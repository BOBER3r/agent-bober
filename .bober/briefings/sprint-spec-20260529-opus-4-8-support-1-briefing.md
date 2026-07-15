# Sprint Briefing: Repoint opus shorthand to Claude Opus 4.8 with pinned 4.7 alias

**Contract:** sprint-spec-20260529-opus-4-8-support-1
**Generated:** 2026-05-29T18:30:00Z

> Scope is tiny and exactly two files: `src/orchestrator/model-resolver.ts` and `src/orchestrator/model-resolver.test.ts`. No SDK, no adapter, no schema, no defaults.ts changes. The `opus` shorthand is referenced widely (defaults.ts, schema.ts, init.ts, many tests) by NAME, never by raw id — so repointing the shorthand propagates 4.8 transitively with zero other edits.

---

## 1. Target Files

### src/orchestrator/model-resolver.ts (modify)

The only change is inside `SHORTHAND_MAP`. The whole 92-line file is shown elsewhere; the load-bearing block is lines 22-35.

**Relevant section — current (lines 22-35):**
```ts
const SHORTHAND_MAP: Record<string, { provider: string; modelId: string }> = {
  // Anthropic
  opus: { provider: "anthropic", modelId: "claude-opus-4-7" },
  sonnet: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
  haiku: { provider: "anthropic", modelId: "claude-haiku-4-5" },
  // OpenAI
  "gpt-4.1": { provider: "openai", modelId: "gpt-4.1" },
  "gpt-4.1-mini": { provider: "openai", modelId: "gpt-4.1-mini" },
  o3: { provider: "openai", modelId: "o3" },
  "o4-mini": { provider: "openai", modelId: "o4-mini" },
  // Google
  "gemini-pro": { provider: "google", modelId: "gemini-2.5-pro" },
  "gemini-flash": { provider: "google", modelId: "gemini-2.5-flash" },
};
```

**Relevant section — desired (replace the Anthropic block, lines 23-26):**
```ts
const SHORTHAND_MAP: Record<string, { provider: string; modelId: string }> = {
  // Anthropic
  opus: { provider: "anthropic", modelId: "claude-opus-4-8" },
  "opus-4-8": { provider: "anthropic", modelId: "claude-opus-4-8" }, // optional symmetry alias
  "opus-4-7": { provider: "anthropic", modelId: "claude-opus-4-7" }, // pinned previous GA
  sonnet: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
  haiku: { provider: "anthropic", modelId: "claude-haiku-4-5" },
  // ...rest unchanged...
```

Exact required edits:
1. Line 24: change `modelId: "claude-opus-4-7"` -> `modelId: "claude-opus-4-8"` for the `opus` key.
2. Add a new key `"opus-4-7": { provider: "anthropic", modelId: "claude-opus-4-7" }` (REQUIRED — criterion C2).
3. (Optional, generatorNotes-blessed) Add `"opus-4-8": { provider: "anthropic", modelId: "claude-opus-4-8" }` for symmetry. Not asserted by any criterion — include only if you add a matching test or leave it untested; it cannot break anything.

Do NOT touch `resolveProviderModel` (lines 51-78) or `resolveModel` (lines 88-91) — they read the map generically and need no logic change. The default-anthropic passthrough branch (lines 76-77) is what keeps `resolveProviderModel("claude-opus-4-7")` returning `claude-opus-4-7`.

**Imports this file uses:** none (no `import` lines; it only `export`s the interface + two functions).

**Imported by (15 files — all import the FUNCTIONS, none read the map directly):**
- `src/providers/factory.ts`, `src/providers/types.ts`, `src/index.ts`
- `src/discovery/synthesizer.ts`, `src/orchestrator/agentic-loop.ts`
- `src/orchestrator/{planner,generator,curator,evaluator,code-reviewer,research,architect}-agent.ts`
- tests: `model-resolver.test.ts`, `code-reviewer-agent.test.ts`, `checkpoints/checkpoints.test.ts`

None of these hardcode `claude-opus-4-7`; they pass the `"opus"` shorthand through `resolveProviderModel`/`resolveModel`, so they automatically pick up 4.8.

**Test file:** `src/orchestrator/model-resolver.test.ts` (exists — collocated, must be updated).

---

### src/orchestrator/model-resolver.test.ts (modify)

**Sections to CHANGE:**

