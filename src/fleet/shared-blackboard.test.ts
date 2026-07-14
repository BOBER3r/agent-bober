import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import {
  SharedBlackboard,
  BLACKBOARD_MAX_ROUNDS,
} from "./shared-blackboard.js";

// ── Helpers ───────────────────────────────────────────────────────────

const NOW = "2026-06-18T00:00:00.000Z";

// ── SharedBlackboard (WAL mode — sc-1-3) ─────────────────────────────

describe("SharedBlackboard — WAL mode (sc-1-3)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-blackboard-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("open() creates the facts.db file and enables WAL journal mode", async () => {
    const dbPath = join(tmpDir, "bb.db");
    const bb = await SharedBlackboard.open({
      dbPath,
      namespace: "ns",
      maxRounds: 3,
    });
    bb.close();

    // Verify file was created and WAL mode is active via a raw connection
    const raw = new Database(dbPath);
    const mode = raw.pragma("journal_mode", { simple: true });
    raw.close();

    expect(mode).toBe("wal");
  });

  it("open() creates parent directories if absent", async () => {
    const dbPath = join(tmpDir, "nested", "deep", "bb.db");
    const bb = await SharedBlackboard.open({
      dbPath,
      namespace: "ns",
      maxRounds: 3,
    });
    bb.close();

    const raw = new Database(dbPath);
    const mode = raw.pragma("journal_mode", { simple: true });
    raw.close();

    expect(mode).toBe("wal");
  });
});

// ── SharedBlackboard (publish + round cap — sc-1-4) ───────────────────

describe("SharedBlackboard — publish + round cap (sc-1-4)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-blackboard-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("publish writes a FactRecord with correct fields", async () => {
    const dbPath = join(tmpDir, "bb.db");
    const bb = await SharedBlackboard.open({
      dbPath,
      namespace: "fleet-run-1",
      maxRounds: 3,
    });

    const rec = bb.publish(
      { childFolder: "child-a", round: 1, payload: "analysis done" },
      NOW,
    );
    bb.close();

    expect(rec.scope).toBe("fleet-run-1");
    expect(rec.subject).toBe("child-a");
    expect(rec.predicate).toBe("finding");
    expect(rec.value).toBe("analysis done");
    expect(rec.confidence).toBe(1);
    expect(rec.tValid).toBe(NOW);
    expect(rec.tCreated).toBe(NOW);
  });

  it("publish respects custom confidence", async () => {
    const dbPath = join(tmpDir, "bb.db");
    const bb = await SharedBlackboard.open({
      dbPath,
      namespace: "ns",
      maxRounds: 3,
    });

    const rec = bb.publish(
      { childFolder: "child-a", round: 1, payload: "partial", confidence: 0.7 },
      NOW,
    );
    bb.close();

    expect(rec.confidence).toBe(0.7);
  });

  it("publish throws when round exceeds maxRounds (default BLACKBOARD_MAX_ROUNDS=3)", async () => {
    const dbPath = join(tmpDir, "bb.db");
    const bb = await SharedBlackboard.open({
      dbPath,
      namespace: "ns",
      maxRounds: 3,
    });

    expect(() =>
      bb.publish({ childFolder: "child-a", round: 4, payload: "too late" }, NOW),
    ).toThrow(/round 4 exceeds cap 3/);

    bb.close();
  });

  it("publish throws on round > custom maxRounds (capped at BLACKBOARD_MAX_ROUNDS)", async () => {
    // maxRounds=5 but BLACKBOARD_MAX_ROUNDS=3, so effective cap=3
    const dbPath = join(tmpDir, "bb.db");
    const bb = await SharedBlackboard.open({
      dbPath,
      namespace: "ns",
      maxRounds: 5,
    });

    expect(() =>
      bb.publish({ childFolder: "child-a", round: 4, payload: "over cap" }, NOW),
    ).toThrow(/round 4 exceeds cap 3/);

    bb.close();
  });

  it("BLACKBOARD_MAX_ROUNDS constant equals 3", () => {
    expect(BLACKBOARD_MAX_ROUNDS).toBe(3);
  });
});

