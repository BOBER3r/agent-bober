# Sprint Briefing: Add docsMode/docsDir config keys and mode-aware runDocumenter behavior

**Contract:** sprint-spec-20260731-documenter-docs-output-1
**Generated:** 2026-07-31T00:00:00Z

---

## 1. Target Files

### src/config/schema.ts (modify)

**Relevant section (lines 299-313) — the exact block to extend:**

```ts
/**
 * Per-sprint documenter — writes docs immediately after a sprint's evaluator
 * passes (instead of batching all docs into a final sprint). Advisory: a
 * documenter failure never downgrades the already-passed sprint.
 */
export const DocumenterSectionSchema = z.object({
  timeoutMs: z.number().int().positive().default(300_000),
  enabled: z.boolean().default(true),
  model: ModelChoiceSchema.default("sonnet"),
  maxTurns: z.number().int().min(1).default(20),
  provider: z.string().optional(),
  endpoint: z.string().nullable().optional(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
});
export type DocumenterSection = z.infer<typeof DocumenterSectionSchema>;
```

**Sibling style to match for the doc comments on the new keys** (`src/config/schema.ts:281-295`, the `verifier` block inside `SecuritySectionSchema`):

```ts
  /**
   * Sprint-8: opt-in adversarial finder->verifier stage config. OPTIONAL
   * with no outer default — a config that omits `verifier` entirely stays
   * byte-identical (no defaults leak in), same guarantee as `diff` /
   * `supplyChain` / `egress` above (sc-8-5). `maxTurns` defaults lower than
   * the finder's (10 vs 20) — refutation needs fewer turns than the
   * original audit.
   */
  verifier: z
    .object({
      enabled: z.boolean().default(false),
      model: ModelChoiceSchema.default("opus"),
      maxTurns: z.number().int().min(1).default(10),
    })
    .optional(),
```

**Enum-with-default precedent** (`src/config/schema.ts:216-220` and `:261`):

```ts
export const SecurityDiffConfigSchema = z.object({
  mode: z.enum(["estimated-files", "git-diff"]).default("estimated-files"),
  baseRef: z.string().optional(),
  expandWithGraph: z.boolean().default(false),
});
```
```ts
  /** Blocking threshold for the standalone `bober security-audit` CLI (sprint 4). */
  standaloneBlockOn: z.enum(["critical", "important"]).default("critical"),
```

**Wiring point (unchanged, do NOT touch)** — `src/config/schema.ts:815`:

```ts
  codeReview: CodeReviewSectionSchema.optional(),
  documenter: DocumenterSectionSchema.optional(),
```

**Imports this file uses:** `import { z } from "zod";` (line 1). Nothing else — schema.ts has zero non-zod imports; keep it that way (no `node:path`, no `node:os` in schema.ts).

**Imported by (only the ones that matter here):**
- `src/config/loader.ts:5-9` — imports `BoberConfigSchema`, `PartialBoberConfigSchema`, `type BoberConfig`. Verified: `loader.ts`, `defaults.ts`, `config/index.ts`, `discovery/config-generator.ts` and `cli/commands/config.ts` contain **zero** references to `documenter` (grep), so no loader/default plumbing is needed for the new keys.
- `src/orchestrator/documenter-agent.ts:1` — `import type { BoberConfig } from "../config/schema.js";`
- `src/config/schema.test.ts:4-25` — imports individual section schemas by name.

**Test file:** `src/config/schema.test.ts` (exists, 1299 lines).

---

### src/config/schema.test.ts (modify)

**Where to add:** append a `describe("DocumenterSectionSchema — docsMode/docsDir ...")` block near the other opt-in-section describes (after line 829, before `describe("BoberConfigSchema — security section is optional...")` at line 831), and import `DocumenterSectionSchema` in the import list at lines 4-25 (currently it is NOT imported).

**Template to copy — `src/config/schema.test.ts:798-829`:**

```ts
describe("SecuritySectionSchema.verifier — opt-in adversarial verifier config (sc-8-5)", () => {
  it("parse({}) still has NO verifier key — byte-identical to pre-sprint-8 behavior", () => {
    const parsed = SecuritySectionSchema.parse({});
    expect(parsed).toEqual({
      enabled: false,
      failClosed: true,
      timeoutMs: 300_000,
      model: "opus",
      maxTurns: 20,
      scanners: [],
      standaloneBlockOn: "critical",
      hub: true,
    });
    expect(Object.hasOwn(parsed, "verifier")).toBe(false);
  });

  it("parse({ verifier: {} }) defaults enabled:false, model:'opus', maxTurns:10", () => {
    const parsed = SecuritySectionSchema.parse({ verifier: {} });
    expect(parsed.verifier).toEqual({ enabled: false, model: "opus", maxTurns: 10 });
  });

  it("rejects maxTurns < 1 on the verifier sub-object", () => {
    expect(() => SecuritySectionSchema.parse({ verifier: { maxTurns: 0 } })).toThrow();
  });
});
```

**Minimal full-config fixture used by the `BoberConfigSchema` describes** (`src/config/schema.test.ts:832-840`) — reuse this shape for the "config omitting the new keys resolves identically" test:

```ts
  const minimalBase = {
    project: { name: "test-project", mode: "greenfield" },
    planner: {},
    generator: {},
    evaluator: { strategies: [] },
    sprint: {},
    pipeline: {},
    commands: {},
  };
```

**Naming-the-key assertion pattern (sc-1-1 requires the error to name `docsMode`).** No existing test asserts on `issue.path`, so use zod's standard shape:

```ts
const result = DocumenterSectionSchema.safeParse({ docsMode: "bogus" });
expect(result.success).toBe(false);
if (!result.success) {
  expect(result.error.issues.some((i) => i.path.includes("docsMode"))).toBe(true);
}
```

---

### src/orchestrator/documenter-agent.ts (modify)

**Imports currently at lines 1-10:**

```ts
import type { BoberConfig } from "../config/schema.js";
import type { SprintContract } from "../contracts/sprint-contract.js";
import type { EvaluationRunResult } from "../evaluators/registry.js";
import type { GeneratorResult } from "./generator-agent.js";
import { createClient } from "../providers/factory.js";
import { logger } from "../utils/logger.js";
import { resolveModel } from "./model-resolver.js";
import { assembleSystemPrompt } from "./agent-loader.js";
import { resolveRoleTools, getGraphState, getGraphDeps } from "./tools/index.js";
import { runAgenticLoop } from "./agentic-loop.js";
```

