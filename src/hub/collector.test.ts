import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactStore, factsDbPath, ensureFactsDir } from "../state/facts.js";
import { HUB_SCOPE } from "./finding-source.js";
import { collectFindings } from "./collector.js";

// ── Fixtures ─────────────────────────────────────────────────────────

const T = "2026-06-28T00:00:00.000Z";

function findingJson(id: string): string {
  return JSON.stringify({
    id,
    domain: "medical",
    title: `t-${id}`,
    kind: "action",
    urgency: 3,
    severity: 4,
    evidence: ["e"],
    surfacedAt: T,
    tags: ["x"],
    status: "open",
  });
}

/**
 * Seed a writable file-backed store (no WAL — keeps mtime stable for sc-2-4)
 * at <repoRoot>/.bober/memory/facts.db, insert one finding per id, then close.
 */
async function seedRepo(repoRoot: string, ids: string[]): Promise<void> {
  await ensureFactsDir(repoRoot);
  const store = new FactStore(factsDbPath(repoRoot)); // no opts -> default (non-WAL)
  for (const id of ids) {
    store.insertFact({
      scope: HUB_SCOPE,
      subject: id,
      predicate: "finding",
      value: findingJson(id),
      confidence: 1,
      sourceRunId: null,
      tValid: T,
      tCreated: T,
    });
  }
  store.close();
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("collectFindings", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "bober-collector-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("pools distinct ids across two siblings (sc-2-2)", async () => {
    const a = join(tmp, "kb-a");
    const b = join(tmp, "kb-b");
    await seedRepo(a, ["f-1", "f-2"]);
    await seedRepo(b, ["f-3"]);

    const pooled = collectFindings([a, b], HUB_SCOPE);
    expect(pooled).toHaveLength(3);
  });

  it("dedups an overlapping id to exactly one entry (sc-2-3)", async () => {
    const a = join(tmp, "kb-a");
    const b = join(tmp, "kb-b");
    await seedRepo(a, ["f-1", "f-2"]);
    await seedRepo(b, ["f-2", "f-3"]); // f-2 overlaps

    const pooled = collectFindings([a, b], HUB_SCOPE);
    expect(pooled).toHaveLength(3);
    expect(pooled.filter((f) => f.id === "f-2")).toHaveLength(1);
  });

  it("pooled length equals distinct-id count (sc-2-2 + sc-2-3 combined)", async () => {
    const a = join(tmp, "kb-a");
    const b = join(tmp, "kb-b");
    await seedRepo(a, ["f-1", "f-2", "f-3"]);
    await seedRepo(b, ["f-2", "f-3", "f-4"]);

    const pooled = collectFindings([a, b], HUB_SCOPE);
    // f-1, f-2, f-3, f-4 → 4 distinct
    expect(pooled).toHaveLength(4);
  });

  it("collect leaves the sibling facts.db size and mtime unchanged (sc-2-4)", async () => {
    const a = join(tmp, "kb-a");
    await seedRepo(a, ["f-1"]);
    const dbFile = factsDbPath(a);

    const before = await stat(dbFile);
    collectFindings([a], HUB_SCOPE);
    const after = await stat(dbFile);

    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("write through readonly handle is rejected (sc-2-4)", async () => {
    const a = join(tmp, "kb-a");
    await seedRepo(a, ["f-1"]);
    const dbFile = factsDbPath(a);

    const ro = new FactStore(dbFile, { readonly: true });
    expect(() =>
      ro.insertFact({
        scope: HUB_SCOPE,
        subject: "f-x",
        predicate: "finding",
        value: findingJson("f-x"),
        confidence: 1,
        sourceRunId: null,
        tValid: T,
        tCreated: T,
      }),
    ).toThrow();
    ro.close();
  });

  it("skips a missing sibling without throwing (fault tolerance)", async () => {
    const a = join(tmp, "kb-a");
    await seedRepo(a, ["f-1"]);
    const ghost = join(tmp, "kb-ghost"); // does not exist

    // ghost is passed directly as a repo path whose facts.db is absent → caught silently
    const pooled = collectFindings([a, ghost], HUB_SCOPE);
    expect(pooled).toHaveLength(1);
    expect(pooled[0]?.id).toBe("f-1");
  });

  it("returns empty array when no repos are given", () => {
    expect(collectFindings([], HUB_SCOPE)).toHaveLength(0);
  });
});
