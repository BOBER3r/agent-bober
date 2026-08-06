import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initialOverallState } from "../state/overall.js";
import type { OverallState, ScratchRef } from "../state/overall.js";
import {
  ScratchIntegrityError,
  ScratchRefError,
  UnsafePathSegmentError,
  assertSafePathSegment,
  createScratchStore,
  errnoCode,
  readIfPresent,
  resolveWithin,
  scratchPathForRef,
  scratchRunDir,
  selectForRemoval,
} from "./scratch.js";

/**
 * sc-6-1, sc-6-2 — the offload path.
 *
 * The assertions that matter are about SIZE and IDENTITY: a 5 MB payload must survive
 * the round trip byte for byte, the state that references it must stay tiny, and two
 * puts of identical bytes must produce one file rather than two copies.
 */

let root = "";
const RUN = "run-20260805-a";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-scratch-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** True when this process can still read `path` — uid 0 defeats every mode bit. */
async function isReadable(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 5 MB of non-repeating bytes, so a truncating or re-encoding bug cannot pass. */
function fiveMegabyteDiff(): string {
  const chunk: string[] = [];
  for (let i = 0; i < 90_000; i += 1) {
    chunk.push(`@@ -${i},7 +${i},9 @@ line ${i} — ünïcødé ✓ "quoted" \\ backslash\n`);
  }
  const text = chunk.join("");
  expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(5 * 1024 * 1024);
  return text;
}

describe("readIfPresent tells absent from unreadable", () => {
  it("returns present with the exact bytes", async () => {
    const path = join(root, "present.json");
    await writeFile(path, "hello ünïcødé", "utf8");
    expect(await readIfPresent(path)).toEqual({ kind: "present", text: "hello ünïcødé" });
  });

  it("returns absent for ENOENT — and ONLY for ENOENT", async () => {
    expect(await readIfPresent(join(root, "no-such-file.json"))).toEqual({ kind: "absent" });
  });

  it("returns unreadable, carrying the errno, for a directory", async () => {
    // EISDIR (Linux/macOS): the path exists and is not a readable file. Reporting this
    // as "absent" would tell the caller to create what is already there — and would tell
    // a caller that DELETES the absent that it may delete this.
    const read = await readIfPresent(root);
    expect(read.kind).toBe("unreadable");
    if (read.kind !== "unreadable") throw new Error("unreachable");
    expect(read.code).not.toBe("ENOENT");
    expect(read.message.length).toBeGreaterThan(0);
  });

  it("returns unreadable, not absent, for a file whose mode denies reading", async ({ skip }) => {
    const path = join(root, "locked.json");
    await writeFile(path, "secret", "utf8");
    await chmod(path, 0o000);
    try {
      // uid 0 ignores mode bits, and a few filesystems ignore them too. Prove the mode
      // bites in THIS process before asserting on it.
      if (await isReadable(path)) skip("chmod 0o000 does not deny this process");
      expect(await readIfPresent(path)).toEqual({
        kind: "unreadable",
        code: "EACCES",
        message: expect.any(String),
      });
    } finally {
      await chmod(path, 0o600);
    }
  });

  it("errnoCode reads a SystemError's code and nothing else", () => {
    expect(errnoCode(Object.assign(new Error("x"), { code: "EACCES" }))).toBe("EACCES");
    expect(errnoCode(new Error("no code"))).toBeUndefined();
    expect(errnoCode({ code: 13 })).toBeUndefined();
    expect(errnoCode(null)).toBeUndefined();
    expect(errnoCode("EACCES")).toBeUndefined();
  });
});

describe("ScratchStore.put / get (sc-6-1)", () => {
  it("writes .bober/scratch/<runId>/<sha256>.<ext> and returns a 4-field ScratchRef", async () => {
    const store = createScratchStore(root);
    const payload = "generated patch\n";
    const ref = await store.put(RUN, "diff", payload);

    const sha = createHash("sha256").update(Buffer.from(payload, "utf8")).digest("hex");
    expect(ref).toEqual({
      uri: `scratch://${RUN}/${sha}.diff`,
      sha256: sha,
      bytes: Buffer.byteLength(payload, "utf8"),
      kind: "diff",
    });

    const onDisk = join(root, ".bober", "scratch", RUN, `${sha}.diff`);
    expect(await readFile(onDisk, "utf8")).toBe(payload);
    expect(Object.keys(ref).sort()).toEqual(["bytes", "kind", "sha256", "uri"]);
  });

  it("uses the extension registered for each payload kind", async () => {
    const store = createScratchStore(root);
    const extensions: Record<string, string> = {};
    for (const kind of ["stdout", "stderr", "diff", "document", "payload"] as const) {
      const ref = await store.put(RUN, kind, `body of ${kind}`);
      extensions[kind] = ref.uri.split(".").at(-1) ?? "";
    }
    expect(extensions).toEqual({
      stdout: "txt",
      stderr: "txt",
      diff: "diff",
      document: "md",
      payload: "json",
    });
  });

  it("round-trips a 5 MB diff byte-identically through put and get", async () => {
    const store = createScratchStore(root);
    const diff = fiveMegabyteDiff();
    const ref = await store.put(RUN, "diff", diff);

    expect(ref.bytes).toBe(Buffer.byteLength(diff, "utf8"));
    const bytes = await store.get(ref);
    expect(bytes.byteLength).toBe(ref.bytes);
    expect(bytes.equals(Buffer.from(diff, "utf8"))).toBe(true);
    expect(await store.text(ref)).toBe(diff);
  });

  it("round-trips binary bytes that are not valid UTF-8", async () => {
    const store = createScratchStore(root);
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x7f, 0x00]);
    const ref = await store.put(RUN, "payload", bytes);
    expect(ref.bytes).toBe(6);
    expect((await store.get(ref)).equals(bytes)).toBe(true);
  });

  it("putting identical content twice yields ONE file and does not rewrite it", async () => {
    const store = createScratchStore(root);
    const payload = fiveMegabyteDiff();

    const first = await store.put(RUN, "diff", payload);
    const dir = scratchRunDir(root, RUN);
    const inodeAfterFirst = (await stat(join(dir, `${first.sha256}.diff`))).ino;

    const second = await store.put(RUN, "diff", payload);
    expect(second).toEqual(first);

    // One file, and the SAME file: an atomic rewrite would have renamed a new inode
    // over the old one, so a stable inode is proof the second put did not write.
    expect(await readdir(dir)).toEqual([`${first.sha256}.diff`]);
    expect((await stat(join(dir, `${first.sha256}.diff`))).ino).toBe(inodeAfterFirst);
  });

  it("different content in the same run produces different files", async () => {
    const store = createScratchStore(root);
    const a = await store.put(RUN, "diff", "alpha");
    const b = await store.put(RUN, "diff", "beta");
    expect(a.sha256).not.toBe(b.sha256);
    expect((await readdir(scratchRunDir(root, RUN))).length).toBe(2);
  });

  it("leaves no .tmp files behind", async () => {
    const store = createScratchStore(root);
    await store.put(RUN, "document", "notes");
    const names = await readdir(scratchRunDir(root, RUN));
    expect(names.filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});

describe("ScratchStore refuses unusable references", () => {
  it("rejects a runId that would escape the store", async () => {
    const store = createScratchStore(root);
    await expect(store.put("../../etc", "payload", "x")).rejects.toBeInstanceOf(
      UnsafePathSegmentError,
    );
    await expect(store.put("..", "payload", "x")).rejects.toBeInstanceOf(UnsafePathSegmentError);
    await expect(store.put("a/b", "payload", "x")).rejects.toBeInstanceOf(UnsafePathSegmentError);
  });

  it("rejects a uri that resolves outside .bober/scratch/", async () => {
    const store = createScratchStore(root);
    const hostile: ScratchRef = {
      uri: "scratch://../../../../etc/passwd",
      sha256: "0".repeat(64),
      bytes: 1,
      kind: "payload",
    };
    await expect(store.get(hostile)).rejects.toBeInstanceOf(ScratchRefError);
    expect(() => scratchPathForRef(root, hostile)).toThrow(/resolves outside/);
  });

  it("rejects a uri with the wrong scheme", () => {
    expect(() =>
      scratchPathForRef(root, {
        uri: "file:///etc/passwd" as ScratchRef["uri"],
        sha256: "0".repeat(64),
        bytes: 1,
        kind: "payload",
      }),
    ).toThrow(ScratchRefError);
  });

  it("detects a payload whose bytes no longer match its digest", async () => {
    const store = createScratchStore(root);
    const ref = await store.put(RUN, "document", "trustworthy");
    await writeFile(scratchPathForRef(root, ref), "tampered", "utf8");

    await expect(store.get(ref)).rejects.toBeInstanceOf(ScratchIntegrityError);
    await expect(store.get(ref)).rejects.toThrow(/failed its integrity check/);
  });

  it("assertSafePathSegment accepts ordinary ids and refuses traversal", () => {
    expect(() => assertSafePathSegment("runId", "run-2026-08-05_a.1")).not.toThrow();
    for (const bad of ["", ".", "..", "a/b", "a\\b", "a b", "a\u0000b"]) {
      expect(() => assertSafePathSegment("runId", bad), bad).toThrow(UnsafePathSegmentError);
    }
  });

  it("resolveWithin returns null for anything outside the base", () => {
    expect(resolveWithin("/base", "child")).toBe(join("/base", "child"));
    expect(resolveWithin("/base", ".")).toBe("/base");
    expect(resolveWithin("/base", "../sibling")).toBeNull();
    expect(resolveWithin("/base", "/elsewhere")).toBeNull();
    // A sibling directory whose name merely STARTS with the base name is not inside it.
    expect(resolveWithin("/base", "/basement/x")).toBeNull();
  });
});

describe("offloading keeps state small (sc-6-2)", () => {
  it("a 5 MB diff leaves the serialized state under 4 KB and round-trips for a second consumer", async () => {
    const producer = createScratchStore(root);
    const diff = fiveMegabyteDiff();
    const ref = await producer.put(RUN, "diff", diff);

    const state: OverallState = {
      ...initialOverallState({ runId: RUN, projectRoot: root, featureRequest: "add a feature" }),
      refs: { "sprint-1.diff": ref },
    };

    const serialized = JSON.stringify(state);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(4096);
    // The payload itself is 5 MB — the state is three orders of magnitude smaller.
    expect(Buffer.byteLength(diff, "utf8")).toBeGreaterThan(5 * 1024 * 1024);
    expect(serialized).not.toContain("@@ -0,7");

    // A SECOND consumer — a fresh store, constructed from the same root and given only
    // the ref that travelled through state — reads identical bytes.
    const revived = JSON.parse(serialized) as OverallState;
    const consumer = createScratchStore(root);
    const readBack = await consumer.get(revived.refs["sprint-1.diff"] as ScratchRef);
    expect(readBack.equals(Buffer.from(diff, "utf8"))).toBe(true);
    expect(createHash("sha256").update(readBack).digest("hex")).toBe(ref.sha256);
  });
});

describe("retention", () => {
  it("selectForRemoval keeps the newest under each bound", () => {
    const files = [
      { path: "a", bytes: 100, mtimeMs: 1_000 },
      { path: "b", bytes: 100, mtimeMs: 2_000 },
      { path: "c", bytes: 100, mtimeMs: 3_000 },
    ];
    expect(selectForRemoval(files, {}).map((f) => f.path)).toEqual([]);
    expect(selectForRemoval(files, { maxEntries: 2 }).map((f) => f.path)).toEqual(["a"]);
    expect(selectForRemoval(files, { maxEntries: 0 }).map((f) => f.path).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(selectForRemoval(files, { maxBytes: 250 }).map((f) => f.path)).toEqual(["a"]);
    expect(
      selectForRemoval(files, { maxAgeMs: 1_500, now: 3_000 }).map((f) => f.path).sort(),
    ).toEqual(["a"]);
  });

  it("prune removes the oldest payloads and leaves the newest readable", async () => {
    const store = createScratchStore(root);
    const oldRef = await store.put(RUN, "document", "old");
    const newRef = await store.put(RUN, "document", "new");
    // Age the older file explicitly rather than sleeping.
    const oldPath = scratchPathForRef(root, oldRef);
    await utimes(oldPath, new Date(1_000), new Date(1_000));

    await store.prune(RUN, { maxAgeMs: 10_000, now: 1_000_000 });

    expect(await readdir(scratchRunDir(root, RUN))).toEqual([`${newRef.sha256}.md`]);
    expect(await store.text(newRef)).toBe("new");
  });

  it("prune on an unknown run is a no-op rather than a throw", async () => {
    const store = createScratchStore(root);
    await expect(store.prune("run-never-seen", { maxEntries: 0 })).resolves.toBeUndefined();
  });
});
