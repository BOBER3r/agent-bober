// ── source-text.invariant.test.ts ────────────────────────────────────
//
// NO RAW CONTROL BYTES IN SOURCE.
//
// A source file containing a raw control byte is classified as binary by
// content-based tooling, which then silently SKIPS it. `grep` bails without a
// match, ripgrep prints "binary file matches" instead of the lines, and both
// semgrep and gitleaks — the deterministic scanners this repo's security gate
// drives (src/security/security-scanners.ts) — omit the file entirely. The
// file is not flagged; it is simply never read. That is the dangerous part:
// the gate reports success on a file it never examined.
//
// Four files carried such bytes, and every one of them was invisible to the
// scanners for as long as it did. Two were found by security audits; the other
// two were found by this scan on its first run, which is the argument for
// having it:
//
//   - src/pge/registry/reducers.ts — a NUL separating the parts of a ledger
//     composite key, and a 0x01 sentinel prefixing the non-object key form.
//     This is the module deciding which of two conflicting values survives
//     EVERY channel merge, so it is precisely the code most worth auditing.
//   - src/pge/runtime/frontier.ts — a NUL inside computeTaskKey, the resume
//     identity key. Found by this scan, not by either audit.
//   - src/pge/topology/docs.test.ts — a NUL separating joined row fields.
//   - tests/graph/cli.test.ts — ESC bytes in an ANSI-coloured CLI fixture.
//     Also found by this scan, and the reason the walk covers tests/ too: a
//     test file the scanners cannot read is the same blind spot as a source one.
//
// The fix in every case was to spell the same byte as a `\uXXXX` escape. The
// runtime string is byte-identical — the golden gate passing unchanged across
// those edits is the proof — while the file stays readable as text.
//
// This invariant stops the pattern returning. It is deliberately about the
// FILE's bytes, not about any behaviour, because the failure it guards against
// is a tooling blind spot rather than a bug.

import { Buffer } from "node:buffer";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Both trees are scanned. `tests/` matters as much as `src/`: an unreadable
 * test file hides whatever the scanners would have said about it just as
 * effectively, and one of the four offenders lived there.
 */
const SCAN_ROOTS = ["src", "tests"] as const;

/**
 * Tab, newline and carriage return are the only control bytes legitimately
 * present in source text. Everything else below 0x20, plus DEL, makes the file
 * binary to the scanners.
 */
function isForbiddenControlByte(byte: number): boolean {
  if (byte === 0x09 || byte === 0x0a || byte === 0x0d) return false;
  return byte < 0x20 || byte === 0x7f;
}

export interface ControlByteHit {
  /** Repo-relative path with forward slashes, so failures read the same everywhere. */
  readonly file: string;
  readonly line: number;
  /** Lower-case hex, e.g. "0x00". */
  readonly byte: string;
}

/**
 * Pure core: report every forbidden control byte in a buffer. Driven directly
 * by the mutation controls below with in-memory content, so proving the scan
 * bites never requires writing a planted offender into the repo.
 */
export function findControlBytes(file: string, content: Buffer): ControlByteHit[] {
  const hits: ControlByteHit[] = [];
  let line = 1;
  for (const byte of content) {
    if (byte === 0x0a) {
      line++;
      continue;
    }
    if (isForbiddenControlByte(byte)) {
      hits.push({ file, line, byte: "0x" + byte.toString(16).padStart(2, "0") });
    }
  }
  return hits;
}

async function collectSourceFiles(dir: string, acc: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    // withFileTypes reports a symlink AS a symlink, so the walk cannot be
    // redirected outside SRC_ROOT by planting one.
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      await collectSourceFiles(full, acc);
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".mts"))) {
      acc.push(full);
    }
  }
  return acc;
}

const asRepoRelative = (full: string): string => relative(REPO_ROOT, full).split(sep).join("/");

async function collectAllScanned(): Promise<string[]> {
  const acc: string[] = [];
  for (const root of SCAN_ROOTS) await collectSourceFiles(join(REPO_ROOT, root), acc);
  return acc;
}

describe("no source file under src/ or tests/ contains a raw control byte", () => {
  it("walks both trees — liveness control, so an empty scan cannot pass vacuously", async () => {
    const files = await collectAllScanned();
    expect(files.length).toBeGreaterThan(200);
    // Each root contributes, so a rename that empties one is not silently tolerated.
    for (const root of SCAN_ROOTS) {
      expect(files.some((f) => asRepoRelative(f).startsWith(`${root}/`))).toBe(true);
    }
  });

  it("finds no forbidden control byte in any committed source file", async () => {
    const offenders: ControlByteHit[] = [];
    for (const full of await collectAllScanned()) {
      offenders.push(...findControlBytes(asRepoRelative(full), await readFile(full)));
    }
    // Reported as `path:line byte` so a failure names the file to fix, not just a count.
    expect(offenders.map((o) => `${o.file}:${o.line} ${o.byte}`)).toEqual([]);
  });

  it("the four files that used to carry raw bytes are readable as text", async () => {
    // Named explicitly: these are the ones the invariant exists for, and a
    // regression in any of them is the exact failure that motivated it.
    for (const path of [
      "src/pge/registry/reducers.ts",
      "src/pge/runtime/frontier.ts",
      "src/pge/topology/docs.test.ts",
      "tests/graph/cli.test.ts",
    ]) {
      const content = await readFile(join(REPO_ROOT, path));
      expect(findControlBytes(path, content)).toEqual([]);
    }
  });

  // ── Mutation controls ──────────────────────────────────────────────
  // Driven with in-memory buffers; nothing is ever written into the repo.

  it("BITES: reports a planted NUL byte, with its line", () => {
    const planted = Buffer.from(`const a = 1;\nconst sep = "${String.fromCharCode(0)}";\n`, "utf-8");
    expect(findControlBytes("planted.ts", planted)).toEqual([
      { file: "planted.ts", line: 2, byte: "0x00" },
    ]);
  });

  it("BITES: reports the 0x01 sentinel form too, not just NUL", () => {
    const planted = Buffer.from(`const k = \`${String.fromCharCode(1)}x\`;\n`, "utf-8");
    expect(findControlBytes("planted.ts", planted)).toEqual([
      { file: "planted.ts", line: 1, byte: "0x01" },
    ]);
  });

  it("does NOT bite on the escape sequence that replaced them", () => {
    // The whole point of the fix: the same runtime string, spelled as text.
    const fixed = Buffer.from('const sep = "\\u0000";\n', "utf-8");
    expect(findControlBytes("fixed.ts", fixed)).toEqual([]);
  });

  it("does NOT bite on tab, newline or carriage return", () => {
    const ordinary = Buffer.from("const a = 1;\n\tconst b = 2;\r\n", "utf-8");
    expect(findControlBytes("ordinary.ts", ordinary)).toEqual([]);
  });

  it("counts lines correctly when an offender follows several newlines", () => {
    const planted = Buffer.from(`a\nb\nc\n${String.fromCharCode(0)}\n`, "utf-8");
    expect(findControlBytes("planted.ts", planted)).toEqual([
      { file: "planted.ts", line: 4, byte: "0x00" },
    ]);
  });
});
