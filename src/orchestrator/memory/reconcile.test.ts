import { describe, it, expect, afterEach } from "vitest";
import { FactStore, factId } from "../../state/facts.js";
import { reconcileFact, writeFact } from "./reconcile.js";
import type { FactJudge } from "./fact-judge.js";
import type { ReconcileAction } from "./reconcile.js";

// ── Helpers ───────────────────────────────────────────────────────────────

function makeInput(
  overrides: Partial<{
    scope: string;
    subject: string;
    predicate: string;
    value: string;
    confidence: number;
    tValid: string;
    tCreated: string;
  }> = {},
) {
  const t = "2026-06-15T00:00:00.000Z";
  return {
    scope: "programming",
    subject: "patient",
    predicate: "medication",
    value: "metformin",
    confidence: 1,
    sourceRunId: null as string | null,
    tValid: t,
    tCreated: t,
    ...overrides,
  };
}

// ── sc-2-3: Supersession (no judge) ──────────────────────────────────────

describe("reconcileFact — supersession (sc-2-3)", () => {
  let store: FactStore;

  afterEach(() => {
    store?.close();
  });

  it("writing a changed value supersedes the prior fact and returns 'update'", async () => {
    store = new FactStore(":memory:");
    const t1 = "2026-06-15T00:00:00.000Z";
    const t2 = "2026-06-16T00:00:00.000Z";

    // First write: metformin
    const action1 = await writeFact(
      store,
      makeInput({ value: "metformin", tValid: t1, tCreated: t1 }),
      { now: t1 },
    );
    expect(action1).toBe("add");

    // Second write: ozempic — same scope/subject/predicate, different value
    const action2 = await writeFact(
      store,
      makeInput({ value: "ozempic", tValid: t2, tCreated: t2 }),
      { now: t2 },
    );
    expect(action2).toBe("update");

    // Only the new value is active
    const active = store.getActiveFacts("programming", "patient", "medication");
    expect(active).toHaveLength(1);
    expect(active[0].value).toBe("ozempic");

    // Superseded metformin row persists with BOTH temporal fields
    const oldId = factId("programming", "patient", "medication", "metformin", t1);
    const old = store.getFact(oldId);
    expect(old).not.toBeNull();
    expect(old?.tInvalidated).toBe(t2); // record-time
    expect(old?.tInvalid).toBe(t2);     // world-time end = incoming tValid

    // Confidence on supersede carries the INCOMING value's confidence (not old)
    expect(active[0].confidence).toBe(1);
  });

  it("superseded row carries the incoming fact's confidence, not the old one", async () => {
    store = new FactStore(":memory:");
    const t1 = "2026-06-15T00:00:00.000Z";
    const t2 = "2026-06-16T00:00:00.000Z";

    await writeFact(
      store,
      makeInput({ value: "metformin", confidence: 0.8, tValid: t1, tCreated: t1 }),
      { now: t1 },
    );

    await writeFact(
      store,
      makeInput({ value: "ozempic", confidence: 0.9, tValid: t2, tCreated: t2 }),
      { now: t2 },
    );

    const active = store.getActiveFacts("programming", "patient", "medication");
    expect(active[0].confidence).toBe(0.9);
  });

  it("an inactive prior fact with the same value still ADDs (only active facts gate NOOP)", async () => {
    store = new FactStore(":memory:");
    const t1 = "2026-06-15T00:00:00.000Z";
    const t2 = "2026-06-16T00:00:00.000Z";
    const t3 = "2026-06-17T00:00:00.000Z";

    // Insert metformin
    await writeFact(
      store,
      makeInput({ value: "metformin", tValid: t1, tCreated: t1 }),
      { now: t1 },
    );
    // Supersede it with ozempic
    await writeFact(
      store,
      makeInput({ value: "ozempic", tValid: t2, tCreated: t2 }),
      { now: t2 },
    );
    // Now write metformin again — the old metformin row is INACTIVE, should ADD
    const action = await writeFact(
      store,
      makeInput({ value: "metformin", tValid: t3, tCreated: t3 }),
      { now: t3 },
    );
    expect(action).toBe("update"); // supersedes the active ozempic row
    const active = store.getActiveFacts("programming", "patient", "medication");
    expect(active).toHaveLength(1);
    expect(active[0].value).toBe("metformin");
  });
});

