/**
 * handlers/upload.ts — Per-upload opt-in gate for document → src/medical ingest.
 *
 * Telegram is NOT end-to-end encrypted. A document is NEVER downloaded or passed to
 * any medical code until the user taps an explicit Yes. The ingest fn and download fn
 * are INJECTED so tests use spies (no grammy, no network, no real medical pipeline).
 * grammy stays in bot.ts only (principles.md:28).
 *
 * Privacy invariants enforced here:
 *   - No download before Yes (sc-5-2, sc-5-4).
 *   - ingest called exactly once on Yes, never on No or no-confirm (sc-5-3, sc-5-4).
 *   - Post-ingest reply carries only a NON-SENSITIVE integer count (sc-5-5, nonGoal #3).
 *   - Temp file is always removed in a finally block — no PHI persists on disk (nonGoal #4).
 *
 * The existing medical egress/consent guardrails (EgressGuard, ConsentGate, AuditLog)
 * run inside the subprocess — they are NOT duplicated here (nonGoal #5).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";

import { isAllowed } from "../whitelist.js";
import type { AllowedUsers } from "../whitelist.js";
import { decodeCallback } from "../keyboard.js";
import { findProjectRoot } from "../../utils/fs.js";
import { resolveCliEntry } from "../../fleet/runner.js";

// ── Injected deps (testability) ───────────────────────────────────────

/**
 * Downloads the Telegram file_id to destPath.
 * Production default: transport.downloadDocument (grammy wired in bot.ts).
 * Tests: spy that records calls without any network or disk access.
 */
export type DownloadFn = (fileId: string, destPath: string) => Promise<void>;

/**
 * Hands a LOCAL file path to the existing src/medical ingest path.
 * Returns a NON-SENSITIVE count — never marker values/names (nonGoal #3).
 * Production default: defaultMedicalIngest (execa subprocess below).
 * Tests: spy that returns fixture counts without spawning any subprocess.
 */
export type MedicalIngest = (filePath: string) => Promise<{ recordsParsed: number; newRows: number }>;

// ── Ephemeral pending-upload state (mirror approvals.ts:32-36) ────────

/**
 * In-memory stash of pending upload confirmations keyed by uploadId.
 * Created in the loop, cleared on restart, never written to disk.
 *
 * bober: single-process map; extend to a shared Redis key-value store if the bot
 *        runs across multiple processes (low-probability at current scale).
 */
export type PendingUpload = { fileId: string; fileName: string; chatId: number };
export type PendingUploadState = Map<string, PendingUpload>;

export function createPendingUploadState(): PendingUploadState {
  return new Map();
}

// ── Prompt + reply text (sc-5-5) ──────────────────────────────────────

/**
 * The LOCAL medical ingest destination disclosed to the user BEFORE confirmation.
 * Named as a constant so unit tests can assert it is present in the prompt text
 * without hardcoding the exact string in both the handler and the test.
 */
export const LOCAL_INGEST_DEST = ".bober/medical (local health store)";

/**
 * Build the per-upload opt-in prompt that is shown BEFORE any download.
 * Must name the local ingest destination and disclose the non-E2E nature of Telegram
 * so consent is fully informed (sc-5-5).
 */
export function buildUploadPrompt(fileName: string): string {
  return (
    `Telegram is not end-to-end encrypted. ` +
    `Send "${fileName}" to the LOCAL medical ingest (${LOCAL_INGEST_DEST})? ` +
    `Nothing is processed until you tap Yes.`
  );
}

// ── registerUpload — stash + return prompt (NO download here) ─────────

/**
 * Called when a document message arrives from a whitelisted user.
 * Stashes the upload in the ephemeral pending map and returns the opt-in prompt.
 * The file is NOT downloaded at this point — download happens only after Yes (sc-5-2).
 */
export function registerUpload(args: {
  uploadId: string;
  chatId: number;
  fileId: string;
  fileName: string;
  pending: PendingUploadState;
}): { reply: string } {
  args.pending.set(args.uploadId, {
    fileId: args.fileId,
    fileName: args.fileName,
    chatId: args.chatId,
  });
  return { reply: buildUploadPrompt(args.fileName) };
}

// ── handleUploadCallback — Yes/No resolution ──────────────────────────

