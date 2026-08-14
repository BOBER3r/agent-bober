import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";

import { loadConfig } from "../../config/loader.js";
import type { BoberConfig } from "../../config/schema.js";
import type { PipelineResult } from "../../orchestrator/pipeline.js";
import { createEffectRegistry } from "../../pge/registry/effects.js";
import type { PgeRegistriesFactory, PgeRegistriesInput } from "../../pge/engine/pge-engine.js";
import {
  createRefusingSandbox,
  createReplayEffectRegistry,
  prepareReplayRoot,
  replayRecordedRun,
} from "../../pge/runtime/replay.js";
import type { Recording, ReplayOutcome, ReplayRerunInput } from "../../pge/runtime/replay.js";
import { readSpans, tracePath } from "../../pge/runtime/trace.js";
import { CODING_GRAPH_ID } from "../../pge/topology/coding.graph.js";
import { readRunState } from "../../state/run-state.js";
import { findProjectRoot } from "../../utils/fs.js";

/**
 * `bober trace replay <runId>` — re-execute a recorded run offline.
 *
 * The run is re-executed from `.bober/traces/<runId>.jsonl`: every outward call is answered
 * from the responses recorded on that run's spans, `fetch` is replaced by a stub that
 * THROWS and the sandbox is replaced by a runner that refuses to spawn. The replayed run
 * writes into a SEPARATE root, and its artifacts are then compared with the recorded ones
 * through the same `EngineConformanceHarness` the ts-versus-pge conformance gate uses —
 * same normalisation, same volatile-key stripping, same order-tolerant structured diff.
 *
 * What that regression-tests is the RUNTIME and the ARTIFACT SHAPE. It is not a judgement
 * about the run: the recorded model answers are replayed verbatim, so a replay of a bad
 * plan reproduces the bad plan exactly and reports success.
 *
 * Exit codes follow `bober pge`: 0 the artifacts matched, 1 they diverged or the replay
 * could not complete, 2 the command could not run at all. Nothing here calls
 * `process.exit`; every verb returns a code and the Commander action assigns it.
 */

// ── Exit codes ──────────────────────────────────────────────────────

/** The replayed artifacts matched the recorded ones. */
export const EXIT_OK = 0;
/** They diverged, or the replay stopped — a missing recording, a failed re-execution. */
export const EXIT_FAILED = 1;
/** The command could not run: no trace, no prompt, no config, unparseable trace. */
export const EXIT_USAGE = 2;

// ── IO seam ─────────────────────────────────────────────────────────

export interface TraceIo {
  out(line: string): void;
  err(line: string): void;
}

export function processIo(): TraceIo {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}

// ── replay ──────────────────────────────────────────────────────────

export interface TraceReplayOptions {
  runId: string;
  /**
   * The feature request the recorded run was started with.
   *
   * Defaults to `RunState.task` for that run. A replay cannot invent it: the prompt is an
   * INPUT to the graph, and re-running with a different one would compare two different
   * runs and report the difference as a divergence.
   */
  prompt?: string;
  /** Where the replayed run writes. Defaults to a fresh temp directory, which is printed. */
  replayRoot?: string;
  graphId?: string;
  json?: boolean;
}

/** What the default re-execution needs beyond the replay itself. */
export interface TraceReplayContext {
  readonly prompt: string;
  readonly config: BoberConfig;
  readonly graphId: string;
}

export interface TraceReplayDeps {
  /** Re-executes the run. Default {@link pgeReplayRerun}. */
  rerun?: (input: ReplayRerunInput, ctx: TraceReplayContext) => Promise<PipelineResult | void>;
  /** Default {@link loadConfig}. */
  loadConfig?: (projectRoot: string) => Promise<BoberConfig>;
  /** Default: a fresh `os.tmpdir()` directory. */
  makeReplayRoot?: (runId: string) => Promise<string>;
}