// ── sc-2-4: NOOP (no judge) ───────────────────────────────────────────────

describe("reconcileFact — NOOP (sc-2-4)", () => {
  let store: FactStore;

  afterEach(() => {
    store?.close();
  });

  it("writing the identical value twice returns 'noop' the second time", async () => {
    store = new FactStore(":memory:");
    const t1 = "2026-06-15T00:00:00.000Z";
    const t2 = "2026-06-16T00:00:00.000Z";

    const action1 = await reconcileFact(
      store,
      makeInput({ value: "metformin", tValid: t1, tCreated: t1 }),
      { now: t1 },
    );
    expect(action1).toBe("add");

    // Same value, different timestamp (but same scope/subject/predicate/value)
    const action2 = await reconcileFact(
      store,
      makeInput({ value: "metformin", tValid: t2, tCreated: t2 }),
      { now: t2 },
    );
    expect(action2).toBe("noop");

    // Only one active row — no duplicate
    const active = store.getActiveFacts("programming", "patient", "medication");
    expect(active).toHaveLength(1);
    expect(active[0].value).toBe("metformin");
  });

  it("NOOP creates no second row", async () => {
    store = new FactStore(":memory:");
    const t = "2026-06-15T00:00:00.000Z";

    await reconcileFact(store, makeInput({ tValid: t, tCreated: t }), { now: t });
    await reconcileFact(store, makeInput({ tValid: t, tCreated: t }), { now: t });

    const all = store.getActiveFacts("programming");
    expect(all).toHaveLength(1);
  });
});

// ── sc-2-6: Stub FactJudge + no-judge ADD fallback ───────────────────────

