# Online research-latest-findings + vault notes, schedulable research-job (egress-gated)

**Contract:** sprint-spec-20260628-medical-analysis-5  ·  **Spec:** spec-20260628-medical-analysis  ·  **Completed:** 2026-06-28

## What this sprint added

Sprint 5 — the **finale** of the medical-analysis plan (5 of 5) — adds an **egress-gated online
research job** under a NEW module `src/medical/research/`. `runResearchJob` is a **schedulable
entrypoint**: when the `literature-retrieval` egress axis is **off** it returns
`{ disabled: true, notesWritten: 0, findingsWritten: 0 }` **before constructing any
`LiteratureRetriever` / `MedlineSource`** — **zero egress**. When the axis is on, it retrieves
latest MedlinePlus evidence per marker, grounds each note through the **fail-closed grounding
critic** (`synthesizeGrounded`), and — only for non-abstained answers — writes a citation-bearing
research note plus an optional `kind: "watch"` "new evidence" Finding into the vault. Synthesis
**fail-closes to the local Ollama model** via `buildMedicalInferenceClient` unless `cloud-inference`
is independently enabled. All retrieval / synthesis / grounding / model-selection primitives are
**reused, not re-implemented**, and `src/medical/engine.ts` is **byte-unchanged**.

## Public surface

- `runResearchJob(projectRoot, config, { markers, now }, deps?)` (`src/medical/research/online-research.ts:80`)
  — `async` schedulable entrypoint returning `Promise<ResearchSummary>`
  (`{ notesWritten, findingsWritten, disabled }`). Gating order is **load-bearing**: build
  `EgressGuard` → axis-off short-circuit (returns **before** retriever construction) → build
  fail-closed synthesis client → resolve vault dir → construct `LiteratureRetriever` **only** on
  the axis-on branch → per marker `retrieve` → `synthesizeGrounded` → `answer.abstained ? continue :
  write note + watch finding`. The clock is **injected** (`opts.now`); the function never reads the
  wall clock and imports no network. This is the entrypoint consumed by
  `spec-20260628-research-scheduler` (the scheduler owns cadence and passes `markers` + `now`).
- `ResearchSummary` (`src/medical/research/online-research.ts:38`) — `{ notesWritten: number;
  findingsWritten: number; disabled: boolean }`.
- `ResearchDeps` (`src/medical/research/online-research.ts:49`) — optional injectable deps
  (`retriever?`, `llmClient?`, `clientFactory?`, `writeFindingFn?`); **production callers pass
  none**. Tests inject a fake retriever (avoids `MedlineSource`), a spyable `clientFactory`
  (`sc-5-5`), and a `writeFinding` spy.
- `serializeResearchNote(marker, answer, now)` (`src/medical/research/research-note.ts:43`) — **PURE**
  (no network / no LLM / no `Date.now()`). Serializes a grounded `MedicalAnswer` into a vault
  research note. **Flattens** `Citation[]` into **parallel arrays of strings** `citationTitles[]` /
  `citationUrls[]` plus a **scalar** `source: "medlineplus"`, sidestepping the `[object Object]`
  pitfall when nested objects are passed to `serializeFrontmatter` (scalar / array-of-scalar only).
- `researchNotePath(vaultDir, marker, now)` (`src/medical/research/research-note.ts:23`) — derives
  the canonical path `<vaultDir>/research/<YYYY-MM-DD>-<marker>.md`; the date is **sliced from the
  injected `now`**, never wall-clock.
- `bober medical research [--marker <m>]` (`src/cli/commands/medical.ts:455`) — additive CLI
  subcommand. `--marker` omitted ⇒ default marker set `["ldl", "hdl", "a1c"]`. The clock is read
  **only** at this CLI boundary. Prints whether research **ran** (with `notes written` /
  `findings written` counts) or was **disabled** by the egress axis; on error sets
  `process.exitCode = 1` **without throwing** (exits 0 on both ran and disabled outcomes).

## How to use / how it fits

```bash
# Axis OFF (default): no-op, zero egress —
bober medical research
#   literature-retrieval egress not enabled — research skipped (zero egress)

# Axis ON (medical.egress.literatureRetrieval: true): retrieve + ground + write notes —
bober medical research --marker ldl
#   Research complete
#     notes written:    1
#     findings written: 1
```

