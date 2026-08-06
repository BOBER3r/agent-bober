import { CODING_SCHEMA_REFS } from "../topology/coding.graph.js";
import type { TopologySpec } from "../../contracts/topology.js";
import type { Registries } from "../compile/compiler.js";
import type { SchemaCatalog } from "../topology/validate.js";
import {
  createPlanEffectRegistry,
  createResearchEffectRegistry,
  createSprintEffectRegistry,
  createTerminalEffectRegistry,
} from "../nodes/effects.js";
import type {
  PlanBindings,
  ResearchBindings,
  SprintBindings,
  TerminalBindings,
} from "../nodes/effects.js";
import { commitNode, hitlCommitNode } from "../nodes/commit.js";
import { documenterNode } from "../nodes/documenter.js";
import {
  anchorRegressionGate,
  mockCoverageGate,
  reduceSprintsGate,
  sprintEntryGate,
  sprintExitGate,
  sprintRouter,
  syntaxGate,
} from "../nodes/gates.js";
import { registerPlanNodes } from "../nodes/plan.js";
import { RESEARCH_REGION, PLAN_REGION, SPRINT_REGION, TERMINAL_REGION } from "../nodes/regions.js";
import type { RegionId } from "../nodes/regions.js";
import { registerResearchNodes } from "../nodes/research.js";
import { sprintCurateExplainNode, sprintCurateMocksNode } from "../nodes/sprint-curate.js";
import { sprintEvaluateNode, sprintSecurityNode } from "../nodes/sprint-evaluate.js";
import { fanoutSprintsNode, sprintBodyNode } from "../nodes/sprint-fanout.js";
import { sprintCorrectNode, sprintGenerateNode } from "../nodes/sprint-generate.js";
import { sprintExitNode, sprintReviewNode } from "../nodes/sprint-review.js";
import type { SprintRuntime } from "../nodes/verification.js";
import { gracefulFailureNode, supervisorNode } from "../nodes/supervisor.js";
import { createNodeRegistry } from "./nodes.js";
import type { NodeImpl, NodeRegistry } from "./nodes.js";
import { createReducerRegistry } from "./reducers.js";

/**
 * The composition root: a region of the committed artifact, plus the implementations that
 * animate it, assembled into the {@link Registries} `compile()` takes.
 *
 * ── This barrel must never enter the `bober pge` command path ──
 *
 * `src/cli/commands/pge.ts:24` imports `../../pge/registry/effects.js` BY DIRECT PATH, and
 * that is deliberate: `src/pge/zero-execution.test.ts` statically imports the whole `bober
 * pge` command module with `vi.mock` installed for the pipeline, every agent, every
 * provider adapter and `execa`, and asserts that importing it resolves ZERO of them. This
 * file transitively imports `runResearch` and `runPlanner` (through `../nodes/effects.js`),
 * so re-pointing that CLI import at this barrel would fail that assertion immediately.
 * Import the specific module, never the barrel.
 *
 * ── Why `schemas` and not `schemaModules` ──
 *
 * `compile()` offers a reference-identity check when `Registries.schemaModules` resolves a
 * `schemaRef` to the exact Zod schema an implementation parses with (`compiler.ts:325`),
 * which is the strongest port check available. Two properties of the COMMITTED artifact
 * make it inexpressible for these regions:
 *
 *  1. every boundary gate must declare a permissive `inputSchema` — the interpreter parses
 *     a task's input before the handler is entered (`interpreter.ts:929`), so a gate whose
 *     input schema were strict could never run the body that refuses a bad payload — and
 *     its output is `admitted | refusal`. No single schema behind `"FeatureRequest"` can be
 *     both the feature request and the refusal that replaces it;
 *  2. one ref serves two cardinalities: `fanout_sprints` binds `schemaRef:
 *     "SprintContract"` on a PLURAL `contracts` input port and a SINGULAR `contract`
 *     output port (`coding.graph.ts:453-454`), while the module map is keyed by ref alone.
 *
 * So the artifact's own closed ref list, {@link CODING_SCHEMA_REFS}, is supplied as a
 * {@link SchemaCatalog}: every `schemaRef` an implementation binds must still resolve
 * through the list the artifact publishes, and a ref that does not is `UnknownSchemaRef`.
 * Both properties are reported as findings rather than worked around.
 */

// ── Schema catalog ──────────────────────────────────────────────────

/**
 * The artifact's own closed ref list, as a catalog.
 *
 * `isAssignable` is identity: a `schemaRef` names one type, and a topology that wanted a
 * widening conversion between two of them would have to say so in the artifact.
 */
