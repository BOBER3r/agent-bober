# Sprint Briefing: fleet expand-deep --critique CLI flag (additive, byte-lock preserved)

**Contract:** sprint-spec-20260618-fleet-expand-deep-critique-2
**Generated:** 2026-06-18T00:00:00Z

---

## TL;DR — The Whole Sprint in 3 Edits + Tests

This is a **CLI-seam-only** sprint. The engine (`decomposeGoalDeep` accepting `critique?:boolean`) already shipped in Sprint 1. You wire ONE flag through ONE file:

1. **Add one field** to `FleetExpandDeepOptions` (`src/fleet/index.ts:261-276`): `critique?: boolean`.
2. **Add one `.option()` line** in `registerFleetExpandDeepSubcommand` (`src/fleet/index.ts:396-432`) and add `critique?: boolean` to the action's inline `opts` type, then pass `opts` straight through (already does).
3. **Change ONE call site** in `runFleetExpandDeep` (`src/fleet/index.ts:325`): add the guarded spread.
4. **Tests** in `src/fleet/expand-deep.test.ts` (edit) OR `src/fleet/expand-deep-critique.test.ts` (new): byte-identity DI assertion + command-tree `--critique` presence.

**ZERO deleted lines in index.ts. Purely additive. Touch no other source file.**

---

## 1. Target Files

### src/fleet/index.ts (modify — additive only)

#### Edit A — `FleetExpandDeepOptions` interface (lines 261-276)

```typescript
export interface FleetExpandDeepOptions {
  /** Soft target for number of children to decompose */
  count?: string;
  /** Override the decomposer LLM provider (default: "openai-compat") */
  provider?: string;
  /** Override the decomposer LLM model (default: "deepseek-v4-pro") */
  model?: string;
  /** Override the manifest rootDir (default: ".") */
  root?: string;
  /** Override manifest concurrency (default: 3) */
  concurrency?: string;
  /** Override the output path for the written manifest */
  out?: string;
  /** When true, chain into runFleet(outPath) after writing */
  yes?: boolean;
  // ADD HERE, after `yes?`:
  // /** When true, run a fresh-context critic gate that re-expands degenerate manifests */
  // critique?: boolean;
}
```
**Rule:** Append `critique?: boolean` as the LAST field (after `yes?`). Do not reorder existing fields (zero deletions).

#### Edit B — the decompose call site in `runFleetExpandDeep` (line 324-325) — THE ONLY BEHAVIORAL CHANGE

Current (`src/fleet/index.ts:324-325`):
```typescript
  const decomposeDeepFn = deps?.decomposeDeep ?? decomposeGoalDeep;
  const decomposed = await decomposeDeepFn({ goal: goalWithHint, client, model });
```
Change line 325 ONLY to:
```typescript
  const decomposed = await decomposeDeepFn({
    goal: goalWithHint,
    client,
    model,
    ...(opts.critique ? { critique: true } : {}),
  });
```
**Rule (ADR-2, arch-...-adr-2.md:15):** The guarded spread `...(opts.critique ? { critique: true } : {})` makes the arg object **structurally byte-identical to Phase 3** when `--critique` is absent — no `critique` key appears at all. Do NOT write `critique: opts.critique` (that would inject a `critique: undefined` key and break byte-identity). Steps 1 (lines 304-315), 3 (327-334), 4 (336-353), 5 (355-363), 6 (365-385) stay **UNTOUCHED**.

#### Edit C — `registerFleetExpandDeepSubcommand` (lines 396-432)

Existing `.option()` block (`src/fleet/index.ts:402-408`):
```typescript
    .option("--count <n>", "Soft target for number of sub-projects")
    .option("--provider <p>", "Override the decomposer LLM provider (default: openai-compat)")
    .option("--model <m>", "Override the decomposer LLM model (default: deepseek-v4-pro)")
    .option("--root <dir>", "Override the manifest rootDir (default: .)")
    .option("--concurrency <c>", "Override manifest concurrency (default: 3)")
    .option("--out <path>", "Override the output path for the written manifest")
    .option("--yes", "Chain into fleet run after writing the manifest")
```
Add EXACTLY ONE line (after `--yes`, per generatorNotes):
```typescript
    .option("--critique", "Run a fresh-context critic gate that re-expands degenerate manifests")
```
Then extend the action's inline `opts` type (`src/fleet/index.ts:412-420`) by adding `critique?: boolean;` after `yes?: boolean;`:
```typescript
        opts: {
          count?: string;
          provider?: string;
          model?: string;
          root?: string;
          concurrency?: string;
          out?: string;
          yes?: boolean;
          critique?: boolean;   // ADD
        },
```
The action body (`src/fleet/index.ts:423`) is `await runFleetExpandDeep(goal, opts);` — `opts` already flows through unchanged, so NO change to the body is needed. The `critique` field is now carried by `opts` automatically.

