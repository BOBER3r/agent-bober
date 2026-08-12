import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as StateIndexModule from "../../state/index.js";

// ── Order probe ──────────────────────────────────────────────────────
//
// `appendHistory` is WRAPPED, not replaced: every write below is a real write to a real
// temp directory. The wrapper exists to snapshot one fact at one instant — whether the
// completion marker was already on disk when the pipeline-complete line was appended.
// That order is load-bearing (the marker carries the runId, the history line is only the
// trigger) and reversing it strands a run for src/chat/completion-tailer.ts, which is a
// defect this repository has already shipped once.

const probe = vi.hoisted(() => ({
  root: "",
  markerPresentAtHistoryWrite: [] as boolean[],
}));

vi.mock("../../state/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof StateIndexModule>();
  const { readdir: readdirActual } = await import("node:fs/promises");
  const { join: joinActual } = await import("node:path");
  return {
    ...actual,
    appendHistory: vi.fn(
      async (root: string, entry: Parameters<typeof actual.appendHistory>[1]) => {
        if (entry.event === "pipeline-complete") {
          let present: boolean;
          try {
            const entries = await readdirActual(joinActual(probe.root, ".bober", "runs"));
            present = entries.some((e) => e.endsWith(".completed.json"));
          } catch {
            present = false;
          }
          probe.markerPresentAtHistoryWrite.push(present);
        }
        return actual.appendHistory(root, entry);
      },
    ),
  };
});

import { createDefaultConfig } from "../../config/schema.js";
import type { BoberConfig } from "../../config/schema.js";
import { RunResultFlusher } from "../../orchestrator/workflow/flusher.js";
import {
  COMPLETION_MARKER_SUFFIX,
  finalizePipelineRun,
  runsDir,
} from "../../orchestrator/finalize.js";
import { loadHistory } from "../../state/history.js";
import { compile } from "../compile/compiler.js";
import type { CompiledGraph } from "../compile/compiler.js";
import {
  CONTROL_KEYS,
  ConflictingControlUpdateError,
  ImmutableStateKeyError,
  StateBloatError,
  UndeclaredChannelError,
  createCommitBoundary,
  createFixedClock,
  createSystemClock,
  FinalizeWithoutSpecError,
} from "./commit.js";
import type { ChannelUpdate, CommitContext } from "./commit.js";
import { createScratchStore } from "./scratch.js";
import {
  GOLDEN_SPEC_ID,
  goldenContracts,
  goldenInitialState,
  goldenPlanSpec,
  goldenRegistries,
  goldenSpec,
} from "./__fixtures__/golden-graph.js";
import { countingArtifactWriter } from "./__fixtures__/run-harness.js";

// ── Fixtures ─────────────────────────────────────────────────────────

let root = "";
let config: BoberConfig;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-commit-"));
  probe.root = root;
  probe.markerPresentAtHistoryWrite.length = 0;
  config = createDefaultConfig("commit-fixture", "brownfield");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function graph(): CompiledGraph {
  return compile(goldenSpec(), goldenRegistries({ contracts: goldenContracts(1) }));
}

function ctxFor(superstep = 0): CommitContext {
  return { runId: "run-commit", projectRoot: root, config, superstep, startedAtMs: 1_000 };
}

function update(channel: string, value: unknown, nodeId = "sprint_generate"): ChannelUpdate {
  return { channel, nodeId, branchKey: null, value };
}

function message(id: string, seq: number, text: string): unknown {
  return { id, seq, role: "assistant", nodeId: "sprint_generate", text, tokens: text.length };
}

// ── One reducer invocation per channel per superstep ─────────────────

