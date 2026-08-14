import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadHistory } from "../../state/history.js";
import { CODING_GRAPH } from "../topology/coding.graph.js";
import {
  HISTORY_EVENT,
  HISTORY_EVENT_NODE_MAP,
  IMPERATIVE_HISTORY_EVENT_ORDER,
  emitPhaseEvent,
} from "./history.js";
import type { HistoryEventMapping } from "./history.js";

/**
 * sc-4-1 and sc-4-4.
 *
 * sc-4-1 asks for the ten imperative events, enumerated from a real run, each mapped to the
 * graph node that should emit it, recorded BEFORE any node body was touched. The "real run"
 * half of that claim is `src/orchestrator/workflow/conformance.engines.test.ts` — it runs
 * BOTH shipped engines for real and reads the actual event list off disk (its "records WHAT
 * each divergence IS" test). What THIS file checks is the other half: that the recorded
 * MAPPING (`HISTORY_EVENT_NODE_MAP`) agrees with what is actually on disk in
 * `pipeline.ts`/`finalize.ts` and in the committed topology artifact — re-derived from
 * source on every run, so neither side can drift silently.
 *
 * sc-4-4 is checked here directly: `emitPhaseEvent` must write through the SAME
 * `appendHistory`/`loadHistory` pair the rest of the codebase uses, not a parallel file or a
 * parallel validator.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PIPELINE_SOURCE_PATH = join(REPO_ROOT, "src", "orchestrator", "pipeline.ts");
const FINALIZE_SOURCE_PATH = join(REPO_ROOT, "src", "orchestrator", "finalize.ts");

// ── sc-4-1: the mapping table, checked against real source ──────────

describe("HISTORY_EVENT_NODE_MAP (sc-4-1)", () => {
  it("has all ten events, in the imperative engine's own emission order", () => {
    expect(IMPERATIVE_HISTORY_EVENT_ORDER).toEqual([
      "pipeline-start",
      "planning-complete",
      "curator-start",
      "curator-complete",
      "generator-start",
      "evaluator-start",
      "sprint-passed",
      "code-review-complete",
      "sprint-docs-complete",
      "pipeline-complete",
    ]);
  });

  it("every HISTORY_EVENT constant appears exactly once in the map, nine node-emitted rows plus the shared terminal one", () => {
    const nodeEmitted = HISTORY_EVENT_NODE_MAP.filter((row) => row.graphNodeId !== null);
    expect(nodeEmitted.map((row) => row.event).sort()).toEqual(
      Object.values(HISTORY_EVENT).sort(),
    );
    expect(nodeEmitted).toHaveLength(9);
    expect(HISTORY_EVENT_NODE_MAP).toHaveLength(10);
  });

  it("every node-emitted event is a real appendHistory call site in pipeline.ts today", async () => {
    // NOT a source-position check: `curator-start` is written inside `runSprintCycle`,
    // declared textually BEFORE `runTsPipeline` (which writes `pipeline-start` and
    // `planning-complete`) even though `runTsPipeline` calls it much later at runtime —
    // function declaration order in the file is not call order. The TRUE emission order is
    // verified by running the engine for real, in
    // `conformance.engines.test.ts` ("records WHAT each divergence IS"), which is where
    // `IMPERATIVE_HISTORY_EVENT_ORDER` above is checked against a live run's own
    // `loadHistory()` output. What this test re-derives from source is narrower and
    // complementary: that every `imperativeSite` this table claims is still a real,
    // spelled-exactly `appendHistory` call in `pipeline.ts`, so a rename or removal on the
    // imperative side fails HERE instead of only silently deceiving a reader of the table.
    const source = await readFile(PIPELINE_SOURCE_PATH, "utf-8");
    const nodeEmitted = HISTORY_EVENT_NODE_MAP.filter((row) => row.graphNodeId !== null);

    for (const row of nodeEmitted) {
      const needle = `event: "${row.event}"`;
      expect(
        source.includes(needle),
        `pipeline.ts does not write "${needle}" — the mapping's imperativeSite for "${row.event}" no longer matches source`,
      ).toBe(true);
    }
  });

  it("the tenth event, pipeline-complete, is the SHARED terminal event and is marked as not node-emitted", async () => {
    const finalizeSource = await readFile(FINALIZE_SOURCE_PATH, "utf-8");
    const row = HISTORY_EVENT_NODE_MAP.at(-1);
    expect(row?.event).toBe("pipeline-complete");
    expect(row?.graphNodeId).toBeNull();
    expect(finalizeSource).toContain('export const PIPELINE_COMPLETE_EVENT = "pipeline-complete"');
    expect(finalizeSource).toContain("event: PIPELINE_COMPLETE_EVENT,");
  });
});

// ── Every non-null graphNodeId names a real declared node (pure function, both directions) ──

/** The mapped node ids that are NOT declared in `declaredIds` — `[]` means every row is honest. */
function undeclaredNodeIds(
  map: readonly HistoryEventMapping[],
  declaredIds: ReadonlySet<string>,
): string[] {
  return map
    .filter((row) => row.graphNodeId !== null && !declaredIds.has(row.graphNodeId))
    .map((row) => row.graphNodeId)
    .filter((id): id is string => id !== null)
    .sort();
}

