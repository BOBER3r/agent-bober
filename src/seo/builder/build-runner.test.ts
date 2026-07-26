/**
 * Tests for `SeoBuildRunner` (spec-20260717-seo-improver-builder, Sprint 13,
 * sc-13-1, sc-13-2, sc-13-4). Real temp dirs via `mkdtemp` for the report/
 * draft stores — no fs mocks (principle L44); a `:memory:` `FactStore` for
 * the hub adapter.
 */
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { createDefaultConfig } from "../../config/schema.js";
import { FactStore } from "../../state/facts.js";
import { HUB_SCOPE } from "../../hub/finding-source.js";
import type { Finding } from "../../hub/finding.js";

import { SeoReportStore, deriveReportId } from "../report-store.js";
import type { SeoReport } from "../types.js";

import { SeoBuildRunner } from "./build-runner.js";
import type { SeoBuildRunInput } from "./build-runner.js";
import { SeoDraftStore } from "./draft-store.js";
import { readApprovedSeoFindings } from "./hub-approved-source.js";
import type { ApprovedFinding } from "./approved-finding.js";
import type { ApprovedHubFinding } from "./approved-finding.js";

const T = "2026-07-16T00:00:00.000Z";
const CONFIG = createDefaultConfig("seo-build-runner-test", "greenfield");

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-seo-build-runner-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ── Fixtures ─────────────────────────────────────────────────────────

function makeReport(overrides: Partial<SeoReport> = {}): SeoReport {
  return {
    reportId: deriveReportId(T, "technical-audit", "https://example.com"),
    workflow: "technical-audit",
    target: "https://example.com",
    generatedAt: T,
    findings: [],
    droppedUncited: 0,
    droppedNeverEncode: 0,
    dataProvenance: [],
    verdict: "pass",
    ...overrides,
  };
}

function makeApprovedRow(overrides: Partial<ApprovedHubFinding> = {}): ApprovedHubFinding {
  return {
    id: "abc",
    domain: "seo",
    title: "[seo] technical-audit: Fix title",
    kind: "action",
    urgency: 3,
    severity: 3,
    surfacedAt: T,
    tags: ["seo", "workflow:technical-audit", "playbook:seo.tech.title", "confidence:firm"],
    evidence: ["Fix title", "cite:https://developers.google.com/search/docs"],
    status: "approved",
    ...overrides,
  };
}

/** Seed a `:memory:` FactStore with one approved row, decode via the real adapter. */
function seededApprovedFindings(overrides: Partial<ApprovedHubFinding> = {}): ApprovedFinding[] {
  const store = new FactStore(":memory:");
  store.insertFact({
    scope: HUB_SCOPE,
    subject: overrides.id ?? "abc",
    predicate: "finding",
    value: JSON.stringify(makeApprovedRow(overrides)),
    confidence: 1,
    sourceRunId: null,
    tValid: T,
    tCreated: T,
  });
  const result = readApprovedSeoFindings(store);
  store.close();
  return result;
}

function baseInput(overrides: Partial<SeoBuildRunInput> = {}): SeoBuildRunInput {
  return {
    projectRoot: tmpRoot,
    config: CONFIG,
    reportId: "seo-technical-audit-does-not-matter",
    now: T,
    ...overrides,
  };
}

// ── sc-13-1: build persists drafts + exit 0 ───────────────────────────

