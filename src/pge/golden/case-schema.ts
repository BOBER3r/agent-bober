// ── GoldenCase — the schema of one curated regression case ──────────

import { z } from "zod";

import { canonical } from "../../orchestrator/workflow/conformance.js";
import { CONFORMANCE_FIELDS } from "../../orchestrator/workflow/types.js";
import type { ConformanceField } from "../../orchestrator/workflow/types.js";
import { RecordedCallSchema, recordingKey } from "../runtime/replay.js";

/**
 * One golden case: an input, the provider answers pinned for it, and the artifacts a run
 * over those answers is expected to leave behind.
 *
 * ── WHAT A GOLDEN CASE IS EVIDENCE OF ──
 *
 * The RUNTIME and the ARTIFACT SHAPE, and nothing else — the same limit
 * `src/pge/runtime/replay.ts` states about a replay, and for the same reason. Every
 * outward call is answered from {@link GoldenCase.pinnedResponses}, so what a green case
 * proves is that the interpreter, the gates, the loop bounds, the reducers and the
 * `.bober/` writers still turn the SAME answers into the SAME artifacts. It proves
 * NOTHING about whether those answers were any good. A permanently-green dataset is not
 * evidence of generation quality, and reading it as such is the one misuse that would make
 * the whole exercise worse than useless.
 *
 * The committed cases are HAND-AUTHORED from the shipped writers' shapes rather than
 * captured from real runs — see the provenance note in `runner.ts`, which says what that
 * does and does not license the dataset to claim.
 *
 * ── THE PINNED RESPONSES ARE RECORDING-SHAPED ──
 *
 * `pinnedResponses` is an array of {@link RecordedCallSchema} — the exact shape
 * `createRunRecorder` writes and `createReplayEffectRegistry` looks up, keyed by
 * {@link recordingKey}. This is a deliberate coupling: a golden case is a recording that
 * was curated and committed rather than captured and thrown away, so a case can be fed to
 * the replay registry without translation, and a change to the recording format breaks the
 * dataset loudly instead of leaving it silently un-replayable.
 *
 * Two structural invariants of a real recording are enforced here, because a case that
 * violates either could never have been produced by a run and would answer the wrong call
 * on lookup:
 *
 *  - recording keys are UNIQUE within a case;
 *  - `callIndex` is CONTIGUOUS from 0 within each `(nodeId, branchKey)` pair, because the
 *    recorder assigns it as `bundle.calls.length` across all effect names for that pair.
 *
 * One asymmetry between the two halves of a pinned call is deliberate and worth stating:
 * `response` is what a replay HANDS BACK and is pinned in full, while `request` is carried
 * for diagnostics and is abbreviated in the committed cases — a request naming its contract
 * by `contractId` rather than embedding the whole `SprintContract` keeps a case reviewable.
 * A reader must not take a committed `request` for a byte-exact capture of a real one.
 *
 * ── EXPECTED ARTIFACTS ARE STORED CANONICAL ──
 *
 * `expected.artifacts` is keyed by {@link CONFORMANCE_FIELDS} — the same eleven fields
 * `EngineConformanceHarness` collects — and each value is the field's collection, stored
 * ALREADY normalised: volatile keys stripped, object keys sorted. The schema enforces it
 * by re-canonicalising with {@link canonical} and refusing anything that differs, so a case
 * authored by pasting a raw artifact (with its `createdAt`, `runId` or `duration` still on
 * it) is rejected at parse time rather than silently compared against a key the comparison
 * cannot see. One consequence is worth naming: a key whose NAME is volatile — `duration`
 * inside a `details` record, say — is not expressible in an expectation, because the
 * comparison would not look at it anyway.
 */

// ── Constants ───────────────────────────────────────────────────────

/** Bumped when the case shape changes in a way an existing file cannot satisfy. */
export const GOLDEN_CASE_FORMAT_VERSION = 1;

/**
 * The committed dataset's size bounds (sc-14-1).
 *
 * A floor because a handful of cases is not a regression suite; a ceiling because every
 * case is hand-curated content that has to be re-pinned when the graph changes, and a
 * dataset nobody can afford to maintain rots into a permanently-skipped gate.
 */
export const GOLDEN_DATASET_MIN_CASES = 20;
export const GOLDEN_DATASET_MAX_CASES = 50;

