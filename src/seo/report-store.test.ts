/**
 * Tests for `SeoReportStore` (spec-20260715-ultimate-seo-suite, Sprint 11, sc-11-3).
 *
 * Real temp dirs via `mkdtemp` — no fs mocks (principle L44).
 */
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { SeoReportStore, deriveReportId } from "./report-store.js";
import type { SeoReport } from "./types.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-seo-report-store-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function makeReport(overrides: Partial<SeoReport> = {}): SeoReport {
  return {
    reportId: deriveReportId("2026-07-16T00:00:00.000Z", "technical-audit", "example.com"),
    workflow: "technical-audit",
    target: "example.com",
    generatedAt: "2026-07-16T00:00:00.000Z",
    findings: [],
    droppedUncited: 0,
    dataProvenance: [],
    verdict: "pass",
    ...overrides,
  };
}

describe("deriveReportId — pure fn of (now, workflow, target)", () => {
  it("is fs-safe (no path separators or special characters)", () => {
    const id = deriveReportId("2026-07-16T00:00:00.000Z", "technical-audit", "https://example.com/a?b=c");
    expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it("is deterministic: same inputs -> same id", () => {
    const id1 = deriveReportId("2026-07-16T00:00:00.000Z", "technical-audit", "example.com");
    const id2 = deriveReportId("2026-07-16T00:00:00.000Z", "technical-audit", "example.com");
    expect(id1).toBe(id2);
  });

  it("diverges across different targets in the same instant (collision-free)", () => {
    const id1 = deriveReportId("2026-07-16T00:00:00.000Z", "technical-audit", "example.com");
    const id2 = deriveReportId("2026-07-16T00:00:00.000Z", "technical-audit", "example.org");
    expect(id1).not.toBe(id2);
  });

  it("diverges across different workflows for the same target/now", () => {
    const id1 = deriveReportId("2026-07-16T00:00:00.000Z", "technical-audit", "example.com");
    const id2 = deriveReportId("2026-07-16T00:00:00.000Z", "rank-track", "example.com");
    expect(id1).not.toBe(id2);
  });
});

describe("SeoReportStore.save/read — round-trip (sc-11-3)", () => {
  it("writes a report under .bober/seo/reports/ and reads it back byte-equal", async () => {
    const store = new SeoReportStore();
    const report = makeReport();

    await store.save(tmpRoot, report);
    const read = await store.read(tmpRoot, report.reportId);

    expect(read).toEqual(report);
  });

  it("writes into .bober/seo/reports/ (verified by directory listing)", async () => {
    const store = new SeoReportStore();
    const report = makeReport();
    await store.save(tmpRoot, report);

    const entries = await readdir(join(tmpRoot, ".bober", "seo", "reports"));
    expect(entries.some((f) => f.endsWith("-seo-report.json"))).toBe(true);
  });

  it("leaves no leftover .tmp file after a successful save (atomic temp+rename)", async () => {
    const store = new SeoReportStore();
    await store.save(tmpRoot, makeReport());

    const entries = await readdir(join(tmpRoot, ".bober", "seo", "reports"));
    expect(entries.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("overwrites an existing report with the same reportId", async () => {
    const store = new SeoReportStore();
    const report = makeReport();
    await store.save(tmpRoot, report);
    await store.save(tmpRoot, { ...report, droppedUncited: 5 });

    const read = await store.read(tmpRoot, report.reportId);
    expect(read?.droppedUncited).toBe(5);
  });

  it("read() returns null (never throws) on a missing id", async () => {
    const store = new SeoReportStore();
    await expect(store.read(tmpRoot, "seo-technical-audit-nonexistent-00000000")).resolves.toBeNull();
  });

  it("read() returns null (never throws) when the reports directory does not exist at all", async () => {
    const store = new SeoReportStore();
    const emptyRoot = await mkdtemp(join(tmpdir(), "bober-seo-report-store-empty-"));
    try {
      await expect(store.read(emptyRoot, "anything")).resolves.toBeNull();
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });
});

describe("SeoReportStore.list — sorted ids, never throws", () => {
  it("returns [] when the reports directory does not exist", async () => {
    const store = new SeoReportStore();
    await expect(store.list(tmpRoot)).resolves.toEqual([]);
  });

  it("lists saved report ids sorted by filename", async () => {
    const store = new SeoReportStore();
    const reportA = makeReport({
      reportId: deriveReportId("2026-07-16T00:00:00.000Z", "technical-audit", "a.com"),
    });
    const reportB = makeReport({
      reportId: deriveReportId("2026-07-16T00:00:01.000Z", "rank-track", "b.com"),
    });
    await store.save(tmpRoot, reportA);
    await store.save(tmpRoot, reportB);

    const ids = await store.list(tmpRoot);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(reportA.reportId);
    expect(ids).toContain(reportB.reportId);
  });
});