**Imports this file uses (no new imports needed):**
- `import type { Command } from "commander";` (`src/fleet/index.ts:11`)
- `import { decomposeGoalDeep } from "./decomposer-deep.js";` (`src/fleet/index.ts:24`)
- `import { createClient } from "../providers/factory.js";` (`src/fleet/index.ts:21`)
- `import type { LLMClient } from "../providers/types.js";` (`src/fleet/index.ts:29`)
- `import type { FleetManifest } from "./manifest.js";` (`src/fleet/index.ts:26`)

**Imported by (impact surface):**
- `src/cli/index.ts:38,317` — imports + calls `registerFleetCommand(program)` (the production wiring; additive flag is transparent to it).
- `src/fleet/expand-deep.test.ts:6,11` — `runFleetExpandDeep`, `registerFleetCommand`, `type runFleet`.
- `src/fleet/expand.test.ts:6,10` — `runFleetExpand`, `registerFleetCommand`, `type runFleet`.
- `src/fleet/index.test.ts:6` — `runFleet`, `registerFleetCommand`.

**Test file:** `src/fleet/expand-deep.test.ts` (exists, 538 lines) — primary template. `src/fleet/index.test.ts` and `src/fleet/expand.test.ts` also exercise `registerFleetCommand`.

---

### src/fleet/expand-deep-critique.test.ts (create — OR extend expand-deep.test.ts)

**Directory pattern:** Files in `src/fleet/` use kebab-case `.test.ts` co-located beside the module (`expand-deep.test.ts`, `decomposer-deep.test.ts`, `critic-deep.test.ts`).
**Most similar existing file:** `src/fleet/expand-deep.test.ts` — copy its DI helpers verbatim.
**Decision:** Either editing `expand-deep.test.ts` or creating `expand-deep-critique.test.ts` is contract-valid (estimatedFiles allows both). A NEW file is cleaner for byte-lock auditing (`git diff --name-only` lists `index.ts` + ONE new test file). If you create new, re-declare the DI helpers locally (do not export from the existing test file).

**Structure template (mirror `expand-deep.test.ts:1-63`):**
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { runFleetExpandDeep, registerFleetCommand } from "./index.js";
import { FleetManifestSchema } from "./manifest.js";
import type { FleetManifest } from "./manifest.js";
import type { LLMClient } from "../providers/types.js";
import type { decomposeGoalDeep } from "./decomposer-deep.js";
import type { runFleet } from "./index.js";
import type { createClient } from "../providers/factory.js";

