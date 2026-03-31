import type { BoberConfig } from "../config/schema.js";
import { createClient } from "../providers/factory.js";
import { saveArchitecture } from "../state/index.js";
import { logger } from "../utils/logger.js";
import { resolveModel } from "./model-resolver.js";
import { loadAgentDefinition } from "./agent-loader.js";
import { buildToolSet } from "./tools/index.js";
import { runAgenticLoop } from "./agentic-loop.js";

// ── Constants ──────────────────────────────────────────────────────

const ARCHITECT_MAX_TURNS = 25;
const RESEARCH_MAX_LINES = 300;

// ── Types ──────────────────────────────────────────────────────────

/**
 * The output artifact produced by the architect's 5-checkpoint flow.
 */
export interface ArchitectResult {
  /** Unique identifier for this architecture document, format: arch-<YYYYMMDD>-<slug> */
  id: string;
  /** ISO-8601 timestamp of when the architecture was produced. */
  timestamp: string;
  /** Full markdown architecture document (capped at 500 lines). */
  document: string;
  /** Individual ADR contents in order. */
  adrs: string[];
  /** Number of components defined in the architecture. */
  componentCount: number;
  /** Number of Architecture Decision Records produced. */
  decisionCount: number;
}

// ── ID Generation ──────────────────────────────────────────────────

function generateArchitectId(userPrompt: string): string {
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

  return `arch-${datePart}-${slug}`;
}

// ── Research truncation ────────────────────────────────────────────

function truncateResearch(findings: string, maxLines: number = RESEARCH_MAX_LINES): string {
  const lines = findings.split("\n");
  if (lines.length <= maxLines) return findings;
  return (
    lines.slice(0, maxLines).join("\n") +
    "\n\n... (truncated — full research doc saved to disk)"
  );
}

// ── Result parsing ─────────────────────────────────────────────────

interface RawArchitectResult {
  architectureId?: string;
  title?: string;
  componentCount?: number;
  decisionCount?: number;
  documentPath?: string;
  adrPaths?: string[];
  summary?: string;
}

function parseArchitectResponse(text: string): RawArchitectResult {
  const trimmed = text.trim();

  // Try direct parse first
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as RawArchitectResult;
    }
  } catch {
    // Fall through
  }

  // Try extracting JSON from markdown fences
  const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(trimmed);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as RawArchitectResult;
      }
    } catch {
      // Fall through
    }
  }

  // Try finding the first { ... } block
  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    try {
      const parsed = JSON.parse(trimmed.slice(braceStart, braceEnd + 1));
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as RawArchitectResult;
      }
    } catch {
      // Fall through
    }
  }

  // Return empty object — caller will handle with defaults
  logger.warn("Could not parse architect JSON response; using defaults.");
  return {};
}

// ── Main Entry Point ───────────────────────────────────────────────

/**
 * Run the 5-checkpoint architect flow in autonomous mode.
 *
 * The architect self-discusses at each checkpoint, reads the codebase for
 * evidence, makes decisions, and produces an architecture document with ADRs.
 * The researchDoc (if provided) is included in the architect's context but
 * the architect does NOT generate application code — documents only.
 *
 * @param userPrompt   Feature description passed as the problem space.
 * @param projectRoot  Absolute path to the project root.
 * @param config       Bober configuration (model, provider settings, etc.).
 * @param researchDoc  Optional research findings to provide codebase context.
 * @returns ArchitectResult with the full architecture document and ADRs.
 */
