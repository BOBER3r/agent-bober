# Sprint Briefing: Add preset-aware command filtering to installClaudeCommands

**Contract:** sprint-spec-20260416-auto-filter-commands-1
**Generated:** 2026-04-16T12:30:00Z

---

## 1. Target Files

### src/cli/commands/init.ts (modify)

This is the ONLY file to modify. It is 1105 lines long. The changes touch two functions and require a new constant.

**Relevant section 1 — `installClaudeCommands` (lines 944-1028):**

```typescript
// ── Install Claude Code slash commands ───────────────────────────

/**
 * Copy SKILL.md files from the package's skills/ directory into
 * the project's .claude/commands/ directory so they appear as
 * /bober-plan, /bober-sprint, etc. in Claude Code.
 *
 * Also copies agent definitions into .claude/agents/.
 */
async function installClaudeCommands(projectRoot: string): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  // From dist/cli/commands/init.js → go up to package root
  const packageRoot = join(dirname(__filename), "..", "..", "..");

  const commandsDir = join(projectRoot, ".claude", "commands");
  await ensureDir(commandsDir);

  // Map skill directories to command file names
  const skillMap: Record<string, string> = {
    "bober.plan": "bober-plan.md",
    "bober.sprint": "bober-sprint.md",
    "bober.eval": "bober-eval.md",
    "bober.run": "bober-run.md",
    "bober.react": "bober-react.md",
    "bober.brownfield": "bober-brownfield.md",
    "bober.solidity": "bober-solidity.md",
    "bober.anchor": "bober-anchor.md",
    "bober.principles": "bober-principles.md",
    "bober.playwright": "bober-playwright.md",
    "bober.research": "bober-research.md",
    "bober.architect": "bober-architect.md",
  };

  const skillsRoot = join(packageRoot, "skills");
  let installed = 0;

  for (const [skillDir, cmdFile] of Object.entries(skillMap)) {
    // ... copies each skill file to .claude/commands/
  }

  // Copy agent definitions (lines 1006-1020) — LEAVE UNCHANGED
  const agentsDir = join(projectRoot, ".claude", "agents");
  // ...copies agent .md files...

  if (installed > 0) {
    logger.success(
      `Installed ${installed} slash commands in .claude/commands/`,
    );
    logger.success(`Installed agent definitions in .claude/agents/`);
  }
}
```

**Relevant section 2 — `writeConfig` (lines 1042-1104), specifically the call at line 1077:**

```typescript
async function writeConfig(
  projectRoot: string,
  config: ConfigShape,
  mode: ProjectMode,
  strategies: Array<{ type: string; required: boolean }>,
  preset?: string,
  provider?: SupportedProvider,
): Promise<void> {
  // ... writes config, creates .bober/, updates .gitignore ...

  // Install Claude Code slash commands into .claude/commands/
  await installClaudeCommands(projectRoot);  // <-- line 1077: ADD mode, preset here

  // ... prints summary ...
}
```

**All three call sites of `writeConfig` (which calls `installClaudeCommands`):**

| Call Site | Line | Mode | Preset | Flow |
|-----------|------|------|--------|------|
| `brownfieldFlow` | 650 | `"brownfield"` | `undefined` | Auto-discovery brownfield |
| `brownfieldManualFlow` | 763 | `"brownfield"` | `undefined` | Manual brownfield fallback |
| `greenfieldFlow` | 901 | `"greenfield"` | `selectedPreset` (string or undefined) | Greenfield with optional preset |

**Key detail:** `writeConfig` already receives `mode` (ProjectMode) and `preset` (optional string) as parameters. It just needs to forward them to `installClaudeCommands`.

**Imports this file uses (relevant to the change):**
- `type { ProjectMode }` from `../../config/schema.js` (line 7) — already imported
- `fileURLToPath` from `node:url` (line 3)
- `join, basename, dirname` from `node:path` (line 2)
- `readFile, readdir` from `node:fs/promises` (line 1)
- `fileExists, ensureDir` from `../../utils/fs.js` (line 12)
- `logger` from `../../utils/logger.js` (line 13)

**Imported by:**
- `src/cli/index.ts:11` — imports `runInitCommand`
- `src/mcp/tools/init.ts:6` — imports from a **different** init tool (MCP version, does NOT call `installClaudeCommands`)

