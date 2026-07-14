import { basename } from "node:path";

import type { AuditDiff, ChangedFile, DiffHunk } from "./diff-provider.js";
import type { SecurityFinding } from "../security-audit-types.js";
import { logger } from "../../utils/logger.js";

/**
 * OFFLINE, zero-network supply-chain diff inspector (spec-20260714 sprint 7,
 * G5, ADR-4). Scoped to `diff.changedFiles`; every check operates purely on
 * the hunk text already captured by the diff provider (Pattern B — no
 * `node:fs` reads, no child processes, no network). NEVER throws: any
 * per-file check failure is caught and skips that file only (Pattern A,
 * mirrors `diff-provider.ts`'s `collectGraphNeighborhood`), so one malformed
 * hunk can never drop the rest of the audit's findings.
 *
 * Findings feed the finder as PRIORS (the "ground truth priors" prompt
 * section rendered by `security-auditor-agent.ts`) — this is NOT a new LLM
 * role or sub-auditor (nonGoals[3]).
 */

export interface SupplyChainInspectInput {
  projectRoot: string;
  diff: AuditDiff;
  signal: AbortSignal;
}

const REGISTRY_HOSTS = new Set(["registry.npmjs.org", "registry.yarnpkg.com"]);

const LIFECYCLE_SCRIPT_KEYS = ["preinstall", "install", "postinstall", "prepare"];

