# Perplexity Sonar engine — third grounded arm

**Contract:** sprint-spec-20260718-in-house-ai-visibility-7  ·  **Spec:** spec-20260718-in-house-ai-visibility  ·  **Completed:** 2026-07-18

## What this sprint added

Through Sprint 6 the in-house grounded-API spine had two live arms — `anthropic` and `openai`
— both `LiveGroundedSearchClient`s wrapping an injected `LLMClient.chat` turn. `"perplexity"`
was a valid `GroundedEngine` enum value but **type-only**: no mapper, no client, and
`defaultMakeClient` returned `undefined` for it unconditionally. This sprint lands the real
third arm. Perplexity Sonar is a **direct HTTP `chat/completions` API**, not reachable through
`LLMClient.chat`, so it gets its own `GroundedSearchClient` implementation —
**`PerplexitySonarClient`** — that speaks HTTP itself through an injectable fetch-like
transport, reads its key from `PERPLEXITY_API_KEY`, and maps Sonar's `search_results` /
`citations` payload into normalized `GroundedAnswer.citations`. It composes as a third engine
labeled `"perplexity"` into the untouched `AiVisibilityMultiplexer` with **no logic change** to
the generic composer — the only wiring is an early branch in `runner.ts`'s `defaultMakeClient`.

## Public surface

