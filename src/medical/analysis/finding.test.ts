import { describe, it, expect } from "vitest";

import { findingId, serializeFindingToMarkdown } from "./finding.js";
import type { MedicalFinding } from "./finding.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

const NOW = "2026-06-28T12:00:00.000Z";

function makeFinding(overrides: Partial<MedicalFinding> = {}): MedicalFinding {
  return {
    id: findingId("medical", "ldl", "rule-a-high"),
    domain: "medical",
    title: "ldl: above reference range",
    kind: "watch",
    urgency: 3,
    severity: 3,
    evidence: ["ldl = 160 mg/dL (ref: ≤130 mg/dL)"],
    surfacedAt: NOW,
    tags: ["lab-trend", "ldl"],
    status: "open",
    ...overrides,
  };
}

// ── findingId ─────────────────────────────────────────────────────────────

describe("findingId", () => {
  it("returns a 16-character lowercase hex string", () => {
    const id = findingId("medical", "ldl", "rule-a-high");
    expect(id).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(id)).toBe(true);
  });

  it("is deterministic — identical inputs produce the same id", () => {
    const id1 = findingId("medical", "ldl", "rule-a-high");
    const id2 = findingId("medical", "ldl", "rule-a-high");
    expect(id1).toBe(id2);
  });

  it("produces different ids for different biomarkers", () => {
    const id1 = findingId("medical", "ldl", "rule-a-high");
    const id2 = findingId("medical", "cholesterol", "rule-a-high");
    expect(id1).not.toBe(id2);
  });

  it("produces different ids for different ruleKeys", () => {
    const id1 = findingId("medical", "ldl", "rule-a-high");
    const id2 = findingId("medical", "ldl", "rule-a-low");
    expect(id1).not.toBe(id2);
  });
});

// ── serializeFindingToMarkdown ────────────────────────────────────────────

describe("serializeFindingToMarkdown", () => {
  it("starts with the YAML frontmatter opening fence", () => {
    const md = serializeFindingToMarkdown(makeFinding());
    expect(md.startsWith("---\n")).toBe(true);
  });

  it("includes required key: id", () => {
    const finding = makeFinding();
    const md = serializeFindingToMarkdown(finding);
    expect(md).toContain(`id: ${finding.id}`);
  });

  it("includes required key: domain with value 'medical'", () => {
    const md = serializeFindingToMarkdown(makeFinding());
    expect(md).toContain("domain: medical");
  });

  it("includes required key: kind", () => {
    const md = serializeFindingToMarkdown(makeFinding({ kind: "risk" }));
    expect(md).toContain("kind: risk");
  });

  it("includes required key: urgency", () => {
    const md = serializeFindingToMarkdown(makeFinding({ urgency: 4 }));
    expect(md).toContain("urgency: 4");
  });

  it("includes required key: severity", () => {
    const md = serializeFindingToMarkdown(makeFinding({ severity: 4 }));
    expect(md).toContain("severity: 4");
  });

  it("includes required key: status", () => {
    const md = serializeFindingToMarkdown(makeFinding({ status: "open" }));
    expect(md).toContain("status: open");
  });

  it("sc-1-6: surfacedAt equals the injected ISO timestamp (never wall-clock)", () => {
    const injectedNow = "2026-06-28T12:00:00.000Z";
    const md = serializeFindingToMarkdown(makeFinding({ surfacedAt: injectedNow }));
    expect(md).toContain(`surfacedAt: ${injectedNow}`);
  });

  it("serializes evidence[] as a YAML block list", () => {
    const md = serializeFindingToMarkdown(
      makeFinding({ evidence: ["ldl = 160 mg/dL", "ref: ≤130 mg/dL"] }),
    );
    expect(md).toContain("evidence:");
    expect(md).toContain("  - ldl = 160 mg/dL");
    expect(md).toContain("  - ref: ≤130 mg/dL");
  });

  it("serializes tags[] as a YAML block list", () => {
    const md = serializeFindingToMarkdown(
      makeFinding({ tags: ["lab-trend", "ldl"] }),
    );
    expect(md).toContain("tags:");
    expect(md).toContain("  - lab-trend");
    expect(md).toContain("  - ldl");
  });

  it("includes optional dueBy when present", () => {
    const md = serializeFindingToMarkdown(
      makeFinding({ dueBy: "2026-07-01T00:00:00.000Z" }),
    );
    expect(md).toContain("dueBy: 2026-07-01T00:00:00.000Z");
  });

  it("omits optional dueBy when absent", () => {
    const md = serializeFindingToMarkdown(makeFinding());
    expect(md).not.toContain("dueBy");
  });
});
