/**
 * bot.ts — grammY adapter + getUpdates long-poll loop.
 * Telegram SDK: grammy (https://grammy.dev) — TypeScript-native, ESM-compatible,
 * no separate @types package required. This is the ONLY file that imports grammy.
 */
import { Buffer } from "node:buffer";
import { writeFile } from "node:fs/promises";

import { Bot, InlineKeyboard } from "grammy";

import type { TelegramTransport, EditTransport, SendOptions } from "./outbound.js";
import { sendSafe, sendSafeKeyboard } from "./outbound.js";
import { isAllowed, parseAllowedUsers, denialReply } from "./whitelist.js";
import { classify } from "./router.js";
import { handleCapture, defaultCapture } from "./handlers/capture.js";
import type { InboxCapture } from "./handlers/capture.js";
import { handlePrioritize, defaultPrioritize } from "./handlers/prioritize.js";
import type { PrioritizeFn } from "./handlers/prioritize.js";
import { handleApprovalCallback, handleApprovalFollowup, createPendingState } from "./handlers/approvals.js";
import type { PendingCallbackState } from "./handlers/approvals.js";
import {
  registerUpload,
  handleUploadCallback,
  defaultMedicalIngest,
  createPendingUploadState,
} from "./handlers/upload.js";
import type { PendingUploadState } from "./handlers/upload.js";
import { buildApprovalKeyboard, buildUploadKeyboard, decodeCallback } from "./keyboard.js";
import type { InlineKeyboardSpec } from "./keyboard.js";
import { listPending } from "../state/approval-state.js";
import { findProjectRoot } from "../utils/fs.js";
import { handleFleet, defaultSynthesisReader } from "./fleet-view.js";
import type { SynthesisReader } from "./fleet-view.js";

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
    /** Present when the update is a document upload (mirrors @grammyjs/types Document subset). */
    document?: { file_id: string; file_name?: string; mime_type?: string };
  };
  /** Inline-keyboard button tap — present when a user clicks an inline button. */
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { chat: { id: number } };
    data?: string;
  };
}

// ── BotTransport ──────────────────────────────────────────────────────

/**
 * Extended transport used by the poll loop: outbound TelegramTransport + EditTransport
 * plus a getUpdates polling method, inline-keyboard sender, and callback acknowledgement.
 * Tests inject a fake BotTransport so the loop is testable without any SDK dependency.
 * Extensions stay here (not in outbound.ts) per outbound.ts:8-9.
 * Sprint 6: extends EditTransport so GrammyTransport satisfies both text and edit funnels.
 */
export interface BotTransport extends TelegramTransport, EditTransport {
  getUpdates(offset: number): Promise<TelegramUpdate[]>;
  /** Send a message with an inline keyboard. spec is the provider-neutral shape from keyboard.ts. */
  sendKeyboard(chatId: number, text: string, keyboard: InlineKeyboardSpec): Promise<void>;
  /** Acknowledge a callback query — dismisses the loading spinner on the client. */
  answerCallback(callbackQueryId: string, text?: string): Promise<void>;
  /**
   * Download a Telegram file to a local path.
   * Uses grammy's getFile API then fetches via the Telegram file endpoint.
   * Implemented only in GrammyTransport — grammy types stay in this file.
   */
  downloadDocument(fileId: string, destPath: string): Promise<void>;
}

// ── GrammyTransport ───────────────────────────────────────────────────

/**
 * Convert a provider-neutral InlineKeyboardSpec to a grammy InlineKeyboard.
 * This function is the only place grammy's InlineKeyboard is constructed;
 * keyboard.ts and approvals.ts never import grammy (principles.md:28,41).
 */
