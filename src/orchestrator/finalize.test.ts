// ── finalize.test.ts ─────────────────────────────────────────────────
//
// finalizePipelineRun is the single owner of a run's terminal side-effect set.
// Two consumers wait on that set (src/chat/completion-tailer.ts and anything
// reading .bober/runs/<id>.completed.json), and a malformed emission does not
// throw — it silently strands a run as "never completed". So these tests assert
// SHAPE, COUNT and ORDER, not mere existence.
//
// appendHistory and runWithAudit are wrapped (not replaced) with importOriginal
// pass-throughs purely to observe call counts and interleaving; every write in
// this file is a real write to a real temp directory.

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { PlanSpec } from "../contracts/spec.js";
import type { SprintContract } from "../contracts/sprint-contract.js";
import type * as StateIndexModule from "../state/index.js";
import type * as AuditModule from "./checkpoints/audit.js";
import { createDefaultConfig } from "../config/schema.js";
import { loadHistory } from "../state/history.js";

// ── Observation probes (hoisted so vi.mock can close over them) ───────

const probe = vi.hoisted(() => ({
  /** Ordered log of the observable steps finalizePipelineRun performs. */
  steps: [] as string[],
  /** Marker-existence snapshot taken at each step, filled by the test. */
  markerSeenAt: [] as Array<{ step: string; markerExists: boolean }>,
  /** Root under observation; set per test so the probes know where to look. */
  root: "",
  /**
   * Injected at the ONE instant a concurrent consumer can first observe the
   * run: immediately after the pipeline-complete line is durable on disk and
   * before finalizePipelineRun has done anything else. This is the real race
   * window — src/chat/chat-session.ts polls the tailer from a DIFFERENT process
   * than the one running the pipeline (src/chat/run-spawner.ts spawns
   * `bober run --run-id <id>` as a child), so nothing serialises the two.
   */
  afterHistoryLineVisible: null as null | (() => Promise<void>),
}));

vi.mock("../state/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof StateIndexModule>();
  return {
    ...actual,
    appendHistory: vi.fn(
      async (root: string, entry: Parameters<typeof actual.appendHistory>[1]) => {
        const terminal = entry.event === "pipeline-complete";
        if (terminal) {
          probe.steps.push("history");
          probe.markerSeenAt.push({
            step: "history",
            markerExists: await markerExists(probe.root),
          });
        }
        const out = await actual.appendHistory(root, entry);
        if (terminal && probe.afterHistoryLineVisible) {
          await probe.afterHistoryLineVisible();
        }
        return out;
      },
    ),
  };
});

vi.mock("./checkpoints/audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof AuditModule>();
  return {
    ...actual,
    runWithAudit: vi.fn(async (opts: Parameters<typeof actual.runWithAudit>[0]) => {
      if (opts.checkpointId === "end-of-pipeline") {
        probe.steps.push("checkpoint");
        probe.markerSeenAt.push({
          step: "checkpoint",
          markerExists: await markerExists(probe.root),
        });
      }
      return actual.runWithAudit(opts);
    }),
  };
});

import {
  COMPLETION_MARKER_SUFFIX,
  FinalizeVerdictMismatchError,
  PIPELINE_COMPLETE_EVENT,
  completionMarkerPath,
  deriveRunSuccess,
  deriveRunVerdict,
  finalizePipelineRun,
  runsDir,
  writeCompletionMarker,
} from "./finalize.js";
import { appendHistory } from "../state/index.js";
import { runWithAudit } from "./checkpoints/audit.js";
import { CompletionTailer, type CompletionEvent } from "../chat/completion-tailer.js";

// ── Helpers ──────────────────────────────────────────────────────────

let root = "";

/** Any marker file present under .bober/runs/ (used by the ordering probe). */
async function markerExists(dir: string): Promise<boolean> {
  if (!dir) return false;
  try {
    const entries = await readdir(runsDir(dir));
    return entries.some((e) => e.endsWith(COMPLETION_MARKER_SUFFIX));
  } catch {
    return false;
  }
}

async function listMarkers(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(runsDir(dir));
    return entries.filter((e) => e.endsWith(COMPLETION_MARKER_SUFFIX)).sort();
  } catch {
    return [];
  }
}

