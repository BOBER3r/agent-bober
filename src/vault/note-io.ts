/**
 * Vault note I/O — filesystem read / write / list helpers.
 *
 * Bridges the pure frontmatter parse/serialize layer (`./frontmatter.ts`) with
 * the real filesystem:
 *   - `readNote`  — readFile + parseFrontmatter, returns a typed VaultNote
 *   - `writeNote` — ensureDir(dirname) + writeFile(serializeNote)
 *   - `listNotes` — glob("**\/*.md", { cwd, absolute: true, nodir: true })
 *
 * All fs access is via `node:fs/promises` (no sync variants).
 * Uses the existing `glob` dependency (same recipe as `src/discovery/scanners/`).
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { glob } from "glob";
import type { VaultNote } from "./types.js";
import { parseNote, serializeNote } from "./frontmatter.js";
import { ensureDir } from "../utils/fs.js";

// ── Read ─────────────────────────────────────────────────────────────

/**
 * Read a markdown file from disk and parse its YAML frontmatter.
 * Returns a fully typed `VaultNote` with `path` set to the given path.
 */
export async function readNote(path: string): Promise<VaultNote> {
  const raw = await readFile(path, "utf-8");
  return parseNote(raw, path);
}

// ── Write ────────────────────────────────────────────────────────────

/**
 * Serialize a `VaultNote` and write it to `note.path`.
 * Parent directories are created automatically (mirrors `writeJson` in utils/fs.ts).
 */
export async function writeNote(note: VaultNote): Promise<void> {
  await ensureDir(dirname(note.path));
  await writeFile(note.path, serializeNote(note), "utf-8");
}

// ── List ─────────────────────────────────────────────────────────────

/**
 * Return the absolute paths of every `.md` file under `vaultDir`, recursively.
 * Uses `glob` (existing repo dependency) — no hand-rolled walker.
 */
export async function listNotes(vaultDir: string): Promise<string[]> {
  return glob("**/*.md", { cwd: vaultDir, absolute: true, nodir: true });
}
