/**
 * Unit tests for CarefulSidecar (sc-1-6).
 *
 * Tests use a real temp dir — no fs mocks per project principles.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CarefulSidecar } from "./careful-sidecar.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-careful-sidecar-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("CarefulSidecar (sc-1-6)", () => {
  it("returns false for missing sidecar file (default autopilot)", async () => {
    const sidecar = new CarefulSidecar(tmpDir, "session-1");
    const result = await sidecar.isCareful();
    expect(result).toBe(false);
  });

  it("toggle on: fresh instance reads careful as true", async () => {
    const sidecar = new CarefulSidecar(tmpDir, "session-1");
    await sidecar.setCareful(true);

    // Fresh instance same sessionId must read persisted value
    const fresh = new CarefulSidecar(tmpDir, "session-1");
    expect(await fresh.isCareful()).toBe(true);
  });

  it("toggle off: fresh instance reads careful as false", async () => {
    const sidecar = new CarefulSidecar(tmpDir, "session-1");
    await sidecar.setCareful(true);
    await sidecar.setCareful(false);

    const fresh = new CarefulSidecar(tmpDir, "session-1");
    expect(await fresh.isCareful()).toBe(false);
  });

  it("session isolation: different sessionIds have independent careful flags", async () => {
    const sidecarA = new CarefulSidecar(tmpDir, "session-a");
    const sidecarB = new CarefulSidecar(tmpDir, "session-b");

    await sidecarA.setCareful(true);
    // session-b has NOT been set — should default to false
    expect(await sidecarB.isCareful()).toBe(false);
    expect(await sidecarA.isCareful()).toBe(true);
  });

  it("toggle on then off and back on — final state is true", async () => {
    const sidecar = new CarefulSidecar(tmpDir, "session-1");
    await sidecar.setCareful(true);
    await sidecar.setCareful(false);
    await sidecar.setCareful(true);

    const fresh = new CarefulSidecar(tmpDir, "session-1");
    expect(await fresh.isCareful()).toBe(true);
  });

  it("malformed sidecar file returns false without throwing", async () => {
    // Write a malformed JSON file in the expected location
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { join: pathJoin } = await import("node:path");
    await mkdir(pathJoin(tmpDir, ".bober", "chat"), { recursive: true });
    await writeFile(
      pathJoin(tmpDir, ".bober", "chat", "session-bad.careful.json"),
      "{ this is not valid json }}",
      "utf-8",
    );

    const sidecar = new CarefulSidecar(tmpDir, "session-bad");
    expect(await sidecar.isCareful()).toBe(false);
  });
});
