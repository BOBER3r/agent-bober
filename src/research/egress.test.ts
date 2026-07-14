/**
 * Tests for src/research/egress.ts — ResearchEgressGuard (sc-3-1, sc-3-2).
 */

import { describe, it, expect } from "vitest";
import { ResearchEgressGuard } from "./egress.js";
import type { BoberConfig } from "../config/schema.js";

// ── sc-3-1: isAllowed defaults false ─────────────────────────────────

describe("ResearchEgressGuard — online-research axis default false (sc-3-1)", () => {
  it("isAllowed false when research section absent from config", () => {
    const g = ResearchEgressGuard.fromConfig({} as BoberConfig);
    expect(g.isAllowed("online-research")).toBe(false);
  });

  it("isAllowed false when research section present but egress absent", () => {
    const g = ResearchEgressGuard.fromConfig({ research: {} } as BoberConfig);
    expect(g.isAllowed("online-research")).toBe(false);
  });

  it("isAllowed false when onlineResearch is explicitly false", () => {
    const g = ResearchEgressGuard.fromConfig({
      research: { egress: { onlineResearch: false } },
    } as unknown as BoberConfig);
    expect(g.isAllowed("online-research")).toBe(false);
  });

  it("isAllowed true when onlineResearch is explicitly true", () => {
    const g = ResearchEgressGuard.fromConfig({
      research: { egress: { onlineResearch: true } },
    } as unknown as BoberConfig);
    expect(g.isAllowed("online-research")).toBe(true);
  });
});

// ── sc-3-2: assertAllowed throw semantics ─────────────────────────────

describe("ResearchEgressGuard — assertAllowed throw semantics (sc-3-2)", () => {
  it("assertAllowed throws exact message when axis is off (config absent)", () => {
    const g = ResearchEgressGuard.fromConfig({} as BoberConfig);
    expect(() => g.assertAllowed("online-research"))
      .toThrow("Egress axis 'online-research' not enabled");
  });

  it("assertAllowed throws exact message when axis is explicitly false", () => {
    const g = ResearchEgressGuard.fromConfig({
      research: { egress: { onlineResearch: false } },
    } as unknown as BoberConfig);
    expect(() => g.assertAllowed("online-research"))
      .toThrow("Egress axis 'online-research' not enabled");
  });

  it("assertAllowed is silent (does not throw) when axis is on", () => {
    const g = ResearchEgressGuard.fromConfig({
      research: { egress: { onlineResearch: true } },
    } as unknown as BoberConfig);
    expect(() => g.assertAllowed("online-research")).not.toThrow();
  });

  it("new ResearchEgressGuard(false).assertAllowed throws", () => {
    const g = new ResearchEgressGuard(false);
    expect(() => g.assertAllowed("online-research"))
      .toThrow("Egress axis 'online-research' not enabled");
  });

  it("new ResearchEgressGuard(true).assertAllowed does not throw", () => {
    const g = new ResearchEgressGuard(true);
    expect(() => g.assertAllowed("online-research")).not.toThrow();
  });
});
