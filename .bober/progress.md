# Bober Progress

Project: agent-bober
Mode: brownfield
Preset: custom
Initialized: 2026-03-28
Last updated: 2026-06-09T02:26:30Z

---

## Plan: Fleet Orchestrator (Tech-Lead Orchestrator)
- Spec: spec-20260609-fleet-orchestrator
- Created: 2026-06-09
- Sprints: 4
- Status: completed (4/4 sprints)
- Mode: greenfield
- Branch: bober/fleet-orchestrator (unpushed)

### Sprint Breakdown
1. [completed] Fleet manifest schema, loader, child config builder -- Passed iteration 1 (5c8e6fe). src/fleet/manifest.ts + child-config.ts.
2. [completed] Child folder scaffolding + subprocess runner -- Passed iteration 2 (f1a88de, 3a062cc). Iter 1 failed lint + untested ChildRunner.run(); fixed with eslint .js-globals block + real run() tests + spawn-failure seam. src/fleet/scaffolder.ts + runner.ts + stub fixture.
3. [completed] Bounded fan-out coordinator + outcome aggregator -- Passed iteration 1 (774d18b). src/fleet/coordinator.ts (mapBounded, never-reject thunk) + aggregator.ts (disk-primary + exit-code fallback) + types.ts.
4. [completed] Portfolio reporter, runFleet entrypoint, fleet CLI command -- Passed iteration 1 (69f909f). src/fleet/reporter.ts + index.ts (runFleet + registerFleetCommand) + cli/index.ts wiring. E2E smoke verified: `agent-bober fleet <manifest>` writes .bober/fleet-report.json, exits 0 on child failure, credential fail-fast before spawn.

### Pipeline Statistics
- Total Generator-Evaluator iterations: 5 / 20
- Sprints completed: 4 / 4
- Subagents spawned: 13 (4 curator, 5 generator, 4 evaluator)
- 53 fleet tests added; run command/runPipeline untouched.

---

## Plan: Scale-Safe Sprint History + Self-Improvement Memory
- Spec: spec-20260605-scale-safe-history-memory
- Created: 2026-06-05
- Sprints: 4
- Status: ready (0/4 sprints)
- Mode: brownfield
- Ambiguity score: 2/10

### Sprint Breakdown
1. [proposed] Bounded history reads + crash-safe rotation -- loadRecentHistory + archive rotation; loadHistory keeps its full-read contract so resume-cursor + conformance stay byte-equivalent (Layer 1, ships independently).
2. [proposed] Deterministic lessons memory store -- LessonEntry zod schema (mandatory provenance) + .bober/memory/ append-only store + bounded INDEX.md reader (Layer 2).
3. [proposed] Deterministic distillation + bober memory CLI -- pure LLM-free distill() + idempotent dedupe + distill|list|show command, out of the autopilot loop (Layer 2).
4. [proposed] Planner reads bounded memory (close the arc) -- retrieveRelevantLessons (tag/keyword, topK-capped, index-only) wired into bober.plan + bober-planner; demonstrably-improves gate (Layer 2).

### Design Notes
- Layer 1 / Layer 2 split: storage hardening ships and de-risks before the self-improvement memory builds on it.
- Safety (from RSI research): deterministic-only distillation (zero LLM, no reward-hacking surface); explicit CLI trigger only (no runaway loop); planner reads bounded + retrieved memory, never raw history; provenance on every lesson.
- Honest note: history is 272 lines today — Sprint 1 is preventative at-scale hardening, not an acute fix.

---

## Plan: Documentation & Release-Metadata Correction (0.16.0)
- Spec: spec-20260604-docs-correction
- Created: 2026-06-04
- Sprints: 4
- Status: completed (4/4 sprints) — 2026-06-04
- Branch: bober/docs-correction-0.16.0 (commit 0a39fa8, not pushed)

### Sprint Breakdown
1. [completed] CHANGELOG [0.16.0] + npm metadata -- cut dated [0.16.0] (claude-code, DeepSeek, graph telemetry, evaluator/architect/native lens panels, workflow engine, auto-filter, plugin-hooks fix); bumped package.json 0.15.0->0.16.0 + description + deepseek keyword. Verified: ordering [Unreleased]->[0.16.0]->[0.15.0], #17 not duplicated, typecheck clean.
2. [completed] README corrections -- Lens Panels section + config reference (architect.panel/evaluator.panel/pipeline.engine); slash-command table 12->24 (all 12 missing added); preset-aware install note. Verified 24 rows.
3. [completed] Ancillary docs -- COMMANDS.md DEEPSEEK_API_KEY; VISION.md config reference (pipeline.engine + evaluator/architect panel tables); docs/providers.md verified accurate (no edits needed).
4. [completed] Git release tags -- annotated v0.12.0(e30099f)/v0.13.0(0ffc81e)/v0.14.0(b83d641)/v0.15.0(95f9965)/v0.16.0(0a39fa8); all verified, local only (not pushed).

---

## Plan: Architect Decision Lens Panel
- Spec: spec-20260604-architect-lens-panel
- Created: 2026-06-04
- Sprints: 5
- Status: completed (5/5 sprints) — 2026-06-04
- Branch: bober/architect-lens-panel

### Sprint Breakdown
1. [completed] Shared synthesize() reducer + arch-lens catalog + architect.panel config -- Passed iter 1 (4/4), commit 7de08b5. Pure synthesize() + arch-lenses.ts (6 lenses) + architect.panel (optional section, off by default). 1576 passed/3 skipped.
2. [completed] TS Checkpoint 2 synthesis panel -- Passed iter 2 (4/4), commits 6f82cea + 1d02543. runArchitect gates on config.architect?.panel -> runArchitectSingleLoop (off, byte-identical) | runArchitectPanel (genApproaches + mapBounded per-lens score + synthesize winner + continuation). ArchitectResult.lensScores/selectedApproach additive optional. 1589 passed/3 skipped.
3. [completed] TS Checkpoint 5 review panel -- Passed iter 1 (4/4), commit 9163a56. CP5 review fan-out inside runArchitectPanel (off-path byte-identical); mapBounded per-lens reviews; reconcile() reused; 2-2 fail-closed; lensReviews + panelReviewPassed additive optional; failing verdict recorded. 1591 passed/3 skipped.
4. [completed] Native canonical arch-lens reference + lens-aware architect agent + sync gate -- Passed iter 1 (5/5), commit a77625a. skills/shared/arch-lens-panel.md (6 verbatim fragments + CP2/CP5 protocols); additive MODE section; .claude copy byte-identical; drift gate. 1593 passed/3 skipped.
5. [completed] Wire native architect CP2+CP5 + reference copy + regenerate command + drift gate -- Passed iter 1 (5/5), commit 4050d18. Additive gated panel branches at CP2/CP5; reference copied + inlined; command regenerated; drift gate 4/4 (recomputation). 1595 passed/3 skipped.

