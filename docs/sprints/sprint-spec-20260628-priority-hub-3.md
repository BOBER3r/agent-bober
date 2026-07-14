# Query scope parsing and two-pass prioritization judge

**Contract:** sprint-spec-20260628-priority-hub-3  ·  **Spec:** spec-20260628-priority-hub  ·  **Completed:** 2026-06-29

## What this sprint added

Sprint 3 gives the hub its **ranking brain**. It adds an ephemeral query `Scope`
(general / decision / filtered) and a two-pass `rankFindings` judge that turns a pooled
`Finding[]` into a ranked `Finding[]`. The design boundary is the headline: **the LLM only
ranks (relevance verdict + per-lens scores); deterministic JS arranges** the final order, so
repeated runs against the same fake client return byte-identical output. The judge takes an
**injected `LLMClient`** (no provider/SDK import) so the whole pass is unit-tested offline,
and it carries **hub-specific** prioritization lenses (urgency / impact / effort / deadline-risk)
that are deliberately distinct from the orchestrator's eval lenses. No-consensus findings are
**kept and flagged**, never dropped. This is all internal plumbing — nothing is wired to a CLI
yet (the `priority` / `decide` commands are Sprint 4).

## Public surface

- `Scope` (`src/hub/scope.ts:13`) — discriminated union on `mode`:
  `{ mode: "general" }` | `{ mode: "decision"; optionA: string; optionB: string }` |
  `{ mode: "filtered"; domain?: string; dueWithinDays?: number; tag?: string }`.
  Ephemeral, per-call, **never persisted**.
- `parseScope(raw: unknown): Scope` (`src/hub/scope.ts:39`) — Zod `discriminatedUnion("mode").safeParse`
  with a **fallback to `{ mode: "general" }` on any failure — never throws**.
- `applyFilter(findings, scope, now): Finding[]` (`src/hub/scope.ts:59`) — **pure** (no LLM, no
  async, no side effects). For `filtered` mode keeps findings matching **all** specified
  constraints (`domain` AND `tag` AND `dueBy` within `dueWithinDays` of the injected `now`); a
  finding with no `dueBy` does **not** satisfy a `dueWithinDays` constraint. For non-filtered
  scopes returns the input unchanged (pass-1 handles those).
- `HUB_LENS_NAMES` / `HubLensName` (`src/hub/lenses.ts:26`) — the closed 4-lens tuple
  (`urgency`, `impact`, `effort`, `deadline-risk`).
- `resolveHubLensFocus(lens): string` (`src/hub/lenses.ts:42`) — maps a lens name to its focus
  fragment from the module-private `HUB_LENS_CATALOG`; returns a generic non-empty fallback for an
  unknown string — **never throws**.
- `RelevanceVerdictSchema` / `RelevanceVerdict` (`src/hub/lenses.ts:55`) — pass-1 shape:
  `{ relevant: boolean; relevantTo?: "optionA"|"optionB"|"both"|"neither"; reason?: string }`.
- `LensScoreSchema` / `LensScore` (`src/hub/lenses.ts:69`) — pass-2 shape:
  `{ include: boolean; score: number (0–10); reason?: string }`.
- `validateRelevanceVerdict(rawText): RelevanceVerdict | null` (`src/hub/lenses.ts:124`) and
  `validateLensScore(rawText): LensScore | null` (`src/hub/lenses.ts:141`) — defensive parsers over
  a shared **four-tier `extractJson`** (direct parse → fenced ```json``` block → first `{ … }` block
  → null). Both return `null` on any failure (treated as no-vote / fail-closed) and **never throw**.
- `rankFindings(findings, scope, llm, now): Promise<Finding[]>` (`src/hub/judge.ts:174`) — the
  two-pass judge. Input array and `Finding` objects are **never mutated**. See below.

## How to use / how it fits

`rankFindings` runs three stages:

1. **Filtered fast path (zero LLM calls).** When `scope.mode === "filtered"`, it calls
   `applyFilter` and returns a deterministically sorted copy — no relevance pass, no lens pass,
   no aggregate score. This is the pure-JS path proven to make **zero** `llm.chat` calls.
2. **Pass 1 — LLM relevance.** For `general` / `decision`, it asks the injected `llm` per finding
   (`model: "hub-relevance"`, `jsonObjectMode: true`) and parses with `validateRelevanceVerdict`.
   A `null` verdict or `relevant: false` **drops** the finding (fail-closed). Under `decision`
   scope it additionally drops anything whose `relevantTo` is not `optionA` / `optionB` / `both`
   (i.e. `neither` and `undefined` are dropped) — so a finding relevant to **either** named option
   survives and is ranked within that frame.
