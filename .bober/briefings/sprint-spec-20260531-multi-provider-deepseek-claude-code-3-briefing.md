# Sprint Briefing: openai optional-peer preflight warning and missing-package error

**Contract:** sprint-spec-20260531-multi-provider-deepseek-claude-code-3
**Generated:** 2026-05-31T00:00:00Z

---

## 1. Target Files

### src/providers/openai.ts (modify — NO behavior change; verify only)

The EXISTING call-time missing-package error already satisfies sc-3-1's production
code. Do NOT change its wording (nonGoal at contract line 49). Verify it with a test.

**Relevant section — `getClient()` dynamic import + error, lines 266-301:**
```ts
private async getClient(): Promise<OAIClientLike> {
  if (this.client) {
    return this.client;
  }

  let OpenAI: new (opts: { apiKey?: string; baseURL?: string }) => OAIClientLike;

  try {
    // Construct the specifier at runtime so TypeScript does not attempt
    // to statically resolve the optional peer dependency at compile time.
    const specifier = "openai";
    const mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
    OpenAI = (mod["default"] ?? mod) as typeof OpenAI;
  } catch {
    throw new Error(
      'OpenAI provider requires the "openai" package. Run: npm install openai',
    );
  }
  // ... constructs `new OpenAI({ apiKey, ...baseURL })`
}
```

**EXACT error wording (openai.ts:284-286) — quote verbatim in the sc-3-1 test:**
```
OpenAI provider requires the "openai" package. Run: npm install openai
```
The catch swallows the original rejection (`catch {` with no binding) and always
re-throws this fixed message. The error fires lazily — only when `.chat()` is
first called (which calls `getClient()`).

**Note:** sc-3-1 is ALREADY covered by an existing test at
`src/providers/openai.test.ts:427-445` ("throws a helpful install error..."). The
Generator should KEEP that test and may add an equivalent test asserting the same
wording when `import("openai")` is mocked to reject. If the existing test fully
satisfies sc-3-1, openai.ts and openai.test.ts may need no further change — but
confirm the wording match. Do NOT edit openai.ts logic.

**Imports this file uses:** type-only from `./types.js` (LLMClient, ChatParams, etc.).
**Imported by:** `src/providers/factory.ts:2`, `src/providers/openai-compat.js` (extends OpenAIAdapter).
**Test file:** `src/providers/openai.test.ts` (exists).

---

### src/providers/openai.test.ts (modify — optional; sc-3-1 likely already met)

Existing missing-package test, lines 427-445 (this is the sc-3-1 template):
```ts
describe("OpenAIAdapter missing openai package", () => {
  it("throws a helpful install error when openai is not available", async () => {
    vi.doMock("openai", () => {
      throw new Error("Cannot find module 'openai'");
    });

    const { OpenAIAdapter } = await import("./openai.js?v=missing-" + Date.now());
    const adapter = new OpenAIAdapter("gpt-4.1");

    await expect(
      adapter.chat({
        model: "gpt-4.1",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow('OpenAI provider requires the "openai" package. Run: npm install openai');
  });
});
```
The `?v=...` cache-busting query string on the dynamic import is REQUIRED so the
re-import picks up the fresh `vi.doMock` (see Pattern: Mockable dynamic import).

---

### src/providers/preflight.ts (create) — the main deliverable

**Directory pattern:** `src/providers/` files are kebab-case, one adapter per file
(`anthropic.ts`, `openai.ts`, `openai-compat.ts`, `google.ts`, `factory.ts`,
`types.ts`). Named exports, NodeNext ESM with `.js` import extensions.

**Most similar existing file for structure:** `src/providers/factory.ts` (named
function exports, imports `resolveProviderModel` from `../orchestrator/model-resolver.js`).

