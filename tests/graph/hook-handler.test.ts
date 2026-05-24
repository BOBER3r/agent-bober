import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock("../../src/graph/cli.js", () => ({
  TokensaveCli: vi.fn().mockImplementation(() => ({
    sync: vi.fn().mockResolvedValue({ indexed: 0 }),
  })),
}));

// ── Helpers ───────────────────────────────────────────────────────────

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    debounceMs: 750,
    hookQueueMax: 50,
    syncTimeoutMs: 2000,
    autoSync: true,
    enabled: true,
    ...overrides,
  };
}

function makeStore(manifestOverride: Record<string, unknown> | null = null) {
  return {
    readManifest: vi.fn().mockResolvedValue(
      manifestOverride ?? {
        schemaVersion: 1,
        tokensaveVersion: "6.0.0",
        createdAt: new Date().toISOString(),
        lastSyncAt: new Date().toISOString(),
        indexedFileCount: 0,
        languageTier: "core",
        lastSyncedHeadSha: null,
        pendingFiles: [],
      },
    ),
    writeManifest: vi.fn().mockResolvedValue(undefined),
  };
}

function makeIncidents() {
  return { append: vi.fn().mockResolvedValue(undefined) };
}

// ── Tests ─────────────────────────────────────────────────────────────

let tmp: string;

