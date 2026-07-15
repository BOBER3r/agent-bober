# Sprint Briefing: config.fleet section + manifest.blackboard + path injection + `agent-bober blackboard` CLI

**Contract:** sprint-spec-20260618-fleet-blackboard-exchange-2
**Generated:** 2026-06-18T00:00:00Z

> Phase B / Sprint 2. Additive config + manifest surface + the explicit child seam. Sprint 1 already shipped `SharedBlackboard` (`src/fleet/shared-blackboard.ts`). This sprint adds (1) optional `config.fleet`, (2) optional `manifest.blackboard`, (3) `resolveBlackboardPath`, (4) per-child scaffolder injection, (5) a new `agent-bober blackboard publish|read` CLI. NO coordinator loop, NO synthesis, NO auto-wiring into `agent-bober run`.

---

## 1. Target Files

### `src/config/schema.ts` (modify)

Add a `FleetSectionSchema` sibling next to `MedicalSectionSchema`, then add `fleet: FleetSectionSchema.optional()` to `BoberConfigSchema`. The optional section is REQUIRED to be declared because Zod object schemas strip unknown keys — an undeclared `fleet` key in a child's `bober.config.json` would be silently dropped on parse.

**`MedicalSectionSchema` — the template to mirror (lines 374-401):**
```ts
// ── Medical Section (Phase 6, Sprint 6 — two egress axes default off) ──

export const MedicalSectionSchema = z.object({
  egress: z
    .object({
      cloudInference: z.boolean().default(false),
      literatureRetrieval: z.boolean().default(false),
      deviceConnection: z.boolean().default(false),
    })
    .optional(),
  // ...
});
export type MedicalSection = z.infer<typeof MedicalSectionSchema>;
```

**`BoberConfigSchema` tail — where to add the `fleet` key (lines 405-435):**
```ts
export const BoberConfigSchema = z.object({
  project: ProjectSectionSchema,
  // ...
  // ── Phase 6: medical team egress config ──
  medical: MedicalSectionSchema.optional(),
  // ── Phase B: fleet blackboard (child-visible channel) ──   <-- ADD HERE
  // fleet: FleetSectionSchema.optional(),
});
export type BoberConfig = z.infer<typeof BoberConfigSchema>;
```

**Exact new schema to add (from generatorNotes / contract):**
```ts
// ── Fleet Section (Phase B — inter-agent blackboard, child-visible) ──
export const FleetSectionSchema = z.object({
  blackboardDbPath: z.string(),
  blackboardNamespace: z.string(),
  blackboardSubject: z.string(),
  maxRounds: z.number().int().min(1).max(3),
});
export type FleetSection = z.infer<typeof FleetSectionSchema>;
```

**CRITICAL — `PartialBoberConfigSchema` (lines 441-449):** it is `BoberConfigSchema.deepPartial().extend({ project: ... })`. `loadConfig` validates against the partial first, then re-validates the deep-merged result against the FULL `BoberConfigSchema` (loader.ts:174 then :239). Because `fleet` is `.optional()` and not in the loader's hardcoded merge base (loader.ts:186-234), it survives via `partial as Partial<BoberConfig>` spread (loader.ts:235). No loader change needed — the optional section flows through.

**Imported by:** `src/config/loader.ts` (loadConfig), `src/fleet/child-config.ts:1` (`buildChildConfig` calls `BoberConfigSchema.parse(merged)` at child-config.ts:52), `src/cli/commands/blackboard.ts` (NEW — reads `config.fleet`).

**Test file:** `src/config/schema.test.ts` (exists — add a `describe("BoberConfigSchema — fleet section is optional")` block; mirror the architect pattern at schema.test.ts:70-105 which uses `BoberConfigSchema.safeParse({...})` + asserts `result.success` and `result.data.architect?...`).

---

### `src/fleet/manifest.ts` (modify)

Add an optional `blackboard` block to `FleetManifestSchema`.

**Current schema (lines 6-19):**
```ts
export const FleetChildSchema = z.object({
  folder: z.string().min(1),
  task: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
  tier: z.enum(["default", "cheap", "standard", "hard", "frontier"]).optional(),
});
export type FleetChild = z.infer<typeof FleetChildSchema>;

export const FleetManifestSchema = z.object({
  rootDir: z.string().default("."),
  concurrency: z.number().int().min(1).default(3),
  children: z.array(FleetChildSchema).min(1),
  // blackboard: z.object({ namespace: z.string().min(1), maxRounds: z.number().int().min(1).max(3).default(3) }).optional(),  <-- ADD
});
export type FleetManifest = z.infer<typeof FleetManifestSchema>;
```

**Exact block to add (per contract item 2 / sc-2-4):**
```ts
blackboard: z
  .object({
    namespace: z.string().min(1),
    maxRounds: z.number().int().min(1).max(3).default(3),
  })
  .optional(),
```

