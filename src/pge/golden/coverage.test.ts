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
 * The nodes no committed case reaches, each with the reason it cannot be reached.
 *
 * Every entry is a STRUCTURAL block, not a missing scenario. None of them can be closed by
 * writing another set of bindings, which is exactly why they are recorded here rather than
 * left as a to-do:
 *
 *  - `commit` is refused FAIL_CLOSED under the autopilot `noop` mechanism (the sprint-13
 *    divergence), and `finalize`'s only edge in is `commit -> finalize`. Covering it needs a
 *    durable mechanism, and the golden executor pins ONE config on purpose so a case
 *    produces the same artifacts everywhere.
 *  - `context_compact`'s only edge in is `supervisor -> context_compact` under the `compact`
 *    label, and the shipped supervisor never selects that label: the artifact declares
 *    `supervisor.reads` without `messages`, so deciding a window crossed a compression
 *    threshold would mean reading a channel the artifact does not authorise. Recorded as
 *    artifact drift in `nodes/supervisor.ts`.
 *  - `critique`, `rework_route` and `synthesize` sit behind `route_after_eval`'s `rework`
 *    and `partial` labels, which require reaching `evaluate_global` with a non-pass verdict.
 *    Every failing path available through the collaborator seam settles earlier — the
 *    evaluation-fails case exhausts `fanoutRetries` at `reduce_sprints` and lands in
 *    `graceful_failure` without ever reaching the global evaluation.
 */
const NEVER_EXECUTED = [
  "context_compact",
  "critique",
  "finalize",
  "rework_route",
  "synthesize",
] as const;

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

/** Every `nodeId` that appears in a run root's span file. */
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
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const span: unknown = JSON.parse(line);
      const nodeId = (span as { nodeId?: unknown }).nodeId;
      if (typeof nodeId === "string") executed.add(nodeId);
    }
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
