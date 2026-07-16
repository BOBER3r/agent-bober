/**
 * Tests for `SeoHubEmitter` (spec-20260715-ultimate-seo-suite, Sprint 11, sc-11-4/sc-11-5).
 */
import { describe, it, expect, vi } from "vitest";

import { SeoHubEmitter } from "./hub-emitter.js";
import type { SeoFindingSink } from "./hub-emitter.js";
import { FindingSchema } from "../hub/finding.js";
import type { Finding } from "../hub/finding.js";
import type { SeoAnalysis } from "./analyzer.js";
import type { SeoFinding } from "./types.js";
import { logger } from "../utils/logger.js";

function makeSeoFinding(overrides: Partial<SeoFinding> = {}): SeoFinding {
  return {
    recommendation: "De-duplicate the title tag shared by /a and /b.",
    workflow: "technical-audit",
    playbookRef: "seo.technical-audit.title-tags",
    citationUrl: "https://developers.google.com/search/docs/appearance/title-link",
    evidence: [{ metric: "coverageState", value: "Indexed", source: "url-inspection", url: "https://example.com/a" }],
    severity: 3,
    humanApprovalRequired: false,
    confidence: "firm",
    ...overrides,
  };
}

function makeAnalysis(findings: SeoFinding[]): SeoAnalysis {
  return {
    workflow: "technical-audit",
    target: "example.com",
    findings,
    parsed: true,
    dataProvenance: [],
  };
}

const NOW = "2026-07-16T00:00:00.000Z";

describe("SeoHubEmitter.mapToFindings — pure mapping (sc-11-4)", () => {
  it("maps a cited finding to a hub Finding validating against FindingSchema, domain 'seo'", () => {
    const emitter = new SeoHubEmitter();
    const analysis = makeAnalysis([makeSeoFinding()]);

    const mapped = emitter.mapToFindings(analysis, NOW);

    expect(mapped).toHaveLength(1);
    expect(() => FindingSchema.parse(mapped[0])).not.toThrow();
    expect(mapped[0].domain).toBe("seo");
    expect(mapped[0].surfacedAt).toBe(NOW);
  });

  it("maps humanApprovalRequired:true to kind 'action'", () => {
    const emitter = new SeoHubEmitter();
    const analysis = makeAnalysis([makeSeoFinding({ humanApprovalRequired: true })]);

    const mapped = emitter.mapToFindings(analysis, NOW);

    expect(mapped).toHaveLength(1);
    expect(mapped[0].kind).toBe("action");
  });

  it("maps humanApprovalRequired:false to kind 'risk'", () => {
    const emitter = new SeoHubEmitter();
    const analysis = makeAnalysis([makeSeoFinding({ humanApprovalRequired: false })]);

    const mapped = emitter.mapToFindings(analysis, NOW);

    expect(mapped[0].kind).toBe("risk");
  });

  it("skips a finding with an empty citationUrl (sc-11-5 belt-and-suspenders)", () => {
    const emitter = new SeoHubEmitter();
    const analysis = makeAnalysis([makeSeoFinding({ citationUrl: "" })]);

    expect(emitter.mapToFindings(analysis, NOW)).toEqual([]);
  });

  it("skips a finding with a whitespace-only citationUrl", () => {
    const emitter = new SeoHubEmitter();
    const analysis = makeAnalysis([makeSeoFinding({ citationUrl: "   " })]);

    expect(emitter.mapToFindings(analysis, NOW)).toEqual([]);
  });

  it("is pure: never reads the clock — identical input always yields identical output", () => {
    const emitter = new SeoHubEmitter();
    const analysis = makeAnalysis([makeSeoFinding()]);

    const first = emitter.mapToFindings(analysis, NOW);
    const second = emitter.mapToFindings(analysis, NOW);

    expect(first).toEqual(second);
  });

  it("flattens evidence entries + cite marker into evidence[] strings", () => {
    const emitter = new SeoHubEmitter();
    const analysis = makeAnalysis([makeSeoFinding()]);

    const mapped = emitter.mapToFindings(analysis, NOW);

    expect(mapped[0].evidence.every((e) => typeof e === "string")).toBe(true);
    expect(mapped[0].evidence.some((e) => e.includes("cite:https://developers.google.com"))).toBe(true);
  });

  it("severity/urgency both carry SeoFinding.severity (1..5)", () => {
    const emitter = new SeoHubEmitter();
    const analysis = makeAnalysis([makeSeoFinding({ severity: 5 })]);

    const mapped = emitter.mapToFindings(analysis, NOW);

    expect(mapped[0].severity).toBe(5);
    expect(mapped[0].urgency).toBe(5);
  });

  it("maps multiple cited findings, skipping only the uncited ones", () => {
    const emitter = new SeoHubEmitter();
    const analysis = makeAnalysis([
      makeSeoFinding({ recommendation: "cited one" }),
      makeSeoFinding({ recommendation: "uncited one", citationUrl: "" }),
      makeSeoFinding({ recommendation: "cited two", humanApprovalRequired: true }),
    ]);

    const mapped = emitter.mapToFindings(analysis, NOW);
    expect(mapped).toHaveLength(2);
  });
});

describe("SeoHubEmitter.emit — best-effort sink, never throws (sc-11-4)", () => {
  it("calls the sink once per mapped finding", async () => {
    const emitter = new SeoHubEmitter();
    const analysis = makeAnalysis([makeSeoFinding(), makeSeoFinding({ recommendation: "second" })]);
    const calls: Finding[] = [];
    const sink: SeoFindingSink = async (f) => {
      calls.push(f);
    };

    await emitter.emit(analysis, sink, logger, NOW);

    expect(calls).toHaveLength(2);
  });

  it("swallows a throwing sink and logs a warning — never throws", async () => {
    const emitter = new SeoHubEmitter();
    const analysis = makeAnalysis([makeSeoFinding()]);
    const throwingSink: SeoFindingSink = async () => {
      throw new Error("sink boom");
    };
    const warn = vi.fn();

    await expect(
      emitter.emit(analysis, throwingSink, { warn }, NOW),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("sink boom");
  });

  it("never calls the sink when there is nothing cited (all-uncited)", async () => {
    const emitter = new SeoHubEmitter();
    const analysis = makeAnalysis([makeSeoFinding({ citationUrl: "" })]);
    const sink = vi.fn(async () => {});

    await emitter.emit(analysis, sink, logger, NOW);

    expect(sink).not.toHaveBeenCalled();
  });
});
