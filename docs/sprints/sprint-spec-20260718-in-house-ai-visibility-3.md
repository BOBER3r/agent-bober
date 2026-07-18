# Seam wiring — axis + config + factory + multiplexer + selectSource (first live slice)

**Contract:** sprint-spec-20260718-in-house-ai-visibility-3  ·  **Spec:** spec-20260718-in-house-ai-visibility  ·  **Completed:** 2026-07-18

## What this sprint added

The **first live slice** of the in-house AI-visibility hybrid: the `ai-visibility` axis
now routes to a real, in-house **grounded-API spine** end-to-end instead of the offline
`LocalExportSource`. This sprint wires the Sprint-1 `GroundedSearchClient` + Sprint-2
`ApiSpineEngineProvider` primitives onto the untouched `AiVisibilityProvider` seam via a
new `resolveAiVisibilityProvider` factory (mirroring `resolveSerpProvider`) and a new
`AiVisibilityMultiplexer` that fans one probe out to every configured+keyed engine and
**concatenates** their rows (never merged — each `AiVisibilityRow` keeps its own
`provider` label). It also adds a **fifth**, default-off `ai-visibility-scrape` egress
axis (axis-only — composes no provider until Sprint 10) and the new `config.seo.aiVisibility`
Zod schema. Two load-bearing invariants are preserved and evaluator-verified:
**byte-identical-when-off** (the all-off predicate still returns `LocalExportSource` before
any governor/socket, and the scrape axis is excluded from it) and **no-key-safe** (the
factory returns `undefined` — offline fallback — when the axis is off, `aiVisibility` is
absent/empty, or no configured engine has an API key). The locked `AiVisibilityProvider`
port, `AiVisibilityRow` shape, and `AiVisibilityAdapter` body are byte-unchanged.

## Public surface

- `SeoEgressAxis` (`src/seo/egress.ts:9`) — union widened 4 → **5** with `"ai-visibility-scrape"`. `SeoEgressGuard` gains a 5th defaulted ctor param, a `fromConfig` read (`egress.ts:48`), and an exhaustive-switch `isAllowed` case (`egress.ts:63`). The ~99 existing 2–4-arg `new SeoEgressGuard(...)` call sites keep compiling untouched.
- `config.seo.egress["ai-visibility-scrape"]` (`src/config/schema.ts:691`) — `z.boolean().default(false)`. Reserves the egress gate for the future UI-scrape arm; composes no provider this sprint.
- `config.seo.aiVisibility` (`src/config/schema.ts:729`) — **optional, no outer default** (mirrors the `serp` idiom; omitting it is byte-identical). `{ samplesPerPrompt: number int > 0 (default 5); engines: { engine: "anthropic" | "openai" | "perplexity"; perCallUsd: number ≥ 0 (default 0) }[] (default []) }`.
- `AiVisibilityDeps` (`src/seo/ai-visibility-provider.ts:35`) — the injected seam: `{ makeClient(engine): GroundedSearchClient | undefined; extractor: MentionCitationExtractor }`. `makeClient` returning `undefined` (no usable key) means that arm is skipped, never composed.
- `AiVisibilityMultiplexer` (`src/seo/ai-visibility-provider.ts:50`) — `implements AiVisibilityProvider`. `name = "ai-visibility-multiplexer"`; `estCostUsdPerPrompt` = plain **sum** of the arms' already-N-baked prices (no re-multiply). `probe()` (`:69`) uses `Promise.allSettled` over the arms, concatenates fulfilled rows, and — when there is ≥1 arm and **every** arm rejects — rethrows (so the locked adapter degrades to abstain and books nothing) rather than resolving `[]`.
- `resolveAiVisibilityProvider(config, egress, deps)` (`src/seo/ai-visibility-provider.ts:100`) — the selection factory. Returns `undefined` when `ai-visibility` is off, `config.seo.aiVisibility` is absent, `engines` is empty, or every `deps.makeClient` returns `undefined`; otherwise composes one `ApiSpineEngineProvider` per keyed engine into an `AiVisibilityMultiplexer`.
- `selectSource(config, projectRoot, deps?)` (`src/seo/runner.ts:307`) — gains an **optional 3rd `deps` param** (production call sites stay 2-arg). Its `ai-visibility` branch now routes `new AiVisibilityAdapter(egress, governor, provider)` when the factory returns a defined provider, else the offline `LocalExportSource` (`runner.ts:384`).