/**
 * How a case's `expected` block is ENFORCED. Every case must say which, in the file.
 *
 * ── `replay` — the runtime claim ──
 *
 * The case is EXECUTED. `src/pge/golden/executor.ts` runs the shipped `PgeEngine` over the
 * committed topology artifact in a throwaway root with every outward call answered from
 * this case's `pinnedResponses`, collects the eleven conformance artifact fields the run
 * left behind and compares them with `expected.artifacts`. A `replay` case that stops
 * reproducing its expectation FAILS THE BLOCKING CI JOB. Its pins are CAPTURED from a real
 * run (see `capture.ts`), never hand-written, because only a capture can be complete: a
 * hand-written pin set that misses one call makes the replay throw `MissingRecordingError`
 * at the call it did not anticipate.
 *
 * ── `integrity` — a curated specification, and NO runtime claim ──
 *
 * The case is NOT executed. It is checked for schema validity and against the committed
 * graph — its ids, its pinned node ids and effect names must all still exist — and that is
 * all it claims. These are hand-authored descriptions of behaviour the dataset means to
 * pin one day; their pins describe the calls a reader would find interesting rather than
 * the complete call sequence a run makes, so replaying one would fail for a reason that
 * says nothing about the runtime.
 *
 * Being explicit is the point. A case that carries no `enforcement` is REJECTED by the
 * schema rather than defaulted, because both defaults are wrong: defaulting to `integrity`
 * lets a captured case silently stop being executed, and defaulting to `replay` lets a
 * curated case fail for a reason its author never claimed.
 *
 * {@link GOLDEN_MIN_REPLAY_CASES} is what stops the split from eroding — see there.
 */
export const GOLDEN_ENFORCEMENTS = ["replay", "integrity"] as const;
export type GoldenEnforcement = (typeof GOLDEN_ENFORCEMENTS)[number];

/**
 * The floor on `replay`-enforced cases. Below it the dataset is REJECTED.
 *
 * Without a floor the split above is an escape hatch: a case that started failing could be
 * relabelled `integrity` and the gate would go green while enforcing strictly less, which
 * is the decorative gate this whole design refuses. With one, relabelling the last replay
 * case fails the dataset check itself — so the only way to make a failing replay case go
 * green is to fix the runtime or to re-capture it and say in the diff that the artifacts
 * changed.
 *
 * It is a FLOOR and not an equality, so a case can be added without editing this constant;
 * it must rise when the replay set grows, and `dataset.test.ts` asserts the committed count
 * against it so the two cannot drift silently.
 */
export const GOLDEN_MIN_REPLAY_CASES = 5;

/** Every file under `.bober/golden/` is one case, named for its `caseId`. */
export const GOLDEN_CASE_FILE_EXTENSION = ".json";

/**
 * The two fields `FIELD_SPECS` calls "logically scalar" and carries as a zero-or-one array.
 *
 * An expectation that pins two of either describes a run that cannot exist, and the
 * comparison would report a divergence no engine could ever fix.
 */
export const SCALAR_ARTIFACT_FIELDS = ["progress", "pipelineResult"] as const;

// ── Primitive schemas ───────────────────────────────────────────────

/** `kebab-case`, and equal to the file's basename — see `loadGoldenDataset`. */
export const GoldenCaseIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "caseId must be kebab-case (a-z, 0-9 and single -)");

/** `MAJOR.MINOR.PATCH`. The same spelling `graphVersion` uses in the topology artifact. */
export const GraphVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "graphVersion must be MAJOR.MINOR.PATCH");

/** The major of a `MAJOR.MINOR.PATCH` string. Used for the compatibility check. */
export function majorVersion(version: string): number {
  return Number.parseInt(version.split(".")[0] ?? "", 10);
}

// ── Expected artifacts ──────────────────────────────────────────────

/**
 * The artifact map, keyed by conformance field.
 *
 * The shape is built in SORTED key order deliberately: zod emits parsed object keys in
 * shape order, so a sorted shape means a parsed expectation is already in canonical key
 * order and {@link isCanonicalArtifacts} is then checking the part that matters — the
 * nested values, which `z.unknown()` passes through exactly as the file spelled them.
 *
 * `.strict()` so a typo (`contract` for `contracts`) is an error rather than an
 * expectation that silently pins nothing.
 */
const artifactShape = Object.fromEntries(
  [...CONFORMANCE_FIELDS].sort().map((field) => [field, z.array(z.unknown()).optional()]),
) as Record<ConformanceField, z.ZodOptional<z.ZodArray<z.ZodUnknown>>>;

