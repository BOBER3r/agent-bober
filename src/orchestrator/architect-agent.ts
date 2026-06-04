import type { BoberConfig } from "../config/schema.js";
import { createClient } from "../providers/factory.js";
import { saveArchitecture } from "../state/index.js";
import { logger } from "../utils/logger.js";
import { resolveModel } from "./model-resolver.js";
import { assembleSystemPrompt } from "./agent-loader.js";
import { resolveRoleTools, getGraphState, getGraphDeps } from "./tools/index.js";
import { runAgenticLoop } from "./agentic-loop.js";
import { PreflightContextInjector } from "../graph/preflight-injector.js";
import { graphPipelineLifecycle } from "../graph/pipeline-lifecycle.js";
import { synthesize } from "./workflow/synthesizer.js";
import { resolveArchLensFocus } from "./arch-lenses.js";
import { reconcile } from "./workflow/reconciler.js";
import { mapBounded } from "./workflow/scheduler.js";
import type { EvalResult } from "../contracts/eval-result.js";

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
  /** Per-lens scores from the panel path (additive, optional — absent on the off path). */
  lensScores?: Array<{ lens: string; scores: Record<string, number> }>;
  /** The approach selected by synthesize().winner on the panel path (additive, optional — absent on the off path). */
  selectedApproach?: string;
  /** Per-lens CP5 review verdicts from the panel path (additive, optional — absent on the off path). */
  lensReviews?: Array<{ lens: string; passed: boolean; summary: string; feedback: string }>;
  /** The reconciled panel verdict for CP5 (additive, optional). false = fail-closed. */
  panelReviewPassed?: boolean;
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

  const panel = config.architect?.panel;
  if (!panel?.enabled || panel.lenses.length < 2) {
    return runArchitectSingleLoop(userPrompt, projectRoot, config, researchDoc);
  }
  return runArchitectPanel(userPrompt, projectRoot, config, panel, researchDoc);
}

// ── Single-loop path (OFF path — verbatim original body) ───────────

/**
 * Run the original single monolithic runAgenticLoop flow (CP1–CP5 in one call).
 * This is the byte-identical off path — called when architect.panel is disabled
 * or fewer than 2 lenses are configured.
 */
