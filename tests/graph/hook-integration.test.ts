/**
 * Hook integration test — s8-c10.
 *
 * Requires the real `tokensave` binary to be present on PATH.
 * Skipped automatically in CI environments without the binary.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Check whether the real tokensave binary is available.
const hasTokensave = (() => {
  try {
    return spawnSync("tokensave", ["--version"]).status === 0;
  } catch {
    return false;
  }
})();

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "bober-hook-int-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe.skipIf(!hasTokensave)("hook integration with real tokensave (s8-c10)", () => {
  it("8 rapid file changes → exactly 1 sync call after debounce window", async () => {
    const { GraphHookHandler } = await import("../../src/graph/hook-handler.js");
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const { GraphArtifactStore } = await import("../../src/graph/artifact-store.js");
    const { IncidentLog } = await import("../../src/graph/incidents.js");

    const store = new GraphArtifactStore(tmp);
    await store.ensureLayout();

    const cli = new TokensaveCli(tmp, store, "tokensave");
    const incidents = new IncidentLog(tmp);
    const config = {
      debounceMs: 200, // shorter for test speed
      hookQueueMax: 50,
      syncTimeoutMs: 5000,
      autoSync: true,
      enabled: true,
    };

    const syncSpy = vi.spyOn(cli, "sync");
    // Mock sync to resolve immediately (we're testing debounce, not real tokensave sync)
    syncSpy.mockResolvedValue({ indexed: 0 });

    const h = new GraphHookHandler(
      cli,
      store,
      incidents,
      config as never,
      tmp,
    );

    // Simulate 8 rapid file changes (within 50ms of each other)
    const files = Array.from({ length: 8 }, (_, i) => `src/file${i}.ts`);
    for (const f of files) {
      h.onPostToolUse({ paths: [f] });
      // Tiny artificial gap to simulate rapid but not simultaneous edits
      await new Promise((r) => setTimeout(r, 10));
    }

    // Wait for debounce window to expire + a buffer
    await new Promise((r) => setTimeout(r, config.debounceMs + 200));

    // Exactly 1 sync call with all 8 paths
    expect(syncSpy).toHaveBeenCalledTimes(1);
    const calledPaths = syncSpy.mock.calls[0][0] as string[];
    expect(calledPaths.length).toBe(8);
    for (const f of files) {
      expect(calledPaths).toContain(f);
    }
  });
});

// ── Lightweight structural tests (always run, no binary required) ────────

describe("hook integration — structural (no binary)", () => {
  it("GraphHookHandler can be constructed without a running engine", async () => {
    const { GraphHookHandler } = await import("../../src/graph/hook-handler.js");
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
      tmp,
    );

    expect(h).toBeTruthy();
    await h.flush(); // should be a no-op (queue empty)
    expect(cli.sync).not.toHaveBeenCalled();
  });
});