export const GoldenArtifactsSchema = z.object(artifactShape).strict();
export type GoldenArtifacts = z.infer<typeof GoldenArtifactsSchema>;

/** True when `artifacts` is byte-for-byte what the conformance normaliser would produce. */
export function isCanonicalArtifacts(artifacts: unknown): boolean {
  return JSON.stringify(artifacts) === canonical(artifacts);
}

export const GoldenExpectationSchema = z
  .object({
    /**
     * The node the run is expected to come to rest on.
     *
     * Cross-checked against the committed topology by {@link checkCaseAgainstGraph}; the
     * schema cannot do it, because a schema that read the artifact would make every parse
     * depend on a file on disk.
     */
    terminalNodeId: z.string().min(1),
    artifacts: GoldenArtifactsSchema,
    /** Why this expectation is what it is. Prose, for the reader of a failing diff. */
    notes: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((expected, ctx) => {
    if (!isCanonicalArtifacts(expected.artifacts)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifacts"],
        message:
          "expected.artifacts is not canonical: store artifacts already normalised " +
          "(volatile keys stripped, object keys sorted) — an expectation carrying a " +
          "volatile key pins a value the conformance comparison never looks at",
      });
    }
    for (const field of SCALAR_ARTIFACT_FIELDS) {
      const values = expected.artifacts[field];
      if (values !== undefined && values.length > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["artifacts", field],
          message: `${field} is a scalar field carried as a zero-or-one array; ${String(values.length)} elements describes a run that cannot exist`,
        });
      }
    }
  });
export type GoldenExpectation = z.infer<typeof GoldenExpectationSchema>;

// ── Input ───────────────────────────────────────────────────────────

export const GoldenCaseInputSchema = z
  .object({
    /** What the run was asked for. The `FeatureRequest` the entry node receives. */
    featureRequest: z.string().min(1),
    /** Where the run starts. A node id; `research_body` for a whole-pipeline case. */
    entryNodeId: z.string().min(1),
    /**
     * Config overrides in force for the case, e.g. `{ "autopilot": true }`.
     *
     * Free-form because the case pins the SHAPE of the run's output, not the schema of
     * bober's config, and a case that had to be rewritten every time an unrelated config
     * key moved would be abandoned.
     */
    config: z.record(z.string(), z.unknown()).optional(),
    /** Channel values the case starts from, when it does not start from empty. */
    seed: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type GoldenCaseInput = z.infer<typeof GoldenCaseInputSchema>;

// ── The case ────────────────────────────────────────────────────────

export const GoldenCaseSchema = z
  .object({
    formatVersion: z.literal(GOLDEN_CASE_FORMAT_VERSION),
    caseId: GoldenCaseIdSchema,
    title: z.string().min(1),
    /** What this case exists to catch. One sentence, in the imperative of a regression. */
    intent: z.string().min(1),
    tags: z.array(z.string().min(1)).min(1),
    /** Executed and compared, or checked for integrity only. See {@link GOLDEN_ENFORCEMENTS}. */
    enforcement: z.enum(GOLDEN_ENFORCEMENTS),
    graph: z
      .object({
        graphId: z.string().min(1),
        graphVersion: GraphVersionSchema,
      })
      .strict(),
    input: GoldenCaseInputSchema,
    /** At least one: a case that pins no answer exercises no outward call. */
    pinnedResponses: z.array(RecordedCallSchema).min(1),
    expected: GoldenExpectationSchema,
  })
  .strict()
  .superRefine((goldenCase, ctx) => {
    const seen = new Set<string>();
    /** `nodeId@branchKey` -> the call indices pinned for it. */
    const indices = new Map<string, number[]>();

    goldenCase.pinnedResponses.forEach((call, position) => {
      const key = recordingKey(call);
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pinnedResponses", position],
          message: `duplicate recording key ${key}: a replay resolves a call by this key, so a second entry is unreachable and the case would answer the wrong call`,
        });
      }
      seen.add(key);

      const nodeKey = `${call.nodeId}@${call.branchKey ?? ""}`;
      const existing = indices.get(nodeKey);
      if (existing === undefined) indices.set(nodeKey, [call.callIndex]);
      else existing.push(call.callIndex);
    });

    for (const [nodeKey, pinned] of indices) {
      const sorted = [...pinned].sort((a, b) => a - b);
      const contiguous = sorted.every((value, index) => value === index);
      if (!contiguous) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pinnedResponses"],
          message: `callIndex for ${nodeKey} is [${sorted.join(", ")}]; the recorder assigns it as the node's own call count, so a real recording is contiguous from 0`,
        });
      }
    }
  });