### Pipeline Statistics
- Total iterations used: 6 / 20 (Sprint 2 took 2 iterations; the other four passed on iteration 1)
- Sprints completed: 5 / 5
- Subagents spawned: 17 (5 curators + 6 generators + 6 evaluators)
- Mid-pipeline correction: Sprint 2 iter-1 failed on a missing C2 test assertion (selected approach == synthesize().winner); iter-2 added it via an additive selectedApproach field + test.
- Architect deep mode is opt-in & OFF by default (architect.panel) — zero behavior change unless enabled with ≥2 lenses. Shared synthesize() reducer is ready for the research/planner deep-mode follow-ons.

---

## Plan: Native-Surface Multi-Lens Evaluator Panel
- Spec: spec-20260604-native-lens-panel
- Created: 2026-06-04
- Sprints: 3
- Status: completed (3/3 sprints) — 2026-06-04
- Branch: bober/evaluator-lens-panel

### Sprint Breakdown
1. [completed] Canonical panel reference + lensVerdicts schema field + drift gate -- Passed iter 1 (4/4), commit 0dc9cd8. skills/shared/lens-panel.md + optional lensVerdicts + drift gate (teeth verified). 1543 passed/3 skipped.
2. [completed] Lens-aware evaluator agent modes + sync gate -- Passed iter 1 (5/5), commit 0736260. Additive MODE section (full|deterministic|lens); agent copies byte-identical + sync gate. 1544 passed/3 skipped.
3. [completed] Wire run/sprint/eval orchestrators + per-skill reference copies + regenerate commands -- Passed iter 1 (5/5), commit 34118e3. Gated additive panel branch in 3 SKILL.md (zero deletions); 3 reference copies; 3 commands regenerated + proven byte-equal by in-repo recomputation gate. 1550 passed/3 skipped.

### Pipeline Statistics
- Total iterations used: 3 / 20 (all sprints passed on iteration 1)
- Sprints completed: 3 / 3
- Subagents spawned: 9 (3 curators + 3 generators + 3 evaluators)
- Mid-sprint correction: Sprint 3 C3/C5 gate switched from update-all:check (external targets) to in-repo vitest recomputation of inlined commands.
- Native panel is opt-in & OFF by default — zero behavior change unless evaluator.panel.enabled=true with ≥2 lenses.

---

## Plan: Multi-Lens Evaluator Panel
- Spec: spec-20260604-evaluator-lens-panel
- Created: 2026-06-04
- Sprints: 2
- Status: completed (2/2 sprints) — 2026-06-04
- Branch: bober/evaluator-lens-panel

### Sprint Breakdown
1. [completed] Panel config, lens-aware evaluator, and reconcile wiring -- opt-in evaluator.panel + bounded fan-out + reconcile(); byte-identical when off. Passed iter 1 (5/5 criteria), commit 5dc7a5e. Full suite 1531 passed/3 skipped.
2. [completed] Lens prompt catalog and per-lens verdict telemetry -- built-in correctness/security/regression/quality lenses + generic fallback + per-lens verdicts via appendHistory (open event string, no schema change). Passed iter 1 (5/5 criteria), commit 1560050. Full suite 1540 passed/3 skipped.

### Pipeline Statistics
- Total iterations used: 2 / 20 (both sprints passed on iteration 1)
- Sprints completed: 2 / 2
- Subagents spawned: 6 (2 curators + 2 generators + 2 evaluators)
- Note: evaluator.panel is opt-in and OFF by default — zero behavior/cost change unless `evaluator.panel.enabled=true` with ≥2 lenses.

---

## Plan: Config-Selectable Workflow Orchestration Engine
- Spec: spec-20260604-workflow-engine
- Created: 2026-06-04
- Sprints: 6
- Status: completed (6/6 sprints)

### Sprint Breakdown
1. [completed] Engine-selection seam, pipeline.engine config, and eligibility probe -- Passed on iteration 1 (1423 tests green)
2. [completed] EvaluatorPanelReconciler -- Passed on iteration 1 (19 tests, verified pure)
3. [completed] Pure-JS reducer port and twin/port drift gate -- Passed on iteration 1 (gate proven via live mutation)
4. [completed] Workflow types, ResumeCursorReconstructor, ArgsPayloadBuilder -- Passed on iteration 1 (56 workflow tests)
5. [completed] bober-pipeline.js workflow script + RunResultFlusher -- Passed on iteration 1 (85 workflow tests)
6. [completed] WorkflowEngine assembly + selector integration + EngineConformanceHarness -- Passed on iteration 1 (102 workflow tests, 1519 total)

---

## Plan: Multi-Provider LLM Adapter Layer
- Spec: spec-20260328-multi-provider-llm-adapter
- Status: completed (6/6 sprints)

## Plan: MCP Server for Cross-IDE Integration
- Spec: spec-20260328-mcp-server
- Status: completed (4/4 sprints)

## Plan: Brownfield Auto-Discovery System
- Spec: spec-20260329-brownfield-auto-discovery
- Status: completed (4/4 sprints)

### Sprint Breakdown
1. [completed] Deep Programmatic Scanner
2. [completed] LLM-Powered Principles Synthesizer
3. [completed] Auto-Configure Evaluator Strategies
4. [completed] Integration: Init Flow, Principles Skill, MCP

## Plan: CRISPY-Inspired Pipeline Enhancement
- Spec: spec-20260331-crispy-pipeline-enhance
- Status: completed (5/5 sprints)

### Sprint Breakdown
1. [completed] Research Agent
2. [completed] Mandatory Questions + Design Discussion
3. [completed] Structure Outline + Vertical Slice Enforcement
4. [completed] Pipeline Integration + Context Distillation
5. [completed] Artifact Lifecycle + Progress Tracking

## Plan: Solution Architect Workflow
- Spec: spec-20260331-architect-workflow
- Status: completed (3/3 sprints)

### Sprint Breakdown
1. [completed] Architect Agent + Skill + State
2. [completed] Programmatic Module + Pipeline Integration
3. [completed] Distribution + Documentation + Progress Tracking

## Plan: Auto-Filter Slash Commands by Preset
- Spec: spec-20260416-auto-filter-commands
- Created: 2026-04-16
- Sprints: 1
- Status: completed (1/1 sprints)

### Sprint Breakdown
1. [completed] Add preset-aware command filtering to installClaudeCommands -- Passed on iteration 2

## Plan: TokenSave Graph Integration
- Spec: spec-20260524-tokensave-integration
- Created: 2026-05-24
- Sprints: 10 (planned)
- Status: in-progress (7/10 sprints)

### Sprint Breakdown
1. [completed] Graph Foundations (types, prereq, artifact-store, config schema)
2. [completed] TokenUsageLog + per-agent capture (.bober/graph/token-usage.jsonl)
3. [completed] Graph client + MCP integration
4. [completed] Pipeline lifecycle management
5. [completed] GraphToolGate (resolveRoleTools, getGraphState, 5 agent files migrated)
6. [completed] PreflightContextInjector + per-role QUERY_BATCHES + budgets + Researcher-Phase2 isolation invariant
7. [completed] AgentGraphPrompts (ADR-5) + KPI MEASUREMENT GATE

### KPI Gate (Sprint 7 deliverable)
gatePass=true required before merging Sprints 8-10 in production.
CI continues on failure for now per 0.13.0 cutover (see TODO(0.13.0) in .github/workflows/ci.yml).
If gate fails locally: inspect .bober/graph/kpi-gate-report.json → recommendations array → iterate on
PreflightContextInjector or prompt fragments before unblocking Sprints 8-10.

