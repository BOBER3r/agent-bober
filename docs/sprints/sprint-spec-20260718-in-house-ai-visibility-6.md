# TrackedPromptStore — filesystem prompt set + gatherDataBundle feed

**Contract:** sprint-spec-20260718-in-house-ai-visibility-6  ·  **Spec:** spec-20260718-in-house-ai-visibility  ·  **Completed:** 2026-07-18

## What this sprint added

Before this sprint, `gatherDataBundle` synthesized a trivial `AiVisibilityQuery` of
`{ target, prompts: [target] }` — the spine could only ever probe the target's own name as
the sole prompt. This sprint adds a filesystem-backed **`TrackedPromptStore`** that loads a
committed, per-target tracked-prompt set from `.bober/seo/ai-visibility/<target>.json` and
feeds the **real** prompt list (plus an optional `locale`) into the locked
`AiVisibilityQuery`, so a team can curate the exact prompts they track for a brand. The load
happens **only** inside the `requested.has("ai-visibility")` arm — a workflow that does not
request `ai-visibility` never touches the filesystem for this store (byte-identical to
pre-change). A missing, unreadable, or schema-invalid file collapses to the exact prior
`{ target, prompts: [target] }` query — with **no `locale` key present at all** — so today's
behavior is preserved verbatim. `load()` never throws.

## Public surface

- `TrackedPromptStore` (`src/seo/tracked-prompt-store.ts:52`) — constructed with a
  `projectRoot`. `load(target): Promise<TrackedPromptSet>` reads
  `<projectRoot>/.bober/seo/ai-visibility/<sanitized-target>.json` via `node:fs/promises`,
  `JSON.parse`s it, and validates with `TrackedPromptSetSchema.safeParse`. Missing /
  unreadable / malformed / schema-invalid all fall back to
  `{ target, prompts: [target], engines: [], samplesPerPrompt: 5 }`. **Never throws.**
- `TrackedPromptSetSchema` / `TrackedPromptSet` (`src/seo/tracked-prompt-store.ts:26`) — the
  Zod schema and inferred type for the file:
  `{ target: string; prompts: string[]; engines: string[] (default []); samplesPerPrompt: number (int>0, default 5); locale?: string }`.
- `gatherDataBundle` (`src/seo/runner.ts:411`) — now takes a `projectRoot` param; its
  `ai-visibility` arm is a lazy async IIFE that loads the tracked set and builds the locked
  `{ target, prompts, locale? }` query (`AiVisibilityQuery`, `data-source.ts:61`). The call
  site (`SeoWorkflowRunner.run`, `runner.ts:516`) passes `input.projectRoot`.

## Tracked-prompt file format

`.bober/seo/ai-visibility/<target>.json` (the `<target>` filename is traversal-safe —
non-`[a-zA-Z0-9_-]` chars are replaced with `_`, so e.g. `example.com` → `example_com.json`):

```json
{
  "target": "example.com",
  "prompts": ["what is example.com", "who runs example.com", "is example.com trustworthy"],
  "engines": ["anthropic"],
  "samplesPerPrompt": 9,
  "locale": "en-GB"
}
```

- `target`, `prompts` — required. Only these two (and `locale`) reach the provider.
- `locale` — optional; forwarded into the query when present, **omitted entirely** when absent.
- `engines`, `samplesPerPrompt` — parsed and validated, but **advisory only**: they are
  deliberately **not** forwarded into the locked `AiVisibilityQuery` (contract nonGoal). The
  real N/engines are resolved from `seo.aiVisibility` config at provider construction. A
  missing `engines` defaults to `[]`; a missing `samplesPerPrompt` defaults to `5`.

## How to use / how it fits

Author a tracked-prompt file per brand you track and commit it under
`.bober/seo/ai-visibility/`. On any run whose workflow requests the `ai-visibility`
capability, `gatherDataBundle` loads that file and probes your curated prompts (via the
in-house grounded-API spine, Sprints 1–5). With no file present, the axis behaves exactly as
it did before — probing `[target]` alone.

There is **no CLI to author the file** (a deliberate nonGoal — reading + fallback only); write
it by hand or via your own tooling.

## Notes for maintainers

- **Byte-identical fallback is the safety contract.** The fallback query
  (`{ target, prompts: [target] }`, no `locale` key) is asserted byte-identical to the
  pre-Sprint-6 literal, including `hasOwnProperty("locale") === false`. Keep the `locale`
  omission (not `locale: undefined`) if you ever touch the query-building code.
- **No extra fs read when the axis isn't requested.** The `load()` call lives *inside* the
  `requested.has("ai-visibility")` ternary within `Promise.all`, never hoisted above it. A
  spy on `TrackedPromptStore.prototype.load` confirms a `technical-audit` workflow never calls
  it. Do not hoist it.
- **`engines`/`samplesPerPrompt` are intentionally inert in the query.** They are parsed for
  completeness and future use, but the locked `AiVisibilityQuery` carries only
  `target`/`prompts`/`locale?`. Forwarding them would re-open the spec's locked-query Open
  Question.
- **Filename sanitization mirrors `report-store.ts`.** `trackedPromptPath` reuses the same
  `replace(/[^a-zA-Z0-9_-]/g, "_")` traversal-safe idiom; a `../`-bearing target can neither
  throw nor escape the `ai-visibility` directory (two dedicated security tests).
- **No DB, no history/time-series store** (nonGoal) — this is a stateless read of a committed
  flat file.

## Scope

One commit — `a2049cc` — matching `estimatedFiles`: new `src/seo/tracked-prompt-store.ts`
(+ `.test.ts`, 8 tests: valid/defaulted parse, four fallback paths, two traversal-safety
tests), modified `src/seo/runner.ts` (the `gatherDataBundle` `ai-visibility` arm + the
`projectRoot` param and call-site) + `src/seo/runner.test.ts` (a query-capturing fake source
+ sc-6-3 prompts/locale-flow and sc-6-4 zero-fs-read-for-non-ai-visibility blocks). **No new
dependencies. `WORKFLOW_CAPABILITIES` untouched.** All 5 required criteria (sc-6-1..6-5)
passed on **iteration 1**; typecheck/build/lint clean; full suite **4848 passed | 1 skipped |
0 failed** (+11 new tests, 0 regressions).
