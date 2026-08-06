// ── EngineConformanceHarness ────────────────────────────────────────

import { readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { listContracts } from "../../state/sprint-state.js";
import { loadHistory } from "../../state/history.js";
import { listSpecs } from "../../state/plan-state.js";
import { listBriefings, readBriefing } from "../../state/briefing-state.js";
import { listReviews, readReview } from "../../state/review-state.js";
import { listRunStateFiles } from "../../state/run-state.js";
import { loadEvalResults } from "../memory/eval-source.js";
import { COMPLETION_MARKER_SUFFIX, runsDir } from "../finalize.js";
import { logger } from "../../utils/logger.js";
import type { PipelineResult } from "../pipeline.js";
import type { PipelineEngineName } from "./engine.js";
import { CONFORMANCE_FIELDS } from "./types.js";
import type {
  ConformanceArtifactName,
  ConformanceDiff,
  ConformanceField,
  ConformanceFieldReport,
  ConformanceReport,
} from "./types.js";

// ── Types ───────────────────────────────────────────────────────────

/**
 * The runner the CALLER injects — this harness never constructs an engine.
 *
 * Deliberate: the harness's job is to compare two sets of artifacts, and a harness that
 * built its own engines would decide which engines it is possible to compare. A runner
 * that returns its {@link PipelineResult} lets the eleventh field — which is a VALUE and
 * not a file — be compared with the other ten; returning nothing keeps every runner
 * written before that field existed valid.
 */
export type EngineRunner = (projectRoot: string) => Promise<void | PipelineResult>;

// ── Normalization ────────────────────────────────────────────────────

/**
 * Volatile fields stripped before deep-compare.
 *
 * These EIGHT are the original set and cover SprintContract, PlanSpec, HistoryEntry,
 * EvalResult, RunState, the completion marker and PipelineResult.
 *
 * The bar for adding a key is deliberately high: a key here makes a real divergence
 * invisible, and the whole point of this harness is that a divergence is loud. A key
 * belongs here only when two runs of the SAME engine over the same input would differ on
 * it. Two additions clear that bar and no more:
 *
 *  - `durationMs` — `ApprovalRecord.durationMs` (checkpoints/audit.ts:69) is elapsed wall
 *    time around a human/mechanism decision. It is a measurement of the machine, not of
 *    the engine, and the same run twice never reproduces it.
 *  - `approverId` — `ApprovalRecord.approverId` is resolved from the environment
 *    (`resolveApproverId`, checkpoints/audit.ts:166), so it is a property of who ran the
 *    comparison. Note the narrowness: this hides WHO approved, never WHETHER approval
 *    happened — `outcome`, `mechanism`, `checkpointId` and `iteration` all stay compared.
 *
 * Not added, and named here so a future reader can see the decision was made: `phase`,
 * `event`, `status`, `verdict`, `success`, `outcome`, `mechanism`. Every one of those is
 * an engine-observable fact, and stripping it would hide exactly the divergence this
 * harness exists to find.
 */
const VOLATILE_KEYS = new Set([
  "createdAt",
  "updatedAt",
  "startedAt",
  "completedAt",
  "timestamp",
  "duration",
  "runId",
  "totalCost",
  "durationMs",
  "approverId",
]);

/**
 * Recursively deep-clone a value, stripping volatile fields and sorting object keys.
 *
 * Key sorting is what makes the JSON encoding below a CANONICAL form: two writers that
 * emit the same object with the keys in a different order are the same artifact, and a
 * byte comparison that said otherwise would report a divergence that does not exist.
 */
function normalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(normalize);
  }

  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    if (!VOLATILE_KEYS.has(k)) {
      result[k] = normalize(obj[k]);
    }
  }
  return result;
}

/** The canonical bytes of a normalized value. Two values are equal iff these match. */
function canonical(value: unknown): string {
  return JSON.stringify(normalize(value) ?? null);
}

/** The placeholder every occurrence of an engine's own project root collapses to. */
export const REDACTED_PROJECT_ROOT = "<projectRoot>";

