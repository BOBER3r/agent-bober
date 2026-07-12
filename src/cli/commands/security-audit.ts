/**
 * `agent-bober security-audit [target]` — on-demand stack-aware security audit.
 *
 * Synthesizes a lightweight SprintContract-shaped descriptor from the target
 * path (or the working tree when omitted), runs the same `runSecurityAudit`
 * core the in-pipeline gate uses (with `evaluation=null` for standalone
 * mode), persists the artifact via `saveSecurityAudit` (called internally by
 * the core), prints a human-readable findings summary, and exits with a
 * CI-friendly code driven by `security.standaloneBlockOn`.
 *
 * Threshold semantics (sc-4-2) are CLI-local by design: `thresholdVerdict`
 * lives HERE, never in `security-gate.ts`. The pipeline gate's critical-only
 * veto (ADR-2) stays structurally untouched — this command reads
 * `security.standaloneBlockOn` to decide its OWN exit code only.
 *
 * Exit codes: 0 = pass, 2 = blocked-by-threshold OR fail-closed (audit threw,
 * or the auditor's output could not be parsed). 1 is reserved for Commander's
 * own usage errors and for unexpected errors resolving config/project root.
 *
 * Clock discipline: `new Date().toISOString()` is called ONLY at the
 * `.action()` boundary — never inside `runStandaloneSecurityAudit` — mirrors
 * `research.ts`'s "stamp wall-clock time at handler boundary" convention.
 * Hub emission (sprint 6) reuses `deps.now` for the same reason — it is
 * never re-stamped inside this module.
 *
 * Error handling: CLI handlers MUST NOT throw. They set `process.exitCode`
 * and return on all errors (mirrors `research.ts` / `do.ts`).
 */

import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { loadConfig } from "../../config/loader.js";
import { SecuritySectionSchema } from "../../config/schema.js";
import type { BoberConfig, SecuritySection } from "../../config/schema.js";
import type { SprintContract } from "../../contracts/sprint-contract.js";
import type { ReviewResult } from "../../orchestrator/code-reviewer-agent.js";
import type { SecurityAuditResult } from "../../orchestrator/security-audit-types.js";
import { runSecurityAudit } from "../../orchestrator/security-auditor-agent.js";
import type { SecurityFindingSink } from "../../orchestrator/security-hub.js";
import { emitSecurityFindings, mapAuditToFindings } from "../../orchestrator/security-hub.js";
import { ingestFinding } from "../../hub/finding-store.js";
import { FactStore, factsDbPath, ensureFactsDir } from "../../state/facts.js";
import { logger } from "../../utils/logger.js";

// ── Pure threshold (lives HERE, never in security-gate.ts) — sc-4-4 ──

/**
 * Decide whether the standalone CLI should block (exit 2) given a review and
 * the configured `standaloneBlockOn` threshold. Pure function — no I/O.
 *
 * `critical` findings always block, regardless of threshold. `important`
 * findings only block when `standaloneBlockOn === "important"`. `minor`
 * findings never block. This is intentionally a *superset* of the pipeline
 * gate's critical-only veto (`deriveVerdict`) — it must never be imported
 * into `security-gate.ts` or `pipeline.ts` (sc-4-4 is verified structurally).
 */
export function thresholdVerdict(
  review: ReviewResult,
  standaloneBlockOn: "critical" | "important",
): boolean {
  if (review.critical.length > 0) return true;
  if (standaloneBlockOn === "important" && review.important.length > 0) return true;
  return false;
}

// ── Descriptor synthesis ───────────────────────────────────────────────

/**
 * Build a synthetic SprintContract-shaped descriptor for the standalone
 * audit. The `contractId` is timestamped (`security-audit-<slug>`) so it can
 * never collide with a pipeline sprint's `sprint-*` contractId, and so the
 * fs-safe sanitization in `security-audit-state.ts` produces a stable,
 * readable artifact filename.
 */
