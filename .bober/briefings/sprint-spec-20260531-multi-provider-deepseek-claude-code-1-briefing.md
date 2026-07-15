# Sprint Briefing: Fix eslint peer-dependency conflict (unblocks install)

**Contract:** sprint-spec-20260531-multi-provider-deepseek-claude-code-1
**Generated:** 2026-05-31T14:10:00Z

---

## 0. TL;DR (read this first)

This is a one-line dependency bump. The root cause: `package.json` pins
`eslint@^9.19.0` (`package.json:92`) while `@eslint/js@^10.0.1` (`package.json:86`)
requires `eslint@^10.0.0` as a peer. On a clean tree this produces ERESOLVE.

**The fix:** set `devDependencies.eslint` to `"^10.0.0"` (resolves to `10.4.1`,
latest) and regenerate the lockfile. **No eslint.config.js change is required** —
the flat config in this repo uses only APIs that are stable across eslint 9 → 10
(`js.configs.recommended`, flat array export, `languageOptions`, `plugins`, `rules`).
typescript-eslint v8 already declares `^10.0.0` in its peer range, so **no
typescript-eslint bump is needed**.

**Verified facts (do not re-derive):**
- `npm view eslint dist-tags.latest` → `10.4.1`
- `@typescript-eslint/parser@^8` and `@typescript-eslint/eslint-plugin@^8` peer:
  `"eslint": "^8.57.0 || ^9.0.0 || ^10.0.0"` — eslint 10 already satisfied.
- eslint 10 peer dep is only `jiti` (`peerDependenciesMeta.jiti.optional = true`) —
  **do NOT install jiti**, it is optional and only needed for TS config files.
- eslint 10 `engines.node`: `^20.19.0 || ^22.13.0 || >=24`. Local Node is `22.14.0` (OK).

---

## 1. Target Files

### package.json (modify)

**Relevant section — `devDependencies` (lines 85-96):**
```json
"devDependencies": {
  "@eslint/js": "^10.0.1",                       // already on 10 (line 86)
  "@types/node": "^22.13.0",
  "@types/prompts": "^2.4.9",
  "@types/semver": "^7.7.1",
  "@typescript-eslint/eslint-plugin": "^8.22.0", // LEAVE AS-IS (line 90)
  "@typescript-eslint/parser": "^8.22.0",        // LEAVE AS-IS (line 91)
  "eslint": "^9.19.0",                           // <-- CHANGE to "^10.0.0" (line 92)
  "markdownlint-cli": "^0.48.0",
  "typescript": "^5.7.3",
  "vitest": "^3.0.5"
}
```

**The ONLY required edit:** `package.json:92` `"eslint": "^9.19.0"` → `"eslint": "^10.0.0"`.

**Imported by / consumed by:** `package.json:14` `"lint": "eslint src/"` runs the binary.
No source code imports eslint.

