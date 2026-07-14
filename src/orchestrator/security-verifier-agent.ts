import type { BoberConfig } from "../config/schema.js";
import type { SecurityFinding } from "./security-audit-types.js";
import type { AuditDiff } from "./security-knowledge/diff-provider.js";
import { createClient } from "../providers/factory.js";
import { resolveModel } from "./model-resolver.js";
import { assembleSystemPrompt } from "./agent-loader.js";
import { resolveRoleTools, getGraphState, getGraphDeps } from "./tools/index.js";
import { runAgenticLoop } from "./agentic-loop.js";
import { budgetFromMaxUsd } from "./workflow/budget.js";
import { logger } from "../utils/logger.js";

/**
 * Adversarial, fresh-context, contract-free finder->verifier stage
 * (spec-20260714 sprint 8, ADR-2/ADR-6 default-off).
 *
 * Runs sequentially AFTER the security auditor ("finder") inside
 * `runSecurityAudit`, fed ONLY the finder's `critical`+`important` findings
 * (never `minor`/`approvedAreas`, never the sprint contract — that strips
 * the sycophancy framing a favorably-worded contract creates). It is told
 * to DISPROVE each finding and may only downgrade (`critical`->`important`)
 * or drop a finding — never promote or manufacture a clean pass.
 *
 * Fail-closed, mirroring the finder's own `parsed:false => blocked`
 * inversion: any parse failure, provider error, refusal, or abort resolves
 * `ran:false`, and the caller (`runSecurityAudit`'s fold) KEEPS the finder's
 * findings unchanged.
 */

/** Downgrade-only, fail-closed verifier result. `ran:false` => finder criticals kept. */
export interface VerifierResult {
  /** Confirmed by the verifier — stays at the finder's original severity. */
  verified: SecurityFinding[];
  /** Real but not critical-severity — moves critical->important in the fold. */
  downgraded: SecurityFinding[];
  /** Disproved against the evidence — removed entirely in the fold. */
  dropped: SecurityFinding[];
  /** False on parse-failure / provider error / refusal / abort (fail-closed). */
  ran: boolean;
}

export interface VerifyParams {
  /** The finder's critical + important findings ONLY — never minor/approvedAreas. */
  findings: SecurityFinding[];
  /** The SAME AuditDiff the finder saw; hunks are the re-check evidence. Undefined in estimated-files mode. */
  diff: AuditDiff | undefined;
  projectRoot: string;
  config: BoberConfig;
  /** Time-box for this stage, owned by the caller (keyed to config.security.timeoutMs). */
  signal: AbortSignal;
}

/** Injectable seam so `runSecurityAudit` tests can stub the stage (mirrors `SecurityDiffProvider`). */
export interface SecurityVerifier {
  verify(params: VerifyParams): Promise<VerifierResult>;
}

const FAIL_CLOSED_RESULT: VerifierResult = { verified: [], downgraded: [], dropped: [], ran: false };

