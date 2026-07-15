# Sprint Briefing: Robust two-stage decomposition engine (decomposer-deep.ts)

**Contract:** sprint-spec-20260618-fleet-expand-deep-1
**Generated:** 2026-06-18T08:05:00Z

---

## 0. TL;DR (read this first)

Create TWO new files, edit NOTHING else:
- `src/fleet/decomposer-deep.ts` — the PLAN → EXPAND engine
- `src/fleet/decomposer-deep.test.ts` — collocated Vitest tests

The single most important reuse rule: **`validateManifest` is IMPORTED verbatim** from `./decomposer.js` — never copied, never re-implemented. It already does JSON-extraction (direct → fenced → first-brace block), `FleetManifestSchema.safeParse`, AND the config-key guard. The EXPAND stage feeds raw LLM text into it unmodified.

This file is essentially `decomposer.ts` "twice": a PLAN copy of `callDecomposer`/`decomposeGoal` that validates with a NEW local `validateOutline`, then an EXPAND copy that validates with the IMPORTED `validateManifest`. Mirror `src/fleet/decomposer.ts` structure, prompts tone, and the bounded loop exactly.

DO NOT edit: `decomposer.ts`, `manifest.ts`, `index.ts`, anything in `src/providers/`. The evaluator runs `git diff --name-only` and expects ONLY the two new files.

---

## 1. Target Files

### src/fleet/decomposer-deep.ts (create)

**Directory pattern:** `src/fleet/*.ts` use kebab-cased filenames (`decomposer.ts`, `child-config.ts`), named exports, unicode box-drawing section comments (`// ── Section ──`), collocated `*.test.ts`. Confirmed by `ls src/fleet/`.

**Most similar existing file:** `src/fleet/decomposer.ts` — follow its structure section-for-section. The new file is two adapted copies of its three internal pieces (constants → types → `callDecomposer` → `validateManifest` → `decomposeGoal`).

**Structure template (mirror `decomposer.ts:1-187`):**
```typescript
import { validateManifest } from "./decomposer.js";       // REUSE — do not copy
import type { FleetManifest } from "./manifest.js";
import type { LLMClient, Message } from "../providers/types.js";

// ── Constants ────────────────────────────────────────────────────────
export const DEEP_PLAN_SYSTEM_PROMPT = `...emit ONLY { "areas": [ { "name": ..., "intent": ... } ] } ...`;
export const DEEP_PLAN_COERCION_INSTRUCTION = `Your previous response was not a valid outline. ...`;
export const DEEP_EXPAND_SYSTEM_PROMPT = `...emit ONLY { "children": [ { "folder": ..., "task": ... } ] } ...`;  // mirror DECOMPOSE_SYSTEM_PROMPT rules verbatim
export const DEEP_EXPAND_COERCION_INSTRUCTION = `Your previous response was not a valid fleet manifest. ...`;
export const DEEP_PLAN_MAX_RETRIES = 1;
export const DEEP_EXPAND_MAX_RETRIES = 1;
export const DEEP_MAX_TOTAL_CALLS = 4;  // = (1+DEEP_PLAN_MAX_RETRIES)+(1+DEEP_EXPAND_MAX_RETRIES)

// ── Types ────────────────────────────────────────────────────────────
export type OutlineArea = { name: string; intent: string };
export type Outline = { areas: OutlineArea[] };
export interface DecomposeDeepInput {
  goal: string;
  client: LLMClient;
  model: string;
  count?: string;
  planMaxRetries?: number;
  expandMaxRetries?: number;
}
type ValidateOutlineResult =
  | { ok: true; outline: Outline }
  | { ok: false; error: string };

// ── Internal: one PLAN call ──────────────────────────────────────────
async function callPlan(input: { client; model; goal; count?; priorText?; formattedError? }): Promise<string> { ... }
// ── Internal: one EXPAND call ────────────────────────────────────────
async function callExpand(input: { client; model; outline; goal; priorText?; formattedError? }): Promise<string> { ... }

// ── validateOutline (NEVER throws) ───────────────────────────────────
export function validateOutline(rawText: string): ValidateOutlineResult { ... }

// ── Stages ───────────────────────────────────────────────────────────
export async function runPlanStage(input: { client; model; goal; count?; maxRetries: number }): Promise<Outline> { ... }
export async function runExpandStage(input: { client; model; outline: Outline; goal; maxRetries: number }): Promise<FleetManifest> { ... }

// ── Public entrypoint ────────────────────────────────────────────────
export async function decomposeGoalDeep(input: DecomposeDeepInput): Promise<FleetManifest> { ... }
```