## How to use / how it fits

Turn the axis on **and** configure at least one keyed engine; anything less falls back to
offline:

```jsonc
"seo": {
  "egress": { "ai-visibility": true },   // axis on
  "aiVisibility": {
    "samplesPerPrompt": 5,               // N grounded-search samples per prompt per engine
    "engines": [
      { "engine": "anthropic", "perCallUsd": 0.02 }  // needs ANTHROPIC_API_KEY
    ]
  }
}
```

With `ANTHROPIC_API_KEY` present, a `bober seo ai-visibility <target>` run now probes the
live grounded-API spine: `selectSource` calls `resolveAiVisibilityProvider(...)`, which
composes an `ApiSpineEngineProvider` arm (via the production `defaultMakeClient`,
`runner.ts:167`) into an `AiVisibilityMultiplexer` behind the `AiVisibilityAdapter`. The
governor books `Σ(perCallUsd × N) × prompts.length` — proven end-to-end in the sc-3-4
test: two fake engines (`0.01`, `0.02`, N=2) over 2 prompts yield 8 rows (2 engines × 2
samples × 2 prompts, 4 per provider) and `governor.spentUsd() === 0.12`. Omit the config,
the engine key, or the axis and the axis is byte-identical to the offline arm.

## Notes for maintainers

- **No-key-safe production path.** `defaultMakeClient` (`runner.ts:167`) reads `anthropic` → `ANTHROPIC_API_KEY`, `openai` → `OPENAI_API_KEY` and returns `undefined` when the key is absent, so a misconfigured/no-key run never opens a socket or throws the zero-network guard. `defaultAiVisibilityDeps` (`runner.ts:176`) pairs it with the deterministic `MentionCitationExtractor` (Sprint 2).
- **Per-engine model is hardcoded** (`AI_VISIBILITY_DEFAULT_MODEL`, `runner.ts`): `anthropic` → the default SEO model, `openai` → `gpt-4.1`. The config carries no per-engine `model` field yet — promote to config if a project needs a different model. `"perplexity"` has **no** map entry (no `createClient` provider until Sprint 7) — it is intentionally absent, not merely unset, so configuring it yields zero rows from that arm rather than an error.
- **`ai-visibility-scrape` is axis-only this sprint.** It exists in the egress union + config but composes no provider (Sprint 10) and is deliberately **excluded** from `selectSource`'s all-off byte-identical predicate — that predicate reads only the four data axes, so an all-off run still returns `LocalExportSource` before the governor loads or any socket opens.
- **Multiplexer failure semantics.** One arm rejecting drops only its rows; **all** arms rejecting rethrows (never resolves `[]`) — resolving `[]` would let the adapter book USD for zero rows on a total outage. The `async (arm) => arm.probe(...)` wrapper also captures a *synchronous* throw from a misbehaving arm as a rejected promise.
- **Locked files byte-unchanged** (`git diff --stat` empty on them): the `AiVisibilityProvider` port, `AiVisibilityRow`, `AiVisibilityAdapter`, and `ApiSpineEngineProvider`. This sprint is pure seam wiring — no `CitationVerifier`, scorer, tracked-prompt store, Perplexity mapper, LLM-judge, or scrape arm (all later-sprint nonGoals).
- **Production builder path is not exercised by tests** — every test injects fake `deps`, keeping the suite network-free. Live validation needs real engine keys (follow-up smoke).
- Minor: the generator report overstated one test count (claimed `schema.test` 145, actual 120) — reporting inaccuracy only, no code defect (eval `generatorFeedback`).

## Scope

One commit — `e777f3a` — matching `estimatedFiles`: `src/seo/egress.ts` (+ `.test.ts`),
`src/config/schema.ts` (+ `.test.ts`), new `src/seo/ai-visibility-provider.ts` (+
`.test.ts`, 14 tests), `src/seo/runner.ts` (+ `.test.ts`). No new dependencies. All 6
required criteria (sc-3-1..3-6) passed on **iteration 1**; typecheck/build/lint clean;
full suite **4788 passed | 1 skipped | 0 failed** (+32 new tests, 0 regressions; locked
files 203/203 green).
</content>
</invoke>
