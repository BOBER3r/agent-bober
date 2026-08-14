import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { BoberConfig } from "../../../config/schema.js";
import { createDefaultConfig } from "../../../config/schema.js";
import type { PlanSpec } from "../../../contracts/spec.js";
import type { SprintContract } from "../../../contracts/sprint-contract.js";
import type { NodeKind } from "../../../contracts/topology.js";
import type { EvaluationRunResult } from "../../../evaluators/registry.js";
import type { ReviewResult } from "../../../orchestrator/code-reviewer-agent.js";
import type { DocumentationResult } from "../../../orchestrator/documenter-agent.js";
import type { GeneratorResult } from "../../../orchestrator/generator-agent.js";
import { persistEvalResult } from "../../../orchestrator/eval-persist.js";
import { saveBriefing } from "../../../state/briefing-state.js";
import { saveSpec } from "../../../state/plan-state.js";
import { saveReview } from "../../../state/review-state.js";
import { updateContract } from "../../../state/sprint-state.js";
import type { CodingBindings } from "../../registry/index.js";
import type { ScratchRef } from "../../state/overall.js";
import type { SandboxOutcome, SandboxRunner } from "../../runtime/sandbox.js";
import type { ScratchStore } from "../../runtime/scratch.js";
import type { TraceWriter } from "../../runtime/trace.js";
import {
  stubContracts,
  stubPlanSpec,
  stubReflection,
  stubResearchDoc,
} from "../../nodes/__fixtures__/region-harness.js";
import {
  stubDocumenter,
  stubEvaluation,
  stubExplain,
  stubMocks,
  stubSecurity,
} from "../../nodes/__fixtures__/sprint-harness.js";
import type { BudgetLedger, NodeContext, NodeUsage } from "../../registry/nodes.js";
import type { PgeRegistriesInput } from "../pge-engine.js";

/**
 * The whole COMMITTED artifact, driven by ONE deterministic collaborator set.
 *
 * ── What this substitutes, and what it does not ──
 *
 * Nothing in the graph runtime is replaced. The interpreter, the commit boundary, the
 * scheduler, the trace writer, the scratch store, the ledger, the registries and all
 * forty-four node implementations are the shipped ones, compiled from
 * `.bober/topology/coding.json`. The ONLY substitution is at the effect seam the artifact
 * already declares — the shipped agent functions at the very edge of the system — and it is
 * made through `CodingBindings`, which is the seam production wiring itself uses.
 *
 * ── Why the fakes WRITE the artifacts the real agents write ──
 *
 * `runCurator` writes `.bober/briefings/<contractId>-briefing.md`, `runCodeReviewer` writes
 * `.bober/reviews/`, and the evaluator's result is persisted to `.bober/eval-results/`.
 * Those writes are part of what the collaborator IS, not an incidental side effect, and a
 * fake that returned a value and wrote nothing would make an eleven-field artifact
 * comparison empty on exactly the fields the two engines are least likely to agree on —
 * which would turn a passing comparison into a comparison of two absences.
 *
 * So each fake performs the same persistence its real counterpart performs, through the same
 * `src/state/` writers, and — this is the point — the SAME fake is used on both sides of a
 * ts-versus-pge comparison. A divergence in `.bober/briefings/` is then a fact about the two
 * ENGINES, because the thing that wrote the briefing was identical.
 */

// ── The committed artifact ──────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
/** `<repo>/.bober/topology/coding.json` — this file is four levels below the repo root. */
export const REPO_ROOT = join(HERE, "..", "..", "..", "..");
export const COMMITTED_ARTIFACT = join(REPO_ROOT, ".bober", "topology", "coding.json");
export const CODING_GRAPH_ID = "coding";

/** Copy the repository's own committed artifact into `projectRoot`, with its prompts. */
export async function seedCommittedArtifact(projectRoot: string): Promise<void> {
  await mkdir(join(projectRoot, ".bober", "topology"), { recursive: true });
  await cp(COMMITTED_ARTIFACT, join(projectRoot, ".bober", "topology", `${CODING_GRAPH_ID}.json`));
  await seedPrompts(projectRoot);
}

