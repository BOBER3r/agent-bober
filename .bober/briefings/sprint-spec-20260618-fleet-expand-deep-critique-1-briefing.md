# Sprint Briefing: Critique engine (critic-deep.ts) + opt-in threading

**Contract:** sprint-spec-20260618-fleet-expand-deep-critique-1
**Generated:** 2026-06-18T00:00:00Z

> Sprint 1 builds the critique ENGINE only. NEW module `src/fleet/critic-deep.ts` (bounded fresh-critic critique/refine loop, Approach A) + additive opt-in threading in `src/fleet/decomposer-deep.ts` so `decomposeGoalDeep({...,critique:true})` routes a structurally-valid baseline manifest through `runCritiqueLoop`. Fully testable via a `ScriptedClient` fake. NO CLI in this sprint (do NOT touch `index.ts`).

---

## 0. Mandatory Reading Order (do this first)

The architecture doc + ADRs are the contract. They are already summarized below, but the source of truth is:
- `.bober/architecture/arch-20260618-fleet-expand-deep-critique-architecture.md` — Component Breakdown (exact TS signatures), Integration Strategy (call chain + gate ordering).
- ADR-1 (loop structure: boolean critic, reuse runExpandStage, accept-best), ADR-3 (validateVerdict mirrors validateOutline + fail-open), ADR-4 (reuse runExpandStage seam + critiqueFeedback), ADR-5 (critic AFTER validateManifest, BEFORE write).

**Golden rule from generatorNotes: MIRROR, DO NOT INVENT.** `validateVerdict` mirrors `validateOutline`. `callCritic` mirrors `callExpand`'s call shape (jsonObjectMode:true + 3-message coercion) but with its OWN clean prompt. The constants block + audit test mirror the Phase-3 ones.

---

## 1. Target Files

### `src/fleet/critic-deep.ts` (CREATE)

**Directory pattern:** `src/fleet/` uses kebab-case file names (`decomposer-deep.ts`, `manifest.ts`). Named exports only, no default export. ESM `.js` extensions on ALL relative imports. `import type { ... }` for type-only imports (LLMClient, Message, FleetManifest, Outline). Module layout: imports → constants → schemas → types → internal helpers → exported functions. This mirrors `decomposer-deep.ts:1-4` exactly:
```typescript
import { z } from "zod";
import { validateManifest } from "./decomposer.js";
import type { FleetManifest } from "./manifest.js";
import type { LLMClient, Message } from "../providers/types.js";
```
**For critic-deep.ts the imports are** (verify each path):
```typescript
import { z } from "zod";
import type { LLMClient, Message } from "../providers/types.js";
import type { FleetManifest } from "./manifest.js";
import {
  type Outline,
  runExpandStage,
  DEEP_MAX_TOTAL_CALLS,        // 4 — for the audit relation test
  DEEP_EXPAND_MAX_RETRIES,     // 1 — for the audit relation + loop budget
} from "./decomposer-deep.js";
```
> NOTE: `Outline` is `export type Outline` (`decomposer-deep.ts:79`); `runExpandStage` is `export async function` (`decomposer-deep.ts:280`); `DEEP_MAX_TOTAL_CALLS` (`:74`) and `DEEP_EXPAND_MAX_RETRIES` (`:72`) are exported consts. All confirmed exported.

**Most similar existing file:** `src/fleet/decomposer-deep.ts` — follow its structure for constants block, the `validateOutline` ladder (→ `validateVerdict`), and the `callExpand` call shape (→ `callCritic`).

**Components to export (exact signatures from architecture Component Breakdown):**
```typescript
// CritiqueConstants
export const CRITIQUE_MAX_ROUNDS = 1;
export const CRITIQUE_PARSE_MAX_RETRIES = 1;
// closed form: DEEP_MAX_TOTAL_CALLS(4) + CRITIQUE_MAX_ROUNDS(1) * ((1+CRITIQUE_PARSE_MAX_RETRIES) + (1+DEEP_EXPAND_MAX_RETRIES))
export const DEEP_CRITIQUE_MAX_TOTAL_CALLS = 8;

// CritiqueVerdictValidator
export const CritiqueVerdictSchema = z.object({
  verdict: z.enum(["approve", "reject"]),
  feedback: z.string(),
});
export type CritiqueVerdict = z.infer<typeof CritiqueVerdictSchema>;
export type ValidateVerdictResult =
  | { ok: true; verdict: CritiqueVerdict }
  | { ok: false; error: string };
export function validateVerdict(rawText: string): ValidateVerdictResult;

// FreshCriticCaller
export const CRITIQUE_SYSTEM_PROMPT: string;
export const CRITIQUE_COERCION_INSTRUCTION: string;
export function callCritic(input: {
  client: LLMClient; model: string; goal: string; outline: Outline;
  candidate: FleetManifest; priorText?: string; formattedError?: string;
}): Promise<string>;
export function getCriticVerdict(input: {
  client: LLMClient; model: string; goal: string; outline: Outline; candidate: FleetManifest;
}): Promise<CritiqueVerdict>;

// CritiqueLoopOrchestrator
export function runCritiqueLoop(input: {
  client: LLMClient; model: string; goal: string; outline: Outline;
  baseline: FleetManifest; expandMaxRetries: number;
}): Promise<FleetManifest>;
```

