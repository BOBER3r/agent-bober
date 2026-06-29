/** outbound.ts — Single outbound chokepoint for all Telegram replies. */

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