export const runSecurityVerifier: SecurityVerifier = {
  async verify(params) {
    const { findings, diff, projectRoot, config, signal } = params;

    // Nothing to verify — a clean no-op. No LLM call needed, and there is
    // nothing to fail-closed on: ran:true with all buckets empty is correct
    // (the fold leaves the finder review completely unchanged either way).
    if (findings.length === 0) {
      return { verified: [], downgraded: [], dropped: [], ran: true };
    }

    const verifierModel = config.security?.verifier?.model ?? "opus";
    const model = resolveModel(verifierModel);
    const maxTurns = config.security?.verifier?.maxTurns ?? 10;

    // The verifier reuses the SAME "curator" read-only role as the finder —
    // no bash/write/edit (nonGoals[0]). No new AgentRole is introduced.
    const graphState = getGraphState(config);
    const graphDeps = graphState.engineHealth === "ready" ? getGraphDeps() : undefined;
    const toolSet = resolveRoleTools("curator", projectRoot, graphState, graphDeps ?? undefined);
    const systemPrompt = await assembleSystemPrompt(
      "curator",
      "bober-security-verifier",
      projectRoot,
      graphState,
    );

    const client = createClient(
      config.security?.provider ?? null,
      config.security?.endpoint ?? null,
      config.security?.providerConfig,
      verifierModel,
      "SecurityVerifier",
    );

    const budget = budgetFromMaxUsd(config.security?.budget?.maxUsd);
    const userMessage = buildVerifierUserMessage(findings, diff);

    let result;
    try {
      result = await runAgenticLoop({
        client,
        model,
        systemPrompt,
        userMessage,
        tools: toolSet.schemas,
        toolHandlers: toolSet.handlers,
        maxTurns,
        maxTokens: 16384,
        ...(budget !== undefined ? { budget } : {}),
        abortSignal: signal,
        onToolUse: (name, input) => {
          const inp = input as Record<string, unknown>;
          const inputStr = JSON.stringify(inp).slice(0, 120);
          logger.debug(`  [security-verifier] ${name}(${inputStr})`);
        },
      });
    } catch (err) {
      // Provider/network error — fail-closed, never propagate a crash out of
      // an opt-in verification stage into the audit path.
      logger.debug(
        `[security-verifier] runAgenticLoop threw: ${
          err instanceof Error ? err.message : String(err)
        } — fail-closed (ran:false)`,
      );
      return { ...FAIL_CLOSED_RESULT };
    }

    logger.debug(
      `Security verifier completed in ${result.turnsUsed} turns (${result.toolsCalled.length} tool calls)`,
    );

    // Abort/error/refusal stop reasons are all fail-closed — never treated
    // as "confirmed everything" or "found nothing to disprove".
    if (result.stopReason === "aborted" || result.stopReason === "error" || result.refused === true) {
      return { ...FAIL_CLOSED_RESULT };
    }

    return parseVerifierResult(result.finalText, findings);
  },
};

// ── Prompt assembly ────────────────────────────────────────────────

/**
 * Renders the "# Changed files (real diff)" section — deliberately the same
 * shape as `security-auditor-agent.ts`'s file-local `renderChangedFilesSection`
 * so the evidence the verifier re-checks against matches what the finder saw.
 * Empty string when there's no diff (estimated-files mode / no changes).
 */
function renderChangedFilesSection(diff: AuditDiff | undefined): string {
  if (!diff || diff.changedFiles.length === 0) return "";

  const filesText = diff.changedFiles
    .map((f) => {
      const hunksText = f.hunks.length > 0 ? f.hunks.map((h) => h.content).join("\n\n") : "(no hunks captured)";
      return `## ${f.path} (${f.status})\n\n${hunksText}`;
    })
    .join("\n\n");

  const neighborhoodText =
    diff.neighborhoodFiles.length > 0
      ? `\n\nCall-graph neighborhood (files affected by the changes above):\n${diff.neighborhoodFiles.join("\n")}`
      : "";

  const truncatedText = diff.truncated
    ? "\n\n(diff truncated — showing a bounded subset of changed files/hunks)"
    : "";

  return `# Changed files (real diff)\n\n${filesText}${neighborhoodText}${truncatedText}\n\n`;
}

/**
 * Builds the verifier's user message from ONLY the findings + diff hunks.
 * Deliberately excludes everything `security-auditor-agent.ts:buildUserMessage`
 * folds in for the finder: no `# Sprint Contract` JSON, no
 * `# Evaluation Result (Already Passed)` section, no priors section — this is
 * the sycophancy-framing strip that makes the verifier a genuinely fresh,
 * unbiased second opinion (sc-8-2).
 */
function buildVerifierUserMessage(findings: SecurityFinding[], diff: AuditDiff | undefined): string {
  const findingsJson = JSON.stringify(
    findings.map((finding, index) => ({ index, ...finding })),
    null,
    2,
  );
  const changedFilesSection = renderChangedFilesSection(diff);

  return `# Findings To Verify

${findingsJson}

${changedFilesSection}# Your Task

You have Read/Grep/Glob only (no Bash, no git). For each finding above:
1. Read the cited path/line and confirm the snippet is genuine and current
2. Check the "# Changed files (real diff)" section (when present) for the actual hunk touching that file
3. Look for a sanitizer, parameterized query, access check, or input-validation guard the finder may have missed
4. Decide whether there is a realistic, externally-triggerable exploit path

Render one verdict per finding: "confirmed" (it holds — stays at its original severity),
"downgraded" (real but not critical-severity — moves critical to important), or "disproved"
(the evidence does not support it — dropped).

Output ONLY a JSON array (no markdown fences, no surrounding prose), one entry per finding,
in this exact shape:
[
  {
    "index": 0,
    "verdict": "confirmed",
    "confidence": "high",
    "reason": "<one-line reason citing what you actually checked>"
  }
]`;
}

