import { mapBounded } from "../orchestrator/workflow/scheduler.js";
import { ChildScaffolder } from "./scaffolder.js";
import { ChildRunner } from "./runner.js";
import type { FleetManifest, FleetChild } from "./manifest.js";
import type { ScaffoldResult } from "./scaffolder.js";
import type { ChildSpawnResult } from "./runner.js";
import type { ChildExecution } from "./types.js";

// ── Injection seam ────────────────────────────────────────────────────

export interface Scaffolder {
  scaffold(rootDir: string, child: FleetChild): Promise<ScaffoldResult>;
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
