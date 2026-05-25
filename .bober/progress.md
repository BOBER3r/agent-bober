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
10. [proposed] GitHub PR-native mechanism — Draft PR per run, comment per checkpoint, label/comment-driven approval; gh CLI integration with disk-mechanism fallback.
11. [proposed] Per-artifact-type renderers — Structured summaries per artifact type (research/plan/contract/diff/eval/review/sprint/pipeline).
12. [proposed] Feedback propagation back to agents — Reject/edit feedback routed to responsible agent (planner re-plans, generator re-implements); iteration cap with abort.
13. [proposed] Approval audit trail — Append-only .bober/audits/<runId>.jsonl with ApprovalRecord; bober audit show CLI.
14. [proposed] Mode + mechanism config — pipeline.mode (autopilot|careful), pipeline.checkpointMechanism, pipeline.checkpointOverrides; --checkpoint CLI flag; backward-compat defaults.

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
