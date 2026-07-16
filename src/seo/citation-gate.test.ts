import { describe, it, expect } from "vitest";
import type { SeoFinding } from "./types.js";
import { SeoCitationGate } from "./citation-gate.js";

function makeFinding(overrides: Partial<SeoFinding> = {}): SeoFinding {
  return {
    recommendation: "Fix duplicate title tags on category pages.",
    workflow: "technical-audit",
    playbookRef: "seo.technical-audit.title-tags",
    citationUrl: "https://developers.google.com/search/docs/appearance/title-link",
    evidence: [],
    severity: 3,
    humanApprovalRequired: false,
    confidence: "firm",
    ...overrides,
  };
}

describe("SeoCitationGate.apply — citation partitioning (sc-10-3)", () => {
  const gate = new SeoCitationGate();

  it("keeps a finding with a well-formed https citationUrl in cited", () => {
    const finding = makeFinding({ citationUrl: "https://example.com/docs" });
    const result = gate.apply([finding], "never");
    expect(result.cited).toEqual([finding]);
    expect(result.dropped).toEqual([]);
  });

  it("drops a finding with an empty citationUrl (stopCondition)", () => {
    const finding = makeFinding({ citationUrl: "" });
    const result = gate.apply([finding], "never");
    expect(result.dropped).toEqual([finding]);
    expect(result.cited).toEqual([]);
  });

  it.each(["not a url", "ftp://example.com/x", "   ", "x", "javascript:alert(1)"])(
    "drops a finding with a malformed citationUrl: %j",
    (bad) => {
      const finding = makeFinding({ citationUrl: bad });
      const result = gate.apply([finding], "never");
      expect(result.dropped).toEqual([finding]);
      expect(result.cited).toEqual([]);
    },
  );
});

describe("SeoCitationGate.apply — blocking thresholds (sc-10-3)", () => {
  const gate = new SeoCitationGate();

  it("threshold 'never' never blocks, even with dropped findings", () => {
    const dropped = makeFinding({ citationUrl: "", severity: 5 });
    expect(gate.apply([dropped], "never").blocked).toBe(false);
  });

  it("threshold 'any-uncited' blocks when any finding is dropped, else false", () => {
    const cited = makeFinding({ citationUrl: "https://example.com" });
    const dropped = makeFinding({ citationUrl: "" });
    expect(gate.apply([cited], "any-uncited").blocked).toBe(false);
    expect(gate.apply([cited, dropped], "any-uncited").blocked).toBe(true);
  });

  it("threshold 'critical-uncited' blocks only when a dropped finding has severity >= 4", () => {
    const lowSeverityDropped = makeFinding({ citationUrl: "", severity: 2 });
    const highSeverityDropped = makeFinding({ citationUrl: "", severity: 4 });
    expect(gate.apply([lowSeverityDropped], "critical-uncited").blocked).toBe(false);
    expect(gate.apply([highSeverityDropped], "critical-uncited").blocked).toBe(true);
  });

  it("threshold 'critical-uncited' does not block on a well-cited critical finding", () => {
    const citedCritical = makeFinding({ citationUrl: "https://example.com", severity: 5 });
    expect(gate.apply([citedCritical], "critical-uncited").blocked).toBe(false);
  });
});

describe("SeoCitationGate — purity and offline discipline", () => {
  const gate = new SeoCitationGate();

  it("is deterministic: repeated calls with the same input yield the same partition", () => {
    const findings = [
      makeFinding({ citationUrl: "" }),
      makeFinding({ citationUrl: "https://example.com" }),
    ];
    const first = gate.apply(findings, "any-uncited");
    const second = gate.apply(findings, "any-uncited");
    expect(first).toEqual(second);
  });

  it("does not mutate the input findings array or its elements", () => {
    const findings = [makeFinding({ citationUrl: "" })];
    const snapshot = JSON.parse(JSON.stringify(findings));
    gate.apply(findings, "any-uncited");
    expect(findings).toEqual(snapshot);
  });

  it("'filter' is an alias that returns the same result as 'apply'", () => {
    const findings = [
      makeFinding({ citationUrl: "" }),
      makeFinding({ citationUrl: "https://example.com" }),
    ];
    expect(gate.filter(findings, "critical-uncited")).toEqual(gate.apply(findings, "critical-uncited"));
  });
});