---

### `src/fleet/critic-deep.test.ts` (CREATE)

**Most similar existing file:** `src/fleet/decomposer-deep.test.ts` — copy its `ScriptedClient` fake verbatim (lines 21-39) and its test idioms. Vitest, co-located `.test.ts`, `import { describe, it, expect } from "vitest"`.

---

### `src/fleet/decomposer-deep.ts` (MODIFY — ADDITIVE ONLY, ZERO DELETED LINES)

Three surgical additions. **Every existing line must remain byte-identical** (evaluator runs `git diff | grep '^-[^-]'` and it must be EMPTY).

**Edit 1 — `DecomposeDeepInput` (currently lines 81-88):** add one optional field.
```typescript
export interface DecomposeDeepInput {
  goal: string;
  client: LLMClient;
  model: string;
  count?: string;
  planMaxRetries?: number;
  expandMaxRetries?: number;
  critique?: boolean; // NEW; undefined/false ⇒ Phase-3 path
}
```

**Edit 2 — `runExpandStage` input type + first-message threading (currently lines 280-315):** add optional `critiqueFeedback?: string`, appended to the FIRST EXPAND user message ONLY when present. Current relevant lines:
```typescript
// :280-287
export async function runExpandStage(input: {
  client: LLMClient;
  model: string;
  outline: Outline;
  goal: string;
  maxRetries: number;
}): Promise<FleetManifest> {
  const { client, model, outline, goal, maxRetries } = input;
```
The cleanest additive approach (no fork of runExpandStage per ADR-4): add `critiqueFeedback?: string` to the input type and to the destructure, then thread it down to `callExpand` which builds `firstUserContent` at `:212`:
```typescript
// callExpand currently (:202-212):
async function callExpand(input: {
  client: LLMClient; model: string; outline: Outline; goal: string;
  priorText?: string; formattedError?: string;
}): Promise<string> {
  const { client, model, outline, goal, priorText, formattedError } = input;
  const firstUserContent = `Goal: ${goal}\n\nOutline:\n${JSON.stringify(outline)}`;
```
Add `critiqueFeedback?: string` to callExpand's input type + destructure, and append it to `firstUserContent` only when present, e.g.:
```typescript
const firstUserContent =
  `Goal: ${goal}\n\nOutline:\n${JSON.stringify(outline)}` +
  (critiqueFeedback ? `\n\nPrior reviewer feedback to address:\n${critiqueFeedback}` : "");
```
Then pass `critiqueFeedback` through `runExpandStage` → `callExpand`. KEEP all existing fields and the coercion branch byte-unchanged — only ADD the optional field + the conditional suffix. **The append touches only the FIRST user turn; the coercion 3-message branch (:216-229) stays as-is.**

**Edit 3 — `decomposeGoalDeep` routing (currently lines 319-349):** capture the Outline ONCE from `runPlanStage`, then route. Current body:
```typescript
// :331-348
const outline = await runPlanStage({ client, model, goal, count, maxRetries: planMaxRetries });
const manifest = await runExpandStage({ client, model, outline, goal, maxRetries: expandMaxRetries });
return manifest;
```
Becomes (add `critique` to destructure at :322-329, import `runCritiqueLoop`):
```typescript
const manifest = await runExpandStage({ client, model, outline, goal, maxRetries: expandMaxRetries });
if (input.critique === true) {
  return runCritiqueLoop({ client, model, goal, outline, baseline: manifest, expandMaxRetries });
}
return manifest;
```
> `import { runCritiqueLoop } from "./critic-deep.js";` at the top (additive import line). The existing `outline` const is REUSED — no 2nd PLAN call. Route ONLY when `input.critique === true`; the else path returns `manifest` exactly as today (byte-identity guard).

**Imported by `decomposer-deep.ts`:**
- `src/fleet/decomposer-deep.test.ts` (line 5-13 imports `decomposeGoalDeep`, `runPlanStage`, `runExpandStage`, `validateOutline`, constants) — these tests MUST still pass unchanged.
- `index.ts` imports the CLI wiring (NOT touched this sprint, but the existing import must keep working).

