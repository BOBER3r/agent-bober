# Decision Document: agent-bober → "Chattable Team-of-Agents" Platform

> Research date: 2026-06-14. Produced via a 15-agent online research workflow (7 angles, each
> independently fact-checked) + code-graph grounding against the working tree. Market claims carry
> inline citations; file/line references verified via tokensave.
>
> **This is research synthesis, not legal advice.** The medical-team section must be confirmed with
> FDA/MDR counsel before shipping anything health-facing.

## 1. Executive Summary

**Yes, this is realistic — and the shortest path is unusually short**, because agent-bober already
owns the two hardest components most projects in this space lack: (a) a production multi-agent SOP
pipeline (`runPipeline`, plan→research→architect→sprint with a generator↔evaluator retry loop) and
(b) a supervisor/fan-out fleet layer (`FleetCoordinator`/`ChildRunner`) that already runs DeepSeek
children. What's missing is *not* an orchestration engine — it's a **persistent conversational
session layer** that sits *above* the existing one-shot pipeline, plus a generalization of three
already-built abstractions (memory, role-provider routing, skill catalog) from "one programming
pipeline" to "an arbitrary team."

The verified research convergence is decisive on one point: **do not adopt a framework.** Every
credible 2025–2026 source (Anthropic subagents, OpenAI handoffs, LangGraph store/checkpointer split,
MetaGPT SOP, Letta file-memory at 74% LoCoMo, Anthropic's own file-based memory tool) points to a
**file-first, in-process, SOP-driven** design that agent-bober *already embodies*. CrewAI's
hierarchical "manager agent self-orchestrates" mode is documented to **fail and degrade to
sequential** ([TDS critique](https://towardsdatascience.com/why-crewais-manager-worker-architecture-fails-and-how-to-fix-it/))
— agent-bober's encoded SOP pipeline is the recommended antidote, not the thing to replace.

**Shortest path (the opinionated answer):** Build a thin `bober chat` REPL that wraps the existing
`RunManager` (disk-authoritative roster) and a turn-classifier (answer | spawn run | steer run),
reusing `runPipeline` + the lessons memory unchanged. That is a shippable "chat with a programming
team" in one phase. The medical team is a *second domain instantiation* of the same abstraction — it
should be **deferred until the team/chat/memory spine exists**, and it carries real legal exposure
(FDA intended-use, the Illinois WOPR Act) that demands code-enforced guardrails, not disclaimers.

**The one thing to resist:** building the medical team first because it's exciting. The platform
value is the domain-agnostic team spine; medical is a high-risk validation of it, not the MVP.

---

## 2. What Already Exists in agent-bober That Maps Directly

All file/line references verified against the working tree via the code graph.

| Desired capability | Existing component (verified) | Gap to close |
|---|---|---|
| One-shot autonomous "build a feature" | `runPipeline()` (`src/orchestrator/pipeline.ts:968`) — plan→research→architect→sprint | None for programming; it's a *worker*, needs a conversational caller above it |
| Team-lead spawns N specialist workers | `FleetCoordinator` (`src/fleet/coordinator.ts:20`) + `ChildRunner` (`src/fleet/runner.ts:56`) + `aggregate()` | Batch-only; needs to become a *chat participant*, not a one-shot job |
| Multi-run tracking / roster | `RunManager` (`src/mcp/run-manager.ts:73`), `RunState` persisted to `.bober/runs/<id>/state.json` | Promote from in-memory-with-backup to **disk-authoritative reload per turn** (compaction-safety) |
| Event backbone for live updates | `EventStreamManager` (`src/mcp/event-stream.ts:68`), `initEventStream`/`getEventStream` | Wire `ChildRunner` completion → session inbox (push, not poll) |
| Approval / interrupt / resume | `approval-state.ts` (`approvalsDir`, pending/approved), `bober approve`, `resume-cursor.ts` | Re-point triggers from CLI flag → chat turn; add `input-required`/`paused` to `RunState` |
| Persistent procedural memory (lessons) | `appendLesson`/`lessonPath`/`indexPath` (`src/state/memory.ts:18,22,195`), `LessonIndexRecord` (`:41`) with `occurrences` field, deterministic top-k retrieval | Missing **semantic-facts** memory type; lessons grow monotonically (no hygiene/decay) |
| Bounded run-memory + distillation | `.bober/memory/` deterministic distill + `bober memory` CLI | Needs **per-team/per-domain namespacing** (a scope key) |
| Multi-provider, per-role routing | `RoleProviderMap` (`src/config/role-providers.ts:17`), `resolveRoleProviders` (`:91`), `BoberConfig` (`src/config/schema.ts:372`), DeepSeek-via-openai-compat | Role set hardcoded to 6 SE roles; needs to be **team-definable** |
| Dynamic workflow runtime | `selectPipelineEngine` (`src/orchestrator/workflow/selector.ts:49`) | Already an extension point for a "team" pipeline shape |
| Generator↔evaluator self-correction | `bober-generator`/`bober-evaluator` agents + retry loop | Discards the **fail→pass contrast signal** (ExpeL gap) |
| Skill catalog (~25) + 11 subagents | `skills/bober.*/`, `agents/bober-*.md` | SE-only vocabulary; new domains need their own skill packs |

**Honest summary:** ~80% of the mechanical substrate exists. The gaps are a *session object*, three
*generalizations* (memory scope, role set, skill pack), and *memory lifecycle hygiene*.

---

## 3. What to COPY from the Market

Per concern, with a one-line "why" and source. **Copy patterns/algorithms, never infrastructure.**

**Team orchestration**
- **Anthropic subagent-as-context-isolation** — delegate to a worker that burns its own context window and returns only a summary; the single highest-leverage CLI pattern, and `ChildRunner` already does it. ([Claude multi-agent ecosystem](https://codex.danielvaughan.com/2026/04/09/claude-multi-agent-ecosystem/))
- **OpenAI handoff primitive** — "delegation = return the next agent + carry context"; trivial as the turn-classifier's routing decision. ([Agents SDK](https://openai.github.io/openai-agents-python/))
- **MetaGPT SOP + structured-schema handoffs** — encode a known-good workflow with typed intermediate artifacts (85.9% HumanEval / 87.7% MBPP) rather than trusting a manager to self-organize; agent-bober's pipeline *is* this. ([arXiv 2308.00352](https://arxiv.org/html/2308.00352v6))
- **Anthropic Agent Teams mailbox + shared task list w/ file locking** — durable file-based coordination that maps onto `.bober/runs/`; copy the durability, **avoid the documented bug** where context compaction makes the lead re-spawn "missing" workers ([#55586](https://github.com/anthropics/claude-code/issues/55586)) — defeated by making the disk roster authoritative.

**Persistent memory**
- **Mem0 reconcile-on-write (`ADD`/`UPDATE`/`DELETE`/`NOOP`)** — supersede stale facts instead of duplicating; deterministic on exact subject+predicate match, LLM-judged only on ambiguity. ([Mem0, arXiv 2504.19413](https://arxiv.org/pdf/2504.19413))
- **Zep/Graphiti bi-temporal validity** — two timestamp axes (`t_valid`/`t_invalid` + `t_created`/`t_invalidated`); *invalidate, don't delete* — exactly right for "was on metformin → now on Ozempic." Two SQLite columns, no graph engine. ([Zep, arXiv 2501.13956](https://arxiv.org/abs/2501.13956))
- **Letta file-memory** — 74% LoCoMo with *just files* validates agent-bober's substrate; the upgrade is structure+lifecycle, not a vector DB. ([Letta Memory Blocks](https://www.letta.com/blog/memory-blocks))
- **CrewAI memory taxonomy** — adopt the vocabulary (working/procedural/semantic/episodic; short/long/entity/shared) even without the framework. ([memory deep-dive](https://sparkco.ai/blog/deep-dive-into-crewai-memory-systems))

**Self-improvement**
- **ExpeL fail→pass contrast extraction** — the retry loop already produces failing+passing diffs; mine the *transition* for a generalizable lesson. Highest-value, lowest-risk (pure addition to `appendLesson`). ([arXiv 2308.10144](https://arxiv.org/abs/2308.10144))
- **Letta Skill Learning** — reflect on trajectories → write markdown skills under git (+15.7% absolute on Terminal-Bench 2.0); the published analog to bober's lessons. ([Letta Skill Learning](https://www.letta.com/blog/skill-learning))
- **GEPA reflective prompt evolution** — evolve the *instruction text* of generator/evaluator offline, gated by replay (+up to 20%, 35× fewer rollouts than RL). ([arXiv 2507.19457](https://arxiv.org/abs/2507.19457))
- **Memory governance (SSGM)** — dedup/decay/conflict-quarantine to stop monotonic store-rot, the #1 named failure mode. ([arXiv 2603.11768](https://arxiv.org/html/2603.11768v1))

**Multi-provider routing**
- **Keep the in-process adapter layer** — `LLMClient`+`RoleProviderMap` is already 2025–2026 best practice (Vercel AI SDK / Pydantic-AI family). **Do NOT add LiteLLM** — it flattens to the OpenAI dialect and loses Anthropic prompt caching/effort. ([LiteLLM routing](https://docs.litellm.ai/docs/routing))
- **DeepSeek strict-vs-loose JSON discipline** — DeepSeek rejects strict `json_schema`, supports loose `json_object`; bober already encodes this. Copy *retry-with-escalation* (cheap worker fails validation → escalate that one call to the lead model). ([DeepSeek JSON mode](https://api-docs.deepseek.com/guides/json_mode))

**Health data**
- **Leo Health Core (MIT, local, zero-egress)** — closest CLI analog: SAX-streaming Apple Health XML + auto-detect Whoop CSV → local SQLite `~/.leo-health/leo.db`, one table per metric. ([GitHub](https://github.com/sandseb123/Leo-Health-Core))
- **Google PHIA "code-as-tool for arithmetic"** — never let the LLM do math on time-series; generate Python/Pandas in a sandbox (50% error reduction). ([arXiv 2406.06464](https://arxiv.org/html/2406.06464))
- **OpenEvidence retrieve-then-synthesize + abstain-when-inconclusive** — ground every clinical claim in retrieved literature, cite inline, refuse when evidence is weak. ([clinician guide](https://gacguidelines.ca/ai-healthcare/openevidence))

**Chat-with-team**
- **A2A task-state vocabulary** — adopt `submitted → working → input-required → auth-required → completed | failed | canceled | rejected` as the *internal* `RunState` grammar. No HTTP server needed. ([A2A spec](https://a2a-protocol.org/latest/specification/))
- **Lindy/Zapier chat-as-control-surface** — human talks to the lead in one thread; plain-English agent definition. Copy the *UX*, not the workflow engine. ([Lindy review](https://skywork.ai/blog/lindy-ai-review-2025-no-code-agent-platform-automation/))

**Traps to avoid (verified):** trusting a manager agent to self-orchestrate (CrewAI hierarchical);
building on churning bases (Swarm, AutoGen→AG2→Agent Framework); "fully autonomous" framing
(Cognition retreated from it); hard-coupling to a proprietary runtime — Anthropic blocked
third-party subscription agents in Apr 2026 **but reversed it in May 2026** via an Agent-SDK-credit
system, so the directional lesson ("don't hard-couple") stands while the specific block does not.

---

## 4. What to REUSE vs BUILD NEW

**REUSE unchanged:**
- `runPipeline` as the programming team's "do-the-work" verb.
- `FleetCoordinator`/`ChildRunner`/`aggregate` as the fan-out worker layer (already DeepSeek-capable).
- `RunManager`/`RunState`/`.bober/runs/` as the durable roster + per-worker scratchpad.
- `EventStreamManager` as the completion-push backbone.
- `approval-state.ts` + `resume-cursor.ts` as the interrupt/resume substrate.
- `RoleProviderMap`/`resolveRoleProviders`/`BoberConfig` + adapter layer as provider routing (no LiteLLM).
- `appendLesson`/lessons + `.bober/memory/` distill as procedural/episodic memory.
- The generator↔evaluator retry loop as the self-correction unit.

**BUILD NEW (thin, additive):**
1. **`bober chat` session object** — persistent REPL holding conversation history; owns the run roster; per turn classifies answer | spawn | steer.
2. **`Team` abstraction** — `{ id, roles[], tools[], skillPack, memoryNamespace, RoleProviderMap }` as config; programming + medical teams are two instances.
3. **`semantic_facts` SQLite table** — the missing memory type (scope, subject, predicate, value, confidence, bi-temporal columns, source_run_id).
4. **Reconcile-on-write + memory hygiene** ops (dedup/decay/conflict-quarantine) over the existing store.
5. **Fail→pass contrast extractor** hooked into the retry loop.
6. **`input-required`/`paused` RunState** + chat-turn-driven resume.
7. **Domain skill packs** — medical team's roles/skills; health ingestion adapters + code-as-tool sandbox; guardrail layer.
8. **(Deferred) GEPA offline prompt evolution + replay regression harness.**

**Explicitly DON'T build:** a graph DB (FTS5 covers point lookups), a vector DB (defer per
turbovec/Letta findings), an external memory service (adopt algorithms not infra), an A2A HTTP
server (in-process file inbox suffices), a visual builder.

---

## 5. Proposed Architecture

### The domain-agnostic Team abstraction — *a Team is data, not code*

```
Team = {
  id,                       // "programming" | "medical"
  roles:        Role[],     // each Role = { name, systemPrompt, toolSubset, skillPack }
  tools:        ToolDef[],  // the team's capability surface
  memoryNamespace: string,  // scopes .bober/memory/<ns>/ and semantic_facts.scope
  providers:    RoleProviderMap,  // per-role model routing (reuses resolveRoleProviders)
  pipeline:     PipelineShape,    // resolved via selectPipelineEngine — the team's SOP
  guardrails:   GuardrailSet,     // code-enforced refusals (critical for medical)
}
```

The programming team's `pipeline` is `runPipeline` (plan→research→architect→sprint). The medical
team's `pipeline` is a *different SOP* (intake→retrieve-literature→reason-in-sandbox→answer-with-
abstention), selected by `selectPipelineEngine`. **Same engine, different encoded SOP — the MetaGPT
lesson.**

### Persistent chat above the one-shot pipeline

```
┌─ bober chat <team> (persistent CLI session) ───────────────────┐
│  TeamLead (conversational supervisor — thin, durable)          │
│   • conversation history (reuses .bober/memory/<ns> distill)   │
│   • owns roster via RunManager  (DISK = source of truth)       │
│   • per turn: classify → { answer | spawn pipeline | steer }   │
└───────────┬─────────────────────────────────────────────────────┘
            │ delegates (A2A task vocabulary internally)
   ┌────────┴────────┐
   ▼                 ▼
 runPipeline()   FleetCoordinator → N×ChildRunner   (isolated workers)
   │ emits EventStreamManager events; persists RunState to disk
   ▼
 Blackboard = .bober/runs/<id>/ (scratchpad) + .bober/memory/<ns>/ (shared)
```

**Load-bearing invariants:**
1. **Session durable, workers isolated.** TeamLead never holds worker transcripts — it reads aggregated `RunState` + distilled memory. (Anthropic Agent-Teams lesson; antidote to the compaction/re-spawn bug.)
2. **Disk roster is the only membership truth** — `RunManager` reloaded per turn; never reconstruct the roster from LLM context.
3. **A2A state grammar internally** — approval gate = worker → `input-required`, writes question to scratchpad, lead surfaces it in chat, user reply resumes via `resume-cursor.ts`. No HTTP stack.
4. **Event-driven, non-blocking** — a spawn turn returns an ack immediately ("started run X"); `EventStreamManager` completion lets the lead weave "run X finished, 6/6 sprints passed — open a PR?" into a later turn.
5. **Two interrupt classes, both built** — hard stop = `abortRun()`; soft steer = `input-required` + `approval-state.ts`.

### Memory scoping (per-team / per-domain)

Identity-keyed isolation **enforced at the store layer**, not the prompt (the Mem0 standard).
Namespace = `(team, project/user, run)`. `semantic_facts` carries a `scope` column;
`.bober/memory/<namespace>/` partitions distilled episodic/procedural memory. The programming team's
lessons never leak into the medical team's recall.

### Self-improvement loop

- **P0 (do first):** fail→pass contrast extraction (mine signal the retry loop already throws away) + lesson hygiene (wire the existing `occurrences` field; add decay + conflict-quarantine). Both additive and reversible.
- **P1:** evaluator anti-degeneration guards — deterministic gate (tests/lint/compile) *before* the LLM judge runs; keep the rubric out of the generator prompt; require the evaluator to cite a failing artifact.
- **P2 then P1:** build the replay regression harness *before* turning on GEPA offline prompt evolution. **Never let the system edit itself without a deterministic, replay-gated check** — the cross-cutting defense against the biased-judge→biased-lesson→biased-generator flywheel.

Provider-agnostic and CLI-first throughout: files + SQLite + in-process adapters, runs identically
on Anthropic or DeepSeek.

---

## 6. The Medical Team — Special Considerations

### Data ingestion
- **Local SQLite, one table per metric, full timestamps** (Leo schema): `heart_rate`, `hrv`, `sleep`, `workouts`, `blood_oxygen`, `whoop_recovery`, `whoop_strain`, plus `labs(biomarker, value, unit, ref_low, ref_high, collected_at)`, `medications`, `baselines`, `preferences`.
- **Streaming adapters behind one normalization layer:** SAX/iterative XML for Apple Health (4GB-safe), auto-detect CSV for Whoop's inconsistent columns, OAuth pull for Whoop/Oura. **Dedup on (metric, timestamp, source)**.
- **Code-as-tool for ALL numerical reasoning** — generate Python/Pandas in a sandbox; never let the LLM do arithmetic on time-series (PHIA, 50% error reduction). Pre-aggregate to time-window tables before sending anything to the model.
- **Narrow MCP-style tools** (`get_metric(name,window)`, `get_lab_trend(biomarker)`, `search_literature(query)`) so the model retrieves only the slice it needs.

### Durable personal memory schema
Reuse `semantic_facts` with bi-temporal columns — *exactly* the medication-history use case.
Maintain a separate `baselines` table (resting HR, HRV baseline, VO2max trend) as durable facts
distinct from raw events; deltas-vs-baseline become the coaching signal. Preferences + goals are
first-class durable context.

### CONSERVATIVE guardrail set — the wellness/medical-device line

**The bright line (load-bearing legal fact):** a product is a *legally regulated medical device*
under FFDCA §201(h) the moment its **intended use** is "diagnosis, cure, mitigation, treatment, or
prevention of disease" — and the FDA reads intended use **broadly, from behavior and design, not
your disclaimer** ([Petrie-Flom, Harvard, May 2026](https://petrieflom.law.harvard.edu/2026/05/26/health-ai-chatbots-are-legally-medical-devices-its-time-the-fda-started-treating-them-like-it/)).
A footer disclaimer does not save you; the *absence* of guardrails preventing diagnostic use is
itself read as intent to enable a device function. The General Wellness safe harbor requires *not
referencing a specific disease* for diagnosis/treatment AND low-risk framing. The Clinical Decision
Support carve-out is **structurally unavailable** to a consumer-facing agent (its prongs target
healthcare professionals). EU MDR is stricter with no broad wellness carve-out.

**Code-enforced refusals (NOT prompt-only) — conservative posture is REFUSAL + REDIRECTION:**

| Category | Required behavior |
|---|---|
| Emergency / red-flag (chest pain, stroke, anaphylaxis, suicidal ideation, overdose) | **Detect and short-circuit BEFORE LLM reasoning** → emergency services + crisis line (988 US) |
| Specific drug dosing ("how much X") | **Refuse personalized dose**; general label-range info only + "confirm with pharmacist/prescriber" |
| Drug interactions | High-risk; ground in retrieved authoritative source, caveat heavily, **never assert safety** |
| Diagnosis from symptoms | **Do not diagnose** (the bright line into "device"); general education + clinician redirect |
| Self-harm / illicit-drug / dangerous procedures | Safety-refuse with crisis resources |

**Reliability + privacy + disclaimers:**
- **Grounded retrieve-then-synthesize, abstain when inconclusive** (OpenEvidence) for any clinical fact — never free-generate dosing/interactions; cite inline.
- **Local-first / zero-egress by default** (Leo's "zero outbound network code") — HIPAA almost certainly does not attach to a consumer-direct local tool, but FTC §5, Washington My Health My Data Act, proposed federal HIPRA, and EU GDPR do. Cloud inference: explicit opt-in, prefer no-training/zero-retention providers, never silently exfiltrate.
- **Surfaced disclaimers** (first-run consent + per-response footer), not buried — the field regressed from ~26% (2022) to <1% (2025) disclaimer presence ([npj Digital Medicine](https://www.nature.com/articles/s41746-025-01943-1)); be the outlier.
- **Local audit log** of queries + refusals; versioned record of system prompt/refusal rules/disclaimer text for defensibility.
- **Cautionary precedent (verified):** Illinois' WOPR Act (Aug 2025) bans representing AI as a substitute for human therapy — "wellness" positioning did not insulate mental-health chatbots once behavior looked like treatment. **Re-evaluate classification whenever you add a feature** — a symptom-checker or dosing calculator changes regulatory status.

**This is research synthesis, not legal advice — confirm classification with FDA/MDR counsel before
shipping anything health-facing.**

---

## 7. Risks & Open Questions

**Hardest unknowns:**
1. **Conversational supervisor coherence over long sessions** — the documented Claude-Code failure (compaction → lead loses roster → re-spawns workers, [#55586](https://github.com/anthropics/claude-code/issues/55586)). Mitigated by disk-authoritative roster, but the lead's *own* context management over a multi-hour chat is genuinely unsolved.
2. **Cheap-worker structured-output reliability on DeepSeek** — strict `json_schema` rejected, even `strict:true` tool args can emit malformed JSON ([#1069](https://github.com/deepseek-ai/DeepSeek-V3/issues/1069)). Retry-with-escalation is the safety net but raises cost on the hard 10%.
3. **Self-improvement degeneration** — biased judge → biased lesson → biased generator flywheel. The replay-gated offline-only constraint is the defense; building the replay harness *correctly* (representative held-out set) is the keystone risk.
4. **Medical regulatory exposure** — intended-use is read from behavior; one feature (symptom-checker) flips you into device territory in US *and* EU. Guardrails must be code-enforced and tested.
5. **Memory staleness ("confidently wrong")** — named, unsolved production gap; bi-temporal + confidence-decay helps but doesn't fully solve it.

**Open questions:**
- Prompt-cache economics across a mixed Anthropic-lead/DeepSeek-worker fleet.
- Where the "team-definition" lives — JSON config vs a richer DSL — and how non-engineers author a team.
- Sandbox security for medical code-as-tool execution (Python/Pandas) on a local machine.

---

## 8. Recommended Sprint-Decomposed Roadmap

Phased, CLI-first, each phase shippable. **Phase 1 is the thinnest end-to-end "chat with a
programming team that reuses `runPipeline` + memory."**

### Phase 1 — Chattable programming team (the MVP)
*A human chats a team lead in the terminal; it answers, spawns `runPipeline`, and reports back,
reusing all existing memory.*
- **S1.1** `bober chat` REPL session object wrapping `RunManager`; turn-classifier (answer | spawn | steer).
- **S1.2** Promote `RunManager` to disk-authoritative roster, reloaded per turn (compaction-safety).
- **S1.3** Wire `ChildRunner`/`runPipeline` completion → `EventStreamManager` → session inbox (ack-then-weave-later UX).
- **S1.4** TeamLead reads `.bober/memory/` distill for cross-turn continuity.
- **Ships:** "chat with your programming team" on Anthropic or DeepSeek. No new engine.

### Phase 2 — Interrupt/approve/steer in chat
- **S2.1** Add `input-required`/`paused` to `RunState` (A2A grammar).
- **S2.2** Re-point `approval-state.ts` + `resume-cursor.ts` from CLI flags → chat turns.
- **S2.3** Soft-steer + hard-stop (`abortRun`) as chat commands.
- **Ships:** mid-flight human-in-the-loop conversation.

### Phase 3 — Memory upgrade + self-improvement P0
- **S3.1** `semantic_facts` SQLite table (scope + bi-temporal + confidence).
- **S3.2** Reconcile-on-write (deterministic exact-match, LLM only on ambiguity).
- **S3.3** Lesson hygiene: wire `occurrences`, add decay + conflict-quarantine.
- **S3.4** Fail→pass contrast extractor on the retry loop.
- **Ships:** durable facts, non-rotting memory, compounding lessons.

### Phase 4 — Team abstraction generalization
- **S4.1** Extract `Team` config (roles/tools/skillPack/memoryNamespace/providers/pipeline/guardrails); refactor programming team to be one instance.
- **S4.2** Per-team memory namespacing over `.bober/memory/` + `semantic_facts.scope`.
- **S4.3** `selectPipelineEngine` resolves team-specific SOP shape.
- **Ships:** the platform — adding a team is data, not code.

### Phase 5 — Self-improvement P1/P2 (offline, gated)
- **S5.1** Replay regression harness (frozen sprint→diff pairs).
- **S5.2** Evaluator anti-degeneration guards (deterministic-first gate, rubric isolation, cite-failing-artifact).
- **S5.3** GEPA offline prompt evolution, replay-gated, Pareto-set, never live.

### Phase 6 — Medical team (highest-risk, deliberately last)
- **S6.1** Health SQLite schema + streaming ingestion adapters (Apple Health SAX, Whoop CSV, OAuth) with dedup.
- **S6.2** Code-as-tool sandbox for numerical reasoning (PHIA); narrow MCP tools.
- **S6.3** Grounded literature-retrieval subagent with abstention (OpenEvidence).
- **S6.4** Code-enforced guardrail layer (emergency short-circuit, dosing/diagnosis refusal) + first-run consent + audit log + local-first zero-egress.
- **S6.5** Regulatory review with counsel before any release.
- **Ships:** the medical team as a second `Team` instance — validating the abstraction on a hard, high-stakes domain.

**Sequencing rationale:** Phases 1–2 deliver the chattable-team UX on existing engines with near-zero
new infrastructure. Phases 3–5 harden memory and make self-improvement safe. Phase 6 is last because
it is the riskiest (legal + reliability) and is *only* a clean second instance of the abstraction
once Phase 4 exists — building it earlier would mean rebuilding it.

---

**Bottom line:** agent-bober is unusually well-positioned — it already owns the engine, the fleet,
the roster, the events, the memory, and the provider routing that most teams spend a year building.
The work is a thin persistent session layer + three generalizations + memory hygiene. Reuse
aggressively, copy algorithms not frameworks, ship the programming chat first, and treat the medical
team as a deliberately-deferred, guardrail-gated validation of the same domain-agnostic spine.