/**
 * A prompt file for every `promptRef` the COMMITTED ARTIFACT declares.
 *
 * Derived from the artifact rather than from a list here, so a topology that adds an `llm`
 * node gets its prompt without this fixture being edited — and so a run cannot silently
 * resolve a ref the artifact does not declare.
 *
 * The refs are seeded because `PgeEngine` builds a REAL file-backed prompt store, and this
 * repository ships no `.bober/prompts/` tree (creating one would change
 * `pge validate --mode full` repo-wide, which is out of this sprint's scope). Without the
 * files the first `llm` node dies on `UnknownPromptRefError`, which is a fact about this
 * checkout's prompt store and not about either engine.
 */
export async function seedPrompts(projectRoot: string): Promise<void> {
  const raw: unknown = JSON.parse(await readFile(COMMITTED_ARTIFACT, "utf-8"));
  const nodes = (raw as { nodes?: Array<{ promptRef?: string }> }).nodes ?? [];
  const refs = [...new Set(nodes.map((node) => node.promptRef).filter((ref): ref is string => typeof ref === "string"))];
  for (const ref of refs) {
    const path = join(projectRoot, ".bober", "prompts", `${ref}.md`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `# ${ref}\n\nFixture prompt for ${ref}.\n`, "utf-8");
  }
}

/**
 * Every node the COMMITTED artifact declares, mapped to its declared `kind`.
 *
 * Read off the artifact JSON so a test that maps a span to a node kind is reading the same
 * source the run compiled from. A list written into a test would make the mapping an
 * assertion about the test.
 */
export async function artifactNodeKinds(): Promise<Map<string, NodeKind>> {
  const raw: unknown = JSON.parse(await readFile(COMMITTED_ARTIFACT, "utf-8"));
  const nodes = (raw as { nodes?: Array<{ id: string; kind: NodeKind }> }).nodes ?? [];
  return new Map(nodes.map((node) => [node.id, node.kind]));
}

// ── The deterministic plan ──────────────────────────────────────────

/**
 * The one spec both engines plan, with a FIXED id.
 *
 * `createSpec` derives `specId` from the title and the clock, and the two engines run at
 * two different wall-clock instants; a drifting id would make every downstream artifact
 * name differ and report a divergence that is an artefact of the fixture.
 */
export const GOLDEN_SPEC_ID = "spec-20260805-pge-conformance";

export function goldenPlanSpec(): PlanSpec {
  const base = stubPlanSpec();
  return {
    ...base,
    specId: GOLDEN_SPEC_ID,
    title: "PGE conformance fixture",
    description: "The single golden spec both engines are compared on.",
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
  };
}

/** The contracts the golden spec materialises to, with ids derived from the fixed spec id. */
export function goldenContracts(): SprintContract[] {
  return stubContracts(goldenPlanSpec()).map((contract) => ({
    ...contract,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
  }));
}

/** The instant every fixture artifact is stamped with. */
export const FIXED_ISO = "2026-08-05T00:00:00.000Z";

// ── Sandbox ─────────────────────────────────────────────────────────

/**
 * A sandbox that runs nothing and reports success.
 *
 * The sprint region's three sandbox nodes (`gate_syntax`, `sprint_evaluate`,
 * `gate_anchor_regression`) would otherwise spawn this repository's real `npm test` inside a
 * temp directory that has no package.json. Refusing to spawn is also what makes a
 * conformance comparison reproducible: a real suite run is the one collaborator whose result
 * genuinely varies between two invocations.
 */
export function passingSandbox(scratch: ScratchStore, runId: string): SandboxRunner {
  return {
    async run(): Promise<SandboxOutcome> {
      const stdoutRef: ScratchRef = await scratch.put(runId, "stdout", "ok\n");
      const stderrRef: ScratchRef = await scratch.put(runId, "stderr", "");
      return { status: "ok", exitCode: 0, stdoutRef, stderrRef };
    },
  };
}

// ── Bindings ────────────────────────────────────────────────────────

/**
 * Narrow an OPTIONAL binding from the region fixtures to the REQUIRED member
 * {@link CodingBindings} declares.
 *
 * `stubExplain()` and `stubMocks()` are typed as `RegionBindings["explain" | "mocks"]`,
 * which is optional because a research-only composition has no explainer. A whole-graph
 * composition requires both, and this is where the two facts meet. A `!` would say the same
 * thing without ever checking it.
 */
