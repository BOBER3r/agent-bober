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
import { ALL_VULN_CLASSES } from "./stack-knowledge.js";
import { resolveStackSecurityContext } from "./security-knowledge/resolver.js";
import { SecurityKnowledgeIndex } from "./security-knowledge/index.js";
import { runScannerPreFilter, isNetworkScanner } from "./security-scanners.js";
import type { AuditDiff, SecurityDiffProvider } from "./security-knowledge/diff-provider.js";
import { securityDiffProvider, extractDiffKeywords } from "./security-knowledge/diff-provider.js";
import { inspectSupplyChain } from "./security-knowledge/supply-chain-inspector.js";
import { logger } from "../utils/logger.js";

/**
 * Injectable dependencies for `runSecurityAudit` (sprint 6). Currently
 * exposes only the diff provider so tests never shell real git; the
 * default resolves to the real `securityDiffProvider`.
 */
export interface SecurityAuditDeps {
  diffProvider?: SecurityDiffProvider;
}

// bober: one memoised index per process (ADR-7, no runtime invalidation) —
// swap for an injectable dependency if per-request skill reloading is ever needed.
let sharedSecurityKnowledgeIndex: SecurityKnowledgeIndex | null = null;

function getSecurityKnowledgeIndex(): SecurityKnowledgeIndex {
  if (!sharedSecurityKnowledgeIndex) {
    sharedSecurityKnowledgeIndex = new SecurityKnowledgeIndex();
  }
  return sharedSecurityKnowledgeIndex;
}

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
 * @param deps        Injectable dependencies (sprint 6) — currently just the
 *                    diff provider, defaulting to the real `securityDiffProvider`.
 *                    Appended last so all existing positional callers stay
 *                    byte-compatible.
 * @returns A SecurityAuditResult, already persisted via saveSecurityAudit.
 */
