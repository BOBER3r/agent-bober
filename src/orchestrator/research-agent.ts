import type { BoberConfig } from "../config/schema.js";
import { createClient } from "../providers/factory.js";
import { saveResearch } from "../state/index.js";
import { logger } from "../utils/logger.js";
import { resolveModel } from "./model-resolver.js";
import { loadAgentDefinition } from "./agent-loader.js";
import { buildToolSet } from "./tools/index.js";
import { runAgenticLoop } from "./agentic-loop.js";

// ── Constants ──────────────────────────────────────────────────────

const RESEARCHER_PHASE1_MAX_TURNS = 3;
const RESEARCHER_PHASE2_MAX_TURNS = 20;

// ── Types ──────────────────────────────────────────────────────────

/**
 * A factual research document produced by the two-phase research process.
 * Contains ONLY findings — no implementation opinions or recommendations.
 */
export interface ResearchDoc {
  /** Unique identifier for this research document, format: research-<YYYYMMDD>-<slug> */
  id: string;
  /** ISO-8601 timestamp of when research was produced. */
  generatedAt: string;
  /** The questions that guided codebase exploration (generated in Phase 1). */
  explorationQuestions: string[];
  /** Factual sections produced by Phase 2 exploration. */
  sections: ResearchSections;
  /** File paths the Phase 2 agent actually read during exploration. */
  filesExplored: string[];
  /** Number of questions that were answered. */
  questionsAnswered: number;
}

/**
 * The factual sections of a research document.
 * Each section contains only observed facts, no recommendations.
 */
export interface ResearchSections {
  /** How the relevant subsystem is structured — files, relationships, call chain. */
  architectureOverview: string;
  /** File:line references for observed patterns. */
  existingPatterns: string;
  /** Most important files for this area with their purpose and key exports. */
  keyFiles: string;
  /** All public interfaces, exported functions, types, CLI entry points. */
  integrationPoints: string;
  /** Existing tests covering the relevant area — paths, what they cover, utilities used. */
  testCoverage: string;
  /** Areas of complexity, tight coupling, or high change-impact surface. */
  riskAreas: string;
}

// ── Phase 1: Question Generation ───────────────────────────────────

/**
 * Run Phase 1: generate exploration questions from the user prompt.
 *
 * The Phase 1 agent receives the feature description and produces 5–8 specific
 * questions that will guide codebase exploration. It does NOT read any files.
 */
async function generateExplorationQuestions(
  userPrompt: string,
  projectRoot: string,
  agentSystemPrompt: string,
  config: BoberConfig,
): Promise<string[]> {
  logger.info("Phase 1: Generating exploration questions...");

  // Phase 1 gets NO tools — it only needs to think, not explore
  const toolSet = buildToolSet("planner", projectRoot);

  const client = createClient(
    config.planner.provider ?? null,
    config.planner.endpoint ?? null,
    config.planner.providerConfig,
    config.planner.model,
    "Researcher-Phase1",
  );

  const model = resolveModel(config.planner.model);

  const phase1Message = `You are the Bober Researcher agent, Phase 1: Question Generation.

## Your Task

Given the feature description below, generate 5–8 specific exploration questions that will guide codebase exploration. These questions will be passed to a SEPARATE agent that has NO knowledge of the feature — so your questions must be self-contained and answerable by reading the codebase.

## Rules

- Generate ONLY questions, no preamble, no explanation
- Questions must be specific to what a developer would need to explore
- Questions must be answerable by reading files (not by building or running code)
- Do NOT suggest implementations or make recommendations
- Do NOT explore the codebase yourself — just generate questions

## Feature Description

${userPrompt}

## Project Root

${projectRoot}

## Output Format

Respond with ONLY a JSON array of question strings. No markdown fences, no explanation.`;

  const result = await runAgenticLoop({
    client,
    model,
    systemPrompt: agentSystemPrompt,
    userMessage: phase1Message,
    tools: toolSet.schemas,
    toolHandlers: toolSet.handlers,
    maxTurns: RESEARCHER_PHASE1_MAX_TURNS,
    maxTokens: 4096,
    onToolUse: (name, input) => {
      const inputStr =
        typeof input === "object" && input !== null
          ? JSON.stringify(input).slice(0, 80)
          : String(input);
      logger.debug(`  [researcher-p1] ${name}(${inputStr})`);
    },
  });

  logger.debug(
    `Phase 1 completed in ${result.turnsUsed} turns`,
  );

  return parseQuestions(result.finalText);
}