export function buildAuditDescriptor(target: string | undefined, now: string): SprintContract {
  const slug = now.replace(/[^A-Za-z0-9]/g, "-");
  const scope = target ?? "working tree";
  return {
    contractId: `security-audit-${slug}`,
    specId: "security-audit-standalone",
    sprintNumber: 1,
    title: `Standalone security audit: ${scope}`,
    description: `On-demand security audit of ${scope}, requested via the standalone bober security-audit CLI.`,
    status: "in-progress",
    dependsOn: [],
    features: [],
    successCriteria: [
      {
        criterionId: "audit",
        description: "Audit the target for exploitable security vulnerabilities and cite each finding with path:line.",
        verificationMethod: "manual",
        required: true,
      },
    ],
    nonGoals: ["This is a standalone on-demand audit — not a pipeline sprint contract."],
    stopConditions: ["The auditor emits a well-formed ReviewResult JSON."],
    definitionOfDone: "A cited security review of the target has been produced and persisted.",
    assumptions: [],
    outOfScope: [],
    estimatedFiles: target ? [target] : [],
    iterationHistory: [],
    lastEvalId: null,
  };
}

// ── Injectable DI core ─────────────────────────────────────────────────

/** Injectable deps so tests never spawn a process or hit a real provider. */
export interface StandaloneAuditDeps {
  projectRoot: string;
  config: BoberConfig;
  target?: string;
  /** ISO timestamp, stamped ONCE at the `.action` boundary. */
  now: string;
  /** Default = the real `runSecurityAudit` core; tests inject a fake. */
  runAudit?: typeof runSecurityAudit;
  /** Injected hub sink (tests only) — default binds ingestFinding to a real FactStore. */
  findingSink?: SecurityFindingSink;
}

export interface StandaloneAuditOutcome {
  result?: SecurityAuditResult;
  exitCode: 0 | 2;
}

/**
 * Run a standalone security audit and compute the CI exit code.
 *
 * `config.security` may be absent — that is legal for standalone mode (the
 * explicit CLI invocation IS the opt-in; nonGoals[0]). When absent, the
 * section is synthesized via `SecuritySectionSchema.parse({})` so the audit
 * still runs with schema defaults (sc-4-3).
 *
 * Fail-closed (sc-4-2): a thrown audit error, or `result.parsed === false`,
 * always exits 2 — checked BEFORE the threshold, so an empty fallback review
 * (which `thresholdVerdict` alone would read as "clean") never yields a
 * false pass.
 */
