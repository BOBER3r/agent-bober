import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname, resolve } from "node:path";

// ── File-System Helpers ────────────────────────────────────────────

/**
 * Async check whether a file exists and is readable.
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a JSON file and parse it with an optional type parameter.
 *
 * Throws if the file does not exist or contains invalid JSON.
 */
export async function readJson<T = unknown>(path: string): Promise<T> {
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as T;
}

/**
 * Write data as pretty-printed JSON to the given path.
 *
 * Parent directories are created automatically.
 */
export async function writeJson(
  path: string,
  data: unknown,
): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

/**
 * Create a directory (and any missing parents) if it does not already exist.
 */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/**
 * Walk up the directory tree from `startDir` looking for a project root.
 *
 * A directory is considered a project root if it contains
 * `bober.config.json` or `package.json`.
 *
 * @param startDir Starting directory (defaults to `process.cwd()`).
 * @returns Absolute path to the project root, or `null` if none found.
 */
export async function findProjectRoot(
  startDir?: string,
): Promise<string | null> {
  let dir = resolve(startDir ?? process.cwd());

  const markers = ["bober.config.json", "package.json"];

  for (;;) {
    for (const marker of markers) {
      if (await fileExists(join(dir, marker))) {
        return dir;
      }
    }

    const parent = dirname(dir);
    if (parent === dir) {
      // Reached filesystem root without finding a marker.
      return null;
    }
    dir = parent;
  }
}
