import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * Reading a `.bober/` tree as comparable BYTES.
 *
 * The determinism criterion is "the same golden topology and inputs at concurrency 1 and
 * at concurrency 8 produce byte-identical `.bober/` artifacts, after canonicalisation".
 * Canonicalisation has to be principled or the criterion is worthless, so exactly three
 * classes of substitution are made and each is justified below. Nothing else is touched:
 * every remaining byte of every remaining file is compared literally.
 *
 *  1. WALL-CLOCK VALUES. ISO-8601 timestamps and `duration`/`durationMs` numbers come from
 *     the real clock at the moment the artifact was written. Two runs cannot produce the
 *     same ones and no design could make them. They are replaced, never dropped, so a file
 *     that GAINED or LOST a timestamp still differs.
 *  2. THE PROJECT ROOT. The two runs write into two temp directories, so an absolute path
 *     inside an artifact is a fact about `mkdtemp`, not about the runtime.
 *  3. NOTHING ELSE.
 *
 * ── What is EXCLUDED, and why that is not a dodge ──
 *
 * `.bober/traces/` is excluded from the byte comparison. A trace is an EXECUTION record —
 * one line per node execution, carrying the superstep index that admitted it — and the
 * whole point of raising the cap is to change which superstep a task lands in and how the
 * branches interleave. Requiring the trace to be byte-identical would be requiring the two
 * runs to have the SAME SCHEDULE, which is the opposite of what is being tested.
 *
 * The trace is not thereby unchecked: `determinism.invariant.test.ts` separately asserts
 * that the two runs executed the same MULTISET of (node, branch, status, route) spans, so a
 * run that skipped, duplicated or re-routed a node fails even though its line order is
 * allowed to differ. The bytes that the commit boundary owns — contracts, specs, history,
 * the completion marker — are compared with no exclusion at all.
 */

const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z/g;
const DURATION_FIELD = /"(duration|durationMs)":\s*-?\d+/g;

/** Paths under `.bober/` whose bytes are execution shape rather than committed state. */
export const EXECUTION_SHAPE_PREFIXES = [".bober/traces/"] as const;

export interface CanonicaliseOptions {
  /** Absolute project root, replaced with a stable token wherever it appears. */
  projectRoot: string;
}

/** Apply the three substitutions the module header justifies, and nothing else. */
export function canonicaliseArtifact(text: string, options: CanonicaliseOptions): string {
  return text
    .split(options.projectRoot)
    .join("<ROOT>")
    .replace(ISO_TIMESTAMP, "<TIMESTAMP>")
    .replace(DURATION_FIELD, '"$1": <DURATION>');
}

async function walk(dir: string, base: string, found: string[]): Promise<void> {
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, base, found);
    else found.push(relative(base, full).split(sep).join("/"));
  }
}

/**
 * Every file under `<projectRoot>/.bober/`, keyed by its POSIX-relative path, canonicalised.
 *
 * A `Map` in sorted key order, so a comparison reports WHICH artifact differs rather than
 * "the trees differ".
 */
export async function readArtifactTree(
  projectRoot: string,
  options: { exclude?: readonly string[] } = {},
): Promise<Map<string, string>> {
  const exclude = options.exclude ?? EXECUTION_SHAPE_PREFIXES;
  const found: string[] = [];
  await walk(join(projectRoot, ".bober"), projectRoot, found);

  const tree = new Map<string, string>();
  for (const path of found.sort()) {
    if (exclude.some((prefix) => path.startsWith(prefix))) continue;
    const raw = await readFile(join(projectRoot, path), "utf8");
    tree.set(path, canonicaliseArtifact(raw, { projectRoot }));
  }
  return tree;
}
