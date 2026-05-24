/**
 * Colocated smoke tests for GraphHookHandler.
 *
 * These fast, dependency-free tests verify the class exports and basic
 * synchronous invariants. Full unit tests live in tests/graph/hook-handler.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./cli.js", () => ({
  TokensaveCli: vi.fn().mockImplementation(() => ({
    sync: vi.fn().mockResolvedValue({ indexed: 0 }),
  })),
}));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GraphHookHandler — colocated smoke tests", () => {
  it("can be imported and instantiated", async () => {
    const { GraphHookHandler } = await import("./hook-handler.js");
    const cli = { sync: vi.fn().mockResolvedValue({ indexed: 0 }) };
    const store = {
      readManifest: vi.fn().mockResolvedValue(null),
      writeManifest: vi.fn().mockResolvedValue(undefined),
    };
    const incidents = { append: vi.fn().mockResolvedValue(undefined) };
    const config = {
      debounceMs: 750,
      hookQueueMax: 50,
      syncTimeoutMs: 2000,
      autoSync: true,
      enabled: true,
    };

    const h = new GraphHookHandler(
      cli as never,
      store as never,
      incidents as never,
      config as never,
      "/tmp/test",
    );

    expect(h).toBeTruthy();
  });

  it("onPostToolUse does not schedule sync when autoSync=false", async () => {
    const { GraphHookHandler } = await import("./hook-handler.js");
    const cli = { sync: vi.fn().mockResolvedValue({ indexed: 0 }) };
    const h = new GraphHookHandler(
      cli as never,
      { readManifest: vi.fn(), writeManifest: vi.fn() } as never,
      { append: vi.fn().mockResolvedValue(undefined) } as never,
      { debounceMs: 750, hookQueueMax: 50, syncTimeoutMs: 2000, autoSync: false, enabled: true } as never,
      "/tmp/test",
    );

    h.onPostToolUse({ paths: ["src/foo.ts"] });
    vi.advanceTimersByTime(10_000);
    await vi.runAllTimersAsync();

    expect(cli.sync).not.toHaveBeenCalled();
  });

  it("flush() on empty queue returns without calling sync", async () => {
    const { GraphHookHandler } = await import("./hook-handler.js");
    const cli = { sync: vi.fn().mockResolvedValue({ indexed: 0 }) };
    const h = new GraphHookHandler(
      cli as never,
      { readManifest: vi.fn(), writeManifest: vi.fn() } as never,
      { append: vi.fn().mockResolvedValue(undefined) } as never,
      { debounceMs: 750, hookQueueMax: 50, syncTimeoutMs: 2000, autoSync: true, enabled: true } as never,
      "/tmp/test",
    );

    await h.flush();

    expect(cli.sync).not.toHaveBeenCalled();
  });
});
