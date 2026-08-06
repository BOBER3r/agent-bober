import { z } from "zod";

import type { BoberConfig } from "../../config/schema.js";
import {
  ProblemReflectionSchema,
  ResearchSectionsSchema,
  totalSchema,
} from "../../contracts/problem-reflection.js";
import type { ResearchSections as ContractResearchSections } from "../../contracts/problem-reflection.js";
import { PlanSpecSchema } from "../../contracts/spec.js";
import { SprintContractSchema } from "../../contracts/sprint-contract.js";
import type { SprintContract } from "../../contracts/sprint-contract.js";
import { ContextHandoffSchema } from "../../orchestrator/context-handoff.js";
import type { ContextHandoff } from "../../orchestrator/context-handoff.js";
import { materializeContracts } from "../../orchestrator/contract-materialization.js";
import { runCodeReviewer } from "../../orchestrator/code-reviewer-agent.js";
import type { ReviewResult } from "../../orchestrator/code-reviewer-agent.js";
import { runCurator } from "../../orchestrator/curator-agent.js";
import type { SprintBriefing } from "../../orchestrator/curator-agent.js";
import { runDocumenter } from "../../orchestrator/documenter-agent.js";
import type { DocumentationResult } from "../../orchestrator/documenter-agent.js";
import { runEvaluatorAgent } from "../../orchestrator/evaluator-agent.js";
import { runGenerator } from "../../orchestrator/generator-agent.js";
import type { GeneratorResult } from "../../orchestrator/generator-agent.js";
import { runPlanner } from "../../orchestrator/planner-agent.js";
import type { PlannerResult } from "../../orchestrator/planner-agent.js";
import { runResearch } from "../../orchestrator/research-agent.js";
import type { ResearchDoc, ResearchSections } from "../../orchestrator/research-agent.js";
import { evaluateSecurityGate } from "../../orchestrator/security-gate.js";
import type { SecurityGateInput, SecurityGateVerdict } from "../../orchestrator/security-gate.js";
import type { EvaluationRunResult } from "../../evaluators/registry.js";
import { listResearch, saveContract, saveResearch } from "../../state/index.js";
import { commitAll } from "../../utils/git.js";
import type { Exact } from "../state/overall.js";
import type { EffectDef, EffectRegistry } from "../registry/effects.js";
import { createEffectRegistry } from "../registry/effects.js";
import type { NodeContext } from "../registry/nodes.js";
import { FAILURE_ARTIFACT_FORMAT_VERSION, FailureArtifactSchema, writeFailureArtifact } from "../runtime/graceful-failure.js";
import { MockCategorySchema } from "./gates.js";

/**
 * The effect definitions the research and plan node bodies reach the outside world
 * through.
 *
 * ── Why a node never imports a provider ──
 *
 * `EffectRegistry.invoke` re-checks the calling node's DECLARED `effects` array against
 * the effect's own tags at call time (`registry/effects.ts:147`), so an `fs-write` a node
 * did not declare in the committed artifact is refused however the node obtained the
 * registry. That check is worth nothing if a body can `import { runResearch }` and call
 * it directly, so every outward call in `research.ts`, `plan.ts`, `gates.ts` and
 * `supervisor.ts` goes through `ctx.effects.invoke` and the imports live HERE.
 *
 * ── Why the LLM effects declare no tags ──
 *
 * `research_reflect`, `research_explore`, `research_critique`, `plan_draft`,
 * `plan_clarify_check` and `plan_clarify` all declare `effects: []` in the artifact — the
 * topology deliberately does not tag inference as `network`, which is what lets
 * `research_critique` carry a cache policy at all (`CacheOnEffectfulNode`). An effect def
 * that tagged them would make every one of those nodes fail closed.
 *
 * KNOWN ARTIFACT DRIFT, reported rather than fixed (the artifact is out of this sprint's
 * scope): `runResearch` persists its own document (`research-agent.ts:592`) and
 * `runPlanner` persists its own spec (`planner-agent.ts:275`), so the shipped agents DO
 * write files behind an `effects: []` declaration. The declaration is the artifact's, the
 * agents are unmodifiable (sprint non-goal), and tagging the effect here would fail-close
 * six nodes rather than describe the situation.
 *
 * ── Why two of them have no default implementation ──
 *
 * `research.reflect` and `research.critique` have no shipped counterpart: agent-bober has
 * never emitted a structured {@link ProblemReflectionSchema}, and sc-11-1 is explicitly
 * additive. Rather than invent a body, the composition root DEMANDS one (see
 * `../registry/index.ts`), so a caller either binds a real model call or binds a stub and
 * says so. `research.explore`, `planner.draft`, `research.collect`, `plan.materialize` and
 * `run.gracefulFailure` all default to the function this repository already ships.
 */

// ── Effect names ────────────────────────────────────────────────────

/**
 * The name each effect is invoked under.
 *
 * The three that back a `tool` node use that node's declared `toolRef` verbatim —
 * `research.collect`, `plan.materialize`, `run.gracefulFailure` — so the artifact's
 * `toolRef` resolves to something. The three that back an `llm` node are named after the
 * declared `promptRef` domain, because an `llm` node declares no `toolRef`.
 */
