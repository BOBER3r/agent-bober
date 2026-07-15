# Bober Progress

Project: agent-bober
Mode: greenfield
Last updated: 2026-07-09 20:29 UTC

---

## Active Run: spec-20260628-telegram-frontend
- Started: 2026-06-30 (via /bober-run telegram-frontend)
- Branch: bober/medical-team
- Status: completed (7/7 sprints) — PLAN COMPLETE
- Spec 9/9 (LAST) of the knowledge-platform plan set. Thin presentation adapter (new src/telegram/) exposing hub/inbox/approve-gate/calendar/medical over a locally-run long-polling Telegram bot. No new domain logic. Deps satisfied (priority-hub, task-inbox, calendar-planner all completed). The knowledge-platform plan set (9 specs) is now fully built.

### Sprint Breakdown
1. [completed] Sprint 1: Long-polling bot transport + user-id whitelist + sendSafe outbound funnel — passed iter-1 (eb680c2); new src/telegram/{whitelist,outbound,bot}.ts + src/cli/commands/telegram.ts. grammy ^1.44.0 = the one permitted new dep (whole spec adds exactly this one), behind a typed TelegramTransport/BotTransport wrapper (imported ONLY in bot.ts). getUpdates long-poll only — no server/webhook. Pure whitelist; denial echoes sender id; env-only creds, missing token exits non-zero naming the var. Single-funnel invariant evaluator-verified. 5/5 required; +20 tests, suite 3603.
2. [completed] Sprint 2: Plain text → zero-friction task inbox capture — passed iter-1 (e936eea); router.ts classify() (command vs text) + handlers/capture.ts (injected InboxCapture sink, defaultCapture imports captureTask from src/hub/task-inbox.ts — title-only, no field prompt). /start→helpReply preserved; '/'-prefixed not captured. 4/4 required; +10 tests, suite 3613.
3. [completed] Sprint 3: Scoped prioritization /today /priority /decide X vs Y — passed iter-1 (54f7d98); router.parseScopeFromCommand (real Scope shapes; /decide splits on /\s+vs\s+/i to exactly 2 trimmed options) + handlers/prioritize.ts (injected HubQuery, title-only render preserving hub order; execa-to-`hub priority`/`hub decide` default so the HUB owns LLM calls — adapter builds NO LLMClient). Ephemeral scope. 4/4 required; +15 tests, suite 3629.
4. [completed] Sprint 4: Inline-keyboard approve/adjust/reject over the disk-marker gate — passed iter-1 (36514ae); keyboard.ts (callback_data codec ≤64B) + handlers/approvals.ts (/pending; callbacks whitelist+pendingExists guarded; Approve/Adjust/Reject write markers BYTE-IDENTICAL to approve/reject CLI — reuses the ONE existing gate; ephemeral chatId-keyed multi-turn state). BotTransport gained sendKeyboard/answerCallback. 5/5 required; +67 tests, suite 3650.
5. [completed] Sprint 5: Document upload → medical ingest, mandatory per-upload opt-in — passed iter-1 (e7a2aa4); handlers/upload.ts (per-upload Yes/No keyboard naming local dest + 'not E2E' warning; download DEFERRED until Yes; Yes→download+execa `medical import` once + count-only reply, temp removed in finally; No/no-confirm ingests nothing; medical guards authoritative in subprocess). §B FUNNEL UNIFICATION (carry-forward fix from S4): outbound.ts sendSafeKeyboard = the single keyboard chokepoint; /pending retrofitted through it. 5/5 required; +17 tests, suite 3667. [recovered from 2 evaluator API drops; fresh evaluator confirmed]
6. [completed] Sprint 6: Streaming progress (in-place edits) + silent scheduled digest — passed iter-1 (0c9fe11); streaming.ts streamProgress (1 sendSafeForEdit + N sendSafeEdit on the SAME id, injected AsyncIterable) + digest.ts sendDigest (sendSafe {silent:true}→disable_notification). outbound.ts gained SendOptions{silent} (optional, callers unchanged) + EditTransport; BotTransport gained sendReturningId/editMessage. NO run/fleet/scheduler logic; live do-bridge wiring left as a documented seam. 4/4 required; +11 tests, suite 3678.
7. [completed] Sprint 7: Multi-LLM "secretary" /fleet view — passed iter-1 (1a9a628); fleet-view.ts pure renderFleetView(bundle) groups .bober/fleet-synthesis.json findings by FactRecord.subject (label+summary+round+confidence+count, header+round from bundle.rounds since FactRecord has none) + handleFleet (whitelist-gated BEFORE injected reader, empty→'no recent fleet run', no throw). SHARED renderer feeds BOTH /fleet AND streamFleetView. TYPE-ONLY imports — compiled JS has ZERO runtime coupling to src/fleet/better-sqlite3 (evaluator-verified). over-long value truncated to one line via sendSafe. 6/6 required; +8 tests, suite 3686.

### Pipeline Statistics
- Iterations used: 7 / 20 (ALL 7 sprints passed iteration 1 — ZERO reworks)
- Sprints completed: 7 / 7 — PLAN COMPLETE
- Subagents spawned: 23 (curator×7, generator×7, evaluator×7 [+2 recovery re-runs in Sprint 5], documenter×7)
- Final suite: 3686 passed (295 files); build + typecheck + lint clean (only 2 pre-existing eval-persist warnings); net +103 tests over the 3583 pre-spec baseline; zero regressions across all 7 sprints
- Net-new src/telegram/ module: whitelist, outbound (sendSafe/sendSafeKeyboard/sendSafeForEdit/sendSafeEdit — the unified control-plane funnel), bot (grammy isolated; BotTransport send/sendKeyboard/answerCallback/downloadDocument/sendReturningId/editMessage), router, keyboard, streaming, digest, fleet-view + handlers/{capture,prioritize,approvals,upload}. CLI `agent-bober telegram` (long-poll getUpdates, env creds, whitelist). Commands: plain-text capture, /today /priority /decide, /pending [Approve][Adjust][Reject], document opt-in, /fleet. EXACTLY ONE new dep (grammy, S1 only). Safety invariants all evaluator-verified: getUpdates-only (no server/webhook), whitelist gates every update+callback, single sendSafe/sendSafeKeyboard control-plane funnel (summaries/titles only — never raw PHI), byte-identical approval markers (reuses existing gate), mandatory per-upload medical opt-in, medical guards authoritative in subprocess, type-only fleet coupling.
- Follow-ups: (a) live do-bridge streaming wiring (sc-6-5 seam at do.ts:~172-180) + live smoke tests (manual sc-N criteria) deferred — need a real bot token; (b) PendingCallbackState keyed by chatId only (group-chat cross-user edge — fine for single-operator posture, bober: marker in code); (c) `npm run update-all` + eventual merge of bober/medical-team.

---

## Active Run: spec-20260628-calendar-planner
- Started: 2026-06-29 (via /bober-run calendar-planner)
- Branch: bober/medical-team
- Status: completed (4/4 sprints) — PLAN COMPLETE
- Spec 7/9 of the knowledge-platform plan set. Deterministic JS slot-fill places ranked hub Findings (dueBy + estDurationMin) into free/busy slots in priority order (LLM never packs), proposes via the existing approve/steer gate, writes via a connector-agnostic interface (.ics local-first + Google MCP). Deps satisfied (priority-hub 5/5, task-inbox 6/6).

