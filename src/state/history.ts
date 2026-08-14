import { readFile, writeFile, appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

import type { ContractStatus, SprintContract } from "../contracts/sprint-contract.js";
import { isSettledContractStatus } from "../contracts/sprint-contract.js";
import type { PlanSpec } from "../contracts/spec.js";
import { ensureDir } from "./helpers.js";
import { rotateIfNeeded, historyArchivePath } from "./history-rotation.js";

// ── Constants ───────────────────────────────────────────────────────

const BOBER_DIR = ".bober";
const HISTORY_FILE = "history.jsonl";
const PROGRESS_FILE = "progress.md";

function historyPath(projectRoot: string): string {
  return join(projectRoot, BOBER_DIR, HISTORY_FILE);
}

function progressPath(projectRoot: string): string {
  return join(projectRoot, BOBER_DIR, PROGRESS_FILE);
}

// ── History Entry ───────────────────────────────────────────────────

export const PhaseSchema = z.enum([
  "init",
  "planning",
  "curating",
  "generating",
  "evaluating",
  "rework",
  "complete",
  "failed",
]);
export type Phase = z.infer<typeof PhaseSchema>;

export const HistoryEntrySchema = z.object({
  timestamp: z.string().datetime(),
  event: z.string().min(1),
  phase: PhaseSchema,
  sprintId: z.string().optional(),
  details: z.record(z.string(), z.unknown()),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

// ── Parse Helpers ───────────────────────────────────────────────────

/**
 * Parse a JSONL content string into HistoryEntry objects.
 * Skips malformed or invalid lines without throwing.
 */
function parseEntries(content: string): HistoryEntry[] {
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  const entries: HistoryEntry[] = [];

  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      const result = HistoryEntrySchema.safeParse(parsed);
      if (result.success) {
        entries.push(result.data);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}

// ── Redaction ───────────────────────────────────────────────────────
//
// `.bober/history.jsonl` is untracked in THIS repo (.gitignore), but
// `appendHistory` ships in the published CLI and runs inside user projects,
// where the same file may well be committed to a remote we do not control.
// This layer is what protects those projects: it bounds and scrubs every
// caller-supplied string before it reaches the line, at the one point both
// engines funnel through (the graph engine reaches it via
// `emitPhaseEvent` -> `appendHistory`).
//
// Scope is `details` only — the untyped, caller-owned bag. `event`,
// `sprintId` and `phase` are identity fields: the engine-conformance harness
// keys history divergences off `event` (conformance.ts FIELD_SPECS), so
// rewriting them would move a comparison channel rather than protect anything.
//
// Both engines share this function, so redaction is symmetric and cannot open
// a conformance divergence between them.

/**
 * Max characters any single `details` string may carry into a persisted line.
 * Generalises the 200-char cap the imperative pipeline already applied to its
 * `userPrompt` field: applying it to EVERY string means a new call site cannot
 * reintroduce an unbounded prompt body just by picking a different key name.
 */
export const MAX_HISTORY_STRING_LENGTH = 200;

/** Written in place of a matched credential. */
export const CREDENTIAL_PLACEHOLDER = "[redacted]";

/** Written in place of a home-directory prefix, which carries the OS username. */
export const HOME_PLACEHOLDER = "<home>";

/** Depth cap for the `details` walk; deeper values are left as-is rather than recursed forever. */
const MAX_REDACT_DEPTH = 8;

/**
 * High-confidence credential shapes. Deliberately narrow — each has a fixed
 * prefix and a length floor, so ordinary prose cannot match. A pattern that
 * guessed at "looks secret" would mangle the audit notes this log exists for.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  // These five prefixes are distinctive enough to match ANYWHERE in the string,
  // including flush against a preceding word character. A `\b` here would be a
  // hole: `\b` needs a non-word char before the prefix, so a token concatenated
  // onto other text would survive.
  /gh[posur]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /Bearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/gi, // Authorization header value

  // Compound vendor prefixes — also safe unanchored; no English word contains them.
  /sk-(?:ant|proj|live|test)-[A-Za-z0-9_-]{8,}/g,

  // Bare `sk-` is the one prefix that DOES occur inside ordinary words:
  // "risk-mitigation-strategy" would otherwise be scrubbed to "ri[redacted]".
  // The lookbehind keeps it delimited. Residual, deliberately accepted: a bare
  // `sk-` key concatenated directly onto a word character is not matched — the
  // compound-prefix rule above covers the real vendor formats, and the log is
  // untracked in this repo regardless (.gitignore).
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g,
];

/** Email addresses — personal data even when they appear inside prose. */
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** POSIX and Windows home prefixes; the segment after the root is the username. */
const HOME_PATTERNS: readonly RegExp[] = [
  /\/(?:Users|home)\/[^/\s"']+/g,
  /[A-Za-z]:\\Users\\[^\\\s"']+/g,
];

/**
 * Scrub, then bound, a single string.
 *
 * Order matters: scrubbing runs BEFORE truncation so a secret straddling the
 * cap cannot survive as a usable prefix.
 *
 * An over-long value keeps its first {@link MAX_HISTORY_STRING_LENGTH}
 * characters and gains a marker carrying the dropped length and a short
 * SHA-256 of the full scrubbed value — enough to correlate two records or spot
 * a changed payload without persisting the body.
 */
export function redactHistoryString(value: string): string {
  let out = value;
  for (const pattern of CREDENTIAL_PATTERNS) out = out.replace(pattern, CREDENTIAL_PLACEHOLDER);
  out = out.replace(EMAIL_PATTERN, CREDENTIAL_PLACEHOLDER);
  for (const pattern of HOME_PATTERNS) out = out.replace(pattern, HOME_PLACEHOLDER);

  if (out.length <= MAX_HISTORY_STRING_LENGTH) return out;

  const digest = createHash("sha256").update(out).digest("hex").slice(0, 12);
  const dropped = out.length - MAX_HISTORY_STRING_LENGTH;
  return `${out.slice(0, MAX_HISTORY_STRING_LENGTH)}[+${dropped} chars, sha256:${digest}]`;
}

/** Recursively apply {@link redactHistoryString} to every string reachable in `value`. */
function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactHistoryString(value);
  if (depth >= MAX_REDACT_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactValue(v, depth + 1)]),
    );
  }
  return value;
}

/**
 * Return `entry` with every string in `details` scrubbed and bounded.
 * Identity fields (`event`, `phase`, `sprintId`, `timestamp`) are returned untouched.
 */
export function redactHistoryEntry(entry: HistoryEntry): HistoryEntry {
  return { ...entry, details: redactValue(entry.details) as Record<string, unknown> };
}

// ── History Operations ──────────────────────────────────────────────

/**
 * Append a history entry to the JSONL log file.
 * After appending, triggers rotation if active history exceeds maxActiveLines.
 * Rotation uses a hardcoded default of 2000 — do NOT call loadConfig here
 * (loadConfig throws when no bober.config.json exists in test fixtures).
 */
export async function appendHistory(
  projectRoot: string,
  entry: HistoryEntry,
): Promise<void> {
  const boberDir = join(projectRoot, BOBER_DIR);
  await ensureDir(boberDir);

  const validation = HistoryEntrySchema.safeParse(entry);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid history entry:\n${issues}`);
  }

  // Validate the CALLER's entry (so a schema error names the caller's mistake),
  // then persist the redacted one.
  const line = JSON.stringify(redactHistoryEntry(entry)) + "\n";
  await appendFile(historyPath(projectRoot), line, "utf-8");

  // Rotate if needed — default limit 2000; no loadConfig call (would throw in test fixtures)
  await rotateIfNeeded(projectRoot, 2000);
}

/**
 * Load all history entries from both archive (if present) and active JSONL logs.
 * Returns entries in chronological order: archive (oldest) first, then active (newest).
 * Skips malformed lines. Signature is unchanged — always returns the full stream.
 */
export async function loadHistory(
  projectRoot: string,
): Promise<HistoryEntry[]> {
  // Read archive (ENOENT is normal on first run — treat as empty)
  let archiveContent = "";
  try {
    archiveContent = await readFile(historyArchivePath(projectRoot), "utf-8");
  } catch {
    // Archive does not exist yet — normal, treat as empty
  }

  // Read active file (ENOENT is normal before first append — treat as empty)
  let activeContent = "";
  try {
    activeContent = await readFile(historyPath(projectRoot), "utf-8");
  } catch {
    // Active file does not exist yet
  }

  // Concatenate: archive (older) first, active (newer) second
  return [...parseEntries(archiveContent), ...parseEntries(activeContent)];
}

/**
 * Load at most `limit` of the most-recent history entries from the ACTIVE log only.
 * Does NOT read from history.archive.jsonl — use loadHistory for the full stream.
 * Returns entries newest-last (ascending chronological order within the tail).
 */
export async function loadRecentHistory(
  projectRoot: string,
  { limit }: { limit: number },
): Promise<HistoryEntry[]> {
  let activeContent: string;
  try {
    activeContent = await readFile(historyPath(projectRoot), "utf-8");
  } catch {
    // Active file does not exist yet
    return [];
  }

  const entries = parseEntries(activeContent);
  // Return the newest `limit` entries (tail of the array), preserving ascending order
  return entries.slice(-limit);
}

// ── Progress Markdown ───────────────────────────────────────────────

/**
 * Update the human-readable progress.md file with current state.
 */
export async function updateProgress(
  projectRoot: string,
  contracts: SprintContract[],
  spec: PlanSpec | null,
): Promise<void> {
  const boberDir = join(projectRoot, BOBER_DIR);
  await ensureDir(boberDir);

  const lines: string[] = [];

  lines.push("# Bober Progress");
  lines.push("");
  lines.push(`Last updated: ${new Date().toISOString()}`);
  lines.push("");

  // Plan summary
  if (spec) {
    lines.push("## Plan");
    lines.push("");
    lines.push(`**${spec.title}**`);
    lines.push("");
    lines.push(spec.description);
    lines.push("");
    lines.push(`- Features: ${spec.features.length}`);
    lines.push(`- Tech stack: ${spec.techStack.join(", ") || "not specified"}`);
    lines.push("");
  }

  // Sprint summary
  lines.push("## Sprints");
  lines.push("");

  if (contracts.length === 0) {
    lines.push("No sprints yet.");
    lines.push("");
  } else {
    // "Passed" row: sprints that settled successfully (passed OR completed —
    // the two engines' words for the same outcome). "Failed" stays a
    // SEPARATE, literal count below — folding it into the settled predicate
    // would double-count every failed sprint in this table.
    const passed = contracts.filter((c) => isSettledContractStatus(c.status)).length;
    const failed = contracts.filter((c) => c.status === "failed").length;
    const inProgress = contracts.filter(
      (c) => c.status === "in-progress" || c.status === "evaluating",
    ).length;
    const pending = contracts.filter(
      (c) =>
        c.status === "proposed" ||
        c.status === "negotiating" ||
        c.status === "agreed",
    ).length;

    lines.push(
      `| Status | Count |`,
    );
    lines.push(`| --- | --- |`);
    lines.push(`| Passed | ${passed} |`);
    lines.push(`| Failed | ${failed} |`);
    lines.push(`| In Progress | ${inProgress} |`);
    lines.push(`| Pending | ${pending} |`);
    lines.push(`| **Total** | **${contracts.length}** |`);
    lines.push("");

    // Individual sprint status
    lines.push("### Sprint Details");
    lines.push("");

    for (const contract of contracts) {
      const statusIcon = getStatusIcon(contract.status);
      lines.push(
        `- ${statusIcon} **${contract.title}** (${contract.contractId})`,
      );
      lines.push(`  - Status: ${contract.status}`);

      const criteriaTotal = contract.successCriteria.length;
      const requiredCount = contract.successCriteria.filter(
        (c) => c.required,
      ).length;
      if (criteriaTotal > 0) {
        lines.push(
          `  - Criteria: ${criteriaTotal} (${requiredCount} required)`,
        );
      }

      if (contract.startedAt) {
        lines.push(`  - Started: ${contract.startedAt}`);
      }
      if (contract.completedAt) {
        lines.push(`  - Completed: ${contract.completedAt}`);
      }
    }
    lines.push("");
  }

  await writeFile(progressPath(projectRoot), lines.join("\n"), "utf-8");
}

/**
 * Exported (not local) so the mapping can be pinned directly against
 * `SETTLED_CONTRACT_STATUSES` rather than a hardcoded literal — see
 * history.test.ts. Before sprint 5 of spec-20260812-terminal-vocabulary this
 * switched on the bare literal `"passed"`, so once `runSprintCycle` and the
 * workflow flusher started writing `"completed"` for a settled sprint, every
 * settled row in `.bober/progress.md` silently fell through to the
 * `default: "[PENDING]"` branch. Routed through `isSettledContractStatus`
 * (the sprint-1 predicate) instead of a literal so a THIRD settled word
 * cannot reintroduce the same defect.
 */
export function getStatusIcon(status: ContractStatus): string {
  if (status === "failed") return "[FAIL]";
  if (status === "in-progress" || status === "evaluating") return "[WIP]";
  if (status === "needs-rework") return "[REWORK]";
  if (isSettledContractStatus(status)) return "[PASS]";
  return "[PENDING]";
}
