import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { BoberConfig, DocumenterDocsMode } from "../config/schema.js";
import type { SprintContract } from "../contracts/sprint-contract.js";
import type { EvaluationRunResult } from "../evaluators/registry.js";
import type { GeneratorResult } from "./generator-agent.js";
import { createClient } from "../providers/factory.js";
import { logger } from "../utils/logger.js";
import { ensureGitignoreEntry } from "../utils/git.js";
import { resolveModel } from "./model-resolver.js";
import { assembleSystemPrompt } from "./agent-loader.js";
import { resolveRoleTools, getGraphState, getGraphDeps } from "./tools/index.js";
import { runAgenticLoop } from "./agentic-loop.js";

// ── Types ──────────────────────────────────────────────────────────

/** One existing doc the documenter updated because the sprint made it stale. */
export interface RelatedDocUpdate {
  path: string;
  reason: string;
}

/**
 * The structured result emitted by the bober-documenter subagent.
 */
export interface DocumentationResult {
  contractId: string;
  /** Path to the per-sprint record the documenter wrote. */
  sprintDocPath: string;
  /** Existing docs the documenter updated. */
  relatedDocsUpdated: RelatedDocUpdate[];
  /** The docs-only commit the documenter made, if any. */
  docsCommit?: string;
  /** Code/doc issues the documenter noticed but did NOT fix (it must not touch code). */
  concerns: string[];
  summary: string;
}

// ── Path resolution ────────────────────────────────────────────────

/**
 * Resolve a `docsDir` (relative, absolute, or `~`-prefixed) against a
 * project root. There is no tilde-expansion helper elsewhere in `src/`
 * (`node:path` does not expand `~`), so this expands it inline with
 * `os.homedir()` before the `isAbsolute` check.
 */
function resolveDocsDir(dir: string, projectRoot: string): string {
  const expanded = dir.startsWith("~") ? join(homedir(), dir.slice(1)) : dir;
  return isAbsolute(expanded) ? expanded : join(projectRoot, expanded);
}

/**
 * Resolve the absolute path where the per-sprint doc record for
 * `contractId` should be written, given the documenter's `docsMode`
 * and optional `docsDir`.
 *
 * - `committed`/`local` with `docsDir` unset: `docs/sprints/<id>.md` under
 *   `projectRoot` (byte-identical to the pre-sprint-1 hardcoded path).
 * - Any mode with `docsDir` set: `docsDir` resolved against `projectRoot`
 *   (relative), or honored as-is (absolute / `~`-prefixed).
 * - `external` with `docsDir` unset: `~/.bober/docs/<project.name>/sprints/<id>.md`
 *   (project name falls back to `basename(projectRoot)`).
 *
 * Exported for direct unit testing (sc-1-2).
 */
export function resolveSprintDocPath(
  config: BoberConfig,
  projectRoot: string,
  contractId: string,
): string {
  const docsMode: DocumenterDocsMode = config.documenter?.docsMode ?? "committed";
  const docsDir = config.documenter?.docsDir;
  const fileName = `${contractId}.md`;

  if (docsDir) {
    return join(resolveDocsDir(docsDir, projectRoot), fileName);
  }

  if (docsMode === "external") {
    const projectName = config.project?.name ?? basename(projectRoot);
    return join(homedir(), ".bober", "docs", projectName, "sprints", fileName);
  }

  // committed / local defaults
  return join(projectRoot, "docs", "sprints", fileName);
}

// ── Prompt builder ─────────────────────────────────────────────────

/** Inputs to {@link buildDocumenterUserMessage}. */
export interface DocumenterUserMessageOptions {
  contract: SprintContract;
  contractJson: string;
  evalSummary: string;
  filesChanged: string;
  projectRoot: string;
  sprintDocPath: string;
  docsMode: DocumenterDocsMode;
}

/**
 * Build the user message sent to the documenter agent. The instructions
 * differ by `docsMode`: `committed` keeps the original git add/commit
 * text verbatim; `local`/`external` forbid touching any repo file other
 * than the sprint record and redirect stale-doc observations into
 * "concerns" instead of editing them (sc-1-4).
 *
 * Exported for direct unit testing.
 */