**Imports this file uses:**
- `validateManifest` (value import) from `./decomposer.js` — REUSED
- `FleetManifest` (type import) from `./manifest.js`
- `LLMClient`, `Message` (type imports) from `../providers/types.js`

**Imported by:** nothing yet. Sprint 2 (`fleet expand-deep` CLI) will import `decomposeGoalDeep` from `./index.ts`. No current dependents — zero downstream-break risk.

**Test file:** `src/fleet/decomposer-deep.test.ts` (create alongside).

---

### src/fleet/decomposer-deep.test.ts (create)

**Most similar existing file:** `src/fleet/decomposer.test.ts` — copy the `ScriptedClient` class (lines 17-35) verbatim and the helper-JSON-constant pattern (lines 39-48), then adapt assertions.

---

## 2. Patterns to Follow

### Pattern A — The 3-message coercion shape (first-turn vs retry)
**Source:** `src/fleet/decomposer.ts:57-91` (`callDecomposer`)
```typescript
let messages: Message[];
if (priorText !== undefined && formattedError !== undefined) {
  // Coercion retry: 3-message shape [user, assistant, user]
  messages = [
    { role: "user", content: goal },
    { role: "assistant", content: priorText },
    {
      role: "user",
      content: `${DECOMPOSE_COERCION_INSTRUCTION}\n\nPrevious validation error:\n${formattedError}`,
    },
  ];
} else {
  messages = [{ role: "user", content: goal }];  // First turn: single user message
}
const response = await client.chat({
  model,
  system: DECOMPOSE_SYSTEM_PROMPT,
  messages,
  jsonObjectMode: true,            // ALWAYS true
});                                // responseSchema is NEVER set
return response.text;
```
**Rule:** Each stage's call helper does exactly this. First turn = `[{role:'user',content:<prompt>}]`. Retry (attempt>0) = `[{role:'user',content:<prompt>}, {role:'assistant',content:priorText}, {role:'user',content:`${COERCION}\n\nPrevious validation error:\n${formattedError}`}]`. EVERY `client.chat` sets `jsonObjectMode: true` and never references `responseSchema` (satisfies AC3 / sc-1-5). For PLAN the first user message = goal (+ optional soft count hint); for EXPAND the first user message = goal + `JSON.stringify(outline)`.

### Pattern B — The bounded attempt loop (maxAttempts = 1 + maxRetries)
**Source:** `src/fleet/decomposer.ts:159-187` (`decomposeGoal`)
```typescript
const maxAttempts = 1 + maxRetries;
let lastError = "Unknown error";
let priorText: string | undefined;
for (let attempt = 0; attempt < maxAttempts; attempt++) {
  const rawText = await callDecomposer({
    client, model, goal,
    priorText: attempt > 0 ? priorText : undefined,
    formattedError: attempt > 0 ? lastError : undefined,
  });
  const validated = validateManifest(rawText);
  if (validated.ok) return validated.manifest;
  lastError = validated.error;
  priorText = rawText;
}
throw new Error(`Fleet decomposition failed after ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}:\n${lastError}`);
```
**Rule:** Both `runPlanStage` and `runExpandStage` use THIS exact loop shape. PLAN validates with `validateOutline` and throws `` `deep plan failed after ${maxAttempts} attempt(s):\n${lastError}` ``; EXPAND validates with the IMPORTED `validateManifest` and throws `` `deep expand failed after ${maxAttempts} attempt(s):\n${lastError}` ``. With `maxRetries=1`, `maxAttempts=2` → at most 2 calls per stage → 4 total (AC4/AC5/budget, sc-1-6/sc-1-7).