**Test file:** `src/fleet/decomposer-deep.test.ts` EXISTS (395 lines) — must stay green (regression guard for byte-identity).

---

## 2. Patterns to Follow

### Pattern: Tolerant-parse ladder returning a discriminated union (validateVerdict mirrors validateOutline)
**Source:** `src/fleet/decomposer-deep.ts`, lines 107-155 (`validateOutline`). Replicate the EXACT four-step ladder, swapping only the Zod schema (`OutlineSchema` → `CritiqueVerdictSchema`) and the result key (`outline` → `verdict`).
```typescript
export function validateOutline(rawText: string): ValidateOutlineResult {
  let parsed: unknown;
  try {                                   // 1. direct JSON.parse
    parsed = JSON.parse(rawText.trim());
  } catch {
    const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(rawText);  // 2. ```json fence
    if (fenceMatch) { try { parsed = JSON.parse(fenceMatch[1].trim()); } catch {} }
    if (!parsed) {                        // 3. first-brace → last-brace substring
      const braceStart = rawText.indexOf("{");
      const braceEnd = rawText.lastIndexOf("}");
      if (braceStart !== -1 && braceEnd > braceStart) {
        try { parsed = JSON.parse(rawText.slice(braceStart, braceEnd + 1)); }
        catch { return { ok: false, error: `No valid JSON object found...` }; }
      } else { return { ok: false, error: `No JSON object found...` }; }
    }
  }
  const result = OutlineSchema.safeParse(parsed);   // 4. Zod safeParse
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    return { ok: false, error: issues };
  }
  return { ok: true, outline: result.data };
}
```
**Rule:** `validateVerdict` returns `{ok:false,error}` for empty/non-JSON/bad-enum/missing-feedback and `{ok:true,verdict}` for a valid `{verdict,feedback}` — and NEVER throws. The Zod `z.enum(["approve","reject"])` rejects a bad verdict string; `z.string()` on feedback means a MISSING feedback key fails safeParse (returns `{ok:false}`). (AC sc-1-5)

### Pattern: jsonObjectMode call + 3-message [user,assistant,user] coercion (callCritic mirrors callExpand)
**Source:** `src/fleet/decomposer-deep.ts`, lines 202-239 (`callExpand`).
```typescript
async function callExpand(input: {...}): Promise<string> {
  const { client, model, outline, goal, priorText, formattedError } = input;
  const firstUserContent = `Goal: ${goal}\n\nOutline:\n${JSON.stringify(outline)}`;
  let messages: Message[];
  if (priorText !== undefined && formattedError !== undefined) {
    messages = [
      { role: "user", content: firstUserContent },
      { role: "assistant", content: priorText },
      { role: "user", content: `${DEEP_EXPAND_COERCION_INSTRUCTION}\n\nPrevious validation error:\n${formattedError}` },
    ];
  } else {
    messages = [{ role: "user", content: firstUserContent }];
  }
  const response = await client.chat({ model, system: DEEP_EXPAND_SYSTEM_PROMPT, messages, jsonObjectMode: true });
  return response.text;
}
```
**Rule for callCritic:** same call shape — `jsonObjectMode: true`, NEVER `responseSchema` (AC sc-1-6). BUT: (a) use its OWN `CRITIQUE_SYSTEM_PROMPT` and `CRITIQUE_COERCION_INSTRUCTION`, NOT the EXPAND prompts; (b) the first user message presents the candidate manifest as THIRD-PARTY input to review ("Review this proposed manifest...") — it must NOT tell the model it authored the manifest and must NOT extend the EXPAND conversation (LOCK1). Build a FRESH message array. Include goal + outline + `JSON.stringify(candidate)` in the first user turn so the critic can judge adequacy (e.g. 2 children for a 12-area outline = under-expanded).

### Pattern: Bounded retry loop with explicit `maxAttempts = 1 + maxRetries`, fail at exhaustion
**Source:** `src/fleet/decomposer-deep.ts`, lines 280-315 (`runExpandStage`) and 256-273 (`runPlanStage` loop).
```typescript
const maxAttempts = 1 + maxRetries;
let lastError = "Unknown error";
let priorText: string | undefined;
for (let attempt = 0; attempt < maxAttempts; attempt++) {
  const rawText = await callExpand({ ..., priorText: attempt > 0 ? priorText : undefined,
                                          formattedError: attempt > 0 ? lastError : undefined });
  const validated = validateManifest(rawText);
  if (validated.ok) return validated.manifest;
  lastError = validated.error;
  priorText = rawText;
}
```
**Rule for getCriticVerdict:** SAME loop shape with `maxAttempts = 1 + CRITIQUE_PARSE_MAX_RETRIES` (= 2), `validateVerdict` in place of `validateManifest`, the 3-message coercion on `attempt > 0`. BUT at exhaustion DO NOT throw — `runPlanStage`/`runExpandStage` throw at the end (`:275`, `:312`), `getCriticVerdict` instead **fails open**: `return { verdict: "approve", feedback: "" };` (AC sc-1-6, ADR-3). Log each parse failure (observable no-op per ADR-3 risk) — e.g. `console.warn(...)` or the project's logger if one is used in fleet (none observed in decomposer-deep.ts, so a comment + plain fail-open is acceptable; do not invent a logger import).

### Pattern: Co-located audit-relation constant test
**Source:** `src/fleet/decomposer-deep.test.ts`, lines 76-80.
```typescript
it("DEEP_MAX_TOTAL_CALLS equals (1+DEEP_PLAN_MAX_RETRIES)+(1+DEEP_EXPAND_MAX_RETRIES)", () => {
  expect(DEEP_MAX_TOTAL_CALLS).toBe((1 + DEEP_PLAN_MAX_RETRIES) + (1 + DEEP_EXPAND_MAX_RETRIES));
});
```
**Rule:** write the audit relation as a REAL assertion (not a comment) — AC sc-1-4:
```typescript
expect(DEEP_CRITIQUE_MAX_TOTAL_CALLS).toBe(8);
expect(CRITIQUE_MAX_ROUNDS).toBe(1);
expect(CRITIQUE_PARSE_MAX_RETRIES).toBe(1);
expect(DEEP_CRITIQUE_MAX_TOTAL_CALLS).toBe(
  DEEP_MAX_TOTAL_CALLS + CRITIQUE_MAX_ROUNDS * ((1 + CRITIQUE_PARSE_MAX_RETRIES) + (1 + DEEP_EXPAND_MAX_RETRIES)),
);
```

### Pattern: ScriptedClient fake recording every ChatParams
**Source:** `src/fleet/decomposer-deep.test.ts`, lines 21-39. Copy verbatim into critic-deep.test.ts.
```typescript
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
```
**Rule:** repeats the LAST scripted response once exhausted (`Math.min(this.idx, len-1)`). For an "all-reject" run, scripting a single reject verdict makes every subsequent critic call also reject — the ceiling test relies on this. Records EVERY `ChatParams` in `.calls` for jsonObjectMode/responseSchema/order/count assertions.

### Pattern: ChatParams shape assertion (jsonObjectMode true / responseSchema undefined)
**Source:** `src/fleet/decomposer-deep.test.ts`, lines 184-201.
```typescript
expect(client.calls[0]?.jsonObjectMode).toBe(true);
expect(client.calls[0]?.responseSchema).toBeUndefined();
```
**Rule:** assert this on BOTH critic calls captured by ScriptedClient (AC sc-1-6). Identify the critic calls by index relative to PLAN+EXPAND, or assert on every call whose `system === CRITIQUE_SYSTEM_PROMPT`.

### Pattern: Call-count ceiling assertion
**Source:** `src/fleet/decomposer-deep.test.ts`, lines 267-275.
```typescript
expect(client.calls.length).toBeLessThanOrEqual(DEEP_MAX_TOTAL_CALLS);
```
**Rule for AC sc-1-7:** `expect(client.calls.length).toBeLessThanOrEqual(DEEP_CRITIQUE_MAX_TOTAL_CALLS)` (=8) on a fully-failing/all-reject run, AND assert the loop RESOLVES (never throws): `await expect(runCritiqueLoop({...})).resolves.toBeDefined()`.

### Pattern: 3-message coercion-shape assertion
**Source:** `src/fleet/decomposer-deep.test.ts`, lines 222-235 (PLAN) and 278-293 (EXPAND).
```typescript
expect(secondCall?.messages).toHaveLength(3);
expect(secondCall?.messages[0]?.role).toBe("user");
expect(secondCall?.messages[1]?.role).toBe("assistant");
expect(secondCall?.messages[1]?.content).toBe("not json"); // echoed prior text
expect(secondCall?.messages[2]?.role).toBe("user");
```
**Rule:** assert the critic coercion retry uses the same [user,assistant,user] shape (AC sc-1-6).

---

## 3. Existing Utilities — DO NOT Recreate

Searched `src/fleet/`, `src/providers/`. (No `utils/`, `lib/`, `helpers/`, `shared/`, `common/` dirs are relevant to the fleet critique loop — these utilities all live in `src/fleet/` + `src/providers/`.)

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `validateManifest` | `src/fleet/decomposer.ts:95` | `(rawText: string) => {ok:true,manifest}\|{ok:false,error}` | Tolerant-parse + Zod + config-key guard. THE structural gate. Reused verbatim inside `runExpandStage`; do NOT call it again in the critique loop — the candidate is ALREADY validated. |
| `validateOutline` | `src/fleet/decomposer-deep.ts:107` | `(rawText: string) => {ok:true,outline}\|{ok:false,error}` | The discriminated-union ladder `validateVerdict` MIRRORS. Do not reuse; mirror its structure with a different schema. |
| `runExpandStage` | `src/fleet/decomposer-deep.ts:280` | `({client,model,outline,goal,maxRetries,critiqueFeedback?}) => Promise<FleetManifest>` | THE re-expand seam (ADR-4). `runCritiqueLoop` calls it with `critiqueFeedback` set. Do NOT fork it. |
| `runPlanStage` | `src/fleet/decomposer-deep.ts:243` | `({client,model,goal,count?,maxRetries}) => Promise<Outline>` | Produces the Outline captured ONCE in decomposeGoalDeep and passed to runCritiqueLoop. No 2nd PLAN call. |
| `FleetManifestSchema` | `src/fleet/manifest.ts:13` | Zod schema; `children: z.array(FleetChildSchema).min(1)` | Children-only contract. Use `.safeParse(...).success` in tests to assert manifest validity. BYTE-LOCKED — do not change. |
| `FleetChildSchema` | `src/fleet/manifest.ts:6` | `{folder:string.min(1), task:string.min(1), config?:record}` | Child shape. `config` optional but config-key-guarded by validateManifest. |
| `Outline` / `OutlineArea` | `src/fleet/decomposer-deep.ts:78-79` | `type Outline = {areas: OutlineArea[]}` | Re-export/import these types into critic-deep.ts; do not redeclare. |
| `DEEP_MAX_TOTAL_CALLS` | `src/fleet/decomposer-deep.ts:74` | `const = 4` | Base term in the closed-form audit relation. Import, do not hardcode 4 in the relation test. |
| `DEEP_EXPAND_MAX_RETRIES` | `src/fleet/decomposer-deep.ts:72` | `const = 1` | Re-expand budget term. Import for the audit relation + as `expandMaxRetries` default. |
| `LLMClient` / `Message` / `ChatParams` / `ChatResponse` | `src/providers/types.ts:216 / :128 / :139 / :194` | interfaces | `import type` ONLY. `jsonObjectMode?: boolean` (:183), `responseSchema?` (:174). Critic MUST use jsonObjectMode, never responseSchema. |

---

## 4. Prior Sprint Output

**No prior sprints in THIS spec** (`dependsOn: []`). The feature builds on the shipped **Phase 3 deep decomposer**:
- `src/fleet/decomposer-deep.ts` — exports `decomposeGoalDeep`, `runPlanStage`, `runExpandStage`, `validateOutline`, `callPlan`/`callExpand` (internal), constants `DEEP_PLAN_MAX_RETRIES`/`DEEP_EXPAND_MAX_RETRIES`/`DEEP_MAX_TOTAL_CALLS`, types `Outline`/`OutlineArea`/`DecomposeDeepInput`.
- `src/fleet/decomposer.ts` — exports `validateManifest`, `decomposeGoal`, `DECOMPOSE_*` constants.
- `src/fleet/manifest.ts` — exports `FleetManifestSchema`, `FleetChildSchema`, `FleetManifest`, `FleetChild`, `load`.

**Connection:** this sprint MIRRORS the Phase-3 module structure and EXTENDS `decomposer-deep.ts` additively. The new `critic-deep.ts` sits as a wrapper between EXPAND output and the unchanged write path (ADR-5).

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` consulted for this sprint (the architecture doc + ADRs are the governing spec). Project-wide conventions extracted from code: ESM (`"type":"module"` in package.json:5), NodeNext `.js` extensions on relative imports, Zod for schemas, named exports, no default exports in `src/fleet/`, `import type` for type-only imports, no explicit `any`.

