import type { BoberConfig } from "../config/schema.js";
import type { PlanSpec } from "../contracts/spec.js";
import { isPipelineReady } from "../contracts/spec.js";
import type { SprintContract } from "../contracts/sprint-contract.js";
import {
  createContract,
  updateContractStatus,
} from "../contracts/sprint-contract.js";
import type { EvaluationRunResult } from "../evaluators/registry.js";
import {
  createHandoff,
  summarizeOlderSprints,
} from "./context-handoff.js";
import type { ContextHandoff, ProjectContext } from "./context-handoff.js";
import { runPlanner } from "./planner-agent.js";
import { runResearch } from "./research-agent.js";
import { runArchitect } from "./architect-agent.js";
import { runCurator } from "./curator-agent.js";
import { runGenerator } from "./generator-agent.js";
import type { GeneratorResult } from "./generator-agent.js";
import { runEvaluatorAgent } from "./evaluator-agent.js";
import {
  ensureBoberDir,
  saveContract,
  updateContract,
  appendHistory,
  readDesign,
  readOutline,
} from "../state/index.js";
import { commitAll, getCurrentBranch, getChangedFiles } from "../utils/git.js";
import { logger } from "../utils/logger.js";

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

interface SprintCycleResult {
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

// ── Sprint cycle ───────────────────────────────────────────────────

async function runSprintCycle(
  contract: SprintContract,
  spec: PlanSpec,
  completedContracts: SprintContract[],
  projectRoot: string,
  config: BoberConfig,
  projectContext: ProjectContext,
): Promise<SprintCycleResult> {
  const maxIterations = config.evaluator.maxIterations;
  let currentContract = updateContractStatus(contract, "in-progress");
  await updateContract(projectRoot, currentContract);

  let lastEvaluation: EvaluationRunResult | undefined;
  let lastGeneratorResult: GeneratorResult | undefined;

  // ── Curate (once, before the first generator attempt) ─────────
  // The curator explores the codebase and saves a Sprint Briefing to
  // .bober/briefings/<contractId>-briefing.md. The generator reads it
  // from disk as its first action.
  const curatorEnabled = config.curator?.enabled !== false;

  if (curatorEnabled) {
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

    // ── Generate ───────────────────────────────────────────────
    logger.phase(`Sprint ${currentContract.contractId} - Generate (Round ${iteration})`);

    await appendHistory(projectRoot, {
      timestamp: new Date().toISOString(),
      event: "generator-start",
      phase: "generating",
      sprintId: currentContract.contractId,
      details: { iteration },
    });

    const generatorResult = await runGenerator(
      compactedHandoff,
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
export async function runPipeline(
  userPrompt: string,
  projectRoot: string,
  config: BoberConfig,
): Promise<PipelineResult> {
  const startTime = Date.now();
  const cleanup = setupInterruptHandler();

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
    let researchDoc;
    if (config.pipeline.researchPhase !== false) {
      await appendHistory(projectRoot, {
        timestamp: new Date().toISOString(),
        event: "research-started",
        phase: "planning",
        details: { userPrompt: userPrompt.slice(0, 200) },
      });

      researchDoc = await runResearch(userPrompt, projectRoot, config);

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

    // ── Phase 2: Sprint loop ─────────────────────────────────────
    logger.phase("Sprint Execution");

    // Create sprint contracts from features.
    // These auto-generated contracts use placeholder precision fields;
    // a planner-authored contract (saved directly by the bober-planner
    // subagent) supersedes them with substantive nonGoals, stopConditions,
    // and definitionOfDone.
    const contracts: SprintContract[] = [];
    for (let i = 0; i < spec.features.length; i++) {
      const feature = spec.features[i];
      const contract = createContract(
        feature.title,
        feature.description,
        feature.acceptanceCriteria.map((ac, idx) => ({
          criterionId: `${feature.featureId}-criterion-${idx + 1}`,
          description: ac,
          verificationMethod: "agent-evaluation",
        })),
        {
          specId: spec.specId,
          sprintNumber: i + 1,
          features: [feature.featureId],
        },
      );
      contracts.push(contract);
      await saveContract(projectRoot, contract);
    }

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
