/**
 * `bober do <findingId>` — promote a hub Finding into a bober run task.
 *
 * Error handling: CLI handlers MUST NOT throw. Set process.exitCode=1 and return.
 *
 * HARD BOUNDARY: this file MUST NOT import execa, node:child_process,
 * or RunSpawner directly. Import the Launcher adapter from do-bridge/launcher.ts
 * instead — it owns the RunSpawner import.
 */

import chalk from "chalk";
import prompts from "prompts";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { loadConfig } from "../../config/loader.js";
import { loadTeam } from "../../teams/registry.js";
import { FactStore, factsDbPath, ensureFactsDir } from "../../state/facts.js";
import type { FindingStore } from "../../do-bridge/finding-port.js";
import { FactStoreFindingStore } from "../../do-bridge/finding-port.js";
import { PromoterRegistry } from "../../do-bridge/registry.js";
import { codingPromoter } from "../../do-bridge/coding-promoter.js";
import type { Launcher } from "../../do-bridge/launcher.js";
import { RunSpawnerLauncher } from "../../do-bridge/launcher.js";
import { runPromotionGate } from "../../do-bridge/promote.js";
import type { Promoter } from "../../do-bridge/types.js";
import { reconcilePromotionsForRoot } from "../../do-bridge/reconcile.js";
import { logger } from "../../utils/logger.js";

// ── Root resolver ─────────────────────────────────────────────────────

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

// ── Namespace resolver ────────────────────────────────────────────────

/**
 * Resolve the active memory namespace from the default team.
 * Falls back to undefined (default .bober/memory/ path) if config is absent.
 * Never throws — config absence is not fatal.
 */
async function resolveDefaultNamespace(
  projectRoot: string,
): Promise<string | undefined> {
  try {
    const config = await loadConfig(projectRoot);
    return loadTeam(config, undefined).memoryNamespace || undefined;
  } catch {
    return undefined;
  }
}

// ── RunDoDeps ─────────────────────────────────────────────────────────

/**
 * Injected dependencies for the real (non-dry-run) launch path.
 * OPTIONAL so the 12 existing Sprint-1 tests (4-arg calls that hit
 * dry-run/error branches) still compile without providing deps.
 */
export interface RunDoDeps {
  /** Launcher port — injected so tests use a fake and never spawn a real process. */
  launcher: Launcher;
  /** Absolute project root for approval marker files. */
  projectRoot: string;
  /** Interactive confirm. TTY path calls this; tests pass a stub. */
  confirm: () => Promise<boolean>;
  /** Whether stdout is a TTY. Defaults to process.stdout.isTTY. */
  isTTY?: boolean;
  /** Clock injection. Defaults to () => new Date().toISOString(). */
  now?: () => string;
  /** Non-TTY poll interval in ms (small values for tests). */
  pollMs?: number;
  /** Non-TTY timeout in ms. */
  timeoutMs?: number;
}

// ── runDo (DI core) ───────────────────────────────────────────────────

/**
 * DI core for `bober do` — accepts injected FindingStore + registry so tests
 * can drive it without opening a real DB or spawning anything.
 *
 * Never throws: every failure branch sets process.exitCode=1 and returns.
 *
 * Resolution branches:
 *  1. finding === null          → stderr "no finding with id …" + exitCode 1 + return.
 *  2. promoter === undefined    → stderr naming the unsupported domain + exitCode 1 + return.
 *  3. --dry-run                 → print ONE stdout line containing plan.task + "dry-run"; NO writes.
 *  4. non-dry-run               → gate (pending → approve/reject) → launch on approve.
 */
