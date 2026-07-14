/** router.ts — Pure classifier: slash-command vs plain text. No side effects, no network. */
import type { Scope } from "../hub/scope.js";

// ── Types ─────────────────────────────────────────────────────────────

/**
 * Discriminated union returned by classify.
 * A command carries the slash-stripped name and any trailing args string.
 * A text message carries the raw message verbatim for zero-friction capture.
 */
export type RoutedMessage =
  | { kind: "command"; name: string; args: string }
  | { kind: "text"; text: string };

// ── classify ──────────────────────────────────────────────────────────

/**
 * Classify a Telegram message text as a slash-command or plain capture text.
 *
 * A message whose first non-space character is '/' is a command:
 *   "/start"           → { kind:"command", name:"start", args:"" }
 *   "/todo buy milk"   → { kind:"command", name:"todo",  args:"buy milk" }
 *
 * All other messages are plain text routed to the capture handler:
 *   "renew passport"   → { kind:"text", text:"renew passport" }
 *
 * PURE: no side effects, no network, no clock. Text is never trimmed/parsed
 * (the capture handler receives it verbatim — generatorNotes).
 */
export function classify(message: string): RoutedMessage {
  const trimmed = message.trimStart();
  if (trimmed.startsWith("/")) {
    const body = trimmed.slice(1);
    const sp = body.search(/\s/);
    const name = sp === -1 ? body : body.slice(0, sp);
    const args = sp === -1 ? "" : body.slice(sp + 1).trim();
    return { kind: "command", name, args };
  }
  // Return message verbatim — do not trim/lowercase/parse (generatorNotes).
  return { kind: "text", text: message };
}

// ── parseScopeFromCommand ─────────────────────────────────────────────

/**
 * Parse an ephemeral Scope from a slash-command name and its trailing args.
 *
 * Maps:
 *   "today"    → { mode: "filtered", dueWithinDays: 1 }
 *   "priority" → { mode: "general" }
 *   "decide"   → { mode: "decision", optionA: X, optionB: Y }
 *                 (split args on /\s+vs\s+/i, trim both; returns null if ≠2 parts)
 *
 * Returns null for all other command names, or if /decide args do not yield
 * exactly two non-empty trimmed options (caller should fall through to Unknown command).
 *
 * PURE: no side effects, no network, no disk access. Scope is ephemeral —
 * never persisted (nonGoal #2).
 */
export function parseScopeFromCommand(name: string, args: string): Scope | null {
  switch (name.toLowerCase()) {
    case "today":
      return { mode: "filtered", dueWithinDays: 1 };
    case "priority":
      return { mode: "general" };
    case "decide": {
      const parts = args.split(/\s+vs\s+/i);
      if (parts.length !== 2) return null;
      const optionA = parts[0]!.trim();
      const optionB = parts[1]!.trim();
      if (!optionA || !optionB) return null;
      return { mode: "decision", optionA, optionB };
    }
    default:
      return null;
  }
}
