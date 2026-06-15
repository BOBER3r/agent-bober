// ── chat-session-approval.test.ts ────────────────────────────────────
//
// Tests that ChatSession.handleTurn surfaces pending approval notices
// (sc-2-5), dedupes them (sc-2-6), reflects RunState fields (sc-2-7),
// and is a no-op when no markers exist (sc-2-8).

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
