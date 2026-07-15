# Sprint Briefing: Query scope parsing and two-pass prioritization judge

**Contract:** sprint-spec-20260628-priority-hub-3
**Generated:** 2026-06-28T00:00:00Z

> The single closest precedent for this entire sprint is `src/medical/recommend/`
> (`lenses.ts` + `judge-panel.ts` + `types.ts` + their `.test.ts`). It is a lens
> panel with strict-majority/fail-closed reconcile, an injected `LLMClient`, defensive
> Zod parsing, and a `ScriptedClient` fake. **MIRROR ITS SHAPE.** This sprint differs in
> two ways only: (a) define hub prioritization lenses, NOT medical lenses; (b) the
> reconcile tie outcome is `flagged-for-review` (keep), not `reject` (drop).

---

## 1. Target Files

All five files are **create** (none exist yet — `ls src/hub/` shows only
`finding*`, `finding-source*`, `collector*`, `repo-resolver*`).

### src/hub/scope.ts (create)

**Directory pattern:** `src/hub/` uses kebab-less single-word lowercase filenames
(`finding.ts`, `collector.ts`, `repo-resolver.ts`). Collocated `*.test.ts`.

**What to build (from generatorNotes):**
- A `Scope` discriminated union on `mode`:
  ```ts
  export type Scope =
    | { mode: "general" }
    | { mode: "decision"; optionA: string; optionB: string }
    | { mode: "filtered"; domain?: string; dueWithinDays?: number; tag?: string };
  ```
- `parseScope(...)` helper that builds one of those variants.
- `applyFilter(findings: Finding[], scope: Scope, now: Date): Finding[]` — **PURE JS, NO LLM**.
  For `filtered` mode keep findings matching `domain` AND/OR `tag` AND/OR `dueBy` within
  `dueWithinDays` of `now`; for non-filtered modes return `findings` unchanged (the LLM pass-1
  handles those). `dueBy` is an optional ISO string (`Finding.dueBy`); a finding with no
  `dueBy` does NOT satisfy a `dueWithinDays` constraint.

**Imports it will need:**
- `import type { Finding } from "./finding.js";` (Sprint 1 — see §4)

**Test file:** `src/hub/scope.test.ts` (create) — pure, no fake client needed.

---

### src/hub/lenses.ts (create)

**Most similar existing file:** `src/orchestrator/eval-lenses.ts:1-28` (catalog idiom) and
`src/medical/recommend/lenses.ts` (full lens-adapter module with Zod parse). Mirror the
*shape* of the eval catalog but define the hub's **own** prioritization lenses.

**What to build:** a `Record<string,string>` catalog of focus fragments for the hub
prioritization lenses (e.g. `urgency`, `impact`, `effort` / ROI, `deadline-risk`) plus a
`resolveLensFocus`-style resolver. DO NOT reuse the eval `correctness/security/regression/
quality/simplicity` fragments. See §2 Pattern A for the exact idiom to copy.

**Test file:** `src/hub/lenses.test.ts` — NOT in estimatedFiles; fold lens assertions into
`judge.test.ts` (or add it — the catalog is small).

---

### src/hub/judge.ts (create)

**Most similar existing file:** `src/medical/recommend/judge-panel.ts` (reconcile +
panel loop) and `src/medical/recommend/lenses.ts` (defensive `validateLensVerdict`).

**Public surface (from generatorNotes):**
```ts
export async function rankFindings(
  findings: Finding[],
  scope: Scope,
  llm: LLMClient,   // INJECTED — see §3
  now: Date,
): Promise<Finding[]>;
```
- **Pass 1 (relevance filter):** `filtered` mode → `applyFilter` first (no LLM).
  `decision`/`general` → ask the injected `llm` for a per-finding relevance verdict against
  the scope; drop findings the verdict marks irrelevant. Under `decision`, keep a finding
  iff relevant to optionA OR optionB; drop "neither" (sc-3-4).
- **Pass 2 (prioritization):** for each survivor fan out the hub lenses, collect per-lens
  include-votes + scores, reconcile with strict-majority / fail-closed-on-tie. Tie or
  no-majority → the finding is **kept but tagged `flagged-for-review`** (NOT dropped, sc-3-3).