function makeSpec(): PlanSpec {
  const now = "2026-08-05T00:00:00.000Z";
  return {
    specId: "spec-finalize-1",
    version: 1,
    title: "Terminal side-effect ownership",
    description: "Extract the terminal block so every engine emits one set.",
    status: "in-progress",
    mode: "brownfield",
    features: [
      {
        featureId: "feat-3",
        title: "Single terminal owner",
        description: "One emitter for the completion event and marker.",
        priority: "must-have",
        acceptanceCriteria: ["Exactly one history line", "Exactly one marker"],
      },
    ],
    assumptions: [],
    outOfScope: [],
    clarificationQuestions: [],
    resolvedClarifications: [],
    techStack: ["TypeScript"],
    nonFunctionalRequirements: [],
    constraints: [],
    createdAt: now,
    updatedAt: now,
  };
}

function makeContract(id: string): SprintContract {
  const now = "2026-08-05T00:00:00.000Z";
  return {
    contractId: id,
    specId: "spec-finalize-1",
    sprintNumber: 1,
    title: "Extract finalizePipelineRun",
    description:
      "Move the terminal side-effect block out of runTsPipeline into a shared " +
      "module so the flusher path emits the identical history event and marker.",
    status: "passed",
    dependsOn: [],
    features: ["feat-3"],
    successCriteria: [
      {
        criterionId: "sc-4-4",
        description: "finalizePipelineRun is the only emitter of the terminal set.",
        verificationMethod: "unit-test",
        required: true,
      },
    ],
    nonGoals: ["Do not implement PgeEngine in this sprint."],
    stopConditions: ["Stop when the terminal set has exactly one emitter."],
    definitionOfDone:
      "One owner emits the pipeline-complete event and the completion marker.",
    assumptions: [],
    outOfScope: [],
    ambiguityScore: 2,
    estimatedFiles: ["src/orchestrator/finalize.ts"],
    estimatedDuration: "medium",
    iterationHistory: [],
    createdAt: now,
    updatedAt: now,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-finalize-"));
  probe.steps.length = 0;
  probe.markerSeenAt.length = 0;
  probe.root = root;
  probe.afterHistoryLineVisible = null;
  vi.mocked(appendHistory).mockClear();
  vi.mocked(runWithAudit).mockClear();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// ── sc-4-6: frozen PipelineResult key set ────────────────────────────

describe("finalizePipelineRun — frozen PipelineResult shape (sc-4-6)", () => {
  /**
   * Transcribed from the PRE-extraction source, not from the new code:
   *
   *   $ git show HEAD~:src/orchestrator/pipeline.ts | sed -n '1048,1054p'
   *     return {
   *       success,
   *       spec,
   *       completedSprints,
   *       failedSprints,
   *       duration,
   *     };
   *
   * Insertion order is asserted too, so a re-ordered literal is a failure even
   * though the key SET would still match.
   */
  const PRE_EXTRACTION_KEYS = [
    "success",
    "spec",
    "completedSprints",
    "failedSprints",
    "duration",
  ];

  it("returns exactly the pre-extraction key set, in the pre-extraction order", async () => {
    const spec = makeSpec();
    const result = await finalizePipelineRun({
      projectRoot: root,
      runId: "run-keys",
      config: createDefaultConfig("test", "brownfield"),
      spec,
      completedSprints: [makeContract("c1")],
      failedSprints: [],
      startedAtMs: Date.now() - 1234,
    });

    expect(Object.keys(result)).toEqual(PRE_EXTRACTION_KEYS);
    expect(result.success).toBe(true);
    expect(result.spec).toBe(spec);
    expect(result.completedSprints).toHaveLength(1);
    expect(result.failedSprints).toHaveLength(0);
    expect(result.duration).toBeGreaterThanOrEqual(1234);
  });

  it("does not add a needsClarification key (that field is workflow-only)", async () => {
    const result = await finalizePipelineRun({
      projectRoot: root,
      runId: "run-keys-2",
      config: createDefaultConfig("test", "brownfield"),
      spec: makeSpec(),
      completedSprints: [],
      failedSprints: [makeContract("c1")],
      startedAtMs: Date.now(),
    });
    expect("needsClarification" in result).toBe(false);
    expect(result.success).toBe(false);
  });
});

// ── Verdict derivation ───────────────────────────────────────────────

describe("run verdict derivation", () => {
  it("derives success only when there are passes and zero failures", () => {
    expect(deriveRunSuccess(1, 0)).toBe(true);
    expect(deriveRunSuccess(3, 0)).toBe(true);
    expect(deriveRunSuccess(0, 0)).toBe(false); // nothing ran → not a success
    expect(deriveRunSuccess(1, 1)).toBe(false);
    expect(deriveRunSuccess(0, 2)).toBe(false);
  });

  it("maps the same facts to the three-valued verdict", () => {
    expect(deriveRunVerdict(2, 0)).toBe("success");
    expect(deriveRunVerdict(2, 1)).toBe("partial");
    expect(deriveRunVerdict(0, 1)).toBe("failed");
    expect(deriveRunVerdict(0, 0)).toBe("failed");
  });

  it("throws FinalizeVerdictMismatchError when a caller asserts the wrong verdict", async () => {
    await expect(
      finalizePipelineRun({
        projectRoot: root,
        runId: "run-mismatch",
        config: createDefaultConfig("test", "brownfield"),
        spec: makeSpec(),
        completedSprints: [makeContract("c1")],
        failedSprints: [makeContract("c2")],
        startedAtMs: Date.now(),
        verdict: "success", // derived verdict is "partial"
      }),
    ).rejects.toBeInstanceOf(FinalizeVerdictMismatchError);

    // Nothing was emitted — the guard runs BEFORE any write.
    expect(await listMarkers(root)).toEqual([]);
    expect(vi.mocked(appendHistory)).not.toHaveBeenCalled();
  });

  it("accepts a matching asserted verdict and emits normally", async () => {
    const result = await finalizePipelineRun({
      projectRoot: root,
      runId: "run-match",
      config: createDefaultConfig("test", "brownfield"),
      spec: makeSpec(),
      completedSprints: [makeContract("c1")],
      failedSprints: [makeContract("c2")],
      startedAtMs: Date.now(),
      verdict: "partial",
    });
    expect(result.success).toBe(false);
    expect(await listMarkers(root)).toEqual(["run-match.completed.json"]);
  });
});

// ── Exactly-once, by counting writes ─────────────────────────────────

describe("finalizePipelineRun — exactly-once emission (counted)", () => {
  it("performs exactly ONE history append and ONE marker write per call", async () => {
    await finalizePipelineRun({
      projectRoot: root,
      runId: "run-once",
      config: createDefaultConfig("test", "brownfield"),
      spec: makeSpec(),
      completedSprints: [makeContract("c1")],
      failedSprints: [],
      startedAtMs: Date.now(),
    });

    // Counted at the call site, not inferred from the resulting file.
    expect(vi.mocked(appendHistory)).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(runWithAudit).mock.calls.filter(
        (c) => c[0].checkpointId === "end-of-pipeline",
      ),
    ).toHaveLength(1);

    // ...and confirmed against the durable artifacts.
    const history = await loadHistory(root);
    expect(history.filter((h) => h.event === PIPELINE_COMPLETE_EVENT)).toHaveLength(1);
    expect(await listMarkers(root)).toEqual(["run-once.completed.json"]);

    // One line total in the file — the append did not double-write.
    const raw = await readFile(join(root, ".bober", "history.jsonl"), "utf-8");
    expect(raw.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(1);
  });

  it("two runs in the SAME process emit one event and one marker EACH, per runId", async () => {
    const config = createDefaultConfig("test", "brownfield");
    for (const runId of ["run-p1", "run-p2"]) {
      await finalizePipelineRun({
        projectRoot: root,
        runId,
        config,
        spec: makeSpec(),
        completedSprints: [makeContract("c1")],
        failedSprints: [],
        startedAtMs: Date.now(),
      });
    }

    expect(vi.mocked(appendHistory)).toHaveBeenCalledTimes(2);
    expect(await listMarkers(root)).toEqual([
      "run-p1.completed.json",
      "run-p2.completed.json",
    ]);
    const history = await loadHistory(root);
    expect(history.filter((h) => h.event === PIPELINE_COMPLETE_EVENT)).toHaveLength(2);
  });
});

// ── Emission ORDER is load-bearing ───────────────────────────────────

describe("finalizePipelineRun — pinned emission order", () => {
  /**
   * The marker is the DATA and the history line is the TRIGGER, so the data
   * must be durable before the trigger becomes visible.
   *
   * src/chat/completion-tailer.ts scans for a pipeline-complete line and then
   * resolves the runId from a .bober/runs/<id>.completed.json marker, because
   * the line itself carries no runId. It consumes the line unconditionally:
   * it advances the persisted byte cursor past it and records a synthetic
   * dedupe key, so a poll that lands while the marker is still missing loses
   * the runId FOREVER (see the interleaving test below).
   *
   * The checkpoint keeps its pre-extraction position relative to the history
   * line (line first, then gate) — only the marker moved earlier.
   */
  it("writes the marker BEFORE the history line the tailer triggers on", async () => {
    await finalizePipelineRun({
      projectRoot: root,
      runId: "run-order",
      config: createDefaultConfig("test", "brownfield"),
      spec: makeSpec(),
      completedSprints: [makeContract("c1")],
      failedSprints: [],
      startedAtMs: Date.now(),
    });

    expect(probe.steps).toEqual(["history", "checkpoint"]);

    // The marker must ALREADY exist at both of these steps: that is what makes
    // this an ORDER assertion rather than a "both happened" assertion.
    expect(probe.markerSeenAt).toEqual([
      { step: "history", markerExists: true },
      { step: "checkpoint", markerExists: true },
    ]);

    expect(await listMarkers(root)).toEqual(["run-order.completed.json"]);
  });

  /**
   * Regression test for the emission-order race.
   *
   * ChatSession.handleTurn polls CompletionTailer once per turn, from a process
   * that is NOT the one running the pipeline (run-spawner spawns `bober run
   * --run-id <id>` as a child). Nothing serialises the poll against the
   * emission, so the poll can land in the window between the two writes.
   *
   * Under the pre-fix order (history line, then checkpoint, then marker) that
   * poll returned an event with `runId: undefined`, persisted an advanced byte
   * cursor plus a synthetic `${timestamp}:${durationMs}` dedupe key, and every
   * later poll returned []. chat-session.ts guards `if (c.runId)`, so
   * cleanupTerminalRun never ran and the run's approval markers, guidance.jsonl
   * and paused.json were stranded permanently.
   */
  it("delivers the runId to a tailer that polls the instant the history line lands", async () => {
    let observed: CompletionEvent[] | null = null;
    const tailer = new CompletionTailer(root, "session-race");
    probe.afterHistoryLineVisible = async () => {
      observed = await tailer.poll();
    };

    await finalizePipelineRun({
      projectRoot: root,
      runId: "run-race",
      config: createDefaultConfig("test", "brownfield"),
      spec: makeSpec(),
      completedSprints: [makeContract("c1")],
      failedSprints: [],
      startedAtMs: Date.now(),
    });

    // The probe really did fire inside the window.
    expect(observed).not.toBeNull();
    const events = observed as unknown as CompletionEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]!.runId).toBe("run-race");
    expect(events[0]!.phase).toBe("complete");

    // ...and the delivery was the only one: the tailer consumed the line, so a
    // runId missed here could never be recovered by a later poll.
    expect(await tailer.poll()).toEqual([]);
  });
});