beforeEach(async () => {
  vi.useFakeTimers();
  tmp = await mkdtemp(join(tmpdir(), "bober-hook-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(tmp, { recursive: true, force: true });
});

// ── s8-c2: class shape ────────────────────────────────────────────────

describe("GraphHookHandler — class shape (s8-c2)", () => {
  it("exports GraphHookHandler with onPostToolUse and flush methods", async () => {
    const { GraphHookHandler } = await import("../../src/graph/hook-handler.js");
    const cli = { sync: vi.fn().mockResolvedValue({ indexed: 0 }) };
    const h = new GraphHookHandler(cli as never, makeStore() as never, makeIncidents() as never, makeConfig() as never, tmp);
    expect(typeof h.onPostToolUse).toBe("function");
    expect(typeof h.flush).toBe("function");
    expect(typeof h.start).toBe("function");
  });

  it("onPostToolUse returns void synchronously (no Promise)", async () => {
    const { GraphHookHandler } = await import("../../src/graph/hook-handler.js");
    const cli = { sync: vi.fn().mockResolvedValue({ indexed: 0 }) };
    const h = new GraphHookHandler(cli as never, makeStore() as never, makeIncidents() as never, makeConfig() as never, tmp);
    const result = h.onPostToolUse({ paths: ["a.ts"] });
    expect(result).toBeUndefined();
  });

  it("flush() returns a Promise", async () => {
    const { GraphHookHandler } = await import("../../src/graph/hook-handler.js");
    const cli = { sync: vi.fn().mockResolvedValue({ indexed: 0 }) };
    const h = new GraphHookHandler(cli as never, makeStore() as never, makeIncidents() as never, makeConfig() as never, tmp);
    const p = h.flush();
    expect(p).toBeInstanceOf(Promise);
    await p;
  });
});

// ── s8-c3: debounce coalescing ─────────────────────────────────────────

describe("GraphHookHandler — debounce coalescing (s8-c3)", () => {
  it("coalesces 3 calls within 750ms into 1 sync invocation", async () => {
    const { GraphHookHandler } = await import("../../src/graph/hook-handler.js");
    const cli = { sync: vi.fn().mockResolvedValue({ indexed: 0 }) };
    const h = new GraphHookHandler(
      cli as never,
      makeStore() as never,
      makeIncidents() as never,
      makeConfig() as never,
      tmp,
    );

    h.onPostToolUse({ paths: ["a.ts"] });     // t=0
    vi.advanceTimersByTime(300);
    h.onPostToolUse({ paths: ["b.ts"] });     // t=300
    vi.advanceTimersByTime(300);
    h.onPostToolUse({ paths: ["c.ts"] });     // t=600

    expect(cli.sync).not.toHaveBeenCalled(); // still in window

    vi.advanceTimersByTime(750);              // t=1350 — debounce fires
    await vi.runAllTimersAsync();

    expect(cli.sync).toHaveBeenCalledTimes(1);
    const calledPaths = (cli.sync.mock.calls[0] as [string[], number])[0];
    expect([...calledPaths].sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect((cli.sync.mock.calls[0] as [string[], number])[1]).toBe(2000);
  });

  it("resets the timer on each call — does not fire early", async () => {
    const { GraphHookHandler } = await import("../../src/graph/hook-handler.js");
    const cli = { sync: vi.fn().mockResolvedValue({ indexed: 0 }) };
    const h = new GraphHookHandler(
      cli as never,
      makeStore() as never,
      makeIncidents() as never,
      makeConfig() as never,
      tmp,
    );

    // t=0: arm debounce at t=750
    h.onPostToolUse({ paths: ["x.ts"] });
    // t=700: still 50ms left — reset timer to fire at t=1450
    vi.advanceTimersByTime(700);
    h.onPostToolUse({ paths: ["y.ts"] });

    // t=700+749=1449: 749ms since second call, timer not yet fired
    vi.advanceTimersByTime(749);
    // Drain microtasks but do NOT run timers
    await Promise.resolve();

    // Must not have fired yet (timer resets to 750ms from t=700)
    expect(cli.sync).not.toHaveBeenCalled();

    // t=1450: now 750ms since second call — fires
    vi.advanceTimersByTime(1);
    await vi.runAllTimersAsync();

    expect(cli.sync).toHaveBeenCalledTimes(1);
  });

  it("deduplicates paths via Set semantics", async () => {
    const { GraphHookHandler } = await import("../../src/graph/hook-handler.js");
    const cli = { sync: vi.fn().mockResolvedValue({ indexed: 0 }) };
    const h = new GraphHookHandler(
      cli as never,
      makeStore() as never,
      makeIncidents() as never,
      makeConfig() as never,
      tmp,
    );

    h.onPostToolUse({ paths: ["a.ts", "b.ts"] });
    h.onPostToolUse({ paths: ["a.ts", "c.ts"] }); // 'a.ts' is duplicate

    vi.advanceTimersByTime(750);
    await vi.runAllTimersAsync();

    expect(cli.sync).toHaveBeenCalledTimes(1);
    const calledPaths = (cli.sync.mock.calls[0] as [string[], number])[0];
    expect(calledPaths.length).toBe(3); // a, b, c — no duplicates
  });
});

// ── s8-c4: queue cap overflow ──────────────────────────────────────────

describe("GraphHookHandler — queue cap overflow (s8-c4)", () => {
  it("evicts oldest 10 entries when queue exceeds cap and logs debounce-overflow incident", async () => {
    const { GraphHookHandler } = await import("../../src/graph/hook-handler.js");
    const cli = { sync: vi.fn().mockResolvedValue({ indexed: 0 }) };
    const incidents = makeIncidents();
    const h = new GraphHookHandler(
      cli as never,
      makeStore() as never,
      incidents as never,
      makeConfig() as never,
      tmp,
    );

    // Push 60 paths in a tight loop (each is a separate call, dedup via unique names)
    for (let i = 0; i < 60; i++) {
      h.onPostToolUse({ paths: [`f${i}.ts`] });
    }

    expect(incidents.append).toHaveBeenCalledWith(
      expect.objectContaining({ event: "debounce-overflow", droppedCount: 10 }),
    );
  });

  it("queue size does not exceed hookQueueMax after overflow", async () => {
    const { GraphHookHandler } = await import("../../src/graph/hook-handler.js");
    const cli = { sync: vi.fn().mockResolvedValue({ indexed: 0 }) };
    const incidents = makeIncidents();
    const h = new GraphHookHandler(
      cli as never,
      makeStore() as never,
      incidents as never,
      makeConfig({ hookQueueMax: 10 }) as never,
      tmp,
    );

    // Push 25 paths — should trigger overflow and keep only 10
    for (let i = 0; i < 25; i++) {
      h.onPostToolUse({ paths: [`f${i}.ts`] });
    }

    // Drain the debounce timer to trigger sync (which clears the queue)
    vi.advanceTimersByTime(750);
    await vi.runAllTimersAsync();

    // Verify at least one overflow incident was logged
    expect(incidents.append).toHaveBeenCalledWith(
      expect.objectContaining({ event: "debounce-overflow" }),
    );
  });
});

// ── s8-c5: sync timeout ────────────────────────────────────────────────

describe("GraphHookHandler — sync timeout (s8-c5)", () => {
  it("on timeout: appends pendingFiles and logs hook-timeout incident", async () => {
    const { GraphHookHandler } = await import("../../src/graph/hook-handler.js");

    const cli = {
      sync: vi.fn().mockRejectedValue(new Error("tokensave sync timed out after 2000ms")),
    };
    const store = makeStore();
    const incidents = makeIncidents();

    const h = new GraphHookHandler(
      cli as never,
      store as never,
      incidents as never,
      makeConfig() as never,
      tmp,
    );

    h.onPostToolUse({ paths: ["a.ts"] });

    vi.advanceTimersByTime(750);
    await vi.runAllTimersAsync();

    // Let the async runSync complete
    await Promise.resolve();
    await Promise.resolve();

    expect(incidents.append).toHaveBeenCalledWith(
      expect.objectContaining({ event: "hook-timeout", paths: expect.arrayContaining(["a.ts"]) }),
    );
    expect(store.writeManifest).toHaveBeenCalledWith(
      expect.objectContaining({ pendingFiles: expect.arrayContaining(["a.ts"]) }),
    );
  });

  it("non-timeout error: does NOT log hook-timeout or pendingFiles", async () => {
    const { GraphHookHandler } = await import("../../src/graph/hook-handler.js");

    const cli = {
      sync: vi.fn().mockRejectedValue(new Error("network error")),
    };
    const store = makeStore();
    const incidents = makeIncidents();

    const h = new GraphHookHandler(
      cli as never,
      store as never,
      incidents as never,
      makeConfig() as never,
      tmp,
    );

    h.onPostToolUse({ paths: ["a.ts"] });

    vi.advanceTimersByTime(750);
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    expect(incidents.append).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "hook-timeout" }),
    );
    expect(store.writeManifest).not.toHaveBeenCalled();
  });
});

