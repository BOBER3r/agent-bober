import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { BoberConfig } from "../config/schema.js";
import type { PlanSpec, FeatureSpec } from "../contracts/spec.js";
import { PlanSpecSchema } from "../contracts/spec.js";
import { createClient } from "../providers/factory.js";
import { saveSpec } from "../state/index.js";
import { fileExists } from "../utils/fs.js";
import { logger } from "../utils/logger.js";
import { resolveModel } from "./model-resolver.js";
import { assembleSystemPrompt } from "./agent-loader.js";
import { buildToolSet } from "./tools/index.js";
import { runAgenticLoop, coerceJsonOutput } from "./agentic-loop.js";
import type { ResearchDoc } from "./research-agent.js";
import { retrieveRelevantFacts, serializeFactsForContext } from "./memory/fact-retrieve.js";

// ── Constants ──────────────────────────────────────────────────────

const PLANNER_MAX_TURNS = 100;
const RESEARCH_MAX_LINES = 300;

/**
 * Fallback instruction used when the planner's response isn't a valid PlanSpec.
 * Some OpenAI-compatible models (DeepSeek) emit valid JSON of the WRONG shape
 * (e.g. the short {specId, sprintCount, contractIds} summary the agent prompt
 * asks for) rather than the full PlanSpec the orchestrator parses. This spells
 * out every required field so json_object mode produces a parseable spec.
 */
const PLAN_SPEC_COERCION_INSTRUCTION = `Your previous response was not a complete PlanSpec object.
Output ONLY a single JSON object (no prose, no markdown fences, no tool calls) with EXACTLY this shape, filled in from the task and research above:
{
  "specId": "spec-<yyyymmdd>-<slug>",
  "version": 1,
  "title": "<short title>",
  "description": "<2-3 sentence summary of what this builds and why>",
  "status": "ready",
  "mode": "greenfield",
  "features": [
    {
      "featureId": "feat-1",
      "title": "<feature title>",
      "description": "<what this feature does>",
      "priority": "must-have",
      "acceptanceCriteria": ["<verifiable criterion>", "<verifiable criterion>"],
      "dependencies": [],
      "estimatedComplexity": "medium"
    }
  ],
  "assumptions": [],
  "outOfScope": [],
  "ambiguityScore": 3,
  "clarificationQuestions": [],
  "techStack": [],
  "createdAt": "<ISO-8601 timestamp>",
  "updatedAt": "<ISO-8601 timestamp>"
}
Rules: "status" must be one of draft|needs-clarification|ready|in-progress|completed (use "ready" for autonomous runs). "mode" is greenfield or brownfield. "priority" is must-have|should-have|nice-to-have. Each feature needs at least one acceptanceCriteria entry. Provide 3-6 features that fully cover the task. Output the JSON object and nothing else.`;
const ARCHITECT_MAX_LINES = 200;

// ── Research truncation ────────────────────────────────────────────

/**
 * Truncate research findings to a maximum number of lines.
 * If the findings exceed the limit, the first maxLines lines are kept
 * and a note is appended indicating that the full document is on disk.
 */
function truncateResearch(findings: string, maxLines: number = RESEARCH_MAX_LINES): string {
  const lines = findings.split("\n");
  if (lines.length <= maxLines) return findings;
  return (
    lines.slice(0, maxLines).join("\n") +
    "\n\n... (truncated — full research doc saved to disk)"
  );
}

/**
 * Truncate an architecture document to keep the planner's context manageable.
 */
function truncateArchitecture(doc: string, maxLines: number = ARCHITECT_MAX_LINES): string {
  const lines = doc.split("\n");
  if (lines.length <= maxLines) return doc;
  return (
    lines.slice(0, maxLines).join("\n") +
    "\n\n... (truncated — full architecture doc saved to .bober/architecture/)"
  );
}

// ── Context gathering ──────────────────────────────────────────────

