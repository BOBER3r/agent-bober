# Sprint Briefing: Grok/xAI provider wiring

**Contract:** sprint-spec-20260618-fleet-tier-provider-routing-1
**Generated:** 2026-06-18T00:00:00Z

---

## TL;DR for the Generator

You are mirroring the **existing DeepSeek wiring** for xAI/Grok at exactly **two source files** (+ their collocated tests):

1. `src/orchestrator/model-resolver.ts` — add `grok*` entries to `SHORTHAND_MAP` and make the openai-compat endpoint-attach branch select `https://api.x.ai/v1` for grok ids (vs `https://api.deepseek.com` for deepseek).
2. `src/providers/factory.ts` — add `export function isXaiEndpoint(endpoint?: string): boolean` (the ONLY place `api.x.ai` is matched), then add a parallel xAI arm in `validateApiKey` (require `XAI_API_KEY`) and in `createClient` (inject `XAI_API_KEY`).

**DO NOT:** add a `ProviderName` value, add a new adapter class, touch `OpenAICompatAdapter`, touch `src/fleet/index.ts`, or change DeepSeek/Ollama behavior. `ProviderName` at `factory.ts:13` MUST stay `"anthropic" | "openai" | "google" | "openai-compat" | "claude-code"` exactly.

---

## 1. Target Files

### src/orchestrator/model-resolver.ts (modify)

**`SHORTHAND_MAP` — lines 22-41 (DeepSeek block to mirror is lines 37-40):**
```ts
const SHORTHAND_MAP: Record<string, { provider: string; modelId: string }> = {
  // ...
  // DeepSeek — resolved via openai-compat adapter at api.deepseek.com
  deepseek: { provider: "openai-compat", modelId: "deepseek-v4-pro" },
  "deepseek-v4-pro": { provider: "openai-compat", modelId: "deepseek-v4-pro" },
  "deepseek-v4-flash": { provider: "openai-compat", modelId: "deepseek-v4-flash" },
};
```
**Add a parallel Grok block (after the DeepSeek entries, inside the same object):**
```ts
  // Grok / xAI — resolved via openai-compat adapter at api.x.ai/v1
  grok: { provider: "openai-compat", modelId: "grok-4" },
  "grok-4": { provider: "openai-compat", modelId: "grok-4" },
  "grok-4-fast": { provider: "openai-compat", modelId: "grok-4-fast" },
```

**`resolveProviderModel` openai-compat endpoint-attach branch — lines 76-88 (THE branch that hardcodes the deepseek endpoint):**
```ts
  // 3. Known shorthand
  const mapped = SHORTHAND_MAP[model];
  if (mapped) {
    if (mapped.provider === "openai-compat") {
      // openai-compat shorthands (e.g. deepseek) need an endpoint attached.
      return {
        provider: mapped.provider,
        modelId: mapped.modelId,
        endpoint: "https://api.deepseek.com",   // <-- HARDCODED today; must become a selector
      };
    }
    return { provider: mapped.provider, modelId: mapped.modelId };
  }
```
**Required change:** the `endpoint:` value must branch on the resolved `modelId` (or the shorthand key `model`). A grok id → `"https://api.x.ai/v1"`, else `"https://api.deepseek.com"`. Keyed on the modelId is cleanest because the shorthand key (`grok`) and the modelId (`grok-4`) both start with `grok`. Example:
```ts
    if (mapped.provider === "openai-compat") {
      const endpoint = mapped.modelId.startsWith("grok")
        ? "https://api.x.ai/v1"
        : "https://api.deepseek.com";
      return { provider: mapped.provider, modelId: mapped.modelId, endpoint };
    }
```
**Important:** the `ollama/` prefix path (lines 66-74) returns its own endpoint EARLIER (`http://localhost:11434/v1`) and never reaches this branch — do not touch it.

**Imports this file uses:** none (pure module, no imports).
**Imported by:** `src/providers/factory.ts:8` (`import { resolveProviderModel } from "../orchestrator/model-resolver.js"`). Also widely imported across the codebase (see Impact Analysis).
**Test file:** `src/orchestrator/model-resolver.test.ts` — **exists** (196 lines).

---

### src/providers/factory.ts (modify)

**`ProviderName` union — line 13 (MUST NOT CHANGE — flag for sc-1-6):**
```ts
export type ProviderName = "anthropic" | "openai" | "google" | "openai-compat" | "claude-code";
```

