# Sprint Briefing: DeepSeek shorthand resolution and API-key handling

**Contract:** sprint-spec-20260531-multi-provider-deepseek-claude-code-2
**Generated:** 2026-05-31T00:00:00Z

---

## 0. Goal Recap

Make `deepseek`, `deepseek-v4-pro`, `deepseek-v4-flash` resolve through the existing
`openai-compat` adapter pointed at `https://api.deepseek.com`. Add a `DEEPSEEK_API_KEY`
env fallback **scoped to the api.deepseek.com endpoint only**, and a DeepSeek-specific
missing-key error in `validateApiKey`. NO new adapter code — only resolution + key wiring.

Constant to reuse everywhere: `https://api.deepseek.com` (no trailing slash, no `/v1`).
The key-detection match string is `api.deepseek.com` (substring check on the resolved endpoint).

---

## 1. Target Files

### src/orchestrator/model-resolver.ts (modify)

**`SHORTHAND_MAP` (lines 22-37)** — entries carry only `{ provider, modelId }`, NO endpoint:
```ts
const SHORTHAND_MAP: Record<string, { provider: string; modelId: string }> = {
  // Anthropic
  opus: { provider: "anthropic", modelId: "claude-opus-4-8" },
  ...
  // Google
  "gemini-pro": { provider: "google", modelId: "gemini-2.5-pro" },
  "gemini-flash": { provider: "google", modelId: "gemini-2.5-flash" },
};
```

**`resolveProviderModel` ollama branch (lines 62-70)** — THIS is the endpoint-attach pattern to mirror:
```ts
  // 2. ollama/ prefix — local OpenAI-compatible server
  if (model.startsWith("ollama/")) {
    const modelId = model.slice("ollama/".length);
    return {
      provider: "openai-compat",
      modelId,
      endpoint: "http://localhost:11434/v1",
    };
  }
```

**Shorthand branch (lines 72-76)** — currently returns NO endpoint. This is where deepseek must
diverge: deepseek shorthands must return `provider: "openai-compat"` PLUS the endpoint.
```ts
  // 3. Known shorthand
  const mapped = SHORTHAND_MAP[model];
  if (mapped) {
    return { provider: mapped.provider, modelId: mapped.modelId };
  }
```

**`ResolvedModel` interface (lines 9-16)** — `endpoint?: string` is already optional; no type change needed.

