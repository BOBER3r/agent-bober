# MedlinePlus grounded retrieval + cited synthesis (opt-in) — plan finale

**Contract:** sprint-spec-20260616-medical-team-7  ·  **Spec:** spec-20260616-medical-team  ·  **Completed:** 2026-06-17

## What this sprint added

The **opt-in networked slice** that completes the medical team: the **real
MedlinePlus / NIH (no-auth) grounded retrieval + cited LLM synthesis**, replacing the
Sprint 6 always-abstain stub. With the `literature-retrieval` egress axis **on**,
`LiteratureRetriever.retrieve` now queries the MedlinePlus Web Service and parses the
response into `Passage[]`, and `synthesize` makes a **single provider-agnostic
`LLMClient.chat` call** (local Ollama by default) that answers **only** from the
retrieved passages — abstaining unless a passage supports the claim, and attaching
**≥ 1 citation** to every non-abstained clinical answer. The live network fetch lives
in the **one** ESLint-excepted file (`src/medical/retrieval/medline-source.ts`) and is
fronted by `EgressGuard.assertAllowed("literature-retrieval")` as its very first
statement. The path is **fail-closed at three independent layers** (axis off, source
error, model unavailable), and enabling literature retrieval does **not** enable
cloud inference — both egress axes stay independent and the `cloud-inference` axis
remains off. This is **Sprint 7 of 7 — the plan is engineering-complete**.

## Public surface

### `src/medical/retrieval/medline-source.ts` — the single network file

- `interface Passage` (`medline-source.ts:12`) — one retrieved passage:
  `{ title; url; text; source: "medlineplus" }`. `title` + `url` form the citation;
  `text` is the body the synthesizer grounds on.
- `type RetrievalOutcome` (`medline-source.ts:25`) — discriminated union (unchanged
  shape from S6, `grounded` arm now real): `{ kind: "disabled" }` (axis off) |
  `{ kind: "abstain"; reason }` (axis on, no passages / error) |
  `{ kind: "grounded"; passages: Passage[] }`.
- `type FetchLike` (`medline-source.ts:37`) — **injectable transport**:
  `(url: string) => Promise<{ ok; status; json(): Promise<unknown> }>`. A duck-typed
  minimal fetch surface (no `AbortSignal`, deliberately not the global `Response`) so
  tests pass a fake returning fixture data without referencing the banned global
  `fetch` in test files.
- `class MedlineSource` (`medline-source.ts:123`) — constructor
  `(egress: EgressGuard, fetchImpl: FetchLike = fetch)`. The `fetch` global is the
  default **only here** (the ESLint exception); tests inject `fetchImpl`.
  - `fetchPassages(query)` (`medline-source.ts:142`) — calls
    `egress.assertAllowed("literature-retrieval")` **first**, builds the MedlinePlus
    URL, awaits `fetchImpl(url)`, and parses the JSON into `Passage[]`. Returns
    `grounded` (passages) | `abstain{no-passages}` (empty) | `abstain{source-error}`
    (`!res.ok`, network throw, parse error, or axis-off `assertAllowed` throw — all
    caught). **Never throws out of this method; never returns fabricated content.**

### `src/medical/retrieval/literature.ts` — orchestration + synthesis

- `class LiteratureRetriever` (`literature.ts:15`) — `retrieve(query)`
  (`literature.ts:31`) checks `egress.isAllowed("literature-retrieval")` **before** the
  source: axis off ⇒ `{ disabled }` synchronously (zero-egress proof preserved from
  S6); axis on ⇒ delegates to `MedlineSource.fetchPassages`, with a belt-and-braces
  `catch` mapping any throw to `abstain{source-error}`.
- `synthesize(query, outcome, llm, footer)` (`literature.ts:98`) — the cited-synthesis
  entry point. Single `llm.chat` call pinned to the passages; returns a
  `MedicalAnswer`. See rules below.

### `src/medical/types.ts`

- `interface Citation` (`types.ts`) — placeholder replaced with real fields:
  `{ title; url; source: "medlineplus" }`.

### `src/medical/engine.ts` — grounded branch wired into the SOP

- `MedicalSopEngine.run` (`engine.ts:358`) — the answer-composition step now branches:
  when `outcome.kind === "grounded"` and there is no numeric answer, it resolves an
  `LLMClient` **lazily on this path only** (`this.deps?.llmClient ?? createClient(
  "openai-compat", "http://localhost:11434/v1", undefined, "llama3")`,
  `engine.ts:364`) and calls `synthesize(...)`. Numeric / disabled / red-flag /
  abstain paths construct **no** LLM client (preserving sc-7-8 and the S2/S3
  never-called assertions). The audit event is derived from `answer.abstained`.

### Fixture

- `src/medical/retrieval/__fixtures__/medlineplus-sample.json` — sanitized
  `nlmSearchResult` response (two metformin / type-2-diabetes passages) that drives
  the offline retrieval + synthesis tests.

## How to use / how it fits

Opt in by enabling the axis (it is **off** by default):

```jsonc
// bober.config.json — opt in to MedlinePlus retrieval (still no cloud inference)
{
  "medical": {
    "egress": {
      "cloudInference": false,        // stays off — independent axis
      "literatureRetrieval": true     // permit the MedlinePlus fetch + grounded synthesis
    }
  }
}
```