export const EFFECTS = {
  researchReflect: "research.reflect",
  researchExplore: "research.explore",
  researchCritique: "research.critique",
  researchCollect: "research.collect",
  plannerDraft: "planner.draft",
  planMaterialize: "plan.materialize",
  gracefulFailure: "run.gracefulFailure",
  // ── Sprint region (sprint 12) ──
  curatorBrief: "curator.brief",
  curatorExplain: "curator.explain",
  curatorMocks: "curator.mocks",
  generatorSprint: "generator.sprint",
  securityAudit: "security.audit",
  evaluatorSprint: "evaluator.sprint",
  reviewerSprint: "reviewer.sprint",
  sprintExit: "sprint.exit",
  documenterSummary: "documenter.summary",
  gitCommit: "git.commit",
} as const;

// ── Shared payload schemas ──────────────────────────────────────────

/**
 * The shipped `ResearchDoc`, as a schema.
 *
 * {@link _researchSectionsAreExact} and {@link _researchDocIsExact} fail `tsc` if this
 * ever drifts from `src/orchestrator/research-agent.ts` — the same discipline
 * `overall.ts` applies to `SprintContract`, and for the same reason: a look-alike doc
 * shape would compile and only diverge when a real agent produced one.
 */
export const ResearchDocSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string(),
  questions: z.array(z.string()),
  findings: z.string(),
  sections: ResearchSectionsSchema,
  filesExplored: z.array(z.string()),
  questionsAnswered: z.number(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** The contracts schema is the REAL one — no parallel contract type (sc-11-9). */
export const SprintContractListSchema = z.array(SprintContractSchema);

export const _researchSectionsAreExact: Exact<ContractResearchSections, ResearchSections> = true;
export const _researchDocIsExact: Exact<z.infer<typeof ResearchDocSchema>, ResearchDoc> = true;
export const _materializedContractsAreExact: Exact<
  z.infer<typeof SprintContractListSchema>[number],
  SprintContract
> = true;

// ── research.reflect ────────────────────────────────────────────────

export const ReflectRequestSchema = z.object({
  featureRequest: z.string().min(1),
  projectRoot: z.string().min(1),
  /** The node's declared `promptRef`, so the binding can resolve the prompt text. */
  promptRef: z.string().min(1),
  /** The model the node's declared tier bound to. */
  model: z.string().min(1),
});
export type ReflectRequest = z.infer<typeof ReflectRequestSchema>;

/**
 * Deliberately `unknown`.
 *
 * sc-11-1 is the claim that a researcher which emits PROSE is rejected with the failing
 * Zod path named. That claim is only testable if the raw emission reaches the node body
 * unvalidated: an effect that parsed it with {@link ProblemReflectionSchema} would turn a
 * prose emission into a thrown `ZodError` inside the effect channel, and the node would
 * never get to report a diagnostic at all.
 */
export const ReflectResponseSchema = z.unknown();

export type Reflector = (req: ReflectRequest, ctx: NodeContext) => Promise<unknown>;

export function researchReflectEffect(reflect: Reflector): EffectDef<ReflectRequest, unknown> {
  return {
    name: EFFECTS.researchReflect,
    requestSchema: ReflectRequestSchema,
    responseSchema: ReflectResponseSchema,
    effects: [],
    run: reflect,
  };
}

// ── research.explore ────────────────────────────────────────────────

export const ExploreRequestSchema = z.object({
  /**
   * What the researcher is asked, INCLUDING the prior round's critique when there is one.
   *
   * Folded into the prompt by the node rather than passed as a separate argument, because
   * `runResearch(userPrompt, projectRoot, config)` takes three parameters and adding a
   * fourth would modify a shipped agent (sprint non-goal).
   */
  userPrompt: z.string().min(1),
  projectRoot: z.string().min(1),
  /** The prior round's critique, carried for the binding's benefit and for assertions. */
  critique: z.string().nullable(),
  reflexionRound: z.number().int().min(0),
});
export type ExploreRequest = z.infer<typeof ExploreRequestSchema>;

export type Researcher = (
  userPrompt: string,
  projectRoot: string,
  config: BoberConfig,
) => Promise<ResearchDoc>;

/** The shipped researcher, unmodified. Exported so a test can prove the binding by identity. */
export const DEFAULT_RESEARCHER: Researcher = runResearch;

export function researchExploreEffect(
  research: Researcher = DEFAULT_RESEARCHER,
): EffectDef<ExploreRequest, z.infer<typeof ResearchDocSchema>> {
  return {
    name: EFFECTS.researchExplore,
    requestSchema: ExploreRequestSchema,
    responseSchema: ResearchDocSchema,
    effects: [],
    run: async (req, ctx) => research(req.userPrompt, req.projectRoot, ctx.config),
  };
}

// ── research.critique ───────────────────────────────────────────────

export const CritiqueRequestSchema = z.object({
  researchId: z.string().min(1),
  reflection: ProblemReflectionSchema,
  questions: z.array(z.string()),
  findings: z.string(),
  questionsAnswered: z.number().int().min(0),
  reflexionRound: z.number().int().min(0),
  promptRef: z.string().min(1),
  model: z.string().min(1),
});
export type CritiqueRequest = z.infer<typeof CritiqueRequestSchema>;

/**
 * A critique, or `null` when the reviewer has nothing left to ask for.
 *
 * `null` is what ends the reflexion loop EARLY; the declared `maxIterations` is what ends
 * it late. Both exits lead to `research_collect`.
 */
export const CritiqueResponseSchema = z.object({ critique: z.string().nullable() });
export type CritiqueResponse = z.infer<typeof CritiqueResponseSchema>;

export type Critic = (req: CritiqueRequest, ctx: NodeContext) => Promise<CritiqueResponse>;

export function researchCritiqueEffect(critique: Critic): EffectDef<CritiqueRequest, CritiqueResponse> {
  return {
    name: EFFECTS.researchCritique,
    requestSchema: CritiqueRequestSchema,
    responseSchema: CritiqueResponseSchema,
    effects: [],
    run: critique,
  };
}

// ── research.collect ────────────────────────────────────────────────

export const CollectRequestSchema = z.object({
  projectRoot: z.string().min(1),
  doc: ResearchDocSchema,
});
export type CollectRequest = z.infer<typeof CollectRequestSchema>;

/**
 * `documentId` is READ BACK OUT OF THE DIRECTORY, never computed.
 *
 * `saveResearch` returns `void` and `researchPath` is private to
 * `src/state/research-state.ts`, so the only honest evidence that the document exists is
 * the shipped `listResearch` reporting it. `null` means the write did not land, which the
 * research exit gate refuses on (`gate.check: "research-document-written"`).
 */
export const CollectResponseSchema = z.object({
  researchId: z.string().min(1),
  documentId: z.string().min(1).nullable(),
});

export type ResearchWriter = (projectRoot: string, doc: ResearchDoc) => Promise<void>;
export type ResearchLister = (projectRoot: string) => Promise<string[]>;

/** The shipped research-document writer and lister, unmodified. */
export const DEFAULT_RESEARCH_WRITER: ResearchWriter = saveResearch;
export const DEFAULT_RESEARCH_LISTER: ResearchLister = listResearch;

/** The sanitisation `researchPath` applies to a document id before it becomes a filename. */
function documentIdOf(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function researchCollectEffect(
  write: ResearchWriter = DEFAULT_RESEARCH_WRITER,
  list: ResearchLister = DEFAULT_RESEARCH_LISTER,
): EffectDef<CollectRequest, z.infer<typeof CollectResponseSchema>> {
  return {
    name: EFFECTS.researchCollect,
    requestSchema: CollectRequestSchema,
    responseSchema: CollectResponseSchema,
    // `research_collect` is the ONE research node that declares fs-write.
    effects: ["fs-write"],
    run: async (req) => {
      await write(req.projectRoot, req.doc);
      const onDisk = await list(req.projectRoot);
      const expected = documentIdOf(req.doc.id);
      return {
        researchId: req.doc.id,
        documentId: onDisk.includes(expected) ? expected : null,
      };
    },
  };
}

// ── planner.draft ───────────────────────────────────────────────────

export const PlannerRequestSchema = z.object({
  /** Folded by the node, for the same three-parameter reason as `research.explore`. */
  userPrompt: z.string().min(1),
  projectRoot: z.string().min(1),
  researchDoc: ResearchDocSchema.optional(),
  /**
   * Answers already given, carried explicitly.
   *
   * `runPlanner` has no parameter for them — they reach the shipped agent through
   * `userPrompt` — but a request that only carried the folded prompt would make "the
   * planner was re-invoked WITH the answers" an assertion about substring matching.
   */
  resolvedClarifications: z.array(
    z.object({ questionId: z.string().min(1), answer: z.string().min(1) }),
  ),
});
export type PlannerRequest = z.infer<typeof PlannerRequestSchema>;

/**
 * A DISCRIMINATED union, not `z.enum(["ready", "needs-clarification"])` beside a spec.
 *
 * `PlannerResult` is a discriminated union (`planner-agent.ts:146`), and an object schema
 * with an enum member infers `{ kind: "ready" | "needs-clarification" }` — a wider type
 * that {@link _plannerResponseIsExact} correctly refuses. Callers "MUST narrow on `kind`
 * before reading `spec.features`" per the agent's own contract, and only the union shape
 * makes that narrowing possible downstream.
 */
export const PlannerResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), spec: PlanSpecSchema }),
  z.object({ kind: z.literal("needs-clarification"), spec: PlanSpecSchema }),
]);