describe("one write per channel per superstep (sc-7-7)", () => {
  it("applies each channel's reducer exactly once with the WHOLE batch", async () => {
    const registries = goldenRegistries({ contracts: goldenContracts(1) });
    const merges: Array<{ id: string; batch: number }> = [];
    const counted = {
      ids: () => registries.reducers.ids(),
      get: (id: string) => {
        const inner = registries.reducers.get(id);
        if (!inner) return undefined;
        return {
          ...inner,
          merge(current: unknown, updates: readonly unknown[]) {
            merges.push({ id, batch: updates.length });
            return inner.merge(current, updates);
          },
        };
      },
    };
    const compiled = compile(goldenSpec(), { ...registries, reducers: counted });
    const boundary = createCommitBoundary({ clock: createFixedClock("2026-08-05T00:00:00.000Z") });

    const result = await boundary.commit(
      compiled,
      goldenInitialState("run-commit", root),
      [
        update("messages", [message("m-1", 1, "one")]),
        update("messages", [message("m-2", 2, "two")]),
        update("messages", [message("m-3", 3, "three")]),
        update("counters", { a: 1 }),
        update("counters", { a: 5 }),
      ],
      ctxFor(),
    );

    expect(result.writesPerChannel).toEqual({ messages: 1, counters: 1 });
    expect(result.batchSizePerChannel).toEqual({ messages: 3, counters: 2 });
    expect(merges).toEqual([
      { id: "maxNumber", batch: 2 },
      { id: "appendById", batch: 3 },
    ]);
    expect(result.state.messages.map((m) => m.id)).toEqual(["m-1", "m-2", "m-3"]);
    expect(result.state.counters).toEqual({ a: 5 });
  });

  it("leaves untouched channels absent from writesPerChannel", async () => {
    const boundary = createCommitBoundary();
    const result = await boundary.commit(
      graph(),
      goldenInitialState("run-commit", root),
      [update("testAnchors", ["anchor:a"])],
      ctxFor(),
    );
    expect(Object.keys(result.writesPerChannel)).toEqual(["testAnchors"]);
    expect(result.state.messages).toEqual([]);
  });

  it("commits the same state whichever order the batch arrived in", async () => {
    const boundary = createCommitBoundary();
    const batch = [
      update("messages", [message("m-b", 2, "b")]),
      update("messages", [message("m-a", 1, "a")]),
      update("branchStatus", { "c-2": { state: "succeeded", attempts: 1 } }),
      update("branchStatus", { "c-1": { state: "succeeded", attempts: 1 } }),
    ];
    const forwards = await boundary.commit(
      graph(),
      goldenInitialState("run-commit", root),
      batch,
      ctxFor(),
    );
    const backwards = await createCommitBoundary().commit(
      graph(),
      goldenInitialState("run-commit", root),
      [...batch].reverse(),
      ctxFor(),
    );
    expect(JSON.stringify(backwards.state)).toBe(JSON.stringify(forwards.state));
  });
});

// ── Inline byte guard ────────────────────────────────────────────────

describe("the inline-size guard enforces offloading (sc-7-9)", () => {
  it("rejects a value above the channel's maxInlineBytes, naming channel and byte count", async () => {
    const boundary = createCommitBoundary();
    const fiveMegabytes = "d".repeat(5 * 1024 * 1024);
    const oversized = [message("m-diff", 1, fiveMegabytes)];

    const result = await boundary.commit(
      graph(),
      goldenInitialState("run-commit", root),
      [update("messages", oversized)],
      ctxFor(),
    );

    expect(result.rejected).toHaveLength(1);
    const error = result.rejected[0];
    expect(error).toBeInstanceOf(StateBloatError);
    expect(error.channel).toBe("messages");
    expect(error.limit).toBe(4096);
    expect(error.bytes).toBeGreaterThan(5 * 1024 * 1024);
    expect(error.message).toContain("messages");
    expect(error.message).toContain(String(error.bytes));

    // The channel was NOT written: a rejected update does not reach the reducer.
    expect(result.writesPerChannel.messages).toBeUndefined();
    expect(result.state.messages).toEqual([]);
  });

  it("commits the same payload once it is offloaded and referenced by a ScratchRef", async () => {
    const scratch = createScratchStore(root);
    const fiveMegabytes = "d".repeat(5 * 1024 * 1024);
    const ref = await scratch.put("run-commit", "diff", fiveMegabytes);

    const boundary = createCommitBoundary();
    const result = await boundary.commit(
      graph(),
      goldenInitialState("run-commit", root),
      [
        update("refs", { "diff:sprint-1": ref }),
        update("messages", [
          {
            id: "m-diff",
            seq: 1,
            role: "assistant",
            nodeId: "sprint_generate",
            textRef: ref,
            tokens: 0,
          },
        ]),
      ],
      ctxFor(),
    );

    expect(result.rejected).toEqual([]);
    expect(result.writesPerChannel).toEqual({ messages: 1, refs: 1 });
    expect(result.state.refs["diff:sprint-1"].sha256).toBe(ref.sha256);
    expect(result.state.refs["diff:sprint-1"].bytes).toBe(5 * 1024 * 1024);
    // The bytes are on disk; only the four-field descriptor is in state.
    expect((await scratch.text(ref)).length).toBe(5 * 1024 * 1024);
  });

  it("rejects only the oversized update and still commits its siblings", async () => {
    const boundary = createCommitBoundary();
    const result = await boundary.commit(
      graph(),
      goldenInitialState("run-commit", root),
      [
        update("messages", [message("m-big", 1, "x".repeat(5000))]),
        update("counters", { rounds: 1 }),
      ],
      ctxFor(),
    );
    expect(result.rejected.map((e) => e.channel)).toEqual(["messages"]);
    expect(result.writesPerChannel).toEqual({ counters: 1 });
    expect(result.state.counters).toEqual({ rounds: 1 });
  });

  it("honours a channel's own higher limit rather than the graph default", async () => {
    const boundary = createCommitBoundary();
    // `sprintContracts` declares 65536; a real contract is far above the 4096 default.
    const result = await boundary.commit(
      graph(),
      goldenInitialState("run-commit", root),
      [update("sprintContracts", goldenContracts(3), "plan_draft")],
      ctxFor(),
    );
    expect(result.rejected).toEqual([]);
    expect(result.state.sprintContracts).toHaveLength(3);
  });
});