### Architecture Decisions
- **ADR-1:** boolean `approve|reject`+feedback critic; reuse runExpandStage; accept-best-on-exhaustion; never throw.
- **ADR-2:** opt-in `critique?: boolean` on DecomposeDeepInput; absent ⇒ byte-identical Phase 3 (guarded spread).
- **ADR-3:** validateVerdict mirrors validateOutline union; coercion budget `1+CRITIQUE_PARSE_MAX_RETRIES`; **fail-open** (approve) on parse exhaustion.
- **ADR-4:** reuse runExpandStage via a single optional `critiqueFeedback?`; reuse the single planned outline; no extra PLAN call.
- **ADR-5:** critic runs strictly AFTER validateManifest (inside runExpandStage), strictly BEFORE the atomic write — i.e. inside decomposeGoalDeep before returning.

### Other Docs
Build/test scripts (package.json): `build` = `tsc`, `typecheck` = `tsc --noEmit`, `lint` = `eslint src/`, `test` = `vitest`.

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/fleet/decomposer-deep.test.ts` (whole file is the template).
```typescript
import { describe, it, expect } from "vitest";
import type { LLMClient, ChatParams, ChatResponse } from "../providers/types.js";
import { FleetManifestSchema } from "./manifest.js";
import { /* decomposeGoalDeep, runExpandStage, validateOutline, constants */ } from "./decomposer-deep.js";

