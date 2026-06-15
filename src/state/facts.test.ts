import { describe, it, expect, afterEach } from "vitest";
import { FactStore, factId } from "./facts.js";

// ── FactStore (in-memory) ─────────────────────────────────────────────

describe("FactStore (in-memory)", () => {
  let store: FactStore;

  afterEach(() => {
    store?.close();
  });

  it("insert -> getActiveFacts returns the row", () => {
    store = new FactStore(":memory:");
    const t = "2026-06-15T00:00:00.000Z";
    const rec = store.insertFact({
      scope: "programming",
      subject: "project",
      predicate: "testCommand",
      value: "vitest",
      confidence: 1,
      sourceRunId: null,
      tValid: t,
      tCreated: t,
    });
    const active = store.getActiveFacts("programming");
    expect(active).toHaveLength(1);
    expect(active[0].value).toBe("vitest");
    expect(rec.id).toBe(factId("programming", "project", "testCommand", "vitest", t));
  });

  it("invalidateFact removes from active but keeps it for getFact", () => {
    store = new FactStore(":memory:");
    const t = "2026-06-15T00:00:00.000Z";
    const { id } = store.insertFact({
      scope: "programming",
      subject: "project",
      predicate: "testCommand",
      value: "vitest",
      confidence: 1,
      sourceRunId: null,
      tValid: t,
      tCreated: t,
    });
    store.invalidateFact(id, "2026-06-16T00:00:00.000Z");
    expect(store.getActiveFacts("programming")).toHaveLength(0);
    expect(store.getFact(id)).not.toBeNull();
    expect(store.getFact(id)?.tInvalidated).toBe("2026-06-16T00:00:00.000Z");
  });

  it("ids are deterministic for identical (scope|subject|predicate|value|tCreated)", () => {
    const t = "2026-06-15T00:00:00.000Z";
    expect(factId("programming", "project", "testCommand", "vitest", t)).toBe(
      factId("programming", "project", "testCommand", "vitest", t),
    );
  });

  it("getActiveFacts filters by subject and predicate", () => {
    store = new FactStore(":memory:");
    const t = "2026-06-15T00:00:00.000Z";
    store.insertFact({
      scope: "programming",
      subject: "project",
      predicate: "testCommand",
      value: "vitest",
      confidence: 1,
      sourceRunId: null,
      tValid: t,
      tCreated: t,
    });
    store.insertFact({
      scope: "programming",
      subject: "other",
      predicate: "testCommand",
      value: "jest",
      confidence: 1,
      sourceRunId: null,
      tValid: t,
      tCreated: "2026-06-15T01:00:00.000Z",
    });
    const bySubject = store.getActiveFacts("programming", "project");
    expect(bySubject).toHaveLength(1);
    expect(bySubject[0].subject).toBe("project");
  });

  it("invalidateFact returns false for already-invalidated or unknown id", () => {
    store = new FactStore(":memory:");
    const t = "2026-06-15T00:00:00.000Z";
    const { id } = store.insertFact({
      scope: "programming",
      subject: "project",
      predicate: "testCommand",
      value: "vitest",
      confidence: 1,
      sourceRunId: null,
      tValid: t,
      tCreated: t,
    });
    store.invalidateFact(id, "2026-06-16T00:00:00.000Z");
    // Second invalidation on the same already-invalidated row → false
    expect(store.invalidateFact(id, "2026-06-17T00:00:00.000Z")).toBe(false);
    // Unknown id → false
    expect(store.invalidateFact("nonexistent-id-1234", "2026-06-17T00:00:00.000Z")).toBe(false);
  });
});