export function buildDocumenterUserMessage(options: DocumenterUserMessageOptions): string {
  const { contract, contractJson, evalSummary, filesChanged, projectRoot, sprintDocPath, docsMode } =
    options;
  const contractId = contract.contractId;

  const header = `# Sprint Contract

${contractJson}

# Evaluation Result (Already Passed)

${evalSummary}

# Files Changed This Sprint (from the generator report)

${filesChanged}

# Project Root

${projectRoot}

# Context

- Contract ID: ${contractId}
- Spec ID: ${contract.specId}
- The implementation is ALREADY complete, evaluated, and committed.
- Your job is documentation ONLY. Do NOT modify application code, tests, configs, or build files.`;

  switch (docsMode) {
    case "committed": {
      return `${header}

# Your Task

1. Inspect what actually shipped: run \`git show --stat HEAD\` and \`git diff HEAD~1 HEAD\` on the changed files. Read the source of the key new/changed symbols — do not document from filenames alone.
2. Write a focused per-sprint record to ${sprintDocPath} (create docs/sprints/ if needed): what the sprint added, the public surface (symbols/endpoints/CLI commands/config keys with file:line), how it fits, and maintainer notes.
3. Find & update related existing docs the change made stale: grep README.md, docs/**, CLAUDE.md, AGENTS.md, ADRs, and module docs for the names of changed symbols/commands/config keys. Update only what is genuinely inaccurate or now-missing. Match each doc's existing voice and formatting.
4. Commit ONLY the documentation files (verify with \`git status\` that no source/test files are staged):
   \`git add <doc files> && git commit -m "bober(${contractId}): docs for <short title>"\`

If you believe code is wrong, do NOT fix it — record it in "concerns".

Output ONLY a JSON object (no markdown fences):
{
  "contractId": "${contractId}",
  "sprintDocPath": "${sprintDocPath}",
  "relatedDocsUpdated": [
    {"path": "<path>", "reason": "<why it was stale / what you changed>"}
  ],
  "docsCommit": "<hash> - <message>",
  "concerns": [],
  "summary": "<2-3 sentence summary>"
}`;
    }
    case "local":
    case "external": {
      const locationNote =
        docsMode === "local"
          ? "This directory is intentionally NOT committed — a deterministic pre-step already ensured it is gitignored. Do NOT edit .gitignore yourself."
          : "This location is outside the project repository entirely — do not attempt any git operation.";

      return `${header}

# Your Task

1. Inspect what actually shipped: run \`git show --stat HEAD\` and \`git diff HEAD~1 HEAD\` on the changed files. Read the source of the key new/changed symbols — do not document from filenames alone.
2. Write a focused per-sprint record to ${sprintDocPath} (create parent directories if needed): what the sprint added, the public surface (symbols/endpoints/CLI commands/config keys with file:line), how it fits, and maintainer notes. ${locationNote}
3. Do NOT modify ANY repo file other than the sprint record at ${sprintDocPath} — this includes README.md, docs/**, CLAUDE.md, AGENTS.md, ADRs, module docs, .gitignore, application code, tests, and configs. If the sprint made an existing doc stale, do NOT edit it — report it in "concerns" instead.
4. Do NOT stage or commit anything, and do NOT invoke any version-control command. No source-control operation of any kind happens in this mode.

If you believe code is wrong, do NOT fix it — record it in "concerns".

Output ONLY a JSON object (no markdown fences):
{
  "contractId": "${contractId}",
  "sprintDocPath": "${sprintDocPath}",
  "relatedDocsUpdated": [],
  "concerns": [],
  "summary": "<2-3 sentence summary>"
}`;
    }
    default: {
      // Exhaustiveness guard (TypeScript narrows here)
      const _never: never = docsMode;
      throw new Error(`Unknown docsMode: ${String(_never)}`);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────

/**
 * Run the bober-documenter subagent to write per-sprint documentation.
 *
 * Runs AFTER the evaluator returns passed=true and the sprint is committed.
 * The documenter writes a focused record of what the sprint built to
 * `docs/sprints/<contractId>.md`, finds & updates related existing docs that
 * the change made stale, and commits ONLY the doc files. It must NOT modify
 * application code or tests — the sprint already passed evaluation.
 *
 * Documentation is advisory: a documenter failure never downgrades the
 * already-passed sprint (see the caller in pipeline.ts).
 *
 * The documenter reuses the "generator" role's write-tool surface (bash,
 * read/write/edit files, glob, grep) — mirroring how runCodeReviewer reuses
 * the "evaluator" role rather than introducing a distinct AgentRole.
 *
 * @param contract        The sprint contract that just passed.
 * @param evaluation      The evaluation result (passed=true).
 * @param generatorResult The generator's result — the authoritative list of
 *                        what changed in this sprint.
 * @param projectRoot     Absolute path to the project root.
 * @param config          The resolved bober configuration.
 * @returns A DocumentationResult with the docs written and updated.
 */
export async function runDocumenter(
  contract: SprintContract,
  evaluation: EvaluationRunResult,
  generatorResult: GeneratorResult | undefined,
  projectRoot: string,
  config: BoberConfig,
): Promise<DocumentationResult> {
  const contractId = contract.contractId;
  logger.sprint(contractId, `Documenting: ${contract.title}`);

  const documenterModel = config.documenter?.model ?? config.generator.model;
  const model = resolveModel(documenterModel);
  const maxTurns = config.documenter?.maxTurns ?? 20;

  // Documenter needs WRITE access — reuse the "generator" role tool set
  // (bash, read/write/edit, glob, grep; UNION with graph_* when gated).
  const graphState = getGraphState(config);
  const graphDeps = graphState.engineHealth === "ready" ? getGraphDeps() : undefined;
  const toolSet = resolveRoleTools("generator", projectRoot, graphState, graphDeps ?? undefined);
  const systemPrompt = await assembleSystemPrompt("generator", "bober-documenter", projectRoot, graphState);

  const client = createClient(
    config.documenter?.provider ?? config.generator.provider ?? null,
    config.documenter?.endpoint ?? config.generator.endpoint ?? null,
    config.documenter?.providerConfig ?? config.generator.providerConfig,
    documenterModel,
    "Documenter",
  );

  const contractJson = JSON.stringify(contract, null, 2);
  const evalSummary = JSON.stringify(
    {
      passed: evaluation.passed,
      score: evaluation.score,
      summary: evaluation.summary,
    },
    null,
    2,
  );
  const filesChanged =
    generatorResult?.filesChanged && generatorResult.filesChanged.length > 0
      ? generatorResult.filesChanged.map((f) => `- ${f}`).join("\n")
      : "(no file list reported — derive the change set from git)";

  const docsMode: DocumenterDocsMode = config.documenter?.docsMode ?? "committed";
  const sprintDocPath = resolveSprintDocPath(config, projectRoot, contractId);

  // 'local' mode writes inside the repo but must never be committed — ensure
  // .gitignore covers the resolved docs directory before the agent runs.
  // Deterministic TS, never the LLM's job (nonGoals[3]). Advisory: a failure
  // here must not abort the (already-passed) sprint's documentation step.
  if (docsMode === "local") {
    const docsDirAbs = dirname(sprintDocPath);
    const gitignoreEntry = relative(projectRoot, docsDirAbs) || ".";
    try {
      await ensureGitignoreEntry(projectRoot, gitignoreEntry);
    } catch (err) {
      logger.warn(`Could not ensure .gitignore covers ${gitignoreEntry}: ${(err as Error).message}`);
    }
  }

  const userMessage = buildDocumenterUserMessage({
    contract,
    contractJson,
    evalSummary,
    filesChanged,
    projectRoot,
    sprintDocPath,
    docsMode,
  });

  logger.info(`Calling documenter model (${documenterModel} → ${model})...`);

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
      logger.debug(`  [documenter] ${name}(${inputStr})`);
    },
  });

  logger.debug(
    `Documenter completed in ${result.turnsUsed} turns (${result.toolsCalled.length} tool calls)`,
  );

  const docResult = parseDocumentationResult(result.finalText, contractId, sprintDocPath);

  logger.info(
    `Documentation complete: ${docResult.sprintDocPath} (+${docResult.relatedDocsUpdated.length} related docs updated, ${docResult.concerns.length} concerns)`,
  );

  return docResult;
}