export function codingSchemaCatalog(): SchemaCatalog {
  const known = new Set(CODING_SCHEMA_REFS);
  return { has: (ref) => known.has(ref), isAssignable: (from, to) => from === to };
}

// ── Bindings ────────────────────────────────────────────────────────

/**
 * What a composition supplies, beyond the shipped defaults.
 *
 * `reflect` and `critique` are REQUIRED because nothing in this repository produces either
 * yet — agent-bober has never emitted a structured `ProblemReflection`, and sc-11-1 is
 * explicitly additive. Everything else defaults to the function this repository already
 * ships, so a caller that binds nothing gets the live agents.
 */
export interface RegionBindings
  extends ResearchBindings,
    PlanBindings,
    Partial<SprintBindings>,
    TerminalBindings {
  /**
   * The execution collaborators the sprint region needs and `NodeContext` does not carry.
   *
   * REQUIRED for the sprint region and meaningless for the other three, so it is optional
   * here and demanded where it is used — a `SprintRuntime` on a research composition would
   * be a sandbox nobody can invoke.
   */
  runtime?: SprintRuntime;

  /**
   * Replace one node's body outright, leaving the artifact untouched.
   *
   * The same escape hatch the golden fixture offers (`golden-graph.ts:568`) and for the
   * same reason: a test about a gate refusing a bad payload should change exactly the one
   * node that produces the bad payload, and run against the same committed topology every
   * other test runs against.
   */
  handlerOverrides?: Readonly<Record<string, NodeImpl["handler"]>>;

  /**
   * Replace one node's whole IMPLEMENTATION, including the schemas it parses with.
   *
   * Narrower in intent than {@link handlerOverrides} and broader in reach, so it is
   * separate rather than folded in. It exists for exactly one situation: a downstream
   * node's fail-closed behaviour cannot be observed while an UPSTREAM node's own
   * `outputSchema` refuses the payload first.
   *
   * `plan_materialize` binds `outputSchema: PlanContractsSchema`, and the interpreter
   * parses a handler's return value with it before routing (`interpreter.ts:958`). So a
   * malformed contract set never leaves the materialiser, `gate_plan_out` is never
   * reached, and a test that stopped there would have proved something about the
   * MATERIALISER while claiming something about the gate. Relaxing the producer's own
   * schema is what puts the gate on the payload's path; the gate itself is untouched, and
   * the positive control in `gates.test.ts` re-runs the same region with nothing
   * overridden.
   */
  implOverrides?: Readonly<Record<string, (impl: NodeImpl) => NodeImpl>>;
}

/** Apply the overrides on the way OUT of the registry, so the artifact is unchanged. */
function overriding(inner: NodeRegistry, bindings: RegionBindings): NodeRegistry {
  const handlers = bindings.handlerOverrides ?? {};
  const impls = bindings.implOverrides ?? {};
  return {
    ids: () => inner.ids(),
    register: (impl) => {
      inner.register(impl);
    },
    get(id) {
      const base = inner.get(id);
      if (base === undefined) return undefined;
      const reshaped = Object.prototype.hasOwnProperty.call(impls, id) ? impls[id](base) : base;
      if (!Object.prototype.hasOwnProperty.call(handlers, id)) return reshaped;
      return { ...reshaped, handler: handlers[id] };
    },
  };
}

// ── Region registries ───────────────────────────────────────────────

function regionNodeRegistry(
  spec: TopologySpec,
  region: RegionId,
  bindings: RegionBindings,
): NodeRegistry {
  const registry = createNodeRegistry();
  if (region === RESEARCH_REGION) registerResearchNodes(registry, spec);
  else if (region === PLAN_REGION) registerPlanNodes(registry, spec);
  else if (region === SPRINT_REGION) registerSprintNodes(registry, spec, requireRuntime(bindings));
  else registerTerminalNodes(registry, spec);

  // Every region except the terminal one keeps the supervisor: its exit edge targets it.
  // Every region keeps the failure terminal, because every boundary gate's `gate.onFail`
  // names it — including `gate_sprint_out`'s and `hitl_commit`'s.
  if (region !== TERMINAL_REGION) registry.register(supervisorNode({ spec }));
  registry.register(gracefulFailureNode({ spec }));
  return overriding(registry, bindings);
}

