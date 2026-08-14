import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DiskCheckpointMechanism } from "../../orchestrator/checkpoints/mechanisms/disk.js";
import {
  getCheckpointMechanism,
  registerCheckpointMechanism,
} from "../../orchestrator/checkpoints/registry.js";
import type { CheckpointMechanism, CheckpointOutcome } from "../../orchestrator/checkpoints/types.js";
import { FAIL_CLOSED_ERROR_CLASS, HITL_REJECTED_ERROR_CLASS } from "../runtime/interpreter.js";
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
  documentedContracts,
  DOCUMENTER_NODE_ID,
  DOCUMENTER_NO_COMMIT_INSTRUCTION,
} from "./documenter.js";
import { TERMINAL_REGION, regionSpec, terminalTriple } from "./regions.js";
import { globalVerdictId } from "./root.js";
import type { OverallState } from "../state/overall.js";
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
let originalDisk: CheckpointMechanism;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-commit-"));
  originalDisk = getCheckpointMechanism("disk");
});

afterEach(async () => {
  // The registry is module state. Restore the shipped instance so no other suite in this
  // worker inherits a mechanism a test here pointed at a stub or at a temp directory that no
  // longer exists — `interrupt.test.ts:95-107`'s hygiene pattern, applied here because a new
  // test below depends on the REAL disk mechanism and the tests above never restored it.
  registerCheckpointMechanism("disk", originalDisk);
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

/**
 * Answer whatever the disk mechanism asks with a REAL approval file, the way `bober approve`
 * does — not `scriptApproval` above, which answers the mechanism call directly and never
 * touches a filesystem. sc-2-4 means the second: a record that survives process exit rather
 * than one synthesised in memory for the duration of this call.
 *
 * Mirrors `src/pge/runtime/interrupt.test.ts`'s `startApprover`: the shipped mechanism
 * deletes a marker written up front and then polls (`disk.ts:80-83`), so the round trip has
 * to happen WHILE the run is blocked, and the marker is written temp-plus-rename because a
 * half-written file makes the mechanism throw.
 */
function startApprover(approvalsDir: string): { stop: () => Promise<string[]> } {
  const answered: string[] = [];
  let running = true;
  const loop = (async (): Promise<void> => {
    while (running) {
      const names = await readdir(approvalsDir).catch(() => [] as string[]);
      for (const name of names) {
        if (!name.endsWith(".pending.json")) continue;
        const id = name.slice(0, -".pending.json".length);
        const marker = join(approvalsDir, `${id}.approved.json`);
        const temp = join(approvalsDir, `.${id}.${String(answered.length)}.answer.tmp`);
        try {
          await writeFile(temp, JSON.stringify({ approvedBy: "test" }), "utf-8");
          await rename(temp, marker);
          answered.push(id);
        } catch {
          // The run finished and its root went away mid-poll. Nothing left to answer.
          running = false;
        }
      }
      if (running) await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
  return {
    stop: async (): Promise<string[]> => {
      running = false;
      await loop;
      return answered;
    },
  };
}

const COMPLETED = { ...sprintContractFixture(), status: "completed" as const };

/**
 * Seed the passing GLOBAL verdict a real run always carries into the terminal region.
 *
 * `commit`'s third lock refuses unless the run's own global evaluation passed, and it
 * refuses an ABSENT verdict too (`./commit.ts`). The terminal region is a projection: it
 * contains the documenter, the approval gate and the commit, and NOT `evaluate_global`, so
 * nothing inside it can produce that row. A whole-graph run reaches `commit` only through
 * `route_after_eval`, which cannot select `pass` without one — so seeding it here supplies
 * what the projection elided rather than relaxing anything the shipped graph enforces.
 *
 * The positive commit cases below use it. The fail-closed cases deliberately do NOT: their
 * subject is the approval gate, and they must keep failing for the reason they name.
 */
function passedGlobally(state: OverallState): Promise<OverallState> {
  return Promise.resolve({
    ...state,
    evaluations: [
      ...state.evaluations,
      {
        id: globalVerdictId(0),
        seq: 0,
        contractId: COMPLETED.contractId,
        sprintNumber: COMPLETED.sprintNumber,
        iteration: 1,
        verdict: "pass" as const,
        summary: "every branch succeeded",
        evalId: null,
      },
    ],
  });
}

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

// ── A failing run is refused the commit, approval or not ────────────

/**
 * The whole-tree commit a FAILED run must never produce.
 *
 * The audited chain: `route_after_eval` selects `partial` when the GLOBAL verdict failed but
 * something passed (`root.ts`), `synthesize`'s sole outbound edge is `-> documenter` — the
 * same successor `pass` takes — so the partial path continues into `hitl_commit` and
 * `commit`. `commitAll` then runs `git add -A` over the entire working tree
 * (`utils/git.ts`), including the failed branches' unevaluated changes, while
 * `commitMessage` is built from `documentedContracts`, which filters to succeeded/completed
 * contracts only (`documenter.ts`). A failed run would commit EVERYTHING, described as only
 * the sprints that passed.
 *
 * These cases pin the guarantee at the commit node, where it is now a DESIGNED refusal. They
 * deliberately do not depend on `partial` being unreachable: each seeds the state that route
 * would produce and asserts the repository is untouched. `nodes/root.test.ts` proves the
 * unreachability separately — that proof and this refusal are independent, which is the
 * point of having both.
 */
describe("the commit node when the run's global verdict did NOT pass", () => {
  /** The `partial` shape exactly: a FAILED global verdict alongside a settled contract. */
  function failedGlobally(state: OverallState): Promise<OverallState> {
    return Promise.resolve({
      ...state,
      evaluations: [
        ...state.evaluations,
        {
          id: globalVerdictId(0),
          seq: 0,
          contractId: COMPLETED.contractId,
          sprintNumber: COMPLETED.sprintNumber,
          iteration: 1,
          verdict: "fail" as const,
          summary: "the run did not pass its global evaluation",
          evalId: null,
        },
      ],
    });
  }

  it("creates NO commit even WITH an approval, and stages none of the working tree", async () => {
    await initTempRepo(root);
    // The unevaluated change a failed branch leaves behind. `git add -A` would sweep it in.
    await writeFile(join(root, "unevaluated.txt"), "a failed branch's work\n", "utf-8");
    const before = await headSha(root);
    const countBefore = await commitCount(root);
    // Approval GRANTED: this test is about the verdict, not the gate. Both locks that
    // already existed are open, and the commit must still not happen.
    scriptApproval([{ approved: true }]);

    const run = await runSprint({
      projectRoot: root,
      region: TERMINAL_REGION,
      // The SHIPPED `commitAll`, in the temp repo — if the node committed, git would show it.
      bindings: stubTerminalBindings(),
      config: sprintConfig({}, { checkpointMechanism: "disk" }),
      contracts: [COMPLETED],
      seed: failedGlobally,
    });

    // The handler DID run — this is not the fail-closed path, and proving that matters:
    // the refusal below is the node's own decision, not the interrupt controller's.
    expect(run.handlerLog.calls[COMMIT_NODE_IDS.commit]).toBe(1);

    // The repository is byte-for-byte where it was.
    expect(await headSha(root)).toBe(before);
    expect(await commitCount(root)).toBe(countBefore);
    // And specifically: the failed branch's file was never staged.
    expect(await commitFiles(root)).not.toContain("unevaluated.txt");

    expect(run.finalState.messages.map((entry) => entry.text ?? "")).toContain(
      'global verdict is "fail" — a failing run produces no commit',
    );
  }, 30_000);

  it("refuses when NO global verdict was recorded at all — absent is not passed", async () => {
    await initTempRepo(root);
    await writeFile(join(root, "unevaluated.txt"), "work nothing evaluated\n", "utf-8");
    const before = await headSha(root);
    scriptApproval([{ approved: true }]);

    // No `seed`: `evaluations` is empty, which is what a state reconstituted from a
    // checkpoint — or any projection lacking `evaluate_global` — looks like.
    const run = await runSprint({
      projectRoot: root,
      region: TERMINAL_REGION,
      bindings: stubTerminalBindings(),
      config: sprintConfig({}, { checkpointMechanism: "disk" }),
      contracts: [COMPLETED],
    });

    expect(run.handlerLog.calls[COMMIT_NODE_IDS.commit]).toBe(1);
    expect(await headSha(root)).toBe(before);
    expect(await commitFiles(root)).not.toContain("unevaluated.txt");
    expect(run.finalState.messages.map((entry) => entry.text ?? "")).toContain(
      "no global verdict recorded — nothing may be committed",
    );
  }, 30_000);

  it("is decided by the VERDICT, not by whether anything settled — the old predicate's blind spot", async () => {
    // `documentedContracts` is NON-EMPTY here (COMPLETED carries `status: "completed"`), so
    // the superseded `contracts.length === 0` guard would have admitted this exact state and
    // committed the whole tree. Asserting the two facts together is what pins the fix rather
    // than the symptom.
    await initTempRepo(root);
    const countBefore = await commitCount(root);
    scriptApproval([{ approved: true }]);

    const run = await runSprint({
      projectRoot: root,
      region: TERMINAL_REGION,
      bindings: stubTerminalBindings(),
      config: sprintConfig({}, { checkpointMechanism: "disk" }),
      contracts: [COMPLETED],
      seed: failedGlobally,
    });

    expect(documentedContracts(run.finalState).length).toBeGreaterThan(0);
    expect(await commitCount(root)).toBe(countBefore);
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
      seed: passedGlobally,
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

// ── A DURABLE approval, not a scripted one (sc-2-1, sc-2-2, sc-2-4) ──

/**
 * Everything above answers the gate through `scriptApproval` — an in-memory
 * `CheckpointMechanism` registered directly as `"disk"`, whose `request()` returns a
 * scripted outcome without ever touching a filesystem. That is exactly what sc-2-4 forbids
 * calling durable: the record has to survive process exit and be something a run reads back
 * off disk, not an answer the test harness fabricates for the duration of one call.
 *
 * These two tests use the REAL, unmodified `DiskCheckpointMechanism` against a real
 * `.bober/approvals/` directory under this test's own temp root — never `process.cwd()` —
 * and answer it the way `bober approve` does: a file, written temp-plus-rename, while the
 * run is blocked polling for it (`startApprover` above; the shipped mechanism deletes a
 * marker written up front, so it cannot be seeded before the run starts — `disk.ts:80-83`).
 */
describe("the commit node behind a DURABLE disk approval, not a scripted one (sc-2-1, sc-2-2, sc-2-4)", () => {
  it("executes — span status ok, not interrupted/FailClosed — when a real approval file answers the gate", async () => {
    await initTempRepo(root);
    await writeFile(join(root, "generated.txt"), "work the run produced\n", "utf-8");
    const countBefore = await commitCount(root);

    const approvalsDir = join(root, ".bober", "approvals");
    await mkdir(approvalsDir, { recursive: true });
    registerCheckpointMechanism(
      "disk",
      new DiskCheckpointMechanism(approvalsDir, { pollMs: 5, timeoutMs: 10_000 }),
    );
    const approver = startApprover(approvalsDir);

    const run = await runSprint({
      projectRoot: root,
      region: TERMINAL_REGION,
      // The SHIPPED `commitAll`, in the temp repo — nothing about git is stubbed.
      bindings: stubTerminalBindings(),
      config: sprintConfig({}, { checkpointMechanism: "disk" }),
      contracts: [COMPLETED],
      seed: passedGlobally,
    });
    const answered = await approver.stop();

    // The approval really was a file the mechanism read off disk, not a value handed back
    // in-process: `answered` is populated only by the temp-plus-rename write above. De-duped
    // for the same reason `interrupt.test.ts`'s `startApprover` callers de-dupe it: the
    // approver's own poll and the mechanism's poll both run every 5ms, so the same pending
    // marker can occasionally be seen — and answered again, harmlessly — twice before the
    // mechanism has consumed the first answer.
    expect([...new Set(answered)]).toEqual(["end-of-pipeline"]);

    const span = run.spans.find((entry) => entry.nodeId === COMMIT_NODE_IDS.commit);
    expect(span?.status).toBe("ok");
    expect(span?.failClosed).toBeUndefined();
    expect(span?.errorClass).toBeUndefined();

    expect(run.handlerLog.calls[COMMIT_NODE_IDS.commit]).toBe(1);
    expect(await commitCount(root)).toBe(countBefore + 1);
    expect(run.result.failures).toEqual([]);
  }, 30_000);

  it("is STILL refused when disk is configured but no approval ever arrives (sc-2-2)", async () => {
    // Routing the gate to a durable mechanism must not itself grant anything — approval
    // requires an actual record, not merely a non-noop mechanism being configured. No
    // approver runs here, so the mechanism polls, finds nothing, and times out (a short
    // timeout is what keeps that fast rather than 24 hours) — the SAME real
    // `DiskCheckpointMechanism` the test above uses, minus the approval.
    //
    // A timed-out `hitl_commit` is a REJECTION of hitl_commit's own gate
    // (`errorClass: "HitlRejected"`, `interpreter.ts:1167-1201` — `hitl !== undefined` for
    // `hitl_commit`, so `failClosed` is false there and the block is not pushed to
    // `run.result.failures`), and the run routes straight to `hitl_commit.hitl.onReject` —
    // `commit` is never even ADMITTED, so it opens no span at all. That is a DIFFERENT node
    // and a different errorClass than the FAIL_CLOSED guard `interrupt.ts:523` protects
    // (which the unmodified, default-noop test above already pins: `mechanismName !==
    // "noop"` is what stops autopilot recording a grant, and that guard is untouched — this
    // file's diff of `interrupt.ts` is empty). What this test adds is the other half of
    // sc-2-2: a durable mechanism being CONFIGURED is not itself an approval, so the same
    // observable guarantee — no commit handler entered, no git object created — holds even
    // when the run is routed at the real disk mechanism and nobody answers it.
    await initTempRepo(root);
    await writeFile(join(root, "generated.txt"), "work the run produced\n", "utf-8");
    const before = await headSha(root);
    const countBefore = await commitCount(root);

    const approvalsDir = join(root, ".bober", "approvals");
    await mkdir(approvalsDir, { recursive: true });
    registerCheckpointMechanism(
      "disk",
      new DiskCheckpointMechanism(approvalsDir, { pollMs: 5, timeoutMs: 50 }),
    );

    const run = await runSprint({
      projectRoot: root,
      region: TERMINAL_REGION,
      bindings: stubTerminalBindings(),
      config: sprintConfig({}, { checkpointMechanism: "disk" }),
      contracts: [COMPLETED],
    });

    expect(run.handlerLog.calls[COMMIT_NODE_IDS.commit]).toBeUndefined();
    expect(run.handlerLog.calls[COMMIT_NODE_IDS.approval]).toBeUndefined();
    expect(await headSha(root)).toBe(before);
    expect(await commitCount(root)).toBe(countBefore);

    const gateSpan = run.spans.find((entry) => entry.nodeId === COMMIT_NODE_IDS.approval);
    expect(gateSpan?.status).toBe("interrupted");
    expect(gateSpan?.errorClass).toBe(HITL_REJECTED_ERROR_CLASS);
    expect(gateSpan?.failClosed).toBe(false);
    expect(run.handlerLog.calls["graceful_failure"]).toBe(1);

    // No span for `commit` at all — it was never admitted, which is a STRONGER absence than
    // "opened a span and was refused".
    expect(run.spans.find((entry) => entry.nodeId === COMMIT_NODE_IDS.commit)).toBeUndefined();
  }, 30_000);
});