**`validateApiKey` openai-compat case — lines 128-140 (the DeepSeek arm to mirror):**
```ts
    case "openai-compat":
      // API key is optional for Ollama and other local servers.
      // DeepSeek (api.deepseek.com) requires a key — check specifically for it.
      if (endpoint?.includes("api.deepseek.com")) {
        const key = apiKey ?? process.env["DEEPSEEK_API_KEY"];
        if (!key) {
          throw new Error(
            `${roleLabel} is configured to use DeepSeek but neither providerConfig.apiKey nor DEEPSEEK_API_KEY is set. ` +
              `Set the DEEPSEEK_API_KEY environment variable and try again.`,
          );
        }
      }
      break;
```
**Add the parallel xAI arm inside the same `case "openai-compat":` (before or after the deepseek `if`, both are independent `if`s — do NOT make it `else if`, they target different endpoints):**
```ts
      if (isXaiEndpoint(endpoint)) {
        const key = apiKey ?? process.env["XAI_API_KEY"];
        if (!key) {
          throw new Error(
            `${roleLabel} is configured to use Grok/xAI but XAI_API_KEY is not set. ` +
              `Set the XAI_API_KEY environment variable and try again.`,
          );
        }
      }
```
Note `roleLabel` is already in scope (`factory.ts:92`).

**`createClient` openai-compat case key-injection — lines 244-260 (the DEEPSEEK_API_KEY injection at 251-257):**
```ts
    case "openai-compat": {
      if (!resolvedEndpoint) {
        throw new Error(
          'OpenAI-compatible provider requires an endpoint. Set endpoint in provider config or use the "ollama/" model prefix.',
        );
      }

      // Inject DEEPSEEK_API_KEY env fallback only for the api.deepseek.com endpoint.
      // Ollama and other openai-compat endpoints keep the no-key (not-needed) behavior.
      const compatKey =
        apiKey ??
        (resolvedEndpoint.includes("api.deepseek.com")
          ? process.env["DEEPSEEK_API_KEY"]
          : undefined);

      return new OpenAICompatAdapter(resolvedEndpoint, resolvedModelId, compatKey);
    }
```
**Extend `compatKey` to add the xAI arm (the `OpenAICompatAdapter` ctor call stays byte-identical):**
```ts
      const compatKey =
        apiKey ??
        (isXaiEndpoint(resolvedEndpoint)
          ? process.env["XAI_API_KEY"]
          : resolvedEndpoint.includes("api.deepseek.com")
            ? process.env["DEEPSEEK_API_KEY"]
            : undefined);
```

**Add the single predicate (top-level export, after imports / near other helpers, e.g. right above `validateApiKey`):**
```ts
/**
 * True when the endpoint targets xAI's OpenAI-compatible Grok API.
 * SOLE place the "api.x.ai" host substring is matched (sc-1-6).
 */
export function isXaiEndpoint(endpoint?: string): boolean {
  return !!endpoint && endpoint.includes("api.x.ai");
}
```

**Imports this file uses (lines 1-8):** adapter classes from `./*.js`, `type { LLMClient, ChatParams, ChatResponse } from "./types.js"`, `execa`, `resolveProviderModel` from `../orchestrator/model-resolver.js`. You add NO new imports.
**Imported by:** `src/fleet/index.ts:19` (`validateApiKey`, `createClient`), and the broader pipeline (see Impact Analysis).
**Test file:** `src/providers/factory.test.ts` — **exists** (459 lines).

---

## 2. Patterns to Follow

### ESM `.js` import extensions
**Source:** `factory.ts`, lines 1-8 and `.bober/principles.md:27`
```ts
import { OpenAICompatAdapter } from "./openai-compat.js";
import type { LLMClient, ChatParams, ChatResponse } from "./types.js";
import { resolveProviderModel } from "../orchestrator/model-resolver.js";
```
**Rule:** Every relative import ends in `.js` (NodeNext). Type-only imports use `import type`.

### Unicode box-drawing section headers
**Source:** `factory.ts:15` and `model-resolver.test.ts:131`; `.bober/principles.md:32`
```ts
// ── Deterministic stub (BOBER_TEST_DETERMINISTIC) ─────────────────────────────
// ── DeepSeek shorthands (sc-2-1, sc-2-2) ────────────────────────────────────
```
**Rule:** Group new code under a `// ── Section Name ──` header (use the `──` box-drawing char). For the new tests, add headers like `// ── Grok/xAI shorthands (sc-1-3) ──`.

