import { readFile, writeFile, readdir, unlink, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

import { ensureDir } from "./helpers.js";

const APPROVAL_DIR = ".bober/approvals";

function approvalsDir(projectRoot: string): string {
  return join(projectRoot, APPROVAL_DIR);
}

function pendingPath(projectRoot: string, id: string): string {
  return join(approvalsDir(projectRoot), `${id}.pending.json`);
}

function approvedPath(projectRoot: string, id: string): string {
  return join(approvalsDir(projectRoot), `${id}.approved.json`);
}

function rejectedPath(projectRoot: string, id: string): string {
  return join(approvalsDir(projectRoot), `${id}.rejected.json`);
}

export interface PendingMarker {
  checkpointId: string;
  runId?: string;
  artifact: { type?: string; path?: string; summary?: string; lines?: number };
  prompt: string;
  requestedAt: string;
  timeoutAt: string;
}

export interface ApprovedMarker {
  approvedAt: string;
  approverId: string;
  editDelta?: unknown;
}

export interface RejectedMarker {
  rejectedAt: string;
  rejecterId: string;
  feedback: string;
}

/**
 * Write a pending approval marker to disk.
 */
export async function savePending(
  projectRoot: string,
  m: PendingMarker,
): Promise<void> {
  await ensureDir(approvalsDir(projectRoot));
  await writeFile(
    pendingPath(projectRoot, m.checkpointId),
    JSON.stringify(m, null, 2) + "\n",
    "utf-8",
  );
}

/**
 * Read a pending approval marker from disk. Returns null if not found.
 */
export async function readPending(
  projectRoot: string,
  id: string,
): Promise<PendingMarker | null> {
  try {
    return JSON.parse(
      await readFile(pendingPath(projectRoot, id), "utf-8"),
    ) as PendingMarker;
  } catch {
    return null;
  }
}

/**
 * List all pending approval markers.
 */
export async function listPending(projectRoot: string): Promise<PendingMarker[]> {
  let entries: string[];
  try {
    entries = await readdir(approvalsDir(projectRoot));
  } catch {
    return [];
  }

  const out: PendingMarker[] = [];
  for (const f of entries.filter((x) => x.endsWith(".pending.json"))) {
    try {
      out.push(
        JSON.parse(
          await readFile(join(approvalsDir(projectRoot), f), "utf-8"),
        ) as PendingMarker,
      );
    } catch {
      // skip corrupted files
    }
  }
  return out;
}

/**
 * Write an approved marker to disk.
 */
export async function saveApproved(
  projectRoot: string,
  id: string,
  m: ApprovedMarker,
): Promise<void> {
  await ensureDir(approvalsDir(projectRoot));
  await writeFile(
    approvedPath(projectRoot, id),
    JSON.stringify(m, null, 2) + "\n",
    "utf-8",
  );
}

/**
 * Write a rejected marker to disk.
 */
export async function saveRejected(
  projectRoot: string,
  id: string,
  m: RejectedMarker,
): Promise<void> {
  await ensureDir(approvalsDir(projectRoot));
  await writeFile(
    rejectedPath(projectRoot, id),
    JSON.stringify(m, null, 2) + "\n",
    "utf-8",
  );
}

/**
 * Delete a pending marker from disk (after resolution). Best-effort — does not throw.
 */
export async function deletePending(projectRoot: string, id: string): Promise<void> {
  await unlink(pendingPath(projectRoot, id)).catch(() => {});
}

/**
 * Check whether a pending marker exists for the given checkpoint id.
 */
export async function pendingExists(
  projectRoot: string,
  id: string,
): Promise<boolean> {
  try {
    await access(pendingPath(projectRoot, id), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cockpit-shape pending row — what both the CLI (--json) and the MCP
 * tool bober_list_pending_approvals should return.
 */
export interface PendingApprovalRow {
  checkpointId: string;
  ageMs: number;
  prompt: string;
}

/**
 * List all pending checkpoints in cockpit-row shape.
 *
 * Mirrors the row-builder loop in src/cli/commands/list-approvals.ts
 * but lives in state/ so both the CLI and the MCP tool can share it.
 * Reads .bober/approvals/*.pending.json.
 *
 * Behavior:
 * - Missing approvals dir → returns [].
 * - Corrupted JSON files → skipped silently (matches CLI behavior).
 * - ageMs = Date.now() - Date.parse(requestedAt).
 */
export async function listPendingApprovals(
  projectRoot: string,
): Promise<PendingApprovalRow[]> {
  let entries: string[];
  try {
    entries = await readdir(approvalsDir(projectRoot));
  } catch {
    return [];
  }
  const rows: PendingApprovalRow[] = [];
  for (const f of entries.filter((x) => x.endsWith(".pending.json"))) {
    try {
      const raw = await readFile(join(approvalsDir(projectRoot), f), "utf-8");
      const parsed = JSON.parse(raw) as {
        checkpointId: string;
        prompt: string;
        requestedAt: string;
      };
      rows.push({
        checkpointId: parsed.checkpointId,
        ageMs: Date.now() - Date.parse(parsed.requestedAt),
        prompt: parsed.prompt,
      });
    } catch {
      // skip corrupted files
    }
  }
  return rows;
}
