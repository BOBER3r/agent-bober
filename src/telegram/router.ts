/** router.ts — Pure classifier: slash-command vs plain text. No side effects, no network. */

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