**Recommended design (TESTABLE — inject the importer so tests can mock present/absent):**
```ts
import { resolveProviderModel } from "../orchestrator/model-resolver.js";
import { logger } from "../utils/logger.js";
import type { BoberConfig } from "../config/schema.js";

/** Providers that require the optional `openai` peer package. */
const OPENAI_FAMILY = new Set(["openai", "openai-compat"]);

/** The actionable hint string. MUST contain 'npm install openai'. */
export const OPENAI_PEER_HINT =
  'A configured role uses an OpenAI-family provider (openai/openai-compat/DeepSeek), ' +
  'but the optional "openai" package is not installed. Run: npm install openai';

/**
 * Injectable importer so tests can simulate openai present/absent without
 * touching the real module graph. Mirrors the getClient() pattern in openai.ts.
 */
export type OpenaiImporter = () => Promise<unknown>;

const defaultImporter: OpenaiImporter = () => {
  const specifier = "openai";
  return import(/* @vite-ignore */ specifier);
};

/** Returns true if any configured role resolves to an openai-family provider. */
export function usesOpenaiFamily(config: Partial<BoberConfig>): boolean {
  const sections = [
    config.planner, config.curator, config.generator,
    config.evaluator, config.codeReview,
    // researcher: no dedicated section — see Pitfalls. Reuse planner/curator.
  ];
  for (const section of sections) {
    if (!section?.model) continue;
    const { provider } = resolveProviderModel(section.model, section.provider);
    if (OPENAI_FAMILY.has(provider)) return true;
  }
  return false;
}

/**
 * Preflight: if an openai-family provider is configured but the openai package
 * is absent, return the install hint. Otherwise return null. Pure (no logging)
 * so it is trivially testable; the caller logs.
 *
 * @returns the hint string (contains 'npm install openai'), or null.
 */
export async function preflightOpenaiPeer(
  config: Partial<BoberConfig>,
  importer: OpenaiImporter = defaultImporter,
): Promise<string | null> {
  if (!usesOpenaiFamily(config)) return null;     // sc-3-4: anthropic-only => null
  try {
    await importer();                              // sc-3-3: present => no hint
    return null;
  } catch {
    logger.warn(OPENAI_PEER_HINT);                 // sc-3-2: absent => hint
    return OPENAI_PEER_HINT;
  }
}
```
**Why injectable importer:** `vi.doMock("openai", ...)` works in openai.test.ts
because the SUT re-imports `./openai.js?v=...` AFTER the mock. A standalone
preflight that imports openai directly cannot be re-mocked per-test cleanly.
Passing `importer` lets the test do `() => Promise.resolve({})` (installed) or
`() => Promise.reject(new Error("not found"))` (absent) with zero module-graph
juggling. The contract's sc-3-2/3-3 say "openai package mocked as installed/absent"
— an injected importer satisfies this and is the cleanest mockable seam.

---

### src/providers/factory.ts (modify — light/optional wiring)

Per generatorNotes, the preflight may live in factory.ts OR a new preflight.ts;
sc-3-2..3-4 test the FUNCTION directly, so heavy wiring is NOT required. If wiring
a call site, `createClient` (lines 129-223) is the natural one-time startup point,
but calling an async preflight from the synchronous `createClient` is awkward — DO
NOT make createClient async (it has 9 importers, see Impact). Prefer exporting the
preflight from preflight.ts and leaving call-site wiring minimal/none. Add the
provider-name list reference: `OPENAI_FAMILY` mirrors `ProviderName` at factory.ts:11.

---

## 2. Patterns to Follow

### Mockable dynamic import (the load-bearing pattern)
**Source:** `src/providers/openai.ts`, lines 276-287 (SUT) + `src/providers/openai.test.ts`, lines 77-88 (mock)
```ts
// In tests, mock BEFORE the dynamic import resolves, then re-import with cache-bust:
vi.doMock("openai", () => ({ default: makeFakeOpenAI(createFn) }));   // installed
// or
vi.doMock("openai", () => { throw new Error("Cannot find module 'openai'"); }); // absent
const { OpenAIAdapter } = await import("./openai.js?v=" + Date.now());
```
**Rule:** For preflight, prefer the injected-importer seam over vi.doMock — but the
sc-3-1 openai test MUST keep the vi.doMock + `?v=...` cache-bust pattern.