type DecomposeDeepFn = typeof decomposeGoalDeep;
type RunFleetFn = typeof runFleet;
type CreateClientFn = typeof createClient;
// ... copy FAKE_CHILDREN, makeFakeDecomposeDeep, fakeLLMClient, makeFakeClientBuilder ...
```

---

## 2. Patterns to Follow

### Guarded-spread for byte-identical optional threading (ADR-2)
**Source:** `src/fleet/index.ts:104-108` (the runFleet options-override precedent) and ADR-2 `arch-...-adr-2.md:15`.
```typescript
  const effectiveManifest = {
    ...manifest,
    ...(options?.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    ...(options?.rootDir !== undefined ? { rootDir: options.rootDir } : {}),
  };
```
**Rule:** This is the EXACT idiom for the new decompose-call spread — `...(cond ? { key: val } : {})` adds the key only when the condition holds, leaving the object byte-identical otherwise. The codebase already uses it three times in `runFleet` (lines 106-107). Use `...(opts.critique ? { critique: true } : {})`.

### DI seam: optional `deps` param with `??` fallback to the real impl
**Source:** `src/fleet/index.ts:307-308, 324, 368`
```typescript
  const clientBuilder = deps?.createClient ?? createClient;
  ...
  const decomposeDeepFn = deps?.decomposeDeep ?? decomposeGoalDeep;
  ...
    const runFleetFn = deps?.runFleet ?? runFleet;
```
**Rule:** Tests inject fakes via the third `deps` arg (`FleetExpandDeepDeps`, `src/fleet/index.ts:278-282`). Do NOT add a new dep — the existing three (`decomposeDeep`/`runFleet`/`createClient`) are sufficient; `critique` is a flag on `opts`, not a dep.

### Commander subcommand registration via `.command().option().action()`
**Source:** `src/fleet/index.ts:396-432` (expand-deep) and `src/fleet/index.ts:442-476` (expand, identical shape).
```typescript
  fleet
    .command("expand-deep <goal>")
    .description("...")
    .option("--count <n>", "...")
    // ... more .option() ...
    .option("--yes", "Chain into fleet run after writing the manifest")
    .action(async (goal: string, opts: { /* inline type */ }) => {
      try {
        await runFleetExpandDeep(goal, opts);
      } catch (err) { logger.error(...); process.exitCode = 1; }
    });
```
**Rule:** Add the new `.option("--critique", "...")` as a boolean flag (no `<...>` placeholder ⇒ Commander treats it as a boolean). Extend the inline action `opts` type to keep `tsc` strict-clean.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `decomposeGoalDeep` | `src/fleet/decomposer-deep.ts:170` (declared via `DecomposeDeepInput`:82-90) | `(input: DecomposeDeepInput): Promise<FleetManifest>` | Two-stage plan→expand; **already accepts `critique?: boolean` at line 89** (Sprint 1). Routes through `runCritiqueLoop` when `critique===true`. |
| `createClient` | `src/providers/factory.js` (imported `src/fleet/index.ts:21`) | `(provider, endpoint, providerConfig, model, role) => LLMClient` | Builds the DeepSeek client; throws synchronously on missing `DEEPSEEK_API_KEY` (credential fail-fast). |
| `validateApiKey` | `src/providers/factory.js` (imported `src/fleet/index.ts:21`) | — | Credential validation; reused by `validateManifestCredentials` (`src/fleet/index.ts:48-72`). |
| `runFleet` | `src/fleet/index.ts:95-128` | `(manifestPath, options?, deps?) => Promise<PortfolioReport>` | The spawn step gated behind `--yes`; injected as a spy in tests. |
| `ensureDir` | `src/state/helpers.js` (imported `src/fleet/index.ts:25`) | — | Creates the parent dir before the atomic write. |
| `FleetManifestSchema` | `src/fleet/manifest.ts:13-18` | Zod `z.object({rootDir, concurrency, children: z.array(FleetChildSchema).min(1)})` | Validates the written manifest; `children` carry only `folder`/`task` (`src/fleet/manifest.ts:7-8`). Used in `expect(FleetManifestSchema.safeParse(parsed).success).toBe(true)`. |
| `runCritiqueLoop` | `src/fleet/critic-deep.ts` (imported `src/fleet/decomposer-deep.ts:5`) | — | The Sprint-1 critique engine. **Already wired into decomposer-deep — DO NOT touch from this sprint.** |
| `logger` | `src/utils/logger.js` (imported `src/fleet/index.ts:22`) | `.error(msg)` | Action-body error logging. |

**Utilities reviewed:** `src/utils/`, `src/state/helpers.js`, `src/providers/factory.js`, `src/fleet/manifest.ts` — all relevant ones listed above. No new utility is needed for this sprint.

---

## 4. Prior Sprint Output

### Sprint 1: critique engine (critic-deep.ts) + opt-in threading
**Created:** `src/fleet/critic-deep.ts` — exports `runCritiqueLoop`, `getCriticVerdict`, `callCritic`, `validateVerdict`, `CritiqueVerdictSchema`, `DEEP_CRITIQUE_MAX_TOTAL_CALLS`, `CRITIQUE_MAX_ROUNDS`.
**Modified:** `src/fleet/decomposer-deep.ts` — added `critique?: boolean` to `DecomposeDeepInput` (`src/fleet/decomposer-deep.ts:89`):
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
`decomposeGoalDeep` routes into `runCritiqueLoop` only when `critique===true`; absent/false ⇒ byte-identical Phase-3 path (`src/fleet/decomposer-deep.ts:1-5` imports `runCritiqueLoop`).
**Connection to this sprint:** This sprint ONLY wires the `--critique` CLI flag through to that already-existing `critique` field. The engine is done. You add nothing to `decomposer-deep.ts` or `critic-deep.ts` — passing `{ critique: true }` into the existing decompose call is the entire integration.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` consulted for this sprint (CLI-seam additive change). Governing constraints come from the architecture doc and ADRs below.

### Architecture Decisions
- **ADR-2** (`arch-20260618-fleet-expand-deep-critique-adr-2.md`): Opt-in `critique?: boolean` + guarded spread `...(opts.critique?{critique:true}:{})` makes the `--critique`-absent decompose arg object **structurally identical** to Phase 3. **Risk (adr-2.md:19):** "If a future edit reads `opts.critique` outside the guarded spread, the default path silently diverges — mitigated by a byte-identity regression test." This sprint MUST include that test.
- **ADR-5** (`arch-20260618-fleet-expand-deep-critique-adr-5.md`): Critic gate runs AFTER `validateManifest` and BEFORE the atomic write — that ordering lives inside `decomposeGoalDeep` (Sprint 1), NOT in `runFleetExpandDeep`. **For this sprint:** the gate ordering is already correct because `decomposeGoalDeep` returns to `index.ts:325` ahead of the Step-4 write (`index.ts:348-349`). You do NOT manage ordering — just confirm the decompose return still precedes the write (it does; lines 325 → 348).
- **Main architecture** (`arch-...-architecture.md:24, 34`): LOCK1 = fresh critic (Sprint-1 concern, done). **LOCK2 = `--critique` is a boolean flag on the EXISTING `expand-deep` subcommand, NOT a sibling `expand-deep-critique` command.** Do not add a sibling.

### Other Docs
`COMMANDS.md` and `docs/sprints/` exist but are docs-only (changed in HEAD~2; not source). No `CLAUDE.md` coding-rule changes apply.

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/fleet/expand-deep.test.ts` (this file is the direct template).
**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach:** `vi.fn()` spies + hand-rolled fakes injected via the `deps` arg. **File naming:** `<module>.test.ts`, co-located in `src/fleet/`.

**DI helpers to reuse verbatim (`src/fleet/expand-deep.test.ts:23-63`):**
```typescript
const FAKE_CHILDREN: FleetManifest["children"] = [
  { folder: "api-server", task: "Build a REST API server with Express" },
  { folder: "web-frontend", task: "Build a React frontend application" },
];

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
  return (_provider, _endpoint, _providerConfig, _model, _role) => fakeLLMClient;
}
```

**Byte-identity / threading test (AC sc-2-5) — the critical new test.** Capture the decompose arg object by recording it inside the fake:
```typescript
it("WITHOUT --critique the decompose arg has NO critique key; WITH --critique it receives critique:true", async () => {
  const argsSeen: Array<Record<string, unknown>> = [];
  const recordingDecompose: DecomposeDeepFn = async (input) => {
    argsSeen.push(input as unknown as Record<string, unknown>);
    return { rootDir: ".", concurrency: 3, children: FAKE_CHILDREN };
  };

  // no-flag path
  await runFleetExpandDeep("g", { out: join(tmpDir, "a.json"), root: tmpDir },
    { decomposeDeep: recordingDecompose, runFleet: vi.fn() as unknown as RunFleetFn,
      createClient: makeFakeClientBuilder() });
  expect("critique" in argsSeen[0]!).toBe(false);      // byte-identity: key ABSENT

  // --critique path
  await runFleetExpandDeep("g", { out: join(tmpDir, "b.json"), root: tmpDir, critique: true },
    { decomposeDeep: recordingDecompose, runFleet: vi.fn() as unknown as RunFleetFn,
      createClient: makeFakeClientBuilder() });
  expect(argsSeen[1]!["critique"]).toBe(true);          // flag threaded
});
```
Note: assert `"critique" in argsSeen[0]` is `false` (key truly absent), NOT `argsSeen[0].critique === undefined`. The guarded spread must leave NO key. For "zero extra chat calls" you can also assert the fake `recordingDecompose` was invoked exactly once per call (it does not itself call chat, so no extra LLMClient.chat fires on the no-flag path — the fake decompose stands in for the whole engine).

**Write-and-stop + --yes-gate templates already exist** — mirror `expand-deep.test.ts:86-117` (write-and-stop, runFleet NOT called), `:178-201` (--yes calls runFleet once with `outPath` after file exists), `:269-291` (credential fail-fast: throwing client ⇒ no file, decompose never called), `:293-317` (createClient throws before decompose). Re-run these same scenarios but pass `{ critique: true }` to prove the critique path preserves all spawn-safety invariants (AC sc-2-4, sc-2-7).

### Command-tree / byte-lock test (AC sc-2-6)
**Source:** `src/fleet/expand-deep.test.ts:452-537` — reuse this exact `registerFleetCommand(new Command())` pattern.
```typescript
it("expand-deep now exposes --critique alongside the existing 7 options", () => {
  const program = new Command();
  registerFleetCommand(program);
  const fleet = program.commands.find((c) => c.name() === "fleet")!;
  const deep = fleet.commands.find((c) => c.name() === "expand-deep")!;
  const deepOpts = deep.options.map((o) => o.long);
  expect(deepOpts).toContain("--critique");
  for (const o of ["--count","--provider","--model","--root","--concurrency","--out","--yes"])
    expect(deepOpts).toContain(o);          // existing 7 intact
});