function toGrammyKeyboard(spec: InlineKeyboardSpec): InlineKeyboard {
  const kb = new InlineKeyboard();
  spec.forEach((row, i) => {
    if (i > 0) kb.row();
    for (const b of row) kb.text(b.text, b.data);
  });
  return kb;
}

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

  /**
   * Send a plain-text message. Maps the provider-neutral `silent` option to
   * grammy's `disable_notification` so callers (via sendSafe) stay SDK-agnostic.
   */
  async sendMessage(chatId: number, text: string, opts?: SendOptions): Promise<void> {
    await this.bot.api.sendMessage(chatId, text, opts?.silent ? { disable_notification: true } : undefined);
  }

  /**
   * Send a message and return its Telegram message_id.
   * Used exclusively by the streaming funnel (sendSafeForEdit) to capture the id
   * of the initial status message for subsequent in-place edits.
   * grammy's sendMessage returns Message.TextMessage which carries message_id (api.d.ts:156).
   */
  async sendReturningId(chatId: number, text: string, opts?: SendOptions): Promise<number> {
    const msg = await this.bot.api.sendMessage(
      chatId,
      text,
      opts?.silent ? { disable_notification: true } : undefined,
    );
    return msg.message_id;
  }

  /**
   * Edit an existing message in place. Used exclusively by the streaming funnel
   * (sendSafeEdit) — never posts a new message, only updates the one sent by sendReturningId.
   * grammy's editMessageText signature: editMessageText(chat_id, message_id, text, other?, signal?).
   */
  async editMessage(chatId: number, messageId: number, text: string): Promise<void> {
    await this.bot.api.editMessageText(chatId, messageId, text);
  }

  /**
   * Send a message with an inline keyboard. Converts the provider-neutral
   * InlineKeyboardSpec to a grammy InlineKeyboard inside this class only.
   */
  async sendKeyboard(chatId: number, text: string, keyboard: InlineKeyboardSpec): Promise<void> {
    await this.bot.api.sendMessage(chatId, text, {
      reply_markup: toGrammyKeyboard(keyboard),
    });
  }

  /**
   * Acknowledge a callback query. Must be called for every tap to dismiss
   * the loading spinner on the Telegram client, even on denied/ghost taps.
   */
  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    await this.bot.api.answerCallbackQuery(callbackQueryId, text ? { text } : undefined);
  }

  /**
   * Fetches the next batch of updates using getUpdates long-polling (timeout=30s).
   * offset ensures already-acknowledged updates are not returned again.
   * callback_query updates are included by default (no allowed_updates filter needed).
   */
  async getUpdates(offset: number): Promise<TelegramUpdate[]> {
    const updates = await this.bot.api.getUpdates({ offset, timeout: 30 });
    // Cast: grammy's Update is a superset of TelegramUpdate; subset is all we consume.
    return updates as unknown as TelegramUpdate[];
  }

  /**
   * Download a Telegram document to a local path.
   * Uses getFile (grammy api) to resolve file_path, then fetches from the Telegram
   * file endpoint and writes bytes via node:fs/promises (no @grammyjs/files plugin needed).
   * Stays in this class so grammy types never leak outside bot.ts (principles.md:28).
   */
  async downloadDocument(fileId: string, destPath: string): Promise<void> {
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) {
      throw new Error(`Telegram getFile returned no file_path for file_id: ${fileId}`);
    }
    const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Telegram file download failed: ${res.status} ${res.statusText}`);
    }
    await writeFile(destPath, Buffer.from(await res.arrayBuffer()));
  }
}

// ── Help reply ────────────────────────────────────────────────────────

/**
 * Returns the /start help reply sent to whitelisted senders.
 * Handlers return a content string; the loop passes it through sendSafe.
 */
export function helpReply(): string {
  return (
    "Welcome! I am agent-bober's Telegram interface.\n" +
    "Available commands:\n" +
    "  /start    — show this help\n" +
    "  /pending  — list pending approval checkpoints with inline buttons\n" +
    "  /today    — today's top priorities\n" +
    "  /priority — ranked findings\n" +
    "  /decide X vs Y — decision support\n" +
    "  /fleet    — latest multi-LLM fleet run findings"
  );
}

// ── Long-poll loop ────────────────────────────────────────────────────

/**
 * Runs a getUpdates long-polling loop until the AbortSignal fires (e.g. SIGINT).
 * TELEGRAM_ALLOWED_USERS is read from process.env at loop start.
 *
 * Invariant: all outbound text goes through sendSafe — the loop never calls
 * transport.sendMessage directly (nonGoal #5, evaluatorNotes).
 * Keyboard messages go through transport.sendKeyboard (also on BotTransport,
 * still not bypassing the transport layer).
 *
 * New params are optional/defaulted so existing callers (telegram.ts:50) that
 * pass only (transport, signal) continue to compile unchanged.
 *
 * bober: single-process synchronous poll; extend to concurrent processing or
 *        grammY's bot.start() if throughput becomes a bottleneck (later sprint).
 */
export async function startPollLoop(
  transport: BotTransport,
  signal: AbortSignal,
  capture: InboxCapture = defaultCapture,
  prioritize: PrioritizeFn = defaultPrioritize,
  pending: PendingCallbackState = createPendingState(),
  uploads: PendingUploadState = createPendingUploadState(),
  fleetReader: SynthesisReader = defaultSynthesisReader,
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

      // ── Callback-query branch (inline keyboard button taps) ───────────
      // Must run BEFORE the message branch — callback_query and message are
      // mutually exclusive in a single update, but the branch order matters
      // for clarity and future extension.
      // Decode-first routing: confirm/cancel → upload handler; a/j/r → approval handler.
      const cb = update.callback_query;
      if (cb) {
        const cbChatId = cb.message?.chat.id;
        if (cbChatId !== undefined) {
          const cbData = cb.data ?? "";
          const cbDecoded = decodeCallback(cbData);
          if (
            cbDecoded &&
            (cbDecoded.action === "confirm" || cbDecoded.action === "cancel")
          ) {
            // Upload opt-in tap: route to the upload callback handler
            const { reply, answer } = await handleUploadCallback({
              senderId: cb.from.id,
              allowed,
              data: cbData,
              pending: uploads,
              download: (fileId, dest) => transport.downloadDocument(fileId, dest),
              ingest: defaultMedicalIngest,
            });
            await transport.answerCallback(cb.id, answer);
            if (reply !== null) {
              await sendSafe(transport, cbChatId, reply);
            }
          } else {
            // Approval tap (approve/adjust/reject) — existing path unchanged
            const projectRoot = (await findProjectRoot()) ?? process.cwd();
            const { reply, answer } = await handleApprovalCallback({
              projectRoot,
              senderId: cb.from.id,
              allowed,
              chatId: cbChatId,
              data: cbData,
              pending,
            });
            // Always ack to dismiss the spinner — even on denied/ghost taps
            await transport.answerCallback(cb.id, answer);
            if (reply !== null) {
              await sendSafe(transport, cbChatId, reply);
            }
          }
        } else {
          // Inline-mode tap (no message context) — ack only, no reply possible
          await transport.answerCallback(cb.id, "Error");
        }
        continue;
      }

      // ── Message branch ────────────────────────────────────────────────
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

      // ── Document upload branch ────────────────────────────────────────
      // Must run BEFORE the text branch — a document message has no text field,
      // so without this branch it would fall through to the helpReply() fallback.
      // The upload is NOT downloaded here; registerUpload only stashes + sends the
      // per-upload opt-in keyboard. Download + ingest happen only on explicit Yes.
      const doc = msg.document;
      if (doc) {
        const uploadId = String(msg.message_id);
        const { reply } = registerUpload({
          uploadId,
          chatId,
          fileId: doc.file_id,
          fileName: doc.file_name ?? "upload.bin",
          pending: uploads,
        });
        await sendSafeKeyboard(transport, chatId, reply, buildUploadKeyboard(uploadId));
        continue;
      }

      // Whitelisted sender: route via classify → capture or command dispatch.
      const text = msg.text;
      if (text === undefined || text.trim() === "") {
        // No text content (sticker, photo, etc.) — fall back to help stub.
        await sendSafe(transport, chatId, helpReply());
        continue;
      }

      // ── Adjust/Reject follow-up interception ─────────────────────────
      // Check BEFORE classify so multi-turn Adjust/Reject text is not captured
      // as a new task. Returns null when no stash exists → fall through.
      const projectRoot = (await findProjectRoot()) ?? process.cwd();
      const followupReply = await handleApprovalFollowup({
        projectRoot,
        senderId,
        allowed,
        chatId,
        text,
        pending,
      });
      if (followupReply !== null) {
        await sendSafe(transport, chatId, followupReply);
        continue;
      }

      // ── Normal routing ────────────────────────────────────────────────
      const routed = classify(text);
      if (routed.kind === "command") {
        // Command dispatch: /start → help; hub-priority commands → prioritize handler;
        // /pending → list pending approvals with inline keyboards;
        // everything else → Unknown-command stub.
        // bober: single-level command switch; extend to a command registry map
        //        if Sprint 5+ adds further commands to this block.
        if (routed.name === "start") {
          await sendSafe(transport, chatId, helpReply());
        } else if (
          routed.name === "today" ||
          routed.name === "priority" ||
          routed.name === "decide"
        ) {
          const reply = await handlePrioritize(routed.name, routed.args, prioritize);
          await sendSafe(transport, chatId, reply);
        } else if (routed.name === "pending") {
          const markers = await listPending(projectRoot);
          if (markers.length === 0) {
            await sendSafe(transport, chatId, "No pending approvals.");
          } else {
            for (const m of markers) {
              const kbText = [
                `[${m.checkpointId}]`,
                m.prompt,
                m.artifact.type ? `Artifact: ${m.artifact.type}` : "",
              ]
                .filter(Boolean)
                .join("\n");
              // §B: unified keyboard funnel — all keyboard sends go through sendSafeKeyboard
              await sendSafeKeyboard(transport, chatId, kbText, buildApprovalKeyboard(m.checkpointId));
            }
          }
        } else if (routed.name === "fleet") {
          const reply = await handleFleet(senderId, allowed, fleetReader);
          await sendSafe(transport, chatId, reply);
        } else {
          await sendSafe(transport, chatId, `Unknown command: /${routed.name}`);
        }
      } else {
        // Plain text → zero-friction capture via the injected inbox sink.
        const reply = await handleCapture(routed.text, capture);
        await sendSafe(transport, chatId, reply);
      }
    }
  }
}
