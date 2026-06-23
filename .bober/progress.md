# Bober Progress

Project: agent-bober
Mode: greenfield
Last updated: 2026-06-18

---

## Plan: Real executed round count in fleet synthesis + report
- Spec: spec-20260618-fleet-synthesis-round-count
- Branch: bober/medical-team
- Created: 2026-06-18
- Sprints: 1
- Status: completed (1/1 sprints)
- Origin: closes the Phase-B (spec-20260618-fleet-blackboard-exchange) known limitation — bundle.rounds reported the configured maxRounds cap, not the rounds actually executed (early-stopped runs over-reported). User decisions: Q1=rounds-executed (terminating round, ==maxRounds on full run); Q2=surface in BOTH fleet-synthesis.json AND fleet-report.json (PortfolioReport gains an OPTIONAL rounds field, present only on blackboard runs → no-blackboard report byte-identical).

### Sprint Breakdown
1. [completed] executeRounds returns real round count → fleet-synthesis.json + fleet-report.json -- Passed iter-1 (commit 5a4d6b7); executeRounds returns {executions, roundsRun=terminating round}; runFleet threads it into reporter.build (blackboard-only, optional rounds field) + collect; bober: ceiling comment removed; no-blackboard path byte-identical. 6 files (coordinator/index/reporter + tests).

---

## Plan: Phase B — bounded inter-agent blackboard + round loop + synthesis
- Spec: spec-20260618-fleet-blackboard-exchange
- Branch: bober/medical-team
- Created: 2026-06-18
- Sprints: 4
- Status: completed (4/4 sprints)
- Origin: arch-20260618-heterogeneous-multi-provider-agent-team Phase B (the deferred inter-agent exchange). User decisions: coordinator re-run loop (≤3 rounds, early-stop on no-new-findings); explicit `agent-bober blackboard` CLI seam (no run auto-wiring); separate .bober/fleet-synthesis.json (pure data, head synthesizes). Additive — omit --blackboard → byte-identical to Phase A.

### Sprint Breakdown
1. [completed] SharedBlackboard module (WAL facts.db wrapper) -- Passed iter-1 (commit e1d4b00); open/publish/readSiblings/readAll/close + BLACKBOARD_MAX_ROUNDS cap; concurrent-writer test; FactStore WAL opt-in (default off, existing callers unaffected).
2. [completed] config.fleet section + manifest.blackboard + path injection + `agent-bober blackboard` CLI -- Passed iter-1 (commit 2784f71); BoberConfig.fleet (child-visible channel) + manifest.blackboard + resolveBlackboardPath (head-injected absolute) + scaffolder writes it; explicit publish/read CLI; byte-identical when absent.
3. [completed] Coordinator re-run loop -- Passed iter-1 (commit 2e16f19); rounds ≤maxRounds (scaffold round-1 only, re-spawn each round), early-stop on no-new-findings; wired into runFleet behind a blackboard; byte-identical single-pass when absent.
4. [completed] SynthesisStep + fleet-synthesis.json -- Passed iter-1 (commit 297a8f2); pure collect {rounds,childResults,findings} written only on blackboard runs; no LLM; report unchanged.

---