### resolveProviderModel call shape
**Source:** `src/orchestrator/model-resolver.ts`, lines 57-92
```ts
resolveProviderModel(model: string, explicitProvider?: string): ResolvedModel
// ResolvedModel = { provider: string; modelId: string; endpoint?: string }
```
**Rule:** Call per-role as `resolveProviderModel(section.model, section.provider)`.
DeepSeek shorthands (`deepseek`, `deepseek-v4-pro`, `deepseek-v4-flash`) map to
`provider: "openai-compat"` (model-resolver.ts:38-40, 79-86). `gpt-4.1`, `o3`,
`o4-mini` map to `provider: "openai"` (lines 30-33). Explicit `provider: "openai"`
or `"openai-compat"` in config passes through unchanged (lines 61-64).

### Named-export ESM module with .js extensions
**Source:** `src/providers/factory.ts`, lines 1-11
```ts
import { resolveProviderModel } from "../orchestrator/model-resolver.js";
export type ProviderName = "anthropic" | "openai" | "google" | "openai-compat";
export function validateApiKey(...): void { ... }
```
**Rule:** Relative imports end in `.js`; export functions/types by name; no default export.

### logger usage
**Source:** `src/utils/logger.ts`, lines 22-25, 87
```ts
import { logger } from "../utils/logger.js";
logger.warn("message");   // yellow "warn" prefix via console.warn
```
**Rule:** Use the singleton `logger.warn(...)` for the hint emission (it is a
WARNING/HINT, never `logger.error`, never a throw — nonGoal contract:47).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `resolveProviderModel` | `src/orchestrator/model-resolver.ts:57` | `(model, explicitProvider?) => { provider, modelId, endpoint? }` | Maps shorthand/provider to resolved provider — USE per role to detect openai-family |
| `resolveModel` | `src/orchestrator/model-resolver.ts:102` | `(choice) => string` | Deprecated; returns modelId only. Do NOT use for provider detection |
| `logger` (singleton) | `src/utils/logger.ts:87` | `Logger` instance | `.warn/.info/.error/.debug/.success` — emit hint via `.warn` |
| `Logger.warn` | `src/utils/logger.ts:23` | `(message, ...args) => void` | Yellow warning to console.warn |
| `createClient` | `src/providers/factory.ts:129` | `(provider?, endpoint?, providerConfig?, model?, role?) => LLMClient` | Builds adapter; candidate call site, keep synchronous |
| `validateApiKey` | `src/providers/factory.ts:47` | `(provider, role?, apiKey?, endpoint?) => void` | API-key env validation; pattern reference, not reused |
| `BoberConfig` / section types | `src/config/schema.ts:325, 91, 102, 113, 130, 141` | zod-inferred types | Type the preflight `config` param |

**Utilities reviewed:** `src/utils/` (logger only is relevant), `src/orchestrator/model-resolver.ts`, `src/providers/factory.ts`. No `lib/`, `helpers/`, `shared/`, `common/` dirs in src/.

---

## 4. Prior Sprint Output

