/**
 * `bober incident <start|status|end|list|abort>` — top-level incident workflow CLI.
 *
 * Subcommands:
 *   start <symptom> [--severity S1|S2|S3|S4]  — Create a new incident.
 *   status <incidentId>                        — Print rich status for an incident.
 *   end <incidentId> [--verified|--override]   — Mark incident resolved.
 *   list                                       — List all incidents.
 *   abort <incidentId> --reason <text>         — Abort at any phase.
 *
 * Error handling: CLI handlers MUST NOT throw. They set process.exitCode=1 and
 * return on all errors (Pattern C per briefing). Top-level main().catch() is
 * the last-ditch fallback, not the primary error path.
 *
 * Sprint 24 — src/cli/commands/incident.ts
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import {
  createIncident,
  listIncidents,
  setIncidentStatus,
} from "../../incident/timeline.js";
import {
  abort,
  readIncidentMetadata,
} from "../../incident/orchestrator.js";
import type { VerifyResult } from "../../incident/resolution-verify.js";
import type { SetStatusOpts } from "../../incident/timeline.js";
import type { IncidentMetadata } from "../../incident/types.js";

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

// ── Duration formatter ────────────────────────────────────────────────────────

function formatDuration(startIso: string, endIso?: string): string {
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const ms = end - start;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// ── Status command renderer ───────────────────────────────────────────────────

async function renderStatus(projectRoot: string, incidentId: string): Promise<void> {
  const meta: IncidentMetadata = await readIncidentMetadata(projectRoot, incidentId);
  const incDir = join(projectRoot, ".bober", "incidents", incidentId);

  const duration = formatDuration(meta.createdAt, meta.resolvedAt);
  const severity = meta.severity ?? "(unset)";

  process.stdout.write(`\nIncident: ${incidentId} (symptom: "${meta.symptom}")\n`);
  process.stdout.write(`Phase:    ${chalk.bold(meta.status)}\n`);
  process.stdout.write(`Severity: ${meta.severity ? chalk.yellow(meta.severity) : chalk.gray(severity)}\n`);
  process.stdout.write(`Duration: ${duration}\n`);
  process.stdout.write(`\n`);

  // ── Latest diagnosis ──────────────────────────────────────────────────────
  const diagnosesDir = join(incDir, "diagnoses");
  try {
    const diagFiles = await readdir(diagnosesDir);
    const jsonFiles = diagFiles.filter((f) => f.endsWith(".json")).sort();
    if (jsonFiles.length === 0) {
      process.stdout.write(`Latest diagnosis: (no diagnoses yet)\n\n`);
    } else {
      const latestFile = jsonFiles[jsonFiles.length - 1]!;
      try {
        const raw = await readFile(join(diagnosesDir, latestFile), "utf-8");
        const diag = JSON.parse(raw) as {
          diagnosisId?: string;
          summary?: string;
          hypotheses?: Array<{ statement: string; confidence: string }>;
        };
        const topHypothesis = diag.hypotheses?.[0];
        const confidence = topHypothesis?.confidence ?? "unknown";
        process.stdout.write(`Latest diagnosis (confidence: ${chalk.cyan(confidence)}):\n`);
        if (topHypothesis) {
          process.stdout.write(`  ${topHypothesis.statement}\n`);
        }
        if (diag.summary && !topHypothesis) {
          process.stdout.write(`  ${diag.summary}\n`);
        }
        process.stdout.write(`  (diagnoses/${latestFile})\n\n`);
      } catch {
        process.stdout.write(`Latest diagnosis: (could not read ${latestFile})\n\n`);
      }
    }
  } catch {
    process.stdout.write(`Latest diagnosis: (no diagnoses yet)\n\n`);
  }

  // ── Actions executed ──────────────────────────────────────────────────────
  const changelogPath = join(incDir, "changelog.jsonl");
  try {
    const raw = await readFile(changelogPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    // Latest-line-wins per id.
    const byId = new Map<string, { description: string; status: string; lineIdx: number }>();
    lines.forEach((l, idx) => {
      try {
        const e = JSON.parse(l) as { id: string; description: string; status: string };
        byId.set(e.id, { description: e.description, status: e.status, lineIdx: idx });
      } catch { /* skip malformed */ }
    });

    const executed = [...byId.values()].filter((e) => e.status === "executed");
    const rolledBack = [...byId.values()].filter((e) => e.status === "rolled-back");

    process.stdout.write(
      `Actions executed: ${chalk.bold(String(executed.length))} (${rolledBack.length} rolled back)\n`,
    );
    executed.forEach((e, i) => {
      process.stdout.write(
        `  ${i + 1}. ${e.description} (changelog.jsonl#L${e.lineIdx + 1})\n`,
      );
    });
    if (executed.length > 0) process.stdout.write("\n");
  } catch {
    process.stdout.write(`Actions executed: (no changelog entries)\n\n`);
  }

  // ── Resolution criteria ───────────────────────────────────────────────────
  if (meta.resolutionCriteria) {
    process.stdout.write(`Resolution criteria:\n  ${meta.resolutionCriteria}\n`);

    // Attempt to read latest evidence.
    const evidenceDir = join(incDir, "resolution-evidence");
    try {
      const evidenceFiles = await readdir(evidenceDir);
      const jsonEvidence = evidenceFiles.filter((f) => f.endsWith(".json")).sort();
      if (jsonEvidence.length > 0) {
        const latestEvidence = jsonEvidence[jsonEvidence.length - 1]!;
        try {
          const raw = await readFile(join(evidenceDir, latestEvidence), "utf-8");
          const ev = JSON.parse(raw) as {
            allSamplesPassed: boolean;
            samples?: Array<{ value: number; timestamp: string }>;
          };
          const lastSample = ev.samples?.[ev.samples.length - 1];
          if (lastSample) {
            const status = ev.allSamplesPassed ? chalk.green("meets threshold") : chalk.red("does not meet threshold");
            process.stdout.write(
              `  Current: ${lastSample.value} (sampled ${new Date(lastSample.timestamp).toLocaleTimeString()}) — ${status}\n`,
            );
          }
        } catch { /* skip */ }
      }
    } catch { /* no evidence dir */ }
    process.stdout.write("\n");
  } else if (meta.resolutionEvidence) {
    const ev = meta.resolutionEvidence;
    if (ev.verified) {
      process.stdout.write(
        `Resolution: ${chalk.green("verified")}${ev.observedValue !== undefined ? ` (observed: ${ev.observedValue})` : ""}\n\n`,
      );
    } else if (ev.override) {
      process.stdout.write(
        `Resolution: ${chalk.yellow("override")} — ${ev.override.reason} (at ${ev.override.at})\n\n`,
      );
    }
  }

  // ── Abort report ──────────────────────────────────────────────────────────
  if (meta.status === "aborted") {
    const abortReportPath = join(incDir, "abort-report.md");
    try {
      await stat(abortReportPath);
      process.stdout.write(`Abort report: ${abortReportPath}\n\n`);
    } catch { /* no abort report */ }
    return; // No "Next:" hint for aborted incidents.
  }

  // ── Next hint ─────────────────────────────────────────────────────────────
  const nextHint: Record<string, string> = {
    investigating: "Invoke bober-diagnoser, then run `bober incident end` or wait for risky actions to transition to remediating.",
    remediating: "Execute proposed actions via bober-deployer (with gates), then run `bober incident end --verified` when done.",
    monitoring: "auto-transition to 'resolved' when criteria sustained. Or run `bober incident end --override <reason>`.",
    resolved: "Postmortem auto-generated. Incident closed. Re-open with `bober incident start` for recurrence.",
  };
  const hint = nextHint[meta.status];
  if (hint) {
    process.stdout.write(`Next: ${chalk.gray(hint)}\n\n`);
  }
}

