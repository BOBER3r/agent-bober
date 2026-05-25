# Changelog

All notable changes to `agent-bober` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`bober_list_active_runs`**: Lists all runs tracked by the RunManager. Accepts optional `{ status?: 'running'|'completed'|'failed'|'aborted' }` filter. Returns a JSON array of RunState objects. Omit the filter to get all runs regardless of status.
- **`bober_get_run_status`**: Fetches the full RunState for a specific run by `runId`. Input: `{ runId: string }` (required). Returns the complete RunState JSON or `{ error: 'Run not found: <runId>' }` when the runId is unknown.
- **`bober_abort_run`**: Aborts a currently running pipeline run. Input: `{ runId: string, reason?: string }`. Flips `status` to `'aborted'`, persists `abortedAt` and `abortReason` to `state.json`, and returns `{ runId, status: 'aborted', abortedAt }`. Returns `{ error: 'Run not found: <runId>' }` for unknown runs, `{ error: 'Run is not active' }` for non-running runs. Note: this sprint flips state only; forceful in-flight subprocess termination (SIGTERM propagation) is deferred to a future hardening sprint.
- **`RunState.status`** type union widened to include `'aborted'`; new optional fields `abortedAt?: string` and `abortReason?: string` added.

## [0.14.0] — 2026-05-25

Bober Vision — agent-bober becomes a four-mode software engineering teammate
instead of a single-mode autopilot. The pipeline you already know is Mode 1;
the other three modes share its scaffolding (planner, evaluator, audit log)
but pause at different boundaries and operate at different blast radii.

The headline change: it is now safe to delegate production-touching work.
Careful-flow gates every meaningful boundary; Diagnose has a native vocabulary
for incidents; Postmortem auto-synthesizes from the audit trail.

See [VISION.md](./VISION.md) for the full design rationale and example flows.

### Added

- **Mode 1 — Autopilot** (unchanged): the existing generator-evaluator loop.
  Use for spikes and greenfield. `bober run`.
- **Mode 2 — Careful-flow**: checkpoint-gated execution. Every
  research/plan/sprint boundary surfaces a diff and waits for approval via
  CLI prompt, disk marker (`.bober/approvals/*.pending.json`), or GitHub PR.
  Per-run audit log at `.bober/audits/<runId>.jsonl`. New CLI:
  `bober approve <checkpointId>`, `bober reject <checkpointId>`,
  `bober list-approvals`, `bober audit-show <runId>`.
- **Mode 3 — Diagnose**: production-incident response. Generic observability
  MCP plugin slots (any MCP server matching the schema can supply metrics
  and logs). Structured incident timeline at `.bober/incidents/<id>/`.
  Change-management gates around destructive actions. Playbook library
  searchable by symptom. New CLI: `bober incident [start|status|end|list|abort]`,
  `bober rollback <incidentId>`, `bober playbook [list|show|search]`.
- **Mode 4 — Postmortem**: auto-synthesized from incident artifacts when an
  incident transitions to `resolved`. Every claim has an inline citation
  back to timeline/changelog/observations. Required sections enforced
  (TL;DR, Impact, Timeline, Root Cause 5-Whys, Contributing Factors, What
  Went Well, What Went Wrong, Action Items). New CLI:
  `bober postmortem [generate|show] <incidentId>`.
- **Behavioral discipline foundation** (verbatim port of obra/superpowers):
  Iron Laws, Red Flags, Rationalization-Prevention tables, SessionStart
  bootstrap, anti-pattern catalog, AGENTS.md contract. Surfaces as 9 new
  universal skills: `bober.using-bober`, `bober.verify`, `bober.debug`,
  `bober.code-review`, `bober.incident`, `bober.diagnose`, `bober.deploy`,
  `bober.runbook`, `bober.postmortem`. Installed by `agent-bober init` and
  copied to `.claude/commands/`.
- **4 new agent definitions** in `agents/`: `bober-code-reviewer`,
  `bober-diagnoser`, `bober-deployer`, `bober-postmortemer`.
- **Opt-in local-only telemetry** (default OFF). When enabled, writes mode-0600
  JSONL events to `.bober/telemetry/<date>.jsonl`. ESLint rule
  (`no-restricted-imports` + `no-restricted-globals`) scoped to
  `src/telemetry/**` blocks all network primitives at lint time. Privacy
  invariant: only IDs, counts, durations, and enums in payloads; never
  user-content strings. New CLI: `bober telemetry [status|purge|export]`.
