# GroundedSearchClient — Anthropic + OpenAI web_search provider extension

**Contract:** sprint-spec-20260718-in-house-ai-visibility-1  ·  **Spec:** spec-20260718-in-house-ai-visibility  ·  **Completed:** 2026-07-18

## What this sprint added

The **riskiest-first building block** of the in-house AI-visibility hybrid (arch-20260717-in-house-oss-ai-visibility, "BYOK grounded-API spine + gated damcrawler scrape arm"): a **provider-agnostic `GroundedSearchClient`** under `src/providers/` that runs one web-search-grounded LLM turn and normalizes the vendor-native citation payload into a plain `GroundedAnswer{ answerText, citations[{url,title}], costUsd? }`. `LiveGroundedSearchClient` wraps an **injected** `LLMClient.chat` with a `web_search` `ToolDef` and maps Anthropic `web_search_result_location` / OpenAI `url_citation` payloads into normalized citations. This is the ToS-clean "API spine" primitive that a later sprint's `ApiSpineEngineProvider` will call once per (prompt, engine, sample). One additive optional carrier — `ChatResponse.groundingCitations` — was added to `providers/types.ts` as the citation-transport contract. **No vendor SDK type crosses the `src/providers/` boundary** (sc-1-4); **nothing is seam-wired into `src/seo/` yet** (nonGoal); and **no real adapter populates `groundingCitations` yet** — this sprint is the tested, self-contained client that a later sprint plugs a live client into.

## Public surface

- `GroundedEngine` (`src/providers/grounded-search.ts:34`) — `"anthropic" | "openai" | "perplexity"` union. `"perplexity"` is type-only this sprint (its engine impl is Sprint 7, a nonGoal here) — `search` returns `citations: []` for it without throwing.
- `GroundedCitation` (`src/providers/grounded-search.ts:37`) — `{ url: string; title: string }`; the minimal normalized citation shape (`cited_text` is intentionally dropped).
- `GroundedAnswer` (`src/providers/grounded-search.ts:43`) — `{ answerText: string; citations: GroundedCitation[]; costUsd?: number }`; the normalized result of one grounded turn. `costUsd` follows the `ChatResponse.costUsd` convention — key **omitted** (never `undefined`) when unknown.
- `GroundedSearchClient` (`src/providers/grounded-search.ts:56`) — the provider-agnostic surface: `{ readonly engine: GroundedEngine; search(prompt: string, locale?: string): Promise<GroundedAnswer> }`.
- `LiveGroundedSearchClient` (`src/providers/grounded-search.ts:102`) — `constructor(engine, llm: LLMClient, model: string)`. Constructor-injects the `LLMClient` (mirrors `SeoAnalyzer(llm, model)`); its `search` runs one `chat` turn with the `web_search` tool and normalizes `res.groundingCitations`.
- `ChatResponse.groundingCitations?` (`src/providers/types.ts:286`) — new **optional, default-absent** carrier `{ url: string; title?: string; cited_text?: string }[]`. The vendor-native superset a per-adapter response mapper will populate; **no adapter fills it yet** (see maintainer notes).

## How to use / how it fits

`LiveGroundedSearchClient` never constructs a real provider client itself — the caller injects one (built by `createClient`/`factory.ts` at wiring time, a later sprint). Given an injected client and a model, one grounded turn is:

```ts
const client = new LiveGroundedSearchClient("anthropic", llm, "sonnet");
const answer = await client.search("Who ranks for X in the EU?", "en-GB");
// answer.answerText  -> the model's text
// answer.citations   -> normalized [{ url, title }] (title falls back to url when absent)
// answer.costUsd     -> present only when the underlying chat reported a cost
```

The `search` call builds a `web_search` `ToolDef` (expressed via the existing `ToolDef` surface, not a vendor-specific tool type), threads an optional `locale` into the system prompt, and dispatches to the per-engine citation mapper by `engine`. Within the in-house AI-visibility architecture this client is the **API spine** primitive: the ToS-clean default arm that later composes into `ApiSpineEngineProvider` → `AiVisibilityMultiplexer` → the existing `AiVisibilityProvider` seam. It does **not** touch `src/seo/`, the router, the multiplexer, the scorer, the verifier, or any config axis this sprint (all nonGoals).

## Notes for maintainers

- **`ChatResponse.groundingCitations` has no live producer yet.** `anthropic.ts`'s `normalizeContent` still **drops** `web_search` citation blocks, so no real adapter populates the field today — it is the contract a later sprint fills. `LiveGroundedSearchClient` already reads and normalizes it, exercised end-to-end via a **scripted** `LLMClient` in tests. A live grounded call returns `citations: []` until that adapter-population sprint lands.
- **No-grounding never throws (sc-1-3).** `search` guards `res.groundingCitations ?? []` before mapping, so a response that didn't ground its answer yields `citations: []` — not an error. The field being **absent** (key omitted) rather than an empty array is deliberate: it lets a future upstream distinguish "not grounded" from "grounded with zero sources" if that ever matters.
- **No SDK leak (sc-1-4, principle).** `grounded-search.ts` imports **only** `./types.js`. `GroundedAnswer`/`GroundedCitation`/`GroundedEngine` are plain provider-agnostic types — no `@anthropic-ai/sdk` or `openai` type crosses the file boundary. The evaluator grep confirmed no new SDK import outside `src/providers/` (only the two pre-existing guard strings).
- **`perplexity` is type-only.** It satisfies the sc-1-1 union but has no mapper — `search` returns `citations: []` for it. Its real engine impl is Sprint 7.
- **Not exported from `src/index.ts`.** The re-export was skipped (optional); consumers import directly from `src/providers/grounded-search.js`.
- **`cited_text` is intentionally dropped** by both mappers — `GroundedCitation` carries only `{ url, title }` (arch doc §247). `title` falls back to `url` when the raw citation omits it.

## Scope

One commit — `f424371` — adding `src/providers/grounded-search.ts` (the client + types + `web_search` `ToolDef` + per-engine mappers), `src/providers/grounded-search.test.ts` (10 tests with a scripted `LLMClient`: Anthropic/OpenAI citation mapping, `cited_text` drop, locale threading, no-grounding-never-throws, `perplexity` returns `[]`, `costUsd` pass-through, engine identity), and one additive optional field on `ChatResponse` in `src/providers/types.ts`. `anthropic.ts`/`openai.ts` were **not** modified (real-adapter `groundingCitations` population deferred, documented). Scope matches `estimatedFiles` + all nonGoals: no seam wiring, no `AiVisibilityProvider`/multiplexer/factory/scorer/verifier, no Perplexity impl, no `src/seo/` touch. All 5 required criteria (sc-1-1..1-5) passed on **iteration 1**; typecheck/build/lint clean; full suite **4730 passed | 1 skipped | 0 failed** (grounded-search 10/10, zero regressions).