// ── Channel and key rules ────────────────────────────────────────────

describe("channel rules", () => {
  it("refuses an update naming a channel the topology does not declare", async () => {
    const boundary = createCommitBoundary();
    await expect(
      boundary.commit(
        graph(),
        goldenInitialState("run-commit", root),
        [update("notAChannel", { x: 1 })],
        ctxFor(),
      ),
    ).rejects.toBeInstanceOf(UndeclaredChannelError);
  });

  it("refuses to rewrite run identity", async () => {
    const boundary = createCommitBoundary();
    await expect(
      boundary.commit(
        graph(),
        goldenInitialState("run-commit", root),
        [update("projectRoot", "/somewhere/else")],
        ctxFor(),
      ),
    ).rejects.toBeInstanceOf(ImmutableStateKeyError);
  });

  it("merges control keys by unanimity and rejects disagreement", async () => {
    const boundary = createCommitBoundary();
    const agreed = await boundary.commit(
      graph(),
      goldenInitialState("run-commit", root),
      [update("currentPhase", "generating"), update("currentPhase", "generating", "sprint_route")],
      ctxFor(),
    );
    expect(agreed.state.currentPhase).toBe("generating");
    expect(agreed.writesPerChannel.currentPhase).toBe(1);

    await expect(
      createCommitBoundary().commit(
        graph(),
        goldenInitialState("run-commit", root),
        [update("currentPhase", "generating"), update("currentPhase", "evaluating", "sprint_route")],
        ctxFor(),
      ),
    ).rejects.toBeInstanceOf(ConflictingControlUpdateError);
  });

  it("names exactly the three control keys", () => {
    expect([...CONTROL_KEYS]).toEqual(["currentPhase", "specId", "verdict"]);
  });

  it("VALIDATES every control key with its schema, and never coerces one", async () => {
    // `specId` is the control key with no enum behind it, so it is the one a hand-rolled
    // `String(value)` would look harmless on. It is not: a coercion in front of the final
    // `OverallStateSchema.parse` defeats that re-parse, because "[object Object]" and "7"
    // are both perfectly valid strings. What must survive is the malformed VALUE being
    // refused, not a stringified corpse of it being committed.
    for (const malformed of [{ oops: 1 }, 7, ["a"], true]) {
      const attempt = createCommitBoundary().commit(
        graph(),
        goldenInitialState("run-commit", root),
        [update("specId", malformed, "plan_draft")],
        ctxFor(),
      );
      await expect(attempt).rejects.toThrow();
      // Specifically: refused, not stringified. A coercion would resolve, not reject.
      await expect(attempt.then(
        (r) => `COMMITTED:${String(r.state.specId)}`,
        () => "REFUSED",
      )).resolves.toBe("REFUSED");
    }

    // The two shapes the schema does declare still commit unchanged.
    const named = await createCommitBoundary().commit(
      graph(),
      goldenInitialState("run-commit", root),
      [update("specId", GOLDEN_SPEC_ID, "plan_draft")],
      ctxFor(),
    );
    expect(named.state.specId).toBe(GOLDEN_SPEC_ID);
    expect(named.writesPerChannel.specId).toBe(1);

    const cleared = await createCommitBoundary().commit(
      graph(),
      goldenInitialState("run-commit", root),
      [update("specId", null, "plan_draft")],
      ctxFor(),
    );
    expect(cleared.state.specId).toBeNull();
  });

  it("re-parses the merged state, so a malformed value cannot survive the commit", async () => {
    const boundary = createCommitBoundary();
    // `replaceIfNewer` is TOTAL: it hands back whatever ranked highest, including a value
    // that is not a PlanSpec at all. The re-parse at the end of the commit is the only
    // thing standing between that and a corrupted state one superstep later.
    await expect(
      boundary.commit(
        graph(),
        goldenInitialState("run-commit", root),
        [update("spec", { notA: "planSpec" }, "plan_draft")],
        ctxFor(),
      ),
    ).rejects.toThrow();
  });

  it("keeps a total reducer total: a non-numeric counter is dropped, not committed", async () => {
    const boundary = createCommitBoundary();
    const result = await boundary.commit(
      graph(),
      goldenInitialState("run-commit", root),
      [update("counters", { rounds: "not-a-number", real: 3 })],
      ctxFor(),
    );
    expect(result.state.counters).toEqual({ real: 3 });
  });
});

