# Config axis + core SEO types + egress guard (byte-identical-when-off)

**Contract:** sprint-spec-20260715-ultimate-seo-suite-1  ·  **Spec:** spec-20260715-ultimate-seo-suite  ·  **Completed:** 2026-07-16

## What this sprint added

The **typed foundation** for the ultimate SEO agent + skill suite (arch-20260715-ultimate-seo-agents-skills). Three additive pieces landed, all **default-off and byte-identical when the `seo` config section is omitted**: (1) an optional `seo` Zod section on `BoberConfigSchema` carrying two independent live-data egress axes (`search-console`, `serp-provider`) that each default `false`, an opt-in downgrade-only `verifier`, an optional per-run USD `budget` (reusing `BudgetSectionSchema`), an optional `defaultTarget`, and a `blockThreshold` defaulting to `'critical-uncited'`; (2) the `src/seo/` core type module (`SeoWorkflow`, `SeoSignature`, `SeoFinding`, `DataOutcome<T>`, `DataProvenance`, `SeoReport`, `SeoQuotaLedger`) — pure `type` declarations with zero imports; and (3) `SeoEgressGuard`, a code-enforced barrier mirroring `src/medical/egress.ts` that both axes must clear before any network-opening adapter method runs. No parser, data sources, adapters, analyzer, CLI, hub emitter, or `bober.seo-*` skill content yet — those are later sprints.

## Public surface

- `SeoConfigSchema` / `SeoConfig` (`src/config/schema.ts:668`, `:699`) — the optional `seo` section. Wired `seo: SeoConfigSchema.optional()` on `BoberConfigSchema` (`src/config/schema.ts:747`) with **no outer default**, so omitting `seo` leaks no defaults.
  - `egress` (`schema.ts:684`) — optional `{ "search-console": boolean = false, "serp-provider": boolean = false }`. Two **independent** axes; omitting `egress` entirely stays byte-identical.
  - `verifier` (`schema.ts:688`) — optional `{ enabled: boolean = false }`; opt-in adversarial downgrade-only stage, mirrors `security.verifier`.
  - `budget` (`schema.ts:693`) — optional, reuses `BudgetSectionSchema` verbatim; `null`/absent = uncapped PAYG spend.
  - `defaultTarget` (`schema.ts:695`) — optional domain/URL/local-export path used when the CLI omits `[target]`.
  - `blockThreshold` (`schema.ts:697`) — `'never' | 'any-uncited' | 'critical-uncited'`, default `'critical-uncited'`; the citation-gate CI exit threshold.
- `SeoWorkflow` (`src/seo/types.ts:17`) — the 8-member workflow union: `technical-audit`, `rank-track`, `content-decay`, `topical-map`, `ai-visibility`, `parasite-watch`, `internal-linking`, `schema-audit`.
- `DataOutcome<T>` (`src/seo/types.ts:43`) — three-arm result of every data-source capability call: `{ kind: "disabled" }` | `{ kind: "abstain"; reason }` | `{ kind: "data"; rows; provenance }` (mirrors medical `RetrievalOutcome`).
- `DataProvenance` (`src/seo/types.ts:33`) — `{ source: "local-export" | "gsc" | "dataforseo"; retrievedAt; costUsd? }`; `costUsd` set only by costed live sources.
- `SeoSignature` (`src/seo/types.ts:54`) — parsed shape of a `skills/bober.seo-*` playbook (`policyClass`, `evidenceGrade`, `workflows[]`, keywords, `skillRef`, …).
- `SeoFinding` (`src/seo/types.ts:74`) — one SEO recommendation; `severity` stays a plain `1|2|3|4|5` union (no `hub/finding.ts` import this sprint — the hub mapping is a later sprint).
- `SeoReport` (`src/seo/types.ts:91`) — the persisted per-run report (`findings[]`, `droppedUncited`, `dataProvenance[]`, `verdict: "pass" | "blocked"`).
- `SeoQuotaLedger` (`src/seo/types.ts:109`) — the date-keyed spend/rows/url-inspection quota ledger shape.
- `SeoEgressGuard` (`src/seo/egress.ts:19`) — `fromConfig(config)` builds from `config.seo?.egress?.[axis] ?? false`; `isAllowed(axis)` returns the axis boolean; `assertAllowed(axis)` **throws** `Egress axis '<axis>' not enabled` when the axis is off, else returns `void`.
- `SeoEgressAxis` (`src/seo/egress.ts:5`) — `"search-console" | "serp-provider"`.
- Barrel `src/seo/index.ts` re-exports the seven types + `SeoEgressGuard`/`SeoEgressAxis`. It deliberately does **not** re-export `SeoConfigSchema` (matching `src/config/index.ts`, which omits section schemas — import those directly from `./schema.js`).

## How to use / how it fits

This is pure typed plumbing that the rest of the spec builds on; nothing new runs on its own and no network client exists yet. The intended flow:

```ts
import { SeoEgressGuard } from "./seo/index.js";

const guard = SeoEgressGuard.fromConfig(config);
// Every network-opening adapter method calls this FIRST:
guard.assertAllowed("search-console"); // throws unless config.seo.egress["search-console"] === true
```

The default (no `seo` section, or `seo.egress` omitted) is fully offline: both axes resolve `false`, `assertAllowed` throws for both, and the planned `LocalExportSource` path needs neither. Opting one axis in never opts the other in.

## Notes for maintainers

- **Byte-identical-when-off is the load-bearing invariant, and it is enforced by test, not by eyeballing.** `SeoConfigSchema` is `.optional()` with no outer default and every nested block (`egress`, `verifier`, `budget`) is likewise `.optional()`, so a config that omits `seo` resolves deep-equal to the pre-change golden snapshot. The snapshot assertion lives in `src/config/schema.test.ts`; any future default added at the `seo` top level would break it (that is the point).
- **`SeoFinding.severity` stays a plain `1|2|3|4|5` union — `hub/finding.ts` is intentionally not imported here.** Mapping SEO severity onto the hub `Finding` urgency/severity happens in the later hub-emitter sprint; do not add a value import to `types.ts` before then.
- **`src/seo/` imports nothing but config types.** `types.ts` has zero imports; `egress.ts` imports only `import type { BoberConfig }`. Per the sprint nonGoals there is deliberately no HTTP client, adapter, or data-source seam under `src/seo/` yet — keep it that way until the adapter sprints.
- **The two egress axes are independent and both fail closed.** `assertAllowed` is the hard barrier (ADR-5); every future network-capable adapter method must call it before opening a connection.
- **Unrelated pre-existing drift fixed in passing.** The generator also corrected a stale hardcoded `maxSprints:10` assertion in the `bober.config.json` snapshot test to the repo's current `maxSprints:14` — pre-existing drift, not introduced by this sprint.

## Scope

One commit — `1687276` — touching exactly `src/config/schema.ts`, `src/seo/types.ts`, `src/seo/egress.ts`, `src/seo/index.ts` and the collocated tests (`src/config/schema.test.ts`, `src/seo/egress.test.ts`). No parser, adapter, CLI, hub emitter, network client, or skill content added. All 5 required criteria (sc-1-1..1-5) passed on **iteration 1**, verified via compiled-dist runtime execution; full suite **4300 passed | 1 skipped | 0 failed**.