- **Config schema migration**: `bober config migrate` rewrites an existing
  `bober.config.json` to explicitly include all new vision-era fields with
  default values. Back-compat parsing handles missing fields automatically —
  the migrate command is informative, not required.
- **Mode + checkpoint config**: `pipeline.mode` (`autopilot` | `careful`,
  default `autopilot`), `pipeline.checkpointMechanism` (`noop` | `disk` |
  `cli` | `github-pr`, default `noop`). All optional; absence means autopilot.
- **End-to-end correctness gate**: `tests/e2e/four-modes.test.ts` (11 tests)
  exercises all four modes on a fixture project. Uses the real
  `DiskCheckpointMechanism` (not a mock), spawns the real
  `ExternalMcpServer` subprocess for the MCP protocol boundary, runs the
  real incident lifecycle including `verifyResolution`, and validates the
  auto-generated postmortem against the required-sections + citation rules.

### Changed

- `src/cli/commands/init.ts`: `UNIVERSAL_COMMANDS` extended with the 9 new
  vision skills. `agentFiles` extended with the 4 new agent definitions.
  All vision-era surfaces now ship with every brownfield/preset init.
- `VISION.md`, `README.md`, `AGENTS.md` updated to document the four modes,
  the careful-flow mechanisms, the incident lifecycle, the telemetry
  guarantee, and the slash-command set.

### Tests

563 → **1115 tests passing** across 82 test files (4 pre-existing skipped).
New test coverage includes: incident timeline + state machine, resolution
verification, rollback (full + per-step gates), postmortem section/citation
assertions, playbook search, careful-flow integration, observability MCP
spawn, deployer change classification + ChangeEntry recording, config
schema back-compat, telemetry writer (mode-0600, default-off, concurrency,
privacy), CLI subcommands for config/telemetry.

### Backward compatibility

- Existing `bober.config.json` files (pre-vision) parse cleanly with the
  extended schema — all new fields are optional and default to current
  autopilot behavior. No migration required.
- Existing CLI surface (`bober plan`, `bober sprint`, `bober eval`,
  `bober run`, `bober graph`, etc.) is unchanged.
- Telemetry defaults OFF. No network egress under any condition; enforced
  statically by ESLint and verified at runtime.

## [0.13.0] — 2026-05-24

Graph (tokensave) integration — user-facing CLI commands and slash-command skills for code-graph workflows.

### Added

- **`agent-bober graph [init|sync|status]`** — manage the code graph index.
  - `init`: runs `tokensave init`, writes `.bober/graph/manifest.json`. Exits 2 with platform-aware install hint when tokensave is missing.
  - `sync [--force]`: re-indexes changed files (full re-index with `--force`). Updates manifest.
  - `status [--json]`: prints `{ready, indexedFileCount, tokensaveVersion, lastSyncedHeadSha, stale}`. Human-readable or JSON.
- **`agent-bober onboard`** — generate 5 onboarding markdown files in `.bober/onboarding/` using the code graph (architecture overview, hotspots, knowledge gaps, communities, README). Prints a summary table on completion.
- **`agent-bober impact <symbol|file>`** — analyse the impact radius of a symbol or file. Writes `.bober/graph/impact/<slug>.md` with sections `# Impact: <target>`, `## Affected symbols`, `## Tests covering this symbol`.
- **3 new universal skills** (installed in all presets and brownfield):
  - `skills/bober.graph/SKILL.md` (`/bober-graph`) — code graph management
  - `skills/bober.onboard/SKILL.md` (`/bober-onboard`) — onboarding doc generation
  - `skills/bober.impact/SKILL.md` (`/bober-impact`) — impact analysis (with `argument-hint: <symbol|file>`)
- **`scripts/e2e-graph-smoke.sh`** — end-to-end smoke test script (gates on tokensave binary availability).
- Architecture document: [`.bober/architecture/arch-20260524-port-code-review-graph-architecture.md`](.bober/architecture/arch-20260524-port-code-review-graph-architecture.md)

### Changed

- All 3 graph commands respect `graph.enabled=false` — exit 1 with message: *"Graph integration is disabled. Enable via `graph.enabled: true` in bober.config.json."*
- `src/cli/commands/init.ts` skill map: `bober.graph`, `bober.onboard`, `bober.impact` added to `UNIVERSAL_COMMANDS` — included in every preset and brownfield init.

### KPI gate result

60% combined reduction (synthetic-fixture baseline; real-pipeline measurement via `node scripts/run-kpi-gate.mjs`).

### Tests

549 → **563 tests passing** (added 14 tests: slug derivation, command success paths, disabled-graph paths, skill bundle frontmatter, init.ts skill inclusion).

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
