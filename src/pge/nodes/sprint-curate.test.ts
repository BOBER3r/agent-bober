import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CODING_GRAPH } from "../topology/coding.graph.js";
import {
  MOCK_CATEGORIES,
  MOCK_MANIFEST_REF_KEY,
  MOCK_TEST_MAX,
  MOCK_TEST_MIN,
  gatePolicyOf,
  mockCoverageIssues,
} from "./gates.js";
import {
  MIN_EXPECTED_BEHAVIOR_LENGTH,
  SPRINT_CURATE_NODE_IDS,
  explanationIssues,
  explanationsRefKey,
  sprintTestIds,
} from "./sprint-curate.js";
import {
  enteredNodes,
  runSprint,
  sprintContractFixture,
  stubExplain,
  stubMocks,
  stubSprintBindings,
  underDeliveringExplain,
} from "./__fixtures__/sprint-harness.js";

/**
 * The curator's two nodes and the mock-coverage gate (sc-12-1, sc-12-2).
 *
 * What each test here exists to catch:
 *
 *  - a curator whose "one explanation per test" claim is really "at least one explanation":
 *    the count assertion below is an EQUALITY against the input-test count derived from the
 *    contract, and there is a separate assertion that an explanation for a test nobody asked
 *    about is also a refusal;
 *  - an explanation floor that is satisfied by a stub. The negative fixture answers every
 *    test — with the word "ok" — and is refused on length, so "explained" cannot mean
 *    "responded";
 *  - a mock gate that checks the COUNT and forgets the CATEGORIES, or vice versa. Both
 *    negative fixtures below reach the gate through a real run and are refused there, and
 *    the count fixture (five cases) covers all four categories so it can only fail on count;
 *  - a gate that refuses and lets the downstream node run anyway. `sprint_generate` never
 *    being entered is asserted from `countingNodeRegistry`, which counts handler ENTRY — a
 *    span count would also pass against a node that ran and discarded its result.
 *
 * Every structural fact — the gate's declared `check`, its `gate.onFail` endpoint, the node
 * ids — is read off `CODING_GRAPH`, so a test that agreed with the implementation while both
 * disagreed with the artifact cannot pass.
 *
 * Deliberate mutations this suite was run against and failed on:
 *  1. `explanationIssues` comparing `>=` instead of `===`     -> the same-test-twice fixture passes;
 *  2. dropping the length check from `explanationIssues`      -> the "ok" fixture passes;
 *  3. `mockCoverageIssues` checking only the count            -> the missing-category run passes;
 *  4. `mockCoverageIssues` checking only the categories       -> the five-case run passes;
 *  5. `mockCoverageGate` returning `admitted: true` on issues -> `sprint_generate` is entered in
 *                                                                both negative runs;
 *  6. the explain node routing to its successor on a refusal  -> `sprint_curate_mocks` is entered
 *                                                                in the under-delivering run.
 */

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-curate-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// ── The test set (sc-12-1) ──────────────────────────────────────────

describe("sprintTestIds", () => {
  it("counts test FILES and executable CRITERIA, from the contract itself", () => {
    const contract = sprintContractFixture({
      estimatedFiles: ["src/a.ts", "src/a.test.ts", "src/b.spec.tsx", "docs/notes.md"],
      successCriteria: [
        { criterionId: "sc-x-1", description: "a".repeat(40), verificationMethod: "unit-test", required: true },
        { criterionId: "sc-x-2", description: "b".repeat(40), verificationMethod: "typecheck", required: true },
        // `manual` is in the contract vocabulary but is not something this layer executes.
        { criterionId: "sc-x-3", description: "c".repeat(40), verificationMethod: "manual", required: false },
      ],
    });
    expect(sprintTestIds(contract)).toEqual(["sc-x-1", "sc-x-2", "src/a.test.ts", "src/b.spec.tsx"]);
  });

  it("de-duplicates, so one test is asked about once", () => {
    const contract = sprintContractFixture({
      estimatedFiles: ["src/a.test.ts", "src/a.test.ts"],
      successCriteria: [
        { criterionId: "sc-x-1", description: "a".repeat(40), verificationMethod: "unit-test", required: true },
      ],
    });
    expect(sprintTestIds(contract)).toEqual(["sc-x-1", "src/a.test.ts"]);
  });
});

