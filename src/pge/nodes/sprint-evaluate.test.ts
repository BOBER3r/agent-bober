import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { replaceIfNewer } from "../registry/reducers.js";
import { createFixedClock } from "../runtime/commit.js";
import { readFailureArtifact } from "../runtime/graceful-failure.js";
import { CODING_GRAPH } from "../topology/coding.graph.js";
import type { SprintContract } from "../../contracts/sprint-contract.js";
import { anchorId } from "./anchors.js";
import { SPRINT_GATE_IDS, gatePolicyOf, loopBoundOf } from "./gates.js";
import { isCorrectionPayload } from "./sprint-correct.js";
import type { CorrectionPayload } from "./sprint-correct.js";
import { EVALUATOR_FAIL_CLOSED_ERROR_CLASS } from "./sprint-evaluate.js";
import { SPRINT_REGION, regionSpec } from "./regions.js";
import { SETTLED_CONTRACT_STATUSES } from "../../contracts/sprint-contract.js";
import {
  DEFAULT_QUALITY_SCORE_THRESHOLD,
  selectVerification,
} from "./verification.js";
import {
  enteredNodes,
  registeredIds,
  runSprint,
  scriptedEvaluator,
  sprintConfig,
  sprintContractFixture,
  stubEvaluation,
  stubEvaluator,
  stubGenerator,
  stubSprintBindings,
  underDeliveringExplain,
} from "./__fixtures__/sprint-harness.js";
import type { SprintRun } from "./__fixtures__/sprint-harness.js";

/**
 * The syntax gate, the corrector, the evaluator, the anchor gate, selective verification and
 * the sprint subgraph end to end (sc-12-3, sc-12-4, sc-12-5, sc-12-6, sc-12-7, sc-12-8,
 * sc-12-10, sc-12-12).
 *
 * What each test here exists to catch:
 *
 *  - a syntax gate that "blocks" by routing somewhere the evaluator also reaches. Both
 *    assertions are made: `sprint_evaluate`'s handler is never ENTERED (from
 *    `countingNodeRegistry`, which counts entry rather than spans), and the corrector's input
 *    carries the diagnostics;
 *  - a "verbatim" claim that compares a REFORMATTED message. The assertion below reads the
 *    scratch FILE the sandbox itself wrote (`await scratch.text(payload.stderrRef)`) and
 *    compares it to the exact bytes the child process emitted, byte for byte;
 *  - a correction that reaches state but not the PROMPT. The second generator entry's
 *    recorded input is inspected, and separately the handoff the generator built is checked
 *    for the excerpt;
 *  - an evaluator guard that catches a THROW and not a malformed RETURN, or vice versa. Both
 *    are exercised, both must route to the corrector, and both must record `failClosed` in
 *    the trace;
 *  - a selective-verification claim asserted by "the node did not run". There is no such
 *    node; the assertion counts SANDBOX INVOCATIONS at the one seam every execution passes
 *    through;
 *  - a sandbox denial or timeout treated as a pass. Both are driven through the real runner
 *    and both must produce a correction, never a `pass` label;
 *  - a loop bound re-implemented in a node body. The bound asserted below is read off the
 *    ARTIFACT (`loopBoundOf`), and the counter it checks is the one the interpreter writes.
 *
 * Deliberate mutations this suite was run against and failed on:
 *  1. `syntaxGate` returning `admitted: true` on a failing command  -> `sprint_evaluate` is entered;
 *  2. `buildCorrection` re-rendering stderr instead of carrying the -> the verbatim comparison
 *     sandbox's own `stderrRef`                                        fails on the exact bytes;
 *  3. `sprintHandoff` dropping `correctionInstructions`             -> the prompt assertion fails;
 *  4. `evaluateGuarded` returning `{kind:"ok"}` on a parse failure  -> the malformed-evaluator run
 *                                                                      reaches `sprint_review`;
 *  5. dropping the `failClosed` span                                -> both sc-12-6 cases fail;
 *  6. `selectVerification` testing the score BEFORE the doc rule    -> the docs-only case invokes
 *                                                                      the suite;
 *  7. `sandboxCorrectionSource` returning `null` for `denied`       -> the denial routes to `pass`;
 *  8. a node body inventing its own retry counter beside the      -> the "no second bound" assertion
 *     artifact's (a SAME-key hand increment is inert: the             in sc-12-7 finds an undeclared
 *     interpreter overwrites it at `interpreter.ts:1305`, which       counter key.
 *     is itself worth knowing)
 */

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-eval-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// ── Helpers ─────────────────────────────────────────────────────────

/** The exact bytes the failing fixture writes to stderr. Compared byte-for-byte below. */
const DIAGNOSTIC_TEXT = [
  "src/example.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'.",
  "src/example.ts(19,3): error TS2554: Expected 2 arguments, but got 1.",
  "",
].join("\n");

/** A node script that prints `DIAGNOSTIC_TEXT` on stderr and exits non-zero. */
async function writeFailingTypecheck(dir: string): Promise<void> {
  await writeFile(
    join(dir, "typecheck.cjs"),
    `process.stderr.write(${JSON.stringify(DIAGNOSTIC_TEXT)});\nprocess.exit(2);\n`,
    "utf-8",
  );
}

/** A node script that ignores SIGTERM and never exits. */
async function writeHangingSuite(dir: string): Promise<void> {
  await writeFile(
    join(dir, "hang.cjs"),
    "process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\nprocess.stdout.write('alive');\n",
    "utf-8",
  );
}

/** A shell script the sandbox must refuse to run, and the marker it would have written. */
async function writeShellSuite(dir: string, marker: string): Promise<void> {
  await writeFile(join(dir, "suite.sh"), `#!/bin/sh\necho executed > ${marker}\n`, "utf-8");
}

/** Every correction the corrector was handed, in order. */
function correctionsInto(run: SprintRun, nodeId: string): CorrectionPayload[] {
  return (run.inputLog.inputs[nodeId] ?? []).filter(isCorrectionPayload);
}

/** Sandbox invocations attributed to one node. */
function sandboxCallsFrom(run: SprintRun, nodeId: string): number {
  return run.sandboxLog.calls.filter((call) => call.nodeId === nodeId).length;
}

