import type { BoberConfig } from "../config/schema.js";
import type { ContextHandoff } from "./context-handoff.js";
import { serializeHandoff } from "./context-handoff.js";
import type { EvalResult } from "../contracts/eval-result.js";
import {
  createDefaultRegistry,
  runEvaluation,
} from "../evaluators/registry.js";
import type { EvaluationRunResult } from "../evaluators/registry.js";
import { createClient } from "../providers/factory.js";
import { getChangedFiles } from "../utils/git.js";
import { logger } from "../utils/logger.js";
import { resolveModel } from "./model-resolver.js";
import { loadAgentDefinition } from "./agent-loader.js";
import { buildToolSet } from "./tools/index.js";
import { runAgenticLoop } from "./agentic-loop.js";

export type { EvaluationRunResult } from "../evaluators/registry.js";

// ── Constants ──────────────────────────────────────────────────────

const EVALUATOR_MAX_TURNS = 25;

// ── Main ───────────────────────────────────────────────────────────

/**
 * Run the evaluator agent, combining programmatic evaluation (plugins)
 * with agent-based qualitative evaluation using tools.
 *
 * The evaluator agent can read files, run bash commands (tests, dev server,
 * screenshots), and search the codebase — but CANNOT write or edit files.
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

  const sprintId = contract.contractId;

  logger.sprint(sprintId, `Evaluating: ${contract.title}`);

  // 1. Programmatic evaluation — run registered evaluator plugins
  logger.info("Running programmatic evaluations...");
  const registry = await createDefaultRegistry(config);

  let changedFiles: string[];
  try {
    changedFiles =
      handoff.changedFiles.length > 0
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

  // 2. Agent evaluation — qualitative assessment via agentic loop with tools
  logger.info("Running agent evaluation...");
  const agentResult = await runAgentEvaluation(
    handoff,
    programmaticEval.results,
    projectRoot,
    config,
  );

  // 3. Combine results
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

// ── Agent evaluation with tools ────────────────────────────────────

/**
 * Run the agent-based qualitative evaluation using a multi-turn agentic
 * loop with bash, read_file, glob, and grep tools.
 *
 * The evaluator can run commands, take screenshots, inspect code, start
 * dev servers, and curl endpoints — but CANNOT write or edit files.
 */
async function runAgentEvaluation(
  handoff: ContextHandoff,
  programmaticResults: EvalResult[],
  projectRoot: string,
  config: BoberConfig,
): Promise<EvalResult> {
  const timestamp = new Date().toISOString();

  try {
    // Load agent definition (system prompt from .md file)
    const agentDef = await loadAgentDefinition("bober-evaluator", projectRoot);
    const model = resolveModel(config.evaluator.model);

    // Build tool set (evaluator: bash, read_file, glob, grep — NO write/edit)
    const toolSet = buildToolSet("evaluator", projectRoot);

    const client = createClient(
      config.evaluator.provider ?? null,
      config.evaluator.endpoint ?? null,
      config.evaluator.providerConfig,
      config.evaluator.model,
    );
    const handoffJson = serializeHandoff(handoff);

    // Format programmatic results for context
    const programmaticSummary = programmaticResults
      .map((r) => {
        const lines = [`[${r.passed ? "PASS" : "FAIL"}] ${r.evaluator}: ${r.summary}`];
        if (!r.passed && r.feedback) {
          lines.push(`  Feedback: ${r.feedback}`);
        }
        for (const detail of r.details) {
          if (!detail.passed) {
            const loc = detail.file
              ? ` at ${detail.file}${detail.line !== undefined ? `:${detail.line}` : ""}`
              : "";
            lines.push(
              `  [${detail.severity.toUpperCase()}] ${detail.message}${loc}`,
            );
          }
        }
        return lines.join("\n");
      })
      .join("\n\n");

    const userMessage = `# Context Handoff
${handoffJson}

# Project Root
${projectRoot}

# Automated Check Results (already completed)
${programmaticSummary}

# Success Criteria
Verify every criterion listed in the contract's successCriteria array in the handoff above.

# Your Task
Evaluate whether the sprint contract criteria have been met. Use your tools to:
1. Read the relevant source files to verify implementation
2. Run the dev server and test the application if applicable
3. Take Playwright screenshots if applicable: \`npx playwright screenshot http://localhost:3000 /tmp/bober-eval.png --full-page\`
4. Run any additional verification commands
5. Check for regressions

Be skeptical. Verify independently. Do not trust the generator's self-report alone.

Your final response must contain ONLY a JSON object matching this schema (no markdown fences):
{
  "evaluator": "Agent Evaluation",
  "passed": true/false,
  "score": 0-100,
  "details": [
    {
      "criterion": "criterion id or description",
      "passed": true/false,
      "message": "explanation with evidence",
      "severity": "error" | "warning" | "info",
      "file": "file path if applicable",
      "line": 123
    }
  ],
  "summary": "Overall assessment",
  "feedback": "Actionable feedback for the generator if anything needs fixing",
  "timestamp": "${timestamp}"
}`;

    logger.info(
      `Calling evaluator model (${config.evaluator.model} → ${model})...`,
    );

    const result = await runAgenticLoop({
      client,
      model,
      systemPrompt: agentDef.systemPrompt,
      userMessage,
      tools: toolSet.schemas,
      toolHandlers: toolSet.handlers,
      maxTurns: EVALUATOR_MAX_TURNS,
      maxTokens: 16384,
      onToolUse: (name, input) => {
        const inp = input as Record<string, unknown>;
        const inputStr = JSON.stringify(inp).slice(0, 120);
        logger.debug(`  [evaluator] ${name}(${inputStr})`);
      },
    });

    logger.debug(
      `Evaluator completed in ${result.turnsUsed} turns (${result.toolsCalled.length} tool calls)`,
    );

    return parseEvalResult(result.finalText, timestamp);
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

// ── JSON parser ────────────────────────────────────────────────────

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
