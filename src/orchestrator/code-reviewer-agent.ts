import type { BoberConfig } from "../config/schema.js";
import type { SprintContract } from "../contracts/sprint-contract.js";
import type { EvaluationRunResult } from "../evaluators/registry.js";
import { createClient } from "../providers/factory.js";
import { logger } from "../utils/logger.js";
import { resolveModel } from "./model-resolver.js";
import { assembleSystemPrompt } from "./agent-loader.js";
import { resolveRoleTools, getGraphState, getGraphDeps } from "./tools/index.js";
import { runAgenticLoop } from "./agentic-loop.js";
import { saveReview } from "../state/review-state.js";

// ── Types ──────────────────────────────────────────────────────────

/**
 * A finding in the ReviewResult — one entry in critical, important, or minor arrays.
 */
export interface ReviewFinding {
  description: string;
  evidence: Array<{ path: string; line: number; snippet: string }>;
  antiPattern?: string;
  source?: string;
}

/**
 * The structured result emitted by the bober-code-reviewer subagent.
 */
export interface ReviewResult {
  reviewId: string;
  contractId: string;
  specId: string;
  timestamp: string;
  summary: string;
  critical: ReviewFinding[];
  important: ReviewFinding[];
  minor: ReviewFinding[];
  approvedAreas: string[];
}

// ── Main ───────────────────────────────────────────────────────────

/**
 * Run the bober-code-reviewer subagent for advisory code review.
 *
 * Runs AFTER the evaluator returns passed=true. The review is advisory:
 * findings surface in the run history but do NOT block sprint completion,
 * do NOT trigger generator retry, and do NOT mutate contract status.
 *
 * @param contract    The sprint contract that just passed.
 * @param evaluation  The evaluation result (passed=true) from runEvaluatorAgent.
 * @param projectRoot Absolute path to the project root.
 * @param config      The resolved bober configuration.
 * @returns A ReviewResult with structured findings.
 */
export async function runCodeReviewer(
  contract: SprintContract,
  evaluation: EvaluationRunResult,
  projectRoot: string,
  config: BoberConfig,
): Promise<ReviewResult> {
  const contractId = contract.contractId;
  logger.sprint(contractId, `Code review: ${contract.title}`);

  const reviewerModel = config.codeReview?.model ?? config.evaluator.model;
  const model = resolveModel(reviewerModel);
  const maxTurns = config.codeReview?.maxTurns ?? 15;

  // Code reviewer reuses the "evaluator" role tool set — read-only (bash, read, grep, glob).
  // Adding a distinct role is a separate refactor — out of scope per contract s5-c9.
  const graphState = getGraphState(config);
  const graphDeps = graphState.engineHealth === "ready" ? getGraphDeps() : undefined;
  const toolSet = resolveRoleTools("evaluator", projectRoot, graphState, graphDeps ?? undefined);
  const systemPrompt = await assembleSystemPrompt("evaluator", "bober-code-reviewer", projectRoot, graphState);

  const client = createClient(
    config.codeReview?.provider ?? config.evaluator.provider ?? null,
    config.codeReview?.endpoint ?? config.evaluator.endpoint ?? null,
    config.codeReview?.providerConfig ?? config.evaluator.providerConfig,
    reviewerModel,
    "CodeReviewer",
  );

  const contractJson = JSON.stringify(contract, null, 2);
  const evalSummary = JSON.stringify(
    {
      passed: evaluation.passed,
      score: evaluation.score,
      summary: evaluation.summary,
      timestamp: evaluation.timestamp,
    },
    null,
    2,
  );

  const userMessage = `# Sprint Contract

${contractJson}

# Evaluation Result (Already Passed)

${evalSummary}

# Project Root

${projectRoot}

# Context

- Contract ID: ${contractId}
- Spec ID: ${contract.specId}
- Review is ADVISORY ONLY — findings do NOT block completion or trigger retries

# Anti-Pattern Catalog

The catalog index is at .bober/anti-patterns/README.md. Consult it BEFORE classifying severity.
Catalogued anti-patterns:
- Testing anti-patterns → .bober/anti-patterns/testing-anti-patterns.md
- Condition-based waiting → .bober/anti-patterns/condition-based-waiting.md
- Root-cause tracing → .bober/anti-patterns/root-cause-tracing.md
- Defense in depth → .bober/anti-patterns/defense-in-depth.md

# Your Task

Review the sprint diff. Use your tools to:
1. Read .bober/contracts/${contractId}.json and .bober/anti-patterns/README.md
2. Run git diff HEAD~1 --stat to see what changed
3. Review each changed file for DRY violations, YAGNI, dead code, missing tests, anti-patterns
4. Produce a ReviewResult JSON

Output ONLY a JSON object (no markdown fences):
{
  "reviewId": "review-${contractId}-<ISO-timestamp>",
  "contractId": "${contractId}",
  "specId": "${contract.specId}",
  "timestamp": "<ISO-8601>",
  "summary": "<2-3 sentence overall assessment>",
  "critical": [],
  "important": [],
  "minor": [],
  "approvedAreas": []
}`;

  logger.info(`Calling code reviewer model (${reviewerModel} → ${model})...`);

  const result = await runAgenticLoop({
    client,
    model,
    systemPrompt,
    userMessage,
    tools: toolSet.schemas,
    toolHandlers: toolSet.handlers,
    maxTurns,
    maxTokens: 16384,
    onToolUse: (name, input) => {
      const inp = input as Record<string, unknown>;
      const inputStr = JSON.stringify(inp).slice(0, 120);
      logger.debug(`  [code-reviewer] ${name}(${inputStr})`);
    },
  });

  logger.debug(
    `Code reviewer completed in ${result.turnsUsed} turns (${result.toolsCalled.length} tool calls)`,
  );

  const reviewResult = parseReviewResult(result.finalText, contractId, contract.specId);

  // Write the review markdown to .bober/reviews/<contractId>-review.md
  const markdown = renderReviewMarkdown(reviewResult);
  await saveReview(projectRoot, contractId, markdown);

  logger.info(
    `Code review complete: ${reviewResult.critical.length} critical, ${reviewResult.important.length} important, ${reviewResult.minor.length} minor findings`,
  );

  return reviewResult;
}

