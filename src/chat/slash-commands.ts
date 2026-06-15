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
  "  /runs          — List all active and recent runs",
  "  /stop <runId>  — Stop a running run by ID",
  "  /help          — Show this help message",
  "  /exit          — Exit the chat session",
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
 */
export async function dispatch(
  input: string,
  roster: RosterReader,
  stopHandler?: (runId: string) => Promise<string>,
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

    case "/exit": {
      return { handled: true, exit: true };
    }

    default: {
      const output = `Unknown command: ${command}\n${HELP_TEXT}`;
      return { handled: true, output };
    }
  }
}