**Test file:** No test file exists for `src/cli/commands/init.ts`. No file at `src/cli/commands/init.test.ts`.

---

## 2. Patterns to Follow

### Module-Level Constants with Section Headers
**Source:** `src/cli/commands/init.ts`, lines 182-217
```typescript
// ── Preset metadata ──────────────────────────────────────────────

interface PresetInfo {
  name: string;
  label: string;
  description: string;
}

const PRESET_INFO: PresetInfo[] = [
  { name: "nextjs", label: "nextjs", description: "Next.js full-stack app" },
  // ...
];
```
**Rule:** Use unicode box-drawing section headers (`// -- Section Name ------`) when defining new module-level constants. Define types/interfaces inline above the constant.

### Type Imports (ESLint enforced)
**Source:** `src/cli/commands/init.ts`, lines 7-8
```typescript
import type { EvalStrategyType, ProjectMode } from "../../config/schema.js";
import { createDefaultConfig } from "../../config/schema.js";
```
**Rule:** Use `import type { ... }` for type-only imports. ESLint rule `@typescript-eslint/consistent-type-imports` enforces this — build will fail otherwise.

### ESM .js Extensions in Imports
**Source:** `src/cli/commands/init.ts`, line 9
```typescript
import { configExists } from "../../config/loader.js";
```
**Rule:** All relative imports MUST use `.js` extensions (NodeNext module resolution). The tsconfig uses `"module": "NodeNext"`.

### Private Functions at Module Level
**Source:** `src/cli/commands/init.ts`, lines 953, 1042
```typescript
async function installClaudeCommands(projectRoot: string): Promise<void> {
  // ...
}

async function writeConfig(
  projectRoot: string,
  config: ConfigShape,
  // ...
): Promise<void> {
  // ...
}
```
**Rule:** Non-exported helper functions are defined as standalone `async function` declarations at module level. They are NOT exported — only `runInitCommand` and `InitCommandOptions` are exported from this file.

### Record/Map Data Structure Pattern
**Source:** `src/cli/commands/init.ts`, lines 962-975
```typescript
const skillMap: Record<string, string> = {
  "bober.plan": "bober-plan.md",
  "bober.sprint": "bober-sprint.md",
  "bober.eval": "bober-eval.md",
  // ...
};
```
**Rule:** Use `Record<string, T>` for map-like constants with explicit type annotation. Keys are string literals.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `fileExists` | `src/utils/fs.ts:10` | `(path: string): Promise<boolean>` | Async check if a file exists and is readable |
| `readJson` | `src/utils/fs.ts:24` | `<T>(path: string): Promise<T>` | Read and parse a JSON file |
| `writeJson` | `src/utils/fs.ts:34` | `(path: string, data: unknown): Promise<void>` | Write pretty-printed JSON to a file |
| `ensureDir` | `src/utils/fs.ts:45` | `(path: string): Promise<void>` | Create directory and parents if needed |
| `findProjectRoot` | `src/utils/fs.ts:58` | `(startDir?: string): Promise<string \| null>` | Walk up dirs looking for project root |
| `logger` | `src/utils/logger.ts:87` | `Logger` instance | Singleton logger with info/success/warn/error/debug/phase/sprint methods |
| `getPresetNames` | `src/config/defaults.ts:54` | `(): string[]` | Returns known preset names: nextjs, react-vite, solidity, anchor, api-node, python-api |
| `getDefaults` | `src/config/defaults.ts:237` | `(mode: ProjectMode, preset?: string): Partial<BoberConfig>` | Returns default config for mode+preset |
| `createDefaultConfig` | `src/config/schema.ts:186` | `(projectName, mode, preset?, overrides?): BoberConfig` | Create full default config |
| `ProjectModeSchema` | `src/config/schema.ts:5` | `z.enum(["greenfield", "brownfield"])` | Zod schema for project mode |
| `ProjectMode` | `src/config/schema.ts:6` | `"greenfield" \| "brownfield"` | TypeScript type for project mode |
| `KNOWN_PRESETS` | `src/config/defaults.ts:42` | `string[]` | Array of known preset names |

---

## 4. Prior Sprint Output

No prior sprints completed. This is Sprint 1.

---

## 5. Relevant Documentation

