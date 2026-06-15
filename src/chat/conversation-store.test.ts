import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConversationStore } from "./conversation-store.js";
import type { TurnRecord } from "./conversation-store.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-conv-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("ConversationStore", () => {
  it("returns empty array when no prior session exists", async () => {
    const store = new ConversationStore(tmpDir, "test-session");
    const turns = await store.loadRecent(10);
    expect(turns).toEqual([]);
  });

  it("appends and loads turns (sc-1-7: resume)", async () => {
    const store = new ConversationStore(tmpDir, "test-session");

    const t1: TurnRecord = { role: "user", content: "hello", ts: "2026-01-01T00:00:00.000Z" };
    const t2: TurnRecord = { role: "assistant", content: "hi there", ts: "2026-01-01T00:00:01.000Z" };

    await store.append(t1);
    await store.append(t2);

    // Create a FRESH store instance with same sessionId+projectRoot — resume
    const freshStore = new ConversationStore(tmpDir, "test-session");
    const turns = await freshStore.loadRecent(10);

    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ role: "user", content: "hello" });
    expect(turns[1]).toMatchObject({ role: "assistant", content: "hi there" });
  });

  it("respects the limit parameter", async () => {
    const store = new ConversationStore(tmpDir, "limit-session");

    for (let i = 0; i < 5; i++) {
      await store.append({ role: "user", content: `msg${i}`, ts: new Date().toISOString() });
    }

    const turns = await store.loadRecent(3);
    expect(turns).toHaveLength(3);
    expect(turns[2]).toMatchObject({ content: "msg4" });
  });

  it("skips malformed lines", async () => {
    const store = new ConversationStore(tmpDir, "malformed");
    await store.append({ role: "user", content: "good", ts: "2026-01-01T00:00:00.000Z" });

    // Manually inject a bad line
    const { appendFile } = await import("node:fs/promises");
    const { join: pjoin } = await import("node:path");
    const badPath = pjoin(tmpDir, ".bober", "chat", "malformed.jsonl");
    await appendFile(badPath, "NOT JSON AT ALL\n", "utf-8");
    await store.append({ role: "assistant", content: "good2", ts: "2026-01-01T00:00:01.000Z" });

    const freshStore = new ConversationStore(tmpDir, "malformed");
    const turns = await freshStore.loadRecent(10);

    // Should have exactly 2 valid turns (malformed line skipped)
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ content: "good" });
    expect(turns[1]).toMatchObject({ content: "good2" });
  });
});
