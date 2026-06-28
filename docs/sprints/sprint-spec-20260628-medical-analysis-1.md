# Proactive trend Findings + vault Finding writer + Dataview dashboard + review pass

**Contract:** sprint-spec-20260628-medical-analysis-1  ·  **Spec:** spec-20260628-medical-analysis  ·  **Completed:** 2026-06-28

## What this sprint added

The **opening sprint** of the medical-analysis plan: a deterministic, **fully offline**
proactive review pass that scans the existing lab series in `HealthDataStore`, applies two
reference-range / slope rules, and emits one **Finding** markdown note per detected condition
into a medical vault `findings/` directory plus a `findings/dashboard.md` Dataview note. The
whole pass is **pure compute** — no LLM, no network, no wall-clock read inside the analysis
modules — so it is safe to schedule. A new module `src/medical/analysis/` holds the
`MedicalFinding` shape + a deterministic `findingId`, the vault writer, the trend analyzer, and
the schedulable `runProactiveReview` entrypoint. It is exposed as a `bober medical review`
subcommand and reuses `NumericsQueryLayer.getLabTrend` for all arithmetic (ADR-3). The reactive
medical Q&A engine (`src/medical/engine.ts`) is **untouched**.

## Public surface

- `bober medical review` (`src/cli/commands/medical.ts:351`) — runs the proactive trend review pass against `.bober/medical/health.db`, writes Finding notes + the dashboard, prints `findings written` + the dashboard path, and exits 0. Reads the wall clock **only here** (the CLI boundary) and sets `process.exitCode = 1` on error without throwing. Nested subcommand under `medical`, **not** a top-level command.
- `runProactiveReview(projectRoot, config, opts)` (`src/medical/analysis/review-pass.ts:45`) — the schedulable/importable entrypoint. `opts = { now: ISO-8601; biomarkers?: string[]; store?: HealthDataStore }`. Opens a `HealthDataStore` at `<projectRoot>/.bober/medical/health.db` (mirrors `engine.ts:350`) and **always closes it in `finally` — unless a `store` was injected**, in which case the caller owns the lifecycle. Resolves the vault dir from `config.medical.vaultDir` or the default `<projectRoot>/.bober/medical/vault`. Returns `ProactiveReviewResult { findingsWritten, dashboardPath, findingPaths }` (`review-pass.ts:26`).
- `analyzeTrends(store, biomarkers, opts)` (`src/medical/analysis/trends.ts:182`) — **PURE / synchronous / deterministic**. Returns `MedicalFinding[]`. Delegates **all** trend math to `NumericsQueryLayer.getLabTrend` (no hand-rolled slope arithmetic). Abstains (no finding) when `sampleCount === 0`. Rule A (range crossing) takes precedence over Rule B (slope-toward-edge) per biomarker.
- `MedicalFinding` (`src/medical/analysis/finding.ts:36`) — the common Finding field set (`id`, `domain` fixed to `"medical"`, `title`, `kind`, `urgency` 1–5, `severity` 1–5, `evidence[]`, `surfacedAt`, `dueBy?`, `tags[]`, `status`, `promotesTo?`) emitted as YAML frontmatter. Supporting types: `FindingKind = "action" | "watch" | "risk" | "question"` (`finding.ts:26`), `FindingDomain`, `FindingStatus`. **This is not a canonical Zod schema** — the canonical Finding schema is owned by `spec-20260628-priority-hub`; this module emits the field set as markdown frontmatter only.
- `findingId(domain, biomarker, ruleKey)` (`src/medical/analysis/finding.ts:65`) — a deterministic 16-char `SHA-256(domain|biomarker|ruleKey)` slice (mirrors `observationId` at `health-store.ts:32-42`). **`now` is never part of the id**, so the same condition maps to the same note file across runs (idempotent overwrite, no duplicates).
- `serializeFindingToMarkdown(finding)` (`src/medical/analysis/finding.ts:83`) — serializes a `MedicalFinding` to YAML-frontmatter markdown, reusing the array-aware `serializeFrontmatter` from `src/vault/frontmatter.ts`. `surfacedAt` equals the injected `now` (never wall-clock).
- `writeFinding(vaultDir, finding)` (`src/medical/analysis/finding-writer.ts:27`) — writes `<vaultDir>/findings/<finding.id>.md` (deterministic hex id is filename-safe), creates parent dirs via `ensureDir`, returns the absolute path. `node:fs/promises` only.
- `writeDashboard(vaultDir)` (`src/medical/analysis/finding-writer.ts:62`) — writes `<vaultDir>/findings/dashboard.md` containing a fenced `dataview` block (`TABLE urgency, severity, kind, status FROM "findings" WHERE domain = "medical" SORT urgency DESC`). Returns the absolute path.
- `HealthDataStore.listBiomarkers()` (`src/medical/health-store.ts:268`) — returns the distinct `biomarker` names in `lab_results`, ordered alphabetically (empty array when no labs are loaded). Used by `runProactiveReview` to enumerate biomarkers when `opts.biomarkers` is not supplied.
- `medical.vaultDir` config key (`src/config/schema.ts:401`) — optional `z.string()` on `MedicalSectionSchema`. The vault directory for medical Finding notes; defaults to `<projectRoot>/.bober/medical/vault` when unset.