function requireBinding<T>(binding: T | undefined, name: string): T {
  if (binding === undefined) throw new Error(`the ${name} fixture returned no binding`);
  return binding;
}

export interface WholeGraphBindingOptions {
  /** Fails the evaluator, so the rework and partial paths can be exercised. */
  readonly evaluationPasses?: boolean;
  /** Records every collaborator invocation, in order. */
  readonly calls?: string[];
  /**
   * What each ctx-bearing collaborator charges the run's ledger.
   *
   * Charged through `ctx.ledger.charge` from inside a node's own collaborator — the same
   * call a real provider adapter makes — so a reconciliation test is reconciling numbers the
   * RUN booked rather than numbers a test wrote into a ledger it built itself. Absent means
   * nothing is charged and the run's spend stays zero.
   */
  readonly charge?: NodeUsage;
  /** Called with the run's own ledger on every charge, so a test can read it mid-run. */
  readonly ledgerProbe?: (ledger: BudgetLedger) => void;
}

/**
 * The collaborator BODIES, shared by both engines.
 *
 * This is the fixture's whole point. The imperative engine reaches these through
 * `vi.mock`ed agent modules and the graph engine reaches them through `CodingBindings`, and
 * they are the SAME functions with the same persistence — so an artifact that differs
 * between the two engines differs because of the ENGINE and not because of what stood in for
 * the model.
 */
export interface SharedAgents {
  planner(): Promise<{ kind: "ready"; spec: PlanSpec }>;
  materialize(): Promise<SprintContract[]>;
  curator(contract: SprintContract): Promise<{
    contractId: string;
    timestamp: string;
    briefing: string;
    filesAnalyzed: string[];
    patternsFound: number;
    utilsIdentified: number;
  }>;
  generator(contractId: string): Promise<{
    success: boolean;
    notes: string;
    filesChanged: string[];
  }>;
  evaluator(contract: SprintContract | undefined): Promise<EvaluationRunResult>;
  reviewer(contract: SprintContract): Promise<ReviewResult>;
  documenter(
    contract: SprintContract,
    evaluation: EvaluationRunResult,
    generatorResult: GeneratorResult | undefined,
    projectRoot: string,
  ): Promise<DocumentationResult>;
}

export function sharedAgents(
  projectRoot: string,
  options: { evaluationPasses?: boolean; record?: (name: string) => void } = {},
): SharedAgents {
  const passes = options.evaluationPasses ?? true;
  const record = (name: string): void => options.record?.(name);
  const documenter = stubDocumenter();

  return {
    planner: async () => {
      record("planner");
      const spec = goldenPlanSpec();
      // The shipped `runPlanner` persists its own spec (`planner-agent.ts`), and the
      // imperative pipeline has no other spec writer — so a fake that skipped this would
      // leave `.bober/specs/` empty on the ts side and populated on the pge side (whose
      // commit boundary writes the `spec` channel), reporting a divergence created by the
      // fixture rather than by either engine.
      await saveSpec(projectRoot, spec);
      return { kind: "ready" as const, spec };
    },
    materialize: async () => {
      record("materialize");
      return goldenContracts();
    },
    curator: async (contract) => {
      record("curator");
      const briefing = `# ${contract.title}\n\nBriefing for ${contract.contractId}.\n`;
      // The real curator persists its briefing; so does this one, through the shipped writer.
      await saveBriefing(projectRoot, contract.contractId, briefing);
      return {
        contractId: contract.contractId,
        timestamp: FIXED_ISO,
        briefing,
        filesAnalyzed: contract.estimatedFiles ?? [],
        patternsFound: 1,
        utilsIdentified: 1,
      };
    },
    generator: async (contractId) => {
      record("generator");
      return { success: true, notes: `generated ${contractId}`, filesChanged: ["src/example.ts"] };
    },
    evaluator: async (contract) => {
      record("evaluator");
      return stubEvaluation({
        details: [
          { criterion: contract?.successCriteria[0]?.criterionId ?? "sc-1", passed: passes },
        ],
      });
    },
    reviewer: async (contract) => {
      record("reviewer");
      const review: ReviewResult = {
        reviewId: `review-${contract.contractId}`,
        contractId: contract.contractId,
        specId: contract.specId,
        timestamp: FIXED_ISO,
        summary: "no blocking findings",
        critical: [],
        important: [],
        minor: [],
        approvedAreas: ["structure"],
      };
      await saveReview(projectRoot, contract.contractId, `# Review\n\n${review.summary}\n`);
      return review;
    },
    documenter: async (contract, evaluation, generatorResult, root) =>
      documenter(contract, evaluation, generatorResult, root, conformanceConfig()),
  };
}