// ── s8-c8: flush drains queue ──────────────────────────────────────────

describe("GraphHookHandler — flush (s8-c8)", () => {
  it("flush() drains pending queue and clears the debounce timer", async () => {
    const { GraphHookHandler } = await import("../../src/graph/hook-handler.js");
    const cli = { sync: vi.fn().mockResolvedValue({ indexed: 0 }) };
    const h = new GraphHookHandler(
      cli as never,
      makeStore() as never,
      makeIncidents() as never,
      makeConfig() as never,
      tmp,
    );

    h.onPostToolUse({ paths: ["a.ts", "b.ts"] });

    // Don't let the debounce timer fire naturally; call flush() directly
    const flushPromise = h.flush();
    vi.runAllTimers();
    await flushPromise;

    expect(cli.sync).toHaveBeenCalledTimes(1);
    const calledPaths = (cli.sync.mock.calls[0] as [string[], number])[0];
    expect(calledPaths).toEqual(expect.arrayContaining(["a.ts", "b.ts"]));
  });

  it("flush() with no queued paths completes immediately", async () => {
    const { GraphHookHandler } = await import("../../src/graph/hook-handler.js");
    const cli = { sync: vi.fn().mockResolvedValue({ indexed: 0 }) };
    const h = new GraphHookHandler(
      cli as never,
      makeStore() as never,
      makeIncidents() as never,
      makeConfig() as never,
      tmp,
    );

    await h.flush();

    expect(cli.sync).not.toHaveBeenCalled();
  });
});

// ── s8-c9: autoSync=false no-op ────────────────────────────────────────

describe("GraphHookHandler — autoSync=false no-op (s8-c9)", () => {
  it("onPostToolUse is a complete no-op when autoSync=false", async () => {
    const { GraphHookHandler } = await import("../../src/graph/hook-handler.js");
    const cli = { sync: vi.fn().mockResolvedValue({ indexed: 0 }) };
    const h = new GraphHookHandler(
      cli as never,
      makeStore() as never,
      makeIncidents() as never,
      makeConfig({ autoSync: false }) as never,
      tmp,
    );

    h.onPostToolUse({ paths: ["a.ts"] });

    vi.advanceTimersByTime(10_000);
    await vi.runAllTimersAsync();

    expect(cli.sync).not.toHaveBeenCalled();
  });

  it("no debounce timer is armed when autoSync=false", async () => {
    const { GraphHookHandler } = await import("../../src/graph/hook-handler.js");
    const cli = { sync: vi.fn().mockResolvedValue({ indexed: 0 }) };
    const incidents = makeIncidents();
    const h = new GraphHookHandler(
      cli as never,
      makeStore() as never,
      incidents as never,
      makeConfig({ autoSync: false }) as never,
      tmp,
    );

    // Push many paths — should be completely no-op
    for (let i = 0; i < 10; i++) {
      h.onPostToolUse({ paths: [`f${i}.ts`] });
    }

    vi.advanceTimersByTime(10_000);
    await vi.runAllTimersAsync();

    expect(cli.sync).not.toHaveBeenCalled();
    expect(incidents.append).not.toHaveBeenCalled();
  });
});