### Sprint 2: DeepSeek shorthands + DEEPSEEK_API_KEY
**Modified:** `src/orchestrator/model-resolver.ts` — added `deepseek*` entries to
`SHORTHAND_MAP` (lines 38-40) resolving to `provider: "openai-compat"`, endpoint
`https://api.deepseek.com` (lines 79-86). **Confirmed: deepseek => openai-compat.**
**Modified:** `src/providers/factory.ts` — `validateApiKey` gained 4th `endpoint`
param (lines 47-52, 89-101); DEEPSEEK_API_KEY injection in openai-compat branch
(lines 208-216).
**Test harness added:** `src/providers/openai-compat.test.ts:28-42` — `makeFakeOpenAI`
+ `lastConstructorOptions` capturing the openai client constructor opts. Reusable
for any openai-import mocking, though preflight should prefer the injected importer.
**Connection:** The preflight's openai-family detection relies entirely on Sprint 2's
deepseek->openai-compat mapping. sc-3-2 must include a deepseek-shorthand case.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` checked into src scope for this sprint. Contract nonGoals
(lines 46-51) are the binding constraints: warning never hard-abort; no auto-install;
don't change existing error wording; don't add openai to package.json deps.

### Architecture Decisions
`.bober/architecture/` exists but no ADR specific to optional-peer preflight was
referenced by the contract. The dynamic-import optional-peer pattern is documented
inline at `src/providers/openai.ts:1-10`.

### Other Docs
Tech stack: TypeScript strict NodeNext ESM, Vitest. `import("openai")` is an
OPTIONAL peer — the package is NOT in node_modules (that's the whole point).

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/providers/openai.test.ts:15`, `:74-88`, `:427-445`
```ts
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

describe("preflightOpenaiPeer", () => {
  it("sc-3-2: returns hint for deepseek role when openai absent", async () => {
    const config = { generator: { model: "deepseek-v4-pro" } } as Partial<BoberConfig>;
    const hint = await preflightOpenaiPeer(config, () => Promise.reject(new Error("nope")));
    expect(hint).toContain("npm install openai");
  });

  it("sc-3-3: returns null when openai present for same config", async () => {
    const config = { generator: { model: "deepseek-v4-pro" } } as Partial<BoberConfig>;
    const hint = await preflightOpenaiPeer(config, () => Promise.resolve({ default: class {} }));
    expect(hint).toBeNull();
  });

  it("sc-3-4: returns null for anthropic-only config even when openai absent", async () => {
    const config = {
      planner: { model: "opus" }, generator: { model: "sonnet" },
      evaluator: { model: "sonnet" },
    } as Partial<BoberConfig>;
    const hint = await preflightOpenaiPeer(config, () => Promise.reject(new Error("nope")));
    expect(hint).toBeNull();
  });

  it("sc-3-2: also covers explicit openai provider + gpt model", async () => {
    const config = { generator: { model: "gpt-4.1" } } as Partial<BoberConfig>;
    const hint = await preflightOpenaiPeer(config, () => Promise.reject(new Error("x")));
    expect(hint).toContain("npm install openai");
  });
});
```
**Runner:** vitest. **Assertion style:** `expect(...).toContain / .toBeNull / .rejects.toThrow`.
**Mock approach:** Injected importer fn for preflight; `vi.doMock("openai", ...)` +
`await import("./openai.js?v=" + Date.now())` for the openai adapter test.
**File naming:** co-located `*.test.ts`. **Location:** co-located in `src/providers/`.