/**
 * The production registries, with the two doors to the outside world closed.
 *
 * The effect registry answers from the recording and throws on a miss, and the sandbox
 * throws instead of spawning — a replay that ran `npm test` or committed to git would be
 * performing the recorded run's side effects a second time, which is not a replay. Only
 * those two bindings change; every node implementation is the shipped one.
 *
 * The node library is imported LAZILY for the reason `PgeEngine` gives about its own
 * registries factory: `src/pge/registry/index.ts` is the composition root of every shipped
 * agent, the security gate and the git primitive, and `bober --help` must not load it.
 */
export function replayRegistriesFactory(recording: Recording): PgeRegistriesFactory {
  return async (regInput: PgeRegistriesInput) => {
    const { productionRegionBindings } = await import("../../pge/engine/pge-engine.js");
    const { codingRegistries } = await import("../../pge/registry/index.js");

    const bindings = await productionRegionBindings(regInput);
    const registries = codingRegistries(regInput.spec, {
      ...bindings,
      runtime: { ...bindings.runtime, sandbox: createRefusingSandbox() },
    });
    return {
      ...registries,
      effects: createReplayEffectRegistry(
        registries.effects ?? createEffectRegistry(),
        recording,
      ),
    };
  };
}

/**
 * Re-execute the recorded run with the shipped PGE engine.
 *
 * The engine is the one `selectPipelineEngine` returns — no test-only subclass and no
 * parallel driver — constructed with the replay registries above. The run id is the
 * RECORDED one: a replay is the same run executed again, and the recording is keyed by the
 * node positions that run produced.
 */
export async function pgeReplayRerun(
  input: ReplayRerunInput,
  ctx: TraceReplayContext,
): Promise<PipelineResult> {
  const { PgeEngine } = await import("../../pge/engine/pge-engine.js");
  const engine = new PgeEngine({
    graphId: ctx.graphId,
    registries: replayRegistriesFactory(input.recording),
  });
  return engine.run(ctx.prompt, input.projectRoot, ctx.config, { runId: input.runId });
}

function defaultReplayRoot(runId: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `bober-replay-${runId}-`));
}

/** Render an outcome for a human. `--json` prints the same facts as one object. */
function report(outcome: ReplayOutcome, io: TraceIo, json: boolean): void {
  if (json) {
    io.out(
      JSON.stringify(
        {
          runId: outcome.runId,
          identical: outcome.identical,
          recordedCalls: outcome.recordedCalls,
          replayRoot: outcome.replayRoot,
          comparedFields: outcome.comparedFields,
          emptyFields: outcome.emptyFields,
          divergences: outcome.divergences,
          vacuous: outcome.report.vacuous,
        },
        null,
        2,
      ),
    );
    return;
  }

  io.out(`replayed ${outcome.runId} into ${outcome.replayRoot}`);
  io.out(`recorded calls: ${String(outcome.recordedCalls)}`);
  io.out(
    `compared fields: ${outcome.comparedFields.length === 0 ? "(none)" : outcome.comparedFields.join(", ")}`,
  );
  if (outcome.emptyFields.length > 0) {
    io.out(`empty on both sides: ${outcome.emptyFields.join(", ")}`);
  }

  if (outcome.identical) {
    io.out("identical: the replayed artifacts match the recorded ones after volatile stripping");
    return;
  }

  if (outcome.report.vacuous) {
    io.err(
      "vacuous: neither the recorded run nor the replay produced a single comparable artifact, so nothing was proven",
    );
    return;
  }

  io.err(`diverged: ${String(outcome.divergences.length)} artifact difference(s)`);
  for (const divergence of outcome.divergences) {
    io.err(`  ${divergence.artifact} ${divergence.path}: ${divergence.detail ?? "differs"}`);
  }
}

