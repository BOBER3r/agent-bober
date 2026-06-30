/**
 * fleet-view.test.ts — Unit tests for renderFleetView + handleFleet (sc-7-2..sc-7-6).
 * Uses injected readers/spies — no disk access, no SDK, no network.
 */
import { describe, it, expect } from "vitest";
import { renderFleetView, handleFleet } from "./fleet-view.js";
import { streamFleetView } from "./streaming.js";
import type { SynthesisReader } from "./fleet-view.js";
import type { SynthesisBundle } from "../fleet/synthesis.js";
import type { FactRecord } from "../state/facts.js";
import { sendSafe } from "./outbound.js";
import type { TelegramTransport, EditTransport } from "./outbound.js";

// ── Fixtures ──────────────────────────────────────────────────────────

/** Build a minimal valid FactRecord 'finding' (mirrors prioritize.test.ts `fx`). */
const fact = (
  subject: string,
  value: string,
  confidence = 1,
  tCreated = "2026-06-30T00:00:00.000Z",
): FactRecord => ({
  id: `${subject}-${value}`.slice(0, 16),
  scope: "fleet-ns",
  subject,
  predicate: "finding",
  value,
  confidence,
  sourceRunId: null,
  tValid: tCreated,
  tInvalid: null,
  tCreated,
  tInvalidated: null,
});

/** Build a minimal valid SynthesisBundle. */
const bundle = (findings: FactRecord[], rounds = 2): SynthesisBundle => ({
  rounds,
  childResults: {
    total: findings.length,
    completed: findings.length,
    failed: 0,
    other: 0,
    generatedAt: "2026-06-30T00:00:00.000Z",
    children: [],
  },
  findings,
});

// ── Transport spies ───────────────────────────────────────────────────

/** TelegramTransport spy (mirrors outbound.test.ts makeSpy). */
function makeSpy(): TelegramTransport & { calls: Array<{ chatId: number; text: string }> } {
  const calls: Array<{ chatId: number; text: string }> = [];
  return {
    calls,
    async sendMessage(chatId: number, text: string): Promise<void> {
      calls.push({ chatId, text });
    },
  };
}

const FIXED_MSG_ID = 555;

/** EditTransport spy for streaming tests (mirrors streaming.test.ts makeStreamSpy). */
function makeStreamSpy(): EditTransport & {
  sends: Array<{ chatId: number; text: string }>;
  edits: Array<{ chatId: number; messageId: number; text: string }>;
} {
  const sends: Array<{ chatId: number; text: string }> = [];
  const edits: Array<{ chatId: number; messageId: number; text: string }> = [];
  return {
    sends,
    edits,
    async sendReturningId(chatId: number, text: string): Promise<number> {
      sends.push({ chatId, text });
      return FIXED_MSG_ID;
    },
    async editMessage(chatId: number, messageId: number, text: string): Promise<void> {
      edits.push({ chatId, messageId, text });
    },
  };
}

const ALLOWED = new Set<number>([111]);

// ── sc-7-2: one section per distinct subject ──────────────────────────

describe("renderFleetView", () => {
  it("sc-7-2: emits one section per distinct subject with label+summary+round+confidence+count", () => {
    const out = renderFleetView(
      bundle([
        fact("grok-child", "anomaly found in Q3 ledger", 0.9),
        fact("grok-child", "second grok note", 0.8),
        fact("deepseek-child", "schema mismatch detected", 0.7),
      ]),
    );
    const joined = out.join("\n");
    expect(joined).toContain("grok-child");
    expect(joined).toContain("deepseek-child");
    // exactly 2 agent sections (subjects), regardless of header line
    const sections = out.filter(
      (s) => s.includes("grok-child") || s.includes("deepseek-child"),
    );
    expect(sections).toHaveLength(2);
    // grok section carries its count (2 findings) and a "2" somewhere after the label
    expect(joined).toMatch(/grok-child[\s\S]*2/); // count of 2
  });

  // ── sc-7-4: header shows bundle.rounds ──────────────────────────────
  it("sc-7-4: header includes the run's round count", () => {
    const out = renderFleetView(bundle([fact("a", "x")], 3));
    expect(out[0]).toContain("3"); // header line carries rounds=3
  });

  // ── sc-7-5 (render half): over-long value truncated to one line ──────
  it("sc-7-5: a multi-line / over-long value is summarized to one line", () => {
    const huge = "L1 secret-payload\nL2 more\n" + "x".repeat(5000);
    const out = renderFleetView(bundle([fact("a", huge)]));
    const joined = out.join("\n");
    expect(joined).not.toContain("L2 more"); // newlines collapsed
    expect(joined).not.toContain("x".repeat(5000)); // verbatim never present
    expect(joined.split("\n").every((l) => l.length < 400)).toBe(true);
  });
});

// ── sc-7-3 / sc-7-5 / sc-7-6: handler behaviour ──────────────────────

describe("handleFleet", () => {
  it("sc-7-3: reader returns null → 'no recent fleet run', no throw", async () => {
    const reader: SynthesisReader = async () => null;
    const reply = await handleFleet(111, ALLOWED, reader);
    expect(reply.toLowerCase()).toContain("no recent fleet run");
  });

  it("sc-7-3: reader returns { findings: [] } → 'no recent fleet run'", async () => {
    const reader: SynthesisReader = async () => bundle([]);
    const reply = await handleFleet(111, ALLOWED, reader);
    expect(reply.toLowerCase()).toContain("no recent fleet run");
  });

  it("sc-7-5: over-long value routed via sendSafe — verbatim never reaches transport", async () => {
    const huge = "secret-" + "z".repeat(4000);
    const reader: SynthesisReader = async () => bundle([fact("a", huge)]);
    const reply = await handleFleet(111, ALLOWED, reader);
    const spy = makeSpy();
    await sendSafe(spy, 111, reply); // caller funnels the string
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.text).not.toContain("z".repeat(4000));
  });

  it("sc-7-6: non-whitelisted /fleet denied with id-echo AND reader never called", async () => {
    let called = false;
    const readerSpy: SynthesisReader = async () => {
      called = true;
      return null;
    };
    const reply = await handleFleet(99999, ALLOWED, readerSpy); // 99999 NOT in ALLOWED
    expect(reply).toContain("99999"); // id echo (denialReply)
    expect(called).toBe(false); // reader spy never invoked
  });
});

// ── sc-7-5 streaming half: streamFleetView ───────────────────────────

describe("streamFleetView", () => {
  it("sc-7-5: streamFleetView edits never contain the verbatim over-long payload", async () => {
    const spy = makeStreamSpy();
    await streamFleetView(spy, 7, bundle([fact("a", "p-" + "q".repeat(4000))]));
    expect(spy.sends).toHaveLength(1); // one initial send
    expect(spy.edits.every((e) => !e.text.includes("q".repeat(4000)))).toBe(true);
  });
});
