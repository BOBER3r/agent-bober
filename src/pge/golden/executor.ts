// ── The golden executor — the runtime half of the blocking CI gate ──

import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { BoberConfig } from "../../config/schema.js";
import { createDefaultConfig } from "../../config/schema.js";
import type { TopologySpec } from "../../contracts/topology.js";
import { collectRunArtifacts } from "../../orchestrator/workflow/conformance.js";
import { CONFORMANCE_FIELDS } from "../../orchestrator/workflow/types.js";
import type { ConformanceField } from "../../orchestrator/workflow/types.js";
import { PgeEngine, readValidatedTopologySpec } from "../engine/pge-engine.js";
import type { PgeRegistriesInput } from "../engine/pge-engine.js";
import { createEffectRegistry } from "../registry/effects.js";
import type { CodingBindings } from "../registry/index.js";
import { createRecording, createReplayEffectRegistry, withNetworkDisabled } from "../runtime/replay.js";
import type { SandboxOutcome, SandboxRunner } from "../runtime/sandbox.js";
import type { ScratchStore } from "../runtime/scratch.js";
import { CODING_GRAPH_ID } from "../topology/coding.graph.js";
import { topologyArtifactPath } from "../topology/dump.js";
import { isReplayCase } from "./case-schema.js";
import type { GoldenCase } from "./case-schema.js";
import type { GoldenExecutor, GoldenRunArtifacts } from "./runner.js";

/**
 * Runs one `replay`-enforced golden case against the REAL engine and hands back the
 * artifacts the run left behind.
 *
 * This module is what `scripts/run-golden-regression.mjs` loads as
 * `dist/pge/golden/executor.js`, and its existence is what makes the pass-rate half of the
 * blocking CI job live rather than announced. Everything it does is the shipped code path:
 *
 *  - the engine is `new PgeEngine(...)` — the object `selectPipelineEngine` returns, not a
 *    test double and not a private interpreter wiring;
 *  - the graph is the COMMITTED `.bober/topology/coding.json`, copied into a throwaway root
 *    so a golden run can never write into the repository;
 *  - the reducers, the commit boundary, the trace writer, the scratch store, the ledger and
 *    all forty-four node bodies are the shipped ones;
 *  - the artifacts are read back through {@link collectRunArtifacts}, the SAME collection
 *    `EngineConformanceHarness` uses, so "identical" means one thing in this repository.
 *
 * ── The only substitution is the effect seam, and it answers from the case ──
 *
 * `createReplayEffectRegistry` answers every outward call from the case's `pinnedResponses`
 * and THROWS {@link MissingRecordingError} for anything else. It never falls through to a
 * real effect, so a golden run performs zero provider calls, zero git commands and zero
 * writes outside its own root. Two further doors are shut for the same reason:
 * `withNetworkDisabled` installs a `fetch` that throws, and every collaborator binding is
 * bound to a function that throws — see {@link goldenBindings}. Those throwers are a
 * PROOF, not a fallback: a replay that reached one would mean the effect registry had been
 * bypassed, and it fails the case loudly instead of quietly answering from a live agent.
 *
 * ── What a green case is evidence of ──
 *
 * The runtime and the artifact shape, and nothing else — the same limit `runner.ts` and
 * `case-schema.ts` state. Same pinned answers in, same `.bober/` artifacts out. It says
 * nothing about whether those answers were any good.
 *
 * ── What it deliberately cannot do yet ──
 *
 * Start anywhere but the graph's own entry, seed channels, or take config overrides. Each
 * of those is REFUSED with a typed error rather than ignored: a case whose declared input
 * was silently dropped would be compared against an expectation for a run that never
 * happened. That refusal is what confines `replay` enforcement to cases `capture.ts`
 * produced, and it is why the hand-authored cases declare `enforcement: "integrity"`.
 */

// ── Errors ──────────────────────────────────────────────────────────

/** A case declared input this executor cannot honour. Refused, never ignored. */
export class UnsupportedGoldenInputError extends Error {
  constructor(
    readonly caseId: string,
    detail: string,
  ) {
    super(
      `Golden case "${caseId}" cannot be executed: ${detail}. ` +
        `An input this executor ignored would make the comparison a comparison of some other run.`,
    );
    this.name = "UnsupportedGoldenInputError";
  }
}

/** A collaborator binding was invoked during a replay, which means an effect escaped. */
export class GoldenBindingInvokedError extends Error {
  constructor(readonly binding: string) {
    super(
      `The golden executor's "${binding}" binding was invoked. A replay answers every outward ` +
        `call from the case's pinned responses, so reaching a binding means the replay effect ` +
        `registry was bypassed and the run is no longer offline.`,
    );
    this.name = "GoldenBindingInvokedError";
  }
}

// ── The run id and the config ───────────────────────────────────────

/**
 * The run id every golden run uses.
 *
 * Fixed rather than generated: `runId` is one of the conformance normaliser's volatile
 * keys, so it never reaches an expectation — but a fixed one keeps a failing case's trace
 * and scratch paths predictable for whoever has to read them.
 */