### E2E Test Pattern
Not applicable — this is a unit-test-only sprint (sc-3-1..3-4 are unit-test, sc-3-5 is build/lint).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/providers/factory.ts` | `openai.ts` (import line 2), `model-resolver.ts` | low | Only touched if wiring preflight; keep `createClient` SYNC |
| 9 orchestrator agents + `src/index.ts` | `factory.ts createClient` | medium | If createClient signature/sync-ness changes they break — DO NOT change it |
| `src/providers/openai-compat.ts` | extends `OpenAIAdapter` | low | Inherits getClient error; unchanged |
| `src/providers/openai-compat.test.ts` | `factory.createClient`, openai mock | low | Must still pass; shares the openai mock pattern |

(createClient importers: src/index.ts, src/discovery/synthesizer.ts, and orchestrator/{evaluator,architect,code-reviewer,generator,research,planner,curator}-agent.ts — grep confirmed.)

### Existing Tests That Must Still Pass
- `src/providers/openai.test.ts` — covers OpenAIAdapter incl. the missing-package error (sc-3-1 already there at :427-445). Verify the new test (if added) does not collide with the existing describe block; both can coexist.
- `src/providers/openai-compat.test.ts` — covers compat adapter + DeepSeek key injection (sc-2-5); shares openai mock; must still pass.

### Features That Could Be Affected
- **feat-4 (this sprint)** — owns preflight + missing-package verification.
- **DeepSeek resolution (Sprint 2)** — shares `model-resolver.ts`; verify deepseek still resolves to openai-compat (read-only use here, low risk).

### Recommended Regression Checks
1. `npm test` (vitest) — all provider tests green, new preflight tests pass.
2. `npm run build` — exits 0 (sc-3-5).
3. `npm run lint` — exits 0 (sc-3-5); watch for `@typescript-eslint` unused-import / floating-promise rules on the async preflight.
4. Confirm `createClient` remains synchronous (no `async` added) so its 9 importers are unaffected.

---

## 8. Implementation Sequence

1. **src/providers/preflight.ts** — create. Define `OPENAI_FAMILY` set, `OPENAI_PEER_HINT` const (must contain `npm install openai`), `OpenaiImporter` type + `defaultImporter`, `usesOpenaiFamily(config)`, and `async preflightOpenaiPeer(config, importer?)`. Import `resolveProviderModel` (`../orchestrator/model-resolver.js`), `logger` (`../utils/logger.js`), `BoberConfig` type (`../config/schema.js`).
   - Verify: `npm run build` compiles; types resolve.
2. **src/providers/preflight.test.ts** — create. Add sc-3-2 (deepseek + openai absent => hint), sc-3-2 (gpt/openai provider variant), sc-3-3 (present => null), sc-3-4 (anthropic-only => null). Use the injected-importer mock.
   - Verify: `npm test` — preflight tests pass.
3. **src/providers/openai.test.ts** — verify/keep the sc-3-1 test at :427-445 asserting `'OpenAI provider requires the "openai" package. Run: npm install openai'`. Add an equivalent assertion only if the contract reviewer wants an explicit new test; otherwise this criterion is met.
   - Verify: `npm test` — openai tests pass.
4. **src/providers/factory.ts** — OPTIONAL minimal wiring only; do NOT make createClient async. Likely no change needed.
   - Verify: `npm test` of openai-compat.test.ts still green.
5. **Run full verification** — `npm run build`, `npm test`, `npm run lint` (all exit 0).

---

## 9. Pitfalls & Warnings

- **DO NOT change the openai.ts error wording** (nonGoal contract:49). The sc-3-1 test asserts the EXACT string `OpenAI provider requires the "openai" package. Run: npm install openai` (openai.ts:284-286). Quote it verbatim.
- **Hint, not error.** Use `logger.warn` + return a string; NEVER throw, NEVER `process.exit`. anthropic-only config must emit nothing (sc-3-4).
- **No `researcher` config section exists** in schema.ts. The role sections are: `planner`, `curator` (optional), `generator`, `evaluator`, `codeReview` (optional, camelCase — NOT `code-review`). See schema.ts:307-323. generatorNotes mentions "researcher" but there is no `researcher` section to scan; do not invent one. (`graph.preflightBudgets` has architect/researcherPhase2 keys but those are token budgets, unrelated.)
- **Each section's fields:** every role section has `.model: string` and optional `.provider?: string` (planner:83-90, generator:93-101, evaluator:104-112, curator:122-129, codeReview:132-140). Scan `section.model` + `section.provider` per role.
- **Don't make createClient async** — 9 importers depend on its synchronous signature (Impact §7). Keep the preflight a separate exported async function.
- **Injected importer over vi.doMock for preflight** — a standalone module that statically does `import("openai")` is painful to re-mock per test; the `importer` param makes sc-3-2/3-3 trivial. The contract's "mocked as installed/absent" is satisfied by passing a resolving/rejecting fn.
- **openai is NOT installed** in this repo (optional peer) — the real `defaultImporter` will genuinely reject; tests must always pass an explicit importer to avoid relying on environment state.
- **ESLint floating-promise / no-misused-promises** — `preflightOpenaiPeer` is async; if a call site invokes it, `await` or `void` it explicitly to satisfy lint (sc-3-5).
- **Config sections are optional** (`curator`, `codeReview` are `.optional()`; planner/generator/evaluator required). Use `config.planner?.model` style and skip undefined sections.