// ── Markdown renderer ──────────────────────────────────────────────

/**
 * Render a ReviewResult into the 6-section markdown format required by s5-c5.
 */
function renderReviewMarkdown(review: ReviewResult): string {
  const lines: string[] = [];

  lines.push(`# Code Review: ${review.contractId}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(review.summary);
  lines.push("");
  lines.push("## Critical");
  lines.push("");

  if (review.critical.length === 0) {
    lines.push("No critical findings.");
  } else {
    for (const finding of review.critical) {
      lines.push(`- **${finding.description}**`);
      for (const ev of finding.evidence) {
        lines.push(`  - \`${ev.path}:${ev.line}\`: ${ev.snippet}`);
      }
      if (finding.antiPattern) {
        lines.push(`  - Anti-pattern: ${finding.antiPattern} (${finding.source ?? ""})`);
      }
    }
  }

  lines.push("");
  lines.push("## Important");
  lines.push("");

  if (review.important.length === 0) {
    lines.push("No important findings.");
  } else {
    for (const finding of review.important) {
      lines.push(`- **${finding.description}**`);
      for (const ev of finding.evidence) {
        lines.push(`  - \`${ev.path}:${ev.line}\`: ${ev.snippet}`);
      }
    }
  }

  lines.push("");
  lines.push("## Minor");
  lines.push("");

  if (review.minor.length === 0) {
    lines.push("No minor findings.");
  } else {
    for (const finding of review.minor) {
      lines.push(`- **${finding.description}**`);
      for (const ev of finding.evidence) {
        lines.push(`  - \`${ev.path}:${ev.line}\`: ${ev.snippet}`);
      }
    }
  }

  lines.push("");
  lines.push("## Approved Areas");
  lines.push("");

  if (review.approvedAreas.length === 0) {
    lines.push("No areas specifically called out.");
  } else {
    for (const area of review.approvedAreas) {
      lines.push(`- ${area}`);
    }
  }

  lines.push("");
  lines.push(`---`);
  lines.push(`*Review ID: ${review.reviewId} — ${review.timestamp}*`);
  lines.push("");

  return lines.join("\n");
}

// ── JSON parser ────────────────────────────────────────────────────

/**
 * Parse the code reviewer's response into a ReviewResult.
 * Mirrors the resilient JSON-parsing pattern from evaluator-agent.ts:parseEvalResult.
 */
function parseReviewResult(
  text: string,
  contractId: string,
  specId: string,
): ReviewResult {
  const timestamp = new Date().toISOString();
  let parsed: unknown;

  // Try direct parse
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    // Try extracting from markdown fences
    const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(text);
    if (fenceMatch) {
      try {
        parsed = JSON.parse(fenceMatch[1].trim());
      } catch {
        // Fall through
      }
    }

    // Try finding { ... }
    if (!parsed) {
      const braceStart = text.indexOf("{");
      const braceEnd = text.lastIndexOf("}");
      if (braceStart !== -1 && braceEnd > braceStart) {
        try {
          parsed = JSON.parse(text.slice(braceStart, braceEnd + 1));
        } catch {
          // Fall through to default
        }
      }
    }
  }

  if (parsed && typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;

    return {
      reviewId:
        typeof obj.reviewId === "string"
          ? obj.reviewId
          : `review-${contractId}-${timestamp}`,
      contractId:
        typeof obj.contractId === "string" ? obj.contractId : contractId,
      specId: typeof obj.specId === "string" ? obj.specId : specId,
      timestamp:
        typeof obj.timestamp === "string" ? obj.timestamp : timestamp,
      summary:
        typeof obj.summary === "string"
          ? obj.summary
          : "No summary provided.",
      critical: parseFindingArray(obj.critical),
      important: parseFindingArray(obj.important),
      minor: parseFindingArray(obj.minor),
      approvedAreas: parseStringArray(obj.approvedAreas),
    };
  }

  // Fallback — reviewer ran but response wasn't parseable
  return {
    reviewId: `review-${contractId}-${timestamp}`,
    contractId,
    specId,
    timestamp,
    summary: "Code reviewer response could not be parsed.",
    critical: [],
    important: [],
    minor: [],
    approvedAreas: [],
  };
}

function parseFindingArray(raw: unknown): ReviewFinding[] {
  if (!Array.isArray(raw)) return [];

  return (raw as unknown[])
    .filter((item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null,
    )
    .map((item) => ({
      description: typeof item.description === "string" ? item.description : "Unknown finding",
      evidence: parseEvidenceArray(item.evidence),
      ...(typeof item.antiPattern === "string" ? { antiPattern: item.antiPattern } : {}),
      ...(typeof item.source === "string" ? { source: item.source } : {}),
    }));
}

function parseEvidenceArray(
  raw: unknown,
): Array<{ path: string; line: number; snippet: string }> {
  if (!Array.isArray(raw)) return [];

  return (raw as unknown[])
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null,
    )
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