**Config-threading pattern to mirror for `docsMode`/`docsDir` (lines 72-89):**

```ts
  const documenterModel = config.documenter?.model ?? config.generator.model;
  const model = resolveModel(documenterModel);
  const maxTurns = config.documenter?.maxTurns ?? 20;
  ...
  const client = createClient(
    config.documenter?.provider ?? config.generator.provider ?? null,
    config.documenter?.endpoint ?? config.generator.endpoint ?? null,
    config.documenter?.providerConfig ?? config.generator.providerConfig,
    documenterModel,
    "Documenter",
  );
```

> Note the `config.documenter?.x ?? <literal fallback>` shape — it does NOT rely on zod defaults having been applied. Keep that: several test fixtures pass hand-written config literals (see §7), so `config.documenter?.docsMode ?? "committed"` is mandatory, not optional.

**The hardcoded path to replace — line 106:**

```ts
  const sprintDocPath = `docs/sprints/${contractId}.md`;
```

**The prompt block to extract into an exported builder — lines 108-151 (verbatim, this is the `committed` text that sc-1-4 says must be preserved):**

```ts
  const userMessage = `# Sprint Contract

${contractJson}

# Evaluation Result (Already Passed)

${evalSummary}

# Files Changed This Sprint (from the generator report)

${filesChanged}

# Project Root

${projectRoot}

# Context

- Contract ID: ${contractId}
- Spec ID: ${contract.specId}
- The implementation is ALREADY complete, evaluated, and committed.
- Your job is documentation ONLY. Do NOT modify application code, tests, configs, or build files.

# Your Task

1. Inspect what actually shipped: run \`git show --stat HEAD\` and \`git diff HEAD~1 HEAD\` on the changed files. Read the source of the key new/changed symbols — do not document from filenames alone.
2. Write a focused per-sprint record to ${sprintDocPath} (create docs/sprints/ if needed): what the sprint added, the public surface (symbols/endpoints/CLI commands/config keys with file:line), how it fits, and maintainer notes.
3. Find & update related existing docs the change made stale: grep README.md, docs/**, CLAUDE.md, AGENTS.md, ADRs, and module docs for the names of changed symbols/commands/config keys. Update only what is genuinely inaccurate or now-missing. Match each doc's existing voice and formatting.
4. Commit ONLY the documentation files (verify with \`git status\` that no source/test files are staged):
   \`git add <doc files> && git commit -m "bober(${contractId}): docs for <short title>"\`

If you believe code is wrong, do NOT fix it — record it in "concerns".

Output ONLY a JSON object (no markdown fences):
{
  "contractId": "${contractId}",
  "sprintDocPath": "${sprintDocPath}",
  "relatedDocsUpdated": [
    {"path": "<path>", "reason": "<why it was stale / what you changed>"}
  ],
  "docsCommit": "<hash> - <message>",
  "concerns": [],
  "summary": "<2-3 sentence summary>"
}`;
```

**The two consumers of `sprintDocPath` further down (lines 175 and 192-196) — the sc-1-5 seam:**

```ts
  const docResult = parseDocumentationResult(result.finalText, contractId, sprintDocPath);
