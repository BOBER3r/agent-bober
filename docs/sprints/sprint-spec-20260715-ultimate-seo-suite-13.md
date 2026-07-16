# Benchmark corpus + measurement harness (verified, not asserted)

**Contract:** sprint-spec-20260715-ultimate-seo-suite-13  ·  **Spec:** spec-20260715-ultimate-seo-suite  ·  **Completed:** 2026-07-16

## What this sprint added

The **quality-measurement backstop** for the SEO pipeline: a small labeled fixture corpus (3 known-good / 3 known-bad) plus an offline measurement harness that makes finding quality **measured, not asserted**. `runBenchmark` drives the **real** `SeoWorkflowRunner.run` over each case — injecting a `LocalExportSource` (temp fixture files), a `ScriptedClient`-backed `SeoAnalyzer` (recorded LLM response, no network), and a capturing sink standing in for the hub, with both egress axes off — then reports precision/recall and **proves the two safety invariants corpus-wide**: `uncitedReachedSink = 0` and `neverEncodeEmitted = 0`. It is a leaf measurement module consumed only by its own test; it is **not** wired into the runner, the CLI, or any evaluator gate (this sprint's non-goal is to *measure and report*, not to gate the pipeline on a precision/recall threshold). The sprint also widens the test-side `FORBIDDEN_ACTION_PATTERNS` guard, closing the Sprint-5 follow-up.

## Public surface

- `runBenchmark(corpus, projectRoot)` (`src/seo/benchmark/harness.ts:167`) — runs the real `SeoWorkflowRunner` over every labeled case offline and deterministically; writes each case's inline `imports[]` under `<projectRoot>/<id>/imports/`, injects source/analyzer/sink, and returns `CorpusMetrics`. **Never throws** (the runner itself never throws; everything else is pure aggregation).
- `CorpusMetrics` (`harness.ts:88`) — `{ findingPrecision, findingRecall, uncitedDropRecall, uncitedReachedSink, neverEncodeEmitted, cases }`. The first three are ΣTP/ΣFP/ΣFN and drop-count rates across the corpus; `uncitedReachedSink` and `neverEncodeEmitted` are the two **invariants that MUST be 0**; `cases` carries per-case `{ id, emitted, report?, exitCode }`.
- `SeoBenchmarkCase` (`harness.ts:55`) — one labeled case: `{ id, label, workflow, target, imports[], analyzerResponse, expected }`, where `expected.findings[]` each name a `playbookRef` and whether they should survive the citation gate (`cited`), plus `droppedUncited` and a `verdict`.
- `src/seo/benchmark/corpus/manifest.json` — the 6-case labeled corpus (see the table below), each case pairing inline import fixtures + a recorded `analyzerResponse` + its expected outcome.
- `src/seo/benchmark/corpus/README.md` — the corpus label schema and the rationale for authoring the never-encode case uncited (and for keeping fixtures as inline JSON strings, i.e. *data*, so the adversarial phrasing is never compiled/linted/executed).
- Barrel `src/seo/index.ts` — additive re-export of `runBenchmark` + the `CorpusMetrics`/`SeoBenchmarkCase` types.

## Corpus coverage

| Case id | Label | What it proves |
|---|---|---|
| `kg-technical-audit-cited` | known-good | A single well-cited finding survives the gate and reaches the sink; `verdict: pass`. |
| `kg-mixed-cited-and-uncited` | known-good | One cited + one non-critical uncited finding — only the cited one reaches the sink (`droppedUncited: 1`); non-critical severity keeps `verdict: pass`. |
| `kg-rank-track-auto-safe` | known-good | A second workflow (`rank-track`) behaves identically — the harness is workflow-agnostic. |
| `kb-uncited-drop` | known-bad | A single critical (severity 5) uncited finding is dropped entirely — zero sink calls, `verdict: blocked`, `exitCode: 2`. |
| `kb-never-encode-uncited` | known-bad | Two never-encode-phrased findings ("mass-generate ... thin pages", "purchase links from DR90 hosts"), **both authored uncited**, are dropped at the citation gate before reaching any sink. |
| `kb-parse-failure` | known-bad | An unparseable `analyzerResponse` ⇒ `SeoAnalyzer.analyze` returns `parsed: false`; the runner fail-closes to `exitCode: 2`, no report, zero sink calls. |

## The verify-not-assert role

The whole point of this sprint is to *verify* the pipeline's guarantees empirically rather than *assert* them from the spec. Two invariants are checked by scanning the findings that actually reached the capturing sink across the full corpus:

- **`uncitedReachedSink = 0`** — every emitted finding must carry a well-formed absolute `http(s)` `cite:` evidence entry (`lacksWellFormedCitation`, `harness.ts:112`, a real `new URL()` protocol check). This re-proves the citation gate's structural drop at the sink boundary.
- **`neverEncodeEmitted = 0`** — no emitted finding's `title`+`evidence` text matches a never-encode tactic pattern (`matchesNeverEncode`, `harness.ts:124`, scanning `NEVER_ENCODE_EMIT_PATTERNS`, `harness.ts:79`).

Offline/credential-free is proved directly in the test: `createClient` (`src/providers/factory.ts`) is mocked to throw if ever invoked, and a `globalThis.fetch` spy asserts zero calls after a full corpus run (sc-13-4). On this corpus the harness reports precision/recall of 1/1 and `uncitedDropRecall` 1, with both invariants at 0.

## Widened `FORBIDDEN_ACTION_PATTERNS` guard

`src/seo/skills-content.test.ts`'s (test-only) `FORBIDDEN_ACTION_PATTERNS` was widened to catch `mass-generat(e|ing)` in either order / hyphenated and `purchase`/`purchasing` as a buy-links synonym — closing the non-blocking follow-up flagged in Sprint 5. All 9 `skills-content` tests stay green. This touches only the test-side pattern constant; no skill *content* and no shipped guard logic changed.

## How it fits

This is Feature F10 of the SEO suite and the penultimate sprint (13 of 14). It builds on the end-to-end-runnable, verifier-guarded pipeline from Sprints 11–12 by giving maintainers a reproducible, offline yardstick: change the analyzer prompt, the citation gate, or a skill library, and re-run the harness to see precision/recall move and to confirm the two invariants still hold. Run it via the test path (`npx vitest run src/seo/benchmark/harness.test.ts`); it needs no environment variable, provider key, or network.

## Notes for maintainers

- **The never-encode proof is via the citation gate, not a runtime content filter.** The pipeline has **no runtime never-encode content filter** — the only runtime enforcement is the citation gate (uncited ⇒ dropped). The corpus's `kb-never-encode-uncited` case is therefore deliberately authored **uncited** (`citationUrl: ""`), so the same drop that satisfies "zero uncited reach the hub" also satisfies "zero never-encode emitted", because neither finding ever reaches a sink. A *cited* finding whose text described a never-encode tactic would NOT be blocked by anything else and would (correctly, per the current architecture) reach the sink — so a cited never-encode case is intentionally **not** in the corpus (it would correctly fail the invariant). See `src/seo/benchmark/corpus/README.md` ("Why the never-encode case is authored UNCITED"). This is an honest, documented limitation of the proof, not a gap in the run.
- **Follow-up (future hardening):** if a runtime never-encode content *filter* on emitted findings is ever wanted (to also catch a hypothetical *cited* never-encode recommendation), that would be a new runtime stage — at which point the corpus should gain a cited never-encode case to exercise it. Until then, `neverEncodeEmitted` is proved only through the citation-gate drop.
- **This is not gated on a threshold.** Per the sprint's non-goal, the harness measures and reports; it does not fail a run when precision/recall dips. Wiring it into an evaluator gate is a deliberate future decision, not an oversight.
- **`NEVER_ENCODE_EMIT_PATTERNS` is a deliberate test-local mirror** of the widened `FORBIDDEN_ACTION_PATTERNS` — it is intentionally not imported from `skills-content.test.ts` (do not import a `.test.ts` const into a build file). If one list changes, keep the other in sync by hand.
- **Determinism discipline:** `BENCHMARK_NOW` (`harness.ts:102`) is a fixed constant threaded into every case's `now`; the harness never constructs a wall-clock `Date` and never calls `Math.random`.

## Scope

One commit — `92c07c8` — creating `src/seo/benchmark/harness.ts` (228 lines), `src/seo/benchmark/corpus/manifest.json` (98; 6 cases), `src/seo/benchmark/corpus/README.md` (83), and `src/seo/benchmark/harness.test.ts` (200; 14 tests), plus additive re-exports in `src/seo/index.ts` (+3) and the widened `FORBIDDEN_ACTION_PATTERNS` in `src/seo/skills-content.test.ts` (+3/−1). Runner/analyzer/citation-gate/hub-emitter/verifier/adapters/governor/egress and all skill *content* untouched; not wired into the CLI or any gate; no new dependencies. All 4 required criteria (sc-13-1..13-4) passed on **iteration 1**; full suite **4506 passed | 1 skipped | 0 failed** (`src/seo` 216).