// ── JSON parser ────────────────────────────────────────────────────

/**
 * Parse the documenter's response into a DocumentationResult.
 * Mirrors the resilient JSON-parsing pattern from code-reviewer-agent.ts.
 *
 * Exported for direct unit testing.
 */
export function parseDocumentationResult(
  text: string,
  contractId: string,
  defaultSprintDocPath: string,
): DocumentationResult {
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
      contractId:
        typeof obj.contractId === "string" ? obj.contractId : contractId,
      sprintDocPath:
        typeof obj.sprintDocPath === "string"
          ? obj.sprintDocPath
          : defaultSprintDocPath,
      relatedDocsUpdated: parseRelatedDocs(obj.relatedDocsUpdated),
      ...(typeof obj.docsCommit === "string" ? { docsCommit: obj.docsCommit } : {}),
      concerns: parseStringArray(obj.concerns),
      summary:
        typeof obj.summary === "string" ? obj.summary : "No summary provided.",
    };
  }

  // Fallback — documenter ran but response wasn't parseable.
  return {
    contractId,
    sprintDocPath: defaultSprintDocPath,
    relatedDocsUpdated: [],
    concerns: [],
    summary: "Documenter response could not be parsed.",
  };
}

function parseRelatedDocs(raw: unknown): RelatedDocUpdate[] {
  if (!Array.isArray(raw)) return [];

  return (raw as unknown[])
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null,
    )
    .map((item) => ({
      path: typeof item.path === "string" ? item.path : "unknown",
      reason: typeof item.reason === "string" ? item.reason : "",
    }));
}

function parseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).filter((item): item is string => typeof item === "string");
}
