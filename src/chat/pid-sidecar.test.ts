import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PidSidecar } from "./pid-sidecar.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-pidsidecar-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("PidSidecar", () => {
  it("returns empty map when no file exists", async () => {
    const sidecar = new PidSidecar(tmpDir, "s1");
    const all = await sidecar.readAll();
    expect(all).toEqual({});
  });

  it("records an entry and a fresh instance reads it back (sc-2-7 persistence)", async () => {
    const sidecar = new PidSidecar(tmpDir, "s1");
    await sidecar.record("test-run-123", {
      pid: 4242,
      task: "build X",
      spawnedAt: "2026-06-14T00:00:00.000Z",
    });

    // A fresh instance must read from disk, not in-memory state
    const fresh = new PidSidecar(tmpDir, "s1");
    const all = await fresh.readAll();
    expect(all["test-run-123"]).toEqual({
      pid: 4242,
      task: "build X",
      spawnedAt: "2026-06-14T00:00:00.000Z",
    });
  });

  it("accumulates multiple entries without overwriting previous ones", async () => {
    const sidecar = new PidSidecar(tmpDir, "s1");
    await sidecar.record("run-1", { pid: 100, task: "task A", spawnedAt: "2026-06-14T00:00:01.000Z" });
    await sidecar.record("run-2", { pid: 200, task: "task B", spawnedAt: "2026-06-14T00:00:02.000Z" });

    const fresh = new PidSidecar(tmpDir, "s1");
    const all = await fresh.readAll();
    expect(Object.keys(all)).toHaveLength(2);
    expect(all["run-1"]?.pid).toBe(100);
    expect(all["run-2"]?.pid).toBe(200);
  });

  it("is session-scoped: separate sessions do not share entries", async () => {
    const s1 = new PidSidecar(tmpDir, "session-a");
    const s2 = new PidSidecar(tmpDir, "session-b");
    await s1.record("run-x", { pid: 1, task: "t", spawnedAt: "2026-06-14T00:00:00.000Z" });

    const all = await s2.readAll();
    expect(all).toEqual({});
  });

  it("records an entry with no pid (pid optional)", async () => {
    const sidecar = new PidSidecar(tmpDir, "s1");
    await sidecar.record("run-nopid", { task: "foo", spawnedAt: "2026-06-14T00:00:00.000Z" });
    const fresh = new PidSidecar(tmpDir, "s1");
    const all = await fresh.readAll();
    expect(all["run-nopid"]?.pid).toBeUndefined();
    expect(all["run-nopid"]?.task).toBe("foo");
  });
});