3. **Pass 2 — hub lens fan-out + reconcile + deterministic sort.** For each survivor it fans out
   all four hub lenses (`model: "hub-lens"`). `aggregateScore` = **SUM** of the four per-lens
   scores (range 0–40). Reconcile is **strict majority, fail-closed on tie**: `passVotes > failVotes`
   → ranked normally; otherwise (tie or fail-majority) the finding is **kept** and tagged
   `"flagged-for-review"`. The final order is a stable deterministic sort:
   `aggregateScore` DESC → `urgency` DESC → `severity` DESC → `dueBy` ASC (`undefined` treated as
   `+Infinity`, sorts **last**) → `id` ASC. **The LLM never emits the final ordering.**

```ts
import { parseScope } from "./scope.js";
import { rankFindings } from "./judge.js";

const scope = parseScope({ mode: "decision", optionA: "Job A", optionB: "Job B" });
// llm is any providers/types LLMClient; tests pass a ScriptedClient fake returning canned JSON
const ranked = await rankFindings(pooledFindings, scope, llm, new Date());
```

Sprint 4 will pass a real `LLMClient` here and render the ranked output to `priority.md` /
wire the `priority` and `decide` CLI commands.

## Notes for maintainers

- **LLM ranks, deterministic JS arranges.** This boundary is the contract's central non-goal
  ("Do not let the LLM emit the final ordered list"). The model contributes only a relevance
  verdict and per-lens 0–10 scores; `compareFindings` (`src/hub/judge.ts:143`) computes order. If
  you add a tie-breaker, add it to `compareFindings`, never to a prompt.
- **`"flagged-for-review"` is appended to a SPREAD COPY of `tags`** (`src/hub/judge.ts:222`):
  `{ ...finding, tags: [...finding.tags, "flagged-for-review"] }`, guarded by an `includes` check
  so it is not duplicated. The input `Finding[]` and every `Finding` object are left untouched, and
  the **`Finding` schema is unchanged** — the flag is just another tag string, not a new field.
  Vote splits `2–2` / `0–4` / `1–3` flag; `3–1` does not.
- **Fail-closed everywhere.** An unparseable relevance verdict drops the finding; an unparseable
  lens response is treated as `{ include: false, score: 0 }` (contributes to `failVotes`, adds 0 to
  the aggregate). `parseScope`, `resolveHubLensFocus`, `validateRelevanceVerdict`, and
  `validateLensScore` all never throw.
- **Hub owns its own lenses — do NOT reuse the eval lenses.** `HUB_LENS_CATALOG` is private to
  `lenses.ts`; it is intentionally **not** the orchestrator's
  correctness/security/regression/quality/simplicity catalog, which is pinned by a drift gate at
  `src/orchestrator/lens-panel-parity.test.ts`. The fan-out **shape** mirrors
  `src/orchestrator/eval-lenses.ts`; the lens **content** is hub-specific prioritization.
- **The clock is injected.** `applyFilter` and `rankFindings` take `now: Date`; nothing in this
  module calls `Date.now()`. Pass the clock from the caller (the CLI boundary in Sprint 4).
- **Injected `LLMClient`, no SDK leakage.** `judge.ts` imports only the type from
  `../providers/types.js` (mirroring `src/chat/answerer.ts`); there is **no** `createClient` / SDK
  import. Tests drive it with a `ScriptedClient` fake that records every `ChatParams`, so the
  filtered = 0-calls and "no real network call" guarantees are asserted directly.

## Scope

Commit `01af871`: five new files under `src/hub/`, **+1038 / -0**, no existing code touched
(`eval-lenses.ts` and `finding.ts` byte-unchanged), no new dependencies, `Finding` schema
unchanged. `scope.ts` (`Scope` union + `parseScope` + pure `applyFilter`), `lenses.ts`
(`HUB_LENS_CATALOG`/`HUB_LENS_NAMES`/`resolveHubLensFocus` + the two Zod schemas + four-tier
`extractJson` + `validateRelevanceVerdict`/`validateLensScore`), `judge.ts` (`rankFindings`
two-pass judge), plus collocated `scope.test.ts` (22 tests) and `judge.test.ts` (16 tests, with a
`ScriptedClient` fake). +38 new tests; per the eval, 69 hub tests and 73 medical/recommend +
eval-lenses regression tests are green; typecheck + build + lint exit 0 (2 pre-existing unrelated
lint warnings in `eval-persist.test.ts`). All six required criteria (`sc-3-1..sc-3-6`) passed
**iteration 1**. Eval `eval-sprint-spec-20260628-priority-hub-3-1` → **pass** (6/6 required).

The judge is **internal** this sprint — `priority.md` rendering + the `priority` / `decide` CLI
commands are **Sprint 4**, and the chat hub surface is **Sprint 5**.

> Process footnote: the first generator attempt was interrupted by an API connection error after
> `scope.ts` / `lenses.ts` / `scope.test.ts` landed; a continuation generator added `judge.ts` /
> `judge.test.ts` and committed the whole sprint as one commit (`01af871`). The committed final
> state is what was evaluated.