describe("every mapped graphNodeId is a real node id in the committed topology", () => {
  it("the real HISTORY_EVENT_NODE_MAP names only declared node ids", () => {
    const declaredIds = new Set(CODING_GRAPH.nodes.map((node) => node.id));
    expect(undeclaredNodeIds(HISTORY_EVENT_NODE_MAP, declaredIds)).toEqual([]);
  });

  it("the scanner bites: a fabricated node id in a synthetic map is caught", () => {
    const declaredIds = new Set(CODING_GRAPH.nodes.map((node) => node.id));
    const synthetic: HistoryEventMapping[] = [
      {
        event: "fake-event",
        imperativeSite: "nowhere.ts:1",
        graphNodeId: "not_a_real_node_id",
        graphEmissionPoint: "invented",
      },
    ];
    expect(undeclaredNodeIds(synthetic, declaredIds)).toEqual(["not_a_real_node_id"]);
  });

  it("a null graphNodeId (the already-emitted terminal row) is never flagged", () => {
    const declaredIds = new Set(CODING_GRAPH.nodes.map((node) => node.id));
    const synthetic: HistoryEventMapping[] = [
      {
        event: "pipeline-complete",
        imperativeSite: "finalize.ts:254",
        graphNodeId: null,
        graphEmissionPoint: "already emitted",
      },
    ];
    expect(undeclaredNodeIds(synthetic, declaredIds)).toEqual([]);
  });
});

// ── sc-4-4: emitPhaseEvent writes through the SAME appendHistory/loadHistory pair ────

describe("emitPhaseEvent (sc-4-4)", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bober-pge-history-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** The narrowest legal `HistoryEmitContext` — proves the module needs nothing else. */
  function fakeCtx(nowIso: string): { projectRoot: string; clock: { nowIso: () => string } } {
    return { projectRoot: root, clock: { nowIso: () => nowIso } };
  }

  it("a written event round-trips through the real loadHistory reader", async () => {
    await emitPhaseEvent(fakeCtx("2026-08-14T00:00:00.000Z"), {
      event: HISTORY_EVENT.CURATOR_START,
      phase: "curating",
      sprintId: "sprint-spec-example-1",
      details: { title: "Example sprint" },
    });

    const entries = await loadHistory(root);
    expect(entries).toEqual([
      {
        timestamp: "2026-08-14T00:00:00.000Z",
        event: "curator-start",
        phase: "curating",
        sprintId: "sprint-spec-example-1",
        details: { title: "Example sprint" },
      },
    ]);
  });

  it("stamps timestamp from ctx.clock.nowIso(), never omitting or inventing it", async () => {
    await emitPhaseEvent(fakeCtx("2026-01-01T12:34:56.000Z"), {
      event: HISTORY_EVENT.PIPELINE_START,
      phase: "init",
      details: { userPrompt: "example" },
    });
    const [entry] = await loadHistory(root);
    expect(entry?.timestamp).toBe("2026-01-01T12:34:56.000Z");
  });

  it("omits sprintId entirely when the event carries none, matching HistoryEntrySchema's optional field", async () => {
    await emitPhaseEvent(fakeCtx("2026-01-01T00:00:00.000Z"), {
      event: HISTORY_EVENT.PLANNING_COMPLETE,
      phase: "planning",
      details: { specId: "spec-example", featureCount: 3 },
    });
    const [entry] = await loadHistory(root);
    expect(entry).not.toHaveProperty("sprintId");
  });

  it("writes to the SAME .bober/history.jsonl file appendHistory writes, not a parallel one", async () => {
    await emitPhaseEvent(fakeCtx("2026-01-01T00:00:00.000Z"), {
      event: HISTORY_EVENT.GENERATOR_START,
      phase: "generating",
      sprintId: "sprint-spec-example-1",
      details: { iteration: 1 },
    });
    const raw = await readFile(join(root, ".bober", "history.jsonl"), "utf-8");
    expect(JSON.parse(raw.trim()) as unknown).toMatchObject({ event: "generator-start" });
  });

  it("rejects a malformed entry through the SAME HistoryEntrySchema appendHistory validates against", async () => {
    await expect(
      emitPhaseEvent(fakeCtx("2026-01-01T00:00:00.000Z"), {
        // `event` fails `z.string().min(1)` — the exact validation appendHistory performs.
        event: "",
        phase: "init",
        details: {},
      }),
    ).rejects.toThrow(/Invalid history entry/);
    // Nothing was written — a rejected entry must not leave a partial line behind.
    expect(await loadHistory(root)).toEqual([]);
  });
});