**`rootDir` availability:** `FleetManifestSchema.rootDir` defaults to `"."` (manifest.ts:15). `resolveBlackboardPath` takes the manifest and does `resolve(manifest.rootDir)` to make the path absolute — `rootDir` is already a field on the parsed manifest. Note `runFleet` builds `effectiveManifest` with the `--root` override applied BEFORE any scaffold (index.ts:103-107), so resolve against `effectiveManifest.rootDir`.

**Imported by:** `src/fleet/index.ts:14,25` (load + type), `src/fleet/child-config.ts:3` (FleetChild type), `src/fleet/scaffolder.ts:5` (FleetChild type).

**Test file:** `src/fleet/manifest.test.ts` (exists — add cases mirroring the `FleetChildSchema — tier field` describe at manifest.test.ts:92-141: parse manifest WITH blackboard, WITHOUT (absent), and `maxRounds: 4` → throws ZodError).

---

### `src/fleet/scaffolder.ts` (modify)

Thread an optional fleet descriptor into `scaffold()` and, when present, set `config.fleet` on the built child config BEFORE `JSON.stringify` + `writeFile`. When absent, write exactly as today (byte-identical — no `fleet` key).

**The exact merge point (lines 55-58):**
```ts
    // 3. Write bober.config.json using the Zod-valid config from buildChildConfig
    try {
      const configJson = JSON.stringify(buildChildConfig(child), null, 2);   // <-- line 57
      await writeFile(join(absPath, "bober.config.json"), configJson, "utf-8");  // <-- line 58
```

**Required change shape (do NOT mutate the buildChildConfig return in place beyond adding the key):**
```ts
async scaffold(
  rootDir: string,
  child: FleetChild,
  blackboard?: { dbPath: string; namespace: string; maxRounds: number },  // NEW optional param
): Promise<ScaffoldResult> {
  // ...existing safety + mkdir...
  try {
    const config = buildChildConfig(child);
    if (blackboard) {
      config.fleet = {
        blackboardDbPath: blackboard.dbPath,       // the ABSOLUTE shared path
        blackboardNamespace: blackboard.namespace,
        blackboardSubject: child.folder,           // sc-2-5: subject === child.folder
        maxRounds: blackboard.maxRounds,
      };
    }
    const configJson = JSON.stringify(config, null, 2);
    await writeFile(join(absPath, "bober.config.json"), configJson, "utf-8");
  } catch (err) { /* unchanged error capture */ }
```
- `buildChildConfig` returns a `BoberConfig` (child-config.ts:22, `BoberConfigSchema.parse(merged)`). After this sprint adds `fleet?` to the schema, `config.fleet = {...}` typechecks. The `blackboard` arg passed by `runFleet` carries the already-resolved absolute `dbPath` — the scaffolder does NOT call `resolveBlackboardPath` (no path derivation in the scaffolder).
- `child.folder` is the per-child folder name (`FleetChild.folder`, manifest.ts:7) — used as `absPath = resolve(rootDir, child.folder)` (scaffolder.ts:21) AND as `blackboardSubject`.

**BYTE-IDENTICAL RULE (sc-2-8):** when `blackboard` is `undefined`, do not touch `config` — `JSON.stringify(buildChildConfig(child), null, 2)` must produce the SAME bytes as today. Only set `config.fleet` inside the `if (blackboard)` guard.

**Test file:** `src/fleet/scaffolder.test.ts` (exists — see §6).

---

### `src/fleet/index.ts` (modify)

Add `resolveBlackboardPath(manifest)` and thread the resolved descriptor through to the scaffolder. NOTE: `runFleet` does NOT currently call the scaffolder directly — it delegates to `FleetCoordinator.execute(effectiveManifest)` (index.ts:118). For THIS sprint the only required landing is the exported `resolveBlackboardPath` helper (Sprint 3 wires the loop). Export it for tests.

**Where it goes (after the imports at index.ts:12, reuse `join`/`resolve`):**
```ts
import { join, resolve } from "node:path";   // index.ts:12 currently imports only `join` — add `resolve`

/**
 * Resolve the ABSOLUTE shared blackboard path for a fleet run.
 * Returns undefined when no blackboard is configured.
 */
export function resolveBlackboardPath(manifest: FleetManifest): string | undefined {
  if (!manifest.blackboard) return undefined;
  return join(resolve(manifest.rootDir), ".bober", "memory", manifest.blackboard.namespace, "facts.db");
}
```
- sc-2-5: the returned path is ABSOLUTE and contains `.bober/memory/<namespace>/facts.db`.
- `FleetManifest` type is already imported (index.ts:25).

**Test file:** no `src/fleet/index.test.ts` exists for runFleet today (only sub-modules tested). Add `resolveBlackboardPath` tests in `src/fleet/manifest.test.ts` OR a new small describe — the contract lists `src/fleet/index.ts` but no `index.test.ts`; co-locate the helper's tests in `manifest.test.ts` (it already imports from `./manifest.js`; import `resolveBlackboardPath` from `./index.js`).

---

### `src/cli/commands/blackboard.ts` (create)

