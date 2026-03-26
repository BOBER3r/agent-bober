import Anthropic from "@anthropic-ai/sdk";

import type { BoberConfig } from "../config/schema.js";
import type { ContextHandoff } from "./context-handoff.js";
import { serializeHandoff } from "./context-handoff.js";
import type { EvalResult } from "../contracts/eval-result.js";
import {
  createDefaultRegistry,
  runEvaluation,
} from "../evaluators/registry.js";
import type { EvaluationRunResult } from "../evaluators/registry.js";
import { getChangedFiles } from "../utils/git.js";
import { logger } from "../utils/logger.js";

export type { EvaluationRunResult } from "../evaluators/registry.js";

// ── Model mapping ──────────────────────────────────────────────────

function resolveModel(choice: string): string {
  switch (choice) {
    case "opus":
      return "claude-sonnet-4-20250514";
    case "sonnet":
      return "claude-sonnet-4-20250514";
    case "haiku":
      return "claude-haiku-4-20250414";
    default:
      return "claude-sonnet-4-20250514";
  }
}

// ── Agent Evaluation System Prompt ─────────────────────────────────

const EVALUATOR_SYSTEM_PROMPT = `You are the Bober Evaluator agent. Your job is to qualitatively assess whether a sprint's implementation meets its contract criteria.

You will receive:
- The sprint contract with success criteria
- The context handoff with implementation notes
- Results from automated checks (typecheck, lint, tests, etc.)

For each success criterion that cannot be automatically verified, assess whether it has been met based on the implementation description and changed files.

Output format — respond with a JSON object:
{
  "evaluator": "Agent Evaluation",
  "passed": true/false,
  "score": 0-100,
  "details": [
    {
      "criterion": "criterion id or description",
      "passed": true/false,
      "message": "explanation",
      "severity": "error" | "warning" | "info"
    }
  ],
  "summary": "Overall assessment",
  "feedback": "Actionable feedback for the generator if anything needs fixing",
  "timestamp": "<ISO datetime>"
}

Guidelines:
- Be thorough but fair. If the implementation reasonably meets a criterion, mark it as passed.
- If automated checks already cover a criterion, you can defer to their results.
- Focus on criteria that require human-like judgment: code quality, architectural decisions, completeness.
- Provide specific, actionable feedback when something fails.

Output ONLY the JSON object. No markdown fences, no explanation.`;

// ── Main ───────────────────────────────────────────────────────────

/**
 * Run the evaluator agent, combining programmatic evaluation (plugins)
 * with agent-based qualitative evaluation.
 *
 * @param handoff  Context handoff for the current sprint.
 * @param projectRoot  Absolute path to the project.
 * @param config  The resolved bober configuration.
 * @returns A combined EvaluationRunResult.
 */
export async function runEvaluatorAgent(
  handoff: ContextHandoff,
  projectRoot: string,
  config: BoberConfig,
): Promise<EvaluationRunResult> {
  const contract = handoff.currentContract;
  if (!contract) {
    throw new Error("No current contract in handoff for evaluation.");
  }

  const sprintId = contract.id;

  logger.sprint(sprintId, `Evaluating: ${contract.feature}`);

  // 1. Programmatic evaluation — run registered evaluator plugins
  logger.info("Running programmatic evaluations...");
  const registry = await createDefaultRegistry(config);

  let changedFiles: string[];
  try {
    changedFiles = handoff.changedFiles.length > 0
      ? handoff.changedFiles
      : await getChangedFiles(projectRoot);
  } catch {
    changedFiles = handoff.changedFiles;
  }

  const programmaticEval = await runEvaluation(
    registry,
    projectRoot,
    config,
    contract,
    changedFiles,
  );

  for (const result of programmaticEval.results) {
    const icon = result.passed ? "PASS" : "FAIL";
    logger.debug(`  [${icon}] ${result.evaluator}: ${result.summary}`);
  }

  // 2. Agent evaluation — qualitative assessment via Claude
  logger.info("Running agent evaluation...");
  const agentResult = await runAgentEvaluation(
    handoff,
    programmaticEval.results,
    config,
  );

  // 3. Combine results: merge the agent result into the programmatic evaluation
  const allResults = [...programmaticEval.results, agentResult];

  const scoredResults = allResults.filter((r) => r.score !== undefined);
  const avgScore =
    scoredResults.length > 0
      ? Math.round(
          scoredResults.reduce((sum, r) => sum + (r.score ?? 0), 0) /
            scoredResults.length,
        )
      : 0;

  const passedCount = allResults.filter((r) => r.passed).length;
  const summaryParts = [
    `Evaluation complete: ${passedCount}/${allResults.length} evaluators passed`,
    `Score: ${avgScore}/100`,
  ];

  const evaluation: EvaluationRunResult = {
    passed: programmaticEval.passed && agentResult.passed,
    score: avgScore,
    results: allResults,
    summary: summaryParts.join(". "),
    timestamp: new Date().toISOString(),
  };

  const statusLabel = evaluation.passed ? "PASSED" : "FAILED";
  logger.sprint(sprintId, `Evaluation ${statusLabel}`);

  return evaluation;
}

