/** `bober calendar plan --dry-run` — propose a schedule from ranked findings + free/busy (Sprint 1). */

import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { planSlots } from "../../calendar/slotter.js";
import { readFindingsFromFile, readBusyIntervalsFromFile } from "../../calendar/finding-source.js";
import { createIcsConnector } from "../../calendar/ics-connector.js";
import type { Finding, BusyInterval, SlotConstraints } from "../../calendar/types.js";
import type { CalendarConnector } from "../../calendar/connector.js";

// ── Root resolver ─────────────────────────────────────────────────────

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

// ── CalendarPlan deps injection (for testability) ─────────────────────

/**
 * Injectable dependencies for runCalendarPlan.
 * Production callers pass undefined (all fields default to the real implementations).
 * Tests inject fixture readers and a fixed clock to achieve deterministic assertions.
 */
export interface CalendarPlanDeps {
  /** Override the findings reader (default: readFindingsFromFile). */
  readFindings?: (path: string) => Promise<Finding[]>;
  /** Override the free/busy reader (default: readBusyIntervalsFromFile). */
  readFreeBusy?: (path: string) => Promise<BusyInterval[]>;
  /** Override the current ISO time string (clock read ONLY at the CLI boundary). */
  nowIso?: string;
  /** Factory for the calendar connector used by --export-ics (default: createIcsConnector). */
  makeConnector?: (outPath: string) => CalendarConnector;
}

// ── Default planning window ───────────────────────────────────────────

const WINDOW_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── Core (extracted for testability) ─────────────────────────────────

/**
 * Core logic for `bober calendar plan`.
 *
 * Extracted so tests can inject fixture deps without module-level mocking.
 * The CLI .action() calls this with no deps (production path).
 *
 * --dry-run: prints the proposed plan to stdout only; writes NOTHING to any calendar
 * or .ics file. No connectors exist in this sprint (sc-1-6 / nonGoals).
 */
export async function runCalendarPlan(
  _projectRoot: string,
  opts: { findings?: string; freebusy?: string; dryRun?: boolean; exportIcs?: string },
  deps: CalendarPlanDeps = {},
): Promise<void> {
  try {
    // ── 1. Read findings (pre-ranked by the hub) ──────────────────────
    const findingsPath = opts.findings;
    if (findingsPath === undefined) {
      process.stderr.write(chalk.red("--findings <path> is required\n"));
      process.exitCode = 1;
      return;
    }

    const readFindings = deps.readFindings ?? readFindingsFromFile;
    const findings = await readFindings(findingsPath);

    // ── 2. Read free/busy intervals ───────────────────────────────────
    const freebusyPath = opts.freebusy;
    const readFreeBusy = deps.readFreeBusy ?? readBusyIntervalsFromFile;
    const busy = freebusyPath !== undefined ? await readFreeBusy(freebusyPath) : [];

    // ── 3. Build planning constraints ────────────────────────────────
    // Clock read ONLY here at the CLI boundary (mirrors medical.ts:102).
    const nowIso = deps.nowIso ?? new Date().toISOString();
    const windowEndMs = Date.parse(nowIso) + WINDOW_DAYS * MS_PER_DAY;

    const constraints: SlotConstraints = {
      windowStartIso: nowIso,
      windowEndIso: new Date(windowEndMs).toISOString(),
    };

    // ── 4. Slot-fill (pure, synchronous, LLM-free) ───────────────────
    const plan = planSlots(findings, busy, constraints);

    // ── 5. Print proposed plan (stdout only — dry-run writes nothing) ─
    process.stdout.write(chalk.bold("\nProposed calendar plan\n"));
    process.stdout.write(`Window: ${constraints.windowStartIso} → ${constraints.windowEndIso}\n\n`);

    if (plan.scheduled.length === 0 && plan.unscheduled.length === 0) {
      process.stdout.write(chalk.yellow("No findings to schedule.\n"));
      return;
    }

    if (plan.scheduled.length > 0) {
      process.stdout.write(chalk.green(`Scheduled (${plan.scheduled.length}):\n`));
      for (const item of plan.scheduled) {
        process.stdout.write(`  [${item.startIso} → ${item.endIso}]  ${item.title}\n`);
      }
    }

    if (plan.unscheduled.length > 0) {
      process.stdout.write(chalk.yellow(`\nUnscheduled (${plan.unscheduled.length}):\n`));
      for (const entry of plan.unscheduled) {
        process.stdout.write(`  ${entry.findingId}  reason: ${entry.reason}\n`);
      }
    }

    // ── 6. --export-ics → write VCALENDAR via the connector ──────────
    if (opts.exportIcs !== undefined) {
      const makeConnector =
        deps.makeConnector ??
        ((outPath) => createIcsConnector({ outPath, freeBusyPath: opts.freebusy, nowIso }));
      const connector = makeConnector(opts.exportIcs);
      const result = await connector.writeEvents(plan.scheduled);
      process.stdout.write(
        chalk.green(`\nWrote ${result.writtenCount} event(s) to ${result.target}\n`),
      );
    }

    if (opts.dryRun === true) {
      process.stdout.write(chalk.gray("\n(dry-run — nothing written to any calendar)\n"));
    }
  } catch (err) {
    process.stderr.write(
      chalk.red(`Failed to plan: ${err instanceof Error ? err.message : String(err)}\n`),
    );
    // CLI handlers MUST NOT throw — set exitCode and return (mirrors medical.ts:268-269).
    process.exitCode = 1;
  }
}

// ── registerCalendarCommand ───────────────────────────────────────────

/**
 * Register the `bober calendar` command tree.
 * Mirrors registerMedicalCommand (src/cli/commands/medical.ts:229-297).
 */
export function registerCalendarCommand(program: Command): void {
  const calendarCmd = program
    .command("calendar")
    .description("Calendar planner utilities");

  // ── calendar plan ─────────────────────────────────────────────────
  calendarCmd
    .command("plan")
    .description("Propose a schedule from ranked findings + free/busy (deterministic, LLM-free)")
    .option("--dry-run", "print the proposed plan; write nothing to any calendar")
    .option("--findings <path>", "ranked findings JSON file (Finding[] ordered by priority)")
    .option("--freebusy <path>", "free/busy intervals JSON file (BusyInterval[])")
    .option("--export-ics <path>", "write the scheduled plan to an RFC 5545 .ics file (local, no network)")
    .action(
      async (opts: { dryRun?: boolean; findings?: string; freebusy?: string; exportIcs?: string }) => {
        const projectRoot = await resolveRoot();
        await runCalendarPlan(projectRoot, opts);
      },
    );
}
