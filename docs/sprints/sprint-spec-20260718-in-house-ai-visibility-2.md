# ApiSpineEngineProvider + deterministic MentionCitationExtractor

**Contract:** sprint-spec-20260718-in-house-ai-visibility-2  ·  **Spec:** spec-20260718-in-house-ai-visibility  ·  **Completed:** 2026-07-18

## What this sprint added

The **grounded-API-spine arm** of the in-house AI-visibility hybrid (arch-20260717-in-house-oss-ai-visibility): one engine's `AiVisibilityProvider` that turns the Sprint-1 `GroundedSearchClient` into raw AI-answer observations. `ApiSpineEngineProvider` probes a target with `samplesPerPrompt` (N) **independent** grounded-search samples per prompt and emits **one raw `AiVisibilityRow` per real observation** (never a pre-aggregate), each stamped with the engine label (`= client.engine`). Mention/citation labelling is delegated to a new **pure, synchronous, network-free** `DeterministicMentionCitationExtractor` that decides `{mentioned, citationPresent, sourceUrls}` by word-boundary brand/host string matching and host-equality URL matching alone — no LLM judge (Sprint 8), no `CitationVerifier` (Sprint 3/4). Cost is **N-baked** at construction so the locked `AiVisibilityAdapter` (which multiplies `estCostUsdPerPrompt * prompts.length` and has no notion of N) books the correct USD ceiling. **Nothing is seam-wired this sprint** — no runner/`selectSource`/factory/multiplexer/config/egress changes (all Sprint 3 nonGoals); both classes are self-contained and unit-tested against a hand-scripted fake `GroundedSearchClient`.

## Public surface

- `SampleObservation` (`src/seo/sources/mention-citation-extractor.ts:37`) — `{ mentioned: boolean; rank?: number; citationPresent: boolean; sourceUrls: string[] }`. The extractor's locked output shape; feeds `AiVisibilityRow`. `rank` is **always omitted** this sprint (no deterministic ordinal derivable from a single answer) — never `rank: undefined`.
- `MentionCitationExtractor` (`src/seo/sources/mention-citation-extractor.ts:44`) — the port: `extract({ target, answerText, citations }): SampleObservation`.
- `DeterministicMentionCitationExtractor` (`src/seo/sources/mention-citation-extractor.ts:103`) — the pure implementation. `mentioned` = target's brand token (the host's first label) **or** its bare host appears, case-insensitive **and on a word boundary**, in `answerText` or in any citation `title`. `sourceUrls` = citation URLs whose host equals the target host or is a subdomain of it (candidate URLs only, not verified). `citationPresent = sourceUrls.length > 0`. Empty/whitespace/malformed input (empty target, blank answer, no citations, un-parseable URLs) always yields `{ mentioned: false, citationPresent: false, sourceUrls: [] }` — **never a false positive** (sc-2-1).
- `ApiSpineEngineProvider` (`src/seo/sources/api-spine-provider.ts:43`) — implements `AiVisibilityProvider`. `constructor(client: GroundedSearchClient, extractor: MentionCitationExtractor, samplesPerPrompt: number, perCallUsd: number)`. `readonly name: GroundedEngine` (`= client.engine`); `readonly estCostUsdPerPrompt = perCallUsd * samplesPerPrompt` (ADR-3, N folded in once). `probe(target, prompts, locale?): Promise<AiVisibilityRow[]>` runs `prompts.length × N` samples and returns one row per successful sample, each `provider`-stamped with `this.name`.

## How to use / how it fits

`ApiSpineEngineProvider` is the ToS-clean **API spine** arm that a later sprint's `resolveAiVisibilityProvider` factory + `AiVisibilityMultiplexer` will compose onto the untouched `AiVisibilityProvider` seam. It composes the two new primitives with the Sprint-1 client:

```ts
const client = new LiveGroundedSearchClient("anthropic", llm, "sonnet"); // Sprint 1
const provider = new ApiSpineEngineProvider(
  client,
  new DeterministicMentionCitationExtractor(),
  /* samplesPerPrompt (N) */ 3,
  /* perCallUsd */ 0.05,
);
provider.estCostUsdPerPrompt; // 0.15  (0.05 * 3) — N baked in for the adapter's estCostUsdPerPrompt * prompts.length
const rows = await provider.probe("target.example", ["Who ranks for X?"]); // up to 3 rows, all provider="anthropic"
```

Each row is a single genuine `(prompt, provider, sample)` observation, so API and (future) scrape signal stay **structurally unmixable** by the distinct `provider` label. The provider does no egress gating, sanitizing, or quota accounting — those are the injected-transport `AiVisibilityAdapter`'s job (ADR-5), and this class is **not** yet wired into it.

## Notes for maintainers

- **Sample-failure contract (sc-2-4).** A single rejecting `client.search` sample is caught and `continue`d — dropped from the batch (yielding N−1 rows), never mislabelled, never merged, never a fabricated citation. If **every attempted sample across every prompt** rejects (and at least one was attempted), `probe()` **throws** rather than returning an empty-but-successful `[]`; the not-yet-wired `AiVisibilityAdapter` converts any probe throw into `abstain` + books nothing — exactly the architecture's "all fail ⇒ abstain, nothing booked" outcome. Calling `probe()` with zero prompts (or `samplesPerPrompt <= 0`) attempts nothing and returns `[]` without throwing.
- **`rank` is deliberately never emitted** this sprint — a single answer yields no deterministic ordinal. The key is omitted (not set to `undefined`); the `AiVisibilityRow.rank?` slot stays open for a later ranking sprint.
- **`sourceUrls` are candidate URLs, not verified ones.** The `CitationVerifier` call is a Sprint 3/4 nonGoal; the extractor only asserts host-equality/subdomain against the target, never that the URL resolves.
- **Word-boundary matching, not `includes`.** Brand/host matching uses `\b…\b` regex (escaped) to avoid substring false positives — brand `"ace"` must not match inside `"space"` (evaluator-reverified with a fresh script). `safeHost` prefixes a scheme when absent and `try/catch`es `new URL(...)`, so a malformed citation URL never throws and simply doesn't match.
- **No seam wiring (nonGoal, evaluator-confirmed).** `git diff --stat` shows edits to **only** the four new files — zero changes to the runner, `selectSource`, the factory, the multiplexer, config, the egress axis, or `ai-visibility-adapter.ts`. The `ai-visibility` axis therefore still routes to the offline `LocalExportSource` arm; `docs/seo.md` remains accurate until Sprint 3 wires the factory.
- **Tests use a hand-scripted fake `GroundedSearchClient`** (no `vi.mock`) — a scripted client varies mention/citation across the N samples to prove each row is a distinct observation, and a rejecting-sample script proves the drop-that-sample behaviour.

## Scope

One commit — `8a7449c` — adding `src/seo/sources/mention-citation-extractor.ts` (+ `.test.ts`, 17 tests for sc-2-1) and `src/seo/sources/api-spine-provider.ts` (+ `.test.ts`, 9 tests for sc-2-2/3/4). Scope matches `estimatedFiles` exactly and honours every nonGoal: no seam/factory/multiplexer/config/egress wiring, no `CitationVerifier`, no LLM-as-judge. All 5 required criteria (sc-2-1..2-5) passed on **iteration 1**; typecheck/build/lint clean; full suite **4756 passed | 1 skipped | 0 failed** (26 new tests, zero regressions).
