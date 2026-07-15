# Research: How can we use the newly-merged fleet decomposer work to improve the medical team?

**Research ID:** research-20260618-fleet-decomposer-to-medical-team
**Generated:** 2026-06-18T00:00:00Z
**Questions Explored:** 7
**Files Explored:** 12

---

## Architecture Overview

Two independent modules were compared: the newly-merged **fleet decomposer** (`src/fleet/`) and the existing **medical team** (`src/medical/`). They share one substrate — the provider-agnostic `LLMClient` / `Message` interface from `src/providers/types.ts` — but enforce opposite failure philosophies.

**Fleet decomposer pipeline** (goal string → validated `FleetManifest`):
- `src/fleet/decomposer.ts` — single-shot `decomposeGoal` + `validateManifest` (never-throws JSON extractor + Zod `FleetManifestSchema`).
- `src/fleet/decomposer-deep.ts` — two-stage **PLAN → EXPAND** (`runPlanStage` → coarse `Outline` of `{name,intent}` areas; `runExpandStage` → `FleetManifest` of `{folder,task}` children). `decomposeGoalDeep` runs PLAN strictly before EXPAND (never parallel), with a fixed call budget `DEEP_MAX_TOTAL_CALLS = 4` (`decomposer-deep.ts:75`, `:343-358`).
- `src/fleet/critic-deep.ts` — optional **fresh-context critique gate**. `getCriticVerdict` reviews the manifest in a *fresh* message array that never extends the EXPAND conversation ("LOCK1", `critic-deep.ts:130`), returning `{verdict:"approve"|"reject", feedback}`. `runCritiqueLoop` re-expands with feedback (bounded `CRITIQUE_MAX_ROUNDS = 1`) and **accept-best** on exhaustion.
- `src/fleet/manifest-write.ts` — `writeManifestWithProvenance` emits a `<outPath>.meta.json` provenance sidecar `{command,goal,critique,childCount,timestamp}`, preserves the prior manifest as `.bak` on overwrite, and writes atomically via tmp+rename.

**Medical SOP pipeline** (`src/medical/engine.ts`, `MedicalSopEngine.run`) is a strictly ordered gate chain: Gate 1 consent (fail-closed, zero downstream) → Gate 2 red-flag 0-LLM short-circuit → Gate 2b content-policy refusal → (3) deterministic numerics → (4) `FactStore` active meds → Gate 3 EgressGuard + (5) literature retrieval → (6) disclaimer → (7) audit → (8) return. The **only** LLM call in the entire SOP is the single `synthesize` call on the grounded-literature branch (`engine.ts:396-403`), and it runs against **local Ollama** (`createClient("openai-compat", "http://localhost:11434/v1", …)`), never a cloud provider.

## Existing Patterns

**Reusable patterns introduced by the fleet work:**

- **Never-throw structured validators.** `validateManifest` (`decomposer.ts:94`), `validateOutline` (`decomposer-deep.ts:109`), and `validateVerdict` (`critic-deep.ts:67`) all share the identical tolerant shape: direct `JSON.parse` → markdown-fence extraction → first-`{…}`-brace slice → Zod `safeParse`, returning `{ok:true,…} | {ok:false,error}`. None throw.
- **Bounded retry-with-coercion.** `runPlanStage`/`runExpandStage`/`getCriticVerdict` loop `1 + maxRetries` times; on a parse miss they re-prompt with a 3-message `[user, assistant(priorText), user(COERCION_INSTRUCTION + error)]` shape (`decomposer-deep.ts:177-190`). Call budgets are compile-time constants (`DEEP_MAX_TOTAL_CALLS`, `DEEP_CRITIQUE_MAX_TOTAL_CALLS`).
- **Fresh-context adversarial critic.** The critic is explicitly told it did not author the artifact and is handed the goal+outline+candidate in a brand-new message array (`critic-deep.ts:119-152`) — structurally preventing self-approval bias.
- **`jsonObjectMode: true`** is passed on every fleet decomposition `client.chat` call (`decomposer-deep.ts:196`, `:244`; `critic-deep.ts:158`).