// ── Domain artifacts ─────────────────────────────────────────────────

describe("domain artifact writes", () => {
  it("persists the spec and every contract, and does NOT rewrite unchanged bytes", async () => {
    const artifacts = countingArtifactWriter();
    const boundary = createCommitBoundary({ artifacts: artifacts.writer });
    const compiled = graph();
    const contracts = goldenContracts(2);

    const first = await boundary.commit(
      compiled,
      goldenInitialState("run-commit", root),
      [update("spec", goldenPlanSpec(), "plan_draft"), update("sprintContracts", contracts, "plan_draft")],
      ctxFor(0),
    );
    expect(artifacts.log.specs).toEqual([GOLDEN_SPEC_ID]);
    expect(artifacts.log.contracts).toEqual(["sprint-golden-1", "sprint-golden-2"]);
    expect(first.artifactWrites).toBe(3);

    // A rework loop re-committing an IDENTICAL contract must not write again.
    const second = await boundary.commit(
      compiled,
      first.state,
      [update("sprintContracts", [contracts[0]], "gate_sprint_out")],
      ctxFor(1),
    );
    expect(second.artifactWrites).toBe(0);
    expect(artifacts.log.contracts).toEqual(["sprint-golden-1", "sprint-golden-2"]);

    // A CHANGED contract is a different value and is written again.
    const third = await boundary.commit(
      compiled,
      second.state,
      [update("sprintContracts", [{ ...contracts[0], status: "passed" }], "gate_sprint_out")],
      ctxFor(2),
    );
    expect(third.artifactWrites).toBe(1);
    expect(artifacts.log.contracts).toEqual([
      "sprint-golden-1",
      "sprint-golden-2",
      "sprint-golden-1",
    ]);

    const onDisk = await readdir(join(root, ".bober", "contracts"));
    expect(onDisk.sort()).toEqual(["sprint-golden-1.json", "sprint-golden-2.json"]);
  });

  it("writes nothing when the batch touches no persisted channel", async () => {
    const artifacts = countingArtifactWriter();
    const boundary = createCommitBoundary({ artifacts: artifacts.writer });
    const result = await boundary.commit(
      graph(),
      goldenInitialState("run-commit", root),
      [update("counters", { rounds: 1 })],
      ctxFor(),
    );
    expect(result.artifactWrites).toBe(0);
    expect(artifacts.log).toEqual({ specs: [], contracts: [] });
  });
});

// ── Clock ownership ──────────────────────────────────────────────────

describe("the boundary is the clock", () => {
  it("hands out a system clock whose three readings agree", () => {
    const clock = createSystemClock();
    const iso = clock.nowIso();
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Math.abs(clock.nowMs() - clock.now().getTime())).toBeLessThan(1000);
  });

  it("accepts an injected clock that never moves", () => {
    const clock = createFixedClock("2026-08-05T00:00:00.000Z");
    expect(clock.nowIso()).toBe("2026-08-05T00:00:00.000Z");
    expect(clock.nowIso()).toBe("2026-08-05T00:00:00.000Z");
  });
});