// bober: substring/regex heuristics over the diff's added lines, not a full
// JSON/YAML grammar — cheap and total, mirrors extractDiffKeywords's
// NOTABLE_SUBSTRINGS precedent in diff-provider.ts; good enough to ground
// the finder's priors, not a guarantee of zero false positives/negatives.
const OBFUSCATION_PATTERN =
  /(base64|Buffer\.from\([^)]*base64|eval\(|\\x[0-9a-f]{2}|atob\(|child_process|curl\s|wget\s|node\s+-e)/i;
const LONG_BLOB_PATTERN = /[A-Za-z0-9+/]{80,}={0,2}/;

const PACKAGE_JSON_METADATA_KEYS = new Set([
  "name",
  "version",
  "description",
  "main",
  "types",
  "typings",
  "license",
  "author",
  "private",
  "type",
  "module",
  "bin",
  "homepage",
  "repository",
  "bugs",
  "keywords",
  "engines",
  "scripts",
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "files",
  "exports",
  "sideEffects",
  "workspaces",
]);

function addedLines(hunks: DiffHunk[]): string[] {
  const lines: string[] = [];
  if (!Array.isArray(hunks)) return lines;

  for (const hunk of hunks) {
    const content = typeof hunk?.content === "string" ? hunk.content : "";
    if (!content) continue;
    for (const line of content.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) lines.push(line.slice(1));
    }
  }

  return lines;
}

function isLockfile(path: string): boolean {
  const name = basename(path);
  return name === "package-lock.json" || name === "yarn.lock" || name === "pnpm-lock.yaml";
}

function isCiWorkflow(path: string): boolean {
  return /\.github\/workflows\/[^/]+\.ya?ml$/.test(path);
}

function makeFinding(description: string, path: string, snippet: string): SecurityFinding {
  return {
    description,
    evidence: [{ path, line: 0, snippet: snippet.slice(0, 300) }],
    source: "supply-chain-inspector",
    vulnClass: "supply-chain",
  };
}

// ── Check 1: malicious lifecycle script (package.json) ────────────────

function checkLifecycleScripts(file: ChangedFile): SecurityFinding[] {
  if (basename(file.path) !== "package.json") return [];

  const findings: SecurityFinding[] = [];
  for (const line of addedLines(file.hunks)) {
    const scriptKey = LIFECYCLE_SCRIPT_KEYS.find((key) => line.includes(`"${key}"`));
    if (!scriptKey) continue;
    if (OBFUSCATION_PATTERN.test(line) || LONG_BLOB_PATTERN.test(line)) {
      findings.push(
        makeFinding(
          `package.json lifecycle script "${scriptKey}" added/changed with obfuscated content (base64/hex/eval)`,
          file.path,
          line.trim(),
        ),
      );
    }
  }
  return findings;
}

// ── Check 2: lockfile "resolved" host mismatch ─────────────────────────

function checkLockfileHost(file: ChangedFile): SecurityFinding[] {
  if (!isLockfile(file.path)) return [];

  const findings: SecurityFinding[] = [];
  const resolvedPattern = /resolved"?\s*:?\s*"https?:\/\/([^/"]+)/;
  for (const line of addedLines(file.hunks)) {
    const match = resolvedPattern.exec(line);
    if (!match) continue;
    const host = match[1];
    if (!REGISTRY_HOSTS.has(host)) {
      findings.push(
        makeFinding(
          `Lockfile "resolved" host "${host}" is not a known registry (expected one of: ${Array.from(REGISTRY_HOSTS).join(", ")})`,
          file.path,
          line.trim(),
        ),
      );
    }
  }
  return findings;
}

// ── Check 3: .npmrc registry override / ignore-scripts disabled ────────

function checkNpmrc(file: ChangedFile): SecurityFinding[] {
  if (basename(file.path) !== ".npmrc") return [];

  const findings: SecurityFinding[] = [];
  for (const line of addedLines(file.hunks)) {
    const trimmed = line.trim();
    if (/^registry\s*=/.test(trimmed) || /^@[\w-]+:registry\s*=/.test(trimmed)) {
      findings.push(makeFinding(".npmrc adds/changes a custom registry override", file.path, trimmed));
    }
    if (/ignore-scripts\s*=\s*false/.test(trimmed)) {
      findings.push(
        makeFinding(".npmrc re-enables lifecycle scripts (ignore-scripts=false)", file.path, trimmed),
      );
    }
  }
  return findings;
}

// ── Check 4: new dependency with no matching import in the diff ────────

function checkNewDependencyImport(file: ChangedFile, allFiles: ChangedFile[]): SecurityFinding[] {
  if (basename(file.path) !== "package.json") return [];

  const findings: SecurityFinding[] = [];
  // A dependency entry: `"name": "^1.2.3"` — the leading digit/^/~ on the
  // value side distinguishes a semver range from an arbitrary metadata
  // string value (e.g. "name": "my-package"), which is skipped via the
  // metadata-key set below anyway (belt-and-suspenders).
  const depLinePattern = /^\s*"([\w@][\w./-]*)"\s*:\s*"[~^]?\d[^"]*"\s*,?\s*$/;

  for (const line of addedLines(file.hunks)) {
    const match = depLinePattern.exec(line);
    if (!match) continue;
    const depName = match[1];
    if (PACKAGE_JSON_METADATA_KEYS.has(depName)) continue;

    const referenced = allFiles.some(
      (f) =>
        f.path !== file.path &&
        addedLines(f.hunks).some(
          (l) =>
            l.includes(`from "${depName}`) ||
            l.includes(`from '${depName}`) ||
            l.includes(`require("${depName}`) ||
            l.includes(`require('${depName}`),
        ),
    );

    if (!referenced) {
      findings.push(
        makeFinding(
          `New dependency "${depName}" added to package.json with no matching import/require found in this diff ` +
            "(heuristic — may be a false positive if the import lives outside the diffed hunks)",
          file.path,
          line.trim(),
        ),
      );
    }
  }
  return findings;
}

// ── Check 5: CI uses "npm install" instead of "npm ci" ──────────────────

function checkCiNpmInstall(file: ChangedFile): SecurityFinding[] {
  if (!isCiWorkflow(file.path)) return [];

  const findings: SecurityFinding[] = [];
  for (const line of addedLines(file.hunks)) {
    if (/\bnpm\s+ci\b/.test(line)) continue;
    if (/\bnpm\s+install\b/.test(line)) {
      findings.push(
        makeFinding(
          'CI workflow uses "npm install" instead of the reproducible, lockfile-enforcing "npm ci"',
          file.path,
          line.trim(),
        ),
      );
    }
  }
  return findings;
}

// ── Check 6: GitHub Action pinned by tag/branch instead of full SHA ─────

function checkActionPinning(file: ChangedFile): SecurityFinding[] {
  if (!isCiWorkflow(file.path)) return [];

  const findings: SecurityFinding[] = [];
  const usesPattern = /uses:\s*([\w.-]+\/[\w.-]+)@([\w.-]+)/;
  for (const line of addedLines(file.hunks)) {
    const match = usesPattern.exec(line);
    if (!match) continue;
    const [, action, ref] = match;
    const isFullSha = /^[0-9a-f]{40}$/i.test(ref);
    if (!isFullSha) {
      findings.push(
        makeFinding(
          `GitHub Action "${action}" is pinned by tag/branch "${ref}" instead of a full commit SHA (supply-chain-tampering risk, cf. tj-actions CVE-2025-30066)`,
          file.path,
          line.trim(),
        ),
      );
    }
  }
  return findings;
}

// ── Entry point ─────────────────────────────────────────────────────

/**
 * Runs all six offline supply-chain checks over `diff.changedFiles` and
 * returns the combined findings. Pure fold over hunk text — no fs reads, no
 * child processes, no network. Honours `signal.aborted` between files.
 * NEVER throws: a per-file exception is logged and skipped, never
 * propagated (Pattern A).
 */
export async function inspectSupplyChain(input: SupplyChainInspectInput): Promise<SecurityFinding[]> {
  const { diff, signal } = input;
  const changedFiles = Array.isArray(diff?.changedFiles) ? diff.changedFiles : [];

  const findings: SecurityFinding[] = [];

  for (const file of changedFiles) {
    if (signal.aborted) break;
    if (!file || typeof file.path !== "string") continue;

    try {
      findings.push(...checkLifecycleScripts(file));
      findings.push(...checkLockfileHost(file));
      findings.push(...checkNpmrc(file));
      findings.push(...checkNewDependencyImport(file, changedFiles));
      findings.push(...checkCiNpmInstall(file));
      findings.push(...checkActionPinning(file));
    } catch (err) {
      logger.debug(
        `[supply-chain-inspector] check on "${file.path}" threw: ${err instanceof Error ? err.message : String(err)} — skipping this file`,
      );
    }
  }

  return findings;
}