### Project Principles
Key principles from `.bober/principles.md` relevant to this sprint:
- **ESM everywhere:** All imports use `.js` extensions for NodeNext resolution.
- **Use `type` imports:** ESLint enforces `consistent-type-imports`.
- **Section comments:** Use unicode box-drawing section headers: `// -- Section Name ------`.
- **Prefix unused params with `_`.** The `_` prefix is the only escape hatch.
- **No `any` without justification.** Use `unknown` + type narrowing.
- **No synchronous filesystem ops.** All fs operations use `node:fs/promises`.

### Architecture Decisions
No architecture docs found in `.bober/architecture/`.

### Other Docs
- **tsconfig.json:** `"module": "NodeNext"`, `"strict": true`, `"noUnusedLocals": true`, `"noUnusedParameters": true`. Test files (`**/*.test.ts`) are excluded from compilation.
- **eslint.config.js:** Enforces `@typescript-eslint/consistent-type-imports: "error"`, `@typescript-eslint/no-unused-vars: ["error", { argsIgnorePattern: "^_" }]`.
- **package.json scripts:** `build: tsc`, `typecheck: tsc --noEmit`, `lint: eslint src/`, `test: vitest`.

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/providers/factory.test.ts`
```typescript
import { describe, it, expect } from "vitest";
import { createClient, validateApiKey } from "./factory.js";
import { GoogleAdapter } from "./google.js";

describe("createClient factory", () => {
  describe("google provider", () => {
    it("creates a GoogleAdapter for explicit provider 'google' with inline key", () => {
      const client = createClient(
        "google",
        null,
        { apiKey: FAKE_GOOGLE_KEY },
        "gemini-2.5-pro",
      );
      expect(client).toBeInstanceOf(GoogleAdapter);
    });
  });
});
```
**Runner:** vitest (no config file — uses defaults from package.json)
**Assertion style:** `expect(...)` from vitest
**Mock approach:** vitest built-in (`vi.mock`) — but this project prefers real filesystem tests over mocks (see principles: "No test mocks for filesystem")
**File naming:** `*.test.ts` co-located next to source
**Location:** Co-located (e.g., `src/providers/factory.test.ts` alongside `src/providers/factory.ts`)

### Scanner Test Pattern (Filesystem Tests)
**Source:** `src/discovery/scanner.test.ts`, lines 1-48
```typescript
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { scanProject } from "./scanner.js";

const PROJECT_ROOT = process.cwd();