const VALID_OUTLINE_JSON = JSON.stringify({ areas: [ {name:"auth",intent:"..."}, {name:"billing",intent:"..."} ] });
const VALID_MULTI_CHILD_JSON = JSON.stringify({ children: [ {folder:"auth-service",task:"..."}, {folder:"billing-service",task:"..."} ] });

describe("validateVerdict", () => {
  it("returns ok:false (does not throw) for empty string", () => {
    expect(() => validateVerdict("")).not.toThrow();
    expect(validateVerdict("").ok).toBe(false);
  });
  it("returns ok:true for a valid verdict JSON", () => {
    const r = validateVerdict(JSON.stringify({ verdict: "reject", feedback: "too few children" }));
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.verdict.verdict).toBe("reject"); expect(r.verdict.feedback).toBe("too few children"); }
  });
});
```
**Runner:** vitest (`package.json` scripts.test = `vitest`).
**Assertion style:** `expect(...).toBe / .toHaveLength / .resolves / .rejects.toThrow / .not.toThrow`.
**Mock approach:** hand-rolled `ScriptedClient implements LLMClient` (NO `vi.mock`) — copy from decomposer-deep.test.ts:21-39.
**File naming:** `<module>.test.ts`, co-located in `src/fleet/`.

### Test scenarios required by the success criteria (map verbatim)
- **sc-1-4 (audit):** `DEEP_CRITIQUE_MAX_TOTAL_CALLS===8`, `===1` for both round/retry consts, AND the closed-form relation `=== DEEP_MAX_TOTAL_CALLS + CRITIQUE_MAX_ROUNDS*((1+CRITIQUE_PARSE_MAX_RETRIES)+(1+DEEP_EXPAND_MAX_RETRIES))`. Real `expect`, not comment.
- **sc-1-5 (validateVerdict never throws):** empty/non-JSON → `{ok:false}`; bad verdict enum (`{verdict:"maybe",feedback:"x"}`) → `{ok:false}`; missing feedback (`{verdict:"approve"}`) → `{ok:false}`; valid `{verdict,feedback}` → `{ok:true}`. Each wrapped in `expect(()=>...).not.toThrow()`.
- **sc-1-6 (critic call shape + fail-open):** both critic calls `jsonObjectMode===true && responseSchema===undefined`; callCritic uses CRITIQUE_SYSTEM_PROMPT + fresh array, candidate as third-party; getCriticVerdict after 2 unparseable responses returns `{verdict:"approve",feedback:""}` WITHOUT throwing; coercion retry uses 3-message [user,assistant,user] shape. Script ScriptedClient with 2 garbage responses → assert `(await getCriticVerdict({...})).verdict === "approve"` and `client.calls.length === 2`.
- **sc-1-7 (loop behaviors):** (a) reject-then-richer-expand: script `[rejectVerdict, VALID_MULTI_CHILD_JSON]` → folds feedback into a FRESH runExpandStage (assert a re-expand chat call exists whose first user message CONTAINS the feedback / critiqueFeedback present) and returns the multi-child manifest. (b) all-reject: every critic call rejects → returns accept-best (tiebreak most children, else first-seen baseline) and NEVER throws. (c) ceiling: all-reject run `client.calls.length <= 8`. Note: with CRITIQUE_MAX_ROUNDS=1, an all-reject run = baseline critic call (reject) + 1 re-expand (≤2 calls) + re-critic (reject) → accept best; assert it stays ≤8 and resolves.
- **sc-1-8 (decomposeGoalDeep integration):** `decomposeGoalDeep({...,critique:true})` on a degenerate 2-child baseline with scripted reject + richer re-expand returns the multi-child manifest, and the manifest handed to the critic is FleetManifestSchema-valid (critic AFTER structural gate). `decomposeGoalDeep` with critique absent/false → ZERO critic calls, chat sequence byte-identical to Phase 3 (`client.calls` has only PLAN+EXPAND, ≤4, and matches the existing happy-path test at decomposer-deep.test.ts:148-180).

### E2E Test Pattern
Not applicable — no Playwright in this sprint; this is a pure-logic module tested with vitest + ScriptedClient.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/fleet/decomposer-deep.test.ts` | `decomposer-deep.ts` (modified) | medium | All 30+ existing tests MUST still pass. The additions are purely optional fields + a guarded `critique===true` branch — the no-flag happy path (`:148-180`), PLAN/EXPAND exhaustion (`:205-307`), and standalone runExpandStage (`:343-394`) must stay green. |
| `src/cli/index.ts` (fleet expand-deep wiring) | `decomposeGoalDeep` import | low | NOT touched this sprint. Its import of `decomposeGoalDeep` keeps working because the signature change is additive (new optional field). Verify build doesn't break. |
| `src/fleet/critic-deep.test.ts` | `critic-deep.ts`, `decomposer-deep.ts`, `manifest.ts` | n/a (new) | New file — author the tests. |