/**
 * Replace an engine's own project root wherever it appears inside a string value.
 *
 * The harness hands each engine a DIFFERENT fresh root — that is the isolation the
 * comparison rests on — so every artifact that records where it ran (`RunState.projectRoot`,
 * `worktreePath`, a path inside a failure artifact) differs by construction. That is the
 * harness's own doing and not a divergence between engines.
 *
 * Redaction rather than a {@link VOLATILE_KEYS} entry, deliberately: stripping
 * `projectRoot` would also hide an engine that wrote the WRONG root, whereas redacting the
 * root the engine was GIVEN still fails loudly if an engine writes some other path. The
 * check survives; only the incidental difference goes.
 */
function redactRoots(value: unknown, roots: readonly string[]): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const root of roots) out = out.split(root).join(REDACTED_PROJECT_ROOT);
    return out;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => redactRoots(entry, roots));
  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) result[k] = redactRoots(v, roots);
  return result;
}

// ── Order-tolerant collections ───────────────────────────────────────

/**
 * A keyed collection, normalized and SORTED by a stable key.
 *
 * Order tolerance is a real requirement and a real hazard. Two engines that write the
 * same three contracts in a different order have written the same artifact set, and a
 * position-wise comparison would call that a divergence. But sorting must not be able to
 * make CONTENT vanish, so the sort key is `<identity>\u0000<canonical bytes>`: identity
 * groups an artifact with its counterpart, and the canonical bytes break ties totally.
 * A changed field changes the bytes, so it changes the element — it cannot be sorted away.
 */
interface KeyedCollection {
  /** Sort key -> canonical bytes, in sorted key order. */
  readonly entries: ReadonlyArray<{ key: string; identity: string; bytes: string }>;
}

function keyedCollection(
  values: readonly unknown[],
  identityOf: (value: unknown, index: number) => string,
): KeyedCollection {
  const entries = values.map((value, index) => {
    const bytes = canonical(value);
    const identity = identityOf(value, index);
    return { key: `${identity}\u0000${bytes}`, identity, bytes };
  });
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { entries };
}

/** Read `field` off a record, as a string, when it is one. */
function stringField(value: unknown, field: string): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" ? candidate : null;
}

/** Identity by a declared id field, falling back to the canonical bytes. */
function idIdentity(field: string): (value: unknown) => string {
  return (value) => stringField(value, field) ?? canonical(value);
}

/**
 * The first element that differs between two keyed collections.
 *
 * Returns the identity of the offending element and which side has it, so a diff can name
 * `.bober/contracts/<contractId>` instead of `.bober/contracts/`.
 */
function firstDivergence(
  a: KeyedCollection,
  b: KeyedCollection,
): { identity: string; detail: string } | null {
  const countsA = new Map<string, number>();
  const countsB = new Map<string, number>();
  for (const entry of a.entries) countsA.set(entry.key, (countsA.get(entry.key) ?? 0) + 1);
  for (const entry of b.entries) countsB.set(entry.key, (countsB.get(entry.key) ?? 0) + 1);

  // Present on exactly one side (or a different number of times) — reported first,
  // because "the other engine never wrote this at all" is the more informative fact.
  for (const entry of [...a.entries, ...b.entries]) {
    const inA = countsA.get(entry.key) ?? 0;
    const inB = countsB.get(entry.key) ?? 0;
    if (inA === inB) continue;
    return {
      identity: entry.identity,
      detail: `"${entry.identity}" appears ${String(inA)} time(s) on the first engine and ${String(inB)} time(s) on the second`,
    };
  }

  return null;
}

// ── Readers ──────────────────────────────────────────────────────────

/**
 * `.bober/progress.md`, with its one volatile line removed.
 *
 * Markdown, so {@link VOLATILE_KEYS} cannot reach it: `updateProgress` stamps
 * `Last updated: <ISO>` (state/history.ts:169) into the body. The line is dropped
 * textually and nothing else is touched — a substring filter over the whole document
 * would be a licence to erase content that happened to look like a timestamp.
 */
async function readProgress(projectRoot: string): Promise<string | null> {
  try {
    const text = await readFile(join(projectRoot, ".bober", "progress.md"), "utf-8");
    return text
      .split("\n")
      .filter((line) => !line.startsWith("Last updated: "))
      .join("\n");
  } catch {
    return null;
  }
}

/**
 * Every `ApprovalRecord` under `.bober/audits/`.
 *
 * Read here rather than through a reader module because none exists: `audit.ts` publishes
 * only `getAuditPath`, and the harness does not know the run ids in advance. Inventing a
 * production reader for one consumer would put a module in `src/orchestrator/` that
 * nothing but this comparison calls.
 */