## Plan: Port highest-priority superpowers concepts into agent-bober
- Spec: spec-20260524-superpowers-port
- Created: 2026-05-24
- Sprints: 8
- Status: ABANDONED 2026-05-24 — superseded by spec-20260524-bober-vision (verbatim voice + multi-mode careful-flow + prod-incident agent shape)
- Original contracts preserved on disk for reference; not scheduled for execution
- Research basis: .bober/research/research-20260524-superpowers-vs-agent-bober.md

## Plan: Bober Vision — Multi-mode software engineering teammate
- Spec: spec-20260524-bober-vision
- Created: 2026-05-24
- Sprints: 28 (across 4 tiers)
- Status: planned
- Supersedes: spec-20260524-superpowers-port
- Research basis: .bober/research/research-20260524-superpowers-vs-agent-bober.md
- Config: bumped sprint.maxSprints 10 → 30

### Tier 0 — Foundation (sprints 1-3)
1. [completed] SessionStart bootstrap + bober.using-bober skill — Passed iter 1 (6/6 criteria, 584 tests, commit 03cf904).
2. [completed] Verbatim port of verify + debug skills — Passed iter 1 (7/7 criteria, 584 tests, commit e9ea377). Iron Laws source-verbatim ("FRESH VERIFICATION EVIDENCE", "ROOT CAUSE INVESTIGATION FIRST"). DISPUTE protocol + 5 Forbidden Responses inlined into bober-generator.
3. [completed] Voice pass across remaining agent prompts — Passed iter 1 (9/9 criteria, 584 tests, commit e5233ed). All 5 agent prompts gained role-specific Iron Law + Red Flags (>=8 entries) + Rationalization-Prevention table (>=7 rows). Voice clean.

**Tier 0 COMPLETE** — 3/3 sprints passed first try, 3/20 iteration budget used, 0 regressions, 584 tests pass. Branch: bober/bober-vision @ commit e5233ed.