**Note on `engines.node` (`package.json:46-48`):** currently `">=18.0.0"`. eslint 10
requires Node `^20.19.0 || ^22.13.0 || >=24`. **Do NOT change `engines.node`** —
it is out of scope (nonGoal "only version bump plus shims required for eslint 10 to
load") and changing it would alter the package's published contract. eslint installs
fine on the local Node 22.14.0; npm only warns (does not fail) on engine mismatch for
a transitive/dev tool. If `npm install` emits an `EBADENGINE` *warning* that is
acceptable (it is a warning, not ERESOLVE, and exit code stays 0).

### package-lock.json (modify — regenerated, do not hand-edit)

Currently `node_modules/eslint` resolves to `9.39.4` (`package-lock.json:2400-2402`)
and the root `packages."".devDependencies.eslint` is `"^9.19.0"` (`package-lock.json:33`).
Regenerate by running install (see Section 8). **Never hand-edit this file.**

### eslint.config.js (modify ONLY IF eslint 10 fails to load — expected: NO CHANGE)

**Full current structure (lines 1-73) — flat config, ESM, default-exported array:**
```js
import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  js.configs.recommended,                 // line 6 — stable in eslint 10
  {
    files: ["src/**/*.ts"],
    languageOptions: { parser: tsParser, parserOptions: {...}, globals: {...} },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,                       // line 32
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", {...}],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  { files: ["src/telemetry/**/*.ts"], rules: { "no-restricted-imports": [...], "no-restricted-globals": [...] } },
  { ignores: ["dist/", "node_modules/", "templates/"] },           // line 70-72
];
```

Every construct here (`js.configs.recommended`, array export, `languageOptions`,
`plugins` map, `rules`, `ignores`-only object) is the eslint flat-config v9 API and is
**unchanged in eslint 10**. The expected outcome is that this file loads with zero edits.

**Test file:** eslint.config.js has no dedicated test; it is exercised by `npm run lint`.

---

## 2. Patterns to Follow

### Flat config is already the only config style
**Source:** `eslint.config.js:1-73` (verified: no `.eslintrc*` exists — checked, no matches).
**Rule:** This repo uses eslint flat config exclusively. Do not introduce `.eslintrc`,
do not add an `eslint.config.ts` (that would require the optional `jiti` peer).

### Version-pin style is caret ranges
**Source:** `package.json:85-96` — every devDependency uses `^x.y.z`.
**Rule:** Use `"^10.0.0"` (caret), matching the style of `@eslint/js: "^10.0.1"`.
Do not pin an exact version.

---

## 3. Existing Utilities — DO NOT Recreate

Utilities reviewed: there is no `utils/`, `lib/`, `helpers/`, or `shared/` directory
relevant to a dependency-version bump. **None applicable** — this sprint touches only
manifest/config files and runs npm + the lint/build/test binaries. There is no code to
import or reuse.

---

## 4. Prior Sprint Output

`dependsOn: []` — this is the first sprint. No prior sprint output to consume.

---

## 5. Relevant Documentation

### Project Principles
`.bober/principles.md` — not checked as load-bearing for a version bump; the contract's
nonGoals are the governing constraints (see Section 9).

### Architecture Decisions
No ADR relevant to eslint versioning. The only architectural note embedded in config is
the **Sprint 28 telemetry network-egress guard** (`eslint.config.js:42-69`): the
`src/telemetry/**` block forbids network imports. **Preserve this block byte-for-byte** —
it is an enforced invariant, not a removable rule.

### Other Docs
`package.json` scripts (`package.json:11-20`) define the verification commands:
`lint` = `eslint src/`, `build` = `tsc`, `test` = `vitest`, `typecheck` = `tsc --noEmit`.

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/graph/preflight-telemetry.test.ts:105-123`
```ts
it("writes NOTHING when the graph is disabled (zero-overhead opt-in)", async () => {
  const injector = new PreflightContextInjector(fakeClient, { enabled: false } as unknown as GraphSection, undefined, root);
  const out = await injector.inject("generator", contract("sprint-x"), "ORIGINAL");
  expect(out).toBe("ORIGINAL");
  ...
});
```
**Runner:** vitest (`package.json:95`, `"test": "vitest"`).
**Assertion style:** `expect(...).toBe(...)`.
**File naming:** `*.test.ts`, co-located in `src/` AND in top-level `tests/`.

**This sprint writes NO new tests.** Verification is via the existing suite (sc-1-5:
"no newly failing tests"). You only confirm the suite's failure count does not increase.

### E2E Test Pattern
Not applicable — no Playwright config in this repo and no UI surface in this sprint.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `eslint.config.js` | `eslint` runtime API | low | Flat-config APIs used are stable in v10; expect no load error |
| `package-lock.json` | `package.json` ranges | low | Regenerated by install; verify eslint resolves to 10.x |
| CI / `npm install` consumers | `package.json` peer graph | medium→fixed | This sprint *removes* the ERESOLVE; verify clean install exit 0 |

### Existing Tests That Must Still Pass
The eslint upgrade does not touch runtime code, so the relevant gate is "no NEW failures".

**CRITICAL PRE-EXISTING BASELINE (measured before any change):**
- `npm run lint` currently **EXITS 1** due to a pre-existing error:
  `src/graph/preflight-telemetry.test.ts:116` — `no-useless-assignment`
  ("This assigned value is not used in subsequent statements"). `let raw = "";` is
  reassigned inside the following try/catch. This is a COMMITTED file (not in your diff).
- `npm test` currently has **3 PRE-EXISTING failing test files** (1352 pass / 3 fail):
  - `src/mcp/tools/tools.test.ts:8` — "registers exactly 37 tools" (tool-count drift)
  - `tests/mcp/external-server-graph.test.ts:34` — same 37-tools assertion
  - `src/orchestrator/checkpoints/mechanisms/disk.test.ts:86` — "deletes pending file
    after approval" (timing/flake)
- `npm run build` currently **EXITS 0** (tsc clean).

**Implication for success criteria:**
- sc-1-3 says `npm run lint` must exit 0. With the pre-existing
  `no-useless-assignment` error this will NOT pass on the current tree, and the eslint
  10 core rule set still includes `no-useless-assignment` (it is a v9 recommended rule).
  **The Generator must surface this to the evaluator.** The honest, in-scope reading:
  the upgrade must not INTRODUCE new lint errors. Fixing the pre-existing
  `no-useless-assignment` is a lint-rule-output fix, not a rule change, and may be the
  minimal edit needed to make `npm run lint` exit 0. If the Generator fixes it, fix ONLY
  that line (`src/graph/preflight-telemetry.test.ts:116`, e.g. `const raw = await readFile(...).catch(() => "")`)
  and DO NOT touch eslint.config.js rules. If the Generator considers this out of scope,
  it must explicitly report the pre-existing failure so the evaluator does not attribute
  it to the upgrade. **Recommendation: make the lint pass exit 0, because sc-1-3 is a
  required criterion verified by the `lint` method.**
- sc-1-5 ("no newly failing tests"): the 3 failing test files above are PRE-EXISTING and
  unrelated to eslint. Do not attempt to fix them; report them as baseline. Compare the
  post-change failure set to this baseline — it must not grow.

### Features That Could Be Affected
- **Sprint 28 telemetry egress guard** — lives in `eslint.config.js:42-69`. Verify it
  still applies after the upgrade (it will; the rules are core/plugin rules stable in v10).
- **Later sprints (DeepSeek / claude-code / openai peer)** — this sprint unblocks
  `npm install` for them. Confirm clean install so the optional `openai` peer is installable later.

### Recommended Regression Checks
After the edit, run in order and assert exit codes:
1. `rm -rf node_modules package-lock.json && npm install` → exit 0, grep output for `ERESOLVE` (must be ABSENT). (Regenerating the lock from scratch is the cleanest way to guarantee a 10.x resolution; alternatively keep the lock and run `npm install` to let it update in place — but a from-scratch regen most reliably clears the stale eslint@9 pin.)
2. `node -e "console.log(require('eslint/package.json').version)"` → prints `10.x`.
3. `grep '"eslint"' package-lock.json` and confirm a `10.` version resolves.
4. `npm run build` → exit 0 (baseline was 0).
5. `npm run lint` → exit 0 (see pre-existing `no-useless-assignment` note above).
6. `npm test -- --run` → failing-file count must be ≤ baseline of 3, and no NEW file failing.

---

## 8. Implementation Sequence

1. **package.json** — change `package.json:92` `"eslint": "^9.19.0"` → `"eslint": "^10.0.0"`.
   Leave `@eslint/js`, `@typescript-eslint/*`, and `engines.node` untouched.
   - Verify: the only diff in package.json is that single line.
2. **package-lock.json** — regenerate via install:
   `rm -rf node_modules package-lock.json && npm install`
   - Verify: exit 0, NO `ERESOLVE` in stdout/stderr; `node_modules/eslint/package.json`
     version starts with `10.`. (An `EBADENGINE` *warning* is acceptable; it is not ERESOLVE.)
3. **eslint.config.js** — DO NOTHING unless step-4 lint fails to LOAD the config (distinct
   from reporting lint errors). Expected: no change.
   - Verify: `npm run lint` does not print a config-load/parse error (it may still print the
     pre-existing `no-useless-assignment` lint error — that is a finding, not a load failure).
4. **(Conditional) Minimal lint fix** — if making sc-1-3 exit 0, fix ONLY
   `src/graph/preflight-telemetry.test.ts:116` per Section 7. Do not edit any rule.
5. **Run full verification** — `npm run build` (exit 0), `npm run lint` (exit 0),
   `npm test -- --run` (no new failures vs baseline of 3), and a clean
   `rm -rf node_modules && npm install` (exit 0, no ERESOLVE).

---

## 9. Pitfalls & Warnings

- **Do NOT bump `@typescript-eslint/*` or `typescript-eslint`.** Their v8 peer range
  already allows `^10.0.0` (verified via `npm view`). nonGoal forbids it unless forced.
- **Do NOT install `jiti`.** It is eslint 10's only peer and is OPTIONAL
  (`peerDependenciesMeta.jiti.optional`); only needed for TS-authored config files. This
  repo's config is `eslint.config.js` (JS), so jiti is unnecessary.
- **Do NOT change `engines.node`** even though eslint 10 wants Node ≥20.19. It is out of
  scope and alters the published contract. The local Node 22.14.0 satisfies it; an
  `EBADENGINE` warning (if any) does not fail install.
- **Do NOT add, remove, reorder, or change severity of ANY rule** in eslint.config.js
  (nonGoal). Preserve the Sprint-28 telemetry block (`eslint.config.js:42-69`) verbatim.
- **package-lock.json is generated** — never hand-edit; let `npm install` produce it.
- **Pre-existing `npm run lint` exit 1** (`src/graph/preflight-telemetry.test.ts:116`,
  `no-useless-assignment`) and **pre-existing 3 failing test files** are NOT caused by this
  sprint. Capture them as baseline and either (a) fix only the single lint line to satisfy
  required sc-1-3, or (b) explicitly report them to the evaluator. Do not let them be
  mis-attributed to the eslint upgrade.
- **Do NOT touch anything under `src/providers/` or `src/orchestrator/`** (nonGoal) — note
  this means the pre-existing `disk.test.ts` failure under `src/orchestrator/` must be left
  alone and reported as baseline, not fixed.
- **Do NOT install the `openai` package** in this sprint (nonGoal) — that is a later sprint.
