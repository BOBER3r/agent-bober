/**
 * Append-only approval audit logger (Sprint 13).
 *
 * Each call to recordApproval() appends ONE JSON line to
 * .bober/audits/<runId>.jsonl. Lines never span. Concurrent appends from
 * multiple async checkpoints serialize via an in-process Promise chain
 * (per-runId mutex — unrelated runs proceed in parallel).
 *
 * File is created with mode 0600 on first append via fs.open with
 * O_WRONLY|O_APPEND|O_CREAT flags. Subsequent appends preserve the mode
 * (kernel does not re-chmod on O_APPEND). appendFile is NOT used because
 * it does not reliably honor the mode argument across all Node versions.
 *
 * POSIX O_APPEND atomicity: single-line records are well under PIPE_BUF
 * (4096 bytes), so cross-process appends are also safe in practice.
 * Multi-process safety is not formally guaranteed beyond PIPE_BUF limits.
 *
 * approverId resolution: chooses a strategy per mechanism name.
 *   1. PR mechanism:    GitHub user from comment/merge actor (passed in).
 *   2. CLI mechanism:   process.env["USER"] || process.env["USERNAME"].
 *   3. disk mechanism:  `git config user.name` then env USER.
 *   4. noop mechanism:  'autopilot'.
 *   5. fallback:        'unknown'.
 *
 * Audit write failures NEVER break the pipeline — the finally block in
 * runWithAudit swallows recordApproval errors via .catch(() => {}).
 *
 * Mechanism fallback chains (cli→noop, pr→disk) are transparent to this
 * module. The audit records the *requested* mechanism name, not the actual
 * fallback that fired inside the mechanism.
 *
 * Sprint 13 — colocated in src/orchestrator/checkpoints/ per Sprints 7-12 precedent.
 */