async function gatherProjectContext(
  projectRoot: string,
  config: BoberConfig,
): Promise<string> {
  const sections: string[] = [];

  // Package.json
  const pkgPath = join(projectRoot, "package.json");
  if (await fileExists(pkgPath)) {
    const content = await readFile(pkgPath, "utf-8");
    sections.push(`## package.json\n\`\`\`json\n${content}\n\`\`\``);
  }

  // CLAUDE.md
  const claudeMdPath = join(projectRoot, "CLAUDE.md");
  if (await fileExists(claudeMdPath)) {
    const content = await readFile(claudeMdPath, "utf-8");
    sections.push(`## CLAUDE.md\n${content}`);
  }

  // bober.config.json
  sections.push(
    `## bober.config.json\n\`\`\`json\n${JSON.stringify(config, null, 2)}\n\`\`\``,
  );

  // Additional context files from config
  if (config.planner.contextFiles) {
    for (const relPath of config.planner.contextFiles) {
      const fullPath = join(projectRoot, relPath);
      if (await fileExists(fullPath)) {
        try {
          const content = await readFile(fullPath, "utf-8");
          sections.push(`## ${relPath}\n\`\`\`\n${content}\n\`\`\``);
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  return sections.join("\n\n");
}

// ── Main ───────────────────────────────────────────────────────────

/**
 * Discriminated result from `runPlanner`.
 *
 * - `ready` — the planner produced a complete spec; the pipeline may proceed.
 * - `needs-clarification` — the planner refused to fully decompose the
 *   request (ambiguityScore exceeded the threshold or open questions remain).
 *   The spec was still saved to disk so the user can resume later, but the
 *   pipeline must NOT run sprints from it until the questions are answered.
 *
 * Callers MUST narrow on `kind` before reading `spec.features`.
 */
export type PlannerResult =
  | { kind: "ready"; spec: PlanSpec }
  | { kind: "needs-clarification"; spec: PlanSpec };

/**
 * Run the planner agent to produce a PlanSpec from a user prompt.
 *
 * Uses a multi-turn agentic loop with read-only tools so the planner
 * can explore the codebase. The system prompt is loaded from
 * `agents/bober-planner.md`.
 *
 * Returns a discriminated PlannerResult — see the type for the contract.
 */
export async function runPlanner(
  userPrompt: string,
  projectRoot: string,
  config: BoberConfig,
  researchDoc?: ResearchDoc,
  architectDoc?: string,
): Promise<PlannerResult> {
  logger.phase("Planning Phase");
  logger.info("Gathering project context...");

  const context = await gatherProjectContext(projectRoot, config);

  // Load agent definition (system prompt from .md file).
  // Planner mode is 'disabled' — decoration is always a no-op regardless of ctx.
  const systemPrompt = await assembleSystemPrompt(
    "planner",
    "bober-planner",
    projectRoot,
    { graphEnabled: false, engineHealth: "disabled" },
  );
  const model = resolveModel(config.planner.model);

  // Build tool set (planner gets read-only tools)
  const toolSet = buildToolSet("planner", projectRoot);

  const client = createClient(
    config.planner.provider ?? null,
    config.planner.endpoint ?? null,
    config.planner.providerConfig,
    config.planner.model,
  );

  const researchSection = researchDoc
    ? `\n\n## Research Findings\n${truncateResearch(researchDoc.findings)}`
    : "";

  const architectSection = architectDoc
    ? `\n\n## Architecture\n${truncateArchitecture(architectDoc)}`
    : "";

  // ── Sprint 5: inject scope-keyed project facts (best-effort) ──────────
  // Retrieval failure must NEVER block planning. Scope "" = default/programming team.
  let factsSection = "";
  try {
    const factKeywords = userPrompt.split(/\s+/).filter((w) => w.length > 2);
    const facts = await retrieveRelevantFacts(projectRoot, "", factKeywords, { topK: 5 });
    const serialized = serializeFactsForContext(facts, { charBudget: 1200 });
    if (serialized) {
      factsSection = `\n\n${serialized}`;
    }
  } catch {
    // Retrieval failure is non-fatal — planning proceeds without facts
  }

  const userMessage = `# Task Description
${userPrompt}

# Project Root
${projectRoot}

# Project Context
${context}${researchSection}${architectSection}${factsSection}

Explore the codebase using your tools if you need more context, then produce a PlanSpec JSON.
Your final response must contain ONLY valid JSON matching the PlanSpec schema (no markdown fences, no explanation).`;

  logger.info(`Calling planner model (${config.planner.model} → ${model})...`);

  const result = await runAgenticLoop({
    client,
    model,
    systemPrompt,
    userMessage,
    tools: toolSet.schemas,
    toolHandlers: toolSet.handlers,
    maxTurns: PLANNER_MAX_TURNS,
    maxTokens: 16384,
    onToolUse: (name, input) => {
      const inputStr =
        typeof input === "object" && input !== null
          ? JSON.stringify(input).slice(0, 100)
          : String(input);
      logger.debug(`  [planner] ${name}(${inputStr})`);
    },
  });

  logger.debug(
    `Planner completed in ${result.turnsUsed} turns (tools: ${result.toolsCalled.length})`,
  );

  // Parse the final response for PlanSpec JSON. Some OpenAI-compatible models
  // (e.g. DeepSeek) explore correctly but narrate prose instead of emitting the
  // required JSON. On parse failure, fall back to a JSON-mode coercion call that
  // forces a structured PlanSpec object. No-op for models that already comply.
  let spec: PlanSpec;
  try {
    spec = parsePlanSpec(result.finalText);
  } catch (parseErr) {
    logger.warn(
      `Planner output was not a valid PlanSpec (${parseErr instanceof Error ? parseErr.message : String(parseErr)}). ` +
        `Retrying via JSON mode...`,
    );
    const coerced = await coerceJsonOutput({
      client,
      model,
      systemPrompt,
      userMessage,
      priorText: result.finalText,
      instruction: PLAN_SPEC_COERCION_INSTRUCTION,
    });
    spec = parsePlanSpec(coerced);
    logger.info("Planner JSON-mode coercion succeeded.");
  }

  // Save to .bober/specs/
  await saveSpec(projectRoot, spec);

  // Branch on planner-emitted status. The planner agent prompt instructs
  // the model to set status === "needs-clarification" when ambiguityScore
  // exceeds the threshold or any clarification questions remain unresolved.
  if (spec.status === "needs-clarification") {
    const open = spec.clarificationQuestions.length;
    logger.warn(
      `Plan saved with ${open} open clarification${open === 1 ? "" : "s"}: ${spec.title}`,
    );
    return { kind: "needs-clarification", spec };
  }

  logger.success(
    `Plan saved: ${spec.title} (${spec.features.length} features)`,
  );
  return { kind: "ready", spec };
}

// ── JSON parser ────────────────────────────────────────────────────

/**
 * Parse the planner response text into a validated PlanSpec.
 */
function parsePlanSpec(text: string): PlanSpec {
  let parsed: unknown;

  // Try direct parse first
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    // Try extracting JSON from markdown code fences
    const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(text);
    if (fenceMatch) {
      try {
        parsed = JSON.parse(fenceMatch[1].trim());
      } catch {
        // Fall through
      }
    }

    // Try finding the first { ... } block
    if (!parsed) {
      const braceStart = text.indexOf("{");
      const braceEnd = text.lastIndexOf("}");
      if (braceStart !== -1 && braceEnd > braceStart) {
        try {
          parsed = JSON.parse(text.slice(braceStart, braceEnd + 1));
        } catch {
          throw new Error(
            "Failed to parse planner response as JSON. Raw response:\n" +
              text.slice(0, 500),
          );
        }
      } else {
        throw new Error(
          "No JSON object found in planner response. Raw response:\n" +
            text.slice(0, 500),
        );
      }
    }
  }

  const result = PlanSpecSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Planner produced invalid PlanSpec:\n${issues}\n\nRaw:\n${JSON.stringify(parsed, null, 2).slice(0, 1000)}`,
    );
  }

  return result.data;
}

// ── Contract precision generation ──────────────────────────────────

/** Vague phrases the generator's contract preflight rejects (bober-generator.md). */
const BANNED_CONTRACT_PHRASES = [
  "works correctly",
  "works as expected",
  "looks good",
  "looks nice",
  "is reasonable",
  "behaves properly",
  "behaves correctly",
  "is correct",
  "appears correct",
  "as needed",
  "if appropriate",
];

/** The substantive precision fields a generator-passable contract requires. */
export interface ContractPrecision {
  nonGoals: string[];
  stopConditions: string[];
  definitionOfDone: string;
  assumptions: string[];
  outOfScope: string[];
}

function hasBannedPhrase(s: string): boolean {
  const lower = s.toLowerCase();
  return BANNED_CONTRACT_PHRASES.some((p) => lower.includes(p));
}

function validatePrecision(obj: unknown): ContractPrecision | undefined {
  if (typeof obj !== "object" || obj === null) return undefined;
  const o = obj as Record<string, unknown>;
  const strArr = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      : [];
  const nonGoals = strArr(o.nonGoals);
  const stopConditions = strArr(o.stopConditions);
  const definitionOfDone =
    typeof o.definitionOfDone === "string" ? o.definitionOfDone.trim() : "";

  // Enforce the same bar the generator preflight does — else it's wasted effort.
  if (nonGoals.length === 0 || stopConditions.length === 0) return undefined;
  if (definitionOfDone.length < 20) return undefined;
  if (nonGoals[0].startsWith("Auto-generated contract")) return undefined;
  const allStrings = [...nonGoals, ...stopConditions, definitionOfDone];
  if (allStrings.some(hasBannedPhrase)) return undefined;

  return {
    nonGoals,
    stopConditions,
    definitionOfDone,
    assumptions: strArr(o.assumptions),
    outOfScope: strArr(o.outOfScope),
  };
}

/**
 * Generate substantive contract precision fields (nonGoals, stopConditions,
 * definitionOfDone) for a feature via a json_object model call.
 *
 * The standalone pipeline otherwise creates contracts with placeholder precision
 * fields, which the generator's BLOCKING precision preflight rejects. This fills
 * them with concrete, verifiable values so the sprint can actually run.
 *
 * Returns undefined if generation fails or the output doesn't meet the bar — the
 * caller then keeps placeholders (and the generator correctly blocks) rather than
 * shipping a vague contract.
 */
export async function generateContractPrecision(
  feature: FeatureSpec,
  spec: Pick<PlanSpec, "title" | "description">,
  config: BoberConfig,
): Promise<ContractPrecision | undefined> {
  try {
    const model = resolveModel(config.planner.model);
    const client = createClient(
      config.planner.provider ?? null,
      config.planner.endpoint ?? null,
      config.planner.providerConfig,
      config.planner.model,
    );
    const userMessage = `# Overall Plan\nTitle: ${spec.title}\n${spec.description}\n\n# This Sprint's Feature\nTitle: ${feature.title}\nDescription: ${feature.description}\nAcceptance Criteria:\n${feature.acceptanceCriteria.map((a) => `- ${a}`).join("\n")}`;
    const instruction = `Output ONLY a JSON object with the precision fields for THIS sprint's contract:
{
  "nonGoals": ["a specific thing the implementer must NOT do in this sprint (e.g. 'Do not implement the settings UI — that is sprint 3')"],
  "stopConditions": ["a concrete, verifiable signal the sprint is finished (e.g. 'npm test passes and src/foo.ts exports bar()')"],
  "definitionOfDone": "a specific paragraph (at least 20 characters) describing exactly when this sprint is complete and how to verify it",
  "assumptions": ["any assumption made"],
  "outOfScope": ["work explicitly deferred to other sprints"]
}
Rules: every string must be concrete and verifiable. "nonGoals" and "stopConditions" each need at least one specific entry. Do NOT use any of these banned vague phrases: ${BANNED_CONTRACT_PHRASES.map((p) => `"${p}"`).join(", ")}. Output the JSON object and nothing else.`;

    const text = await coerceJsonOutput({
      client,
      model,
      systemPrompt:
        "You write precise, verifiable sprint contract fields for an autonomous coding harness.",
      userMessage,
      priorText: "",
      instruction,
    });

    // Extract the JSON object from the response.
    let parsed: unknown;
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return validatePrecision(parsed);
  } catch (err) {
    logger.warn(
      `Contract precision generation failed for "${feature.featureId}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