describe("SeoBuildRunner.run — sc-13-1 build + persist", () => {
  it("stamps now once, reads the approved findings, runs SeoBuilder.build, and persists a draft bundle under .bober/seo/drafts/", async () => {
    const reportStore = new SeoReportStore();
    const report = makeReport();
    await reportStore.save(tmpRoot, report);

    const approved = seededApprovedFindings();
    expect(approved).toHaveLength(1);

    const findingSink = vi.fn(async () => {});
    const runner = new SeoBuildRunner();

    const outcome = await runner.run(
      baseInput({
        reportId: report.reportId,
        readApproved: async () => approved,
        findingSink,
      }),
    );

    expect(outcome.exitCode).toBe(0);
    expect(outcome.drafts).toBeDefined();
    expect(outcome.drafts!.length).toBeGreaterThan(0);

    const draftStore = new SeoDraftStore();
    const bundle = await draftStore.read(tmpRoot, report.reportId);
    expect(bundle).not.toBeNull();
    expect(bundle!.reportId).toBe(report.reportId);
    expect(bundle!.target).toBe(report.target);
    expect(bundle!.generatedAt).toBe(T); // injected `now`, never Date.now()
    expect(bundle!.drafts.length).toBe(outcome.drafts!.length);

    const entries = await readdir(join(tmpRoot, ".bober", "seo", "drafts"));
    expect(entries.some((f) => f.endsWith("-seo-drafts.json"))).toBe(true);
    expect(entries.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("emits each persisted draft to the hub as kind 'action' via the injected sink", async () => {
    const reportStore = new SeoReportStore();
    const report = makeReport();
    await reportStore.save(tmpRoot, report);

    const approved = seededApprovedFindings();
    const emitted: Finding[] = [];
    const findingSink = async (f: Finding): Promise<void> => {
      emitted.push(f);
    };

    const runner = new SeoBuildRunner();
    const outcome = await runner.run(
      baseInput({
        reportId: report.reportId,
        readApproved: async () => approved,
        findingSink,
      }),
    );

    expect(outcome.exitCode).toBe(0);
    expect(emitted.length).toBe(outcome.drafts!.length);
    expect(emitted.length).toBeGreaterThan(0);
    for (const finding of emitted) {
      expect(finding.kind).toBe("action");
      expect(finding.domain).toBe("seo");
      expect(finding.evidence.some((e) => e.startsWith("cite:"))).toBe(true);
      expect(finding.surfacedAt).toBe(T); // injected `now`, never Date.now()
    }
  });
});

// ── sc-13-2: failing hub sink never changes the exit code ─────────────

describe("SeoBuildRunner.run — sc-13-2 best-effort hub emission", () => {
  it("a throwing findingSink does not change the exit code, and the draft bundle is still persisted", async () => {
    const reportStore = new SeoReportStore();
    const report = makeReport();
    await reportStore.save(tmpRoot, report);

    const approved = seededApprovedFindings();
    const throwingSink = async (): Promise<void> => {
      throw new Error("hub down");
    };

    const runner = new SeoBuildRunner();
    const outcome = await runner.run(
      baseInput({
        reportId: report.reportId,
        readApproved: async () => approved,
        findingSink: throwingSink,
      }),
    );

    expect(outcome.exitCode).toBe(0);

    const draftStore = new SeoDraftStore();
    const bundle = await draftStore.read(tmpRoot, report.reportId);
    expect(bundle).not.toBeNull();
    expect(bundle!.drafts.length).toBeGreaterThan(0);
  });
});

// ── sc-13-4: unknown reportId / no approved findings ──────────────────

describe("SeoBuildRunner.run — sc-13-4 nothing-to-build is a clean exit with zero emits", () => {
  it("an unknown reportId prints a message, exits 0, and never calls the finding sink", async () => {
    const findingSink = vi.fn(async () => {});
    const runner = new SeoBuildRunner();

    const outcome = await runner.run(
      baseInput({
        reportId: "seo-technical-audit-never-saved-00000000",
        readApproved: async () => seededApprovedFindings(),
        findingSink,
      }),
    );

    expect(outcome.exitCode).toBe(0);
    expect(outcome.drafts).toBeUndefined();
    expect(findingSink).not.toHaveBeenCalled();

    const draftStore = new SeoDraftStore();
    expect(await draftStore.list(tmpRoot)).toEqual([]);
  });

  it("a report with no approved findings prints a message, exits 0, and never calls the finding sink", async () => {
    const reportStore = new SeoReportStore();
    const report = makeReport();
    await reportStore.save(tmpRoot, report);

    const findingSink = vi.fn(async () => {});
    const runner = new SeoBuildRunner();

    const outcome = await runner.run(
      baseInput({
        reportId: report.reportId,
        readApproved: async () => [],
        findingSink,
      }),
    );

    expect(outcome.exitCode).toBe(0);
    expect(outcome.drafts).toBeUndefined();
    expect(findingSink).not.toHaveBeenCalled();

    const draftStore = new SeoDraftStore();
    expect(await draftStore.list(tmpRoot)).toEqual([]);
  });

  it("filters approved findings by the report's workflow — a different-workflow approved finding does not count", async () => {
    const reportStore = new SeoReportStore();
    const report = makeReport({ workflow: "schema-audit" }); // approved fixture is workflow:technical-audit
    await reportStore.save(tmpRoot, report);

    const findingSink = vi.fn(async () => {});
    const runner = new SeoBuildRunner();

    const outcome = await runner.run(
      baseInput({
        reportId: report.reportId,
        readApproved: async () => seededApprovedFindings(),
        findingSink,
      }),
    );

    expect(outcome.exitCode).toBe(0);
    expect(outcome.drafts).toBeUndefined();
    expect(findingSink).not.toHaveBeenCalled();
  });
});

// ── Never throws ─────────────────────────────────────────────────────

describe("SeoBuildRunner.run — never throws", () => {
  it("resolves exitCode 2 when the injected reportStore.read throws (fail-closed)", async () => {
    const throwingReportStore = {
      read: () => Promise.reject(new Error("disk error")),
      save: () => Promise.reject(new Error("unused")),
      list: () => Promise.reject(new Error("unused")),
    } as unknown as SeoReportStore;

    const runner = new SeoBuildRunner();
    await expect(
      runner.run(baseInput({ reportStore: throwingReportStore })),
    ).resolves.toEqual({ exitCode: 2 });
  });

  it("resolves exitCode 2 when the injected readApproved throws (fail-closed)", async () => {
    const reportStore = new SeoReportStore();
    const report = makeReport();
    await reportStore.save(tmpRoot, report);

    const runner = new SeoBuildRunner();
    await expect(
      runner.run(
        baseInput({
          reportId: report.reportId,
          readApproved: () => Promise.reject(new Error("hub read failed")),
        }),
      ),
    ).resolves.toEqual({ exitCode: 2 });
  });

  it("resolves exitCode 2 when the injected draftStore.save throws (fail-closed)", async () => {
    const reportStore = new SeoReportStore();
    const report = makeReport();
    await reportStore.save(tmpRoot, report);

    const failingDraftStore = {
      save: () => Promise.reject(new Error("write failed")),
      read: () => Promise.reject(new Error("unused")),
      list: () => Promise.reject(new Error("unused")),
    } as unknown as SeoDraftStore;

    const runner = new SeoBuildRunner();
    await expect(
      runner.run(
        baseInput({
          reportId: report.reportId,
          readApproved: async () => seededApprovedFindings(),
          draftStore: failingDraftStore,
        }),
      ),
    ).resolves.toEqual({ exitCode: 2 });
  });
});