export const _plannerResponseIsExact: Exact<
  z.infer<typeof PlannerResponseSchema>,
  PlannerResult
> = true;

export type Planner = (
  userPrompt: string,
  projectRoot: string,
  config: BoberConfig,
  researchDoc?: ResearchDoc,
) => Promise<PlannerResult>;

/** The shipped planner, unmodified. Exported so a test can prove the binding by identity. */
export const DEFAULT_PLANNER: Planner = runPlanner;

export function plannerDraftEffect(
  plan: Planner = DEFAULT_PLANNER,
): EffectDef<PlannerRequest, PlannerResult> {
  return {
    name: EFFECTS.plannerDraft,
    requestSchema: totalSchema(PlannerRequestSchema),
    responseSchema: totalSchema(PlannerResponseSchema),
    effects: [],
    run: async (req, ctx) => plan(req.userPrompt, req.projectRoot, ctx.config, req.researchDoc),
  };
}

// ── plan.materialize ────────────────────────────────────────────────

export const MaterializeRequestSchema = z.object({
  projectRoot: z.string().min(1),
  spec: PlanSpecSchema,
});
export type MaterializeRequest = z.infer<typeof MaterializeRequestSchema>;

export type ContractMaterializer = (
  spec: z.infer<typeof PlanSpecSchema>,
  projectRoot: string,
  config: BoberConfig,
) => Promise<SprintContract[]>;

