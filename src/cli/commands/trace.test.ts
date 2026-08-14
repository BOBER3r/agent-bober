import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDefaultConfig } from "../../config/schema.js";
import type { BoberConfig } from "../../config/schema.js";
import type { NodeContext } from "../../pge/registry/nodes.js";
import { createFixedClock } from "../../pge/runtime/commit.js";
import { MissingRecordingError, createRecording } from "../../pge/runtime/replay.js";
import { createScratchStore } from "../../pge/runtime/scratch.js";
import { createTraceWriter } from "../../pge/runtime/trace.js";
import { CODING_GRAPH } from "../../pge/topology/coding.graph.js";
import { writeRunState } from "../../state/run-state.js";
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  registerTraceCommand,
  replayRegistriesFactory,
  runTraceReplay,
} from "./trace.js";
import type { TraceIo, TraceReplayDeps } from "./trace.js";

/**
 * `bober trace replay <runId>`.
 *
 * The verb is exercised through the exported function, so the exit code is a return value
 * and stdout/stderr are captured through the injected IO seam — the same shape
 * `pge.test.ts` uses.
 *
 * The re-execution itself is INJECTED here. What these tests own is the command: whether it
 * refuses to run without a trace, without a prompt or in place, what it does with a replay
 * that diverges or blows up, and what it prints. The end-to-end claim — that a recorded run
 * really does replay to byte-identical artifacts from its span file with the network stubbed
 * to throw — is `src/pge/runtime/replay.test.ts`, which runs the real interpreter. The
 * comparator underneath is the real one in both files; only the run is stubbed here.
 */

const RUN_ID = "run-cli-replay";
const PROMPT = "Add offline trace replay";

let tmpRoots: string[] = [];
let out: string[] = [];
let err: string[] = [];
let io: TraceIo;

beforeEach(() => {
  tmpRoots = [];
  out = [];
  err = [];
  io = { out: (line) => out.push(line), err: (line) => err.push(line) };
});

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

async function mkTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bober-trace-cli-"));
  tmpRoots.push(dir);
  return dir;
}

/** Write one real span so the run has a trace to be replayed from. */
async function writeTrace(projectRoot: string, runId: string): Promise<void> {
  const trace = await createTraceWriter(projectRoot, runId);
  trace.begin({ nodeId: "plan_draft", kind: "llm", phase: "planning", branchKey: null }).end({
    status: "ok",
  });
  await trace.close();
}

async function writeProgress(root: string, body: string): Promise<void> {
  await mkdir(join(root, ".bober"), { recursive: true });
  await writeFile(
    join(root, ".bober", "progress.md"),
    `# Progress\nLast updated: ${new Date().toISOString()}\n${body}\n`,
    "utf-8",
  );
}

function deps(overrides: Partial<TraceReplayDeps> = {}): TraceReplayDeps {
  return {
    loadConfig: (): Promise<BoberConfig> =>
      Promise.resolve(createDefaultConfig("trace-cli-fixture", "brownfield")),
    ...overrides,
  };
}

describe("bober trace replay — refusals", () => {
  it("refuses a run that recorded no trace", async () => {
    const root = await mkTmp();
    const code = await runTraceReplay(root, { runId: RUN_ID, prompt: PROMPT }, io, deps());
    expect(code).toBe(EXIT_USAGE);
    expect(err.join("\n")).toContain("No trace at");
  });

  it("refuses a run id that is not a safe path segment", async () => {
    const root = await mkTmp();
    const code = await runTraceReplay(root, { runId: "../escape", prompt: PROMPT }, io, deps());
    expect(code).toBe(EXIT_USAGE);
    expect(err.join("\n")).toContain("Cannot resolve a trace");
  });

  it("refuses when neither --prompt nor the recorded run state supplies one", async () => {
    const root = await mkTmp();
    await writeTrace(root, RUN_ID);
    const code = await runTraceReplay(root, { runId: RUN_ID }, io, deps());
    expect(code).toBe(EXIT_USAGE);
    expect(err.join("\n")).toContain("--prompt");
  });

  it("takes the prompt from the recorded run state when one exists", async () => {
    const root = await mkTmp();
    const replayRoot = await mkTmp();
    await writeTrace(root, RUN_ID);
    await writeRunState(root, {
      runId: RUN_ID,
      task: PROMPT,
      status: "completed",
      startedAt: new Date().toISOString(),
      progress: { completed: 1, total: 1 },
      projectRoot: root,
    });
    await writeProgress(root, "- recorded");

    let seenPrompt = "";
    const code = await runTraceReplay(
      root,
      { runId: RUN_ID, replayRoot },
      io,
      deps({
        // The replayed run reproduces both artifacts the recorded root holds. Reproducing
        // only one of them would be a real divergence, and the harness would say so.
        rerun: async (input, ctx) => {
          seenPrompt = ctx.prompt;
          await writeProgress(input.projectRoot, "- recorded");
          await writeRunState(input.projectRoot, {
            runId: input.runId,
            task: ctx.prompt,
            status: "completed",
            startedAt: new Date().toISOString(),
            progress: { completed: 1, total: 1 },
            projectRoot: input.projectRoot,
          });
        },
      }),
    );

    expect(seenPrompt).toBe(PROMPT);
    expect(code).toBe(EXIT_OK);
    expect(out.join("\n")).toContain("runState");
  });

  it("refuses to replay in place", async () => {
    const root = await mkTmp();
    await writeTrace(root, RUN_ID);
    const code = await runTraceReplay(
      root,
      { runId: RUN_ID, prompt: PROMPT, replayRoot: root },
      io,
      deps(),
    );
    expect(code).toBe(EXIT_USAGE);
    expect(err.join("\n")).toContain("must differ from the recorded root");
  });
});