### Pattern C — JSON extraction strategy (reuse via validateManifest; mirror in validateOutline)
**Source:** `src/fleet/decomposer.ts:95-155` (`validateManifest`)
```typescript
let parsed: unknown;
try {
  parsed = JSON.parse(rawText.trim());            // 1. direct parse
} catch {
  const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(rawText);  // 2. fenced block
  if (fenceMatch) { try { parsed = JSON.parse(fenceMatch[1].trim()); } catch { /* fall through */ } }
  if (!parsed) {                                  // 3. first { .. last }
    const braceStart = rawText.indexOf("{");
    const braceEnd = rawText.lastIndexOf("}");
    if (braceStart !== -1 && braceEnd > braceStart) {
      try { parsed = JSON.parse(rawText.slice(braceStart, braceEnd + 1)); }
      catch { return { ok: false, error: `No valid JSON object found in response. Raw: ${rawText.slice(0, 200)}` }; }
    } else { return { ok: false, error: `No JSON object found in response. Raw: ${rawText.slice(0, 200)}` }; }
  }
}
```
**Rule:** `validateManifest` already does this — EXPAND gets it for free by passing raw text. `validateOutline` must replicate the SAME 3-tier extraction (direct → fenced → first-brace block) then shape-check for `{ areas: [{name:non-empty-string, intent:string}] }` with `areas.length >= 1`. It returns `{ ok:false, error }` on every failure and NEVER throws (AC6 / sc-1-8). You MAY hand-roll the shape check OR use a small LOCAL zod schema (`z.object({areas: z.array(z.object({name: z.string().min(1), intent: z.string()})).min(1)})`). Do NOT touch `manifest.ts`.

### Pattern D — The config-key guard (inherited, do not reimplement)
**Source:** `src/fleet/decomposer.ts:142-152`
```typescript
const offending = result.data.children.find((c) =>
  Object.prototype.hasOwnProperty.call(c, "config"),
);
if (offending) {
  return { ok: false, error: `child "${offending.folder}": children must not carry a "config" key` };
}
```
**Rule:** This lives INSIDE the imported `validateManifest`. The EXPAND stage inherits it automatically — a child carrying `config` returns `ok:false` with an error containing `"config"`, which routes to a coercion retry (AC5 / sc-1-7). You write zero guard code; you only TEST that it surfaces.

