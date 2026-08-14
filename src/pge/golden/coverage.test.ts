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
 * ── `critique` and `rework_route` left this list at sprint 8 of spec-20260814-pge-full-convergence ──
 *
 * Both sat here on the same claim: nothing in the dataset drove `route_after_eval` to its
 * `rework` label, because every committed case's branches either all succeeded on the first
 * attempt or failed outright and were caught by `reduce_sprints` before `evaluate_global`
 * ever ran. `replay-corrected-sprint-still-grades-fail` closes that gap by exploiting an
 * asymmetry between two rules that both read the same evaluation history and disagree:
 * `branchOutcome` (`nodes/sprint-review.ts`) settles a branch on its LAST decisive verdict,
 * so a branch that fails once and then passes settles `"succeeded"` and `reduce_sprints`'s
 * `all-branches-settled` gate admits it into global evaluation; `gradeContracts`
 * (`nodes/root.ts`) instead REDUCES over every recorded verdict and lets one `"fail"` row
 * outrank a later `"pass"` permanently, so the SAME contract stays graded `"fail"` forever.
 * `evaluate_global` therefore returns a non-pass verdict on a run every branch of which
 * succeeded, `route_after_eval` selects `"rework"` (`reworkRoundsTaken` is still under
 * budget on a first rework round), and `critique` runs: it builds one correction per branch
 * needing rework and hands off to its sole successor edge, `rework_route`.
 *
 * `rework_route` leaves this list in the SAME case, and not by choice: `critique`'s only
 * outbound edge is `critique -> rework_route` (`e-eval-critiqued`), so no case can drive one
 * without driving the other — this was recorded ahead of implementation in the sprint's
 * `preFlightFinding`, and the contract's nonGoal ("driving rework_route — sprint 9") could
 * not be honoured because it is forced by the graph's topology, not a scope choice. By the
 * time `rework_route` runs, `reduce_sprints`'s gate has already guaranteed every dispatched
 * branch's status is `"succeeded"` — `dispatchableContracts` (`nodes/sprint-fanout.ts`)
 * excludes exactly the branches whose status is `"succeeded"` or `"abandoned"` — so
 * `rework_route`'s own dispatch set is empty and it selects the `"exhausted"` label rather
 * than re-offering the branch, still ending a `status: "ok"` span. Sprint 9's remaining work
 * on this graph narrowed to `synthesize` alone, and confirmed it is the same kind of
 * structural block rather than a missing scenario — see the `synthesize` bullet below.
 *
 * `context_compact` and `synthesize` remain structural: no set of bindings, however
 * imaginative, can make case authoring close either, which is why they stay recorded here
 * rather than as a to-do:
 *
 *  - `context_compact`'s only edge in is `supervisor -> context_compact` under the `compact`
 *    label, and the shipped supervisor's handler (`nodes/supervisor.ts:140-177`) has NO code
 *    path that returns that label at all — its five branches select `plan`, `sprints`,
 *    `evaluate`, the graceful-failure hop for a refusal, or end the run; `COMPACT_LABEL`
 *    (`supervisor.ts:82`) is declared and referenced nowhere else in `src/` (grep-verified).
 *    The committed artifact's `supervisor.reads` — `["branchStatus", "counters",
 *    "evaluations", "spec"]`, still no `messages` at `graphVersion 1.5.0`, re-verified for
 *    this sprint — is WHY no such path exists: a supervisor cannot decide a message window
 *    crossed a compression threshold without reading the messages. The block is therefore at
 *    LABEL SELECTION, one step upstream of the node itself — `contextCompactNode`'s own body
 *    would return a `status: "ok"` span even below its threshold (`nodes/root.ts`'s handler,
 *    the `!decision.shouldCompact` branch) if it were ever entered, so this is not a
 *    token-threshold problem and enlarging a case's message count changes nothing. What
 *    would close it — teaching the supervisor to measure the window and select
 *    `COMPACT_LABEL`, which first requires adding `messages` to `supervisor.reads` — is a
 *    topology change (a minor `graphVersion` bump) plus a shipped-code change, not a case,
 *    and is out of this sprint's scope. Recorded as artifact drift in `nodes/supervisor.ts`,
 *    and backed by a claim test in `nodes/supervisor.test.ts` that fails the moment the
 *    handler gains a path returning `COMPACT_LABEL`.
 *  - `synthesize` is a genuine STRUCTURAL block, unlike `context_compact` above, and its
 *    recorded reason (rewritten at sprint 9 of spec-20260812-pge-real-workload-errors) is
 *    unaffected by `critique`/`rework_route` closing above: it sits behind
 *    `route_after_eval`'s `partial` label, selected only when
 *    `reworkRoundsTaken(spec, state) >= maxIterations` (2) at a SECOND invocation of
 *    `route_after_eval` — which never happens. `route_after_eval` and `rework_route` read
 *    the identical counter and the identical `maxIterations` off the SAME artifact loop
 *    bound (`loopBoundOf(spec, "rework_route")`), and the interpreter enforces that bound
 *    independently, at `rework_route` itself, using the counter value already including
 *    this execution's own increment (`boundedDestination`, `src/pge/runtime/
 *    interpreter.ts:1004-1044`). `rework_route`'s dispatch set is always empty when it runs
 *    — `dispatchableContracts` excludes branches whose status is `"succeeded"` or
 *    `"abandoned"`, and `reduce_sprints`'s gate guarantees every dispatched branch IS
 *    `"succeeded"` by the time `rework_route` can run at all, exactly as the paragraph above
 *    about `critique`/`rework_route` explains — so it never selects its own `"rework"`
 *    fan-out, the only edge that would loop back through the sprint subgraph and return to
 *    `evaluate_global` a second time. It always exits to `graceful_failure` on its first and
 *    only invocation per run, and `reworkRounds` can reach at most 1, never the bound of 2.
 *    `route_after_eval` is therefore invoked AT MOST ONCE per run, and its own
 *    `reworkRoundsTaken >= maxIterations` branch — `"partial"` and, for that matter, its
 *    `"exhausted"` sibling — can never fire. No golden case, however constructed, can close
 *    this: it is dead code by construction, not a missing recording. An EARLIER analysis
 *    (recorded against sprint 7 of spec-20260812-pge-real-workload-errors) attributed this
 *    to `rework_route`'s dispatch set being always empty "because nothing ever writes
 *    `abandoned`" — the CONCLUSION (dispatch set always empty) is right, but that mechanism
 *    is not: no branch is ever `"abandoned"` in this shipped graph. `"succeeded"`, not
 *    `"abandoned"`, is the exclusion that actually bites.
 *
 *    Sprint 9 of `spec-20260814-pge-full-convergence` genuinely tried to drive `synthesize`
 *    before accepting this block (per that sprint's `preFlightFinding` and its own
 *    stopCondition), independently re-derived the same conclusion from a SECOND code path —
 *    `supervisorNode` itself never selects its `"evaluate"` label while
 *    `dispatchableContracts(state, state.sprintContracts)` is non-empty
 *    (`nodes/supervisor.ts:165` checks `"sprints"` first), and `evaluate_global`,
 *    `route_after_eval` and `critique` write neither `sprintContracts` nor `branchStatus`
 *    (`coding.graph.ts`), so the all-succeeded state that guard requires is exactly what
 *    `rework_route` still sees when it runs — and closed the one gap this block had left
 *    open: the claim above was prose only, unlike `context_compact`'s, which
 *    `nodes/supervisor.test.ts` backs with a test. `src/pge/nodes/root.test.ts` now backs
 *    it the same way, in four mutation-proven pieces, and also proves `evalRouterNode`'s
 *    `"partial"`/`"exhausted"` branches are themselves correctly implemented (unlike
 *    `context_compact`'s label-selection code, which does not exist at all) — the
 *    precondition is what is unreachable, not the code that would react to it.
 */
const NEVER_EXECUTED = ["context_compact", "synthesize"] as const;

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

  // sc-8-3: `critique` and `context_compact` moved OPPOSITE directions this sprint —
  // `critique` left NEVER_EXECUTED, `context_compact` stayed — and the guard has to bite
  // for each independently of the real golden executor, exactly as the `commit`/`synthesize`
  // pair above proves it for sprint 9's move. Sprint 5 of this spec shipped a control that
  // passed identically before and after a change and was rejected for it; sprint 7 proved
  // its guard by injecting a synthetic stale entry, which is the shape these two follow.

  it("critique silently re-entering NEVER_EXECUTED (losing its ok span) fails the shrunk pin", () => {
    const declared = ["documenter", "critique"];
    const currentNeverExecuted: string[] = []; // sprint 8's shrunk list: critique is not on it
    const before = missingAgainst(declared, [
      { nodeId: "documenter", status: "ok" },
      { nodeId: "critique", status: "ok" },
    ]);
    expect(before).toEqual(currentNeverExecuted); // matches: critique is genuinely executed now

    // critique's span silently regresses (e.g. a future change makes its buildCorrection
    // call throw) with NEVER_EXECUTED left at this sprint's shrunk list:
    const after = missingAgainst(declared, [
      { nodeId: "documenter", status: "ok" },
      { nodeId: "critique", status: "failed" },
    ]);
    expect(after).not.toEqual(currentNeverExecuted);
    expect(after).toEqual(["critique"]);
  });

  it("context_compact gaining an ok span while still listed fails the pin", () => {
    const declared = ["documenter", "context_compact"];
    const currentNeverExecuted = ["context_compact"]; // sprint 8 left it structurally blocked
    const before = missingAgainst(declared, [{ nodeId: "documenter", status: "ok" }]);
    expect(before).toEqual(currentNeverExecuted); // matches: context_compact is genuinely unreached

    // context_compact starts producing an ok span (its structural-block claim stopped being
    // true — e.g. a future sprint teaches the supervisor to select COMPACT_LABEL) with the
    // list left unchanged:
    const after = missingAgainst(declared, [
      { nodeId: "documenter", status: "ok" },
      { nodeId: "context_compact", status: "ok" },
    ]);
    expect(after).not.toEqual(currentNeverExecuted);
    expect(after).toEqual([]);
  });
});