**Directory pattern:** Files in `src/cli/commands/` are `kebab-case.ts` (e.g. `facts.ts`, `medical.ts`, `worktree.ts`). Each exports a `register<Name>Command(program: Command): void`.
**Most similar existing files:** `src/cli/commands/facts.ts` (uses `loadConfig` + `FactStore` + `store.close()` in `finally` + `process.exitCode=1` on error) and `src/cli/commands/medical.ts` (exports a DI'd testable core `runWhoopSync(projectRoot, opts, deps)` + clean exit-1-no-throw branches). Mirror BOTH: a testable core (`runBlackboardPublish`/`runBlackboardRead` or one `runBlackboard`) + a thin `registerBlackboardCommand`.

**Structure template (synthesized from facts.ts:14-32,99-134 + medical.ts:43-121,130-189):**
```ts
/** `agent-bober blackboard publish|read` — inter-agent blackboard CLI (Phase B). */
import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { loadConfig } from "../../config/loader.js";
import { SharedBlackboard } from "../../fleet/shared-blackboard.js";

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

/** Core for `blackboard publish` — DI'd projectRoot + nowIso for tests. */
export async function runBlackboardPublish(
  projectRoot: string,
  value: string,
  opts: { round?: string },
  nowIso: string = new Date().toISOString(),
): Promise<void> {
  let bb: SharedBlackboard | undefined;
  try {
    const config = await loadConfig(projectRoot);
    if (!config.fleet) {
      process.stderr.write(chalk.red("No fleet section in bober.config.json — this child is not part of a fleet blackboard run.\n"));
      process.exitCode = 1;
      return;                                       // NEVER throw
    }
    bb = await SharedBlackboard.open({
      dbPath: config.fleet.blackboardDbPath,        // ABSOLUTE path from config ONLY — never re-derive from cwd
      namespace: config.fleet.blackboardNamespace,
      maxRounds: config.fleet.maxRounds,
    });
    bb.publish(
      { childFolder: config.fleet.blackboardSubject, round: opts.round ? Number(opts.round) : 1, payload: value },
      nowIso,
    );
    process.stdout.write(chalk.green(`Published finding for ${config.fleet.blackboardSubject}\n`));
  } catch (err) {
    process.stderr.write(chalk.red(`Failed to publish: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
  } finally {
    bb?.close();
  }
}

/** Core for `blackboard read [--all]`. */
export async function runBlackboardRead(
  projectRoot: string,
  opts: { all?: boolean },
): Promise<void> {
  let bb: SharedBlackboard | undefined;
  try {
    const config = await loadConfig(projectRoot);
    if (!config.fleet) { /* same clean exit-1 message + return as publish */ }
    bb = await SharedBlackboard.open({ dbPath: config.fleet.blackboardDbPath, namespace: config.fleet.blackboardNamespace, maxRounds: config.fleet.maxRounds });
    const findings = opts.all ? bb.readAll() : bb.readSiblings(config.fleet.blackboardSubject);
    for (const f of findings) {
      process.stdout.write(`[${f.subject}] ${f.value}\n`);   // FactRecord.subject / .value (facts.ts:37-49)
    }
  } catch (err) { /* exit-1 no-throw */ } finally { bb?.close(); }
}

export function registerBlackboardCommand(program: Command): void {
  const bbCmd = program.command("blackboard").description("Inter-agent fleet blackboard (publish/read findings)");
  bbCmd
    .command("publish <value>")
    .description("Publish a finding to the shared fleet blackboard")
    .option("--round <n>", "Round number (default 1)")
    .action(async (value: string, opts: { round?: string }) => {
      await runBlackboardPublish(await resolveRoot(), value, opts);
    });
  bbCmd
    .command("read")
    .description("Read findings from the shared fleet blackboard")
    .option("--all", "Show all findings (default: siblings only)")
    .action(async (opts: { all?: boolean }) => {
      await runBlackboardRead(await resolveRoot(), opts);
    });
}
```

---

### `src/cli/index.ts` (modify)

Add the import and the registration call, mirroring `registerMedicalCommand`/`registerFleetCommand`.

**Imports block (lines 38-40):**
```ts
import { registerFleetCommand } from "../fleet/index.js";
import { registerChatCommand } from "./commands/chat.js";
import { registerMedicalCommand } from "./commands/medical.js";
// import { registerBlackboardCommand } from "./commands/blackboard.js";   <-- ADD
```

**Registration block (lines 317-324):**
```ts
  // ── medical ───────────────────────────────────────────────────────
  registerMedicalCommand(program);

  // ── fleet ─────────────────────────────────────────────────────────
  registerFleetCommand(program);

  // ── chat ──────────────────────────────────────────────────────────
  registerChatCommand(program);
  // ── blackboard ────────────────────────────────────────────────────   <-- ADD
  // registerBlackboardCommand(program);