export async function runArchitect(
  userPrompt: string,
  projectRoot: string,
  config: BoberConfig,
  researchDoc?: string,
): Promise<ArchitectResult> {
  logger.phase("Architect Phase");

  const architectId = generateArchitectId(userPrompt);
  logger.info(`Architecture ID: ${architectId}`);

  // Load the architect agent definition (system prompt)
  const agentDef = await loadAgentDefinition("bober-architect", projectRoot);

  // Architect gets read-only tools plus write for saving artifacts
  const toolSet = buildToolSet("generator", projectRoot);

  const client = createClient(
    config.planner.provider ?? null,
    config.planner.endpoint ?? null,
    config.planner.providerConfig,
    config.planner.model,
    "Architect",
  );

  const model = resolveModel(config.planner.model);

  const researchSection = researchDoc
    ? `\n\n## Research Findings\n\n${truncateResearch(researchDoc)}`
    : "";

  const autonomousMessage = `You are the Bober Architect agent running in AUTONOMOUS mode. You have been spawned programmatically as part of the pipeline. There is NO user to interact with — you must self-discuss and self-decide at every checkpoint.

## Feature Description (Your Problem Space)

${userPrompt}

## Architecture ID

Use this exact ID for all saved artifacts: **${architectId}**

## Project Root

${projectRoot}
${researchSection}

## Instructions

Run all 5 checkpoints in strict order. For each checkpoint:

1. **Read the codebase first** using Glob, Grep, and Read tools. Cite specific file paths and line numbers.
2. **Self-discuss** — reason about tradeoffs as if presenting to a senior engineer.
3. **Make a decision** with explicit rationale citing Checkpoint 1 constraints.
4. **Draft an ADR** for each significant decision (Checkpoint 2 and beyond).

### Checkpoint 1: Problem Framing
Answer all 6 standard questions using the feature description above and any codebase evidence. Produce the Problem Statement section.

### Checkpoint 2: Approach Selection
Present 2-3 architectural approaches in the structured format. Select one with rationale citing Checkpoint 1 constraints. Draft ADR-1 for this selection.

### Checkpoint 3: Component Design
Define all components with TypeScript interface signatures. Each component: responsibility (1 sentence), interface, dependencies. Draft an ADR for key boundary decisions if warranted.

### Checkpoint 4: Integration Strategy
Map the data flow as a concrete call chain. Define the API contracts table. Identify integration risks with severity and mitigation. Draft an ADR for key integration decisions if warranted.

### Checkpoint 5: Final Assembly
Compile all outputs into a single architecture document (cap at 500 lines). Save it to:
  \`.bober/architecture/${architectId}-architecture.md\`

Save each ADR to:
  \`.bober/architecture/${architectId}-adr-1.md\`
  \`.bober/architecture/${architectId}-adr-2.md\`
  (etc.)

## Output Format

After saving all files, respond with EXACTLY this JSON (no markdown fences, no other text):
{
  "architectureId": "${architectId}",
  "title": "<architecture title>",
  "componentCount": <number of components defined>,
  "decisionCount": <number of ADRs produced>,
  "documentPath": ".bober/architecture/${architectId}-architecture.md",
  "adrPaths": [".bober/architecture/${architectId}-adr-1.md"],
  "summary": "<2-3 sentence summary of the architecture>"
}`;

  logger.info(`Calling architect model (${config.planner.model} → ${model})...`);

  const result = await runAgenticLoop({
    client,
    model,
    systemPrompt: agentDef.systemPrompt,
    userMessage: autonomousMessage,
    tools: toolSet.schemas,
    toolHandlers: toolSet.handlers,
    maxTurns: ARCHITECT_MAX_TURNS,
    maxTokens: 16384,
    onToolUse: (name, input) => {
      const inputStr =
        typeof input === "object" && input !== null
          ? JSON.stringify(input).slice(0, 100)
          : String(input);
      logger.debug(`  [architect] ${name}(${inputStr})`);
    },
  });

  logger.debug(
    `Architect completed in ${result.turnsUsed} turns (tools: ${result.toolsCalled.length})`,
  );

  const raw = parseArchitectResponse(result.finalText);

  // Read back the saved architecture document
  let document = "";
  try {
    const { readArchitecture } = await import("../state/index.js");
    document = await readArchitecture(projectRoot, architectId);
  } catch {
    logger.warn(`Could not read back architecture document for ${architectId}; using empty string.`);
  }

  // Read back saved ADRs
  let adrs: string[] = [];
  try {
    const { readADRs } = await import("../state/index.js");
    adrs = await readADRs(projectRoot, architectId);
  } catch {
    logger.warn(`Could not read back ADRs for ${architectId}; using empty array.`);
  }

  const timestamp = new Date().toISOString();
  const componentCount =
    typeof raw.componentCount === "number" ? raw.componentCount : 0;
  const decisionCount =
    typeof raw.decisionCount === "number" ? raw.decisionCount : adrs.length;

  // If the agent did not save the document itself, save a fallback
  if (!document && result.finalText) {
    const fallbackDoc = [
      `# Architecture: ${userPrompt.slice(0, 80)}`,
      ``,
      `**Architecture ID:** ${architectId}`,
      `**Generated:** ${timestamp}`,
      `**Status:** draft`,
      ``,
      `---`,
      ``,
      `## Summary`,
      ``,
      raw.summary ?? "Architecture generation completed.",
      ``,
      `---`,
      ``,
      `## Agent Output`,
      ``,
      result.finalText.slice(0, 3000),
    ].join("\n");

    try {
      await saveArchitecture(projectRoot, architectId, fallbackDoc);
      document = fallbackDoc;
    } catch (err) {
      logger.warn(
        `Failed to save fallback architecture: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  logger.success(`Architecture saved: ${architectId} (${decisionCount} ADRs)`);

  return {
    id: architectId,
    timestamp,
    document,
    adrs,
    componentCount,
    decisionCount,
  };
}
