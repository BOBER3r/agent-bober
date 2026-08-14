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
export function normalize(value: unknown): unknown {
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

/**
 * The canonical bytes of a normalized value. Two values are equal iff these match.
 *
 * Exported (sprint 14) so the golden dataset can store its expected artifacts ALREADY
 * stripped and sorted, and compare them the same way this harness does. A second
 * normaliser in the golden runner would be free to disagree with this one about what
 * "identical" means, and the disagreement would surface as a golden case that passes while
 * conformance fails — so there is one definition and the golden layer imports it.
 */
export function canonical(value: unknown): string {
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

/**
 * Replace `projectRoot` — and the path it resolves to — wherever it appears in `value`.
 *
 * Exported (sprint 14) for the golden capture step, which has the same problem the harness
 * has and must solve it the same way: a recorded request or response carrying the throwaway
 * root a capture happened to run in would make the committed case differ from the next
 * capture for a reason that is not a behaviour change. One redactor, one placeholder.
 */
export async function redactProjectRoot(value: unknown, projectRoot: string): Promise<unknown> {
  return redactRoots(value, await rootAliases(projectRoot));
}

/**
 * The eleven artifact fields ONE finished run left behind, redacted and normalized.
 *
 * Exported (sprint 14) because the golden regression executor has to read a run's
 * artifacts exactly the way this harness reads an engine's, and a second reader would be
 * free to disagree with this one about what a run produced. {@link EngineConformanceHarness}
 * itself goes through this function, so there is one collection path and not two that
 * happen to look alike.
 *
 * Both transformations the harness applies are applied here, in the harness's order:
 * the run's own project root is REDACTED wherever it appears in a string (a fresh temp
 * root per run is the isolation the comparison rests on, so the root itself is never a
 * finding), then the value is NORMALIZED — volatile keys stripped, object keys sorted.
 * The result is therefore already in the canonical form a golden expectation is stored in.
 */
export async function collectRunArtifacts(
  projectRoot: string,
  pipelineResult?: void | PipelineResult,
): Promise<Record<ConformanceField, unknown[]>> {
  const raw = await collectFields(projectRoot, pipelineResult);
  // Both the given root and its resolved form: on macOS `os.tmpdir()` yields
  // `/var/folders/...` while anything that resolves the path writes
  // `/private/var/folders/...`, and an artifact recording the second would otherwise
  // survive redaction of the first.
  const roots = await rootAliases(projectRoot);
  const collected = {} as Record<ConformanceField, unknown[]>;
  for (const field of CONFORMANCE_FIELDS) {
    collected[field] = raw[field].map((value) => normalize(redactRoots(value, roots)));
  }
  return collected;
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
      // ONE collection path, shared with the golden regression executor: redaction of
      // this run's own root then normalization. `keyedCollection` re-canonicalises, which
      // is a no-op on an already-normalized value — `normalize` is idempotent.
      const raw = await collectRunArtifacts(root, pipelineResult);

      const collected = {} as Record<ConformanceField, KeyedCollection>;
      for (const spec of FIELD_SPECS) {
        const values = raw[spec.field];
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

// ── The amended bar (sc-11-1/sc-11-2, spec-20260814-pge-full-convergence sprint 11) ─────

/**
 * The two fields `equivalent: true` cannot reach, each with the recorded, source-grounded
 * reason it is ARCHITECTURAL rather than merely unbuilt — the same standard sprint 3 applied
 * to `audits` alone, now applied to both remaining entries.
 *
 * `audits` — a per-branch interrupt inside a fan-out is unsound at runtime, not merely
 * unrevisited: `Checkpoint.interrupt` holds exactly one pending interrupt
 * (`src/pge/runtime/checkpointer.ts`), `grantScope`/`clearScope` carry no branch key so a
 * sibling branch's arrival evicts a prior branch's grant, and `resumeMessageId` collapses
 * every branch's decision onto one message row (`src/pge/runtime/interrupt.ts`) — see
 * `.bober/architecture/arch-20260814-pge-full-convergence-adr-1.md`.
 *
 * `pipelineResult` — `PipelineResult.errors` has exactly one write site repo-wide,
 * `PgeEngine.run`, populated from the interpreter's own `TaskFailure` records after a
 * checkpoint-gated `commit` refusal (`src/pge/engine/pge-engine.ts`); the imperative
 * engine's `commitAll` (`src/orchestrator/pipeline.ts`) is unconditional and ungated behind
 * no HITL checkpoint, so there is no honest write site for an equivalent entry — found at
 * sprint 6 of `spec-20260814-pge-full-convergence`.
 *
 * Both share ONE root cause: the graph has a checkpoint-gated commit the imperative engine
 * lacks. Extending or shrinking this set is a decision recorded in
 * `docs/pge-graph.md`'s "Engine migration disposition", not a comparison to adjust quietly —
 * see {@link equivalentModuloAcceptedDivergences}.
 */
export const ARCHITECTURALLY_ACCEPTED_DIVERGENCES: Readonly<
  Partial<Record<ConformanceField, string>>
> = Object.freeze({
  audits:
    "a per-branch interrupt inside a fan-out is unsound at runtime (ADR-1): Checkpoint.interrupt holds one slot, grantScope/clearScope are branch-blind, resumeMessageId collapses every branch onto one message row",
  pipelineResult:
    "PipelineResult.errors has exactly one write site (PgeEngine.run, sourced from a checkpoint-gated commit refusal); the imperative commitAll is unconditional and ungated, so there is no honest equivalent write site (sprint 6)",
});

/**
 * The bar `equivalent: true` amends to, once every non-architectural divergence has closed
 * (sc-11-1, spec-20260814-pge-full-convergence sprint 11): true only when the report's
 * divergence set is EXACTLY {@link ARCHITECTURALLY_ACCEPTED_DIVERGENCES}'s keys — no more,
 * and no less.
 *
 * "No more" catches a NEW divergence the same way `report.equivalent` always did. "No less"
 * is the half a naive re-specification would drop: a report that is missing one of the two
 * accepted fields is NOT this bar's idea of equivalence either, because that would mean the
 * comparison stopped detecting a divergence that, in fact, still exists — a silently-relaxed
 * comparison, not a real convergence. Reaching a TRUE `equivalent: true` (zero accepted
 * fields, zero everything else) is not this function's job to celebrate quietly; it is the
 * literal bar this function stands in for until it is re-decided, and `report.equivalent`
 * remains the assertion for that unamended claim.
 *
 * Two integrity rules sit underneath the set comparison, both added in the follow-up to
 * sprint 11 after a security audit found them missing. Neither was exploitable at the time
 * — the sole diff producer names every field, and only `ts` and `pge` are ever compared —
 * and both are the exact class of hole this predicate exists to close, so they are checked
 * rather than argued from the current producer's good behaviour:
 *
 *  1. A diff whose `field` is not a known {@link ConformanceField} makes this `false`. It is
 *     an UNACCEPTED divergence, not an absent one — see the comment at the check.
 *  2. Every diff must come from the SAME unordered engine pair. A field set flattened
 *     across pairs can equal the accepted set without any single pair equalling it.
 */
export function equivalentModuloAcceptedDivergences(report: ConformanceReport): boolean {
  if (report.vacuous) return false;

  const observed = new Set<ConformanceField>();
  const pairs = new Set<string>();

  for (const diff of report.diffs) {
    // A diff whose `field` is not one of the eleven known fields is an UNACCEPTED
    // divergence, never an absent one. This function used to FILTER such diffs out before
    // comparing, which is the one way a reported divergence could read as non-existent:
    // `report.equivalent` counts every diff (`diffs.length === 0 && !vacuous`), so a
    // field-less diff made the two claims disagree about the same report, with this — the
    // amended, narrower one — the more permissive of the two. `field` is required by the
    // type as of this change, so what remains here binds a diff that reached the predicate
    // from outside the type system: a cast, a JavaScript caller, a report round-tripped
    // through JSON. The bar does not trust the type it is checking.
    if (!CONFORMANCE_FIELDS.includes(diff.field)) return false;
    observed.add(diff.field);
    // Unordered: `assertEquivalent` emits `[nameA, nameB]` in `engines` iteration order,
    // and (A,B) and (B,A) are the same comparison.
    pairs.add([...diff.engines].sort().join("|"));
  }

  // This bar is defined for ONE engine pair, and says so rather than averaging over
  // several. `assertEquivalent` compares every unordered pair, tagging each diff with the
  // pair it came from; flattening those into one field set means a report where (A,B)
  // diverges only on `audits` and (A,C) only on `pipelineResult` has a UNION equal to the
  // accepted set while NEITHER pair matches it — two engines that each fail the bar,
  // reported as passing. `ARCHITECTURALLY_ACCEPTED_DIVERGENCES`'s two reasons are both
  // stated about the graph-vs-imperative pair specifically (ADR-1; sprint 6), so what the
  // set even means for a third engine is a decision to take deliberately — the same as
  // widening the set is — not one to infer here. Until it is taken, a multi-pair report
  // gets `false`: refusing to answer, rather than answering with a bar weaker than it reads.
  if (pairs.size > 1) return false;

  const accepted = Object.keys(ARCHITECTURALLY_ACCEPTED_DIVERGENCES) as ConformanceField[];
  if (observed.size !== accepted.length) return false;
  return accepted.every((field) => observed.has(field));
}