### Endpoint-discrimination via `.includes()` substring match
**Source:** `factory.ts:131` and `factory.ts:255`
```ts
if (endpoint?.includes("api.deepseek.com")) { ... }
resolvedEndpoint.includes("api.deepseek.com") ? ... : undefined
```
**Rule:** xAI follows the same idiom but the substring lives ONLY inside `isXaiEndpoint()` (sc-1-6) — call the predicate, never inline `"api.x.ai"` a second time. DeepSeek's inline match may stay as-is (refactoring it into `isDeepseekEndpoint()` is optional per generatorNotes, NOT required).

### Env-var fallback with explicit-key override
**Source:** `factory.ts:96`, `:106`, `:132`
```ts
const key = apiKey ?? process.env["ANTHROPIC_API_KEY"];
const key = apiKey ?? process.env["DEEPSEEK_API_KEY"];
```
**Rule:** `process.env` is indexed with bracket notation and a string literal (`process.env["XAI_API_KEY"]`), never dot access — required by the strict tsconfig.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `resolveProviderModel` | `src/orchestrator/model-resolver.ts:57` | `(model: string, explicitProvider?: string): ResolvedModel` | Maps a shorthand/model string to `{ provider, modelId, endpoint? }`. You EXTEND its SHORTHAND_MAP + endpoint branch; do not fork it. |
| `resolveModel` | `src/orchestrator/model-resolver.ts:102` | `(choice: string): string` | Backward-compat wrapper returning only modelId. Do not touch. |
| `validateApiKey` | `src/providers/factory.ts:86` | `(resolvedProvider, role?, apiKey?, endpoint?): void` | Throws if required key missing. You add the xAI arm inside its `openai-compat` case. |
| `createClient` | `src/providers/factory.ts:172` | `(provider?, endpoint?, providerConfig?, model?, role?): LLMClient` | Factory. You extend `compatKey` in its `openai-compat` case. |
| `OpenAICompatAdapter` | `src/providers/openai-compat.ts:31` | `constructor(endpoint: string, model: string, apiKey?: string)` | The adapter Grok rides on UNCHANGED. Its ctor already defaults a missing key to `"not-needed"` (line 42). Pass `(resolvedEndpoint, resolvedModelId, compatKey)` exactly as DeepSeek does. |
| `isDeepseekEndpoint` | (does NOT exist) | n/a | Today DeepSeek is matched inline at `factory.ts:131,255`. The mirror predicate `isXaiEndpoint` is what you CREATE. |
| `process.env["XAI_API_KEY"]` | n/a (env var) | n/a | NEW env var name to introduce. No existing reference (grep of `src/` returned nothing). Do not hardcode/commit any value. |

**Utilities reviewed:** searched `src/` for `api.x.ai`, `XAI_API_KEY`, `isXaiEndpoint`, `isDeepseekEndpoint` — **all absent** (clean greenfield for the xAI host string, which satisfies the sc-1-6 single-source invariant from the start). The DeepSeek wiring in `model-resolver.ts` + `factory.ts` is your only template.

---

## 4. Prior Sprint Output

No prior sprints in this spec (Sprint 1 of 3). The **DeepSeek wiring** you mirror was added in earlier (unrelated) provider work; it is the de-facto template, tagged in tests as `sc-2-*`:
- `src/orchestrator/model-resolver.ts:37-40` + `:79-85` — deepseek shorthand + endpoint attach.
- `src/providers/factory.ts:131-139` + `:251-257` — deepseek validate + inject.
- `src/orchestrator/model-resolver.test.ts:131-157` + `src/providers/factory.test.ts:342-366,426-454` — the deepseek tests you mirror line-for-line for grok/xAI.

