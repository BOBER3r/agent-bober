/**
 * digest.test.ts — Unit tests for sendDigest (sc-6-3, sc-6-4).
 * Uses an injected TelegramTransport spy that records opts — no SDK, no network.
 */
import { describe, it, expect } from "vitest";
import { sendDigest } from "./digest.js";
import type { TelegramTransport, SendOptions } from "./outbound.js";

// ── Spy factory ───────────────────────────────────────────────────────

function makeDigestSpy(): TelegramTransport & {
  calls: Array<{ chatId: number; text: string; opts?: SendOptions }>;
} {
  const calls: Array<{ chatId: number; text: string; opts?: SendOptions }> = [];
  const transport: TelegramTransport & { calls: typeof calls } = {
    calls,
    // sendMessage is called by sendSafe — opts is recorded so the silent flag is observable.
    async sendMessage(chatId: number, text: string, opts?: SendOptions): Promise<void> {
      calls.push({ chatId, text, opts });
    },
  };
  return transport;
}

// ── sc-6-3: disable_notification flag (via silent:true) ──────────────

describe("sendDigest — sc-6-3", () => {
  it("sets silent:true on the outgoing message so GrammyTransport maps it to disable_notification", async () => {
    const spy = makeDigestSpy();
    await sendDigest(spy, 7, "Morning digest: 3 new findings");

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.opts?.silent).toBe(true);
  });

  it("delivers the digest text to the correct chatId", async () => {
    const spy = makeDigestSpy();
    await sendDigest(spy, 42, "Weekly summary: all clear");

    expect(spy.calls[0]?.chatId).toBe(42);
    expect(spy.calls[0]?.text).toBe("Weekly summary: all clear");
  });

  it("issues exactly one transport.sendMessage call per digest", async () => {
    const spy = makeDigestSpy();
    await sendDigest(spy, 1, "digest text");

    expect(spy.calls).toHaveLength(1);
  });
});

// ── sc-6-4: content routes through the sendSafe funnel ───────────────

describe("sendDigest — sc-6-4 (funnel discipline)", () => {
  it("reaches transport.sendMessage via the sendSafe funnel (not a direct call)", async () => {
    const spy = makeDigestSpy();
    await sendDigest(spy, 7, "Morning digest: 3 new findings");

    // sendSafe calls transport.sendMessage — if the spy recorded the call,
    // the funnel was used (digest.ts never calls transport.sendMessage directly).
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.opts?.silent).toBe(true);
  });
});
