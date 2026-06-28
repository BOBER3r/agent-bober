import { describe, it, expect } from "vitest";
import { FactStore } from "../state/facts.js";
import { FactStoreFindingSource, HUB_SCOPE } from "./finding-source.js";

// ── Fixtures ─────────────────────────────────────────────────────────

const T = "2026-06-28T00:00:00.000Z";

const VALID_FINDING = {
  id: "f-001",
  domain: "medical",
  title: "Review cholesterol levels",
  kind: "action" as const,
  urgency: 3,
  severity: 4,
  evidence: ["Lab result 2026-06-28"],
  surfacedAt: T,
  tags: ["cholesterol"],
  status: "open" as const,
};

function seedFact(
  store: FactStore,
  subject: string,
  value: string,
): void {
  store.insertFact({
    scope: HUB_SCOPE,
    subject,
    predicate: "finding",
    value,
    confidence: 1,
    sourceRunId: null,
    tValid: T,
    tCreated: T,
  });
}

// ── Tests: sc-1-3 ────────────────────────────────────────────────────

describe("FactStoreFindingSource", () => {
  it("returns a validated Finding from a well-formed row", () => {
    const store = new FactStore(":memory:");
    seedFact(store, "f-001", JSON.stringify(VALID_FINDING));
    const results = new FactStoreFindingSource(store, HUB_SCOPE).read();
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("f-001");
    store.close();
  });

  it("skips a row with malformed JSON without throwing (sc-1-3)", () => {
    const store = new FactStore(":memory:");
    seedFact(store, "f-good", JSON.stringify(VALID_FINDING));
    seedFact(store, "f-bad", "{not valid json");
    const results = new FactStoreFindingSource(store, HUB_SCOPE).read();
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("f-001");
    store.close();
  });

  it("skips a schema-invalid row (urgency 6) without throwing", () => {
    const store = new FactStore(":memory:");
    seedFact(store, "f-good", JSON.stringify(VALID_FINDING));
    seedFact(store, "f-invalid", JSON.stringify({ ...VALID_FINDING, id: "f-bad", urgency: 6 }));
    const results = new FactStoreFindingSource(store, HUB_SCOPE).read();
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("f-001");
    store.close();
  });

  it("returns empty array when no finding rows exist", () => {
    const store = new FactStore(":memory:");
    const results = new FactStoreFindingSource(store, HUB_SCOPE).read();
    expect(results).toHaveLength(0);
    store.close();
  });

  it("does not cross-read findings from a different scope", () => {
    const store = new FactStore(":memory:");
    // Insert in a different scope
    store.insertFact({
      scope: "other-scope",
      subject: "f-other",
      predicate: "finding",
      value: JSON.stringify(VALID_FINDING),
      confidence: 1,
      sourceRunId: null,
      tValid: T,
      tCreated: T,
    });
    const results = new FactStoreFindingSource(store, HUB_SCOPE).read();
    expect(results).toHaveLength(0);
    store.close();
  });

  it("returns multiple valid findings when multiple rows exist", () => {
    const store = new FactStore(":memory:");
    const f2 = { ...VALID_FINDING, id: "f-002", title: "Second finding" };
    seedFact(store, "f-001", JSON.stringify(VALID_FINDING));
    seedFact(store, "f-002", JSON.stringify(f2));
    const results = new FactStoreFindingSource(store, HUB_SCOPE).read();
    expect(results).toHaveLength(2);
    store.close();
  });
});