/**
 * The shipped contract materializer, unmodified.
 *
 * KNOWN CONSEQUENCE: `materializeContracts` persists each contract itself
 * (`contract-materialization.ts:132`), and the PGE commit boundary persists the
 * `sprintContracts` channel again (`commit.ts:420-430`). The two writes are
 * byte-identical to the same path, so the artifact is correct either way, but the plan
 * region writes each contract twice. Reimplementing the derivation here to avoid it
 * would fork the pipeline's contract shape, which is strictly worse.
 */
export const DEFAULT_CONTRACT_MATERIALIZER: ContractMaterializer = materializeContracts;

export function planMaterializeEffect(
  materialize: ContractMaterializer = DEFAULT_CONTRACT_MATERIALIZER,
): EffectDef<MaterializeRequest, SprintContract[]> {
  return {
    name: EFFECTS.planMaterialize,
    requestSchema: totalSchema(MaterializeRequestSchema),
    responseSchema: totalSchema(SprintContractListSchema),
    effects: ["fs-write"],
    run: async (req, ctx) => materialize(req.spec, req.projectRoot, ctx.config),
  };
}

// ── run.gracefulFailure ─────────────────────────────────────────────

export const GracefulFailureRequestSchema = z.object({
  projectRoot: z.string().min(1),
  artifact: FailureArtifactSchema,
});
export type GracefulFailureRequest = z.infer<typeof GracefulFailureRequestSchema>;

export const GracefulFailureResponseSchema = z.object({ path: z.string().min(1) });

export type FailureWriter = (
  projectRoot: string,
  artifact: z.infer<typeof FailureArtifactSchema>,
) => Promise<string>;

/** The runtime's own failure-artifact writer, unmodified. */
export const DEFAULT_FAILURE_WRITER: FailureWriter = writeFailureArtifact;

export function gracefulFailureEffect(
  write: FailureWriter = DEFAULT_FAILURE_WRITER,
): EffectDef<GracefulFailureRequest, z.infer<typeof GracefulFailureResponseSchema>> {
  return {
    name: EFFECTS.gracefulFailure,
    requestSchema: GracefulFailureRequestSchema,
    responseSchema: GracefulFailureResponseSchema,
    effects: ["fs-write"],
    run: async (req) => ({ path: await write(req.projectRoot, req.artifact) }),
  };
}

export { FAILURE_ARTIFACT_FORMAT_VERSION };

// ── Registry assembly ───────────────────────────────────────────────

/**
 * The bindings a research composition must supply, and the ones it may override.
 *
 * `reflect` and `critique` are REQUIRED because nothing in this repository produces
 * either yet; the rest default to shipped functions.
 */
export interface ResearchBindings {
  reflect: Reflector;
  critique: Critic;
  research?: Researcher;
  writeResearch?: ResearchWriter;
  listResearch?: ResearchLister;
  writeFailure?: FailureWriter;
}

export function createResearchEffectRegistry(bindings: ResearchBindings): EffectRegistry {
  const registry = createEffectRegistry();
  registry.register(researchReflectEffect(bindings.reflect));
  registry.register(researchExploreEffect(bindings.research));
  registry.register(researchCritiqueEffect(bindings.critique));
  registry.register(researchCollectEffect(bindings.writeResearch, bindings.listResearch));
  registry.register(gracefulFailureEffect(bindings.writeFailure));
  return registry;
}

export interface PlanBindings {
  planner?: Planner;
  materialize?: ContractMaterializer;
  writeFailure?: FailureWriter;
}

export function createPlanEffectRegistry(bindings: PlanBindings = {}): EffectRegistry {
  const registry = createEffectRegistry();
  registry.register(plannerDraftEffect(bindings.planner));
  registry.register(planMaterializeEffect(bindings.materialize));
  registry.register(gracefulFailureEffect(bindings.writeFailure));
  return registry;
}

// ══ Sprint region (sprint 12) ═══════════════════════════════════════