## Plan: Phase A — Tier-by-difficulty provider routing + Grok/xAI + tool-role guard
- Spec: spec-20260618-fleet-tier-provider-routing
- Branch: bober/medical-team
- Created: 2026-06-18
- Sprints: 3
- Status: completed (3/3 sprints)
- Origin: arch-20260618-heterogeneous-multi-provider-agent-team (Approach C, head-agnostic substrate). Phase A = the mechanical, buildable-now slice (Phase B blackboard deferred). Head = a Claude Code dynamic workflow (subscription); bober supplies heterogeneous-provider children. Tier table: cheap→DeepSeek, standard→Grok/xAI, hard→Anthropic Sonnet, frontier→Anthropic Opus; default→no overlay (byte-identical). claude-code never in a tier (head-only; can't drive tool roles).

### Sprint Breakdown
1. [completed] Grok/xAI provider wiring -- iter 1 (7/7). grok/grok-4/grok-4-fast→openai-compat api.x.ai/v1; isXaiEndpoint() sole predicate; validateApiKey/createClient XAI_API_KEY arms; ProviderName unchanged; validateManifestCredentials untouched. Commit b739ef1.
2. [completed] TierProviderPolicy + buildChildConfig tier overlay -- iter 1 (8/8). new tier-policy.ts (cheap=DeepSeek/standard=Grok/hard=Sonnet/frontier=Opus; default=>no overlay; no claude-code); FleetChild.tier enum; overlay before the unchanged shallow-merge; byte-identical no-tier (deep-equal proven); child.config wins. Commit 6e25a5f.
3. [completed] ToolRoleGuard (build-time, fail-fast) -- iter 1 (8/8). exported isToolRole() (from TOOL_ROLES) + effectiveProvider; new tool-role-guard.ts check/assertManifest; wired into runFleet step 3 BEFORE validateManifestCredentials + coordinator.execute (line 110 < 118), coordinator never called on throw; validateManifest byte-identical. Commit c13056a.

---

## Plan: Fail-closed grounding-critic gate for medical synthesis
- Spec: spec-20260618-medical-grounding-critic
- Branch: bober/medical-team
- Created: 2026-06-18
- Sprints: 3
- Status: completed (3/3 sprints)
- Origin: research-20260618-fleet-decomposer-to-medical-team — applies the newly-merged fleet decomposer/critic pattern to the medical team, INVERTED to fail-closed (abstain, not approve, on uncertainty). Adds a 2nd LLM call that audits each synthesized answer against its cited passages for faithfulness + completeness; one bounded re-synthesis then abstain. Synthesis/critic model configurable, cloud strictly gated by existing cloud-inference egress axis (default false). criticVerdict recorded IDs/enums-only in 0600 audit log.

### Sprint Breakdown
1. [completed] Grounding-critic module (fail-closed core) -- iter 1 (7/7). new src/medical/retrieval/grounding-critic.ts; never-throw validator + bounded retry from fleet critic-deep.ts INVERTED to reject-on-exhaustion (line 206). 22 tests, purely additive, zero wiring. Commit 10bb964.
2. [completed] Gated synthesis flow + engine wiring -- iter 1 (8/8). synthesizeGrounded in literature.ts (synthesize -> critic -> one re-synth -> abstain; try/catch->abstain on throw; GROUNDED_GATE_MAX_LLM_CALLS=6); engine.ts:403 swap. All 11 zero-LLM assertions intact; only grounded call-count updated. 12 new tests. Commit 90c3ca3.
3. [completed] Configurable model + cloud-inference egress gating + audit verdict -- iter 1 (8/8). config.medical.inference block + new src/medical/inference.ts buildMedicalInferenceClient (fail-closed to local when cloud-inference off; cloud built only when on); synthesizeGrounded widened MedicalAnswer->{answer,verdict}; AuditEntry.criticVerdict enum (approve|reject-abstained|error-abstained), PHI-free @ 0600. Commit 4cafe66.

---

## Plan: Fleet Manifest Provenance + Recoverable Overwrite (Fleet Phase 4.1)
- Spec: spec-20260618-fleet-manifest-provenance
- Branch: bober/fleet-expand-decomposer
- Created: 2026-06-18
- Sprints: 1
- Status: completed (1/1 sprints)
- Origin: research follow-up to ADR-4 shared-default-path risk (expand + expand-deep clobber the same .bober/fleet-expand.json). ADR-4-preserving mitigation (does NOT change the path).

### Sprint Breakdown
1. [completed] Provenance sidecar + recoverable, informative overwrite -- iter 1 (8/8). new src/fleet/manifest-write.ts (writeManifestWithProvenance: sidecar `${outPath}.meta.json` {command,goal,critique,childCount,timestamp}, move prior manifest to `${outPath}.bak`, informative non-blocking notice, injected clock) wired into both expand + expand-deep write sites in index.ts; FleetManifestSchema untouched. 15 helper tests; .bak preserves prior bytes; missing/corrupt sidecar no-throw. Commit c83c212.

### Pipeline Statistics
- Total iterations used: 1 / 20 (passed iteration 1, zero reworks)
- Sprints completed: 1 / 1
- Subagents spawned: 4 (1 curator, 1 generator, 1 evaluator, 1 documenter)
- Final suite: all fleet suites green (2354 passed; 6 pre-existing unrelated cockpit E2E failures)

---

## Plan: Fleet Critique Loop (fleet expand-deep --critique) (Fleet Phase 4)
- Spec: spec-20260618-fleet-expand-deep-critique
- Architecture: arch-20260618-fleet-expand-deep-critique (ADR-1..5)
- Branch: bober/fleet-expand-decomposer (continues on Phase 2/3 branch it builds on)
- Created: 2026-06-18
- Sprints: 2
- Status: completed (2/2 sprints)

### Sprint Breakdown
1. [completed] Critique engine (critic-deep.ts) + opt-in threading -- iter 1 (8/8). new src/fleet/critic-deep.ts (fresh boolean critic, validateVerdict, runCritiqueLoop accept-best, fail-open getCriticVerdict, constants CRITIQUE_MAX_ROUNDS=1/DEEP_CRITIQUE_MAX_TOTAL_CALLS=8) + additive decomposer-deep.ts threading (critique?, critiqueFeedback?, decomposeGoalDeep routing, 0 deleted lines). 42 tests; critique-absent byte-identical Phase 3. Commit e4f7b6b.
2. [completed] fleet expand-deep --critique CLI flag -- iter 1 (8/8). Additive index.ts: FleetExpandDeepOptions.critique?, .option('--critique'), guarded spread ...(opts.critique?{critique:true}:{}) at the decompose call. No-flag path byte-identical (critique key ABSENT, verified) + command-tree lock (no sibling, fleet expand unchanged). 9 tests. Commit 1c688cd.

### Pipeline Statistics
- Total iterations used: 2 / 20 (both sprints passed iteration 1, zero reworks)
- Sprints completed: 2 / 2
- Subagents spawned: 7 (2 curator, 2 generator, 2 evaluator, 2 documenter)
- Final suite: 188 fleet tests + full suite green (6 pre-existing unrelated cockpit E2E MCP failures); build/typecheck/lint clean -- additive --critique flag on the existing subcommand, threaded via guarded spread; default no-flag path byte-identical to Phase 3 (golden test) + command-tree byte-lock.

---

## Plan: Fleet Robust Decomposition (fleet expand-deep) (Fleet Phase 3)
- Spec: spec-20260618-fleet-expand-deep
- Architecture: arch-20260617-fleet-robust-decomposition (ADR-1..5)
- Branch: bober/fleet-expand-decomposer (continues on the Phase 2 branch it builds on)
- Created: 2026-06-18
- Sprints: 2
- Status: completed (2/2 sprints)

### Sprint Breakdown
1. [completed] Robust two-stage decomposition engine (decomposer-deep.ts) — iter 1 (8/8). NEW sibling src/fleet/decomposer-deep.ts: decomposeGoalDeep() runs a bounded PLAN (transient in-memory Outline {areas:[{name,intent}]}) then EXPAND into a children-only FleetManifest, validated via the IMPORTED (not copied) validateManifest. Constants DEEP_PLAN_MAX_RETRIES=1 / DEEP_EXPAND_MAX_RETRIES=1 / DEEP_MAX_TOTAL_CALLS=4. Both LLM calls jsonObjectMode:true, never responseSchema. validateOutline never throws. 31 collocated tests, ScriptedClient fake, no CLI/network. Phase-2 decomposer/manifest/index byte-locked. Commit 960e287.
2. [completed] fleet expand-deep CLI subcommand — iter 1 (8/8). Additive (zero deleted lines) in src/fleet/index.ts: runFleetExpandDeep mirrors runFleetExpand, differs only in calling decomposeGoalDeep (adapted to DecomposeDeepInput — no maxRetries field, avoids TS2353); registerFleetExpandDeepSubcommand appended after registerFleetExpandSubcommand exposing the same 7 options. Spawn-safe: atomic write precedes the --yes gate; write-and-stop default; --yes sole gate into runFleet. Byte-locked `fleet expand` + `fleet <manifest>` + cli/index.ts untouched. 17 tests; full suite 2294. Commit 5eac55e.

### Pipeline Statistics
- Total iterations used: 2 / 20 (both sprints passed on iteration 1, zero reworks)
- Sprints completed: 2 / 2
- Subagents spawned: 7 (2 curator, 2 generator, 2 evaluator, 2 documenter) — Sprint-2 documenter finalizing
- Final suite: 2294 tests passing | 3 skipped, build + typecheck + lint clean

---

## Plan: Fleet Expand — LLM Goal Decomposer (Fleet Phase 2)
- Spec: spec-20260617-fleet-expand-decomposer
- Architecture: arch-20260617-fleet-orchestrator-phase-2-expand (ADR-1..5)
- Branch: bober/fleet-expand-decomposer (forked from main — Phase 1 already merged there)
- Created: 2026-06-17
- Sprints: 2
- Status: completed (2/2 sprints)

### Sprint Breakdown
1. [completed] FleetDecomposer module — iter 1 (8/8). src/fleet/decomposer.ts: decomposeGoal() turns a goal into a children-only Zod-valid FleetManifest via one DeepSeek jsonObjectMode call + 1 bounded coercion retry + config-key guard; 22 collocated tests with a fake LLMClient (no CLI, no spawn). Phase 1 files untouched. Commit 4c1dc09.
2. [completed] fleet expand subcommand — iter 1 (8/8). src/fleet/index.ts: exported testable runFleetExpand(goal,opts,deps?) + registerFleetExpandSubcommand. Credential fail-fast (createClient first) → decomposeGoal → assemble {rootDir,concurrency,children} → atomic temp+rename write to <root>/.bober/fleet-expand.json (overwrite+notice) → STOP by default; --yes is the SOLE gate into locked runFleet(outPath). `fleet <manifest>` registration byte-identical. 14 tests; full suite 2246. Commit 0edf3d1.

### Pipeline Statistics
- Total iterations used: 2 / 20 (both sprints passed on iteration 1)
- Sprints completed: 2 / 2
- Subagents spawned: 8 (2 curator, 2 generator, 2 evaluator, 1 documenter [Sprint 1] + 1 final documenter pending [Sprint 2])

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

## Plan: Phase 6 — The Medical Team (local-first, code-enforced health/wellness team)
- Spec: spec-20260616-medical-team
- Created: 2026-06-16
- Sprints: 7
- Branch: bober/medical-team
- Status: completed (7/7 sprints) — engineering-complete on branch; shipping gated on external S6.5 counsel review
- Built FROM architecture: arch-20260616-medical-team (12 components, ADR-1..7)
- Dependency satisfied: bober/team-abstraction merged to main (#45, 63e6a33) — the `medical-sop` shape extends the on-main Team/PipelineEngine substrate.
- Clarifications resolved: FULL surface incl. real literature (Q1); MedlinePlus/NIH no-auth source (Q2); Apple Health XML SAX only, registry makes others additive (Q3); team registered + opt-in, both egress axes default false (Q4). User approved assumptions+scope (gate-design-approval).
- RELEASE GATE (non-engineering, out of scope for code): shipping/enabling is blocked on the external S6.5 FFDCA §201(h) counsel review. This plan is engineering-complete-on-a-branch only.

### Sprint Breakdown
1. [completed] Additive pipeline plumbing + medical team registration — iter 1 (8/8). Commit 60215d2. `medical-sop` across PipelineEngineName + both Zod enums + both selector switches (exhaustive never-guard); MedicalSopEngine stub; GuardrailSet type in Team.guardrails slot; buildMedicalTeam + registry. Byte-zero impact on ts|skill|workflow + programming team. +22 tests -> 2232 passing, build+typecheck clean.
2. [completed] Consent gate + append-only audit + disclaimer (Gate 1) — iter 1 (8/8). Commit 4e0286d. Fail-closed ConsentGate (no consent => refuse, 0 downstream calls); AuditLog .bober/medical/audit-<date>.jsonl O_WRONLY|O_APPEND|O_CREAT + chmod(0600), IDs/enums-only (PHI-free verified); versioned DisclaimerComposer footer in both paths; injected timestamps. MedicalSopEngine keeps zero-arg constructor (optional MedicalSopDeps). +48 medical tests -> 2258 passing. NON-BLOCKING CARRY-FORWARD: (a) sc-2-4 downstream spies not yet injected into engine (MedicalSopDeps lacks LLM/numerics slots) — S3 must add the real injection seam (its AC1 needs spy-LLMClient-never-invoked); (b) engine.ts:63 wall-clock fallback for ad-hoc runs — ensure opts.now always passed when real SOP wires in S6.
3. [completed] Red-flag emergency short-circuit (Gate 2, 0 LLM) — iter 1 (8/8). Commit 6fc7c97. Pure/sync RedFlagDetector (cardiac|stroke|anaphylaxis|self-harm|overdose|none, PATTERNSET_VERSION) in src/medical/red-flag.ts (zero imports); real MedicalGuardrails (src/medical/guardrails.ts) replaces S1 allow-only stub; Gate 2 after consent in engine.run; canned 911/988; short-circuit audit (ruleId+rulesetVersion+patternsetVersion, PHI-free); throws on empty. CARRY-FORWARD FIX: MedicalSopDeps gained real llmClient?:LLMClient + numerics? injection slots; new consent-ordering test injects spies (genuine never-called proof). +45 tests -> 2303 passing. NON-BLOCKING CARRY-FORWARDS: (a) original sc-2-4 test still has hollow spies — clean up in S6; (b) advisory red-flag false-negatives ('I want to end it all'->none, 'myocardial infarction'->none) — ADR-2 accepted conservative matching; surface to patternset revision / external S6.5 counsel review.
4. [completed] HealthDataStore + NumericsQueryLayer — iter 1 (8/8). Commit 907bae4. HealthDataStore (src/medical/health-store.ts, better-sqlite3 sync mirroring FactStore; 3 tables observations/labs/kv — accepted, no criterion mandates single-table; INSERT OR IGNORE SHA-256(metric|tStart|source|value), NEW-row count). NumericsQueryLayer (src/medical/numerics.ts, closed 8-primitive whitelist mean|min|max|latest|delta|slope|percentile|zscore + getLabTrend; empty window => {value:null,sampleCount:0} abstain; cross-unit refusal => sampleCount>0; zscore n<2 abstain; NO eval/Function/vm/child_process/execa — verified by grep + genuine guard test). Evaluator independently re-derived all 8 primitives. +35 tests -> 2338 passing. NON-BLOCKING CARRY-FORWARD: numerics.test.ts uses readFileSync (sync fs) — only sync-fs principle violation; convert to node:fs/promises in S6 cleanup.
5. [completed] Apple Health ingestion (SAX streaming) + `bober medical import` — iter 1 (8/8). Commit aa7f9be. Added sax@1.6.0 (isolated to adapter). IngestionNormalizer + adapter registry + StoreObservationSink; AppleHealthAdapter (createReadStream + sax, bounded 1000-row batches, for-await backpressure verified by slow-sink ordering test, no whole-file read); idempotent re-import (newRows 2->0); unknown file throws named error; `bober medical import <file>` wired in cli/index.ts + reports counts. +19 tests -> 2357 passing. NOTE: first generator attempt crashed on a transient API socket error after impl was complete; recovered via a focused lint-fix+commit generator (no logic rework). engine.ts untouched.
6. [completed] EgressGuard + meds-in-FactStore + full SOP wiring — iter 1 (8/8). Commit 4f3ba55. EgressGuard (src/medical/egress.ts, two independent axes cloud-inference + literature-retrieval default false; assertAllowed throws when off; fromConfig via new MedicalSectionSchema). Scoped ESLint no-restricted-imports over src/medical/**/*.ts (forbids undici/got/axios/node-fetch + http/https/net/tls/dgram(+node:) + fetch global) with SINGLE exception src/medical/retrieval/medline-source.ts (reserved for S7 net call; zero network import now). LiteratureRetriever stub returns {disabled} synchronously when off. Medications via FactStore.getActiveFacts('medical','patient','takes-medication') (ADR-7); HealthDataStore schema untouched. Full ordered SOP wired in engine.run (consent->red-flag->numerics->meds->egress->retrieve(disabled=>abstain)->footer->audit->PipelineResult) — evaluator TRACED that gates hard-return before any downstream call. Zero-egress end-to-end (numeric from compute, literature abstains, llmSpy never called). Both carry-forward cleanups DONE (sc-2-4 real spy injection + numerics.test.ts async readFile). +13 tests -> 2370 passing. No regressions; programming team byte-identical.
7. [completed] MedlinePlus grounded retrieval + cited synthesis (opt-in) — iter 1 (8/8). Commit 553f087. Real no-auth MedlinePlus fetch confined to the sanctioned net file src/medical/retrieval/medline-source.ts (assertAllowed FIRST; injectable FetchLike transport; only network file, ESLint boundary holds); retrieve returns disabled|abstain{reason}|grounded{passages}; synthesize single LLMClient.chat call (local Ollama default, injectable) abstains-unless-supported with citations>=1; source failure/model-unavailable => abstain (never fail-open, evaluator structurally proved no uncited-claim escape hatch); cloud-inference independently off (no cloud fallback); recorded fixture + injected fakes => CI fully offline. +22 tests -> 2393 passing. No regressions.

### Final state
- 7/7 sprints passed on iteration 1 (zero reworks). One transient generator API-socket crash on S5 recovered without rework.
- Test suite: 2393 passing, 3 pre-existing skips; build + typecheck clean; lint 0 errors.
- All 5 code-enforced safety guarantees verified by independent evaluators: consent fail-closed (Gate 1), red-flag 0-LLM short-circuit (Gate 2), deterministic numerics (no eval/codegen), zero-egress default (two axes off + scoped ESLint boundary + runtime assertAllowed), and abstain-unless-cited synthesis (fail-closed, no uncited claim).
- Byte-zero impact on ts|skill|workflow + programming team confirmed every sprint.
- RELEASE GATE (non-engineering, NOT a buildable sprint): shipping/enabling the medical team remains blocked on the external S6.5 FFDCA §201(h) counsel/regulatory review. This branch is engineering-complete only; both egress axes default false and first-run consent is fail-closed, so it ships nothing to cloud by default.
- Open carry-forwards (non-blocking, all addressed or accepted): S2 hollow sc-2-4 spies + S4 readFileSync — both FIXED in S6. Advisory red-flag false-negatives ('I want to end it all', 'myocardial infarction' -> none) — ADR-2 accepted conservative matching; SURFACE to the patternset revision / S6.5 counsel review.

### Notes
- Architecture file paths used shorthand: `selector.ts`/`engine.ts` resolve to src/orchestrator/workflow/. selectPipelineEngineForTeam:103 + selectPipelineEngine:51 are the two exhaustive switches; resolveEngineNameForTeam:75 passes medical-sop through verbatim (only 'workflow' is downgraded).
- MedicalSopEngine IMPLEMENTS the PipelineEngine interface (engine.ts:9) — the ADR `extends` is shorthand.
- Reuse-not-rebuild: FactStore bi-temporal (meds), better-sqlite3 single-table convention (HealthDataStore), telemetry no-restricted-imports ESLint pattern (egress boundary), detached-spawn chat contract (ADR-5), provider-agnostic LLMClient + Ollama path.

## Plan: Medical Team — WHOOP Connection + Code-Enforced Refusal Guardrails
- Spec: spec-20260617-medical-whoop-guardrails
- Created: 2026-06-17
- Sprints: 3
- Branch: bober/medical-team
- Status: completed (3/3 sprints) — engineering-complete on branch; shipping still gated on the base medical-team's external S6.5 FFDCA §201(h) counsel review (non-engineering)
- Architecture: arch-20260617-medical-team-whoop-guardrails
- Baseline: 2393 tests (medical-team S7 close-out) -> 2438 after S1 -> 2473 after S2 -> 2484 after S3

### Sprint Breakdown
1. [completed] Code-enforced non-emergency refusal layer — iter 1 (8/8). Commit 2a8ff70. Pure/sync RefusalDetector (src/medical/refusal.ts, zero imports; prescription|specific-dosing|individualized-treatment-plan|none, REFUSAL_PATTERNSET_VERSION='refusal-2026.06.17', fixed REFUSAL_REASONS constants). MedicalGuardrails.evaluate emits {kind:'refuse'} AFTER red-flag short-circuit (emergency precedence). engine.run refuse-dispatch branch: canned MedicalAnswer (shortCircuit:true, abstained:false, citations:[]) + IDs-only event:'refuse' audit (ruleId/rulesetVersion/patternsetVersion, PHI-free) + 0 LLM/numerics/retrieval (spy-proven). +45 tests -> 2438 passing; build/typecheck clean, lint 0 errors. NON-BLOCKING CARRY-FORWARD: sc-1-6/sc-1-7 describe block duplicated in engine.test.ts (~lines 549 & 935, byte-identical, both pass) — low-priority cleanup.
2. [completed] WHOOP egress axis + authenticated transport — iter 1 (7/7). Commit e442cc9. Third 'device-connection' EgressAxis (default false, INDEPENDENT; ternary->exhaustive switch w/ compile-time never-guard; optional 3rd ctor param keeps 2-arg call sites byte-identical); schema.ts deviceConnection z.boolean().default(false). WhoopTokenStore (src/medical/whoop/whoop-token.ts, NO network: env-cred clear-throw + 0600 sidecar passed directly to writeFile + read absent/corrupt/missing=>undefined). WhoopClient (src/medical/whoop/whoop-client.ts, 2nd & ONLY new ESLint-excepted net file: assertAllowed-first in both methods, injectable FetchLike/waiter/nowIso, v2 endpoint routing, cursor pagination, 401->refresh+retry-once+2nd-401-throws, 429->injected waiter(reset*1000)+retry). Zero-egress boundary structurally re-verified (grep clean, exception list = [medline-source, whoop-client] only). +35 tests -> 2473 passing; build/typecheck clean, lint 0 errors. No regressions.
3. [completed] WHOOP sync adapter + CLI — iter 1 (8/8). Commit 7d829a2. WhoopSyncAdapter (src/medical/whoop/whoop-sync.ts, NO network: WHOOP_FIELD_MAP fixed (metric,unit) per field across recovery/sleep/cycle/workout; mapWhoopRecords skips unmapped fields, never guesses; id left UNSET so the store derives content-derived SHA-256, NOT the WHOOP UUID; sync(window,sink) pages WhoopClient following nextCursor and writes via the EXISTING StoreObservationSink.writeBatch per batch). Idempotent resume (re-run newRows===0 via INSERT OR IGNORE). FAIL-CLOSED partial-failure: no try/catch around fetchPage — a mid-pagination throw propagates, committed page-1 rows survive valid, clean re-run reaches full state (evaluator-verified). `bober medical whoop sync [--since <iso>]` (src/cli/commands/medical.ts via testable runWhoopSync() helper mirroring runRunCommand): assertAllowed('device-connection') gate BEFORE any WhoopClient/HTTP construction; clear axis-off / 'set WHOOP_CLIENT_ID/SECRET' / 'authorize first' messages each exit 1 and NEVER throw; default window last 7 days or --since computed at CLI boundary (adapter/store never read the clock); store.close() in finally; event:'ingest' audit (IDs/enums only, PHI-free). +11 tests -> 2484 passing; build/typecheck clean, lint 0 errors. No regressions; IngestionAdapter/ObservationSink/schema unchanged.

### Final state
- 3/3 sprints passed on iteration 1 (zero reworks). 8 subagents per sprint flow (curator+generator+evaluator+documenter).
- Test suite: 2484 passing (2393 base medical-team -> +45 S1 -> +35 S2 -> +11 S3 = +91), 3 pre-existing skips; build + typecheck clean; lint 0 errors (2 pre-existing eval-persist.test.ts warnings, unrelated).
- Closed the production-grade refusal gap: prescription/specific-dosing/individualized-treatment-plan prompts now code-enforced-refused pre-LLM (Gate 2b), red-flag emergency precedence preserved, 0 LLM calls on refuse path (spy-proven).
- WHOOP added behind a THIRD zero-default 'device-connection' egress axis (independent of cloud-inference + literature-retrieval); all HTTP confined to the two sanctioned ESLint-excepted network files (medline-source.ts + whoop-client.ts); refresh token at 0600; Apple Health stays the offline SAX file-import path unchanged.
- All highest-stakes decisions code-enforced & pre-LLM; ingestion fail-closed + idempotent.
- RELEASE GATE (non-engineering, unchanged): shipping/enabling remains blocked on the base medical-team's external S6.5 FFDCA §201(h) counsel review. Both literature/cloud axes AND the new device-connection axis default false; first-run consent fail-closed — ships nothing to cloud or any device endpoint by default.

### Pipeline Statistics
- Total iterations used: 3 / 20
- Sprints completed: 3 / 3
- Subagents spawned: 12 (3 curator, 3 generator, 3 evaluator, 3 documenter [+1 pending S3 docs])

---

## Plan: Fleet Robust Decomposition (`fleet expand-deep`)
- Spec: spec-20260618-fleet-expand-deep
- Created: 2026-06-18
- Sprints: 2
- Mode: greenfield (additive to existing fleet module)
- Status: planned
- Architecture: arch-20260617-fleet-robust-decomposition (Phase 3; extends Phase 1 fleet-orchestrator + Phase 2 fleet-expand)
- Ambiguity: 2/10 — fully specified by the architecture; 3 open questions resolved with user (2 sprints / Approach A only / shared fleet-expand.json default)

### Sprint Breakdown
1. [proposed] Robust two-stage decomposition engine (decomposer-deep.ts) — NEW sibling module: PlanStage -> in-memory Outline, ExpandStage -> children-only manifest via REUSED validateManifest; bounded budget DEEP_MAX_TOTAL_CALLS=4; both calls jsonObjectMode:true (never responseSchema); fully unit-tested with a scripted fake LLMClient, no CLI/IO/network.
2. [proposed] `fleet expand-deep` CLI subcommand — additive runFleetExpandDeep + registerFleetExpandDeepSubcommand mirroring runFleetExpand step-for-step (only swaps decomposeGoal->decomposeGoalDeep); preserves spawn-safety (write-before-spawn, write-and-stop default, --yes sole gate); byte-locked `fleet <manifest>` + `fleet expand` proven unchanged.

### Next
- `/bober-sprint` to execute Sprint 1, or `/bober-run` for the full pipeline. Build forks off main (per fleet-orchestrator-plan memory; branch bober/fleet-expand-decomposer currently holds Phase 2).

---

## Plan: Graph integration compatibility with tokensave serve 6.1.1
- Spec: spec-20260620-graph-tokensave-6-1-compat
- Created: 2026-06-20
- Sprints: 2
- Mode: greenfield (repair of existing src/graph/ integration)
- Status: completed (2/2 sprints) — 2026-06-20
- Ambiguity: 2/10 — root cause debugged & reproduced this session; scope ('Full transport + catalog remap', onboard semantic-search path kept) approved by user
- Origin: discovered while running `/bober-onboard` — the `agent-bober onboard` CLI failed with `tokensave serve handshake timed out`. Onboarding docs were produced via the tokensave MCP-tools fallback; branch tracking (`tokensave branch add bober/medical-team` + `tokensave sync`) done separately.

### Sprint Breakdown
1. [completed] MCP-compliant transport in TokensaveMcpClient — Passed iteration 1 (commit 1441890; 8/8 criteria; full suite 2809 green; real tokensave_status round-trip verified) — spawnAndHandshake() sends an MCP `initialize` request and resolves on its correlated response (then `notifications/initialized`); call() uses the `tools/call` envelope and unwraps result.content[].text; HANDSHAKE_TIMEOUT_MS 1000→5000; breaker/health/correlation/stop preserved. Files: src/graph/mcp-client.ts (+ its test). Fixes the handshake deadlock vs tokensave 6.1.1's passive MCP serve.
2. [completed] Remap GraphClient to the tokensave 6.1.1 tool catalog — Passed iteration 1 (commit 6ed3f77; 7/7 criteria; suite 2814 green; `node dist/cli/index.js onboard` E2E runs the real engine, no handshake timeout, 5 files written). TOOL map now tokensave_* only; 6 methods remapped with raw-6.1.1→stable-type adapters; query() pattern→tool switch; onboard.ts untouched.

### Outcome
- **`agent-bober onboard` is FIXED** — the handshake-timeout bug is gone; the CLI starts the real tokensave 6.1.1 engine and writes the 5 docs. Graph features in `agent-bober run` now also reach a working engine.
- Known limitation (accepted scope option B): onboard output is noisy because onboard.ts keeps its semantic-search path (test fixtures show as hotspots; dist/+docs in architecture-overview; indexedFileCount=0). Deferred "option C" (use tokensave_hotspots/dead_code/circular/module_api directly) would make the docs accurate.
- Pre-existing follow-up: dangling link in README.md:204 / onboard.ts:27 → `.bober/architecture/arch-20260524-port-code-review-graph-architecture.md` (file missing).
- Pipeline: 2 sprints, 2 iterations (0 reworks), 8 subagents (2 curator / 2 generator / 2 evaluator / 2 documenter). Commits: 1441890, f3ffdc2, 6ed3f77 (+ Sprint 2 docs).

## Plan: Codebase Health Remediation
- Spec: spec-20260621-codebase-health-remediation
- Created: 2026-06-21
- Sprints: 3
- Status: completed (3/3 sprints)
- Source research: research-20260621-codebase-health-hotspots-cycles

### Sprint Breakdown
1. [completed] Break critic-deep ↔ decomposer-deep cycle (DI) -- inject runExpandStage into runCritiqueLoop; relocate Outline type to a leaf; critic-deep ends with zero imports from decomposer-deep.
2. [completed] Collapse runSprintCycle 7 params → object -- single RunSprintCycleParams; 1 prod + 5 test call sites; internal-only, zero behavior change.
3. [completed] Remove verified dead-code orphans -- delete stashAndRestore + saveOutline + their barrel lines; leave the 3 false positives untouched.

## Plan: Fix standalone plan to sprint contract materialization
- Spec: spec-20260623-plan-contracts-materialization
- Created: 2026-06-23
- Sprints: 3
- Status: planned
- Trigger: external tester report — `plan --provider openai` wrote .bober/specs/ but no .bober/contracts/, so `sprint` failed with "No sprint contracts found". Materialization lives only inside `run` (pipeline.ts:856-906).

### Sprint Breakdown
1. [proposed] Extract shared deterministic materializeContracts helper -- pull pipeline.ts:861-906 into materializeContracts() called by runTsPipeline; preserve feature-derived content; deterministic zero-padded sprint-<specId>-NN ids; characterization test.
2. [proposed] Embedded-sprint materialization + eager wiring into plan -- prefer valid spec.sprints (safeParse, status→proposed) w/ feature-derived fallback; plan materializes after non-clarification plan; clear stale same-specId contracts; fix next-step hint.
3. [proposed] Scope sprint to the active spec + clarification guard -- filter listContracts by spec.specId; refuse needs-clarification specs; improve empty-contracts message; single-spec flow unchanged.

### Scope notes
- Owner lifted the run-pipeline freeze: run + plan share one helper; run now honors valid embedded spec.sprints (skips per-feature generateContractPrecision LLM calls when present). Protected invariant = feature-derived content parity when no embedded sprints; contract ids legitimately change to deterministic zero-padded form.
- Build required for CLI pickup: npm run build (+ npm run update-all for skill copies).