it("byte-lock: fleet <manifest> positional + --concurrency/--root + expand subcommand intact", () => {
  const program = new Command();
  registerFleetCommand(program);
  const fleet = program.commands.find((c) => c.name() === "fleet")!;
  expect(fleet.usage()).toContain("manifest");                       // positional
  const fleetOpts = fleet.options.map((o) => o.long);
  expect(fleetOpts).toContain("--concurrency");
  expect(fleetOpts).toContain("--root");
  const subNames = fleet.commands.map((c) => c.name());
  expect(subNames).toContain("expand");                              // sibling intact
  expect(subNames).toContain("expand-deep");
  expect(subNames).not.toContain("expand-deep-critique");           // LOCK2: no sibling cmd
});
```
**Selector convention:** Commander tree introspection — `program.commands.find(c => c.name() === ...)`, `.options.map(o => o.long)`, `.usage()`. (No data-testid / Playwright; this is a CLI, no E2E layer.)

### E2E Test Pattern
Not applicable — `src/fleet/` has no Playwright/E2E layer. All verification is vitest unit tests with Commander-tree introspection.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/index.ts:38,317` | `registerFleetCommand` from `../fleet/index.js` | low | Pure additive flag; the production wiring `registerFleetCommand(program)` is unchanged. No edit needed. |
| `src/fleet/expand-deep.test.ts` | `runFleetExpandDeep`, `registerFleetCommand` | low | Existing assertions (7-option set, expand sibling, positional) must still hold — adding `--critique` does not remove any. If you EDIT this file, keep all 538 existing lines. |
| `src/fleet/expand.test.ts` | `registerFleetCommand`, `runFleetExpand` | low | Asserts `expand` subcommand option set — unaffected (you touch only `expand-deep`). |
| `src/fleet/index.test.ts` | `runFleet`, `registerFleetCommand` | low | Tests `fleet <manifest>` run path — unaffected. |

