# Bober Progress

Project: agent-bober
Mode: greenfield
Last updated: 2026-06-15

---

## Plan: Self-improvement P1/P2 — offline, gated (Chattable-Team Phase 5)
- Spec: spec-20260615-self-improve-p1-p2
- Branch: bober/self-improve-p1-p2
- Created: 2026-06-15
- Sprints: 4
- Status: completed (4/4 sprints)
- Note: Hardens self-improvement to be SAFE to enable. Replay regression harness (the gate) + off-by-default evaluator anti-degeneration guards + offline replay-gated GEPA prompt evolution. Cross-cutting invariant: system never edits its own prompts/lessons without a deterministic, replay-gated check; live pipeline byte-identical until a selfImprove flag is explicitly enabled. DAG: 1 → {2,3}, 2 → 4.

### Sprint Breakdown
1. [completed] Replay store + selfImprove config + `bober replay capture|list|show` — iter 1 (8/8). Pure SQLite ReplayStore cloning FactStore discipline (content-hash caseId, injected timestamps, :memory:-testable), immutable .bober/replay/cases/*.json fixtures, off-by-default selfImprove Zod section, no-throw CLI. +22 tests; full suite 2236 pass, zero regressions.
2. [completed] `bober replay run` deterministic regression gate + runReplayHarness API — iter 1 (7/7). Pure compareToBaseline (baseline-pass→fresh-fail = regression) + runReplayHarness re-derives verdict from frozen eval_details_json (zero LLM/network refs — the load-bearing invariant) + `replay run` exit-1-on-regression. +18 tests; full suite 2254 pass, zero regressions.
3. [completed] Evaluator anti-degeneration guards (deterministic-first, rubric isolation, cite-artifact) — off-by-default — iter 1 (8/8). Three PURE guards in eval-guards.ts (shouldShortCircuitJudge/redactRubric/enforceCitedArtifacts) wired into LIVE evaluator-agent.ts + pipeline.ts behind config.selfImprove?. optional chaining. sc-3-7 byte-identical-when-off invariant proven via loopSpy. +33 tests; full suite 2290 pass, ZERO regressions despite touching live files.
4. [completed] GEPA offline prompt evolution `bober evolve` — replay-gated, Pareto-set, never live — iter 1 (9/9). gepa.ts (mulberry32 seeded proposeVariants, paretoSet frontier, evolve with DI seam) + `bober evolve --role --seed --dry-run`. Variants scored ONLY via runReplayHarness; strict promotion (zero regressions AND strictly-more improvements — tie does NOT promote); writes only under .bober/evolve/<runId>/. Two safety invariants (never writes agents/, never called by runPipeline) proven by source-text guard test + independent grep. +19 tests; full suite 2309 pass, zero regressions.

### Pipeline Statistics
- Total iterations used: 4 / 20
- Sprints completed: 4 / 4 — ALL PASSED ITERATION 1 (zero reworks)
- Subagents spawned: 18 (1 planner, 4 curator, 4 generator, 4 evaluator, 4 documenter [3 done + 1 pending]) 
- Final suite: 2309 tests passing, build + typecheck clean, lint 0 errors
- Branch: bober/self-improve-p1-p2 (unpushed). Follow-up: npm run update-all (sync skill/agent .claude copies if any changed), then merge.

---

## Plan: Domain-Agnostic Team Abstraction (Chattable-Team Phase 4)
- Spec: spec-20260615-team-abstraction
- Branch: bober/team-abstraction
- Created: 2026-06-15
- Sprints: 4
- Status: completed (4/4 sprints)
- Note: user's "Phase 2" = research-roadmap Phase 4 (Team abstraction). Interrupt/approve/steer (research Phase 2) intentionally NOT built here. semantic_facts namespacing deferred to Phase 3.

### Sprint Breakdown
1. [completed] Team data model + registry + programming team as instance #1 — iter 1 (8/8). src/teams/{types,registry}.ts + loadTeam + teams/defaultTeam schema; zero behavior change.
2. [completed] Per-team memory namespacing — iter 1 (8/8). memoryDir centralizes ns→path; appendLesson/loadLessonIndex/loadLesson/retrieveRelevantLessons thread namespace; CLI+chat derive from loadTeam; distill.ts untouched (pure). +20 tests.
3. [completed] Team-aware pipeline-shape selection — iter 1 (6/6). selectPipelineEngineForTeam(team,config) + runPipeline opts.teamId/defaultTeam wiring; programming path byte-identical; downgrade log line unchanged. +8 tests.
4. [completed] Second team as data + CLI wiring (`run --team`, `chat <team>`) + docs — iter 1 (8/8). Example team pure data (no code branch); --team additive; namespace routing isolated; docs/teams.md + README. +16 tests. (Generator crashed once on transient API error; clean redo passed.)

### Pipeline Statistics
- Total iterations used: 4 / 20
- Sprints completed: 4 / 4
- Subagents spawned: 16 (4 curator, 4 generator [1 crashed/redone], 4 evaluator, 3 documenter) + final documenter pending
- Final suite: 1977 tests passing, build + typecheck clean, lint 0 errors

---

## Plan: Bober Chat Session Layer (Chattable-Team Phase 1)
- Spec: spec-20260614-bober-chat-session-layer
- Branch: bober/chat-session-layer
- Status: completed (4/4 sprints)

### Sprint Breakdown
1. [completed] Chat REPL that answers — walking skeleton, chat role, resumable session — iter 1 (9/9)
2. [completed] Non-blocking detached spawn with session-generated runId (--run-id flag) — iter 1 (9/9)
3. [completed] Rotation-safe completion weaving (history.jsonl tailer) — iter 2 (8/8; iter 1 caught a self-scan regression)
4. [completed] Steer: inspect + kill-by-PID stop with /stop command — iter 1 (9/9)

### Pipeline Statistics
- Total iterations used: 5 / 20
- Sprints completed: 4 / 4
- Subagents spawned: 18 (4 curator, 5 generator, 5 evaluator, 4 documenter)
- Final suite: 1920 tests passing, build + typecheck clean

---

## Plan: Chat Interrupt / Approve / Steer (Chattable-Team research Phase 2)
- Spec: spec-20260615-chat-interrupt-approve-steer
- Created: 2026-06-15
- Sprints: 6
- Branch: bober/chat-interrupt-approve-steer
- Status: in-progress (5/6 sprints — all steer capabilities built; S6 = hygiene + docs + e2e)
- Baseline (branch cut from main 63e6a33): 1977 tests passing, typecheck + build clean
- KNOWN PRE-EXISTING FLAKE (track for S6): src/mcp/tools/list-active-runs.test.ts intermittent ENOTEMPTY cleanup race on first full-suite run; passes on re-run/isolation. Not caused by this plan.

### Sprint Breakdown
1. [completed] RunState grammar + careful-mode chat spawn + /careful toggle — iter 1 (7/7). Commit 14c2be6 (12 files, +545). RunState union +input-required/paused +4 optional fields (run-manager.ts); --approve-gates validated vs CHECKPOINT_SITES (run.ts/index.ts); CarefulSidecar session toggle; RunSpawner careful-on appends curated gates, autopilot byte-for-byte (canary green). +25 tests -> 2002 passing. Docs fb74d32.
2. [completed] Surface pending approvals in chat (read path) + roster input-required — iter 1 (8/8). Commit 67495fc (7 files, +708). ApprovalReader over listPending (read-only); ApprovalCursor announce-once (key=checkpointId@requestedAt); handleTurn poll-prelude weaves notice into both reply paths; idempotent running->input-required RunState reflection (no clobber); roster additive waiting=<gate>. approval-state.ts untouched. +19 tests -> 2021 passing. Docs 5cb70ea.
3. [completed] Resolve approvals from chat: /approve, /reject + feedback, NL — iter 1 (7/7). Commit fb4b787 (6 files, +679). handleApprove/handleReject reuse saveApproved/saveRejected + pendingExists guard + resolveApprover (approve.ts:29, already exported); classifier approve/reject intents; ambiguity rule (1->use, 2+ unnamed->ASK); RunState clears pending->running. Genuine DiskCheckpointMechanism round-trip proves {approved:false,feedback} (correct setTimeout-after-request timing). Protected files untouched. +27 tests -> 2048 passing. HITL loop closed. Docs c9ac80c.
4. [completed] Free-text guidance injection: /tell <runId> <text> + additive pipeline read point — iter 1 (8/8). Commit b74dfcb (9 files, +809). src/state/guidance.ts (safeSegment path-traversal guard, atomic temp+rename drain-consume, hasRunDir unknown-run guard); /tell slash + NL 'tell' classifier action + HELP_TEXT. PROTECTED pipeline.ts: +34/-1 single additive 'guidance injection' block inside runSprintCycle guarded on pipelineRunId; pure injectGuidanceIntoHandoff (empty->SAME reference ===, no-op); runTsPipeline + :571 invariant untouched, no phase reorder (evaluator-verified). +38 tests -> 2086 passing. Docs e5306f6.
5. [completed] Soft pause/resume: /pause, /resume + paused RunState + cooperative gate — iter 1 (7/7). Commit bd14e02 (10 files, +1024). src/state/pause.ts (clones guidance.ts, reuses exported safeSegment; setPaused/clearPaused/isPaused + waitWhilePaused injected-clock bounded poll). PROTECTED pipeline.ts: +8/-0 PURE addition — single guarded if(pipelineRunId) waitWhilePaused gate after S4 guidance block, before Generate phase; runTsPipeline/runPipeline/:570-587 untouched. NO-KILL verified (killCalls===0 vs /stop ===1); /pause distinct from hard /stop in HELP_TEXT. NL pause/resume. +44 tests -> 2130 passing.
3. [proposed] Resolve approvals from chat: /approve, /reject + feedback, NL — reuse saveApproved/saveRejected; child resumes via existing disk poll; feedback -> rework
4. [proposed] Free-text guidance injection: /tell <runId> <text> + additive pipeline read point at checkpoint boundary
5. [proposed] Soft pause/resume: /pause, /resume + paused RunState + additive cooperative-pause gate (distinct from hard /stop)
6. [proposed] Hygiene, docs, end-to-end — cleanup stale markers/RunState on completion; full-loop e2e; /help + README + docs/chat-steer.md (documents single-careful-run limitation + runId-scoped follow-up)

### Notes
- Phase 1 (chat #44) and Phase 4 (team abstraction #45) are merged to main; building on main.
- ~80% of the approval substrate already exists (DiskCheckpointMechanism + approval-state.ts + approve/reject/list-approvals CLI resume cross-process); Phase 2 wires it into chat, does not rebuild it.
- Pipeline already wires every checkpoint gate; curated gating = checkpointOverrides {post-research,post-plan,post-sprint -> disk}.
- Decisions: careful = session toggle; pause points = curated subset; steer scope = approve/reject+feedback + guidance injection + soft pause/resume (all three).

---

## Plan: Durable Semantic Facts + Memory Hygiene (Phase 3)
- Spec: spec-20260615-memory-self-improve-p0
- Created: 2026-06-15
- Sprints: 5
- Status: completed (5/5 sprints) — all passed iter 1, zero reworks, on branch bober/memory-self-improve-p0
- Source: .bober/research/20260614-chattable-team-of-agents-platform.md §8 Phase 3
- Decisions (user-answered): SQLite facts store (better-sqlite3) · LLM-judged reconcile (deterministic core + injected judge) · auto-producer wired · deterministic offline contrast in distill

### Sprint Breakdown
1. [completed] Add bi-temporal SQLite semantic-facts store + `bober facts` CLI -- FactStore adapter + schema + insert/query-active/invalidate + CLI -- Passed iter 1 (7/7). Commit 7f0b1b6 (6 files, +1073). better-sqlite3 behind FactStore iface; pure store (no clock); 11-col semantic_facts + 2 indexes; deterministic sha256 ids; 5 :memory: tests; facts add|list|show|invalidate CLI. Full suite 2144/2144, zero regressions.
2. [completed] Reconcile-on-write -- deterministic exact-match supersede (NOOP/ADD/UPDATE) + injected LLM FactJudge on ambiguity, ADD fallback -- Passed iter 1 (7/7). Commit 0600a76 (5 files, +743). reconcile.ts pure core (no clock/network); supersedeFact sets both bi-temporal fields; fact-judge.ts createLLMFactJudge via createClient w/ 'add' fallback; CLI add now reconciles. Full suite 2156/2156.
3. [completed] Lesson hygiene -- occurrence-weighted ranking + decay/conflict-quarantine to QUARANTINE.md + `bober memory prune` -- Passed iter 1 (6/6). Commit 9d17da4 (7 files, +797). retrieve.ts 3-key sort (overlap→occurrences→lessonId, token-overlap dominant); hygiene.ts pure pruneLessons {kept,quarantined}; memory.ts quarantinePath + rewriteIndexForQuarantine (never deletes .md); `memory prune` CLI. Full suite 2176/2176.
4. [completed] Fail->pass contrast extractor -- extend pure distill() to emit `fix-contrast` lessons from iterationHistory transitions -- Passed iter 1 (6/6). Commit 697eb20 (2 files, +105). Pure additive signal (d): detects fail→pass in iterationHistory → fix-contrast:<id> lesson w/ refs to fail+pass iterations; ignores first-pass/all-fail/pass-before-fail; purity preserved (no providers/clock/fs). Regression trap handled (2 fixture assertions updated). Full suite 2180/2180.
5. [completed] Auto-producer -- deterministic project-fact detector wired into runPipeline/chat + retrieveRelevantFacts into planner/curator context -- Passed iter 1 (6/6). Commit 3a407ce (7 files, +901). Pure detectProjectFacts (test/build/packageManager/framework) + thin seedProjectFacts IO caller; guarded additive wiring at pipeline.ts:1030 + chat-session.ts:504 (facts failure never aborts a run); retrieveRelevantFacts (scope-isolated active rows, SQL-enforced) + serializeFactsForContext (charBudget hard cap); planner userMessage injection (guarded). No LLM on produce path. +30 tests → full suite 2213 (2210 pass), zero regressions.

### Pipeline Statistics
- Total iterations used: 5 / 20 (one per sprint — zero reworks)
- Sprints completed: 5 / 5
- Subagents spawned: 21 (5 curators + 5 generators + 5 evaluators + 5 documenters + 1 planner from prior session)
- Test suite: 2144 → 2213 (+69 new tests across the 5 sprints)
- Open follow-up: principles.md tension (SQLite = first relational store + native dep + sync I/O vs "No database"/"No synchronous fs" principles); user-approved Q1=B, flagged in docs/self-improvement-memory.md, deferred to maintainer. Also: `npm run update-all` to sync skill/agent copies; merge branch bober/memory-self-improve-p0.

---

## Plan: Self-improvement P1/P2 — replay harness, evaluator guards, GEPA (Phase 5)
- Spec: spec-20260615-self-improve-p1-p2
- Created: 2026-06-15
- Sprints: 4
- Status: planned (ready)
- Source: .bober/research/20260614-chattable-team-of-agents-platform.md §5 (Self-improvement loop) + §8 Phase 5
- Cross-cutting invariant: never let the system edit its own prompts/lessons without a deterministic, replay-gated check (defense against the biased-judge → biased-lesson → biased-generator flywheel, §7 risk #3). Fully additive + reversible — no live pipeline behavior change by default; every new gate/verb is opt-in or off-by-default.
- Self-answered decisions (planner, all evidence-cited in design doc): replay corpus = .bober/replay/cases/*.json + SQLite replay.db via FactStore adapter pattern · deterministic-first gate = pure guard after runEvaluation, off-by-default · rubric isolation = pure redactRubric at createHandoff, off-by-default · cite-artifact = downgrade uncited FAIL details, off-by-default · GEPA writes ONLY under .bober/evolve/, never agents/ and never from runPipeline.

### Sprint Breakdown
1. [proposed] Replay store + selfImprove config section + `bober replay capture|list|show` — pure SQLite ReplayStore (deterministic caseId, injected timestamps, :memory:-testable) + immutable per-case fixtures + off-by-default selfImprove Zod section + capture/list/show CLI ingesting .bober/eval-results/. (S5.1 — the GATE)
2. [proposed] `bober replay run` deterministic regression gate + runReplayHarness API — pure compareToBaseline + `replay run` (per-case delta table, exit 1 on any regression) + public runReplayHarness() for Sprint 4. Depends on Sprint 1. (S5.1)
3. [proposed] Evaluator anti-degeneration guards (off-by-default) — pure shouldShortCircuitJudge (deterministic-first), redactRubric (rubric isolation), enforceCitedArtifacts (cite-failing-artifact), wired into evaluator-agent.ts + pipeline.ts behind config.selfImprove flags; all-flags-false invariant test proves byte-identical live behavior. Depends on Sprint 1. (S5.2)
4. [proposed] GEPA offline prompt evolution `bober evolve` — replay-gated, Pareto-set, never live — deterministic proposeVariants + paretoSet + evolve() scoring variants ONLY via runReplayHarness, writing a promoted prompt under .bober/evolve/ only on strict improvement w/ zero regressions; guard test proves no write to agents/ and no call from runPipeline. Depends on Sprint 2. (S5.3)

### Notes
- DAG: 1 → {2, 3}; 2 → 4. Sprint 1 is the only zero-dependency entry. Sprint 4 (GEPA) depends on Sprint 2's replay GATE — never built before the harness exists, per §8 sequencing.
- Reuses (not rebuilds): better-sqlite3 / FactStore adapter pattern (src/state/facts.ts), CLI register<X>Command pattern (src/cli/commands/facts.ts), eval-results payload (src/orchestrator/eval-persist.ts), agent-loader prompt contract (src/orchestrator/agent-loader.ts), provider-agnostic createClient (src/providers/factory.ts).
- All four contracts pass the precision gate (no banned vague phrases); each has a required build + typecheck criterion and a functional/unit-test criterion.
