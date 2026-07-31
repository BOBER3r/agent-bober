# Sprint Briefing: Init flow — solo vs team docs question

**Contract:** sprint-spec-20260731-documenter-docs-output-3
**Generated:** 2026-07-31T00:00:00Z

> **Headline findings (read first):**
> 1. `src/discovery/config-generator.ts` **never emits a `documenter` section** — it returns only `{ strategies, commands }` (`config-generator.ts:237-279`). **Do not touch it or `config-generator.test.ts`.** The "golden snapshot" from commit 255f992 is not there — it lives in `src/config/schema.test.ts:945` (repo's own `bober.config.json`) and `:1297` (`minimalBase` golden). Both stay green as long as you do **not** add `documenter` to `createDefaultConfig` and do **not** edit the repo's own `bober.config.json`.
> 2. The **non-interactive init path already exists and already satisfies sc-3-2 with zero code changes**: `src/mcp/tools/init.ts` (the `bober_init` MCP tool) never imports `prompts` and emits no `documenter` section → `config.documenter?.docsMode ?? "committed"` (`documenter-agent.ts:79`) resolves to `committed`. Assert this in a test; do not add flags.
> 3. **Never write a fully-materialized documenter section.** `DocumenterSectionSchema.parse({ docsMode })` would also materialize `model: "sonnet"`, and `documenter-agent.ts:247` reads `config.documenter?.model ?? config.generator.model` — that would silently override the user's chosen generator model (e.g. `openai` + `"sonnet"` → broken documenter). Emit **only** `{ docsMode }`.

---

## 1. Target Files

### `src/cli/commands/init.ts` (modify) — 1190 lines, the only file that needs code changes

There are **three** config-writing flows, each with its own `prompts` block and its own `writeConfig(...)` call. All three funnel through `writeConfig` (`:1128`).

**Prompt-helper pattern to copy — `askProvider`, lines 144-180:**
```ts
/**
 * Ask the user which AI provider they want to use.
 * Returns null if the user cancels.
 */
async function askProvider(): Promise<SupportedProvider | null> {
  const { provider } = await prompts({
    type: "select",
    name: "provider",
    message: "Which AI provider?",
    choices: [
      {
        title: "Anthropic (Claude)",
        description: "Opus, Sonnet, Haiku — requires ANTHROPIC_API_KEY",
        value: "anthropic",
      },
      // ... 3 more
    ],
    initial: 0,
  });

  if (provider === undefined) return null;
  return provider as SupportedProvider;
}
```

**Non-aborting fallback pattern (use this, not the cancel-and-abort pattern) — lines 138-141:**
```ts
  return {
    plannerModel: (answers.plannerModel as string | undefined) ?? opts.planner[opts.defaultPlanner]?.value ?? "sonnet",
    generatorModel: (answers.generatorModel as string | undefined) ?? opts.generator[opts.defaultGenerator]?.value ?? "sonnet",
  };
```

**Insertion point 1 — `brownfieldFlow`, lines 611-651** (deep-scan flow; asks after the "Look good?" confirm at `:585`):
```ts
  // ── Step 5: Provider + model selection ────────────────────────
  const provider = await askProvider();
  if (provider === null) { logger.info("Init cancelled."); return; }

  const { plannerModel, generatorModel } = await askModelPreferences(provider);
  // <-- ASK docsMode HERE (line 618)

  // ── Step 6: Build config using discovered strategies/commands ─
  const mode: ProjectMode = "brownfield";
  const defaults = getDefaults(mode);

  const config = createDefaultConfig(projectName, mode, undefined, { /* planner/generator/evaluator/commands */ });

  // Write bober.config.json first (synthesizePrinciples needs a BoberConfig)
  await writeConfig(projectRoot, config, mode, evalConfig.strategies, undefined, provider);   // :651
```
NOTE: `config` is reused at `:658` (`synthesizePrinciples(report, projectRoot, config)`) — pass the **original** `BoberConfig` there and the merged object only to `writeConfig`.

**Insertion point 2 — `brownfieldManualFlow`, lines 711-765** (fallback when the user answers "Look good? → no"; `brownfieldFlow` returns right after at `:595`, so there is no double-ask):
```ts
  const provider = await askProvider();
  if (provider === null) { logger.info("Init cancelled."); return; }

  // Ask model preferences (conditional on provider)
  const { plannerModel, generatorModel } = await askModelPreferences(provider);   // :719  <-- ASK docsMode after this
  ...
  await writeConfig(projectRoot, config, mode, strategies, undefined, provider);  // :765
```

**Insertion point 3 — `greenfieldFlow`, lines 842-904:**
```ts
  const { plannerModel, generatorModel } = await askModelPreferences(provider);   // :850  <-- ASK docsMode after this
  ...
  // Attach description if provided
  if (description) {
    config.project.description = description;                                     // :900-902 — post-construction mutation precedent
  }

  await writeConfig(projectRoot, config, mode, strategies, selectedPreset, provider);  // :904
```

**The serialization seam — `ConfigShape` + `writeConfig`, lines 1116-1140:**
```ts
interface ConfigShape {
  project: { name: string; mode: string; preset?: string; description?: string };
  planner: { model: string; provider?: string };
  generator: { model: string; provider?: string };
  evaluator: { strategies: Array<{ type: string }>; provider?: string };
}

async function writeConfig(
  projectRoot: string,
  config: ConfigShape,
  mode: ProjectMode,
  strategies: Array<{ type: string; required: boolean }>,
  preset?: string,
  provider?: SupportedProvider,
): Promise<void> {
  // Write config
  const configPath = join(projectRoot, "bober.config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  logger.success(`Created ${configPath}`);
  ...
```
`ConfigShape` is a **local structural subset** — `JSON.stringify(config, ...)` serializes whatever is on the object. Add an optional `documenter?: { docsMode: DocumenterDocsMode }` field so the merged object is explicitly typed (and, optionally, so the summary block at `:1165-1181` can print it).

**Imports this file uses (lines 1-16):** `node:fs/promises` (`writeFile, readFile, appendFile, readdir`), `node:path`, `node:url`, `prompts`, `chalk`, `type { EvalStrategyType, ProjectMode }` + `createDefaultConfig` from `../../config/schema.js`, `configExists` from `../../config/loader.js`, `getDefaults, getPresetNames` from `../../config/defaults.js`, `ensureBoberDir`, `fileExists, ensureDir`, `logger`, `scanProject`, `generateEvalConfig`, `synthesizePrinciples`.
You will add: `import type { DocumenterDocsMode } from "../../config/schema.js";` (or extend the existing `import type { EvalStrategyType, ProjectMode }` line at `:7` — `consistent-type-imports` is **error**-level).

**Imported by:** `src/cli/index.ts:11` (`runInitCommand`), `src/cli/commands/update.ts:25` (`installClaudeCommands` only).
**Test file:** `src/cli/commands/init.test.ts` — **does not exist** (this sprint should create it).

---

### `src/discovery/config-generator.ts` (listed as modify — **recommendation: leave untouched**)

**Full public surface (lines 237-279):**
```ts
export interface EvalConfig {
  strategies: EvalStrategy[];
  commands: CommandsSection;
}

export function generateEvalConfig(report: DiscoveryReport): EvalConfig {
  const commands = generateCommands(report);
  const coreStrategies = generateCoreStrategies(report);
  ...
  return { strategies, commands };
}
```
It has **no documenter awareness and no config-assembly role** — `init.ts:507` and `mcp/tools/init.ts:110` merge its result into `evaluator.strategies` / `commands`. Adding a `docsMode` here would (a) require widening `EvalConfig`, (b) perturb every one of the ~40 `expect(result.commands)/expect(result.strategies)` assertions in `config-generator.test.ts` (570 lines), and (c) buy nothing, since the interactive answer is not derivable from a scan. **Keep the change on the interactive-question path only** and record the deviation in the completion notes.

**Imported by:** `src/index.ts:203`, `src/discovery/index.ts:12-13`, `src/cli/commands/init.ts:15`, `src/mcp/tools/init.ts:18`, `src/discovery/config-generator.test.ts:11`.
**Test file:** `src/discovery/config-generator.test.ts` (exists — should stay byte-identical).

---

### `src/cli/commands/init.test.ts` (create — replaces `config-generator.test.ts` in the contract's file list)

**Directory pattern:** co-located `<name>.test.ts` next to `<name>.ts` in `src/cli/commands/` (`run.test.ts`, `telemetry.test.ts`, `plan.test.ts`, `do.test.ts`, …). Required by `.bober/principles.md`: "Tests are collocated with source (`*.test.ts` next to `*.ts`)".
**Most similar existing file:** `src/cli/commands/run.test.ts` (header docblock naming the criteria, `vi.mock` of heavy deps, dynamic `await import("./x.js")` inside each test, tmpdir lifecycle).
**Structure template:**
```ts
/**
 * Colocated unit tests for the bober init solo-vs-team docs question.
 *
 * sc-3-1: interactive init writes documenter.docsMode 'committed' (solo) / 'local' (team).
 * sc-3-2: non-interactive paths never prompt and resolve to 'committed'.
 */

import { describe, it, expect } from "vitest";
import prompts from "prompts";
import { DocumenterSectionSchema } from "../../config/schema.js";

describe("askDocsMode — interactive (sc-3-1)", () => {
  it("returns 'local' when the team choice is injected", async () => {
    const { askDocsMode } = await import("./init.js");
    prompts.inject(["local"]);
    expect(await askDocsMode(true)).toBe("local");
  });
});
```

---

## 2. Patterns to Follow

### Question wording / choice style
**Source:** `src/cli/commands/init.ts`, lines 466-485
```ts
  const { projectKind } = await prompts({
    type: "select",
    name: "projectKind",
    message: "Are you starting a new project or working with existing code?",
    choices: [
      { title: "New project (greenfield)", description: "Start from scratch with optional preset", value: "greenfield" },
      { title: "Existing codebase (brownfield)", description: "Auto-detect stack and use conservative settings", value: "brownfield" },
    ],
    initial: 0,
  });
```
**Rule:** one `prompts({ type: "select", name, message, choices: [{title, description, value}], initial: 0 })` object; `message` is a short sentence ending in `?` or `:`; the default answer is `initial: 0`; the human explanation goes in `description`, never in `title`.

### TTY guard for non-interactive environments
**Source:** `src/orchestrator/checkpoints/mechanisms/cli.ts`, lines 107-113
```ts
    // TTY guard — fall back to noop in CI / non-interactive environments.
    if (!process.stdin.isTTY) {
      process.stderr.write(
        `warn: CLI checkpoint "${checkpoint}" requested but stdin is not a TTY; auto-approving via noop.\n`,
      );
      return this.fallback.request(checkpoint, artifact);
    }
```
**Rule:** guard on `process.stdin.isTTY` before prompting and fall back to the documented default instead of aborting.

### Injectable TTY flag (makes the guard unit-testable)
**Source:** `src/cli/commands/do.ts`, lines 69-70 and 151
```ts
  /** Whether stdout is a TTY. Defaults to process.stdout.isTTY. */
  isTTY?: boolean;
...
  const isTTY = deps.isTTY ?? process.stdout.isTTY ?? false;
```
**Rule:** accept the TTY flag as an optional parameter defaulting to `process.std*.isTTY ?? false`, so tests can drive both branches without touching globals. Recommended signature:
```ts
export async function askDocsMode(isTTY: boolean = process.stdin.isTTY ?? false): Promise<DocumenterDocsMode>
```

### Optional config sections are never materialized into the default config
**Source:** `src/config/schema.test.ts`, lines 1361-1364
```ts
  it("createDefaultConfig never sets a seo section (default config stays byte-identical)", () => {
    // Mirrors the egress-axis idiom (Pattern A): new opt-in sections are never
    // added to createDefaultConfig's base — only BoberConfigSchema.optional().
    expect(Object.hasOwn(BoberConfigSchema.parse(minimalBase), "seo")).toBe(false);
  });
```
**Rule:** do **not** add `documenter` to `createDefaultConfig`'s `base` (`schema.ts:909-959`) — attach it at the init call site only.

### Explicit-defaults house style in init's config assembly
**Source:** `src/cli/commands/init.ts`, lines 640-647
```ts
    evaluator: {
      model: generatorModel,
      strategies: evalConfig.strategies,
      maxIterations: defaults.evaluator?.maxIterations ?? 3,
      provider,
      panel: { enabled: false, lenses: [], maxConcurrent: 4 },
    },
    commands: evalConfig.commands,
```
**Rule:** init writes resolved values explicitly even when they equal the schema default (`maxIterations: 3`, `panel`, `branchPattern`). So writing `"documenter": { "docsMode": "committed" }` for the solo answer matches house style and satisfies sc-3-1 literally. (Omitting it is *also* runtime-equivalent — see §5 — but only sc-3-2 explicitly permits omission.)

### Section headers in long files
**Source:** `src/cli/commands/init.ts:182`, `:219`, `:415`, `:907`
```ts
// ── Preset metadata ──────────────────────────────────────────────
```
**Rule:** if you add a helper block, head it with a `// ── Name ───` unicode rule (also mandated by `.bober/principles.md`).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `askProvider` | `src/cli/commands/init.ts:148` | `(): Promise<SupportedProvider \| null>` | Provider select question — the template for the new question |
| `askModelPreferences` | `src/cli/commands/init.ts:93` | `(provider): Promise<{plannerModel, generatorModel}>` | Model questions; shows the `?? fallback` (never-abort) idiom |
| `buildStrategyChoices` | `src/cli/commands/init.ts:909` | `(suggested: EvalStrategyType[]) => Array<{title,value,selected}>` | Builds multiselect choices |
| `writeConfig` | `src/cli/commands/init.ts:1128` | `(projectRoot, config: ConfigShape, mode, strategies, preset?, provider?) => Promise<void>` | **The single serialization point** — writes `bober.config.json`, `.bober/`, `.gitignore`, slash commands, summary |
| `installClaudeCommands` | `src/cli/commands/init.ts:994` | `(projectRoot, mode, preset?) => Promise<void>` | Copies skills/agents; also used by `update.ts` — do not disturb |
| `createDefaultConfig` | `src/config/schema.ts:903` | `(projectName, mode, preset?, overrides: Partial<Omit<BoberConfig,"project">>) => BoberConfig` | Base config factory. `overrides.documenter` requires a **full** `DocumenterSection` — do not use it for a partial |
| `DocumenterDocsModeSchema` / `DocumenterDocsMode` | `src/config/schema.ts:304-305` | `z.enum(["committed","local","external"])` | The mode union — import the **type** for the helper's return type; use the schema if you want runtime validation of the answer |
| `DocumenterSectionSchema` | `src/config/schema.ts:312-342` | `z.object({... docsMode: default("committed"), docsDir: optional()})` | Parses a partial `{ docsMode }`; **materializes `model:"sonnet"` etc. — do not persist its output** |
| `BoberConfigSchema` | `src/config/schema.ts` (`documenter: DocumenterSectionSchema.optional()` at `:845`) | `.parse(unknown): BoberConfig` | Use in tests to prove the generated config validates |
| `resolveSprintDocPath` | `src/orchestrator/documenter-agent.ts:74` | `(config, projectRoot, contractId) => string` | Sprint-1 resolver — reads `config.documenter?.docsMode ?? "committed"` (`:79`); use it to prove an omitted section resolves to `committed` |
| `ensureGitignoreEntry` | `src/utils/git.ts:163` | `(projectRoot, entry) => Promise<boolean>` | Sprint-1 helper; the documenter calls it in `local` mode. **Init must not call it** — gitignoring is the documenter's runtime pre-step |
| `fileExists` / `ensureDir` | `src/utils/fs.ts:10` / `:45` | `(path) => Promise<boolean>` / `Promise<void>` | fs predicates |
| `readJson` / `writeJson` | `src/utils/fs.ts:24` / `:34` | generic JSON helpers | JSON I/O |
| `logger` | `src/utils/logger.ts` | `.phase/.info/.warn/.success/.error` | All init console output goes through this or `chalk` |
| `configExists` / `loadConfig` | `src/config/loader.ts:91` / `:142` | `(projectRoot) => Promise<boolean>` / `Promise<BoberConfig>` | Config presence / load |
| `getDefaults` / `getPresetNames` | `src/config/defaults.ts:283` / `:54` | `(mode, preset?) => Partial<BoberConfig>` / `() => string[]` | Mode/preset defaults |
| `ensureBoberDir` | `src/state/index.ts` | `(projectRoot) => Promise<void>` | Creates `.bober/` tree |
| `generateEvalConfig` | `src/discovery/config-generator.ts:251` | `(report) => EvalConfig` | Strategies+commands from a scan (no documenter) |
| `scanProject` | `src/discovery/scanner.ts` | `(projectRoot) => Promise<DiscoveryReport>` | Brownfield deep scan |
| `synthesizePrinciples` | `src/discovery/synthesizer.ts` | `(report, projectRoot, config) => Promise<string>` | LLM principles synthesis (needs a real `BoberConfig`) |

---

## 4. Prior Sprint Output

### Sprint 1: TS runtime (`c0d97c5` + `4155e53`)
**Modified `src/config/schema.ts`** — exports `DocumenterDocsModeSchema` / `DocumenterDocsMode` (`:304-305`), `documenter.docsMode` with `.default("committed")` (`:331`), optional `documenter.docsDir` (`:341`); `documenter: DocumenterSectionSchema.optional()` on `BoberConfigSchema` (`:845`).
**Modified `src/orchestrator/documenter-agent.ts`** — `resolveSprintDocPath` (`:74`), `buildDocumenterUserMessage` (`:122`), `runDocumenter` (`:237`). Every read is defensive: `config.documenter?.docsMode ?? "committed"` (`:79`, `:281`), `config.documenter?.model ?? config.generator.model` (`:247`), `config.documenter?.maxTurns ?? 20` (`:249`).
**Added `ensureGitignoreEntry`** in `src/utils/git.ts:163`.
**Connection to this sprint:** this sprint only has to *write* the key that sprint 1 already reads. Two consequences: (a) an **omitted** `documenter` section is already equivalent to `docsMode: "committed"`; (b) a **partially** written section is safe, but a fully materialized one is not (it pins `model: "sonnet"` over the user's generator model).

### Sprint 2: md surfaces + docs (`3938793`)
**Modified (markdown only):** `README.md` (config block at `:858-865` incl. the solo/team recipes), `VISION.md:374-375`, `CHANGELOG.md`, `skills/bober.{sprint,run}/SKILL.md`, `agents/bober-documenter.md`, the 3 `.claude/` mirrors.
**Connection to this sprint:** the user-facing wording is already fixed and should be reused verbatim in the question copy — README `:863-865`: *"solo repo (default): docs/sprints/<id>.md, committed with the code"* vs *"team: on-disk, gitignored, never committed"*. `docs/sprints/README.md:2464` already announces this sprint ("`bober init` solo-vs-team question — **sprint 3**"). No md file *needs* editing for sc-3-1..3; a CHANGELOG line is optional and low-risk.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- "**Zod for config validation.** All configuration schemas are Zod schemas in `config/schema.ts` … No hand-rolled validation." → derive the answer type from `DocumenterDocsModeSchema`, don't re-declare the union.
- "**Type safety:** strict mode incl. `noUnusedLocals`, `noUnusedParameters` … Zero type errors is a hard gate." → an unused import or param fails the build.
- "**Use `type` imports.** ESLint enforces `consistent-type-imports`." → `import type { DocumenterDocsMode }`.
- "**Tests are collocated** (`*.test.ts` next to `*.ts`)" and "**No test mocks for filesystem** — tests that need filesystem state create temp directories and clean up."
- "**ESM everywhere** … All imports use `.js` extensions for NodeNext resolution."
- "**Section comments.** `// ── Section Name ──`."
- "**Small utility modules**"; "**No `any` without justification**".

### Architecture Decisions
No ADR covers init prompting. `docs/storage.md:155` documents the sprint-doc record location and the sprint-1 `docsMode`/`docsDir` semantics — it is already accurate and needs no change. `.bober/architecture/` contains no init/documenter ADR relevant here.

### Other Docs
- `README.md:858-865` — the canonical config block and the three solo/team recipes (source of the question copy).
- `README.md:1330` — Documenter role description, already mode-aware.
- `docs/sprints/README.md:2464` — "`bober init` solo-vs-team question — **sprint 3**; until it lands, a non-default `docsMode` is a hand-edit."
- `package.json:12-17` — `build: tsc`, `lint: eslint src/`, `typecheck: tsc --noEmit`, `test: vitest` (**watch mode** — use `npx vitest run` for one-shot).
- `tsconfig.json` excludes `**/*.test.ts`, so the new test file is **not** typechecked by `npm run typecheck`/`build`; it **is** linted (`eslint src/` matches `src/**/*.ts`). Keep the test file lint-clean (no `any`, no unused vars).

### The `docsMode` values as the schema documents them (`src/config/schema.ts:320-331`)
```ts
  /**
   * Sprint-20260731: where/how the per-sprint doc record is written.
   * `committed` reproduces today's behavior byte-for-byte ...
   * `local` writes under `docsDir` inside the repo without committing
   * (a deterministic helper ensures `.gitignore` covers `docsDir`).
   * `external` writes outside the repo entirely ...
   * Defaults to `committed` so configs that omit this key are unaffected
   */
  docsMode: DocumenterDocsModeSchema.default("committed"),
```
Per `nonGoals[2]`, `external` must **not** be an init choice — keep the prompt binary.

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/cli/commands/run.test.ts:13-75`
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../orchestrator/pipeline.js", () => ({ runPipeline: vi.fn(async () => ({ /* ... */ })) }));
vi.mock("../../config/loader.js", () => ({
  configExists: vi.fn(async () => true),
  loadConfig: vi.fn(async () => minimalConfig),
}));

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-run-cmd-"));
  vi.clearAllMocks();
});
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

describe("sc-4-5 — --team flag propagation through runRunCommand", () => {
  it("with team:'example' passes teamId:'example' to runPipeline", async () => {
    const { runPipeline } = await import("../../orchestrator/pipeline.js");
    const { runRunCommand } = await import("./run.js");
    await runRunCommand("do something", tmpDir, { team: "example" });
    expect(runPipeline).toHaveBeenCalledWith(
      "do something", tmpDir, expect.anything(),
      expect.objectContaining({ teamId: "example" }),
    );
  });
});
```
**Runner:** vitest 3 (no `vitest.config.ts` → default include `**/*.{test,spec}.?(c|m)[jt]s?(x)`; run with `npx vitest run`).
**Assertion style:** `expect(...)` with `.toBe/.toEqual/.toMatchObject/.toHaveBeenCalledWith`; `Object.hasOwn(x, "k")` to prove a key is absent (`schema.test.ts:844`, `:1340`).
**Mock approach:** `vi.mock("<relative .js path>", factory)` at module top level + `await import()` **inside** each test (so mocks apply).
**File naming / location:** co-located `init.test.ts` next to `init.ts`.
**Docblock convention:** header comment naming the criteria IDs it covers (`run.test.ts:1-10`, `telemetry.test.ts:1-5`, `schema.test.ts:832`).

### Schema/criterion-tagged assertion pattern
**Source:** `src/config/schema.test.ts:834-845`
```ts
describe("DocumenterSectionSchema — docsMode/docsDir (sc-1-1)", () => {
  it("parse({}) defaults docsMode to 'committed' and does NOT materialize docsDir", () => {
    const parsed = DocumenterSectionSchema.parse({});
    expect(parsed).toEqual({ timeoutMs: 300_000, enabled: true, model: "sonnet", maxTurns: 20, docsMode: "committed" });
    expect(Object.hasOwn(parsed, "docsDir")).toBe(false);
  });
```
Use the same shape for the "generated config validates" assertion: `expect(BoberConfigSchema.parse(generated).documenter?.docsMode).toBe("local")`.

### `prompts` injection — no existing precedent in this repo, so here is the verified mechanism
`grep -rn "prompts.inject"` across `src/` and `tests/` → **no hits**. `prompts@2.4.2` is a direct dependency (`package.json:77`), typed via `@types/prompts` (`inject(arr: readonly any[]): void`, `override(obj): void`).

**`node_modules/prompts/lib/index.js:58-92` (verified behavior — read this carefully):**
```js
    if (override[question.name] !== undefined) { answer = await getFormattedAnswer(question, override[question.name]); ... }
    ...
      answer = prompt._injected ? getInjectedAnswer(prompt._injected, question.initial) : await prompts[type](question);
...
function getInjectedAnswer(injected, deafultValue) {
  const answer = injected.shift();
    if (answer instanceof Error) { throw answer; }
    return (answer === undefined) ? deafultValue : answer;
}
function inject(answers) { prompt._injected = (prompt._injected || []).concat(answers); }
```
Consequences the Generator MUST design around:
1. `inject()` is a **positional FIFO queue**, not keyed by question name. `prompts.override({ docsMode: "local" })` **is** keyed by name and may be the safer choice for a single named question.
2. `inject([])` **does not reset** the queue (it `concat`s), and an empty array is still truthy, so **once any injection happens in a module instance, prompts never blocks again** — it returns `question.initial` instead. For a `select`, `initial` is the **numeric index `0`**, not the value. So a drained queue yields `docsMode === 0`, and a `?? "committed"` nullish fallback would **not** catch it.
   → Validate the answer explicitly, e.g. `return answer === "local" ? "local" : "committed";` or `DocumenterDocsModeSchema.safeParse(answer)` with a `committed` fallback. This also makes the helper robust against SIGINT (`undefined`).
3. Vitest isolates modules per test **file**, so injection state does not leak between files — but it does accumulate within a file. Keep injections 1:1 with `askDocsMode(true)` calls.

**Suggested test set (all deterministic, no TTY, no fs):**
```ts
// sc-3-1
prompts.inject(["local"]);   expect(await askDocsMode(true)).toBe("local");
prompts.inject(["committed"]); expect(await askDocsMode(true)).toBe("committed");
// the written shape validates and resolves
const cfg = BoberConfigSchema.parse({ ...minimalBase, documenter: { docsMode: "local" } });
expect(cfg.documenter?.docsMode).toBe("local");
expect(resolveSprintDocPath(BoberConfigSchema.parse(minimalBase), "/tmp/p", "c1")).toBe(join("docs","sprints","c1.md")); // omitted → committed
// sc-3-2: guard fires before any prompt — inject stays unconsumed
prompts.inject(["local"]);
expect(await askDocsMode(false)).toBe("committed");   // no prompt fired
expect(await askDocsMode(true)).toBe("local");        // proves the injected answer was still queued
```

### E2E Test Pattern
No Playwright config in this repo. `tests/e2e/*.test.ts` are vitest "end-to-end pipeline" tests (`four-modes.test.ts`, `cockpit-integration.test.ts`) — **not applicable** to this sprint; do not add one.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/index.ts:11,116` | `runInitCommand` from `init.ts` | low | Signature of `runInitCommand(projectRoot, { preset })` must not change |
| `src/cli/commands/update.ts:25,73-75` | `installClaudeCommands` from `init.ts` | low | Do not touch `installClaudeCommands` / `UNIVERSAL_COMMANDS` / `skillMap` |
| `tests/cli/skill-bundles.test.ts` | reads `src/cli/commands/init.ts` **as text** and asserts skills appear in `UNIVERSAL_COMMANDS` | medium | Keep the `UNIVERSAL_COMMANDS` block (`:952-972`) untouched; don't reformat it |
| `src/mcp/tools/init.ts` | duplicates the config-assembly logic (`createDefaultConfig` + `writeFile`) | low (if left alone) | It must stay prompt-free; it emits no `documenter` → resolves to `committed`. Recommended: **do not modify** |
| `src/orchestrator/documenter-agent.ts:79,247,249,281` | `config.documenter?.*` | medium | A *partial* `{docsMode}` is safe; a materialized section pins `model:"sonnet"` over the user's generator model and `maxTurns:20` |
| `src/index.ts:203`, `src/discovery/index.ts:12-13` | `generateEvalConfig` / `EvalConfig` | low | Only breaks if you widen `EvalConfig` (recommendation: don't) |
| `src/config/schema.ts` `createDefaultConfig` | consumed by `init.ts`, `mcp/tools/init.ts`, many tests | high **if** you add `documenter` to its base | Leave `createDefaultConfig` unchanged |

### Existing Tests That Must Still Pass
- `src/config/schema.test.ts:945` — parses **the repo's own `bober.config.json`** "byte-identically (sc-1-2, sc-7-2)"; this is the golden snapshot commit 255f992 fixed. Passes iff you do not edit the repo's config.
- `src/config/schema.test.ts:1297-1341` — `minimalBase` golden snapshot: asserts the exact resolved object and `Object.hasOwn(parsed,"seo") === false`. Breaks if `createDefaultConfig`/`BoberConfigSchema` defaults shift.
- `src/config/schema.test.ts:1361` — "createDefaultConfig never sets a seo section" — the precedent this sprint must respect for `documenter`.
- `src/config/schema.test.ts:834-890` — sprint-1 `docsMode`/`docsDir` schema tests.
- `src/orchestrator/documenter-agent.test.ts:333+` — `resolveSprintDocPath` per mode (incl. the "committed must stay repo-relative" invariant).
- `src/discovery/config-generator.test.ts` (570 lines) — should remain **untouched and green**.
- `tests/cli/skill-bundles.test.ts` — text assertions against `init.ts`.
- `src/cli/commands/*.test.ts` (`run`, `plan`, `do`, `telemetry`, …) — unaffected, but they share the `prompts` dependency; never leave a real prompt reachable in a test process.

### Features That Could Be Affected
- **feat-5 (this sprint) vs sprints 1-2** — shares `documenter.docsMode`. Verify `resolveSprintDocPath` still returns the repo-relative `docs/sprints/<id>.md` for `committed`.
- **`bober update`** — shares `installClaudeCommands`; verify `npx vitest run tests/cli/skill-bundles.test.ts`.
- **`bober_init` MCP tool** — the parallel init surface. Keeping it prompt-free *is* sc-3-2's evidence; if you choose to also emit `documenter: { docsMode: "committed" }` there, it must remain unconditional and prompt-free.
- **Documenter model/provider selection** — the most likely silent regression (see the `model` fallback at `documenter-agent.ts:247`).

### Recommended Regression Checks
1. `npx tsc --noEmit` (typecheck) — zero errors.
2. `npx eslint src/` — zero errors (new test file included in the glob).
3. `npm run build` (`tsc`) — clean.
4. `npx vitest run` — full suite; baseline after sprint 2 is **4990 passed | 1 skipped** (`docs/sprints/README.md:2470`). Expect only additions.
5. `npx vitest run src/config/schema.test.ts src/orchestrator/documenter-agent.test.ts src/discovery/config-generator.test.ts tests/cli/skill-bundles.test.ts` — the four highest-risk files.
6. `git diff --stat` — should be `src/cli/commands/init.ts` + new `src/cli/commands/init.test.ts` (+ optional `CHANGELOG.md`). `git diff --name-only -- bober.config.json src/config/schema.ts src/discovery/` must be **empty**.
7. Manual/asserted: a generated config with `"documenter": { "docsMode": "local" }` passes `BoberConfigSchema.parse` and `resolveSprintDocPath` returns an absolute path under the project root; with `documenter` omitted it returns the repo-relative `docs/sprints/<id>.md`.

---

## 8. Implementation Sequence

1. **`src/cli/commands/init.ts` — imports.** Add `DocumenterDocsMode` to the existing type-import at `:7`: `import type { EvalStrategyType, ProjectMode, DocumenterDocsMode } from "../../config/schema.js";`
   - Verify: `npx tsc --noEmit` still clean (unused imports fail under `noUnusedLocals`, so do this together with step 2).
2. **`init.ts` — add the exported helper** in a new `// ── Docs output (solo vs team) ──` section right after `askProvider` (insert after `:180`):
   ```ts
   export async function askDocsMode(
     isTTY: boolean = process.stdin.isTTY ?? false,
   ): Promise<DocumenterDocsMode> {
     if (!isTTY) return "committed";           // non-interactive / CI — never prompt (sc-3-2)
     const { docsMode } = await prompts({
       type: "select",
       name: "docsMode",
       message: "Where should per-sprint docs go?",
       choices: [
         { title: "Commit them into the repo (solo)", description: "docs/sprints/<sprint>.md, committed with the code", value: "committed" },
         { title: "Keep the repo clean (team)",       description: "Written on disk and gitignored — never committed", value: "local" },
       ],
       initial: 0,
     });
     return docsMode === "local" ? "local" : "committed";   // SIGINT / drained-inject safe (see §6)
     }
   ```
   (Exported so the test can drive it without running the whole init.)
   - Verify: `npx tsc --noEmit`, `npx eslint src/cli/commands/init.ts`.
3. **`init.ts` — widen the local `ConfigShape`** (`:1116-1126`) with `documenter?: { docsMode: DocumenterDocsMode };` (optionally print `Docs: <mode>` in the summary at `:1174-1181`, next to `Provider:`).
   - Verify: typecheck.
4. **`init.ts` — wire the three flows** (order matters only for UX; put the call right after `askModelPreferences`):
   - `brownfieldFlow`: call after `:618`; build `const configToWrite = { ...config, documenter: { docsMode } };` and pass `configToWrite` to `writeConfig` at `:651`, keeping the original `config` for `synthesizePrinciples` at `:658`.
   - `brownfieldManualFlow`: call after `:719`; merged object into `writeConfig` at `:765`.
   - `greenfieldFlow`: call after `:850`; merged object into `writeConfig` at `:904`.
   - Verify: `npx tsc --noEmit`; `git diff` shows ~3 one-line prompt calls + 3 merged-object lines.
5. **Create `src/cli/commands/init.test.ts`** with the sc-3-1 / sc-3-2 tests from §6 (docblock naming the criteria).
   - Verify: `npx vitest run src/cli/commands/init.test.ts` green; the injected-answer test must not hang (if it hangs, the TTY guard or the injection order is wrong).
6. **Optional (low risk): CHANGELOG `[Unreleased]`** line noting that `bober init` now asks the solo/team docs question. Do **not** touch README/VISION/skills — sprint 2 already documents the keys.
7. **Run full verification** — `npx tsc --noEmit`, `npx eslint src/`, `npm run build`, `npx vitest run`.
   - Record in completion notes: (a) `config-generator.ts`/`config-generator.test.ts` were deliberately **not** modified (no documenter surface there); (b) the golden snapshots (`schema.test.ts:945`, `:1297`) were untouched and still pass; (c) the test lives in `init.test.ts` instead of the contract's `config-generator.test.ts`.

---

## 9. Pitfalls & Warnings

- **The "golden snapshot" is not where the contract implies.** Commit 255f992 touched only `bober.config.json`; the assertions live in `src/config/schema.test.ts:945` (repo's own config) and `:1297` (`minimalBase`). `config-generator.test.ts` has **no** snapshot (`grep -n "snapshot\|golden"` → no hits). Do not go looking for one to "update".
- **Do not materialize the full documenter section.** `DocumenterSectionSchema.parse({ docsMode })` yields `{timeoutMs:300000, enabled:true, model:"sonnet", maxTurns:20, docsMode}`. Persisting that pins `documenter.model = "sonnet"` and defeats `config.documenter?.model ?? config.generator.model` (`documenter-agent.ts:247`) — catastrophic when the user picked `openai`/`google` (a `sonnet` model id sent to OpenAI).
- **`createDefaultConfig` overrides won't accept a partial documenter.** `overrides: Partial<Omit<BoberConfig,"project">>` (`schema.ts:907`) means `documenter` must be a **complete** `DocumenterSection`. Merge the partial at the `writeConfig` call site instead (assign to a variable first — a fresh inline object literal with an extra key would trip TypeScript's excess-property check against `ConfigShape`).
- **Do not add `documenter` to `createDefaultConfig`'s base** — `schema.test.ts:1297-1341` and `:1361` assert byte-identical resolved defaults and that opt-in sections stay unmaterialized.
- **`prompts` select `initial` is an index, not a value.** With a drained injection queue, `prompts` returns `question.initial` → `0`. A `?? "committed"` fallback will let the number `0` through into the JSON. Validate the answer by value.
- **`prompts.inject([])` does not clear the queue** (`lib/index.js:90-92` uses `concat`), and after the first injection `prompts` never blocks again in that module instance. Keep injections balanced, or prefer `prompts.override({ docsMode: "local" })` (keyed by name, `lib/index.js:58`).
- **Never let a test reach a real prompt.** There is no `vitest.config.ts` and no TTY in the test process; a real `prompts` call in a test can hang the suite. The `isTTY` parameter default (`process.stdin.isTTY ?? false`) means an un-parameterized call in a test returns `committed` immediately — pass `true` explicitly for the interactive tests.
- **Three flows, three writes.** `runInitCommand` returns early for `--preset <name>` and the `brownfield` positional (`:449-464`), so a single question placed in `runInitCommand` before the greenfield/brownfield dispatch would work but reorders the UX (docs question before "new or existing project?"). Asking inside each flow is the smaller, safer diff — just don't forget `brownfieldManualFlow` (the "Look good? → no" fallback at `:594`).
- **`brownfieldFlow` reuses `config` after writing** (`synthesizePrinciples` at `:658` needs a real `BoberConfig`) — do not shadow or replace that variable with the merged shape.
- **`tests/cli/skill-bundles.test.ts` reads `init.ts` as text.** Avoid reformatting `UNIVERSAL_COMMANDS` (`:952-972`) or `skillMap` (`:1007-1032`).
- **`npm test` is watch mode** (`package.json:17`). Use `npx vitest run`.
- **Test files are excluded from `tsc`** (`tsconfig.json` `exclude: ["**/*.test.ts"]`) but **not** from `eslint src/` — a lint error in the new test file fails the lint gate even though typecheck ignores it.
- **`external` is out of scope** (`nonGoals[2]`) — two choices only; users reach `external`/`docsDir` by hand-editing, as documented in `README.md:862-865`.
- **Do not call `ensureGitignoreEntry` from init.** In `local` mode the documenter does it as a runtime pre-step (`documenter-agent.ts:288-290`); init writing `.gitignore` entries for docs would duplicate that and diverge from sprint 1's design (init only adds `.bober/`, `:1146-1160`).
