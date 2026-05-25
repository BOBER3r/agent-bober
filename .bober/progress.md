# Bober Progress

Project: agent-bober
Mode: brownfield
Preset: custom
Initialized: 2026-03-28
Last updated: 2026-05-25T04:25:00Z

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
15. [proposed] bober-diagnoser agent — Read-only investigator; tool list mergeable with observability MCPs at spawn.
16. [proposed] Observability MCP plugin slot architecture — observability.providers config schema; tool merge at diagnoser spawn; reference adapter docs (no built-in integrations).
17. [proposed] bober.diagnose skill — 4-phase incident root-cause discipline (Reproduce/Confirm, Gather at Boundaries, Hypothesize-and-Test, Verify Resolution).
18. [proposed] bober.runbook skill — Runbook-execution discipline with precondition+postcondition verification per step, hard gates around destructive ops.
19. [proposed] Incident timeline tracking — .bober/incidents/<id>/ structured artifacts + timeline/observation/action/change/runbook-execution append helpers.
20. [proposed] Change-management gates + bober-deployer agent + bober.deploy skill — Action classification (safe vs risky); risky actions require checkpoint approval regardless of mode; ChangeEntry recorded with required inverse.
21. [proposed] Rollback awareness + bober rollback CLI — Plan + execute rollback via recorded inverses with per-step gating.
22. [proposed] SLO/metric verification — verifyResolution queries observability MCP, gates resolved status; override token with required reason.
23. [proposed] bober-postmortemer + bober.postmortem skill — Offline synthesis of incident timeline into structured postmortem.md with 5-Whys + evidence citations + action items.
24. [proposed] /bober-incident skill + CLI entry — Top-level incident workflow with state machine routing across diagnoser/deployer/postmortemer.
25. [proposed] Incident playbook library — .bober/playbooks/ starter set + searchPlaybooks for symptom-to-playbook matching.

### Tier 4 — Integration & polish (sprints 26-28)
26. [proposed] VISION.md at repo root + README update — Document the four modes with worked examples; configuration reference; foundation crediting obra/superpowers.
27. [proposed] End-to-end four-mode integration test — Fixture project, mock observability MCP, exercises autopilot → careful-flow → diagnose → postmortem → rollback paths.
28. [proposed] Config migration + opt-in local-only telemetry — Backward-compat schema; telemetry hooks with no network egress (ESLint-enforced); spec marked completed only when full regression sweep passes.