### Existing Tests That Must Still Pass (the five fleet suites, AC sc-2-8)
- `src/fleet/decomposer.test.ts` — tests `decomposeGoal`/`validateManifest`; untouched module, verify still green.
- `src/fleet/decomposer-deep.test.ts` — tests `decomposeGoalDeep` incl. Sprint-1 `critique` routing; you do not edit `decomposer-deep.ts`, verify green.
- `src/fleet/expand.test.ts` — tests `runFleetExpand` + `expand` command tree; verify green (no overlap).
- `src/fleet/expand-deep.test.ts` — tests `runFleetExpandDeep` write-and-stop/--yes/credential/command-tree; **directly adjacent — most likely to regress if you mis-edit `index.ts`.** Verify all 30+ assertions green.
- `src/fleet/index.test.ts` — tests `runFleet` + `registerFleetCommand`; verify green.
- (Also: `src/fleet/critic-deep.test.ts` — Sprint-1 engine tests; untouched, verify green.)

### Features That Could Be Affected
- **`fleet expand` (Phase-2 sibling)** — shares `registerFleetCommand` and the `index.ts` module. Verify its option set (`expand.test.ts:520-536`) and the sibling check (`expand-deep.test.ts:464-473`) still pass. The `expand` subcommand must NOT gain `--critique`.
- **`fleet <manifest>` (Phase-1 run path)** — byte-locked positional + `--concurrency`/`--root`. Verify intact (`expand-deep.test.ts:475-494`).