import { open, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import type { CheckpointOutcome } from "./types.js";
import { logger } from "../../utils/logger.js";

// ── Exported types ───────────────────────────────────────────────────────────

export type ApprovalOutcome = "approved" | "rejected" | "edited" | "aborted";
export type MechanismName = "cli" | "disk" | "pr" | "noop";

export interface EditDeltaSummary {
  /** Number of lines in the after-text. */
  lineCount: number;
  /** First 200 characters of the after-text. */
  firstChars: string;
}

export interface ApprovalRecord {
  /** ISO-8601 timestamp set at write time. */
  timestamp: string;
  runId: string;
  /** Widened to string: CheckpointId values are valid here but not enforced at runtime. */
  checkpointId: string;
  mechanism: MechanismName;
  outcome: ApprovalOutcome;
  approverId: string;
  /** 1-based iteration count (per checkpoint invocation, not global). */
  iteration: number;
  /** First 500 chars of feedback text, if any. */
  feedbackText?: string;
  /** Null when outcome is not 'edited'. */
  editDeltaSummary?: EditDeltaSummary | null;
  durationMs: number;
}

// ── Path helper ───────────────────────────────────────────────────────────────

export function getAuditPath(projectRoot: string, runId: string): string {
  return join(projectRoot, ".bober", "audits", `${runId}.jsonl`);
}

// ── Per-runId mutex (Promise-chain pattern) ──────────────────────────────────
// Mirrors prReadyTimer module-state idiom in mechanisms/pr.ts.
// One chain per runId so unrelated runs proceed in parallel.

const writeChains = new Map<string, Promise<void>>();

// ── Internal: append one JSON line atomically ─────────────────────────────────

async function appendOneLine(projectRoot: string, runId: string, record: ApprovalRecord): Promise<void> {
  const dir = join(projectRoot, ".bober", "audits");
  await mkdir(dir, { recursive: true });
  const path = getAuditPath(projectRoot, runId);

  // Serialize the record — guard against circular references.
  let line: string;
  try {
    line = JSON.stringify(record) + "\n";
  } catch (err) {
    // Circular reference or other serialization failure — write a synthesized fallback.
    const fallback: ApprovalRecord = {
      ...record,
      feedbackText: `AUDIT_SERIALIZE_FAILED: ${err instanceof Error ? err.message : String(err)}`,
    };
    try {
      line = JSON.stringify(fallback) + "\n";
    } catch {
      // Extremely unlikely — give up and write a minimal record.
      line = JSON.stringify({
        timestamp: record.timestamp,
        runId: record.runId,
        checkpointId: record.checkpointId,
        mechanism: record.mechanism,
        outcome: record.outcome,
        approverId: record.approverId,
        iteration: record.iteration,
        durationMs: record.durationMs,
        feedbackText: "AUDIT_SERIALIZE_FAILED_UNRECOVERABLE",
      }) + "\n";
    }
  }

  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT;
  const fh = await open(path, flags, 0o600);
  try {
    // Guarantee mode 0600 even if umask would have reduced it.
    await fh.chmod(0o600);
    await fh.write(line);
  } finally {
    await fh.close();
  }
}

// ── Public: recordApproval ────────────────────────────────────────────────────

/**
 * Append one ApprovalRecord to .bober/audits/<runId>.jsonl.
 *
 * Writes are serialized per-runId via a Promise chain so concurrent async
 * callers for the same run never interleave partial lines.
 *
 * Propagates errors to the caller but does NOT break the chain — subsequent
 * appends for the same runId will still proceed.
 */
export async function recordApproval(
  projectRoot: string,
  runId: string,
  record: ApprovalRecord,
): Promise<void> {
  const prev = writeChains.get(runId) ?? Promise.resolve();
  const next = prev.then(() => appendOneLine(projectRoot, runId, record));
  // Swallow errors in the chain pointer so subsequent appends aren't blocked,
  // but propagate the real error to THIS caller via `next`.
  writeChains.set(runId, next.catch(() => {}));
  return next;
}

// ── Public: resolveApproverId ─────────────────────────────────────────────────

/**
 * Resolve the identity of the approver from the mechanism name and optional hint.
 *
 * Resolution chain (per generatorNotes):
 *   1. pr  → `hint` (GitHub actor passed by caller) or 'github:unknown'
 *   2. cli → process.env["USER"] || process.env["USERNAME"] || 'unknown'
 *   3. disk → `git config user.name` (with 5s timeout, reject:false) → env USER → 'unknown'
 *   4. noop → 'autopilot'
 *   5. fallback → 'unknown'
 */
export async function resolveApproverId(
  mechanism: MechanismName,
  hint?: string,
): Promise<string> {
  switch (mechanism) {
    case "pr": {
      return hint ?? "github:unknown";
    }
    case "cli": {
      return process.env["USER"] ?? process.env["USERNAME"] ?? "unknown";
    }
    case "disk": {
      // Try git config user.name first.
      try {
        const r = await execa("git", ["config", "user.name"], {
          reject: false,
          timeout: 5000,
        });
        if (r.exitCode === 0 && r.stdout.trim().length > 0) {
          return r.stdout.trim();
        }
      } catch {
        // git not available — fall through.
      }
      return process.env["USER"] ?? process.env["USERNAME"] ?? "unknown";
    }
    case "noop": {
      return "autopilot";
    }
    default: {
      return "unknown";
    }
  }
}

// ── Public: summarizeEditDelta ────────────────────────────────────────────────

/**
 * Extract a compact summary from an editDelta value.
 * Returns null if the value cannot be coerced to a meaningful string.
 *
 * Rules:
 * - string editDelta → after-text is the string itself
 * - { after: string } → use `after`
 * - { before, after } or any other object → JSON.stringify
 * - null/undefined → null
 */
export function summarizeEditDelta(editDelta: unknown): EditDeltaSummary | null {
  if (editDelta === null || editDelta === undefined) {
    return null;
  }

  let afterText: string;
  if (typeof editDelta === "string") {
    afterText = editDelta;
  } else if (
    typeof editDelta === "object" &&
    "after" in (editDelta as Record<string, unknown>) &&
    typeof (editDelta as Record<string, unknown>)["after"] === "string"
  ) {
    afterText = (editDelta as Record<string, unknown>)["after"] as string;
  } else {
    try {
      afterText = JSON.stringify(editDelta);
    } catch {
      return null;
    }
  }

  return {
    lineCount: afterText.split("\n").length,
    firstChars: afterText.slice(0, 200),
  };
}

// ── Public: truncateFeedback ─────────────────────────────────────────────────

/**
 * Truncate feedback text to 500 characters to minimize PII surface in the audit log.
 * Returns undefined if the input is undefined.
 */
export function truncateFeedback(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  return s.slice(0, 500);
}

// ── Public: runWithAudit ─────────────────────────────────────────────────────

/**
 * Wrap a mechanism.request() call with audit accounting in a try/finally.
 *
 * This is the canonical seam (B) — every caller (pipeline.ts × 9 sites,
 * feedback-router's runCheckpointWithFeedback) calls runWithAudit instead
 * of mechanism.request() directly. The wrapper owns the try/finally so the
 * audit entry is recorded even when the mechanism throws.
 *
 * Outcome mapping:
 *   { approved: true }  → 'approved'
 *   { approved: false } → 'rejected' (feedbackText from outcome.feedback)
 *   { edit: true }      → 'edited'   (editDeltaSummary from outcome.editDelta)
 *   thrown error        → 'aborted'  (feedbackText from err.message)
 *
 * Audit write failures NEVER break the pipeline — they are swallowed via
 * .catch(() => {}) after a logger.warn. The mechanism's outcome is always
 * returned to the caller.
 *
 * Re-throws the original error after writing the audit entry so callers see
 * the mechanism failure.
 */
export async function runWithAudit<T extends CheckpointOutcome>(opts: {
  projectRoot: string;
  runId: string;
  checkpointId: string;
  mechanism: MechanismName;
  iteration: number;
  approverHint?: string;
  fn: () => Promise<T>;
}): Promise<T> {
  const start = Date.now();
  let outcome: ApprovalOutcome = "aborted";
  let feedbackText: string | undefined;
  let editDeltaSummary: EditDeltaSummary | null = null;
  let thrown: unknown;
  let result: T | undefined;

  try {
    result = await opts.fn();

    // Narrow the CheckpointOutcome discriminated union.
    if ("approved" in result && result.approved === true) {
      outcome = "approved";
    } else if ("approved" in result && result.approved === false) {
      outcome = "rejected";
      feedbackText = truncateFeedback((result as { approved: false; feedback: string }).feedback);
    } else if ("edit" in result && (result as { edit: true; editDelta: unknown }).edit === true) {
      outcome = "edited";
      editDeltaSummary = summarizeEditDelta((result as { edit: true; editDelta: unknown }).editDelta);
    }
  } catch (err) {
    thrown = err;
    outcome = "aborted";
    feedbackText = truncateFeedback(err instanceof Error ? err.message : String(err));
  } finally {
    const approverId = await resolveApproverId(opts.mechanism, opts.approverHint).catch(() => "unknown");
    const record: ApprovalRecord = {
      timestamp: new Date().toISOString(),
      runId: opts.runId,
      checkpointId: opts.checkpointId,
      mechanism: opts.mechanism,
      outcome,
      approverId,
      iteration: opts.iteration,
      feedbackText,
      editDeltaSummary,
      durationMs: Date.now() - start,
    };

    // Audit write failures MUST never break the pipeline.
    await recordApproval(opts.projectRoot, opts.runId, record).catch((err: unknown) => {
      logger.warn(
        `[audit] Failed to write audit entry for ${opts.checkpointId}/${opts.runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  if (thrown !== undefined) throw thrown;
  return result as T;
}