- **Deterministic JS sort** (LLM never emits the order): see §2 Pattern D + §6.

**Test file:** `src/hub/judge.test.ts` (create) — drives a `ScriptedClient` fake (§3, §6).

---

## 2. Patterns to Follow

### Pattern A — Lens catalog `Record<string,string>` + safe resolver
**Source:** `src/orchestrator/eval-lenses.ts:4-28`
```ts
const LENS_CATALOG: Record<string, string> = {
  correctness: "Focus on whether the implementation actually satisfies each success criterion ...",
  security: "Focus on injection vulnerabilities, authentication and authorisation gaps ...",
  // ...
};

export function resolveLensFocus(lens: string): string {
  return (
    LENS_CATALOG[lens] ?? `Evaluate specifically through the '${lens}' lens.`
  );
}
```
**Rule:** Define `const HUB_LENS_CATALOG: Record<string,string>` with the hub's OWN
prioritization fragments (urgency / impact / effort / deadline-risk) and a `?? fallback`
resolver that never throws. Do NOT import or re-export the eval `LENS_CATALOG`
(it is module-private in eval-lenses.ts anyway — only `resolveLensFocus` is exported).

### Pattern B — Strict-majority, fail-closed-on-tie reconcile
**Source (canonical rule):** `skills/shared/lens-panel.md:73-89`, verbatim:
> - **Vote count:** `passCount` = number of lenses where `passed === true`; `failCount` = total − passCount.
> - **Verdict:** `passed = passCount > failCount` (strict majority).
>   - **Fail-closed on tie:** when `passCount === failCount` the panel verdict is `false`.

**Reference implementation #1 (eval reconciler):** `src/orchestrator/workflow/reconciler.ts:29-40`
```ts
let passCount = 0;
for (const lens of lensVerdicts) {
  if (lens.passed === true) { passCount = passCount + 1; }
}
const failCount = n - passCount;
const passed = passCount > failCount;   // strict majority, fail-closed on tie
```
**Reference implementation #2 (medical panel):** `src/medical/recommend/judge-panel.ts:50-58`
```ts
const approveCount = all.filter((v) => v.verdict === "approve").length;
const rejectCount = all.filter((v) => v.verdict === "reject").length;
if (approveCount > rejectCount) { return { accepted: true }; }
return { accepted: false, reason: "no-consensus" };
```
**Rule:** Compute `passCount`/`failCount` over the hub lens votes; `included = passCount > failCount`.
**THE HUB INVERSION:** where the eval/medical panels *drop* on `!included`, the hub instead
**keeps the finding and tags it `flagged-for-review`** (sc-3-3). A finding is NEVER silently
dropped by pass-2 reconcile — only pass-1 relevance filtering drops findings.
Unparseable / no-vote lens output counts toward `failCount` (contributes to fail-closed).

### Pattern C — Defensive, never-throwing LLM-output parse (Zod safeParse)
**Source:** `src/medical/recommend/lenses.ts:65-113`
```ts
export const LensVerdictSchema = z.object({
  verdict: z.enum(["approve", "reject"]),
  feedback: z.string(),
  veto: z.boolean().optional(),
});

export function validateLensVerdict(rawText: string): ValidateLensResult {
  let parsed: unknown;
  try { parsed = JSON.parse(rawText.trim()); }
  catch {
    const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(rawText);
    if (fenceMatch) { try { parsed = JSON.parse(fenceMatch[1].trim()); } catch { /* fall through */ } }
    if (!parsed) {
      const braceStart = rawText.indexOf("{");
      const braceEnd = rawText.lastIndexOf("}");
      if (braceStart !== -1 && braceEnd > braceStart) {
        try { parsed = JSON.parse(rawText.slice(braceStart, braceEnd + 1)); }
        catch { return { ok: false, error: "No valid JSON object found ..." }; }
      } else { return { ok: false, error: "No JSON object found ..." }; }
    }
  }
  const result = LensVerdictSchema.safeParse(parsed);
  if (!result.success) { return { ok: false, error: /* zod issues */ }; }
  return { ok: true, verdict: result.data };
}
```
**Rule:** Define small Zod schemas for the pass-1 relevance verdict and the pass-2 lens
score/vote. Parse the model's `response.text` with `safeParse` inside try/catch. A parse
failure is a **no-vote** (fail-closed: contributes to `failCount`, never a thrown exception).
Per principles, all LLM-output validation is Zod, not hand-rolled (`.bober/principles.md:29`).