### Sprint Breakdown
1. [completed] Sprint 1: Deterministic slot-fill engine + dry-run plan CLI — passed iter-1 (0d141c1); new src/calendar/{types,slotter,finding-source} + src/cli/commands/calendar.ts (registered in cli/index.ts). Local Finding consume-type mirrors hub/finding.ts fields WITHOUT importing src/hub; pure synchronous planSlots (no async/fs/network/LLM, identical input => deep-equal output, exhaustive switch + never guard, mirrors medical/numerics.ts); places findings in INPUT order respecting dueBy/estDurationMin, unscheduled list carries reason ('does-not-fit'|'no-free-slot-before-dueBy'). `bober calendar plan --dry-run --findings <f.json> --freebusy <f.json>` exits 0, prints plan, writes NOTHING. +28 tests, full suite 3428 green, build/typecheck/lint clean. 6/6 required criteria evaluator-verified.
2. [completed] Sprint 2: Connector interface + .ics export (local-first, zero-egress) — passed iter-1 (0481407); new src/calendar/connector.ts (CalendarConnector { name, readFreeBusy, writeEvents } + WriteResult) + src/calendar/ics-connector.ts (zero-egress RFC 5545 .ics writer: BEGIN:VCALENDAR/VERSION:2.0/PRODID, one VEVENT per item w/ UID/DTSTAMP/DTSTART/DTEND in UTC YYYYMMDDTHHMMSSZ + escaped SUMMARY, CRLF, node:fs/promises writeFile). `bober calendar plan --export-ics <path>` slots + writes the .ics via an injected makeConnector dep; --dry-run path byte-behaviorally unchanged. CRITICAL: writeFile lives ONLY in ics-connector.ts — calendar.ts still imports no writeFile/writeJson/appendFile (Sprint-1 source-scan guard held). Round-trip DTSTART/DTEND/SUMMARY verified; no http/https/fetch/external-client. slotter.ts UNTOUCHED. +10 tests, full suite 3438 green, build/typecheck/lint clean. 6/6 required criteria evaluator-verified.
3. [completed] Sprint 3: Google Calendar MCP connector (egress-gated) + safe-title privacy — passed iter-1 (123c7c4); new src/calendar/{calendar-egress,calendar-token,google-connector}.ts + docs/calendar.md + additive `calendar` config section in src/config/schema.ts (CalendarSectionSchema .optional(): egress.cloudCalendar default FALSE, connector 'ics'|'google' default 'ics', timezone?; createDefaultConfig untouched, existing config byte-identical). FOUR security invariants evaluator-verified: (1) CalendarEgressGuard.assertCloudCalendarAllowed() is the FIRST action in readFreeBusy + writeEvents — axis-off throws naming calendar.egress.cloudCalendar, ZERO adapter listTools/callTool calls (refuse-before-client); (2) SAFE-TITLE: event summary = safeTitleById.get(findingId) ?? item.calendarSafeTitle ?? 'Focus block', NEVER PlanItem.title (which slotter sets to full finding.title) — payload excludes evidence/full-title/tags; threaded via findings map + ADDITIVE optional PlanItem.calendarSafeTitle (slotter populates it, Sprint 1/2 tests still green); (3) sanitizeCalendarError redacts KEY=VALUE (matches external-client.ts:69), injected token absent from thrown msg; (4) 0600 CalendarTokenStore sidecar + module-doc/docs caveat: hosted OAuth UNFIT for unattended/cron, recommends .ics fallback. Stub GoogleCalendarToolAdapter (no live OAuth in CI); both connectors interchangeable behind CalendarConnector. +82 tests, full suite 3482 green, build/typecheck/lint clean. 6/6 required criteria evaluator-verified.
4. [completed] Sprint 4: Approve-gate propose -> /approve|/tell -> write events — passed iter-1 (f30c769); new src/calendar/proposal-gate.ts (proposePlan/applyPlan/adjustPlan) + live `bober calendar plan` (propose) + `bober calendar apply <checkpointId>` CLI. REUSES src/state/approval-state.ts (savePending/saveApproved/saveRejected/readPending/deletePending) — NO new approval mechanism. CORE SAFETY INVARIANT evaluator-verified: proposePlan has NO connector parameter so writeEvents is structurally impossible before approval — it writes a .pending.json marker + a plan sidecar (.bober/calendar/<id>.plan.json, since PendingMarker.artifact can't hold PlanItems) and prints checkpointId=`calendar-<id>` + how to `bober approve <id>`/`/approve <id>`; applyPlan detects approved/rejected markers INLINE via readdir (no readApproved/readRejected export exists — mirrors promote.ts/approve.ts), calls connector.writeEvents EXACTLY ONCE on approval then deletePending, NEVER on reject; adjustPlan is a PURE synchronous planSlots re-run with a ConstraintDelta (excludeInterval appended to busy[] / window shift), writes nothing, no input mutation; NO auto-approve in any mode (apply READS approval, never creates it); Google apply still egress-gated. ALL fs writes live in proposal-gate.ts — calendar.ts still imports no writeFile/writeJson/appendFile (Sprint-1 source-scan held). +15 tests, full suite 3497 green, build/typecheck/lint clean. 6/6 required criteria evaluator-verified.

### Pipeline Statistics
- Iterations used: 4 / 20 (ALL 4 sprints passed iteration 1 — ZERO reworks)
- Sprints completed: 4 / 4 — PLAN COMPLETE
- Subagents spawned: 16 (curator×4, generator×4, evaluator×4, documenter×4) — all complete
- Final suite: 3497 passed (276 files); build + typecheck + lint clean; net +97 tests over the 3400 pre-spec baseline; zero regressions across all 4 sprints
- Net-new src/calendar/ module: types, slotter (pure deterministic), finding-source, connector (interface), ics-connector (zero-egress RFC 5545), google-connector (egress-gated, safe-title-only), calendar-egress, calendar-token (0600 sidecar), proposal-gate (approve-gate). Additive `calendar` config section (egress.cloudCalendar default false, connector 'ics'|'google' default 'ics'). CLI `bober calendar plan [--dry-run|--export-ics <path>] [--findings <f>] [--freebusy <f>]` + `bober calendar apply <checkpointId>`. docs/calendar.md + COMMANDS.md + README + docs/sprints index. Slotter byte-purity + safe-title privacy + egress-fail-closed + approve-before-write all evaluator-verified in source.

---

## Active Run: spec-20260628-do-bridge
- Started: 2026-06-29 (via /bober-run do-bridge)
- Branch: bober/medical-team
- Status: completed (3/3 sprints) — PLAN COMPLETE
- Spec 6/9 of the knowledge-platform plan set. Promotes a hub Finding/task into real coding work: Finding -> approve gate -> detached `agent-bober run` (runPipeline) via an extensible promoter registry, then reconciles the run outcome back onto the Finding. Additive under new src/do-bridge/; consumes task-inbox + priority-hub through a FindingStore port. Deps satisfied (task-inbox 6/6, priority-hub 5/5).
- ORCHESTRATOR DECISION (Sprint 2): hub FindingSchema types promotesTo as z.string().optional() and forbids redefining Finding; do-bridge is additive-only (Finding schema owned by priority-hub). Resolved by SERIALIZING the structured PromotionRef {kind,runId,launchedAt,status} into the existing promotesTo string field via do-bridge-owned serialize/parse helpers + a DoFinding view type — hub schema stays byte-unchanged ALL 3 SPRINTS. NOT by widening the shared schema.

### Sprint Breakdown
1. [completed] Sprint 1: Promoter registry, FindingStore port, and `bober do --dry-run` — passed iter-1 (8370612); new src/do-bridge/{types,registry,finding-port,coding-promoter} + src/cli/commands/do.ts (registered in cli/index.ts, only permitted core edit); PromoterRegistry resolve precedence domain+kind>domain-only>undefined; FactStore-backed FindingStore adapter + in-memory fake; coding promoter (coding|projects -> PromotionPlan {kind:'bober-run',task,teamId?}); dry-run prints planned task + zero writes, NO execa/child_process/approvals reached; +32 tests, hub/task 134 regression green, build/lint clean. Docs 2ce98f3
2. [completed] Sprint 2: Gate the promotion through the approve marker and launch real work — passed iter-1 (cf33acb); new src/do-bridge/{launcher,promote} + structured PromotionRef + serialize/parse helpers (types.ts) + DoFinding view + setPromotion on FindingStore (both adapters); runPromotionGate writes promote-<id> pending marker via approval-state.ts, gates --yes/TTY-confirm/non-TTY-poll (mirrors disk.ts), approve->launch-once via INJECTED RunSpawnerLauncher->setPromotion(in-progress + promotesTo launched), reject->zero launch/zero writes/pending removed; checkpointId 'promote-<id>' aligns with `bober approve`; hub/finding.ts BYTE-UNCHANGED; +26 tests (58 do-bridge total), 334 regression (hub/task/chat) green, build/lint clean
3. [completed] Sprint 3: Reconcile promotion outcome to done and prove registry extensibility — passed iter-1 (f430fd1); new src/do-bridge/reconcile.ts (reconcilePromotions DI core + reconcilePromotionsForRoot wrapper) + additive listPromoted()/applyOutcome() on FindingStore (both adapters); maps run-state snapshot -> completed->done(supersede)+promotesTo.status=completed / aborted|failed->open+aborted / running|missing->unchanged; best-effort NEVER-throws (null run-state = still-running), NO poll/block; `bober do --reconcile` flag + start-of-command best-effort reconcile (mirrors seedProjectFacts pipeline.ts:981); SECOND non-functional stub promoter {projects,action} proves register() extensibility, unregistered (domain,kind) fails closed; docs/do-bridge.md (208 lines, names register() call site + Promoter interface). hub/finding.ts BYTE-UNCHANGED; +18 do-bridge tests (76 total), FULL SUITE 3400 green, build/lint clean. POST-SPRINT FOLLOW-UP RESOLVED (cf21faf): unsupported-promoter error now names the full (domain,kind) pair (`do: unsupported (<domain>, <kind>) — no promoter registered for this domain+kind`); sc-1-5 test strengthened to assert the kind; build/lint clean, 76 do-bridge tests green.

### Pipeline Statistics
- Iterations used: 3 / 20 (ALL 3 sprints passed iteration 1 — ZERO reworks)
- Sprints completed: 3 / 3 — PLAN COMPLETE
- Subagents spawned: 11 (curator×3, generator×3, evaluator×3, documenter×2 [S3 docs pending])
- Final suite: 3400 passed (267 files); build + lint clean; hub FindingSchema byte-unchanged all 3 sprints (PromotionRef serialized into existing promotesTo string field)
- Net-new src/do-bridge/ module: types, registry, finding-port (FactStore adapter + in-memory fake), coding-promoter, launcher (RunSpawner-backed, injected), promote (approve-gate), reconcile; CLI `bober do [findingId] [--dry-run] [--yes] [--reconcile]`. docs/do-bridge.md + COMMANDS.md + README.md. Reuses approval-state.ts markers (no new format); detached launch via RunSpawner; outcome=supersede.

---

## Active Run: spec-20260628-medical-analysis
- Started: 2026-06-28 (via /bober-run)
- Branch: bober/medical-team
- Status: completed (5/5 sprints) — PLAN COMPLETE
- Spec 3/9 of the knowledge-platform plan set. Proactive + reactive medical insights + 4-lens recommendation judge-loop (contraindication VETO, fail-closed, red-flag-first). Additive under src/medical/{analysis,recommend,research}; MedicalSopEngine (engine.ts) byte-unchanged every sprint.

### Sprint Breakdown
1. [completed] Sprint 1: Proactive trend Findings + vault writer + Dataview dashboard + review pass — passed iter-1 (307e5e7); new src/medical/analysis/ (finding/finding-writer/trends/review-pass), now-free SHA-256 findingId, analyzeTrends reuses NumericsQueryLayer.getLabTrend, HealthDataStore.listBiomarkers(), config.medical.vaultDir, `bober medical review`; +43 tests, suite 3029; docs f819140
2. [completed] Sprint 2: Recommendation judge-loop core (4-lens panel, contraindication VETO, fail-closed) — passed iter-1 (fb467c6); PURE injectable src/medical/recommend/{types,lenses,judge-panel}; fail-closed inversion (mirrors grounding-critic.ts:206, inverts critic-deep.ts), absolute contraindication veto checked before vote, red-flag-first, MEDICAL_PANEL_MAX_TOTAL_CALLS=27; +43 tests, suite 3072; docs 542b134
3. [completed] Sprint 3: Recommendation generation end-to-end + `bober medical recommend` CLI — passed iter-1 (3b2abb9); src/medical/recommend/{context,urgency,recommend}; egress-gated tier-diverse lenses ON / all-local fail-closed OFF (no cloud client built — sc-3-5), accepted action Finding NO refer-out hedging + LLM urgency/severity/confidence, no-consensus question Finding w/ dissent, red-flag escalation; +25 tests, suite 3097; docs 367122b
4. [completed] Sprint 4: Test-gap cadence + cross-marker dig-deeper offers — passed iter-1 (92a0481); src/medical/analysis/{cadence,cross-marker}; CLOSED RECOMMENDED_CADENCE_DAYS (unknown skipped), zero-LLM cross-marker OFFER persists pair in tags[], one-pass trend+gap+offer (distinct ruleKeys, sc-1-4 idempotency preserved), `--dig-deeper <id>` delegates to sprint-3 generateRecommendation; +17 tests, suite 3114; docs 1c41eaa. NON-BLOCKING FOLLOW-UP: sc-4-4 llmSpy in cross-marker.test.ts is disconnected/tautological (no LLM injection point) — zero-LLM guarantee holds by source/grep, not that spy; test-hygiene cleanup candidate
5. [completed] Sprint 5: Online research-latest-findings + vault notes (egress-gated) — passed iter-1 (07b0fb9); src/medical/research/{research-note,online-research}; runResearchJob axis-gate-FIRST {disabled:true} before any MedlineSource construction (zero egress), critic-abstain skips clinical note, synthesis fail-closes local via buildMedicalInferenceClient, flattened citation frontmatter (source medlineplus), `bober medical research`; importable schedulable entrypoint for spec-20260628-research-scheduler; +28 tests, suite 3142

### Pipeline Statistics
- Iterations used: 5 / 20 (ALL 5 sprints passed iteration 1 — ZERO reworks)
- Sprints completed: 5 / 5 — PLAN COMPLETE
- Subagents spawned: 24 (curator×5, generator×5, evaluator×5, documenter×4 [S5 docs pending])
- Final suite: 3142 passed (246 files), up from 2975 baseline (+167); build + typecheck + lint clean
- Net-new src/medical/ modules: analysis/ (finding, finding-writer, trends, cadence, cross-marker, review-pass), recommend/ (types, lenses, judge-panel, context, urgency, recommend), research/ (research-note, online-research); CLI: medical review [--dig-deeper] / recommend / research. engine.ts byte-unchanged all 5 sprints; zero-egress posture preserved (cloud-inference + literature-retrieval axes default false, fail-closed local model + no-op research when off); audit IDs/enums-only.

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
- Status: completed (10/10 sprints)
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
- Status: completed (3/3 sprints)
- Trigger: external tester report — `plan --provider openai` wrote .bober/specs/ but no .bober/contracts/, so `sprint` failed with "No sprint contracts found". Materialization lives only inside `run` (pipeline.ts:856-906).

### Sprint Breakdown
1. [completed] Extract shared deterministic materializeContracts helper -- pull pipeline.ts:861-906 into materializeContracts() called by runTsPipeline; preserve feature-derived content; deterministic zero-padded sprint-<specId>-NN ids; characterization test.
2. [completed] Embedded-sprint materialization + eager wiring into plan -- prefer valid spec.sprints (safeParse, status→proposed) w/ feature-derived fallback; plan materializes after non-clarification plan; clear stale same-specId contracts; fix next-step hint.
3. [completed] Scope sprint to the active spec + clarification guard -- filter listContracts by spec.specId; refuse needs-clarification specs; improve empty-contracts message; single-spec flow unchanged.

### Scope notes
- Owner lifted the run-pipeline freeze: run + plan share one helper; run now honors valid embedded spec.sprints (skips per-feature generateContractPrecision LLM calls when present). Protected invariant = feature-derived content parity when no embedded sprints; contract ids legitimately change to deterministic zero-padded form.
- Build required for CLI pickup: npm run build (+ npm run update-all for skill copies).

## Plan Set: Interconnected AI Knowledge Platform (9 specs)
- Created: 2026-06-28
- Source design: `.bober/research/research-20260627-knowledge-platform-landscape.md`
- Planned by: 9-agent bober-planner team (one part each), autonomous gate (cited evidence)
- Total: 9 specs / 44 sprints — all status=draft (ready)
- Scope decisions: Hybrid storage (medical/financial local-first) · shared git repos · Obsidian vault = storage + v1 UI (vault-canonical, FactStore = derived index) · medical = first end-to-end domain template · financial parked for a later /bober-research (Plaid)

### Specs (sprint count · dependsOn)
1. spec-20260628-obsidian-vault-store (5) — [] — vault note model + derived FactStore index + `vault reindex` + Obsidian MCP adapter + SOPS hook
2. spec-20260628-medical-ingest (5) — [vault-store] — lab-PDF→frontmatter note + supplements + profile.yaml (SOPS)
3. spec-20260628-medical-analysis (5) — [medical-ingest] — proactive+reactive insights + 4-lens recommendation judge-loop (contraindication VETO, fail-closed, red-flag-first)
4. spec-20260628-priority-hub (5) — [vault-store, medical-analysis] — OWNS Finding schema + cross-repo collector + query-scoped two-pass judge → priority.md
5. spec-20260628-task-inbox (6) — [priority-hub] — zero-friction capture + lifecycle + snooze + Gmail→task
6. spec-20260628-do-bridge (3) — [task-inbox, priority-hub] — promoter registry; coding task→`bober run` via approval gate
7. spec-20260628-calendar-planner (4) — [priority-hub, task-inbox] — deterministic slotter + Google MCP/.ics + approve-gate + calendarSafeTitle
8. spec-20260628-telegram-frontend (7) — [priority-hub, task-inbox, calendar-planner] — long-poll bot + whitelist + command map + inline approve + upload opt-in; control-plane-only privacy + Sprint 7 multi-LLM "secretary" /fleet view (v2 enrichment)
9. spec-20260628-research-scheduler (5) — [priority-hub] — recurring multi-model research jobs + new online-research egress axis + digest

### Build order (topological)
vault-store → medical-ingest → medical-analysis → priority-hub → task-inbox → {do-bridge · calendar-planner · research-scheduler} → telegram-frontend

### Notes
- Cross-spec contract: priority-hub OWNS the Finding schema; siblings consume it. urgency/severity/dueBy are optional/nullable so inbox capture never blocks (verified present in hub spec).
- Each spec is independently runnable in dependency order via /bober-run or /bober-sprint.
- 2026-06-28: telegram-frontend ENRICHED to v2 (now 7 sprints). Added feat-9 "secretary" multi-LLM view + Sprint 7 (/fleet command + per-agent streaming sections, reads .bober/fleet-synthesis.json, groups by FactRecord.subject). Validated topology = Tier 1 (Telegram presents the existing fleet blackboard; it is NOT a second coordination bus). Tier 2 (per-LLM bot identities via Bot API 10.0 bot-to-bot) and Tier 3 (Secretary Mode) deliberately deferred to sibling specs. Evidence: .bober/research/research-20260628-telegram-features-and-topology.md + research-20260628-telegram-multi-llm-coordination-research.md.

---

## Active Run: spec-20260628-obsidian-vault-store
- Started: 2026-06-28 (via /bober-run)
- Branch: bober/medical-team
- Last updated: 2026-06-28T18:12:30Z
- Status: completed (5/5 sprints)

### Sprint Breakdown
1. [completed] Sprint 1: Vault note model + frontmatter round-trip I/O — passed iter-1 (e576e77); 18 new tests, suite 2849
2. [completed] Sprint 2: Derived FactStore index over note frontmatter (reconcile-at-ingest) — passed iter-1 (01d17b4); +20 tests, suite 2869
3. [completed] Sprint 3: `bober vault reindex` CLI command — passed iter-1 (82ebc23); +3 tests, suite 2872; path-parity w/ facts CLI confirmed
4. [completed] Sprint 4: On-device Obsidian MCP read/write adapter + config — passed iter-2 (4f5288d + lint-fix 0185daf); +36 tests, suite 2907; iter-1 failed only on lint hard-gate (unused import)
5. [completed] Sprint 5: Vault profile.yaml hook + Dataview/attachments conventions — passed iter-1 (bb95d3b); +4 tests, suite 2911; incl SUPERSEDED_STATUS convergence into conventions.ts (eval run directly by orchestrator — subagent session limit)

### Pipeline Statistics
- Iterations used: 6 / 20
- Sprints completed: 5 / 5 — PLAN COMPLETE
- Subagents spawned: 16 (curator×5, generator×6, evaluator×5) + documenter×3
- Pending follow-up: docs for sprints 4 & 5 (documenter spawns hit a classifier/session limit; non-fatal)

---

## Active Run: spec-20260628-medical-ingest
- Started: 2026-06-28 (via /bober-run)
- Branch: bober/medical-team
- Status: completed (5/5 sprints) — PLAN COMPLETE
- Spec 2/9 of the knowledge-platform plan set. Lab-PDF→frontmatter notes + derived HealthDataStore index + supplements→FactStore + SOPS profile.yaml. No hard import of the sibling vault-store module (build-independent).

### Sprint Breakdown
1. [completed] Sprint 1: Lab-PDF -> structured JSON parser (Claude document block, egress-gated) — passed iter-1 (be98982); ParsedLabReport Zod schemas + additive Anthropic-only ChatParams.documents + parseLabPdf(); +10 tests, suite 2921
2. [completed] Sprint 2: Lab-note vault writer + derived HealthDataStore reindex + ingest dedup — passed iter-1 (181f30c); hand-rolled frontmatter (no YAML dep, no vault import), deterministic deriveLabStatus + labResultId dedup; +33 tests, suite 2944
3. [completed] Sprint 3: bober medical import-labs <pdf> end-to-end command (fail-closed + audit + dedup) — passed iter-1 (cd4a2ea); runImportLabs fail-closed cloud-inference gate (exit 1 before any PDF read/client build), IDs/enums-only audit, ingest dedup; +3 tests, suite 2947
4. [completed] Sprint 4: Supplements markdown-frontmatter list -> FactStore + supplements CLI — passed iter-1 (90842ec); deterministic no-judge reconcile (scope medical/subject name/predicate dose), re-add NOOP keeps count 1; supplements add|list nested under medical; +15 tests, suite 2962
5. [completed] Sprint 5: Personalization profile.yaml (SOPS-encrypted, injectable cipher) + profile CLI — passed iter-1 (9895965); Zod ProfileSchema + injectable ProfileCipher seam (default sops/execa) + writeProfile/readProfile fail-closed (available() before serialize/write -> no plaintext PHI on disk) + profile show|set under medical; +13 tests, suite 2975

### Pipeline Statistics
- Iterations used: 5 / 20 (all 5 sprints passed iteration 1 — zero reworks)
- Sprints completed: 5 / 5 — PLAN COMPLETE
- Subagents spawned: 20 (curator×5, generator×5, evaluator×5, documenter×5)
- Final suite: 2975 passed (233 files), up from 2911 baseline (+64); build + typecheck clean, lint 0 errors
- Net-new src/medical/ modules: lab-types, lab-pdf-parser, lab-note, lab-reindex, supplements, profile; provider ChatParams.documents (Anthropic-only, additive); import-labs + supplements + profile subcommands under medical. No hard import of the sibling vault-store module (build-independent). Zero-egress posture preserved: lab parse fail-closed behind cloud-inference axis; profile SOPS fail-closed (no plaintext PHI); audit IDs/enums-only.

---

## Active Run: spec-20260628-priority-hub
- Started: 2026-06-28 (via /bober-run)
- Branch: bober/medical-team
- Status: completed (5/5 sprints) — PLAN COMPLETE
- Spec 4/9 of the knowledge-platform plan set. New src/hub/ module: OWNS the canonical cross-domain Finding Zod schema; cross-repo read-only collector over sibling kb-* FactStores; query-scoped two-pass prioritization judge; priority.md renderer; `bober hub` + `bober chat hub` surfaces. Deps [vault-store, medical-analysis] both satisfied. Only permitted edit to an existing core file = additive FactStore { readonly } flag (default byte-identical).

### Sprint Breakdown
1. [completed] Sprint 1: Canonical Finding schema, FactStoreFindingSource, `bober hub list` — passed iter-1 (2bb3b95); src/hub/finding.ts (single Zod FindingSchema, locked field set) + finding-source.ts (FactStoreFindingSource, predicate-'finding', JSON.parse+safeParse skip-on-fail, HUB_SCOPE='hub') + hub.ts (runHubList DI core) + index.ts registration; +21 tests
2. [completed] Sprint 2: Cross-repo read-only collector with sibling resolution and dedup — passed iter-1 (708c799); additive FactStore { readonly } flag (no-flag path byte-identical, WAL/busy_timeout preserved) + repo-resolver.ts (resolveSiblingRepos: configured→absolute else kb-* discovery, non-existent skipped) + collector.ts (collectFindings, pure/readonly, dedup by Finding.id keep-first) + hub.ts list aggregates across siblings (raw-JSON hub.repos read, NO schema.ts edit); +36 tests, full suite 3178
3. [completed] Sprint 3: Query scope parsing and two-pass prioritization judge — passed iter-1 (01af871); scope.ts (Scope union + parseScope + pure applyFilter) + lenses.ts (HUB_LENS_CATALOG urgency/impact/effort/deadline-risk + RelevanceVerdict/LensScore Zod schemas + four-tier extractJson defensive validators) + judge.ts (rankFindings two-pass: pass1 relevance [decision drops 'neither'], pass2 lens fan-out strict-majority FAIL-CLOSED-ON-TIE → keep+tag 'flagged-for-review' on tags-copy, deterministic sort aggregate/urgency/severity/dueBy[undef-last]/id); injected LLMClient (zero SDK import), filtered=0 LLM calls; +38 tests (scope 22, judge 16). NB: first generator attempt was infra-interrupted (API connection closed) after scope+lenses landed; continuation generator finished judge.ts and committed the whole sprint
4. [completed] Sprint 4: priority.md renderer and `bober hub priority` / `bober hub decide` — passed iter-1 (d82a27f); priority-md.ts (PURE renderPriorityMd: hand-rolled YAML frontmatter [no yaml dep] + 7-col Dataview table rank|title|domain|kind|urgency|severity|dueBy + per-finding rationale, no re-rank, pipe-escaped) + hub-config.ts (resolveOutVault: raw-JSON hub.outVault else <parent>/kb-hub ABSOLUTE) + hub.ts runHubPriority DI core (injected LLMClient+outVault; missing-vault gate → stderr + exitCode=1, no throw) + priority/decide commander subcommands wiring collect→scope→judge→render→write; +18 tests, sibling sources unchanged, no new deps
5. [completed] Sprint 5: `bober chat hub` surface with scoped /priority and /decide — passed iter-1 (45d3c17); 'hub' team registered as data inline in loadTeam (memoryNamespace 'hub', no guardrails, no new deps); /priority + /decide added as the LAST two optional dispatch params + gated handleHubPriority/handleHubDecide on ChatSession (this.memoryNamespace==='hub' only; non-hub = informative no-op, zero LLM call) delegating to collectFindings→rankFindings(this.llm)→renderPriorityMd; HELP_TEXT BYTE-IDENTICAL (new cmds not advertised in /help to keep existing-command output unchanged per sc-5-4); +~25 tests, full suite 3264

### Pipeline Statistics
- Iterations used: 5 / 20 (all 5 sprints passed iteration 1 — zero evaluator reworks; Sprint 3 generator phase resumed once after an infra interruption)
- Sprints completed: 5 / 5 — PLAN COMPLETE
- Subagents spawned: 16 (curator×5, generator×6 [Sprint 3 had a continuation], evaluator×5) + documenter×4 (Sprint 5 doc pending)
- Final suite: 3264 passed (255 files); build + typecheck clean, lint 0 errors
- Net-new src/hub/ module: finding (canonical Zod FindingSchema, single owner) · finding-source (FactStoreFindingSource, HUB_SCOPE) · collector (cross-repo read-only collectFindings, dedup-by-id) · repo-resolver (kb-* sibling resolution) · scope (Scope union + pure applyFilter) · lenses (hub prioritization lens catalog + defensive validators) · judge (rankFindings two-pass, LLM-scores/JS-arranges, fail-closed-on-tie flagged-for-review) · priority-md (pure Dataview renderer) · hub-config (outVault resolution). CLI: `bober hub list|priority|decide` + `bober chat hub` with /priority //decide. Single existing-core edit = additive FactStore { readonly } flag (default byte-identical). No new runtime deps; no schema.ts edit (raw-JSON hub.repos/hub.outVault reads). Cross-spec: hub now OWNS the Finding schema for sibling kb-* specs to consume.

---

## Active Run: spec-20260628-task-inbox
- Started: 2026-06-29 (via /bober-run)
- Branch: bober/medical-team
- Status: completed (6/6 sprints) — PLAN COMPLETE
- Spec 5/9 of the knowledge-platform plan set. Zero-friction task capture as Findings in the unified hub pool (scope='hub'/predicate='finding'/subject=id/value=JSON), open→in-progress→snoozed→done/dropped lifecycle via the bi-temporal FactStore reconcile UPDATE path, AUTO-finding ingest seam, Gmail→task bridge (egress-gated). Dep [priority-hub] satisfied — IMPORTS its Finding schema (src/hub/finding.ts), never redefines it. Curator caught: domain/urgency/severity are REQUIRED → capture uses neutral defaults (inbox/3/1), the spec's never-block fallback.

### Sprint Breakdown
1. [completed] Sprint 1: Zero-friction task capture (persistence helper + `bober task add`) — passed iter-1 (0e39c15); src/hub/finding-store.ts (writeFinding via writeFact / readFindings, HUB_SCOPE reuse) + task-inbox.ts (captureTask, sha256 id, now-injected) + cli/commands/task.ts (registerTaskCommand: task add, never-throws, exitCode=1) wired in cli/index.ts; FindingSchema imported (Finding type-only); +17 tests, suite 3264→3281, zero regressions. Docs 4e0f4a7 (COMMANDS.md Task Inbox section + README)
2. [completed] Sprint 2: Task listing + lifecycle transitions (start / done / drop) — passed iter-2 (5e2bc2f + lint-fix 26f45db); transitionFinding(store,id,newStatus,{now,mutate?}) PURE in finding-store.ts routes through writeFinding->writeFact UPDATE (supersede+insert, history preserved); cli task list (default ACTIVE_STATUSES=[open,in-progress], --all/--status) + start/done/drop (drop=supersede not DELETE); runTaskList/runTaskTransition DI cores, never-throw on missing id. sc-2-2 reads superseded open row via factId+getFact. +10 tests (3 finding-store + 7 task; generator report's "+27" was an overcount — documenter corrected), suite 3281→3291. iter-1 FAILED only on a new lint error (unused var task2 in task.test.ts:132 — zero-lint hard gate); iter-2 added expect(output).toContain(task2.id) clearing it + strengthening sc-2-3. Docs 2c861a2 (COMMANDS.md list/lifecycle + README). NB non-blocking: `task list --status <s>` does not validate s (unknown → "No tasks found"), intentional
3. [completed] Sprint 3: Snooze with wake semantics — passed iter-1 (2b5c3c9); finding-store.ts SNOOZE_TAG_PREFIX + snoozeUntil() + PURE isVisibleInDefaultList(finding,now) (visible if open/in-progress OR snoozed&wake<=now); task.ts runTaskList gained now-param, task snooze --until (parse->toISOString at boundary, NaN->exitCode=1 no throw, re-snooze strips+appends tag, terminal blocked). NO schema change (wake in tags[]). +6 tests, suite 3291→3297, zero regressions; lint 0 errors. Evaluator confirmed lexicographic ISO compare safe (--until normalized via toISOString before storage)
4. [completed] Sprint 4: Domain finding intake (pool ingest + dedup) — passed iter-1 (5c77a49); finding-store.ts ingestFinding(store,input,{now}) validates IngestInputSchema=FindingSchema.partial({id,surfacedAt}) then re-validates assembled obj via FULL FindingSchema before writeFinding (schema NOT bypassed, no-write-on-reject); deriveFindingId 16-char sha256 of domain|title|kind => dedup one active row on re-ingest; returns ReconcileAction. task.ts runTaskIngest + `task ingest [file]` (file via node:fs/promises or stdin async-iter, never-throws exitCode=1). +6 tests, suite 3297→3303, zero regressions; lint 0 errors. All invariants source-verified
5. [completed] Sprint 5: Chat intent-detection capture — passed iter-1 (3846c50); turn-classifier.ts ADDITIVE {action:capture-task, task} union member+zod option+parse branch+2 system-prompt lines (capture-task option & scope/decision-statement->answer rule); FALLBACK={action:answer} byte-identical, existing actions untouched. chat-session.ts capture-task dispatch + handleCaptureTask (now@boundary, FactStore open->captureTask reuse->close, "Captured task:" confirmation, NO Answerer call). sc-5-4 OnceClient throw-on-2nd-LLM-call proves Answerer not invoked + 1 open action finding persisted. +6 tests, suite 3303→3309, zero regressions; lint 0 errors
6. [completed] Sprint 6: Gmail thread to task (egress-gated bonus) — passed iter-1 (55d6878); new isolated taskInbox.gmailEgress Zod config (default false, optional — existing configs parse, medical EgressGuard untouched); src/hub/gmail-to-task.ts (pure parseGmailThread subject->title; sanitizeConnectorError identical regex to external-client.ts:69; fromGmailTask REFUSES before any MCP construction when egress off). task.ts from-gmail subcommand fail-closed (axis off => opt-in refusal + exitCode=1 + ZERO network; on => read thread -> parse -> captureTask). sc-6-2 callTool spy never called when off; sc-6-4 token never leaks. captureTask sole write path. +15 tests, suite 3309→3324, zero regressions; lint 0 errors. Security props independently evaluator-verified

### Pipeline Statistics
- Iterations used: 7 / 20 (S1 i1; S2 i1-fail+i2-pass; S3 i1; S4 i1; S5 i1; S6 i1) — 6/6 sprints passed, only ONE sub-iteration rework (S2 trivial lint fix)
- Sprints completed: 6 / 6 — PLAN COMPLETE
- Subagents spawned: 25 (curator×6, generator×7 [S2 lint-fix rework], evaluator×6, documenter×5 + S6 docs running) + 1 orchestrator doc-artifact cleanup (01d2734)
- Final suite: 3324 passed (260 files), up from 3264 baseline (+60); build + typecheck clean, lint 0 errors
- Net-new: src/hub/{finding-store(+transitionFinding/isVisibleInDefaultList/ingestFinding/deriveFindingId), task-inbox(captureTask), gmail-to-task(parseGmailThread/fromGmailTask/sanitizeConnectorError)} + chat capture-task intent (turn-classifier + chat-session handleCaptureTask) + config taskInbox.gmailEgress axis. CLI: `bober task add|list|start|done|drop|snooze|ingest|from-gmail` + chat new-task capture. All on the hub-owned Finding schema (imported, never redefined); single bi-temporal FactStore persistence (scope='hub'/predicate='finding'); zero-egress default (gmail axis off). Spec 5/9 of the knowledge-platform plan set.

---

## Active Run: spec-20260628-research-scheduler
- Started: 2026-06-29 (via /bober-run)
- Branch: bober/medical-team
- Status: completed (5/5 sprints) — PLAN COMPLETE
- Spec 9/9 (FINAL) of the knowledge-platform plan set. Recurring multi-model research jobs: thin job config + JSON store, deterministic runner using fleet tier-policy for model diversity -> vault note + hub Finding, NEW online-research egress axis (default off, mirrors medical EgressGuard), idempotent `bober research tick` cadence runner, morning digest artifact for the Telegram bot. Dep [priority-hub] satisfied. Additive src/research/ module; existing fleet/medical/pipeline byte-identical when no job runs. ALL 5 SPRINTS PASSED ITER-1 (zero evaluator reworks). Net-new src/research/: types(ResearchJobSchema+nextDueAt/lastRunAt) · job-store(JSON .bober/research/jobs/) · model-diversity(tierPolicy cross-tier) · note-writer(vault md+frontmatter) · runner(runResearchJob -> note + 1 hub Finding) · egress(ResearchEgressGuard 'online-research' axis, default-off) · online-retrieval(injectable) · cadence(computeNextDue clock-free) · scheduler(idempotent tick) · digest(buildDigest -> .bober/research/digests/<date>.{md,json}). CLI: `bober research job add|list|remove · run <jobId> · tick [--watch] [--interval] · digest --since <iso>`. Single existing-core edit = additive OPTIONAL research section in src/config/schema.ts (existing configs byte-identical). Suite 3497→3583 (+86). With the whole knowledge-platform plan set now 9/9, this CLOSES the 9-spec build.

### Sprint Breakdown
1. [completed] Sprint 1: Research job schema, JSON store, `bober research job` CLI — passed iter-1 (0336e47); src/research/types.ts (ResearchJobSchema; cadence enum daily|weekly|monthly; question min(1); onlineResearch default false; jobId=sha256(question|createdAt).slice(0,16) clock-free) + job-store.ts (addJob/listJobs/readJob/removeJob over .bober/research/jobs/<id>.json, async-only, safeParse-before-write) + cli/commands/research.ts (registerResearchCommand: research job add|list|remove) wired in cli/index.ts:42/331. NB src/state/research-state.ts already owns .bober/research/*.md — untouched. +22 tests, suite 3497→3519, zero regressions; lint 0 errors
2. [completed] Sprint 2: Single-shot multi-model research run -> vault note + hub Finding — passed iter-1 (20d42cb); src/research/model-diversity.ts (diverseBlocks() enumerates >=2 DISTINCT provider/model blocks across DIFFERENT fleet tiers via the single exported tierPolicy.resolveTier() — within-tier roles are identical so distinctness comes from cheap/standard/hard/frontier; default pair openai-compat/deepseek + openai-compat/grok) + note-writer.ts (PURE serializeResearchNote -> md+YAML frontmatter {jobId,question,models[],generatedAt} via serializeFrontmatter, mirrors medical research-note) + runner.ts (runResearchJob(job,deps={queryModel,findingSink,now,vaultRoot}): loops blocks, writes vault note, emits EXACTLY ONE Finding via INJECTED sink using canonical FindingSchema imported from src/hub/finding.ts — never redefined; pluggable domain-analyzer registry hook, no src/medical/ import) + `bober research run <jobId>` (binds queryModel→provider createClient, findingSink→ingestFinding finding-store.ts:140). Clock injected (no new Date() in core; only CLI .action boundary). research.ts does ZERO direct fs (delegates to runner — keeps research.test.ts vi.mock(utils/fs) surface stable). +21 tests, suite 3519→3540, zero regressions; lint 0 errors. NO web egress yet (Sprint 3)
3. [completed] Sprint 3: Online-research egress axis (default off) + gated web retrieval — passed iter-1 (0150737); NEW research-owned opt-in egress axis. src/config/schema.ts ResearchSectionSchema {egress:{onlineResearch default false}} registered OPTIONAL on BoberConfigSchema (:532) — existing configs parse unchanged (37 config tests green). src/research/egress.ts ResearchEgressGuard mirrors src/medical/egress.ts LINE-FOR-LINE: assertAllowed throws exact literal `Egress axis 'online-research' not enabled` when off, fromConfig reads config.research?.egress?.onlineResearch ?? false. online-retrieval.ts injectable retrieve(query,client) (fail-closed []→ on client error). runner.ts gates retrieval BETWEEN model loop and note serialization via TWO OPTIONAL RunDeps (egress + retrievalClient): gate `deps.egress?.isAllowed('online-research')===true && deps.retrievalClient!==undefined` — axis-off OR deps-absent => Sprint-2 path BYTE-IDENTICAL, ZERO outbound; axis-on => 1 retrieve + source URLs threaded as string[] (never objects). note-writer optional sources param default [] => identical frontmatter. +13 tests, suite 3540→3553, zero regressions; lint 0 errors. FAIL-CLOSED independently evaluator-verified
4. [completed] Sprint 4: Recurring scheduler — cadence due-dates + idempotent `bober research tick` — passed iter-1 (c8c4b53); src/research/cadence.ts (computeNextDue(cadence,fromIso) PURE/clock-free — only new Date(Date.parse(fromIso)) on the INJECTED arg, no argless new Date()/Date.now(); daily+1d/weekly+7d/monthly+1mo via setUTCMonth; month-rollover documented Jan-31→Mar-03) + scheduler.ts (tick(deps={now,listJobs,saveJob,runJob}): isDue=nextDueAt unset||Date.parse(nextDueAt)<=Date.parse(now), runs each due job via Sprint-2 runResearchJob UNCHANGED, advances lastRunAt=now+nextDueAt=computeNextDue, persists via addJob UPSERT; IDEMPOTENT — 2nd tick same now runs 0, verified at persistence level via read-back). types.ts EXTENDED ResearchJobSchema += nextDueAt/lastRunAt z.string().datetime().optional() (REQUIRED — addJob safeParse strips unknown keys; jobId still hashes only question|createdAt so id stable on update). CLI `bober research tick [--watch] [--interval <ms>]` — clock only at .action boundary; help documents in-repo-loop vs OS cron/launchd (recommended unattended) vs harness-scheduler tradeoff + crontab example. +22 tests, suite 3553→3575, zero regressions; lint 0 errors. Clock-injection + idempotency independently evaluator-verified
5. [completed] Sprint 5: Morning digest artifact for the Telegram bot — passed iter-1 (bebe2f5); src/research/digest.ts buildDigest(since,now,deps={collectRuns}) aggregates in-window runs -> PURE renderDigestMarkdown (heading + bullet/run: title, top finding, source link) + JSON {since,now,generatedAt,runs[]}, writes BOTH .bober/research/digests/<YYYY-MM-DD>.{md,json} (date=now.slice(0,10), ensureDir from state/helpers NOT utils/fs so research.test.ts vi.mock stays stable). Empty window => '_No new research was produced in this window._' to both files (never throws/empty). REAL collectRunsFromVault reads vault notes <vaultRoot>/research/ filtered by frontmatter.generatedAt in [since,now] (NOT hub Findings — they dedup by sha256(domain|title|kind) & undercount; notes are 1:1 dated artifacts w/ source path); topFinding from frontmatter.question (NON-SENSITIVE only, Telegram non-E2E). `bober research digest --since <iso>` (default last 24h at .action boundary). Telegram transport OUT of scope (sibling spec consumes the JSON). +8 tests, suite 3575→3583, zero regressions; lint 0 errors

### Pipeline Statistics
- Iterations used: 5 / 20 (S1–S5 ALL pass iter-1 — ZERO evaluator reworks)
- Sprints completed: 5 / 5 — PLAN COMPLETE
- Subagents spawned: 15 (curator×5, generator×5, evaluator×5) + documenter×5 (S1 1ab72b7, S2 fa667e5, S3 ec7ddb4, S4 db37574, S5 running)
- Final suite: 3583 passed (284 files), up from 3497 baseline (+86); build + typecheck clean, lint 0 errors
- Open follow-ups (non-blocking): (1) runner queries ALL distinct tier blocks (4: deepseek/grok/sonnet/opus) not just 2 — real `research run` makes 4 provider calls incl. cloud Anthropic; sc-2-1 only needs >=2 so no violation; candidate configurable model-count cap. (2) TWO onlineResearch knobs — Sprint 1 per-job ResearchJob.onlineResearch (stored, INERT) vs Sprint 3 config axis config.research.egress.onlineResearch (the ACTUAL gate); runner keys off the config axis; reconcile later. (3) `research run`/`tick` do NOT yet bind a LIVE web-search RetrievalClient (injectable for tests only) — even axis-on has no production retrieval provider wired; deferred by design.
- Open follow-up (non-blocking, from S2 documenter): runner queries ALL distinct tier blocks (currently 4: deepseek/grok/sonnet/opus) not just 2 — real `bober research run` makes 4 provider calls incl. cloud Anthropic; sc-2-1 only requires >=2 so no violation; candidate for a configurable model-count cap later

## Plan: Agent-Loop Capability Port (full Agent SDK parity on the own loop)
- Spec: spec-20260709-agent-loop-capability-port
- Created: 2026-07-09
- Sprints: 10
- Status: completed (10/10 sprints)
- Architecture: arch-20260709-agent-sdk-agent-loop-harness (5 ADRs; sprints 1-4 architecture-backed, sprints 5-10 user-mandated extensions of the 7 deferred areas)

### Sprint Breakdown
1. [completed] Refusal detection end-to-end — passed iter-1 (35a2dbd); explicit 'refusal' case in anthropic+openai normalizeStopReason (openai also maps message.refusal + content_filter), spread-conditional refused:true on AgenticLoopResult completion branch (never throws), parseGeneratorResult exported + fail-closed refusal guard BEFORE filesWritten shortcut (verified at real call site :151). +13 tests, suite 3686->3699, byte-identical non-refusal path (Object.hasOwn asserted). 6/6 criteria evaluator-verified
2. [completed] Cost substrate — passed iter-1 (8d68248/c73b95d/d5c8b9d/73053c0); pure src/providers/cost-meter.ts (dated 2026-07 PRICE_TABLE, longest-prefix match, NO catch-all rows so unknown models fail-open undefined, claude-code always undefined) + optional ChatResponse.costUsd in anthropic/openai/openai-compat (protected costProvider discriminator: compat prices deepseek/grok via its OWN rows) + claude-code passes through real total_cost_usd (no cost-meter import, ADR-3) + Budget maxUsd axis (chargeUsd non-finite/negative->0, remainingUsd Infinity uncapped, BudgetExceededError kind 'usd'). Google rows present but adapter unwired (per contract scope). Budget still zero production callers (dormant until S3). +32 tests, suite 3699->3731. 6/6 evaluator-verified
3. [completed] Loop wiring — passed iter-1 (b9c936c); EffortSchema (low|medium|high|xhigh|max) + BudgetSectionSchema {maxUsd positive|null} optional on planner/curator/generator/evaluator sections (no defaults injected, fixtures parse unchanged); AgenticLoopParams {effort?, budget?} — effort spread at the maxTokens site (anthropic.ts UNTOUCHED, output_config forwarding pre-existed; openai test asserts effort never on wire); per-turn budget.chargeTokens+chargeUsd then graceful budget_exceeded partial return mirroring max-turns (NEVER throws, assertWithinBudget never called — ADR-4); cumulative AgenticLoopResult.costUsd conditional on ALL FOUR return sites; pipeline sprint-passed event conditionally carries costUsd (z.record, no schema change); generator wires config via new exported budgetFromMaxUsd helper (other roles adopt later). bober.config.json untouched (dogfooding declined). +39 tests, suite 3731->3770. 7/7 evaluator-verified
4. [completed] Parallel read-only tool execution — passed iter-1 (4ab7040 + test-only anti-flake 59b4b23); ToolDef.readOnly?: boolean (ADR-2 classification-travels-with-ToolDef), readOnly:true on EXACTLY read_file/glob/grep (bash NEVER), new src/orchestrator/tools/executor.ts executeToolBatch (maximal contiguous read-only runs via Promise.all, serial otherwise, error shapes byte-identical to old serial block incl. logger.warn, never rejects, order by original index), loop serial for-of replaced by delegation (no hard-coded tool names — grep-verified), parallelReadOnlyTools z.boolean().optional() NO default on GeneratorSectionSchema + conditional-spread threading. Evaluator independently probe-verified mixed batch [ro,ro,write,ro] -> maxConcurrent 2, no merge across write boundary. sc-4-2 concurrency proof self-calibrated (parallel < serial*0.7 w/ hard serial floor). +17 tests, suite 3770->3787. ADVISORY (low): add a committed mixed-batch test later. NB machine-load flakes in unrelated tests at default 5s timeout (preflight-injector-bench verified 440x under budget in isolation). 6/6 evaluator-verified
5. [completed] Structured loop event stream + hooks — passed iter-1 (d52f94c); new types-only src/orchestrator/loop-events.ts (LoopEvent union init/turn-start/tool-start/tool-end/turn-end/result; compact-boundary+text-delta names RESERVED comment-only; type-only import breaks cycle) + LoopHooks {preToolUse veto, postToolUse, onStop}; loop gains safeEmit (swallow+log) + single finish() helper wrapping ALL FOUR return paths (error/budget_exceeded/completion-refusal/max-turns — evaluator verified no bypass) firing result event + onStop exactly once; tool events + veto threaded through Sprint-4 executor (executeOne finalize() closure fires onToolEnd+postToolUse on veto/unknown/success/thrown paths; onToolStart pre-await); throwing preToolUse = fail-closed deny, throwing observers swallowed; turn-end fires on completion turn too (8-event trace asserted). onToolUse/onTurnComplete untouched; paired-run deep-equal byte-identity. +15 tests, suite 3787->3802. ADVISORY (low): direct executor-level hook-dispatch unit tests would speed future failure localization. 6/6 evaluator-verified
6. [completed] Loop session persistence/resume/fork — passed iter-1 (c51b28b); new src/orchestrator/session-store.ts (Zod MessageSchema w/ union ordering that round-trips AssistantMessage.toolCalls, SessionRecordSchema, SessionStore save/load/fork/path over .bober/sessions/<id>.json mirroring job-store.ts: ensureDir, safeParse both directions, injected clock, load returns null never throws) + sessionForkId deterministic; AgenticLoopParams {session?, initialMessages?}; fail-soft persistSession() at EVERY turn-body completion point incl. completion turn's final assistant text (in-loop array never receives it — trap caught), budget_exceeded, error, max-turns; resumeSession typed {error} on missing/corrupt (never throws, never silently empty, corrupt bytes untouched); fork structurally never opens source for write. No pipeline role auto-enables (all 8 byte-identical). +30 tests, suite 3802->3832. ADVISORY (low): add committed test for store.save()-throws fail-soft path (evaluator ad-hoc verified correct). 6/6 evaluator-verified
7. [completed] In-context auto-compaction — passed iter-1 (8b8fd13); AgenticLoopParams.compaction {maxContextTokens, keepRecentTurns? (default 2), instructions?}; trigger = tool_use stop && PER-REQUEST usage.inputTokens > threshold; new pure src/orchestrator/compaction.ts summarizeMessages -> CompactionOutcome {summaryMessage, usage, costUsd?} | undefined (serialized-head no-tools call, bounded maxTokens 4096, fails OPEN returning undefined); loop splices head -> single user-role '[Conversation summary]' TextMessage in place (tail identity preserved), charges summarizer usage/cost to accumulators+Budget BEFORE the existing exceeded() gate, safeEmits compact-boundary {turn, messagesBefore, messagesAfter, inputTokensAtTrigger} (full 3-field payload, richer than reserved stub); absent config = zero extra calls, inert-config deep-equal proven. summarizeOlderSprints/contextReset untouched; no role enables by default. +11 tests, suite 3832->3843. ADVISORIES (low): pathological turns whose own tail exceeds threshold can re-trigger consecutively (JSDoc slightly overstates 'naturally resets'); no combined session+compaction test (trace-verified safe). 6/6 evaluator-verified
8. [completed] Streaming text deltas — passed iter-1 (37405e2 + sc-8-3 tests 016e9f5); ChatParams.onTextDelta (adapters MAY ignore); anthropic.ts extracts shared normalizeResponse(message,model,structured) (moved VERBATIM — create+stream branches deep-equal proven) + branches create() (unchanged path) vs messages.stream() (SDK 0.100.1 MessageStream AsyncIterable + finalMessage()); per-delta callback try/catch (throwing consumer never kills request); mid-stream errors reject un-swallowed -> same untouched chatWithRetry/isTransientError classification; loop per-turn emitTextDelta wrapper (safeEmit text-delta LoopEvent BEFORE caller cb, key absent when both unset); 4 non-Anthropic adapters: no-op comment + explicit never-called/nothing-on-wire test each; loop-events.ts text-delta implemented (NO reserved names left). +16 tests, suite 3843->3859. ADVISORY (low): streaming+structured-output combination untested — delta-join guarantee would not hold there (forced tool_choice); document/guard when first combined. 6/6 evaluator-verified
9. [completed] Mid-turn interrupt — passed iter-1 (2f3636e); ChatParams.abortSignal (web-standard) + AgenticLoopParams.abortSignal; THREE abort exits ALL through finish(): top-of-turn boundary, post-response pre-tool-batch (discarded response's usage/cost NEVER accumulated NOR budget-charged — evaluator-verified past the early return), chatWithRetry catch; abort check BEFORE isTransientError keyed on signal.aborted (SDK APIUserAbortError leaves err.name 'Error' — curator caught this trap) w/ err.name AbortError secondary; AbortedError class; abortedResult() mirrors budget_exceeded shape, turnsUsed=turn-1 per existing error convention; anthropic forwards {signal} as 2nd options arg to BOTH create/stream (never in requestBody — S8 body-identity invariant re-verified w/ signal); non-cancellable adapters degrade at next boundary structurally (untouched); paired-run byte-identity. +13 tests, suite 3859->3870. ADVISORY (low): add permanent session+abort combined regression test (evaluator ad-hoc verified all 3 exits persist correctly, no crash). 6/6 evaluator-verified
10. [completed] In-process scoped subagents + opt-in MCP bridge — passed iter-1 (288fc4f); src/orchestrator/subagents.ts SubagentDef + buildSubagentTool (scoped fresh-context child via injected runLoop breaking the import cycle w/ type-only imports; child inherits SAME Budget instance (reference-equal, ceiling shared) + abortSignal + parallelReadOnlyTools + maxTokens; EXCLUDES session/compaction/onEvent/hooks/onTextDelta/initialMessages/subagents — one-level hard cap; refusal/budget/error/aborted -> isError naming reason, handler NEVER throws incl. unknown-name/throwing-runLoop); src/orchestrator/tools/mcp-bridge.ts reuses existing @modelcontextprotocol/sdk (package.json untouched) w/ injectable McpBridgeClientLike, mcp__-prefixed NEVER-readOnly ToolDefs, runWithMcpBridge close()-in-finally on success AND throw — loop stays hermetic (never wired into runAgenticLoop; consumer composes); config.tools.mcpBridge {enabled default false} NOT in createDefaultConfig; no-subagents path = REFERENCE-equal tools array. +33 tests, suite 3870->3903. claude-code.ts/fleet untouched. 6/6 evaluator-verified. NOT wired: no automated call site invokes createMcpToolBridge (future consumer sprint).

## Plan: Security Audit Agent Team (fail-closed gate + standalone audit)
- Spec: spec-20260712-security-audit-agent-team
- Architecture: arch-20260712-security-audit-agent-team (6 ADRs)
- Created: 2026-07-12
- Sprints: 7
- Status: completed (7/7 sprints)

### Sprint Breakdown
1. [completed] Add security config section, audit result types, and .bober/security store -- Passed on iteration 1 (f76ee2e/fc20eae/4ae188f); suite 3929
2. [completed] Implement bober-security-auditor agent, runSecurityAudit core, and stack knowledge injection -- Passed on iteration 2 (0990156/ddf27bc/e5cf267 + nonGoal fix 40c1488: auditor bash tool removed, curator role); suite 3960
3. [completed] Wire the fail-closed SecurityAuditGate into the pipeline -- Passed on iteration 1 (e60422c); pipeline.ts additive 98+/0-, byte-identity frozen-clock deep-equal proven; suite 3980
4. [completed] Add the standalone `bober security-audit` CLI with configurable blocking threshold -- Passed on iteration 1 (61e055a); 10-cell exit-code matrix, gate byte-identical; suite 4004
5. [completed] Implement the scanner pre-filter with slither and semgrep parsers -- Passed on iteration 1 (bf2a31b); CI-offline fixtures, SIGKILL abort proven w/ real child; suite 4019
6. [completed] Emit security audit findings into the priority hub -- Passed on iteration 2 (5b9a214 + sc-6-2 guard fix 3d99fbc: default-sink store setup try/catch, evaluator-reproduced fs-failure defect); suite 4045
7. [completed] Add the bober.security-audit skill, enable dogfooding, and write docs -- Passed on iteration 1 (c2953e7); dogfood security.enabled=true (LLM-only) live in this repo's config; suite 4045

## Plan: Per-Stack Security Auditor with Skill-File Signatures + Adversarial Verifier
- Spec: spec-20260714-security-auditor-per-stack-skills
- Architecture: arch-20260714-security-auditor-per-stack-skills
- Created: 2026-07-14
- Sprints: 10
- Status: completed (10/10 sprints)

### Sprint Breakdown
1. [completed] Widen taxonomy + structured finding metadata + hub collision fix (G6/G8/G10) -- PASSED iteration 2
2. [completed] Signature type + skill-file format + total parser + generic security skill -- PASSED iteration 1 (22c8739)
3. [completed] Author money/crypto skill files: solidity, anchor, igaming, dex-backend -- PASSED iteration 1 (f19a4bf), zero-drop 12/7/12/12
4. [completed] Author web/backend skill files: node, payments, react -- PASSED iteration 1 (09918db); all 8 stacks complete
5. [completed] Stack registry + knowledge index + selector + resolver, wired into finder (fixes G3) -- PASSED iteration 1 (a081f35); HALFWAY: auditor now uses per-stack skills
6. [completed] Orchestrator-owned real-diff provider + wire into audit (fixes G4) -- PASSED iteration 1 (73cf22d), diff-driven selection proven
7. [completed] Supply-chain axis: scanner kinds + nonzero-exit fix (G9) + offline inspector (G5) -- PASSED iteration 1 (89d0ad7)
8. [completed] Adversarial finder->verifier stage (fresh, contract-free, downgrade-only, fail-closed) -- PASSED iteration 1 (9acf265)
9. [completed] Labelled vulnerable/safe benchmark corpus + measurement harness -- PASSED iteration 1 (5537086); FP-reduction measured 2/13->0 recall retained
10. [completed] Dogfood enablement (verifier + offline supply-chain, egress off) + docs + update-all sync -- PASSED iteration 1 (d934df6)

## Plan: Documentation & Metadata Refresh (0.18.0)
- Spec: spec-20260714-docs-metadata-0-18-refresh
- Created: 2026-07-14
- Sprints: 2
- Status: completed (2/2 sprints)

### Sprint Breakdown
1. [completed] Complete the COMMANDS.md CLI reference — add sections for config, telemetry, worktree, memory, facts (5 registered, non-hidden commands the "complete reference" claim omits). -- PASSED iteration 2 (0ae6da6, 6296eee); all 35 top-level commands documented
2. [completed] Sync README CLI quick-reference (fleet + those 5 commands, deferring to COMMANDS.md) and refresh package.json description/keywords for the 0.18.0 surface (security-audit, fleet, incident-response, knowledge-platform). -- PASSED iteration 1 (bdb2e04)

Scope: docs + npm metadata only — no src/ or *.test.ts changes, no git tags. VISION.md/providers.md spot-checked current and excluded; CHANGELOG already through [0.18.0].
