/** digest.ts — Deliver a scheduler-handed digest payload silently (no notification sound). */
import { sendSafe } from "./outbound.js";
import type { TelegramTransport } from "./outbound.js";

// ── sendDigest ────────────────────────────────────────────────────────

/**
 * Send a plain digest summary with notifications silenced.
 * The payload text is supplied by the scheduler owner — this adapter does NOT
 * decide content or cadence (nonGoal: "do not implement the scheduler itself").
 *
 * Routes through the sendSafe funnel with `{ silent: true }` so GrammyTransport
 * maps it to Telegram's `disable_notification: true` (sc-6-3).
 * Never calls transport.sendMessage directly (sc-6-4).
 *
 * Example usage (from a scheduled job owner):
 *   const text = renderDigestMarkdown(digest); // src/research/digest.ts — NOT imported here
 *   await sendDigest(transport, chatId, text);
 *
 * bober: in-process delivery; swap for a queue/worker if the scheduler needs
 *        retry semantics or cross-process delivery in a follow-up sprint.
 */
export async function sendDigest(
  transport: TelegramTransport,
  chatId: number,
  text: string,
): Promise<void> {
  await sendSafe(transport, chatId, text, { silent: true });
}
