/**
 * SeoReportStore — persists `SeoReport` JSON under `.bober/seo/reports/`
 * (spec-20260715-ultimate-seo-suite, Sprint 11).
 *
 * Mirrors `saveSecurityAudit`/`readSecurityAudit`
 * (`src/state/security-audit-state.ts:29-56`) for the path/dir/null-on-missing
 * shape, but writes via the ATOMIC temp-file + rename pattern of
 * `writeLedgerAtomic` (`src/seo/quota-ledger.ts:73-81`) — the architecture
 * (lines 337/406/483) explicitly requires atomic writes for the report
 * artifact, which `saveSecurityAudit`'s plain `writeFile` does not provide.
 *
 * `reportId` is a PURE function of (now, workflow, target) — see
 * `deriveReportId` — so callers never need to invent an id themselves, and
 * two runs of the same workflow/target in the same second (extremely
 * unlikely given ISO-millisecond `now`) still diverge via the target hash.
 */
import { readFile, writeFile, readdir, rename } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { join } from "node:path";

import { ensureDir } from "../utils/fs.js";
import type { SeoReport, SeoWorkflow } from "./types.js";

// ── Paths ────────────────────────────────────────────────────────────

const SEO_REPORTS_DIR = ".bober/seo/reports";
const REPORT_SUFFIX = "-seo-report.json";

function reportsDir(projectRoot: string): string {
  return join(projectRoot, SEO_REPORTS_DIR);
}

/** fs-safe filename — mirrors `security-audit-state.ts:17`'s sanitization. */
function reportPath(projectRoot: string, reportId: string): string {
  const safeId = reportId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(reportsDir(projectRoot), `${safeId}${REPORT_SUFFIX}`);
}

// ── Id derivation ────────────────────────────────────────────────────

/**
 * Derive a write-once, collision-free `reportId` from `now` + `workflow` +
 * a short hash of `target`. PURE — never reads the clock itself (`now` is
 * caller-injected). `now` is sanitized into a filename-safe slug (mirrors
 * `buildAuditDescriptor`'s slug, `security-audit.ts:78`); `target` is
 * hashed (not embedded raw) so an arbitrary target string can never break
 * the id shape or collide across two different targets.
 */
export function deriveReportId(now: string, workflow: SeoWorkflow, target: string): string {
  const slug = now.replace(/[^A-Za-z0-9]/g, "-");
  const targetHash = createHash("sha256").update(target).digest("hex").slice(0, 8);
  return `seo-${workflow}-${slug}-${targetHash}`;
}

// ── Store ────────────────────────────────────────────────────────────

export class SeoReportStore {
  /**
   * Write `report` atomically (temp file + POSIX-atomic rename) under
   * `.bober/seo/reports/`. Overwrites any existing report with the same
   * `reportId`. Throws on an unrecoverable fs failure — callers (the
   * runner) are expected to catch and fail closed.
   */
  async save(projectRoot: string, report: SeoReport): Promise<void> {
    await ensureDir(reportsDir(projectRoot));
    const path = reportPath(projectRoot, report.reportId);
    // Uniqueness token for the temp filename only — NOT a report timestamp.
    const tmp = `${path}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(report, null, 2) + "\n", { encoding: "utf-8" });
    await rename(tmp, path);
  }

  /**
   * Read a persisted `SeoReport` by id. Returns `null` on a missing file —
   * NEVER throws (mirrors `readSecurityAudit`, `security-audit-state.ts:51-55`).
   */
  async read(projectRoot: string, reportId: string): Promise<SeoReport | null> {
    const path = reportPath(projectRoot, reportId);
    try {
      const raw = await readFile(path, "utf-8");
      return JSON.parse(raw) as SeoReport;
    } catch {
      return null;
    }
  }

  /**
   * List all persisted report ids, sorted by filename. Returns `[]` if the
   * reports directory does not exist — never throws.
   */
  async list(projectRoot: string): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(reportsDir(projectRoot));
    } catch {
      return [];
    }

    return entries
      .filter((f) => f.endsWith(REPORT_SUFFIX))
      .sort()
      .map((f) => f.slice(0, -REPORT_SUFFIX.length));
  }
}