export async function runSecurityAudit(
  contract: SprintContract,
  evaluation: EvaluationRunResult | null,
  projectRoot: string,
  config: BoberConfig,
  priors: SecurityFinding[] = [],
  deps: SecurityAuditDeps = {},
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

  const knowledgeIndex = getSecurityKnowledgeIndex();
  await knowledgeIndex.load();

  // Sprint-6: compute the real diff ONCE (opt-in via config.security.diff.mode
  // === 'git-diff'; default 'estimated-files' keeps today's exact behavior).
  // The diff is read-only input to the resolver/selector/finder — git runs
  // ONLY here, in orchestrator Node, never as an auditor tool (ADR-5).
  let changedPaths = contract.estimatedFiles;
  let diffKeywords: string[] = [];
  let auditDiff: AuditDiff | undefined;
  if (config.security?.diff?.mode === "git-diff") {
    const provider = deps.diffProvider ?? securityDiffProvider;
    const diffAbort = new AbortController();
    const diffTimer = setTimeout(() => diffAbort.abort(), config.security?.timeoutMs ?? 300_000);
    try {
      auditDiff = await provider.compute({
        projectRoot,
        baseRef: config.security.diff.baseRef,
        expandWithGraph: config.security.diff.expandWithGraph,
        signal: diffAbort.signal,
        config,
      });
    } finally {
      clearTimeout(diffTimer);
    }

    // Empty diff (no changes / provider failure) falls back to estimatedFiles
    // — no regression from today's behavior (sc-6-5).
    const files = auditDiff.changedFiles.map((f) => f.path);
    if (files.length > 0) {
      changedPaths = files;
      diffKeywords = extractDiffKeywords(auditDiff.changedFiles);
    }
  }

  const ctx = await resolveStackSecurityContext({
    stack: config.project.stack,
    changedPaths,
    diffKeywords,
    index: knowledgeIndex,
  });

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

  // Sprint-7 seam (supply-chain axis, ADR-4): when supplyChain.enabled, fold
  // both the (network-gated) scanner pre-filter and the always-available
  // OFFLINE diff inspector into effectivePriors. Network-capable scanner
  // kinds (npm-audit/osv-scanner) only run when egress.onlineResearch is
  // explicitly true (default false); gitleaks and the offline inspector run
  // regardless of egress — neither one touches the network. The offline
  // inspector runs even when zero external scanners are configured; it is
  // itself the "always-available" half of the axis.
  const supplyChain = config.security?.supplyChain;
  if (supplyChain?.enabled) {
    const scAbort = new AbortController();
    const scTimer = setTimeout(
      () => scAbort.abort(),
      config.security?.timeoutMs ?? 300_000,
    );
    try {
      const onlineOk = config.security?.egress?.onlineResearch === true;
      const scScanners = onlineOk
        ? (supplyChain.scanners ?? [])
        : (supplyChain.scanners ?? []).filter((s) => !isNetworkScanner(s));

      const scannerPriors =
        scScanners.length > 0
          ? await runScannerPreFilter({ scanners: scScanners, projectRoot, signal: scAbort.signal })
          : [];

      const inspectorPriors = auditDiff
        ? await inspectSupplyChain({ projectRoot, diff: auditDiff, signal: scAbort.signal })
        : [];

      effectivePriors = [...effectivePriors, ...scannerPriors, ...inspectorPriors];
    } finally {
      clearTimeout(scTimer);
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
    auditDiff,
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

/**
 * Renders the "# Changed files (real diff)" section (Pattern D — empty
 * string when there's no diff, so git-diff-mode-with-no-changes produces a
 * prompt byte-identical to estimated-files mode, sc-6-5).
 */
function renderChangedFilesSection(auditDiff: AuditDiff | undefined): string {
  if (!auditDiff || auditDiff.changedFiles.length === 0) return "";

  const filesText = auditDiff.changedFiles
    .map((f) => {
      const hunksText = f.hunks.length > 0 ? f.hunks.map((h) => h.content).join("\n\n") : "(no hunks captured)";
      return `## ${f.path} (${f.status})\n\n${hunksText}`;
    })
    .join("\n\n");

  const neighborhoodText =
    auditDiff.neighborhoodFiles.length > 0
      ? `\n\nCall-graph neighborhood (files affected by the changes above):\n${auditDiff.neighborhoodFiles.join("\n")}`
      : "";

  const truncatedText = auditDiff.truncated
    ? "\n\n(diff truncated — showing a bounded subset of changed files/hunks)"
    : "";

  return `# Changed files (real diff)\n\n${filesText}${neighborhoodText}${truncatedText}\n\n`;
}

function buildUserMessage(
  contract: SprintContract,
  evaluation: EvaluationRunResult | null,
  projectRoot: string,
  stackLabel: string,
  skillName: string | null,
  promptFragment: string,
  priors: SecurityFinding[],
  auditDiff?: AuditDiff,
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

  // Sprint-6 seam: real changed files/hunks, rendered only when present.
  const changedFilesSection = renderChangedFilesSection(auditDiff);
  const hasRealDiff = (auditDiff?.changedFiles.length ?? 0) > 0;

  const scopeInstruction = hasRealDiff
    ? 'Use the "# Changed files (real diff)" section above — it lists the ACTUAL changed files/hunks for ' +
      "this sprint; Read each changed file in full for surrounding context, and ground findings in the " +
      "real diff rather than guessing from `estimatedFiles`"
    : "Use Glob to enumerate the in-scope files (the `estimatedFiles` patterns, or the relevant\n" +
      "   project directories when that list is empty) and Read each one in full; there is no diff\n" +
      "   available without Bash, so audit the CURRENT content of each in-scope file";

  return `# Sprint Contract

${contractJson}

${evalSection}${priorsSection}${changedFilesSection}# Stack Security Context

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
only (no Bash, no git)${hasRealDiff ? ' — a real diff IS provided inline above ("# Changed files (real diff)" section)' : ""} — use them to:
1. Read .bober/contracts/${contractId}.json for scope, including its \`estimatedFiles\` list
2. ${scopeInstruction}
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