/**
 * The sprint region reaches the five shipped agents, the shipped security gate and the
 * shipped git primitive through the definitions below, and through nothing else.
 *
 * The rule from the module header applies unchanged and matters more here: `runGenerator`
 * writes to the working tree and `commitAll` creates a git object, so a node body that
 * could import either directly would make `EffectRegistry.invoke`'s re-check of the
 * calling node's DECLARED `effects` (`registry/effects.ts:147`) decorative. Every one of
 * those imports is in THIS file, and every sprint node body calls `ctx.effects.invoke`.
 *
 * None of the five agent functions is modified (nonGoal 2); each is wrapped, its result
 * parsed with a schema this module owns, and handed back. `evaluateSecurityGate`'s
 * fail-closed semantics are likewise untouched (nonGoal 6): the gate is CALLED, its verdict
 * is read, and not one of its five reasons is re-derived here.
 */

// ── Shared sprint payload schemas ───────────────────────────────────

/**
 * The shipped `EvaluationRunResult`, as a schema.
 *
 * `results` is `.loose()` because `EvalResult` carries eight optional enrichment fields
 * (`contracts/eval-result.ts`) that a plugin may or may not populate, and stripping them on
 * the way through the effect channel would silently narrow what the security gate and the
 * documenter are handed. {@link _evaluationIsAssignable} is what stops the shape drifting.
 */
export const EvaluationRunResultSchema = z.object({
  passed: z.boolean(),
  score: z.number(),
  results: z.array(
    z
      .object({
        evaluator: z.string(),
        passed: z.boolean(),
        score: z.number().optional(),
        details: z.array(
          z
            .object({
              criterion: z.string(),
              passed: z.boolean(),
              message: z.string(),
              severity: z.enum(["error", "warning", "info"]),
            })
            .passthrough(),
        ),
        summary: z.string(),
        feedback: z.string(),
        timestamp: z.string(),
      })
      .passthrough(),
  ),
  summary: z.string(),
  timestamp: z.string(),
});

/** A shipped evaluation is always a legal request payload. */
export const _evaluationIsAssignable: Exact<
  z.infer<typeof EvaluationRunResultSchema>["passed"],
  EvaluationRunResult["passed"]
> = true;

// ── curator.brief ───────────────────────────────────────────────────

export const CuratorBriefRequestSchema = z.object({
  contract: SprintContractSchema,
  spec: PlanSpecSchema,
  completedSprints: z.array(SprintContractSchema),
  projectRoot: z.string().min(1),
});
export type CuratorBriefRequest = z.infer<typeof CuratorBriefRequestSchema>;

/** The shipped `SprintBriefing`, as a schema. {@link _briefingIsExact} pins the drift. */
export const SprintBriefingSchema = z.object({
  contractId: z.string().min(1),
  timestamp: z.string(),
  briefing: z.string(),
  filesAnalyzed: z.array(z.string()),
  patternsFound: z.number(),
  utilsIdentified: z.number(),
});
export const _briefingIsExact: Exact<z.infer<typeof SprintBriefingSchema>, SprintBriefing> = true;

export type Curator = (
  contract: SprintContract,
  spec: z.infer<typeof PlanSpecSchema>,
  completedSprints: SprintContract[],
  projectRoot: string,
  config: BoberConfig,
) => Promise<SprintBriefing>;

/** The shipped curator, unmodified. */
export const DEFAULT_CURATOR: Curator = runCurator;

export function curatorBriefEffect(
  curate: Curator = DEFAULT_CURATOR,
): EffectDef<CuratorBriefRequest, SprintBriefing> {
  return {
    name: EFFECTS.curatorBrief,
    requestSchema: totalSchema(CuratorBriefRequestSchema),
    responseSchema: totalSchema(SprintBriefingSchema),
    effects: [],
    run: async (req, ctx) =>
      curate(req.contract, req.spec, [...req.completedSprints], req.projectRoot, ctx.config),
  };
}

// ── curator.explain ─────────────────────────────────────────────────

/**
 * One test explained in natural language.
 *
 * There is no shipped counterpart. `SprintBriefing` is a markdown blob
 * (`curator-agent.ts:27-41`) with no `expectedBehavior`, no per-test structure and no
 * categories, and `runCurator` may not be modified (nonGoal 2). So the explanation is a
 * SECOND, schema-constrained call the node makes beside the briefing — which is also why
 * the binding is REQUIRED rather than defaulted: nothing in this repository produces one
 * yet, and inventing a body would fabricate the evidence sc-12-1 is about.
 */
export const TestExplanationSchema = z.object({
  testId: z.string().min(1),
  expectedBehavior: z.string().min(1),
});
export type TestExplanation = z.infer<typeof TestExplanationSchema>;

export const ExplainRequestSchema = z.object({
  contractId: z.string().min(1),
  /** Every provided or existing test the curator must explain, derived from the contract. */
  testIds: z.array(z.string().min(1)),
  briefing: z.string(),
  promptRef: z.string().min(1),
  model: z.string().min(1),
});
export type ExplainRequest = z.infer<typeof ExplainRequestSchema>;

export const ExplainResponseSchema = z.object({
  explanations: z.array(TestExplanationSchema),
});
export type ExplainResponse = z.infer<typeof ExplainResponseSchema>;

export type Explainer = (req: ExplainRequest, ctx: NodeContext) => Promise<ExplainResponse>;