function parseQuestions(text: string): string[] {
  const trimmed = text.trim();

  // Try direct parse first
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.every((q) => typeof q === "string")) {
      return parsed;
    }
  } catch {
    // Fall through
  }

  // Try extracting JSON array from markdown fences
  const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(trimmed);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (Array.isArray(parsed) && parsed.every((q) => typeof q === "string")) {
        return parsed;
      }
    } catch {
      // Fall through
    }
  }

  // Try finding the first [...] block
  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    try {
      const parsed = JSON.parse(trimmed.slice(arrayStart, arrayEnd + 1));
      if (Array.isArray(parsed) && parsed.every((q) => typeof q === "string")) {
        return parsed;
      }
    } catch {
      // Fall through
    }
  }

  throw new Error(
    `Failed to parse exploration questions from Phase 1 response. Raw response:\n${text.slice(0, 500)}`,
  );
}

// ── Phase 2: Codebase Exploration ──────────────────────────────────

/**
 * Run Phase 2: explore the codebase using ONLY the questions from Phase 1.
 *
 * CRITICAL: The userPrompt (feature description) MUST NOT be included in the
 * Phase 2 prompt. This isolation prevents opinion contamination in the research.
 */
async function exploreCodabase(
  questions: string[],
  researchId: string,
  projectRoot: string,
  agentSystemPrompt: string,
  config: BoberConfig,
): Promise<{
  sections: ResearchSections;
  filesExplored: string[];
  questionsAnswered: number;
}> {
  logger.info(
    `Phase 2: Exploring codebase for ${questions.length} questions...`,
  );

  // Phase 2 gets read-only tools to explore the codebase
  const toolSet = buildToolSet("planner", projectRoot);

  const client = createClient(
    config.planner.provider ?? null,
    config.planner.endpoint ?? null,
    config.planner.providerConfig,
    config.planner.model,
    "Researcher-Phase2",
  );

  const model = resolveModel(config.planner.model);

  const questionsText = questions
    .map((q, i) => `${i + 1}. ${q}`)
    .join("\n");

  // NOTE: userPrompt is intentionally NOT included here — this is the two-phase isolation
  const phase2Message = `You are the Bober Researcher agent, Phase 2: Codebase Exploration.

## Your Task

You have been given a list of exploration questions. Your job is to explore the codebase and answer each question with factual findings. You do NOT know what feature is being built — this is intentional to prevent bias in your research.

## Exploration Questions

${questionsText}

## Research ID

${researchId}

## Project Root

${projectRoot}

## Instructions

1. Work through each question systematically using the available tools (read_file, glob, grep)
2. Record exact file paths for every finding
3. Produce a factual research document with ONLY these sections:
   - Architecture Overview
   - Existing Patterns (with file references)
   - Key Files
   - Integration Points
   - Test Coverage
   - Risk Areas
4. No recommendations. No opinions. Facts only.

## Output Format

Respond with a JSON object (no markdown fences, no explanation):
{
  "researchId": "${researchId}",
  "sections": {
    "architectureOverview": "<string>",
    "existingPatterns": "<string>",
    "keyFiles": "<string>",
    "integrationPoints": "<string>",
    "testCoverage": "<string>",
    "riskAreas": "<string>"
  },
  "filesExplored": ["<list of file paths you read>"],
  "questionsAnswered": <number>
}`;

  const result = await runAgenticLoop({
    client,
    model,
    systemPrompt: agentSystemPrompt,
    userMessage: phase2Message,
    tools: toolSet.schemas,
    toolHandlers: toolSet.handlers,
    maxTurns: RESEARCHER_PHASE2_MAX_TURNS,
    maxTokens: 16384,
    onToolUse: (name, input) => {
      const inputStr =
        typeof input === "object" && input !== null
          ? JSON.stringify(input).slice(0, 100)
          : String(input);
      logger.debug(`  [researcher-p2] ${name}(${inputStr})`);
    },
  });

  logger.debug(
    `Phase 2 completed in ${result.turnsUsed} turns (tools: ${result.toolsCalled.length})`,
  );

  return parsePhase2Result(result.finalText);
}

interface Phase2Result {
  researchId?: string;
  sections: ResearchSections;
  filesExplored: string[];
  questionsAnswered: number;
}

