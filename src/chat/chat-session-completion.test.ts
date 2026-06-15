// ── chat-session-completion.test.ts ──────────────────────────────────────
//
// Tests that ChatSession.handleTurn weaves completion notices into the reply
// when the CompletionTailer detects a finished spawned run (sc-3-7).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChatSession } from "./chat-session.js";
import type { CompletionTailer } from "./completion-tailer.js";
import type { LLMClient } from "../providers/types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-session-completion-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Minimal LLM client that always classifies as "answer" with a fixed reply. */
function makeAnswerLLM(replyText: string): LLMClient {
  let callCount = 0;
  return {
    chat: async () => {
      callCount++;
      // First call = classify (returns JSON action), subsequent = answer
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

/** Write a pipeline-complete line + .completed.json marker. */
async function injectCompletion(
  projectRoot: string,
  runId: string,
  phase: "complete" | "failed" = "complete",
): Promise<void> {
  const boberDir = join(projectRoot, ".bober");
  await mkdir(boberDir, { recursive: true });
  const histPath = join(boberDir, "history.jsonl");
  const runsDir = join(boberDir, "runs");
  await mkdir(runsDir, { recursive: true });

  // Write history line
  const histLine = JSON.stringify({
    timestamp: "2026-06-14T10:00:00.000Z",
    event: "pipeline-complete",
    phase,
    details: { completed: 1, failed: 0, durationMs: 5000 },
  }) + "\n";
  await appendFile(histPath, histLine, "utf-8");

  // Write .completed.json marker so tailer can resolve runId
  const markerPath = join(runsDir, `${runId}.completed.json`);
  await writeFile(
    markerPath,
    JSON.stringify({ runId, completedAt: "2026-06-14T10:00:00.000Z" }, null, 2) + "\n",
    "utf-8",
  );
}

describe("ChatSession completion weaving — sc-3-7", () => {
  it("weaves a completion notice into the turn reply when a run finishes", async () => {
    const runId = "run-99999";
    await injectCompletion(tmpDir, runId, "complete");

    const llm = makeAnswerLLM("Here is your answer.");
    const session = new ChatSession({
      llm,
      projectRoot: tmpDir,
      sessionId: "weave-test",
    });

    const reply = await session.handleTurn("What happened?");

    expect(reply).not.toBeNull();
    expect(reply).toContain(runId);
    expect(reply).toContain("finished");
  });

  it("does not weave a completion notice when no run has finished", async () => {
    // No history.jsonl — poll returns []
    const llm = makeAnswerLLM("Just a normal answer.");
    const session = new ChatSession({
      llm,
      projectRoot: tmpDir,
      sessionId: "no-weave-test",
    });

    const reply = await session.handleTurn("How are things?");

    expect(reply).not.toBeNull();
    expect(reply).toBe("Just a normal answer.");
  });

  it("does not re-weave the same completion on the next turn", async () => {
    const runId = "run-dedupe";
    await injectCompletion(tmpDir, runId, "complete");

    const llm = makeAnswerLLM("Answer text.");
    const session = new ChatSession({
      llm,
      projectRoot: tmpDir,
      sessionId: "dedupe-test",
    });

    const reply1 = await session.handleTurn("First turn");
    expect(reply1).toContain(runId);

    const reply2 = await session.handleTurn("Second turn");
    // run-dedupe should not appear again
    expect(reply2).not.toContain(runId);
  });

  it("accepts an injected tailer for testing", async () => {
    // Test that the tailer option is honoured
    let polled = false;
    const fakeTailer = {
      poll: async () => {
        polled = true;
        return [];
      },
    } as unknown as CompletionTailer;

    const llm = makeAnswerLLM("Hi.");
    const session = new ChatSession({
      llm,
      projectRoot: tmpDir,
      sessionId: "injected-tailer",
      tailer: fakeTailer,
    });

    await session.handleTurn("Hello");
    expect(polled).toBe(true);
  });
});