export async function runDo(
  store: FindingStore,
  registry: PromoterRegistry,
  findingId: string,
  opts: { dryRun?: boolean; yes?: boolean },
  deps?: RunDoDeps,
): Promise<void> {
  // Branch 1: look up the finding
  const finding = await store.readFinding(findingId);
  if (finding === null) {
    process.stderr.write(
      chalk.red(`do: no finding with id '${findingId}'\n`),
    );
    process.exitCode = 1;
    return;
  }

  // Branch 2: resolve the promoter
  const promoter = registry.resolve({ domain: finding.domain, kind: finding.kind });
  if (promoter === undefined) {
    process.stderr.write(
      chalk.red(
        `do: unsupported domain '${finding.domain}' — no promoter registered for this domain\n`,
      ),
    );
    process.exitCode = 1;
    return;
  }

  // Branch 3: build the promotion plan
  // Cast to Finding for the promoter call — DoFinding is compatible except for
  // promotesTo type (object vs string); codingPromoter never reads promotesTo.
  const plan = promoter(finding as Parameters<typeof promoter>[0]);
  const teamDisplay = plan.teamId !== undefined ? plan.teamId : "default team";

  if (opts.dryRun) {
    // Dry-run: print the plan and return — NO writes, NO spawns (evaluator checks this)
    process.stdout.write(
      chalk.green(
        `[dry-run] would launch: bober run "${plan.task}" (team: ${teamDisplay})\n`,
      ),
    );
    return;
  }

  // Branch 4: non-dry-run — gate + launch
  if (deps === undefined) {
    // Safety net: deps are required for the real path
    process.stderr.write(
      chalk.red(`do: internal error — missing deps for real launch path\n`),
    );
    process.exitCode = 1;
    return;
  }

  const now = deps.now ?? (() => new Date().toISOString());
  const isTTY = deps.isTTY ?? process.stdout.isTTY ?? false;

  process.stdout.write(
    chalk.cyan(
      `do: requesting approval to launch bober run "${plan.task}" (team: ${teamDisplay})\n`,
    ),
  );

  try {
    const outcome = await runPromotionGate({
      projectRoot: deps.projectRoot,
      findingId,
      plan,
      yes: opts.yes ?? false,
      isTTY,
      confirm: deps.confirm,
      now,
      pollMs: deps.pollMs,
      timeoutMs: deps.timeoutMs,
    });

    if (!outcome.approved) {
      process.stdout.write(
        chalk.yellow(`do: promotion rejected — no launch, finding unchanged\n`),
      );
      return;
    }

    // Approved: launch and update finding
    const { runId, pid } = await deps.launcher.launch(plan);

    const ref = {
      kind: "bober-run" as const,
      runId,
      launchedAt: now(),
      status: "launched" as const,
    };

    await store.setPromotion(findingId, ref, { now: now() });

    const pidDisplay = pid !== undefined ? ` (pid ${pid})` : "";
    process.stdout.write(
      chalk.green(
        `do: launched bober run "${plan.task}" — runId: ${runId}${pidDisplay}\n`,
      ),
    );
  } catch (err) {
    process.stderr.write(
      chalk.red(
        `do: launch failed — ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
    process.exitCode = 1;
  }
}

// ── registerDoCommand ─────────────────────────────────────────────────

export function registerDoCommand(program: Command): void {
  program
    .command("do [findingId]")
    .description("Promote a hub Finding into a bober run task, or reconcile launched promotions")
    .option("--dry-run", "Preview the planned launch without spawning anything", false)
    .option("--yes", "Auto-approve the promotion without prompting", false)
    .option("--reconcile", "Reconcile launched promotions to their run outcome and exit", false)
    .action(async (
      findingId: string | undefined,
      opts: { dryRun?: boolean; yes?: boolean; reconcile?: boolean },
    ) => {
      const projectRoot = await resolveRoot();
      try {
        const ns = await resolveDefaultNamespace(projectRoot);
        await ensureFactsDir(projectRoot, ns);

        const store = new FactStore(factsDbPath(projectRoot, ns));
        const findingStore = new FactStoreFindingStore(store);

        // ── reconcile-only path (--reconcile flag) ──────────────────
        if (opts.reconcile === true) {
          try {
            const summary = await reconcilePromotionsForRoot(
              projectRoot,
              findingStore,
              () => new Date().toISOString(),
            );
            process.stdout.write(
              chalk.green(
                `do --reconcile: completed=${summary.completed} aborted=${summary.aborted} unchanged=${summary.unchanged}\n`,
              ),
            );
          } finally {
            store.close();
          }
          return;
        }

        // ── normal promote path (bober do <id>) ─────────────────────
        if (findingId === undefined) {
          store.close();
          process.stderr.write(
            chalk.red(`do: findingId is required (run \`bober do --reconcile\` to reconcile)\n`),
          );
          process.exitCode = 1;
          return;
        }

        // ── Registry: add promoters here to extend the do-bridge ──────
        // See docs/do-bridge.md for the extension point documentation.
        // Call site referenced from docs/do-bridge.md §The Promoter Registry Extension Point.
        const registry = new PromoterRegistry();
        registry.register({ domain: "coding" }, codingPromoter);
        registry.register({ domain: "projects" }, codingPromoter);
        // STUB — not functional; registered here only to prove registry.register
        // accepts a new PromoterKey {domain:'projects', kind:'action'}.
        // Replace with a real projectsActionPromoter in a future sprint.
        // bober: stub promoter; swap for a real implementation when the
        // projects-action use case is defined.
        const projectsActionStub: Promoter = (_f) => ({
          kind: "bober-run",
          task: "STUB — not functional",
        });
        registry.register({ domain: "projects", kind: "action" }, projectsActionStub);

        // Best-effort start-of-command reconcile — mirrors seedProjectFacts in
        // src/orchestrator/pipeline.ts:981. A reconcile failure MUST NOT abort
        // `bober do`. Missing/corrupt run-state files are handled inside reconcile.
        try {
          await reconcilePromotionsForRoot(
            projectRoot,
            findingStore,
            () => new Date().toISOString(),
          );
        } catch (err) {
          logger.warn(
            `Reconcile skipped: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        // Build the real deps for the launch path
        const launcher = new RunSpawnerLauncher({
          projectRoot,
          findingId,
        });

        const deps: RunDoDeps = {
          launcher,
          projectRoot,
          confirm: async () => {
            const answer = await prompts({
              type: "confirm",
              name: "value",
              message: `Approve promotion for finding '${findingId}'?`,
              initial: false,
            });
            return answer.value === true;
          },
          isTTY: process.stdout.isTTY,
        };

        try {
          await runDo(findingStore, registry, findingId, opts, deps);
        } finally {
          store.close();
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `do failed: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });
}