export function curatorExplainEffect(explain: Explainer): EffectDef<ExplainRequest, ExplainResponse> {
  return {
    name: EFFECTS.curatorExplain,
    requestSchema: totalSchema(ExplainRequestSchema),
    responseSchema: totalSchema(ExplainResponseSchema),
    effects: [],
    run: explain,
  };
}

// ── curator.mocks ───────────────────────────────────────────────────

/**
 * The mock-fixture curator.
 *
 * Declares `fs-write` because `sprint_curate_mocks` does (`coding.graph.ts:520`): the
 * curator writes fixture files. The manifest it returns is what `gate_mock_coverage`
 * inspects, and the gate's own schema for it lives in `gates.ts` — the module that gates on
 * it — so this request/response pair carries the manifest shape by reference rather than
 * defining a second one.
 */
export const MocksRequestSchema = z.object({
  contract: SprintContractSchema,
  projectRoot: z.string().min(1),
  /** The explanations from `curator.explain`, so the mocks answer the same behaviours. */
  explanations: z.array(TestExplanationSchema),
  /** Which round this is; a re-curation round carries the gate's diagnostics. */
  round: z.number().int().min(1),
  rejection: z.string().nullable(),
  promptRef: z.string().min(1),
  model: z.string().min(1),
});
export type MocksRequest = z.infer<typeof MocksRequestSchema>;

export const MocksResponseSchema = z.object({
  contractId: z.string().min(1),
  tests: z.array(
    z.object({
      testId: z.string().min(1),
      category: MockCategorySchema,
      intent: z.string().min(1),
      path: z.string().min(1),
    }),
  ),
});
export type MocksResponse = z.infer<typeof MocksResponseSchema>;

export type MockCurator = (req: MocksRequest, ctx: NodeContext) => Promise<MocksResponse>;

export function curatorMocksEffect(curate: MockCurator): EffectDef<MocksRequest, MocksResponse> {
  return {
    name: EFFECTS.curatorMocks,
    requestSchema: totalSchema(MocksRequestSchema),
    responseSchema: totalSchema(MocksResponseSchema),
    effects: ["fs-write"],
    run: curate,
  };
}

// ── generator.sprint ────────────────────────────────────────────────

