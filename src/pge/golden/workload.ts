// ── workload.ts — the committed real-payload corpus, read from disk ─

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { byteSize } from "../runtime/commit.js";

/**
 * The corpus every channel cap is measured against, and pinned against, for ever after.
 *
 * ── Why a corpus, and why committed ──
 *
 * Sprint 1 of spec-20260812-pge-real-workload-errors found that the shipped 4096-byte
 * `maxInlineBytes` cap on every channel was set from nothing this repository had ever
 * actually run: the largest `PlanSpec`-shaped object anywhere in the 42-case golden dataset
 * is 1,181 bytes, nowhere near this repository's own 29 KB `PlanSpec`. A cap sized from a
 * fixture is a cap sized from nothing, and sprint 3 of this spec needs a number to size the
 * REPLACEMENT cap from. This module is the corpus that number comes from: real `PlanSpec`
 * and `SprintContract` payloads read straight off `.bober/specs/` and `.bober/contracts/`,
 * plus representative generator and evaluator payloads, plus — for the four channels this
 * repository has never committed a real payload for (`refs`, `counters`, `branchStatus`,
 * `ledger`) — payloads OBSERVED from a real `PgeEngine` run rather than invented.
 *
 * Committing it, rather than deriving it at test time from `.bober/specs/` and
 * `.bober/contracts/` directly, is deliberate: a live re-read would let sprint 3's cap
 * silently drift the next time an unrelated spec file is edited, which is precisely the
 * "a fixture can never again be the only evidence" property this corpus exists to hold.
 *
 * ── What is deliberately NOT here ──
 *
 * The logic that BUILDS `.bober/workload/` — reading every committed spec and contract,
 * sampling real eval-results and generator notes, and observing a real engine run for the
 * four channels with no committed payload — lives in
 * `src/pge/golden/__fixtures__/workload-build.ts` and is invoked from
 * `workload.test.ts` behind `BUILD_WORKLOAD_CORPUS=1`, exactly as `capture.ts` /
 * `capture.test.ts` regenerate a golden case and `real-workload.test.ts` regenerates its
 * measurement behind `MEASURE_REAL_WORKLOAD=1`. This module only READS the committed
 * result, and it stays dependency-light on purpose: it compiles into `dist/` (`tsconfig.json`
 * excludes only test files, so a plain "ts" module like this one is always built), and it
 * must never import `src/pge/registry/index.ts` — the composition root `pge-engine.ts`
 * deliberately keeps out of every load-time graph — or drive a `PgeEngine`.
 */

// ── Where the corpus lives ──────────────────────────────────────────

/** Where the committed workload corpus lives, relative to the project root. Never `.bober/golden/` — see the module header of `workload-build.ts` for why. */
export const WORKLOAD_DIR = join(".bober", "workload");

/** Every entry is one file, named for its own `entryId`. */
export const WORKLOAD_ENTRY_FILE_EXTENSION = ".json";

// ── Shapes ──────────────────────────────────────────────────────────

/**
 * Where an entry's value came from.
 *
 * `"file"` — a byte-exact copy of one committed file's parsed value (a `PlanSpec`, an
 * eval-result's derived `SprintVerdict`, ...). `"file-group"` — a value assembled from
 * SEVERAL committed files, e.g. the whole `SprintContract[]` one spec's `sprints` resolves
 * to. `"observed"` — a value with no committed file anywhere in the repository, captured
 * from a real `PgeEngine` run's own `ChannelUpdate`s rather than invented.
 */
export const WorkloadProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), path: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("file-group"), paths: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ kind: z.literal("observed"), source: z.string().min(1) }).strict(),
]);
export type WorkloadProvenance = z.infer<typeof WorkloadProvenanceSchema>;

export const WorkloadEntrySchema = z
  .object({
    entryId: z.string().min(1),
    /** The channel id in `.bober/topology/coding.json` `channels[]` this entry exercises. */
    channel: z.string().min(1),
    provenance: WorkloadProvenanceSchema,
    /** The value a node would write to `channel`. Never re-derived — see the module header. */
    value: z.unknown(),
  })
  .strict();
export type WorkloadEntry = z.infer<typeof WorkloadEntrySchema>;

export interface WorkloadCorpus {
  readonly dir: string;
  /** Every entry `readdir` returned, in sorted order. Not filtered — errors are reported instead. */
  readonly files: readonly string[];
  readonly entries: readonly WorkloadEntry[];
  /** Unreadable, unparseable or schema-violating files. */
  readonly errors: readonly string[];
}

// ── Loading ─────────────────────────────────────────────────────────

/**
 * Read every file under `dir` as a workload entry.
 *
 * `readdir` rather than a manifest, deliberately: the same reason `loadGoldenDataset`
 * (`src/pge/golden/runner.ts`) reads its directory rather than trusting a list — a
 * hardcoded list of entries is a list that drifts from the directory, and the first thing
 * it hides is an entry someone deleted.
 */
export async function loadWorkloadCorpus(dir: string): Promise<WorkloadCorpus> {
  let files: string[];
  try {
    files = (await readdir(dir)).sort();
  } catch (error) {
    return {
      dir,
      files: [],
      entries: [],
      errors: [
        `${dir}: cannot read the workload corpus directory (${error instanceof Error ? error.message : String(error)})`,
      ],
    };
  }

  const entries: WorkloadEntry[] = [];
  const errors: string[] = [];

  for (const file of files) {
    if (!file.endsWith(WORKLOAD_ENTRY_FILE_EXTENSION)) {
      errors.push(`${file}: not a workload entry file (does not end in "${WORKLOAD_ENTRY_FILE_EXTENSION}")`);
      continue;
    }

    let text: string;
    try {
      text = await readFile(join(dir, file), "utf-8");
    } catch (error) {
      errors.push(`${file}: unreadable (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      errors.push(`${file}: not JSON (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }

    const result = WorkloadEntrySchema.safeParse(parsed);
    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push(`${file}: ${issue.path.join(".") || "<root>"} — ${issue.message}`);
      }
      continue;
    }

    const expectedName = `${result.data.entryId}${WORKLOAD_ENTRY_FILE_EXTENSION}`;
    if (file !== expectedName) {
      errors.push(
        `${file}: entryId is "${result.data.entryId}", so the file must be named ${expectedName} — an entry whose id and filename disagree cannot be found from a failure message`,
      );
      continue;
    }

    entries.push(result.data);
  }

  return { dir, files, entries, errors };
}

// ── The metric ──────────────────────────────────────────────────────

/**
 * The largest serialised byte size the corpus holds, per channel.
 *
 * sc-2-2: `byteSize` here is IMPORTED from `../runtime/commit.js` — the exact function the
 * commit boundary's own cap check uses — never reimplemented. Two independently-maintained
 * copies of the metric that decides every channel cap is exactly the drift a committed
 * corpus exists to prevent.
 *
 * A channel absent from the corpus is absent from the result rather than defaulted to `0`:
 * a `0` would read as "measured and found small," which is a different fact from "not
 * measured at all" (see sc-2-4).
 */
export function maxBytesPerChannel(corpus: WorkloadCorpus): Record<string, number> {
  const max: Record<string, number> = {};
  for (const entry of corpus.entries) {
    const bytes = byteSize(entry.value);
    const current = max[entry.channel];
    if (current === undefined || bytes > current) max[entry.channel] = bytes;
  }
  return max;
}
