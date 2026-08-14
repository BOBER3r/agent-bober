import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOLDEN_RUN_ID, createGoldenExecutor } from "./executor.js";
import { GOLDEN_MIN_REPLAY_CASES, isReplayCase, parseGoldenCase } from "./case-schema.js";
import type { GoldenCase } from "./case-schema.js";

/**
 * WHICH nodes the committed `replay` cases actually execute.
 *
 * ── Why this exists ──
 *
 * The dataset's headline number is how many CASES it holds, and that number says nothing
 * about what is enforced: five cases that walk the same happy path enforce one path. The
 * number that matters is how much of the committed graph the executed cases reach, and
 * until this file there was no way to know it without instrumenting a run by hand.
 *
 * So the executed set is PINNED, in both directions:
 *
 *   - a node that stops being executed fails, because coverage silently regressing is the
 *     failure this file exists to prevent;
 *   - a node that STARTS being executed also fails, because {@link NEVER_EXECUTED} is a
 *     list of claims about WHY each node is unreachable, and a node leaving it means one of
 *     those claims stopped being true and should be deleted deliberately.
 *
 * That is the same two-directional pin `conformance.engines.test.ts` puts on the divergence
 * set, for the same reason: a list nobody is forced to maintain rots into a lie.
 *
 * ── What a covered node does and does not prove ──
 *
 * Executed means the node's body RAN inside a replay and its artifacts matched the
 * committed expectation. It does not mean the node is correct — the expectation was
 * captured from the same code. Coverage bounds what a golden failure can be attributed to;
 * it is not a quality measure. See the golden dataset section of docs/pge-graph.md.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const GOLDEN_DIR = join(REPO_ROOT, ".bober", "golden");
const ARTIFACT = join(REPO_ROOT, ".bober", "topology", "coding.json");

/**
 * The nodes no committed case executes, each with the reason it does not.
 *
 * "Executes" means at least one span with `status: "ok"` (see {@link executedNodeIdsFromSpans}) —
 * a node that opens a span and is then refused, interrupted or fails is REACHED, not
 * executed, and does not belong on the opposite side of this list. Sprint 9 of
 * spec-20260812-pge-real-workload-errors corrected the rule to say that (it previously read
 * `nodeId` off a span with no status check at all).
 *
 * ── `commit` and `finalize` left this list at sprint 2 of spec-20260814-pge-full-convergence ──
 *
 * Both sat here on the same claim: `commit` is refused FAIL_CLOSED under the autopilot
 * `noop` mechanism before its body is ever entered — `noop` grants no durable approval
 * (`src/pge/runtime/interrupt.ts:38-46,523`) — and `finalize`'s only inbound edge is
 * `commit -> finalize`, so a `commit` that never completes `"ok"` means that edge is never
 * crossed either. Neither was a structural impossibility — nothing about the graph's shape
 * forbade covering them, the way it forbids reaching `synthesize` below — it was that
 * nothing in this repository ever ran `end-of-pipeline` under a mechanism other than `noop`.
 * `replay-full-run-commit-approved` closes that gap: the SAME scenario
 * `replay-full-run-evaluation-passes` pins, executed under `goldenApprovedConfig()` instead
 * of `goldenConfig()` — the one config change this dataset now allows a case to opt into,
 * via `input.config: { approved: true }` (`executor.ts`'s `resolveGoldenConfig`) — so
 * `end-of-pipeline` resolves to the real, unmodified `DiskCheckpointMechanism` and a
 * real approval marker, written to disk by a test-scoped approver while the run is blocked
 * (`executor.ts`'s `withGoldenApproval`), answers it. `commit`'s body runs, performs its one
 * pinned `git.commit` call, and control reaches `finalize`. Both nodes therefore leave this
 * list on the strength of an actual `status: "ok"` span from a real replay — the rule this
 * file enforces did not relax; a case that satisfies it now exists.
 *
 * `critique` and `rework_route` are genuinely a **missing scenario**, not a structural
 * block — nothing here claims otherwise for them specifically. `context_compact` and
 * `synthesize` ARE structural: no set of bindings, however imaginative, can make case
 * authoring close them, which is exactly why they are recorded here rather than left as a
 * to-do:
 *
 *  - `context_compact`'s only edge in is `supervisor -> context_compact` under the `compact`
 *    label, and the shipped supervisor never selects that label: the committed artifact
 *    declares `supervisor.reads` as exactly `["branchStatus", "counters", "evaluations",
 *    "spec"]` — no `messages` — so deciding a window crossed a compression threshold would
 *    mean reading a channel the artifact does not authorise. Re-checked directly against
 *    `.bober/topology/coding.json` for this sprint (unchanged since `1.2.0`, and unmoved by
 *    the `specDraft` channel `1.4.0` added). Recorded as artifact drift in
 *    `nodes/supervisor.ts`.
 *  - `critique` sits behind `route_after_eval`'s `rework` label, chosen whenever
 *    `evaluate_global` returns a non-pass verdict while `reworkRoundsTaken` is still under
 *    budget. `reduce_sprints`'s own gate (`all-branches-settled`) refuses to admit the run
 *    into evaluation at all while any branch is `failed`/`abandoned` — it re-dispatches
 *    such a branch through `fanout_sprints` instead (bounded by `fanoutRetries`) — so
 *    `evaluate_global` is only ever reached once EVERY dispatched branch has already
 *    settled `"succeeded"`. The only way it can still return a non-pass verdict there is
 *    `gradeContracts` grading a contract `"fail"` (or leaving it `"ungraded"`) despite its
 *    branch succeeding — which happens for real whenever a branch needed even one
 *    correction round: `gradeContracts` reduces EVERY recorded verdict for a contract, and
 *    a single `"fail"` row anywhere in that history outweighs a later `"pass"` permanently
 *    (`nodes/root.ts`, `gradeContracts`). None of the committed `replay` cases drives
 *    this — the one case whose branch fails outright is caught by `reduce_sprints` before
 *    reaching `evaluate_global` at all (see `rework_route`'s bullet), and the one case that
 *    exercises `sprint_correct` does so through `gate_syntax`/`gate_anchor_regression`,
 *    neither of which writes a `SprintVerdict`. This is a genuine gap in the dataset, not a
 *    wall: a case pinning a corrected-but-recorded-fail sprint alongside an otherwise
 *    passing run would exercise it.
 *  - `rework_route` is reached only immediately after `critique`, so it inherits `critique`'s
 *    gap — but even in that missing scenario it would not do useful work. Its dispatch rule,
 *    `dispatchableContracts`, re-offers a branch only while its `branchStatus` is not
 *    `"succeeded"`/`"abandoned"` (`nodes/sprint-fanout.ts`), and by the time `rework_route`
 *    can run at all every dispatched branch's status IS `"succeeded"` — `reduce_sprints`'s
 *    gate guarantees it, per `critique`'s bullet. So `rework_route`'s own first (and, see
 *    `synthesize`'s bullet, only ever) invocation would choose the `"exhausted"` label, not
 *    `"rework"`, and still produce a `status: "ok"` span — it is a missing-scenario node
 *    like `critique`, and the case that would exercise `critique` exercises this node too.
 *  - `synthesize` is a genuine STRUCTURAL block, unlike its two neighbours above — its
 *    recorded reason was rewritten at sprint 9 of spec-20260812-pge-real-workload-errors. It
 *    sits behind `route_after_eval`'s `partial` label, selected only when
 *    `reworkRoundsTaken(spec, state) >= maxIterations` (2) at a SECOND invocation of
 *    `route_after_eval` — which never happens. `route_after_eval` and `rework_route` read
 *    the identical counter and the identical `maxIterations` off the SAME artifact loop
 *    bound (`loopBoundOf(spec, "rework_route")`), and the interpreter enforces that bound
 *    independently, at `rework_route` itself, using the counter value already including
 *    this execution's own increment (`boundedDestination`, `src/pge/runtime/
 *    interpreter.ts:1004-1044`). Because `rework_route`'s dispatch set is always empty when
 *    it runs (previous bullet), it never selects its own `"rework"` fan-out — the only edge
 *    that would loop back through the sprint subgraph and return to `evaluate_global` a
 *    second time — so it always exits to `graceful_failure` on its first and only
 *    invocation per run, and `reworkRounds` can reach at most 1, never the bound of 2.
 *    `route_after_eval` is therefore invoked AT MOST ONCE per run, and its own
 *    `reworkRoundsTaken >= maxIterations` branch — `"partial"` and, for that matter, its
 *    `"exhausted"` sibling — can never fire. No golden case, however constructed, can close
 *    this: it is dead code by construction, not a missing recording. An EARLIER analysis
 *    (recorded against sprint 7 of spec-20260812-pge-real-workload-errors) attributed this
 *    to `rework_route`'s dispatch set being always empty "because nothing ever writes
 *    `abandoned`" — the CONCLUSION (dispatch set always empty) is right, but that mechanism
 *    is not: no branch is ever `"abandoned"` in this shipped graph, but that is beside the
 *    point, because `dispatchableContracts` already excludes `"succeeded"` branches, and
 *    `reduce_sprints`'s gate guarantees every branch IS `"succeeded"` by the time
 *    `rework_route` can run at all (`critique`'s bullet). `"succeeded"`, not `"abandoned"`,
 *    is the exclusion that actually bites.
 */