- `PerplexitySonarClient` (`src/providers/grounded-search.ts:240`) — the third
  `GroundedSearchClient` (`engine: "perplexity"`). Constructor
  `(transport?, getApiKey?, model?)` — all three optional, defaulting to a real global-`fetch`
  wrapper, `() => process.env["PERPLEXITY_API_KEY"]`, and `"sonar"` respectively, so production
  wiring needs no arguments while tests stub every seam. `search(prompt, locale?)`
  (`:257`) POSTs one Sonar turn to `https://api.perplexity.ai/chat/completions` and returns a
  `GroundedAnswer`. **Never throws** (sc-7-1): a missing key, an `!res.ok` response, a network
  error, or malformed JSON all degrade to `{ answerText: "", citations: [] }`. `costUsd` is
  intentionally **omitted** (cost is N-baked upstream via the engine's `perCallUsd`).
- `defaultMakeClient` (`src/seo/runner.ts:174`) — now has an **early `perplexity` branch**
  (`:175`): with `PERPLEXITY_API_KEY` unset it returns `undefined` (arm skipped, no-key-safe);
  with the key present it constructs `new PerplexitySonarClient()` **directly**, bypassing
  `createClient`/`LLMClient` (Sonar is not an `LLMClient` provider, so the generic path has no
  `perplexity` entry and would otherwise return `undefined`).

Everything Perplexity-specific — the endpoint/model consts, the local
`SonarChatCompletionResponse` / `SonarSearchResult` response shapes, the `PerplexityTransport`
/ `PerplexityTransportResponse` transport types, the `defaultPerplexityTransport`, and the
`mapSonarCitations` helper — stays **local and unexported** to `grounded-search.ts` (sc-7-4).
Only `PerplexitySonarClient` (which implements the provider-agnostic `GroundedSearchClient`) is
exported; no Perplexity SDK/type crosses `src/providers/`.

## Citation mapping

`mapSonarCitations` (`src/providers/grounded-search.ts:221`) normalizes a Sonar response into
`GroundedCitation[]`, mirroring the `title ?? url` fallback used by the Anthropic/OpenAI mappers:

- **Prefers `search_results[{ title, url }]`** — the richest shape (carries a title). Filters
  to entries with a string `url`, maps each to `{ url, title: title ?? url }`.
- **Falls back to the plain `citations[]` URL array** when `search_results` is absent/empty —
  each URL doubles as its own title.
- **`[]` when both are absent/empty** (ungrounded answer). Because `search` never throws,
  missing grounding degrades to `citations: []` and the adapter abstains upstream.

## How to use / how it fits

Add `perplexity` to your `seo.aiVisibility.engines` and export `PERPLEXITY_API_KEY`:

```jsonc
"aiVisibility": {
  "samplesPerPrompt": 5,
  "engines": [
    { "engine": "anthropic",  "perCallUsd": 0.02 },
    { "engine": "openai",     "perCallUsd": 0.01 },
    { "engine": "perplexity", "perCallUsd": 0.03 }
  ]
}
```

With the axis on and the key present, `resolveAiVisibilityProvider` composes a third
`ApiSpineEngineProvider` arm labeled `"perplexity"` into the `AiVisibilityMultiplexer`. The
multiplexer fans `probe()` out to all three arms in parallel (`Promise.allSettled`) and
**concatenates** their rows — arms are never merged, each `AiVisibilityRow` keeps its own
`provider` label. Its `estCostUsdPerPrompt` is the plain **sum** of all configured arms'
already-N-baked prices (verified: three engines at `perCallUsd` 0.02/0.01/0.03 with N-baking
sum to `0.24`; drop the unkeyed Perplexity arm and two arms sum to `0.12`). Configure
`perplexity` but leave `PERPLEXITY_API_KEY` unset and the arm is simply **omitted** — the run
is no-key-safe, exactly as for the other engines.

## Notes for maintainers

- **Perplexity does NOT route through `createClient`/`LLMClient`.** Sonar is BYOK HTTP. The
  early `defaultMakeClient` branch that constructs `PerplexitySonarClient` directly is
  load-bearing — without it, `perplexity` falls through to the generic path (which has no
  `perplexity` entry in either the model or key-env table) and returns `undefined`, so the arm
  never composes and sc-7-2 fails end-to-end. `runner.ts` was edited even though it was absent
  from `estimatedFiles` for exactly this reason.
- **Injected transport is the only network seam.** `PerplexitySonarClient` introduces this
  file's sole `fetch` reference, behind `defaultPerplexityTransport`. Tests inject a fake
  transport and assert `calls.length === 0` when the key is unset — no real socket ever opens.
- **Keep the Sonar types local.** The response/transport types are deliberately unexported and
  do not import from `src/seo/` (the `PerplexityTransportResponse` shape mirrors
  `seo/adapters/http.ts` `HttpResponse` in shape only, defined locally). A grep for a Sonar
  payload/transport type outside `src/providers/` must stay empty (sc-7-4).
- **No SDK, no new dependency, no schema change.** The `perplexity` enum value already existed
  (Sprint 1); the model default (`"sonar"`) lives on the client itself, so there is no entry in
  runner.ts's `AI_VISIBILITY_DEFAULT_MODEL` / `AI_VISIBILITY_KEY_ENV` tables for it.
- **NonGoals respected.** No Gemini / Google AI-Overviews path, no scrape arm (Sprint 10), no
  hardcoded key.
- **Live smoke coverage still absent.** As with the rest of the spine, every test injects fake
  deps; end-to-end validation of a real Sonar call needs a live `PERPLEXITY_API_KEY`.

## Scope

One commit — `f04c99a` — five files, +375/−10: `src/providers/grounded-search.ts`
(the client + local Sonar types + `mapSonarCitations`; `LiveGroundedSearchClient` untouched)
and `src/providers/grounded-search.test.ts` (+10 tests via a fake transport: engine identity,
`search_results`-preferred / `citations`-fallback / `[]`-when-absent mapping, never-throws,
no-real-network); `src/seo/runner.ts` (the `defaultMakeClient` early branch + stale doc-comment
updates); `src/seo/ai-visibility-provider.test.ts` (+2 tests: three-engine composition sum
`0.24` + perplexity-omitted-when-unkeyed); `src/seo/ai-visibility-provider.ts` (doc-only header
note, no logic change). All 5 required criteria (sc-7-1..7-5) passed on **iteration 1**;
typecheck/build/lint clean; full suite **4860 passed | 1 skipped | 0 failed** (+12 new, 0
regressions).
