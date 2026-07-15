# Sprint Briefing: fleet expand-deep CLI subcommand (additive, spawn-safe, byte-lock preserved)

**Contract:** sprint-spec-20260618-fleet-expand-deep-2
**Generated:** 2026-06-18T08:12:00Z

---

## 0. CRITICAL DISCREPANCY — READ FIRST (signature mismatch)

The contract's `definitionOfDone` and `generatorNotes` say to call
`(deps?.decomposeDeep ?? decomposeGoalDeep)({ goal: goalWithHint, client, model })`
and to "COPY runFleetExpand's body verbatim".

**But `runFleetExpand` calls its decompose with a `maxRetries` field**
(`src/fleet/index.ts:195`):

```ts
const decomposed = await decomposeFn({ goal: goalWithHint, client, model, maxRetries: 1 });
```

`decomposeGoalDeep`'s input type **has NO `maxRetries` field** — it uses
`planMaxRetries` / `expandMaxRetries` (defaulted internally). See
`src/fleet/decomposer-deep.ts:81-88`:

```ts
export interface DecomposeDeepInput {
  goal: string;
  client: LLMClient;
  model: string;
  count?: string;
  planMaxRetries?: number;
  expandMaxRetries?: number;
}
```

**RULE:** In `runFleetExpandDeep`, call decompose WITHOUT `maxRetries`:
```ts
const decomposed = await decomposeDeepFn({ goal: goalWithHint, client, model });
```
Passing `maxRetries: 1` would be an excess-property error under strict object-literal
checking (TS2353) when the arg is a literal typed as `DecomposeDeepInput` via `typeof decomposeGoalDeep`.
This is the ONE intentional deviation from a verbatim copy. Everything else is identical.

**Do NOT add `responseSchema`, `count`, or any other field.** The `count` hint is folded
into the goal string (the `goalWithHint` pattern), exactly as runFleetExpand does — keep it that way
so the diff stays minimal. (Passing `count` separately would also work since the type allows it,
but the verbatim-mirror requirement says fold it into the goal.)

---

## 1. Target Files

### src/fleet/index.ts (modify — ADDITIVE ONLY)

This is the ONLY production file changed. The contract is byte-lock strict: do not edit a single
existing line in `runFleet`, `runFleetExpand`, `registerFleetExpandSubcommand`, or the
`fleet <manifest>` `.command/.action`. Add: one import, two interfaces, one async function, one
register function, and one call line.

**Existing imports already present (REUSE — do not re-add) (lines 10-28):**
```ts
import chalk from "chalk";
import type { Command } from "commander";
import { join, dirname } from "node:path";
import { writeFile, rename, access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { validateApiKey, createClient } from "../providers/factory.js";
import { logger } from "../utils/logger.js";
import { decomposeGoal } from "./decomposer.js";
import { ensureDir } from "../state/helpers.js";
import type { FleetManifest } from "./manifest.js";
import type { LLMClient } from "../providers/types.js";
```
You only need to ADD one new import:
```ts
import { decomposeGoalDeep } from "./decomposer-deep.js";
```
Place it near the existing `import { decomposeGoal } from "./decomposer.js";` (line 23).

**TEMPLATE TO MIRROR — runFleetExpand (lines 169-256):** this is the EXACT step sequence
`runFleetExpandDeep` must reproduce. Reproduced here so you don't re-read:

```ts
// FleetExpandOptions (lines 131-146) — your FleetExpandDeepOptions is IDENTICAL in shape
export interface FleetExpandOptions {
  count?: string; provider?: string; model?: string; root?: string;
  concurrency?: string; out?: string; yes?: boolean;
}

// FleetExpandDeps (lines 148-152) — yours swaps `decompose` -> `decomposeDeep`
export interface FleetExpandDeps {
  decompose?: typeof decomposeGoal;
  runFleet?: typeof runFleet;
  createClient?: typeof createClient;
}

export async function runFleetExpand(
  goal: string, opts: FleetExpandOptions, deps?: FleetExpandDeps,
): Promise<void> {
  // Step 1: credential fail-fast BEFORE any IO (lines 177-185)
  const model = opts.model ?? "deepseek-v4-pro";
  const clientBuilder = deps?.createClient ?? createClient;
  const client: LLMClient = clientBuilder(
    opts.provider ?? "openai-compat",
    "https://api.deepseek.com",
    undefined,
    model,
    "FleetDecomposer",
  );

  // Step 2: fold --count into goal, then decompose (lines 189-195)
  const goalWithHint =
    opts.count !== undefined
      ? `${goal}\n\n(Decompose into approximately ${opts.count} independent sub-projects.)`
      : goal;
  const decomposeFn = deps?.decompose ?? decomposeGoal;
  const decomposed = await decomposeFn({ goal: goalWithHint, client, model, maxRetries: 1 });
  //                                                                       ^^^^^^^^^^^^^ DROP for deep

  // Step 3: assemble { rootDir, concurrency, children } (lines 198-204)
  const root = opts.root ?? ".";
  const concurrency = opts.concurrency ? Number(opts.concurrency) : 3;
  const manifest: FleetManifest = { rootDir: root, concurrency, children: decomposed.children };

  // Step 4: atomic tmp+rename write + overwrite notice (lines 207-223)
  const outPath = opts.out ?? join(root, ".bober", "fleet-expand.json");
  await ensureDir(dirname(outPath));
  const alreadyExisted = await access(outPath).then(() => true, () => false);
  const rnd = randomBytes(4).toString("hex");
  const tmp = `${outPath}.${process.pid}.${Date.now()}.${rnd}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2), { encoding: "utf-8" });
  await rename(tmp, outPath);
  if (alreadyExisted) {
    console.log(`[fleet expand] Overwritten existing manifest at: ${outPath}`);
  }

  // Step 5: print manifest + review hint (lines 226-233)
  console.log();
  console.log(chalk.bold("═══ Fleet Expand Manifest ═══"));
  console.log();
  console.log(JSON.stringify(manifest, null, 2));
  console.log();
  console.log(`Manifest written to: ${outPath}`);
  console.log(`Review then run: agent-bober fleet "${outPath}"`);
  console.log();

  // Step 6: --yes gate — runFleet ONLY here (lines 237-255)
  if (opts.yes) {
    const runFleetFn = deps?.runFleet ?? runFleet;
    const report = await runFleetFn(outPath);
    console.log();
    console.log(chalk.bold("═══ Fleet Summary ═══"));
    console.log();
    console.log(`  Total:      ${chalk.cyan(String(report.total))} children`);
    console.log(`  Completed:  ${chalk.green(String(report.completed))}`);
    if (report.failed > 0) console.log(`  Failed:     ${chalk.red(String(report.failed))}`);
    if (report.other > 0) console.log(`  Other:      ${chalk.yellow(String(report.other))}`);
    console.log();
  } else {
    process.exitCode = 0;
  }
}
```

**registerFleetExpandSubcommand TEMPLATE (lines 266-300):**
```ts
export function registerFleetExpandSubcommand(fleet: Command): void {
  fleet
    .command("expand <goal>")
    .description("Decompose a goal into a fleet manifest and optionally run it")
    .option("--count <n>", "Soft target for number of sub-projects")
    .option("--provider <p>", "Override the decomposer LLM provider (default: openai-compat)")
    .option("--model <m>", "Override the decomposer LLM model (default: deepseek-v4-pro)")
    .option("--root <dir>", "Override the manifest rootDir (default: .)")
    .option("--concurrency <c>", "Override manifest concurrency (default: 3)")
    .option("--out <path>", "Override the output path for the written manifest")
    .option("--yes", "Chain into fleet run after writing the manifest")
    .action(
      async (goal: string, opts: { count?: string; provider?: string; model?: string;
          root?: string; concurrency?: string; out?: string; yes?: boolean; }) => {
        try {
          await runFleetExpand(goal, opts);
        } catch (err) {
          logger.error(`Fleet expand failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
        }
      },
    );
}
```

**registerFleetCommand — the SINGLE wiring line to add (lines 312-346):**
```ts
export function registerFleetCommand(program: Command): void {
  const fleet = program
    .command("fleet <manifest>")                                   // BYTE-LOCKED positional
    .description("Run a fleet of agent-bober children from a manifest")
    .option("--concurrency <n>", "Override manifest concurrency")  // BYTE-LOCKED
    .option("--root <dir>", "Override manifest rootDir")           // BYTE-LOCKED
    .action(async (manifest: string, opts: { concurrency?: string; root?: string }) => {
      /* ... byte-locked action body, lines 318-343 ... */
    });

  registerFleetExpandSubcommand(fleet);          // line 345 — DO NOT EDIT
  // >>> ADD EXACTLY THIS ONE LINE, IMMEDIATELY AFTER line 345 <<<
  registerFleetExpandDeepSubcommand(fleet);
}
```

**Imported by (consumers of src/fleet/index.ts exports — see Impact Analysis §7):**
- `src/cli/index.ts:317` imports/calls `registerFleetCommand(program)` — UNCHANGED (non-goal).
- `src/fleet/expand.test.ts` imports `runFleetExpand, registerFleetCommand`.
- `src/fleet/index.test.ts` imports `runFleet, registerFleetCommand`.

**Test file for this target:** `src/fleet/expand-deep.test.ts` — **does NOT exist** (you create it).

---

### src/fleet/expand-deep.test.ts (create)

**Directory pattern:** collocated tests, kebab/lower module name + `.test.ts`
(`src/fleet/expand.test.ts`, `src/fleet/index.test.ts`, `src/fleet/decomposer-deep.test.ts`).
**Most similar existing file:** `src/fleet/expand.test.ts` — clone its structure almost verbatim,
swapping `decompose` → `decomposeDeep` in the deps and `runFleetExpand` → `runFleetExpandDeep`.
**Structure template (mirrors expand.test.ts):**
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { runFleetExpandDeep, registerFleetCommand } from "./index.js";
import type { FleetManifest } from "./manifest.js";
import type { LLMClient } from "../providers/types.js";
import type { decomposeGoalDeep } from "./decomposer-deep.js";
import type { runFleet } from "./index.js";
import type { createClient } from "../providers/factory.js";

type DecomposeDeepFn = typeof decomposeGoalDeep;
type RunFleetFn = typeof runFleet;
type CreateClientFn = typeof createClient;

const FAKE_CHILDREN: FleetManifest["children"] = [
  { folder: "api-server", task: "Build a REST API server with Express" },
  { folder: "web-frontend", task: "Build a React frontend application" },
];

// fake decomposeGoalDeep returns a children-only FleetManifest (NO LLM call)
function makeFakeDecomposeDeep(
  children: FleetManifest["children"] = FAKE_CHILDREN,
): DecomposeDeepFn {
  return async (_input) => ({ rootDir: ".", concurrency: 3, children });
}

const fakeLLMClient: LLMClient = {
  async chat(_params) {
    return { text: '{"children":[{"folder":"a","task":"t"}]}', toolCalls: [],
      stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } };
  },
};
function makeFakeClientBuilder(): CreateClientFn {
  return (_p, _e, _pc, _m, _r) => fakeLLMClient;
}
function makeFakeClientBuilderThrowing(): CreateClientFn {
  return (_p, _e, _pc, _m, _r) => {
    throw new Error("FleetDecomposer is configured to use DeepSeek but DEEPSEEK_API_KEY is not set.");
  };
}
// ... describe blocks mirroring expand.test.ts (see §6) ...
```

**NOTE on the fake's return type:** `decomposeGoalDeep` returns `Promise<FleetManifest>` (it adds
`rootDir`/`concurrency` defaults internally), whereas `decomposeGoal` also returns
`Promise<FleetManifest>`. The fake returns the full `{ rootDir, concurrency, children }` object —
this matches `typeof decomposeGoalDeep`'s return type. (`runFleetExpandDeep` only reads
`.children` off it, exactly like runFleetExpand.)

---

## 2. Patterns to Follow

### Credential fail-fast BEFORE any IO (AC3 / sc-2-6)
**Source:** `src/fleet/index.ts`, lines 174-185
```ts
const model = opts.model ?? "deepseek-v4-pro";
const clientBuilder = deps?.createClient ?? createClient;
const client: LLMClient = clientBuilder(
  opts.provider ?? "openai-compat", "https://api.deepseek.com",
  undefined, model, "FleetDecomposer",
);
```
**Rule:** `createClient(...)` is the FIRST statement — it throws synchronously via `validateApiKey`
when `DEEPSEEK_API_KEY` is missing, so no file is written and decompose never runs. Keep this order.

### Write-before-spawn atomic tmp+rename (AC2 / sc-2-5)
**Source:** `src/fleet/index.ts`, lines 207-219
```ts
const outPath = opts.out ?? join(root, ".bober", "fleet-expand.json");
await ensureDir(dirname(outPath));
const alreadyExisted = await access(outPath).then(() => true, () => false);
const rnd = randomBytes(4).toString("hex");
const tmp = `${outPath}.${process.pid}.${Date.now()}.${rnd}.tmp`;
await writeFile(tmp, JSON.stringify(manifest, null, 2), { encoding: "utf-8" });
await rename(tmp, outPath);
```
**Rule:** Write + rename happen at Step 4, structurally BEFORE the `if (opts.yes)` gate at Step 6.
The file is guaranteed to exist on disk before `runFleet(outPath)` is ever reachable. Do not reorder.

### --yes is the sole spawn gate (AC1/AC2)
**Source:** `src/fleet/index.ts`, lines 237-255
```ts
if (opts.yes) {
  const runFleetFn = deps?.runFleet ?? runFleet;
  const report = await runFleetFn(outPath);
  /* print Fleet Summary */
} else {
  process.exitCode = 0;
}
```
**Rule:** The ONLY call into `runFleet` lives inside `if (opts.yes)`. No TTY check, no prompt.

### Thin try/catch action wrapper
**Source:** `src/fleet/index.ts`, lines 290-298
```ts
try { await runFleetExpand(goal, opts); }
catch (err) {
  logger.error(`Fleet expand failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
```
**Rule:** The deep action mirrors this; only the message changes to `Fleet expand-deep failed: ...`.

### Section-comment headers (principles.md:32)
**Source:** `src/fleet/index.ts:129` `// ── runFleetExpand ────...`
**Rule:** Add `// ── runFleetExpandDeep ───...` and `// ── registerFleetExpandDeepSubcommand ───...`
unicode box-drawing headers, matching the existing style.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `decomposeGoalDeep` | `src/fleet/decomposer-deep.ts:319` | `(input: DecomposeDeepInput): Promise<FleetManifest>` | Sprint-1 two-stage plan→expand decomposer. Call as `({ goal, client, model })` — NO maxRetries. |
| `decomposeGoal` | `src/fleet/decomposer.ts:159` | `(input: DecomposeInput): Promise<FleetManifest>` | Phase-2 single-shot decomposer (template caller; takes `maxRetries`). |
| `runFleet` | `src/fleet/index.ts:94` | `(manifestPath, options?, deps?): Promise<PortfolioReport>` | Locked fleet entrypoint reused via the written manifest path. Do NOT modify. |
| `createClient` | `src/providers/factory.ts:172` | `(provider?, endpoint?, providerConfig?, model?, role?): LLMClient` | Builds the LLMClient; throws on missing key (fail-fast). |
| `validateApiKey` | `src/providers/factory.ts:86` | `(provider, role, apiKey?, endpoint?): void` | Throws when a required key is missing (invoked inside createClient). |
| `ensureDir` | `src/state/helpers.ts:6` | `(dirPath: string): Promise<void>` | `mkdir(..., { recursive: true })`. Use for the output dir. |
| `logger` | `src/utils/logger.ts` | `logger.error(msg)` | Action-level error logging in the catch block. |
| `FleetManifest` (type) | `src/fleet/manifest.ts` | type | Manifest shape `{ rootDir, concurrency, children }`. |
| `FleetManifestSchema` | `src/fleet/manifest.ts` | Zod schema | Validate written manifest in tests (`.safeParse(parsed).success`). Do NOT modify. |
| `LLMClient` (type) | `src/providers/types.ts:216` | interface w/ `chat(params): Promise<ChatResponse>` | Type for the fake client in tests. |

Utilities reviewed: `src/state/helpers.ts`, `src/utils/`, `src/providers/factory.ts`,
`src/fleet/` — all relevant helpers listed above. No new helper is needed; everything reused.

---

## 4. Prior Sprint Output

### Sprint 1: decomposer-deep.ts engine — COMPLETE
**Created:** `src/fleet/decomposer-deep.ts` — exports `decomposeGoalDeep(input: DecomposeDeepInput): Promise<FleetManifest>`,
plus `DecomposeDeepInput`, `runPlanStage`, `runExpandStage`, `validateOutline`, and DEEP_* prompt constants.
**Exact signature (decomposer-deep.ts:319-321 + input type 81-88):**
```ts
export interface DecomposeDeepInput {
  goal: string; client: LLMClient; model: string;
  count?: string; planMaxRetries?: number; expandMaxRetries?: number;
}
export async function decomposeGoalDeep(input: DecomposeDeepInput): Promise<FleetManifest>;
```
**Connection to this sprint:** `runFleetExpandDeep` imports `decomposeGoalDeep` and calls it
where `runFleetExpand` calls `decomposeGoal` — the ONLY behavioral difference between the two
actions. Call it as `({ goal: goalWithHint, client, model })` (no `maxRetries`).
**Existing call convention confirmed** at `src/fleet/decomposer-deep.test.ts:151-155, 209` — always
`{ goal, client, model }`, never `maxRetries`.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM .js imports** (line 27): `import { decomposeGoalDeep } from "./decomposer-deep.js";` — `.js` extension required.
- **`import type` for type-only imports** (line 35): `typeof decomposeGoalDeep`, `typeof runFleet`,
  `typeof createClient` in `FleetExpandDeepDeps` reference values via `typeof`, so the import of
  `decomposeGoalDeep` is a VALUE import (not `import type`). In the test file, `import type { decomposeGoalDeep }`
  IS correct because it's used only in `typeof` alias position (mirror expand.test.ts:9).
- **No `any`** (line 40): use `unknown` + narrowing; the action's `opts` is an inline typed object literal.
- **No SDK import outside providers/** (line 41): N/A here — you import only fleet/provider helpers.
- **No synchronous fs** (line 42): all writes via `node:fs/promises` (writeFile/rename/access). Already satisfied by the template.
- **Section comments** (line 32): add `// ── ... ──` headers.
- **Collocated tests** (line 20): `src/fleet/expand-deep.test.ts` next to source.

### Architecture Decisions
No `.bober/architecture/` ADR is specific to this sprint. The relevant invariant lives in
`.bober/principles.md` (provider-agnostic LLMClient, ESM). No additional ADR read needed.

### Other Docs
`generatorNotes` in the contract are the authoritative step list — but see §0: the
`{ goal, client, model }` form WITHOUT `maxRetries` overrides the literal "copy verbatim" wording.

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/fleet/expand.test.ts` (clone this file's structure)
**Runner:** Vitest. **Assertion style:** `expect(...)`. **Mock approach:** hand-rolled DI fakes + `vi.fn()` spies. **File naming:** `<module>.test.ts` collocated.

**(a) write-and-stop (sc-2-4) — mirror expand.test.ts:85-115:**
```ts
const outPath = join(tmpDir, "fleet-expand.json");
const runFleetSpy = vi.fn();
await runFleetExpandDeep("Build a platform", { out: outPath, root: tmpDir }, {
  decomposeDeep: makeFakeDecomposeDeep(),
  runFleet: runFleetSpy as unknown as RunFleetFn,
  createClient: makeFakeClientBuilder(),
});
const parsed = JSON.parse(await readFile(outPath, "utf-8")) as unknown;
expect(FleetManifestSchema.safeParse(parsed).success).toBe(true);   // AC-explicit schema check
expect(runFleetSpy).not.toHaveBeenCalled();
```
(Set `process.env["DEEPSEEK_API_KEY"]="fake-key-for-test"` in beforeEach, restore in afterEach —
copy the env save/restore block from expand.test.ts:70-83.)

**(b) --yes-after-write (sc-2-5) — mirror expand.test.ts:218-244:** use the `runFleetSpy` whose
`mockImplementation` does `await access(outPath)` to prove the file existed BEFORE the spawn,
and `expect(runFleetSpy).toHaveBeenCalledTimes(1)` + `toHaveBeenCalledWith(outPath)`.

**(c) credential fail-fast (sc-2-6) — mirror expand.test.ts:267-316:**
```ts
delete process.env["DEEPSEEK_API_KEY"];
let decomposeCalled = false;
const trackingDecompose: DecomposeDeepFn = async (...args) => {
  decomposeCalled = true; return makeFakeDecomposeDeep()(...args);
};
await expect(runFleetExpandDeep("g", { out: outPath }, {
  decomposeDeep: trackingDecompose,
  runFleet: runFleetSpy as unknown as RunFleetFn,
  createClient: makeFakeClientBuilderThrowing(),
})).rejects.toThrow(/DEEPSEEK_API_KEY/);
await expect(access(outPath)).rejects.toThrow();   // no file
expect(decomposeCalled).toBe(false);               // decompose never ran
expect(runFleetSpy).not.toHaveBeenCalled();
```

**(d) decompose-failure (sc-2-7) — NEW pattern (expand.test.ts lacks it; add explicitly for AC4):**
```ts
const throwingDecompose: DecomposeDeepFn = async () => {
  throw new Error("deep expand failed after 2 attempts");
};
const runFleetSpy = vi.fn();
await expect(runFleetExpandDeep("g", { out: outPath, root: tmpDir }, {
  decomposeDeep: throwingDecompose,
  runFleet: runFleetSpy as unknown as RunFleetFn,
  createClient: makeFakeClientBuilder(),
})).rejects.toThrow();
await expect(access(outPath)).rejects.toThrow();   // no file written
expect(runFleetSpy).not.toHaveBeenCalled();
```

**(e) overwrite notice + --out redirect (sc-2-8) — mirror expand.test.ts:341-399** (two writes,
assert second manifest content + `console.log` spy contains the path and `/overwrite|overwritten/`;
and `--out` redirect: custom path exists, default `.bober/fleet-expand.json` does NOT).

**(f) command-tree registration (sc-2-8 / AC5) — mirror expand.test.ts:404-453 AND ADD expand-deep:**
```ts
const program = new Command();
registerFleetCommand(program);
const fleet = program.commands.find((c) => c.name() === "fleet");
const subNames = fleet!.commands.map((c) => c.name());
expect(subNames).toContain("expand-deep");          // NEW child present
expect(subNames).toContain("expand");               // locked child intact
expect(fleet!.usage()).toContain("manifest");       // locked positional intact
const fleetOpts = fleet!.options.map((o) => o.long);
expect(fleetOpts).toContain("--concurrency");       // locked
expect(fleetOpts).toContain("--root");              // locked
const deep = fleet!.commands.find((c) => c.name() === "expand-deep");
const deepOpts = deep!.options.map((o) => o.long);
for (const o of ["--count","--provider","--model","--root","--concurrency","--out","--yes"]) {
  expect(deepOpts).toContain(o);
}
```

### E2E Test Pattern
Not applicable — no Playwright config in this repo; this is a CLI/library sprint. Unit tests only.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/index.ts:317` | `registerFleetCommand` | low | Only the internal body of `registerFleetCommand` grows (one new call). Public signature `registerFleetCommand(program)` unchanged. Non-goal: do NOT touch src/cli/index.ts. |
| `src/fleet/index.test.ts` | `runFleet`, `registerFleetCommand` | low | Asserts `fleet` exists, `--concurrency`/`--root`, `manifest` positional. Adding `expand-deep` does not remove/rename anything — must still pass. |
| `src/fleet/expand.test.ts` | `runFleetExpand`, `registerFleetCommand` | low | Asserts `expand` child + its 7 options + `fleet <manifest>` positional. Your additive change leaves all of these byte-identical — must still pass. |
| `src/fleet/decomposer.test.ts` | `decomposeGoal` | none | Untouched module; runs independently. |
| `src/fleet/decomposer-deep.test.ts` | `decomposeGoalDeep` | none | Sprint-1 engine untouched; you only import its export. |

### Existing Tests That Must Still Pass
- `src/fleet/index.test.ts` — tests `runFleet` + `registerFleetCommand` tree (`fleet`, `--concurrency`, `--root`, `manifest` positional). Affected because you grow `registerFleetCommand`; verify it still finds `fleet` and its options.
- `src/fleet/expand.test.ts` — tests `runFleetExpand` write-and-stop/--yes/cred/overwrite + the `expand` subcommand registration (lines 404-453). Verify byte-lock: `expand` child and `fleet <manifest>` positional remain.
- `src/fleet/decomposer.test.ts` and `src/fleet/decomposer-deep.test.ts` — must remain green (AC8 explicitly names decomposer.test.ts; engine + Phase-2 decomposer are non-goals).

### Features That Could Be Affected
- **`fleet <manifest>` (Phase 1)** — shares `registerFleetCommand`; verify the positional + `--concurrency`/`--root` still register (index.test.ts).
- **`fleet expand` (Phase 2)** — shares `registerFleetCommand` and the `fleet` Command object; verify the `expand` child + its 7 options + `runFleetExpand` behavior are unchanged (expand.test.ts).

### Recommended Regression Checks
1. `npm run build` (or `npx tsc --noEmit`) — zero errors (sc-2-1, sc-2-2). Watch for TS2353 if you mistakenly pass `maxRetries` to `decomposeGoalDeep` (see §0).
2. `npx eslint src/fleet/index.ts src/fleet/expand-deep.test.ts` — zero errors (sc-2-3): `consistent-type-imports`, no-unused, `.js` extensions.
3. `npx vitest run src/fleet/` — ALL fleet tests green, including `index.test.ts`, `expand.test.ts`, `decomposer.test.ts`, `decomposer-deep.test.ts`, and the new `expand-deep.test.ts` (AC8).
4. Structural byte-lock check: `git diff src/fleet/index.ts` — confirm ONLY additive hunks (import, two interfaces, runFleetExpandDeep, registerFleetExpandDeepSubcommand, one call line). No deletions inside runFleet/runFleetExpand/registerFleetExpandSubcommand/`fleet <manifest>`.

---

## 8. Implementation Sequence

1. **src/fleet/index.ts — add the import** — `import { decomposeGoalDeep } from "./decomposer-deep.js";` near line 23.
   - Verify: `tsc --noEmit` resolves the module (decomposer-deep.ts exists, Sprint 1).
2. **src/fleet/index.ts — add `FleetExpandDeepOptions` + `FleetExpandDeepDeps` interfaces** (after line 256, with a `// ── runFleetExpandDeep ──` header). `FleetExpandDeepOptions` = same shape as `FleetExpandOptions`; `FleetExpandDeepDeps` = `{ decomposeDeep?: typeof decomposeGoalDeep; runFleet?: typeof runFleet; createClient?: typeof createClient }`.
   - Verify: no type errors; `typeof decomposeGoalDeep` resolves.
3. **src/fleet/index.ts — add `runFleetExpandDeep`** — copy runFleetExpand's body, swap `decomposeFn`→`decomposeDeepFn` resolving `deps?.decomposeDeep ?? decomposeGoalDeep`, and call `decomposeDeepFn({ goal: goalWithHint, client, model })` (DROP `maxRetries` — §0).
   - Verify: `tsc` clean; structurally the only `runFleet` call sits inside `if (opts.yes)`.
4. **src/fleet/index.ts — add `registerFleetExpandDeepSubcommand`** — copy registerFleetExpandSubcommand, change `.command("expand <goal>")`→`.command("expand-deep <goal>")`, update `.description` (e.g. "Robustly decompose a large/ambiguous goal (two-stage plan-then-expand) into a fleet manifest and optionally run it"), keep all 7 options identical, action calls `runFleetExpandDeep` with catch message "Fleet expand-deep failed: ...".
   - Verify: option set identical to expand.
5. **src/fleet/index.ts — wire the call** — add `registerFleetExpandDeepSubcommand(fleet);` on the line IMMEDIATELY AFTER `registerFleetExpandSubcommand(fleet);` (line 345). Edit no other line.
   - Verify: `git diff` shows a single inserted line in registerFleetCommand.
6. **src/fleet/expand-deep.test.ts — create** — clone expand.test.ts structure; cover (a)-(f) from §6. Add the explicit `decompose-failure` test (d) and the FleetManifestSchema validity assertion.
   - Verify: `npx vitest run src/fleet/expand-deep.test.ts` green.
7. **Run full verification** — `npm run build`, `npx eslint src/fleet/index.ts src/fleet/expand-deep.test.ts`, `npx vitest run src/fleet/`.

---

## 9. Pitfalls & Warnings

- **`maxRetries` excess property (§0):** `decomposeGoalDeep`'s input type lacks `maxRetries`. Copying runFleetExpand line 195 verbatim → TS2353 compile error. Call `{ goal: goalWithHint, client, model }` only.
- **Byte-lock:** Do NOT edit `runFleet` (94-127), `runFleetExpand` (169-256), `registerFleetExpandSubcommand` (266-300), or the `fleet <manifest>` `.command/.action` (313-343). AC5/AC8 + evaluator diff the file. Insert only.
- **The new call goes AFTER line 345, not before** — order matters only for byte-lock of line 345 itself; `registerFleetExpandSubcommand(fleet);` must stay byte-identical.
- **`import type` correctness:** In the TEST file, `import type { decomposeGoalDeep }` is right (used only as `typeof` alias — mirror expand.test.ts:9). In `index.ts`, the import is a VALUE import (`decomposeGoalDeep` is the runtime fallback `?? decomposeGoalDeep`), so plain `import { decomposeGoalDeep }`.
- **DeepSeek key in env for happy-path tests:** set `process.env["DEEPSEEK_API_KEY"]="fake-key-for-test"` in beforeEach (the fake createClient ignores it, but mirroring expand.test.ts keeps parity); in the cred-fail test `delete` it.
- **`process.exitCode` not `process.exit`:** the template sets `process.exitCode = 0` (write-and-stop) / `= 1` (action catch). Do not call `process.exit()` — it would kill the test runner.
- **Default output path is shared:** expand-deep uses the SAME default `<root>/.bober/fleet-expand.json` (non-goal: no distinct default path). Don't invent a new default.
- **Don't fold `count` into `DecomposeDeepInput.count`:** even though the type allows it, the verbatim-mirror requirement says fold `--count` into the goal string (`goalWithHint`). Keep the `goalWithHint` pattern.
- **No new top-level CLI wiring:** `registerFleetCommand(program)` at `src/cli/index.ts:317` stays untouched; the new subcommand wires INSIDE `registerFleetCommand`.