### Existing Tests That Must Still Pass
- `src/fleet/decomposer-deep.test.ts` — tests Phase-3 plan→expand happy path, exhaustion, coercion, call-count ceilings (4). MUST stay green: AC sc-1-8 byte-identity REQUIRES it. Run `npx vitest run src/fleet/decomposer-deep.test.ts` after edits.
- `src/fleet/decomposer.test.ts` (if present) and `src/fleet/manifest.test.ts` (if present) — verify byte-lock on decomposer.ts/manifest.ts (they must NOT change). Run `git diff --stat src/fleet/decomposer.ts src/fleet/manifest.ts` → must be empty.

### Features That Could Be Affected
- **fleet expand-deep (Phase 3)** — shares `decomposeGoalDeep`/`runExpandStage`. Verify the no-`critique` path is byte-identical: zero critic calls, ≤4 chat calls, same call order.
- **fleet expand (Phase 2)** — uses `decomposeGoal`/`validateManifest` in `decomposer.ts`. BYTE-LOCKED; must not change.

### Recommended Regression Checks
After implementation, the Generator MUST verify:
1. `npx vitest run src/fleet/` — ALL fleet tests green (existing + new).
2. `npm run build` — clean tsc.
3. `npm run typecheck` — `tsc --noEmit` clean, no explicit `any`.
4. `npm run lint` — eslint clean on the two new files (consistent-type-imports, no-unused, ESM `.js`).
5. `git diff --stat` shows ONLY: `critic-deep.ts` (new), `critic-deep.test.ts` (new), `decomposer-deep.ts` (modified). `decomposer.ts`, `manifest.ts`, `index.ts`, `src/providers/**` must NOT appear.
6. `git diff src/fleet/decomposer-deep.ts | grep '^-[^-]'` must be EMPTY (zero deleted lines — additive only).
7. `grep -n responseSchema src/fleet/critic-deep.ts` must be EMPTY (critic never sets responseSchema).