// ── The audit label tracks the mechanism actually invoked (regression) ─

describe("finalizePipelineRun — the audit label matches the resolved mechanism, not just the global default", () => {
  /**
   * `getCheckpointMechanismFor` two lines below the label (`finalize.ts`) resolves through
   * the FULL override-aware ladder — `resolveCheckpointMechanismName`, the SAME expression
   * `interrupt.ts`'s controller uses for this checkpoint's own hitl-branch and gated-effect-
   * branch calls. The label used to read only `config.pipeline?.checkpointMechanism`,
   * silently ignoring `checkpointOverrides` (tier 2 of that ladder,
   * `checkpoints/registry.ts:76-77`).
   *
   * A config setting `checkpointMechanism: "disk"` GLOBALLY and `checkpointOverrides: {
   * "end-of-pipeline": "noop" }` PER-CHECKPOINT — a combination `config/schema.ts` accepts —
   * therefore resolved the ACTUAL request through `noop` (auto-approved, nobody asked) while
   * the audit line still claimed `"disk"`. `runWithAudit` resolves `approverId` from exactly
   * that label (`checkpoints/audit.ts`'s `resolveApproverId`): the `"disk"` branch shells out
   * to `git config user.name`, so the audit trail credited a named human with an approval
   * autopilot rubber-stamped. This test fails if the two ever diverge again.
   */
  it("labels the end-of-pipeline record with the OVERRIDE mechanism, not the global default", async () => {
    const base = createDefaultConfig("test", "brownfield");
    const config = {
      ...base,
      pipeline: {
        ...base.pipeline,
        checkpointMechanism: "disk" as const,
        checkpointOverrides: { "end-of-pipeline": "noop" as const },
      },
    };

    await finalizePipelineRun({
      projectRoot: root,
      runId: "run-label-override",
      config,
      spec: makeSpec(),
      completedSprints: [makeContract("c1")],
      failedSprints: [],
      startedAtMs: Date.now(),
    });

    // The wrapped mock's own captured argument — what finalizePipelineRun actually passed.
    const call = vi
      .mocked(runWithAudit)
      .mock.calls.find((c) => c[0].checkpointId === "end-of-pipeline");
    expect(call?.[0].mechanism).toBe("noop");

    // ...and the DURABLE artifact agrees: this is what `resolveApproverId` saw, and what an
    // operator reading `.bober/audits/<runId>.jsonl` sees.
    const raw = await readFile(
      join(root, ".bober", "audits", "run-label-override.jsonl"),
      "utf-8",
    );
    const lines = raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { checkpointId: string; mechanism: string; approverId: string });
    const line = lines.find((l) => l.checkpointId === "end-of-pipeline");
    expect(line?.mechanism).toBe("noop");
    // noop's approverId is the fixed constant "autopilot" — never a git-config-derived human
    // name for a request the durable "disk" mechanism never actually saw.
    expect(line?.approverId).toBe("autopilot");
  });
});

