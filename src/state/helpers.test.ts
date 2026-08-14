/**
 * Colocated unit tests for the state helpers.
 *
 * writeFileAtomic exists because approval markers are polled by another
 * process: `bober approve` / the MCP tool write .bober/approvals/<id>.approved.json
 * while DiskCheckpointMechanism watches the directory for that entry to appear.
 * A plain writeFile publishes the directory entry at open(2), before any bytes
 * land, so the poller could read zero bytes or a prefix and fail to parse it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFileAtomic } from "./helpers.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-atomic-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it("never exposes a partially written payload under the final name", async () => {
    // 2 MB: node writes a payload this size in several 512 KiB chunks, so an
    // in-place write is observable mid-flight by a reader that polls the
    // directory — exactly what the checkpoint poll loop does.
    const name = "post-plan.approved.json";
    const target = join(tmpDir, name);
    const payload =
      JSON.stringify({
        approvedAt: "2026-08-14T00:00:00.000Z",
        approverId: "test-user",
        editDelta: { before: "", after: "y".repeat(2_000_000) },
      }) + "\n";

    let settled = false;
    const write = writeFileAtomic(target, payload).then(() => {
      settled = true;
    });

    // Poll the directory for the final name and read it on every sighting,
    // mirroring disk.ts: readdir -> presence check -> readFile -> JSON.parse.
    const sightings: string[] = [];
    while (!settled) {
      const entries = new Set(await readdir(tmpDir).catch(() => [] as string[]));
      if (entries.has(name)) {
        sightings.push(await readFile(target, "utf-8").catch(() => ""));
      }
    }
    await write;

    // The invariant: if the poller can see the name at all, the bytes are there.
    for (const raw of sightings) {
      expect(() => JSON.parse(raw) as unknown).not.toThrow();
    }
    // And the committed file is complete.
    expect(await readFile(target, "utf-8")).toBe(payload);
  });

  it("leaves no temp file behind on success", async () => {
    await writeFileAtomic(join(tmpDir, "marker.json"), '{"ok":true}\n');
    expect(await readdir(tmpDir)).toEqual(["marker.json"]);
  });

  it("leaves no temp file behind when the rename target is unwritable", async () => {
    // A directory cannot be replaced by rename(2) from a regular file.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(tmpDir, "occupied"), { recursive: true });

    await expect(
      writeFileAtomic(join(tmpDir, "occupied"), '{"ok":true}\n'),
    ).rejects.toThrow();

    // Only the pre-existing directory remains — no orphaned .tmp sibling.
    expect(await readdir(tmpDir)).toEqual(["occupied"]);
  });
});
