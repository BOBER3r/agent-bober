import type { BoberConfig } from "../config/schema.js";
import type { SprintContract } from "../contracts/sprint-contract.js";
import type { EvaluationRunResult } from "../evaluators/registry.js";
import type { ReviewResult, ReviewFinding } from "./code-reviewer-agent.js";
import type { SecurityAuditResult, SecurityFinding, VulnClass } from "./security-audit-types.js";
import { deriveVerdict } from "./security-audit-types.js";
import { createClient } from "../providers/factory.js";
import { resolveModel } from "./model-resolver.js";
import { assembleSystemPrompt } from "./agent-loader.js";
import { resolveRoleTools, getGraphState, getGraphDeps } from "./tools/index.js";
import { runAgenticLoop } from "./agentic-loop.js";
import { budgetFromMaxUsd } from "./workflow/budget.js";
import { saveSecurityAudit } from "../state/security-audit-state.js";
import { resolveStackSecurityContext, ALL_VULN_CLASSES } from "./stack-knowledge.js";
import { runScannerPreFilter } from "./security-scanners.js";
import { logger } from "../utils/logger.js";

// ── Main ───────────────────────────────────────────────────────────

/**
 * Run the bober-security-auditor subagent for a stack-aware security audit.
 *
 * Mirrors runCodeReviewer's structure (prompt build → runAgenticLoop with
 * read-only tools → parse → persist) but the parse is FAIL-CLOSED: an
 * unparseable auditor response resolves with `parsed:false` and a forced
 * `verdict:'blocked'` — it never silently degrades to a clean pass the way
 * the advisory code reviewer's fallback does.
 *
 * Two distinct failure modes (per arch-20260712-security-audit-agent-team
 * API contracts):
 * - Provider/network/budget error → THROWS (propagates to the caller).
 * - Unparseable auditor output → RESOLVES with `parsed:false`, `verdict:'blocked'`.
 *
 * @param contract    The sprint contract to audit.
 * @param evaluation  The evaluation result when running in-pipeline (post-evaluation),
 *                    or `null` for standalone mode — the evaluation-context section of
 *                    the prompt is omitted entirely when null.
 * @param projectRoot Absolute path to the project root.
 * @param config      The resolved bober configuration (reads `config.security` and
 *                    `config.project.stack`; both optional).
 * @param priors      Deterministic scanner findings supplied directly by the caller.
 *                    Combined with any findings produced internally by
 *                    `runScannerPreFilter` when `config.security.scanners` is
 *                    non-empty; the combined list is rendered into a "ground
 *                    truth priors" prompt section when non-empty. Defaults to [].
 * @returns A SecurityAuditResult, already persisted via saveSecurityAudit.
 */