const NEVER_EXECUTED = ["context_compact", "critique", "rework_route", "synthesize"] as const;

async function loadReplayCases(): Promise<GoldenCase[]> {
  const cases: GoldenCase[] = [];
  for (const file of (await readdir(GOLDEN_DIR)).sort()) {
    if (!file.endsWith(".json")) continue;
    const parsed = parseGoldenCase(
      JSON.parse(await readFile(join(GOLDEN_DIR, file), "utf8")),
      file,
    );
    // A dataset this cannot parse is `dataset.test.ts`'s failure to report, not this
    // file's — but swallowing it here would silently shrink the executed set and read as
    // a coverage regression, so it is surfaced rather than skipped.
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    if (isReplayCase(parsed.goldenCase)) cases.push(parsed.goldenCase);
  }
  return cases;
}

/**
 * The `nodeId` one parsed trace line is evidence of, if and only if its span shows the
 * node's body actually ran.
 *
 * `status: "ok"` is the only status that means that. A node can open a span and never
 * enter its handler at all — `commit`'s FailClosed refusal under the autopilot `noop`
 * mechanism ends `"interrupted"` — or open one and have its handler throw or exhaust a
 * loop bound, ending `"failed"`; `"skipped"` and `"serialized"` (`SPAN_STATUSES`,
 * `src/pge/runtime/trace.ts`) are further ways a span exists without the node's body
 * running. Reading `nodeId` off a span with no status check — this file's rule before
 * sprint 9 of spec-20260812-pge-real-workload-errors — counted every one of those as
 * "executed", which is how the committed figure counted `commit` as covered when its own
 * only span was a refusal.
 *
 * Exported and pure — parsed spans in, node ids out — so {@link NEVER_EXECUTED}'s
 * two-directional pin can be proven by mutation without driving the real golden executor;
 * see the "mutated in both directions" describe block below.
 */
