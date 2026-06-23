/**
 * Pre-flight context injection (Sprint 6, ADR-9):
 * PreflightContextInjector.inject() is called inside each agent's
 * runner before runAgenticLoop:
 *  - src/orchestrator/research-agent.ts (researcher-phase2)
 *  - src/orchestrator/architect-agent.ts
 *  - src/orchestrator/curator-agent.ts (writes to .bober/briefings/<contractId>-briefing.md)
 *  - src/orchestrator/generator-agent.ts
 *  - src/orchestrator/evaluator-agent.ts
 * Failure isolation: 5s timeout via Promise.race; preflight-failure
 * incident logged; original firstMessage returned on error.
 */
import type { BoberConfig } from "../config/schema.js";
import type { PlanSpec } from "../contracts/spec.js";
import { isPipelineReady } from "../contracts/spec.js";
import type { SprintContract } from "../contracts/sprint-contract.js";
import { updateContractStatus } from "../contracts/sprint-contract.js";
import { materializeContracts } from "./contract-materialization.js";
import type { EvaluationRunResult } from "../evaluators/registry.js";
import { persistEvalResult } from "./eval-persist.js";
import {
  createHandoff,
  summarizeOlderSprints,
} from "./context-handoff.js";
import type { ContextHandoff, ProjectContext } from "./context-handoff.js";
import { runPlanner } from "./planner-agent.js";
import { runResearch } from "./research-agent.js";
import type { ResearchDoc } from "./research-agent.js";
import { listResearch, readResearch } from "../state/research-state.js";
import { runArchitect } from "./architect-agent.js";
import { runCurator } from "./curator-agent.js";
import { runGenerator } from "./generator-agent.js";
import type { GeneratorResult } from "./generator-agent.js";
import { runEvaluatorAgent } from "./evaluator-agent.js";
import { runCodeReviewer } from "./code-reviewer-agent.js";
import { runDocumenter } from "./documenter-agent.js";
import { getCheckpointMechanismFor } from "./checkpoints/index.js";
// NOTE (Sprint 12): The feedback-router (src/orchestrator/checkpoints/feedback-router.ts)
// provides runCheckpointWithFeedback() for full iteration + abort semantics.
// Full wiring of the iterating checkpoints (post-research, post-plan, post-sprint-contract,
// post-sprint) into a retry loop is deferred — the plumbing is available via the router
// module and is exercised in its unit tests. This sprint replaces the plain
// getCheckpointMechanism("noop") calls with getCheckpointMechanismFor so that
// config overrides are honoured, which is the minimum-viable pipeline wiring.
import { writeCompletionMarker } from "./checkpoints/feedback-router.js";
// Sprint 13: audit wrapper — every checkpoint call site uses runWithAudit so
// each outcome is appended to .bober/audits/<runId>.jsonl regardless of mechanism.
import { runWithAudit, type MechanismName } from "./checkpoints/audit.js";
import { emit } from "../telemetry/emit.js";
import {
  ensureBoberDir,
  updateContract,
  appendHistory,
  readDesign,
  readOutline,
} from "../state/index.js";
import { commitAll, getCurrentBranch, getChangedFiles } from "../utils/git.js";
import { logger } from "../utils/logger.js";
import { drainGuidance } from "../state/guidance.js";
import { waitWhilePaused } from "../state/pause.js";

// ── Types ──────────────────────────────────────────────────────────

export interface PipelineResult {
  success: boolean;
  spec: PlanSpec;
  completedSprints: SprintContract[];
  failedSprints: SprintContract[];
  totalCost?: number;
  duration: number;
  /**
   * When the planner refuses to fully decompose the request (ambiguityScore
   * over threshold or open clarification questions), the pipeline stops
   * before sprint execution and sets this flag. Callers should surface
   * `spec.clarificationQuestions` to the user in this case.
   */
  needsClarification?: boolean;
}

export interface SprintCycleResult {
  contract: SprintContract;
  evaluation?: EvaluationRunResult;
  generatorResult?: GeneratorResult;
}

// ── Interrupt handling ─────────────────────────────────────────────

let interrupted = false;