/**
 * Every collaborator the committed artifact needs, deterministic and persisting.
 *
 * Consumed through `PgeEngineDeps.bindings`, which is the shipped seam — there is no
 * test-only engine, no adapted registry and no forked node.
 */
export function wholeGraphBindings(
  input: PgeRegistriesInput,
  options: WholeGraphBindingOptions = {},
): CodingBindings {
  const record = (name: string): void => {
    options.calls?.push(name);
  };
  const projectRoot = input.projectRoot;
  const agents = sharedAgents(projectRoot, {
    ...(options.evaluationPasses === undefined ? {} : { evaluationPasses: options.evaluationPasses }),
    record,
  });

  /**
   * Book this collaborator's usage against the node that invoked it.
   *
   * `callIndex: 1` because the node BODY already charges `(nodeId, 0, 0)` and a charge is a
   * keyed upsert — sharing the key would silently replace the body's entry instead of
   * adding to it, and the per-node total would then be a function of which one ran last.
   */
  const bill = (ctx: NodeContext): void => {
    if (options.charge !== undefined) {
      ctx.ledger.charge({ nodeId: ctx.nodeId, attempt: 0, callIndex: 1 }, options.charge);
    }
    options.ledgerProbe?.(ctx.ledger);
  };

  const explain = requireBinding(stubExplain(), "explain");
  const mocks = requireBinding(stubMocks(), "mocks");

  return {
    runtime: {
      sandbox: passingSandbox(input.scratch, input.runId),
      scratch: input.scratch,
      trace: input.trace as unknown as TraceWriter,
    },

    // ── research region ──
    reflect: async (_req, ctx) => {
      record("reflect");
      bill(ctx);
      return stubReflection();
    },
    critique: async (_req, ctx) => {
      record("critique");
      bill(ctx);
      return { critique: null };
    },
    research: async () => {
      record("research");
      return stubResearchDoc(1, null);
    },

    // ── plan region ──
    planner: agents.planner,
    materialize: agents.materialize,

    // ── sprint region ──
    curator: agents.curator,
    explain: async (req, ctx) => {
      record("explain");
      bill(ctx);
      return explain(req, ctx);
    },
    mocks: async (req, ctx) => {
      record("mocks");
      bill(ctx);
      return mocks(req, ctx);
    },
    generator: async (handoff) => agents.generator(handoff.currentContract?.contractId ?? "unknown"),
    security: stubSecurity,
    evaluator: async (handoff) => {
      const contract = handoff.currentContract;
      const result = await agents.evaluator(contract);
      // The imperative pipeline persists every evaluation to `.bober/eval-results/`
      // (`pipeline.ts` calls `persistEvalResult` itself); the graph engine has no such
      // step, so the binding performs the write its imperative counterpart performs.
      if (contract !== undefined) await persistEvalResult(projectRoot, contract.contractId, 1, result);
      return result;
    },
    reviewer: agents.reviewer,
    writeContract: async (root, contract) => {
      record("writeContract");
      await updateContract(root, contract);
    },

    // ── terminal region ──
    documenter: async (contract, evaluation, generatorResult, root) =>
      agents.documenter(contract, evaluation, generatorResult, root),
    committer: async () => {
      record("committer");
      return "0000000";
    },
  };
}

// ── Config ──────────────────────────────────────────────────────────

/** The config both engines are run under. Autopilot, default engine untouched. */
export function conformanceConfig(name = "pge-conformance"): BoberConfig {
  const base = createDefaultConfig(name, "brownfield");
  return {
    ...base,
    pipeline: { ...base.pipeline, researchPhase: false, maxIterations: 2 },
    evaluator: { ...base.evaluator, maxIterations: 1 },
  };
}
