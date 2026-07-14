/**
 * Launcher port and default RunSpawner-backed adapter.
 *
 * HARD BOUNDARY: `src/cli/commands/do.ts` MUST NOT import RunSpawner or
 * execa directly. The RunSpawner import lives here; do.ts imports from
 * this file instead.
 */

import { RunSpawner } from "../chat/run-spawner.js";
import type { RunSpawnerOptions } from "../chat/run-spawner.js";
import type { PromotionPlan } from "./types.js";

// ── Launcher port ─────────────────────────────────────────────────────

/**
 * Port for launching the work behind an approved PromotionPlan.
 * Injected into runDo so unit tests use a fake and never spawn a real process.
 */
export interface Launcher {
  /** Launch the work described by plan. Returns the runId used + optional pid. */
  launch(plan: PromotionPlan): Promise<{ runId: string; pid?: number }>;
}

// ── RunSpawnerLauncher (default adapter) ──────────────────────────────

/** Options for the RunSpawnerLauncher adapter. */
export interface RunSpawnerLauncherOptions {
  /** Absolute project root, passed to RunSpawner. */
  projectRoot: string;
  /** The finding id — embedded in the generated runId: `do-<findingId>-<ts>`. */
  findingId: string;
  /** Session id for the RunSpawner sidecar. Defaults to `do-<findingId>`. */
  sessionId?: string;
  /** Clock injection. Defaults to () => new Date().toISOString(). */
  now?: () => string;
  /**
   * Pre-built RunSpawner to use instead of constructing one.
   * Inject a RunSpawner with a fake spawn fn in launcher.test.ts so no real
   * process is ever started in unit tests.
   */
  spawner?: RunSpawner;
}

/**
 * Default Launcher adapter — wraps RunSpawner to spawn a detached
 * `agent-bober run <task> --run-id <id>` child.
 *
 * runId format: `do-<findingId>-<timestamp>` — stable prefix for identifying
 * do-bridge runs in roster state.json files.
 */
export class RunSpawnerLauncher implements Launcher {
  private readonly spawner: RunSpawner;
  private readonly findingId: string;
  private readonly now: () => string;

  constructor(opts: RunSpawnerLauncherOptions) {
    this.findingId = opts.findingId;
    this.now = opts.now ?? (() => new Date().toISOString());

    // bober: builds a fresh RunSpawner per CLI invocation; swap for a pre-built
    // injected spawner in tests so no real execa ever runs.
    const spawnerOpts: RunSpawnerOptions = {
      projectRoot: opts.projectRoot,
      sessionId: opts.sessionId ?? `do-${opts.findingId}`,
    };
    this.spawner = opts.spawner ?? new RunSpawner(spawnerOpts);
  }

  async launch(plan: PromotionPlan): Promise<{ runId: string; pid?: number }> {
    const runId = `do-${this.findingId}-${this.now()}`;
    const ack = await this.spawner.spawn(plan.task, runId);
    return { runId, pid: ack.pid };
  }
}
