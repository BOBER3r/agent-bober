import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerCheckpointMechanism } from "../../orchestrator/checkpoints/registry.js";
import type { CheckpointOutcome } from "../../orchestrator/checkpoints/types.js";
import { FAIL_CLOSED_ERROR_CLASS } from "../runtime/interpreter.js";
import {
  commitCount,
  commitFiles,
  commitSubjects,
  headSha,
  initTempRepo,
} from "../runtime/__fixtures__/temp-repo.js";
import { CODING_GRAPH } from "../topology/coding.graph.js";
import { COMMIT_NODE_IDS, commitMessage, commitSubject } from "./commit.js";
import {
  DOCUMENTATION_REF_KEY,
  DOCUMENTER_NODE_ID,
  DOCUMENTER_NO_COMMIT_INSTRUCTION,
} from "./documenter.js";
import { TERMINAL_REGION, regionSpec, terminalTriple } from "./regions.js";
import {
  registeredIds,
  runSprint,
  sprintConfig,
  sprintContractFixture,
  stubDocumenter,
  stubTerminalBindings,
} from "./__fixtures__/sprint-harness.js";

/**
 * The documenter, the commit approval gate and the git commit (sc-12-9).
 *
 * What each test here exists to catch:
 *
 *  - a commit that happens without a recorded approval. The fail-closed case below runs
 *    against a REAL temporary git repository and asserts three independent facts: the commit
 *    node's handler was never entered, `git rev-parse HEAD` is unchanged, and `git rev-list
 *    --count HEAD` is unchanged. A test that only checked for an error would pass against an
 *    implementation that committed and then reported one;
 *  - a bypass. There is no flag to set (nonGoal 4) and the shipped controller decides, so
 *    the negative case is run through `createInterruptController` with the shipped rules and
 *    the shipped `computeEffectGates` derivation;
 *  - a documenter that commits. `runDocumenter`'s prompt tells the model to
 *    (`documenter-agent.ts:137`) and the node declares only `fs-write`. The assertion is the
 *    absence of a git object after the documenter ran, not the presence of an instruction;
 *  - a conventional message that is conventional only in the test's imagination. The
 *    formatter is unit-tested for its scope, its one-line subject and its length budget, and
 *    the end-to-end case reads the subject back out of `git log`.
 *
 * NO TEST HERE CREATES A GIT OBJECT IN THIS REPOSITORY. Every `cwd` is a fresh `mkdtemp`
 * directory, and the git helpers take an explicit `cwd` with no default for exactly that
 * reason (`runtime/__fixtures__/temp-repo.ts`).
 *
 * Deliberate mutations this suite was run against and failed on:
 *  1. stripping `git` (not only `process-exec`) in         -> the fail-closed case creates a real
 *     `sandboxEffectInterrupts`                              commit and `headSha` changes;
 *  2. `commitNode` calling `commitAll` directly instead of -> the effect registry's declared-tag
 *     through `ctx.effects.invoke`                            check no longer runs, and the
 *                                                             approved case still passes, so the
 *                                                             registry assertion below is what
 *                                                             catches it;
 *  3. `commitSubject` using the contract id as the scope   -> the subject assertions fail;
 *  4. `commitSubject` dropping the length budget           -> the long-title test fails;
 *  5. treating `HitlRejected` as a fail-closed block      -> the rejection case asserts
 *     (or vice versa)                                       `failClosed: false` and
 *                                                           `errorClass: "HitlRejected"`, which is
 *                                                           the distinction ADR-6 draws: a human
 *                                                           saying no is the gate WORKING, and an
 *                                                           unapproved git effect is a run failure.
 */

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-commit-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Answer the approval gate the way `bober approve` does, through the shipped registry. */
function scriptApproval(answers: readonly CheckpointOutcome[]): { asked: string[] } {
  const asked: string[] = [];
  registerCheckpointMechanism("disk", {
    request: (checkpointId): Promise<CheckpointOutcome> => {
      asked.push(checkpointId);
      return Promise.resolve(answers[Math.min(asked.length - 1, answers.length - 1)]);
    },
  });
  return { asked };
}

const COMPLETED = { ...sprintContractFixture(), status: "completed" as const };

// ── The conventional message ────────────────────────────────────────

