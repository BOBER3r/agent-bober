# LLM-as-judge extraction (optional fuzzy brand-mention path)

**Contract:** sprint-spec-20260718-in-house-ai-visibility-8  ·  **Spec:** spec-20260718-in-house-ai-visibility  ·  **Completed:** 2026-07-18

## What this sprint added

The deterministic `MentionCitationExtractor` (Sprint 2) decides brand mention by pure
string/host matching, so a **paraphrased** or fuzzy reference ("their bullseye logo" for
Target) reads as *unmentioned*. This sprint adds an **optional, injected LLM-as-judge second
pass** — a new `LlmJudgeMentionCitationExtractor` that **composes** the deterministic one:
it runs the deterministic pass first and, **only** when that pass left `mentioned:false` on a
non-empty answer (cost control), sanitizes the answer text and asks a **bounded, Zod-parsed**
LLM judge whether the answer fuzzily mentions the target. The judge **fails safe** to the
deterministic result on any transport error, unparseable/schema-invalid verdict, or
empty/sanitized-to-empty answer — it never fabricates `mentioned:true`. The deterministic path
stays **byte-identical** when no `llm` is injected or the judge is disabled, and the judge is
**opt-in, deterministic-by-default** (a nonGoal forbids making it the default).

## Public surface

- `LlmJudgeMentionCitationExtractor` (`src/seo/sources/mention-citation-extractor.ts:268`) —
  optional injected extractor implementing `MentionCitationExtractor`. Constructor
  `(deterministic: DeterministicMentionCitationExtractor, llm: LLMClient, model: string,
  sanitizer: ContentSanitizer)`. `extract()` is now **async**: deterministic pass first →
  return verbatim if it matched (no judge call) → else sanitize + one `llm.chat({ jsonObjectMode:
  true })` judge turn → parse → apply the verdict's `mentioned`/`rank` only (never touches
  `citationPresent`/`sourceUrls`, which always come from the deterministic pass).
- `JudgeVerdictSchema` / `JudgeVerdict` (`:169` / `:173`) — the bounded verdict schema
  `{ mentioned: boolean, rank?: positive int }`; the only shape the judge may return.
- `parseJudgeVerdict(rawText)` (`:185`) → `ParseJudgeVerdictResult` (`:175`,
  `{ ok:true; verdict } | { ok:false; error }`) — a **never-throws** 3-tier parser (direct
  JSON → fenced ```` ```json ```` block → first `{…}` span, then `safeParse`), mirroring the
  medical `validateGroundingVerdict` idiom. Total failure returns `{ ok:false }` so the caller
  fails safe rather than propagating a throw.
- `config.seo.aiVisibility.judge` (`src/config/schema.ts:758`) — new optional object
  `{ enabled: boolean (default false), model?: string }`. **No outer default** (mirrors
  `serp`/`aiVisibility`): omitting `judge` entirely leaves `parse({ aiVisibility: {} })`
  byte-identical (leaks only `samplesPerPrompt`/`engines`). The judge is off by default even
  when the object is present but `enabled` is omitted.
- `MentionCitationExtractor.extract()` return type **widened** to
  `SampleObservation | Promise<SampleObservation>` (`:64`) so both the sync deterministic and
  async judge extractors satisfy the port; this forced a single `await` at
  `api-spine-provider.ts:96` (the sole caller — `probe()` was already async, so behavior is
  preserved).

## How to use / how it fits

Intended config once wired (see the limitation below):

```jsonc
"aiVisibility": {
  "engines": [{ "engine": "anthropic", "perCallUsd": 0.02 }],
  "judge": { "enabled": true, "model": "claude-…" }  // model optional; omit to use the injected default
}
```

The judge is a **cost-controlled fuzzy backstop**, not a replacement: it only spends an LLM
call on answers the cheap deterministic pass already missed, only over already-**sanitized**
text (sc-8-4 — the judge never sees raw scraped/answer content), and only ever *upgrades* a
missed mention. It reuses the existing provider-agnostic `LLMClient` via injection (no new
provider, a nonGoal) and the existing `ContentSanitizer`; it is **not** used for citation-URL
verification (that stays `CitationVerifier`'s job).

## Notes for maintainers

- **KNOWN LIMITATION — the flag is currently INERT.** `LlmJudgeMentionCitationExtractor` is
  exported and unit-tested but **not yet wired into the production factory**:
  `resolveAiVisibilityProvider` / `runner.ts` still construct the plain
  `DeterministicMentionCitationExtractor` with no `llm`. **A user who sets
  `config.seo.aiVisibility.judge.enabled: true` today gets no behavior change and no warning** —
  nothing reads the flag to build the judge extractor. This is an in-contract deferral (the
  briefing explicitly kept factory wiring out of scope, and the contract's `estimatedFiles`
  excluded it); the evaluator recorded it as a medium follow-up. **The orchestrator plan folds
  the wiring into Sprint 11** (`resolveAiVisibilityProvider` reading `judge.enabled`/`judge.model`
  to construct the judge arm). Until then, treat `judge` as a reserved-but-inert config key.
- **Fail-safe is load-bearing, not incidental.** The judge only ever runs on a deterministic
  *miss*; empty/whitespace answers and sanitizer-drops-to-`""` short-circuit **before** any LLM
  call (spend + false-positive protection); a thrown `llm.chat` or an unparseable/schema-invalid
  verdict returns the deterministic result verbatim. `mentioned:true` is never fabricated.
- **`rank` is omitted, never `undefined`.** The verdict's `rank` is only copied onto the
  `SampleObservation` when present, matching the deterministic extractor's shape contract.
- **Deterministic-only is byte-identical.** The 16 Sprint-2 tests and
  `schema.test.ts:1089-1096` are untouched and green; judge off / `llm` absent ⇒ deep-equal to
  the deterministic output with zero `llm` calls.

## Scope

One commit — `7ad36d1` — four files, +500/−10: `src/seo/sources/mention-citation-extractor.ts`
(the judge extractor + `JudgeVerdictSchema` + never-throws `parseJudgeVerdict` + widened port;
`DeterministicMentionCitationExtractor` byte-identical), `src/config/schema.ts` (the optional
`judge` object), `src/seo/sources/api-spine-provider.ts` (single-line `await` forced by the
widened interface), and `src/seo/sources/mention-citation-extractor.test.ts` (+21 tests via a
scripted/throwing fake `LLMClient`; the 16 Sprint-2 tests unedited). All 5 required criteria
(sc-8-1..8-5) passed on **iteration 1**; typecheck/build/lint clean; full suite **4880 passed |
1 skipped | 0 failed** (+20 new, 0 regressions). No new dependency.