// ── registerIncidentCommand ───────────────────────────────────────────────────

export function registerIncidentCommand(program: Command): void {
  const incCmd = program
    .command("incident")
    .description("Manage production incidents (start, status, end, list, abort)");

  // ── incident start <symptom> [--severity S1|S2|S3|S4] ──
  incCmd
    .command("start <symptom>")
    .description("Create a new incident and return its ID")
    .option("--severity <level>", "Severity: S1|S2|S3|S4")
    .action(async (symptom: string, opts: { severity?: string }) => {
      const projectRoot = await resolveRoot();
      try {
        const incidentId = await createIncident(symptom, projectRoot);
        if (opts.severity) {
          const validSeverities = ["S1", "S2", "S3", "S4"];
          if (!validSeverities.includes(opts.severity)) {
            process.stderr.write(
              chalk.red(`Invalid severity '${opts.severity}'. Must be one of: S1, S2, S3, S4\n`),
            );
            process.exitCode = 1;
            return;
          }
          // Persist severity via setIncidentStatus extras; stays in 'investigating'.
          await setIncidentStatus(
            projectRoot,
            incidentId,
            "investigating",
            { severity: opts.severity as "S1" | "S2" | "S3" | "S4" },
          );
        }
        process.stdout.write(chalk.green(`Incident created: ${incidentId}\n`));
        process.stdout.write(chalk.gray(`Artifacts at .bober/incidents/${incidentId}/\n`));
      } catch (err) {
        process.stderr.write(
          chalk.red(`Failed to create incident: ${err instanceof Error ? err.message : String(err)}\n`),
        );
        process.exitCode = 1;
      }
    });

  // ── incident status <incidentId> ──
  incCmd
    .command("status <incidentId>")
    .description(
      "Print current state for an incident: phase, severity, duration, latest diagnosis, action counts, criteria",
    )
    .action(async (incidentId: string) => {
      const projectRoot = await resolveRoot();
      try {
        await renderStatus(projectRoot, incidentId);
      } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") {
          process.stderr.write(
            chalk.yellow(`No incident found at .bober/incidents/${incidentId}/.\n`),
          );
          process.exitCode = 1;
          return;
        }
        process.stderr.write(
          chalk.red(
            `Failed to read incident status: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });

  // ── incident end <incidentId> [--verified | --override <reason>] ──
  incCmd
    .command("end <incidentId>")
    .description(
      "Mark incident resolved. Auto-triggers postmortem (Sprint 23). " +
        "Requires --verified (external verification) or --override <reason> (override token).",
    )
    .option(
      "--verified",
      "Resolution criteria were verified externally (synthesize a verifyResult with verified=true)",
    )
    .option(
      "--override <reason>",
      "Use Sprint 22 override token; reason is mandatory and non-empty",
    )
    .action(
      async (incidentId: string, opts: { verified?: boolean; override?: string }) => {
        const projectRoot = await resolveRoot();
        try {
          if (!opts.verified && !opts.override) {
            process.stderr.write(
              chalk.red(
                `One of --verified or --override <reason> is required when ending an incident.\n` +
                  `  --verified: asserts external metric verification passed.\n` +
                  `  --override <reason>: documents operator override with an audit trail.\n`,
              ),
            );
            process.exitCode = 1;
            return;
          }

          const setOpts: SetStatusOpts = {};
          if (opts.verified) {
            setOpts.verifyResult = {
              verified: true,
              reason: "OK",
            } as VerifyResult;
          } else if (opts.override) {
            setOpts.overrideToken = `SKIP_METRIC_VERIFY: ${opts.override}`;
          }

          await setIncidentStatus(projectRoot, incidentId, "resolved", undefined, setOpts);
          process.stdout.write(
            chalk.green(
              `Incident ${incidentId} marked resolved. Postmortem synthesis triggered.\n`,
            ),
          );
        } catch (err) {
          if ((err as { code?: string }).code === "ENOENT") {
            process.stderr.write(
              chalk.yellow(`No incident found at .bober/incidents/${incidentId}/.\n`),
            );
            process.exitCode = 1;
            return;
          }
          process.stderr.write(
            chalk.red(
              `Failed to end incident: ${err instanceof Error ? err.message : String(err)}\n`,
            ),
          );
          process.exitCode = 1;
        }
      },
    );

  // ── incident list ──
  incCmd
    .command("list")
    .description("List all incidents sorted by createdAt descending")
    .action(async () => {
      const projectRoot = await resolveRoot();
      try {
        const summaries = await listIncidents(projectRoot);
        if (summaries.length === 0) {
          process.stdout.write(chalk.gray("No incidents found.\n"));
          return;
        }
        // Header.
        process.stdout.write(
          chalk.bold(
            `${"INCIDENT ID".padEnd(36)} ${"STATUS".padEnd(14)} ${"CREATED AT".padEnd(22)} SYMPTOM\n`,
          ),
        );
        process.stdout.write(`${"-".repeat(100)}\n`);
        for (const s of summaries) {
          const symptomTrunc =
            s.symptom.length > 60 ? `${s.symptom.slice(0, 57)}...` : s.symptom;
          const statusColored =
            s.status === "resolved"
              ? chalk.green(s.status)
              : s.status === "aborted"
                ? chalk.red(s.status)
                : s.status === "monitoring"
                  ? chalk.cyan(s.status)
                  : s.status === "remediating"
                    ? chalk.yellow(s.status)
                    : chalk.blue(s.status);
          process.stdout.write(
            `${s.incidentId.padEnd(36)} ${statusColored.padEnd(14 + (statusColored.length - s.status.length))} ${s.createdAt.slice(0, 19).padEnd(22)} ${symptomTrunc}\n`,
          );
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `Failed to list incidents: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });

  // ── incident abort <incidentId> --reason <text> [--confirm-rollback] ──
  incCmd
    .command("abort <incidentId>")
    .description(
      "Abort an incident at any phase. Writes abort marker; optionally rolls back executed changes.",
    )
    .requiredOption("--reason <text>", "Reason for aborting (REQUIRED)")
    .option(
      "--confirm-rollback",
      "ALSO execute rollback for unreverted changes (each step gates as risky)",
    )
    .action(async (incidentId: string, opts: { reason: string; confirmRollback?: boolean }) => {
      const projectRoot = await resolveRoot();
      try {
        const result = await abort(projectRoot, incidentId, {
          reason: opts.reason,
          confirmRollback: opts.confirmRollback ?? false,
        });
        process.stdout.write(
          chalk.yellow(`Incident ${incidentId} aborted. Report: ${result.abortReportPath}\n`),
        );
        if (result.rollback) {
          process.stdout.write(
            chalk.gray(
              `  Rollback: ${result.rollback.succeeded}/${result.rollback.attempted} step(s) succeeded\n`,
            ),
          );
          if (result.rollback.escalated) {
            process.stderr.write(
              chalk.red(
                `  ESCALATED: rollback halted — manual recovery required for remaining steps.\n`,
              ),
            );
          }
        }
      } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") {
          process.stderr.write(
            chalk.yellow(`No incident found at .bober/incidents/${incidentId}/.\n`),
          );
          process.exitCode = 1;
          return;
        }
        process.stderr.write(
          chalk.red(
            `Failed to abort incident: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });
}