describe("commitSubject (sc-12-9)", () => {
  it("uses the sprint NUMBER as the conventional scope", () => {
    expect(commitSubject([12], "PGE sprint subgraph")).toBe("bober(sprint-12): PGE sprint subgraph");
  });

  it("spans a range when a run committed several sprints", () => {
    expect(commitSubject([11, 12, 13], "3 sprints")).toBe("bober(sprint-11..13): 3 sprints");
  });

  it("falls back to a bare scope when nothing was committed", () => {
    expect(commitSubject([], "nothing")).toBe("bober(sprint): nothing");
  });

  it("keeps the subject to one line", () => {
    expect(commitSubject([1], "first line\nsecond line")).toBe("bober(sprint-1): first line second line");
  });

  it("truncates on a word boundary rather than wrapping the subject line", () => {
    const subject = commitSubject([1], "a".repeat(20) + " " + "b".repeat(80));
    expect(subject.length).toBeLessThanOrEqual(72);
    expect(subject.endsWith("…")).toBe(true);
    expect(subject).toContain("aaaa");
  });

  it("lists every contract in the body", () => {
    const message = commitMessage([
      { ...sprintContractFixture(), sprintNumber: 12, title: "second", contractId: "c-12" },
      { ...sprintContractFixture(), sprintNumber: 11, title: "first", contractId: "c-11" },
    ]);
    expect(message.split("\n")[0]).toBe("bober(sprint-11..12): 2 sprints");
    expect(message).toContain("- c-11: first");
    expect(message).toContain("- c-12: second");
    // Sorted by sprint number, so two runs that settled in different orders write the same
    // message.
    expect(message.indexOf("c-11")).toBeLessThan(message.indexOf("c-12"));
  });
});

// ── The terminal region, derived from the artifact ──────────────────

describe("the terminal region projection", () => {
  it("derives the documenter, the approval gate and the git node from the artifact", () => {
    const triple = terminalTriple(CODING_GRAPH);
    expect(triple.gitNode).toBe("commit");
    expect(triple.approvalGate).toBe(COMMIT_NODE_IDS.approval);
    expect(triple.documenter).toBe(DOCUMENTER_NODE_ID);

    // The relationship, not the names: the git node is reachable only from a node carrying
    // a HITL policy, which is the ADR-6 inbound-edge rule the interpreter derives too.
    const gate = CODING_GRAPH.nodes.find((node) => node.id === triple.approvalGate);
    expect(gate?.hitl).toBeDefined();
    expect(gate?.effects).toEqual([]);
    const git = CODING_GRAPH.nodes.find((node) => node.id === triple.gitNode);
    expect(git?.effects).toEqual(["git"]);
  });

  it("compiles with an implementation for every projected node", async () => {
    const run = await runSprint({
      projectRoot: root,
      region: TERMINAL_REGION,
      bindings: stubTerminalBindings({ committer: async () => "deadbee" }),
      contracts: [COMPLETED],
    });
    const spec = regionSpec(CODING_GRAPH, TERMINAL_REGION);
    expect(registeredIds(run.graph)).toEqual(spec.nodes.map((node) => node.id).sort());
  }, 20_000);
});

// ── Fail-closed: no approval, no commit ─────────────────────────────

