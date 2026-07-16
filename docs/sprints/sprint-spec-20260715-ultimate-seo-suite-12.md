# Adversarial verifier agent + opt-in downgrade-only stage

**Contract:** sprint-spec-20260715-ultimate-seo-suite-12  ·  **Spec:** spec-20260715-ultimate-seo-suite  ·  **Completed:** 2026-07-16

## What this sprint added

The **false-positive control** for the SEO pipeline: an opt-in, adversarial second opinion that runs immediately after the citation gate and can only ever *weaken* a recommendation, never strengthen or add one. Two artefacts land: (1) `SeoRecommendationVerifier` (`src/seo/verifier.ts`) — a single-shot, fail-closed stage that hands the citation-gate's cited findings to a fresh-context LLM adversary and folds the returned verdicts **downgrade-only**; and (2) the `bober-seo-verifier` agent (`agents/bober-seo-verifier.md`) — a tool-less, contract-free system prompt whose whole job is to try to *disprove* each finding. The stage is gated on `config.seo.verifier.enabled` (default `false`, pre-existing from Sprint 1), so a run that omits it is **byte-identical** to the Sprint-11 no-verifier pipeline: no verifier is constructed and no provider call is made. It is wired into `SeoWorkflowRunner` at the previously-documented seam between the citation gate and report persistence/hub emission. Both artefacts mirror the security-audit precedent (`bober-security-verifier` + `src/orchestrator/security-verifier-agent.ts`), so the adversarial-verifier discipline is now identical across the security and SEO pipelines.

## Public surface

- `SeoRecommendationVerifier` (`src/seo/verifier.ts:210`) — the opt-in stage. `verify(params: SeoVerifyParams): Promise<SeoVerifyResult>`; **never throws** — every failure (disabled flag, agent-md load error, provider/transport error, unparseable/wrong-shape response) resolves `{ ran: false, findings }` with the input findings returned **by the same reference** (fail-closed).
- `SeoVerifier` (`verifier.ts:66`) — the injectable interface (`verify(...)`), the seam `runner.test.ts` stubs; mirrors `SeoRunInput.analyzer`.
- `SeoVerifyParams` (`verifier.ts:48`) — `{ findings, config, projectRoot, now, llm? }`. `now` is the injected wall-clock snapshot (the verifier never reads the clock); `llm` is a test-injection seam (default = a real client via `createClient`).
- `SeoVerifyResult` (`verifier.ts:59`) — `{ ran: boolean; findings: SeoFinding[] }`. `ran: false` ⇒ `findings` is the **unchanged** input; `ran: true` ⇒ `findings` is the folded subset (severities only ever lowered, findings only ever dropped).
- `config.seo.verifier.enabled` (`src/config/schema.ts:688`, default `false`) — the sole gate. Set `true` to opt the stage in. (Config key pre-existed from Sprint 1; this sprint is the first to *read* it.)
- `bober-seo-verifier` agent (`agents/bober-seo-verifier.md`) — `tools: []`, `model: sonnet`; loaded as the verifier's `system` prompt via `loadAgentDefinition`. Fresh-context, contract-free, downgrade-only; verdict vocabulary is exactly `confirmed | downgraded | disproved`.
- `SeoRunInput.verifier?` (`src/seo/runner.ts:81`) — test-injection seam for the stage; default = a real `SeoRecommendationVerifier`, constructed **only** when the flag is on.
- Barrel `src/seo/index.ts` — additive re-exports of `SeoRecommendationVerifier` + the `SeoVerifier`/`SeoVerifyParams`/`SeoVerifyResult` types.

## The downgrade-only structural guarantee

The verifier can only ever produce a **strict subset** of its input findings, with severities moving **only down** — never up, never added. This is structural, not trusted from the model, and holds at three layers:

1. **The verdict vocabulary is closed** — the zod `SeoVerdictSchema` (`verifier.ts:72`) accepts only `confirmed | downgraded | disproved`. There is no `promote`/`raise`/`add` verdict the model could emit; any out-of-enum value fails `safeParse` and fail-closes the whole stage to `ran: false`.
2. **The fold has no raising/adding branch** — `applyVerdicts` (`verifier.ts:190`) iterates the **original** findings array and, per index, either drops it (`disproved`), lowers its severity by exactly one floored at 1 (`downgraded` → `Math.max(1, severity - 1)`), or keeps it byte-unchanged (`confirmed`, *or* any unaddressed/out-of-range index the model invented). There is no code path that pushes a finding not already in the input or that increases a severity. A model that returns `index: 99` (out of range) or omits a finding is a no-op on that finding — fail-closed by default.
3. **The gate decision is never recomputed from the verifier** — the runner derives `gate.blocked`/`exitCode` from the **untouched** citation gate before the verifier runs (`runner.ts`); the verifier's output replaces only the `cited` list that is persisted/emitted. A verifier failure therefore structurally cannot change the run's exit code or block decision (sc-12-4).

The `bober-seo-verifier` agent prompt reinforces this at the model layer ("you can only confirm, downgrade, or disprove... NEVER add a finding... NEVER upgrade or raise a finding's severity") — but even a misbehaving model cannot escape the structural fold above.

## Fail-closed on every failure path