**Connection to Sprints 2 & 3 (out of scope now):** Sprint 2 adds tier-by-difficulty routing (`FleetChild.tier`, `buildChildConfig`); Sprint 3 adds ToolRoleGuard. Do NOT pre-build either. This sprint changes zero fleet behavior.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere** (`:27`): `.js` import extensions, `"type":"module"`, no CommonJS.
- **Provider-agnostic interfaces / no SDK lock-in** (`:28`, `:41`): never import `openai`/`@anthropic-ai/sdk` outside their adapter files. Your changes are pure routing/config — they import NO SDK, so you are clean.
- **`import type`** (`:35`): `consistent-type-imports` is ESLint-enforced. You add no new imports, so nothing to convert.
- **Section comments** (`:32`): use `// ── … ──` headers.
- **Collocated tests** (`:20`): `*.test.ts` next to `*.ts`, Vitest. Both target test files already exist and are collocated.
- **Prefix unused params with `_`** (`:36`). **No `any`** (`:40`).

### Architecture Decisions
No `.bober/architecture/*.md` ADR pertains to provider routing for this sprint (the architecture dir holds fleet-expand-deep-critique ADRs, unrelated). The contract's `assumptions` already encode the only ADR-level fact you need: **xAI is OpenAI-wire-compatible at `https://api.x.ai/v1`, so `OpenAICompatAdapter` handles it unchanged** (contract assumptions[0], research:50).

### Other Docs
`README.md` / `CLAUDE.md` add no provider-routing guidance beyond principles.md. The contract `generatorNotes` is your authoritative recipe (it gives near-verbatim code).

---

## 6. Testing Patterns

### Unit Test Pattern — model-resolver
**Source:** `src/orchestrator/model-resolver.test.ts:131-157` (the DeepSeek block — mirror it for Grok)
```ts
import { describe, it, expect } from "vitest";
import { resolveProviderModel, resolveModel } from "./model-resolver.js";

describe("DeepSeek shorthands", () => {
  it("resolves deepseek-v4-pro to openai-compat at api.deepseek.com (sc-2-1)", () => {
    expect(resolveProviderModel("deepseek-v4-pro")).toEqual({
      provider: "openai-compat",
      modelId: "deepseek-v4-pro",
      endpoint: "https://api.deepseek.com",
    });
  });
});
```
**Mirror for Grok (sc-1-3):** assert `resolveProviderModel("grok")`, `("grok-4")`, `("grok-4-fast")` each `.toEqual({ provider: "openai-compat", modelId: <id>, endpoint: "https://api.x.ai/v1" })`. Also keep a no-regression assertion that `deepseek` still resolves to `api.deepseek.com` (the endpoint branch now has two arms).

### Unit Test Pattern — factory `validateApiKey` (env-stub via save/delete/restore)
**Source:** `src/providers/factory.test.ts:426-454` (DeepSeek validateApiKey throw/no-throw — mirror exactly)
```ts
it("throws with DEEPSEEK_API_KEY in message for openai-compat at api.deepseek.com when key absent", () => {
  const saved = process.env["DEEPSEEK_API_KEY"];
  delete process.env["DEEPSEEK_API_KEY"];
  try {
    expect(() =>
      validateApiKey("openai-compat", undefined, undefined, "https://api.deepseek.com"),
    ).toThrow(/DEEPSEEK_API_KEY/);
  } finally {
    if (saved !== undefined) process.env["DEEPSEEK_API_KEY"] = saved;
  }
});

it("does not throw for openai-compat at api.deepseek.com when DEEPSEEK_API_KEY is set", () => {
  const saved = process.env["DEEPSEEK_API_KEY"];
  process.env["DEEPSEEK_API_KEY"] = "sk-fake-deepseek-key";
  try {
    expect(() =>
      validateApiKey("openai-compat", undefined, undefined, "https://api.deepseek.com"),
    ).not.toThrow();
  } finally {
    if (saved !== undefined) process.env["DEEPSEEK_API_KEY"] = saved;
    else delete process.env["DEEPSEEK_API_KEY"];
  }
});
```
**Mirror for xAI (sc-1-4):**
- `validateApiKey("openai-compat", "generator", undefined, "https://api.x.ai/v1")` with `XAI_API_KEY` deleted → `.toThrow(/XAI_API_KEY/)` (the message also names "Grok/xAI").
- Same call with `XAI_API_KEY` set → `.not.toThrow()`.
- **Non-regression:** assert the existing deepseek throw still fires and a bare `validateApiKey("openai-compat")` (no endpoint, Ollama path) still does NOT throw — there is already a test for this at `factory.test.ts:422-424`, keep it green.