/**
 * The sprint region's sixteen implementations, registered against the projected artifact.
 *
 * `runtime` is threaded rather than reached for: {@link NodeContext} carries no sandbox, and
 * the trace and scratch interfaces it DOES carry are narrower than the ones
 * `SandboxRunner.run` takes (see `../nodes/verification.ts`). Supplying it here is what keeps
 * every process the sprint region spawns inside one policy, one allowlist and one trace.
 */
export function registerSprintNodes(
  registry: NodeRegistry,
  spec: TopologySpec,
  runtime: SprintRuntime,
): void {
  registry.register(fanoutSprintsNode(spec));
  registry.register(sprintBodyNode(spec));
  registry.register(sprintEntryGate(spec));
  registry.register(sprintCurateExplainNode(spec));
  registry.register(sprintCurateMocksNode(spec));
  registry.register(mockCoverageGate(spec));
  registry.register(sprintGenerateNode(spec));
  registry.register(syntaxGate({ spec, runtime }));
  registry.register(sprintSecurityNode(spec));
  registry.register(sprintEvaluateNode({ spec, runtime }));
  registry.register(anchorRegressionGate({ spec, runtime }));
  registry.register(sprintRouter(spec));
  registry.register(sprintCorrectNode(spec));
  registry.register(sprintReviewNode(spec));
  registry.register(sprintExitNode(spec));
  registry.register(sprintExitGate(spec));
  registry.register(reduceSprintsGate(spec));
}

/** The terminal region: document, ask, commit. */
export function registerTerminalNodes(registry: NodeRegistry, spec: TopologySpec): void {
  registry.register(documenterNode(spec));
  registry.register(hitlCommitNode(spec));
  registry.register(commitNode(spec));
}

function requireRuntime(bindings: RegionBindings): SprintRuntime {
  if (bindings.runtime === undefined) {
    throw new Error(
      "The sprint region needs a SprintRuntime (sandbox, scratch, trace): NodeContext carries no sandbox and its trace/scratch interfaces are narrower than SandboxRunner.run accepts.",
    );
  }
  return bindings.runtime;
}

/**
 * The registries the RESEARCH region compiles against.
 *
 * `spec` is the projected region, not the whole artifact: `compile()` is all-or-nothing
 * over `spec.nodes` in BOTH directions, so half a registry against the whole artifact is
 * `UnregisteredNodeImpl` for every sprint-12 node plus `OrphanNodeImpl` for nothing at all.
 * See `../nodes/regions.ts` for how a region becomes its own `TopologySpec`.
 */
export function researchRegistries(spec: TopologySpec, bindings: RegionBindings): Registries {
  return {
    nodes: regionNodeRegistry(spec, RESEARCH_REGION, bindings),
    reducers: createReducerRegistry(),
    effects: createResearchEffectRegistry(bindings),
    schemas: codingSchemaCatalog(),
  };
}

/** The registries the PLAN region compiles against. */
export function planRegistries(spec: TopologySpec, bindings: RegionBindings): Registries {
  return {
    nodes: regionNodeRegistry(spec, PLAN_REGION, bindings),
    reducers: createReducerRegistry(),
    effects: createPlanEffectRegistry(bindings),
    schemas: codingSchemaCatalog(),
  };
}

/**
 * The registries the SPRINT region compiles against.
 *
 * `explain` and `mocks` are required by {@link SprintBindings} because nothing in this
 * repository produces either — see `../nodes/effects.ts`. A composition that omits them is a
 * type error rather than a silent stub.
 */
export function sprintRegistries(spec: TopologySpec, bindings: RegionBindings): Registries {
  if (bindings.explain === undefined || bindings.mocks === undefined) {
    throw new Error(
      "The sprint region needs `explain` and `mocks` bindings: no shipped function produces per-test explanations or a mock manifest, and stubbing them silently would fabricate the evidence sc-12-1 and sc-12-2 are about.",
    );
  }
  return {
    nodes: regionNodeRegistry(spec, SPRINT_REGION, bindings),
    reducers: createReducerRegistry(),
    effects: createSprintEffectRegistry({
      ...bindings,
      explain: bindings.explain,
      mocks: bindings.mocks,
    }),
    schemas: codingSchemaCatalog(),
  };
}

/** The registries the TERMINAL region (documenter, approval gate, commit) compiles against. */
export function terminalRegistries(spec: TopologySpec, bindings: RegionBindings): Registries {
  return {
    nodes: regionNodeRegistry(spec, TERMINAL_REGION, bindings),
    reducers: createReducerRegistry(),
    effects: createTerminalEffectRegistry(bindings),
    schemas: codingSchemaCatalog(),
  };
}
