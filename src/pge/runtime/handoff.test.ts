import { describe, expect, it } from "vitest";

import { renderDigest } from "./digest.js";
import type { PhaseDigest } from "./digest.js";
import {
  InvalidContextRatioError,
  SUCCESSOR_CONTEXT_RATIO,
  SuccessorPromptTooLargeError,
  assembleSuccessorPrompt,
  successorTokenBudget,
} from "./handoff.js";
import { createCharsPerTokenEstimator, estimateMessages } from "./token-estimator.js";
import type { GraphMessage } from "../state/overall.js";

/**
 * The clean-context handoff, at the unit level: the successor's prompt is CONSTRUCTED from
 * the digest and its own declared ports, and no message list is reachable from the
 * function that builds it.
 *
 * The run-level half of sc-10-5 — reading the assembled prompt back out of the trace — is
 * in `__tests__/engram.invariant.test.ts`, because "captured in the trace" is a claim
 * about a real run and cannot be made here.
 *
 * ── Mutation-proven ──
 *
 * This suite was run against two deliberate breakages and failed on each:
 *  - `assembleSuccessorPrompt` gaining a `messages` parameter and interpolating the last
 *    N of them (the predecessor-id scan then found ids in the prompt);
 *  - `successorTokenBudget` using `Math.ceil` (the budget then rounded UP past the
 *    documented fraction).
 */

const EST = createCharsPerTokenEstimator(4);

function digestFixture(): PhaseDigest {
  return {
    phase: "generating",
    runId: "run-handoff",
    createdAt: "2026-08-05T00:00:00.000Z",
    insights: ["The barrier, not the scheduler, is what makes the fan-in deterministic."],
    modellingChoices: [
      {
        timestamp: "2026-08-05T00:00:01.000Z",
        description: "Model the fan-in join as a semilattice",
        rationale: "Order invariance is the only property a concurrent barrier can rely on",
        madeBy: "generator",
      },
    ],
    nextSteps: ["Re-run the exactly-once suite at concurrency 8."],
    diagnoses: [
      {
        hypothesis: "The branch committed twice because the task key ignored the branch key.",
        evidence: "Two spans share an inputHash and differ only in branchKey.",
      },
    ],
  };
}

/** The predecessor transcript. It exists in this FILE, and nowhere in `handoff.ts`. */
function predecessor(count = 86): GraphMessage[] {
  return Array.from({ length: count }, (_, i) => {
    const id = `m-pred-${String(i).padStart(3, "0")}`;
    const head = `${id}: `;
    const text = head + "x".repeat(400 - head.length);
    return { id, seq: i, role: "assistant" as const, nodeId: "producer", text, tokens: text.length };
  });
}

describe("successorTokenBudget", () => {
  it("is floor(predecessorTokens * ratio), defaulting to the documented 15%", () => {
    expect(SUCCESSOR_CONTEXT_RATIO).toBe(0.15);
    expect(successorTokenBudget(8600)).toBe(1290);
    // floor, not ceil: 8601 * 0.15 = 1290.15 and the budget stays 1290.
    expect(successorTokenBudget(8601)).toBe(1290);
    expect(successorTokenBudget(8600, 0.5)).toBe(4300);
  });

  it("refuses a ratio outside (0, 1] — a successor may not exceed its predecessor", () => {
    expect(() => successorTokenBudget(100, 0)).toThrow(InvalidContextRatioError);
    expect(() => successorTokenBudget(100, 1.5)).toThrow(InvalidContextRatioError);
    expect(successorTokenBudget(100, 1)).toBe(100);
  });
});

