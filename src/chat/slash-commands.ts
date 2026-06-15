// ── slash-commands.ts ────────────────────────────────────────────────
//
// Deterministic slash-command dispatcher.
// Handles /runs, /help, /exit WITHOUT touching the LLMClient.

import type { RosterReader } from "./roster-reader.js";

// ── Types ─────────────────────────────────────────────────────────────

export type SlashResult =
  | { handled: true; output: string; exit?: false }
  | { handled: true; output?: undefined; exit: true }
  | { handled: false };

// ── Help text ─────────────────────────────────────────────────────────

const HELP_TEXT = [
  "Available slash commands:",
  "  /runs              — List all active and recent runs",
  "  /stop <runId>      — Stop a run by killing its process (hard stop)",
  "  /pause <runId>     — Soft-pause a run at the next boundary (process stays alive)",
  "  /resume <runId>    — Resume a soft-paused run",
  "  /careful [on|off]  — Toggle approval gates for new runs",
  "  /approve <id>      — Approve a pending checkpoint (resume the run)",
  "  /reject <id> [why] — Reject a pending checkpoint with optional feedback",
  "  /tell <runId> <text> — Queue free-text guidance for a run (applied at next boundary)",
  "  /help              — Show this help message",
  "  /exit              — Exit the chat session",
  "",
  "Any other input is sent to the AI assistant.",
].join("\n");

// ── dispatch ──────────────────────────────────────────────────────────

/**
 * Handle a slash command if the input starts with '/'.
 * Returns { handled: false } for non-slash input.
 * Never calls the LLMClient.
 *
 * @param stopHandler - Optional handler for /stop <runId>. When omitted, /stop
 *   returns an "unavailable" message. Kept optional so existing 2-arg callers
 *   are not broken (sc-4-6).
 * @param carefulHandler - Optional handler for /careful [on|off]. When omitted,
 *   /careful returns an "unavailable" message. Kept optional so existing 2-/3-arg
 *   callers are not broken.
 * @param approveHandler - Optional handler for /approve <id>. When omitted, /approve
 *   returns an "unavailable" message. Kept optional so existing callers are not broken.
 * @param rejectHandler - Optional handler for /reject <id> [feedback]. When omitted,
 *   /reject returns an "unavailable" message. Kept optional so existing callers are not broken.
 * @param tellHandler - Optional handler for /tell <runId> <text>. When omitted,
 *   /tell returns an "unavailable" message.
 * @param pauseHandler - Optional handler for /pause <runId>. When omitted,
 *   /pause returns an "unavailable" message. Kept optional for back-compat.
 * @param resumeHandler - Optional handler for /resume <runId>. When omitted,
 *   /resume returns an "unavailable" message. Last optional param preserves back-compat.
 */
export async function dispatch(
  input: string,
  roster: RosterReader,
  stopHandler?: (runId: string) => Promise<string>,
  carefulHandler?: (arg: string | undefined) => Promise<string>,
  approveHandler?: (id: string) => Promise<string>,
  rejectHandler?: (id: string, feedback: string) => Promise<string>,
  tellHandler?: (runId: string, text: string) => Promise<string>,
  pauseHandler?: (runId: string) => Promise<string>,
  resumeHandler?: (runId: string) => Promise<string>,
): Promise<SlashResult> {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) {
    return { handled: false };
  }

  const command = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";

  switch (command) {
    case "/runs": {
      const states = await roster.read();
      const output = roster.summarize(states);
      return { handled: true, output };
    }

    case "/help": {
      return { handled: true, output: HELP_TEXT };
    }

    case "/stop": {
      const arg = trimmed.split(/\s+/)[1];
      if (!arg) return { handled: true, output: "Usage: /stop <runId>" };
      const output = stopHandler
        ? await stopHandler(arg)
        : "Stop is unavailable.";
      return { handled: true, output };
    }

    case "/careful": {
      const arg = trimmed.split(/\s+/)[1]?.toLowerCase();
      const output = carefulHandler
        ? await carefulHandler(arg)
        : "Careful mode is unavailable.";
      return { handled: true, output };
    }

    case "/approve": {
      const arg = trimmed.split(/\s+/)[1];
      if (!arg) return { handled: true, output: "Usage: /approve <checkpointId>" };
      const output = approveHandler
        ? await approveHandler(arg)
        : "Approve is unavailable.";
      return { handled: true, output };
    }

    case "/reject": {
      const parts = trimmed.split(/\s+/);
      const id = parts[1];
      if (!id) return { handled: true, output: "Usage: /reject <checkpointId> [feedback]" };
      // Everything after the id is feedback (preserve spacing of the remainder)
      const feedback = trimmed.replace(/^\/reject\s+\S+\s*/, "");
      const output = rejectHandler
        ? await rejectHandler(id, feedback)
        : "Reject is unavailable.";
      return { handled: true, output };
    }

    case "/tell": {
      const parts = trimmed.split(/\s+/);
      const runId = parts[1];
      if (!runId) return { handled: true, output: "Usage: /tell <runId> <text>" };
      // Capture everything after the runId as the guidance text (preserve spacing)
      const text = trimmed.replace(/^\/tell\s+\S+\s*/, "");
      if (!text) return { handled: true, output: "Usage: /tell <runId> <text>" };
      const output = tellHandler
        ? await tellHandler(runId, text)
        : "Tell is unavailable.";
      return { handled: true, output };
    }

    case "/pause": {
      const arg = trimmed.split(/\s+/)[1];
      if (!arg) return { handled: true, output: "Usage: /pause <runId>" };
      const output = pauseHandler ? await pauseHandler(arg) : "Pause is unavailable.";
      return { handled: true, output };
    }

    case "/resume": {
      const arg = trimmed.split(/\s+/)[1];
      if (!arg) return { handled: true, output: "Usage: /resume <runId>" };
      const output = resumeHandler ? await resumeHandler(arg) : "Resume is unavailable.";
      return { handled: true, output };
    }

    case "/exit": {
      return { handled: true, exit: true };
    }

    default: {
      const output = `Unknown command: ${command}\n${HELP_TEXT}`;
      return { handled: true, output };
    }
  }
}
