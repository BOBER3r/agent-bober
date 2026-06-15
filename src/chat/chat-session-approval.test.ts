// ── chat-session-approval.test.ts ────────────────────────────────────
//
// Tests that ChatSession.handleTurn surfaces pending approval notices
// (sc-2-5), dedupes them (sc-2-6), reflects RunState fields (sc-2-7),
// and is a no-op when no markers exist (sc-2-8).
//
// Sprint 3 tests: handleApprove/handleReject write-path (sc-3-4, sc-3-5),
// NL classify routing + single/ambiguous resolve (sc-3-6),
// RunState clear + /help HELP_TEXT (sc-3-7),
// DiskCheckpointMechanism round-trip integration (sc-3-5).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChatSession } from "./chat-session.js";
import { RosterReader } from "./roster-reader.js";
import { writeRunState, readRunState } from "../state/run-state.js";
import type { LLMClient } from "../providers/types.js";
import type { RunState } from "../mcp/run-manager.js";
import type { PendingMarker } from "../state/approval-state.js";
import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { DiskCheckpointMechanism } from "../orchestrator/checkpoints/mechanisms/disk.js";
import type { CheckpointId } from "../orchestrator/checkpoints/types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-session-approval-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────

/** Minimal LLM that classifies as "answer" and returns a fixed reply. */
function makeAnswerLLM(replyText: string): LLMClient {
  let callCount = 0;
  return {
    chat: async () => {
      callCount++;
      if (callCount === 1) {
        return {
          text: JSON.stringify({ action: "answer" }),
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        };
      }
      return {
        text: replyText,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    },
  } as unknown as LLMClient;
}

/** Build a synthetic PendingMarker. */
function makeMarker(
  o?: Partial<{
    checkpointId: string;
    runId: string;
    prompt: string;
    requestedAt: string;
  }>,
): PendingMarker {
  const now = new Date().toISOString();
  return {
    checkpointId: "cp-test",
    artifact: { type: "research-doc" },
    prompt: "Approve this action",
    requestedAt: now,
    timeoutAt: now,
    ...o,
  };
}

/** Write a .pending.json file directly to the approvals dir (no write fns). */
async function injectPending(root: string, m: PendingMarker): Promise<void> {
  const dir = join(root, ".bober", "approvals");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${m.checkpointId}.pending.json`),
    JSON.stringify(m, null, 2),
    "utf-8",
  );
}

/** Write a running RunState for the given runId. */
async function injectRunningRun(root: string, runId: string): Promise<RunState> {
  const state: RunState = {
    runId,
    task: `Task for ${runId}`,
    status: "running",
    startedAt: new Date().toISOString(),
    progress: { completed: 0, total: 1 },
    projectRoot: root,
  };
  await writeRunState(root, state);
  return state;
}

// ── sc-2-5: notice weaved into reply naming runId + checkpointId + prompt ─

describe("sc-2-5: approval notice surfaced in handleTurn", () => {
  it("weaves a notice naming runId, checkpointId, and prompt into the LLM reply", async () => {
    const runId = "run-approval-test";
    const checkpointId = "cp-sc25";
    const prompt = "Please review the research document";

    const marker = makeMarker({ checkpointId, runId, prompt });
    await injectPending(tmpDir, marker);
    await injectRunningRun(tmpDir, runId);

    const llm = makeAnswerLLM("Normal answer.");
    const session = new ChatSession({
      llm,
      projectRoot: tmpDir,
      sessionId: "test-sc25",
    });

    const reply = await session.handleTurn("What is going on?");

    expect(reply).not.toBeNull();
    expect(reply).toContain(runId);
    expect(reply).toContain(checkpointId);
    expect(reply).toContain(prompt);
  });

  it("weaves notice for a marker with no runId (shows 'unknown')", async () => {
    const checkpointId = "cp-no-run";
    const prompt = "Approve this anonymous gate";

    const marker = makeMarker({ checkpointId, prompt }); // no runId
    await injectPending(tmpDir, marker);

    const llm = makeAnswerLLM("Normal answer.");
    const session = new ChatSession({
      llm,
      projectRoot: tmpDir,
      sessionId: "test-no-run",
    });

    const reply = await session.handleTurn("What is going on?");

    expect(reply).not.toBeNull();
    expect(reply).toContain("unknown");
    expect(reply).toContain(checkpointId);
    expect(reply).toContain(prompt);
  });
});

// ── sc-2-6: announce-once dedupe across turns ─────────────────────────

describe("sc-2-6: announce-once dedupe", () => {
  it("announces a marker on the first turn but not the second", async () => {
    const runId = "run-dedupe-approval";
    const checkpointId = "cp-dedupe";
    const marker = makeMarker({ checkpointId, runId });

    await injectPending(tmpDir, marker);
    await injectRunningRun(tmpDir, runId);

    // LLM needs to be called twice per turn (classify + answer)
    let callCount = 0;
    const llm: LLMClient = {
      chat: async () => {
        callCount++;
        // odd calls = classify, even calls = answer
        if (callCount % 2 === 1) {
          return {
            text: JSON.stringify({ action: "answer" }),
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          };
        }
        return {
          text: "Answer text.",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        };
      },
    } as unknown as LLMClient;

    const session = new ChatSession({
      llm,
      projectRoot: tmpDir,
      sessionId: "test-dedupe",
    });

    const reply1 = await session.handleTurn("First turn");
    expect(reply1).toContain(checkpointId);

    // Marker is still present on disk — but cursor should suppress re-announce
    const reply2 = await session.handleTurn("Second turn");
    expect(reply2).not.toContain(checkpointId);
  });
});

// ── sc-2-7: RunState reflection + roster [INPUT-REQUIRED] ────────────

describe("sc-2-7: RunState reflection and roster summary", () => {
  it("reflects status=input-required and pending fields onto the RunState after handleTurn", async () => {
    const runId = "run-reflect";
    const checkpointId = "cp-reflect";
    const prompt = "Approve the artifact";
    const requestedAt = "2026-06-15T10:00:00.000Z";

    const marker = makeMarker({ checkpointId, runId, prompt, requestedAt });
    await injectPending(tmpDir, marker);
    await injectRunningRun(tmpDir, runId);

    const llm = makeAnswerLLM("Done.");
    const session = new ChatSession({
      llm,
      projectRoot: tmpDir,
      sessionId: "test-reflect",
    });

    await session.handleTurn("Any updates?");

    const after = await readRunState(tmpDir, runId);
    expect(after).not.toBeNull();
    expect(after?.status).toBe("input-required");
    expect(after?.pendingCheckpointId).toBe(checkpointId);
    expect(after?.pendingPrompt).toBe(prompt);
    expect(after?.pendingSince).toBe(requestedAt);
  });

  it("roster summarize shows [INPUT-REQUIRED] for the correlated run", async () => {
    const runId = "run-roster-ir";
    const checkpointId = "cp-roster";
    const prompt = "Approve roster test";

    const marker = makeMarker({ checkpointId, runId, prompt });
    await injectPending(tmpDir, marker);
    await injectRunningRun(tmpDir, runId);

    const llm = makeAnswerLLM("Done.");
    const session = new ChatSession({
      llm,
      projectRoot: tmpDir,
      sessionId: "test-roster-ir",
    });

    await session.handleTurn("Check runs.");

    // After the turn the RunState should be input-required
    const roster = new RosterReader(tmpDir);
    const states = await roster.read();
    const summary = roster.summarize(states);

    expect(summary).toContain("[INPUT-REQUIRED]");
    expect(summary).toContain(runId);
  });

  it("does NOT clobber a completed RunState", async () => {
    const runId = "run-completed";
    const checkpointId = "cp-clobber";

    const marker = makeMarker({ checkpointId, runId });
    await injectPending(tmpDir, marker);

    // Write a completed (not running) RunState — must not be clobbered
    const completedState: RunState = {
      runId,
      task: "Done task",
      status: "completed",
      startedAt: "2026-06-15T00:00:00.000Z",
      completedAt: "2026-06-15T01:00:00.000Z",
      progress: { completed: 1, total: 1 },
      projectRoot: tmpDir,
    };
    await writeRunState(tmpDir, completedState);

    const llm = makeAnswerLLM("Done.");
    const session = new ChatSession({
      llm,
      projectRoot: tmpDir,
      sessionId: "test-clobber",
    });

    await session.handleTurn("Any updates?");

    const after = await readRunState(tmpDir, runId);
    // Should remain completed — never clobbered by the approval reflection
    expect(after?.status).toBe("completed");
  });
});

// ── sc-2-8: no-pending is identical to Phase 1 ───────────────────────

describe("sc-2-8: no pending markers — phase-1 parity", () => {
  it("returns exactly the LLM reply with no approval prefix when no markers exist", async () => {
    const llm = makeAnswerLLM("Just a normal answer.");
    const session = new ChatSession({
      llm,
      projectRoot: tmpDir,
      sessionId: "no-pending-test",
    });

    const reply = await session.handleTurn("How are things?");

    expect(reply).not.toBeNull();
    expect(reply).toBe("Just a normal answer.");
  });

  it("returns exactly the LLM reply when .bober/approvals dir does not exist", async () => {
    // No approvals dir at all
    const llm = makeAnswerLLM("Plain answer.");
    const session = new ChatSession({
      llm,
      projectRoot: tmpDir,
      sessionId: "missing-dir-test",
    });

    const reply = await session.handleTurn("What is up?");
    expect(reply).toBe("Plain answer.");
  });
});

// ── sc-3-4: /approve writes marker or guards missing pending ──────────

describe("sc-3-4: handleApprove via /approve slash command", () => {
  it("writes .approved.json with approverId when pending marker exists", async () => {
    const checkpointId = "post-plan";
    const marker = makeMarker({ checkpointId });
    await injectPending(tmpDir, marker);

    const llm = makeAnswerLLM("answer");
    const session = new ChatSession({ llm, projectRoot: tmpDir, sessionId: "s34-approve" });

    const reply = await session.handleTurn(`/approve ${checkpointId}`);

    expect(reply).toContain("Approved checkpoint post-plan");

    // Assert .approved.json was written
    const approvedPath = join(tmpDir, ".bober", "approvals", `${checkpointId}.approved.json`);
    const raw = await readFile(approvedPath, "utf-8");
    const parsed = JSON.parse(raw) as { approvedAt: string; approverId: string };
    expect(typeof parsed.approvedAt).toBe("string");
    expect(typeof parsed.approverId).toBe("string");
  });

  it("returns clear message and writes NOTHING for non-existent pending marker", async () => {
    const llm = makeAnswerLLM("answer");
    const session = new ChatSession({ llm, projectRoot: tmpDir, sessionId: "s34-noexist" });

    const reply = await session.handleTurn("/approve does-not-exist");

    expect(reply).toContain("No pending checkpoint found");

    // Assert nothing was written
    const approvedPath = join(tmpDir, ".bober", "approvals", "does-not-exist.approved.json");
    let existed = false;
    try {
      await access(approvedPath, constants.R_OK);
      existed = true;
    } catch {
      // expected — file should not exist
    }
    expect(existed).toBe(false);
  });
});

// ── sc-3-5: /reject writes marker + DiskCheckpointMechanism round-trip ─

describe("sc-3-5: handleReject via /reject slash command", () => {
  it("writes .rejected.json with correct feedback and rejecterId", async () => {
    const checkpointId = "post-plan";
    const marker = makeMarker({ checkpointId });
    await injectPending(tmpDir, marker);

    const llm = makeAnswerLLM("answer");
    const session = new ChatSession({ llm, projectRoot: tmpDir, sessionId: "s35-reject" });

    const reply = await session.handleTurn(`/reject ${checkpointId} split sprint 2`);

    expect(reply).toContain("Rejected checkpoint post-plan");

    // Assert .rejected.json was written with correct feedback
    const rejectedPath = join(tmpDir, ".bober", "approvals", `${checkpointId}.rejected.json`);
    const raw = await readFile(rejectedPath, "utf-8");
    const parsed = JSON.parse(raw) as { rejectedAt: string; rejecterId: string; feedback: string };
    expect(parsed.feedback).toBe("split sprint 2");
    expect(typeof parsed.rejecterId).toBe("string");
    expect(typeof parsed.rejectedAt).toBe("string");
  });

  it("returns clear message and writes NOTHING for non-existent pending marker", async () => {
    const llm = makeAnswerLLM("answer");
    const session = new ChatSession({ llm, projectRoot: tmpDir, sessionId: "s35-noreject" });

    const reply = await session.handleTurn("/reject no-such-cp feedback text");

    expect(reply).toContain("No pending checkpoint found");

    // Assert nothing was written
    const rejectedPath = join(tmpDir, ".bober", "approvals", "no-such-cp.rejected.json");
    let existed = false;
    try {
      await access(rejectedPath, constants.R_OK);
      existed = true;
    } catch {
      // expected — file should not exist
    }
    expect(existed).toBe(false);
  });

  it("DiskCheckpointMechanism resolves to {approved:false, feedback} when chat writes rejected marker", async () => {
    // CRITICAL TIMING NOTE: disk.ts deletes stale markers at the START of request().
    // We MUST write the rejected marker AFTER request() has started polling.
    // The pending marker is pre-seeded so handleReject's pendingExists guard passes.

    const approvalsDir = join(tmpDir, ".bober", "approvals");
    const checkpointId = "post-plan" as CheckpointId;

    // Pre-seed the pending marker (so the session's pendingExists guard passes)
    const pendingMarker = makeMarker({ checkpointId: "post-plan" });
    await injectPending(tmpDir, pendingMarker);

    const llm = makeAnswerLLM("answer");
    const session = new ChatSession({
      llm,
      projectRoot: tmpDir,
      sessionId: "s35-roundtrip",
    });

    // Write the rejected marker via handleTurn AFTER mechanism.request() starts polling.
    // This avoids the start-of-request stale-marker cleanup deleting our marker.
    setTimeout(() => {
      // Re-seed pending marker because disk.ts will try to clean it up at request() start
      // (we do NOT rely on the already-seeded one surviving; the handler re-checks via pendingExists).
      // However the injectPending already wrote the file. The mechanism's start-cleanup only removes
      // approved/rejected/timeout markers — NOT the pending marker. So pending survives.
      // We write the rejection after the mechanism has begun polling.
      void session.handleTurn(`/reject post-plan split sprint 2`);
    }, 30);

    const m = new DiskCheckpointMechanism(approvalsDir, { pollMs: 10 });
    const outcome = await m.request(checkpointId, { type: "plan-spec" });

    expect(outcome).toEqual({ approved: false, feedback: "split sprint 2" });
  }, 5000);
});

// ── sc-3-6: NL approve/reject classify routing ────────────────────────

describe("sc-3-6: NL approve/reject routing via classifier", () => {
  /** LLM stub that returns a fixed classify JSON on first call, answer on second. */
  function makeClassifyLLM(classifyJson: string): LLMClient {
    let callCount = 0;
    return {
      chat: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            text: classifyJson,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          };
        }
        return {
          text: "answer",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        };
      },
    } as unknown as LLMClient;
  }

  it("NL approve with absent checkpointId + exactly one pending -> approves that marker", async () => {
    const checkpointId = "post-plan";
    const marker = makeMarker({ checkpointId });
    await injectPending(tmpDir, marker);

    // Classifier returns approve with no checkpointId
    const llm = makeClassifyLLM('{"action":"approve"}');
    const session = new ChatSession({ llm, projectRoot: tmpDir, sessionId: "s36-nl-approve" });

    const reply = await session.handleTurn("approve it");

    expect(reply).toContain("Approved checkpoint post-plan");

    // Marker should be written
    const approvedPath = join(tmpDir, ".bober", "approvals", `${checkpointId}.approved.json`);
    const raw = await readFile(approvedPath, "utf-8");
    const parsed = JSON.parse(raw) as { approverId: string };
    expect(typeof parsed.approverId).toBe("string");
  });

  it("NL approve with zero pending returns ambiguous message, writes nothing", async () => {
    // No pending markers at all
    const llm = makeClassifyLLM('{"action":"approve"}');
    const session = new ChatSession({ llm, projectRoot: tmpDir, sessionId: "s36-zero-pending" });

    const reply = await session.handleTurn("approve it");

    expect(reply).toContain("No pending checkpoints");

    // Nothing should be written
    const approvalsDir = join(tmpDir, ".bober", "approvals");
    let entries: string[] = [];
    try {
      const { readdir: rd } = await import("node:fs/promises");
      entries = await rd(approvalsDir);
    } catch {
      // dir doesn't exist — that's fine
    }
    const approvedFiles = entries.filter((f) => f.endsWith(".approved.json"));
    expect(approvedFiles).toHaveLength(0);
  });

  it("NL reject with two pending markers and none named -> asks which one, writes nothing", async () => {
    const marker1 = makeMarker({ checkpointId: "post-plan" });
    const marker2 = makeMarker({ checkpointId: "post-research" });
    await injectPending(tmpDir, marker1);
    await injectPending(tmpDir, marker2);

    // Classifier returns reject with no checkpointId
    const llm = makeClassifyLLM('{"action":"reject","feedback":"needs more detail"}');
    const session = new ChatSession({
      llm,
      projectRoot: tmpDir,
      sessionId: "s36-multi-pending",
    });

    const reply = await session.handleTurn("reject it");

    // Should ask which one — not write anything
    expect(reply).toContain("Multiple pending checkpoints");

    // No rejected markers should be written
    const approvalsDir = join(tmpDir, ".bober", "approvals");
    const { readdir: rd } = await import("node:fs/promises");
    const entries = await rd(approvalsDir);
    const rejectedFiles = entries.filter((f) => f.endsWith(".rejected.json"));
    expect(rejectedFiles).toHaveLength(0);
  });

  it("NL approve with explicit checkpointId routes directly to that checkpoint", async () => {
    const checkpointId = "post-plan";
    const marker = makeMarker({ checkpointId });
    await injectPending(tmpDir, marker);

    const llm = makeClassifyLLM(`{"action":"approve","checkpointId":"${checkpointId}"}`);
    const session = new ChatSession({ llm, projectRoot: tmpDir, sessionId: "s36-explicit" });

    const reply = await session.handleTurn(`approve ${checkpointId}`);

    expect(reply).toContain(`Approved checkpoint ${checkpointId}`);
  });
});

// ── sc-3-7: RunState clear after approve + /help text ─────────────────

describe("sc-3-7: RunState cleared after resolve + HELP_TEXT", () => {
  it("after handleApprove, RunState returns to running with pending fields cleared", async () => {
    const runId = "run-clear-test";
    const checkpointId = "post-plan";

    // Set up: running run + pending marker + reflect to input-required
    await injectRunningRun(tmpDir, runId);
    const marker = makeMarker({ checkpointId, runId });
    await injectPending(tmpDir, marker);

    // Reflect to input-required (what Sprint 2 does on handleTurn)
    const inputRequiredState: RunState = {
      runId,
      task: `Task for ${runId}`,
      status: "input-required",
      startedAt: new Date().toISOString(),
      progress: { completed: 0, total: 1 },
      projectRoot: tmpDir,
      pendingCheckpointId: checkpointId,
      pendingPrompt: "Approve this",
      pendingSince: new Date().toISOString(),
    };
    await writeRunState(tmpDir, inputRequiredState);

    // Now approve via /approve slash command
    const llm = makeAnswerLLM("answer");
    const session = new ChatSession({ llm, projectRoot: tmpDir, sessionId: "s37-clear" });
    await session.handleTurn(`/approve ${checkpointId}`);

    // RunState should be back to running with pending fields cleared
    const after = await readRunState(tmpDir, runId);
    expect(after).not.toBeNull();
    expect(after?.status).toBe("running");
    expect(after?.pendingCheckpointId).toBeUndefined();
    expect(after?.pendingPrompt).toBeUndefined();
    expect(after?.pendingSince).toBeUndefined();
  });

  it("after handleReject, RunState returns to running with pending fields cleared", async () => {
    const runId = "run-clear-reject";
    const checkpointId = "post-research";

    await injectRunningRun(tmpDir, runId);
    const marker = makeMarker({ checkpointId, runId });
    await injectPending(tmpDir, marker);

    const inputRequiredState: RunState = {
      runId,
      task: `Task for ${runId}`,
      status: "input-required",
      startedAt: new Date().toISOString(),
      progress: { completed: 0, total: 1 },
      projectRoot: tmpDir,
      pendingCheckpointId: checkpointId,
      pendingPrompt: "Approve this research",
      pendingSince: new Date().toISOString(),
    };
    await writeRunState(tmpDir, inputRequiredState);

    const llm = makeAnswerLLM("answer");
    const session = new ChatSession({ llm, projectRoot: tmpDir, sessionId: "s37-reject-clear" });
    await session.handleTurn(`/reject ${checkpointId} needs rework`);

    const after = await readRunState(tmpDir, runId);
    expect(after).not.toBeNull();
    expect(after?.status).toBe("running");
    expect(after?.pendingCheckpointId).toBeUndefined();
    expect(after?.pendingPrompt).toBeUndefined();
    expect(after?.pendingSince).toBeUndefined();
  });

  it("/help lists /approve and /reject (sc-3-7)", async () => {
    const llm = makeAnswerLLM("answer");
    const session = new ChatSession({ llm, projectRoot: tmpDir, sessionId: "s37-help" });

    const reply = await session.handleTurn("/help");

    expect(reply).not.toBeNull();
    expect(reply).toContain("/approve");
    expect(reply).toContain("/reject");
  });

  it("handleApprove is idempotent for non-input-required RunState (no-op clearPending)", async () => {
    const runId = "run-idempotent";
    const checkpointId = "post-plan";

    // Running state (not input-required) — clearPending should be no-op
    await injectRunningRun(tmpDir, runId);
    const marker = makeMarker({ checkpointId, runId });
    await injectPending(tmpDir, marker);

    const llm = makeAnswerLLM("answer");
    const session = new ChatSession({ llm, projectRoot: tmpDir, sessionId: "s37-idempotent" });

    // Should not throw even when there's no input-required RunState to clear
    const reply = await session.handleTurn(`/approve ${checkpointId}`);
    expect(reply).toContain("Approved checkpoint");

    // RunState stays running
    const after = await readRunState(tmpDir, runId);
    expect(after?.status).toBe("running");
  });
});