export function executedNodeIdsFromSpans(
  spans: readonly { readonly nodeId?: unknown; readonly status?: unknown }[],
): Set<string> {
  const executed = new Set<string>();
  for (const span of spans) {
    if (typeof span.nodeId === "string" && span.status === "ok") executed.add(span.nodeId);
  }
  return executed;
}

/** Every `nodeId` a run root's span file has at least one `status: "ok"` span for. */
async function executedNodeIds(runRootParent: string): Promise<Set<string>> {
  const executed = new Set<string>();
  for (const dir of await readdir(runRootParent)) {
    let text: string;
    try {
      text = await readFile(
        join(runRootParent, dir, ".bober", "traces", `${GOLDEN_RUN_ID}.jsonl`),
        "utf8",
      );
    } catch {
      continue;
    }
    const spans: { nodeId?: unknown; status?: unknown }[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      spans.push(JSON.parse(line) as { nodeId?: unknown; status?: unknown });
    }
    for (const nodeId of executedNodeIdsFromSpans(spans)) executed.add(nodeId);
  }
  return executed;
}

describe("what the committed replay cases execute", () => {
  let declared: string[] = [];
  let executed = new Set<string>();
  let parent = "";

  beforeAll(async () => {
    const artifact: unknown = JSON.parse(await readFile(ARTIFACT, "utf8"));
    declared = ((artifact as { nodes: { id: string }[] }).nodes ?? [])
      .map((node) => node.id)
      .sort();

    parent = await mkdtemp(join(tmpdir(), "golden-coverage-"));
    const executor = await createGoldenExecutor({
      projectRoot: REPO_ROOT,
      runRootParent: parent,
      keepRunRoots: true,
    });
    const cases = await loadReplayCases();
    // Without this, a loader that silently matched nothing would make every assertion
    // below compare two empty sets and pass — the exact vacuity this file is meant to
    // expose in the dataset, reproduced inside its own gate.
    expect(cases.length).toBeGreaterThanOrEqual(GOLDEN_MIN_REPLAY_CASES);
    for (const goldenCase of cases) await executor(goldenCase);
    executed = await executedNodeIds(parent);
  }, 120_000);

  afterAll(async () => {
    if (parent !== "") await rm(parent, { recursive: true, force: true });
  });

  it("executes every declared node except the recorded structural blocks", () => {
    const missing = declared.filter((id) => !executed.has(id)).sort();
    expect(missing).toEqual([...NEVER_EXECUTED].sort());
  });

  it("executes nothing the committed artifact does not declare", () => {
    // A span naming a node the artifact never declared would mean the run executed
    // something outside the graph, which no amount of artifact coverage would catch.
    const undeclared = [...executed].filter((id) => !declared.includes(id)).sort();
    expect(undeclared).toEqual([]);
  });

  it("covers a substantial majority of the graph, so the pin is not vacuous", () => {
    // Guards the direction the two assertions above cannot: if the dataset were reduced to
    // one trivial case, `NEVER_EXECUTED` could simply be grown to match and both would
    // still pass. A floor on the RATIO makes that a visible, deliberate edit.
    expect(declared.length - NEVER_EXECUTED.length).toBe(executed.size);
    expect(executed.size / declared.length).toBeGreaterThan(0.85);
  });

  it("reaches every region of the graph, not only the paths one run happens to take", () => {
    // Named anchors rather than a count: each is the entry gate of a region, so losing one
    // means an entire region stopped being exercised while the totals barely moved.
    for (const anchor of [
      "gate_research_in",
      "gate_plan_in",
      "plan_clarify",
      "gate_sprint_in",
      "gate_eval_in",
      "evaluate_global",
      "hitl_commit",
      "graceful_failure",
    ]) {
      expect(executed.has(anchor), `${anchor} is no longer executed by any golden case`).toBe(
        true,
      );
    }
  });
});

