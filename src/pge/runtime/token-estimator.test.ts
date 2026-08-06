import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { GraphMessage } from "../state/overall.js";
import { decideCompaction, selectTail } from "./compactor.js";
import { DIGEST_TOKEN_CEILING, writeDigest } from "./digest.js";
import type { PhaseDigest } from "./digest.js";
import { assembleSuccessorPrompt, successorTokenBudget } from "./handoff.js";
import {
  DEFAULT_CHARS_PER_TOKEN,
  InvalidCharsPerTokenError,
  createCharsPerTokenEstimator,
  estimateMessages,
  estimateTexts,
} from "./token-estimator.js";

/**
 * sc-10-10 — EVERY threshold in this sprint is computed through the injected estimator.
 *
 * The claim is not "an estimator exists". It is that no threshold anywhere in the Engram
 * layer has a token count of its own, so replacing the estimator MOVES the answer. The
 * only way to demonstrate that is to run each threshold-computing export twice against
 * the SAME data with two different estimators and observe the two answers disagree — a
 * function with a hardcoded chars/4 inside would return the same number both times and
 * every case below would fail.
 *
 * The two estimators are `chars/4` and `chars/2`. Two, not one plus a mock: both are real
 * implementations of the interface, so nothing here asserts against a mock of the thing
 * under test.
 */

const FOUR = createCharsPerTokenEstimator(4);
const TWO = createCharsPerTokenEstimator(2);

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-estimator-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function message(id: string, seq: number, text: string): GraphMessage {
  // `tokens` is set to `text.length` on purpose: it mirrors what both existing runtime
  // fixtures do, and every assertion below would break if any threshold read it.
  return { id, seq, role: "assistant", nodeId: "producer", text, tokens: text.length };
}

/** 84 messages of 400 chars: 8400 tokens under chars/4, 16 800 under chars/2. */
function window(count: number): GraphMessage[] {
  return Array.from({ length: count }, (_, i) => message(`m-${String(i)}`, i, "x".repeat(400)));
}

function digestFixture(): PhaseDigest {
  return {
    phase: "generating",
    runId: "run-estimator",
    createdAt: "2026-08-05T00:00:00.000Z",
    insights: ["The failing assertion was the reducer contract, not the scheduler."],
    modellingChoices: [
      {
        timestamp: "2026-08-05T00:00:00.000Z",
        description: "Model the join as a semilattice",
        rationale: "Order invariance is the only property the barrier can rely on",
        madeBy: "generator",
      },
    ],
    nextSteps: ["Re-run the exactly-once suite at concurrency 8."],
    diagnoses: [
      {
        hypothesis: "The branch commits twice because the task key ignores the branch key.",
        evidence: "Two spans with identical inputHash and different branchKey.",
      },
    ],
  };
}

describe("createCharsPerTokenEstimator", () => {
  it("is ceil(length / charsPerToken), so a non-empty string never costs zero tokens", () => {
    expect(FOUR.estimate("")).toBe(0);
    expect(FOUR.estimate("a")).toBe(1);
    expect(FOUR.estimate("abcd")).toBe(1);
    expect(FOUR.estimate("abcde")).toBe(2);
    expect(TWO.estimate("abcd")).toBe(2);
  });

  it("names itself, so a report can say which estimator produced a number", () => {
    expect(FOUR.id).toBe("chars/4");
    expect(TWO.id).toBe("chars/2");
    expect(createCharsPerTokenEstimator().id).toBe(`chars/${String(DEFAULT_CHARS_PER_TOKEN)}`);
  });

  it("refuses a divisor that is not a positive finite number", () => {
    expect(() => createCharsPerTokenEstimator(0)).toThrow(InvalidCharsPerTokenError);
    expect(() => createCharsPerTokenEstimator(-1)).toThrow(InvalidCharsPerTokenError);
    expect(() => createCharsPerTokenEstimator(Number.NaN)).toThrow(InvalidCharsPerTokenError);
  });
});