async function readAudits(projectRoot: string): Promise<unknown[]> {
  const dir = join(projectRoot, ".bober", "audits");
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const records: unknown[] = [];
  for (const file of files.filter((f) => f.endsWith(".jsonl")).sort()) {
    let text: string;
    try {
      text = await readFile(join(dir, file), "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        records.push(JSON.parse(trimmed) as unknown);
      } catch {
        // A torn last line is not a divergence between engines; skip it, exactly as
        // loadHistory does for the same file shape.
      }
    }
  }
  return records;
}

/**
 * Every completion marker under `.bober/runs/`.
 *
 * `completionMarkerPath` needs a run id and the two engines run under DIFFERENT run ids by
 * construction, so the directory is scanned for the suffix `finalize.ts` publishes.
 */
async function readCompletionMarkers(projectRoot: string): Promise<unknown[]> {
  let files: string[];
  try {
    files = await readdir(runsDir(projectRoot));
  } catch {
    return [];
  }

  const markers: unknown[] = [];
  for (const file of files.filter((f) => f.endsWith(COMPLETION_MARKER_SUFFIX)).sort()) {
    try {
      const text = await readFile(join(runsDir(projectRoot), file), "utf-8");
      markers.push(JSON.parse(text) as unknown);
    } catch {
      // Unreadable or half-written marker — not this harness's failure to report.
    }
  }
  return markers;
}

/** Briefings as `{ contractId, content }`, so a diff can name the briefing that differs. */
async function readBriefings(projectRoot: string): Promise<unknown[]> {
  const ids = await listBriefings(projectRoot);
  const out: unknown[] = [];
  for (const contractId of ids) {
    out.push({ contractId, content: await readBriefing(projectRoot, contractId) });
  }
  return out;
}

/** Reviews as `{ contractId, content }`, for the same reason as {@link readBriefings}. */
async function readReviews(projectRoot: string): Promise<unknown[]> {
  const ids = await listReviews(projectRoot);
  const out: unknown[] = [];
  for (const contractId of ids) {
    out.push({ contractId, content: await readReview(projectRoot, contractId) });
  }
  return out;
}

// ── Field table ──────────────────────────────────────────────────────

/**
 * The eleven fields, each with the artifact name a diff reports, the path it lives at,
 * and the identity a keyed comparison sorts by.
 *
 * Every field is an ARRAY here, including the two that are logically scalar: `progress` is
 * one document and `pipelineResult` is one value, and both are carried as a zero-or-one
 * element array so one comparator serves all eleven and "absent" is expressible as an
 * empty collection rather than as `null` meaning two different things.
 */
interface FieldSpec {
  readonly field: ConformanceField;
  readonly artifact: ConformanceArtifactName;
  readonly path: string;
  /** How an element of this collection is identified when reporting a divergence. */
  readonly identityOf: (value: unknown, index: number) => string;
  /** Appended to `path` to name one element. Absent for the scalar fields. */
  readonly elementPath?: (identity: string) => string;
}