// ── sc-12-3: the syntax gate blocks traversal ───────────────────────

describe("the syntax gate (sc-12-3)", () => {
  it("blocks traversal, never reaches the evaluator, and carries the diagnostics verbatim", async () => {
    await writeFailingTypecheck(root);
    const run = await runSprint({
      projectRoot: root,
      config: sprintConfig({ typecheck: "node typecheck.cjs" }),
      bindings: stubSprintBindings(),
      contracts: [sprintContractFixture()],
      maxSupersteps: 120,
    });

    // 1. The gate ran, and the security node and the evaluator did not. Handler ENTRY.
    expect(run.handlerLog.calls[SPRINT_GATE_IDS.syntax]).toBeGreaterThanOrEqual(1);
    expect(run.handlerLog.calls["sprint_evaluate"]).toBeUndefined();
    expect(run.handlerLog.calls["sprint_security"]).toBeUndefined();
    expect(enteredNodes(run)).not.toContain("sprint_review");

    // 2. The route is the artifact's declared `gate.onFail`, not a literal in the body.
    expect(gatePolicyOf(CODING_GRAPH, SPRINT_GATE_IDS.syntax).onFail).toBe("sprint_correct");
    const corrections = correctionsInto(run, "sprint_correct");
    expect(corrections.length).toBeGreaterThanOrEqual(1);
    expect(corrections[0].source).toBe("syntax");

    // 3. VERBATIM: the bytes on disk are the bytes the child wrote. Not a summary of them,
    //    not a re-render — the file the sandbox itself created.
    const ref = corrections[0].stderrRef;
    expect(ref).not.toBeNull();
    if (ref === null) return;
    expect(await run.scratch.text(ref)).toBe(DIAGNOSTIC_TEXT);

    // 4. And the bounded inline excerpt is a genuine PREFIX of those bytes, so a reader of
    //    state sees real diagnostics rather than a placeholder.
    expect(DIAGNOSTIC_TEXT.startsWith(corrections[0].excerpt)).toBe(true);
    expect(corrections[0].excerpt).toContain("TS2322");
  }, 30_000);

  it("positive control: a passing typecheck reaches the evaluator", async () => {
    await writeFile(join(root, "typecheck.cjs"), "process.exit(0);\n", "utf-8");
    const run = await runSprint({
      projectRoot: root,
      config: sprintConfig({ typecheck: "node typecheck.cjs" }),
      bindings: stubSprintBindings(),
      contracts: [sprintContractFixture()],
      maxSupersteps: 120,
    });
    expect(run.handlerLog.calls["sprint_evaluate"]).toBe(1);
    expect(sandboxCallsFrom(run, SPRINT_GATE_IDS.syntax)).toBe(1);
  }, 30_000);
});

// ── sc-12-4: the correction reaches the next prompt ─────────────────

