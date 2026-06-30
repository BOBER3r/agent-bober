import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { savePending } from "../../state/approval-state.js";
import type { PendingMarker } from "../../state/approval-state.js";
import { encodeCallback } from "../keyboard.js";
import { parseAllowedUsers } from "../whitelist.js";
import {
  createPendingState,
  handleApprovalCallback,
  handleApprovalFollowup,
} from "./approvals.js";

// ── Test fixtures ──────────────────────────────────────────────────────────

let tmpRoot: string;
let approvalsDir: string;

const ALLOWED = parseAllowedUsers({ TELEGRAM_ALLOWED_USERS: "42" }); // sender 42 is whitelisted
const NOW = () => "2026-06-30T12:00:00.000Z";

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-tg-approvals-test-"));
  approvalsDir = join(tmpRoot, ".bober", "approvals");
  await mkdir(approvalsDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

const fixturePending = (id: string): PendingMarker => ({
  checkpointId: id,
  artifact: { type: "calendar-plan" },
  prompt: "Approve plan",
  requestedAt: NOW(),
  timeoutAt: NOW(),
});

const fileExists = async (rel: string): Promise<boolean> =>
  readFile(join(approvalsDir, rel), "utf-8").then(
    () => true,
    () => false,
  );

// ── sc-4-2: Approve writes correct ApprovedMarker ─────────────────────────

describe("sc-4-2: Approve", () => {
  it("writes <id>.approved.json with approvedAt + approverId (editDelta key absent)", async () => {
    await savePending(tmpRoot, fixturePending("calendar-x"));
    const pending = createPendingState();

    await handleApprovalCallback({
      projectRoot: tmpRoot,
      senderId: 42,
      allowed: ALLOWED,
      chatId: 7,
      data: encodeCallback("approve", "calendar-x"),
      pending,
      now: NOW,
    });

    const m = JSON.parse(await readFile(join(approvalsDir, "calendar-x.approved.json"), "utf-8"));
    // byte-shape must match approve.ts: {approvedAt, approverId} — no editDelta key
    expect(m).toEqual({ approvedAt: NOW(), approverId: "42" });
  });

  it("deletes the pending marker after approval", async () => {
    await savePending(tmpRoot, fixturePending("calendar-x"));
    const pending = createPendingState();

    await handleApprovalCallback({
      projectRoot: tmpRoot,
      senderId: 42,
      allowed: ALLOWED,
      chatId: 7,
      data: encodeCallback("approve", "calendar-x"),
      pending,
      now: NOW,
    });

    expect(await fileExists("calendar-x.pending.json")).toBe(false);
  });
});

// ── sc-4-3: Reject and Adjust multi-turn ──────────────────────────────────

describe("sc-4-3a: Reject", () => {
  it("feedback tap + follow-up text writes <id>.rejected.json with rejecterId + feedback", async () => {
    await savePending(tmpRoot, fixturePending("calendar-y"));
    const pending = createPendingState();

    await handleApprovalCallback({
      projectRoot: tmpRoot,
      senderId: 42,
      allowed: ALLOWED,
      chatId: 7,
      data: encodeCallback("reject", "calendar-y"),
      pending,
      now: NOW,
    });

    // Approve marker must NOT exist yet (stashed, not resolved)
    expect(await fileExists("calendar-y.rejected.json")).toBe(false);
    expect(pending.size).toBe(1);

    await handleApprovalFollowup({
      projectRoot: tmpRoot,
      senderId: 42,
      allowed: ALLOWED,
      chatId: 7,
      text: "scope too broad",
      pending,
      now: NOW,
    });

    const m = JSON.parse(await readFile(join(approvalsDir, "calendar-y.rejected.json"), "utf-8"));
    // byte-shape must match reject.ts: {rejectedAt, rejecterId, feedback}
    expect(m).toEqual({ rejectedAt: NOW(), rejecterId: "42", feedback: "scope too broad" });
  });

  it("field is rejecterId (not rejectorId or approverId)", async () => {
    await savePending(tmpRoot, fixturePending("calendar-r"));
    const pending = createPendingState();

    await handleApprovalCallback({
      projectRoot: tmpRoot,
      senderId: 42,
      allowed: ALLOWED,
      chatId: 7,
      data: encodeCallback("reject", "calendar-r"),
      pending,
      now: NOW,
    });

    await handleApprovalFollowup({
      projectRoot: tmpRoot,
      senderId: 42,
      allowed: ALLOWED,
      chatId: 7,
      text: "not ready",
      pending,
      now: NOW,
    });

    const m = JSON.parse(await readFile(join(approvalsDir, "calendar-r.rejected.json"), "utf-8"));
    expect("rejecterId" in m).toBe(true);
    expect("rejectorId" in m).toBe(false);
    expect("approverId" in m).toBe(false);
  });
});

describe("sc-4-3b: Adjust", () => {
  it("adjust tap + follow-up text writes approved marker with editDelta == that text", async () => {
    await savePending(tmpRoot, fixturePending("calendar-z"));
    const pending = createPendingState();

    await handleApprovalCallback({
      projectRoot: tmpRoot,
      senderId: 42,
      allowed: ALLOWED,
      chatId: 7,
      data: encodeCallback("adjust", "calendar-z"),
      pending,
      now: NOW,
    });

    // No approved marker yet — stash awaits follow-up
    expect(await fileExists("calendar-z.approved.json")).toBe(false);
    expect(pending.size).toBe(1);

    await handleApprovalFollowup({
      projectRoot: tmpRoot,
      senderId: 42,
      allowed: ALLOWED,
      chatId: 7,
      text: "move to Friday 3pm",
      pending,
      now: NOW,
    });

    const m = JSON.parse(await readFile(join(approvalsDir, "calendar-z.approved.json"), "utf-8"));
    expect(m).toEqual({ approvedAt: NOW(), approverId: "42", editDelta: "move to Friday 3pm" });
  });
});

// ── sc-4-4: No pending marker → write nothing ─────────────────────────────

describe("sc-4-4: no pending marker", () => {
  it("callback for a checkpoint with no .pending.json writes no marker", async () => {
    const pending = createPendingState();

    await handleApprovalCallback({
      projectRoot: tmpRoot,
      senderId: 42,
      allowed: ALLOWED,
      chatId: 7,
      data: encodeCallback("approve", "ghost"),
      pending,
      now: NOW,
    });

    expect(await fileExists("ghost.approved.json")).toBe(false);
    expect(await fileExists("ghost.rejected.json")).toBe(false);
  });

  it("callback for missing pending returns a 'Gone' answer and does not stash", async () => {
    const pending = createPendingState();

    const result = await handleApprovalCallback({
      projectRoot: tmpRoot,
      senderId: 42,
      allowed: ALLOWED,
      chatId: 7,
      data: encodeCallback("reject", "ghost"),
      pending,
      now: NOW,
    });

    expect(result.answer).toBe("Gone");
    expect(pending.size).toBe(0);
  });
});

// ── sc-4-5: Non-whitelisted callback → write nothing, no stash ────────────

describe("sc-4-5: non-whitelisted callback", () => {
  it("callback from non-whitelisted id writes no marker", async () => {
    await savePending(tmpRoot, fixturePending("calendar-x"));
    const pending = createPendingState();

    await handleApprovalCallback({
      projectRoot: tmpRoot,
      senderId: 999, // not in ALLOWED
      allowed: ALLOWED,
      chatId: 7,
      data: encodeCallback("approve", "calendar-x"),
      pending,
      now: NOW,
    });

    expect(await fileExists("calendar-x.approved.json")).toBe(false);
  });

  it("non-whitelisted callback does not stash a pending-callback entry", async () => {
    await savePending(tmpRoot, fixturePending("calendar-x"));
    const pending = createPendingState();

    await handleApprovalCallback({
      projectRoot: tmpRoot,
      senderId: 999,
      allowed: ALLOWED,
      chatId: 7,
      data: encodeCallback("adjust", "calendar-x"),
      pending,
      now: NOW,
    });

    expect(pending.size).toBe(0);
  });

  it("non-whitelisted reject callback writes no marker and no stash", async () => {
    await savePending(tmpRoot, fixturePending("calendar-x"));
    const pending = createPendingState();

    const result = await handleApprovalCallback({
      projectRoot: tmpRoot,
      senderId: 999,
      allowed: ALLOWED,
      chatId: 7,
      data: encodeCallback("reject", "calendar-x"),
      pending,
      now: NOW,
    });

    expect(result.answer).toBe("Denied");
    expect(await fileExists("calendar-x.rejected.json")).toBe(false);
    expect(pending.size).toBe(0);
  });
});

// ── handleApprovalFollowup: no stash → returns null ───────────────────────

describe("handleApprovalFollowup: no stash", () => {
  it("returns null when there is no stashed action for the chatId", async () => {
    const pending = createPendingState();

    const result = await handleApprovalFollowup({
      projectRoot: tmpRoot,
      senderId: 42,
      allowed: ALLOWED,
      chatId: 99,
      text: "some text",
      pending,
      now: NOW,
    });

    expect(result).toBeNull();
  });
});