### Pattern E — ESM / type-import / section-comment conventions
**Source:** `src/fleet/decomposer.ts:1-5`
```typescript
import { FleetManifestSchema } from "./manifest.js";   // .js extension (NodeNext)
import type { FleetManifest } from "./manifest.js";     // import type for type-only
import type { LLMClient, Message } from "../providers/types.js";
```
**Rule:** All relative imports carry `.js`. Type-only imports use `import type` (ESLint `consistent-type-imports` is a hard gate). Use `// ── Name ──` box-drawing section headers. No explicit `any` (use `unknown` + narrowing).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `validateManifest` | `src/fleet/decomposer.ts:95` | `(rawText: string) => { ok:true; manifest:FleetManifest } \| { ok:false; error:string }` | JSON-extract + `FleetManifestSchema.safeParse` + config-key guard. **IMPORT verbatim into EXPAND stage — never copy.** |
| `FleetManifestSchema` | `src/fleet/manifest.ts:13` | `z.object({ rootDir, concurrency, children })` | Zod schema; `.parse` applies defaults `rootDir:"."`, `concurrency:3`. Tests use `FleetManifestSchema.parse/safeParse` to assert results. |
| `FleetChildSchema` | `src/fleet/manifest.ts:6` | `z.object({ folder:min(1), task:min(1), config?:record })` | Child shape — note `config` is OPTIONAL (that's WHY the extra guard exists). Do not modify. |
| `FleetManifest` type | `src/fleet/manifest.ts:18` | `z.infer<typeof FleetManifestSchema>` | Return type of `decomposeGoalDeep`/`runExpandStage`. `import type`. |
| `DECOMPOSE_SYSTEM_PROMPT` | `src/fleet/decomposer.ts:7` | `string` | Reference prompt — mirror its children-only RULES verbatim in `DEEP_EXPAND_SYSTEM_PROMPT` (kebab folder, self-contained task, >=1 child, NO config/concurrency/rootDir/provider keys). |
| `DECOMPOSE_COERCION_INSTRUCTION` | `src/fleet/decomposer.ts:24` | `string` | Reference for `DEEP_EXPAND_COERCION_INSTRUCTION` tone/shape. |
| `LLMClient` / `Message` / `ChatParams` / `ChatResponse` | `src/providers/types.ts:216 / :128 / :139 / :194` | interfaces | Provider-agnostic types. `import type`. NEVER import a provider SDK type. `ChatParams.jsonObjectMode` is at `:183`, `ChatParams.responseSchema` at `:174`. |

Utilities reviewed: `src/utils/`, `src/lib/` — none applicable (this module only needs `validateManifest` + the manifest schema/types + provider types; no fs/git/logger helpers involved — sprint is pure in-memory).

**Critical:** there is NO existing `validateOutline`, no `Outline` type, no `DEEP_*` constant anywhere — confirmed by grep. You are creating all of them. But `validateManifest` and `FleetManifestSchema` ALREADY exist — do not recreate.

---

## 4. Prior Sprint Output

### Phase 2 (single-shot decomposer) — already merged on this branch
**File:** `src/fleet/decomposer.ts` — exports `decomposeGoal`, `validateManifest`, `DECOMPOSE_SYSTEM_PROMPT`, `DECOMPOSE_COERCION_INSTRUCTION`, `DECOMPOSE_MAX_RETRIES`, `DecomposeInput`.
**File:** `src/fleet/decomposer.test.ts` — `ScriptedClient` fake (lines 17-35), `VALID_MANIFEST_JSON`/`VALID_MULTI_CHILD_JSON` helpers (lines 39-48).
**File:** `src/fleet/manifest.ts` — `FleetManifestSchema`, `FleetChildSchema`, `FleetManifest`, `FleetChild`, `load`.
**Connection to this sprint:** This sprint IS the "deep" twin of Phase 2. It imports `validateManifest` from `decomposer.ts`, mirrors `callDecomposer`/`decomposeGoal` structure, and reuses the `ScriptedClient` test fake. `decomposer.ts` itself is **byte-locked** (CP1 / ADR-2) — do not edit it.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere** — `.js` import extensions for NodeNext (`principles.md:27`).
- **Provider-agnostic interfaces** — only `LLMClient`/`Message` from `providers/types.js`; NEVER import an SDK type outside `providers/` (`principles.md:28,41`). sc-1-2 enforces this.
- **Zod for validation** — no hand-rolled validation where a schema fits; a small LOCAL zod schema for the Outline is acceptable (`principles.md:29`). Do not edit `manifest.ts`.
- **TS strict, zero `any`** — use `unknown` + narrowing (`principles.md:18,40`). sc-1-2 hard gate.
- **`import type`** for type-only imports (`consistent-type-imports`, `principles.md:35`). sc-1-3 hard gate.
- **Section comments** — `// ── Name ──` box headers (`principles.md:32`).
- **Tests collocated** as `*.test.ts` next to source, Vitest (`principles.md:20`).

### Architecture Decisions (this exact spec)
- **ADR-1** (`arch-20260617-fleet-robust-decomposition-adr-1.md`): chose two-call PLAN→EXPAND for a FIXED-constant budget; reuses `validateManifest` + 3-message coercion. Approach B (critique loop) deferred — do NOT add a self-critique round (nonGoal).
- **ADR-2** (`...-adr-2.md`): NEW `decomposer-deep.ts` beside the LOCKED `decomposer.ts`; import `validateManifest` only — never duplicate it. `decomposer.ts` diff must be ZERO.
- **ADR-3** (`...-adr-3.md`): `Outline` is in-memory ONLY — no disk write, no loader, no schema file, no CLI. The only artifact a later sprint writes is the children-only manifest.
- **ADR-4 / ADR-5** (`...-adr-4/5.md`): CLI default path and the `fleet expand-deep` sibling subcommand — **Sprint 2 only**, out of scope here. No `index.ts` edits.

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/fleet/decomposer.test.ts:1-35` (the `ScriptedClient` fake — copy this verbatim)
```typescript
import { describe, it, expect } from "vitest";
import type { LLMClient, ChatParams, ChatResponse } from "../providers/types.js";
import { FleetManifestSchema } from "./manifest.js";
import {
  decomposeGoalDeep, runPlanStage, runExpandStage, validateOutline,
  DEEP_PLAN_MAX_RETRIES, DEEP_EXPAND_MAX_RETRIES, DEEP_MAX_TOTAL_CALLS,
} from "./decomposer-deep.js";

class ScriptedClient implements LLMClient {
  readonly calls: ChatParams[] = [];          // records EVERY ChatParams
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
**Runner:** Vitest. **Assertion style:** `expect(...)`. **Mock approach:** hand-rolled `ScriptedClient` implementing `LLMClient` (no `vi.mock`). **File naming:** `decomposer-deep.test.ts`. **Location:** collocated in `src/fleet/`.

**Key assertion idioms (mirror `decomposer.test.ts`):**
```typescript
// happy path (sc-1-4 / AC1,AC2): script [validOutlineJson, validMultiChildManifestJson]
const client = new ScriptedClient([VALID_OUTLINE_JSON, VALID_MULTI_CHILD_JSON]);
const result = await decomposeGoalDeep({ goal: "Build a platform", client, model: "deepseek-v4-pro" });
expect(FleetManifestSchema.safeParse(result).success).toBe(true);
expect(result.children.length).toBeGreaterThan(1);
expect(Object.prototype.hasOwnProperty.call(result.children[0], "config")).toBe(false);
expect(client.calls).toHaveLength(2);   // exactly PLAN + EXPAND

// jsonObjectMode / responseSchema on BOTH calls (sc-1-5 / AC3)
expect(client.calls[0]?.jsonObjectMode).toBe(true);
expect(client.calls[0]?.responseSchema).toBeUndefined();
expect(client.calls[1]?.jsonObjectMode).toBe(true);
expect(client.calls[1]?.responseSchema).toBeUndefined();

// PLAN exhaustion (sc-1-6 / AC4): EXPAND never runs
const c = new ScriptedClient(["not json", "still not json"]);
await expect(decomposeGoalDeep({ goal: "g", client: c, model: "m" })).rejects.toThrow(/deep plan failed/);
expect(c.calls).toHaveLength(2);   // exactly 2, EXPAND absent

// EXPAND exhaustion incl. config child (sc-1-7 / AC5): budget bound <= 4
const cfgChild = JSON.stringify({ children: [{ folder: "x", task: "t", config: {} }] });
const c2 = new ScriptedClient([VALID_OUTLINE_JSON, cfgChild, cfgChild]);
await expect(decomposeGoalDeep({ goal: "g", client: c2, model: "m" })).rejects.toThrow(/deep expand failed/);
expect(c2.calls.length).toBeLessThanOrEqual(DEEP_MAX_TOTAL_CALLS);  // <= 4
// the EXPAND error message should mention the config guard:
//   await expect(...).rejects.toThrow(/config/);

// 3-message coercion shape on retry (AC7): inspect calls[1].messages
const second = c.calls[1];
expect(second?.messages).toHaveLength(3);
expect(second?.messages[0]?.role).toBe("user");
expect(second?.messages[1]?.role).toBe("assistant");   // prior bad text echoed
expect(second?.messages[2]?.role).toBe("user");        // coercion + error

// validateOutline never throws (sc-1-8 / AC6)
expect(validateOutline(JSON.stringify({ areas: [{ name: "auth", intent: "login" }] })).ok).toBe(true);
expect(validateOutline("").ok).toBe(false);
expect(validateOutline("nope").ok).toBe(false);
expect(validateOutline(JSON.stringify({ areas: [] })).ok).toBe(false);

// constants (sc-1-8 / AC8)
expect(DEEP_PLAN_MAX_RETRIES).toBe(1);
expect(DEEP_EXPAND_MAX_RETRIES).toBe(1);
expect(DEEP_MAX_TOTAL_CALLS).toBe(4);
```
Helper constants to define at test top (mirror `decomposer.test.ts:39-48`):
```typescript
const VALID_OUTLINE_JSON = JSON.stringify({ areas: [
  { name: "auth", intent: "user login and sessions" },
  { name: "billing", intent: "payments and invoices" },
]});
const VALID_MULTI_CHILD_JSON = JSON.stringify({ children: [
  { folder: "auth-service", task: "Build the auth service" },
  { folder: "billing-service", task: "Build the billing service" },
]});
```

### E2E Test Pattern
Not applicable — this sprint has no CLI, no disk IO, no network. All tests are pure unit tests with the injected `ScriptedClient`.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/fleet/decomposer.ts` | (you IMPORT from it) | low | You only ADD an importer. Do NOT edit it — must stay byte-identical (ADR-2). `git diff` must not name it. |
| `src/fleet/index.ts` | imports `decomposeGoal` from `decomposer.ts` (`index.ts:23`) | low | Unchanged this sprint. Sprint 2 wires `decomposeGoalDeep`. Do NOT edit. |
| `src/fleet/expand.test.ts` | `import type { decomposeGoal }` (`:9`) | low | Type-only import of an unchanged symbol — unaffected. |
| `src/fleet/manifest.ts` | (you IMPORT `FleetManifest`/schema) | low | Read-only reuse. Do NOT edit. |

New file has NO current dependents (Sprint 2 adds the first), so it cannot break anything downstream.

### Existing Tests That Must Still Pass
- `src/fleet/decomposer.test.ts` — tests `decomposeGoal`/`validateManifest`; must stay green because you do not touch `decomposer.ts`.
- `src/fleet/expand.test.ts` — tests `runFleetExpand` CLI; unaffected (you do not touch `index.ts`).
- `src/fleet/index.test.ts`, `manifest.test.ts` — unaffected; verify still green.

### Features That Could Be Affected
- **Phase 2 `fleet expand`** — shares `validateManifest` + `FleetManifestSchema`. Because you only IMPORT (never mutate) these, Phase 2 behavior is unchanged. Verify by running the full fleet suite.

### Recommended Regression Checks
1. `git diff --name-only` shows ONLY `src/fleet/decomposer-deep.ts` and `src/fleet/decomposer-deep.test.ts` (evaluator gate — decomposer.ts/manifest.ts/index.ts/providers/ MUST be byte-unchanged).
2. `npx tsc --noEmit` → zero errors (sc-1-1, sc-1-2).
3. `npx eslint src/fleet/decomposer-deep.ts src/fleet/decomposer-deep.test.ts` → zero errors (sc-1-3).
4. `npx vitest run src/fleet/` → all fleet tests green (new + existing decomposer/expand/index/manifest).
5. Grep new file: `grep -n responseSchema src/fleet/decomposer-deep.ts` → returns NOTHING (responseSchema must never be referenced — sc-1-5).
6. Grep new file: `grep -n "jsonObjectMode: true" src/fleet/decomposer-deep.ts` → appears in BOTH call helpers.
7. Grep new file: `grep -n 'from "./decomposer.js"' src/fleet/decomposer-deep.ts` → confirms `validateManifest` is imported, not re-implemented.

---

## 8. Implementation Sequence

1. **Constants** — `DEEP_PLAN_SYSTEM_PROMPT`, `DEEP_PLAN_COERCION_INSTRUCTION`, `DEEP_EXPAND_SYSTEM_PROMPT` (mirror `DECOMPOSE_SYSTEM_PROMPT` children-only rules verbatim), `DEEP_EXPAND_COERCION_INSTRUCTION`, `DEEP_PLAN_MAX_RETRIES=1`, `DEEP_EXPAND_MAX_RETRIES=1`, `DEEP_MAX_TOTAL_CALLS=4`.
   - Verify: AC8 constant values; the three numeric constants equal 1/1/4.
2. **Types** — `OutlineArea`, `Outline`, `DecomposeDeepInput`, local `ValidateOutlineResult` union.
   - Verify: `Outline = { areas: OutlineArea[] }` exactly; `DecomposeDeepInput` has `goal/client/model/count?/planMaxRetries?/expandMaxRetries?`.
3. **`validateOutline(rawText)`** — replicate the 3-tier JSON extraction from `validateManifest` (`decomposer.ts:95-132`), then shape-check `{ areas: [{name:non-empty, intent:string}], length>=1 }`. NEVER throws — returns `{ok,...}`.
   - Verify: AC6 — `''`, `'nope'`, `{areas:[]}` → `ok:false` (no throw); valid object → `ok:true`.
4. **`callPlan` / `callExpand`** — one-call helpers mirroring `callDecomposer` (`decomposer.ts:57-91`): first turn single user msg; retry 3-message shape; ALWAYS `jsonObjectMode:true`, NEVER `responseSchema`. PLAN first-msg = goal (+ soft count hint if `count`); EXPAND first-msg = goal + `JSON.stringify(outline)`.
   - Verify: AC3/AC7 — inspect captured `ChatParams`.
5. **`runPlanStage`** — bounded loop (`maxAttempts = 1 + maxRetries`), validate with `validateOutline`, return `outline` on ok, else throw `` `deep plan failed after ${maxAttempts} attempt(s):\n${lastError}` ``.
   - Verify: AC4 — 2 attempts then throw with accumulated error.
6. **`runExpandStage`** — same loop, call `callExpand`, validate with IMPORTED `validateManifest`, throw `` `deep expand failed after ${maxAttempts} attempt(s):\n${lastError}` `` on exhaustion.
   - Verify: AC5 — config-bearing child rejected by the inherited guard → retry → throw; total ≤ 4.
7. **`decomposeGoalDeep`** — `runPlanStage` THEN `runExpandStage(outline)` (strictly sequential, never parallel); pass `planMaxRetries ?? DEEP_PLAN_MAX_RETRIES` / `expandMaxRetries ?? DEEP_EXPAND_MAX_RETRIES`; return manifest.
   - Verify: AC1/AC2 — happy-path multi-child, children only folder+task.
8. **`decomposer-deep.test.ts`** — copy `ScriptedClient`, add the 6 test groups (happy path; both-calls jsonObjectMode/responseSchema; PLAN exhaustion = 2 calls no EXPAND; EXPAND exhaustion incl. config child + budget ≤ 4; `validateOutline` ok/not-ok; constants).
9. **Full verification** — `npx tsc --noEmit` && `npx eslint src/fleet/decomposer-deep.*` && `npx vitest run src/fleet/` && `git diff --name-only`.

---

## 9. Pitfalls & Warnings

- **Do NOT copy `validateManifest`.** Import it from `./decomposer.js`. The evaluator greps the import (sc-1-4). A copied implementation fails review even if it works.
- **`decomposer.ts` is byte-locked (ADR-2 / CP1).** Any edit — even reformatting — fails the `git diff --name-only` gate. Same for `manifest.ts`, `index.ts`, `src/providers/`.
- **`responseSchema` must NEVER appear** in the new file (DeepSeek rejects strict json_schema; see `providers/types.ts:176-181`). Only `jsonObjectMode: true`. A test asserts `responseSchema === undefined` on BOTH captured calls.
- **`validateOutline` must NEVER throw.** Wrap parse attempts in try/catch and return `{ok:false, error}` for every failure mode (non-JSON, wrong shape, empty `areas`). A throw fails AC6.
- **Config-key guard is inherited, not written.** `FleetChildSchema.config` is OPTIONAL (`manifest.ts:9`), so `safeParse` alone ACCEPTS a config-bearing child — the guard inside `validateManifest` (`decomposer.ts:144-152`) is what rejects it. You get this for free via the import; only TEST that the EXPAND error mentions `"config"`.
- **Budget arithmetic:** with default retries, PLAN ≤ 2 + EXPAND ≤ 2 = 4 total. If PLAN never succeeds, EXPAND is never called (2 total). Use `ScriptedClient.calls.length` to assert these exactly (sc-1-6 = `===2`; sc-1-7 = `<=4`).
- **PLAN strictly precedes EXPAND** — never run them in parallel (`await runPlanStage` then `await runExpandStage`). A failing PLAN must short-circuit before any EXPAND call.
- **ScriptedClient repeats its last response** once the script is exhausted (`Math.min(idx, len-1)`). For exhaustion tests provide 2 failing entries (or rely on repeat) so every attempt sees a failing response.
- **`ChatResponse.stopReason`** in the existing fake is `"end"` (`decomposer.test.ts:31`) — keep that; the deep code only reads `response.text`, so stopReason value is irrelevant but copy it for consistency.
- **No explicit `any`** — for the local Outline shape-check use `unknown` + narrowing or a local zod schema; do not cast through `any`.