### Pattern D — LLM produces scores, deterministic JS arranges (the numerics boundary)
**Source:** `src/medical/numerics.ts:8-9, 156-163` (the precedent the contract assumptions cite)
```text
ADR-3: The LLM NEVER performs arithmetic. All numeric computations are pure TypeScript ...
NO async. NO fs. NO network. NO LLM import. Identical input => identical output.
```
**Rule:** The lenses (LLM) emit per-finding scores/votes; a **pure, synchronous JS step**
aggregates the scores and sorts. The LLM never emits the ordered list (nonGoal). Given fixed
fake verdicts/scores the output must be byte-identical across repeated runs (sc-3-2).

### Pattern E — Section headers + ESM `.js` import discipline
**Source:** every module, e.g. `src/medical/recommend/judge-panel.ts:31`, `.bober/principles.md:27,32`
```ts
// ── reconcilePanel ────────────────────────────────────────────────────
import type { LLMClient } from "../../providers/types.js";   // type import, .js extension
```
**Rule:** Use `// ── Section ──` box headers; `import type` for type-only imports
(`consistent-type-imports` is enforced); ALWAYS `.js` extensions (NodeNext). Never import an
SDK — only `../providers/types.js` (`.bober/principles.md:28,41`).

---

## 3. Injected LLMClient (testability) — the exact contract

**Injection precedent #1 — constructor injection:** `src/chat/answerer.ts:6,11-18`
```ts
import type { LLMClient, TextMessage } from "../providers/types.js";

export class Answerer {
  private readonly llm: LLMClient;
  private readonly model: string;
  constructor(llm: LLMClient, model: string) { this.llm = llm; this.model = model; }
  // ... this.llm.chat({ model, system, messages })
}
```
**Injection precedent #2 — parameter injection (what `rankFindings` should do):**
`src/medical/recommend/lenses.ts:236-242` takes `{ llm, model, systemPrompt, userContent }`.
**Rule:** `rankFindings(findings, scope, llm, now)` accepts the `LLMClient` as a plain
parameter so tests pass a `ScriptedClient` (§ below) and **no real network call is made**
(sc-3-5). The real client is built by the caller in Sprint 4 via `createClient(...)`
(`src/cli/commands/chat.ts:33-39`) — OUT OF SCOPE here; the judge only receives it.

**The `LLMClient` interface — `src/providers/types.ts:234-240`**
```ts
export interface LLMClient {
  chat(params: ChatParams): Promise<ChatResponse>;
}
```
**`ChatParams` (the call surface) — `src/providers/types.ts:139-183` (key fields):**
```ts
interface ChatParams {
  model: string;
  system: string;
  messages: Message[];          // use TextMessage[] : { role: "user"|"assistant"; content: string }
  jsonObjectMode?: boolean;     // set TRUE to request a JSON object (medical lenses set this — lenses.ts:220)
}
```
**`ChatResponse` (what the fake must return / how to parse) — `src/providers/types.ts:212-224`**
```ts
interface ChatResponse {
  text: string;                 // <-- parse THIS (safeParse, §Pattern C); the JSON lives here
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage: { inputTokens: number; outputTokens: number };
}
```
**Rule:** Build the request with `await llm.chat({ model, system, messages: [{role:"user",content:...}], jsonObjectMode: true })`
and parse `response.text`. The Anthropic-style contract guarantees `text` holds a best-effort
JSON document when `jsonObjectMode`/`responseSchema` is set (`types.ts:160-183`).

---

## 4. Prior Sprint Output

