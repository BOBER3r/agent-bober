/** outbound.ts — Single outbound chokepoint for all Telegram replies. */
import type { InlineKeyboardSpec } from "./keyboard.js";

// ── Transport interfaces ──────────────────────────────────────────────

/** Provider-neutral delivery options threaded through the outbound funnel. */
export interface SendOptions {
  /**
   * Silence the notification on the recipient's device.
   * GrammyTransport (bot.ts) maps this to Telegram's `disable_notification`.
   * Other transport implementations may map it to their own equivalent flag.
   */
  silent?: boolean;
}

/**
 * Provider-agnostic Telegram transport interface.
 * Handlers and the poll loop depend on this interface, never on a concrete SDK.
 * The optional `opts` param is backward-compatible — all existing 2-arg callers
 * continue to compile unchanged; sendSafe threads opts through to the transport.
 */
export interface TelegramTransport {
  /** Send a plain-text message to the given Telegram chat id. */
  sendMessage(chatId: number, text: string, opts?: SendOptions): Promise<void>;
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

/**
 * Transport surface used by the streaming sender (Sprint 6).
 * Kept in outbound.ts (not bot.ts) so streaming.ts can import it without creating
 * a circular dependency (bot.ts already imports from outbound.ts).
 */
export interface EditTransport {
  /** Send a message and return its Telegram message_id so it can be edited later. */
  sendReturningId(chatId: number, text: string, opts?: SendOptions): Promise<number>;
  /** Edit an existing message in place — does NOT post a new message. */
  editMessage(chatId: number, messageId: number, text: string): Promise<void>;
}

// ── Outbound funnel ───────────────────────────────────────────────────

/**
 * The ONLY place transport.sendMessage is invoked.
 * Every outbound reply must be routed through sendSafe — handlers return
 * a content string; the caller passes it here. No handler may call
 * transport.sendMessage directly (evaluatorNotes, nonGoal #5).
 * The optional `opts` param is undefined for all Sprint 1-5 callers (no behavior change).
 *
 * bober: plain passthrough now; extend to add rate-limiting, audit logging,
 *        or Markdown sanitisation in later sprints without modifying handlers.
 */
export async function sendSafe(
  transport: TelegramTransport,
  chatId: number,
  content: string,
  opts?: SendOptions,
): Promise<void> {
  await transport.sendMessage(chatId, content, opts);
}

/**
 * The ONLY place transport.sendReturningId is invoked (Sprint 6 streaming funnel).
 * Used exclusively by the streaming sender to issue ONE initial status message and
 * capture its id for subsequent in-place edits. Returns the Telegram message_id.
 * streaming.ts MUST call this instead of calling transport.sendReturningId directly.
 */
export async function sendSafeForEdit(
  transport: EditTransport,
  chatId: number,
  content: string,
  opts?: SendOptions,
): Promise<number> {
  return transport.sendReturningId(chatId, content, opts);
}

/**
 * The ONLY place transport.editMessage is invoked (Sprint 6 streaming funnel).
 * Used exclusively by the streaming sender to update ONE message in place per tick.
 * streaming.ts MUST call this instead of calling transport.editMessage directly.
 */
export async function sendSafeEdit(
  transport: EditTransport,
  chatId: number,
  messageId: number,
  content: string,
): Promise<void> {
  await transport.editMessage(chatId, messageId, content);
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