**Runner:** vitest. **Assertion style:** `expect(...).toThrow(/regex/)` / `.not.toThrow()` / `.toEqual({...})` / `.toBeInstanceOf(Class)`.
**Env stub:** the codebase uses **save → `delete process.env[...]` / assign → restore in `finally`** (NOT `vi.stubEnv`). Match this style for consistency with the surrounding tests. (`vi.stubEnv` is acceptable per generatorNotes but the existing file uses save/delete/restore — prefer it for a uniform file.)
**File naming / location:** collocated `factory.test.ts` next to `factory.ts`; `model-resolver.test.ts` next to `model-resolver.ts`.

### Unit Test Pattern — `createClient` key injection (sc-1-5)
**Source:** `src/providers/factory.test.ts:330-365` (openai-compat createClient — DeepSeek throw + Ollama no-key)
```ts
it("throws with DEEPSEEK_API_KEY in message when key is absent for deepseek endpoint", () => {
  const saved = process.env["DEEPSEEK_API_KEY"];
  delete process.env["DEEPSEEK_API_KEY"];
  try {
    expect(() => createClient(null, null, undefined, "deepseek-v4-pro")).toThrow(/DEEPSEEK_API_KEY/);
  } finally {
    if (saved !== undefined) process.env["DEEPSEEK_API_KEY"] = saved;
  }
});

it("does not throw for non-deepseek openai-compat endpoint when no key is set", () => {
  const client = createClient("openai-compat", "http://localhost:11434/v1", undefined, "llama3");
  expect(client).toBeInstanceOf(OpenAICompatAdapter);
});
```
**Mirror for xAI (sc-1-5):**
- `createClient(null, null, undefined, "grok")` with `XAI_API_KEY` unset → `.toThrow(/XAI_API_KEY/)` (validation fires before construction).
- With `XAI_API_KEY` set → `expect(client).toBeInstanceOf(OpenAICompatAdapter)` and `.not.toThrow()`.
- **Asserting the injected key precisely (optional, stronger):** the existing tests assert via `toBeInstanceOf(OpenAICompatAdapter)`, NOT via spying on the ctor (only `AnthropicAdapter` is mocked, at `factory.test.ts:41-58`). The lightest sc-1-5 satisfaction is: throws-without-key + constructs-with-key + Ollama-stays-no-key. If you want to assert the actual key value, follow the `AnthropicAdapter` ctor-recorder mock pattern (`factory.test.ts:41-58`, `:375-394`) by adding a `vi.mock("./openai-compat.js", ...)` recorder — but this is OPTIONAL; the no-throw + instanceof assertions are sufficient and lower-risk.

### Single-predicate invariant test (sc-1-6)
```ts
import { isXaiEndpoint } from "./factory.js";
it("isXaiEndpoint matches only api.x.ai hosts", () => {
  expect(isXaiEndpoint("https://api.x.ai/v1")).toBe(true);
  expect(isXaiEndpoint("https://api.deepseek.com")).toBe(false);
  expect(isXaiEndpoint(undefined)).toBe(false);
  expect(isXaiEndpoint("http://localhost:11434/v1")).toBe(false);
});
```
The grep-style "only place" assertion (sc-1-6) is verified by the evaluator's `grep 'api.x.ai'`; you guarantee it by never inlining the substring — only `isXaiEndpoint` contains it, and `model-resolver.ts` contains only the full URL `"https://api.x.ai/v1"` (a URL literal, not the bare `api.x.ai` host predicate). Confirm the evaluator's grep intent: `api.x.ai` will appear in (a) `isXaiEndpoint` body, (b) the `model-resolver.ts` endpoint string `https://api.x.ai/v1`, and (c) test assertions. The sc-1-6 invariant is about the **host-match predicate** being single-sourced — the URL literal in the resolver is the endpoint VALUE, not a host match, and is the legitimate sibling of `https://api.deepseek.com` already in the resolver. Keep the bare `.includes("api.x.ai")` substring match in exactly ONE function.