describe("estimateMessages reads message TEXT, never GraphMessage.tokens", () => {
  it("sums the estimator's answer over text", () => {
    expect(estimateMessages(window(3), FOUR)).toBe(300);
    expect(estimateMessages(window(3), TWO)).toBe(600);
  });

  it("ignores the provider-reported tokens field entirely", () => {
    // `tokens` here is a wild lie (1_000_000 per message). If any threshold read it, this
    // assertion — and sc-10-10 — would be impossible to satisfy.
    const lying: GraphMessage[] = [
      { id: "a", seq: 0, role: "assistant", nodeId: "n", text: "abcd", tokens: 1_000_000 },
    ];
    expect(estimateMessages(lying, FOUR)).toBe(1);
  });

  it("charges nothing for an offloaded message, whose bytes are not in the window", () => {
    const offloaded: GraphMessage[] = [
      {
        id: "a",
        seq: 0,
        role: "assistant",
        nodeId: "n",
        tokens: 900,
        textRef: {
          uri: "scratch://run-estimator/" + "a".repeat(64) + ".md",
          sha256: "a".repeat(64),
          bytes: 4096,
          kind: "document",
        },
      },
    ];
    expect(estimateMessages(offloaded, FOUR)).toBe(0);
  });

  it("estimateTexts is the same sum over bare strings", () => {
    expect(estimateTexts(["abcd", "abcd"], FOUR)).toBe(2);
    expect(estimateTexts(["abcd", "abcd"], TWO)).toBe(4);
  });
});

describe("sc-10-10: swapping the estimator moves every computed threshold", () => {
  it("decideCompaction: the SAME messages and the SAME cap flip shouldCompact", () => {
    const messages = window(86);
    const cap = 10_000;

    const strict = decideCompaction(messages, cap, FOUR);
    const loose = decideCompaction(messages, cap, createCharsPerTokenEstimator(8));

    // Same cap, same trigger ratio, same messages — only the estimator differs.
    expect(strict.cap).toBe(loose.cap);
    expect(strict.threshold).toBe(loose.threshold);
    expect(strict.tokens).toBe(8600);
    expect(loose.tokens).toBe(4300);
    expect(strict.shouldCompact).toBe(true);
    expect(loose.shouldCompact).toBe(false);
    expect(strict.estimatorId).toBe("chars/4");
    expect(loose.estimatorId).toBe("chars/8");
  });

  it("selectTail: the re-injection window holds a different number of messages", () => {
    const messages = window(86);
    const cap = 10_000;

    const under4 = selectTail(messages, cap, FOUR);
    const under2 = selectTail(messages, cap, TWO);

    // Budget is floor(cap * 0.10) = 1000 tokens for both. At 100 tokens/message that is
    // ten messages; at 200 tokens/message it is five.
    expect(under4.budget).toBe(under2.budget);
    expect(under4.tail).toHaveLength(10);
    expect(under2.tail).toHaveLength(5);
  });

  it("writeDigest: the SAME digest measures to a different token count", async () => {
    const digest = digestFixture();
    const strict = await writeDigest(root, digest, FOUR);
    const loose = await writeDigest(root, digest, TWO);

    expect(strict.markdown).toBe(loose.markdown);
    expect(loose.tokens).toBeGreaterThan(strict.tokens);
    expect(strict.estimatorId).toBe("chars/4");
    expect(loose.estimatorId).toBe("chars/2");
  });

  it("writeDigest: the ceiling is enforced against the CALLER's estimator", async () => {
    const digest = digestFixture();
    const rendered = await writeDigest(root, digest, FOUR);
    // A ceiling between the two answers: accepted by chars/4, refused by chars/2. The
    // ceiling did not move, the estimator did.
    const between = rendered.tokens + 1;
    await expect(writeDigest(root, digest, FOUR, { ceiling: between })).resolves.toBeDefined();
    await expect(writeDigest(root, digest, TWO, { ceiling: between })).rejects.toThrow(
      /above the ceiling/,
    );
  });

  it("assembleSuccessorPrompt: the SAME prompt measures to a different token count", () => {
    const inputs = { digest: digestFixture(), nodeId: "successor", ports: [] };
    const strict = assembleSuccessorPrompt(inputs, FOUR, { predecessorTokens: 10_000 });
    const loose = assembleSuccessorPrompt(inputs, TWO, { predecessorTokens: 10_000 });

    // Byte-identical prompt, identical budget: the only moving part is the estimator.
    expect(strict.text).toBe(loose.text);
    expect(strict.budget).toBe(loose.budget);
    expect(strict.tokens).toBe(Math.ceil(strict.text.length / 4));
    expect(loose.tokens).toBe(Math.ceil(strict.text.length / 2));
    expect(loose.tokens).toBeGreaterThan(strict.tokens);
  });

  it("successorTokenBudget is the only threshold that is estimator-FREE, and deliberately so", () => {
    // It converts a token count that the estimator already produced; introducing a second
    // estimator here would double-count the conversion.
    expect(successorTokenBudget(10_000)).toBe(1500);
    expect(successorTokenBudget(10_000, 0.5)).toBe(5000);
  });

  it("the digest ceiling constant is a token count, not a byte count", () => {
    expect(DIGEST_TOKEN_CEILING).toBe(2000);
  });
});