const FIELD_SPECS: readonly FieldSpec[] = [
  {
    field: "contracts",
    artifact: "contract",
    path: ".bober/contracts/",
    identityOf: idIdentity("contractId"),
    elementPath: (id) => `.bober/contracts/${id}.json`,
  },
  {
    field: "history",
    artifact: "history",
    path: ".bober/history.jsonl",
    identityOf: idIdentity("event"),
    elementPath: (id) => `.bober/history.jsonl#${id}`,
  },
  {
    field: "specs",
    artifact: "spec",
    path: ".bober/specs/",
    identityOf: idIdentity("specId"),
    elementPath: (id) => `.bober/specs/${id}.json`,
  },
  {
    field: "evalResults",
    artifact: "eval-result",
    path: ".bober/eval-results/",
    identityOf: idIdentity("evalId"),
    elementPath: (id) => `.bober/eval-results/${id}.json`,
  },
  {
    field: "briefings",
    artifact: "briefing",
    path: ".bober/briefings/",
    identityOf: idIdentity("contractId"),
    elementPath: (id) => `.bober/briefings/${id}-briefing.md`,
  },
  {
    field: "reviews",
    artifact: "review",
    path: ".bober/reviews/",
    identityOf: idIdentity("contractId"),
    elementPath: (id) => `.bober/reviews/${id}-review.md`,
  },
  {
    field: "audits",
    artifact: "audit",
    path: ".bober/audits/",
    identityOf: idIdentity("checkpointId"),
    elementPath: (id) => `.bober/audits/#${id}`,
  },
  {
    field: "progress",
    artifact: "progress",
    path: ".bober/progress.md",
    identityOf: () => "progress",
  },
  {
    field: "runState",
    artifact: "run-state",
    path: ".bober/runs/<runId>/state.json",
    identityOf: idIdentity("status"),
    elementPath: (id) => `.bober/runs/<runId>/state.json#${id}`,
  },
  {
    field: "completionMarker",
    artifact: "completion-marker",
    path: `.bober/runs/<runId>${COMPLETION_MARKER_SUFFIX}`,
    identityOf: idIdentity("phase"),
  },
  {
    field: "pipelineResult",
    artifact: "pipeline-result",
    path: "<PipelineEngine.run return value>",
    identityOf: () => "pipelineResult",
  },
];

/** Every spelling of one project root, longest first so a prefix never masks a suffix. */
async function rootAliases(root: string): Promise<string[]> {
  const aliases = new Set<string>([root]);
  try {
    aliases.add(await realpath(root));
  } catch {
    // A root that no longer resolves is still redactable by its literal spelling.
  }
  return [...aliases].sort((a, b) => b.length - a.length);
}

/** Collect all eleven fields from one finished run. */
async function collectFields(
  projectRoot: string,
  pipelineResult: void | PipelineResult,
): Promise<Record<ConformanceField, unknown[]>> {
  const progress = await readProgress(projectRoot);
  return {
    contracts: await listContracts(projectRoot),
    history: await loadHistory(projectRoot),
    specs: await listSpecs(projectRoot),
    evalResults: await loadEvalResults(projectRoot),
    briefings: await readBriefings(projectRoot),
    reviews: await readReviews(projectRoot),
    audits: await readAudits(projectRoot),
    progress: progress === null ? [] : [progress],
    runState: await listRunStateFiles(projectRoot),
    completionMarker: await readCompletionMarkers(projectRoot),
    pipelineResult: pipelineResult === undefined ? [] : [pipelineResult],
  };
}

// ── EngineConformanceHarness ─────────────────────────────────────────

/**
 * Asserts that two or more pipeline engines produce equivalent `.bober/` artifacts for a
 * given fixture spec, across the ELEVEN artifact fields sc-13-2 names, ignoring the
 * volatile fields listed at {@link VOLATILE_KEYS}.
 *
 * DESIGN — no real engines run inside. The caller provides `runnerFor`, which returns a
 * runner per engine name; each runner writes to a FRESH project root supplied by
 * `projectRootFactory`. The harness reads back, normalizes, sorts and compares. That is
 * what lets the same harness gate deterministic stubs in a unit test and two real engines
 * in an integration test without knowing the difference.
 *
 * DESIGN — a comparison of nothing is not an equivalence. Every field records whether it
 * was populated per engine, and a report in which no field was populated for any engine
 * is `vacuous` and can never be `equivalent`.
 */