describe("reconcileFact — ambiguity / FactJudge (sc-2-6)", () => {
  let store: FactStore;

  afterEach(() => {
    store?.close();
  });

  it("stub judge returning 'update' supersedes the candidate", async () => {
    store = new FactStore(":memory:");
    const t1 = "2026-06-15T00:00:00.000Z";
    const t2 = "2026-06-16T00:00:00.000Z";

    // Insert a fact with predicate "medication"
    await writeFact(
      store,
      makeInput({ subject: "patient", predicate: "medication", value: "metformin", tValid: t1, tCreated: t1 }),
      { now: t1 },
    );

    // Incoming has normalized-equal predicate "Medication!" (same after stripping)
    // but different value — no exact match, but ambiguity collision
    const stubJudge: FactJudge = {
      async resolve(): Promise<ReconcileAction> {
        return "update";
      },
    };

    const action = await reconcileFact(
      store,
      makeInput({ subject: "patient", predicate: "Medication!", value: "ozempic", tValid: t2, tCreated: t2 }),
      { judge: stubJudge, now: t2 },
    );

    expect(action).toBe("update");

    // Only the new fact is active
    const active = store.getActiveFacts("programming", "patient");
    expect(active).toHaveLength(1);
    expect(active[0].value).toBe("ozempic");
  });

  it("no judge on ambiguity collision falls back to deterministic ADD", async () => {
    store = new FactStore(":memory:");
    const t1 = "2026-06-15T00:00:00.000Z";
    const t2 = "2026-06-16T00:00:00.000Z";

    // Insert fact with predicate "medication"
    await writeFact(
      store,
      makeInput({ subject: "patient", predicate: "medication", value: "metformin", tValid: t1, tCreated: t1 }),
      { now: t1 },
    );

    // Same ambiguous incoming, but NO judge
    const action = await reconcileFact(
      store,
      makeInput({ subject: "patient", predicate: "Medication!", value: "ozempic", tValid: t2, tCreated: t2 }),
      { now: t2 }, // no judge
    );

    // Deterministic ADD: both facts coexist as active
    expect(action).toBe("add");

    const active = store.getActiveFacts("programming", "patient");
    expect(active).toHaveLength(2);
  });

  it("stub judge returning 'noop' keeps the candidate and discards incoming", async () => {
    store = new FactStore(":memory:");
    const t1 = "2026-06-15T00:00:00.000Z";
    const t2 = "2026-06-16T00:00:00.000Z";

    await writeFact(
      store,
      makeInput({ predicate: "medication", value: "metformin", tValid: t1, tCreated: t1 }),
      { now: t1 },
    );

    const noopJudge: FactJudge = {
      async resolve(): Promise<ReconcileAction> {
        return "noop";
      },
    };

    const action = await reconcileFact(
      store,
      makeInput({ predicate: "Medication!", value: "ozempic", tValid: t2, tCreated: t2 }),
      { judge: noopJudge, now: t2 },
    );

    expect(action).toBe("noop");
    const active = store.getActiveFacts("programming", "patient");
    expect(active).toHaveLength(1);
    expect(active[0].value).toBe("metformin");
  });

  it("stub judge returning 'delete' invalidates candidate without inserting incoming", async () => {
    store = new FactStore(":memory:");
    const t1 = "2026-06-15T00:00:00.000Z";
    const t2 = "2026-06-16T00:00:00.000Z";

    const inserted = await writeFact(
      store,
      makeInput({ predicate: "medication", value: "metformin", tValid: t1, tCreated: t1 }),
      { now: t1 },
    );
    expect(inserted).toBe("add");

    const deleteJudge: FactJudge = {
      async resolve(): Promise<ReconcileAction> {
        return "delete";
      },
    };

    const action = await reconcileFact(
      store,
      makeInput({ predicate: "Medication!", value: "ozempic", tValid: t2, tCreated: t2 }),
      { judge: deleteJudge, now: t2 },
    );

    expect(action).toBe("delete");
    const active = store.getActiveFacts("programming", "patient");
    expect(active).toHaveLength(0);
  });

  it("stub judge returning 'add' inserts incoming alongside candidate", async () => {
    store = new FactStore(":memory:");
    const t1 = "2026-06-15T00:00:00.000Z";
    const t2 = "2026-06-16T00:00:00.000Z";

    await writeFact(
      store,
      makeInput({ predicate: "medication", value: "metformin", tValid: t1, tCreated: t1 }),
      { now: t1 },
    );

    const addJudge: FactJudge = {
      async resolve(): Promise<ReconcileAction> {
        return "add";
      },
    };

    const action = await reconcileFact(
      store,
      makeInput({ predicate: "Medication!", value: "ozempic", tValid: t2, tCreated: t2 }),
      { judge: addJudge, now: t2 },
    );

    expect(action).toBe("add");
    const active = store.getActiveFacts("programming", "patient");
    expect(active).toHaveLength(2);
  });
});

// ── Purity assertions ─────────────────────────────────────────────────────

describe("reconcile.ts purity assertions", () => {
  async function readSourceNoComments(): Promise<string> {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      new URL("./reconcile.ts", import.meta.url),
      "utf-8",
    );
    // Strip single-line and JSDoc comment lines (mirrors distill.test.ts:292-307)
    return source
      .split("\n")
      .filter(
        (line) =>
          !line.trimStart().startsWith("//") &&
          !line.trimStart().startsWith("*"),
      )
      .join("\n");
  }

  it("source does not CALL Date.now() or new Date() (comments allowed)", async () => {
    const code = await readSourceNoComments();
    expect(code).not.toMatch(/Date\.now\(\)/);
    expect(code).not.toMatch(/new Date\(\)/);
  });

  it("source does not CALL createClient or fetch (comments allowed)", async () => {
    const code = await readSourceNoComments();
    expect(code).not.toMatch(/createClient/);
    expect(code).not.toMatch(/\bfetch\(/);
  });
});