describe("the commit node without an approval record (sc-12-9)", () => {
  it("never executes, and creates no git object in a real repository", async () => {
    await initTempRepo(root);
    await writeFile(join(root, "generated.txt"), "work the run produced\n", "utf-8");
    const before = await headSha(root);
    const countBefore = await commitCount(root);

    const run = await runSprint({
      projectRoot: root,
      region: TERMINAL_REGION,
      // `committer` unbound on purpose: it resolves to the SHIPPED `commitAll`, so if the
      // node were entered a real commit would exist and the assertions below would see it.
      bindings: stubTerminalBindings(),
      contracts: [COMPLETED],
    });

    // 1. The handler was never entered. The interpreter blocks BEFORE dispatch
    //    (`interpreter.ts:1099-1185`), so the commit did not half-happen.
    expect(run.handlerLog.calls[COMMIT_NODE_IDS.commit]).toBeUndefined();

    // 2. The repository is byte-for-byte where it was.
    expect(await headSha(root)).toBe(before);
    expect(await commitCount(root)).toBe(countBefore);
    expect(await commitSubjects(root)).toEqual(["root"]);

    // 3. The block is recorded as a RUN failure with the shipped error class, and the span
    //    carries `failClosed`.
    const failure = run.result.failures.find((entry) => entry.nodeId === COMMIT_NODE_IDS.commit);
    expect(failure?.errorClass).toBe(FAIL_CLOSED_ERROR_CLASS);
    expect(failure?.message).toContain("FAIL_CLOSED");
    expect(failure?.message).toContain("was not executed");
    const span = run.spans.find(
      (entry) => entry.nodeId === COMMIT_NODE_IDS.commit && entry.failClosed === true,
    );
    expect(span?.errorClass).toBe(FAIL_CLOSED_ERROR_CLASS);

    // 4. The gate itself DID run — the block is at the effectful node, which is what makes
    //    a bypass impossible from a node body.
    expect(run.handlerLog.calls[COMMIT_NODE_IDS.approval]).toBe(1);
  }, 30_000);

  it("the documenter runs first, writes the sprint doc, and still creates no commit", async () => {
    await initTempRepo(root);
    const before = await headSha(root);
    const seen = { instructions: [] as string[] };

    const run = await runSprint({
      projectRoot: root,
      region: TERMINAL_REGION,
      bindings: stubTerminalBindings({ documenter: stubDocumenter(seen) }),
      contracts: [COMPLETED],
    });

    expect(run.handlerLog.calls[DOCUMENTER_NODE_ID]).toBe(1);
    // The prohibition really reached the agent, and is not merely a constant in the module.
    expect(seen.instructions.join("\n")).toContain(DOCUMENTER_NO_COMMIT_INSTRUCTION);

    // ── The documenter's PRODUCT, not merely its invocation (sc-12-9) ──
    //
    // "a sprint doc file is written" is a claim about an artifact, so it is asserted about
    // the artifact. Three independent facts, in the order the node produces them:
    //
    //  1. the result was offloaded and its `ScratchRef` reached state. Deleting
    //     `refs: { [DOCUMENTATION_REF_KEY]: ref }` (`documenter.ts:139`) fails here;
    //  2. the document exists on disk at the path the node recorded — the fs-write the
    //     effect declares, performed by the binding exactly as `runDocumenter`'s tool-holding
    //     model performs it. A stub that only RETURNED a path fails here;
    //  3. the note names the contract and that same path. Deleting the `documented … -> …`
    //     message (`documenter.ts:138`) fails here.
    const ref = run.finalState.refs[DOCUMENTATION_REF_KEY];
    expect(ref).toBeDefined();
    const documented = JSON.parse(await run.scratch.text(ref)) as {
      contractId: string;
      sprintDocPath: string;
    };
    expect(documented.contractId).toBe(COMPLETED.contractId);
    expect(documented.sprintDocPath.length).toBeGreaterThan(0);

    const doc = await readFile(join(root, documented.sprintDocPath), "utf-8");
    expect(doc.length).toBeGreaterThan(0);
    expect(doc).toContain(COMPLETED.contractId);

    expect(run.finalState.messages.map((entry) => entry.text ?? "")).toContain(
      `documented ${COMPLETED.contractId} -> ${documented.sprintDocPath}`,
    );

    // The evidence for the prohibition, though, is the repository: the documenter declares
    // `fs-write` and no git object appeared, doc file or not.
    expect(await headSha(root)).toBe(before);
    expect(await commitCount(root)).toBe(1);
  }, 30_000);
});

// ── Approved: exactly one conventional commit ───────────────────────