export const GeneratorResultSchema = z.object({
  success: z.boolean(),
  notes: z.string(),
  filesChanged: z.array(z.string()),
  commitHash: z.string().optional(),
  turnsUsed: z.number().optional(),
  toolsCalled: z.array(z.string()).optional(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional(),
  costUsd: z.number().optional(),
});
export const _generatorResultIsExact: Exact<
  z.infer<typeof GeneratorResultSchema>,
  GeneratorResult
> = true;

export const GenerateRequestSchema = z.object({
  handoff: ContextHandoffSchema,
  projectRoot: z.string().min(1),
});
export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;

export type Generator = (
  handoff: ContextHandoff,
  projectRoot: string,
  config: BoberConfig,
) => Promise<GeneratorResult>;

/** The shipped generator, unmodified. */
export const DEFAULT_GENERATOR: Generator = runGenerator;

export function generatorSprintEffect(
  generate: Generator = DEFAULT_GENERATOR,
): EffectDef<GenerateRequest, GeneratorResult> {
  return {
    name: EFFECTS.generatorSprint,
    requestSchema: totalSchema(GenerateRequestSchema),
    responseSchema: totalSchema(GeneratorResultSchema),
    effects: ["fs-write"],
    run: async (req, ctx) => generate(req.handoff, req.projectRoot, ctx.config),
  };
}

// ── security.audit ──────────────────────────────────────────────────

export const SecurityAuditRequestSchema = z.object({
  contract: SprintContractSchema,
  evaluation: EvaluationRunResultSchema,
  projectRoot: z.string().min(1),
});
export type SecurityAuditRequest = z.infer<typeof SecurityAuditRequestSchema>;

/**
 * The gate's verdict, with `result` deliberately dropped.
 *
 * `SecurityAuditResult` is a large object with its own findings tree, and every channel in
 * the artifact tops out at 4096 bytes. What the node needs to route is `blocked` and
 * `reason`; the full result stays inside `evaluateSecurityGate`, which already persists it
 * (`security-gate.ts:120`).
 */
export const SecurityAuditResponseSchema = z.object({
  blocked: z.boolean(),
  reason: z.enum(["critical-finding", "timeout", "audit-error", "clean", "disabled"]),
  /** How many CRITICAL findings the audit reported; the count that blocks. */
  findings: z.number().int().min(0),
});
export type SecurityAuditResponse = z.infer<typeof SecurityAuditResponseSchema>;

export type SecurityAuditor = (input: SecurityGateInput) => Promise<SecurityGateVerdict>;

/** The shipped fail-closed gate, unmodified (nonGoal 6). */
export const DEFAULT_SECURITY_AUDITOR: SecurityAuditor = evaluateSecurityGate;

export function securityAuditEffect(
  audit: SecurityAuditor = DEFAULT_SECURITY_AUDITOR,
): EffectDef<SecurityAuditRequest, SecurityAuditResponse> {
  return {
    name: EFFECTS.securityAudit,
    requestSchema: totalSchema(SecurityAuditRequestSchema),
    responseSchema: totalSchema(SecurityAuditResponseSchema),
    effects: [],
    run: async (req, ctx) => {
      // Not one of the five reasons is re-derived: the verdict is read off the gate.
      const verdict = await audit({
        contract: req.contract,
        evaluation: req.evaluation,
        projectRoot: req.projectRoot,
        config: ctx.config,
      });
      return {
        blocked: verdict.blocked,
        reason: verdict.reason,
        findings: verdict.result?.review.critical.length ?? 0,
      };
    },
  };
}

// ── evaluator.sprint ────────────────────────────────────────────────

export const EvaluateRequestSchema = z.object({
  handoff: ContextHandoffSchema,
  projectRoot: z.string().min(1),
});
export type EvaluateRequest = z.infer<typeof EvaluateRequestSchema>;

export type Evaluator = (
  handoff: ContextHandoff,
  projectRoot: string,
  config: BoberConfig,
) => Promise<EvaluationRunResult>;

/** The shipped evaluator, unmodified. */
export const DEFAULT_EVALUATOR: Evaluator = runEvaluatorAgent;

export function evaluatorSprintEffect(
  evaluate: Evaluator = DEFAULT_EVALUATOR,
): EffectDef<EvaluateRequest, EvaluationRunResult> {
  return {
    name: EFFECTS.evaluatorSprint,
    requestSchema: totalSchema(EvaluateRequestSchema),
    // Deliberately NOT `totalSchema`: sc-12-6 is the claim that a MALFORMED evaluator result
    // never reaches success. A strict response schema would turn that into a `ZodError`
    // thrown from inside the effect channel, which the node would then have to catch and
    // guess about; the node parses the result itself and routes on the answer.
    responseSchema: z.custom<EvaluationRunResult>(() => true),
    effects: [],
    run: async (req, ctx) => evaluate(req.handoff, req.projectRoot, ctx.config),
  };
}

// ── reviewer.sprint ─────────────────────────────────────────────────

/** The shipped `ReviewFinding`. {@link _reviewResultIsExact} fails `tsc` on drift. */
export const ReviewFindingSchema = z.object({
  description: z.string(),
  evidence: z.array(
    z.object({ path: z.string(), line: z.number(), snippet: z.string() }),
  ),
  antiPattern: z.string().optional(),
  source: z.string().optional(),
});

export const ReviewResultSchema = z.object({
  reviewId: z.string().min(1),
  contractId: z.string().min(1),
  specId: z.string(),
  timestamp: z.string(),
  summary: z.string(),
  critical: z.array(ReviewFindingSchema),
  important: z.array(ReviewFindingSchema),
  minor: z.array(ReviewFindingSchema),
  approvedAreas: z.array(z.string()),
});
export const _reviewResultIsExact: Exact<z.infer<typeof ReviewResultSchema>, ReviewResult> = true;

export const ReviewRequestSchema = z.object({
  contract: SprintContractSchema,
  evaluation: EvaluationRunResultSchema,
  projectRoot: z.string().min(1),
});
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

export type CodeReviewer = (
  contract: SprintContract,
  evaluation: EvaluationRunResult,
  projectRoot: string,
  config: BoberConfig,
) => Promise<ReviewResult>;

/** The shipped code reviewer, unmodified. */
export const DEFAULT_CODE_REVIEWER: CodeReviewer = runCodeReviewer;

export function reviewerSprintEffect(
  review: CodeReviewer = DEFAULT_CODE_REVIEWER,
): EffectDef<ReviewRequest, z.infer<typeof ReviewResultSchema>> {
  return {
    name: EFFECTS.reviewerSprint,
    requestSchema: totalSchema(ReviewRequestSchema),
    responseSchema: ReviewResultSchema,
    effects: [],
    run: async (req, ctx) => review(req.contract, req.evaluation, req.projectRoot, ctx.config),
  };
}

// ── sprint.exit ─────────────────────────────────────────────────────

export const SprintExitRequestSchema = z.object({
  projectRoot: z.string().min(1),
  contract: SprintContractSchema,
});
export type SprintExitRequest = z.infer<typeof SprintExitRequestSchema>;

export const SprintExitResponseSchema = z.object({ contractId: z.string().min(1) });

export type ContractWriter = (projectRoot: string, contract: SprintContract) => Promise<void>;

/** The shipped contract writer, unmodified. */
export const DEFAULT_CONTRACT_WRITER: ContractWriter = saveContract;

export function sprintExitEffect(
  write: ContractWriter = DEFAULT_CONTRACT_WRITER,
): EffectDef<SprintExitRequest, z.infer<typeof SprintExitResponseSchema>> {
  return {
    name: EFFECTS.sprintExit,
    requestSchema: totalSchema(SprintExitRequestSchema),
    responseSchema: SprintExitResponseSchema,
    effects: ["fs-write"],
    run: async (req) => {
      await write(req.projectRoot, req.contract);
      return { contractId: req.contract.contractId };
    },
  };
}

// ── documenter.summary ──────────────────────────────────────────────

export const DocumentRequestSchema = z.object({
  contract: SprintContractSchema,
  evaluation: EvaluationRunResultSchema,
  projectRoot: z.string().min(1),
  generatorResult: GeneratorResultSchema.optional(),
});
export type DocumentRequest = z.infer<typeof DocumentRequestSchema>;

export const DocumentationResultSchema = z.object({
  contractId: z.string().min(1),
  sprintDocPath: z.string(),
  relatedDocsUpdated: z.array(z.object({ path: z.string(), reason: z.string() })),
  docsCommit: z.string().optional(),
  concerns: z.array(z.string()),
  summary: z.string(),
});
export const _documentationResultIsExact: Exact<
  z.infer<typeof DocumentationResultSchema>,
  DocumentationResult
> = true;

export type Documenter = (
  contract: SprintContract,
  evaluation: EvaluationRunResult,
  generatorResult: GeneratorResult | undefined,
  projectRoot: string,
  config: BoberConfig,
) => Promise<DocumentationResult>;

/** The shipped documenter, unmodified. */
export const DEFAULT_DOCUMENTER: Documenter = runDocumenter;

export function documenterSummaryEffect(
  document: Documenter = DEFAULT_DOCUMENTER,
): EffectDef<DocumentRequest, DocumentationResult> {
  return {
    name: EFFECTS.documenterSummary,
    requestSchema: totalSchema(DocumentRequestSchema),
    responseSchema: totalSchema(DocumentationResultSchema),
    // `fs-write` and NOT `git`, matching `documenter`'s own declaration
    // (`coding.graph.ts:820`). `runDocumenter`'s prompt asks the model to commit the doc
    // files (`documenter-agent.ts:137`); the node fences that instruction (see
    // `documenter.ts`), and `commit.test.ts` asserts no commit object appears.
    effects: ["fs-write"],
    run: async (req, ctx) =>
      document(req.contract, req.evaluation, req.generatorResult, req.projectRoot, ctx.config),
  };
}

// ── git.commit ──────────────────────────────────────────────────────

export const GitCommitRequestSchema = z.object({
  cwd: z.string().min(1),
  message: z.string().min(1),
});
export type GitCommitRequest = z.infer<typeof GitCommitRequestSchema>;

export const GitCommitResponseSchema = z.object({ commit: z.string().min(1) });

export type Committer = (cwd: string, message: string) => Promise<string>;

/** The shipped git primitive, unmodified (`src/utils/git.ts:27`). */
export const DEFAULT_COMMITTER: Committer = commitAll;

/**
 * The ONE effect tagged `git`.
 *
 * `EffectRegistry.invoke` refuses it for any node that does not declare `git` in the
 * artifact (`registry/effects.ts:147`), and the interpreter refuses to DISPATCH such a node
 * without a recorded approval (`interrupt.ts:527-556`). Two independent locks on the same
 * door, and neither is bypassable from a node body.
 */
export function gitCommitEffect(
  commit: Committer = DEFAULT_COMMITTER,
): EffectDef<GitCommitRequest, z.infer<typeof GitCommitResponseSchema>> {
  return {
    name: EFFECTS.gitCommit,
    requestSchema: totalSchema(GitCommitRequestSchema),
    responseSchema: GitCommitResponseSchema,
    effects: ["git"],
    run: async (req) => ({ commit: await commit(req.cwd, req.message) }),
  };
}

// ── Sprint registry assembly ────────────────────────────────────────

/**
 * What a sprint composition supplies.
 *
 * `explain` and `mocks` are REQUIRED for the same reason `reflect` and `critique` are: no
 * shipped function produces either, and the sprint contract's sc-12-1 and sc-12-2 are about
 * output this repository has never emitted. Everything else defaults to the shipped agent.
 */
export interface SprintBindings {
  explain: Explainer;
  mocks: MockCurator;
  curator?: Curator;
  generator?: Generator;
  security?: SecurityAuditor;
  evaluator?: Evaluator;
  reviewer?: CodeReviewer;
  writeContract?: ContractWriter;
  writeFailure?: FailureWriter;
}

export function createSprintEffectRegistry(bindings: SprintBindings): EffectRegistry {
  const registry = createEffectRegistry();
  registry.register(curatorBriefEffect(bindings.curator));
  registry.register(curatorExplainEffect(bindings.explain));
  registry.register(curatorMocksEffect(bindings.mocks));
  registry.register(generatorSprintEffect(bindings.generator));
  registry.register(securityAuditEffect(bindings.security));
  registry.register(evaluatorSprintEffect(bindings.evaluator));
  registry.register(reviewerSprintEffect(bindings.reviewer));
  registry.register(sprintExitEffect(bindings.writeContract));
  registry.register(gracefulFailureEffect(bindings.writeFailure));
  return registry;
}

export interface TerminalBindings {
  documenter?: Documenter;
  committer?: Committer;
  writeFailure?: FailureWriter;
}

export function createTerminalEffectRegistry(bindings: TerminalBindings = {}): EffectRegistry {
  const registry = createEffectRegistry();
  registry.register(documenterSummaryEffect(bindings.documenter));
  registry.register(gitCommitEffect(bindings.committer));
  registry.register(gracefulFailureEffect(bindings.writeFailure));
  return registry;
}
