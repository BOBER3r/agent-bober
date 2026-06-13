# Sprint Briefing: Child folder scaffolding and subprocess runner

**Contract:** sprint-spec-20260609-fleet-orchestrator-2
**Generated:** 2026-06-09T00:00:00Z

---

## 1. Target Files

### src/fleet/scaffolder.ts (create)

**Directory pattern:** `src/fleet/` uses kebab-case file names (`manifest.ts`, `child-config.ts`). Modules begin with a `// ── Section ──` box header, use `import type` for type-only imports, and async `node:fs/promises` only.
**Most similar existing file:** `src/fleet/child-config.ts` (imports the builder it consumes) + `src/fleet/manifest.ts` (async fs loader). Reuse `buildChildConfig` from Sprint 1.
**Structure template:**
```ts
import { mkdir, writeFile, readdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execa } from "execa";
import { buildChildConfig } from "./child-config.js";
import type { FleetChild } from "./manifest.js";

// ── Types ────────────────────────────────────────────────────────────
export interface ScaffoldResult {
  folder: string;
  absPath: string;
  configWritten: boolean;
  gitInitialized: boolean;
  error?: string;
}

// ── Scaffolder ───────────────────────────────────────────────────────
export class ChildScaffolder {
  async scaffold(rootDir: string, child: FleetChild): Promise<ScaffoldResult> {
    const absPath = resolve(rootDir, child.folder);
    // 1. non-empty safety check (readdir length > 0 → bail, untouched)
    // 2. mkdir({recursive:true})
    // 3. writeFile(join(absPath,"bober.config.json"), JSON.stringify(buildChildConfig(child), null, 2))
    // 4. execa("git", ["init"], { cwd: absPath, reject:false })
    // all wrapped so NOTHING throws; capture into error
  }
}
```

### src/fleet/runner.ts (create)

**Most similar existing file:** `src/providers/factory.ts:48-55` (the execa `--version` probe with `reject:false` + `timeout`) and `src/graph/cli.ts:75-95` (execa with `timeout`/`reject:false` and `result.timedOut` detection).
**Structure template:**
```ts
import { execa } from "execa";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── Entry resolution (ADR-4) ─────────────────────────────────────────
// At runtime this file is dist/fleet/runner.js → CLI is dist/cli/index.js
// from dirname(runner.js) = dist/fleet, go ".." to dist, then "cli/index.js"
export function resolveCliEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // dist/fleet
  return join(here, "..", "cli", "index.js");           // dist/cli/index.js
}

// ── Types ────────────────────────────────────────────────────────────
export interface ChildRunSpec { cwd: string; task: string; timeoutMs?: number; }
export interface ChildSpawnResult {
  cwd: string; exitCode: number | null;
  stdout: string; stderr: string;
  timedOut?: boolean; spawnError?: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 10 * 1024 * 1024; // bounded; see pitfalls

export async function probeCliVersion(cliEntry: string): Promise<boolean> { ... }

export class ChildRunner {
  async run(spec: ChildRunSpec): Promise<ChildSpawnResult> { ... }
}
```

### src/fleet/__fixtures__/stub-child.js (create)
Plain Node ESM (or CJS) script invoked via `process.execPath`. Reads `process.argv` to choose behavior: exit with a given code, print to stdout/stderr, or `setTimeout`-sleep long enough to trip a short test timeout. NO `.ts` — it is run directly by node, not compiled through tsc. Keep it out of the tsc build path (it lives in `__fixtures__`).

### src/fleet/scaffolder.test.ts, src/fleet/runner.test.ts (create)
Collocated vitest tests with `mkdtemp` temp dirs + `afterEach` cleanup. See section 6.

---

## 2. Patterns to Follow

### execa import + non-throwing reject:false
**Source:** `src/utils/git.ts:1,69-73`
```ts
import { execa } from "execa";
const { stdout } = await execa("git", ["diff", ref], { cwd, reject: false });
```
**Rule:** Always `import { execa } from "execa"` (named); pass `{ reject: false }` so a non-zero exit resolves instead of throwing.