This is the **online** complement to Sprint 1's deterministic offline review pass. The scheduler
(`spec-20260628-research-scheduler`) imports `runResearchJob` and drives it on a cadence; this sprint
owns only the job itself. Per marker the job:

1. **Retrieves** MedlinePlus passages via the existing `LiteratureRetriever` (axis-gated source).
2. **Grounds** a synthesis through `synthesizeGrounded`, whose **fail-closed grounding critic**
   rejects unfaithful/uncited answers.
3. **Writes** — only when `answer.abstained === false` — a research note
   (`research/<date>-<marker>.md`) with flattened citation frontmatter and an optional
   `kind: "watch"` "New evidence on `<marker>`" Finding (via the Sprint-1 `writeFinding`, evidence =
   citation URLs).

A critic-rejected / abstained answer **skips both writes** for that topic — no uncited synthesis is
ever persisted.

## Notes for maintainers — the three load-bearing invariants

The evaluator confirmed all three **in source** (`eval-sprint-spec-20260628-medical-analysis-5-1`,
pass 7/7):

- **Zero-egress when off (sc-5-2).** The `egress.isAllowed("literature-retrieval")` check is the
  **first** action after building the guard (`online-research.ts:91`); a `false` axis returns
  `{ disabled: true }` **before** any `LiteratureRetriever` / `MedlineSource` is constructed (the
  retriever is built only at `online-research.ts:105`, on the axis-on branch). A `MedlineSource`
  spy proves `fetchPassages` is **never** called and **no files are written**.
- **Fail-closed abstain (sc-5-4).** `if (result.answer.abstained) continue;`
  (`online-research.ts:124`) skips the note write, the `notesWritten` increment, the watch finding,
  and the `findingsWritten` increment. A double-REJECT grounding critic ⇒ `{ notesWritten: 0,
  findingsWritten: 0 }`, no files. No uncited synthesis is persisted.
- **Fail-closed local model (sc-5-5).** Synthesis resolves its client via
  `buildMedicalInferenceClient(config, egress, deps.clientFactory)`. With `cloud-inference` **off**
  it constructs the **local** `openai-compat` `localhost:11434` (`llama3`) client even when
  `inference.provider` requests a cloud provider — the factory spy proves **no** anthropic / x.ai /
  deepseek client is constructed. Enabling `literature-retrieval` does **not** enable
  `cloud-inference` (the two axes are independent).

Additional notes:

- **Citation-frontmatter flattening is deliberate.** `serializeFrontmatter` renders only scalars and
  arrays-of-scalars; a raw `Citation[]` (objects) would serialize as `- [object Object]`.
  `serializeResearchNote` flattens to `citationTitles[]` / `citationUrls[]` + scalar `source` to keep
  the frontmatter valid and queryable. Keep new citation fields scalar/array-of-scalar.
- **Schedulable-entrypoint contract.** `runResearchJob(projectRoot, config, { markers, now }, deps?)
  => Promise<ResearchSummary>` is the stable surface for `spec-20260628-research-scheduler`. The
  scheduler owns the cron/cadence and **injects** the marker list and `now`; the job reads no clock
  and performs no scheduling.
- **`engine.ts` is no-touch.** The reactive medical SOP / Q&A engine is **not** in commit `07b0fb9`
  (evaluator-confirmed byte-unchanged); the reactive literature path is untouched.
- **Scope is MedlinePlus only.** Non-MedlinePlus sources (Quest / LabCorp / CSV) and the
  scheduler/cron engine itself are explicit non-goals (owned by other specs).

## Scope

Commit `07b0fb9`: new module `src/medical/research/` (`research-note.ts` PURE serializer +
`online-research.ts` `runResearchJob`) + 2 collocated `*.test.ts` (28 tests: 10 serializer +
18 covering `sc-5-2..sc-5-6`), plus the additive `bober medical research` CLI subcommand in
`src/cli/commands/medical.ts`. No new deps; all retrieval / synthesis / grounding-critic /
model-selection primitives reused. All 6 required criteria (`sc-5-1..sc-5-6`) + the optional manual
`sc-5-7` passed **iteration 1**; full suite **3142** green (+28, baseline 3114), no regressions,
`engine.ts` byte-unchanged. Eval `eval-sprint-spec-20260628-medical-analysis-5-1` → **pass** (7/7).
**The medical-analysis plan is complete (5 of 5).**