export type GoldenCase = z.infer<typeof GoldenCaseSchema>;

/** True when this case is EXECUTED against the real engine. See {@link GOLDEN_ENFORCEMENTS}. */
export function isReplayCase(goldenCase: GoldenCase): boolean {
  return goldenCase.enforcement === "replay";
}

// ── Parsing ─────────────────────────────────────────────────────────

export type GoldenCaseParse =
  | { readonly ok: true; readonly goldenCase: GoldenCase }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Parse one case, reporting EVERY issue rather than throwing on the first.
 *
 * `source` prefixes each message, because the reader of a failing dataset test needs to
 * know which of two dozen files is wrong before they need to know what is wrong with it.
 */
export function parseGoldenCase(value: unknown, source: string): GoldenCaseParse {
  const result = GoldenCaseSchema.safeParse(value);
  if (result.success) return { ok: true, goldenCase: result.data };
  return {
    ok: false,
    errors: result.error.issues.map(
      (issue) => `${source}: ${issue.path.join(".") || "<root>"} — ${issue.message}`,
    ),
  };
}

// ── Cross-check against the committed graph ─────────────────────────

/**
 * The facts a case is checked against, supplied by the CALLER.
 *
 * Injected rather than read here: this module must stay parseable without a filesystem,
 * and the caller — the dataset test — is the one that knows the committed artifact is the
 * authority for node ids and the effect catalog is the authority for effect names.
 */
export interface GoldenGraphFacts {
  readonly graphId: string;
  readonly graphVersion: string;
  readonly nodeIds: ReadonlySet<string>;
  /** Registry names an effect can actually be invoked under, e.g. `planner.draft`. */
  readonly effectNames: ReadonlySet<string>;
}

/**
 * Every way `goldenCase` disagrees with the graph it claims to be a case for. Empty is good.
 *
 * The version rule is MAJOR-only on purpose. Pinning the exact `graphVersion` would force
 * all two dozen files to be rewritten on every minor bump — which is how a dataset stops
 * being maintained — while ignoring the version entirely would let cases recorded against
 * a structurally different graph sit in the suite claiming to prove something. A major bump
 * is the repository's own signal that the structure changed, so that is the bump that
 * invalidates a recording.
 */
export function checkCaseAgainstGraph(
  goldenCase: GoldenCase,
  facts: GoldenGraphFacts,
): string[] {
  const violations: string[] = [];
  const where = `${goldenCase.caseId}`;

  if (goldenCase.graph.graphId !== facts.graphId) {
    violations.push(
      `${where}: graph.graphId is "${goldenCase.graph.graphId}" but the committed artifact is "${facts.graphId}"`,
    );
  }

  const caseMajor = majorVersion(goldenCase.graph.graphVersion);
  const graphMajor = majorVersion(facts.graphVersion);
  if (caseMajor !== graphMajor) {
    violations.push(
      `${where}: recorded against graphVersion ${goldenCase.graph.graphVersion} but the committed artifact is ${facts.graphVersion}; a major bump changes the structure, so the case must be re-pinned`,
    );
  }

  if (!facts.nodeIds.has(goldenCase.input.entryNodeId)) {
    violations.push(
      `${where}: input.entryNodeId "${goldenCase.input.entryNodeId}" is not a node in the committed artifact`,
    );
  }

  if (!facts.nodeIds.has(goldenCase.expected.terminalNodeId)) {
    violations.push(
      `${where}: expected.terminalNodeId "${goldenCase.expected.terminalNodeId}" is not a node in the committed artifact`,
    );
  }

  for (const call of goldenCase.pinnedResponses) {
    if (!facts.nodeIds.has(call.nodeId)) {
      violations.push(
        `${where}: pinned response for node "${call.nodeId}" (${call.effectName}) — no such node in the committed artifact`,
      );
    }
    if (!facts.effectNames.has(call.effectName)) {
      violations.push(
        `${where}: pinned response for effect "${call.effectName}" at node "${call.nodeId}" — no such effect in the registry catalog, so nothing would ever ask for it`,
      );
    }
  }

  return violations;
}