// ── Fail-closed JSON parser (mirror image of the auditor's — expects an array) ──

/**
 * Parse the verifier's response into a `VerifierResult`.
 *
 * Reuses the same resilient extraction ladder as
 * `security-auditor-agent.ts:parseSecurityAuditResult` (direct parse ->
 * markdown-fence -> first-bracket-to-last-bracket slice), but INVERTS which
 * JSON shape it accepts: the auditor rejects arrays (it wants a
 * `ReviewResult` object); the verifier REQUIRES an array of per-finding
 * verdicts — any non-array, truncated, or garbage response is fail-closed
 * (`ran:false`).
 *
 * A finding present in `inputFindings` but never addressed by a matched,
 * recognized verdict entry defaults to `verified` — fail-closed means an
 * unaddressed finding is never silently dropped.
 */
export function parseVerifierResult(text: string, inputFindings: SecurityFinding[]): VerifierResult {
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(text.trim());
  } catch {
    const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(text);
    if (fenceMatch) {
      try {
        parsedJson = JSON.parse(fenceMatch[1].trim());
      } catch {
        // Fall through
      }
    }

    if (parsedJson === undefined) {
      const bracketStart = text.indexOf("[");
      const bracketEnd = text.lastIndexOf("]");
      if (bracketStart !== -1 && bracketEnd > bracketStart) {
        try {
          parsedJson = JSON.parse(text.slice(bracketStart, bracketEnd + 1));
        } catch {
          // Fall through to fail-closed default below
        }
      }
    }
  }

  // The verifier is the mirror image of the auditor's parser: it EXPECTS a
  // JSON array. A stray object, truncated JSON, or garbage text is
  // fail-closed — never manufactured into "everything confirmed".
  if (!Array.isArray(parsedJson)) {
    return { ...FAIL_CLOSED_RESULT };
  }

  const verdictEntries = (parsedJson as unknown[]).filter(
    (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
  );

  const bucketed = new Set<SecurityFinding>();
  const verified: SecurityFinding[] = [];
  const downgraded: SecurityFinding[] = [];
  const dropped: SecurityFinding[] = [];

  for (const entry of verdictEntries) {
    const finding = resolveFindingRef(entry, inputFindings);
    if (!finding || bucketed.has(finding)) continue;

    const verdict = typeof entry.verdict === "string" ? entry.verdict : undefined;
    if (verdict === "confirmed") {
      verified.push(finding);
      bucketed.add(finding);
    } else if (verdict === "downgraded") {
      downgraded.push(finding);
      bucketed.add(finding);
    } else if (verdict === "disproved") {
      dropped.push(finding);
      bucketed.add(finding);
    }
    // Any unrecognized/missing verdict value leaves the finding unaddressed —
    // it falls through to the fail-closed default loop below (verified).
  }

  // Fail-closed: a finding never addressed by a matched, recognized verdict
  // (missing entry, unmatched index/signature, unrecognized verdict string)
  // defaults to `verified` — never silently dropped.
  for (const finding of inputFindings) {
    if (!bucketed.has(finding)) verified.push(finding);
  }

  return { verified, downgraded, dropped, ran: true };
}

/**
 * Resolves a verdict entry back to the SAME `SecurityFinding` object
 * reference from `inputFindings` (by 0-based `index`, then `signatureId`,
 * then `path`+`line` in its evidence). Identity-preserving on purpose: the
 * fold in `security-auditor-agent.ts` matches by object identity against the
 * finder's own `critical`/`important` arrays.
 */
function resolveFindingRef(
  entry: Record<string, unknown>,
  inputFindings: SecurityFinding[],
): SecurityFinding | undefined {
  if (typeof entry.index === "number" && Number.isInteger(entry.index)) {
    return inputFindings[entry.index];
  }
  if (typeof entry.signatureId === "string" && entry.signatureId.length > 0) {
    return inputFindings.find((f) => f.signatureId === entry.signatureId);
  }
  if (typeof entry.path === "string" && typeof entry.line === "number") {
    return inputFindings.find((f) =>
      f.evidence.some((e) => e.path === entry.path && e.line === entry.line),
    );
  }
  return undefined;
}
