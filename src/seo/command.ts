/**
 * `bober seo <workflow> [target]` — run an SEO workflow end-to-end.
 * (spec-20260715-ultimate-seo-suite, Sprint 11.)
 *
 * Mirrors `registerSecurityAuditCommand`
 * (`src/cli/commands/security-audit.ts:289-322`): `now` is stamped ONCE at
 * the `.action()` boundary and threaded downstream — never re-read inside
 * `SeoWorkflowRunner`. The handler NEVER throws; it always sets
 * `process.exitCode` (`0` pass / `2` blocked-or-fail-closed — `1` is
 * Commander-reserved).
 *
 * Lives at `src/seo/command.ts` (not `src/cli/commands/seo.ts`) per the
 * contract's `estimatedFiles` — mirrors `registerFleetCommand`
 * (`src/fleet/index.ts`, imported into the CLI at `cli/index.ts:39`).
 */
import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../utils/fs.js";
import { loadConfig } from "../config/loader.js";

import type { SeoWorkflow } from "./types.js";
import { SeoWorkflowRunner } from "./runner.js";
import type { SeoRunInput, SeoRunOutcome } from "./runner.js";

/** The 8 SEO workflows the CLI dispatches on (mirrors `types.ts:17-25`). */
const SEO_WORKFLOWS: readonly SeoWorkflow[] = [
  "technical-audit",
  "rank-track",
  "content-decay",
  "topical-map",
  "ai-visibility",
  "parasite-watch",
  "internal-linking",
  "schema-audit",
];

function isSeoWorkflow(value: string): value is SeoWorkflow {
  return (SEO_WORKFLOWS as readonly string[]).includes(value);
}

export interface SeoCommandOverrides {
  /** Injected in tests to bypass the real runner (no real LLM/network/fs). */
  runWorkflow?: (input: SeoRunInput) => Promise<SeoRunOutcome>;
}

export function registerSeoCommand(program: Command, overrides?: SeoCommandOverrides): void {
  program
    .command("seo <workflow> [target]")
    .description(
      "Run an SEO workflow end-to-end (offline by default; opt-in live data via config.seo.egress).",
    )
    .action(async (workflow: string, target?: string) => {
      try {
        if (!isSeoWorkflow(workflow)) {
          process.stderr.write(
            chalk.red(
              `seo: unknown workflow "${workflow}". Expected one of: ${SEO_WORKFLOWS.join(", ")}\n`,
            ),
          );
          process.exitCode = 2;
          return;
        }

        const projectRoot = (await findProjectRoot()) ?? process.cwd();
        // Stamp wall-clock time ONLY here — never inside the runner.
        const now = new Date().toISOString();
        const config = await loadConfig(projectRoot);

        const run =
          overrides?.runWorkflow ?? ((i: SeoRunInput) => new SeoWorkflowRunner().run(i));

        const { report, exitCode } = await run({ projectRoot, config, workflow, target, now });

        if (report) {
          process.stdout.write(
            `SEO report ${report.reportId}: verdict=${report.verdict}, ` +
              `findings=${report.findings.length}, droppedUncited=${report.droppedUncited}\n`,
          );
        }
        process.exitCode = exitCode;
      } catch (err) {
        process.stderr.write(
          chalk.red(`seo failed: ${err instanceof Error ? err.message : String(err)}\n`),
        );
        process.exitCode = 2; // fail-closed; 1 is Commander-reserved
      }
    });
}
