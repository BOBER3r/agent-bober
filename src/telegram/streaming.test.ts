/**
 * streaming.test.ts — Unit tests for streamProgress (sc-6-2, sc-6-4).
 * Uses an injected EditTransport spy — no SDK, no network.
 */
import { describe, it, expect } from "vitest";
import { streamProgress } from "./streaming.js";
import type { EditTransport } from "./outbound.js";

// ── Spy factory ───────────────────────────────────────────────────────

const FIXED_MSG_ID = 555;

function makeStreamSpy(): EditTransport & {
  sends: Array<{ chatId: number; text: string }>;
  edits: Array<{ chatId: number; messageId: number; text: string }>;
} {
  const sends: Array<{ chatId: number; text: string }> = [];
  const edits: Array<{ chatId: number; messageId: number; text: string }> = [];
  const transport: EditTransport & {
    sends: typeof sends;
    edits: typeof edits;
  } = {
    sends,
    edits,
    // sendReturningId is called by sendSafeForEdit — the ONLY path into sends.
    async sendReturningId(chatId: number, text: string): Promise<number> {
      sends.push({ chatId, text });
      return FIXED_MSG_ID;
    },
    // editMessage is called by sendSafeEdit — the ONLY path into edits.
    async editMessage(chatId: number, messageId: number, text: string): Promise<void> {
      edits.push({ chatId, messageId, text });
    },
  };
  return transport;
}

/** Async generator that yields a fixed sequence of strings. */
async function* seq(items: string[]): AsyncIterable<string> {
  for (const item of items) {
    yield item;
  }
}

// ── sc-6-2: one send + >=2 edits on the SAME message id ──────────────

describe("streamProgress — sc-6-2", () => {
  it("issues exactly one send and at least two edits on the same message id for N=2 updates", async () => {
    const spy = makeStreamSpy();
    await streamProgress(spy, 7, seq(["step 1", "done — summary"]));

    expect(spy.sends).toHaveLength(1);
    expect(spy.edits.length).toBeGreaterThanOrEqual(2);
    expect(spy.edits.every((e) => e.messageId === FIXED_MSG_ID)).toBe(true);
  });

  it("issues exactly one send and N edits on the same message id for N=3 updates", async () => {
    const spy = makeStreamSpy();
    await streamProgress(spy, 42, seq(["step 1", "step 2", "done — summary"]));

    expect(spy.sends).toHaveLength(1);
    expect(spy.edits).toHaveLength(3);
    expect(spy.edits.every((e) => e.messageId === FIXED_MSG_ID)).toBe(true);
  });

  it("the initial send uses the configured header, not the first update text", async () => {
    const spy = makeStreamSpy();
    await streamProgress(spy, 7, seq(["update text"]), { header: "Custom header…" });

    expect(spy.sends[0]?.text).toBe("Custom header…");
    expect(spy.edits[0]?.text).toBe("update text");
  });

  it("the initial send uses the default header when no header option is provided", async () => {
    const spy = makeStreamSpy();
    await streamProgress(spy, 7, seq(["update"]));

    expect(spy.sends[0]?.text).toBe("Working…");
  });

  it("all sends and edits target the correct chatId", async () => {
    const spy = makeStreamSpy();
    await streamProgress(spy, 99, seq(["tick 1", "tick 2"]));

    expect(spy.sends.every((s) => s.chatId === 99)).toBe(true);
    expect(spy.edits.every((e) => e.chatId === 99)).toBe(true);
  });
});

// ── sc-6-4: content routes through the sendSafe funnel ───────────────

describe("streamProgress — sc-6-4 (funnel discipline)", () => {
  it("records transport.sendReturningId call for the initial send (via sendSafeForEdit)", async () => {
    const spy = makeStreamSpy();
    await streamProgress(spy, 1, seq(["step", "final"]));

    // sendSafeForEdit calls transport.sendReturningId — if the spy recorded it,
    // the funnel was used (not a direct bot.api call).
    expect(spy.sends).toHaveLength(1);
  });

  it("records transport.editMessage calls for each update (via sendSafeEdit)", async () => {
    const spy = makeStreamSpy();
    await streamProgress(spy, 1, seq(["a", "b", "c"]));

    // sendSafeEdit calls transport.editMessage — if the spy recorded 3 edits,
    // the funnel was used for every update.
    expect(spy.edits).toHaveLength(3);
  });
});
