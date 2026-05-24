# Bober Progress

Project: agent-bober
Mode: brownfield
Preset: custom
Initialized: 2026-03-28
Last updated: 2026-04-16T15:33:00Z

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
1. [proposed] SessionStart bootstrap + bober.using-bober skill — Inject behavior-bootstrap into first-turn context; coexists with existing graph-stats payload.
2. [proposed] Verbatim port of verify + debug skills — bober.verify + bober.debug ported from obra/superpowers with MIT attribution and original voice (Iron Law caps, <EXTREMELY-IMPORTANT> tags preserved); inline into bober-generator.
3. [proposed] Voice pass across remaining agent prompts — Iron Law / Red Flags / Rationalization-Prevention table structure across planner, curator, architect, researcher, evaluator (verbatim style).

### Tier 1 — Quality discipline (sprints 4-6)
4. [proposed] Anti-pattern reference catalog — Port four MIT-attributed anti-pattern docs into .bober/anti-patterns/; wire evaluator to cite them in regressions.
5. [proposed] bober-code-reviewer agent + bober.code-review skill + orchestrator wiring — Fresh-context advisory review after evaluator pass.
6. [proposed] HARD-GATE in bober.plan + AGENTS.md at repo root — Brainstorming hard gate between PlanSpec and contracts; AGENTS.md anti-slop contract with verbatim voice; cross-link from README and bootstrap skill.

### Tier 2 — Careful-flow multi-mode (sprints 7-14)
7. [proposed] Careful-flow plumbing — Checkpoint abstraction + 9 call sites in orchestrator + noop default mechanism (no behavior change yet).
8. [proposed] CLI blocking checkpoint mechanism — Blocking stdin prompts with approve/reject/edit; TTY fallback to noop.
9. [proposed] Disk-marker mechanism + bober approve CLI — .bober/approvals/<id>.pending.json + bober approve/reject/list-approvals subcommands; production-friendly async approval.
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
