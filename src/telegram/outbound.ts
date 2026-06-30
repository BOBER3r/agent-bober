/** outbound.ts — Single outbound chokepoint for all Telegram replies. */
import type { InlineKeyboardSpec } from "./keyboard.js";

// ── Transport interface ───────────────────────────────────────────────

/**
 * Provider-agnostic Telegram transport interface.
 * Handlers and the poll loop depend on this interface, never on a concrete SDK.
 * Later sprints extend BotTransport (in bot.ts) with editMessage, getFile,
 * answerCallback, etc. — without touching this core contract.
 */
export interface TelegramTransport {
  /** Send a plain-text message to the given Telegram chat id. */
  sendMessage(chatId: number, text: string): Promise<void>;
}

/**
 * Minimal transport interface for keyboard sends.
 * BotTransport (bot.ts) satisfies this structurally — no explicit extends needed.
 * Defined here so sendSafeKeyboard can live in outbound.ts without importing from bot.ts
 * (which would create a circular dependency — bot.ts already imports from outbound.ts).
 */
export interface KeyboardTransport {
  sendKeyboard(chatId: number, text: string, keyboard: InlineKeyboardSpec): Promise<void>;
}

// ── Outbound funnel ───────────────────────────────────────────────────

/**
 * The ONLY place transport.sendMessage is invoked.
 * Every outbound reply must be routed through sendSafe — handlers return
 * a content string; the caller passes it here. No handler may call
 * transport.sendMessage directly (evaluatorNotes, nonGoal #5).
 *
 * bober: plain passthrough now; extend to add rate-limiting, audit logging,
 *        or Markdown sanitisation in later sprints without modifying handlers.
 */
export async function sendSafe(
  transport: TelegramTransport,
  chatId: number,
  content: string,
): Promise<void> {
  await transport.sendMessage(chatId, content);
}

/**
 * The ONLY place transport.sendKeyboard is invoked (§B funnel unification).
 * Every outbound keyboard message must go through this chokepoint — the poll loop
 * MUST NOT call transport.sendKeyboard directly. This mirrors sendSafe as the
 * single control-plane seam for keyboard messages.
 *
 * bober: plain passthrough now; extend to add content filtering, audit logging,
 *        or rate-limiting for keyboard messages in later sprints without modifying
 *        the poll loop or handlers.
 */
export async function sendSafeKeyboard(
  transport: KeyboardTransport,
  chatId: number,
  content: string,
  keyboard: InlineKeyboardSpec,
): Promise<void> {
  await transport.sendKeyboard(chatId, content, keyboard);
}