---

## 8. Implementation Sequence

Dependency order: constants → schema/validator → critic caller → loop orchestrator → decomposer threading → tests.

1. **critic-deep.ts — imports + CritiqueConstants** — add the four imports (z, types, runExpandStage + the two constants from decomposer-deep.js) and `CRITIQUE_MAX_ROUNDS=1`, `CRITIQUE_PARSE_MAX_RETRIES=1`, `DEEP_CRITIQUE_MAX_TOTAL_CALLS=8`.
   - Verify: `tsc --noEmit` resolves the imports (paths use `.js`).
2. **critic-deep.ts — CritiqueVerdictSchema + validateVerdict** — Zod schema (`verdict:enum, feedback:string`) + the validateOutline-mirrored ladder returning the discriminated union; NEVER throws.
   - Verify: a quick scratch test of `validateVerdict("")`, bad enum, missing feedback, valid → never throws, correct `ok`.
3. **critic-deep.ts — CRITIQUE_SYSTEM_PROMPT + CRITIQUE_COERCION_INSTRUCTION + callCritic + getCriticVerdict** — clean third-party "review this" prompt; `callCritic` mirrors `callExpand`'s jsonObjectMode:true + 3-message coercion with its own prompt; `getCriticVerdict` loops `1+CRITIQUE_PARSE_MAX_RETRIES` and FAILS OPEN (approve) at exhaustion, logging each parse miss.
   - Verify: a ScriptedClient with 2 garbage responses → getCriticVerdict resolves `{verdict:"approve"}`, `calls.length===2`, both calls `jsonObjectMode===true`/`responseSchema===undefined`.
4. **critic-deep.ts — runCritiqueLoop** — call getCriticVerdict on baseline; approve→return baseline; reject (rounds left)→`runExpandStage({...,critiqueFeedback: verdict.feedback})`, re-critic; on exhaustion accept-best (most children, else first-seen baseline). Wrap critic transport throws → accept-best (never throws). Stay within ≤8 chat calls by reusing the passed `outline` (no PLAN call here).
   - Verify: reject-then-richer scripted run returns multi-child; all-reject returns accept-best and never throws; `calls.length<=8`.