```
```ts
export function parseDocumentationResult(
  text: string,
  contractId: string,
  defaultSprintDocPath: string,
): DocumentationResult {
```

`parseDocumentationResult`'s signature already takes the default as a parameter — sc-1-5 is satisfied by passing the mode-resolved path here. **Do not change this signature**; four existing tests call it positionally (`src/orchestrator/documenter-agent.test.ts:326, 338, 345, 362`).

**Section-comment convention in this file** (lines 12, 36, 184) — reuse it for any new section:

```ts
// ── Types ──────────────────────────────────────────────────────────
// ── Main ───────────────────────────────────────────────────────────
// ── JSON parser ────────────────────────────────────────────────────
```

**Imported by:**
- `src/orchestrator/pipeline.ts:36` — `import { runDocumenter } from "./documenter-agent.js";` (call site at `pipeline.ts:611-618`, must stay intact)
- `src/orchestrator/documenter-agent.test.ts:97,217,256,291,317,...`
- `src/orchestrator/pipeline.test.ts:103,290,368,419`
- NOT re-exported from `src/index.ts` (grep for "documenter" in `src/index.ts` → no matches), so no public-API surface to update.

**Test file:** `src/orchestrator/documenter-agent.test.ts` (exists, 366 lines).

---

### src/orchestrator/documenter-agent.test.ts (modify)

**Existing structure:** a `describe("documenter pipeline integration")` block (lines 198-311) that drives `runSprintCycle` with everything heavy mocked, plus a `describe("parseDocumentationResult")` block (lines 315-366) of pure unit tests. Add new `describe` blocks for `resolveSprintDocPath` and `buildDocumenterUserMessage` in the pure-unit style of the second block — do NOT extend the mocked-pipeline block.

**Pure-unit pattern to copy (lines 316-331):**

```ts
describe("parseDocumentationResult", () => {
  it("parses a clean JSON object", async () => {
    const { parseDocumentationResult } = await import("./documenter-agent.js");
    const text = JSON.stringify({
      contractId: "c1",
      sprintDocPath: "docs/sprints/c1.md",
      relatedDocsUpdated: [{ path: "README.md", reason: "added flag" }],
      docsCommit: "abc - docs",
      concerns: ["typo in foo.ts comment"],
      summary: "Wrote docs.",
    });
    const result = parseDocumentationResult(text, "c1", "docs/sprints/c1.md");
    expect(result.sprintDocPath).toBe("docs/sprints/c1.md");
    ...
  });
```

> The dynamic `await import("./documenter-agent.js")` inside each `it` is deliberate — this file calls `vi.mock("./documenter-agent.js", …importOriginal…)` at line 97, so the spread-with-actual mock means the real `parseDocumentationResult` is still reachable, but only via a post-mock import. Follow the same `await import(...)` style for any newly exported function tested in **this** file, otherwise the mock factory (line 97-111) will shadow it.

**Config fixture in this file (lines 167-194)** — `baseConfig` is a plain object literal, NOT `BoberConfigSchema.parse(...)`, and it has `documenter: { timeoutMs: 300_000, enabled: true, model: "sonnet", maxTurns: 20 }` with **no** `docsMode`. This is the exact reason runtime code must use `?? "committed"`.

**Temp-dir + cleanup pattern already in this file (lines 199-214):**

```ts
  const tmpDirs: string[] = [];

  afterAll(async () => {
    for (const dir of tmpDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  ...
    const tmpRoot = path.join(os.tmpdir(), `documenter_pipeline_a_${Date.now()}`);
    tmpDirs.push(tmpRoot);
    await fs.mkdir(tmpRoot, { recursive: true });
```

---

### src/utils/git.ts (modify)

**Full import surface — line 1 only:**

```ts
import { execa } from "execa";
```

Every existing helper shells out through `execa` (e.g. `commitAll` at :27-38, `isClean` at :130-147). The new `.gitignore` helper is **fs-based, not execa-based** (per `generatorNotes` and spec Q4 = "deterministic ensureGitignoreEntry helper in TS"), so you must add a `node:fs/promises` + `node:path` import. Keep the file's section header style (line 3):

```ts
// ── Git Helpers ────────────────────────────────────────────────────
```

**Closest existing behavior to model the "already covered" check on — `src/orchestrator/worktree.ts:60-70` (private, NOT exported):**

```ts
async function isBoberGitignored(projectRoot: string): Promise<boolean> {
  try {
    const gitignore = await readFile(join(projectRoot, ".gitignore"), "utf-8");
    // Check if any line matches .bober or .bober/
    return gitignore.split("\n").some((line) => {
      const trimmed = line.trim();
      return trimmed === ".bober" || trimmed === ".bober/" || trimmed === "/.bober" || trimmed === "/.bober/";
    });
  } catch {
    return false;
  }
}
```

**Closest existing append-to-.gitignore behavior — `src/cli/commands/init.ts:1145-1159`:**

```ts
  // Add .bober/ to .gitignore if it exists
  const gitignorePath = join(projectRoot, ".gitignore");
  if (await fileExists(gitignorePath)) {
    const content = await readFile(gitignorePath, "utf-8");
    if (!content.includes(".bober/")) {
      await appendFile(gitignorePath, "\n# Bober agent state\n.bober/\n");
      logger.success("Added .bober/ to .gitignore");
```

Use these two as the basis for the new exported helper (trimmed-line equality with the `dir`, `dir/`, `/dir`, `/dir/` variants — the substring `includes()` check from init.ts is the weaker of the two; prefer the line-based comparison so "preserves unrelated lines / no-op when already covered" is exact).

**Doc-comment style in this file (lines 22-26):**

```ts
/**
 * Stage all changes and create a commit.
 *
 * @returns The short hash of the new commit.
 */
```

**Imported by (17 modules; the ones that pin behavior):**
- `src/orchestrator/pipeline.ts`, `src/orchestrator/worktree.ts:17` (`addWorktree, removeWorktree, isClean, getCurrentBranch`)
- `src/utils/index.ts:2-9` — barrel re-export listing `getCurrentBranch, createBranch, commitAll, getChangedFiles, getDiff, hasUncommittedChanges`. Note it already **omits** `addWorktree/removeWorktree/isClean`, so adding the new helper to the barrel is optional and consistent either way; internal modules import from `"../utils/git.js"` directly (principles.md: "No barrel re-exports for deep internals").

**Test file:** `src/utils/git.test.ts` — **does not exist** (there are no tests under `src/utils/` at all). See the "create" entry below.

---

### src/utils/git.test.ts (create)

**Directory pattern:** `src/utils/` contains only `fs.ts`, `git.ts`, `index.ts`, `logger.ts` — kebab/short lowercase names, no tests yet. Test files elsewhere are colocated as `<module>.test.ts` (principles.md line 20).
**Most similar existing file:** `src/research/job-store.test.ts` — a pure fs-touching module tested against a real `mkdtemp` fixture with `beforeEach`/`afterEach` cleanup. `src/orchestrator/worktree.test.ts` is the closest for git-adjacent code (it inits a real git repo with execa) but the new helper needs **no** git repo — just a directory with a `.gitignore` file.

**Structure template (from `src/research/job-store.test.ts:1-19`):**

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { ensureGitignoreEntry } from "./git.js";

// ── Lifecycle ─────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-gitignore-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});
```

Cover the four sc-1-3 branches: creates entry when `.gitignore` is missing / when the pattern is absent; second call appends nothing (idempotent); unrelated lines byte-preserved; existing covering pattern (e.g. a line `docs/sprints/`) → no append.

---

### Optional new file: src/orchestrator/documenter-paths.ts (create — generator's choice)

`generatorNotes` allows the path resolver to live either in `documenter-agent.ts` or in a small `documenter-paths.ts` next to it.
**Most similar existing precedent for a tiny sibling module:** `src/fleet/decomposer-deep-constants.ts` / `src/vault/conventions.ts` (single-purpose constant/helper modules colocated with their consumer). If you split it out, the test must be `src/orchestrator/documenter-paths.test.ts` (colocated) — but note `sc-1-2`'s tests are easiest to keep in `documenter-agent.test.ts` since the contract lists that file. Simplest compliant choice: **keep `resolveSprintDocPath` exported from `documenter-agent.ts`** so no new file and no new test file are introduced beyond `src/utils/git.test.ts`.

---

## 2. Patterns to Follow

### Zod section schema: flat keys, `.default(...)` for behavior-preserving values, `.optional()` for absent-means-absent
**Source:** `src/config/schema.ts:189-198` and `:216-220`
```ts
export const CodeReviewSectionSchema = z.object({
  timeoutMs: z.number().int().positive().default(300_000),
  enabled: z.boolean().default(true),
  model: ModelChoiceSchema.default("sonnet"),
  maxTurns: z.number().int().min(1).default(15),
  provider: z.string().optional(),
  endpoint: z.string().nullable().optional(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
});
export type CodeReviewSection = z.infer<typeof CodeReviewSectionSchema>;
```
**Rule:** add `docsMode: z.enum(["committed","local","external"]).default("committed")` and `docsDir: z.string().optional()` as flat keys on `DocumenterSectionSchema`, each with a `/** ... */` doc comment, and keep `export type DocumenterSection = z.infer<...>` immediately after the schema.

### Config threading: optional-chain + literal fallback (never trust that zod ran)
**Source:** `src/orchestrator/documenter-agent.ts:72-74`
```ts
  const documenterModel = config.documenter?.model ?? config.generator.model;
  const model = resolveModel(documenterModel);
  const maxTurns = config.documenter?.maxTurns ?? 20;
```
**Rule:** read the new keys as `config.documenter?.docsMode ?? "committed"` and `config.documenter?.docsDir`, so hand-written config literals in tests (and `pipeline.ts`'s own `config.documenter?.enabled !== false` idiom at `pipeline.ts:611`) keep working.

### Relative-vs-absolute directory resolution against projectRoot
**Source:** `src/orchestrator/worktree.ts:130-134`
```ts
  const worktreeRootRel = config.pipeline.worktreeRoot ?? ".bober/worktrees";
  const worktreeRootAbs = isAbsolute(worktreeRootRel)
    ? worktreeRootRel
    : join(projectRoot, worktreeRootRel);
  const worktreePath = join(worktreeRootAbs, runId);
```
**Rule:** resolve `docsDir` with `isAbsolute(dir) ? dir : join(projectRoot, dir)` from `node:path`; handle a leading `~/` by replacing it with `os.homedir()` **before** the `isAbsolute` check (there is no existing tilde-expansion helper anywhere in `src/` — grep for `homedir()`, `expandTilde`, `startsWith("~` all return zero matches, so you are writing the first one; keep it inline and tiny).

### Exported prompt builder + pure switch over a mode union
**Source:** `src/orchestrator/checkpoints/feedback-router.ts:265-299`
```ts
/**
 * Build a per-agent augmented prompt for a retry invocation.
 * Each agent type uses a distinct framing strategy (s12-c6).
 */
export function buildFeedbackPrompt(
  checkpointId: CheckpointId,
  originalPrompt: string,
  feedbackHistory: FeedbackHistoryEntry[],
  maxIterations: number,
): string {
  const agent = CHECKPOINT_TO_AGENT[checkpointId];
  ...
  switch (agent) {
    case "planner":
      return buildPlannerRetryPrompt(...);
    ...
    default: {
      // Exhaustiveness guard (TypeScript narrows here)
      const _never: never = agent;
      throw new Error(`Unknown agent type: ${String(_never)}`);
    }
```
**Rule:** export `buildDocumenterUserMessage(...)` returning `string`, taking an options object or explicit params (contract/eval/filesChanged/projectRoot/sprintDocPath/docsMode); branch on `docsMode` with an exhaustive `switch` + `const _never: never = mode;` guard (the `_` prefix is the sanctioned unused-var escape hatch — principles.md line 36).

### Resilient JSON parsing with a caller-supplied default
**Source:** `src/orchestrator/documenter-agent.ts:186-196`
```ts
/**
 * Parse the documenter's response into a DocumentationResult.
 * Mirrors the resilient JSON-parsing pattern from code-reviewer-agent.ts.
 *
 * Exported for direct unit testing.
 */
export function parseDocumentationResult(
  text: string,
  contractId: string,
  defaultSprintDocPath: string,
): DocumentationResult {
```
**Rule:** "Exported for direct unit testing" is an accepted reason to export in this codebase — say the same in the JSDoc of the new exported builder/resolver.

### Section comments (unicode box-drawing)
**Source:** `src/utils/git.ts:3`, `src/orchestrator/documenter-agent.ts:12/36/184`
```ts
// ── Git Helpers ────────────────────────────────────────────────────
```
**Rule:** any new logical group gets a `// ── Name ───...` header (principles.md line 32).

### Async-only fs, `node:` prefixed imports
**Source:** `src/utils/fs.ts:1-3`
```ts
import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname, resolve } from "node:path";
```
**Rule:** `node:fs/promises` only — no `*Sync` calls (principles.md line 42), and all intra-repo imports carry the `.js` extension (line 27).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `fileExists` | `src/utils/fs.ts:10` | `(path: string): Promise<boolean>` | Async readable-file existence check (use instead of try/catch around `access`) |
| `readJson` | `src/utils/fs.ts:24` | `<T>(path: string): Promise<T>` | Read + parse JSON |
| `writeJson` | `src/utils/fs.ts:34` | `(path: string, data: unknown): Promise<void>` | Pretty-print JSON, creates parent dirs |
| `ensureDir` | `src/utils/fs.ts:45` | `(path: string): Promise<void>` | `mkdir -p`. Use this for creating the resolved docs dir |
| `findProjectRoot` | `src/utils/fs.ts:58` | `(startDir?: string): Promise<string \| null>` | Walk up for `bober.config.json`/`package.json` |
| `getCurrentBranch` | `src/utils/git.ts:8` | `(cwd: string): Promise<string>` | `git rev-parse --abbrev-ref HEAD` |
| `createBranch` | `src/utils/git.ts:18` | `(cwd: string, name: string): Promise<void>` | `git checkout -b` |
| `commitAll` | `src/utils/git.ts:27` | `(cwd: string, message: string): Promise<string>` | `git add -A` + commit, returns short hash. **Do not use in the documenter** — committing stays the LLM's job in `committed` mode |
| `getChangedFiles` | `src/utils/git.ts:45` | `(cwd: string, since?: string): Promise<string[]>` | `git diff --name-only` |
| `getDiff` | `src/utils/git.ts:64` | `(cwd: string, since?: string): Promise<string>` | Unified diff since ref |
| `hasUncommittedChanges` | `src/utils/git.ts:79` | `(cwd: string): Promise<boolean>` | Porcelain dirtiness boolean |
| `addWorktree` / `removeWorktree` | `src/utils/git.ts:93` / `:111` | `(projectRoot, worktreePath, branch, baseBranch?)` / `(projectRoot, worktreePath, force?)` | git worktree add/remove |
| `isClean` | `src/utils/git.ts:130` | `(cwd: string): Promise<{clean: boolean; dirtyFiles: string[]}>` | Clean check + dirty file list |
| `logger` | `src/utils/logger.ts` (`info:13`, `success:18`, `warn:23`, `error:28`, `debug:33`, `phase:46`, `sprint:59`) | `logger.info(msg, ...args)` etc. | The only sanctioned console surface; already imported in documenter-agent.ts |
| `ensureDir` (duplicate) | `src/state/helpers.ts:5` | `(dirPath: string): Promise<void>` | Pre-existing duplicate of `fs.ts:45` — do **not** add a third copy |
| `isBoberGitignored` | `src/orchestrator/worktree.ts:60` | `(projectRoot: string): Promise<boolean>` (**private, not exported**) | Line-exact `.gitignore` coverage check — copy its comparison logic into the new exported helper; do not export/move it in this sprint |
| `.gitignore` append flow | `src/cli/commands/init.ts:1145-1159` | inline in `runInit` | Existing `readFile`+`appendFile` idiom for adding a gitignore entry |
| `parseDocumentationResult` | `src/orchestrator/documenter-agent.ts:192` | `(text, contractId, defaultSprintDocPath): DocumentationResult` | Already accepts the default path as a param — reuse, don't fork |
| `resolveModel` | `src/orchestrator/model-resolver.ts` | `(choice: string): string` | Alias → concrete model id |
| `createClient` | `src/providers/factory.ts` | `(provider, endpoint, providerConfig, model, label)` | Provider-agnostic LLM client |
| `assembleSystemPrompt` | `src/orchestrator/agent-loader.ts` | `(role, agentFile, projectRoot, graphState)` | Loads `agents/bober-documenter.md` |
| `resolveRoleTools` / `getGraphState` / `getGraphDeps` | `src/orchestrator/tools/index.ts` | see call at `documenter-agent.ts:78-81` | Tool surface for the role |
| `runAgenticLoop` | `src/orchestrator/agentic-loop.ts` | `(opts): Promise<{finalText, turnsUsed, toolsCalled}>` | The agent loop; already wired |
| `deriveWorktreeSlug` | `src/orchestrator/worktree.ts:28` | `(task: string): string` | Slugifier — unrelated but the nearest "pure exported helper + colocated test" precedent |

**Node built-ins to use rather than hand-rolling:** `path.isAbsolute`, `path.join`, `path.resolve`, `path.basename` (`node:path`), `os.homedir`, `os.tmpdir` (`node:os`).

---

## 4. Prior Sprint Output

`dependsOn: []` — this is sprint 1 of `spec-20260731-documenter-docs-output`; no prior sprint output to build on.

**Upstream context this sprint extends (from the already-shipped documenter feature, spec `#41/#42` per the spec's assumptions):**
- `src/config/schema.ts:304-313` — `DocumenterSectionSchema`, wired optional at `:815`.
- `src/orchestrator/documenter-agent.ts` — `runDocumenter` (:62), `parseDocumentationResult` (:192), `DocumentationResult`/`RelatedDocUpdate` types (:15, :23).
- `src/orchestrator/pipeline.ts:608-641` — the advisory, time-boxed call site.

**Explicitly deferred to sprint 2 (do NOT touch now):** `agents/bober-documenter.md` (hardcodes `docs/sprints/<contractId>.md` at :64, `git add`/`git commit` at :108-109, `sprintDocPath` at :121), `skills/bober.sprint/SKILL.md`, `skills/bober.run/SKILL.md` (:581), and the `.claude/` mirrors regenerated by `npm run update-all`.

---

## 5. Relevant Documentation

### Project Principles
From `.bober/principles.md` — the ones that bind this sprint:
- **ESM everywhere** — "All imports use `.js` extensions for NodeNext resolution" (line 27).
- **Zod for config validation** — "All configuration schemas are Zod schemas in `config/schema.ts`. Runtime config loading uses `z.parse()`. No hand-rolled validation." (line 29).
- **Small utility modules** — "Utils in `utils/` are focused single-purpose files (`fs.ts`, `git.ts`, `logger.ts`). Keep them small." (line 33) → the gitignore helper belongs in `git.ts`, not a new util file.
- **Section comments** — box-drawing headers (line 32).
- **`import type`** — `consistent-type-imports` is an ESLint **error** (line 35 + `eslint.config.js` rule `"@typescript-eslint/consistent-type-imports": "error"`).
- **Unused params get `_`** (line 36) — the only escape hatch.
- **No `any` without justification** (line 40) — `no-explicit-any` is a warning; the existing `// eslint-disable-next-line @typescript-eslint/no-explicit-any` at `documenter-agent.test.ts:98` is the sanctioned exception for `importOriginal<any>()`.
- **No synchronous filesystem ops** (line 42) — `node:fs/promises` only.
- **No test mocks for filesystem** (line 44) — "Tests that need filesystem state create temp directories and clean up." **This forbids `vi.mock("node:fs/promises")` for the gitignore helper tests.** Use `mkdtemp`.
- **Type safety** (line 18) — strict mode with `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `isolatedModules` (confirmed in `tsconfig.json`). Zero type errors is a hard gate.

### Architecture Decisions
`.bober/architecture/` holds 100+ ADRs but **none for `spec-20260731-documenter-docs-output`** (`ls .bober/architecture | grep -i "documenter\|20260731"` → no matches). No ADR constrains this sprint.

The binding design decisions live in the spec's `resolvedClarifications` (`.bober/specs/spec-20260731-documenter-docs-output.json`):
- **Q1 → A:** default stays `committed`; local/external are opt-in (no behavior change without opt-in).
- **Q2 → A:** flat `documenter.docsMode` + `documenter.docsDir` (matches the flat `DocumenterSectionSchema`).
- **Q3 → A:** non-committed modes write **only** the sprint record; stale repo docs go to `concerns`, they are not edited.
- **Q4 → A:** the `.gitignore` entry is ensured by **deterministic TS**, never by the LLM prompt ("gitignore correctness is a safety property; do it in code, not in a prompt").

Spec NFRs: `external` default dir is `~/.bober/docs/<project.name>/sprints`; the gitignore mutation "is idempotent, appends at most one line, and never rewrites unrelated .gitignore content."

Spec `outOfScope` relevant here: do not flip the default; do not touch `.bober/` artifact commit behavior; no retroactive migration of already-committed `docs/sprints/` files; do not change *what* the record contains — only where it goes and whether it is committed.

### Other Docs
- `package.json` scripts: `build: tsc`, `lint: eslint src/`, `typecheck: tsc --noEmit`, `test: vitest`.
- `tsconfig.json` `exclude: ["node_modules", "dist", "**/*.test.ts"]` — **test files are not typechecked** by `npm run typecheck`; `typecheck:tests` only covers `src/seo/builder/**`. So a type break confined to test fixtures will surface only via vitest, not the typecheck gate.
- No `vitest.config.*` exists → vitest default include (`**/*.test.ts`). Run non-watch with `npm test -- --run`.
- `.gitignore` (repo root) currently has no `docs/` entries — the local-mode helper is what would add one in a consumer repo.

---

## 6. Testing Patterns

### Unit Test Pattern — pure function, colocated
**Source:** `src/config/schema.test.ts:27-56` (zod section schema)
```ts
import { describe, it, expect } from "vitest";
import { PipelineSectionSchema, EvaluatorSectionSchema, /* ... */ } from "./schema.js";

describe("EvaluatorSectionSchema.panel", () => {
  it("defaults panel to disabled/empty/4 when omitted", () => {
    const parsed = EvaluatorSectionSchema.parse({ strategies: [] });
    expect(parsed.panel).toEqual({ enabled: false, lenses: [], maxConcurrent: 4 });
  });

  it("rejects maxConcurrent < 1", () => {
    expect(() =>
      EvaluatorSectionSchema.parse({ strategies: [], panel: { maxConcurrent: 0 } }),
    ).toThrow();
  });
});
```

**Source:** `src/config/schema.test.ts:377-402` (invalid-enum rejection via `safeParse` on the full config)
```ts
  it("rejects an invalid generator.effort value", () => {
    const result = BoberConfigSchema.safeParse({
      ...minimalBase,
      generator: { effort: "bogus" },
    });
    expect(result.success).toBe(false);
  });
```

### Unit Test Pattern — real temp-dir filesystem fixture (no fs mocks)
**Source:** `src/research/job-store.test.ts:1-19`
```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { addJob, listJobs, removeJob, readJob, jobId } from "./job-store.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-research-job-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});
```

**Source:** `src/orchestrator/worktree.test.ts:73-80` — when a *real git repo* is needed (not needed for this sprint's helper, but this is the pattern):
```ts
beforeEach(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), "bober-worktree-test-"));
  // Initialize a real git repo with one commit so worktree commands work
  await execa("git", ["init", "-q", "-b", "main"], { cwd: tmpRepo });
```

**Runner:** vitest 3 (`package.json:115`), no config file → defaults.
**Assertion style:** `expect(...)` with `toBe` / `toEqual` / `.toThrow()` / `expect(result.success).toBe(false)`; `Object.hasOwn(parsed, "key")` for "key never materialized" assertions (`schema.test.ts:811, 853`).
**Mock approach:** `vi.mock("<module>.js", factory)` at module top level for heavy deps (`documenter-agent.test.ts:27-111`), `vi.mocked(fn)` to type the spy, `vi.spyOn(logger, "warn")` + `mockRestore()` for log assertions (`documenter-agent.test.ts:259-282`), `vi.clearAllMocks()` in `beforeEach`. **Never mock `node:fs/promises`** (principles.md line 44).
**File naming:** `<module>.test.ts`.
**Location:** colocated next to the source file (`documenter-agent.test.ts:14` — "Colocated with documenter-agent.ts per the project convention").
**Test-file docblock convention:** each test file opens with a `/** ... */` header enumerating what is tested — see `documenter-agent.test.ts:1-15`:
```ts
/**
 * Unit tests for the per-sprint documenter integration.
 *
 * Tests:
 * (a) pipeline.ts spawns runDocumenter ...
 * (d) parseDocumentationResult is resilient to fenced / noisy / unparseable output.
 *
 * Colocated with documenter-agent.ts per the project convention.
 */
```
Mirror this and reference the `sc-1-x` criterion ids in `it(...)` titles — the codebase does this consistently (e.g. `schema.test.ts:799` `"(sc-8-5)"`, `job-store.test.ts:39` `"sc-1-1: rejects an empty question"`).

### E2E Test Pattern
Not applicable — no `playwright.config.ts` and no `e2e/` directory at the repo root; the `playwright` evaluator strategy (`src/evaluators/builtin/playwright.ts`) is opt-in per-project and this sprint ships no UI.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/pipeline.ts:36,611-641` | `runDocumenter` from `documenter-agent.js` | **high** | Signature of `runDocumenter(contract, evaluation, generatorResult, projectRoot, config)` must not change (5 positional args); the advisory try/catch + `Promise.race` timeout at `:611-618` and the `sprint-docs-complete` history entry using `documentation.sprintDocPath` (`:627`) must stay intact |
| `src/config/loader.ts:5-9` | `BoberConfigSchema`, `PartialBoberConfigSchema` | medium | `PartialBoberConfigSchema` is `BoberConfigSchema.deepPartial()` (`schema.ts:856`) — new keys become optional there automatically; verify `deepPartial` still compiles with the enum default |
| `src/config/schema.test.ts:878-972` | `BoberConfigSchema` + repo's own `bober.config.json` | **high** | This test deep-equals the **entire** parsed repo config. Today `bober.config.json` has **no** `documenter` key, so the snapshot has none and adding defaults inside `DocumenterSectionSchema` is invisible. If you add a `documenter` block to `bober.config.json`, this test fails — don't (it is not in `estimatedFiles`) |
| `src/orchestrator/documenter-agent.test.ts:167-194` | `baseConfig` literal without `docsMode` | medium | Runtime must fall back with `?? "committed"`; also, making `docsMode` non-optional in the inferred `DocumenterSection` type could produce type errors in these object literals (they are excluded from `npm run typecheck` but still compiled by vitest's esbuild — type errors are erased, so vitest passes) |
| `src/orchestrator/pipeline.test.ts:103-115, 202, 290, 368, 419, 470` | mocked `runDocumenter` + `documenter` config literal | medium | The `vi.mock(..., importOriginal)` spread at `:103` re-exports everything actual — any new export from `documenter-agent.ts` remains reachable. Config literal at `:202` also lacks `docsMode` |
| `src/utils/index.ts:2-9` | `./git.js` barrel | low | Only a re-export list; adding a new function does not break it (and adding it to the list is optional) |
| `src/orchestrator/worktree.ts:17` | `./utils/git.js` | low | Imports `addWorktree, removeWorktree, isClean, getCurrentBranch` — unaffected as long as you only **add** to `git.ts` |
| 17 other importers of `src/utils/git.js` (pipeline, fleet, chat, cli commands, mcp tools) | `./utils/git.js` | low | Purely additive change; do not modify existing helper signatures or the `execa` import |

### Existing Tests That Must Still Pass
- `src/orchestrator/documenter-agent.test.ts` — 3 pipeline-integration tests (a/b/c) asserting `runDocumenter` is called with 5 args including `tmpRoot` and a config object (`:240-246`), plus 4 `parseDocumentationResult` tests calling it positionally with `docs/sprints/<id>.md` defaults (`:326, 338, 345, 362`). **Most likely to break** if you change `parseDocumentationResult`'s signature or `runDocumenter`'s arity.
- `src/orchestrator/pipeline.test.ts` — sc-3-x security-gate tests that assert the documenter is/is not reached (`:290, 368, 401, 411-419, 470`); relies on the mocked `runDocumenter` and on `config.documenter?.enabled !== false`.
- `src/config/schema.test.ts:878-972` — "repo's own bober.config.json parses byte-identically" full deep-equal snapshot.
- `src/config/schema.test.ts:831-876` and `:341-403` — "optional section / minimal fixture parses with no defaults injected" suites; adding a `.default()` **inside** an already-`.optional()` section must not materialize `documenter` on configs that omit it.
- `src/orchestrator/worktree.test.ts` — exercises real git via `src/utils/git.ts`; must stay green after the `git.ts` edit.
- `src/cli/commands/update.test.ts:45-46` — asserts `bober-documenter.md` is installed; a reminder that the agent file is sprint-2 territory.

### Features That Could Be Affected
- **feat-3 (skill/agent surface sync — sprint 2)** — shares `agents/bober-documenter.md` and the two SKILL.md files, which still hardcode `docs/sprints/` and unconditional committing. Leaving them untouched creates a temporary prompt/system-prompt mismatch: `assembleSystemPrompt("generator", "bober-documenter", ...)` (`documenter-agent.ts:81`) injects the agent file's "commit the docs" instruction even in `local`/`external` mode. The user message must therefore state the mode's prohibition **explicitly and last** so it overrides the system prompt; note the residual risk in the sprint record rather than editing the md files.
- **feat-5 (init solo/team question)** — shares `DocumenterSectionSchema` and `src/cli/commands/init.ts` (which also owns the existing `.gitignore` append at `:1145-1159`). Do not preempt it.
- **Security-audit gate ordering (ADR-6, `pipeline.test.ts:401`)** — "documenter/code-reviewer are never reached on a blocked round." Nothing here may move the documenter call site.
- **Worktree runs** — in `local` mode the ensured `.gitignore` entry is written into whatever `projectRoot` is, which for worktree runs is the worktree path (`worktree.ts:145-150`). Acceptable, but verify the helper is safe when `.gitignore` is absent.

### Recommended Regression Checks
1. `npm run typecheck` — zero errors (note: excludes `**/*.test.ts`).
2. `npm run lint` — zero errors; watch `consistent-type-imports` on any new `import type` and unused-var errors from the exhaustive-switch `_never` guard.
3. `npm run build` — `tsc` emits cleanly to `dist/`.
4. `npm test -- --run` — full suite, zero regressions vs. the pre-sprint baseline. Capture the baseline first: `npm test -- --run 2>&1 | tail -20`.
5. Targeted: `npm test -- --run src/config/schema.test.ts src/orchestrator/documenter-agent.test.ts src/orchestrator/pipeline.test.ts src/utils/git.test.ts src/orchestrator/worktree.test.ts`.
6. Byte-identity spot check: `node -e` / a test asserting `BoberConfigSchema.parse(<repo bober.config.json>)` still has no `documenter` key (`Object.hasOwn(parsed, "documenter") === false`).
7. Confirm `git status` shows only the six contract files touched — in particular **no** changes to `agents/`, `skills/`, `.claude/`, `bober.config.json`, `README.md`, `VISION.md`, `CHANGELOG.md` (all later sprints).

---

## 8. Implementation Sequence

1. **`src/config/schema.ts`** — add `docsMode: z.enum(["committed","local","external"]).default("committed")` and `docsDir: z.string().optional()` to `DocumenterSectionSchema` (`:304-312`), each with a `/** ... */` comment in the `verifier`/`standaloneBlockOn` style. Optionally export a named `DocumenterDocsModeSchema` + `type DocumenterDocsMode` so `documenter-agent.ts` can import the union as a type.
   - Verify: `npx vitest run src/config/schema.test.ts` still green; `DocumenterSectionSchema.parse({}).docsMode === "committed"`.
2. **`src/config/schema.test.ts`** — import `DocumenterSectionSchema`, add the sc-1-1 describe: omitted section, `parse({})` → `docsMode: "committed"`, each valid mode, invalid mode → `success === false` with an issue path containing `docsMode`, `docsDir` accepting relative / absolute / `~/x`, and `Object.hasOwn(BoberConfigSchema.parse(minimalBase), "documenter") === false`.
   - Verify: `npx vitest run src/config/schema.test.ts`.
3. **`src/utils/git.ts`** — add the fs-based exported helper (suggested: `ensureGitignoreEntry(projectRoot: string, entry: string): Promise<boolean>` returning whether a line was appended). Add `import { readFile, writeFile } from "node:fs/promises";` and `import { join } from "node:path";`; keep `execa` untouched. Normalize the entry to a trailing-slash dir form, treat the `x`, `x/`, `/x`, `/x/` trimmed-line variants as already-covering, create `.gitignore` when missing, and append exactly one line (with a preceding newline only when the file does not already end with one).
   - Verify: `npm run typecheck` and `npm run lint` clean; `npx vitest run src/orchestrator/worktree.test.ts` still green.
4. **`src/utils/git.test.ts`** (new) — `mkdtemp` fixture per `src/research/job-store.test.ts:1-19`; cover: missing `.gitignore` → created with the entry; entry absent → appended; **second call → no duplicate**; unrelated lines byte-preserved; existing covering pattern (`docs/sprints/`) → no append.
   - Verify: `npx vitest run src/utils/git.test.ts`.
5. **`src/orchestrator/documenter-agent.ts` (part 1 — pure path resolver)** — export `resolveSprintDocPath(config: BoberConfig, projectRoot: string, contractId: string): string`. Add `import { isAbsolute, join, basename } from "node:path";` and `import { homedir } from "node:os";`. Branches: `committed`/`local` with `docsDir` unset → `join(projectRoot, "docs/sprints", `${contractId}.md`)`; `docsDir` set → tilde-expand, then `isAbsolute ? dir : join(projectRoot, dir)`; `external` with `docsDir` unset → `join(homedir(), ".bober", "docs", config.project?.name ?? basename(projectRoot), "sprints", `${contractId}.md`)`.
   - Verify: unit tests from step 7 for every branch; the committed default must still stringify to a `docs/sprints/<contractId>.md` suffix.
6. **`src/orchestrator/documenter-agent.ts` (part 2 — prompt builder + wiring)** — extract lines 108-151 into an exported `buildDocumenterUserMessage(...)` with an exhaustive `switch` on the mode. `committed` keeps the current text verbatim (including step 4's `git add`/`git commit`). `local`/`external` drop the git step entirely, add an explicit prohibition ("Do NOT modify ANY repo file other than the sprint record") and redirect stale-doc observations into `concerns`; omit `docsCommit` from the requested JSON. Then in `runDocumenter`: replace `:106` with the resolved path, call `ensureGitignoreEntry` **only** when mode === `"local"` (before `runAgenticLoop`, wrapped so a failure logs a `logger.warn` and does not abort — the documenter is advisory), and pass the resolved path into both the builder and `parseDocumentationResult(result.finalText, contractId, sprintDocPath)` (`:175`).
   - Verify: `runDocumenter`'s 5-arg signature unchanged; `pipeline.ts:611-641` untouched; `npm run typecheck` + `npm run lint` clean.
7. **`src/orchestrator/documenter-agent.test.ts`** — add `describe` blocks for `resolveSprintDocPath` (all branches per sc-1-2, asserting exact paths and that the external default contains `.bober/docs/<project.name>/sprints`) and `buildDocumenterUserMessage` (sc-1-4: committed contains `git add` **and** `git commit`; local/external contain neither and contain the explicit other-repo-files prohibition). Use `await import("./documenter-agent.js")` inside each `it`, matching `:317`.
   - Verify: `npx vitest run src/orchestrator/documenter-agent.test.ts`.
8. **Run full verification** — `npm run typecheck && npm run lint && npm run build && npm test -- --run`, then diff the baseline test counts and confirm `git status` touches only the six contract files.

---

## 9. Pitfalls & Warnings

- **Do not rely on zod defaults at runtime.** `documenter-agent.test.ts:193`, `pipeline.test.ts:202` and `worktree.test.ts:24-53` all build `BoberConfig` **object literals** that never pass through `BoberConfigSchema.parse`. Any code path reading `config.documenter.docsMode` without `?? "committed"` will see `undefined` in tests (and in any programmatic API caller). Use `config.documenter?.docsMode ?? "committed"`, exactly like `documenter-agent.ts:72-74`.
- **`.default()` inside an `.optional()` section does not materialize the section.** `documenter` stays `undefined` for configs that omit it (`schema.ts:815`), which is what keeps the `schema.test.ts:878-972` byte-identity snapshot passing. Do **not** give `documenter` an outer `.default({})`, and do **not** add a `documenter` block to the repo's `bober.config.json` — that snapshot enumerates every key and would fail.
- **`src/utils/git.ts` is execa-only today.** The new helper is deliberately fs-based (spec Q4 = deterministic TS, not a git shell-out and not an LLM instruction). Add `node:fs/promises`/`node:path` imports rather than reaching for `execa("git", ["check-ignore", ...])` — `check-ignore` requires a real repo and would break the temp-dir test fixture.
- **No fs mocks in tests.** `.bober/principles.md:44` — "No test mocks for filesystem. Tests that need filesystem state create temp directories and clean up." `vi.mock("node:fs/promises")` for the gitignore tests will be rejected in review.
- **`documenter-agent.test.ts` mocks its own module** (`vi.mock("./documenter-agent.js", …importOriginal…)` at `:97`). A top-level static `import { resolveSprintDocPath } from "./documenter-agent.js"` in that file would resolve through the mock factory. Use the file's existing `await import("./documenter-agent.js")` inside each `it` (`:317`).
- **The system prompt still says "commit the docs".** `assembleSystemPrompt("generator", "bober-documenter", projectRoot, graphState)` (`documenter-agent.ts:81`) loads `agents/bober-documenter.md`, which hardcodes `docs/sprints/<contractId>.md` (`:64`) and `git add`/`git commit` (`:108-109`). That file is **sprint 2** scope. Make the user message's mode instructions explicit and unambiguous so they win, and record the residual mismatch as a known limitation.
- **Do not touch the pipeline call site.** `pipeline.ts:611-641` wraps `runDocumenter` in `Promise.race` + try/catch so a documenter failure never downgrades the passed sprint (contract sc / spec feat-2 AC5, and `documenter-agent.test.ts` test (b) asserts the `"Documentation skipped"` warn). Keep `runDocumenter`'s arity and return type identical.
- **`ensureGitignoreEntry` must never abort the sprint.** Wrap the call in try/catch + `logger.warn` — the documenter is advisory, and a read-only `.gitignore` in a consumer repo must not fail a passed sprint.
- **`~` is not expanded by `node:path`.** `isAbsolute("~/x")` is `false` and `join(projectRoot, "~/x")` silently creates a literal `~` directory. Expand with `os.homedir()` **before** the `isAbsolute` check. There is no existing tilde helper in `src/` (verified by grep) — write the minimal inline version, do not add a new utils file (principles.md line 33 keeps `utils/` small, and a one-off belongs next to its consumer).
- **`config.project.name` is required by the schema** (`schema.ts:93`) but `PartialBoberConfigSchema` makes it optional (`:857-863`). For the `external` default use `config.project?.name ?? basename(projectRoot)` per `generatorNotes`.
- **ESLint `consistent-type-imports` is an error.** Import `DocumenterSection`/mode unions with `import type { ... }`.
- **`noUnusedParameters`/`noUnusedLocals` are on.** The exhaustive-switch guard must use the `_never` underscore form (`feedback-router.ts:294-296`), the only sanctioned escape.
- **`npm run typecheck` does not cover test files** (`tsconfig.json` excludes `**/*.test.ts`). A test-only type mistake will pass typecheck and may still surface at review — keep test fixtures structurally valid.
- **Nothing to export from `src/index.ts`.** The documenter is not part of the public API surface (grep for "documenter" in `src/index.ts` → no matches); adding it there would widen the published API unnecessarily.
- **`docs/sprints/` in this repo is real and tracked** (13+ committed records). This sprint must not delete, move, or gitignore them — spec `outOfScope` explicitly excludes "retroactive migration/cleanup of already-committed docs/sprints/ files".
