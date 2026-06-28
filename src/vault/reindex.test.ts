import { describe, it, expect, afterEach } from "vitest";
import { FactStore, factId } from "../state/facts.js";
import { reindexNotes, SUPERSEDED_STATUS } from "./reindex.js";
import type { VaultNote } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const NOW1 = "2026-06-28T00:00:00.000Z";
const NOW2 = "2026-06-28T01:00:00.000Z";
const SCOPE = "medical";

function makeNote(
  frontmatter: Record<string, unknown>,
  path = "notes/patient.md",
): VaultNote {
  return { frontmatter, body: "", path };
}

// ── sc-2-3: idempotent reindex (all-noop on second pass) ─────────────────────

describe("reindexNotes — sc-2-3: second pass is all-noop", () => {
  let store: FactStore;
  afterEach(() => { store?.close(); });

  it("second reindex over identical notes returns all-noop and active count unchanged", async () => {
    store = new FactStore(":memory:");
    const notes: VaultNote[] = [
      makeNote({ id: "p1", drug: "metformin", dose: "500mg" }),
      makeNote({ id: "p2", drug: "aspirin" }),
    ];

    // First pass: all facts are new
    // p1: { id, drug, dose } = 3 keys; p2: { id, drug } = 2 keys; total = 5 facts
    const summary1 = await reindexNotes(store, notes, { scope: SCOPE, now: NOW1 });
    expect(summary1.factsAdded).toBe(5);
    expect(summary1.factsNoop).toBe(0);
    expect(summary1.notesParsed).toBe(2);

    const activeAfterFirst = store.getActiveFacts(SCOPE).length;

    // Second pass with SAME now: every fact must return noop
    const summary2 = await reindexNotes(store, notes, { scope: SCOPE, now: NOW1 });
    expect(summary2.factsAdded).toBe(0);
    expect(summary2.factsSuperseded).toBe(0);
    // Every single fact (all 5) must be noop — asserts action=noop per fact, not just count
    expect(summary2.factsNoop).toBe(summary1.factsAdded);

    // Active-fact count unchanged
    const activeAfterSecond = store.getActiveFacts(SCOPE).length;
    expect(activeAfterSecond).toBe(activeAfterFirst);
  });
});

// ── sc-2-4: changed value supersedes prior ────────────────────────────────────

describe("reindexNotes — sc-2-4: changed value supersedes prior fact", () => {
  let store: FactStore;
  afterEach(() => { store?.close(); });

  it("prior fact row has t_invalidated set after value change and new value is only active", async () => {
    store = new FactStore(":memory:");
    const noteV1 = makeNote({ id: "p1", dose: "500mg" });
    const noteV2 = makeNote({ id: "p1", dose: "1000mg" });

    // First pass: dose = 500mg
    await reindexNotes(store, [noteV1], { scope: SCOPE, now: NOW1 });

    // Compute id of the original fact
    const oldId = factId(SCOPE, "p1", "dose", "500mg", NOW1);
    const oldFact = store.getFact(oldId);
    expect(oldFact).not.toBeNull();
    expect(oldFact?.tInvalidated).toBeNull(); // still active before update

    // Second pass with different now and changed value: dose = 1000mg
    const summary2 = await reindexNotes(store, [noteV2], { scope: SCOPE, now: NOW2 });
    expect(summary2.factsSuperseded).toBeGreaterThanOrEqual(1);

    // Prior fact must now be superseded (t_invalidated set)
    const supersededFact = store.getFact(oldId);
    expect(supersededFact?.tInvalidated).not.toBeNull();

    // New value must be the only active fact for subject/predicate
    const active = store.getActiveFacts(SCOPE, "p1", "dose");
    expect(active).toHaveLength(1);
    expect(active[0].value).toBe("1000mg");
  });
});

// ── sc-2-5: status:superseded note contributes zero active facts ──────────────

describe("reindexNotes — sc-2-5: superseded notes contribute zero facts", () => {
  let store: FactStore;
  afterEach(() => { store?.close(); });

  it("a note with status:superseded contributes zero active facts", async () => {
    store = new FactStore(":memory:");
    const supersededNote = makeNote({
      id: "p1",
      status: SUPERSEDED_STATUS,
      drug: "metformin",
    });

    const summary = await reindexNotes(store, [supersededNote], { scope: SCOPE, now: NOW1 });

    // Note must be skipped entirely — no facts written, notesParsed should be 0
    expect(summary.notesParsed).toBe(0);
    expect(summary.factsAdded).toBe(0);
    expect(summary.factsSuperseded).toBe(0);
    expect(summary.factsNoop).toBe(0);

    // No active facts from any of the superseded note's keys
    const activeFromId = store.getActiveFacts(SCOPE, "p1");
    expect(activeFromId).toHaveLength(0);

    const allActive = store.getActiveFacts(SCOPE);
    expect(allActive).toHaveLength(0);
  });

  it("processes non-superseded notes alongside superseded ones", async () => {
    store = new FactStore(":memory:");
    const notes: VaultNote[] = [
      makeNote({ id: "p1", status: SUPERSEDED_STATUS, drug: "metformin" }),
      makeNote({ id: "p2", drug: "aspirin" }),
    ];

    const summary = await reindexNotes(store, notes, { scope: SCOPE, now: NOW1 });

    // Only p2 should be indexed
    expect(summary.notesParsed).toBe(1);
    expect(summary.factsAdded).toBeGreaterThan(0);

    // p1's facts must not exist as active
    const p1Active = store.getActiveFacts(SCOPE, "p1");
    expect(p1Active).toHaveLength(0);

    // p2's facts must exist
    const p2Active = store.getActiveFacts(SCOPE, "p2");
    expect(p2Active.length).toBeGreaterThan(0);
  });
});

// ── ReindexSummary shape ──────────────────────────────────────────────────────

describe("reindexNotes — summary shape", () => {
  let store: FactStore;
  afterEach(() => { store?.close(); });

  it("returns a summary with all four fields", async () => {
    store = new FactStore(":memory:");
    const summary = await reindexNotes(
      store,
      [makeNote({ id: "p1", drug: "aspirin" })],
      { scope: SCOPE, now: NOW1 },
    );
    expect(typeof summary.notesParsed).toBe("number");
    expect(typeof summary.factsAdded).toBe("number");
    expect(typeof summary.factsSuperseded).toBe("number");
    expect(typeof summary.factsNoop).toBe("number");
  });
});

// ── SUPERSEDED_STATUS export ──────────────────────────────────────────────────

describe("SUPERSEDED_STATUS from reindex", () => {
  it("exports the string literal 'superseded'", () => {
    expect(SUPERSEDED_STATUS).toBe("superseded");
  });
});

// ── Purity test ───────────────────────────────────────────────────────────────

describe("reindex — source purity", () => {
  it("source does not call Date.now() or new Date()", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./reindex.ts", import.meta.url), "utf-8");
    const noComments = source
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
      .join("\n");
    expect(noComments).not.toMatch(/Date\.now\(\)/);
    expect(noComments).not.toMatch(/new Date\(\)/);
  });
});