// ── SharedBlackboard (readSiblings / readAll — sc-1-5) ────────────────

describe("SharedBlackboard — readSiblings + readAll (sc-1-5)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-blackboard-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("readAll returns [] when no findings published", async () => {
    const dbPath = join(tmpDir, "empty.db");
    const bb = await SharedBlackboard.open({ dbPath, namespace: "ns" });
    expect(bb.readAll()).toEqual([]);
    bb.close();
  });

  it("readSiblings returns [] when no findings published", async () => {
    const dbPath = join(tmpDir, "empty.db");
    const bb = await SharedBlackboard.open({ dbPath, namespace: "ns" });
    expect(bb.readSiblings("child-a")).toEqual([]);
    bb.close();
  });

  it("two subjects: readSiblings excludes self, readAll returns both", async () => {
    const dbPath = join(tmpDir, "bb.db");
    const bb = await SharedBlackboard.open({
      dbPath,
      namespace: "ns",
      maxRounds: 3,
    });

    bb.publish({ childFolder: "child-a", round: 1, payload: "finding-a" }, NOW);
    bb.publish(
      { childFolder: "child-b", round: 1, payload: "finding-b" },
      "2026-06-18T00:00:01.000Z",
    );

    const allFacts = bb.readAll();
    expect(allFacts).toHaveLength(2);

    const siblingsOfA = bb.readSiblings("child-a");
    expect(siblingsOfA).toHaveLength(1);
    expect(siblingsOfA[0].subject).toBe("child-b");

    const siblingsOfB = bb.readSiblings("child-b");
    expect(siblingsOfB).toHaveLength(1);
    expect(siblingsOfB[0].subject).toBe("child-a");

    bb.close();
  });

  it("readSiblings is scoped to namespace — different namespace is isolated", async () => {
    const dbPath = join(tmpDir, "bb.db");

    const bb1 = await SharedBlackboard.open({
      dbPath,
      namespace: "ns-1",
      maxRounds: 3,
    });
    const bb2 = await SharedBlackboard.open({
      dbPath,
      namespace: "ns-2",
      maxRounds: 3,
    });

    bb1.publish({ childFolder: "child-a", round: 1, payload: "ns1-finding" }, NOW);

    expect(bb2.readAll()).toHaveLength(0);
    expect(bb2.readSiblings("child-x")).toHaveLength(0);

    bb1.close();
    bb2.close();
  });
});

// ── SharedBlackboard (concurrency — sc-1-6) ───────────────────────────

describe("SharedBlackboard — concurrency (sc-1-6)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-blackboard-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it(">=5 concurrent publish() calls all persist (WAL + busy_timeout)", async () => {
    const dbPath = join(tmpDir, "concurrent.db");
    const bb = await SharedBlackboard.open({
      dbPath,
      namespace: "fleet-concurrent",
      maxRounds: 3,
      busyTimeoutMs: 5000,
    });

    const N = 5;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        // Use distinct childFolder AND payload so deterministic ids differ
        Promise.resolve().then(() =>
          bb.publish(
            { childFolder: `child-${i}`, round: 1, payload: `payload-${i}` },
            NOW,
          ),
        ),
      ),
    );

    expect(bb.readAll()).toHaveLength(N);

    bb.close();
  });

  it("multiple SharedBlackboard instances on same db can publish without deadlock", async () => {
    const dbPath = join(tmpDir, "multi-writer.db");

    const instances = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        SharedBlackboard.open({
          dbPath,
          namespace: "shared-ns",
          maxRounds: 3,
          busyTimeoutMs: 5000,
        }).then((bb) => ({ bb, i })),
      ),
    );

    await Promise.all(
      instances.map(({ bb, i }) =>
        Promise.resolve().then(() =>
          bb.publish(
            {
              childFolder: `worker-${i}`,
              round: 1,
              payload: `result-from-${i}`,
            },
            NOW,
          ),
        ),
      ),
    );

    const reader = instances[0].bb;
    expect(reader.readAll()).toHaveLength(5);

    for (const { bb } of instances) {
      bb.close();
    }
  });
});
