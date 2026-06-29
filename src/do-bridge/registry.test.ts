import { describe, it, expect } from "vitest";
import { PromoterRegistry } from "./registry.js";
import type { Promoter } from "./types.js";
import type { Finding } from "../hub/finding.js";

const T = "2026-06-28T00:00:00.000Z";

const CODING_FINDING: Finding = {
  id: "abc123def456abc1",
  domain: "coding",
  title: "fix the CI build",
  kind: "action",
  urgency: 3,
  severity: 2,
  evidence: [],
  surfacedAt: T,
  tags: [],
  status: "open",
};

// Two distinct promoter functions for testing precedence
const domainOnlyPromoter: Promoter = (_f) => ({
  kind: "bober-run",
  task: "domain-only promoter",
});

const specificPromoter: Promoter = (_f) => ({
  kind: "bober-run",
  task: "domain+kind specific promoter",
});

describe("PromoterRegistry — sc-1-2 resolution precedence", () => {
  it("domain+kind match beats domain-only when both are registered", () => {
    const registry = new PromoterRegistry();
    registry.register({ domain: "coding" }, domainOnlyPromoter);
    registry.register({ domain: "coding", kind: "action" }, specificPromoter);

    const resolved = registry.resolve({ domain: "coding", kind: "action" });
    expect(resolved).toBe(specificPromoter);
  });

  it("falls back to domain-only promoter when kind has no specific registration", () => {
    const registry = new PromoterRegistry();
    registry.register({ domain: "coding" }, domainOnlyPromoter);
    registry.register({ domain: "coding", kind: "action" }, specificPromoter);

    const resolved = registry.resolve({ domain: "coding", kind: "watch" });
    expect(resolved).toBe(domainOnlyPromoter);
  });

  it("domain-only key resolves when no kind is specified", () => {
    const registry = new PromoterRegistry();
    registry.register({ domain: "coding" }, domainOnlyPromoter);

    const resolved = registry.resolve({ domain: "coding" });
    expect(resolved).toBe(domainOnlyPromoter);
  });

  it("returns undefined for an unregistered domain — sc-1-5", () => {
    const registry = new PromoterRegistry();
    registry.register({ domain: "coding" }, domainOnlyPromoter);

    const resolved = registry.resolve({ domain: "medical" });
    expect(resolved).toBeUndefined();
  });

  it("returns undefined for empty registry", () => {
    const registry = new PromoterRegistry();
    expect(registry.resolve({ domain: "coding", kind: "action" })).toBeUndefined();
  });

  it("domain-only key does not bleed into unrelated domains", () => {
    const registry = new PromoterRegistry();
    registry.register({ domain: "coding" }, domainOnlyPromoter);

    // 'project' is different from 'coding'
    expect(registry.resolve({ domain: "projects" })).toBeUndefined();
  });

  it("resolve accepts a finding-shaped key extracted from a Finding", () => {
    const registry = new PromoterRegistry();
    registry.register({ domain: "coding" }, domainOnlyPromoter);

    // Simulate what do.ts does: resolve({ domain: finding.domain, kind: finding.kind })
    const resolved = registry.resolve({
      domain: CODING_FINDING.domain,
      kind: CODING_FINDING.kind,
    });
    expect(resolved).toBe(domainOnlyPromoter);
  });
});

// ── sc-3-4: second stub promoter extensibility ────────────────────────

describe("PromoterRegistry — sc-3-4: second stub promoter and fail-closed", () => {
  // A NON-FUNCTIONAL stub — exists ONLY to prove the registry accepts a new
  // PromoterKey {domain:'projects', kind:'action'}. Not intended for real use.
  const projectsActionStub: Promoter = (_f) => ({
    kind: "bober-run",
    task: "STUB — not functional",
  });

  it("a second promoter under {domain:'projects', kind:'action'} resolves", () => {
    const registry = new PromoterRegistry();
    registry.register({ domain: "coding" }, domainOnlyPromoter);
    registry.register({ domain: "projects", kind: "action" }, projectsActionStub);
    expect(registry.resolve({ domain: "projects", kind: "action" })).toBe(projectsActionStub);
  });

  it("an unregistered (domain,kind) fails closed — returns undefined", () => {
    const registry = new PromoterRegistry();
    registry.register({ domain: "coding" }, domainOnlyPromoter);
    registry.register({ domain: "projects", kind: "action" }, projectsActionStub);
    expect(registry.resolve({ domain: "financial", kind: "action" })).toBeUndefined();
  });

  it("second stub under projects/action does not shadow domain-only projects promoter for other kinds", () => {
    const registry = new PromoterRegistry();
    registry.register({ domain: "projects" }, domainOnlyPromoter);
    registry.register({ domain: "projects", kind: "action" }, projectsActionStub);
    // 'watch' kind should fall back to the domain-only promoter
    expect(registry.resolve({ domain: "projects", kind: "watch" })).toBe(domainOnlyPromoter);
  });
});