describe("explanationIssues (sc-12-1)", () => {
  const behavior = "explains precisely what this test asserts and when it fails";

  it("admits exactly one sufficiently long explanation per test", () => {
    expect(behavior.length).toBeGreaterThanOrEqual(MIN_EXPECTED_BEHAVIOR_LENGTH);
    expect(
      explanationIssues(["t1", "t2"], [
        { testId: "t1", expectedBehavior: behavior },
        { testId: "t2", expectedBehavior: behavior },
      ]),
    ).toEqual([]);
  });

  it("refuses a set that is one short", () => {
    const issues = explanationIssues(["t1", "t2"], [{ testId: "t1", expectedBehavior: behavior }]);
    expect(issues.map((issue) => issue.message).join(" ")).toContain("explained 1 test(s)");
    expect(issues.map((issue) => issue.message).join(" ")).toContain("t2");
  });

  it("refuses a set that explains a test nobody asked about", () => {
    // An equality on count alone would accept this: two in, two out.
    const issues = explanationIssues(["t1", "t2"], [
      { testId: "t1", expectedBehavior: behavior },
      { testId: "t9", expectedBehavior: behavior },
    ]);
    expect(issues.some((issue) => issue.message.includes("t9"))).toBe(true);
    expect(issues.some((issue) => issue.message.includes("t2"))).toBe(true);
  });

  it("refuses a set that explains the SAME test twice", () => {
    // Two tests, three explanations, no unknown id and nothing missing. A `>=` comparison
    // would admit this; only an equality catches it.
    const issues = explanationIssues(["t1", "t2"], [
      { testId: "t1", expectedBehavior: behavior },
      { testId: "t1", expectedBehavior: behavior },
      { testId: "t2", expectedBehavior: behavior },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("explained 3 test(s)");
  });

  it("refuses an explanation under the configured minimum length", () => {
    const issues = explanationIssues(["t1"], [{ testId: "t1", expectedBehavior: "ok" }]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain(String(MIN_EXPECTED_BEHAVIOR_LENGTH));
  });
});

describe("the curate node against the committed artifact (sc-12-1)", () => {
  it("explains every test and offloads the set, with the count equal to the input-test count", async () => {
    const contract = sprintContractFixture();
    const expected = sprintTestIds(contract);
    expect(expected.length).toBeGreaterThan(0);

    const run = await runSprint({
      projectRoot: root,
      bindings: stubSprintBindings(),
      contracts: [contract],
    });

    const ref = run.finalState.refs[explanationsRefKey(contract.contractId)];
    expect(ref).toBeDefined();
    const stored = JSON.parse(await run.scratch.text(ref)) as {
      explanations: Array<{ testId: string; expectedBehavior: string }>;
    };

    expect(stored.explanations).toHaveLength(expected.length);
    expect(stored.explanations.map((entry) => entry.testId).sort()).toEqual(expected);
    for (const entry of stored.explanations) {
      expect(entry.expectedBehavior.length).toBeGreaterThanOrEqual(MIN_EXPECTED_BEHAVIOR_LENGTH);
    }
  }, 20_000);

  it("short-circuits the branch when the curator under-delivers, and the mock curator never runs", async () => {
    const contract = sprintContractFixture();
    const run = await runSprint({
      projectRoot: root,
      bindings: stubSprintBindings({ explain: underDeliveringExplain(1) }),
      contracts: [contract],
    });

    // Handler ENTRY, not span count: a node that ran and threw its result away would
    // still have a span.
    expect(run.handlerLog.calls[SPRINT_CURATE_NODE_IDS.mocks]).toBeUndefined();
    expect(run.handlerLog.calls["sprint_generate"]).toBeUndefined();
    // The short-circuit endpoint is the artifact's, not a literal in the body.
    expect(gatePolicyOf(CODING_GRAPH, "gate_sprint_in").onFail).toBe("sprint_exit");
    expect(enteredNodes(run)).toContain("sprint_exit");
    expect(run.finalState.branchStatus[contract.contractId]?.state).toBe("failed");
  }, 20_000);

  it("also short-circuits on a stub answer that is long enough to count but not to help", async () => {
    const run = await runSprint({
      projectRoot: root,
      bindings: stubSprintBindings({ explain: stubExplain(() => "ok") }),
      contracts: [sprintContractFixture()],
    });
    expect(run.handlerLog.calls[SPRINT_CURATE_NODE_IDS.mocks]).toBeUndefined();
  }, 20_000);
});

// ── The mock-coverage gate (sc-12-2) ────────────────────────────────

describe("mockCoverageIssues (sc-12-2)", () => {
  const tests = (count: number, categories: readonly string[]): Parameters<typeof mockCoverageIssues>[0] => ({
    contractId: "c",
    tests: Array.from({ length: count }, (_value, index) => ({
      testId: `m${String(index)}`,
      category: categories[index % categories.length] as (typeof MOCK_CATEGORIES)[number],
      intent: "covers a case",
      path: `tests/m${String(index)}.test.ts`,
    })),
  });

  it("admits a set inside the declared band that covers every category", () => {
    expect(mockCoverageIssues(tests(MOCK_TEST_MIN, MOCK_CATEGORIES))).toEqual([]);
    expect(mockCoverageIssues(tests(MOCK_TEST_MAX, MOCK_CATEGORIES))).toEqual([]);
  });

  it("refuses five cases even when all four categories are covered", () => {
    // Five, spread over all four categories: a category-only check would admit it.
    const issues = mockCoverageIssues(tests(5, MOCK_CATEGORIES));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("5 mock test(s)");
  });

  it("refuses nine cases", () => {
    expect(mockCoverageIssues(tests(9, MOCK_CATEGORIES))[0]?.message).toContain("9 mock test(s)");
  });

  it("refuses a set inside the band that misses a category", () => {
    // Six, so a count-only check would admit it.
    const issues = mockCoverageIssues(tests(6, ["boundary", "empty", "large"]));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("negative");
  });

  it("reports BOTH failures at once, so a re-curation round answers both", () => {
    const issues = mockCoverageIssues(tests(5, ["boundary", "empty"]));
    expect(issues).toHaveLength(2);
  });

  it("refuses a missing manifest rather than treating absence as coverage", () => {
    expect(mockCoverageIssues(null)[0]?.message).toContain("no manifest");
  });
});

describe("the mock gate against the committed artifact (sc-12-2)", () => {
  it("refuses a five-case fixture and never reaches the generator", async () => {
    const run = await runSprint({
      projectRoot: root,
      bindings: stubSprintBindings({ mocks: stubMocks(5, MOCK_CATEGORIES) }),
      contracts: [sprintContractFixture()],
    });

    expect(run.handlerLog.calls["sprint_generate"]).toBeUndefined();
    // The re-curation cycle really was entered: the gate's declared `onFail` is the mock
    // curator, and the artifact's `mockCurationRounds` bound then ends it.
    expect(gatePolicyOf(CODING_GRAPH, "gate_mock_coverage").onFail).toBe("sprint_curate_mocks");
    // At least twice: the gate's refusal re-entered the curator. (The branch then fails,
    // and `reduce_sprints` re-dispatches it once more before `fanoutRetries` runs out, so
    // the exact count is a property of the whole artifact rather than of this gate.)
    expect(run.handlerLog.calls["sprint_curate_mocks"] ?? 0).toBeGreaterThanOrEqual(2);
    expect(run.finalState.refs[MOCK_MANIFEST_REF_KEY]).toBeDefined();
  }, 20_000);

  it("refuses a fixture missing one category and never reaches the generator", async () => {
    const run = await runSprint({
      projectRoot: root,
      bindings: stubSprintBindings({ mocks: stubMocks(6, ["boundary", "empty", "large"]) }),
      contracts: [sprintContractFixture()],
    });
    expect(run.handlerLog.calls["sprint_generate"]).toBeUndefined();
  }, 20_000);

  it("positive control: a compliant fixture reaches the generator", async () => {
    // Without this the two negatives above could both be passing because the gate refuses
    // everything, which would prove nothing about coverage.
    const run = await runSprint({
      projectRoot: root,
      bindings: stubSprintBindings(),
      contracts: [sprintContractFixture()],
    });
    expect(run.handlerLog.calls["sprint_generate"]).toBe(1);
    expect(run.handlerLog.calls["sprint_curate_mocks"]).toBe(1);
  }, 20_000);
});