### Sprint 1: src/hub/finding.ts — `Finding` type (REUSE; do NOT redefine — nonGoal #5)
**Source:** `src/hub/finding.ts:10-27`
```ts
export const FindingSchema = z.object({
  id: z.string().min(1),
  domain: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(["action", "watch", "risk", "question"]),
  urgency: z.number().int().min(1).max(5),
  severity: z.number().int().min(1).max(5),
  evidence: z.array(z.string()),
  surfacedAt: z.string().datetime(),
  dueBy: z.string().datetime().optional(),   // <-- ISO string, OPTIONAL (undefined-last in sort)
  tags: z.array(z.string()),                  // <-- append "flagged-for-review" here (no schema change)
  estDurationMin: z.number().int().optional(),
  status: z.enum(["open","in-progress","snoozed","done","dropped"]),
  promotesTo: z.string().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;
```
**Connection:** `scope.ts` and `judge.ts` both `import type { Finding } from "./finding.js"`.
The sort keys (`urgency`, `severity`, `dueBy`, `id`) all live on `Finding`. To mark a finding
`flagged-for-review` WITHOUT changing the schema (nonGoal #5 forbids it), append the literal
tag string `"flagged-for-review"` to `finding.tags` (return a new object, do not mutate input).

### Sprint 2: src/hub/collector.ts (`collectFindings`), repo-resolver.ts, finding-source.ts (`HUB_SCOPE`)
**Connection:** the pooled `Finding[]` that `rankFindings` consumes comes from `collectFindings`
(`src/hub/collector.ts:16-40`). Sprint 3 does NOT call the collector — it receives the pooled
array as a parameter. `finding-source.ts:42-47` is the canonical `safeParse`-or-skip idiom to mirror.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`) — load-bearing for this sprint
- **Zod for all runtime validation** (`:29`) — pass-1 / pass-2 verdict parsing uses Zod `safeParse`.
- **Provider-agnostic** (`:28,41`) — import `LLMClient` from `providers/types.js`; NEVER an SDK.
- **ESM `.js` extensions** for NodeNext (`:27`). `import type` enforced (`:35`).
- **Tests collocated** `*.test.ts` next to source, Vitest (`:20`).
- **Section box headers** `// ── Name ──` (`:32`). **Prefix unused params `_`** (`:36`).
- **Type safety is a hard gate** — `noUnusedLocals/Parameters`, strict (`:18`).

### Architecture Decisions
No `.bober/architecture/` ADR file specific to the hub was found. The governing precedent
is medical **ADR-3** documented inline in `src/medical/numerics.ts:8` ("LLM NEVER performs
arithmetic; deterministic TS arranges") and the contract assumptions (calendar-planner +
medical numerics boundary). No standalone hub ADR exists.

### Other Docs
`skills/shared/lens-panel.md` is the canonical reconcile-rule source (§2 Pattern B).

---

## 6. Testing Patterns

### Unit Test Pattern — the `ScriptedClient` fake (COPY THIS VERBATIM)
**Source:** `src/medical/recommend/judge-panel.test.ts:17-37`
```ts
import { describe, it, expect, vi } from "vitest";
import type { LLMClient, ChatParams, ChatResponse } from "../../providers/types.js";

/** Returns scripted responses in order; repeats the last once exhausted. Records every ChatParams. */
class ScriptedClient implements LLMClient {
  readonly calls: ChatParams[] = [];
  private idx = 0;
  constructor(private readonly responses: string[]) {}
  async chat(params: ChatParams): Promise<ChatResponse> {
    this.calls.push(params);
    const text = this.responses[Math.min(this.idx, this.responses.length - 1)] ?? "";
    this.idx += 1;
    return { text, toolCalls: [], stopReason: "end", usage: { inputTokens: 3, outputTokens: 5 } };
  }
}

/** A client that always throws on chat (assert fail-closed). */
const throwingClient: LLMClient = {
  async chat(_p: ChatParams): Promise<ChatResponse> { throw new Error("Network timeout"); },
};
```
- **Runner:** Vitest. **Assertion style:** `expect(...)`. **Mock approach:** hand-rolled
  `class ... implements LLMClient` (NO `vi.mock`; `vi.fn` only for plain callbacks like
  `generateCandidate`). **File naming:** `judge.test.ts` collocated in `src/hub/`.
- `client.calls` lets you assert NO real network and inspect what was sent (`jsonObjectMode` etc.).
- For sc-3-5 ("no real network call"): the judge ONLY ever touches the injected client — assert
  via a `ScriptedClient` and/or that `client.calls.length` is exactly what you expect.

### Finding fixture helper (reuse for judge.test.ts)
**Source:** `src/hub/collector.test.ts:11-26` and `src/hub/finding.test.ts:6-21`
```ts
const T = "2026-06-28T00:00:00.000Z";
function makeFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: "f-001", domain: "medical", title: "t", kind: "action",
    urgency: 3, severity: 4, evidence: ["e"], surfacedAt: T,
    tags: [], status: "open", ...over,
  };
}
```
**Rule:** Build findings in-memory (no FactStore needed for scope/judge tests — those are pure +
fake-client). Construct the determinism test (sc-3-2) by running `rankFindings` twice with the
SAME `ScriptedClient` script and asserting deep-equal output. For the tie test (sc-3-3) script
the lenses so include-votes split evenly and assert the survivor carries `"flagged-for-review"`
in `tags` and is still present. For decision (sc-3-4) script pass-1 to mark f1→optionA, f2→optionB,
f3→neither and assert only f1,f2 survive.

### E2E Test Pattern
Not applicable — no Playwright. This sprint is pure unit tests (Vitest).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
This sprint is **purely additive** (5 new files). It changes no existing file. The only
existing hub consumer is the CLI:
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/commands/hub.ts` | `hub/finding-source.js`, `hub/collector.js`, `hub/repo-resolver.js` | low | Does NOT import scope/judge yet (Sprint 4 wires `bober hub priority`/`decide`). Adding new files cannot break it. |
| `src/hub/finding.ts` (`Finding`) | imported by new files | low | Only `import type` — no runtime coupling. Do not edit it. |

### Existing Tests That Must Still Pass
- `src/hub/finding.test.ts`, `src/hub/finding-source.test.ts`, `src/hub/collector.test.ts`,
  `src/hub/repo-resolver.test.ts` — unaffected (no edits to those modules); run `npm test` to confirm.
- `src/cli/commands/hub.test.ts` — unaffected; the CLI is untouched this sprint.
- `src/orchestrator/lens-panel-parity.test.ts` — a **drift gate** that pins the EVAL
  `LENS_CATALOG` fragments byte-for-byte to `skills/shared/lens-panel.md`. **DO NOT touch
  `src/orchestrator/eval-lenses.ts` or that skill file** — defining a SEPARATE hub catalog in
  `src/hub/lenses.ts` keeps this gate green.

### Features That Could Be Affected
- **Sprint 4 (`priority-md` + `bober hub priority`/`decide`)** consumes `rankFindings`'s
  `Finding[]` output and `parseScope`. Keep `rankFindings` returning `Finding[]` (sc-3-2) and
  export `Scope`/`parseScope` so Sprint 4 can build a decision scope from `"X vs Y"`
  (see sprint-4 generatorNotes). Do NOT render markdown or wire CLI here (nonGoal #1).

### Recommended Regression Checks (run after implementation)
1. `npm run build` — zero TS errors (sc-3-6; hard gate per principles `:18`).
2. `npx vitest run src/hub` — all hub tests green (new + Sprints 1-2).
3. `npx vitest run src/orchestrator/lens-panel-parity.test.ts` — proves you did not disturb the eval catalog.
4. `npx vitest run src/medical/recommend` — proves the shared `providers/types.ts` surface is unchanged.

---

## 8. Implementation Sequence (dependency-ordered)

1. **src/hub/scope.ts** — `Scope` union + `parseScope` + pure `applyFilter(findings, scope, now)`.
   - Depends on: `./finding.js` only. No LLM, no async.
   - Verify: `npx vitest run src/hub/scope.test.ts` — filtered narrowing works, non-filtered is pass-through.
2. **src/hub/scope.test.ts** — pure unit tests (sc-3-1): domain/tag/dueWithinDays narrowing,
   `dueBy`-undefined excluded by a `dueWithinDays` constraint, `now` is the injected clock.
3. **src/hub/lenses.ts** — `HUB_LENS_CATALOG: Record<string,string>` (urgency/impact/effort/
   deadline-risk) + `resolveLensFocus`-style resolver + (recommended) the Zod verdict schema(s)
   and a never-throwing `validate*` parser mirroring Pattern C.
   - Depends on: `zod`, `./finding.js`, `../providers/types.js`.
   - Verify: catalog entries are distinct, non-empty; resolver has a `?? fallback`.
4. **src/hub/judge.ts** — `rankFindings(findings, scope, llm, now)`: pass-1 (applyFilter for
   filtered; injected-LLM relevance for decision/general) → pass-2 lens fan-out + reconcile
   (flagged-for-review on tie) → deterministic sort.
   - Depends on: `./scope.js`, `./lenses.js`, `./finding.js`, `../providers/types.js`.
   - Verify: see §6; determinism, tie→flagged-for-review, decision drops "neither".
5. **src/hub/judge.test.ts** — `ScriptedClient`-driven; covers sc-3-2/3/4/5.
6. **Full verification** — `npm run build` (sc-3-6) + `npx vitest run src/hub` + the two
   no-regression checks in §7.

---

## 9. Pitfalls & Warnings

- **The deterministic sort — exact tie-break chain (sc-3-2).** Order: aggregate lens score DESC,
  then `urgency` DESC, then `severity` DESC, then `dueBy` ASC (**undefined LAST**), then `id` ASC.
  `Array.prototype.sort` IS stable on Node v22 (V8) — but DO NOT rely on stability for the tie-break;
  encode every key explicitly in the comparator (return at the first non-zero diff). For
  undefined-last `dueBy`, treat missing as `+Infinity`: `const da = a.dueBy ? Date.parse(a.dueBy) : Infinity`.
  For `id` ASC use `a.id < b.id ? -1 : a.id > b.id ? 1 : 0` (or `localeCompare`). Sort a COPY
  (`[...survivors].sort(...)`) — never mutate the input array (purity, identical-output-twice).
- **flagged-for-review is a KEEP, not a drop (sc-3-3).** This is the one place the hub INVERTS the
  eval/medical panels (which drop on `!included`). The split-vote finding stays in the output with
  `"flagged-for-review"` appended to its `tags`. Append immutably (`{ ...f, tags: [...f.tags, "flagged-for-review"] }`).
- **Do NOT change the Finding schema** (nonGoal #5). No new field for the flag — use `tags`.
- **Do NOT reuse the eval lenses** (`correctness/security/...`). They live in
  `src/orchestrator/eval-lenses.ts` and are pinned by a drift gate
  (`src/orchestrator/lens-panel-parity.test.ts`). Define a fresh hub catalog; editing eval-lenses
  or `skills/shared/lens-panel.md` will fail that gate.
- **No real network in tests (sc-3-5).** The judge must touch ONLY the injected `llm`. Never call
  `createClient` / a provider inside `rankFindings` — the caller (Sprint 4) injects the client.
- **Defensive parse = fail-closed, never throw.** Unparseable LLM output is a no-vote that
  contributes to `failCount` (→ flagged-for-review in pass 2). Mirror `validateLensVerdict`'s
  four-tier try/catch (`src/medical/recommend/lenses.ts:65-113`); never let a `JSON.parse` throw escape.
- **`jsonObjectMode: true`** on each lens/relevance call (mirrors `src/medical/recommend/lenses.ts:220`)
  so the provider returns a JSON object in `response.text`. `claude-code` ignores it gracefully.
- **`applyFilter` is pure & synchronous (no LLM, no async).** filtered scope MUST narrow with zero
  `llm.chat` calls (evaluatorNotes); only decision/general invoke pass-1 LLM relevance.
- **`now` is injected** (a `Date` param) for deterministic `dueWithinDays` math — do not call
  `Date.now()` / `new Date()` inside scope or judge (determinism, mirrors `reconciler.ts` ADR-4 note).
- **Decision scope drops "neither" (sc-3-4)** — a finding relevant to NEITHER option is removed in
  pass 1 (a drop), distinct from a pass-2 split-vote (a flag/keep). Keep the two outcomes separate.
