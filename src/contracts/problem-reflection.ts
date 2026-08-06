import { z } from "zod";

/**
 * The port payload schemas the shipped `coding` topology names but no module resolved.
 *
 * `src/pge/topology/coding.graph.ts` declares `FeatureRequest`, `ResearchDigest` and
 * `ProblemReflection`-shaped content on twelve ports across the research and plan
 * regions, and `CODING_SCHEMA_REFS` lists the first two as refs the schema catalog must
 * resolve — but until this file there was no Zod schema behind either name, so a
 * `schemaRef` was a string the artifact wrote about itself. This module is what those
 * refs mean.
 *
 * ── Why ProblemReflection exists at all ──
 *
 * The shipped researcher (`src/orchestrator/research-agent.ts`) emits PROSE: a markdown
 * `findings` blob plus six free-text sections. Prose cannot be checked, so a researcher
 * that answered a different question than the one asked is indistinguishable from one
 * that answered it. {@link ProblemReflectionSchema} is the structured framing the
 * reflexion loop grades against — an explicit goal, and non-empty inputs, outputs, rules
 * and constraints — and a prose-only emission fails it with a Zod path naming exactly
 * what is missing (sc-11-1). It is ADDITIVE: it replaces no existing research artifact
 * shape and `ResearchDoc` is untouched.
 *
 * ── What must NOT appear here ──
 *
 * No second `SprintContract`, `PlanSpec` or clarification-question type. The source
 * documents' `sprint_id`, `goals`, `files_to_edit`, `verification_commands` and
 * `trip_goal` fields are errata; the real vocabulary is `SprintContractSchema`
 * (`./sprint-contract.ts`) and `ClarificationQuestionSchema` / `resolveClarification`
 * (`./spec.ts`), and this module deliberately imports neither so it cannot shadow them.
 *
 * ── Dependencies ──
 *
 * `zod` and nothing else. This file sits beside `topology.ts` in a layer whose whole
 * value is that it can be loaded without dragging an executor in, so it takes no
 * dependency on `src/pge/**`, `src/orchestrator/**` or `src/providers/**`.
 */

// ── Schema diagnostics ──────────────────────────────────────────────

/**
 * One Zod issue, flattened into the three facts a diagnostic actually needs.
 *
 * `path` is the DOTTED join and `pathSegments` is the raw path, because the two answer
 * different questions: a human reads `"features.0.title"`, and a test that wants to
 * prove which field a gate rejected compares segments without re-parsing a string.
 *
 * What is deliberately ABSENT is the value that failed. A diagnostic that echoed the
 * rejected payload would put it back into whatever the diagnostic is written to, which
 * is the exact propagation a fail-closed gate exists to prevent (sc-11-5).
 */
export const SchemaIssueSchema = z.object({
  path: z.string(),
  pathSegments: z.array(z.union([z.string(), z.number()])),
  code: z.string().min(1),
  message: z.string(),
});
export type SchemaIssue = z.infer<typeof SchemaIssueSchema>;

/** Every issue on a `ZodError`, flattened. Order is Zod's own, so it is stable. */
export function schemaIssuesOf(error: z.ZodError): SchemaIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    pathSegments: [...issue.path],
    code: issue.code,
    message: issue.message,
  }));
}

/** The outcome of parsing an untrusted payload: the value, or why it was refused. */
export type SchemaParse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: SchemaIssue[] };

/**
 * `safeParse`, with the failure branch already flattened.
 *
 * Exists so a gate body and a node body report a refusal the SAME way — one shape, one
 * flattening, one place where a Zod internal becomes a diagnostic.
 */
export function parseWithIssues<T>(schema: z.ZodType<T>, value: unknown): SchemaParse<T> {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, issues: schemaIssuesOf(parsed.error) };
}

/**
 * A schema re-typed as a TOTAL parser of its own output.
 *
 * `z.ZodType<T>` expands to `z.ZodType<T, ZodTypeDef, T>` — it demands that a schema's
 * INPUT type equal its OUTPUT type — and every interface in this repository that accepts a
 * schema (`NodeImpl.inputSchema`, `EffectDef.requestSchema`) is declared that way. Every
 * real domain schema breaks it: `PlanSpecSchema.constraints` is `.default([])` and
 * `SprintContractSchema.dependsOn` is `.default([])`, so their input types carry optional
 * members their output types do not.
 *
 * The cast is confined to this one function and is sound. `ZodType.parse` accepts
 * `unknown` at runtime, so validation is unchanged; the only claim being made is "this
 * schema accepts a value it already produced", which is true of a defaulted schema
 * precisely because the defaults are already filled in. The alternative — re-declaring
 * every payload schema without its defaults — is the parallel-type drift the `Exact`
 * guards in `src/pge/state/overall.ts` exist to prevent.
 */