export class EngineConformanceHarness {
  /**
   * Run each engine's runner against a fresh projectRoot, read back the eleven artifact
   * fields, normalize (strip volatile fields, sort keys), sort each keyed collection, and
   * deep-compare across engine pairs.
   *
   * @param fixtureSpecId   The spec ID to pass to runners (informational).
   * @param engines         Names of engines to compare (at least two for a diff).
   * @param projectRootFactory  Returns a FRESH temporary root per engine.
   * @param runnerFor       Returns the EngineRunner for each engine.
   * @returns ConformanceReport with equivalent:true only if all eleven fields match AND
   *          the comparison was not vacuous.
   */
  async assertEquivalent(
    fixtureSpecId: string,
    engines: PipelineEngineName[],
    projectRootFactory: () => Promise<string>,
    runnerFor: (engine: PipelineEngineName) => EngineRunner,
  ): Promise<ConformanceReport> {
    // ── Collect per-engine artifacts ─────────────────────────────────────

    const perEngine: Record<string, Record<ConformanceField, KeyedCollection>> = {};
    const counts: Record<ConformanceField, Record<string, number>> = Object.fromEntries(
      CONFORMANCE_FIELDS.map((field) => [field, {}]),
    ) as Record<ConformanceField, Record<string, number>>;

    for (const engine of engines) {
      const root = await projectRootFactory();
      const runner = runnerFor(engine);

      logger.debug(
        `[conformance] running ${engine} runner against ${root} (specId=${fixtureSpecId})`,
      );

      const pipelineResult = await runner(root);
      const raw = await collectFields(root, pipelineResult);
      // Both the given root and its resolved form: on macOS `os.tmpdir()` yields
      // `/var/folders/...` while anything that resolves the path writes
      // `/private/var/folders/...`, and an artifact recording the second would otherwise
      // survive redaction of the first.
      const roots = await rootAliases(root);

      const collected = {} as Record<ConformanceField, KeyedCollection>;
      for (const spec of FIELD_SPECS) {
        const values = raw[spec.field].map((value) => redactRoots(value, roots));
        collected[spec.field] = keyedCollection(values, spec.identityOf);
        counts[spec.field][engine] = values.length;
      }
      perEngine[engine] = collected;
    }

    // ── Deep-compare across engine pairs ─────────────────────────────────

    const diffs: ConformanceDiff[] = [];

    for (let i = 0; i < engines.length; i++) {
      for (let j = i + 1; j < engines.length; j++) {
        const nameA = engines[i];
        const nameB = engines[j];
        const a = perEngine[nameA];
        const b = perEngine[nameB];

        for (const spec of FIELD_SPECS) {
          const left = a[spec.field];
          const right = b[spec.field];
          if (
            left.entries.length === right.entries.length &&
            left.entries.every((entry, index) => entry.key === right.entries[index].key)
          ) {
            continue;
          }

          const divergence = firstDivergence(left, right);
          const identity = divergence?.identity ?? null;
          const path =
            identity !== null && spec.elementPath !== undefined
              ? spec.elementPath(identity)
              : spec.path;

          diffs.push({
            artifact: spec.artifact,
            path,
            engines: [nameA, nameB],
            field: spec.field,
            detail:
              divergence?.detail ??
              `${String(left.entries.length)} entr(y|ies) on ${nameA} versus ${String(right.entries.length)} on ${nameB}`,
          });
        }
      }
    }

    // ── Population, and the vacuity gate ─────────────────────────────────

    const fields: ConformanceFieldReport[] = FIELD_SPECS.map((spec) => {
      const perEngineCounts = counts[spec.field];
      const populated: Record<string, boolean> = {};
      for (const engine of engines) populated[engine] = (perEngineCounts[engine] ?? 0) > 0;
      return {
        field: spec.field,
        artifact: spec.artifact,
        path: spec.path,
        populated,
        counts: { ...perEngineCounts },
      };
    });

    const vacuous = fields.every((entry) =>
      Object.values(entry.populated).every((value) => !value),
    );

    const report: ConformanceReport = {
      equivalent: diffs.length === 0 && !vacuous,
      diffs,
      fields,
      vacuous,
    };

    if (vacuous) {
      logger.info(
        `[conformance] VACUOUS comparison: not one of the ${String(CONFORMANCE_FIELDS.length)} artifact fields was populated for any of [${engines.join(", ")}] — reporting equivalent:false rather than equivalence over nothing`,
      );
    } else if (!report.equivalent) {
      logger.info(
        `[conformance] artifact divergence detected: ${String(diffs.length)} diff(s) across engines [${engines.join(", ")}]`,
      );
    }

    return report;
  }
}

/** The fields that were populated for EVERY engine — the ones an equivalence rests on. */
export function fullyPopulatedFields(report: ConformanceReport): ConformanceField[] {
  return report.fields
    .filter((entry) => Object.values(entry.populated).every((value) => value))
    .map((entry) => entry.field);
}

/** The fields no engine produced. Known-empty, and reported rather than counted as a match. */
export function emptyOnAllEnginesFields(report: ConformanceReport): ConformanceField[] {
  return report.fields
    .filter((entry) => Object.values(entry.populated).every((value) => !value))
    .map((entry) => entry.field);
}
