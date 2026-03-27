import Anthropic from "@anthropic-ai/sdk";

import type { BoberConfig } from "../config/schema.js";
import type { ContextHandoff } from "./context-handoff.js";
import { serializeHandoff } from "./context-handoff.js";
import { logger } from "../utils/logger.js";
import { resolveModel } from "./model-resolver.js";
import { loadAgentDefinition } from "./agent-loader.js";
import { buildToolSet } from "./tools/index.js";
import { runAgenticLoop } from "./agentic-loop.js";

// ── Types ──────────────────────────────────────────────────────────

export interface GeneratorResult {
  success: boolean;
  notes: string;
  filesChanged: string[];
  commitHash?: string;
  /** Number of agentic loop turns used. */
  turnsUsed?: number;
  /** Tools called during generation. */
  toolsCalled?: string[];
  /** Token usage. */
  usage?: { inputTokens: number; outputTokens: number };
}

// ── Main ───────────────────────────────────────────────────────────

/**
 * Run the generator agent to implement changes for a sprint.
 *
 * Uses a multi-turn agentic loop with full tool access (bash, read/write/edit
 * files, glob, grep). The agent actually reads the codebase, writes code,
 * runs tests, and commits — all via tools.
 *
 * The system prompt is loaded from `agents/bober-generator.md`.
 */
export async function runGenerator(
  handoff: ContextHandoff,
  projectRoot: string,
  config: BoberConfig,
): Promise<GeneratorResult> {
  const contractId = handoff.currentContract?.id ?? "unknown";
  const feature = handoff.currentContract?.feature ?? "unknown";

  logger.sprint(contractId, `Generating: ${feature}`);

  // Load agent definition (system prompt from .md file)
  const agentDef = await loadAgentDefinition("bober-generator", projectRoot);
  const model = resolveModel(config.generator.model);
  const maxTurns = config.generator.maxTurnsPerSprint;

  // Build tool set (generator gets full access)
  const toolSet = buildToolSet("generator", projectRoot);

  const client = new Anthropic();
  const handoffJson = serializeHandoff(handoff);

  const userMessage = `# Context Handoff
${handoffJson}

# Project Root
${projectRoot}

Implement the changes described in the sprint contract. Follow every success criterion.
Use your tools to read the codebase, write code, run tests, and verify your work.
${handoff.issues.length > 0 ? `\n# Previous Issues to Fix\n${handoff.issues.join("\n\n")}` : ""}

When you are done, your final response must contain ONLY a JSON object with this structure (no markdown fences):
{
  "contractId": "${contractId}",
  "status": "complete | partial | blocked",
  "criteriaResults": [
    {"criterionId": "sc-X-Y", "met": true/false, "evidence": "<how you verified>"}
  ],
  "filesChanged": [
    {"path": "<file path>", "action": "created | modified | deleted", "description": "<what changed>"}
  ],
  "testsAdded": ["<test file paths>"],
  "commits": ["<hash> - <message>"],
  "blockers": ["<any unresolved issues>"],
  "notes": "<additional context for the evaluator>"
}`;

  logger.info(`Calling generator model (${config.generator.model} → ${model})...`);

  // Track which files were written/edited via tools
  const filesWritten = new Set<string>();

  const result = await runAgenticLoop({
    client,
    model,
    systemPrompt: agentDef.systemPrompt,
    userMessage,
    tools: toolSet.schemas,
    toolHandlers: toolSet.handlers,
    maxTurns,
    maxTokens: 16384,
    onToolUse: (name, input) => {
      const inp = input as Record<string, unknown>;
      if (name === "write_file" || name === "edit_file") {
        const path = inp.file_path as string;
        if (path) filesWritten.add(path);
      }
      const inputStr = JSON.stringify(inp).slice(0, 120);
      logger.debug(`  [generator] ${name}(${inputStr})`);
    },
  });

  logger.debug(
    `Generator completed in ${result.turnsUsed} turns (${result.toolsCalled.length} tool calls)`,
  );

  return parseGeneratorResult(result.finalText, filesWritten, result);
}

// ── JSON parser ────────────────────────────────────────────────────

/**
 * Parse the generator response text into a GeneratorResult.
 */
function parseGeneratorResult(
  text: string,
  filesWritten: Set<string>,
  loopResult: { turnsUsed: number; toolsCalled: string[]; usage: { inputTokens: number; outputTokens: number } },
): GeneratorResult {
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

  if (
    parsed &&
    typeof parsed === "object" &&
    parsed !== null &&
    ("success" in parsed || "status" in parsed)
  ) {
    const obj = parsed as Record<string, unknown>;

    // Support both old format (success: bool) and new format (status: string)
    const success =
      "success" in obj
        ? Boolean(obj.success)
        : obj.status === "complete";

    // Merge file paths from tool tracking and from the report
    const reportFiles = Array.isArray(obj.filesChanged)
      ? (obj.filesChanged as unknown[])
          .map((f) => {
            if (typeof f === "string") return f;
            if (typeof f === "object" && f !== null && "path" in f)
              return String((f as Record<string, unknown>).path);
            return null;
          })
          .filter((f): f is string => f !== null)
      : [];

    const allFiles = [...new Set([...filesWritten, ...reportFiles])];

    return {
      success,
      notes:
        typeof obj.notes === "string"
          ? obj.notes
          : "No notes provided.",
      filesChanged: allFiles,
      commitHash:
        typeof obj.commitHash === "string" ? obj.commitHash : undefined,
      turnsUsed: loopResult.turnsUsed,
      toolsCalled: loopResult.toolsCalled,
      usage: loopResult.usage,
    };
  }

  // If parsing failed entirely, check if we at least wrote files
  if (filesWritten.size > 0) {
    return {
      success: true,
      notes: `Generator wrote ${filesWritten.size} files but did not produce a structured report. Files: ${[...filesWritten].join(", ")}`,
      filesChanged: [...filesWritten],
      turnsUsed: loopResult.turnsUsed,
      toolsCalled: loopResult.toolsCalled,
      usage: loopResult.usage,
    };
  }

  return {
    success: false,
    notes: `Failed to parse generator response. Raw output:\n${text.slice(0, 500)}`,
    filesChanged: [],
    turnsUsed: loopResult.turnsUsed,
    toolsCalled: loopResult.toolsCalled,
    usage: loopResult.usage,
  };
}