function setupInterruptHandler(): () => void {
  interrupted = false;

  const handler = (): void => {
    if (interrupted) {
      // Second SIGINT — force exit
      logger.error("Force interrupted. Exiting immediately.");
      process.exit(1);
    }
    interrupted = true;
    logger.warn("Interrupt received. Finishing current sprint, then stopping...");
  };

  process.on("SIGINT", handler);
  return () => {
    process.removeListener("SIGINT", handler);
  };
}

// ── Project context helper ─────────────────────────────────────────

async function buildProjectContext(
  projectRoot: string,
  config: BoberConfig,
): Promise<ProjectContext> {
  let currentBranch: string;
  try {
    currentBranch = await getCurrentBranch(projectRoot);
  } catch {
    currentBranch = "unknown";
  }

  return {
    name: config.project.name,
    type: config.project.mode,
    techStack: [],
    entryPoints: [],
    currentBranch,
  };
}

// ── Phase 2 guidance helper ────────────────────────────────────────

/**
 * Pure helper: inject queued guidance texts into a ContextHandoff by
 * appending them to `issues`. When guidanceTexts is empty, returns the
 * SAME handoff reference unchanged (deep-equal no-op for sc-4-7).
 * Exported for direct unit testing (sc-4-6/sc-4-7).
 */
export function injectGuidanceIntoHandoff(
  handoff: ContextHandoff,
  guidanceTexts: string[],
): ContextHandoff {
  if (guidanceTexts.length === 0) return handoff;
  return {
    ...handoff,
    issues: [
      ...handoff.issues,
      ...guidanceTexts.map((g) => `Human guidance: ${g}`),
    ],
  };
}

// ── Sprint cycle ───────────────────────────────────────────────────