describe("the commit node behind a recorded approval (sc-12-9)", () => {
  it("creates exactly one conventional commit in a real repository", async () => {
    await initTempRepo(root);
    await writeFile(join(root, "generated.txt"), "work the run produced\n", "utf-8");
    const countBefore = await commitCount(root);
    const { asked } = scriptApproval([{ approved: true }]);

    const run = await runSprint({
      projectRoot: root,
      region: TERMINAL_REGION,
      // The SHIPPED `commitAll`, in the temp repo. Nothing about git is stubbed.
      bindings: stubTerminalBindings(),
      config: sprintConfig({}, { checkpointMechanism: "disk" }),
      contracts: [COMPLETED],
    });

    // The gate was asked, through the shipped checkpoint subsystem, under the ARTIFACT's
    // own checkpoint id — read off the graph here rather than compared against a fixture
    // constant, so this asserts that what the subsystem received is verbatim what the
    // committed topology declares, with nothing adapting it in between.
    expect(asked).toEqual([
      CODING_GRAPH.nodes.find((n) => n.id === "hitl_commit")?.hitl?.checkpointId,
    ]);

    expect(run.handlerLog.calls[COMMIT_NODE_IDS.commit]).toBe(1);
    expect(await commitCount(root)).toBe(countBefore + 1);

    const subjects = await commitSubjects(root);
    expect(subjects[0]).toBe(
      `bober(sprint-${String(COMPLETED.sprintNumber)}): ${COMPLETED.title}`,
    );
    expect(run.result.failures).toEqual([]);

    // sc-12-9 end to end, in one chain: the documenter wrote a doc, the doc is on disk, and
    // the approved commit is the thing that captured it. Without the middle link the
    // criterion's "a sprint doc file is written" is only an assumption about what the
    // documenter node did between being entered and the gate opening.
    const ref = run.finalState.refs[DOCUMENTATION_REF_KEY];
    expect(ref).toBeDefined();
    const { sprintDocPath } = JSON.parse(await run.scratch.text(ref)) as { sprintDocPath: string };
    expect((await readFile(join(root, sprintDocPath), "utf-8")).length).toBeGreaterThan(0);
    expect(await commitFiles(root)).toContain(sprintDocPath);
  }, 30_000);

  it("does not commit when the human rejects", async () => {
    await initTempRepo(root);
    await writeFile(join(root, "generated.txt"), "work the run produced\n", "utf-8");
    const before = await headSha(root);
    scriptApproval([{ approved: false, feedback: "not this revision" }]);

    const run = await runSprint({
      projectRoot: root,
      region: TERMINAL_REGION,
      bindings: stubTerminalBindings(),
      config: sprintConfig({}, { checkpointMechanism: "disk" }),
      contracts: [COMPLETED],
    });

    expect(run.handlerLog.calls[COMMIT_NODE_IDS.commit]).toBeUndefined();
    expect(await headSha(root)).toBe(before);
    expect(await commitCount(root)).toBe(1);

    // The REJECTION was handled before dispatch, by the shipped controller: the gate's own
    // body never ran, the span records `HitlRejected` rather than a fail-closed block — a
    // human saying no is the gate working — and control went to the artifact's declared
    // `hitl.onReject`.
    expect(run.handlerLog.calls[COMMIT_NODE_IDS.approval]).toBeUndefined();
    const gateSpan = run.spans.find((span) => span.nodeId === COMMIT_NODE_IDS.approval);
    expect(gateSpan?.status).toBe("interrupted");
    expect(gateSpan?.errorClass).toBe("HitlRejected");
    expect(gateSpan?.failClosed).toBe(false);
    expect(run.handlerLog.calls["graceful_failure"]).toBe(1);
  }, 30_000);

  it("a FAILING run produces no commit even with an approval on record", async () => {
    // sc-12-9's second half: "a failing sprint produces no commit". The contract never
    // settled, so nothing is documented and nothing is committed.
    await initTempRepo(root);
    const before = await headSha(root);
    scriptApproval([{ approved: true }]);

    const run = await runSprint({
      projectRoot: root,
      region: TERMINAL_REGION,
      bindings: stubTerminalBindings(),
      config: sprintConfig({}, { checkpointMechanism: "disk" }),
      // `proposed`, and no `branchStatus` entry: a contract that never settled.
      contracts: [sprintContractFixture()],
    });

    const message = run.finalState.messages.map((entry) => entry.text ?? "").join("\n");
    expect(message).toContain("no completed contract to document");
    expect(await commitSubjects(root)).toEqual(["root"]);
    expect(await headSha(root)).toBe(before);
    expect(run.handlerLog.calls[DOCUMENTER_NODE_ID]).toBe(1);

    // "nothing settled therefore nothing documented", PROVEN rather than inferred from the
    // message: no documentation ref reached state and no document reached disk. The node was
    // entered — it is the early return inside it that produced nothing.
    expect(run.finalState.refs[DOCUMENTATION_REF_KEY]).toBeUndefined();
    await expect(
      access(join(root, "docs", "sprints", `${sprintContractFixture().contractId}.md`)),
    ).rejects.toThrow();
  }, 30_000);
});