### Recommended Regression Checks (concrete, runnable)
1. `npm run build` — tsc clean after additive edits (AC sc-2-1).
2. `npx vitest run src/fleet/` — all fleet suites green (AC sc-2-8).
3. `npm test` — full suite green, no cross-module regression.
4. `git diff -- src/fleet/index.ts | grep '^-[^-]'` — **must be EMPTY** (zero deleted lines; purely additive, AC sc-2-8 / evaluatorNotes).
5. `git diff HEAD~1 HEAD --name-only` — must list ONLY `src/fleet/index.ts` and the one test file. `decomposer-deep.ts`, `critic-deep.ts`, `decomposer.ts`, `manifest.ts`, `cli/index.ts` must NOT appear.
6. `npx eslint src/fleet/index.ts <test-file>` — lint clean (AC sc-2-3, optional).

---

## 8. Implementation Sequence

1. **`src/fleet/index.ts` — `FleetExpandDeepOptions`** (lines 261-276): append `critique?: boolean;` after `yes?`.
   - Verify: `tsc` still resolves; no field reordered.
2. **`src/fleet/index.ts` — `registerFleetExpandDeepSubcommand`** (lines 396-432): add one `.option("--critique", "...")` after `--yes`; add `critique?: boolean;` to the inline action `opts` type. Action body `await runFleetExpandDeep(goal, opts)` unchanged.
   - Verify: `npm run build` clean; Commander accepts the boolean flag.
3. **`src/fleet/index.ts` — `runFleetExpandDeep` decompose call** (line 325): replace the single-line call with the multi-line guarded spread `...(opts.critique ? { critique: true } : {})`. Steps 1/3/4/5/6 untouched.
   - Verify: `git diff -- src/fleet/index.ts | grep '^-[^-]'` is empty (the only "deletion" is the single decompose line being expanded — to keep it truly additive, prefer wrapping rather than reformatting; if line 325 must change, that one logical line edit is acceptable as the sole behavioral change per generatorNotes, but minimize deleted-line count).
4. **Tests** (`src/fleet/expand-deep-critique.test.ts` new, or extend `expand-deep.test.ts`): byte-identity threading test (key absent without flag, `critique:true` with flag), command-tree `--critique` presence + byte-lock (positional/expand sibling/no sibling command), and re-run write-and-stop + --yes + credential-fail-fast with `{ critique: true }`.
   - Verify: `npx vitest run src/fleet/` green.
5. **Full verification** — `npm run build` && `npm test`; then the git-diff byte-lock checks (Section 7 #4, #5).

---

## 9. Pitfalls & Warnings

- **Byte-identity killer:** Writing `critique: opts.critique` (or `critique: opts.critique ?? false`) injects a `critique` key on the no-flag path and breaks AC sc-2-5. Use ONLY the guarded spread `...(opts.critique ? { critique: true } : {})` (ADR-2, adr-2.md:15).
- **Assert key ABSENCE, not undefined:** The byte-identity test must assert `"critique" in arg === false`, NOT `arg.critique === undefined`. The spread leaves no key at all.
- **LOCK2 — no sibling command:** Do NOT add `expand-deep-critique` as a sibling subcommand. `--critique` is a boolean flag on the EXISTING `expand-deep` (architecture.md:34, generatorNotes). Add a regression assertion `expect(subNames).not.toContain("expand-deep-critique")`.
- **Do NOT touch the engine:** `decomposer-deep.ts` already has `critique?: boolean` (line 89) and routes to `runCritiqueLoop`. Editing it (or `critic-deep.ts`) violates the byte-lock and will fail evaluatorNotes check #1.
- **Boolean flag syntax:** `.option("--critique", "...")` with NO `<placeholder>` — Commander then sets `opts.critique = true` only when the flag is passed (undefined otherwise), which the guarded spread handles correctly.
- **Strict TS:** Add `critique?: boolean;` to the inline action `opts` type literal (`index.ts:412-420`) too, or `tsc` strict mode will not type the new field on `opts` and the build (AC sc-2-1/sc-2-2) fails. No explicit `any`; use `import type` for type-only imports (already the file convention, e.g. `index.ts:26,29`).
- **Five existing fleet suites must stay green:** The adjacent `expand-deep.test.ts` is most sensitive — if you edit it rather than create a new file, preserve all 538 lines and only ADD tests.
- **Zero deleted lines in index.ts:** Keep the edit purely additive. The decompose-call expansion (line 325 → multi-line) is the one logical line that changes; everything else is insertion. Confirm with `git diff -- src/fleet/index.ts | grep '^-[^-]'`.
- **Commit scope:** Only `src/fleet/index.ts` + the one test file, message `bober(sprint-2): fleet expand-deep --critique flag, byte-lock preserved`.
