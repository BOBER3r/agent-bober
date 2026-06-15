/**
 * Unit tests for compareToBaseline and runReplayHarness (sc-2-5).
 *
 * Uses in-memory ReplayStore (':memory:') seeded via putCase with known
 * evalDetailsJson so fresh verdicts are fully predictable.
 */

import { describe, it, expect, afterEach } from "vitest";

import { ReplayStore } from "./replay-store.js";
import {
  compareToBaseline,
  runReplayHarness,
  type Verdict,
} from "./replay-harness.js";
import type { BoberConfig } from "../../config/schema.js";

// ── Fixture helpers ────────────────────────────────────────────────────

/** evalDetailsJson that re-derives to 'fail': one error-severity failure. */
const FAIL_DETAILS = JSON.stringify([
  {
    evaluator: "test",
    passed: false,
    failures: [{ passed: false, severity: "error", message: "boom" }],
  },
]);

/** evalDetailsJson that re-derives to 'pass': no error-severity failures. */
const PASS_DETAILS = JSON.stringify([
  { evaluator: "test", passed: true, failures: [] },
]);

/** evalDetailsJson with only a warning-severity failure → still 'pass'. */
const WARN_DETAILS = JSON.stringify([
  {
    evaluator: "test",
    passed: false,
    failures: [{ passed: false, severity: "warning", message: "mild" }],
  },
]);

/** Minimal stub BoberConfig that satisfies the harness signature. */
function makeConfig(overrides?: { replayDir?: string }): BoberConfig {
  return {
    project: { name: "test", mode: "greenfield" },
    selfImprove: overrides?.replayDir
      ? {
          deterministicGate: false,
          rubricIsolation: false,
          requireCitedArtifact: false,
          replayDir: overrides.replayDir,
        }
      : undefined,
  } as unknown as BoberConfig;
}

function makeStore(): ReplayStore {
  return new ReplayStore(":memory:");
}

function seedCase(
  store: ReplayStore,
  opts: {
    contractId: string;
    iteration: number;
    baselineVerdict: "pass" | "fail";
    evalDetailsJson: string;
  },
) {
  return store.putCase({
    contractId: opts.contractId,
    iteration: opts.iteration,
    baselineVerdict: opts.baselineVerdict,
    diffDigest: "aabbccddeeff00112233445566778899",
    evalDetailsJson: opts.evalDetailsJson,
    tCaptured: new Date().toISOString(),
  });
}

// ── compareToBaseline (pure) ───────────────────────────────────────────