export async function runSecurityAudit(
  contract: SprintContract,
  evaluation: EvaluationRunResult | null,
  projectRoot: string,
  config: BoberConfig,
  priors: SecurityFinding[] = [],
): Promise<SecurityAuditResult> {
  const contractId = contract.contractId;
  logger.sprint(contractId, `Security audit: ${contract.title}`);

  const securityModel = config.security?.model ?? "opus";
  const model = resolveModel(securityModel);
  const maxTurns = config.security?.maxTurns ?? 20;

  // Security auditor reuses the "curator" role's tool set — read-only,
  // no execution (read_file, glob, grep). It never gets bash, write, or
  // edit tools (nonGoals[3]): unlike the evaluator/code-reviewer roles,
  // the auditor must not be able to run shell commands at all.
  const graphState = getGraphState(config);
  const graphDeps = graphState.engineHealth === "ready" ? getGraphDeps() : undefined;
  const toolSet = resolveRoleTools("curator", projectRoot, graphState, graphDeps ?? undefined);
  const systemPrompt = await assembleSystemPrompt("curator", "bober-security-auditor", projectRoot, graphState);

  const client = createClient(
    config.security?.provider ?? null,
    config.security?.endpoint ?? null,
    config.security?.providerConfig,
    securityModel,
    "SecurityAuditor",
  );

  const ctx = await resolveStackSecurityContext(config.project.stack);

  // Sprint-5 seam: when scanners are configured, run the deterministic
  // pre-filter INSIDE the audit path (under its own AbortController keyed to
  // the same timeout the gate time-boxes the whole audit against — ADR-4)
  // and fold its findings in as additional priors. Absent scanners config,
  // this is a pure no-op: zero child processes spawned.
  const configuredScanners = config.security?.scanners ?? [];
  let effectivePriors = priors;
  if (configuredScanners.length > 0) {
    const scannerAbort = new AbortController();
    const scannerTimer = setTimeout(
      () => scannerAbort.abort(),
      config.security?.timeoutMs ?? 300_000,
    );
    try {
      const scannerPriors = await runScannerPreFilter({
        scanners: configuredScanners,
        projectRoot,
        signal: scannerAbort.signal,
      });
      effectivePriors = [...priors, ...scannerPriors];
    } finally {
      clearTimeout(scannerTimer);
    }
  }

  const userMessage = buildUserMessage(
    contract,
    evaluation,
    projectRoot,
    ctx.stackLabel,
    ctx.skillName,
    ctx.promptFragment,
    effectivePriors,
  );

  logger.info(`Calling security auditor model (${securityModel} → ${model})...`);

  const budget = budgetFromMaxUsd(config.security?.budget?.maxUsd);

  const result = await runAgenticLoop({
    client,
    model,
    systemPrompt,
    userMessage,
    tools: toolSet.schemas,
    toolHandlers: toolSet.handlers,
    maxTurns,
    maxTokens: 16384,
    ...(budget !== undefined ? { budget } : {}),
    onToolUse: (name, input) => {
      const inp = input as Record<string, unknown>;
      const inputStr = JSON.stringify(inp).slice(0, 120);
      logger.debug(`  [security-auditor] ${name}(${inputStr})`);
    },
  });

  logger.debug(
    `Security auditor completed in ${result.turnsUsed} turns (${result.toolsCalled.length} tool calls)`,
  );

  const { review, parsed } = parseSecurityAuditResult(result.finalText, contractId, contract.specId);

  // THE inversion (sc-2-2): verdict is only ever derived from a genuinely
  // parsed review. A parse failure forces 'blocked' — never a silent pass
  // from an empty fallback review.
  const verdict: "pass" | "blocked" = parsed ? deriveVerdict(review) : "blocked";

  const auditResult: SecurityAuditResult = {
    review,
    stack: ctx.stackLabel,
    // True when scanners were configured (even if they all yielded [], the
    // deterministic pre-filter genuinely ran) OR when the caller-supplied
    // `priors` were non-empty (sprint-2 formula — priors passed directly with
    // no scanners configured still counts as "a scanner ran" from the
    // caller's perspective).
    scannerRan: configuredScanners.length > 0 || effectivePriors.length > 0,
    parsed,
    verdict,
  };

  await saveSecurityAudit(projectRoot, contractId, auditResult);

  logger.info(
    `Security audit complete: verdict=${verdict}, parsed=${parsed}, ${review.critical.length} critical finding(s)`,
  );

  return auditResult;
}

// ── Prompt assembly ────────────────────────────────────────────────

function buildUserMessage(
  contract: SprintContract,
  evaluation: EvaluationRunResult | null,
  projectRoot: string,
  stackLabel: string,
  skillName: string | null,
  promptFragment: string,
  priors: SecurityFinding[],
): string {
  const contractId = contract.contractId;
  const contractJson = JSON.stringify(contract, null, 2);

  // Standalone mode (evaluation === null) omits the evaluation-context
  // section entirely — sc-2-5.
  const evalSection =
    evaluation !== null
      ? `# Evaluation Result (Already Passed)\n\n${JSON.stringify(
          {
            passed: evaluation.passed,
            score: evaluation.score,
            summary: evaluation.summary,
            timestamp: evaluation.timestamp,
          },
          null,
          2,
        )}\n\n`
      : "";

  // Sprint-5 seam: deterministic scanner priors, rendered only when present.
  const priorsSection =
    priors.length > 0
      ? `# Deterministic scanner findings (ground truth priors)\n\n${JSON.stringify(priors, null, 2)}\n\n`
      : "";

  return `# Sprint Contract

${contractJson}

${evalSection}${priorsSection}# Stack Security Context

Stack: ${stackLabel}
Skill: ${skillName ?? "none (generic taxonomy only)"}

${promptFragment}

# Project Root

${projectRoot}

# Context

- Contract ID: ${contractId}
- Spec ID: ${contract.specId}
- Mode: ${evaluation === null ? "standalone (no prior evaluation context)" : "in-pipeline (post-evaluation)"}

# Your Task

Audit the sprint's changes for exploitable security vulnerabilities. You have Read/Grep/Glob
only (no Bash, no git) — use them to:
1. Read .bober/contracts/${contractId}.json for scope, including its \`estimatedFiles\` list
2. Use Glob to enumerate the in-scope files (the \`estimatedFiles\` patterns, or the relevant
   project directories when that list is empty) and Read each one in full; there is no diff
   available without Bash, so audit the CURRENT content of each in-scope file
3. Use Grep to search across the codebase for suspicious patterns (hardcoded secrets, unsafe
   string interpolation into a query/shell/template, missing auth checks) that Read alone
   might miss
4. Review each file against the vulnerability taxonomy and stack-specific checklist above
5. Produce a ReviewResult JSON, findings organised by VulnClass, cited with path+line+snippet

Output ONLY a JSON object (no markdown fences, no surrounding prose):
{
  "reviewId": "security-audit-${contractId}-<ISO-timestamp>",
  "contractId": "${contractId}",
  "specId": "${contract.specId}",
  "timestamp": "<ISO-8601>",
  "summary": "<2-3 sentence overall assessment>",
  "critical": [],
  "important": [],
  "minor": [],
  "approvedAreas": []
}`;
}