// ── Wire shapes the tailer depends on ────────────────────────────────

describe("finalizePipelineRun — emitted wire shapes", () => {
  it("history line matches every field the tailer reads", async () => {
    await finalizePipelineRun({
      projectRoot: root,
      runId: "run-wire",
      config: createDefaultConfig("test", "brownfield"),
      spec: makeSpec(),
      completedSprints: [makeContract("c1"), makeContract("c2")],
      failedSprints: [makeContract("c3")],
      startedAtMs: Date.now() - 50,
    });

    const history = await loadHistory(root);
    const entry = history.find((h) => h.event === PIPELINE_COMPLETE_EVENT);
    expect(entry).toBeDefined();
    // completion-tailer.ts:181 compares against exactly this string.
    expect(entry!.event).toBe("pipeline-complete");
    // phase must be a PhaseSchema member or HistoryEntrySchema.safeParse fails
    // inside the tailer and the line is silently skipped.
    expect(entry!.phase).toBe("failed");
    expect(entry!.details["completed"]).toBe(2);
    expect(entry!.details["failed"]).toBe(1);
    expect(typeof entry!.details["durationMs"]).toBe("number");
    // The tailer coerces non-numbers to 0 — assert we never hand it one.
    expect(Number.isFinite(entry!.details["durationMs"] as number)).toBe(true);
  });

  it("marker filename is exactly <runId> + COMPLETION_MARKER_SUFFIX", async () => {
    await finalizePipelineRun({
      projectRoot: root,
      runId: "run-name",
      config: createDefaultConfig("test", "brownfield"),
      spec: makeSpec(),
      completedSprints: [makeContract("c1")],
      failedSprints: [],
      startedAtMs: Date.now(),
    });

    expect(COMPLETION_MARKER_SUFFIX).toBe(".completed.json");
    expect(completionMarkerPath(root, "run-name")).toBe(
      join(root, ".bober", "runs", "run-name.completed.json"),
    );
    expect(await listMarkers(root)).toEqual(["run-name.completed.json"]);
  });

  it("marker JSON carries a runId string — the tailer's fallback reads it", async () => {
    await finalizePipelineRun({
      projectRoot: root,
      runId: "run-marker-body",
      config: createDefaultConfig("test", "brownfield"),
      spec: makeSpec(),
      completedSprints: [makeContract("c1")],
      failedSprints: [],
      startedAtMs: Date.now(),
    });

    const parsed = JSON.parse(
      await readFile(completionMarkerPath(root, "run-marker-body"), "utf-8"),
    ) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "runId",
      "completedAt",
      "success",
      "completedSprints",
      "failedSprints",
      "duration",
    ]);
    expect(parsed["runId"]).toBe("run-marker-body");
  });
});

// ── writeCompletionMarker atomicity ──────────────────────────────────

describe("writeCompletionMarker", () => {
  it("leaves no .tmp file behind (temp-file + rename)", async () => {
    await writeCompletionMarker(root, "run-atomic", { success: true });
    const entries = await readdir(runsDir(root));
    expect(entries).toEqual(["run-atomic.completed.json"]);
  });

  it("creates .bober/runs/ when it does not exist", async () => {
    await writeCompletionMarker(root, "run-mkdir", { success: false });
    expect(await listMarkers(root)).toEqual(["run-mkdir.completed.json"]);
  });
});