export function totalSchema<S extends z.ZodTypeAny>(schema: S): z.ZodType<z.infer<S>> {
  return schema as unknown as z.ZodType<z.infer<S>>;
}

// ── ProblemReflection ───────────────────────────────────────────────

/**
 * The researcher's structured framing of the problem, before it explores anything.
 *
 * Every array is `.min(1)` and every member is `.min(1)`: a reflection with an empty
 * `rules` array has not stated the rules, and one with `rules: [""]` has stated them
 * even less. Both are the same defect and both are refused, with the failing path
 * naming the array.
 */
export const ProblemReflectionSchema = z.object({
  /** What the run is for, in one sentence. Non-empty. */
  goal: z.string().min(1),
  /** What the change consumes: files, artifacts, user input. */
  inputs: z.array(z.string().min(1)).min(1),
  /** What it must produce. */
  outputs: z.array(z.string().min(1)).min(1),
  /** Invariants the implementation must preserve. */
  rules: z.array(z.string().min(1)).min(1),
  /** Boundaries it must not cross. */
  constraints: z.array(z.string().min(1)).min(1),
});
export type ProblemReflection = z.infer<typeof ProblemReflectionSchema>;

/** A reflection, or the Zod paths that stop it from being one. */
export function parseProblemReflection(value: unknown): SchemaParse<ProblemReflection> {
  return parseWithIssues(ProblemReflectionSchema, value);
}

// ── FeatureRequest ──────────────────────────────────────────────────

/**
 * What the graph is asked to do, as it crosses the research entry gate.
 *
 * `projectRoot` travels with the request rather than being read from a module-level
 * global because a worktree run substitutes it, and a node that resolved it itself would
 * resolve a different one than the run it belongs to.
 */
export const FeatureRequestSchema = z.object({
  featureRequest: z.string().min(1),
  projectRoot: z.string().min(1),
});
export type FeatureRequest = z.infer<typeof FeatureRequestSchema>;

// ── ResearchDigest ──────────────────────────────────────────────────

/**
 * The six factual sections the shipped researcher produces.
 *
 * Mirrors `ResearchSections` in `src/orchestrator/research-agent.ts` field for field. The
 * mirror is asserted by an `Exact` guard in `src/pge/nodes/effects.ts` — HERE would
 * require importing the orchestrator into the contracts layer, and the guard belongs
 * wherever the two are already both in scope.
 */
export const ResearchSectionsSchema = z.object({
  architectureOverview: z.string(),
  existingPatterns: z.string(),
  keyFiles: z.string(),
  integrationPoints: z.string(),
  testCoverage: z.string(),
  riskAreas: z.string(),
});
export type ResearchSections = z.infer<typeof ResearchSectionsSchema>;

/**
 * What travels the research region's `digest` port, round after round.
 *
 * ── Why `critique` lives INSIDE the digest ──
 *
 * The reflexion loop's whole claim is that each re-entry of the explorer is informed by
 * the previous round's critique. The explorer's DECLARED input is one port —
 * `digest: ResearchDigest` (`coding.graph.ts:243`) — and the interpreter feeds a
 * successor exactly the predecessor's `output` (`interpreter.ts:1462`). So a critique
 * carried anywhere else is a critique the explorer cannot be shown to have received.
 * `null` is the first round, before anything has been critiqued.
 */
export const ResearchDigestSchema = z.object({
  researchId: z.string().min(1),
  timestamp: z.string().min(1),
  reflection: ProblemReflectionSchema,
  questions: z.array(z.string().min(1)),
  findings: z.string(),
  sections: ResearchSectionsSchema,
  filesExplored: z.array(z.string()),
  questionsAnswered: z.number().int().min(0),
  /** The PRIOR round's critique, carried back into the explorer on a reflexion retry. */
  critique: z.string().nullable(),
  /** How many reflexion rounds have completed. 0 before the first exploration. */
  reflexionRound: z.number().int().min(0),
  /**
   * The id of the research document ON DISK, or `null` while none has been written.
   *
   * The research EXIT gate's declared check is `research-document-written`
   * (`coding.graph.ts:311`) and that gate declares `reads: []`, so the fact it checks has
   * to travel on the port rather than be looked up in state. A digest that reaches the
   * exit gate with `documentId: null` is a run that produced findings and never wrote
   * them down, which is exactly the failure the gate exists to catch.
   *
   * It is an ID rather than a path because the only way to obtain one is to READ THE
   * DIRECTORY BACK (`listResearch`): a path string can be computed by a writer that
   * failed, and an id that came out of a directory listing cannot.
   */
  documentId: z.string().nullable(),
});
export type ResearchDigest = z.infer<typeof ResearchDigestSchema>;
