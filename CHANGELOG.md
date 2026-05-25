# Changelog

All notable changes to `agent-bober` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`bober_list_pending_approvals`**: List all pending careful-flow checkpoints awaiting human
  approval. Accepts optional `{ projectPath?: string }` (must be absolute when supplied; defaults
  to cwd). Returns `[{ checkpointId, ageMs, prompt }]` — identical shape to `bober list-approvals
  --json`. Backed by the new shared `listPendingApprovals(projectRoot)` helper in
  `src/state/approval-state.ts`.
- **`bober_approve_checkpoint`**: Approve a pending checkpoint over MCP by writing
  `.bober/approvals/<id>.approved.json` with the same payload shape as `bober approve`
  (`{ approvedAt, approverId, editDelta? }`). Accepts `{ checkpointId, projectPath?, editDelta? }`.
  Guards with `pendingExists` before writing. Returns `{ approvedAt, checkpointId }`.
- **`bober_reject_checkpoint`**: Reject a pending checkpoint over MCP by writing
  `.bober/approvals/<id>.rejected.json` with the same payload shape as `bober reject`
  (`{ rejectedAt, rejecterId, feedback }`). Accepts `{ checkpointId, projectPath?, feedback }`
  (feedback required and non-empty). Guards with `pendingExists` before writing.
  Returns `{ rejectedAt, checkpointId }`.
- **`bober_list_projects`**: Enumerate bober projects under one or more search roots.
  Accepts `{ searchRoots: string[] }`. Walks each root one level deep; returns
  `[{ projectPath, name, mode?, hasActiveRuns, lastRunAt? }]` for every directory
  containing `bober.config.json`. Unreadable roots are skipped with a stderr warning.
  READ-ONLY — does not instantiate RunManager; reads `.bober/runs/*/state.json` directly.
- **`bober_list_specs`**: List PlanSpecs in a project. Accepts `{ projectPath }`.
  Reads `.bober/specs/*.json` with loose parsing (invalid files silently skipped).
  Returns `[{ specId, title, status, sprintCount, completedAt? }]`.
- **`bober_get_project_state`**: Aggregate per-project state counts for the cockpit sidebar.
  Accepts `{ projectPath }`. Returns `{ configExists, activeRunCount, lastRunAt?,
  openIncidentCount, pendingApprovalCount, specCount, mode? }`. READ-ONLY — does not
  instantiate RunManager.
- All six new tools accept an optional `projectPath` (required for discovery tools; optional
  for approval tools). When supplied, `projectPath` must be absolute — a relative path returns
  a soft-error JSON `{ error: "projectPath must be absolute" }` rather than throwing.
- **`listPendingApprovals(projectRoot)`** helper extracted from
  `src/cli/commands/list-approvals.ts` into `src/state/approval-state.ts`. Both the CLI and
  the MCP tool `bober_list_pending_approvals` share this helper. Exported from
  `src/state/index.ts` as `listPendingApprovals` / `PendingApprovalRow`.
- **`readRunStatesFromDisk(projectRoot)`** helper added to `src/state/run-state.ts` as a
  named alias for `listRunStateFiles`. Exported from `src/state/index.ts`. Cockpit discovery
  tools use it to enumerate run states for arbitrary project roots without touching the
  RunManager singleton.
- MCP tool count: **23 → 29**.

- **`bober_run_in_worktree`**: Start a pipeline inside an isolated git worktree on a new branch.
  Input: `{ task: string, allowDirty?: boolean, keepOnSuccess?: boolean }`. Returns
  `{ runId, branch, worktreePath, status: 'running' }` immediately (fire-and-forget like `bober_run`).
  Multiple worktree runs can execute concurrently on the same project. Use `bober_get_run_status`
  to track progress.
- **`bober worktree run <task>`** CLI subcommand mirroring the MCP tool. Flags:
  `--allow-dirty` (skip uncommitted-changes guard), `--keep-on-success` (retain worktree after success).
  Prints `{ runId, branch, worktreePath, projectRoot }` JSON to stdout.
- **`runInWorktree(task, projectRoot, config, opts)`** (`src/orchestrator/worktree.ts`): the shared helper
  the CLI and MCP tool both use. Creates a git worktree under `<pipeline.worktreeRoot>/<runId>` on a
  branch derived from `generator.branchPattern`, runs the pipeline inside it, and on success removes
  the worktree per `pipeline.cleanupWorktreeOnSuccess`. On failure (or if `--keep-on-success`/`keepOnSuccess`)
  the worktree is retained for debugging and its path is printed to stderr.
- **`pipeline.worktreeRoot`** config field: directory (relative to projectRoot) under which
  worktrees are created. Default `.bober/worktrees`.
- **`pipeline.cleanupWorktreeOnSuccess`** config field: when true (default), remove the worktree
  via `git worktree remove` after a successful run. On failure the worktree is always retained.
- **`RunState.worktreePath`** and **`RunState.branch`** optional fields. Populated by `runInWorktree`
  before the pipeline starts; surfaced in `bober_get_run_status` output.
- **`RunManager.startRun(task, projectRoot, config, pipelineFn?, opts?)`** signature extended with
  optional `opts: { runId?, worktreePath?, branch? }`. Existing 3- and 4-arg callers are unchanged.
- **`git.ts`** helpers: `addWorktree`, `removeWorktree`, `isClean` shelling out to git CLI (no new deps).

### Follow-ups (documented, NOT implemented this sprint)

- Garbage collection of orphaned worktrees from prior failed runs (`bober worktree prune`).
- Worktree-aware bober_status (the cockpit uses bober_get_run_status by runId instead).
- Cross-worktree merge automation.

- **`bober_subscribe_events`**: Subscribe to runId-scoped live events. Input: `{ runId: string, since?: string }`. Returns `{ subscriptionId, status: 'subscribed', startedAt }`. The server begins emitting `bober/events` notifications for every line appended to `.bober/history.jsonl` or `.bober/telemetry/<date>.jsonl` whose `runId` matches the subscription. The optional `since` parameter triggers a one-time backfill of pre-existing events with `timestamp > since`.
- **`bober_unsubscribe_events`**: Unsubscribe from a runId-scoped event stream. Input: `{ subscriptionId: string }`. Releases file-watch handles when no other subscription is watching the same files. Returns `{ subscriptionId, status: 'unsubscribed' }` or a soft-error `{ error: 'Subscription not found: <id>' }`.
- **`EventStreamManager`** (`src/mcp/event-stream.ts`): In-process class that tails `.bober/history.jsonl` and `.bober/telemetry/<date>.jsonl` using `fs.watch`. One file-watch handle is shared across all subscriptions watching the same file (reference-counted). Date roll-over is detected via a polling interval (5 s, `unref()`'d). Lines without an extractable `runId` (top-level or `details.runId`) are silently skipped. Per-subscription bounded queue (default 1000) drops the oldest events on overflow; a single `bober/events.dropped` notification with `{ subscriptionId, dropped: N }` is emitted once per overflow window. All diagnostic output is routed to `process.stderr` (stdout is reserved for the MCP JSON-RPC transport).
- **`pipeline.eventQueueBound`** config field: per-subscription bounded queue limit. Default `1000`, minimum `1`. Readable by the server from `bober.config.json` and passed to `EventStreamManager` at startup.
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
