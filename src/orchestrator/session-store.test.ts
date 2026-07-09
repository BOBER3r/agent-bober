import { mkdtemp, rm, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  SessionStore,
  SessionRecordSchema,
  MessageSchema,
  sessionForkId,
  type SessionRecord,
} from "./session-store.js";
import type { AssistantMessage, ToolResultMessage } from "../providers/types.js";

// ── Lifecycle ─────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-loop-session-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────

function makeClock(times: string[]): () => string {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)];
}

// ── MessageSchema — union ordering trap ────────────────────────────────

describe("MessageSchema", () => {
  it("round-trips a plain TextMessage", () => {
    const msg = { role: "user", content: "hello" };
    const result = MessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(msg);
    }
  });

  it("round-trips an AssistantMessage WITHOUT losing toolCalls (union-ordering trap)", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: "calling a tool",
      toolCalls: [{ id: "t1", name: "read_file", input: { path: "a.ts" } }],
    };
    const result = MessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(msg);
      expect("toolCalls" in result.data).toBe(true);
    }
  });

  it("round-trips a ToolResultMessage", () => {
    const msg: ToolResultMessage = {
      role: "user",
      toolResults: [{ toolUseId: "t1", content: "ok", isError: false }],
    };
    const result = MessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(msg);
    }
  });

  it("round-trips a SystemUpdateMessage", () => {
    const msg = { role: "user", systemUpdate: "context refresh", cacheTtl: "5m" as const };
    const result = MessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(msg);
    }
  });
});

// ── SessionRecordSchema ─────────────────────────────────────────────────

describe("SessionRecordSchema", () => {
  it("rejects an empty sessionId", () => {
    const result = SessionRecordSchema.safeParse({
      sessionId: "",
      model: "m",
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
      turnsUsed: 0,
      messages: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative turnsUsed", () => {
    const result = SessionRecordSchema.safeParse({
      sessionId: "s1",
      model: "m",
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
      turnsUsed: -1,
      messages: [],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid record with a full Message[] mix", () => {
    const record: SessionRecord = {
      sessionId: "s1",
      model: "m",
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:01.000Z",
      turnsUsed: 2,
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "t1", name: "noop", input: {} }],
        },
        { role: "user", toolResults: [{ toolUseId: "t1", content: "ok" }] },
        { role: "assistant", content: "done" },
      ],
    };
    const result = SessionRecordSchema.safeParse(record);
    expect(result.success).toBe(true);
  });
});

// ── SessionStore — path / save / load ──────────────────────────────────