describe("sc-10-5 (unit): the prompt is constructed from the digest, never filtered from a transcript", () => {
  it("contains the digest text in full", () => {
    const digest = digestFixture();
    const prompt = assembleSuccessorPrompt(
      { digest, nodeId: "successor", ports: [] },
      EST,
      { predecessorTokens: estimateMessages(predecessor(), EST) },
    );

    expect(prompt.text).toContain(renderDigest(digest));
    for (const heading of ["## Insights", "## Modelling choices", "## Next steps", "## Diagnoses"]) {
      expect(prompt.text).toContain(heading);
    }
  });

  it("contains ZERO message ids from the predecessor transcript", () => {
    const messages = predecessor();
    const prompt = assembleSuccessorPrompt(
      { digest: digestFixture(), nodeId: "successor", ports: [] },
      EST,
      { predecessorTokens: estimateMessages(messages, EST) },
    );

    for (const message of messages) {
      expect(prompt.text, `leaked ${message.id}`).not.toContain(message.id);
    }
    expect(prompt.sourceMessageIds).toEqual([]);
  });

  it("the emptiness is STRUCTURAL: the transcript is not an input, so it cannot leak", () => {
    // Nothing in `SuccessorContextInputs` can hold a message. The proof that the
    // predecessor ids are absent is not "the filter was careful" — there is no filter, and
    // the value below is the entire surface the function sees.
    const inputs = { digest: digestFixture(), nodeId: "successor", ports: [] };
    expect(Object.keys(inputs).sort()).toEqual(["digest", "nodeId", "ports"]);
    expect(assembleSuccessorPrompt(inputs, EST, { predecessorTokens: 10_000 }).sourceMessageIds)
      .toEqual([]);
    expect(
      Object.isFrozen(
        assembleSuccessorPrompt(inputs, EST, { predecessorTokens: 10_000 }).sourceMessageIds,
      ),
    ).toBe(true);
  });

  it("its estimated token count is at most the configured fraction of the predecessor's context", () => {
    const messages = predecessor();
    const predecessorTokens = estimateMessages(messages, EST);
    const prompt = assembleSuccessorPrompt(
      { digest: digestFixture(), nodeId: "successor", ports: [] },
      EST,
      { predecessorTokens },
    );

    expect(predecessorTokens).toBe(8600);
    expect(prompt.budget).toBe(successorTokenBudget(8600));
    expect(prompt.tokens).toBeLessThanOrEqual(prompt.budget);
    expect(prompt.tokens).toBeLessThanOrEqual(Math.floor(predecessorTokens * SUCCESSOR_CONTEXT_RATIO));
  });

  it("includes the node's DECLARED input ports, sorted, and nothing else", () => {
    const prompt = assembleSuccessorPrompt(
      {
        digest: digestFixture(),
        nodeId: "successor",
        ports: [
          { key: "zeta", schemaRef: "PlanSpec", value: { a: 1 } },
          { key: "alpha", schemaRef: "SprintContract", value: "contract-3" },
        ],
      },
      EST,
      { predecessorTokens: 10_000 },
    );

    expect(prompt.text).toContain("## Declared input ports");
    expect(prompt.text).toContain('- alpha (SprintContract): "contract-3"');
    expect(prompt.text).toContain('- zeta (PlanSpec): {"a":1}');
    expect(prompt.text.indexOf("- alpha")).toBeLessThan(prompt.text.indexOf("- zeta"));
  });

  it("declaring no ports says so explicitly rather than emitting an empty section", () => {
    const prompt = assembleSuccessorPrompt(
      { digest: digestFixture(), nodeId: "successor", ports: [] },
      EST,
      { predecessorTokens: 10_000 },
    );
    expect(prompt.text).toContain("- (none declared)");
  });

  it("throws rather than truncating when the prompt will not fit its share", () => {
    const messages = predecessor(2);
    let caught: unknown;
    try {
      assembleSuccessorPrompt(
        { digest: digestFixture(), nodeId: "successor", ports: [] },
        EST,
        { predecessorTokens: estimateMessages(messages, EST) },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SuccessorPromptTooLargeError);
    const error = caught as SuccessorPromptTooLargeError;
    expect(error.nodeId).toBe("successor");
    expect(error.budget).toBe(successorTokenBudget(200));
    expect(error.tokens).toBeGreaterThan(error.budget);
    // Truncation would be worse than failure: a truncated digest is a digest with a
    // section silently missing, which is precisely what the schema exists to prevent.
  });

  it("reports the estimator that produced the number", () => {
    const prompt = assembleSuccessorPrompt(
      { digest: digestFixture(), nodeId: "successor", ports: [] },
      EST,
      { predecessorTokens: 10_000 },
    );
    expect(prompt.estimatorId).toBe("chars/4");
    expect(prompt.tokens).toBe(EST.estimate(prompt.text));
  });

  it("the digest comes FIRST, ahead of the ports", () => {
    const prompt = assembleSuccessorPrompt(
      {
        digest: digestFixture(),
        nodeId: "successor",
        ports: [{ key: "handoff", schemaRef: "PlanSpec", value: 1 }],
      },
      EST,
      { predecessorTokens: 10_000 },
    );
    expect(prompt.text.indexOf("## Insights")).toBeLessThan(
      prompt.text.indexOf("## Declared input ports"),
    );
    expect(prompt.text).toContain("the predecessor's transcript is not available");
  });
});
