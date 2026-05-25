import type { CheckpointId } from "./types.js";

/**
 * Static enumeration of all checkpoint sites the orchestrator invokes.
 * Each entry documents WHICH artifact the site surfaces (matches the
 * variable name in scope at pipeline.ts at that location).
 *
 * Adding a new site requires: (a) add the literal to CheckpointId in types.ts,
 * (b) add the row here with file:line + artifact description, (c) add the
 * one-line `await getCheckpointMechanism(...).request(id, artifact)` to
 * pipeline.ts at the documented location.
 */
export interface CheckpointSite {
  id: CheckpointId;
  /** When the site fires, in plain English. */
  when: string;
  /** What artifact (variable + type) is surfaced. */
  artifact: string;
  /** Pipeline.ts location for traceability (file:line at sprint authoring time). */
  pipelineLocation: string;
}

export const CHECKPOINT_SITES: readonly CheckpointSite[] = [
  {
    id: "post-research",
    when: "After researcher finalizes .bober/research/<id>-research.md",
    artifact: "researchDoc: ResearchDoc (full findings, filesExplored, questionsAnswered)",
    pipelineLocation: "src/orchestrator/pipeline.ts:~479",
  },
  {
    id: "post-plan",
    when: "After planner produces and saveSpec()-s a PlanSpec",
    artifact: "spec: PlanSpec (full features[] tree)",
    pipelineLocation: "src/orchestrator/pipeline.ts:~614",
  },
  {
    id: "post-sprint-contract",
    when: "After all sprint contracts are auto-generated and saveContract()-d",
    artifact: "contracts: SprintContract[]",
    pipelineLocation: "src/orchestrator/pipeline.ts:~643",
  },
  {
    id: "pre-curator",
    when: "Just before runCurator() is spawned inside runSprintCycle",
    artifact: "{ contract: SprintContract, spec: PlanSpec, completedContracts: SprintContract[] }",
    pipelineLocation: "src/orchestrator/pipeline.ts:~139",
  },
  {
    id: "pre-generator",
    when: "Just before runGenerator() is spawned (per iteration)",
    artifact: "{ contract: SprintContract, iteration: number, handoff: ContextHandoff }",
    pipelineLocation: "src/orchestrator/pipeline.ts:~233",
  },
  {
    id: "pre-evaluator",
    when: "Just before runEvaluatorAgent() is spawned (per iteration)",
    artifact: "{ contract: SprintContract, iteration: number, generatorResult: GeneratorResult }",
    pipelineLocation: "src/orchestrator/pipeline.ts:~295",
  },
  {
    id: "pre-code-reviewer",
    when: "Inside `if (evaluation.passed && reviewEnabled)`, before runCodeReviewer Promise.race",
    artifact: "{ contract: SprintContract, evaluation: EvaluationRunResult }",
    pipelineLocation: "src/orchestrator/pipeline.ts:~351",
  },
  {
    id: "post-sprint",
    when: "Sprint passed branch, just before `return { contract, evaluation, generatorResult }`",
    artifact: "{ contract, evaluation, generatorResult }",
    pipelineLocation: "src/orchestrator/pipeline.ts:~385",
  },
  {
    id: "end-of-pipeline",
    when: "After pipeline-complete history event, just before final return",
    artifact: "{ success, completedSprints, failedSprints, duration, spec } (PipelineResult shape)",
    pipelineLocation: "src/orchestrator/pipeline.ts:~703",
  },
] as const;
