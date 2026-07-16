# Runtime NeverEncodeFilter (third never-encode belt)

**Contract:** sprint-spec-20260717-seo-improver-builder-2  ·  **Spec:** spec-20260717-seo-improver-builder  ·  **Completed:** 2026-07-17

## What this sprint added

A **pure, total, DROP-only `NeverEncodeFilter`** wired into `SeoWorkflowRunner.run`
between the `analysis.parsed` fail-closed check and the citation gate. This is the
**third** never-encode belt (ADR-3), and the first one that operates at **runtime on the
analyzer's output** rather than on authored skill content. Belts 1 and 2 — the parse-time
drop (`parser.ts:111`, `PolicyClass: never-encode`) and the skill-content lint
(`skills-content.test.ts`) — only ever see tactics that were written into a `SKILL.md`
file. This belt catches a banned tactic that the **LLM analyzer synthesized on the fly**,
one that was never in any skill file, **even when it carries a well-formed `citationUrl`
that would otherwise sail straight through `SeoCitationGate`**. It is a hard precondition
of the Phase-2 builder (ADR-1/ADR-3/ADR-4). The `SeoReport.droppedNeverEncode` counter —
a placeholder hardcoded to `0` since Sprint 1 — is now populated for real.

## Public surface

- `NeverEncodeFilter` (`src/seo/never-encode-filter.ts:52`) — a class with a single
  `apply(findings: SeoFinding[]): NeverEncodeResult` method that partitions findings into
  `kept` / `dropped` by banned-tactic text matching. Purity model copied verbatim from
  `SeoCitationGate.apply`: imports **only** `./types.js`; no LLM, egress, filesystem,
  clock, or `Math.random`; identical input always yields identical output; never throws.
  **DROP-only** — unlike the citation gate it computes **no** `blocked`/exit-2 signal
  (ADR-3, nonGoal #1): a single hallucinated phrase must not brick an otherwise-clean run.
- `NeverEncodeResult` (`src/seo/never-encode-filter.ts:14`) — `{ kept: SeoFinding[];
  dropped: SeoFinding[] }`. `kept` is the ONLY set passed downstream to the citation gate.
- `NEVER_ENCODE_PATTERNS` (`src/seo/never-encode-filter.ts:37`) — the exported
  `readonly RegExp[]` (9 regexes) covering all 8 sc-2-2 never-encode classes: parasite
  SEO, expired-domain, paid/bought links, PBN/link schemes, mass AI pages, cloaking,
  doorway pages, AI-recommendation poisoning. Case-insensitive and `\b`-anchored to avoid
  over-matching clean recommendations. The first six mirror the existing
  `FORBIDDEN_ACTION_PATTERNS` (`skills-content.test.ts`) / retriever floor
  (`retriever.ts:34-37`); PBN, cloaking, and doorway are new this sprint. Exported as a
  single const so the parser floor, the benchmark mirror, and this filter share intent.
- Barrel re-exports (`src/seo/index.ts:56-57`) — `NeverEncodeFilter`,
  `NEVER_ENCODE_PATTERNS`, and the `NeverEncodeResult` type.

## How to use / how it fits

The filter is not called directly by users — it runs inside every `bober seo <workflow>`
invocation. Placement in `SeoWorkflowRunner.run` (`src/seo/runner.ts`):

```ts
// ... after the analysis.parsed === false fail-closed check (exit 2, zero hub emits) ...
const scrubbed = new NeverEncodeFilter().apply(analysis.findings);

const threshold = input.config.seo?.blockThreshold ?? "critical-uncited";
const gate = new SeoCitationGate().apply(scrubbed.kept, threshold); // gate sees kept ONLY
// ...
const report: SeoReport = {
  // ...
  droppedNeverEncode: scrubbed.dropped.length, // was hardcoded 0 since Sprint 1
  verdict: gate.blocked ? "blocked" : "pass",
};
```

The updated pipeline order is: resolve playbook → select source → gather → analyze →
**never-encode filter** → citation gate → (opt-in verifier) → persist → best-effort hub
emit → exit code. Because the filter runs *before* the gate, a dropped never-encode
finding never becomes a `cited` finding and never reaches the report or the priority hub —
regardless of how well-formed its citation is.

## Notes for maintainers

- **DROP-only is intentional and load-bearing.** The filter deliberately does not emit a
  block flag or force exit-2 (nonGoal #1) — it matches the parse-time drop semantics
  (ADR-3). If you ever want banned tactics to hard-fail a run, that is a citation-gate /
  `blockThreshold` concern, not this filter's.
- **An all-clean findings set is unchanged** (`kept === input`, `dropped` empty) — proved
  by test. The filter only ever removes, never reorders or rewrites, kept findings.
- **The banned-tactic scan reads `recommendation` + all evidence fields**
  (`metric`/`value`/`source`/`url`), joined and tested case-insensitively. If you add new
  never-encode classes, extend `NEVER_ENCODE_PATTERNS` and keep the `\b` anchoring so
  clean recommendations (e.g. "Add a self-referencing canonical tag") are not caught.
- **Keep the pattern const the single source of truth.** It is deliberately shared with
  the parser floor / retriever floor / benchmark mirror; do not fork a second copy.
- **`droppedNeverEncode` is now real everywhere.** The Sprint-1 placeholder comment in
  `runner.ts` was removed; every `SeoReport` built by the runner now reports the true
  filter drop count.

## Scope

One commit — `9f22314` — adding `src/seo/never-encode-filter.ts` (+ collocated
`never-encode-filter.test.ts`), wiring `src/seo/runner.ts` (filter call + real
`droppedNeverEncode` + updated `runner.test.ts`), adding the barrel re-exports in
`src/seo/index.ts`, and refreshing the `SeoReport.droppedNeverEncode` docstring in
`src/seo/types.ts`. No LLM, no network, no new deps; the citation gate's own logic and the
benchmark corpus were untouched. All 5 required criteria (sc-2-1..2-5) passed on
**iteration 1**; build/typecheck/lint clean; full suite **4534 passed | 1 skipped |
0 failed**, zero regressions.
