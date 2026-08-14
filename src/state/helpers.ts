import { mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

/**
 * Publish a file atomically: write a sibling temp file, then rename it over the
 * target. rename(2) within a directory is atomic, so a concurrent reader sees
 * either the old file or the complete new one — never a half-written one.
 *
 * Plain writeFile is NOT safe for a file another process watches for:
 * open(2) creates the directory entry before any bytes land, and payloads over
 * 512 KiB are written in several chunks. A reader that triggers on the entry
 * appearing (readdir + presence check) can therefore read zero bytes or a
 * prefix. Same commit-point discipline as history-rotation.ts, and as the
 * approval writer in pge/golden/executor.ts.
 *
 * The temp name keeps the target's directory (rename must not cross a
 * filesystem) and ends in `.tmp`, so it never matches a `.pending.json` /
 * `.approved.json` / `.rejected.json` scan.
 *
 * Note: this guarantees atomic VISIBILITY, not crash durability — there is no
 * fsync, so a machine crash can still lose the bytes. That matches the existing
 * rotation path and is sufficient for the marker races this guards.
 */
export async function writeFileAtomic(
  filePath: string,
  data: string,
): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, data, "utf-8");
    await rename(tmp, filePath);
  } catch (err) {
    // Never leave a temp file behind on failure.
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