export async function runTraceReplay(
  projectRoot: string,
  opts: TraceReplayOptions,
  io: TraceIo,
  deps: TraceReplayDeps = {},
): Promise<number> {
  // ── The trace has to exist and to parse ──
  let path: string;
  try {
    path = tracePath(projectRoot, opts.runId);
  } catch (error) {
    io.err(`Cannot resolve a trace for run id "${opts.runId}": ${String(error)}`);
    return EXIT_USAGE;
  }

  try {
    const spans = await readSpans(path);
    if (spans.length === 0) {
      io.err(`No trace at ${path}. A run can only be replayed from the spans it recorded.`);
      return EXIT_USAGE;
    }
  } catch (error) {
    io.err(`Trace ${path} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_USAGE;
  }

  // ── The prompt is an input, and is never invented ──
  const recordedState = await readRunState(projectRoot, opts.runId);
  const prompt = opts.prompt ?? recordedState?.task;
  if (prompt === undefined || prompt.trim().length === 0) {
    io.err(
      `Run ${opts.runId} has no recorded prompt (.bober/runs/${opts.runId}/state.json). Pass --prompt with the request the run was started from.`,
    );
    return EXIT_USAGE;
  }

  // ── Config ──
  let config: BoberConfig;
  try {
    config = await (deps.loadConfig ?? loadConfig)(projectRoot);
  } catch (error) {
    io.err(`Cannot load the project config: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_USAGE;
  }

  const replayRoot =
    opts.replayRoot ?? (await (deps.makeReplayRoot ?? defaultReplayRoot)(opts.runId));
  if (replayRoot === projectRoot) {
    io.err(
      "The replay root must differ from the recorded root; replaying in place would compare the recorded artifacts with themselves.",
    );
    return EXIT_USAGE;
  }
  await prepareReplayRoot(projectRoot, replayRoot);

  const ctx: TraceReplayContext = {
    prompt,
    config,
    graphId: opts.graphId ?? CODING_GRAPH_ID,
  };
  const rerun = deps.rerun ?? pgeReplayRerun;

  let outcome: ReplayOutcome;
  try {
    outcome = await replayRecordedRun({
      recordedRoot: projectRoot,
      replayRoot,
      runId: opts.runId,
      rerun: (input) => rerun(input, ctx),
    });
  } catch (error) {
    // A missing recording lands here, and it is a FAILURE rather than a usage error: the
    // command ran, the replay diverged from the recording, and that is the finding.
    io.err(`Replay of ${opts.runId} did not complete: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    io.err(`The replay root ${replayRoot} is left in place for inspection.`);
    return EXIT_FAILED;
  }

  report(outcome, io, opts.json === true);
  return outcome.identical ? EXIT_OK : EXIT_FAILED;
}

// ── Commander wiring ────────────────────────────────────────────────

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

/** Register the `trace` subcommand on the root program. */
export function registerTraceCommand(program: Command): void {
  const trace = program
    .command("trace")
    .description("Graph run traces (.bober/traces/) — offline replay of a recorded run");

  trace
    .command("replay <runId>")
    .description("Re-execute a recorded run offline and compare its artifacts with the recorded ones")
    .option("--prompt <text>", "The request the recorded run was started from")
    .option("--replay-root <dir>", "Where the replayed run writes (default: a temp directory)")
    .option("--graph <id>", "Graph id the run executed", CODING_GRAPH_ID)
    .option("--json", "Print the comparison as JSON")
    .action(
      async (
        runId: string,
        cmdOpts: { prompt?: string; replayRoot?: string; graph?: string; json?: boolean },
      ) => {
        const io = processIo();
        process.exitCode = await runTraceReplay(
          await resolveRoot(),
          {
            runId,
            ...(cmdOpts.prompt === undefined ? {} : { prompt: cmdOpts.prompt }),
            ...(cmdOpts.replayRoot === undefined ? {} : { replayRoot: cmdOpts.replayRoot }),
            ...(cmdOpts.graph === undefined ? {} : { graphId: cmdOpts.graph }),
            ...(cmdOpts.json === undefined ? {} : { json: cmdOpts.json }),
          },
          io,
        );
      },
    );
}