export async function runSprintCycle(
  contract: SprintContract,
  spec: PlanSpec,
  completedContracts: SprintContract[],
  projectRoot: string,
  config: BoberConfig,
  projectContext: ProjectContext,
  pipelineRunId?: string,
): Promise<SprintCycleResult> {
  const maxIterations = config.evaluator.maxIterations;
  let currentContract = updateContractStatus(contract, "in-progress");
  await updateContract(projectRoot, currentContract);

  // Audit runId for this sprint cycle: prefer the pipeline-level runId,
  // fall back to a sprint-specific id derived from the contract.
  const sprintRunId = pipelineRunId ?? `sprint-${currentContract.contractId}`;

  // Resolve the configured mechanism name for audit records.
  // Sprint 14: checkpointMechanism is now a real typed field in PipelineSection.
  const configuredMechanismName: MechanismName =
    (config.pipeline?.checkpointMechanism as MechanismName | undefined) ?? "noop";

  let lastEvaluation: EvaluationRunResult | undefined;
  let lastGeneratorResult: GeneratorResult | undefined;

  // ── Curate (once, before the first generator attempt) ─────────
  // The curator explores the codebase and saves a Sprint Briefing to
  // .bober/briefings/<contractId>-briefing.md. The generator reads it
  // from disk as its first action.
  const curatorEnabled = config.curator?.enabled !== false;

  if (curatorEnabled) {
    await runWithAudit({
      projectRoot,
      runId: sprintRunId,
      checkpointId: "pre-curator",
      mechanism: configuredMechanismName,
      iteration: 1,
      fn: () => getCheckpointMechanismFor("pre-curator", config, "noop").request("pre-curator", { contract: currentContract, spec, completedContracts }),
    });
    logger.phase(`Sprint ${currentContract.contractId} - Curate`);

    await appendHistory(projectRoot, {
      timestamp: new Date().toISOString(),
      event: "curator-start",
      phase: "curating",
      sprintId: currentContract.contractId,
      details: { title: currentContract.title },
    });

    try {
      const briefing = await runCurator(
        currentContract,
        spec,
        completedContracts,
        projectRoot,
        config,
      );

      logger.success(
        `Curator analyzed ${briefing.filesAnalyzed.length} files, found ${briefing.patternsFound} patterns, ${briefing.utilsIdentified} utils`,
      );

      await appendHistory(projectRoot, {
        timestamp: new Date().toISOString(),
        event: "curator-complete",
        phase: "curating",
        sprintId: currentContract.contractId,
        details: {
          filesAnalyzed: briefing.filesAnalyzed.length,
          patternsFound: briefing.patternsFound,
          utilsIdentified: briefing.utilsIdentified,
        },
      });
    } catch (err) {
      logger.warn(
        `Curator failed: ${err instanceof Error ? err.message : String(err)}. Generator will proceed without briefing.`,
      );
    }
  }

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (interrupted) {
      logger.warn(`Sprint ${currentContract.contractId} interrupted at iteration ${iteration}.`);
      break;
    }

    logger.progress(iteration, maxIterations, `Sprint ${currentContract.contractId} iteration`);

    // Build evaluation feedback from prior round
    // Pass structured feedback (not just summary) so the generator
    // gets detailed per-criterion failures, file:line references, etc.
    const evalFeedbackParts: string[] = [];
    if (lastEvaluation) {
      for (const result of lastEvaluation.results) {
        const status = result.passed ? "PASS" : "FAIL";
        evalFeedbackParts.push(
          `[${status}] ${result.evaluator}${result.score !== undefined ? ` (score: ${result.score}/100)` : ""}`,
        );
        evalFeedbackParts.push(`  Summary: ${result.summary}`);

        const failures = result.details.filter((d) => !d.passed);
        for (const detail of failures) {
          const loc = detail.file
            ? ` at ${detail.file}${detail.line !== undefined ? `:${detail.line}` : ""}`
            : "";
          evalFeedbackParts.push(
            `  [${detail.severity.toUpperCase()}] ${detail.message}${loc}`,
          );
        }

        if (!result.passed && result.feedback) {
          evalFeedbackParts.push(`  Feedback: ${result.feedback}`);
        }
      }
    }

    // Summarize older sprints to save context
    const completedSummaryHandoff = createHandoff({
      from: iteration === 1 ? "planner" : "evaluator",
      to: "generator",
      projectContext,
      spec,
      currentContract,
      sprintHistory: completedContracts,
      instructions: `Implement sprint: ${currentContract.title}\n\n${currentContract.description}`,
      changedFiles: lastGeneratorResult?.filesChanged ?? [],
      issues: evalFeedbackParts.length > 0 ? evalFeedbackParts : [],
    });

    // Compact older sprint history if needed
    const compactedHandoff = summarizeOlderSprints(completedSummaryHandoff, 3);

    // ── Phase 2 guidance injection (additive) ──────────────────────────
    // Drain any queued free-text guidance for the active run and inject it
    // into the handoff. With no guidance (or no runId) this is a no-op and
    // the handoff is byte-for-byte unchanged (sc-4-7 invariant).
    let injectedHandoff = compactedHandoff;
    if (pipelineRunId) {
      const guidance = await drainGuidance(projectRoot, pipelineRunId);
      injectedHandoff = injectGuidanceIntoHandoff(compactedHandoff, guidance);
    }

    // ── Phase 2 cooperative pause gate (additive) ──────────────────────
    // With no runId or no paused.json marker, this is a single existence
    // check (isPaused) then continue — provably additive (sc-5-7).
    if (pipelineRunId) {
      await waitWhilePaused(projectRoot, pipelineRunId);
    }

    // ── Generate ───────────────────────────────────────────────
    await runWithAudit({
      projectRoot,
      runId: sprintRunId,
      checkpointId: "pre-generator",
      mechanism: configuredMechanismName,
      iteration,
      fn: () => getCheckpointMechanismFor("pre-generator", config, "noop").request("pre-generator", { contract: currentContract, iteration, handoff: compactedHandoff }),
    });
    logger.phase(`Sprint ${currentContract.contractId} - Generate (Round ${iteration})`);

    await appendHistory(projectRoot, {
      timestamp: new Date().toISOString(),
      event: "generator-start",
      phase: "generating",
      sprintId: currentContract.contractId,
      details: { iteration },
    });

    const generatorResult = await runGenerator(
      injectedHandoff,
      projectRoot,
      config,
    );
    lastGeneratorResult = generatorResult;

    if (!generatorResult.success) {
      logger.warn(`Generator reported failure: ${generatorResult.notes}`);
      currentContract = {
        ...currentContract,
        generatorNotes: generatorResult.notes,
      };
      await updateContract(projectRoot, currentContract);

      if (iteration < maxIterations) {
        logger.info("Retrying generation...");
        continue;
      }

      // Max iterations reached, mark as needs-rework
      currentContract = updateContractStatus(currentContract, "needs-rework");
      currentContract = {
        ...currentContract,
        evaluatorFeedback: "Generator failed to complete the implementation.",
      };
      await updateContract(projectRoot, currentContract);
      return { contract: currentContract, generatorResult };
    }

    currentContract = {
      ...currentContract,
      generatorNotes: generatorResult.notes,
    };

    // Auto-commit if enabled
    if (config.generator.autoCommit) {
      try {
        const commitHash = await commitAll(
          projectRoot,
          `bober: ${currentContract.title} (sprint ${currentContract.contractId}, round ${iteration})`,
        );
        logger.success(`Committed: ${commitHash}`);
        lastGeneratorResult = { ...generatorResult, commitHash };
      } catch (err) {
        logger.debug(
          `Auto-commit skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // ── Evaluate ──────────────────────────────────────────────
    await runWithAudit({
      projectRoot,
      runId: sprintRunId,
      checkpointId: "pre-evaluator",
      mechanism: configuredMechanismName,
      iteration,
      fn: () => getCheckpointMechanismFor("pre-evaluator", config, "noop").request("pre-evaluator", { contract: currentContract, iteration, generatorResult }),
    });
    logger.phase(`Sprint ${currentContract.contractId} - Evaluate (Round ${iteration})`);

    currentContract = updateContractStatus(currentContract, "evaluating");
    await updateContract(projectRoot, currentContract);

    await appendHistory(projectRoot, {
      timestamp: new Date().toISOString(),
      event: "evaluator-start",
      phase: "evaluating",
      sprintId: currentContract.contractId,
      details: { iteration },
    });

    // Build handoff for evaluator
    let changedFiles: string[];
    try {
      changedFiles = await getChangedFiles(projectRoot);
    } catch {
      changedFiles = generatorResult.filesChanged;
    }

    const evalHandoff: ContextHandoff = {
      ...compactedHandoff,
      from: "generator",
      to: "evaluator",
      changedFiles,
    };

    const evaluation = await runEvaluatorAgent(
      evalHandoff,
      projectRoot,
      config,
    );
    lastEvaluation = evaluation;

    // Persist per-evaluator/lens detail to .bober/eval-results/ so a failing
    // round is inspectable (which evaluator/lens returned passed:false), instead
    // of only surfacing the aggregate "N/M evaluators passed" summary. Best-effort.
    await persistEvalResult(
      projectRoot,
      currentContract.contractId,
      iteration,
      evaluation,
    );

    if (evaluation.passed) {
      logger.success(`Sprint ${currentContract.contractId} passed all evaluations!`);

      currentContract = updateContractStatus(currentContract, "passed");
      currentContract = {
        ...currentContract,
        evaluatorFeedback: evaluation.summary,
      };
      await updateContract(projectRoot, currentContract);

      await appendHistory(projectRoot, {
        timestamp: new Date().toISOString(),
        event: "sprint-passed",
        phase: "complete",
        sprintId: currentContract.contractId,
        details: { iteration, feedback: evaluation.summary },
      });
      // Sprint 28 — telemetry (fire-and-forget, never throws to pipeline)
      void emit(projectRoot, config, "sprint-pass", {
        runId: sprintRunId,
        sprintId: currentContract.contractId,
        iteration,
        outcome: "passed",
      });

      // Sprint 5 — advisory code review (config-gated, time-boxed, never blocks)
      const reviewEnabled = config.codeReview?.enabled !== false;
      if (reviewEnabled) {
        await runWithAudit({
          projectRoot,
          runId: sprintRunId,
          checkpointId: "pre-code-reviewer",
          mechanism: configuredMechanismName,
          iteration,
          fn: () => getCheckpointMechanismFor("pre-code-reviewer", config, "noop").request("pre-code-reviewer", { contract: currentContract, evaluation }),
        });
        const reviewTimeoutMs = config.codeReview?.timeoutMs ?? 300_000;
        try {
          const review = await Promise.race([
            runCodeReviewer(currentContract, evaluation, projectRoot, config),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("code-review timeout")), reviewTimeoutMs),
            ),
          ]);
          await appendHistory(projectRoot, {
            timestamp: new Date().toISOString(),
            event: "code-review-complete",
            phase: "complete",
            sprintId: currentContract.contractId,
            details: {
              critical: review.critical.length,
              important: review.important.length,
              minor: review.minor.length,
            },
          });
        } catch (err) {
          logger.warn(
            `Code review skipped: ${err instanceof Error ? err.message : String(err)}`,
          );
          await appendHistory(projectRoot, {
            timestamp: new Date().toISOString(),
            event: "code-review-failed",
            phase: "complete",
            sprintId: currentContract.contractId,
            details: { error: err instanceof Error ? err.message : String(err) },
          });
          // Advisory only — sprint completion proceeds regardless.
        }
      }

      // Per-sprint documentation (config-gated, time-boxed, never blocks).
      // Runs AFTER the sprint is marked passed/committed so docs are written
      // while the change is fresh — instead of batched into a final sprint.
      const documenterEnabled = config.documenter?.enabled !== false;
      if (documenterEnabled) {
        const documenterTimeoutMs = config.documenter?.timeoutMs ?? 300_000;
        try {
          const documentation = await Promise.race([
            runDocumenter(currentContract, evaluation, lastGeneratorResult, projectRoot, config),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("documenter timeout")), documenterTimeoutMs),
            ),
          ]);
          await appendHistory(projectRoot, {
            timestamp: new Date().toISOString(),
            event: "sprint-docs-complete",
            phase: "complete",
            sprintId: currentContract.contractId,
            details: {
              sprintDocPath: documentation.sprintDocPath,
              relatedDocsUpdated: documentation.relatedDocsUpdated.length,
              concerns: documentation.concerns.length,
            },
          });
        } catch (err) {
          logger.warn(
            `Documentation skipped: ${err instanceof Error ? err.message : String(err)}`,
          );
          await appendHistory(projectRoot, {
            timestamp: new Date().toISOString(),
            event: "sprint-docs-failed",
            phase: "complete",
            sprintId: currentContract.contractId,
            details: { error: err instanceof Error ? err.message : String(err) },
          });
          // Advisory only — the sprint already passed; docs can be regenerated later.
        }
      }

      await runWithAudit({
        projectRoot,
        runId: sprintRunId,
        checkpointId: "post-sprint",
        mechanism: configuredMechanismName,
        iteration,
        fn: () => getCheckpointMechanismFor("post-sprint", config, "noop").request("post-sprint", { contract: currentContract, evaluation, generatorResult: lastGeneratorResult }),
      });
      return { contract: currentContract, evaluation, generatorResult: lastGeneratorResult };
    }

    // Evaluation failed
    logger.warn(
      `Evaluation failed (round ${iteration}/${maxIterations}): ${evaluation.summary.slice(0, 200)}`,
    );

    currentContract = {
      ...currentContract,
      evaluatorFeedback: evaluation.summary,
    };
    await updateContract(projectRoot, currentContract);

    await appendHistory(projectRoot, {
      timestamp: new Date().toISOString(),
      event: "evaluation-failed",
      phase: "rework",
      sprintId: currentContract.contractId,
      details: { iteration, feedback: evaluation.summary },
    });
    // Sprint 28 — telemetry (only emit retry if there are more iterations)
    if (iteration < maxIterations) {
      void emit(projectRoot, config, "sprint-fail-retry", {
        runId: sprintRunId,
        sprintId: currentContract.contractId,
        iteration,
        retryCount: iteration,
      });
    }

    if (iteration >= maxIterations) {
      logger.error(
        `Sprint ${currentContract.contractId} exceeded max iterations (${maxIterations}).`,
      );
      currentContract = updateContractStatus(currentContract, "needs-rework");
      await updateContract(projectRoot, currentContract);
      return { contract: currentContract, evaluation };
    }

    logger.info("Feeding evaluation feedback into next iteration...");
  }

  // Should not normally reach here
  return { contract: currentContract, evaluation: lastEvaluation };
}

// ── Main pipeline ──────────────────────────────────────────────────

/**
 * Run the complete orchestration pipeline:
 *
 * 1. **Plan** — Call the planner agent to produce a PlanSpec
 * 2. **Sprint loop** — For each feature, create sprint contracts and
 *    run the generate-evaluate-iterate cycle
 * 3. **Result** — Return aggregated results
 *
 * Each agent invocation is a FRESH call (new message thread). Context
 * is carried via the ContextHandoff document.
 */
/**
 * Internal implementation: the original TypeScript pipeline body.
 * Extracted so TsPipelineEngine can wrap it without an import cycle.
 * Do NOT change the algorithm, phase order, or .bober/ write behaviour here.
 */
export async function runTsPipeline(
  userPrompt: string,
  projectRoot: string,
  config: BoberConfig,
  opts?: { runId?: string },
): Promise<PipelineResult> {
  const startTime = Date.now();
  const cleanup = setupInterruptHandler();

  // Create a stable runId at the start of the pipeline so all audit entries
  // (including pre-spec pipeline checkpoints) share the same run identifier.
  // Honor a caller-supplied runId (e.g. from chat spawn) or self-generate.
  const pipelineRunId = opts?.runId ?? `run-${Date.now()}`;

  // Resolve mechanism name from config for audit records.
  // Sprint 14: checkpointMechanism is now a real typed field in PipelineSection.
  const pipelineMechanismName: MechanismName =
    (config.pipeline?.checkpointMechanism as MechanismName | undefined) ?? "noop";

  try {
    // Ensure .bober/ directory structure exists
    await ensureBoberDir(projectRoot);

    await appendHistory(projectRoot, {
      timestamp: new Date().toISOString(),
      event: "pipeline-start",
      phase: "init",
      details: { userPrompt: userPrompt.slice(0, 200) },
    });

    // ── Phase 0: Research (optional) ────────────────────────────
    let researchDoc: ResearchDoc | undefined;
    if (config.pipeline.researchPhase !== false) {
      await appendHistory(projectRoot, {
        timestamp: new Date().toISOString(),
        event: "research-started",
        phase: "planning",
        details: { userPrompt: userPrompt.slice(0, 200) },
      });

      // Reuse a previously-saved research doc for this prompt instead of
      // regenerating (saves tokens on re-runs after a later-phase failure).
      // Force fresh generation with BOBER_FRESH_RESEARCH=1.
      researchDoc = undefined;
      if (process.env["BOBER_FRESH_RESEARCH"] !== "1") {
        const slug = userPrompt
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, "")
          .trim()
          .split(/\s+/)
          .slice(0, 5)
          .join("-")
          .slice(0, 40);
        try {
          const existingIds = (await listResearch(projectRoot))
            .filter((id) => new RegExp(`^research-\\d{8}-${slug}$`).test(id))
            .sort();
          const reuseId = existingIds[existingIds.length - 1];
          if (reuseId) {
            researchDoc = await readResearch(projectRoot, reuseId);
            logger.info(
              `Reusing saved research "${reuseId}" (set BOBER_FRESH_RESEARCH=1 to regenerate).`,
            );
          }
        } catch (err) {
          logger.debug(
            `Research reuse check failed, regenerating: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (!researchDoc) {
        researchDoc = await runResearch(userPrompt, projectRoot, config);
      }

      const researchLineCount = researchDoc.findings.split("\n").length;
      await appendHistory(projectRoot, {
        timestamp: new Date().toISOString(),
        event: "research-completed",
        phase: "planning",
        details: {
          researchId: researchDoc.id,
          lineCount: researchLineCount,
          filesExplored: researchDoc.filesExplored.length,
          questionsAnswered: researchDoc.questionsAnswered,
        },
      });
      await runWithAudit({
        projectRoot,
        runId: pipelineRunId,
        checkpointId: "post-research",
        mechanism: pipelineMechanismName,
        iteration: 1,
        fn: () => getCheckpointMechanismFor("post-research", config, "noop").request("post-research", researchDoc),
      });
    }

    // ── Phase 0b: Architecture (optional) ───────────────────────
    let architectDoc: string | undefined;
    if (config.pipeline.architectPhase) {
      await appendHistory(projectRoot, {
        timestamp: new Date().toISOString(),
        event: "architect-started",
        phase: "planning",
        details: { userPrompt: userPrompt.slice(0, 200) },
      });

      const architectResult = await runArchitect(
        userPrompt,
        projectRoot,
        config,
        researchDoc?.findings,
      );

      // Log a checkpoint event for each ADR produced (one per decision)
      for (let i = 0; i < architectResult.decisionCount; i++) {
        await appendHistory(projectRoot, {
          timestamp: new Date().toISOString(),
          event: "architect-checkpoint",
          phase: "planning",
          details: {
            architectId: architectResult.id,
            checkpointNumber: i + 1,
          },
        });
      }

      await appendHistory(projectRoot, {
        timestamp: new Date().toISOString(),
        event: "architect-completed",
        phase: "planning",
        details: {
          architectId: architectResult.id,
          componentCount: architectResult.componentCount,
          decisionCount: architectResult.decisionCount,
          documentLines: architectResult.document.split("\n").length,
        },
      });

      // Pass only the document string to the planner — not the full result
      // object. The adrs are already saved to disk.
      architectDoc = architectResult.document;
    }

    // ── Phase 1: Planning ────────────────────────────────────────
    const plannerResult = await runPlanner(
      userPrompt,
      projectRoot,
      config,
      researchDoc,
      architectDoc,
    );
    const spec = plannerResult.spec;

    if (plannerResult.kind === "needs-clarification" || !isPipelineReady(spec)) {
      // Planner refused to fully decompose the request — block here rather
      // than enqueueing meaningless sprints. The user must answer the open
      // clarification questions and re-run.
      const open = spec.clarificationQuestions.length;
      logger.warn(
        `Plan "${spec.title}" needs clarification before sprints can run (${open} open ${open === 1 ? "question" : "questions"}).`,
      );
      logger.info(
        `Resolve via: bober plan answer ${spec.specId} <questionId> "<answer>"`,
      );
      logger.info(
        "Or edit the spec file directly and flip status to 'ready'.",
      );

      await appendHistory(projectRoot, {
        timestamp: new Date().toISOString(),
        event: "planning-needs-clarification",
        phase: "planning",
        details: {
          specId: spec.specId,
          openQuestions: open,
          ambiguityScore: spec.ambiguityScore,
        },
      });

      const duration = Date.now() - startTime;
      return {
        success: false,
        spec,
        completedSprints: [],
        failedSprints: [],
        duration,
        needsClarification: true,
      };
    }

    logger.info(`Plan: "${spec.title}" with ${spec.features.length} features`);

    // Log design-created event if design doc was saved by the planner
    try {
      const designContent = await readDesign(projectRoot, spec.specId);
      const designLineCount = designContent.split("\n").length;
      await appendHistory(projectRoot, {
        timestamp: new Date().toISOString(),
        event: "design-created",
        phase: "planning",
        details: { specId: spec.specId, lineCount: designLineCount },
      });
    } catch {
      // Design doc is optional — planner may not have saved it
    }

    // Log outline-created event if outline was saved by the planner
    try {
      const outlineContent = await readOutline(projectRoot, spec.specId);
      const outlineLineCount = outlineContent.split("\n").length;
      await appendHistory(projectRoot, {
        timestamp: new Date().toISOString(),
        event: "outline-created",
        phase: "planning",
        details: { specId: spec.specId, lineCount: outlineLineCount },
      });
    } catch {
      // Outline is optional — planner may not have saved it
    }

    await appendHistory(projectRoot, {
      timestamp: new Date().toISOString(),
      event: "planning-complete",
      phase: "planning",
      details: {
        specId: spec.specId,
        featureCount: spec.features.length,
      },
    });
    await runWithAudit({
      projectRoot,
      runId: pipelineRunId,
      checkpointId: "post-plan",
      mechanism: pipelineMechanismName,
      iteration: 1,
      fn: () => getCheckpointMechanismFor("post-plan", config, "noop").request("post-plan", spec),
    });

    // ── Phase 2: Sprint loop ─────────────────────────────────────
    logger.phase("Sprint Execution");

    const contracts = await materializeContracts(spec, projectRoot, config);
    await runWithAudit({
      projectRoot,
      runId: pipelineRunId,
      checkpointId: "post-sprint-contract",
      mechanism: pipelineMechanismName,
      iteration: 1,
      fn: () => getCheckpointMechanismFor("post-sprint-contract", config, "noop").request("post-sprint-contract", contracts),
    });

    const completedSprints: SprintContract[] = [];
    const failedSprints: SprintContract[] = [];

    const projectContext = await buildProjectContext(projectRoot, config);
    const maxSprints = Math.min(contracts.length, config.sprint.maxSprints);

    for (let i = 0; i < maxSprints; i++) {
      if (interrupted) {
        logger.warn("Pipeline interrupted by user.");
        break;
      }

      const contract = contracts[i];
      logger.progress(i + 1, maxSprints, contract.title);

      const result = await runSprintCycle(
        contract,
        spec,
        completedSprints,
        projectRoot,
        config,
        projectContext,
        pipelineRunId,
      );

      if (result.contract.status === "passed") {
        completedSprints.push(result.contract);
      } else {
        failedSprints.push(result.contract);

        // Check if we should continue after failure
        if (
          config.sprint.requireContracts &&
          result.contract.status !== "needs-rework"
        ) {
          logger.error(
            `Sprint ${result.contract.contractId} failed and contracts are required. Stopping pipeline.`,
          );
          break;
        }
      }
    }

    // ── Phase 3: Results ─────────────────────────────────────────
    logger.phase("Pipeline Complete");

    const duration = Date.now() - startTime;
    const success =
      failedSprints.length === 0 && completedSprints.length > 0;

    await appendHistory(projectRoot, {
      timestamp: new Date().toISOString(),
      event: "pipeline-complete",
      phase: success ? "complete" : "failed",
      details: {
        completed: completedSprints.length,
        failed: failedSprints.length,
        durationMs: duration,
      },
    });

    await runWithAudit({
      projectRoot,
      runId: pipelineRunId,
      checkpointId: "end-of-pipeline",
      mechanism: pipelineMechanismName,
      iteration: 1,
      fn: () => getCheckpointMechanismFor("end-of-pipeline", config, "noop").request("end-of-pipeline", { success, completedSprints, failedSprints, duration, spec }),
    });
    // Write completion marker for successful runs (Sprint 12 — s12-c2).
    await writeCompletionMarker(projectRoot, pipelineRunId, {
      success,
      completedSprints: completedSprints.length,
      failedSprints: failedSprints.length,
      duration,
    });
    return {
      success,
      spec,
      completedSprints,
      failedSprints,
      duration,
    };
  } finally {
    cleanup();
  }
}

// ── Engine-selection seam ──────────────────────────────────────────

import { selectPipelineEngineForTeam } from "./workflow/selector.js";
import { loadTeam } from "../teams/registry.js";
import { seedProjectFacts } from "./memory/fact-detector.js";

/**
 * Public entry point. Resolves the configured pipeline engine and delegates.
 * Signature is frozen — callers must not be updated when the engine changes.
 *
 * opts.teamId selects the active team (Phase 4). With no teamId, resolves to
 * 'programming', whose pipelineShape === resolveEngineName(config) — identical
 * to today's selectPipelineEngine(config) behaviour.
 */
export async function runPipeline(
  userPrompt: string,
  projectRoot: string,
  config: BoberConfig,
  opts?: { runId?: string; teamId?: string },
): Promise<PipelineResult> {
  const teamId = opts?.teamId ?? config.defaultTeam;
  const team = loadTeam(config, teamId);

  // ── Sprint 5: deterministic project-fact auto-producer (best-effort) ──
  // A facts failure must NEVER abort a pipeline run.
  try {
    await seedProjectFacts(projectRoot, team.memoryNamespace || undefined);
  } catch (err) {
    logger.warn(
      `Project-fact seeding skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return selectPipelineEngineForTeam(team, config).run(userPrompt, projectRoot, config, opts);
}