`resolveProviderModel` opus assertion (current, lines 6-11):
```ts
    it("resolves opus to anthropic/claude-opus-4-7", () => {
      expect(resolveProviderModel("opus")).toEqual({
        provider: "anthropic",
        modelId: "claude-opus-4-7",
      });
    });
```
becomes:
```ts
    it("resolves opus to anthropic/claude-opus-4-8", () => {
      expect(resolveProviderModel("opus")).toEqual({
        provider: "anthropic",
        modelId: "claude-opus-4-8",
      });
    });

    it("resolves opus-4-7 to anthropic/claude-opus-4-7 (pinned alias)", () => {
      expect(resolveProviderModel("opus-4-7")).toEqual({
        provider: "anthropic",
        modelId: "claude-opus-4-7",
      });
    });
```
(The new `opus-4-7` test satisfies criterion C2. Place it right after the opus test, inside the `describe("Anthropic shorthands", ...)` block at lines 5-26.)

`resolveModel` backward-compat opus assertion (current, lines 126-128):
```ts
  it("returns modelId for opus", () => {
    expect(resolveModel("opus")).toBe("claude-opus-4-7");
  });
```
becomes:
```ts
  it("returns modelId for opus", () => {
    expect(resolveModel("opus")).toBe("claude-opus-4-8");
  });
```

**Sections that MUST STAY UNCHANGED (criterion C3 — these guard the full-id passthrough):**

Line 116-121 — full-id passthrough via the default-anthropic branch:
```ts
    it("defaults exact Anthropic model IDs to anthropic provider", () => {
      expect(resolveProviderModel("claude-opus-4-7")).toEqual({
        provider: "anthropic",
        modelId: "claude-opus-4-7",
      });
    });
```
Line 138-140 — backward-compat passthrough:
```ts
  it("passes through unknown model ID unchanged", () => {
    expect(resolveModel("claude-opus-4-7")).toBe("claude-opus-4-7");
  });
```
These keep yielding `claude-opus-4-7` because a full id is not a shorthand key, so it hits the line 76-77 default-anthropic branch and passes through verbatim. Adding `opus-4-7` as a shorthand does NOT affect them (different key string). Leave them exactly as-is. Likewise leave the sonnet/haiku/OpenAI/Google/ollama/explicit-provider tests untouched.

---

## 2. Patterns to Follow

### SHORTHAND_MAP entry style
**Source:** `src/orchestrator/model-resolver.ts`, lines 22-35
```ts
  opus: { provider: "anthropic", modelId: "claude-opus-4-7" },
  sonnet: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
  "gpt-4.1": { provider: "openai", modelId: "gpt-4.1" },
```
**Rule:** Keys that are valid JS identifiers are bare (`opus`, `sonnet`); keys with dots/hyphens are quoted (`"gpt-4.1"`, `"o4-mini"`). So the new alias MUST be quoted: `"opus-4-7"` and `"opus-4-8"`. Value is always a flat `{ provider, modelId }` object literal, double-quoted strings, trailing comma.

### Model id literal form
**Source:** contract assumptions + keyPrinciples in handoff
**Rule:** `claude-opus-4-8` is a dateless pinned snapshot — use the BARE id, NO date suffix (not `claude-opus-4-8-20260528`). Mirror the existing `claude-opus-4-7` / `claude-sonnet-4-6` style.

### Test structure (Vitest, collocated)
**Source:** `src/orchestrator/model-resolver.test.ts`, lines 1-26
```ts
import { describe, it, expect } from "vitest";
import { resolveProviderModel, resolveModel } from "./model-resolver.js";

describe("resolveProviderModel", () => {
  describe("Anthropic shorthands", () => {
    it("resolves sonnet to anthropic/claude-sonnet-4-6", () => {
      expect(resolveProviderModel("sonnet")).toEqual({
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
      });
    });
  });
});
```
**Rule:** Nested `describe` -> `it("resolves <shorthand> to <provider>/<modelId>", ...)`, body is `expect(resolveProviderModel(x)).toEqual({ provider, modelId })`. Match this exact title and body shape for the new `opus-4-7` test.

### ESM `.js` import extension
**Source:** `src/orchestrator/model-resolver.test.ts`, line 2 — `from "./model-resolver.js"`
**Rule:** Relative imports end in `.js` (NodeNext). The test file already imports correctly; no new imports are needed for this sprint.

---

## 3. Existing Utilities — DO NOT Recreate