## How to use / how it fits

```bash
# Run the proactive review against the project's medical health store:
bober medical review
#   findings written: 2
#   dashboard:        /abs/.bober/medical/vault/findings/dashboard.md
```

Or import the schedulable entrypoint directly (e.g. from a future scheduler):

```ts
import { runProactiveReview } from "../medical/analysis/review-pass.js";

const result = await runProactiveReview(projectRoot, config, {
  now: new Date().toISOString(), // clock read ONLY at this boundary
});
// result: { findingsWritten, dashboardPath, findingPaths }
```

The pass sits **alongside** (not inside) the reactive medical SOP engine: it reads the lab data
that ingestion (`spec-20260628-medical-ingest`) wrote, and emits Findings into the **vault**,
which is the canonical markdown sink. Cross-repo aggregation of Findings into a priority hub is
**out of scope here** — `spec-20260628-priority-hub` owns that and will validate the same field
set with a canonical Zod schema.

### Rules

- **Rule A — reference-range crossing.** Latest value outside `[referenceLow, referenceHigh]` ⇒ `kind: "watch"` (severity 3, urgency 3); **> 20 %** beyond the edge ⇒ `kind: "risk"` (severity 4, urgency 4). Takes precedence over Rule B.
- **Rule B — slope-toward-edge.** In-range value with a non-null slope (and `sampleCount >= 2`) trending toward the nearer reference edge ⇒ `kind: "watch"` (severity 2, urgency 2).

## Notes for maintainers

- **Idempotency is the headline guarantee (sc-1-4).** `findingId` hashes `domain|biomarker|ruleKey` and **deliberately excludes `now`**, so re-running `runProactiveReview` over an unchanged store with the same injected `now` overwrites the same `findings/<id>.md` files — the file count and paths are identical across runs (no duplicates). Verified file-backed, not just in-memory.
- **Determinism / offline is enforced, not just claimed.** `analyzeTrends` is pure, synchronous, and `fs`/network/LLM-free; the evaluator grepped `src/medical/analysis/*` for `Sync`/`fetch`/`providers`/`ollama`/`http` and found none. The wall clock is read **only** at the CLI boundary (`medical.ts`) and threaded in as `opts.now`. "Fail-closed egress" gating does **not** apply here — there is nothing to gate because the pass never reaches the network.
- **ADR-3 — arithmetic stays out of the LLM, and out of this module's own hands.** All slope/latest-value math is delegated to `NumericsQueryLayer.getLabTrend`; there is no inline slope arithmetic. Reference ranges are read from `store.getLabSeries` (the `LabTrend` shape does not carry them).
- **Vault is canonical.** Findings are written as markdown-with-frontmatter into the vault `findings/` dir; there is no FactStore/DB write for Findings in this sprint. Deterministic urgency/severity come from rule tiers — LLM-assigned urgency/severity for recommendations is reserved for a later sprint.
- **No competing Finding schema.** This module emits the common Finding field set as frontmatter only; it intentionally does **not** define a Zod schema (that belongs to `spec-20260628-priority-hub`). A future hub aggregates these notes.
- **Scope.** Commit `307e5e7`: 4 new `src/medical/analysis/*` modules + 4 collocated `*.test.ts` (43 tests), plus additive `listBiomarkers()` on `HealthDataStore`, `medical.vaultDir` on the config schema, and a `medical review` CLI subtree. No new deps, `engine.ts` untouched. All 7 criteria (sc-1-1..sc-1-7) passed iteration 1; full suite **3029** green (+43).