describe("the correction loop (sc-12-4)", () => {
  it("routes back to the generator with the payload, and the next prompt contains it", async () => {
    await writeFailingTypecheck(root);
    const run = await runSprint({
      projectRoot: root,
      config: sprintConfig({ typecheck: "node typecheck.cjs" }),
      bindings: stubSprintBindings(),
      contracts: [sprintContractFixture()],
      maxSupersteps: 120,
    });

    // The TRACE shows the hop, not just the implementation's intent.
    // The sandbox opens its OWN span under the calling node's id (`sandbox.ts:186`), so the
    // routed span is selected rather than the first one.
    const gateSpans = run.spans.filter(
      (span) => span.nodeId === SPRINT_GATE_IDS.syntax && span.route !== undefined,
    );
    expect(gateSpans.length).toBeGreaterThanOrEqual(1);
    expect(gateSpans[0].route?.goto.node).toBe("sprint_correct");

    const correctorSpans = run.spans.filter((span) => span.nodeId === "sprint_correct");
    expect(correctorSpans[0]?.route?.goto.node).toBe("sprint_generate");

    // The SECOND generator entry is the rework, and its input IS the correction.
    const generatorInputs = run.inputLog.inputs["sprint_generate"] ?? [];
    expect(generatorInputs.length).toBeGreaterThanOrEqual(2);
    const second = generatorInputs[1];
    expect(isCorrectionPayload(second)).toBe(true);
    if (!isCorrectionPayload(second)) return;
    expect(second.critique.length).toBeGreaterThan(0);
    expect(DIAGNOSTIC_TEXT).toContain(second.excerpt.trimEnd().split("\n")[0]);

    // And it is recorded in state, so a resumed process can still see what was said.
    const correction = run.finalState.messages.find((message) =>
      message.id.startsWith("correction:"),
    );
    expect(correction?.text).toContain("TS2322");
    expect(correction?.text).toContain("Critique:");
  }, 30_000);

  it("puts the payload in the generator's own PROMPT, not only in state", async () => {
    // The claim sc-12-4 actually makes. `handoff.instructions` is the field `runGenerator`
    // renders into the model's user turn, so this records exactly what the agent was asked.
    await writeFailingTypecheck(root);
    const prompts: string[] = [];
    const run = await runSprint({
      projectRoot: root,
      config: sprintConfig({ typecheck: "node typecheck.cjs" }),
      bindings: stubSprintBindings({
        generator: async (handoff) => {
          prompts.push(handoff.instructions);
          return { success: true, notes: "generated", filesChanged: ["src/example.ts"] };
        },
      }),
      contracts: [sprintContractFixture()],
      maxSupersteps: 120,
    });

    expect(prompts.length).toBeGreaterThanOrEqual(2);
    // The FIRST prompt has no correction in it — otherwise "the second prompt contains it"
    // would be true of every prompt and would prove nothing.
    expect(prompts[0]).not.toContain("TS2322");
    expect(prompts[1]).toContain("TS2322");
    expect(prompts[1]).toContain("Critique:");
    expect(prompts[1]).toContain("gate_syntax");
    // The scratch reference travels with it, so the generator can find the whole file.
    expect(prompts[1]).toContain("scratch://");
    expect(run.handlerLog.calls["sprint_correct"]).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("keeps the whole correction message inside the channel's 4096-byte budget", async () => {
    // A megabyte of diagnostics must not become a megabyte of state. The offloading
    // discipline is what makes the verbatim claim and the byte guard compatible.
    await writeFile(
      join(root, "typecheck.cjs"),
      // `process.exitCode` rather than `process.exit`, which would truncate the pending
      // write and make the byte count a property of the fixture rather than of the store.
      `process.stderr.write("x".repeat(200000));\nprocess.exitCode = 1;\n`,
      "utf-8",
    );
    const run = await runSprint({
      projectRoot: root,
      config: sprintConfig({ typecheck: "node typecheck.cjs" }),
      bindings: stubSprintBindings(),
      contracts: [sprintContractFixture()],
      maxSupersteps: 120,
    });

    const corrections = correctionsInto(run, "sprint_correct");
    expect(corrections.length).toBeGreaterThanOrEqual(1);
    expect(corrections[0].excerptTruncated).toBe(true);
    expect(corrections[0].stderrRef?.bytes).toBe(200_000);

    const messages = run.finalState.messages.filter((message) =>
      message.id.startsWith("correction:"),
    );
    expect(messages.length).toBeGreaterThanOrEqual(1);
    // The commit boundary measures each UPDATE VALUE individually against the channel's
    // `maxInlineBytes` (`runtime/commit.ts:358-369`), and the corrector contributes one
    // message per execution. So each message — envelope, critique and excerpt together —
    // has to clear 4096 bytes on its own.
    for (const message of messages) {
      expect(Buffer.byteLength(JSON.stringify([message]), "utf8")).toBeLessThan(4096);
    }
    // And nothing was silently dropped: a `StateBloatError` is recorded as a TaskFailure
    // rather than thrown, so its absence is the evidence the payload was committed.
    expect(run.result.failures.filter((f) => f.errorClass === "StateBloat")).toEqual([]);
  }, 30_000);
});

// ── sc-12-5: anchor regression rejects a genuine trade ──────────────

describe("the anchor-regression gate (sc-12-5)", () => {
  it("rejects an iteration that fixed the targeted test and broke a green anchor", async () => {
    // Iteration 1 leaves sc-a and sc-b green and sc-c failing. Iteration 2 fixes sc-c AND
    // breaks sc-b — a genuine trade, in one evaluation.
    const { evaluator } = scriptedEvaluator([
      async () =>
        stubEvaluation({
          details: [
            { criterion: "sc-a", passed: true },
            { criterion: "sc-b", passed: true },
            { criterion: "sc-c", passed: false },
          ],
        }),
      async () =>
        stubEvaluation({
          details: [
            { criterion: "sc-a", passed: true },
            { criterion: "sc-b", passed: false },
            { criterion: "sc-c", passed: true },
          ],
        }),
    ]);

    const run = await runSprint({
      projectRoot: root,
      bindings: stubSprintBindings({ evaluator }),
      contracts: [sprintContractFixture()],
      maxSupersteps: 200,
    });

    // The anchors really were carried in state, by the setUnion channel.
    expect(run.finalState.testAnchors).toContain(anchorId("unit-test", "sc-a"));
    expect(run.finalState.testAnchors).toContain(anchorId("unit-test", "sc-b"));

    // The targeted test WAS fixed on iteration 2 …
    const verdicts = run.finalState.evaluations.filter(
      (entry) => entry.verdict !== "skipped",
    );
    const traded = verdicts.find((entry) => entry.summary.includes("[anchor-regression]"));
    expect(traded).toBeDefined();
    expect(traded?.summary).toContain(anchorId("unit-test", "sc-b"));
    expect(traded?.summary).toContain("fixed");

    // … and the iteration was REJECTED anyway. The branch never reaches review.
    expect(traded?.verdict).toBe("fail");
    expect(run.handlerLog.calls["sprint_review"]).toBeUndefined();
    expect(run.finalState.branchStatus[sprintContractFixture().contractId]?.state).toBe("failed");

    // Routed by the gate's own declared onFail, not by the router.
    expect(gatePolicyOf(CODING_GRAPH, SPRINT_GATE_IDS.anchorRegression).onFail).toBe(
      "sprint_correct",
    );
  }, 30_000);

  it("positive control: an iteration that breaks no anchor reaches review", async () => {
    // The anchors are SEEDED into the channel, exactly as a previous iteration would have
    // left them, so the comparison happens on iteration 1. It has to: `sprintIterations` is
    // shared between `sprint_route` and `sprint_correct` (`coding.graph.ts:623,644`), so one
    // correction lap costs two of the three declared iterations and the router's second
    // evaluation is already at the bound. That is the artifact's arithmetic, not this
    // implementation's, and it is reported rather than worked around.
    const run = await runSprint({
      projectRoot: root,
      bindings: stubSprintBindings({
        evaluator: stubEvaluator(
          stubEvaluation({
            details: [
              { criterion: "sc-a", passed: true },
              { criterion: "sc-c", passed: true },
            ],
          }),
        ),
      }),
      contracts: [sprintContractFixture()],
      seed: async (state) => ({ ...state, testAnchors: [anchorId("unit-test", "sc-a")] }),
      maxSupersteps: 200,
    });
    expect(run.handlerLog.calls["sprint_review"]).toBe(1);
    expect(run.finalState.branchStatus[sprintContractFixture().contractId]?.state).toBe(
      "succeeded",
    );
  }, 30_000);

  it("rejects the trade in ONE iteration when the anchors are already recorded", async () => {
    // The same claim as the two-iteration case, with the prior-iteration state supplied
    // rather than produced: sc-b was green, this iteration fixes sc-c and breaks sc-b.
    const run = await runSprint({
      projectRoot: root,
      bindings: stubSprintBindings({
        evaluator: stubEvaluator(
          stubEvaluation({
            details: [
              { criterion: "sc-b", passed: false },
              { criterion: "sc-c", passed: true },
            ],
          }),
        ),
      }),
      contracts: [sprintContractFixture()],
      seed: async (state) => ({ ...state, testAnchors: [anchorId("unit-test", "sc-b")] }),
      maxSupersteps: 200,
    });

    const traded = run.finalState.evaluations.find((entry) =>
      entry.summary.includes("[anchor-regression]"),
    );
    expect(traded?.verdict).toBe("fail");
    expect(traded?.summary).toContain(anchorId("unit-test", "sc-b"));
    // The trade really happened: sc-c went green in the same evaluation.
    expect(traded?.summary).toContain(anchorId("unit-test", "sc-c"));
    expect(run.handlerLog.calls["sprint_review"]).toBeUndefined();

    const corrections = correctionsInto(run, "sprint_correct");
    expect(corrections.some((payload) => payload.source === "anchor")).toBe(true);
  }, 30_000);
});

// ── sc-12-6: an evaluator that fails never looks like one that passed ──

describe("evaluator failure modes (sc-12-6)", () => {
  it("routes a THROWN evaluator error to the corrector and records failClosed", async () => {
    const run = await runSprint({
      projectRoot: root,
      bindings: stubSprintBindings({
        evaluator: async () => {
          throw new Error("provider refused the evaluation");
        },
      }),
      contracts: [sprintContractFixture()],
      maxSupersteps: 200,
    });

    expect(run.handlerLog.calls["sprint_review"]).toBeUndefined();
    const corrections = correctionsInto(run, "sprint_correct");
    expect(corrections.some((payload) => payload.source === "evaluator")).toBe(true);
    expect(corrections.map((payload) => payload.critique).join(" ")).toContain(
      "provider refused the evaluation",
    );

    const failClosedSpans = run.spans.filter(
      (span) => span.failClosed === true && span.errorClass === EVALUATOR_FAIL_CLOSED_ERROR_CLASS,
    );
    expect(failClosedSpans.length).toBeGreaterThanOrEqual(1);
    expect(failClosedSpans[0].nodeId).toBe("sprint_evaluate");
    expect(failClosedSpans[0].status).toBe("failed");
  }, 30_000);

  it("routes a MALFORMED evaluator result to the corrector and records failClosed", async () => {
    const run = await runSprint({
      projectRoot: root,
      bindings: stubSprintBindings({
        // Not an `EvaluationRunResult` at all — the shape a stub or a broken plugin emits.
        evaluator: async () =>
          ({ verdict: "looks fine to me" } as unknown as Awaited<
            ReturnType<NonNullable<Parameters<typeof stubSprintBindings>[0]["evaluator"]>>
          >),
      }),
      contracts: [sprintContractFixture()],
      maxSupersteps: 200,
    });

    expect(run.handlerLog.calls["sprint_review"]).toBeUndefined();
    const corrections = correctionsInto(run, "sprint_correct");
    expect(corrections.some((payload) => payload.source === "evaluator")).toBe(true);
    expect(corrections.map((payload) => payload.critique).join(" ")).toContain(
      "not an EvaluationRunResult",
    );

    const failClosedSpans = run.spans.filter((span) => span.failClosed === true);
    expect(failClosedSpans.length).toBeGreaterThanOrEqual(1);
    expect(failClosedSpans.every((span) => span.errorClass === EVALUATOR_FAIL_CLOSED_ERROR_CLASS)).toBe(
      true,
    );
  }, 30_000);

  it("positive control: a well-formed passing evaluation reaches review and records no failClosed", async () => {
    const run = await runSprint({
      projectRoot: root,
      bindings: stubSprintBindings(),
      contracts: [sprintContractFixture()],
    });
    expect(run.handlerLog.calls["sprint_review"]).toBe(1);
    expect(run.spans.filter((span) => span.failClosed === true)).toEqual([]);
  }, 30_000);
});

// ── sc-12-7: the rework loop is bounded by the artifact ─────────────

describe("the rework loop bound (sc-12-7)", () => {
  it("re-enters at most maxIterations times, carries the critique, and ends in graceful failure", async () => {
    const bound = loopBoundOf(CODING_GRAPH, SPRINT_GATE_IDS.route);
    expect(bound.counterKey).toBe("sprintIterations");

    const contract = sprintContractFixture();
    const run = await runSprint({
      projectRoot: root,
      bindings: stubSprintBindings({
        evaluator: stubEvaluator(stubEvaluation({ details: [{ criterion: "sc-f-1", passed: false }] })),
      }),
      contracts: [contract],
      maxSupersteps: 200,
    });

    // The bound is the ARTIFACT's, and the counter is the interpreter's.
    const counterKey = `${bound.counterKey}.${contract.contractId}`;
    expect(run.finalState.counters[counterKey]).toBe(bound.maxIterations);

    // NO SECOND BOUND. Every counter key the run committed is one the ARTIFACT declares on
    // some node, so a body that invented a private counter — the way a hand-rolled retry
    // limit would — shows up here as an undeclared key. (A same-key hand increment is
    // harmlessly overwritten by the interpreter's fold at `interpreter.ts:1305`; an
    // off-by-one KEY is not, and this is what catches it.)
    const declaredCounters = new Set(
      CODING_GRAPH.nodes
        .map((node) => node.loop?.counterKey)
        .filter((key): key is string => key !== undefined),
    );
    for (const key of Object.keys(run.finalState.counters)) {
      expect(declaredCounters.has(key.split(".")[0])).toBe(true);
    }
    expect(run.handlerLog.calls["sprint_correct"] ?? 0).toBeGreaterThanOrEqual(1);
    expect(run.handlerLog.calls["sprint_correct"] ?? 0).toBeLessThanOrEqual(bound.maxIterations);

    // Every re-entry into the generator after the first carried a critique.
    const generatorInputs = (run.inputLog.inputs["sprint_generate"] ?? []).slice(1);
    expect(generatorInputs.length).toBeGreaterThanOrEqual(1);
    for (const input of generatorInputs) {
      expect(isCorrectionPayload(input)).toBe(true);
      if (isCorrectionPayload(input)) expect(input.critique.length).toBeGreaterThan(0);
    }

    // The interpreter recorded the bound doing its job rather than the run stopping quietly.
    const exhausted = run.result.failures.filter((failure) => failure.errorClass === "LoopExhausted");
    expect(exhausted.some((failure) => failure.nodeId === SPRINT_GATE_IDS.route)).toBe(true);

    // And the run terminated through the sprint-9 graceful-failure path, on disk.
    expect(run.handlerLog.calls["graceful_failure"]).toBe(1);
    const artifact = await readFailureArtifact(root, run.runId);
    expect(artifact.runId).toBe(run.runId);
    expect(artifact.formatVersion).toBe(1);
  }, 60_000);
});

// ── sc-12-8: selective verification ─────────────────────────────────

describe("selectVerification (sc-12-8)", () => {
  it("skips the expensive suite for a docs-only diff", () => {
    const decision = selectVerification({
      changedFiles: ["docs/sprints/s12.md", "README.md"],
      qualityScore: 100,
    });
    expect(decision).toEqual({ runExpensive: false, reason: "docs-only", triggeredBy: [] });
  });

  it("skips it even when the score is low, because the diff cannot break a test", () => {
    // The ordering claim: the doc rule is checked BEFORE the score.
    const decision = selectVerification({
      changedFiles: ["docs/a.md"],
      qualityScore: 5,
    });
    expect(decision.runExpensive).toBe(false);
    expect(decision.reason).toBe("docs-only");
  });

  it("runs it for a diff touching a declared high-risk path, whatever the score", () => {
    const decision = selectVerification({
      changedFiles: ["docs/a.md", "src/orchestrator/pipeline.ts"],
      qualityScore: 100,
      highRiskPaths: ["src/orchestrator/**"],
    });
    expect(decision.runExpensive).toBe(true);
    expect(decision.reason).toBe("high-risk-path");
    expect(decision.triggeredBy).toEqual(["src/orchestrator/pipeline.ts"]);
  });

  it("runs it for a low-risk diff whose intermediate quality score is below threshold", () => {
    const decision = selectVerification({
      changedFiles: ["scripts/release.mjs"],
      qualityScore: DEFAULT_QUALITY_SCORE_THRESHOLD - 1,
      highRiskPaths: ["src/**"],
    });
    expect(decision.runExpensive).toBe(true);
    expect(decision.reason).toBe("low-quality-score");
  });

  it("skips a low-risk diff whose score is fine", () => {
    const decision = selectVerification({
      changedFiles: ["scripts/release.mjs"],
      qualityScore: DEFAULT_QUALITY_SCORE_THRESHOLD,
      highRiskPaths: ["src/**"],
    });
    expect(decision.runExpensive).toBe(false);
    expect(decision.reason).toBe("low-risk-and-passing");
  });
});

describe("selective verification through the evaluator node (sc-12-8)", () => {
  const suiteConfig = (): ReturnType<typeof sprintConfig> =>
    sprintConfig(
      { test: "node suite.cjs" },
      { pge: { selectiveVerification: { highRiskPaths: ["src/**"], qualityScoreThreshold: 70 } } },
    );

  async function runWith(files: string[], score: number): Promise<SprintRun> {
    await writeFile(join(root, "suite.cjs"), "process.exit(0);\n", "utf-8");
    return runSprint({
      projectRoot: root,
      config: suiteConfig(),
      bindings: stubSprintBindings({
        generator: stubGenerator(files),
        evaluator: stubEvaluator(
          stubEvaluation({ details: [{ criterion: "sc-f-1", passed: true }], score }),
        ),
      }),
      contracts: [sprintContractFixture()],
      maxSupersteps: 120,
    });
  }

  it("a docs-only diff does not invoke the suite", async () => {
    const run = await runWith(["docs/sprints/s12.md"], 95);
    // Counted at the one seam every execution passes through. There is no "expensive suite
    // node" in the artifact to assert the absence of.
    expect(sandboxCallsFrom(run, "sprint_evaluate")).toBe(0);
    expect(run.handlerLog.calls["sprint_evaluate"]).toBe(1);
  }, 30_000);

  it("a diff touching a declared high-risk path invokes it", async () => {
    const run = await runWith(["src/orchestrator/pipeline.ts"], 95);
    expect(sandboxCallsFrom(run, "sprint_evaluate")).toBe(1);
  }, 30_000);

  it("a low-risk diff with a below-threshold score invokes it anyway", async () => {
    const run = await runWith(["scripts/release.mjs"], 40);
    expect(sandboxCallsFrom(run, "sprint_evaluate")).toBe(1);
  }, 30_000);
});

// ── sc-12-10: the sandbox is the only execution path ────────────────

describe("sandbox refusal and timeout (sc-12-10)", () => {
  it("refuses a denied binary without spawning it, and routes to correction", async () => {
    const marker = join(root, "side-effect.txt");
    await writeShellSuite(root, marker);
    const run = await runSprint({
      projectRoot: root,
      // `sh` is on `DEFAULT_DENY_BINARIES`; the deny check runs BEFORE the allowlist and
      // before `execa` is reached (`sandbox.ts:206-209`).
      config: sprintConfig({ test: "sh suite.sh" }),
      bindings: stubSprintBindings({
        generator: stubGenerator(["src/example.ts"]),
        evaluator: stubEvaluator(
          stubEvaluation({ details: [{ criterion: "sc-f-1", passed: true }], score: 95 }),
        ),
      }),
      contracts: [sprintContractFixture()],
      maxSupersteps: 200,
    });

    // The proof that nothing spawned: the side effect the script would have had.
    await expect(
      import("node:fs/promises").then((fs) => fs.stat(marker)),
    ).rejects.toMatchObject({ code: "ENOENT" });

    // The denial was RECORDED and routed, never swallowed.
    const corrections = correctionsInto(run, "sprint_correct");
    expect(corrections.some((payload) => payload.source === "sandbox-denied")).toBe(true);
    expect(corrections.map((payload) => payload.critique).join(" ")).toContain("denylisted");

    // And it never became a pass.
    expect(run.handlerLog.calls["sprint_review"]).toBeUndefined();
    const passSpans = run.spans.filter(
      (span) => span.nodeId === SPRINT_GATE_IDS.route && span.route?.goto.label === "pass",
    );
    expect(passSpans).toEqual([]);
  }, 60_000);

  it("kills a non-terminating suite at the configured timeout and routes to correction", async () => {
    await writeHangingSuite(root);
    const run = await runSprint({
      projectRoot: root,
      config: sprintConfig({ test: "node hang.cjs" }, { pge: { sandboxTimeoutMs: 700 } }),
      bindings: stubSprintBindings({
        generator: stubGenerator(["src/example.ts"]),
        evaluator: stubEvaluator(
          stubEvaluation({ details: [{ criterion: "sc-f-1", passed: true }], score: 95 }),
        ),
      }),
      contracts: [sprintContractFixture()],
      maxSupersteps: 200,
      // A short budget, so the run resolves rather than hanging the suite. The KILL is the
      // shipped runner's (`SANDBOX_FORCE_KILL_AFTER_MS`), not this test's.
      sandbox: (real) => real,
    });

    const corrections = correctionsInto(run, "sprint_correct");
    expect(corrections.some((payload) => payload.source === "sandbox-timeout")).toBe(true);
    expect(run.handlerLog.calls["sprint_review"]).toBeUndefined();
  }, 60_000);
});

// ── sc-12-12: the subgraph compiles from the artifact and runs ──────

describe("the sprint subgraph, compiled from the committed artifact (sc-12-12)", () => {
  it("projects the region out of CODING_GRAPH rather than a hand-built fixture", () => {
    const spec = regionSpec(CODING_GRAPH, SPRINT_REGION);

    // Every node object is the artifact's own, by structural identity with it.
    for (const node of spec.nodes) {
      const source = CODING_GRAPH.nodes.find((entry) => entry.id === node.id);
      expect(source).toBeDefined();
      expect(node).toEqual(source);
    }
    // And the whole declared subgraph interior is present.
    const declared = CODING_GRAPH.nodes
      .filter((node) => node.subgraph === SPRINT_REGION)
      .map((node) => node.id)
      .sort();
    expect(declared.length).toBe(14);
    for (const id of declared) {
      expect(spec.nodes.some((node) => node.id === id)).toBe(true);
    }
  });

  it("compiles with an implementation for every projected node", async () => {
    const run = await runSprint({
      projectRoot: root,
      bindings: stubSprintBindings(),
      contracts: [sprintContractFixture()],
    });
    const spec = regionSpec(CODING_GRAPH, SPRINT_REGION);
    expect(registeredIds(run.graph)).toEqual(spec.nodes.map((node) => node.id).sort());
  }, 30_000);

  it("runs end to end and produces the .bober/ artifacts the imperative cycle produces", async () => {
    const contract = sprintContractFixture();
    const persisted: string[] = [];
    const versions: (number | undefined)[] = [];
    const run = await runSprint({
      projectRoot: root,
      bindings: stubSprintBindings({
        writeContract: async (_projectRoot, written) => {
          persisted.push(`${written.contractId}:${written.status}`);
          versions.push(written.version);
        },
      }),
      contracts: [contract],
    });

    expect(run.result.status).toBe("completed");
    expect(run.result.failures).toEqual([]);

    // Every declared node ran, except the corrector — which a passing branch never enters,
    // and which sc-12-4 and sc-12-7 exercise on the failing path.
    const declared = CODING_GRAPH.nodes
      .filter((node) => node.subgraph === SPRINT_REGION && node.id !== "sprint_correct")
      .map((node) => node.id);
    expect(declared).toHaveLength(13);
    for (const id of declared) expect(run.handlerLog.calls[id]).toBeGreaterThanOrEqual(1);

    // The branch settled, the contract was persisted through the SHIPPED writer, and the
    // contract channel carries the settled status the imperative pipeline writes.
    //
    // DELIBERATE EDIT (sc-5-3, sprint 5 of spec-20260812-terminal-vocabulary): before this
    // sprint the comment above was FALSE — `runSprintCycle` wrote "passed" for a settled
    // sprint while `sprint_exit` (exercised here) wrote "completed", so the two engines
    // spelled the same outcome two different ways. This sprint changed the write at
    // pipeline.ts:589 to "completed", making the comment literally true for the first time.
    // The assertion below still pins `sprint_exit`'s own write (unchanged — this file pins
    // the PGE side, never the imperative one), but the SECOND assertion ties that write to
    // the shared settled-status vocabulary both engines' readers now share, rather than
    // merely restating the same literal a second time.
    expect(run.finalState.branchStatus[contract.contractId]).toEqual({
      state: "succeeded",
      attempts: 1,
    });
    expect(persisted).toEqual([`${contract.contractId}:completed`]);
    expect(SETTLED_CONTRACT_STATUSES.has("completed")).toBe(true);

    // sc-3-2: sprint_exit writes a monotone `version` on the settled contract, and it is
    // the SAME number `branchStatus` records as `attempts` — the two channels agree on the
    // ordering discriminator for this branch.
    expect(versions).toEqual([1]);
    expect(versions[0]).toBe(run.finalState.branchStatus[contract.contractId].attempts);

    // The commit boundary ALSO persisted the contract channel to `.bober/contracts/`, which
    // is the same path and the same shape the imperative pipeline writes.
    expect(run.artifactLog.contracts.some((id) => id === contract.contractId)).toBe(true);

    // FORMER KNOWN LIMITATION, now fixed (sprint 4 of spec-20260812-terminal-vocabulary):
    // the `sprintContracts` channel used to keep the seeded `proposed` copy because
    // `appendById` resolved a duplicate `contractId` by CANONICAL ORDER, under which
    // `"completed" < "proposed"` lexically. `mergeEntries` now resolves by RANK
    // (`registry/reducers.ts`, `rankIsGreater`) instead: the settled copy's `version`
    // (written just above) outranks the seeded copy, which carries no `version` at all, so
    // the settled copy wins the channel regardless of what the two `status` strings sort as.
    expect(
      run.finalState.sprintContracts.find((entry) => entry.contractId === contract.contractId)
        ?.status,
    ).toBe("completed");
  }, 30_000);

  it("the written version is REPLAY-STABLE: two independent runs over the same input write the same value (sc-3-3)", async () => {
    const contract = sprintContractFixture({ contractId: "sprint-fixture-replay-stable" });
    const versions: (number | undefined)[] = [];

    for (let i = 0; i < 2; i++) {
      const versionsForRun: (number | undefined)[] = [];
      const run = await runSprint({
        projectRoot: root,
        bindings: stubSprintBindings({
          writeContract: async (_projectRoot, written) => {
            versionsForRun.push(written.version);
          },
        }),
        contracts: [contract],
      });
      expect(run.result.status).toBe("completed");
      expect(versionsForRun).toHaveLength(1);
      versions.push(versionsForRun[0]);
    }

    // Derived only from `state.evaluations` (a count, order-invariant), which a fresh run
    // over the same input rebuilds identically — no clock, superstep, or spanId involved.
    expect(versions[0]).toBeDefined();
    expect(versions[0]).toBe(versions[1]);
  }, 30_000);
});

// ── sc-5-1, sc-5-2, sc-5-3: the settled contract carries the RAW pair, from the
// producing node, not the seed (sprint 5 of spec-20260814-pge-full-convergence) ──

describe("the settled contract carries evaluatorFeedback and generatorNotes from the node that owns them (sc-5-1, sc-5-2, sc-5-3)", () => {
  it("the settled contract's evaluatorFeedback is the RAW evaluator summary and generatorNotes is the RAW generator notes, on a passing branch", async () => {
    const contract = sprintContractFixture();
    const written: SprintContract[] = [];
    const run = await runSprint({
      projectRoot: root,
      bindings: stubSprintBindings({
        writeContract: async (_projectRoot, contractWritten) => {
          written.push(contractWritten);
        },
      }),
      contracts: [contract],
    });

    expect(run.result.status).toBe("completed");
    expect(written).toHaveLength(1);
    // `stubEvaluation`'s raw summary is "all criteria met" (`sprint-harness.ts:222`) — NOT
    // decorated with a `[decision.reason]` suffix, which is what `evaluations[].summary`
    // (the channel's own DECORATED copy) would carry instead.
    expect(written[0].evaluatorFeedback).toBe("all criteria met");
    expect(written[0].evaluatorFeedback).not.toContain("[");
    // `stubGenerator`'s raw notes are `generated ${contractId}` (`sprint-harness.ts:184`).
    expect(written[0].generatorNotes).toBe(`generated ${contract.contractId}`);

    // And the channel copy the commit boundary flushes to `.bober/contracts/` carries the
    // identical pair — the same object `written` above, not a second one built differently.
    const channelCopy = run.finalState.sprintContracts.find(
      (entry) => entry.contractId === contract.contractId,
    );
    expect(channelCopy?.evaluatorFeedback).toBe(written[0].evaluatorFeedback);
    expect(channelCopy?.generatorNotes).toBe(written[0].generatorNotes);
  }, 30_000);

  it("on a PASSING branch, the settled evaluatorFeedback/generatorNotes equal the node's raw values even when the seed disagrees (sc-5-1, sc-5-2)", async () => {
    // NOT a proof that the strip at sprint-review.ts:276-279 is load-bearing, despite the
    // seeded contract disagreeing with the outcome below: on THIS branch `outcome.
    // evaluatorFeedback`/`generatorNotes` are always defined, and object-spread's
    // last-key-wins semantics mean the outcome's value overrides the seed whether or not the
    // seed was stripped first. Deleting the destructure-then-spread at sprint-review.ts:
    // 276-279 (`...contractWithoutFeedback` -> `...contract`, no destructure) does NOT make
    // this test fail — confirmed by running it against that mutation. The discriminating test
    // is the one immediately below, which routes through a path where `outcome` carries no
    // raw value to override with.
    const contract = sprintContractFixture({
      generatorNotes: "SEEDED — must not survive",
      evaluatorFeedback: "SEEDED — must not survive",
    });
    const written: SprintContract[] = [];
    const run = await runSprint({
      projectRoot: root,
      bindings: stubSprintBindings({
        writeContract: async (_projectRoot, contractWritten) => {
          written.push(contractWritten);
        },
      }),
      contracts: [contract],
    });

    expect(run.result.status).toBe("completed");
    expect(written).toHaveLength(1);
    expect(written[0].evaluatorFeedback).toBe("all criteria met");
    expect(written[0].generatorNotes).toBe(`generated ${contract.contractId}`);
    expect(written[0].evaluatorFeedback).not.toBe("SEEDED — must not survive");
    expect(written[0].generatorNotes).not.toBe("SEEDED — must not survive");
  }, 30_000);

  it("the SEEDED evaluatorFeedback/generatorNotes do NOT survive when the decisive verdict carries neither raw value — proves the strip at sprint-review.ts:276-279 is load-bearing (sc-5-3)", async () => {
    // `underDeliveringExplain(1)` makes the curate region's own admission check refuse before
    // `sprint_generate` — let alone `sprint_evaluate` — ever runs, so `sprint_exit`'s
    // `outcome.evaluatorFeedback`/`generatorNotes` are genuinely `undefined` (the same
    // refusal short-circuit the curator test below exercises, but seeded with a STALE value
    // here, which that one deliberately is not). With no raw value for `outcome` to
    // contribute, the ONLY thing standing between the seeded string below and `settled` is
    // the destructure-then-spread that strips `evaluatorFeedback`/`generatorNotes` off
    // `contract` BEFORE the settled object is built (sprint-review.ts:276-279).
    //
    // MUTATION VERIFIED: deleting the destructure at :276-278 and changing
    // `...contractWithoutFeedback` to `...contract` at :279 makes this test FAIL — the seeded
    // string below survives onto `settled` because nothing else overrides it (`outcome`
    // contributes `{}` for both fields on this branch). Restoring the shipped code makes it
    // pass again. The test above does not detect that same mutation.
    const contract = sprintContractFixture({
      evaluatorFeedback: "SEEDED — must not survive",
      generatorNotes: "SEEDED — must not survive",
    });
    const written: SprintContract[] = [];
    const run = await runSprint({
      projectRoot: root,
      bindings: stubSprintBindings({
        explain: underDeliveringExplain(1),
        writeContract: async (_projectRoot, contractWritten) => {
          written.push(contractWritten);
        },
      }),
      contracts: [contract],
    });

    expect(enteredNodes(run)).toContain("sprint_exit");
    expect(run.handlerLog.calls["sprint_generate"]).toBeUndefined();
    expect(written.length).toBeGreaterThanOrEqual(1);
    for (const entry of written) {
      expect(entry.status).toBe("failed");
      // ABSENT, not merely different from the stale string — the doc comment's claim
      // (sprint-review.ts:266-274) is that omission is what protects this field when
      // `outcome` carries nothing, and this is the assertion that backs it.
      expect("evaluatorFeedback" in entry).toBe(false);
      expect("generatorNotes" in entry).toBe(false);
      expect(entry.evaluatorFeedback).not.toBe("SEEDED — must not survive");
      expect(entry.generatorNotes).not.toBe("SEEDED — must not survive");
    }
  }, 30_000);

  it("on a FAILING branch that exhausts its retry budget, evaluatorFeedback/generatorNotes still carry the last decisive attempt's raw values, not a synthesised fallback", async () => {
    const contract = sprintContractFixture();
    const written: SprintContract[] = [];
    const run = await runSprint({
      projectRoot: root,
      bindings: stubSprintBindings({
        evaluator: stubEvaluator(
          stubEvaluation({ details: [{ criterion: "sc-f-1", passed: false }] }),
        ),
        writeContract: async (_projectRoot, contractWritten) => {
          written.push(contractWritten);
        },
      }),
      contracts: [contract],
      maxSupersteps: 200,
    });

    expect(run.result.status).toBe("completed");
    // `sprint_exit` is entered MORE THAN ONCE on this shape: `sprint_route` and
    // `sprint_correct` share the `sprintIterations` counter (`coding.graph.ts:709,730`) and
    // both declare `onExhausted: "sprint_exit"`, so a branch that exhausts the budget while
    // still failing can revisit the settle node — a pre-existing engine characteristic of
    // this exact loop shape, unrelated to this sprint (reproduced identically before any
    // sprint-5 edit). Every write must still agree, so every one is checked rather than
    // asserting a literal count this sprint did not create and is not scoped to fix.
    expect(written.length).toBeGreaterThanOrEqual(1);
    for (const entry of written) {
      expect(entry.status).toBe("failed");
      // `stubEvaluation`'s raw failing summary, undecorated (`sprint-harness.ts:222`).
      expect(entry.evaluatorFeedback).toBe("criteria failed");
      expect(entry.generatorNotes).toBe(`generated ${contract.contractId}`);
    }
  }, 30_000);

  it("a curator short-circuit reaches sprint_exit via a refusal and settles the branch WITHOUT either field — absent, not a synthesised placeholder", async () => {
    // `underDeliveringExplain(1)` makes the curate region's own admission check refuse
    // before `sprint_generate` — let alone `sprint_evaluate` — ever runs, exactly the
    // `sprint-curate.test.ts` fixture that proves the same short-circuit reaches
    // `sprint_exit` (`gatePolicyOf(CODING_GRAPH, "gate_sprint_in").onFail === "sprint_exit"`,
    // `enteredNodes(run)` contains `"sprint_exit"`). No generator result is ever offloaded
    // and no evaluation verdict is ever recorded for this branch, so there is nothing for
    // `sprint_exit` to carry — the honest answer sc-5-3/the stop condition ask for.
    const contract = sprintContractFixture();
    const written: SprintContract[] = [];
    const run = await runSprint({
      projectRoot: root,
      bindings: stubSprintBindings({
        explain: underDeliveringExplain(1),
        writeContract: async (_projectRoot, contractWritten) => {
          written.push(contractWritten);
        },
      }),
      contracts: [contract],
    });

    expect(enteredNodes(run)).toContain("sprint_exit");
    expect(run.handlerLog.calls["sprint_generate"]).toBeUndefined();
    expect(written.length).toBeGreaterThanOrEqual(1);
    for (const entry of written) {
      expect(entry.status).toBe("failed");
      expect("evaluatorFeedback" in entry).toBe(false);
      expect("generatorNotes" in entry).toBe(false);
    }
  }, 30_000);
});

describe("the settled contract's `version` outranks the seeded copy under versionRank (sc-3-4)", () => {
  it("replaceIfNewer.merge picks the settled copy over the seeded one, in both directions, with an IDENTICAL updatedAt", () => {
    // The same instant `.bober/golden/replay-full-run-evaluation-passes.json` shows the
    // seeded `plan.materialize` copy and the settled `sprint.exit` copy sharing byte for
    // byte: proof `updatedAt` is a genuine tie here, not an artifact of this test's setup.
    const updatedAt = createFixedClock("2026-08-05T00:00:00.000Z").nowIso();

    const seeded = sprintContractFixture({ status: "proposed", updatedAt });
    // The seeded copy carries no `version` key at all — exactly what `plan_materialize`
    // produces (sc-3-1's absence guarantee), not `version: 0`.
    expect("version" in seeded).toBe(false);

    const settled = { ...seeded, status: "completed" as const, updatedAt, version: 1 };

    expect(replaceIfNewer.merge(seeded, [settled])).toEqual(settled);
    expect(replaceIfNewer.merge(settled, [seeded])).toEqual(settled);
  });

  it("control: with version absent from BOTH copies and updatedAt held equal too, the seeded copy wins instead — proving the test above is version deciding, not an accident of canonicalJson", () => {
    const updatedAt = createFixedClock("2026-08-05T00:00:00.000Z").nowIso();

    const seeded = sprintContractFixture({ status: "proposed", updatedAt });
    // Same transition as above (`status: "proposed" -> "completed"`, same `updatedAt`) but
    // with NO `version` on either copy — the pre-sc-3-2 world. `"completed" < "proposed"`
    // lexically, so canonicalJson — the last tiebreak — favors the seeded copy.
    const settledNoVersion = { ...seeded, status: "completed" as const, updatedAt };

    expect(replaceIfNewer.merge(seeded, [settledNoVersion])).toEqual(seeded);
    expect(replaceIfNewer.merge(settledNoVersion, [seeded])).toEqual(seeded);
  });
});
