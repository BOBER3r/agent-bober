/**
 * Promotion gate orchestration — write pending marker, resolve approve/reject,
 * then on approval call launch; on rejection clean up and return.
 *
 * PURE-ish DI core: all I/O via injected projectRoot paths + approval-state.ts
 * functions + injected confirm / now / launcher. Never reads the real clock
 * (now is injected). Never throws — failures propagate as Promise rejections
 * which the caller (runDo) converts to process.exitCode = 1.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  savePending,
  saveApproved,
  saveRejected,
  deletePending,
} from "../state/approval-state.js";
import type { PromotionPlan } from "./types.js";

// ── GateOutcome ───────────────────────────────────────────────────────

/** Result returned by runPromotionGate after the approve/reject decision. */
export interface GateOutcome {
  approved: boolean;
}

// ── runPromotionGate ──────────────────────────────────────────────────

/** Arguments for runPromotionGate — all I/O dependencies are injected. */
export interface PromotionGateArgs {
  /** Absolute project root (used to build .bober/approvals paths). */
  projectRoot: string;
  /** Finding id — used to derive checkpointId `promote-<findingId>`. */
  findingId: string;
  /** The promotion plan to summarize in the pending marker. */
  plan: PromotionPlan;
  /** When true, bypass interactive prompt and auto-approve. */
  yes?: boolean;
  /**
   * Whether stdout is a TTY. When true and not --yes, calls the injected
   * confirm() and waits for a synchronous answer. When false, polls the
   * approvals directory until an external approve/reject marker appears.
   */
  isTTY: boolean;
  /** Injected interactive confirm. TTY path only; must return true/false. */
  confirm: () => Promise<boolean>;
  /** Clock injection — returns an ISO string. */
  now: () => string;
  /** Non-TTY poll interval in ms. Default 2000ms; use small values in tests. */
  pollMs?: number;
  /** Non-TTY timeout in ms. Default 24 hours. */
  timeoutMs?: number;
}

/**
 * Write promote-<findingId>.pending.json, gate on it
 * (--yes → auto-approve; TTY → prompts(); non-TTY → poll directory),
 * and return { approved }.
 *
 * Writes/deletes markers via approval-state.ts only — no new format.
 * checkpointId is always `promote-${findingId}` so external
 * `bober approve promote-<id>` resolves it (sc-2-5).
 */
export async function runPromotionGate(args: PromotionGateArgs): Promise<GateOutcome> {
  const {
    projectRoot,
    findingId,
    plan,
    yes = false,
    isTTY,
    confirm,
    now,
    pollMs = 2_000,
    timeoutMs = 24 * 60 * 60 * 1_000,
  } = args;

  const checkpointId = `promote-${findingId}`;
  const requestedAt = now();
  const requestedAtMs = Date.parse(requestedAt);
  const timeoutAt = new Date(requestedAtMs + timeoutMs).toISOString();

  // 1. Write the pending marker
  await savePending(projectRoot, {
    checkpointId,
    artifact: { type: "bober-run", summary: plan.task },
    prompt: `Promote to bober run: "${plan.task}"`,
    requestedAt,
    timeoutAt,
  });

  // 2. --yes: auto-approve without prompting
  if (yes) {
    await saveApproved(projectRoot, checkpointId, {
      approvedAt: now(),
      approverId: "auto",
    });
    await deletePending(projectRoot, checkpointId);
    return { approved: true };
  }

  // 3. TTY: interactive confirm
  if (isTTY) {
    const confirmed = await confirm();
    if (confirmed) {
      await saveApproved(projectRoot, checkpointId, {
        approvedAt: now(),
        approverId: "tty",
      });
      await deletePending(projectRoot, checkpointId);
      return { approved: true };
    } else {
      await saveRejected(projectRoot, checkpointId, {
        rejectedAt: now(),
        rejecterId: "tty",
        feedback: "User declined at TTY prompt",
      });
      await deletePending(projectRoot, checkpointId);
      return { approved: false };
    }
  }

  // 4. Non-TTY: poll the approvals directory until resolved or timeout
  //    Mirror: src/orchestrator/checkpoints/mechanisms/disk.ts:104-175
  //    Use Date.now() for elapsed-time tracking (not the injected `now` which is
  //    for file timestamps only and may be frozen in tests).
  const approvalsDir = join(projectRoot, ".bober", "approvals");
  const startedAtMs = Date.now();
  let pollHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    return await new Promise<GateOutcome>((resolve, reject) => {
      const tick = async (): Promise<void> => {
        try {
          const entries = new Set(
            await readdir(approvalsDir).catch(() => [] as string[]),
          );

          if (entries.has(`${checkpointId}.approved.json`)) {
            await deletePending(projectRoot, checkpointId);
            resolve({ approved: true });
            return;
          }

          if (entries.has(`${checkpointId}.rejected.json`)) {
            await deletePending(projectRoot, checkpointId);
            resolve({ approved: false });
            return;
          }

          // Timeout check (wall clock — not the injected now() which is for file timestamps)
          if (Date.now() - startedAtMs >= timeoutMs) {
            await deletePending(projectRoot, checkpointId);
            resolve({ approved: false });
            return;
          }

          // Schedule next tick — never leak timers (disk.ts:170-175)
          pollHandle = setTimeout(() => {
            tick().catch(reject);
          }, pollMs);
        } catch (err) {
          reject(err);
        }
      };

      // Kick off the first tick
      pollHandle = setTimeout(() => {
        tick().catch(reject);
      }, pollMs);
    });
  } finally {
    // Always clear the handle — covers the resolved-before-tick case
    if (pollHandle !== undefined) {
      clearTimeout(pollHandle);
    }
  }
}
