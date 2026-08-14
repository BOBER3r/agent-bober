import { writeFile } from "node:fs/promises";

import { createFsCheckpointer } from "../checkpointer.js";
import type { Checkpoint, CheckpointRef, GraphCheckpointer } from "../checkpointer.js";
import { goldenContracts } from "./golden-graph.js";
import { runGolden } from "./run-harness.js";
import type { HandlerCallLog } from "./run-harness.js";

/**
 * The CHILD PROCESS of the cross-process resume invariant.
 *
 * This file exists because an in-process simulation of a crash proves nothing about the
 * decision ADR-5 actually made. `MemorySaver` passes any same-process test — the state is
 * still sitting in the heap — so a test that never leaves the process cannot tell the
 * filesystem checkpointer apart from the design it replaced. The only way to make the
 * criterion mean something is to genuinely lose the heap, which is what `SIGKILL` here
 * does: no `finally`, no flush, no unwind. Whatever survives is on disk or is gone.
 *
 * Three modes, one script, so all three runs execute IDENTICAL code:
 *
 *   full  — run the golden graph to completion. The control artifact.
 *   part1 — run it and SIGKILL this process the moment the checkpoint for `--killAfter`
 *           lands on disk. Writes its handler counts before dying, because after the
 *           signal nothing runs.
 *   part2 — resume from `latest(runId)` in a process that shares nothing with part1.
 *
 * Each mode writes `{ handlerCalls, ... }` to `--out`, and the parent compares them.
 */

// ── Arguments ───────────────────────────────────────────────────────

export interface ChildArgs {
  mode: "full" | "part1" | "part2";
  root: string;
  runId: string;
  out: string;
  killAfter: number;
  contracts: number;
}

export function parseChildArgs(argv: readonly string[]): ChildArgs {
  const values = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([a-zA-Z]+)=(.*)$/.exec(arg);
    if (match) values.set(match[1], match[2]);
  }
  const mode = values.get("mode");
  if (mode !== "full" && mode !== "part1" && mode !== "part2") {
    throw new Error(`resume-child: --mode must be full|part1|part2, got ${String(mode)}`);
  }
  return {
    mode,
    root: values.get("root") ?? "",
    runId: values.get("runId") ?? "run-resume",
    out: values.get("out") ?? "",
    killAfter: Number(values.get("killAfter") ?? "2"),
    contracts: Number(values.get("contracts") ?? "2"),
  };
}

/** What the parent reads back out of each child. */
export interface ChildReport {
  mode: ChildArgs["mode"];
  /** Node id -> handler bodies ENTERED in THIS process. */
  handlerCalls: Record<string, number>;
  status: string;
  supersteps: number;
  verdict?: string;
  /** The superstep the resumed process started at, so "it restarted from 0" is visible. */
  resumedAt?: number;
}

// ── Body ────────────────────────────────────────────────────────────

export async function runChild(args: ChildArgs): Promise<void> {
  const behaviour = { contracts: goldenContracts(args.contracts) };
  const inner = createFsCheckpointer(args.root);
  let handlerLog: HandlerCallLog = { calls: {} };

  /**
   * The checkpointer that kills the process.
   *
   * The kill happens AFTER `put` resolves, so the checkpoint is durably on disk and the
   * scenario under test is "the process died between supersteps" rather than "the process
   * died mid-write" — that second one is the checkpointer conformance suite's job.
   */
  const killing: GraphCheckpointer = {
    async put(cp: Checkpoint): Promise<CheckpointRef> {
      const ref = await inner.put(cp);
      if (args.mode === "part1" && cp.superstep >= args.killAfter) {
        await writeFile(
          args.out,
          JSON.stringify({
            mode: args.mode,
            handlerCalls: handlerLog.calls,
            status: "killed",
            supersteps: cp.superstep + 1,
          } satisfies ChildReport),
          "utf8",
        );
        // Unhandleable and immediate. Anything still in memory is lost, which is the point.
        process.kill(process.pid, "SIGKILL");
      }
      return ref;
    },
    get: (ref) => inner.get(ref),
    latest: (runId) => inner.latest(runId),
    list: (runId) => inner.list(runId),
    prune: (runId, keep) => inner.prune(runId, keep),
  };

  let resumedAt: number | undefined;
  let resumeFrom: { ref: CheckpointRef; value?: unknown } | undefined;
  if (args.mode === "part2") {
    const checkpoint = await inner.latest(args.runId);
    if (checkpoint === undefined) {
      throw new Error(`resume-child: no checkpoint to resume for run "${args.runId}"`);
    }
    resumedAt = checkpoint.nextSuperstep;
    resumeFrom = { ref: { runId: args.runId, superstep: checkpoint.superstep } };
  }

  const run = await runGolden({
    projectRoot: args.root,
    runId: args.runId,
    behaviour,
    finalize: true,
    checkpointer: killing,
    onCompiled: (info) => {
      handlerLog = info.handlerLog;
    },
    ...(resumeFrom === undefined ? {} : { resumeFrom }),
  });

  const report: ChildReport = {
    mode: args.mode,
    handlerCalls: handlerLog.calls,
    status: run.result.status,
    supersteps: run.result.supersteps,
    ...(run.result.status === "completed" ? { verdict: run.result.verdict } : {}),
    ...(resumedAt === undefined ? {} : { resumedAt }),
  };
  await writeFile(args.out, JSON.stringify(report), "utf8");
}

/**
 * The flag that turns this module into a program.
 *
 * `process.argv[1]` is the RUNNER's path under every TypeScript runner (`vite-node`,
 * `tsx`, a loader), not this file's, so the usual "am I the entry point" comparison is
 * unavailable. An explicit sentinel is unambiguous instead: importing this module to reuse
 * {@link parseChildArgs} never starts a run, and the parent opts in by passing the flag.
 */
export const CHILD_ENTRY_FLAG = "--pge-resume-child";

if (process.argv.includes(CHILD_ENTRY_FLAG)) {
  await runChild(parseChildArgs(process.argv.slice(2)));
}