The two functions in scope already exist and are the canonical resolution path. Do NOT create new resolver helpers, lookup tables, or alias maps elsewhere.

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `SHORTHAND_MAP` | `src/orchestrator/model-resolver.ts:22` | `Record<string, { provider; modelId }>` | The single source of truth for shorthand -> model id. Edit THIS, nothing else. |
| `resolveProviderModel` | `src/orchestrator/model-resolver.ts:51` | `(model: string, explicitProvider?: string): ResolvedModel` | Expands shorthand or passes full id through (default anthropic). No change needed. |
| `resolveModel` | `src/orchestrator/model-resolver.ts:88` | `(choice: string): string` | Backward-compat wrapper returning just `modelId`. No change needed. |
| `ResolvedModel` | `src/orchestrator/model-resolver.ts:9` | `interface { provider; modelId; endpoint? }` | Return type. No change needed. |
| `ModelChoiceSchema` | `src/config/schema.ts:19` | `z.string().min(1)` | Config model field. FREE STRING, not an enum — so the new `opus-4-7` alias needs NO schema edit. |

---

## 4. Prior Sprint Output

No prior sprints in this plan (`dependsOn: []`). The branch is stacked on completed prompt-caching work in `src/providers/`, which this sprint does NOT touch. Do not modify any provider/adapter file.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md` — exists)
- **ESM everywhere:** relative imports end in `.js` (already correct in the test file).
- **`consistent-type-imports`:** import types with `import type`. (No type imports added this sprint.)
- **Prefix unused params with `_`.** (N/A here.)
- **No SDK lock-in:** never import `@anthropic-ai/sdk` outside adapters. Reinforces the contract non-goal — do not touch the adapter or SDK.
- **Tests collocated:** `*.test.ts` next to `*.ts`, Vitest. (model-resolver.test.ts already follows this.)
- **Conventional commits:** sprint commits use `bober(sprint-N): description`. Use exactly:
  `bober(sprint-1): repoint opus shorthand to claude-opus-4-8 + pin opus-4-7`

### Architecture Decisions
No `.bober/architecture/` ADRs relevant to this sprint were found/needed.

### Baseline note (from handoff)
On this branch, `typecheck`/`lint`/`build` PASS. `npm run test` has **2 PRE-EXISTING flaky timeout failures** in the "registers exactly 37 tools" tests (`tests/mcp/external-server-graph.test.ts` and/or `src/mcp/tools/tools.test.ts`). Those 2 are the ONLY tolerated failures for C5; anything else is a regression.

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/orchestrator/model-resolver.test.ts` (full file is the template)
```ts
import { describe, it, expect } from "vitest";
import { resolveProviderModel, resolveModel } from "./model-resolver.js";

describe("resolveProviderModel", () => {
  describe("Anthropic shorthands", () => {
    it("resolves opus-4-7 to anthropic/claude-opus-4-7 (pinned alias)", () => {
      expect(resolveProviderModel("opus-4-7")).toEqual({
        provider: "anthropic",
        modelId: "claude-opus-4-7",
      });
    });
  });
});
```
**Runner:** vitest
**Assertion style:** `expect(...).toEqual(...)` for object returns, `.toBe(...)` for the string-returning `resolveModel`.
**Mock approach:** none — pure function, no mocks needed.
**File naming:** `<module>.test.ts`
**Location:** collocated (next to `model-resolver.ts`).
**Run just this suite:** `npx vitest run src/orchestrator/model-resolver.test.ts`

### E2E Test Pattern
Not applicable — agent-bober is a CLI/library; no Playwright in scope for this sprint.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| 15 importers of `model-resolver` (factory.ts, the *-agent.ts files, synthesizer.ts, index.ts, etc.) | `resolveProviderModel`/`resolveModel` (function signatures unchanged) | low | Signatures unchanged; only a returned string value flips 4-7->4-8. Nothing asserts the literal `claude-opus-4-7` outside the resolver test. |
| `src/config/defaults.ts` (lines 78,178,218), `src/config/schema.ts` (85,123,362,365), `src/cli/commands/init.ts`, `src/mcp/tools/init.ts` | the `"opus"` shorthand string | low | They use the shorthand by name; repointing the map updates them transitively — that is the intended behavior, no edit. |
| Many `*.test.ts` using `model: "opus"` (synthesizer, run-manager, worktree, code-reviewer-agent, abort-run, get/list-run, run-in-worktree) | `"opus"` shorthand | low | They use opus as a config value, NOT asserting a resolved id. Should stay green. |