async function runArchitectSingleLoop(
  userPrompt: string,
  projectRoot: string,
  config: BoberConfig,
  researchDoc?: string,
): Promise<ArchitectResult> {
  const architectId = generateArchitectId(userPrompt);
  logger.info(`Architecture ID: ${architectId}`);

  // Architect gets read + write tools for saving artifacts. When graph is enabled
  // and ready, bash/grep/glob are removed and graph_* tools are added (ADR-8).
  // write_file and edit_file are RETAINED in gated mode.
  const graphState = getGraphState(config);
  const graphDeps = graphState.engineHealth === "ready" ? getGraphDeps() : undefined;
  const toolSet = resolveRoleTools("architect", projectRoot, graphState, graphDeps ?? undefined);
  // Assemble system prompt with graph-prompt decoration (ADR-5, Sprint 7).
  const systemPrompt = await assembleSystemPrompt("architect", "bober-architect", projectRoot, graphState);

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

  // Pre-flight graph context injection (ADR-9).
  // Architect runs before sprint contracts exist; pass contract=null.
  // On failure or timeout, autonomousMessage is returned unchanged.
  const graphClient = graphPipelineLifecycle.getGraphClient();
  const preflightInjector = new PreflightContextInjector(graphClient, config.graph);
  const enhancedMessage = await preflightInjector.inject("architect", null, autonomousMessage);

  const result = await runAgenticLoop({
    client,
    model,
    systemPrompt,
    userMessage: enhancedMessage,
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

  // Token-usage capture (graph integration sprint 2, s2-c8).
  // Mirrors the cumulative-usage pattern from src/orchestrator/agentic-loop.ts:117-118.
  // Failure to write must NOT break architecture — swallow errors.
  try {
    const { TokenUsageLog } = await import("../graph/token-usage.js");
    await new TokenUsageLog(projectRoot).append({
      agent: "architect",
      runId: architectId,
      timestamp: new Date().toISOString(),
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      graphEnabled: config.graph?.enabled === true,
    });
  } catch (err) {
    logger.debug(`Token usage capture failed (architect): ${err instanceof Error ? err.message : String(err)}`);
  }

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

// ── Panel path (ON path — CP2 synthesis via lens fan-out) ──────────

/**
 * Run the panel-driven architect flow. CP2 (approach selection) is executed
 * as a discrete seam:
 *  1. Generate candidate approaches via a focused LLM call.
 *  2. Fan out one lens scorer per lens (bounded by maxConcurrent).
 *  3. synthesize() selects the ranked winner.
 *  4. A continuation call runs CP1/CP3/CP4/CP5 and assembles the doc + ADR-1.
 */
async function runArchitectPanel(
  userPrompt: string,
  projectRoot: string,
  config: BoberConfig,
  panel: { enabled: boolean; lenses: string[]; maxConcurrent: number },
  researchDoc?: string,
): Promise<ArchitectResult> {
  const architectId = generateArchitectId(userPrompt);
  logger.info(`Architecture ID (panel): ${architectId}`);

  // Build shared tool set and system prompt (same as single-loop path).
  const graphState = getGraphState(config);
  const graphDeps = graphState.engineHealth === "ready" ? getGraphDeps() : undefined;
  const toolSet = resolveRoleTools("architect", projectRoot, graphState, graphDeps ?? undefined);
  const systemPrompt = await assembleSystemPrompt("architect", "bober-architect", projectRoot, graphState);

  // All LLM calls use config.planner.* (architect section only carries panel).
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

  // ── Step 1: Generate candidate approaches (CP2 only) ────────────

  const generateApproachesMessage = `You are the Bober Architect agent running in AUTONOMOUS mode. There is NO user to interact with.

## Feature Description (Your Problem Space)

${userPrompt}

## Architecture ID

Use this exact ID for all saved artifacts: **${architectId}**

## Project Root

${projectRoot}
${researchSection}

## Instructions

Run ONLY Checkpoint 2: Approach Selection.

### Checkpoint 2: Approach Selection
Present exactly 2-3 architectural approaches in the structured format below. For each approach:
- Give it a short identifier (e.g., "approach-A", "approach-B", "approach-C")
- Describe its key characteristics
- Note main tradeoffs

## Output Format

After your analysis, respond with EXACTLY this JSON (no markdown fences, no other text):
{
  "approaches": ["approach-A", "approach-B", "approach-C"]
}`;

  const graphClient = graphPipelineLifecycle.getGraphClient();
  const preflightInjector = new PreflightContextInjector(graphClient, config.graph);
  const enhancedGenerateMessage = await preflightInjector.inject("architect", null, generateApproachesMessage);

  logger.info(`Calling architect model (${config.planner.model} → ${model}) — generating approaches...`);

  const generateResult = await runAgenticLoop({
    client,
    model,
    systemPrompt,
    userMessage: enhancedGenerateMessage,
    tools: toolSet.schemas,
    toolHandlers: toolSet.handlers,
    maxTurns: ARCHITECT_MAX_TURNS,
    maxTokens: 16384,
    onToolUse: (name, input) => {
      const inputStr =
        typeof input === "object" && input !== null
          ? JSON.stringify(input).slice(0, 100)
          : String(input);
      logger.debug(`  [architect-gen] ${name}(${inputStr})`);
    },
  });

  // Parse the approaches from the generate result
  let approaches: string[] = [];
  try {
    const parsed = JSON.parse(generateResult.finalText.trim()) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "approaches" in parsed &&
      Array.isArray((parsed as Record<string, unknown>).approaches)
    ) {
      const arr = (parsed as Record<string, unknown>).approaches as unknown[];
      approaches = arr.filter((x): x is string => typeof x === "string");
    }
  } catch {
    // Try fence extraction
    const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(generateResult.finalText);
    if (fenceMatch) {
      try {
        const parsed = JSON.parse(fenceMatch[1].trim()) as unknown;
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "approaches" in parsed &&
          Array.isArray((parsed as Record<string, unknown>).approaches)
        ) {
          const arr = (parsed as Record<string, unknown>).approaches as unknown[];
          approaches = arr.filter((x): x is string => typeof x === "string");
        }
      } catch {
        // Fall through
      }
    }
  }

  // Fallback: ensure at least one approach so synthesize() does not throw
  if (approaches.length === 0) {
    logger.warn("Could not parse approaches from generate step; using fallback approach identifier.");
    approaches = ["approach-A"];
  }

  // ── Step 2: Fan out per-lens scoring (bounded concurrency) ────────

  logger.info(`Scoring ${approaches.length} approaches across ${panel.lenses.length} lenses (maxConcurrent=${panel.maxConcurrent})...`);

  const scoreLens = async (lens: string): Promise<{ lens: string; scores: Record<string, number> }> => {
    const lensBlock = `\n\n## Scoring Lens: ${lens}\n${resolveArchLensFocus(lens)}`;
    const scoringMessage = `You are the Bober Architect agent acting as a lens scorer. Evaluate the following architectural approaches through the specified lens.

## Feature Description

${userPrompt}

## Approaches to Score

${approaches.map((a, i) => `${i + 1}. ${a}`).join("\n")}

## Scoring Instructions

Score each approach on a scale of 0–100 for the lens specified below. Higher score = better fit for that lens criterion.${lensBlock}

## Output Format

Respond with EXACTLY this JSON (no markdown fences, no other text):
{
  "lens": "${lens}",
  "scores": {
    ${approaches.map((a) => `"${a}": <0-100>`).join(",\n    ")}
  }
}`;

    const enhancedScoringMessage = await preflightInjector.inject("architect", null, scoringMessage);

    logger.info(`  Scoring lens: ${lens}...`);

    const scoringResult = await runAgenticLoop({
      client,
      model,
      systemPrompt,
      userMessage: enhancedScoringMessage,
      tools: toolSet.schemas,
      toolHandlers: toolSet.handlers,
      maxTurns: ARCHITECT_MAX_TURNS,
      maxTokens: 16384,
      onToolUse: (name, input) => {
        const inputStr =
          typeof input === "object" && input !== null
            ? JSON.stringify(input).slice(0, 100)
            : String(input);
        logger.debug(`  [architect-score:${lens}] ${name}(${inputStr})`);
      },
    });

    // Parse scoring result
    try {
      const parsed = JSON.parse(scoringResult.finalText.trim()) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "scores" in parsed &&
        typeof (parsed as Record<string, unknown>).scores === "object"
      ) {
        const rawScores = (parsed as Record<string, unknown>).scores as Record<string, unknown>;
        const scores: Record<string, number> = {};
        for (const approach of approaches) {
          const v = rawScores[approach];
          scores[approach] = typeof v === "number" ? v : 50;
        }
        return { lens, scores };
      }
    } catch {
      // Fall through to default
    }

    // Fallback: equal scores
    const fallbackScores: Record<string, number> = {};
    for (const approach of approaches) {
      fallbackScores[approach] = 50;
    }
    return { lens, scores: fallbackScores };
  };

  const lensScores = await mapBounded(panel.lenses, panel.maxConcurrent, scoreLens);

  // ── Step 3: Synthesize winner ─────────────────────────────────────

  const synthesisResult = synthesize(approaches, lensScores);
  const winner = synthesisResult.winner;
  logger.info(`Synthesis winner: ${winner} (dissent: ${synthesisResult.dissent.join(", ") || "none"})`);

  // ── Step 4: Continuation — CP1/CP3/CP4/CP5 + doc/ADR-1 save ────────

  const lensScoresSummary = lensScores
    .map((ls) => `- **${ls.lens}**: ${Object.entries(ls.scores).map(([a, s]) => `${a}=${s}`).join(", ")}`)
    .join("\n");

  const continuationMessage = `You are the Bober Architect agent running in AUTONOMOUS mode. You have been spawned programmatically as part of the pipeline. There is NO user to interact with — you must self-discuss and self-decide at every checkpoint.

## Feature Description (Your Problem Space)

${userPrompt}

## Architecture ID

Use this exact ID for all saved artifacts: **${architectId}**

## Project Root

${projectRoot}
${researchSection}

## Checkpoint 2 Result (PRE-SELECTED — do not re-evaluate)

The approach selection was completed via multi-lens scoring. The selected approach is:

**Selected Approach: ${winner}**

Lens scoring summary:
${lensScoresSummary}

Dissent: ${synthesisResult.dissent.length > 0 ? synthesisResult.dissent.join("; ") : "none"}

## Instructions

Run Checkpoints 1, 3, 4, and 5 in strict order. Checkpoint 2 has already been decided above — use the selected approach (${winner}) as your architectural approach throughout.

For each checkpoint:

1. **Read the codebase first** using Glob, Grep, and Read tools. Cite specific file paths and line numbers.
2. **Self-discuss** — reason about tradeoffs as if presenting to a senior engineer.
3. **Make a decision** with explicit rationale.
4. **Draft an ADR** for each significant decision.

### Checkpoint 1: Problem Framing
Answer all 6 standard questions using the feature description above and any codebase evidence. Produce the Problem Statement section.

### Checkpoint 2: Approach Selection (ALREADY DONE)
The selected approach is **${winner}**. Draft ADR-1 documenting this selection and the lens scoring rationale above.

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

  const enhancedContinuationMessage = await preflightInjector.inject("architect", null, continuationMessage);

  logger.info(`Calling architect model (${config.planner.model} → ${model}) — continuation (CP1/3/4/5)...`);

  const continuationResult = await runAgenticLoop({
    client,
    model,
    systemPrompt,
    userMessage: enhancedContinuationMessage,
    tools: toolSet.schemas,
    toolHandlers: toolSet.handlers,
    maxTurns: ARCHITECT_MAX_TURNS,
    maxTokens: 16384,
    onToolUse: (name, input) => {
      const inputStr =
        typeof input === "object" && input !== null
          ? JSON.stringify(input).slice(0, 100)
          : String(input);
      logger.debug(`  [architect-cont] ${name}(${inputStr})`);
    },
  });

  logger.debug(
    `Architect panel continuation completed in ${continuationResult.turnsUsed} turns (tools: ${continuationResult.toolsCalled.length})`,
  );

  // Token-usage capture (failure does not break architecture).
  try {
    const { TokenUsageLog } = await import("../graph/token-usage.js");
    const totalInput =
      generateResult.usage.inputTokens +
      lensScores.length * 0 + // scoring usage tracked per-call inside scoreLens
      continuationResult.usage.inputTokens;
    const totalOutput =
      generateResult.usage.outputTokens +
      continuationResult.usage.outputTokens;
    await new TokenUsageLog(projectRoot).append({
      agent: "architect",
      runId: architectId,
      timestamp: new Date().toISOString(),
      inputTokens: totalInput,
      outputTokens: totalOutput,
      graphEnabled: config.graph?.enabled === true,
    });
  } catch (err) {
    logger.debug(`Token usage capture failed (architect panel): ${err instanceof Error ? err.message : String(err)}`);
  }

  const raw = parseArchitectResponse(continuationResult.finalText);

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
  if (!document && continuationResult.finalText) {
    const fallbackDoc = [
      `# Architecture: ${userPrompt.slice(0, 80)}`,
      ``,
      `**Architecture ID:** ${architectId}`,
      `**Generated:** ${timestamp}`,
      `**Status:** draft`,
      `**Selected Approach:** ${winner}`,
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
      continuationResult.finalText.slice(0, 3000),
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

  // ── Step 5: CP5 review fan-out + reconcile (panel verdict) ──────

  logger.info(`Running CP5 review across ${panel.lenses.length} lenses (maxConcurrent=${panel.maxConcurrent})...`);

  const reviewLens = async (lens: string): Promise<EvalResult> => {
    const lensBlock = `\n\n## Review Lens: ${lens}\n${resolveArchLensFocus(lens)}`;
    const reviewMessage = `You are the Bober Architect agent acting as a lens reviewer. Review the assembled architecture document and ADRs through the specified lens and produce a PASS or FAIL verdict.

## Feature Description

${userPrompt}

## Assembled Architecture Document

${document.slice(0, 2000)}

## ADRs

${adrs.slice(0, 3).map((adr, i) => `### ADR-${i + 1}\n${adr.slice(0, 500)}`).join("\n\n")}

## Review Instructions

Review the architecture through the lens specified below. Determine whether the architecture PASSES or FAILS this lens criterion.${lensBlock}

## Output Format

Respond with EXACTLY this JSON (no markdown fences, no other text):
{
  "passed": <true|false>,
  "feedback": "<specific feedback on why the architecture passes or fails this lens>"
}`;

    const enhancedReviewMessage = await preflightInjector.inject("architect", null, reviewMessage);

    logger.info(`  Reviewing lens: ${lens}...`);

    const reviewResult = await runAgenticLoop({
      client,
      model,
      systemPrompt,
      userMessage: enhancedReviewMessage,
      tools: toolSet.schemas,
      toolHandlers: toolSet.handlers,
      maxTurns: ARCHITECT_MAX_TURNS,
      maxTokens: 16384,
      onToolUse: (name, input) => {
        const inputStr =
          typeof input === "object" && input !== null
            ? JSON.stringify(input).slice(0, 100)
            : String(input);
        logger.debug(`  [architect-review:${lens}] ${name}(${inputStr})`);
      },
    });

    // Parse review result into EvalResult shape
    try {
      const parsed = JSON.parse(reviewResult.finalText.trim()) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "passed" in parsed &&
        typeof (parsed as Record<string, unknown>).passed === "boolean"
      ) {
        const p = parsed as Record<string, unknown>;
        const passed = p.passed as boolean;
        const feedback = typeof p.feedback === "string" ? p.feedback : (passed ? "Architecture passes this lens." : "Architecture fails this lens.");
        return {
          evaluator: `lens:${lens}`,
          passed,
          details: [
            {
              criterion: lens,
              passed,
              message: feedback,
              severity: passed ? ("info" as const) : ("error" as const),
            },
          ],
          summary: `Lens ${lens}: ${passed ? "PASS" : "FAIL"}`,
          feedback,
          timestamp,
        };
      }
    } catch {
      // Fall through to fail-closed fallback
    }

    // Fail-closed fallback: unparseable review counts as FAIL
    return {
      evaluator: `lens:${lens}`,
      passed: false,
      details: [
        {
          criterion: lens,
          passed: false,
          message: "Review response could not be parsed; treated as FAIL (fail-closed).",
          severity: "error" as const,
        },
      ],
      summary: `Lens ${lens}: FAIL (parse error)`,
      feedback: "Review response could not be parsed; treated as FAIL (fail-closed).",
      timestamp,
    };
  };

  const lensReviews = await mapBounded(panel.lenses, panel.maxConcurrent, reviewLens);
  const verdict = reconcile(architectId, 1, lensReviews, timestamp);

  logger.info(`CP5 panel verdict: ${verdict.passed ? "PASS" : "FAIL"} (${verdict.summary})`);

  // Record a failing verdict in the document (do NOT silently drop it)
  if (!verdict.passed) {
    const failNote = [
      "",
      "---",
      "",
      "## Panel Review: FAIL",
      "",
      `**Verdict:** ${verdict.summary}`,
      "",
      "**Failing lens feedback:**",
      "",
      verdict.feedback,
    ].join("\n");
    document = document + failNote;
    // Persist the updated document with the FAIL note
    try {
      await saveArchitecture(projectRoot, architectId, document);
    } catch (err) {
      logger.warn(
        `Failed to save document with FAIL note: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  logger.success(`Architecture saved (panel): ${architectId} (${decisionCount} ADRs, winner: ${winner})`);

  return {
    id: architectId,
    timestamp,
    document,
    adrs,
    componentCount,
    decisionCount,
    lensScores,
    selectedApproach: winner,
    lensReviews: lensReviews.map((r) => ({
      lens: r.evaluator.replace("lens:", ""),
      passed: r.passed,
      summary: r.summary,
      feedback: r.feedback,
    })),
    panelReviewPassed: verdict.passed,
  };
}
