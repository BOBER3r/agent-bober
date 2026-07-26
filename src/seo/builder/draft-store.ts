/**
 * SeoDraftStore — persists a `SeoDraftBundle` JSON under `.bober/seo/drafts/`
 * (spec-20260717-seo-improver-builder, Sprint 13). MIRRORS `SeoReportStore`
 * (`../report-store.ts`): atomic temp-file + POSIX rename, sanitized
 * filename, `null`-on-missing read, `[]`-on-missing list. Write-once id =
 * the source `reportId` (one draft bundle per built report).
 *
 * `generatedAt` on the bundle is ALWAYS the caller-injected `now` — this
 * file never reads the clock for that purpose. The `.tmp` suffix below uses
 * `Date.now()` purely as a uniqueness token for the temp filename (same
 * carve-out `report-store.ts:67-68` documents), never as a bundle timestamp.
 */
import { readFile, writeFile, readdir, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { ensureDir } from "../../utils/fs.js";
import type { SeoDraft } from "./draft-types.js";

// ── Paths ────────────────────────────────────────────────────────────

const SEO_DRAFTS_DIR = ".bober/seo/drafts";
const DRAFT_SUFFIX = "-seo-drafts.json";

function draftsDir(projectRoot: string): string {
  return join(projectRoot, SEO_DRAFTS_DIR);
}

/** fs-safe filename — mirrors `report-store.ts`'s sanitization. */
function draftPath(projectRoot: string, reportId: string): string {
  const safeId = reportId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(draftsDir(projectRoot), `${safeId}${DRAFT_SUFFIX}`);
}

// ── Bundle shape ─────────────────────────────────────────────────────

/** One `SeoBuildRunner.run` invocation's persisted output, keyed by `reportId`. */
export type SeoDraftBundle = {
  reportId: string;
  target: string;
  /** = the injected `now`, never `Date.now()`. */
  generatedAt: string;
  drafts: SeoDraft[];
  skipped: number;
};

// ── Store ────────────────────────────────────────────────────────────

export class SeoDraftStore {
  /**
   * Write `bundle` atomically (temp file + POSIX-atomic rename) under
   * `.bober/seo/drafts/`. Overwrites any existing bundle with the same
   * `reportId`. Throws on an unrecoverable fs failure — callers (the build
   * runner) are expected to catch and fail closed.
   */
  async save(projectRoot: string, bundle: SeoDraftBundle): Promise<void> {
    await ensureDir(draftsDir(projectRoot));
    const path = draftPath(projectRoot, bundle.reportId);
    // Uniqueness token for the temp filename only — NOT a bundle timestamp.
    const tmp = `${path}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(bundle, null, 2) + "\n", { encoding: "utf-8" });
    await rename(tmp, path);
  }

  /**
   * Read a persisted `SeoDraftBundle` by `reportId`. Returns `null` on a
   * missing file — NEVER throws (mirrors `SeoReportStore.read`).
   */
  async read(projectRoot: string, reportId: string): Promise<SeoDraftBundle | null> {
    const path = draftPath(projectRoot, reportId);
    try {
      const raw = await readFile(path, "utf-8");
      return JSON.parse(raw) as SeoDraftBundle;
    } catch {
      return null;
    }
  }

  /**
   * List all persisted draft-bundle reportIds, sorted by filename. Returns
   * `[]` if the drafts directory does not exist — never throws.
   */
  async list(projectRoot: string): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(draftsDir(projectRoot));
    } catch {
      return [];
    }

    return entries
      .filter((f) => f.endsWith(DRAFT_SUFFIX))
      .sort()
      .map((f) => f.slice(0, -DRAFT_SUFFIX.length));
  }
}