describe("SessionStore", () => {
  it("sanitizes ids in the path (no path traversal)", () => {
    const store = new SessionStore({ projectRoot: tmpRoot });
    const p = store.path("../../evil/id");
    expect(p).not.toContain("..");
    expect(p.startsWith(join(tmpRoot, ".bober", "sessions"))).toBe(true);
  });

  it("save creates .bober/sessions/<id>.json and load round-trips it", async () => {
    const store = new SessionStore({ projectRoot: tmpRoot, now: makeClock(["2026-07-10T00:00:00.000Z"]) });

    await store.save({
      sessionId: "sess-1",
      model: "m",
      turnsUsed: 1,
      messages: [{ role: "user", content: "hi" }],
    });

    const loaded = await store.load("sess-1");
    expect(loaded).not.toBeNull();
    expect(loaded?.sessionId).toBe("sess-1");
    expect(loaded?.model).toBe("m");
    expect(loaded?.turnsUsed).toBe(1);
    expect(loaded?.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(loaded?.createdAt).toBe("2026-07-10T00:00:00.000Z");
    expect(loaded?.updatedAt).toBe("2026-07-10T00:00:00.000Z");
  });

  it("preserves createdAt across saves while updatedAt advances", async () => {
    const store = new SessionStore({
      projectRoot: tmpRoot,
      now: makeClock([
        "2026-07-10T00:00:00.000Z",
        "2026-07-10T00:01:00.000Z",
        "2026-07-10T00:02:00.000Z",
      ]),
    });

    await store.save({ sessionId: "sess-1", model: "m", turnsUsed: 1, messages: [] });
    await store.save({ sessionId: "sess-1", model: "m", turnsUsed: 2, messages: [] });

    const loaded = await store.load("sess-1");
    expect(loaded?.createdAt).toBe("2026-07-10T00:00:00.000Z");
    expect(loaded?.updatedAt).toBe("2026-07-10T00:01:00.000Z");
    expect(loaded?.turnsUsed).toBe(2);
  });

  it("load returns null for a missing session (never throws)", async () => {
    const store = new SessionStore({ projectRoot: tmpRoot });
    const loaded = await store.load("nonexistent");
    expect(loaded).toBeNull();
  });

  it("load returns null for a corrupt (non-JSON) session file (never throws)", async () => {
    const store = new SessionStore({ projectRoot: tmpRoot });
    const dir = join(tmpRoot, ".bober", "sessions");
    await store.save({ sessionId: "sess-1", model: "m", turnsUsed: 1, messages: [] });
    // Corrupt the file in place.
    await writeFile(join(dir, "sess-1.json"), "{ not valid json", "utf-8");

    const loaded = await store.load("sess-1");
    expect(loaded).toBeNull();
  });

  it("load returns null for well-formed JSON that fails schema validation", async () => {
    const store = new SessionStore({ projectRoot: tmpRoot });
    const dir = join(tmpRoot, ".bober", "sessions");
    await store.save({ sessionId: "sess-1", model: "m", turnsUsed: 1, messages: [] });
    await writeFile(join(dir, "sess-1.json"), JSON.stringify({ sessionId: "sess-1" }), "utf-8");

    const loaded = await store.load("sess-1");
    expect(loaded).toBeNull();
  });

  it("save throws (does not write) for a Zod-invalid record", async () => {
    const store = new SessionStore({ projectRoot: tmpRoot });
    await expect(
      store.save({ sessionId: "", model: "m", turnsUsed: 1, messages: [] }),
    ).rejects.toThrow("Invalid session record");

    const loaded = await store.load("");
    expect(loaded).toBeNull();
  });
});

// ── SessionStore.fork — isolation ──────────────────────────────────────

describe("SessionStore.fork", () => {
  it("copies the transcript to a new id and returns the new id", async () => {
    const store = new SessionStore({ projectRoot: tmpRoot });
    await store.save({
      sessionId: "orig",
      model: "m",
      turnsUsed: 2,
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
    });

    const newId = await store.fork("orig", "forked");
    expect(newId).toBe("forked");

    const forked = await store.load("forked");
    expect(forked?.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(forked?.turnsUsed).toBe(2);
  });

  it("never rewrites the source file — continuing the fork leaves the original byte-identical", async () => {
    const store = new SessionStore({ projectRoot: tmpRoot });
    await store.save({
      sessionId: "orig",
      model: "m",
      turnsUsed: 1,
      messages: [{ role: "user", content: "hi" }],
    });

    const originalBytes = await readFile(store.path("orig"), "utf-8");

    await store.fork("orig", "forked");
    // Continue the fork — new turns append only to the forked file.
    await store.save({
      sessionId: "forked",
      model: "m",
      turnsUsed: 2,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "diverged answer" },
      ],
    });

    const afterBytes = await readFile(store.path("orig"), "utf-8");
    expect(afterBytes).toBe(originalBytes);

    const forked = await store.load("forked");
    expect(forked?.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "diverged answer" },
    ]);
  });

  it("throws when the source session does not exist", async () => {
    const store = new SessionStore({ projectRoot: tmpRoot });
    await expect(store.fork("nonexistent", "forked")).rejects.toThrow(
      "not found or corrupt",
    );
  });
});

// ── sessionForkId — deterministic id derivation ────────────────────────

describe("sessionForkId", () => {
  it("is deterministic for the same inputs", () => {
    expect(sessionForkId("s1", "2026-07-10T00:00:00.000Z")).toBe(
      sessionForkId("s1", "2026-07-10T00:00:00.000Z"),
    );
  });

  it("differs for different sessionIds or timestamps", () => {
    const ts = "2026-07-10T00:00:00.000Z";
    expect(sessionForkId("s1", ts)).not.toBe(sessionForkId("s2", ts));
    expect(sessionForkId("s1", ts)).not.toBe(
      sessionForkId("s1", "2026-07-10T00:00:01.000Z"),
    );
  });

  it("produces a 16-char hex string", () => {
    expect(sessionForkId("s1", "2026-07-10T00:00:00.000Z")).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ── No-session absence ──────────────────────────────────────────────────

describe("SessionStore — absence", () => {
  it("no .bober/sessions/ directory exists until the first save", async () => {
    await expect(readdir(join(tmpRoot, ".bober", "sessions"))).rejects.toThrow();

    const store = new SessionStore({ projectRoot: tmpRoot });
    await store.save({ sessionId: "s1", model: "m", turnsUsed: 1, messages: [] });

    const entries = await readdir(join(tmpRoot, ".bober", "sessions"));
    expect(entries).toContain("s1.json");
  });
});