5. **decomposer-deep.ts — additive threading (Edits 1, 2, 3 from §1)** — add `critique?` to DecomposeDeepInput; add `critiqueFeedback?` to runExpandStage + callExpand input/destructure and append to FIRST EXPAND user message when present; in decomposeGoalDeep capture outline once, route to runCritiqueLoop ONLY when `input.critique===true`, else return manifest unchanged; add `import { runCritiqueLoop } from "./critic-deep.js"`.
   - Verify: `git diff src/fleet/decomposer-deep.ts | grep '^-[^-]'` empty; existing decomposer-deep.test.ts still green.
6. **critic-deep.test.ts — full suite** — copy ScriptedClient; write the sc-1-4 audit, sc-1-5 validateVerdict, sc-1-6 call-shape + fail-open, sc-1-7 loop behaviors + ceiling, sc-1-8 decomposeGoalDeep integration + byte-identity tests.
   - Verify: `npx vitest run src/fleet/critic-deep.test.ts` green.
7. **Run full verification** — `npm run build`, `npm run typecheck`, `npm run lint`, `npx vitest run src/fleet/`, then the §7 git-diff guards.

---

## 9. Pitfalls & Warnings

- **BYTE-LOCK — additive only on decomposer-deep.ts.** Zero deleted lines (`git diff | grep '^-[^-]'` must be empty). Do not reformat, reorder, or rewrite any existing line. Add the optional field to the interface, the optional field + conditional suffix to callExpand/runExpandStage, and the guarded branch to decomposeGoalDeep — nothing else.
- **Do NOT touch `index.ts` this sprint** (CLI flag is a LATER sprint per the contract). Also do NOT touch `decomposer.ts`, `manifest.ts`, or `src/providers/**` — they must not appear in `git diff`.
- **NEVER set `responseSchema` anywhere in critic-deep.ts.** DeepSeek 400-rejects it. Use `jsonObjectMode: true` ONLY (types.ts:174 vs :183). The evaluator greps for `responseSchema` and it must be empty.
- **Fail-OPEN, not fail-closed.** Unlike `runPlanStage`/`runExpandStage` which THROW at exhaustion (decomposer-deep.ts:275, :312), `getCriticVerdict` and `runCritiqueLoop` must NEVER throw — getCriticVerdict returns `{verdict:"approve",feedback:""}` on parse exhaustion; runCritiqueLoop catches transport throws and returns accept-best. The whole point is to degrade to Phase-3, never below it.
- **Critic is FRESH (LOCK1).** Do NOT pass the EXPAND conversation, do NOT tell the model it authored the manifest. Build a clean message array with the candidate framed as third-party "review this proposed manifest". Use a separate CRITIQUE_SYSTEM_PROMPT.
- **Reuse the single outline (ADR-4).** In decomposeGoalDeep, capture `outline` ONCE from runPlanStage and pass it to BOTH the baseline runExpandStage AND runCritiqueLoop. A 2nd PLAN call would blow the closed-form budget of 8. runCritiqueLoop's re-expand reuses runExpandStage with that same outline — do NOT fork runExpandStage or re-plan.
- **Append critiqueFeedback to the FIRST user turn ONLY.** Do not touch the coercion 3-message branch (decomposer-deep.ts:216-229) — the feedback belongs only in the first EXPAND user message when present.
- **Budget arithmetic for the ceiling test:** with CRITIQUE_MAX_ROUNDS=1, worst case = critic-on-baseline (up to 2 parse calls) + 1 re-expand (up to `1+DEEP_EXPAND_MAX_RETRIES`=2 calls) + critic-on-re-expand (up to 2 calls). Plus the PLAN+EXPAND from decomposeGoalDeep (≤4) when testing end-to-end. The closed-form ceiling DEEP_CRITIQUE_MAX_TOTAL_CALLS=8 counts the decompose path (4) + 1 round × ((1+1)+(1+1))=4 = 8. Test runCritiqueLoop in isolation against its own budget and decomposeGoalDeep end-to-end against 8.
- **ScriptedClient repeats the LAST response.** For all-reject, script ONE reject verdict (it repeats). For reject-then-recover, the response array must interleave correctly with the call order (PLAN, EXPAND-baseline, critic-baseline=reject, re-EXPAND=multi-child, critic-re-expand=approve-or-reject) — count the calls carefully when scripting integration tests.
- **`validateVerdict` missing-feedback case:** `z.string()` (not `.optional()`) means a verdict object lacking `feedback` FAILS safeParse → `{ok:false}`. This is required by sc-1-5; do not make feedback optional.
- **`Outline` is a type-only import** — use `import { type Outline, runExpandStage, ... } from "./decomposer-deep.js"` (inline `type` modifier) or a separate `import type`, to satisfy consistent-type-imports lint.