```

---

## 2. Patterns to Follow

### Optional Zod section + add to BoberConfigSchema
**Source:** `src/config/schema.ts`, lines 376-401 (MedicalSectionSchema) and 405-435 (BoberConfigSchema tail).
```ts
export const MedicalSectionSchema = z.object({ egress: z.object({ ... }).optional(), ... });
export type MedicalSection = z.infer<typeof MedicalSectionSchema>;
// ...
export const BoberConfigSchema = z.object({ /* ... */ medical: MedicalSectionSchema.optional() });
```
**Rule:** Declare the section schema + its inferred type, then add it `.optional()` to `BoberConfigSchema`. Because Zod objects strip unknown keys, an undeclared `fleet` key would be dropped — declaring it is the whole point of this sprint (the child-visible channel).

### Optional manifest sub-block with a default
**Source:** `src/fleet/manifest.ts`, lines 14-18.
```ts
export const FleetManifestSchema = z.object({
  rootDir: z.string().default("."),
  concurrency: z.number().int().min(1).default(3),
  children: z.array(FleetChildSchema).min(1),
});
```
**Rule:** Use `.default(3)` on `maxRounds` inside the optional `blackboard` object so an explicit `blackboard:{namespace}` fills `maxRounds=3`; `.max(3)` makes `maxRounds:4` a ZodError (sc-2-4).

### CLI: testable DI'd core + thin register; clean exit, never throw
**Source:** `src/cli/commands/medical.ts`, lines 43-121 (runWhoopSync core: axis-off branch prints + `process.exitCode=1; return;`, `finally { store?.close() }`) and lines 130-189 (registerMedicalCommand). Also `src/cli/commands/facts.ts:99-134` (`new FactStore(...)` then `try {...} finally { store.close() }`).
```ts
if (!egress.isAllowed("device-connection")) {
  process.stderr.write(chalk.red("device-connection egress not enabled — ...\n"));
  process.exitCode = 1;
  return;                       // CLI handlers MUST NOT throw (facts.ts:11)
}
// ...
} finally {
  store?.close();               // always close
}
```
**Rule:** Export a `run*` core taking `projectRoot` (and `nowIso` for the wall-clock seam) so tests call it without spawning a process. The `.action()` is a one-liner. On any error/missing-section: print to stderr, set `process.exitCode=1`, `return` — never `throw`.

### Config loading from cwd
**Source:** `src/cli/commands/medical.ts:23-26,50` + `src/config/loader.ts:142-267`.
```ts
async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}
// ...
const config = await loadConfig(projectRoot);
```
**Rule:** Reuse `loadConfig(projectRoot)` from `src/config/loader.js`. `loadConfig` discovers `bober.config.json` or `.bober/config.json` (loader.ts:67-70) and throws if none — wrap in try/catch and treat as a clean exit-1.

### SharedBlackboard usage (Sprint 1 — DO NOT reimplement)
**Source:** `src/fleet/shared-blackboard.ts`, lines 54-67 (open), 74-90 (publish), 96-105 (read).
```ts
const bb = await SharedBlackboard.open({ dbPath, namespace, maxRounds });   // maxRounds capped at BLACKBOARD_MAX_ROUNDS=3
bb.publish({ childFolder, round, payload, confidence? }, nowIso);            // throws if round > maxRounds
const siblings = bb.readSiblings(selfFolder);  // FactRecord[] excluding self
const all = bb.readAll();                       // FactRecord[]
bb.close();
```
**Rule:** `open` is async (`ensureDir` + WAL). `publish` is sync and takes `now` as a parameter (PURE store — stamp the clock at the CLI boundary, never inside the store). Always `close()` in `finally`.

### Unicode section headers + import type + ESM .js
**Source:** every file above, e.g. `src/fleet/index.ts:32` `// ── DI seam ───`, `src/cli/commands/facts.ts:15` `import type { Command } from "commander";`, `src/fleet/scaffolder.ts:5` `import type { FleetChild } from "./manifest.js";`.
**Rule:** `// ── Section ──` headers; `import type { ... }` for types (ESLint `consistent-type-imports`); ALL relative imports end in `.js`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `SharedBlackboard.open` | `src/fleet/shared-blackboard.ts:54` | `(opts: {dbPath; namespace; busyTimeoutMs?; maxRounds?}): Promise<SharedBlackboard>` | Open/create the shared WAL facts.db; ensures parent dir; caps maxRounds at 3. |
| `SharedBlackboard#publish` | `src/fleet/shared-blackboard.ts:74` | `(finding: {childFolder; round; payload; confidence?}, now: string): FactRecord` | Persist a 'finding' fact; throws if round > cap. |
| `SharedBlackboard#readSiblings` | `src/fleet/shared-blackboard.ts:96` | `(selfFolder: string): FactRecord[]` | Active findings by OTHER subjects in the namespace. |
| `SharedBlackboard#readAll` | `src/fleet/shared-blackboard.ts:103` | `(): FactRecord[]` | All active findings in the namespace. |
| `SharedBlackboard#close` | `src/fleet/shared-blackboard.ts:108` | `(): void` | Close the underlying db. |
| `BLACKBOARD_MAX_ROUNDS` | `src/fleet/shared-blackboard.ts:9` | `const = 3` | The hard round cap (reuse for the `.max(3)` ceilings). |
| `loadConfig` | `src/config/loader.ts:142` | `(projectRoot: string): Promise<BoberConfig>` | Discover + parse + validate bober.config.json; throws if absent. |
| `findProjectRoot` | `src/utils/fs.ts` (imported facts.ts:17, medical.ts:7) | `(): Promise<string \| null>` | Walk up for the project root; CLI falls back to `process.cwd()`. |
| `BoberConfigSchema` | `src/config/schema.ts:405` | Zod object | The full config schema — add `fleet` here; `buildChildConfig` parses against it. |
| `buildChildConfig` | `src/fleet/child-config.ts:22` | `(child: FleetChild): BoberConfig` | Build the per-child config; scaffolder sets `config.fleet` on its return. |
| `FleetManifestSchema` / `load` | `src/fleet/manifest.ts:14,23` | schema / `(path): Promise<FleetManifest>` | Manifest schema (add `blackboard`) + loader. |
| `FactStore` ctor | `src/state/facts.ts:139` | `(dbPath, {journalModeWal?; busyTimeoutMs?}?)` | Backing store; SharedBlackboard wraps it — do NOT use directly in the CLI. |
| `ensureDir` | `src/utils/fs.ts` / re-exported `state/helpers.js` | `(dir): Promise<void>` | Async mkdir-recursive; SharedBlackboard.open already calls it. |

