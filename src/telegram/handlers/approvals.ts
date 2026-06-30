/**
 * handlers/approvals.ts — Resolve pending disk-marker checkpoints from Telegram
 * inline-keyboard taps. Writes the SAME markers as src/cli/commands/{approve,reject}.ts.
 * No new approval mechanism (nonGoal #1). Replies returned as strings → sendSafe.
 *
 * Multi-turn Adjust/Reject: tapping the button stashes {action, checkpointId} in the
 * ephemeral per-chat pending-callback map; the NEXT plain-text message from that chat
 * resolves it (handleApprovalFollowup). The stash lives only in process memory — no disk.
 *
 * grammy is NOT imported here — this module speaks the neutral types from keyboard.ts
 * (principles.md:28,41).
 */
import { isAllowed } from "../whitelist.js";
import type { AllowedUsers } from "../whitelist.js";
import {
  deletePending,
  pendingExists,
  saveApproved,
  saveRejected,
} from "../../state/approval-state.js";
import type { ApprovedMarker, RejectedMarker } from "../../state/approval-state.js";
import { decodeCallback } from "../keyboard.js";

// ── Ephemeral per-chat pending-callback state ──────────────────────────────

/**
 * Map<chatId, {action, checkpointId}> — Adjust/Reject await a follow-up text.
 * In-memory only; cleared on bot restart. No disk persistence.
 * bober: single-process map; extend to a shared Redis key-value store if the bot
 *        runs across multiple processes (low-probability at current scale).
 */
export type PendingCallbackState = Map<number, { action: "adjust" | "reject"; checkpointId: string }>;

export function createPendingState(): PendingCallbackState {
  return new Map();
}

// ── Button tap (callback_query) ────────────────────────────────────────────

/**
 * Handle a button tap from an inline-keyboard approval message.
 *
 * Returns:
 *   reply  — text to send back via sendSafe (null = nothing to send)
 *   answer — text for answerCallbackQuery (always present to dismiss the spinner)
 *
 * Guard chain (mirrors approve.ts:44):
 *   1. Whitelist re-check on the CALLBACK sender id (sc-4-5).
 *   2. pendingExists guard — write NOTHING if no .pending.json (sc-4-4).
 *   3. Approve  → saveApproved {approvedAt, approverId}; editDelta key ABSENT.
 *   4. Adjust   → stash in pending map; return prompt for replacement text.
 *   5. Reject   → stash in pending map; return prompt for feedback text.
 */
export async function handleApprovalCallback(args: {
  projectRoot: string;
  senderId: number;
  allowed: AllowedUsers;
  chatId: number;
  data: string;
  pending: PendingCallbackState;
  now?: () => string;
}): Promise<{ reply: string | null; answer: string }> {
  // 1. Whitelist re-check on the callback sender id (sc-4-5)
  if (!isAllowed(args.senderId, args.allowed)) {
    return { reply: null, answer: "Denied" };
  }

  const decoded = decodeCallback(args.data);
  if (!decoded) {
    return { reply: null, answer: "Unknown" };
  }

  // 2. No-pending guard (mirror approve.ts:44 — write NOTHING; sc-4-4)
  if (!(await pendingExists(args.projectRoot, decoded.checkpointId))) {
    return { reply: `No pending checkpoint: ${decoded.checkpointId}`, answer: "Gone" };
  }

  const now = args.now ?? (() => new Date().toISOString());

  if (decoded.action === "approve") {
    // Plain Approve: editDelta key MUST be absent (byte-identical to approve.ts:68-72)
    const m: ApprovedMarker = {
      approvedAt: now(),
      approverId: String(args.senderId),
    };
    await saveApproved(args.projectRoot, decoded.checkpointId, m);
    await deletePending(args.projectRoot, decoded.checkpointId);
    return { reply: `Approved ${decoded.checkpointId}`, answer: "Approved" };
  }

  // confirm/cancel are upload opt-in actions (Sprint 5) — not handled here.
  // The poll loop routes them to handleUploadCallback before reaching this handler,
  // but guard defensively so the type narrows to "adjust" | "reject" below.
  if (decoded.action === "confirm" || decoded.action === "cancel") {
    return { reply: null, answer: "Unknown" };
  }

  // Adjust / Reject: stash and await the next text message from this chat
  args.pending.set(args.chatId, {
    action: decoded.action,
    checkpointId: decoded.checkpointId,
  });
  return {
    reply:
      decoded.action === "adjust"
        ? "Send the replacement text."
        : "Send rejection feedback.",
    answer: "OK",
  };
}

// ── Follow-up text resolves a stashed Adjust/Reject ───────────────────────

/**
 * Check whether the incoming plain-text message is a follow-up to a stashed
 * Adjust or Reject tap. If so, resolves it and returns a reply string.
 * Returns null when there is no stash for this chat — the caller falls through
 * to normal text routing (capture / command dispatch).
 *
 * Key invariants:
 *   - Adjust follow-up writes ApprovedMarker with editDelta = text.
 *   - Reject follow-up writes RejectedMarker with rejecterId (NOT rejectorId).
 *   - Both call deletePending after a successful write.
 *   - Non-whitelisted sender: belt-and-suspenders return null without deleting stash
 *     (the outer loop already blocks non-whitelisted messages).
 */
export async function handleApprovalFollowup(args: {
  projectRoot: string;
  senderId: number;
  allowed: AllowedUsers;
  chatId: number;
  text: string;
  pending: PendingCallbackState;
  now?: () => string;
}): Promise<string | null> {
  const stash = args.pending.get(args.chatId);
  if (!stash) return null;

  // Belt-and-suspenders: outer loop already guards, but check here too
  if (!isAllowed(args.senderId, args.allowed)) return null;

  args.pending.delete(args.chatId);

  if (!(await pendingExists(args.projectRoot, stash.checkpointId))) {
    return `No pending checkpoint: ${stash.checkpointId}`;
  }

  const now = args.now ?? (() => new Date().toISOString());

  if (stash.action === "adjust") {
    const m: ApprovedMarker = {
      approvedAt: now(),
      approverId: String(args.senderId),
      editDelta: args.text,
    };
    await saveApproved(args.projectRoot, stash.checkpointId, m);
    await deletePending(args.projectRoot, stash.checkpointId);
    return `Adjusted + approved ${stash.checkpointId}`;
  }

  // reject
  const m: RejectedMarker = {
    rejectedAt: now(),
    rejecterId: String(args.senderId),
    feedback: args.text,
  };
  await saveRejected(args.projectRoot, stash.checkpointId, m);
  await deletePending(args.projectRoot, stash.checkpointId);
  return `Rejected ${stash.checkpointId}`;
}
