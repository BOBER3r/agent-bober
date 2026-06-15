import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FactStore } from "../../state/facts.js";
import type { FactRecord } from "../../state/facts.js";
import { writeFact } from "./reconcile.js";
import { retrieveRelevantFacts, serializeFactsForContext } from "./fact-retrieve.js";

// ── Helpers ───────────────────────────────────────────────────────────────

function makeFactRecord(
  id: string,
  scope: string,
  subject: string,
  predicate: string,
  value: string,
): FactRecord {
  return {
    id,
    scope,
    subject,
    predicate,
    value,
    confidence: 1,
    sourceRunId: null,
    tValid: "2026-06-15T00:00:00.000Z",
    tInvalid: null,
    tCreated: "2026-06-15T00:00:00.000Z",
    tInvalidated: null,
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-fact-retrieve-test-"));
  await mkdir(join(tmpDir, ".bober"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── serializeFactsForContext — pure function tests ────────────────────────

describe("serializeFactsForContext — pure serializer", () => {
  it("returns '' for empty records array", () => {
    expect(serializeFactsForContext([])).toBe("");
  });

  it("includes header and one line per fact", () => {
    const records = [
      makeFactRecord("id1", "", "project", "project/testCommand", "vitest"),
      makeFactRecord("id2", "", "project", "project/buildCommand", "tsc"),
    ];
    const block = serializeFactsForContext(records, { charBudget: 10_000 });
    expect(block).toContain("## Project facts (durable semantic memory)");
    expect(block).toContain("- project/project/testCommand: vitest");
    expect(block).toContain("- project/project/buildCommand: tsc");
  });

  it("hard charBudget slice — output length is ALWAYS <= budget (sc-5-5)", () => {
    const records = [
      makeFactRecord("id1", "", "project", "project/testCommand", "vitest run"),
      makeFactRecord("id2", "", "project", "project/buildCommand", "tsc --noEmit"),
      makeFactRecord("id3", "", "project", "project/packageManager", "npm"),
      makeFactRecord("id4", "", "project", "project/framework", "react"),
    ];

    const budget = 50;
    const block = serializeFactsForContext(records, { charBudget: budget });
    expect(block.length).toBeLessThanOrEqual(budget);
  });

  it("uses default charBudget of 1200 when none specified", () => {
    const records = [
      makeFactRecord("id1", "", "project", "project/testCommand", "x".repeat(300)),
    ];
    const block = serializeFactsForContext(records);
    expect(block.length).toBeLessThanOrEqual(1200);
    expect(block.length).toBeGreaterThan(0);
  });

  it("zero-length budget returns empty string (hard slice)", () => {
    const records = [makeFactRecord("id1", "", "project", "project/testCommand", "vitest")];
    const block = serializeFactsForContext(records, { charBudget: 0 });
    expect(block.length).toBe(0);
  });
});

// ── retrieveRelevantFacts — in-memory store ranking ───────────────────────

describe("retrieveRelevantFacts — keyword ranking (sc-5-5)", () => {
  it("returns facts that match keywords and omits non-matching ones", async () => {
    const now = "2026-06-15T00:00:00.000Z";
    const store = new FactStore(":memory:");
    try {
      // Write via writeFact through reconcile
      await writeFact(store, {
        scope: "", subject: "project", predicate: "project/testCommand",
        value: "vitest", confidence: 1, sourceRunId: null, tValid: now, tCreated: now,
      }, { now });
      await writeFact(store, {
        scope: "", subject: "project", predicate: "project/framework",
        value: "react", confidence: 1, sourceRunId: null, tValid: now, tCreated: now,
      }, { now });
    } finally {
      store.close();
    }

    // retrieveRelevantFacts uses a file-backed store, so we need a tmpDir store
    const { ensureFactsDir, FactStore: FS2, factsDbPath } = await import("../../state/facts.js");
    await ensureFactsDir(tmpDir);
    const store2 = new FS2(factsDbPath(tmpDir));
    try {
      await writeFact(store2, {
        scope: "", subject: "project", predicate: "project/testCommand",
        value: "vitest", confidence: 1, sourceRunId: null, tValid: now, tCreated: now,
      }, { now });
      await writeFact(store2, {
        scope: "", subject: "project", predicate: "project/framework",
        value: "react", confidence: 1, sourceRunId: null, tValid: now, tCreated: now,
      }, { now });
    } finally {
      store2.close();
    }

    const results = await retrieveRelevantFacts(tmpDir, "", ["vitest", "test"]);
    const predicates = results.map((r) => r.predicate);
    expect(predicates).toContain("project/testCommand");
    // "react" / "framework" don't match "vitest" or "test" tokens
    expect(predicates).not.toContain("project/framework");
  });

  it("returns empty for non-matching keywords", async () => {
    const now = "2026-06-15T00:00:00.000Z";
    const { ensureFactsDir, FactStore: FS2, factsDbPath } = await import("../../state/facts.js");
    await ensureFactsDir(tmpDir);
    const store2 = new FS2(factsDbPath(tmpDir));
    try {
      await writeFact(store2, {
        scope: "", subject: "project", predicate: "project/testCommand",
        value: "vitest", confidence: 1, sourceRunId: null, tValid: now, tCreated: now,
      }, { now });
    } finally {
      store2.close();
    }

    const results = await retrieveRelevantFacts(tmpDir, "", ["zzz-nonexistent"]);
    expect(results).toEqual([]);
  });

  it("returns empty when no facts in store", async () => {
    const results = await retrieveRelevantFacts(tmpDir, "", ["vitest"]);
    expect(results).toEqual([]);
  });

  it("respects topK cap", async () => {
    const now = "2026-06-15T00:00:00.000Z";
    const { ensureFactsDir, FactStore: FS2, factsDbPath } = await import("../../state/facts.js");
    await ensureFactsDir(tmpDir);
    const store2 = new FS2(factsDbPath(tmpDir));
    try {
      for (let i = 0; i < 5; i++) {
        await writeFact(store2, {
          scope: "", subject: "project", predicate: `project/cmd${i}`,
          value: `vitest${i}`, confidence: 1, sourceRunId: null, tValid: now, tCreated: now,
        }, { now });
      }
    } finally {
      store2.close();
    }

    const results = await retrieveRelevantFacts(tmpDir, "", ["vitest"], { topK: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("stable byte-stable tiebreak by id ASC when scores tie", async () => {
    const now = "2026-06-15T00:00:00.000Z";
    const { ensureFactsDir, FactStore: FS2, factsDbPath, factId } = await import("../../state/facts.js");
    await ensureFactsDir(tmpDir);
    const store2 = new FS2(factsDbPath(tmpDir));
    try {
      // Write two facts with identical keyword overlap (both contain "vitest")
      await writeFact(store2, {
        scope: "", subject: "project", predicate: "project/testCommand",
        value: "vitest run", confidence: 1, sourceRunId: null, tValid: now, tCreated: now,
      }, { now });
      await writeFact(store2, {
        scope: "", subject: "project", predicate: "project/buildCommand",
        value: "vitest build", confidence: 1, sourceRunId: null, tValid: now, tCreated: now,
      }, { now });
    } finally {
      store2.close();
    }

    const results = await retrieveRelevantFacts(tmpDir, "", ["vitest"], { topK: 10 });
    // Verify id order is ascending when scores tie
    const ids = results.map((r) => r.id);
    const sorted = [...ids].sort((a, b) => a.localeCompare(b));
    expect(ids).toEqual(sorted);

    // Suppress the unused import warning
    void factId;
  });
});

// ── sc-5-5: scope isolation — facts in scope A NEVER surface for scope B ─────

describe("scope isolation — facts in scope A never surface for scope B (sc-5-5)", () => {
  it("store-level isolation: getActiveFacts('B') returns [] when only scope A written", async () => {
    const store = new FactStore(":memory:");
    const now = "2026-06-15T00:00:00.000Z";
    try {
      await writeFact(store, {
        scope: "A", subject: "project", predicate: "project/testCommand",
        value: "vitest", confidence: 1, sourceRunId: null, tValid: now, tCreated: now,
      }, { now });

      // Scope B should be completely isolated
      expect(store.getActiveFacts("B")).toEqual([]);
      // Scope A should see the fact
      expect(store.getActiveFacts("A")).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("retrieveRelevantFacts scoped to '' does not return facts written to 'A'", async () => {
    const now = "2026-06-15T00:00:00.000Z";
    const { ensureFactsDir, FactStore: FS2, factsDbPath } = await import("../../state/facts.js");
    await ensureFactsDir(tmpDir);
    const store2 = new FS2(factsDbPath(tmpDir));
    try {
      // Write to scope "A"
      await writeFact(store2, {
        scope: "A", subject: "project", predicate: "project/testCommand",
        value: "vitest", confidence: 1, sourceRunId: null, tValid: now, tCreated: now,
      }, { now });
      // Write to scope "" (default)
      await writeFact(store2, {
        scope: "", subject: "project", predicate: "project/buildCommand",
        value: "tsc", confidence: 1, sourceRunId: null, tValid: now, tCreated: now,
      }, { now });
    } finally {
      store2.close();
    }

    // Querying scope "" must NOT return scope "A" facts
    const resultsEmpty = await retrieveRelevantFacts(tmpDir, "", ["vitest", "tsc"]);
    const predicates = resultsEmpty.map((r) => r.predicate);
    expect(predicates).not.toContain("project/testCommand"); // scope "A" — must not appear
    expect(predicates).toContain("project/buildCommand");    // scope "" — must appear

    // Querying scope "A" must NOT return scope "" facts
    const resultsA = await retrieveRelevantFacts(tmpDir, "A", ["vitest", "tsc"]);
    const predicatesA = resultsA.map((r) => r.predicate);
    expect(predicatesA).toContain("project/testCommand");    // scope "A" — must appear
    expect(predicatesA).not.toContain("project/buildCommand"); // scope "" — must not appear
  });

  it("retrieveRelevantFacts returns [] for a scope that has no facts", async () => {
    const now = "2026-06-15T00:00:00.000Z";
    const { ensureFactsDir, FactStore: FS2, factsDbPath } = await import("../../state/facts.js");
    await ensureFactsDir(tmpDir);
    const store2 = new FS2(factsDbPath(tmpDir));
    try {
      await writeFact(store2, {
        scope: "A", subject: "project", predicate: "project/testCommand",
        value: "vitest", confidence: 1, sourceRunId: null, tValid: now, tCreated: now,
      }, { now });
    } finally {
      store2.close();
    }

    const results = await retrieveRelevantFacts(tmpDir, "B", ["vitest"]);
    expect(results).toEqual([]);
  });
});