/**
 * Run the agent-based qualitative evaluation.
 */
async function runAgentEvaluation(
  handoff: ContextHandoff,
  programmaticResults: EvalResult[],
  config: BoberConfig,
): Promise<EvalResult> {
  const model = resolveModel(config.evaluator.model);
  const client = new Anthropic();
  const timestamp = new Date().toISOString();

  const handoffJson = serializeHandoff(handoff);

  const programmaticSummary = programmaticResults
    .map((r) => `[${r.passed ? "PASS" : "FAIL"}] ${r.evaluator}: ${r.summary}`)
    .join("\n");

  const userMessage = `# Context Handoff
${handoffJson}

# Automated Check Results
${programmaticSummary}

Evaluate whether the sprint contract criteria have been met. Focus on criteria that automated checks cannot verify.

Output ONLY a JSON object matching the EvalResult schema. No markdown fences.`;

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: EVALUATOR_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: userMessage,
        },
      ],
    });

    let responseText = "";
    for (const block of response.content) {
      if (block.type === "text") {
        responseText += block.text;
      }
    }

    return parseEvalResult(responseText, timestamp);
  } catch (err) {
    logger.warn(
      `Agent evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
    );

    return {
      evaluator: "Agent Evaluation",
      passed: true, // Don't block on agent eval failure
      score: undefined,
      details: [],
      summary: "Agent evaluation could not be performed.",
      feedback: `Agent evaluation error: ${err instanceof Error ? err.message : String(err)}`,
      timestamp,
    };
  }
}

/**
 * Parse the evaluator agent's response into an EvalResult.
 */
function parseEvalResult(text: string, fallbackTimestamp: string): EvalResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text.trim());
  } catch {
    const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(text);
    if (fenceMatch) {
      try {
        parsed = JSON.parse(fenceMatch[1].trim());
      } catch {
        // Fall through
      }
    }

    if (!parsed) {
      const braceStart = text.indexOf("{");
      const braceEnd = text.lastIndexOf("}");
      if (braceStart !== -1 && braceEnd > braceStart) {
        try {
          parsed = JSON.parse(text.slice(braceStart, braceEnd + 1));
        } catch {
          // Fall through
        }
      }
    }
  }

  if (parsed && typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;

    const details = Array.isArray(obj.details)
      ? (obj.details as unknown[])
          .filter(
            (d): d is Record<string, unknown> =>
              typeof d === "object" && d !== null,
          )
          .map((d) => ({
            criterion: String(d.criterion ?? "unknown"),
            passed: Boolean(d.passed),
            message: String(d.message ?? ""),
            severity: (["error", "warning", "info"].includes(
              String(d.severity),
            )
              ? String(d.severity)
              : "info") as "error" | "warning" | "info",
            ...(typeof d.file === "string" ? { file: d.file } : {}),
            ...(typeof d.line === "number" ? { line: d.line } : {}),
          }))
      : [];

    return {
      evaluator: String(obj.evaluator ?? "Agent Evaluation"),
      passed: Boolean(obj.passed),
      score: typeof obj.score === "number" ? obj.score : undefined,
      details,
      summary: String(obj.summary ?? "No summary provided."),
      feedback: String(obj.feedback ?? "No feedback provided."),
      timestamp:
        typeof obj.timestamp === "string" ? obj.timestamp : fallbackTimestamp,
    };
  }

  return {
    evaluator: "Agent Evaluation",
    passed: false,
    details: [],
    summary: "Failed to parse agent evaluation response.",
    feedback: `Raw response:\n${text.slice(0, 500)}`,
    timestamp: fallbackTimestamp,
  };
}