describe("scanProject()", () => {
  it("returns a DiscoveryReport with all required sections", async () => {
    const report = await scanProject(PROJECT_ROOT);
    expect(report).toMatchObject({
      projectRoot: PROJECT_ROOT,
      scannedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });
});
```
**Note:** Tests use the real project directory — no mocks for filesystem. For isolated tests, temp directories are created with `mkdir` and cleaned up with `rm`.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
Files that import from or depend on `src/cli/commands/init.ts`:

| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/index.ts` | `runInitCommand` from init.ts | **Low** | Only imports `runInitCommand` which is NOT being changed. Signature stays the same. |
| `src/mcp/tools/init.ts` | Does NOT import from cli/commands/init.ts — separate implementation | **None** | Has its own init logic, does not call `installClaudeCommands`. |

### Existing Tests That Must Still Pass
Tests that cover functionality related to this sprint:

- `src/discovery/scanner.test.ts` — tests the `scanProject()` function used in brownfield flow. Not directly affected but run it to ensure no regressions.
- `src/discovery/config-generator.test.ts` — tests `generateEvalConfig()` used in brownfield flow. Not affected.
- `src/discovery/synthesizer.test.ts` — tests principle synthesis. Not affected.
- `src/mcp/tools/tools.test.ts` — verifies all MCP tools register correctly. Not affected (MCP init is separate).
- `src/providers/factory.test.ts` — provider factory tests. Not affected.

**Note:** There are NO existing tests for `installClaudeCommands` or `writeConfig`. Changes cannot break existing tests unless a type error or lint error is introduced.

### Features That Could Be Affected
- **MCP init tool** (`src/mcp/tools/init.ts`) — has a completely separate implementation that does NOT call `installClaudeCommands`. It only writes config + creates `.bober/` dir. No slash command installation. **No risk.**
- **CLI init flow** — All three flows (brownfield auto, brownfield manual, greenfield) call `writeConfig` which calls `installClaudeCommands`. All three must be checked.

### Recommended Regression Checks
After implementation, the Generator MUST verify:
1. `npm run typecheck` — zero TypeScript errors (sc-1-2)
2. `npm run lint` — zero ESLint errors (sc-1-3)
3. `npm run build` — clean build (sc-1-1)
4. `npm run test` — all existing tests pass (sc-1-7)
5. Manual: verify `installClaudeCommands` signature has `mode` and `preset` params (sc-1-4)
6. Manual: verify a clear constant/map defines universal vs stack-specific commands (sc-1-5)
7. Manual: verify all `writeConfig` call sites pass `mode` and `preset` through (sc-1-6)

---

## 8. Implementation Sequence

1. **Define the command categorization constant** — Add a module-level constant (above `installClaudeCommands`, around line 944) that categorizes each skill key as universal or stack-specific.
   - Structure: A `Set<string>` for universal commands + a `Record<string, string[]>` mapping stack-specific commands to presets they belong to.
   - Universal commands (always installed): `bober.plan`, `bober.sprint`, `bober.eval`, `bober.run`, `bober.principles`, `bober.research`, `bober.architect`
   - Stack-specific: `bober.react` (nextjs, react-vite), `bober.solidity` (solidity), `bober.anchor` (anchor), `bober.brownfield` (brownfield mode), `bober.playwright` (nextjs, react-vite, brownfield mode)
   - Verify: Read the constant and confirm all 12 skill keys are accounted for.

2. **Update `installClaudeCommands` signature** — Add `mode: string` and `preset?: string` parameters after `projectRoot`.
   - Verify: `npm run typecheck` passes.

3. **Add filtering logic inside `installClaudeCommands`** — Before the `for` loop (line 980), filter `skillMap` entries.
   - Logic: If greenfield + no preset → install everything. If greenfield + preset → install universal + commands matching that preset. If brownfield → install universal + brownfield + playwright.
   - Keep the agent file installation (lines 1006-1020) UNCHANGED — agents are always installed.
   - Verify: Read the function and confirm the filter logic matches the spec.

4. **Update `writeConfig` to pass `mode` and `preset`** — Change line 1077 from `await installClaudeCommands(projectRoot)` to `await installClaudeCommands(projectRoot, mode, preset)`.
   - `writeConfig` already has `mode: ProjectMode` and `preset?: string` as parameters.
   - Verify: `npm run typecheck` passes.

5. **Run full verification** — `npm run build`, `npm run typecheck`, `npm run lint`, `npm run test`
   - All four must pass with zero errors.

---

## 9. Pitfalls & Warnings

- **Do NOT modify the agent file installation block (lines 1006-1020).** The contract says agents are always installed — only slash commands are filtered.
- **`noUnusedLocals` and `noUnusedParameters` are enforced in tsconfig.** If you define a type or parameter that is unused, `tsc --noEmit` will fail. Prefix unused params with `_`.
- **`consistent-type-imports` ESLint rule.** If you add any type imports (e.g., `ProjectMode`), use `import type { ... }`. This is already correctly imported at line 7 — do NOT add a duplicate import.
- **The `skillMap` variable is currently defined inside `installClaudeCommands`.** The new categorization constant should be at module level (before the function) for clarity, matching the pattern used by `PRESET_INFO` at line 190.
- **All 12 skill keys must be accounted for.** Missing a key means a command silently won't be installed. Cross-reference against the `skills/` directory listing: `bober.anchor`, `bober.architect`, `bober.brownfield`, `bober.eval`, `bober.plan`, `bober.playwright`, `bober.principles`, `bober.react`, `bober.research`, `bober.run`, `bober.solidity`, `bober.sprint`.
- **Do NOT change `runInitCommand` or `InitCommandOptions` exports.** They are imported by `src/cli/index.ts` — changing their signature would be out of scope.
- **The MCP init tool (`src/mcp/tools/init.ts`) does NOT call `installClaudeCommands`.** Do not modify it. It is a separate code path.
- **Greenfield + no preset should install ALL commands** (user hasn't committed to a stack yet — they may need any of the specialized commands).
- **`writeConfig` already receives both `mode` and `preset`** — just forward them. Do not introduce a new way to get these values.