/**
 * Handle a Yes (confirm) or No (cancel) button tap for a pending upload.
 *
 * On Yes (confirm):
 *   1. Look up the stash; consume it (single-shot).
 *   2. Download the file to a temporary directory via the injected download fn.
 *   3. Pass the local path to the injected ingest fn exactly once.
 *   4. Reply with a NON-SENSITIVE count only — never marker values/names (sc-5-5, nonGoal #3).
 *   5. Remove the temp directory in a finally block (nonGoal #4).
 *
 * On No (cancel) or missing stash:
 *   - Ingest fn is NEVER called (sc-5-4).
 *   - Download fn is NEVER called.
 *   - Any ephemeral stash entry is discarded.
 *
 * Whitelist re-check on the callback sender id (mirror approvals.ts:63-66, sc-4-5 analog).
 */
export async function handleUploadCallback(args: {
  senderId: number;
  allowed: AllowedUsers;
  data: string;
  pending: PendingUploadState;
  download: DownloadFn;
  ingest: MedicalIngest;
}): Promise<{ reply: string | null; answer: string }> {
  // 1. Whitelist re-check on the callback sender id (defense-in-depth)
  if (!isAllowed(args.senderId, args.allowed)) {
    return { reply: null, answer: "Denied" };
  }

  const decoded = decodeCallback(args.data);
  if (!decoded) {
    return { reply: null, answer: "Unknown" };
  }

  const up = args.pending.get(decoded.checkpointId);
  if (!up) {
    return { reply: "Upload expired or already handled.", answer: "Gone" };
  }
  // Single-shot: consume the stash immediately so a duplicate tap is a no-op
  args.pending.delete(decoded.checkpointId);

  // No (cancel) → discard; do NOT download or ingest (sc-5-4)
  if (decoded.action === "cancel") {
    return { reply: "Discarded — nothing was ingested.", answer: "Cancelled" };
  }

  // Yes (confirm) → download then ingest exactly once (sc-5-3)
  const dir = await mkdtemp(join(tmpdir(), "bober-tg-upload-"));
  const dest = join(dir, up.fileName);
  try {
    await args.download(up.fileId, dest);
    const { newRows } = await args.ingest(dest);
    // Reply with a NON-SENSITIVE count only — no marker values/names echoed (sc-5-5, nonGoal #3)
    return {
      reply: `Imported ${newRows} results into local medical store.`,
      answer: "Imported",
    };
  } finally {
    // Always remove the temp dir — no PHI bytes remain on disk after ingest (nonGoal #4)
    await rm(dir, { recursive: true, force: true });
  }
}

// ── defaultMedicalIngest — execa subprocess (§3b) ─────────────────────

/**
 * Production MedicalIngest — invokes `agent-bober medical import <filePath>` in a
 * subprocess via execa. The subprocess runs the full medical pipeline including all
 * EgressGuard / ConsentGate / AuditLog guardrails, keeping them authoritative in the
 * child process (nonGoal #5). This mirrors defaultPrioritize in prioritize.ts.
 *
 * Parses the non-sensitive count from stdout:
 *   records parsed: <N>
 *   new rows:       <M>
 * (see src/cli/commands/medical.ts:255-257 for the exact format)
 *
 * bober: one child process per upload confirmation; swap for in-process
 *        IngestionNormalizer.importFile() if subprocess startup latency
 *        exceeds acceptable Telegram response time under load.
 */
export async function defaultMedicalIngest(
  filePath: string,
): Promise<{ recordsParsed: number; newRows: number }> {
  const projectRoot = (await findProjectRoot()) ?? process.cwd();
  const cliEntry = resolveCliEntry();

  const r = await execa(process.execPath, [cliEntry, "medical", "import", filePath], {
    cwd: projectRoot,
    reject: false,
    all: true,
  });

  if (r.exitCode !== 0) {
    const out = (r.all ?? "").slice(0, 300);
    throw new Error(`medical import failed (exit ${r.exitCode ?? -1}): ${out}`);
  }

  const parsedMatch = /records parsed:\s*(\d+)/.exec(r.stdout ?? "");
  const rowsMatch = /new rows:\s*(\d+)/.exec(r.stdout ?? "");
  return {
    recordsParsed: parsedMatch ? Number(parsedMatch[1]) : 0,
    newRows: rowsMatch ? Number(rowsMatch[1]) : 0,
  };
}
