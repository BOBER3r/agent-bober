# Changelog

All notable changes to `agent-bober` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.12.0] — 2026-04-17

Tuned for Claude Opus 4.7 — the model now follows instructions literally and
no longer fills in blanks left by vague specs. This release pushes precision
discipline through the contract schemas, the planner, the generator, and the
evaluator so the harness stops doing bad work silently.

### Added

- **Structural ambiguity-score clarification gate.** Plans that are too vague
  to safely decompose are no longer fabricated into broken sprints. The
  planner now emits `status: "needs-clarification"` with structured
  `clarificationQuestions`, and the pipeline blocks until the user answers.
- **`bober plan answer <specId> [<questionId> "<answer>"]` CLI command.**
  Resolves clarification questions one-shot or via interactive walkthrough
  with `prompts`. Auto-promotes the spec to `status: "ready"` when the last
  open question is answered.
- **`PlanSpec` precision fields:** `status` (lifecycle enum), `mode`,
  `ambiguityScore` (0-10), `clarificationQuestions`, `resolvedClarifications`,
  `assumptions`, `outOfScope`. New helpers in `src/contracts/spec.ts`:
  `hasOpenClarifications`, `getOpenClarifications`, `isPipelineReady`,
  `resolveClarification`.
- **`SprintContract` precision fields:** `nonGoals`, `stopConditions`,
  `definitionOfDone`, `assumptions`, `outOfScope`, `ambiguityScore`. New
  helpers: `findPrecisionIssues`, `isContractPrecise`. `saveContract` rejects
  contracts containing banned vague phrases (`"works correctly"`,
  `"looks good"`, etc.).
- **Generator preflight (Step 0)** — refuses to start work on contracts with
  placeholder or missing precision fields, returning `status: "blocked"`
  immediately rather than burning tokens on a doomed implementation.
- **Evaluator nonGoals/outOfScope adherence check (Step 5.5)** — converts each
  contract `nonGoal` into a concrete `git diff` check; one violation fails
  the whole sprint regardless of success-criteria results.
- **`PlannerResult` discriminated union** — `runPlanner` returns
  `{ kind: "ready", spec } | { kind: "needs-clarification", spec }`. Callers
  must narrow on `kind`.
- **Migration script** at `scripts/migrate-specs.mjs` — converts legacy
  PlanSpec JSON files (`projectType` → `mode`, `id` → `featureId`,
  priority enum, etc.) to the new schema. Idempotent.
- **`scripts/sync-skills.mjs`** — splits inlined `.claude/commands/*.md`
  back into canonical `skills/*/SKILL.md` + `references/*.md` so the shipped
  npm package always matches the local install.
- New `CHANGELOG.md`.

### Changed

- **PlanSpec field renames:** `id` → `specId`, `projectType` → `mode`,
  `nonFunctional` → `nonFunctionalRequirements`. Feature shape: `id` →
  `featureId`, priority enum `must|should|could` → `must-have|should-have|nice-to-have`,
  `estimatedSprints` → `estimatedComplexity` (low/medium/high).
- **SprintContract field renames:** `id` → `contractId`, `feature` → `title`,
  `expectedChanges` → `estimatedFiles`. Criterion shape: `id` → `criterionId`,
  added required `required: boolean`, removed runtime-only `passed`.
  `verificationMethod` is now a strict enum
  (`manual|typecheck|lint|unit-test|playwright|api-check|build|agent-evaluation`)
  — free-form values are rejected.
- **Bumped Claude model defaults** to current valid IDs:
  `sonnet → claude-sonnet-4-6`, `haiku → claude-haiku-4-5`. `opus` was
  already correct at `claude-opus-4-7`.
- **Pipeline (`runPipeline`)** branches on `PlannerResult.kind`. When
  clarification is needed it logs the open questions, appends a
  `planning-needs-clarification` history event, and returns
  `{ success: false, needsClarification: true }` without spawning sprints.
- **Skills (`bober.plan`, `bober.run`, `bober.sprint`)** updated with
  spec-status triage, clarification surfacing, and the planner-result branch.
- **Agent prompts (`bober-planner`, `bober-generator`, `bober-evaluator`)**
  rewritten for the new schemas and the precision/clarification gates. Planner
  now emits Format A (ready) or Format B (needs-clarification) JSON summary.

### Migration notes

Existing on-disk PlanSpec files are migrated automatically by
`scripts/migrate-specs.mjs` (run once after upgrading; idempotent on
re-runs). Existing SprintContract files keep their richer on-disk shape but
must satisfy the new precision-field minimums when re-saved — re-running the
planner against an existing spec is the recommended path. Direct API
consumers of `runPlanner` must update to handle the new
`PlannerResult` discriminated return type.

### Fixed

- `loadSpec` / `listSpecs` no longer silently drop on-disk specs that the
  Zod schema didn't recognize. The schema now matches reality plus the new
  fields, and `saveContract` enforces the precision gate at the boundary.
- Removed a duplicate `<!-- Reference: contract-schema.md -->` block that had
  crept into `skills/bober.sprint/SKILL.md` from a previous re-init.

### Tests

225 → **251 tests passing** (added 22 spec-schema tests + 4 plan-answer CLI
tests; zero regressions in existing suites).