// ── Fail-closed JSON parser ────────────────────────────────────────

/**
 * Parse the security auditor's response into a ReviewResult.
 *
 * Reuses the same resilient extraction ladder as
 * code-reviewer-agent.ts:parseReviewResult (direct parse → markdown-fence →
 * first-`{`-to-last-`}` slice), but INVERTS its fallback: on any parse
 * failure (garbage text, truncated JSON, non-object shape), this returns
 * `parsed:false` with an empty review — never a silently "clean" result.
 * The caller forces `verdict:'blocked'` whenever `parsed` is false.
 *
 * A genuinely clean audit (empty critical, well-formed JSON) is
 * `parsed:true` — distinguishable from the parse-failure case.
 */
export function parseSecurityAuditResult(
  text: string,
  contractId: string,
  specId: string,
): { review: ReviewResult; parsed: boolean } {
  const timestamp = new Date().toISOString();
  let parsedJson: unknown;

  // Try direct parse
  try {
    parsedJson = JSON.parse(text.trim());
  } catch {
    // Try extracting from markdown fences
    const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(text);
    if (fenceMatch) {
      try {
        parsedJson = JSON.parse(fenceMatch[1].trim());
      } catch {
        // Fall through
      }
    }

    // Try finding { ... }
    if (parsedJson === undefined) {
      const braceStart = text.indexOf("{");
      const braceEnd = text.lastIndexOf("}");
      if (braceStart !== -1 && braceEnd > braceStart) {
        try {
          parsedJson = JSON.parse(text.slice(braceStart, braceEnd + 1));
        } catch {
          // Fall through to fail-closed default below
        }
      }
    }
  }

  // A JSON array is technically valid JSON but not a ReviewResult shape —
  // treating it as "parsed" would manufacture a fake clean review out of the
  // wrong shape. Fail-closed requires an actual object, never an array.
  if (parsedJson && typeof parsedJson === "object" && !Array.isArray(parsedJson)) {
    const obj = parsedJson as Record<string, unknown>;

    const review: ReviewResult = {
      reviewId:
        typeof obj.reviewId === "string" ? obj.reviewId : `security-audit-${contractId}-${timestamp}`,
      contractId: typeof obj.contractId === "string" ? obj.contractId : contractId,
      specId: typeof obj.specId === "string" ? obj.specId : specId,
      timestamp: typeof obj.timestamp === "string" ? obj.timestamp : timestamp,
      summary: typeof obj.summary === "string" ? obj.summary : "No summary provided.",
      critical: parseSecurityFindingArray(obj.critical),
      important: parseSecurityFindingArray(obj.important),
      minor: parseSecurityFindingArray(obj.minor),
      approvedAreas: parseStringArray(obj.approvedAreas),
    };

    return { review, parsed: true };
  }

  // Fail-closed fallback — auditor ran but the response was NOT parseable.
  // Unlike parseReviewResult's fallback, this is a signal the caller MUST
  // act on: parsed:false forces verdict:'blocked', never a silent pass.
  return {
    review: {
      reviewId: `security-audit-${contractId}-${timestamp}`,
      contractId,
      specId,
      timestamp,
      summary: "Security auditor output could not be parsed.",
      critical: [],
      important: [],
      minor: [],
      approvedAreas: [],
    },
    parsed: false,
  };
}

function isVulnClass(value: string): value is VulnClass {
  return (ALL_VULN_CLASSES as string[]).includes(value);
}

function parseSecurityFindingArray(raw: unknown): SecurityFinding[] {
  if (!Array.isArray(raw)) return [];

  return (raw as unknown[])
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item): SecurityFinding => ({
      description: typeof item.description === "string" ? item.description : "Unknown finding",
      evidence: parseEvidenceArray(item.evidence),
      ...(typeof item.antiPattern === "string" ? { antiPattern: item.antiPattern } : {}),
      ...(typeof item.source === "string" ? { source: item.source } : {}),
      ...(typeof item.vulnClass === "string" && isVulnClass(item.vulnClass)
        ? { vulnClass: item.vulnClass }
        : {}),
    }));
}

function parseEvidenceArray(raw: unknown): ReviewFinding["evidence"] {
  if (!Array.isArray(raw)) return [];

  return (raw as unknown[])
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      path: typeof item.path === "string" ? item.path : "unknown",
      line: typeof item.line === "number" ? item.line : 0,
      snippet: typeof item.snippet === "string" ? item.snippet : "",
    }));
}

function parseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).filter((item): item is string => typeof item === "string");
}
