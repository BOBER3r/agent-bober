# Bober Progress

Project: agent-bober
Mode: greenfield
Last updated: 2026-06-15

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
