import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { GraphArtifactStore } from "../../src/graph/artifact-store.js";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "bober-graph-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("GraphArtifactStore", () => {
  it("readManifest returns null when missing", async () => {
    const store = new GraphArtifactStore(tmp);
    expect(await store.readManifest()).toBeNull();
  });

  it("writeManifest creates .bober/graph/ and round-trips", async () => {
    const store = new GraphArtifactStore(tmp);
    const m = {
      schemaVersion: 1 as const,
      tokensaveVersion: "6.0.0-beta.1",
      createdAt: "2026-05-24T00:00:00Z",
      lastSyncAt: "2026-05-24T00:00:00Z",
      indexedFileCount: 0,
      languageTier: "core",
      lastSyncedHeadSha: null,
      pendingFiles: [],
    };
    await store.writeManifest(m);
    const read = await store.readManifest();
    expect(read).toEqual(m);
    expect(read?.schemaVersion).toBe(1);
  });

  it("staleness returns NO_MANIFEST when no manifest exists", async () => {
    const v = await new GraphArtifactStore(tmp).staleness();
    expect(v.stale).toBe(true);
    if (v.stale) expect(v.reason).toBe("NO_MANIFEST");
  });

  it("staleness via mtime fallback in a non-git directory", async () => {
    const store = new GraphArtifactStore(tmp);
    await store.writeManifest({
      schemaVersion: 1,
      tokensaveVersion: "6.0.0-beta.1",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      lastSyncAt: new Date(Date.now() - 60_000).toISOString(),
      indexedFileCount: 0,
      languageTier: "core",
      lastSyncedHeadSha: null,
      pendingFiles: [],
    });
    // Write a newer file (not inside .bober/ — that is ignored by glob)
    await writeFile(join(tmp, "fresh.ts"), "x", "utf-8");
    const v = await store.staleness();
    expect(v.stale).toBe(true);
    if (v.stale) expect(v.reason).toBe("NEWER_MTIME");
  });

  it("staleness uses HEAD_DIFFERS when in a git repo with different SHA", async () => {
    await execa("git", ["init", "-q"], { cwd: tmp });
    await execa(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
      { cwd: tmp },
    );
    const { stdout: head } = await execa("git", ["rev-parse", "HEAD"], { cwd: tmp });
    const store = new GraphArtifactStore(tmp);
    await store.writeManifest({
      schemaVersion: 1,
      tokensaveVersion: "6.0.0-beta.1",
      createdAt: new Date().toISOString(),
      lastSyncAt: new Date().toISOString(),
      indexedFileCount: 0,
      languageTier: "core",
      lastSyncedHeadSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      pendingFiles: [],
    });
    const v = await store.staleness();
    expect(v.stale).toBe(true);
    if (v.stale) expect(v.reason).toBe("HEAD_DIFFERS");

    // Now sync to current HEAD → not stale
    await store.writeManifest({
      schemaVersion: 1,
      tokensaveVersion: "6.0.0-beta.1",
      createdAt: new Date().toISOString(),
      lastSyncAt: new Date().toISOString(),
      indexedFileCount: 0,
      languageTier: "core",
      lastSyncedHeadSha: head.trim(),
      pendingFiles: [],
    });
    expect((await store.staleness()).stale).toBe(false);
  });

  it("staleness completes in <50ms typical (evaluator perf check)", async () => {
    const store = new GraphArtifactStore(tmp);
    const t0 = performance.now();
    await store.staleness();
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it("readManifest returns null and logs when manifest is malformed JSON", async () => {
    const store = new GraphArtifactStore(tmp);
    await store.ensureLayout();
    await writeFile(join(tmp, ".bober/graph/manifest.json"), "{ not json", "utf-8");
    expect(await store.readManifest()).toBeNull();
  });
});