function parsePhase2Result(text: string): {
  sections: ResearchSections;
  filesExplored: string[];
  questionsAnswered: number;
} {
  let parsed: unknown;

  const trimmed = text.trim();

  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Try extracting JSON from markdown fences
    const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(trimmed);
    if (fenceMatch) {
      try {
        parsed = JSON.parse(fenceMatch[1].trim());
      } catch {
        // Fall through
      }
    }

    // Try finding the first { ... } block
    if (!parsed) {
      const braceStart = trimmed.indexOf("{");
      const braceEnd = trimmed.lastIndexOf("}");
      if (braceStart !== -1 && braceEnd > braceStart) {
        try {
          parsed = JSON.parse(trimmed.slice(braceStart, braceEnd + 1));
        } catch {
          throw new Error(
            `Failed to parse Phase 2 response as JSON. Raw response:\n${text.slice(0, 500)}`,
          );
        }
      } else {
        throw new Error(
          `No JSON object found in Phase 2 response. Raw response:\n${text.slice(0, 500)}`,
        );
      }
    }
  }

  const result = parsed as Phase2Result;

  // Validate required fields
  if (!result || typeof result !== "object") {
    throw new Error("Phase 2 response is not an object");
  }

  const sections = result.sections ?? {};
  const normalizedSections: ResearchSections = {
    architectureOverview:
      typeof sections.architectureOverview === "string"
        ? sections.architectureOverview
        : "No architecture overview provided.",
    existingPatterns:
      typeof sections.existingPatterns === "string"
        ? sections.existingPatterns
        : "No patterns documented.",
    keyFiles:
      typeof sections.keyFiles === "string"
        ? sections.keyFiles
        : "No key files listed.",
    integrationPoints:
      typeof sections.integrationPoints === "string"
        ? sections.integrationPoints
        : "No integration points documented.",
    testCoverage:
      typeof sections.testCoverage === "string"
        ? sections.testCoverage
        : "No test coverage documented.",
    riskAreas:
      typeof sections.riskAreas === "string"
        ? sections.riskAreas
        : "No risk areas identified.",
  };

  const filesExplored = Array.isArray(result.filesExplored)
    ? result.filesExplored.filter((f): f is string => typeof f === "string")
    : [];

  const questionsAnswered =
    typeof result.questionsAnswered === "number" ? result.questionsAnswered : 0;

  return { sections: normalizedSections, filesExplored, questionsAnswered };
}

// ── Research ID Generation ─────────────────────────────────────────

function generateResearchId(userPrompt: string): string {
  const now = new Date();
  const datePart = now
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");

  const slug = userPrompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join("-")
    .slice(0, 40);

  return `research-${datePart}-${slug}`;
}

// ── Main Entry Point ───────────────────────────────────────────────

/**
 * Run the two-phase research process for a feature description.
 *
 * Phase 1: Generate 5–8 exploration questions from the user prompt.
 * Phase 2: Explore the codebase using ONLY those questions (no userPrompt).
 *
 * The two-phase isolation is the core design principle: Phase 2 has NO knowledge
 * of what feature is being built, which prevents implementation opinions from
 * contaminating the factual research findings.
 *
 * @param userPrompt   Feature description — passed ONLY to Phase 1.
 * @param projectRoot  Absolute path to the project root.
 * @param config       Bober configuration (model, provider settings, etc.).
 * @returns A factual ResearchDoc with findings from codebase exploration.
 */
export async function runResearch(
  userPrompt: string,
  projectRoot: string,
  config: BoberConfig,
): Promise<ResearchDoc> {
  logger.phase("Research Phase");

  const researchId = generateResearchId(userPrompt);
  logger.info(`Research ID: ${researchId}`);

  // Load the researcher agent definition (system prompt)
  const agentDef = await loadAgentDefinition("bober-researcher", projectRoot);

  // ── Phase 1: Question Generation ─────────────────────────────────
  // userPrompt IS passed to Phase 1 — this is how questions are generated
  const questions = await generateExplorationQuestions(
    userPrompt,
    projectRoot,
    agentDef.systemPrompt,
    config,
  );

  if (questions.length < 3) {
    throw new Error(
      `Phase 1 produced too few questions (${questions.length}). Minimum is 3. ` +
        `This likely indicates a Phase 1 parsing failure.`,
    );
  }

  logger.success(`Phase 1: Generated ${questions.length} exploration questions`);
  questions.forEach((q, i) => logger.debug(`  Q${i + 1}: ${q}`));

  // ── Phase 2: Codebase Exploration ────────────────────────────────
  // userPrompt is NOT passed to Phase 2 — this is the isolation guarantee
  const { sections, filesExplored, questionsAnswered } = await exploreCodabase(
    questions,
    researchId,
    projectRoot,
    agentDef.systemPrompt,
    config,
  );

  logger.success(
    `Phase 2: Explored ${filesExplored.length} files, answered ${questionsAnswered}/${questions.length} questions`,
  );

  const researchDoc: ResearchDoc = {
    id: researchId,
    generatedAt: new Date().toISOString(),
    explorationQuestions: questions,
    sections,
    filesExplored,
    questionsAnswered,
  };

  // Save to .bober/research/
  await saveResearch(projectRoot, researchDoc);
  logger.success(`Research saved: ${researchId}`);

  return researchDoc;
}