### Existing Tests That Must Still Pass
- `src/orchestrator/model-resolver.test.ts` — the file you are editing; sonnet/haiku/OpenAI/Google/ollama/explicit/unknown/full-id passthrough cases must remain green (only opus assertions change + one new test added).
- All other suites — unaffected; none assert `claude-opus-4-7` as a literal (grep confirmed it appears ONLY in model-resolver.ts and model-resolver.test.ts).

### Features That Could Be Affected
- **All agents (planner/generator/curator/etc.)** — share the `opus` shorthand. Intended: they now route to claude-opus-4-8 at runtime. No code change; the resolver is the single point.
- This is sprint 1 of 4; later sprints handle SDK/effort/system — explicitly OUT of scope here.

### Recommended Regression Checks
After implementation, the Generator MUST verify:
1. `npx vitest run src/orchestrator/model-resolver.test.ts` — updated opus (4-8) + new opus-4-7 test pass; sonnet/haiku/passthrough green.
2. `npm run typecheck` — exit 0.
3. `npm run build` — exit 0 (C4: produces updated dist for the npm-linked cockpit).
4. `npm run lint` — exit 0 (consistent-type-imports / unused vars).
5. `npm run test` — only the 2 documented flaky "registers exactly 37 tools" timeout failures may fail; anything else is a regression (C5).
6. `git diff --name-only` — touches ONLY `src/orchestrator/model-resolver.ts` and `src/orchestrator/model-resolver.test.ts` (stopCondition).

---

## 8. Implementation Sequence

1. **src/orchestrator/model-resolver.ts** — In `SHORTHAND_MAP` (line 24) change the `opus` modelId to `claude-opus-4-8`; add `"opus-4-7": { provider: "anthropic", modelId: "claude-opus-4-7" }` (and optionally `"opus-4-8"`). Touch nothing else.
   - Verify: `git diff src/orchestrator/model-resolver.ts` shows only the map block changed.
2. **src/orchestrator/model-resolver.test.ts** — Update the opus `resolveProviderModel` test (lines 6-11) to expect `claude-opus-4-8` and rename its title; add a new `opus-4-7` -> `claude-opus-4-7` test in the same describe block; update the `resolveModel("opus")` backward-compat assertion (line 127) to `claude-opus-4-8`. Leave the two full-id passthrough tests (lines 116-121 and 138-140) and all sonnet/haiku/OpenAI/Google/ollama/explicit/unknown tests untouched.
   - Verify: `npx vitest run src/orchestrator/model-resolver.test.ts` is fully green.
3. **Run full verification** — `npm run typecheck`, `npm run build`, `npm run lint`, `npm run test` (tolerate only the 2 flaky 37-tool tests), then confirm `git diff --name-only` lists exactly the two target files.

---

## 9. Pitfalls & Warnings

- **Quote the new keys.** `opus-4-7` and `opus-4-8` contain hyphens — they MUST be quoted string keys (`"opus-4-7"`), matching the existing `"gpt-4.1"` / `"o4-mini"` style. An unquoted `opus-4-7:` is a syntax error.
- **No date suffix.** Use the bare `claude-opus-4-8`, not a dated snapshot id.
- **Do NOT change the full-id passthrough tests.** `resolveProviderModel("claude-opus-4-7")` and `resolveModel("claude-opus-4-7")` must STILL return `claude-opus-4-7` (they hit the default-anthropic branch, not the new shorthand). Changing them is a C3 failure.
- **Do NOT touch the SDK or adapter** (`src/providers/anthropic.ts`, `@anthropic-ai/sdk`) — explicit non-goal; principle "No SDK lock-in".
- **Do NOT edit defaults.ts / schema.ts / init.ts.** Roles already reference the `"opus"` shorthand; repointing the map propagates 4.8 automatically. Editing them violates the stopCondition (only the 2 resolver files may change). `ModelChoiceSchema` is `z.string()` so no enum needs the new alias.
- **Baseline flaky tests are expected.** Do not chase the 2 "registers exactly 37 tools" timeout failures — they pre-exist this branch and are the only tolerated `npm run test` failures.
- **Build output matters.** C4 requires `npm run build` exit 0 so the npm-linked cockpit gets an updated `dist`; don't skip it.
- **Commit message:** `bober(sprint-1): repoint opus shorthand to claude-opus-4-8 + pin opus-4-7`.