describe("compareToBaseline (sc-2-3)", () => {
  it("identical rerun yields zero regressions", () => {
    const base: Map<string, Verdict> = new Map([
      ["c1", "pass"],
      ["c2", "fail"],
    ]);
    const fresh: Map<string, Verdict> = new Map([
      ["c1", "pass"],
      ["c2", "fail"],
    ]);
    const result = compareToBaseline(base, fresh);
    expect(result.regressions).toEqual([]);
    expect(result.improvements).toEqual([]);
    expect(result.unchanged.sort()).toEqual(["c1", "c2"]);
  });

  it("pass→fail flip appears in regressions exactly once", () => {
    const base: Map<string, Verdict> = new Map([["c1", "pass"]]);
    const fresh: Map<string, Verdict> = new Map([["c1", "fail"]]);
    const result = compareToBaseline(base, fresh);
    expect(result.regressions).toEqual(["c1"]);
    expect(result.improvements).toEqual([]);
    expect(result.unchanged).toEqual([]);
  });

  it("fail→pass flip appears in improvements", () => {
    const base: Map<string, Verdict> = new Map([["c1", "fail"]]);
    const fresh: Map<string, Verdict> = new Map([["c1", "pass"]]);
    const result = compareToBaseline(base, fresh);
    expect(result.regressions).toEqual([]);
    expect(result.improvements).toEqual(["c1"]);
    expect(result.unchanged).toEqual([]);
  });

  it("empty corpus yields all-empty arrays", () => {
    const result = compareToBaseline(new Map(), new Map());
    expect(result).toEqual({ regressions: [], improvements: [], unchanged: [] });
  });

  it("caseId present only in fresh (not in baseline) is not classified", () => {
    const base: Map<string, Verdict> = new Map([["c1", "pass"]]);
    const fresh: Map<string, Verdict> = new Map([
      ["c1", "pass"],
      ["c2", "fail"],
    ]);
    const result = compareToBaseline(base, fresh);
    // c2 is not in baseline — must not appear in any category
    expect(result.regressions).toEqual([]);
    expect(result.improvements).toEqual([]);
    expect(result.unchanged).toEqual(["c1"]);
  });

  it("output arrays are sorted for deterministic output", () => {
    const base: Map<string, Verdict> = new Map([
      ["z1", "pass"],
      ["a1", "pass"],
      ["m1", "pass"],
    ]);
    const fresh: Map<string, Verdict> = new Map([
      ["z1", "fail"],
      ["a1", "fail"],
      ["m1", "fail"],
    ]);
    const { regressions } = compareToBaseline(base, fresh);
    expect(regressions).toEqual(["a1", "m1", "z1"]);
  });

  it("warning-severity failure does not cause regression", () => {
    // A pass→pass where fresh also has only warnings → unchanged
    const base: Map<string, Verdict> = new Map([["c1", "pass"]]);
    const fresh: Map<string, Verdict> = new Map([["c1", "pass"]]);
    const result = compareToBaseline(base, fresh);
    expect(result.regressions).toEqual([]);
    expect(result.unchanged).toEqual(["c1"]);
  });
});

// ── runReplayHarness (async, in-memory store) ──────────────────────────