### Tier 1 — Quality discipline (sprints 4-6)
4. [completed] Anti-pattern reference catalog — Passed iter 1 (7/7 criteria, 584 tests, commit c3d939e). Four MIT-attributed reference docs ported verbatim into .bober/anti-patterns/ + README index. agents/bober-evaluator.md gained Step 6.5 "Anti-Pattern Citations" with JSON example shape extending regressions by optional antiPattern/source/antiPatternEvidence; Sprint 3 Iron Law preserved. src/contracts/eval-result.ts untouched.
5. [completed] bober-code-reviewer agent + bober.code-review skill + orchestrator wiring — Passed iter 2 (9/9 criteria, 589 tests, commits ac29dda + 2cd7b9d + b5568ba). Iter 1 introduced two issues: scanner.test.ts colocated regression (new test placed at tests/ tipped detectColocated's balance) caught by orchestrator pre-evaluator and fixed by moving to colocated convention; eval then failed on s5-c2 (table thresholds off by 1) and s5-c6 (hollow tests not exercising pipeline.ts). Iter 2 fixed both: 8 Red Flags + 7 Rationalization rows; tests rewritten to exercise runSprintCycle and renderReviewMarkdown directly. Advisory-only contract preserved (no critical→retry branch).
6. [completed] HARD-GATE in bober.plan + AGENTS.md at repo root — Passed iter 1 (9/9 criteria, 589 tests, commit 8ddc8ba). HARD-GATE block inserted at skills/bober.plan/SKILL.md:155 between Step 5 (L137) and Step 6 (L165) with INTERACTIVE + AUTONOMOUS protocols documenting resolvedClarifications recording shape. AGENTS.md at repo root (148 lines, 5 sections in order) preserves 'slop'/'your human partner'/'EXTREMELY-IMPORTANT' voice; 94% stat replaced with bober framing; 7 bober-specific 'What We Will Not Accept' categories. Cross-links from README.md and skills/bober.using-bober/SKILL.md (Sprint 1 forward-reference now resolves).

**Tier 1 COMPLETE** — 3/3 sprints passed (sprints 4-6), 4/20 iteration budget used (sprint 5 needed iter 2), 0 regressions. Branch: bober/bober-vision @ commit 8ddc8ba.

### Tier 2 — Careful-flow multi-mode (sprints 7-14)
7. [completed] Careful-flow plumbing — Passed iter 1 (6/6 criteria, 593 tests +4, commit e00d064). src/orchestrator/checkpoints/ module (types/registry/sites/noop/index) wired into pipeline.ts at 9 documented call sites (+10/-0 additive diff). CheckpointOutcome 3-variant discriminated union supports all 3 future mechanisms (CLI/disk/PR). noop is sole registered mechanism; behavior unchanged (canary code-reviewer-agent.test.ts 5/5 + scanner.test.ts 52/52 still green). Test colocated per Sprint 5 regression precedent.
8. [completed] CLI blocking checkpoint mechanism — Passed iter 1 (7/7 criteria, 600 tests +7, commit 9d82c04). src/orchestrator/checkpoints/mechanisms/cli.ts with stderr-only prompts, readline stdin, $EDITOR (nano fallback) + try/finally temp cleanup. Non-TTY → noop fallback via constructor-injected mechanism (test spy-verifies PATH not just outcome equality). Registered as 'cli' at module load. Test COLOCATED at src/orchestrator/checkpoints/mechanisms/cli.test.ts (contract expectedChanges path was wrong; overridden per Sprint 5 scanner precedent). pipeline.ts unchanged — noop stays default until Sprint 14.
9. [completed] Disk-marker mechanism + bober approve CLI — Passed iter 1 (9/9 criteria, 633 tests +33, commit 03f1a0c). src/orchestrator/checkpoints/mechanisms/disk.ts with constructor-injected pollMs/timeoutMs/clock; pending file holds artifact SUMMARY (not raw, meets 100ms budget for 5MB artifact); timer cleared in finally (no leak across 10 parallel checkpoints); 24h default timeout capped at 7d; stale-marker cleanup at request() start. CLI commands approve/reject/list-approvals colocated under src/cli/commands/, use findProjectRoot for cwd-independence, pendingExists guard with stderr+exitCode=1, --json flag on list. src/state/approval-state.ts mirrors review-state.ts. pipeline.ts unchanged.
10. [completed] GitHub PR-native mechanism — Passed iter 2 (9/9 criteria, 663 tests +30, commit 6e5e3ee). src/orchestrator/checkpoints/mechanisms/pr.ts with GhClient constructor-injection seam (interface: version/authStatus/repoView/prList/prCreate/prComment/prView/prEdit/prReady). Run-tracking PR (one per run): ensureRunPr caches runPrNumber; checkpointStates Map<id, pending|approved|rejected> drives renderPrBody with '- [ ] <id>' / '- [x] <id>' checkboxes updated via prEdit before+after each request; prReady called via cancellable setTimeout(0) only when all approved + zero rejected. Availability check (version/auth/repoView) → falls back to DiskCheckpointMechanism (NOT noop/cli) with stderr warning. Poll loop: DEFAULT 30s, MIN 10s warning, rate-limit backoff cap 5min. registry.ts gains getCheckpointMechanismFor(checkpointId, config, fallback) — resolves override → global → fallback while preserving back-compat getCheckpointMechanism(name). Tests COLOCATED at src/orchestrator/checkpoints/mechanisms/pr.test.ts (contract path overridden per Sprint 5/8 precedent); 30 tests, all gh mocked at GhClient seam, zero real PR creation. Iter 1 failed s10-c6 (no checkbox list, no draft→ready transition); iter 2 added prEdit/prReady + checkpointStates Map.
11. [completed] Per-artifact-type renderers — Passed iter 1 (11/11 criteria, 765 tests +103, commits 5b466f2 + 6ee2b03 + 5757b33). src/orchestrator/checkpoints/renderers/ with 9 pure renderers (research, plan, sprint-contract, curator-briefing, generator-diff, eval-result, code-review, sprint-summary, pipeline-summary) + registry.ts (Map dispatch by type, stderr warning + renderGeneric fallback for unknown) + _util.ts (shared applyLineCap with canonical truncation marker, extractH1, countSectionItems, etc). generator-diff has sync renderGeneratorDiff (file list only) + async renderGeneratorDiffAsync (GitClient seam, numstat binary detection -/-, per-file diff capped at 50 lines). cli.ts:116, disk.ts:94 (rendered md now in pending JSON `prompt` field, artifact reduced to {type}), pr.ts:386 all delegate to render(). Tests colocated at src/orchestrator/checkpoints/renderers/*.test.ts (contract path overridden per Sprint 5/8/10 precedent); 10 test files, all toContain assertions (no hollow checks). No regressions in cli/disk/pr/list-approvals tests.
12. [completed] Feedback propagation back to agents — Passed iter 2 (8/8 criteria, 821 tests +56, commits eedff08 + bb57874 + 8f9eadc + 48f037d + adc49f7 + d71d533). src/orchestrator/checkpoints/feedback-router.ts with CHECKPOINT_TO_AGENT mapping (researcher/planner/generator/evaluator/gate), 4 distinct buildXxxRetryPrompt fns (planner prepends 'Plan revision request'; generator appends 'Additional context from human reviewer'; researcher prepends 'Additional research questions'; evaluator prepends 'Concern from prior round'). runCheckpointWithFeedback: per-invocation iteration counter; mechanism call; reject → reinvokeAgent up to maxIterations then writeAbortMarker (atomic tmp+rename) with structured RunAbortedReason; edit → applyEditDelta (backup to .bober/runs/<runId>/edits/<id>.original.<ext> + atomic write) without re-invoking; !!abort case-sensitive prefix OR env var BOBER_CHECKPOINT_ABORT_TOKEN. Schema: pipeline.maxCheckpointIterations min:1 max:10 default:3. renderSprintContract surfaces 'Previous feedback' section at iteration > 1 via _iterationMetadata. Tests COLOCATED at src/orchestrator/checkpoints/feedback-router.test.ts (51 tests; contract path overridden per Sprints 5/7-11 precedent). pipeline.ts swapped getCheckpointMechanism('noop') → getCheckpointMechanismFor at all 9 sites + completion marker. Iter 1 failed s12-c4 (env var unwired); iter 2 added `opts.envAbortToken ?? process.env['BOBER_CHECKPOINT_ABORT_TOKEN']` fallback + test.
13. [completed] Approval audit trail — Passed iter 1 (9/9 criteria, 861 tests +40, commits ff2cbae + bc8ea62 + 555a6b9 + 87ffe85). src/orchestrator/checkpoints/audit.ts: ApprovalRecord shape (timestamp/runId/checkpointId/mechanism/outcome/approverId/iteration/feedbackText?/editDeltaSummary?/durationMs), append-only via fs.open(O_WRONLY|O_APPEND|O_CREAT, 0o600) + fh.chmod(0o600) (race-safe), per-runId Promise-chain mutex. runWithAudit wrapper (seam B): try/catch/finally — mechanism throws still write entry with outcome='aborted' then re-throw original error. resolveApproverId 5-case switch (pr→hint||'github:unknown', cli→USER||USERNAME, disk→git config user.name then USER, noop→'autopilot', default→'unknown'). truncateFeedback 500-char; summarizeEditDelta {lineCount, firstChars(200)}. Wired into all 9 pipeline.ts call sites + feedback-router.ts:608. CLI: src/cli/commands/audit-show.ts registers nested commander 'audit show <runId>' subcommand (table + --json + ENOENT handler with exitCode=1). .bober/audits/ added to state subdirs. Tests COLOCATED (src/orchestrator/checkpoints/audit.test.ts + src/cli/commands/audit-show.test.ts). Two low-priority quality notes (non-blocking): disk approverId tests assert typeof string instead of mocked values; audit-show ENOENT test doesn't exercise CLI action handler end-to-end.
14. [completed] Mode + mechanism config — Passed iter 1 (8/8 criteria, 879 tests +18, commits f8bd3c7 + f09e86d + 933de64 + 67fbffa). PipelineSectionSchema extended: mode (enum autopilot|careful default autopilot), checkpointMechanism (enum noop|cli|disk|pr OPTIONAL — runtime mode-derived), checkpointOverrides (Record default {}), approvalTimeoutMs (default 86400000 24h), prPollMs (default 30000 min 10000). resolveCheckpointMechanismName pure 6-tier resolver (cliOverrideAll+cliOverride > per-checkpoint > cliOverride > global checkpointMechanism > mode-default(careful→disk|autopilot→noop) > fallback). CLI: --mode, --checkpoint, --checkpoint-all flags wired in run.ts; help text documents precedence; --checkpoint preserves per-checkpoint overrides while --checkpoint-all clears them. loader.ts emits stderr warning when mode='careful' + checkpointMechanism='noop'; zod enum rejects unknown mechanism names. tests/integration/careful-flow.test.ts 2 tests exercise REAL DiskCheckpointMechanism (no mocking) — runWithAudit → listPending poll → saveApproved → audit JSONL assertion. tests/config/graph-schema.test.ts 3 new backward-compat tests parse on-disk bober.config.json with new schema (defaults: mode='autopilot', checkpointMechanism=undefined → resolves to 'noop', preserves existing autopilot behavior). Medium-priority follow-up: pipeline.ts:149-150 + :513-514 use `config.pipeline?.checkpointMechanism ?? 'noop'` for audit mechanism label instead of calling resolveCheckpointMechanismName — actual mechanism instance correct, only audit label inaccurate when mode='careful' + checkpointMechanism unset.

**Tier 2 COMPLETE** — 8/8 sprints passed (sprints 7-14), 11/40 iteration budget consumed this tier (2 sprints needed iter 2: 10, 12), 0 regressions, 879 tests pass. Branch: bober/bober-vision @ commit 67fbffa.

### Tier 3 — Prod-incident agent shape (sprints 15-25)
15. [completed] bober-diagnoser agent — Passed iter 1 (9/9 criteria, 879 tests preserved, commit 1260827). agents/bober-diagnoser.md (244 lines, 30.5% of 800 NFR) mirrors evaluator structure: YAML frontmatter [Read,Bash,Grep,Glob], Iron Law fenced @52, 8 Red Flags, 8-row Rationalization-Prevention table. DiagnosisResult schema with contradictingEvidence REQUIRED, confidence='low'|'medium'|'high', blastRadius='safe'|'risky', requiresApproval boolean. 6-step Investigation Discipline. Belt-and-suspenders read-only enforcement (tools list + prose). Enumerated Bash allowlist (10 patterns) + forbidden table (9 categories). Forward-links bober.diagnose (Sprint 17), .bober/incidents/ (Sprint 19).
16. [completed] Observability MCP plugin slot architecture — Passed iter 1 (9/9 criteria, 920 tests +41, commit 063fabb). src/config/schema.ts extended with ObservabilityProviderSchema {name,kind:'logs'|'metrics'|'traces'|'errors'|'custom',mcpCommand,mcpArgs?,mcpEnv?,enabled default true} and ObservabilitySectionSchema (providers default []). src/mcp/external-client.ts ExternalMcpServer wraps @modelcontextprotocol/sdk Client+StdioClientTransport with SIGTERM→5s→SIGKILL fallback and KEY=VALUE token-redaction sanitizeError(). src/orchestrator/observability/merge.ts mergeObsTools() uses Promise.allSettled (NOT all) for isolation, namespaces obs__<provider>__<tool>. Diagnoser prompt updated (lines 202-212, file 244→256). docs/observability-mcps/{README,logs,metrics,traces,errors}.md contract-only (5 files, ~50-100 lines each, community refs named, NOT vendored). Tests: external-client.test.ts (14) + merge.test.ts (13) colocated; tests/orchestrator/observability-mcp.test.ts (10) with fake-obs-mcp.mjs SDK-fixture subprocess; tests/config/graph-schema.test.ts (+4 backward-compat). 879→920 tests preserved.
17. [completed] bober.diagnose skill — Passed iter 1 (9/9 criteria, 920 tests preserved, commit 8466d27). skills/bober.diagnose/SKILL.md (254 lines, target 200-300) — system-level twin of bober.debug. MIT+obra/superpowers attribution. Iron Law: 'NO REMEDIATION WITHOUT VERIFIED ROOT CAUSE AT TWO INDEPENDENT BOUNDARIES'. 11 Red Flags, 8 Rationalization rows. Four phases with 3 <EXTREMELY-IMPORTANT> hard gates (Phase1→2 @84, 2→3 @118, 3→4 @150) — all 'BEFORE proceeding, you MUST have...'. Phase 1: symptom current/scope/timing + observations.jsonl. Phase 2: boundary chain (client→CDN→LB→service→cache→DB→storage) + obs__<provider>__<tool> queries + changelog.jsonl correlation. Phase 3: disproof REQUIRED (not advisory) — 'A hypothesis you cannot disprove is not strongly tested.' Phase 4: PRE-DEFINED metric+threshold+window+baseline+source criteria; bober-deployer routing with Tier 2 checkpoint; forbids 'dashboard looks better' resolution. Cross-refs: bober.debug, bober.runbook (Sprint 18 forward), bober.deploy (Sprint 20 forward), .bober/anti-patterns/. Schema names align with Sprint 19.
18. [completed] bober.runbook skill — Passed iter 1 (9/9 criteria, 920 tests preserved, commit bb55cd8). skills/bober.runbook/SKILL.md (335 lines, target 250-350). Iron Law verbatim: 'NO STEP EXECUTION WITHOUT VERIFIED PRECONDITION; NO ADVANCE WITHOUT VERIFIED POSTCONDITION'. 11 Red Flags, 8 Rationalization rows. Parse format: frontmatter (name/classification:'standard'|'emergency'/prerequisites array) + numbered steps with all 6 fields (description/command optional/precondition-check/postcondition-check/blastRadius safe|risky/rollback optional). Named-STOP execution loop @122-145 with precondition_failed/checkpoint_rejected/execution_failed/rollback_failed conditions. UNCONDITIONAL risky-step gate @149-159 — verbatim "Autopilot mode does NOT bypass risky-step approval" (denies pipeline.mode='autopilot', checkpointMechanism='noop', multi-cmd wrapping). 3-tier rollback cascade @165-177 (run rollback → if rollback fails OR none, escalate via checkpoint → write indeterminate STOP). 7-field runbook-execution.jsonl schema lock @208 for Sprint 19 compatibility. Cross-refs bober.diagnose/bober.deploy/.bober/playbooks/. Worked kubectl/jq examples.
19. [completed] Incident timeline tracking — Passed iter 1 (9/9 criteria, 951 tests +31, commit d53ddaf). src/incident/types.ts: IncidentId=string, IncidentArtifactKind 8-value enum, zod schemas for TimelineEvent (source 5-enum)/Observation/Action/Change (inverse REQUIRED, NOT .optional())/RunbookExecution (7 camelCase fields per Sprint 18 lock)/IncidentMetadata (status enum: investigating/remediating/monitoring/resolved/aborted). src/incident/timeline.ts: deriveSlug (first 3 tokens, kebab, max 30, 'untitled' fallback), createIncident (all 8 artifacts: 5 jsonl + hypotheses.md + incident.json + diagnoses/), per-incidentId Promise-chain mutex mirroring audit.ts, appendOneLine fs.open O_WRONLY|O_APPEND|O_CREAT + fh.chmod(0o600), double-write to timeline.jsonl from every domain append (observation/action/change/runbook-execution all touch both files in same mutex tick), setIncidentStatus atomic temp+rename with resolvedAt auto-set, listIncidents handles missing dir → []. tests/incident/timeline.test.ts (499 lines, 31 tests, mkdtemp fixture): skeleton/slug edge cases (empty/punct/unicode/long)/double-write/required-inverse THROWS/100-concurrent mutex/setIncidentStatus/listIncidents desc sort/file mode 0o600.
20. [completed] Change-management gates + bober-deployer + bober.deploy — Passed iter 1 (8/8 criteria, 973 tests +22, commit 43c9418). Highest-risk Tier 3 sprint. Schema: PipelineSection.allowAutopilotRiskyActions z.boolean().default(false) (footgun escape hatch). src/orchestrator/deploy/{types,classify,resolve,executor,execute,spawn,index}.ts: ProposedActionSchema with REQUIRED inverse; classifyCommand RISKY_PATTERNS default-deny on COMMAND content (multi-command chains caught, NOT trusting agent self-declaration); resolveRiskyActionMechanismName forced floor (isRisky && resolved='noop' && !allow → 'disk'); executeAction sequence (validate inverse → classify → if risky resolveRiskyActionMechanism+mech.request {description,classificationReasoning,inverse} → pending ChangeEntry BEFORE execute → execute via ExecutorSeam → terminal ChangeEntry executed|failed). agents/bober-deployer.md Iron Law verbatim 'NO RISKY ACTION WITHOUT CHECKPOINT APPROVAL; NO ACTION WITHOUT RECORDED INVERSE'. skills/bober.deploy/SKILL.md ~310 lines with 10-step Execution Loop, 3-step Abort Discipline, verbatim 'Autopilot mode does NOT bypass risky-action approval'. tests/orchestrator/deployer.test.ts 22 tests covering unconditional gate (4 scenarios), escape hatch (audit + warning preserved), missing-inverse aborts before IO, multi-command Bash (12 cases), crash-mid-execute (pending+failed durability), nonzero exit, safe-action flow. Defaults updated in schema.ts + defaults.ts + loader.ts.
21. [completed] Rollback awareness + bober rollback CLI — Passed iter 1 (8/8 criteria, 1000 tests +27, commit da18e29). src/incident/types.ts: extended ChangeEntry status enum with 'rolled-back-failed' (additive). src/incident/rollback.ts: readChangelog (latest-line-wins grouping by id), planRollback (executed-only filter, reverse order, --since strict-after with clear error, no-inverse defensive→warning+exclude), executeRollback (per-step risky ProposedAction → executeAction; on success appendChange 'rolled-back' + rollback-execution.jsonl 'rolled-back'; on failure appendChange 'rolled-back-failed' + rollback-execution.jsonl 'rolled-back-failed' + rollback_halted timeline event + escalated:true + remaining list, STOP), presentPlan (CLI format). src/cli/commands/rollback.ts commander subcommand with <incidentId> args + --since/--dry-run/--json flags, always presents plan, --dry-run STOPS pre-execution, readline y/N confirm. tests/incident/rollback.test.ts 27 tests: reverse order, status filtering (4 variants), --since (valid+invalid), per-step gate count assertion (N steps→N executor calls), 5-step halt-on-failure (callCount===3, remaining===2, escalated:true), --dry-run zero side effects, no-inverse missing/empty defensive. 3 low-priority quality notes (timeline audit for no-inverse warnings, explicit per-step status assertions, autopilot-disk integration test) tracked.
22. [completed] SLO/metric verification — Passed iter 1 (9/9 criteria, 1023 tests +23, commit 55be7e9). src/incident/resolution-verify.ts: ResolutionCriteriaSchema (metricName/threshold/comparison lt|lte|gt|gte/windowMinutes/provider/baselineComparison?), VerifyResultSchema, sampleMeetsThreshold (lt strict<, lte≤, gt>, gte≥), verifyResolution with MetricQueryClient seam (default mergeObsTools), allSamplesPassed = samples.length>0 && .every() — every-sample rule, no averaging. NO_PROVIDER reason returns hint mentioning bober.config.json + observability.providers + SKIP_METRIC_VERIFY. Evidence file at .bober/incidents/<id>/resolution-evidence/<ts>.json written on BOTH verified paths (audit). 'percent-of-baseline' → NOT_IMPLEMENTED (scope choice documented). src/incident/types.ts: IncidentResolutionEvidenceSchema + resolutionEvidence optional on IncidentMetadataSchema. src/incident/timeline.ts: setIncidentStatus opts={verifyResult?, overrideToken?}; resolved transition gates throw without opts / verified=false; OVERRIDE_TOKEN_RE /^SKIP_METRIC_VERIFY:\\s*(.+)$/ with trim+non-empty (rejects empty AND whitespace-only). agents/bober-diagnoser.md Step 7 + agents/bober-deployer.md Step 5 with exact verifyResolution name + Phase 4 cross-link. tests/incident/resolution-verify.test.ts 23 tests + 2 timeline.test.ts updates for backward-compat regression.
23. [completed] bober-postmortemer + bober.postmortem skill — Passed iter 1 (9/9 criteria, 1030 tests +7, commit 5df0b06). agents/bober-postmortemer.md (~285 lines): YAML tools:[Read,Bash,Grep,Glob] only (NO obs__ MCPs - OFFLINE), Iron Law 'NO POSTMORTEM SECTION WITHOUT EVIDENCE FROM INCIDENT ARTIFACTS', 7 Red Flags, 7 Rationalization rows, citation discipline, redaction discipline. skills/bober.postmortem/SKILL.md (~245 lines): synthesis order 9 artifacts, 5-Whys heuristic with shallow-warning pseudocode, full postmortem template (Title/Status/Severity/TL;DR/Timeline/Impact/Root Cause 5-Whys/Contributing Factors/What Went Well/What Went Wrong/Action Items with Owner|Due TBD), citation format table 4 styles, 10-pattern redaction regex set. src/incident/postmortem.ts: generatePostmortem deterministic programmatic synthesizer (no LLM), reads 8 sources, citations auto-inserted (count > 5), redaction BEFORE write. src/config/schema.ts: IncidentSectionSchema.autoPostmortem default true (backward compat). src/incident/timeline.ts: fire-and-forget IIFE on resolved with dynamic import + post-completion atomic postmortemPath update. src/cli/commands/postmortem.ts: nested 'generate <id>' / 'show <id>' subcommands. tests/incident/postmortem.test.ts 7 tests: happy-path, citation count >5, 5-Whys deep/shallow, auto-trigger non-blocking (<500ms), autoPostmortem=false suppression, redaction (AKIA fake key NOT in output). 2 low-priority gaps (hypotheses.md not read; non-blocking test uses timing) tracked.
24. [completed] /bober-incident skill + CLI entry — Passed iter 1 (9/9 criteria, 1040 tests +10, commit b2ced1e). **Tier 3 INTEGRATION CAPSTONE**. types.ts: optional severity (S1|S2|S3|S4), STATUS_TRANSITIONS map (investigating→{remediating/resolved/aborted}; remediating→{monitoring/escalated/aborted}; monitoring→{resolved/investigating/aborted}; resolved→{investigating} reopen-only; aborted→{} terminal). src/incident/orchestrator.ts: InvalidTransitionError, transitionPhase (validates BEFORE setIncidentStatus), applyDiagnosisOutcome (risky→'remediating'), applyDeploymentOutcome (success+verified→'monitoring'), abort (no silent rollback — only with confirmRollback=true; writes aborted.txt + abort-report.md). src/cli/commands/incident.ts: 5 subcommands (start with --severity, status with ENOENT-tolerant rendering, end with --verified|--override, list, abort --reason required + --confirm-rollback opt). skills/bober.incident/SKILL.md: YAML, Iron Law verbatim 'NO INCIDENT WITHOUT TIMELINE; NO RESOLUTION WITHOUT VERIFICATION', 7 Red Flags, 6 Rationalization rows, ASCII state machine, Slash Command Flow with prompt-for-symptom. tests/integration/incident-lifecycle.test.ts (10 tests): REAL integration — no module mocking, only ExecutorSeam + MetricQueryClient in-memory seams. Full lifecycle + 3-gate test + state-machine guards + abort with/without rollback + status across all phases. All 10 pass in 490ms.
25. [completed] Incident playbook library — Passed iter 1 (10/10 criteria, 1083 tests +43, commit 7e874d3). 4 starter playbooks (.bober/playbooks/{build-failure,migration-timeout,error-spike,latency-regression}.md) with Sprint 18 parse format: each frontmatter (name/classification/applicableSymptoms — generic tokens, no platform-specific tokens/prerequisites) + 5-7 numbered steps each with blastRadius/precondition/postcondition/optional rollback. Risky steps (migration kill, error-spike remediation, latency remediation) all have rollback entries. .bober/playbooks/README.md index + how-to-add (full Sprint 18 schema) + how-to-test + confidence threshold table. src/incident/playbook-search.ts: Playbook/PlaybookMatch types, tokenize (lowercase+punct-split+stopwords), loadPlaybooks (skips README, ENOENT→[], graceful malformed-frontmatter handling), searchPlaybooks (token-overlap score = overlap/phraseLength, max across applicableSymptoms, [0,1] clamp, sorted desc + matchedTokens), HIGH=0.6/LOW=0.3 constants exported. agents/bober-diagnoser.md Step 0 wires searchPlaybooks with explicit ≥0.6/0.3-0.59/<0.3 branching + EXTREMELY-IMPORTANT block. src/cli/commands/playbook.ts list|show|search subcommands. tests: 38 unit tests in playbook-search.test.ts (incl false-positive prevention for 'user reports button is grey' → zero ≥0.6 matches) + 5 integration tests in incident-lifecycle-playbook.test.ts (build-failure match + full lifecycle). Sprint 24 integration 10/10 still passes.

**Tier 3 COMPLETE** — 11/11 sprints passed (sprints 15-25), 11/40 iteration budget used this tier (all sprints passed iter 1), 0 regressions, 1083 tests pass (was 879 at Tier 3 start; +204 tests added across Tier 3). Branch: bober/bober-vision @ commit 7e874d3.

### Tier 4 — Integration & polish (sprints 26-28)
26. [completed] VISION.md + README update — Passed iter 1 (8/8 criteria, 1083 tests preserved docs-only, commit 5963e07). VISION.md 438 lines, all 9 sections in order (Why agent-bober Exists / The Four Modes / Mode 1-4 sections / Choosing a Mode / Configuration Reference / The Foundation). Each mode section: when-to-use + entry point + disk artifacts + worked example with REAL CLI commands (bober plan/run --mode careful, bober incident start --severity, bober rollback --dry-run, etc.). Decision table 9 rows (4 basics + 5 gray-area). Configuration Reference cross-checked against schema.ts — honest framing for playbookAutoInvokeThreshold (documented as constant HIGH_CONFIDENCE_THRESHOLD=0.6, not config field) and telemetry.enabled (documented as "will be added in Sprint 28"). Foundation section: Iron Laws + Red Flags + Rationalization-Prevention + Anti-Pattern Catalog + HARD-GATEs with obra/superpowers MIT credit. README.md additive: Operating Modes section + New Commands subsection (preserves existing content). AGENTS.md: cross-link block. COMMANDS.md created fresh (contract said existing but file was absent — generator flagged honestly).
27. [completed] End-to-end four-mode integration test — Passed iter 1 (11 tests, commit 733a863). tests/e2e/four-modes.test.ts (940 lines): real DiskCheckpointMechanism, real ExternalMcpServer subprocess, real incident lifecycle (start/diagnose/deploy/abort/rollback), real rollback. Covers autopilot noop, careful-flow disk-based, diagnose-abort, diagnose-resolve paths. CI integrated.
28. [completed] Config schema migration + opt-in local-only telemetry — Passed iter 1 (1115 tests, commit TBD). src/config/schema.ts: TelemetrySectionSchema (enabled: bool, default false) + telemetry: TelemetrySectionSchema.optional() on BoberConfigSchema. src/telemetry/emit.ts: per-filepath mutex, mode-0600 JSONL append, no-op when disabled. eslint.config.js: no-restricted-imports rule for src/telemetry/** (http/https/net/tls/undici etc.). bober config migrate CLI (dry-run + backup). bober telemetry status|purge|export CLI. Emit call sites wired: sprint-pass, sprint-fail-retry in pipeline.ts; agent-spawn in curator/generator/evaluator agents; incident-resolved in timeline.ts; incident-aborted in orchestrator.ts. Privacy bar: IDs/counts/enums only, no user-content strings. VISION.md + AGENTS.md updated. Sprint 27 four-modes regression test: 11/11 pass.

**Tier 4 COMPLETE** — 3/3 sprints passed (sprints 26-28). Spec status='completed'.

## Spec Completion Summary: spec-20260524-bober-vision

- Total sprints: 28/28 passed
- Total tests: 1115 passing (+ 4 skipped) at spec completion
- Branch: bober/bober-vision
- Spec status: completed (completedAt: 2026-05-25T13:30:00Z)
- Ambiguity score: 5 (start) → 5 (final, unchanged)
- Deferred decisions: none — all clarifications resolved in spec planning
- Key capabilities shipped: four operating modes (autopilot, careful-flow, diagnose, postmortem), behavior-shaping skill catalog (Iron Laws / Red Flags / Rationalization-Prevention), incident lifecycle with SLO verification, playbook library, 28-sprint regression suite with e2e four-mode coverage, opt-in local-only telemetry (zero network egress, ESLint-enforced)

---

## Plan: Cockpit Integration
- Spec: spec-20260525-cockpit-integration
- Created: 2026-05-25
- Sprints: 6
- Status: completed (6/6 sprints, completedAt 2026-05-25T18:33:19Z)
- Mode: brownfield
- Ambiguity score: 4/10
- Branch: bober/cockpit-integration
- Test count: 1116 → 1330 (+214); tool count: 17 → 37 (+20)

### Sprint Breakdown
1. [completed] Multi-run RunManager — keyed map + .bober/runs/<runId>/state.json with atomic writes + crash recovery via load(). Commit 8fb8f79.
2. [completed] Run-management MCP tools — bober_list_active_runs, bober_get_run_status, bober_abort_run. Commit caf6c76.
3. [completed] Event-stream MCP tool — bober_subscribe_events with bounded queues + bober/events.dropped on overflow. Commits b573e22, 014cc06.
4. [completed] Worktree adapter — runInWorktree + bober worktree run CLI + bober_run_in_worktree MCP. Git CLI shell-out (no new lib), RunState +worktreePath/branch. Commit 48c2953. Passed iter 1 (8/8).
5. [completed] Careful-flow + discovery MCP — list_pending_approvals, approve_checkpoint, reject_checkpoint, list_projects, list_specs, get_project_state. Shared listPendingApprovals + readRunStatesFromDisk helpers. Commit f3463a2. Passed iter 1 (8/8).
6. [completed] Vision-era MCP wrappers + e2e capstone — eight new tools (incident_start/status/list/abort, rollback_start, postmortem_get, playbook_list/search) as thin adapters over src/incident/*. tests/e2e/cockpit-integration.test.ts spawns real MCP subprocess via StdioClientTransport, exercises every Sprint 1-6 tool with toMatchObject strong assertions, deterministic ~4s via BOBER_TEST_DETERMINISTIC guard in src/providers/factory.ts. Commits 57f3f4f, 714d47f. Passed iter 1 (12/12).

### Pipeline Statistics
- Total iterations used: 3 / 40 (sprints 4-6 each passed iter 1)
- Subagents spawned this run: 9 (3 curator + 3 generator + 3 evaluator)
- Sprints completed this run: 3 (sprints 4-6); spec total 6/6

### Out of Scope
- Cockpit UI/backend itself (separate repo, separate team)
- Credential storage and deployment provider skills (separate parallel spec)
- Discussion-agent / chat memory layer (cockpit's responsibility)
- Auth / multi-user / billing (cockpit's responsibility)

## Plan: Anthropic Prompt Caching
- Spec: spec-20260529-anthropic-prompt-caching
- Created: 2026-05-29
- Sprints: 1
- Status: completed (1/1 sprints)
- Source: borrow #1 from nousresearch/hermes-agent (see openhands-bober/.bober/research/research-20260529-borrow-from-hermes-agent.md)

### Sprint Breakdown
1. [completed] Anthropic prompt caching behind a default-on flag -- cache_control breakpoints (system + last-3) in AnthropicAdapter, gated by providerConfig.promptCaching, default on for Anthropic. (commits 5f7824e + 2dab5fb; passed iteration 2/2, 7/7 criteria)

## Plan: Claude Opus 4.8 Support
- Spec: spec-20260529-opus-4-8-support
- Created: 2026-05-29
- Sprints: 4
- Status: completed (4/4 sprints)
- Branch: bober/opus-4-8-support (stacked on bober/anthropic-prompt-caching)
- Source: https://www.anthropic.com/news/claude-opus-4-8 (GA 2026-05-28); shapes confirmed vs platform.claude.com API ref

### Sprint Breakdown
1. [completed] Repoint opus shorthand to claude-opus-4-8 + pin opus-4-7 -- model-resolver only. Passed iter 1 (5/5 criteria), commit 1fd6497.
2. [completed] Upgrade @anthropic-ai/sdk 0.39->0.100.1 for output_config.effort + mid_conv_system -- Passed iter 1 (6/6), commit b48c5bb. ZERO adapter code changes (type-backward-compatible).
3. [completed] Add effort control (output_config.effort, low|medium|high|xhigh|max) -- Passed iter 1 (5/5), commit da7c642.
4. [completed] Add mid-conversation system blocks (mid_conv_system content block) -- Passed iter 1 (5/5), commit 4d78031.

## Plan: Multi-Provider Strategy — DeepSeek + Claude Code Subscription
- Spec: spec-20260531-multi-provider-deepseek-claude-code
- Created: 2026-05-31
- Status: completed (6/6 sprints) — 2026-05-31
- Branch: spike/claude-code-provider (commits 99c20e2..71d16be)

### Sprint Breakdown
1. [completed] Fix eslint peer-dependency conflict — eslint ^10.0.0 (resolves 10.4.1); npm install clean, no ERESOLVE. Passed iter 1, commit 99c20e2.
2. [completed] DeepSeek shorthand + key handling — deepseek/v4-pro/v4-flash → openai-compat @ api.deepseek.com; DEEPSEEK_API_KEY fallback + DeepSeek-specific missing-key error. Passed iter 1, commit 79971c9.
3. [completed] openai optional-peer preflight — verified missing-package throw; preflightOpenaiPeer warning hint added. Passed iter 1, commit 43b56a0.
4. [completed] Promote claude-code provider — ClaudeCodeAdapter in createClient, no key, preflightClaudeBinary, binary/timeoutMs overrides, tools-guard throw (execa mocked). Passed iter 1, commit 417f37f.
5. [completed] Role-aware provider fallback — resolveRoleProviders wired into loadConfig; tool roles redirect or hard-error naming the role; prompt roles allowed; per-role logging. Passed iter 1, commit 1111e2a.
6. [completed] Docs + key-gated smoke — README capability matrix + docs/providers.md; deepseek/claude-code smoke scripts skip without secrets, excluded from npm test. Passed iter 1, commit 71d16be.

### Pipeline Statistics
- Total iterations used: 6 / 20 (every sprint passed on iteration 1)
- Sprints completed: 6 / 6
- Subagents spawned: 18 (6 curators + 6 generators + 6 evaluators) + 1 planner = 19
- Known follow-up (non-blocking): preflightOpenaiPeer is implemented + tested but not yet wired into a startup call site (Sprint-3 advisory; Sprint-5 left the optional loader wiring out to avoid disturbing loader tests).


---

## Plan: Scale-Safe Sprint History + Self-Improvement Memory
- Spec: spec-20260605-scale-safe-history-memory
- Branch: bober/scale-safe-history-memory
- Status: in-progress
- Last updated: 2026-06-04T23:19:49Z

### Sprint Breakdown
1. [completed] Bounded history reads + crash-safe rotation — passed iteration 1 (a75a376, 59dde7d)
2. [in-progress] Deterministic lessons memory store — iteration 1
3. [proposed] Deterministic distillation + bober memory CLI (depends on 2)
4. [proposed] Planner reads bounded memory / close the arc (depends on 2,3)

### Pipeline Statistics
- Iteration budget: 1 / 20 used
- Sprints completed: 1 / 4
- Subagents spawned: 3 (curator, generator, evaluator)

---

## Plan COMPLETE: Scale-Safe Sprint History + Self-Improvement Memory
- Spec: spec-20260605-scale-safe-history-memory
- Branch: bober/scale-safe-history-memory
- Status: completed (4/4 sprints) — 2026-06-05T00:02:59Z

### Final Sprint Results (all passed iteration 1)
1. [completed] Bounded history reads + crash-safe rotation (a75a376, +lint fix 59dde7d)
2. [completed] Deterministic lessons memory store (6e9179b)
3. [completed] Deterministic distillation + bober memory CLI (b17dff1)
4. [completed] Planner reads bounded memory / close the arc (b8b6d37, 16a09ae)

### Pipeline Statistics
- Iterations: 4 / 20 (every sprint passed on iteration 1)
- Sprints: 4 / 4 passed
- Subagents spawned: 12 (4 curator + 4 generator + 4 evaluator)
- Full suite: 1762 passed / 3 skipped / 1 pre-existing-unrelated fail (stale version pin)

### Documented follow-ups (NOT done, out of plan scope)
- Sprint 3: distill.test.ts C1 could add an exact toHaveLength(N) assertion (evaluator low-priority note).
- Distribution: skills/bober.plan/SKILL.md + agents/bober-planner.md edited (canonical); run `npm run update-all` to sync the .claude/ distributed copies.
- Pre-existing: tests/cli/skill-bundles.test.ts pins version 0.15.0 but actual is 0.16.0 (unrelated stale test).

## Plan: Fleet Orchestrator (Tech-Lead Orchestrator)
- Spec: spec-20260609-fleet-orchestrator
- Architecture: arch-20260609-fleet-orchestrator-tech-lead
- Created: 2026-06-09
- Sprints: 4
- Status: planned

### Sprint Breakdown
1. [proposed] Fleet manifest schema, loader, and child config builder -- Zod manifest + load() + buildChildConfig() producing a Zod-valid DeepSeek BoberConfig (ADR-2).
2. [proposed] Child folder scaffolding and subprocess runner -- scaffold() (mkdir+config+git init, skip non-empty) + run() (execa reject:false + timeout + import.meta.url CLI resolution) (ADR-4, ADR-5).
3. [proposed] Bounded fan-out coordinator and outcome aggregator -- execute() via mapBounded never-reject thunk + aggregate() disk-primary RunState with exit-code fallback (critical isolation+concurrency).
4. [proposed] Portfolio reporter, runFleet entrypoint, and fleet CLI command -- atomic fleet-report.json + runFleet() + registerFleetCommand + DEEPSEEK_API_KEY fail-fast (user-visible end-to-end).