`verify()` returns `{ ran: false, findings }` (input unchanged) on: the disabled flag (checked in `verify` itself as defense-in-depth, so a direct caller that bypasses the runner still makes zero provider calls); a `loadAgentDefinition` failure; any provider/transport error (the injected `llm.chat` throwing); and any parse failure — the 3-tier defensive extraction (raw `JSON.parse` → fenced ```` ```json ```` block → first-`{`-to-last-`}` span) plus zod `safeParse`, mirroring the analyzer's parser verbatim. An unparseable or truncated adversary response is therefore indistinguishable from "never ran": the citation gate's findings are kept as-is. This is symmetric with the analyzer's own fail-closed contract — a broken verifier never silently drops or manufactures a finding.

## Byte-identical when disabled (the default)

With `config.seo.verifier.enabled` absent or `false` (the default), the runner **never constructs** a `SeoRecommendationVerifier` and **never calls** `verify()` — the `cited` list handed to persistence/hub-emit is exactly `gate.cited`, identical to the Sprint-11 pipeline. The runner tests prove this two ways: a verifier spy records zero calls, and the resulting report deep-equals the no-verifier report. This is the contract's headline non-goal ("Do not make the verifier default-on") made structural.

## How to enable it

The stage is opt-in via one config flag under the `seo` section in `.bober/config.*`:

```jsonc
{
  "seo": {
    "verifier": { "enabled": true }   // default false; when off the run is byte-identical to no-verifier
  }
}
```

When enabled, every `bober seo <workflow>` run inserts the adversarial pass between the citation gate and report persistence. It uses the `sonnet` model (`DEFAULT_SEO_VERIFIER_MODEL`, `verifier.ts:88` — `config.seo.verifier` has no `model` field, so this is the sole default) and needs whatever provider credentials that client requires. If the verifier fails for any reason, the run proceeds exactly as if it were disabled — the exit code and hub emission are unaffected.

## How it fits

This sprint fills the seam Sprint 11 left as a documented comment at `runner.ts:282`. The runner now reads `gate.cited`, optionally folds it through the verifier, and persists/emits the (possibly shrunk) list — while continuing to derive the pass/blocked verdict from the untouched citation gate. It is the money-vertical safeguard for the whole suite: the SEO analyzer surfaces recommendations for iGaming/crypto-DeFi/SaaS verticals where a hallucinated citation or an overstated severity has real cost, and this adversarial pass is the second, independent set of eyes that can quietly drop or downgrade a weak claim before it reaches the priority hub — without ever being able to invent one.

The design deliberately mirrors the security pipeline's `bober-security-verifier` + `security-verifier-agent.ts` fold (same downgrade-only semantics, same `ran: false` fail-closed shape, same fresh-context/tool-less agent), so a maintainer familiar with the security auditor's adversarial verifier will recognize every seam here.

## Notes for maintainers

- **This is a single `llm.chat` call, not an agentic loop.** Unlike the security verifier (which runs an agentic loop with Read/Grep/Glob to re-check local evidence), the SEO verifier is tool-less and one-shot: SEO findings cite **external** primary-source URLs, and there is no local evidence to re-inspect. The agent prompt says so explicitly and has `tools: []`. Do not add tools to it.
- **The disabled gate is checked at two layers on purpose** (defense-in-depth). The runner skips constructing the verifier at all when off (so a disabled run makes zero provider calls, sc-12-2), and `verify()` itself short-circuits on the flag so a caller that constructs a `SeoRecommendationVerifier` directly can't accidentally trigger a provider call either. Keep both.
- **`verify()` must never throw.** It is an opt-in stage whose failure must never flip the run's exit code. This is the key divergence from `SeoAnalyzer.analyze`, which deliberately *propagates* transport errors. Do not "clean up" the broad `try`/`catch` — the no-throw is a tested guarantee (sc-12-3/sc-12-4).
- **Severity lowering is floored at 1.** `SeoFinding.severity` is a `1..5` union; `downgraded` computes `Math.max(1, severity - 1)` and casts back to the union (safe: `severity - 1` is always `0..4`, floored to `1..4`). A severity-1 finding that is `downgraded` stays at 1 — it never falls to 0 or drops.
- **The verifier never touches `humanApprovalRequired`.** The agent may *note* in its `reason` that a finding should have been flagged, but it cannot change the flag — only confirm/downgrade/disprove the finding as a whole. That flag stays owned by the analyzer + the `human-approve` policy-class lookup (Sprint 10).

## Scope

One commit — `fb7f7f8` — creating `src/seo/verifier.ts` (262 lines), `agents/bober-seo-verifier.md` (103), and `src/seo/verifier.test.ts` (442; 18 tests), plus additive edits to `src/seo/runner.ts` (+44/−9, wire the stage at the gate→persist seam) and `src/seo/index.ts` (+3, barrel re-exports), and 3 new runner tests (`src/seo/runner.test.ts`, +106). No analyzer/citation-gate/hub-emitter/schema/egress/governor/adapters/skills touched; the config key `seo.verifier.enabled` pre-existed (Sprint 1) and is only now *read*; no new dependencies. All 5 required criteria (sc-12-1..12-5) passed on **iteration 1**; full suite **4492 passed | 1 skipped | 0 failed** (`src/seo` 202).
