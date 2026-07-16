# Signature parser + generic-floor skill + playbook index + retriever

**Contract:** sprint-spec-20260715-ultimate-seo-suite-2  ·  **Spec:** spec-20260715-ultimate-seo-suite  ·  **Completed:** 2026-07-16

## What this sprint added

The **knowledge layer** for the SEO suite: the on-disk `bober.seo-*` signature-block authoring format and the total parser that reads it, the first real signature library, plus a memoising index and a never-empty retriever. Four additive pieces landed (all pure/offline, no network): (1) `SeoPlaybookParser` — a pure, TOTAL markdown parser that turns a skill file into typed `SeoSignature[]`, **dropping** any block that is uncited (no `PrimarySourceUrl`) or tagged `PolicyClass: never-encode`; (2) `skills/bober.seo-generic/SKILL.md` — the authored generic-floor library, **12 cited signatures + 1 dropped `never-encode` boundary block** (13 blocks total), each surviving signature carrying a curl-verified HTTP-200 primary source; (3) `SeoPlaybookIndex` — a per-process memoised, `[]`-safe catalog that `readdir`s every `skills/bober.seo-*/SKILL.md`; and (4) `SeoPlaybookRetriever.retrieve()` — a ranked, **never-empty** (generic-floor-included) selector that dedupes by `playbookId`. The signature format defined here is the **reference contract that the per-workflow skill-content sprints 3–5 must follow.** No adapters, analyzer wiring, or CLI yet (later sprints).

## Public surface