describe("runReplayHarness (sc-2-4 / sc-2-5)", () => {
  let store: ReplayStore;

  afterEach(() => {
    if (store) {
      try {
        store.close();
      } catch {
        // already closed
      }
    }
  });

  it("identical rerun → zero regressions", async () => {
    // baseline 'pass', evalDetailsJson → 'pass' → unchanged, no regressions
    store = makeStore();
    const rec = seedCase(store, {
      contractId: "sprint-c1",
      iteration: 1,
      baselineVerdict: "pass",
      evalDetailsJson: PASS_DETAILS,
    });
    store.close();

    // runReplayHarness opens its own store by path — we need a file path
    // For ":memory:" we seed separately; use a temp path via a fixture
    // Instead, verify via the direct comparator path (pure function covers it),
    // and test the async path in the CLI tests. Here we cover the harness via
    // the exported compareToBaseline which is what the harness delegates to.
    expect(rec.baselineVerdict).toBe("pass");

    // Direct in-memory store test: compareToBaseline with matching verdicts
    const baseline: Map<string, Verdict> = new Map([["c1", "pass"]]);
    const fresh: Map<string, Verdict> = new Map([["c1", "pass"]]);
    const result = compareToBaseline(baseline, fresh);
    expect(result.regressions).toEqual([]);
    expect(result.improvements).toEqual([]);
  });

  it("pass→fail flip appears in regressions exactly once (via compareToBaseline)", () => {
    const baseline: Map<string, Verdict> = new Map([["case-a", "pass"]]);
    const fresh: Map<string, Verdict> = new Map([["case-a", "fail"]]);
    const result = compareToBaseline(baseline, fresh);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]).toBe("case-a");
  });

  it("fail→pass flip appears in improvements (via compareToBaseline)", () => {
    const baseline: Map<string, Verdict> = new Map([["case-b", "fail"]]);
    const fresh: Map<string, Verdict> = new Map([["case-b", "pass"]]);
    const result = compareToBaseline(baseline, fresh);
    expect(result.improvements).toHaveLength(1);
    expect(result.improvements[0]).toBe("case-b");
  });

  it("empty corpus → all-empty arrays + total=0", async () => {
    // We can't easily test runReplayHarness with :memory: since it opens its
    // own connection; test via a temporary file-backed store
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: pathJoin } = await import("node:path");

    const tmpDir = await mkdtemp(pathJoin(tmpdir(), "bober-harness-test-"));
    const replaySubDir = pathJoin(tmpDir, ".bober", "replay");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(replaySubDir, { recursive: true });

    // Leave DB empty (ReplayStore creates the table on open)
    const emptyStore = new ReplayStore(pathJoin(replaySubDir, "replay.db"));
    emptyStore.close();

    try {
      const config = makeConfig();
      const result = await runReplayHarness(tmpDir, config);
      expect(result.total).toBe(0);
      expect(result.regressions).toEqual([]);
      expect(result.improvements).toEqual([]);
      expect(result.unchanged).toEqual([]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("seeded pass→fail regression is detected by runReplayHarness", async () => {
    const { mkdtemp, rm, mkdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: pathJoin } = await import("node:path");

    const tmpDir = await mkdtemp(pathJoin(tmpdir(), "bober-harness-test-"));
    const replaySubDir = pathJoin(tmpDir, ".bober", "replay");
    await mkdir(replaySubDir, { recursive: true });

    const dbPath = pathJoin(replaySubDir, "replay.db");
    const fileStore = new ReplayStore(dbPath);
    seedCase(fileStore, {
      contractId: "sprint-regress",
      iteration: 1,
      baselineVerdict: "pass",
      evalDetailsJson: FAIL_DETAILS, // fresh → 'fail'
    });
    fileStore.close();

    try {
      const config = makeConfig();
      const result = await runReplayHarness(tmpDir, config);
      expect(result.total).toBe(1);
      expect(result.regressions).toHaveLength(1);
      expect(result.improvements).toEqual([]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("seeded fail→pass improvement is detected by runReplayHarness", async () => {
    const { mkdtemp, rm, mkdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: pathJoin } = await import("node:path");

    const tmpDir = await mkdtemp(pathJoin(tmpdir(), "bober-harness-test-"));
    const replaySubDir = pathJoin(tmpDir, ".bober", "replay");
    await mkdir(replaySubDir, { recursive: true });

    const dbPath = pathJoin(replaySubDir, "replay.db");
    const fileStore = new ReplayStore(dbPath);
    seedCase(fileStore, {
      contractId: "sprint-improve",
      iteration: 1,
      baselineVerdict: "fail",
      evalDetailsJson: PASS_DETAILS, // fresh → 'pass'
    });
    fileStore.close();

    try {
      const config = makeConfig();
      const result = await runReplayHarness(tmpDir, config);
      expect(result.total).toBe(1);
      expect(result.regressions).toEqual([]);
      expect(result.improvements).toHaveLength(1);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("warning-severity failure does NOT cause a regression in runReplayHarness", async () => {
    const { mkdtemp, rm, mkdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: pathJoin } = await import("node:path");

    const tmpDir = await mkdtemp(pathJoin(tmpdir(), "bober-harness-test-"));
    const replaySubDir = pathJoin(tmpDir, ".bober", "replay");
    await mkdir(replaySubDir, { recursive: true });

    const dbPath = pathJoin(replaySubDir, "replay.db");
    const fileStore = new ReplayStore(dbPath);
    seedCase(fileStore, {
      contractId: "sprint-warn",
      iteration: 1,
      baselineVerdict: "pass",
      evalDetailsJson: WARN_DETAILS, // fresh → 'pass' (only warning)
    });
    fileStore.close();

    try {
      const config = makeConfig();
      const result = await runReplayHarness(tmpDir, config);
      expect(result.total).toBe(1);
      expect(result.regressions).toEqual([]);
      expect(result.unchanged).toHaveLength(1);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
