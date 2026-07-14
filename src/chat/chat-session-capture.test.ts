import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChatSession } from "./chat-session.js";
import type { LLMClient, ChatParams, ChatResponse } from "../providers/types.js";
import { FactStore, factsDbPath } from "../state/facts.js";
import { readFindings } from "../hub/finding-store.js";

// Answers exactly one chat() call (the classifier). A second call (i.e. the
// Answerer) throws — proving the capture branch never reaches the Answerer.
class OnceClient implements LLMClient {
  calls = 0;
  constructor(private readonly response: string) {}
  async chat(_p: ChatParams): Promise<ChatResponse> {
    this.calls += 1;
    if (this.calls > 1) throw new Error("Answerer must NOT be called on capture-task");
    return { text: this.response, toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-capture-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

describe("sc-5-4: chat-session capture-task handler", () => {
  it("persists one open action Finding and replies with a capture confirmation", async () => {
    const projectRoot = join(tmpDir, "root");
    await mkdir(join(projectRoot, ".bober"), { recursive: true });

    const llm = new OnceClient('{"action":"capture-task","task":"renew passport"}');
    const session = new ChatSession({ llm, projectRoot, sessionId: "t" }); // default namespace → undefined

    const reply = await session.handleTurn("renew passport");

    // Reply is a capture confirmation, NOT an LLM answer.
    expect(reply).toContain("Captured task");
    expect(reply).toContain("renew passport");
    expect(llm.calls).toBe(1); // only the classifier ran

    // Re-open the store the handler wrote to and assert exactly one open action Finding.
    const store = new FactStore(factsDbPath(projectRoot, undefined));
    try {
      const findings = readFindings(store);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.kind).toBe("action");
      expect(findings[0]!.status).toBe("open");
      expect(findings[0]!.title).toBe("renew passport");
    } finally {
      store.close();
    }
  });
});