export async function runStandaloneSecurityAudit(
  deps: StandaloneAuditDeps,
): Promise<StandaloneAuditOutcome> {
  const runAudit = deps.runAudit ?? runSecurityAudit;
  const security = deps.config.security ?? SecuritySectionSchema.parse({});
  const runConfig: BoberConfig = { ...deps.config, security };
  const descriptor = buildAuditDescriptor(deps.target, deps.now);

  let result: SecurityAuditResult;
  try {
    result = await runAudit(descriptor, null, deps.projectRoot, runConfig);
  } catch (err) {
    process.stderr.write(
      chalk.red(
        `security-audit failed: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
    return { exitCode: 2 };
  }

  if (!result.parsed) {
    process.stderr.write(
      chalk.red(
        "security-audit: auditor output could not be parsed — treating as blocked (fail-closed).\n",
      ),
    );
    printSummary(descriptor, result, security.standaloneBlockOn, true);
    return { result, exitCode: 2 };
  }

  // Best-effort hub emission — AFTER a parseable result, BEFORE computing
  // this command's own threshold verdict. A hub failure never changes the
  // exit code (nonGoals[3]); emitSecurityFindings catches and logs
  // internally. Reuses deps.now — never re-stamps the clock here.
  await emitFindingsToHub(result, deps.projectRoot, security, deps.now, deps.findingSink);

  const blocked = thresholdVerdict(result.review, security.standaloneBlockOn);
  printSummary(descriptor, result, security.standaloneBlockOn, blocked);
  return { result, exitCode: blocked ? 2 : 0 };
}

// ── Hub emission ─────────────────────────────────────────────────────

/**
 * Emit a SecurityAuditResult's critical/important findings into the
 * priority hub. Best-effort: emitSecurityFindings already catches and logs
 * sink failures internally, so this helper never throws and never affects
 * the CLI's exit code.
 *
 * - `security.hub === false` -> no-op (zero hub writes).
 * - An injected `findingSink` (tests) is used as-is.
 * - Otherwise, a FactStore is opened lazily — only when mapAuditToFindings
 *   produces at least one finding to emit — so a clean audit (or a
 *   `hub:false` config) never touches the filesystem.
 */
async function emitFindingsToHub(
  result: SecurityAuditResult,
  projectRoot: string,
  security: SecuritySection,
  now: string,
  findingSink: SecurityFindingSink | undefined,
): Promise<void> {
  if (security.hub === false) return;

  if (findingSink !== undefined) {
    await emitSecurityFindings(result, findingSink, logger, now);
    return;
  }

  // Check emptiness BEFORE opening a store — a clean audit (mapAuditToFindings
  // returns []) never touches the filesystem. mapAuditToFindings is pure and
  // cheap, so computing it twice (here + inside emitSecurityFindings) is fine.
  if (mapAuditToFindings(result, now).length === 0) return;

  await ensureFactsDir(projectRoot);
  const store = new FactStore(factsDbPath(projectRoot));
  const defaultSink: SecurityFindingSink = async (finding) => {
    await ingestFinding(store, finding, { now });
  };

  try {
    await emitSecurityFindings(result, defaultSink, logger, now);
  } finally {
    store.close();
  }
}

// ── Summary rendering ───────────────────────────────────────────────────

/** Bound the number of findings printed to the terminal. */
const MAX_PRINTED_FINDINGS = 20;

function printSummary(
  descriptor: SprintContract,
  result: SecurityAuditResult,
  standaloneBlockOn: "critical" | "important",
  blocked: boolean,
): void {
  const { review } = result;
  const safeId = descriptor.contractId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const artifactPath = `.bober/security/${safeId}-security-audit.md`;

  const verdictLine = blocked
    ? chalk.red(`BLOCKED (threshold: ${standaloneBlockOn})`)
    : chalk.green("PASS");

  const lines: string[] = [
    `Security audit: ${verdictLine}`,
    `Stack: ${result.stack}`,
    `Findings — critical: ${review.critical.length}, important: ${review.important.length}, minor: ${review.minor.length}`,
    `Summary: ${review.summary}`,
  ];

  const topFindings = [...review.critical, ...review.important].slice(0, MAX_PRINTED_FINDINGS);
  if (topFindings.length > 0) {
    lines.push("Top findings:");
    for (const finding of topFindings) {
      const evidence = finding.evidence[0];
      const path = evidence?.path ?? "unknown";
      const line = evidence?.line ?? 0;
      lines.push(`  - ${finding.description} at ${path}:${line}`);
    }
  }

  lines.push(`Artifact: ${artifactPath}`);

  process.stdout.write(lines.join("\n") + "\n");
}

// ── registerSecurityAuditCommand ────────────────────────────────────────

export interface SecurityAuditOverrides {
  runAudit?: typeof runSecurityAudit;
}

export function registerSecurityAuditCommand(
  program: Command,
  overrides?: SecurityAuditOverrides,
): void {
  program
    .command("security-audit [target]")
    .description(
      "Run an on-demand stack-aware security audit against a local path (or the working tree).",
    )
    .action(async (target?: string) => {
      try {
        const projectRoot = (await findProjectRoot()) ?? process.cwd();
        // Stamp wall-clock time ONLY here — never inside the DI core.
        const now = new Date().toISOString();
        const config = await loadConfig(projectRoot);

        const { exitCode } = await runStandaloneSecurityAudit({
          projectRoot,
          config,
          target,
          now,
          runAudit: overrides?.runAudit,
        });
        process.exitCode = exitCode;
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `security-audit failed: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 2;
      }
    });
}