**Existing medical patterns that mirror these:**

- **Abstain-unless-cited synthesis** (`literature.ts:98-177`): a single `llm.chat` call pinned to retrieved passages; the model is instructed to reply exactly `ABSTAIN` if unsupported; empty/`ABSTAIN`/throw all map to an abstained `MedicalAnswer` with `citations:[]`. Every non-abstained answer carries ≥1 citation (`passagesToCitations`, `literature.ts:75`).
- **IDs/enums-only append-only audit** (`audit.ts`): `AuditLog.append` writes `.bober/medical/audit-<date>.jsonl` at mode `0600`; the PHI rule (`audit.ts:14-19`) forbids serializing prompt text or health values — entries hold only `{tIso,event,ruleId?,rulesetVersion?,patternsetVersion?}`. The date comes from the injected `tIso`, never the wall clock.
- **Independent opt-in egress axes** (`egress.ts`): `cloud-inference`, `literature-retrieval`, `device-connection`, all `default false`; `assertAllowed` throws a hard barrier (`egress.ts:54`).

## Key Files

| File | Role | Anchor symbols |
|---|---|---|
| `src/fleet/decomposer-deep.ts` | Two-stage PLAN→EXPAND engine | `decomposeGoalDeep:331`, `runPlanStage:252`, `runExpandStage:289`, `validateOutline:109` |
| `src/fleet/critic-deep.ts` | Fresh-context critique gate (fail-OPEN) | `getCriticVerdict:166`, `runCritiqueLoop:206`, `CritiqueVerdictSchema:54` |
| `src/fleet/decomposer.ts` | Single-shot decompose + manifest validator | `decomposeGoal:158`, `validateManifest:94` |
| `src/fleet/manifest-write.ts` | Provenance sidecar + `.bak` recovery | `writeManifestWithProvenance:68`, `ManifestProvenance:16` |
| `src/medical/engine.ts` | Full ordered SOP; only LLM call at `:402-403` | `MedicalSopEngine.run:196` |
| `src/medical/retrieval/literature.ts` | Single grounded-synthesis LLM call | `synthesize:98`, `LiteratureRetriever.retrieve:31` |
| `src/medical/audit.ts` | IDs/enums-only 0600 audit log | `AuditLog.append:44` |
| `src/medical/egress.ts` | Three opt-in egress axes, default false | `EgressGuard.isAllowed:35`, `assertAllowed:54` |
| `src/config/schema.ts` | `MedicalSectionSchema` egress axes | `:374-385` (axes default false), `medical?` optional `:421` |

## Integration Points

- **Shared provider seam.** Both engines call `LLMClient.chat({model, system, messages, …})` from `src/providers/types.ts` (fleet: `decomposer-deep.ts:4`; medical: `engine.ts:35`, `literature.ts:4`). A decomposition or critique helper written against `LLMClient` is drop-in compatible with the medical engine's injected `llmClient` seam (`MedicalSopDeps.llmClient`, `engine.ts:54`).
- **Synthesis branch is the only LLM-bearing seam in medical.** `engine.ts:396-403` is where a critique-gated or decomposed synthesis would attach; everything upstream (consent/red-flag/numerics/meds/egress) is deterministic and 0-LLM by contract and must remain so.
- **EgressGuard is the gate any new LLM fan-out must pass.** The synthesis path today runs on local Ollama and is *not* gated on `cloud-inference`; any decomposition that issues multiple model calls must either stay local (Ollama) or be placed behind `EgressGuard.isAllowed("cloud-inference")` (`egress.ts:35`), which defaults false (`schema.ts:381`).
- **Audit vs. provenance.** Medical already has an audit trail (`AuditLog`); the fleet `ManifestProvenance` sidecar is a *separate* provenance concept (records the generating command + inputs). They are not interchangeable as-is — see Risk Areas.
- **Injectable-deps test seam.** `MedicalSopDeps` (`engine.ts:47-66`) already injects `llmClient`, `literature`, `egress`, `facts`, `healthStore` — a new critic dependency would follow the same optional-deps pattern.
- **Reusable validators are exported.** `validateManifest`, `validateOutline`, `validateVerdict` are all `export function` and importable from medical code without duplicating the JSON-tolerance logic.