export const GOLDEN_RUN_ID = "golden";

/**
 * The config every golden run is executed under.
 *
 * Built from {@link createDefaultConfig} and pinned here rather than read from the
 * repository's own `bober.config.json`: a golden case must produce the same artifacts on a
 * contributor's machine and on a CI runner, and a config the checkout happens to carry is
 * neither. `pipeline.engine` is left at its default — this executor constructs `PgeEngine`
 * directly, so nothing about the golden gate depends on, or changes, which engine a real
 * run selects.
 *
 * The two iteration ceilings are the ones the conformance fixture pins, for the same
 * reason it pins them: they bound how many times a loop can go round, which is what keeps
 * one golden run short enough to sit inside a CI step.
 */
export function goldenConfig(): BoberConfig {
  const base = createDefaultConfig("golden", "brownfield");
  return {
    ...base,
    pipeline: { ...base.pipeline, researchPhase: false, maxIterations: 2 },
    evaluator: { ...base.evaluator, maxIterations: 1 },
  };
}

// ── The sandbox ─────────────────────────────────────────────────────

/**
 * The sandbox a golden run is given: it spawns NOTHING and reports success.
 *
 * The sprint region's three verification nodes (`gate_syntax`, `sprint_evaluate`,
 * `gate_anchor_regression`) reach a process through `SprintRuntime.sandbox`, which is not
 * an effect and therefore not answered by the recording. A real spawn would run this
 * repository's own test suite inside a temp directory that has no `package.json`, and its
 * result is the one collaborator that genuinely varies between two invocations.
 *
 * So the outcome is FIXED, and — this is what makes it sound rather than a fabrication —
 * it is the same fixed outcome at CAPTURE time and at REPLAY time. `capture.ts` uses this
 * exact function. The pair is therefore comparing two runs given the same inputs, which is
 * the only claim a golden case makes.
 */
export function goldenSandbox(scratch: ScratchStore, runId: string): SandboxRunner {
  return {
    async run(): Promise<SandboxOutcome> {
      return {
        status: "ok",
        exitCode: 0,
        stdoutRef: await scratch.put(runId, "stdout", ""),
        stderrRef: await scratch.put(runId, "stderr", ""),
      };
    },
  };
}

// ── The bindings ────────────────────────────────────────────────────

function refuse(binding: string): () => never {
  return () => {
    throw new GoldenBindingInvokedError(binding);
  };
}

/**
 * Every collaborator bound to a thrower, and the runtime bound for real.
 *
 * A replay never invokes a binding — `createReplayEffectRegistry` answers from the
 * recording and never calls `inner.invoke` — so these are an ASSERTION rather than a stub
 * set: if the effect boundary is ever bypassed, the run fails with a named binding instead
 * of quietly calling a shipped agent, which is the difference between a golden gate and a
 * live pipeline run against a provider.
 */
export function goldenBindings(input: PgeRegistriesInput): CodingBindings {
  return {
    runtime: {
      sandbox: goldenSandbox(input.scratch, input.runId),
      scratch: input.scratch,
      trace: input.trace,
    },
    reflect: refuse("reflect"),
    critique: refuse("critique"),
    research: refuse("research"),
    writeResearch: refuse("writeResearch"),
    listResearch: refuse("listResearch"),
    planner: refuse("planner"),
    materialize: refuse("materialize"),
    curator: refuse("curator"),
    explain: refuse("explain"),
    mocks: refuse("mocks"),
    generator: refuse("generator"),
    security: refuse("security"),
    evaluator: refuse("evaluator"),
    reviewer: refuse("reviewer"),
    writeContract: refuse("writeContract"),
    documenter: refuse("documenter"),
    committer: refuse("committer"),
    writeFailure: refuse("writeFailure"),
  };
}

// ── Seeding a run root ──────────────────────────────────────────────

/**
 * Copy the committed artifact and a prompt for every `promptRef` it declares.
 *
 * The prompt files are SYNTHESISED when the source checkout has none, and that is sound
 * for one specific reason: an `llm` node reaches its model through an effect, which a
 * replay answers from the recording, so the prompt TEXT never reaches anything the
 * comparison looks at. What the text's absence would do is kill the first `llm` node on
 * `UnknownPromptRefError` — a fact about the checkout's prompt store rather than about the
 * runtime. A real `.bober/prompts/` tree, when one exists, is copied and wins.
 */
export async function seedGoldenRoot(
  sourceRoot: string,
  runRoot: string,
  graphId: string = CODING_GRAPH_ID,
): Promise<TopologySpec> {
  const artifact = topologyArtifactPath(runRoot, graphId);
  await mkdir(dirname(artifact), { recursive: true });
  await cp(topologyArtifactPath(sourceRoot, graphId), artifact);

  const promptsDir = join(runRoot, ".bober", "prompts");
  await mkdir(promptsDir, { recursive: true });
  try {
    await cp(join(sourceRoot, ".bober", "prompts"), promptsDir, { recursive: true, force: true });
  } catch {
    // The checkout ships none; every ref is synthesised below.
  }

  const spec = await readValidatedTopologySpec(runRoot, graphId);
  for (const node of spec.nodes) {
    if (node.promptRef === undefined) continue;
    const path = join(promptsDir, `${node.promptRef}.md`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `# ${node.promptRef}\n\nGolden replay prompt for ${node.promptRef}.\n`, {
      flag: "wx",
    }).catch(() => {
      // Already there — a real prompt store's file, which must not be overwritten.
    });
  }
  return spec;
}