### execa --version probe with timeout (ADR-4/ADR-5 template)
**Source:** `src/providers/factory.ts:48-55`
```ts
const defaultBinaryProbe: BinaryProbe = async (binary) => {
  try {
    const r = await execa(binary, ["--version"], { reject: false, timeout: 5_000 });
    return r.exitCode === 0;
  } catch {
    return false; // ENOENT → not on PATH
  }
};
```
**Rule:** `probeCliVersion(cliEntry)` mirrors this — `execa(process.execPath, [cliEntry, "--version"], { reject:false, timeout:5_000 })`, returns `r.exitCode === 0`, and a try/catch returns `false` on a spawn/ENOENT error.

### execa timeout + timedOut detection
**Source:** `src/graph/cli.ts:76-88`
```ts
const result = await execa(this.binary, ["sync", ...paths], {
  cwd: this.cwd, timeout: timeoutMs, reject: false, all: true,
});
if (result.timedOut) { /* timeout path */ }
```
**Rule:** execa exposes `result.timedOut` (boolean), `result.exitCode` (number | null on spawn failure), `result.stdout`, `result.stderr`, `result.failed`, `result.shortMessage`. For `run()`: set `timeout: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS`, map `timedOut`, and on a spawn-level throw (bad entry path / ENOENT) catch it and set `spawnError`.

### Own-entry resolution via fileURLToPath(import.meta.url)
**Source:** `src/cli/index.ts:39,42-44`
```ts
const __dirname = dirname(fileURLToPath(import.meta.url));
// In the dist/ output the package.json is two levels up from dist/cli/
const pkgPath = join(__dirname, "..", "..", "package.json");
```
**Rule:** This proves the runtime layout: `dist/cli/index.js` → `..`/`..` reaches the package root. From `dist/fleet/runner.js`, `dirname(fileURLToPath(import.meta.url))` is `dist/fleet`; the CLI entry is `join(here, "..", "cli", "index.js")` → `dist/cli/index.js`. Confirmed by `package.json:9` `"bin": { "agent-bober": "dist/cli/index.js" }`. NEVER use a bare `"agent-bober"` PATH lookup.

### Builder reuse (Sprint 1)
**Source:** `src/fleet/child-config.ts:21`
```ts
export function buildChildConfig(child: FleetChild): BoberConfig
```
**Rule:** `scaffold()` writes `JSON.stringify(buildChildConfig(child), null, 2)` to `bober.config.json`. The result already passes `BoberConfigSchema.parse` (child-config.ts:44), so no extra validation needed in the scaffolder.

### Module/import conventions
**Source:** `src/fleet/manifest.ts:1-3`, `src/fleet/child-config.ts:1-3`
**Rule:** `.js` extensions on all relative imports; `import type` for types (`import type { FleetChild } from "./manifest.js"`); `// ── Section ──` headers; no `any`; async `node:fs/promises` only (`import { readFile } from "node:fs/promises"`).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `buildChildConfig` | `src/fleet/child-config.ts:21` | `(child: FleetChild): BoberConfig` | Build the Zod-valid DeepSeek child config — call this, do not rebuild config. |
| `FleetChild` (type) | `src/fleet/manifest.ts:11` | `{ folder, task, config? }` | The child shape both scaffolder + runner consume. |
| `createDefaultConfig` | `src/config/schema.ts:379` | `(name, mode)` | Base config — already used inside buildChildConfig; do NOT call directly here. |
| `BoberConfigSchema` | `src/config/schema.ts:334` | Zod schema | Validation — buildChildConfig already applies it; tests may re-parse to assert validity (sc-2-4). |
| git helpers | `src/utils/git.ts` | various | NOTE: no `gitInit` helper exists — call `execa("git",["init"],...)` directly per the execa pattern. |

Utilities reviewed: `src/utils/git.ts`, `src/providers/factory.ts`, `src/config/schema.ts`, `src/fleet/*`. No existing `gitInit`, `scaffold`, or subprocess-runner helper — these are net-new.

---

## 4. Prior Sprint Output

