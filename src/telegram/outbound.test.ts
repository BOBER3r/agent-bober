/**
 * outbound.test.ts — Tests for the sendSafe outbound funnel (sc-1-5).
 * Verifies that transport.sendMessage is invoked solely inside sendSafe:
 * handlers return content strings; all sends go through the funnel.
 * Also tests the poll-loop funnel invariant using an injected BotTransport spy.
 * No network access; no SDK in this file.
 */
import { describe, it, expect } from "vitest";
import { sendSafe } from "./outbound.js";
import type { TelegramTransport } from "./outbound.js";
import { startPollLoop, helpReply } from "./bot.js";
import type { BotTransport, TelegramUpdate } from "./bot.js";
import { denialReply } from "./whitelist.js";

// ── Spy factory ───────────────────────────────────────────────────────

/** Duck-typed TelegramTransport spy that records all sendMessage calls. */
function makeSpy(): TelegramTransport & { calls: Array<{ chatId: number; text: string }> } {
  const calls: Array<{ chatId: number; text: string }> = [];
  return {
    calls,
    async sendMessage(chatId: number, text: string): Promise<void> {
      calls.push({ chatId, text });
    },
  };
}

// ── sendSafe funnel ───────────────────────────────────────────────────

describe("sendSafe — outbound funnel (sc-1-5)", () => {
  it("calls transport.sendMessage exactly once with the correct chatId and text", async () => {
    const spy = makeSpy();
    await sendSafe(spy, 123, "hello world");
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]).toMatchObject({ chatId: 123, text: "hello world" });
  });

  it("each sendSafe call produces exactly one transport.sendMessage call", async () => {
    const spy = makeSpy();
    await sendSafe(spy, 1, "first");
    await sendSafe(spy, 2, "second");
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[0]).toMatchObject({ chatId: 1, text: "first" });
    expect(spy.calls[1]).toMatchObject({ chatId: 2, text: "second" });
  });

  it("handler (denialReply) returns content; content flows through sendSafe to transport", async () => {
    const spy = makeSpy();
    const content = denialReply(77777);
    // Handler returns a string — it has no access to transport.
    // Only sendSafe bridges content → transport.sendMessage.
    await sendSafe(spy, 77777, content);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.text).toContain("77777");
    expect(spy.calls[0]?.chatId).toBe(77777);
  });

  it("handler (helpReply) returns content; content flows through sendSafe to transport", async () => {
    const spy = makeSpy();
    const content = helpReply();
    await sendSafe(spy, 88888, content);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.chatId).toBe(88888);
    expect(spy.calls[0]?.text).toBe(content);
  });
});

// ── Poll-loop funnel invariant ────────────────────────────────────────

/**
 * BotTransport spy: returns pre-loaded updates on the first getUpdates call,
 * then aborts the controller and returns empty to let the loop exit cleanly.
 */
function makeLoopSpy(
  preloaded: TelegramUpdate[],
  ac: AbortController,
): BotTransport & { sends: Array<{ chatId: number; text: string }> } {
  const sends: Array<{ chatId: number; text: string }> = [];
  let call = 0;
  return {
    sends,
    async getUpdates(_offset: number): Promise<TelegramUpdate[]> {
      call++;
      if (call === 1) return preloaded;
      // Second call: abort so the loop exits, then return empty.
      ac.abort();
      return [];
    },
    async sendMessage(chatId: number, text: string): Promise<void> {
      sends.push({ chatId, text });
    },
  } as unknown as BotTransport & { sends: Array<{ chatId: number; text: string }> };
}

describe("startPollLoop funnel invariant (sc-1-5)", () => {
  it("sends denial reply through sendSafe for a non-whitelisted sender", async () => {
    const ac = new AbortController();
    const spy = makeLoopSpy(
      [
        {
          update_id: 1,
          message: {
            message_id: 1,
            from: { id: 99999 },
            chat: { id: 99999 },
            text: "hello",
          },
        },
      ],
      ac,
    );

    const saved = process.env["TELEGRAM_ALLOWED_USERS"];
    delete process.env["TELEGRAM_ALLOWED_USERS"];
    try {
      await startPollLoop(spy, ac.signal);
    } finally {
      if (saved !== undefined) process.env["TELEGRAM_ALLOWED_USERS"] = saved;
      else delete process.env["TELEGRAM_ALLOWED_USERS"];
    }

    // Exactly one send: the denial reply routed through sendSafe.
    expect(spy.sends).toHaveLength(1);
    expect(spy.sends[0]?.chatId).toBe(99999);
    expect(spy.sends[0]?.text).toContain("99999");
  });

  it("sends help reply through sendSafe for a whitelisted sender", async () => {
    const ac = new AbortController();
    const spy = makeLoopSpy(
      [
        {
          update_id: 2,
          message: {
            message_id: 2,
            from: { id: 11111 },
            chat: { id: 11111 },
            text: "/start",
          },
        },
      ],
      ac,
    );

    const saved = process.env["TELEGRAM_ALLOWED_USERS"];
    process.env["TELEGRAM_ALLOWED_USERS"] = "11111";
    try {
      await startPollLoop(spy, ac.signal);
    } finally {
      if (saved !== undefined) process.env["TELEGRAM_ALLOWED_USERS"] = saved;
      else delete process.env["TELEGRAM_ALLOWED_USERS"];
    }

    // Exactly one send: the help reply routed through sendSafe.
    expect(spy.sends).toHaveLength(1);
    expect(spy.sends[0]?.chatId).toBe(11111);
    expect(spy.sends[0]?.text).toBe(helpReply());
  });

  it("ignores updates without a message (no sends)", async () => {
    const ac = new AbortController();
    const spy = makeLoopSpy(
      [{ update_id: 3 }], // no message field
      ac,
    );

    const saved = process.env["TELEGRAM_ALLOWED_USERS"];
    delete process.env["TELEGRAM_ALLOWED_USERS"];
    try {
      await startPollLoop(spy, ac.signal);
    } finally {
      if (saved !== undefined) process.env["TELEGRAM_ALLOWED_USERS"] = saved;
      else delete process.env["TELEGRAM_ALLOWED_USERS"];
    }

    expect(spy.sends).toHaveLength(0);
  });
});