**Utilities reviewed:** `src/utils/` (fs, logger), `src/state/` (facts, helpers), `src/config/` (loader, schema), `src/fleet/` (shared-blackboard, manifest, child-config, scaffolder). The CLI must NOT recreate a path helper, a FactStore wrapper, or a config loader — all exist.

---

## 4. Prior Sprint Output

### Sprint 1 (commit e1d4b00): SharedBlackboard
**Created:** `src/fleet/shared-blackboard.ts` — exports `SharedBlackboard` (class with `open`/`publish`/`readSiblings`/`readAll`/`close`), `BLACKBOARD_MAX_ROUNDS=3`, `BlackboardFinding`, `SharedBlackboardOpts`. Also extended `FactStore` (`src/state/facts.ts:139-149`) with optional WAL opts `{journalModeWal?, busyTimeoutMs?}` (default off — byte-identical when absent).
**Connection to this sprint:** The new `blackboard` CLI opens `SharedBlackboard.open({dbPath: config.fleet.blackboardDbPath, namespace: config.fleet.blackboardNamespace, maxRounds: config.fleet.maxRounds})`, then `publish`/`readSiblings`/`readAll`. The CLI is the explicit child seam — there is NO auto-wiring into the coordinator (Sprint 3) and NO synthesis (Sprint 4).

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **Zod for ALL config validation** (principles.md:29) — the `fleet` section + `blackboard` block are Zod schemas; no hand-rolled validation.
- **ESM everywhere, `.js` import extensions** (principles.md:27) — every relative import ends in `.js`.
- **No synchronous fs** (principles.md:42) — use `node:fs/promises`; `SharedBlackboard.open` is already async. (better-sqlite3 writes are synchronous internally — that is Sprint 1's boundary, not this sprint's.)
- **`import type`** (principles.md:35) for `Command`, `BoberConfig`, `FleetManifest`, `FactRecord`.
- **Section comments** `// ── Section ──` (principles.md:32).
- **Collocated tests** `*.test.ts` next to `*.ts`; tests create temp dirs and clean up; **no fs mocks** (principles.md:20,44) — but note `medical.test.ts` DOES `vi.mock("../../config/loader.js")`; for the two-cwd visibility test prefer REAL temp dirs + REAL config files (the contract's two-cwd test needs real loadConfig).
- **CLI reads the absolute path from config ONLY** (contract nonGoal #5 + sc-2-7) — never re-derive `dbPath` from cwd; pass `config.fleet.blackboardDbPath` straight to `SharedBlackboard.open`.

### Architecture Decisions
No ADR doc specific to the blackboard was found in `.bober/architecture/` relevant to this sprint surface; the contract + Sprint 1 module are the source of truth. `SharedBlackboard`'s own JSDoc (shared-blackboard.ts:29-37) notes the single-host WAL-SQLite design.

### Other Docs
`bin` is `agent-bober` (contract assumption #4) — the command is `agent-bober blackboard publish|read`.

---

## 6. Testing Patterns

### Unit Test Pattern — schema (with/without)
**Source:** `src/config/schema.test.ts:70-105` (architect optional section).
```ts
describe("BoberConfigSchema — architect is optional (C3)", () => {
  it("parses a minimal config without architect", () => {
    const result = BoberConfigSchema.safeParse({ project: { name: "x", mode: "greenfield" }, /* required sections */ });
    expect(result.success).toBe(true);
  });
  it("parses a config with architect", () => {
    const result = BoberConfigSchema.safeParse({ /* ... */ architect: { panel: { lenses: ["scalability"] } } });
    if (result.success) expect(result.data.architect?.panel.lenses).toEqual(["scalability"]);
  });
});
```
**For fleet:** parse a config WITH `fleet:{blackboardDbPath,blackboardNamespace,blackboardSubject,maxRounds}` and WITHOUT; assert a no-fleet config's `result.data.fleet` is `undefined` (sc-2-3 byte-identical-to-prior). NOTE the full schema requires `project/planner/generator/evaluator/sprint/pipeline/commands` — use `loadConfig`-style minimal `{project:{name,mode}}` only via `PartialBoberConfigSchema`, OR build a full object; the architect test (schema.test.ts:73-89) shows the minimal full-schema shape needed.

### Unit Test Pattern — manifest (with/without + ZodError)
**Source:** `src/fleet/manifest.test.ts:92-141` (tier field describe).
```ts
describe("FleetManifestSchema — blackboard block", () => {
  it("parses a manifest without blackboard (undefined)", () => {
    const r = FleetManifestSchema.parse({ children: [{ folder: "x", task: "t" }] });
    expect(r.blackboard).toBeUndefined();
  });
  it("parses a manifest with blackboard and defaults maxRounds=3", () => {
    const r = FleetManifestSchema.parse({ children: [{ folder: "x", task: "t" }], blackboard: { namespace: "run-1" } });
    expect(r.blackboard?.maxRounds).toBe(3);
  });
  it("throws ZodError when maxRounds > 3", () => {
    expect(() => FleetManifestSchema.parse({ children: [{ folder: "x", task: "t" }], blackboard: { namespace: "r", maxRounds: 4 } })).toThrow();
  });
});
// resolveBlackboardPath:
it("resolveBlackboardPath returns abs .bober/memory/<ns>/facts.db", () => {
  const p = resolveBlackboardPath({ rootDir: "/tmp/root", concurrency: 3, children: [{folder:"a",task:"t"}], blackboard: { namespace: "ns", maxRounds: 3 } });
  expect(p).toBe(join(resolve("/tmp/root"), ".bober", "memory", "ns", "facts.db"));
});
it("resolveBlackboardPath returns undefined with no blackboard", () => {
  expect(resolveBlackboardPath({ rootDir: ".", concurrency: 3, children: [{folder:"a",task:"t"}] })).toBeUndefined();
});
```
**Runner:** vitest. **Assertion style:** `expect`. **File naming:** `*.test.ts` collocated.

### Unit Test Pattern — scaffolder injection + byte-identical-when-absent
**Source:** `src/fleet/scaffolder.test.ts:1-79` (real temp dir, reads back written `bober.config.json`, parses with `BoberConfigSchema`).
```ts
// WITH blackboard: scaffold, read child's bober.config.json, assert injected section
const blackboard = { dbPath: "/abs/shared/.bober/memory/ns/facts.db", namespace: "ns", maxRounds: 3 };
const res = await scaffolder.scaffold(tmpDir, { folder: "child-a", task: "t" }, blackboard);
const parsed = JSON.parse(await readFile(join(res.absPath, "bober.config.json"), "utf-8"));
expect(parsed.fleet.blackboardSubject).toBe("child-a");          // sc-2-5
expect(parsed.fleet.blackboardDbPath).toBe(blackboard.dbPath);   // absolute, from arg

// WITHOUT blackboard: byte-identical to today — no fleet key
const res2 = await scaffolder.scaffold(tmpDir2, { folder: "child-b", task: "t" });
const raw = await readFile(join(res2.absPath, "bober.config.json"), "utf-8");
expect(JSON.parse(raw).fleet).toBeUndefined();
// Optional strict byte-check: compare against JSON.stringify(buildChildConfig(child), null, 2)
```

### Unit Test Pattern — CLI core via DI + two-cwd shared visibility
**Source:** `src/cli/commands/medical.test.ts:1-60` (DI'd `runWhoopSync`, `process.exitCode` reset in `beforeEach`, temp dirs). For the two-cwd test prefer REAL configs (need real `loadConfig`).
```ts
// Two temp cwds sharing ONE blackboardDbPath (sc-2-7) — path comes from config, not cwd
const shared = join(tmpDir, "shared-facts.db");
const cwdA = await mkdtemp(...); const cwdB = await mkdtemp(...);
await writeFile(join(cwdA, "bober.config.json"), JSON.stringify({ project:{name:"a",mode:"greenfield"}, fleet:{ blackboardDbPath: shared, blackboardNamespace:"run-1", blackboardSubject:"a", maxRounds:3 } }));
await writeFile(join(cwdB, "bober.config.json"), JSON.stringify({ project:{name:"b",mode:"greenfield"}, fleet:{ blackboardDbPath: shared, blackboardNamespace:"run-1", blackboardSubject:"b", maxRounds:3 } }));
await runBlackboardPublish(cwdA, "hello", {}, "2026-06-18T00:00:00.000Z");   // subject a
// read --all from cwdB sees a's "hello"; verify via SharedBlackboard.readAll at `shared` OR capture stdout
const verify = await SharedBlackboard.open({ dbPath: shared, namespace: "run-1", maxRounds: 3 });
expect(verify.readAll().some(f => f.value === "hello")).toBe(true);
verify.close();
// no-fleet error path:
await writeFile(join(cwdC, "bober.config.json"), JSON.stringify({ project:{name:"c",mode:"greenfield"} }));
await runBlackboardPublish(cwdC, "x", {});
expect(process.exitCode).toBe(1);   // printed message, no throw
```
**Mock approach:** prefer real temp dirs for the visibility/no-config tests (principles.md:44); `vi.spyOn(process.stdout, "write")` to capture `read` output if asserting printed lines. Reset `process.exitCode=0` in `beforeEach` (medical.test.ts:55).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/config/loader.ts` | `BoberConfigSchema` | low | Adding an OPTIONAL key does not change parse of existing configs; `fleet` flows through the `partial` spread (loader.ts:235). No loader edit needed. |
| `src/fleet/child-config.ts` | `BoberConfigSchema.parse` (line 52) | low | New optional key does not affect `buildChildConfig` output when `child.config` has no `fleet`. |
| `src/fleet/scaffolder.test.ts` | scaffold signature | medium | New 3rd param is OPTIONAL — existing 2-arg calls (test.ts:25,59,98) keep compiling and must stay byte-identical. |
| `src/fleet/index.ts` (validateManifestCredentials, runFleet) | `FleetManifest` | low | New optional `blackboard` field on the manifest does not change credential validation or `assertManifest`. |
| `src/fleet/coordinator.ts` / `aggregator.ts` / `reporter.ts` | `FleetManifest` | low | They consume `children`/`rootDir`/`concurrency` only; an extra optional field is inert. |
| `src/cli/index.ts` | new register import | low | Pure addition; mirror existing register calls. |
| Any config-consumer test that snapshots a full BoberConfig | `BoberConfigSchema` | medium | If a snapshot exists, an absent optional key keeps the snapshot stable (Zod does not emit undefined optionals). Verify no `toEqual(fullConfigObject)` test newly fails. |

### Existing Tests That Must Still Pass
- `src/config/schema.test.ts` — optional-section parse tests (architect/history/medical). New `fleet` must not perturb them; a no-fleet config still parses as before (sc-2-3).
- `src/fleet/manifest.test.ts` — `load()` defaults + `FleetChildSchema` tier tests; a no-blackboard manifest parses identically (sc-2-4).
- `src/fleet/scaffolder.test.ts` — fresh-scaffold (writes Zod-valid config), non-empty-folder safety, mkdir-error capture. The 2-arg calls must keep producing byte-identical configs (sc-2-8).
- `src/fleet/shared-blackboard.test.ts` — unchanged (Sprint 1 module not edited).
- `src/fleet/child-config.test.ts` (if present) — `buildChildConfig` output stable for no-fleet children.
- FULL suite: only the 6 known cockpit-integration MCP failures may fail (sc-2-2).

### Features That Could Be Affected
- **Fleet run (`agent-bober fleet`)** — shares `src/fleet/index.ts`, `manifest.ts`, `scaffolder.ts`, `child-config.ts`. Verify a no-blackboard manifest still scaffolds byte-identically and runs (sc-2-8). The coordinator loop is NOT touched this sprint.
- **`agent-bober facts` / `bober medical`** — share `loadConfig` + `FactStore`. Verify those CLIs still load config and open their stores unchanged (the `fleet` key is optional and unrelated to their reads).

### Recommended Regression Checks
1. `npm run build` (tsc strict) — zero errors.
2. `npx vitest run src/config/schema.test.ts src/fleet/manifest.test.ts src/fleet/scaffolder.test.ts src/fleet/shared-blackboard.test.ts src/cli/commands/blackboard.test.ts` — targeted.
3. `npx vitest run` — full suite; confirm only the 6 known cockpit MCP failures remain.
4. `npm run lint` — `consistent-type-imports` + unused-vars clean.
5. Manual byte-identity: scaffold a child WITHOUT a blackboard arg and diff `bober.config.json` against `JSON.stringify(buildChildConfig(child), null, 2)` — must be identical (no `fleet` key).

---

## 8. Implementation Sequence

1. **`src/config/schema.ts`** — add `FleetSectionSchema` + `FleetSection` type next to `MedicalSectionSchema` (after line 401); add `fleet: FleetSectionSchema.optional()` to `BoberConfigSchema` (after line 433).
   - Verify: `npx tsc --noEmit` clean; `BoberConfigSchema.safeParse` of a config with/without `fleet` both succeed.
2. **`src/config/schema.test.ts`** — add the with/without `fleet` describe.
   - Verify: `npx vitest run src/config/schema.test.ts` green.
3. **`src/fleet/manifest.ts`** — add the optional `blackboard` block to `FleetManifestSchema`.
   - Verify: parse manifest with `maxRounds:4` throws; without `blackboard` is `undefined`.
4. **`src/fleet/index.ts`** — add `resolve` to the `node:path` import (line 12); export `resolveBlackboardPath(manifest)`.
   - Verify: returns absolute `.bober/memory/<ns>/facts.db`; `undefined` with no blackboard.
5. **`src/fleet/manifest.test.ts`** — add blackboard parse tests + `resolveBlackboardPath` tests (import from `./index.js`).
   - Verify: `npx vitest run src/fleet/manifest.test.ts` green.
6. **`src/fleet/scaffolder.ts`** — add optional 3rd `blackboard?` param; set `config.fleet` inside the `if (blackboard)` guard before `JSON.stringify` (lines 56-57). Thread the descriptor from `runFleet`'s scaffold call site IF one exists in this sprint's scope; otherwise just accept the param (Sprint 3 wires the coordinator loop).
   - Verify: existing 2-arg scaffolder tests still pass byte-identically.
7. **`src/fleet/scaffolder.test.ts`** — add injection test (subject===folder, abs path) + byte-identical-when-absent test.
   - Verify: `npx vitest run src/fleet/scaffolder.test.ts` green.
8. **`src/cli/commands/blackboard.ts`** — create with `runBlackboardPublish`/`runBlackboardRead` cores (DI projectRoot + nowIso) + `registerBlackboardCommand`. Reads `config.fleet` ONLY for the db path; clean exit-1-no-throw when absent; `close()` in `finally`.
   - Verify: typecheck clean; imports end in `.js`.
9. **`src/cli/index.ts`** — import + call `registerBlackboardCommand(program)` after the chat registration (line 324).
   - Verify: typecheck clean.
10. **`src/cli/commands/blackboard.test.ts`** — publish (writes finding, verify via readAll), read (--all / siblings), no-fleet error path (exitCode 1, no throw), two-cwd shared-visibility via one shared `blackboardDbPath`.
    - Verify: `npx vitest run src/cli/commands/blackboard.test.ts` green.
11. **Run full verification** — `npm run build`, `npx vitest run` (only 6 cockpit MCP fails allowed), `npm run lint`.

---

## 9. Pitfalls & Warnings

- **Zod strips unknown keys** — you MUST declare `FleetSectionSchema` on `BoberConfigSchema`; an undeclared `fleet` written by the scaffolder would be silently dropped when the child loads its config (the entire reason this is a "child-visible channel").
- **Byte-identical no-blackboard scaffold (sc-2-8):** only set `config.fleet` inside `if (blackboard)`. Do NOT add a `fleet: undefined` key or reorder the object — `JSON.stringify(buildChildConfig(child), null, 2)` must produce the exact same bytes as today. Existing 2-arg scaffolder tests guard this.
- **CLI reads the path from config ONLY (sc-2-7, nonGoal #5):** pass `config.fleet.blackboardDbPath` straight to `SharedBlackboard.open`. Do NOT re-derive from cwd, do NOT call `resolveBlackboardPath` in the CLI. The two-cwd test proves cwd B sees cwd A's finding precisely because the path lives in config, not cwd.
- **CLI never throws (facts.ts:11, medical.ts):** missing `fleet` section, missing config file (`loadConfig` throws), and any error → print to stderr + `process.exitCode = 1` + `return`. Wrap `loadConfig` in the try/catch.
- **Stamp the clock at the CLI boundary:** `SharedBlackboard.publish(finding, now)` takes `now` as a parameter — the store is PURE (facts.ts:130). Default `nowIso = new Date().toISOString()` in the core and let tests inject a fixed ISO.
- **`maxRounds` is double-capped:** schema `.max(3)` AND `SharedBlackboard.open` re-caps at `BLACKBOARD_MAX_ROUNDS=3` (shared-blackboard.ts:62-65). Keep `.max(3)` on BOTH `config.fleet.maxRounds` and `manifest.blackboard.maxRounds`.
- **`resolveBlackboardPath` must be ABSOLUTE:** use `join(resolve(manifest.rootDir), ...)` — `rootDir` defaults to `"."` so without `resolve()` you'd emit a relative path and the cross-cwd test would fail.
- **Add `resolve` to the `node:path` import in index.ts:12** (currently `import { join } from "node:path"`) — forgetting it is a compile error.
- **`runFleet` does not call the scaffolder directly** (it delegates to `FleetCoordinator.execute`, index.ts:118) — for THIS sprint, exporting `resolveBlackboardPath` + accepting the optional scaffolder param is sufficient; do NOT build the coordinator round loop (Sprint 3) or write `fleet-synthesis.json` (Sprint 4).
- **Use real temp dirs for the two-cwd test** (principles.md:44 "no fs mocks") — `loadConfig` must read REAL `bober.config.json` files; `vi.mock("../../config/loader.js")` (as medical.test.ts does) would defeat the path-from-config proof. Reserve mocking for the no-config error branch only if convenient.