describe("bober trace replay — outcomes", () => {
  it("exits 0 when the replayed artifacts match the recorded ones", async () => {
    const root = await mkTmp();
    const replayRoot = await mkTmp();
    await writeTrace(root, RUN_ID);
    await writeProgress(root, "- sprint 13 replayed");

    const code = await runTraceReplay(
      root,
      { runId: RUN_ID, prompt: PROMPT, replayRoot },
      io,
      // The recorded and replayed documents differ only on the volatile `Last updated:`
      // line, which is exactly what the harness's normalisation is there to strip.
      deps({ rerun: (input) => writeProgress(input.projectRoot, "- sprint 13 replayed") }),
    );

    expect(code).toBe(EXIT_OK);
    expect(out.join("\n")).toContain("identical");
    expect(out.join("\n")).toContain("progress");
  });

  it("exits 1 and names the artifact when the replay diverges", async () => {
    const root = await mkTmp();
    const replayRoot = await mkTmp();
    await writeTrace(root, RUN_ID);
    await writeProgress(root, "- sprint 13 replayed");

    const code = await runTraceReplay(
      root,
      { runId: RUN_ID, prompt: PROMPT, replayRoot },
      io,
      deps({ rerun: (input) => writeProgress(input.projectRoot, "- something else entirely") }),
    );

    expect(code).toBe(EXIT_FAILED);
    expect(err.join("\n")).toContain("diverged");
    expect(err.join("\n")).toContain(".bober/progress.md");
  });

  it("exits 1 and reports the error class when the re-execution throws", async () => {
    const root = await mkTmp();
    const replayRoot = await mkTmp();
    await writeTrace(root, RUN_ID);
    await writeProgress(root, "- recorded");

    class MissingRecordingErrorStandIn extends Error {
      constructor() {
        super("no recorded response for plan_draft");
        this.name = "MissingRecordingError";
      }
    }

    const code = await runTraceReplay(
      root,
      { runId: RUN_ID, prompt: PROMPT, replayRoot },
      io,
      deps({
        rerun: () => Promise.reject(new MissingRecordingErrorStandIn()),
      }),
    );

    expect(code).toBe(EXIT_FAILED);
    expect(err.join("\n")).toContain("MissingRecordingError");
    expect(err.join("\n")).toContain(replayRoot);
  });

  it("reports a comparison of nothing as a failure rather than a match", async () => {
    const root = await mkTmp();
    const replayRoot = await mkTmp();
    await writeTrace(root, RUN_ID);

    const code = await runTraceReplay(
      root,
      { runId: RUN_ID, prompt: PROMPT, replayRoot },
      io,
      // Neither side produced a single artifact.
      deps({ rerun: () => Promise.resolve() }),
    );

    expect(code).toBe(EXIT_FAILED);
    expect(err.join("\n")).toContain("vacuous");
  });

  it("prints the comparison as JSON under --json", async () => {
    const root = await mkTmp();
    const replayRoot = await mkTmp();
    await writeTrace(root, RUN_ID);
    await writeProgress(root, "- recorded");

    const code = await runTraceReplay(
      root,
      { runId: RUN_ID, prompt: PROMPT, replayRoot, json: true },
      io,
      deps({ rerun: (input) => writeProgress(input.projectRoot, "- recorded") }),
    );

    expect(code).toBe(EXIT_OK);
    const parsed = JSON.parse(out.join("\n")) as {
      runId: string;
      identical: boolean;
      divergences: unknown[];
      comparedFields: string[];
    };
    expect(parsed.runId).toBe(RUN_ID);
    expect(parsed.identical).toBe(true);
    expect(parsed.divergences).toEqual([]);
    expect(parsed.comparedFields).toContain("progress");
  });
});

describe("the default re-execution", () => {
  it("composes production registries whose effect channel answers from the recording", async () => {
    const root = await mkTmp();
    const trace = await createTraceWriter(root, RUN_ID);
    try {
      const registries = await replayRegistriesFactory(createRecording(RUN_ID, []))({
        spec: CODING_GRAPH,
        projectRoot: root,
        runId: RUN_ID,
        config: createDefaultConfig("trace-cli-fixture", "brownfield"),
        clock: createFixedClock("2026-08-06T00:00:00.000Z"),
        trace,
        scratch: createScratchStore(root),
      });

      const effects = registries.effects;
      expect(effects).toBeDefined();
      const declarations = effects?.list() ?? [];
      expect(declarations.length).toBeGreaterThan(0);

      // Every shipped effect is answered from the recording, so an empty recording refuses
      // the first one rather than performing it.
      const first = declarations[0];
      const ctx = {
        nodeId: "research_reflect",
        branchKey: null,
        declaredEffects: first.effects,
      } as unknown as NodeContext;
      await expect(effects?.invoke(first.name, {}, ctx)).rejects.toBeInstanceOf(
        MissingRecordingError,
      );
    } finally {
      await trace.close();
    }
  });
});

describe("commander wiring", () => {
  it("registers `trace replay` with its options", () => {
    const program = new Command();
    registerTraceCommand(program);

    const trace = program.commands.find((c) => c.name() === "trace");
    expect(trace).toBeDefined();

    const replay = trace?.commands.find((c) => c.name() === "replay");
    expect(replay).toBeDefined();
    const flags = replay?.options.map((o) => o.long) ?? [];
    expect(flags).toEqual(expect.arrayContaining(["--prompt", "--replay-root", "--graph", "--json"]));
  });
});
