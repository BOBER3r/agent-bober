/**
 * bot.ts — grammY adapter + getUpdates long-poll loop.
 * Telegram SDK: grammy (https://grammy.dev) — TypeScript-native, ESM-compatible,
 * no separate @types package required. This is the ONLY file that imports grammy.
 */
import { Bot } from "grammy";

import type { TelegramTransport } from "./outbound.js";
import { sendSafe } from "./outbound.js";
import { isAllowed, parseAllowedUsers, denialReply } from "./whitelist.js";

// ── Minimal update shape ──────────────────────────────────────────────

/**
 * Minimal Telegram Update shape consumed by the poll loop.
 * Defined locally so that grammy's generated types never leak outside this file
 * (provider-agnostic principle, .bober/principles.md:28).
 * The concrete adapter casts grammy's Update[] to TelegramUpdate[] (compatible subset).
 */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number };
    chat: { id: number };
    text?: string;
  };
}

// ── BotTransport ──────────────────────────────────────────────────────

/**
 * Extended transport used by the poll loop: outbound TelegramTransport
 * plus a getUpdates polling method.
 * Tests inject a fake BotTransport so the loop is testable without any SDK dependency.
 */
export interface BotTransport extends TelegramTransport {
  getUpdates(offset: number): Promise<TelegramUpdate[]>;
}

// ── GrammyTransport ───────────────────────────────────────────────────

/**
 * Concrete BotTransport backed by grammy's Bot.api.
 * This class is the sole SDK consumer — the loop, outbound funnel, and CLI
 * handler all depend on BotTransport / TelegramTransport, not on grammy directly.
 */
export class GrammyTransport implements BotTransport {
  private readonly bot: Bot;

  constructor(token: string) {
    // grammy Bot constructor is lazy — no network calls until api methods are invoked.
    this.bot = new Bot(token);
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    await this.bot.api.sendMessage(chatId, text);
  }

  /**
   * Fetches the next batch of updates using getUpdates long-polling (timeout=30s).
   * offset ensures already-acknowledged updates are not returned again.
   */
  async getUpdates(offset: number): Promise<TelegramUpdate[]> {
    const updates = await this.bot.api.getUpdates({ offset, timeout: 30 });
    // Cast: grammy's Update is a superset of TelegramUpdate; subset is all we consume.
    return updates as unknown as TelegramUpdate[];
  }
}

// ── Help reply ────────────────────────────────────────────────────────

/**
 * Returns the /start help reply sent to whitelisted senders.
 * Handlers return a content string; the loop passes it through sendSafe.
 * Later sprints replace this stub with real command dispatch.
 */
export function helpReply(): string {
  return (
    "Welcome! I am agent-bober's Telegram interface.\n" +
    "Available commands:\n" +
    "  /start — show this help\n" +
    "(More commands arriving soon.)"
  );
}

// ── Long-poll loop ────────────────────────────────────────────────────

/**
 * Runs a getUpdates long-polling loop until the AbortSignal fires (e.g. SIGINT).
 * TELEGRAM_ALLOWED_USERS is read from process.env at loop start.
 *
 * Invariant: all outbound text goes through sendSafe — the loop never calls
 * transport.sendMessage directly (nonGoal #5, evaluatorNotes).
 *
 * bober: single-process synchronous poll; extend to concurrent processing or
 *        grammY's bot.start() if throughput becomes a bottleneck (later sprint).
 */
export async function startPollLoop(
  transport: BotTransport,
  signal: AbortSignal,
): Promise<void> {
  let offset = 0;
  const allowed = parseAllowedUsers(process.env);

  while (!signal.aborted) {
    let updates: TelegramUpdate[];
    try {
      updates = await transport.getUpdates(offset);
    } catch (err) {
      if (signal.aborted) break;
      process.stderr.write(
        `[telegram] getUpdates error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      // Back off before retrying after a transient error.
      await new Promise<void>((resolve) => setTimeout(resolve, 5000));
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (!msg) continue;

      const senderId = msg.from?.id;
      const chatId = msg.chat.id;
      if (senderId === undefined) continue;

      if (!isAllowed(senderId, allowed)) {
        // Non-whitelisted sender: reply with denial echoing their id, then ignore.
        await sendSafe(transport, chatId, denialReply(senderId));
        continue;
      }

      // Whitelisted sender: reply with the /start help stub.
      await sendSafe(transport, chatId, helpReply());
    }
  }
}