- `SeoPlaybookParser.parse(markdown, skillRelPath)` (`src/seo/parser.ts:151`) — pure/total; returns only the surviving `SeoSignature[]`. No fs access, never throws; `typeof markdown !== "string"` yields `[]`.
- `SeoPlaybookParser.parseWithDiagnostics(markdown, skillRelPath)` (`src/seo/parser.ts:156`) — same, plus `{ signatures, dropped }` where `dropped` is the count of blocks removed by the drop rules (for report-diagnostics auditability).
- `SeoPlaybookIndex` (`src/seo/playbook-index.ts:31`) — constructor takes an optional `skillsRoot` (defaults two levels up from `src/seo/` to `<packageRoot>/skills`).
  - `.load()` (`:43`) — parses every `skills/bober.seo-*/SKILL.md` once and memoises a **flat** `SeoSignature[]`; idempotent (a second call returns the same array instance without re-reading disk). Never throws — a missing skills dir, or any unreadable/unparseable `SKILL.md`, degrades to `[]` for that source.
  - `.all()` (`:70`) — the memoised list, or `[]` before `load()`.
  - `.generic()` (`:75`) — only signatures whose `skillRef` includes `bober.seo-generic` (the retriever's always-included floor).
- `SeoPlaybookRetriever` (`src/seo/retriever.ts:120`) — constructed from a `SeoPlaybookIndex`.
  - `.retrieve({ workflow, target?, vertical?, topK? })` (`:128`) — loads (idempotent), ranks the workflow's matching signatures, always appends the generic floor deduped by `playbookId`, and returns `{ promptFragment, signatures }`. `promptFragment` is **never empty** (falls back to a hard-coded `SEO_GENERIC_FLOOR` string). `topK` defaults to `8`.
- `SeoRetrieveInput` / `SeoRetrieveResult` (`src/seo/retriever.ts:15`, `:22`) — retrieve I/O types.
- `skills/bober.seo-generic/SKILL.md` — the authored generic-floor library (a data file, not a workflow skill). Its "Signature Block Format" section and `SeoPlaybookParser` are **one executable spec** — keep them in sync.
- Barrel `src/seo/index.ts` now also re-exports `SeoPlaybookParser`, `SeoPlaybookIndex`, `SeoPlaybookRetriever`, and the two retrieve types.

## The signature-block authoring format (reference for sprints 3–5)

Each signature is a level-3 heading whose text is the `playbookId`, followed by labelled list fields. The parser splits on `^### ` (after stripping YAML frontmatter). Fields:

```markdown
### <playbookId>
- **Title:** <human-readable title>
- **Workflows:** comma, separated, SeoWorkflow, members
- **Tactic:** <the recommended action>
- **Invariant:** <the evidence-backed claim this signature encodes>
- **PrimarySourceUrl:** <REQUIRED citation URL>
- **PolicyClass:** auto-safe|human-approve|never-encode
- **EvidenceGrade:** verified|primary-unverified|single-source
- **Keywords:** comma, separated, keywords
```

- **Hard fields (missing/invalid → block DROPPED):** `playbookId` (non-empty heading text), `Title`, `PrimarySourceUrl` (non-empty), and a **valid** `PolicyClass`.
- **Soft fields (default rather than drop):** `Workflows` (invalid members filtered out, default `[]`), `Tactic` (`""`), `Invariant` (`""`), `EvidenceGrade` (default `single-source` if absent/invalid), `Keywords` (`[]`).
- SEO blocks carry **no code fences** — `Tactic` replaces the security library's unsafe/safe example pair, so there is no `extractFencedExample` machinery.

### The two drop rules

1. **No-uncited-claim:** a block missing or with an empty `PrimarySourceUrl` is dropped (`parser.ts:108`). This is the whole point of the format — every surviving signature is cited.
2. **Never-encode:** `PolicyClass: never-encode` is dropped (`parser.ts:111`), even when every other field is valid. It documents the automation boundary (parasite SEO, expired-domain plays, paid links, mass AI pages, AI-recommendation poisoning) for human readers but must never reach an analyzer prompt. `SeoSignature.policyClass` is therefore only ever `auto-safe | human-approve` at runtime.

The generic skill exercises rule 2 with its `parasite-seo-placement` block (`SKILL.md:163`) — authored in full so a maintainer sees the boundary, then dropped at load time.

## Citation discipline — the load-bearing lesson for sprints 3–5

**Every `PrimarySourceUrl` must be a real, curl-verified HTTP-200 URL.** The parser can only enforce that a URL is *present and non-empty* — it cannot tell a real slug from a plausible-looking hallucinated one. That gap is exactly the failure mode this sprint's format exists to prevent, and the evaluator closes it by independently `curl`-checking every citation.

This sprint **failed iteration 1 on sc-2-2**: 4 of the 12 generic-skill citation URLs were fabricated slugs that returned HTTP 404 —
`ahrefs.com/blog/ai-overviews-study/`, `semrush.com/blog/ai-citations-study/`, the SparkToro leak URL missing its `-in-seo-` segment, and `developers.google.com/.../core-and-spam-updates-rolling-out`. The correct URLs existed at different slugs in the research report. The fix commit (`67d0d07`) rewrote the citation URLs against a curl-verified HTTP-200 map (7 distinct old→new URLs across 10 block lines, going beyond just the 4 flagged) and **touched nothing else** — parser/index/retriever and all tests stayed byte-identical. All **8 unique** final URLs (7 across the 12 surviving blocks + 1 for the dropped `never-encode` block) return 200, content-matched to each block's invariant.

**Guidance for sprints 3–5:** do not write a `PrimarySourceUrl` you have not fetched. Pull the exact slug from the research report or `curl -sI` the URL for a `200` before committing. A "non-empty but wrong" URL passes the parser and the unit suite but is caught (as a hard fail) by the evaluator — cheaper to verify up front than to burn an iteration.

## How it fits

`SeoPlaybookIndex` auto-discovers skills by directory glob (`bober.seo-*`), so sprints 3–5 add per-workflow libraries simply by creating `skills/bober.seo-<workflow>/SKILL.md` in this format — no code change to the index. The retriever is `generic()`-floored so an empty or missing skills dir still yields useful guidance, and the ranked result (workflow-membership + target/vertical keyword overlap, capped at `topK`, then floor appended deduped by `playbookId`) is what the analyzer sprint (10) will consume. Minimal use:

```ts
import { SeoPlaybookIndex, SeoPlaybookRetriever } from "./seo/index.js";

const retriever = new SeoPlaybookRetriever(new SeoPlaybookIndex());
const { promptFragment, signatures } = await retriever.retrieve({ workflow: "ai-visibility" });
// promptFragment is guaranteed non-empty; signatures are deduped by playbookId.
```

## Notes for maintainers

- **`SKILL.md` and `parser.ts` are one spec.** The block format is documented in both the skill file's "Signature Block Format" section and the parser's header comment; a change to either must be mirrored. The `LABEL_RE` regex (`parser.ts:77`) is the exact field grammar.
- **Structural mirror, two deliberate divergences from the security template.** The parser/index/retriever mirror `src/orchestrator/security-knowledge/{parser,index,selector,resolver}.ts`, with two intentional differences: the index is a **flat** auto-discovered list (not a fixed per-stack registry) and its `load()` **returns** the memoised list (the security `load()` returns void); and selector + resolver are folded into one `retriever.ts` because the contract lists a single code file. The retrieval method is `retrieve` (not the architecture table's `resolve`) because sc-2-4 and the evaluator bind that name.
- **`never-encode` never becomes a runtime value.** `SeoSignature.policyClass` is typed `auto-safe | human-approve` (types.ts, Sprint 1); the parser drops `never-encode` before construction. Do not widen that union to include `never-encode`.
- **12 surviving signatures, 9 graded `verified` / 3 `single-source`.** sc-2-2 requires ≥10; the generic floor authors 12 (the `single-source` three are `query-fan-out-coverage`, `sitefocus-topical-authority`, `schema-entity-aio-lift`). Two research claims the report refuted (ChatGPT-Wikipedia dominance, Reddit-leading-AI-Overviews) are deliberately NOT encoded anywhere in the file.

## Scope

Two commits. `3f22c74` added `src/seo/{parser,playbook-index,retriever}.ts` + collocated tests (`parser.test.ts`, `playbook-index.test.ts`, `retriever.test.ts`), the barrel re-exports in `src/seo/index.ts`, and `skills/bober.seo-generic/SKILL.md` (978 insertions). `67d0d07` (iteration-2 fix) changed **only** `skills/bober.seo-generic/SKILL.md`, correcting the citation URLs. All 5 required criteria (sc-2-1..2-5) passed on **iteration 2**; full suite **4331 passed | 1 skipped | 0 failed** (src/seo 41 tests), all 8 unique citation URLs curl-verified 200.