With the axis on, a literature question in `MedicalSopEngine.run` flows:
`retrieve → grounded{passages} → synthesize → MedicalAnswer` with the answer body
grounded in the passages and `citations.length >= 1`. The LLM is the
**provider-agnostic `LLMClient`** resolved for the medical team (local Ollama
`llama3` via `createClient("openai-compat", localhost:11434)` by default; inject
`deps.llmClient` to use another local provider). No cloud provider is ever
constructed by this path. With the axis off, behavior is byte-identical to Sprint 6:
`retrieve` returns `{ disabled }` synchronously and the turn abstains with zero
outbound bytes.

### The three fail-closed layers (never a fail-open / uncited claim)

1. **Axis off / `assertAllowed` throws** — `fetchPassages` catches it ⇒
   `abstain{source-error}`; `synthesize` on a `disabled`/`abstain` outcome returns an
   **abstained** `MedicalAnswer` with `citations: []` and **no clinical assertion**,
   without calling the LLM at all.
2. **Source error** — `!res.ok` (e.g. 503), network throw, empty `document[]`, or a
   malformed response ⇒ `abstain` ⇒ LLM never called ⇒ abstained answer.
3. **Model unavailable** — `llm.chat` throws (e.g. Ollama down) ⇒ caught ⇒ abstained
   answer with a *"model unavailable"* body. **No cloud fallback.**

### Abstain-unless-supported + citation rules (enforced in `synthesize`)

- The synthesis system prompt pins the model to the passages and instructs it to reply
  with the single word `ABSTAIN` if they do not support a specific answer.
- An empty response **or** `ABSTAIN` (case-insensitive) ⇒ abstained answer,
  `citations: []`.
- A non-abstained answer attaches citations derived from the passages
  (`passagesToCitations`) — `passages.length > 0` on the grounded path guarantees
  `citations.length >= 1`. **There is no code path that emits a non-abstained answer
  with zero citations.**

## Notes for maintainers

- **The network boundary still holds — one file, runtime defense-in-depth.**
  `src/medical/retrieval/medline-source.ts` remains the **only** medical file that
  touches `fetch` / `Response`, and it is the **only** file with the ESLint
  `no-restricted-imports` / `no-restricted-globals` override (S6's boundary is
  unchanged). `assertAllowed("literature-retrieval")` is the **first** statement in
  `fetchPassages`, so the runtime guard backs the static lint boundary even if the
  lint exception were ever widened.
- **CI is fully offline.** All retrieval/synthesis tests inject a duck-typed
  `FetchLike` fake + the committed `__fixtures__/medlineplus-sample.json` and a fake
  `LLMClient`; no live HTTP runs in CI. (An optional live-endpoint integration test, if
  added, must sit behind an env flag and be skipped by default — a non-goal here.)
- **`URLSearchParams` is not used** — the MedlinePlus URL is built by manual
  `encodeURIComponent`, because `URLSearchParams` is not declared as a global in the
  ESLint config and adding it would touch the boundary.
- **Citation granularity is coarse by design.** Because all passages are pinned into
  the single synthesis prompt, `passagesToCitations` cites **all** retrieved passages
  for a non-abstained answer rather than tracking which passage each sentence used.
  Per-sentence citation attribution is a possible future refinement, not a guarantee
  this sprint makes.
- **Single source only (ADR-6).** MedlinePlus / NIH is the one source; a second source
  (e.g. PubMed/PMC) would be a new class in its own file plus its own sanctioned
  network exception — explicitly a non-goal here.
- **Cloud inference stays independently off.** `EgressGuard(false, true)` keeps
  `isAllowed("cloud-inference") === false`; the grounded path never constructs a cloud
  provider and never falls back to one. Enabling literature retrieval does **not**
  enable cloud inference.

## Plan close-out — Medical Team is engineering-complete (7 of 7)

`spec-20260616-medical-team` is **engineering-complete on branch
`bober/medical-team`**: 7 of 7 sprints passed evaluation (this finale passed all 8
criteria on iteration 1), the full suite is green at **2393 tests** (no regressions),
and the **five code-enforced safety guarantees** are verified:

1. **Fail-closed consent** (Gate 1, S2) — no consent ⇒ refuse, zero downstream calls.
2. **Deterministic red-flag short-circuit** (Gate 2, S3) — canned, never-model-generated
   911/988 escalation, 0 LLM.
3. **Arithmetic out of the LLM** (S4) — closed 8-primitive `NumericsQueryLayer`
   whitelist, no `eval`/`Function`/`vm`/`child_process`.
4. **Code-enforced zero-egress default** (S6) — two independent axes default `false` +
   scoped ESLint network boundary; default outbound bytes = 0.
5. **Abstain-unless-supported, fail-closed retrieval** (S7) — grounded synthesis cites
   ≥ 1 passage or abstains; three independent fail-closed layers; no uncited clinical
   claim.

**It ships nothing to cloud by default.** Both egress axes default `false` and consent
is fail-closed, so a fresh-config medical turn makes zero outbound calls. **Shipping /
enabling the medical team remains gated on the EXTERNAL S6.5 review** — FFDCA
§201(h) (device/intended-use) counsel + regulatory sign-off. That review is **not a
buildable sprint** and is not part of this plan's engineering completion; the code is
done, the regulatory gate is open.

**Advisory carry-forward (not a bug to fix in code).** Red-flag detection uses **ADR-2
conservative phrase matching**, which has **known false-negatives** (novel phrasing may
miss and fall through to the normal path). This is an intentional precision-over-recall
choice; the gap is surfaced to the **patternset revision / S6.5 counsel review**, not
patched by widening matching here (over-broad matching would degrade the gate).