### E2E Test Pattern
Not applicable — this sprint touches pure routing/config functions. No Playwright/E2E. The 6 known `tests/e2e/cockpit-integration.test.ts` MCP "Connection closed" failures are PRE-EXISTING and unrelated (sc-1-2 explicitly allows only those).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/providers/factory.ts` | `model-resolver.ts` (imports `resolveProviderModel`) | low | New SHORTHAND_MAP entries are additive; the endpoint branch now returns `api.x.ai/v1` for grok ids but `api.deepseek.com` for all prior openai-compat shorthands — verify deepseek + ollama unchanged. |
| `src/fleet/index.ts:19,67` | `factory.ts` (`validateApiKey`, `createClient`) | low | `validateManifestCredentials` (`:46-70`) passes `s.endpoint` into `validateApiKey` per role — the new xAI arm makes Grok recognized with ZERO edits. Do NOT edit this file (nonGoal). Verify no fleet test asserts "xAI unsupported". |
| `src/fleet/index.ts:180,305` | `factory.ts` (deepseek preflight) | low | These hardcode `"https://api.deepseek.com"` for the deepseek smoke path — untouched, must stay green. |
| Pipeline / config consumers of `resolveProviderModel` | `model-resolver.ts` | low | Additive shorthands only; existing keys unchanged. `grep -rn "resolveProviderModel" src` to confirm callers only consume `{provider, modelId, endpoint}`. |

### Existing Tests That Must Still Pass
- `src/orchestrator/model-resolver.test.ts` — all 196 lines; especially the DeepSeek (`:131-157`), ollama (`:81-97`), and "no-regression" (`:161-176`) blocks. Your endpoint-selector change must not break `deepseek → api.deepseek.com`.
- `src/providers/factory.test.ts` — all 459 lines; especially openai-compat DeepSeek/Ollama (`:330-366`) and standalone `validateApiKey` (`:399-459`). The bare-Ollama no-key tests (`:331-340`, `:356-365`, `:422-424`) must stay green.
- `src/fleet/*.test.ts` — fleet credential/manifest tests. Run them; the xAI arm must not throw for existing non-xAI manifests. `grep -rln "validateManifestCredentials\|validateApiKey" src/fleet`.

### Features That Could Be Affected
- **Fleet credential pre-check** — shares `validateApiKey`. Verify an existing deepseek/anthropic manifest still validates and a hypothetical grok child (endpoint `https://api.x.ai/v1`) now passes when `XAI_API_KEY` is set. Do NOT add fleet tests that require editing `index.ts`.
- **DeepSeek + Ollama providers** — share the `openai-compat` case in both functions. Their behavior MUST be byte-identical (nonGoal). The endpoint branch and `compatKey` ternary are the only touched lines — keep deepseek's arm and the `undefined` Ollama fallback intact.

### Recommended Regression Checks (run after implementation)
1. `npm run build` — zero TS errors.
2. `npm run typecheck` — zero strict errors.
3. `npm run lint` — zero ESLint errors (watch `consistent-type-imports`, bracket env access, no unused vars).
4. `npx vitest run src/orchestrator/model-resolver.test.ts src/providers/factory.test.ts` — all green (fast inner loop).
5. `npx vitest run src/fleet` — fleet suite green (proves the free fleet recognition + no regression).
6. `npm run test` (full suite) — only the 6 known `cockpit-integration` MCP failures allowed (sc-1-2).
7. `grep -rn "api.x.ai" src/` — the bare host-match substring `.includes("api.x.ai")` appears ONLY in `isXaiEndpoint`; the full URL `https://api.x.ai/v1` appears in `model-resolver.ts` (endpoint value) + tests. Confirm `ProviderName` at `factory.ts:13` is unchanged.

---

## 8. Implementation Sequence

1. **`src/providers/factory.ts` — add `isXaiEndpoint`** (top-level export, near `validateApiKey` ~line 85, under a `// ── xAI / Grok endpoint predicate ──` header).
   - Verify: `npm run typecheck` passes; function is exported.
2. **`src/providers/factory.ts` — `validateApiKey` xAI arm** (inside `case "openai-compat":` ~line 128, an independent `if (isXaiEndpoint(endpoint)) { ... }`, message names "Grok/xAI" + `XAI_API_KEY`).
   - Verify: deepseek `if` is untouched; both `if`s coexist (not `else if`).
3. **`src/providers/factory.ts` — `createClient` `compatKey` xAI arm** (~line 253, extend the ternary so `isXaiEndpoint(resolvedEndpoint)` → `process.env["XAI_API_KEY"]`, else the deepseek branch, else `undefined`). `OpenAICompatAdapter(...)` ctor call unchanged.
   - Verify: `npm run build` clean.
4. **`src/orchestrator/model-resolver.ts` — add grok entries to `SHORTHAND_MAP`** (`grok`, `grok-4`, `grok-4-fast` → `{ provider: "openai-compat", modelId }`).
   - Verify: typecheck clean.
5. **`src/orchestrator/model-resolver.ts` — endpoint selector** (in the `mapped.provider === "openai-compat"` branch ~line 79, branch endpoint on `mapped.modelId.startsWith("grok")` → `api.x.ai/v1`, else `api.deepseek.com`).
   - Verify: `resolveProviderModel("grok")` returns `api.x.ai/v1`; `resolveProviderModel("deepseek")` still returns `api.deepseek.com`.
6. **`src/orchestrator/model-resolver.test.ts` — Grok shorthand tests** (mirror the DeepSeek block at `:131-157`; assert provider/modelId/endpoint for `grok`, `grok-4`, `grok-4-fast`; keep a deepseek no-regression assert).
   - Verify: `npx vitest run src/orchestrator/model-resolver.test.ts` green.
7. **`src/providers/factory.test.ts` — xAI tests** (mirror DeepSeek validateApiKey throw/no-throw at `:426-454`; mirror createClient throw/instanceof at `:343-365`; add the `isXaiEndpoint` predicate test; keep Ollama/DeepSeek non-regression asserts).
   - Verify: `npx vitest run src/providers/factory.test.ts` green.
8. **Run full verification** — `npm run build` && `npm run typecheck` && `npm run lint` && `npm run test` (only the 6 cockpit-integration MCP failures allowed), then the `grep -rn "api.x.ai" src/` single-source + `ProviderName` unchanged checks.

---

## 9. Pitfalls & Warnings

- **`ProviderName` (factory.ts:13) MUST NOT CHANGE.** Grok is `"openai-compat"`. Adding a literal to the union is an explicit nonGoal and breaks sc-1-6.
- **Do NOT touch `OpenAICompatAdapter`** (`openai-compat.ts:31-44`). Its ctor signature `(endpoint, model, apiKey?)` is unchanged; it already defaults a missing key to `"not-needed"` (line 42), so passing `compatKey` exactly like DeepSeek works.
- **Do NOT edit `src/fleet/index.ts`.** `validateManifestCredentials` (`:46-70`) already forwards `s.endpoint` to `validateApiKey` — the new xAI arm makes Grok recognized "for free". Editing the loop is an explicit nonGoal.
- **The two `openai-compat` `if`s are independent, not `else if`.** An endpoint is either `api.deepseek.com` or `api.x.ai` or neither — chaining them with `else if` is fine logically, but keep the deepseek `if` byte-identical to avoid regressions; safest is a separate `if (isXaiEndpoint(endpoint)) { ... }`.
- **Bracket-notation env access only:** `process.env["XAI_API_KEY"]` — dot access fails strict tsconfig (`process.env.XAI_API_KEY` errors under `noUncheckedIndexedAccess`/index signature rules). Mirror `factory.ts:96,132`.
- **`api.x.ai` host substring appears in exactly ONE predicate.** Inlining `.includes("api.x.ai")` a second time fails sc-1-6. The full URL `https://api.x.ai/v1` in `model-resolver.ts` is an endpoint VALUE (sibling of `https://api.deepseek.com`), not a host match — that is allowed.
- **Endpoint selector keys on grok, not "not deepseek".** Write `mapped.modelId.startsWith("grok") ? "https://api.x.ai/v1" : "https://api.deepseek.com"` so any future openai-compat shorthand still defaults to deepseek's slot unless explicitly grok. Do not invert the condition.
- **No `vi.stubEnv` already imported.** The file uses save/delete/restore. If you choose `vi.stubEnv`/`vi.unstubAllEnvs`, add it to the `vitest` import and call `vi.unstubAllEnvs()` in teardown — but matching the existing save/restore idiom is lower-risk.
- **Don't assert a live Grok model id.** Tests assert routing/endpoint/key only (contract assumptions[2]); `grok-4`/`grok-4-fast` are placeholders, overridable via `child.config.model`. No real API call.
- **Conventional commit:** `bober(sprint-1): Grok/xAI openai-compat wiring + isXaiEndpoint predicate` (principles.md:34).
