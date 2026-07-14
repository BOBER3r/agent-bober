import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { ensureDir } from "./helpers.js";
import { renderReviewMarkdown } from "../orchestrator/code-reviewer-agent.js";
import type { SecurityAuditResult } from "../orchestrator/security-audit-types.js";

// ── Paths (mirrors review-state.ts; separate dir per ADR-3) ───────────

const SECURITY_DIR = ".bober/security";

function securityDir(projectRoot: string): string {
  return join(projectRoot, SECURITY_DIR);
}

function securityPath(projectRoot: string, contractId: string): string {
  const safeId = contractId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(securityDir(projectRoot), `${safeId}-security-audit.md`);
}

// ── Store ───────────────────────────────────────────────────────────

/**
 * Save a security audit result to disk as human-readable markdown, rendered
 * via the existing code-reviewer markdown renderer applied to `result.review`.
 * Uses mkdir -p semantics (idempotent). Overwrites any existing audit for the
 * same contract.
 */
export async function saveSecurityAudit(
  projectRoot: string,
  contractId: string,
  result: SecurityAuditResult,
): Promise<void> {
  await ensureDir(securityDir(projectRoot));
  const markdown = renderReviewMarkdown(result.review);
  const filePath = securityPath(projectRoot, contractId);
  await writeFile(filePath, markdown, "utf-8");
}

/**
 * Read a security audit's rendered markdown by contract ID.
 * Returns null if not found (audits may not exist for all sprints) —
 * never throws on a missing file.
 */
export async function readSecurityAudit(
  projectRoot: string,
  contractId: string,
): Promise<string | null> {
  const filePath = securityPath(projectRoot, contractId);

  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * List all saved security audit contract IDs, sorted by filename.
 * Returns [] if the security directory does not exist.
 */
export async function listSecurityAudits(projectRoot: string): Promise<string[]> {
  const dir = securityDir(projectRoot);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  return entries
    .filter((f) => f.endsWith("-security-audit.md"))
    .sort()
    .map((f) => f.slice(0, -("-security-audit.md".length)));
}
