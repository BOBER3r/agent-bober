/**
 * keyboard.ts — Provider-neutral inline-keyboard spec builder and compact
 * callback_data codec for approval checkpoints and upload opt-in.
 * No grammy import — provider-agnostic (principles.md:28). grammy types stay in bot.ts.
 *
 * Telegram callback_data limit: 64 bytes (UTF-8).
 * Codec: "<code>:<checkpointId>" where code ∈ {a=approve, j=adjust, r=reject, y=confirm, n=cancel}.
 * Budget: 2 bytes for "<code>:" + byteLength(checkpointId).
 * Known checkpointId formats are well under budget:
 *   "promote-<16hex>"   = 24 bytes → 26 bytes total
 *   "calendar-<planId>" = well under 64 bytes for any realistic planId
 *   message_id (int)    = ≤10 bytes → 12 bytes total
 * Never truncate checkpointId — truncation breaks pendingExists lookup silently.
 */

// ── Types ─────────────────────────────────────────────────────────────

export type CallbackAction = "approve" | "adjust" | "reject" | "confirm" | "cancel";

/** Provider-neutral inline keyboard: rows of {text, data} buttons. */
export type InlineKeyboardSpec = { text: string; data: string }[][];

// ── Codec ─────────────────────────────────────────────────────────────

const CODE: Record<CallbackAction, string> = {
  approve: "a",
  adjust: "j",
  reject: "r",
  confirm: "y",
  cancel: "n",
};
const ACTION: Record<string, CallbackAction> = {
  a: "approve",
  j: "adjust",
  r: "reject",
  y: "confirm",
  n: "cancel",
};

/**
 * Encode {action, checkpointId} into a compact callback_data string.
 * Result is "<code>:<checkpointId>" (e.g. "a:calendar-mon-plan").
 * Always ≤ 64 bytes for all current checkpointId formats.
 */
export function encodeCallback(action: CallbackAction, checkpointId: string): string {
  return `${CODE[action]}:${checkpointId}`;
}

/**
 * Decode a callback_data string back to {action, checkpointId}.
 * Returns null for unrecognised or malformed data.
 * Decodes by splitting on the first ":" only — checkpointIds may contain colons.
 */
export function decodeCallback(
  data: string,
): { action: CallbackAction; checkpointId: string } | null {
  const i = data.indexOf(":");
  if (i <= 0) return null;
  const action = ACTION[data.slice(0, i)];
  const checkpointId = data.slice(i + 1);
  if (!action || !checkpointId) return null;
  return { action, checkpointId };
}

// ── Keyboard builders ─────────────────────────────────────────────────

/**
 * Build an approval inline keyboard for a single checkpoint.
 * Returns a one-row spec with Approve / Adjust / Reject buttons.
 * The spec is provider-neutral; GrammyTransport in bot.ts converts it to InlineKeyboard.
 */
export function buildApprovalKeyboard(checkpointId: string): InlineKeyboardSpec {
  return [
    [
      { text: "Approve", data: encodeCallback("approve", checkpointId) },
      { text: "Adjust", data: encodeCallback("adjust", checkpointId) },
      { text: "Reject", data: encodeCallback("reject", checkpointId) },
    ],
  ];
}

/**
 * Build a per-upload opt-in keyboard for document uploads.
 * Returns a one-row spec with Yes / No buttons.
 * uploadId should be the message_id string (short, well within the 64-byte limit).
 */
export function buildUploadKeyboard(uploadId: string): InlineKeyboardSpec {
  return [
    [
      { text: "Yes", data: encodeCallback("confirm", uploadId) },
      { text: "No", data: encodeCallback("cancel", uploadId) },
    ],
  ];
}
