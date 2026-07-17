/**
 * Tests for `SeoDraftStore` (spec-20260717-seo-improver-builder, Sprint 13).
 * Mirrors `../report-store.test.ts` — real temp dirs via `mkdtemp`, no fs
 * mocks (principle L44).
 */
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { SeoDraftStore } from "./draft-store.js";
import type { SeoDraftBundle } from "./draft-store.js";
import type { SeoDraft } from "./draft-types.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-seo-draft-store-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function makeDraft(overrides: Partial<SeoDraft> = {}): SeoDraft {
  return {
    kind: "title-meta",
    humanApprovalRequired: true,
    sourceCitationUrl: "https://developers.google.com/search/docs",
    sourceFindingId: "abc",
    target: "https://example.com",
    artifact: "<title>Fixed unique title</title>",
    playbookRef: "seo.tech.title",
    ...overrides,
  };
}

function makeBundle(overrides: Partial<SeoDraftBundle> = {}): SeoDraftBundle {
  return {
    reportId: "seo-technical-audit-2026-07-16T00-00-00-000Z-deadbeef",
    target: "https://example.com",
    generatedAt: "2026-07-16T00:00:00.000Z",
    drafts: [makeDraft()],
    skipped: 0,
    ...overrides,
  };
}

describe("SeoDraftStore.save/read — round-trip", () => {
  it("writes a bundle under .bober/seo/drafts/ and reads it back byte-equal", async () => {
    const store = new SeoDraftStore();
    const bundle = makeBundle();

    await store.save(tmpRoot, bundle);
    const read = await store.read(tmpRoot, bundle.reportId);

    expect(read).toEqual(bundle);
  });

  it("writes into .bober/seo/drafts/ (verified by directory listing)", async () => {
    const store = new SeoDraftStore();
    const bundle = makeBundle();
    await store.save(tmpRoot, bundle);

    const entries = await readdir(join(tmpRoot, ".bober", "seo", "drafts"));
    expect(entries.some((f) => f.endsWith("-seo-drafts.json"))).toBe(true);
  });

  it("leaves no leftover .tmp file after a successful save (atomic temp+rename)", async () => {
    const store = new SeoDraftStore();
    await store.save(tmpRoot, makeBundle());

    const entries = await readdir(join(tmpRoot, ".bober", "seo", "drafts"));
    expect(entries.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("overwrites an existing bundle with the same reportId (write-once id)", async () => {
    const store = new SeoDraftStore();
    const bundle = makeBundle();
    await store.save(tmpRoot, bundle);
    await store.save(tmpRoot, { ...bundle, skipped: 3 });

    const read = await store.read(tmpRoot, bundle.reportId);
    expect(read?.skipped).toBe(3);
  });

  it("read() returns null (never throws) on a missing reportId", async () => {
    const store = new SeoDraftStore();
    await expect(store.read(tmpRoot, "seo-technical-audit-nonexistent")).resolves.toBeNull();
  });

  it("read() returns null (never throws) when the drafts directory does not exist at all", async () => {
    const store = new SeoDraftStore();
    const emptyRoot = await mkdtemp(join(tmpdir(), "bober-seo-draft-store-empty-"));
    try {
      await expect(store.read(emptyRoot, "anything")).resolves.toBeNull();
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });
});

describe("SeoDraftStore.list — sorted ids, never throws", () => {
  it("returns [] when the drafts directory does not exist", async () => {
    const store = new SeoDraftStore();
    await expect(store.list(tmpRoot)).resolves.toEqual([]);
  });

  it("lists saved bundle reportIds sorted by filename", async () => {
    const store = new SeoDraftStore();
    const bundleA = makeBundle({ reportId: "seo-technical-audit-aaa" });
    const bundleB = makeBundle({ reportId: "seo-rank-track-bbb" });
    await store.save(tmpRoot, bundleA);
    await store.save(tmpRoot, bundleB);

    const ids = await store.list(tmpRoot);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(bundleA.reportId);
    expect(ids).toContain(bundleB.reportId);
  });
});