## Test Coverage

- **Fleet (15 `*.test.ts`):** `decomposer.test.ts`, `decomposer-deep.test.ts`, `critic-deep.test.ts` (42 tests), `expand.test.ts`, `expand-deep.test.ts`, `expand-deep-critique.test.ts`, `manifest-write.test.ts`, plus `aggregator/child-config/coordinator/index/manifest/reporter/runner/scaffolder`.
- **Medical (~17 `*.test.ts`):** `engine.test.ts` (29 tests, incl. axis-independence + sc-6-8 zero-egress assertions), `audit.test.ts`, `consent.test.ts`, `egress.test.ts` (20), `guardrails.test.ts` (21), `numerics.test.ts` (20), `red-flag.test.ts` (25), `refusal.test.ts` (31), `health-store.test.ts`, `retrieval/literature.test.ts` (15), `retrieval/medline-source.test.ts`, `team.test.ts` (17), plus `adapters/apple-health`, `ingestion`, `whoop/*`.
- A post-merge run of `vitest run src/fleet src/medical` reported **471 tests passing across 33 files**; `tsc --noEmit` is clean. Existing engine tests assert the LLM client is **never constructed** on the red-flag / numeric / disabled paths (`engine.ts:400-402` comment references sc-7-8) — any new code must preserve those negative assertions.

## Risk Areas

- **Fail-OPEN vs. fail-CLOSED inversion (highest-impact constraint).** The fleet critic degrades to **approve** on parse exhaustion and transport failure (`getCriticVerdict:199-201`, `runCritiqueLoop:228-231`, ADR-1/ADR-3). The medical pipeline's governing contract is the opposite: every uncertain path must **abstain/refuse** (`literature.ts` abstains on empty/`ABSTAIN`/throw; consent and red-flag gates fail-closed). Reusing the critic loop verbatim in medical would invert its safety posture. A medical critique gate must fail **closed** (abstain) on exhaustion, not open.
- **PHI leakage via provenance sidecar.** `ManifestProvenance` records the raw `goal` string and writes `<path>.meta.json` with default file mode (`manifest-write.ts:117-125`). Medical audit deliberately stores **IDs/enums only at mode 0600** and never the prompt (`audit.ts:14-19`). Applying `writeManifestWithProvenance` to medical outputs unmodified would write the user's health question to a world-readable plaintext sidecar — a direct PHI-rule violation.
- **Egress amplification.** Each added model call (a decomposition fan-out, a critic round) is another outbound inference. On the current local-Ollama path this stays zero-cloud, but it multiplies calls; on any `cloud-inference`-enabled deployment it multiplies outbound egress. The zero-egress proof (synchronous `isAllowed` check before any source call, `literature.ts:32-33`) must remain the first thing checked.
- **Determinism boundary.** Numerics (`engine.ts:333-363`) are deterministic, no-LLM by contract. Decomposition is inherently LLM/non-deterministic. Any decomposition must sit strictly on the synthesis branch and must not move numeric or red-flag logic behind a model call.
- **Wall-clock injection.** Medical forbids `Date.now()` in audited paths (timestamps injected via `opts.now`, `engine.ts:202-204`; audit filename from `tIso`). `manifest-write.ts` uses `Date.now()` for the tmp filename and an injectable `now` for the sidecar timestamp (`manifest-write.ts:71`, `:116`) — a medical adaptation must route all timestamps through the injected `now`.
- **Graph staleness note.** tokensave currently serves this branch from `main` ("branch 'bober/medical-team' is not tracked"); medical symbols resolved correctly from the working tree, but graph-derived queries may lag the branch until `tokensave branch add bober/medical-team` is run.

---

*Generated by bober.research — factual findings only, no implementation recommendations.*