describe("the status-ok rule, mutated in both directions", () => {
  // sc-9-2: the corrected rule has to be proven to bite BOTH ways, independent of the real
  // golden executor — driving it per mutation would be slow and would still only exercise
  // whichever statuses the six committed cases happen to produce today. These tests instead
  // mutate synthetic spans directly against {@link executedNodeIdsFromSpans}, the exact
  // function `executedNodeIds` (and therefore the describe block above) delegates to.

  it("a node whose only span ended failed does not count as executed", () => {
    const executed = executedNodeIdsFromSpans([{ nodeId: "commit", status: "failed" }]);
    expect(executed.has("commit")).toBe(false);
  });

  it("a node whose only span was interrupted does not count as executed", () => {
    // The status `commit` actually ends with under the noop mechanism — see its
    // NEVER_EXECUTED bullet above. Distinct from "failed" and worth its own case: a rule
    // that special-cased "failed" and missed "interrupted" would still misclassify commit.
    const executed = executedNodeIdsFromSpans([{ nodeId: "commit", status: "interrupted" }]);
    expect(executed.has("commit")).toBe(false);
  });

  it("a node that gains a span with status ok begins to count as executed", () => {
    const executed = executedNodeIdsFromSpans([
      { nodeId: "commit", status: "failed" },
      { nodeId: "commit", status: "ok" },
    ]);
    expect(executed.has("commit")).toBe(true);
  });

  /**
   * Reruns the SAME equality the real describe block's first `it` enforces
   * (`missing.sort() === [...NEVER_EXECUTED].sort()`) over a tiny synthetic declared/
   * NEVER_EXECUTED pair, to prove the pin itself — not just {@link executedNodeIdsFromSpans}
   * in isolation — breaks in both directions when the list is not kept in sync.
   */
  function missingAgainst(declared: readonly string[], spans: readonly { nodeId: string; status: string }[]) {
    const executed = executedNodeIdsFromSpans(spans);
    return declared.filter((id) => !executed.has(id)).sort();
  }

  it("a covered node losing its only ok span fails the pin unless NEVER_EXECUTED grows to match", () => {
    const declared = ["commit", "documenter"];
    const staleNeverExecuted: string[] = []; // nobody added "commit"
    const before = missingAgainst(declared, [
      { nodeId: "commit", status: "ok" },
      { nodeId: "documenter", status: "ok" },
    ]);
    expect(before).toEqual(staleNeverExecuted); // matches: both nodes were genuinely executed

    // commit's status regresses to "interrupted" (a FailClosed refusal) with the stale list
    // left unchanged, exactly the situation this sprint's fix was written for:
    const after = missingAgainst(declared, [
      { nodeId: "commit", status: "interrupted" },
      { nodeId: "documenter", status: "ok" },
    ]);
    expect(after).not.toEqual(staleNeverExecuted);
    expect(after).toEqual(["commit"]);
  });

  it("a blocked node gaining an ok span fails the pin unless NEVER_EXECUTED shrinks to match", () => {
    const declared = ["documenter", "synthesize"];
    const staleNeverExecuted = ["synthesize"]; // nobody removed it
    const before = missingAgainst(declared, [{ nodeId: "documenter", status: "ok" }]);
    expect(before).toEqual(staleNeverExecuted); // matches: synthesize was genuinely never executed

    // synthesize starts producing an ok span (its claim stopped being true) with the stale
    // list left unchanged:
    const after = missingAgainst(declared, [
      { nodeId: "documenter", status: "ok" },
      { nodeId: "synthesize", status: "ok" },
    ]);
    expect(after).not.toEqual(staleNeverExecuted);
    expect(after).toEqual([]);
  });
});