### Sprint 1: Manifest + child config (DONE)
**Created:** `src/fleet/manifest.ts` — exports `FleetManifestSchema`, `FleetChildSchema`, types `FleetManifest`/`FleetChild`, async `load(manifestPath)`.
**Created:** `src/fleet/child-config.ts` — exports `buildChildConfig(child): BoberConfig` (DeepSeek `provider:"openai-compat"`, `endpoint:"https://api.deepseek.com"`).
**Connection:** `scaffolder.ts` imports `buildChildConfig` (to write the config) and the `FleetChild` type (input to `scaffold`). `runner.ts` needs only `FleetChild`/a local `ChildRunSpec` — it does not touch the config builder.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere** — `.js` import extensions; `"type":"module"` (package.json:5).
- **No synchronous fs** — `node:fs/promises` only. No `*Sync`.
- **`import type`** — `consistent-type-imports` enforced (lint hard gate).
- **No `any`** — use `unknown` + narrowing. (no-explicit-any).
- **No SDK leakage** — N/A here (no LLM SDK touched).
- **Tests use real temp dirs, never mock fs** — `mkdtemp` + cleanup.
- **Tests collocated** as `*.test.ts` next to source.
- **Zero type/lint errors and clean tsc are hard gates.**

### Architecture Decisions
- **ADR-4 (entry resolution):** resolve the parent's own `dist/cli/index.js` via `fileURLToPath(import.meta.url)`, not a PATH `agent-bober` lookup. Running from un-built source is unsupported (contract assumptions).
- **ADR-5 (timeout):** execa `timeout` option; an exceeded timeout yields `timedOut:true` rather than hanging.

---

## 6. Testing Patterns