**Recommended approach:** Add the three deepseek shorthands to `SHORTHAND_MAP` as
`{ provider: "openai-compat", modelId: "deepseek-v4-pro" | "deepseek-v4-flash" }`. Note `deepseek`
maps to modelId `deepseek-v4-pro` per sc-2-2. Then in the shorthand branch (lines 72-76), when the
mapped provider is `openai-compat`, attach `endpoint: "https://api.deepseek.com"`. Cleanest:
detect via the resolved provider, e.g.
```ts
  const mapped = SHORTHAND_MAP[model];
  if (mapped) {
    if (mapped.provider === "openai-compat") {
      return { provider: mapped.provider, modelId: mapped.modelId, endpoint: "https://api.deepseek.com" };
    }
    return { provider: mapped.provider, modelId: mapped.modelId };
  }
```
(Only deepseek entries use `openai-compat` in the map, so this is safe and keeps Ollama's separate path intact.)

**Imported by (non-test):** `src/providers/factory.ts:6`. Resolver has no other production importers of `resolveProviderModel` besides factory; `resolveModel` is used elsewhere but unchanged here.
**Test file:** `src/orchestrator/model-resolver.test.ts` (exists)

---

### src/providers/factory.ts (modify)

**`validateApiKey` openai-compat case (lines 87-89)** — currently a no-op:
```ts
    case "openai-compat":
      // API key is optional for Ollama and other local servers — skip validation.
      break;
```
PROBLEM: `validateApiKey` does NOT currently receive the endpoint, so it cannot tell deepseek
from ollama. Its signature (lines 46-50) is `(resolvedProvider, role?, apiKey?)`. You must thread
the endpoint into this case. Two viable options:

- **Option A (recommended):** add a 4th param `endpoint?: string` to `validateApiKey`, and in the
  `openai-compat` case check `if (endpoint?.includes("api.deepseek.com")) { ...throw... }`.
- **Option B:** keep the no-key behavior in `validateApiKey` and add the deepseek check inside the
  `createClient` openai-compat branch (after `resolvedEndpoint` is known). Less clean — sc-2-4
  explicitly says "validateApiKey throws", so prefer Option A.

**createClient call to validateApiKey (line 151)** — currently passes no endpoint:
```ts
  validateApiKey(resolvedProvider, role, apiKey);
```
But `resolvedEndpoint` is only computed LATER (lines 182-187) inside the openai-compat switch case.
You must resolve the endpoint BEFORE the validate call if using Option A. The endpoint resolution
logic to hoist/duplicate:
```ts
  const resolvedEndpoint =
    endpoint ??
    (!provider && model ? resolveProviderModel(model).endpoint : undefined) ??
    (typeof providerConfig?.["endpoint"] === "string" ? providerConfig["endpoint"] : undefined);
```
Pass that as the 4th arg: `validateApiKey(resolvedProvider, role, apiKey, resolvedEndpoint);`

**createClient openai-compat branch (lines 179-196)** — where the adapter is built and key flows:
```ts
    case "openai-compat": {
      const resolvedEndpoint =
        endpoint ??
        (!provider && model ? resolveProviderModel(model).endpoint : undefined) ??
        (typeof providerConfig?.["endpoint"] === "string" ? providerConfig["endpoint"] : undefined);
      if (!resolvedEndpoint) { throw new Error('OpenAI-compatible provider requires an endpoint...'); }
      return new OpenAICompatAdapter(resolvedEndpoint, resolvedModelId, apiKey);
    }
```
Note `apiKey` here (line 145-148) only comes from `providerConfig.apiKey`. For the DEEPSEEK_API_KEY
env fallback to reach the adapter constructor, you must inject it here when the endpoint is deepseek:
```ts
      const compatKey =
        apiKey ??
        (resolvedEndpoint.includes("api.deepseek.com") ? process.env["DEEPSEEK_API_KEY"] : undefined);
      return new OpenAICompatAdapter(resolvedEndpoint, resolvedModelId, compatKey);
```
This satisfies sc-2-5 (key reaches the mocked client). Do NOT add DEEPSEEK_API_KEY to non-deepseek
endpoints (nonGoal #3 — Ollama keeps no-key behavior).

**Imported by (createClient — additive change, signature unchanged):** `src/index.ts:180`,
`src/providers/index.ts:23`, plus 7 orchestrator agents: `discovery/synthesizer.ts:370`,
`orchestrator/{architect,code-reviewer,generator,evaluator,planner,curator,research}-agent.ts`.
If you add an OPTIONAL 4th param to `validateApiKey`, all existing call sites stay valid.
`validateApiKey` is also exported (src/index.ts:180) and called standalone in factory.test.ts.

**Test file:** `src/providers/factory.test.ts` (exists)

---

### src/providers/openai-compat.ts (modify — likely NO change needed)

**Constructor (lines 39-43)** — apiKey already flows through to OpenAIAdapter:
```ts
  constructor(endpoint: string, model: string, apiKey?: string) {
    super(model, apiKey ?? "not-needed", endpoint);
  }
```
The DEEPSEEK_API_KEY fallback is best placed in `factory.ts` (where endpoint is known and apiKey is
assembled), NOT here — this class has no access to the env fallback policy and is endpoint-agnostic.
Listed in estimatedFiles for completeness; you may leave it unchanged. If you instead choose to put
the fallback here, you'd need `endpoint.includes("api.deepseek.com")` before defaulting — but factory.ts is cleaner.

**Test file:** `src/providers/openai-compat.test.ts` (exists)

---

### src/providers/openai.ts (modify — likely NO change needed)

**`getClient()` key chain (lines 289-293)** — where the SDK key is finally resolved:
```ts
    const apiKey =
      this.apiKey ??
      (typeof this.providerConfig?.["apiKey"] === "string"
        ? this.providerConfig["apiKey"]
        : process.env["OPENAI_API_KEY"]);
```
**Dynamic import (lines 279-282):**
```ts
      const specifier = "openai";
      const mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
      OpenAI = (mod["default"] ?? mod) as typeof OpenAI;
```
The key already arrives via `this.apiKey` (set from the OpenAICompatAdapter constructor). Since the
fallback is injected in factory.ts BEFORE construction, `this.apiKey` will hold the DEEPSEEK_API_KEY
value and the chain works. NO change required here. Do NOT add DEEPSEEK_API_KEY to this generic
chain (it would leak the deepseek key into every openai-compat endpoint — nonGoal #3).

---

## 2. Patterns to Follow

### Endpoint attach on resolution (mirror this for deepseek)
**Source:** `src/orchestrator/model-resolver.ts`, lines 62-70 (shown in section 1).
**Rule:** Return `provider: "openai-compat"` together with a hardcoded `endpoint` string in the
ResolvedModel — exactly how ollama does it. For deepseek the endpoint is `https://api.deepseek.com`.

### Per-provider key validation switch
**Source:** `src/providers/factory.ts`, lines 53-93.
```ts
  switch (resolvedProvider) {
    case "anthropic": {
      const key = apiKey ?? process.env["ANTHROPIC_API_KEY"];
      if (!key) { throw new Error(`${roleLabel} is configured to use Anthropic but ANTHROPIC_API_KEY is not set. ...`); }
      break;
    }
    ...
    case "openai-compat":
      break;
  }
```
**Rule:** Follow the existing error-message style: `${roleLabel} is configured to use DeepSeek but
neither providerConfig.apiKey nor DEEPSEEK_API_KEY is set. Set the DEEPSEEK_API_KEY environment
variable and try again.` The message MUST contain the literal string `DEEPSEEK_API_KEY` (sc-2-4).

### Optional-param env fallback (mirror for compatKey)
**Source:** `src/providers/factory.ts`, lines 145-148 and 170 (`apiKey ?? process.env["OPENAI_API_KEY"]`).
**Rule:** Use `??` chains; never hardcode key values (nonGoal #2).

### Section comments + type imports
**Source:** principles.md — use `// ── Section ──` box headers and `import type { ... }`.
**Rule:** ESLint enforces `consistent-type-imports`; build/lint must exit 0 (sc-2-6).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `resolveProviderModel` | `src/orchestrator/model-resolver.ts:53` | `(model: string, explicitProvider?: string): ResolvedModel` | Maps shorthand -> {provider, modelId, endpoint?}. EXTEND this; do not fork. |
| `resolveModel` | `src/orchestrator/model-resolver.ts:90` | `(choice: string): string` | Backward-compat; returns only modelId. Leave unchanged. |
| `ResolvedModel` (interface) | `src/orchestrator/model-resolver.ts:9` | `{ provider; modelId; endpoint? }` | Return type — already has optional endpoint, no edit needed. |
| `createClient` | `src/providers/factory.ts:117` | `(provider?, endpoint?, providerConfig?, model?, role?): LLMClient` | Factory. Inject DEEPSEEK_API_KEY fallback in the openai-compat branch. |
| `validateApiKey` | `src/providers/factory.ts:46` | `(resolvedProvider: string, role?: string, apiKey?: string): void` | Per-provider key check. Add deepseek throw (and optionally an `endpoint?` 4th param). |
| `OpenAICompatAdapter` | `src/providers/openai-compat.ts:31` | `new (endpoint, model, apiKey?)` | Adapter — reuse as-is, no new adapter. |
| `OpenAIAdapter` | `src/providers/openai.ts:240` | `new (model, apiKey?, endpoint?, providerConfig?)` | Base adapter; key chain at getClient():289. No edit. |

Utilities reviewed: `src/utils/` (fs, git, logger — none applicable to model resolution / key wiring).

---

## 4. Prior Sprint Output

### Sprint 1: eslint peer-dep fix
**Created/changed:** package.json eslint pin (^10). No source API surface.
**Connection to this sprint:** Only relevance — `npm install` is clean and `npm run lint` (eslint src/) runs, which sc-2-6 requires to exit 0. No code dependency.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- ESM everywhere: all imports use `.js` extensions (NodeNext). Already in these files.
- Provider-agnostic: never leak SDK types outside adapters. Do the key wiring in factory.ts/resolver, not by importing `openai` types broadly.
- `import type { ... }` enforced by ESLint `consistent-type-imports`.
- Prefix unused params with `_`. Zero type errors + zero lint errors are hard gates.
- Section comments use `// ── Name ──` box headers.

### Architecture Decisions
`.bober/architecture/` contains ADRs for openhands fork and ide-desktop-shell — none relevant to provider/model resolution. No multi-provider ADR found.

### Other Docs
npm scripts: `build` = `tsc`, `lint` = `eslint src/`, `test` = `vitest`, `typecheck` = `tsc --noEmit`.

---

## 6. Testing Patterns

### Unit test pattern — resolver (plain, no mocks)
**Source:** `src/orchestrator/model-resolver.test.ts`, lines 81-97.
```ts
import { describe, it, expect } from "vitest";
import { resolveProviderModel } from "./model-resolver.js";

it("resolves ollama/llama3 to openai-compat with localhost endpoint", () => {
  expect(resolveProviderModel("ollama/llama3")).toEqual({
    provider: "openai-compat",
    modelId: "llama3",
    endpoint: "http://localhost:11434/v1",
  });
});
```
**New tests (sc-2-1/2/3):** assert `resolveProviderModel("deepseek-v4-pro")` toEqual
`{ provider: "openai-compat", modelId: "deepseek-v4-pro", endpoint: "https://api.deepseek.com" }`;
same for `"deepseek"` (modelId `deepseek-v4-pro`) and `"deepseek-v4-flash"` (modelId `deepseek-v4-flash`).
ALSO add a no-regression assert reusing the existing ollama and sonnet expectations.

### Unit test pattern — factory validateApiKey (env save/restore, no client mock)
**Source:** `src/providers/factory.test.ts`, lines 219-231 + 354-360.
```ts
it("throws when OPENAI_API_KEY is not set and no inline key provided", () => {
  const saved = process.env["OPENAI_API_KEY"];
  delete process.env["OPENAI_API_KEY"];
  try {
    expect(() => createClient("openai", null, undefined, "gpt-4.1")).toThrow(/OPENAI_API_KEY/);
  } finally {
    if (saved !== undefined) process.env["OPENAI_API_KEY"] = saved;
  }
});
```
**New test (sc-2-4):** delete `process.env["DEEPSEEK_API_KEY"]` (save/restore), call
`createClient(null, null, undefined, "deepseek-v4-pro")` and expect `.toThrow(/DEEPSEEK_API_KEY/)`.
ALWAYS save+restore env in `try/finally` exactly like the example.

### Unit test pattern — openai client MOCK (for key-present, sc-2-5)
**Source:** `src/providers/openai-compat.test.ts`, lines 27-92. This is the canonical mock pattern.
```ts
let lastConstructorOptions: ConstructorOptions = {};
function makeFakeOpenAI(createFn: FakeCreateFn) {
  return class FakeOpenAI {
    chat = { completions: { create: createFn } };
    constructor(opts: ConstructorOptions) { lastConstructorOptions = opts; }
  };
}

beforeEach(() => {
  createFn = vi.fn();
  lastConstructorOptions = {};
  vi.doMock("openai", () => ({ default: makeFakeOpenAI(createFn) }));
});

async function makeAdapter(opts = {}) {
  const { OpenAICompatAdapter } = await import("./openai-compat.js?v=" + Date.now());
  return new OpenAICompatAdapter(opts.endpoint ?? "...", opts.model ?? "llama3", opts.apiKey);
}
```
And the constructor-arg assertion (lines 122-136):
```ts
it("uses the provided apiKey when one is given", async () => {
  createFn.mockResolvedValue(makeOAIResponse({ content: "hello" }));
  const adapter = await makeAdapter({ endpoint: "http://my-server/v1", apiKey: "my-secret-key" });
  await adapter.chat({ model: "llama3", system: "sys", messages: [{ role: "user", content: "hi" }] });
  expect(lastConstructorOptions.apiKey).toBe("my-secret-key");
});
```
**New test (sc-2-5):** The cleanest place is `factory.test.ts` since the DEEPSEEK_API_KEY injection
happens in `createClient`. BUT factory.test.ts does NOT currently mock the openai client — it only
asserts `instanceof OpenAICompatAdapter` and never calls `.chat()`, so the openai package is never
imported there. To assert the key REACHES the openai constructor you must call `.chat()`, which
requires the mock. Recommended: add the sc-2-5 test to **openai-compat.test.ts** (which already has
the `vi.doMock("openai")` + `lastConstructorOptions` harness): set `process.env["DEEPSEEK_API_KEY"]`,
construct the deepseek client via `createClient(null,null,undefined,"deepseek-v4-pro")` (import
createClient there) OR directly via the factory path, call `.chat(...)`, and assert
`lastConstructorOptions.apiKey` equals the env value. Use `vi.doMock` (NOT top-level `vi.mock`) and the
`?v=` + Date.now() dynamic-import cache-bust shown above so the mock applies.

**Runner:** vitest. **Assertion:** `expect`. **Mock:** `vi.doMock("openai", ...)` + dynamic import cache-bust for openai-compat; `vi.mock("./anthropic.js", ...)` hoisted style in factory.test.ts. **File naming:** `*.test.ts` collocated next to source. **Location:** co-located.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/providers/factory.ts` (createClient) callers: `discovery/synthesizer.ts`, `orchestrator/{architect,code-reviewer,generator,evaluator,planner,curator,research}-agent.ts` | createClient signature | low | Change is additive; createClient signature unchanged. Hoisting endpoint resolution before validateApiKey must not alter behavior for non-deepseek providers. |
| `src/index.ts:180`, `src/providers/index.ts:23` | re-export createClient/validateApiKey | low | If you add a 4th OPTIONAL param to validateApiKey, re-exports stay valid; do not make it required. |
| `src/orchestrator/model-resolver.ts` shorthand branch | resolveProviderModel return shape | medium | Existing shorthands (anthropic/openai/google) must STILL return no endpoint. Only openai-compat-provider entries get the endpoint. |

### Existing Tests That Must Still Pass
- `src/orchestrator/model-resolver.test.ts` — all anthropic/openai/google/ollama/explicit/unknown cases (lines 4-148). The new deepseek logic must not add an `endpoint` to non-deepseek `toEqual` expectations (they assert exact object equality, so a stray endpoint key would FAIL them).
- `src/providers/factory.test.ts` — openai-compat tests at lines 94-130 and 287-298 assert "no key required". For NON-deepseek endpoints (ollama, http://my-server/v1) validateApiKey must still no-op. Verify line 354-360 `validateApiKey("openai-compat")` (no endpoint) does NOT throw.
- `src/providers/openai-compat.test.ts` — lines 109-119 assert default `"not-needed"` apiKey for non-deepseek endpoints. Your factory change is upstream of the adapter, so this stays green only if you do NOT alter the adapter's default.

### Features That Could Be Affected
- **Ollama (openai-compat) resolution** — shares `resolveProviderModel` + the openai-compat branch + validateApiKey. Verify ollama still has NO endpoint in the SHORTHAND_MAP path (it uses the `ollama/` prefix branch), still gets `not-needed` key, and validateApiKey still no-ops for ollama.
- **Anthropic resolution** (sonnet) — shares resolveProviderModel; must be unchanged (sc-2-3).

### Recommended Regression Checks
1. `npm test` — all of model-resolver.test.ts, factory.test.ts, openai-compat.test.ts pass (including new deepseek tests).
2. `npm run build` exits 0 (sc-2-6).
3. `npm run lint` exits 0 (sc-2-6) — watch `consistent-type-imports` and unused-var rules.
4. Manually confirm no real network call: openai client is mocked via `vi.doMock` in the sc-2-5 test.

---

## 8. Implementation Sequence

1. **src/orchestrator/model-resolver.ts** — Add `deepseek`, `deepseek-v4-pro`, `deepseek-v4-flash`
   to SHORTHAND_MAP as `{ provider: "openai-compat", modelId: ... }`; in the shorthand branch attach
   `endpoint: "https://api.deepseek.com"` when `mapped.provider === "openai-compat"`.
   - Verify: by inspection, anthropic/openai/google entries still return no endpoint.
2. **src/orchestrator/model-resolver.test.ts** — Add sc-2-1/2/3 tests (3 deepseek + ollama + sonnet no-regression).
   - Verify: `npm test src/orchestrator/model-resolver.test.ts` passes.
3. **src/providers/factory.ts (validateApiKey)** — Add optional `endpoint?` 4th param; in the
   openai-compat case throw DeepSeek-specific error (message contains `DEEPSEEK_API_KEY`) when
   `endpoint?.includes("api.deepseek.com")` and no `apiKey` and no `process.env["DEEPSEEK_API_KEY"]`.
   - Verify: existing `validateApiKey("openai-compat")` (no endpoint) still no-ops.
4. **src/providers/factory.ts (createClient)** — Hoist `resolvedEndpoint` resolution before the
   `validateApiKey(...)` call (line 151) and pass it as the 4th arg. In the openai-compat branch
   build `compatKey = apiKey ?? (resolvedEndpoint.includes("api.deepseek.com") ? process.env["DEEPSEEK_API_KEY"] : undefined)`
   and pass `compatKey` to `new OpenAICompatAdapter(...)`.
   - Verify: ollama path still gets `not-needed`; deepseek key injected only for api.deepseek.com.
5. **src/providers/factory.test.ts** — Add sc-2-4 test (deepseek key-missing throws /DEEPSEEK_API_KEY/, env save/restore).
   - Verify: `npm test src/providers/factory.test.ts` passes.
6. **src/providers/openai-compat.test.ts** — Add sc-2-5 test using the existing `vi.doMock("openai")`
   + `lastConstructorOptions` harness: set DEEPSEEK_API_KEY env, drive a deepseek client, call `.chat()`,
   assert `lastConstructorOptions.apiKey === <env value>`. Restore env in finally.
   - Verify: `npm test src/providers/openai-compat.test.ts` passes; no network call.
7. **Full verification** — `npm test`, then `npm run build`, then `npm run lint` (all exit 0). openai-compat.ts and openai.ts likely need NO edits.

---

## 9. Pitfalls & Warnings

- **`toEqual` is exact:** Adding an `endpoint` to non-deepseek shorthand returns will break existing
  model-resolver.test.ts assertions (lines 4-79, 99-128). Only openai-compat entries get the endpoint.
- **validateApiKey has no endpoint today:** It cannot distinguish deepseek from ollama without the
  endpoint. Thread it in (optional 4th param) — keep the param OPTIONAL so re-exports and the
  standalone `validateApiKey("openai-compat")` test (line 354) stay valid.
- **Endpoint computed late in createClient:** `resolvedEndpoint` lives inside the openai-compat
  switch case (lines 182-187) but the `validateApiKey` call is at line 151 (before the switch). You
  must hoist/duplicate the endpoint resolution above line 151 if validateApiKey needs it.
- **Don't leak the key globally:** Adding DEEPSEEK_API_KEY to `openai.ts` getClient (line 289) or to
  the generic openai-compat path would apply it to ALL openai-compat endpoints — violates nonGoal #3.
  Gate strictly on `endpoint.includes("api.deepseek.com")`.
- **factory.test.ts never imports the openai package:** its openai-compat tests only check `instanceof`
  and never call `.chat()`. The key-PRESENT sc-2-5 assertion needs `.chat()` + the openai mock, which
  lives in openai-compat.test.ts. Put sc-2-5 there, not in factory.test.ts.
- **Endpoint string exactness:** use `https://api.deepseek.com` (no `/v1`, no trailing slash). The
  success criteria (sc-2-1/2/2/3) assert this exact string.
- **No hardcoded keys** (nonGoal #2) and **don't add `openai` as a hard dependency** (nonGoal #4) —
  keep the dynamic `import("openai")` and the optional-peer pattern intact.
- **Don't map** `deepseek-reasoner` / `deepseek-chat` (nonGoal #1, deprecating 2026-07-24).
- **ESM `.js` import extensions** are mandatory; `import type` for type-only imports (lint gate).