// ── The executor ────────────────────────────────────────────────────

export interface GoldenExecutorOptions {
  /** The checkout the committed artifact (and any prompt store) is read FROM. */
  readonly projectRoot: string;
  /** Default {@link CODING_GRAPH_ID}. */
  readonly graphId?: string;
  /** Where throwaway run roots are created. Default the OS temp directory. */
  readonly runRootParent?: string;
  /** Leave the run roots on disk for inspection. Default false. */
  readonly keepRunRoots?: boolean;
}

/**
 * Refuse a case whose declared input this executor cannot reproduce.
 *
 * Called BEFORE any run, so an unsupported case fails with a message naming what it asked
 * for rather than with an artifact diff nobody can interpret.
 */
export function assertExecutable(goldenCase: GoldenCase, spec: TopologySpec): void {
  if (!isReplayCase(goldenCase)) {
    throw new UnsupportedGoldenInputError(
      goldenCase.caseId,
      `it declares enforcement "${goldenCase.enforcement}", and only "replay" cases are executed`,
    );
  }
  if (goldenCase.input.entryNodeId !== spec.entry) {
    throw new UnsupportedGoldenInputError(
      goldenCase.caseId,
      `it starts at "${goldenCase.input.entryNodeId}" and this executor runs the graph from its own entry "${spec.entry}"`,
    );
  }
  if (goldenCase.input.seed !== undefined) {
    throw new UnsupportedGoldenInputError(
      goldenCase.caseId,
      "it seeds channel values, and this executor starts every run from the empty initial state",
    );
  }
  if (goldenCase.input.config !== undefined) {
    throw new UnsupportedGoldenInputError(
      goldenCase.caseId,
      `it overrides config keys (${Object.keys(goldenCase.input.config).sort().join(", ")}), and this executor pins one config for every golden run`,
    );
  }
  if (goldenCase.graph.graphId !== spec.graphId) {
    throw new UnsupportedGoldenInputError(
      goldenCase.caseId,
      `it names graph "${goldenCase.graph.graphId}" and the committed artifact is "${spec.graphId}"`,
    );
  }
}

/** Only the eleven conformance fields, in sorted key order. */
function asRunArtifacts(collected: Record<ConformanceField, unknown[]>): GoldenRunArtifacts {
  const out: Partial<Record<ConformanceField, readonly unknown[]>> = {};
  for (const field of [...CONFORMANCE_FIELDS].sort()) out[field] = collected[field];
  return out;
}

/**
 * Build the executor the golden gate runs its `replay` cases through.
 *
 * A FACTORY because `scripts/run-golden-regression.mjs` calls `createGoldenExecutor` with
 * the repository root once and then hands the result to the gate per case — and because
 * the spec is read once here rather than per case, so a broken artifact fails before any
 * run rather than twenty-odd times.
 */
export async function createGoldenExecutor(
  options: GoldenExecutorOptions,
): Promise<GoldenExecutor> {
  const graphId = options.graphId ?? CODING_GRAPH_ID;
  const spec = await readValidatedTopologySpec(options.projectRoot, graphId);
  const parent = options.runRootParent ?? tmpdir();

  return async (goldenCase: GoldenCase): Promise<GoldenRunArtifacts> => {
    assertExecutable(goldenCase, spec);

    const runRoot = await mkdtemp(join(parent, `golden-${goldenCase.caseId.slice(0, 32)}-`));
    try {
      await seedGoldenRoot(options.projectRoot, runRoot, graphId);
      const recording = createRecording(GOLDEN_RUN_ID, goldenCase.pinnedResponses);

      const result = await withNetworkDisabled(() =>
        new PgeEngine({
          graphId,
          registries: async (input) => {
            // Imported here for the reason `PgeEngine` gives: this barrel is the
            // composition root of the whole node library, and nothing that merely loads
            // the golden module should pull it.
            const { codingRegistries } = await import("../registry/index.js");
            const registries = codingRegistries(input.spec, goldenBindings(input));
            return {
              ...registries,
              effects: createReplayEffectRegistry(
                registries.effects ?? createEffectRegistry(),
                recording,
              ),
            };
          },
        }).run(goldenCase.input.featureRequest, runRoot, goldenConfig(), {
          runId: GOLDEN_RUN_ID,
        }),
      );

      return asRunArtifacts(await collectRunArtifacts(runRoot, result));
    } finally {
      if (options.keepRunRoots !== true) await rm(runRoot, { recursive: true, force: true });
    }
  };
}
