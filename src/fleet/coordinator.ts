import { resolve } from "node:path";

import { mapBounded } from "../orchestrator/workflow/scheduler.js";
import { ChildScaffolder } from "./scaffolder.js";
import { ChildRunner } from "./runner.js";
import type { FleetManifest, FleetChild } from "./manifest.js";
import type { ScaffoldResult } from "./scaffolder.js";
import type { ChildSpawnResult } from "./runner.js";
import type { ChildExecution } from "./types.js";
import type { SharedBlackboard } from "./shared-blackboard.js";

// ── Injection seam ────────────────────────────────────────────────────

/** Optional 3rd param threads the blackboard config into round-1 scaffolding. */
export interface Scaffolder {
  scaffold(
    rootDir: string,
    child: FleetChild,
    blackboard?: { dbPath: string; namespace: string; maxRounds: number },
  ): Promise<ScaffoldResult>;
}

export interface Runner {
  run(spec: { cwd: string; task: string; timeoutMs?: number }): Promise<ChildSpawnResult>;
}

// ── FleetCoordinator ──────────────────────────────────────────────────

export class FleetCoordinator {
  private readonly scaffolder: Scaffolder;
  private readonly runner: Runner;

  constructor(deps?: { scaffolder?: Scaffolder; runner?: Runner }) {
    this.scaffolder = deps?.scaffolder ?? new ChildScaffolder();
    this.runner = deps?.runner ?? new ChildRunner();
  }

  async execute(manifest: FleetManifest): Promise<ChildExecution[]> {
    return mapBounded(
      manifest.children,
      manifest.concurrency,
      (child) => this.runChild(manifest.rootDir, child),
    );
  }

  // ── executeRounds ─────────────────────────────────────────────────

  /**
   * Run children for up to opts.maxRounds rounds sharing the blackboard.
   * Round 1 scaffolds each child (writes config.fleet from scaffoldCfg).
   * Rounds 2..N skip scaffolding entirely and re-spawn via runner only.
   * Early-stops when a completed round adds zero new 'finding' facts.
   * Returns the FINAL round's ChildExecution[].
   */
  async executeRounds(
    manifest: FleetManifest,
    blackboard: SharedBlackboard,
    opts: { maxRounds: number; dbPath: string },
  ): Promise<{ executions: ChildExecution[]; roundsRun: number }> {
    const scaffoldCfg = {
      dbPath: opts.dbPath,
      namespace: manifest.blackboard!.namespace,
      maxRounds: opts.maxRounds,
    };

    let prevCount = blackboard.readAll().length;
    let lastExecutions: ChildExecution[] = [];
    let roundsRun = 0;

    for (let r = 1; r <= opts.maxRounds; r++) {
      roundsRun = r;
      lastExecutions = await mapBounded(
        manifest.children,
        manifest.concurrency,
        (child) => this.runChildRound(manifest.rootDir, child, r, r === 1 ? scaffoldCfg : undefined),
      );

      const count = blackboard.readAll().length;
      if (r > 1 && count === prevCount) break; // early-stop: no new findings this round
      prevCount = count;
    }

    return { executions: lastExecutions, roundsRun };
  }

  // ── runChildRound ─────────────────────────────────────────────────

  /**
   * Round-aware never-reject thunk.
   * Scaffolds ONLY on round 1 (with optional blackboard config threaded in).
   * On rounds ≥ 2, skips scaffolding and reuses the round-1 absPath.
   */
  private async runChildRound(
    rootDir: string,
    child: FleetChild,
    round: number,
    blackboardScaffoldCfg?: { dbPath: string; namespace: string; maxRounds: number },
  ): Promise<ChildExecution> {
    try {
      let scaffold: ScaffoldResult;

      if (round === 1) {
        scaffold = await this.scaffolder.scaffold(rootDir, child, blackboardScaffoldCfg);
        if (scaffold.error) {
          return { folder: child.folder, scaffold, spawn: undefined };
        }
      } else {
        // Round ≥ 2: reuse the same absPath the scaffolder computed in round 1.
        const absPath = resolve(rootDir, child.folder);
        scaffold = {
          folder: child.folder,
          absPath,
          configWritten: true,
          gitInitialized: true,
        };
      }

      const spawn = await this.runner.run({ cwd: scaffold.absPath, task: child.task });
      return { folder: child.folder, scaffold, spawn };
    } catch (e) {
      return {
        folder: child.folder,
        scaffold: {
          folder: child.folder,
          absPath: "",
          configWritten: false,
          gitInitialized: false,
          error: String(e),
        },
        spawn: undefined,
      };
    }
  }

  // The never-reject thunk: EVERYTHING (incl. the awaits) is inside try/catch.
  private async runChild(rootDir: string, child: FleetChild): Promise<ChildExecution> {
    try {
      const scaffold = await this.scaffolder.scaffold(rootDir, child);
      if (scaffold.error) {
        return { folder: child.folder, scaffold, spawn: undefined };
      }
      const spawn = await this.runner.run({ cwd: scaffold.absPath, task: child.task });
      return { folder: child.folder, scaffold, spawn };
    } catch (e) {
      return {
        folder: child.folder,
        scaffold: {
          folder: child.folder,
          absPath: "",
          configWritten: false,
          gitInitialized: false,
          error: String(e),
        },
        spawn: undefined,
      };
    }
  }
}