### Unit Test Pattern (temp dirs, no fs mocks)
**Source:** `src/config/loader.test.ts:8-33`
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-fleet-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
```
**Runner:** vitest. **Assertion:** `expect(...)`. **Mock approach:** logger may be `vi.mock`'d; NEVER mock fs. **File naming:** `scaffolder.test.ts` collocated. **Location:** co-located next to source.

### Spawning a stub via process.execPath (for runner.test.ts)
There is no existing `process.execPath`-stub test in src, so build one against the fixture:
```ts
import { execa } from "execa";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const stub = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "stub-child.js");
// exit-code case: stub exits 3 → expect result.exitCode === 3
const r = await execa(process.execPath, [stub, "exit", "3"], { reject: false });
// timeout case: stub sleeps 5000ms, run with timeout:100 → expect r.timedOut === true
```
**Scaffold tests to cover:** sc-2-4 fresh scaffold (assert `.git` exists via `stat`, config parses against `BoberConfigSchema`); sc-2-5 non-empty folder (pre-write a sentinel file, assert it is byte-for-byte untouched + `error` set + no config written); sc-2-6 error capture (e.g. point at an unwritable path) returns `error`, never throws.
**Runner tests to cover:** sc-2-7 exit-code mapping via stub; sc-2-8 default timeout applied + exceeded timeout → `timedOut:true`; spawn failure (bad entry path) → `spawnError` set, no throw; sc-2-9 `resolveCliEntry()` ends with `dist/cli/index.js` and `probeCliVersion` exists.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| (none yet) | scaffolder.ts / runner.ts | low | These are net-new files; Sprint 3 (`mapBounded` fan-out) will import them. No current importers. |

`src/fleet/scaffolder.ts` and `src/fleet/runner.ts` do not exist yet — nothing imports them. The only shared code is `buildChildConfig` (consumed, not modified) and `FleetChild` (type, not modified).

### Existing Tests That Must Still Pass
- `src/fleet/child-config.test.ts` (if present) — buildChildConfig behavior is unchanged; do not edit child-config.ts.
- Full suite (sc-2-10) — run `npm test`. No existing test exercises `src/fleet/scaffolder.ts`/`runner.ts`.

### Features That Could Be Affected
- **feat-3 (Sprint 3 fan-out)** — will import `ChildScaffolder`/`ChildRunner`. Keep their exported signatures stable: `scaffold(rootDir, child): Promise<ScaffoldResult>` and `run(spec): Promise<ChildSpawnResult>`, plus exported `resolveCliEntry`/`probeCliVersion`.

### Recommended Regression Checks
1. `npm run build` (tsc) — zero errors. Confirm `__fixtures__/stub-child.js` is NOT compiled by tsc / does not break the build.
2. `npx tsc --noEmit` — zero type errors.
3. `npx eslint src/fleet/` — zero errors (consistent-type-imports, no-explicit-any).
4. `npm test` — full suite green.

---

## 8. Implementation Sequence

1. **src/fleet/scaffolder.ts** — define `ScaffoldResult`; implement `ChildScaffolder.scaffold`: resolve absPath, readdir/stat non-empty check (bail untouched with `error`), `mkdir({recursive:true})`, `writeFile(bober.config.json, JSON.stringify(buildChildConfig(child), null, 2))`, `execa("git",["init"],{cwd:absPath,reject:false})`, wrap so it never throws.
   - Verify: imports `buildChildConfig` from `./child-config.js`; tsc clean.
2. **src/fleet/runner.ts** — `resolveCliEntry()` via `fileURLToPath(import.meta.url)` → `join(here,"..","cli","index.js")`; `probeCliVersion`; `ChildRunSpec`/`ChildSpawnResult`; `ChildRunner.run` with `execa(process.execPath, [resolveCliEntry(), "run", spec.task], {cwd, reject:false, timeout: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER})`; map fields; catch spawn throw → `spawnError`.
   - Verify: never throws; `timedOut` mapped; tsc clean.
3. **src/fleet/__fixtures__/stub-child.js** — argv-driven exit-code / sleep behavior. Plain runnable node script.
   - Verify: `node src/fleet/__fixtures__/stub-child.js exit 3; echo $?` prints 3.
4. **src/fleet/scaffolder.test.ts** — fresh scaffold, non-empty safety (sentinel), error capture. temp dirs + cleanup.
5. **src/fleet/runner.test.ts** — exit-code via stub, default + exceeded timeout (`timedOut:true`), spawn failure → `spawnError`, `resolveCliEntry` ends with `dist/cli/index.js`, probe exists.
6. **Run full verification** — `npm run build`, `npx tsc --noEmit`, `npx eslint src/fleet/`, `npm test`.

---

## 9. Pitfalls & Warnings

- **LOAD-BEARING SECURITY (sc-2-5):** a non-empty target folder MUST be left byte-for-byte untouched — no mkdir, no write, no git init, no spawn. Detect via `readdir(absPath)` length > 0 (contract: "any entries"). Test with a sentinel file and assert it is unchanged.
- **Entry must NOT be a bare PATH lookup.** Do NOT `execa("agent-bober", ...)`. Resolve `dist/cli/index.js` from `fileURLToPath(import.meta.url)`. At runtime runner.js lives at `dist/fleet/runner.js`, so `join(dirname(...), "..", "cli", "index.js")`. Confirmed by package.json:9 bin = `dist/cli/index.js` and cli/index.ts:42-44 (`dist/cli/` is two levels under root).
- **Timeout via execa's `timeout` option only** (ADR-5) — never roll your own setTimeout race. Map `result.timedOut`.
- **maxBuffer must be bounded** — set an explicit `maxBuffer` (e.g. 10 MiB) on `run()` so a runaway child cannot exhaust memory.
- **execa `exitCode` can be `null`** on a spawn-level failure — type `ChildSpawnResult.exitCode` as `number | null` and set `spawnError` in the catch.
- **Never throw from scaffold/run/probe** — all failures are returned as data (`error` / `spawnError`). Wrap git init and fs ops; a thrown error fails sc-2-6/sc-2-7.
- **Fixture must not break tsc** — `__fixtures__/stub-child.js` is run by node directly; keep it `.js`. Ensure tsconfig `include`/`exclude` does not try to type-check it (it won't, being `.js`, but verify build stays clean).
- **`import type` for FleetChild / ScaffoldResult-in-tests**; `.js` extensions on every relative import; no `any`.
- **Do NOT modify** the `run` command, `runPipeline`, or child-config.ts (out of scope; Sprint 3/4 own fan-out + CLI wiring).