/**
 * The evaluator's structural check, made mechanical.
 *
 * `CommitBoundary` is the runtime's single clock. The three modules this sprint owns are
 * read from disk and scanned: only `commit.ts` may construct a `Date`, and only inside
 * `createSystemClock`/`createFixedClock`. A node that read the wall clock directly would
 * make a replayed superstep produce different bytes from the one it replays.
 */
describe("the commit boundary is the only clock source in the sprint's modules", () => {
  it("finds no Date construction in interpreter.ts or frontier.ts", async () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    for (const file of ["interpreter.ts", "frontier.ts"]) {
      const source = await readFile(join(here, file), "utf8");
      expect(source.includes("new Date("), `${file} must not construct a Date`).toBe(false);
      expect(source.includes("Date.now("), `${file} must not read Date.now`).toBe(false);
    }
  });

  it("confines Date construction in commit.ts to the two clock factories", async () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const source = await readFile(join(here, "commit.ts"), "utf8");
    const lines = source.split("\n");
    // Prose is not code: a comment naming `new Date()` is documentation of the rule, not a
    // violation of it. Only executable lines are scanned.
    const clockLines = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => {
        const trimmed = line.trimStart();
        return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/**");
      })
      .filter(({ line }) => line.includes("new Date(") || line.includes("Date.now("));
    expect(clockLines.length).toBeGreaterThan(0);

    const systemClockStart = lines.findIndex((l) => l.includes("export function createSystemClock"));
    const fixedClockEnd = lines.findIndex((l) => l.includes("// ── Helpers"));
    expect(systemClockStart).toBeGreaterThan(0);
    for (const { i, line } of clockLines) {
      expect(i > systemClockStart && i < fixedClockEnd, `clock read outside the factories: ${line}`).toBe(true);
    }
  });
});

// ── finalize ─────────────────────────────────────────────────────────

describe("CommitBoundary.finalize", () => {
  // sc-7-4 — FinalizeWithoutSpecError narrowed, not deleted: both branches proved.
  it("refuses to finalize a run that produced NEITHER spec nor specDraft", async () => {
    const boundary = createCommitBoundary();
    const state = goldenInitialState("run-commit", root);
    expect(state.spec).toBeNull();
    expect(state.specDraft).toBeNull();
    await expect(boundary.finalize(state, ctxFor())).rejects.toBeInstanceOf(
      FinalizeWithoutSpecError,
    );
  });

  // sc-7-3 — falls back to specDraft and RESOLVES instead of throwing.
  it("falls back to specDraft when spec is null, and resolves a failed PipelineResult instead of throwing", async () => {
    const boundary = createCommitBoundary();
    const draft = goldenPlanSpec();
    const state = {
      ...goldenInitialState("run-commit", root),
      specDraft: draft,
    };
    expect(state.spec).toBeNull();

    const result = await boundary.finalize(state, ctxFor());

    expect(result.success).toBe(false);
    expect(result.needsClarification).toBe(true);
    expect(result.spec).toEqual(draft);
    expect(result.completedSprints).toEqual([]);
    expect(result.failedSprints).toEqual([]);
    expect(typeof result.duration).toBe("number");
    // No completion marker or pipeline-complete history line: this run never reached its
    // terminal artifact set, unlike a finalizePipelineRun-backed success or failure.
    await expect(
      readFile(join(root, ".bober", "runs", "run-commit.completed.json"), "utf-8"),
    ).rejects.toThrow();
  });

  it("splits contracts into completed and failed by status", async () => {
    const boundary = createCommitBoundary();
    const state = {
      ...goldenInitialState("run-commit", root),
      spec: goldenPlanSpec(),
      sprintContracts: [
        { ...goldenContracts(2)[0], status: "passed" as const },
        { ...goldenContracts(2)[1], status: "failed" as const },
      ],
    };
    const result = await boundary.finalize(state, ctxFor());
    expect(result.completedSprints.map((c) => c.contractId)).toEqual(["sprint-golden-1"]);
    expect(result.failedSprints.map((c) => c.contractId)).toEqual(["sprint-golden-2"]);
    expect(result.success).toBe(false);
  });
});

// ── The third caller (carried gap from sprint 4) ─────────────────────

/**
 * `finalizePipelineRun` must have THREE callers: `runTsPipeline`, `RunResultFlusher.flush`
 * and `CommitBoundary.finalize`. Sprint 4 shipped the first two; this is the third.
 *
 * The assertion is not "all three called it" — that would be satisfied by three functions
 * that each emit something. It is that all three produce the SAME BYTES in the same ORDER:
 * the `.completed.json` marker first, then the pipeline-complete history line. The marker
 * is the sole carrier of the runId and the line is only the trigger, so a consumer woken
 * by the line and finding no marker resolves `runId: undefined` and can never recover.
 */
describe("all three callers of finalizePipelineRun emit identical artifacts", () => {
  const RUN_ID = "run-parity";

  function completedContracts(): ReturnType<typeof goldenContracts> {
    return goldenContracts(2).map((c) => ({ ...c, status: "passed" as const }));
  }

  async function markerBytes(dir: string): Promise<string> {
    const names = (await readdir(runsDir(dir))).filter((n) => n.endsWith(COMPLETION_MARKER_SUFFIX));
    expect(names).toEqual([`${RUN_ID}${COMPLETION_MARKER_SUFFIX}`]);
    const raw = await readFile(join(runsDir(dir), names[0]), "utf8");
    // completedAt and duration are wall-clock facts; everything else is compared literally.
    return raw
      .replace(/"completedAt": "[^"]+"/, '"completedAt": "<TS>"')
      .replace(/"duration": \d+/, '"duration": <DUR>');
  }

  async function historyLine(dir: string): Promise<string> {
    const entries = await loadHistory(dir);
    const terminal = entries.filter((e) => e.event === "pipeline-complete");
    expect(terminal).toHaveLength(1);
    return JSON.stringify({ ...terminal[0], timestamp: "<TS>", details: { ...terminal[0].details, durationMs: "<DUR>" } });
  }

  it("produces byte-identical markers and history lines from all three call sites", async () => {
    // 1. The TS engine's call shape, transcribed from pipeline.ts's terminal block.
    const tsRoot = await mkdtemp(join(tmpdir(), "bober-parity-ts-"));
    // 2. The workflow engine, through the real flusher.
    const flusherRoot = await mkdtemp(join(tmpdir(), "bober-parity-flusher-"));
    // 3. The graph runtime, through the real commit boundary.
    const pgeRoot = await mkdtemp(join(tmpdir(), "bober-parity-pge-"));

    try {
      probe.root = tsRoot;
      await finalizePipelineRun({
        projectRoot: tsRoot,
        runId: RUN_ID,
        config,
        spec: goldenPlanSpec(),
        completedSprints: completedContracts(),
        failedSprints: [],
        startedAtMs: Date.now(),
      });

      probe.root = flusherRoot;
      await new RunResultFlusher().flush(
        flusherRoot,
        config,
        {
          spec: goldenPlanSpec(),
          perSprint: completedContracts().map((contract) => ({
            contract,
            outcome: "passed" as const,
            iterations: 1,
          })),
          pendingHistory: [],
          needsClarification: false,
        },
        { runId: RUN_ID },
      );

      probe.root = pgeRoot;
      await createCommitBoundary().finalize(
        {
          ...goldenInitialState(RUN_ID, pgeRoot),
          spec: goldenPlanSpec(),
          sprintContracts: completedContracts(),
        },
        { runId: RUN_ID, projectRoot: pgeRoot, config, superstep: 9, startedAtMs: Date.now() },
      );

      const markers = await Promise.all([tsRoot, flusherRoot, pgeRoot].map(markerBytes));
      expect(markers[1]).toBe(markers[0]);
      expect(markers[2]).toBe(markers[0]);

      const lines = await Promise.all([tsRoot, flusherRoot, pgeRoot].map(historyLine));
      expect(lines[1]).toBe(lines[0]);
      expect(lines[2]).toBe(lines[0]);

      // ORDER: at the instant the history line was written, the marker was already there —
      // for every one of the three callers.
      expect(probe.markerPresentAtHistoryWrite).toEqual([true, true, true]);
    } finally {
      await rm(tsRoot, { recursive: true, force: true });
      await rm(flusherRoot, { recursive: true, force: true });
      await rm(pgeRoot, { recursive: true, force: true });
    }
  });
});
