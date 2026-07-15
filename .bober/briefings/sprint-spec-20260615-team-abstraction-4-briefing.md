# Sprint Briefing: Second team as data + CLI wiring + docs (the platform proof)

**Contract:** sprint-spec-20260615-team-abstraction-4
**Generated:** 2026-06-15T00:00:00Z

> This is the FINAL sprint — the platform proof. ALL machinery (Team type, loadTeam,
> per-team memory namespacing, runPipeline opts.teamId, ChatSessionOptions.memoryNamespace)
> already exists from Sprints 1–3. Sprint 4 adds ONLY: two CLI flags, an example-team
> config fixture (DATA, not a code branch), routing through existing seams, and docs.
> If you find yourself adding a new abstraction or a `if (teamId === 'example')` branch,
> STOP — the whole point is that the example team flows through `loadTeam`.

---

## 1. Target Files

### src/cli/commands/run.ts (modify)

`runRunCommand` (line 43) already threads `options.runId` into `runPipeline`. Add `--team`
the SAME additive way. The interface and the single call site to change:

**`RunCommandOptions` (lines 13-28) — add a `teamId` field next to `runId`:**
```ts
export interface RunCommandOptions {
  verbose?: boolean;
  provider?: string;
  mode?: "autopilot" | "careful";
  checkpoint?: string;
  checkpointAll?: boolean;
  /** When set, the pipeline honors this runId instead of self-generating run-<timestamp>. */
  runId?: string;
  // ── add this (Phase 4): selects the active team; absent => config.defaultTeam then 'programming'
  // team?: string;   // <-- mirror runId exactly
}
```

**The ONLY call site to change — line 148 (verbatim today):**
```ts
const result = await runPipeline(task, projectRoot, config, { runId: options.runId });
```
Change to thread the team id (runPipeline already accepts `opts.teamId`, pipeline.ts:980):
```ts
const result = await runPipeline(task, projectRoot, config, {
  runId: options.runId,
  teamId: options.team,   // absent => runPipeline falls back to config.defaultTeam then 'programming'
});
```
**Do NOT** resolve `loadTeam` inside run.ts — `runPipeline` already calls `loadTeam(config, opts?.teamId ?? config.defaultTeam)` (pipeline.ts:982-983). Passing `teamId: undefined` reproduces today's exact behavior (sc-4-5 regression). Optionally `logger.info(\`Team: ${options.team}\`)` when set, mirroring the existing `--provider`/`--mode` info lines (run.ts:99, 105).

**Imports this file uses:** `loadConfig`, `configExists` (config/loader.js), `runPipeline` (orchestrator/pipeline.js), `ensureBoberDir` (state/index.js), `logger` (utils/logger.js), `prompts`, `chalk`, `ora`.
**Imported by:** `src/cli/index.ts:20` (`import { runRunCommand }`).
**Test file:** `src/cli/commands/run.test.ts` — **DOES NOT EXIST. You must CREATE it** (sc-4-5).

---

### src/cli/index.ts (modify — flag registration)

The commander `.option()` declarations and the action that calls `runRunCommand` live HERE, not in run.ts. The `--run-id` block to mirror (lines 217-238, verbatim):
```ts
    .option(
      "--run-id <id>",
      "Use a caller-supplied run identifier instead of self-generating run-<timestamp>.",
    )
    .action(async (task?: string, cmdOpts?: {
      provider?: string;
      mode?: "autopilot" | "careful";
      checkpoint?: string;
      checkpointAll?: boolean;
      runId?: string;
    }) => {
      const opts = program.opts<{ verbose?: boolean; config?: string }>();
      const projectRoot = await resolveProjectRoot(opts.config);
      await runRunCommand(task, projectRoot, {
        verbose: opts.verbose,
        provider: cmdOpts?.provider,
        mode: cmdOpts?.mode,
        checkpoint: cmdOpts?.checkpoint,
        checkpointAll: cmdOpts?.checkpointAll,
        runId: cmdOpts?.runId,
      });
    });
```
Add one `.option("--team <id>", "...")` after the `--run-id` option (line 220), add `team?: string;`
to the `cmdOpts` inline type, and add `team: cmdOpts?.team,` to the `runRunCommand({...})` call.
**NOTE:** index.ts is NOT in `estimatedFiles`. You MUST still edit it — the flag is invisible
to the CLI otherwise. (Tests can register the run command via index.ts or call `runRunCommand`
directly with `{ team }` — see §6 for both seams.)

---

### src/cli/commands/chat.ts (modify)

Currently the `[team]` arg is **accepted but ignored** — confirmed verbatim (chat.ts:3-4 doc and
line 24 the param is named `_team`):
```ts
/**
 * `bober chat [team]` — Start an interactive bober chat session.
 *
 * The [team] argument is accepted but ignored in Phase 1.
 */
...
    .command("chat [team]")
    .description("Start an interactive bober chat session")
    .action(async (_team?: string) => {
      const projectRoot = (await findProjectRoot()) ?? process.cwd();
      try {
        const config = await loadConfig(projectRoot);
        const providers = resolveRoleProviders(config);          // line 28
        const client = createClient(
          providers.chat,
          config.chat?.endpoint ?? null,
          config.chat?.providerConfig,
          config.chat?.model,
          "chat",
        );
        const session = new ChatSession({
          llm: client,
          projectRoot,
          sessionId: "default",
        });
        await session.start();
```
**Make `_team` actually select the team.** Resolve `loadTeam(config, team)` and pass the team's
`memoryNamespace` into `ChatSession` (the field already exists — chat-session.ts:38). Minimal change:
```ts
import { loadTeam } from "../../teams/registry.js";   // add this import
...
    .action(async (team?: string) => {            // rename _team -> team
      ...
      const config = await loadConfig(projectRoot);
      const activeTeam = loadTeam(config, team);   // undefined => 'programming' (registry.ts:35-37)
      const providers = resolveRoleProviders(config);
      const client = createClient(/* unchanged */);
      const session = new ChatSession({
        llm: client,
        projectRoot,
        sessionId: "default",
        memoryNamespace: activeTeam.memoryNamespace,  // '' for programming => default .bober/memory/
      });
```
- `loadTeam(config, undefined)` returns the programming team whose `memoryNamespace` is `''`
  (registry.ts:66) — ChatSession maps `''` to `undefined` (chat-session.ts:90 `opts.memoryNamespace || undefined`),
  so omitting `<team>` is byte-for-byte today's behavior (sc-4-6 default path).
- **Optional (provider routing axis):** if you also want chat to honor the team's chat-role provider,
  use `activeTeam.providers.chat` instead of `providers.chat` in `createClient`. The minimal proof for
  sc-4-6 is the namespace; provider routing is a nice-to-have — keep it simple and only do it if it
  doesn't complicate tests.
- **Update the doc comment** at the top of chat.ts (lines 1-8) — it currently says "ignored in Phase 1".

**Spawned-runs team propagation (sc-4-6 "spawned runs to that team"):** `RunSpawner.spawn` (run-spawner.ts:111)
launches `[cliEntry, "run", task, "--run-id", runId]`. To route spawned `bober run` children to the
active team, the spawner would need to append `"--team", teamId`. This requires plumbing a `teamId`
through `RunSpawnerOptions` (run-spawner.ts:44-57, NO teamId today) → into the spawn args (line 111),
and ChatSession passing it (chat-session.ts:96-101). **This is the heaviest part of the sprint.**
Recommendation: thread `teamId` into `ChatSessionOptions` + `RunSpawnerOptions` ONLY if a test demands
it; the contract phrases it "if applicable". The load-bearing, must-pass criteria are the memory
namespace (sc-4-6/sc-4-7) and the run flag (sc-4-5). Keep spawned-run team propagation minimal and
additive (absent `--team` on the child = today's behavior).

**Test file:** `src/cli/commands/chat.test.ts` — **DOES NOT EXIST. You must CREATE it** (sc-4-6).

---

### docs/teams.md (create)

**Directory pattern:** `docs/` holds topic docs in kebab-case: `docs/providers.md`,
`docs/self-improvement-memory.md`, `docs/PR-graph-telemetry-and-update-all.md`. Per-sprint docs go
under `docs/sprints/` (a parallel documenter owns those for Sprint 3 — do NOT touch `docs/sprints/**`).
**Most similar existing file:** `docs/providers.md` (topic reference w/ config snippets). `docs/teams.md`
is clear (no parallel writer touches README.md or docs/teams.md). Cover: the `teams` config shape, the
three axes (provider routing / memory namespace / pipeline shape), the built-in `programming` default,
`bober run --team <id>` + `bober chat <team>` usage, and the **deferred** `.bober/teams/*.json` file
registry. Cross-reference `.bober/research/20260614-chattable-team-of-agents-platform.md` Phase 4 (line 290).

---

### README.md (modify)

The `teams`/`defaultTeam` entries are MISSING from the Full Configuration Reference. The reference block
runs lines 557-668; the last section before the closing `}` is `"commands"` (README.md:658-666). Add a
`// -- Teams (Phase 4) --` block right after `"commands"` and before line 667's closing `}`:
```jsonc
  },

  // -- Teams (NEW: adding a team is data, not code) ----
  "defaultTeam": "programming",           // Optional. Active team when --team / chat <team> is omitted.
  "teams": {                              // Optional. Each entry is a team defined purely as DATA.
    "example": {
      "displayName": "Example research team",
      "memoryNamespace": "example",       // Lessons land in .bober/memory/example/
      "pipelineShape": "ts",              // "ts" | "skill" | "workflow"
      "providers": { "chat": "openai" }   // Partial role->provider override; unset roles keep defaults
    }
  }
}
```
Also add a one-line `npx agent-bober run "feature" --team example` example near the other `run`
examples (README.md:445-446, 509-520) and a short "Teams" subsection linking to `docs/teams.md`.

---

## 2. Patterns to Follow

### Additive CLI flag (mirror `--run-id`)
**Source:** `src/cli/index.ts`, lines 217-238 (quoted in §1).
**Rule:** Register the flag with `.option("--team <id>", "...")`, add it to the inline `cmdOpts` type,
pass `team: cmdOpts?.team` into the command function. The handler threads `teamId: options.team` into
`runPipeline`. Absent flag => `undefined` => existing behavior. Do not add positional args or change
signatures of existing functions.

### Pipeline team threading (already done in S3 — just pass the id)
**Source:** `src/orchestrator/pipeline.ts`, lines 976-985.
```ts
export async function runPipeline(
  userPrompt: string, projectRoot: string, config: BoberConfig,
  opts?: { runId?: string; teamId?: string },
): Promise<PipelineResult> {
  const teamId = opts?.teamId ?? config.defaultTeam;
  const team = loadTeam(config, teamId);
  return selectPipelineEngineForTeam(team, config).run(userPrompt, projectRoot, config, opts);
}
```
**Rule:** Pass `teamId` into the opts object. Do NOT call `loadTeam` in run.ts — the pipeline owns that.

### Resolve namespace from a team (chat path)
**Source:** `src/cli/commands/memory.ts`, lines 45-53 (the precedent for "resolve a team's namespace in a CLI command").
```ts
async function resolveDefaultNamespace(projectRoot: string): Promise<string | undefined> {
  try {
    const config = await loadConfig(projectRoot);
    return loadTeam(config, undefined).memoryNamespace || undefined;
  } catch { return undefined; }
}
```
**Rule:** `loadTeam(config, teamId).memoryNamespace || undefined` is the idiom. The `|| undefined`
collapses the programming sentinel `''` to the default `.bober/memory/` path (memory.ts:26-27).

### CLI handler error contract (never throw)
**Source:** `src/cli/commands/chat.ts`, lines 44-49; `src/cli/commands/memory.ts`, lines 95-102.
**Rule:** Handlers catch all errors, `process.stderr.write(...)`, set `process.exitCode = 1`, and
return. Never throw out of a `.action()`.

### Section comments + type imports
**Source:** `src/teams/registry.ts:14`, `src/cli/commands/chat.ts:10,18`.
**Rule:** Unicode box headers `// ── Section ──────`, and `import type { Command } from "commander"`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `loadTeam` | `src/teams/registry.ts:34` | `(config: BoberConfig, teamId?: string): Team` | Resolves a Team from config; `undefined`/`'programming'` => built-in programming team; unknown id THROWS. This is THE seam — never branch on team id yourself. |
| `runPipeline` | `src/orchestrator/pipeline.ts:976` | `(prompt, root, config, opts?: { runId?; teamId? }): Promise<PipelineResult>` | Entry point; already threads `opts.teamId` (S3). Pass `teamId`, don't pre-resolve. |
| `memoryDir` | `src/state/memory.ts:26` | `(projectRoot, namespace?): string` | Maps namespace (or `''`/`'programming'`/`undefined`) to `.bober/memory/[<ns>/]`. Use to ASSERT lesson location in sc-4-7. |
| `appendLesson` | `src/state/memory.ts:212` | `(projectRoot, lesson, namespace?): Promise<void>` | Writes a lesson + upserts index under the namespace. Use to DRIVE the sc-4-7 lesson write. |
| `loadLessonIndex` | `src/state/memory.ts:259` | `(projectRoot, { limit }, namespace?): Promise<Record[]>` | Reads bounded index from a namespace. Use to assert a lesson landed (or did not) in a namespace. |
| `loadLesson` | `src/state/memory.ts:290` | `(projectRoot, lessonId, namespace?)` | Reads one lesson; throws `Lesson not found` if absent. |
| `loadConfig` | `src/config/loader.js` | `(projectRoot): Promise<BoberConfig>` | Loads + Zod-validates `bober.config.json`. |
| `resolveRoleProviders` | `src/config/role-providers.js` | `(config): RoleProviderMap` | Default per-role provider routing; loadTeam merges team overrides over this. |
| `createClient` | `src/providers/factory.js` | `(provider, endpoint, providerConfig, model, role)` | Builds an LLMClient; used by chat.ts:29. |
| `findProjectRoot` | `src/utils/fs.js` | `(): Promise<string \| undefined>` | Walks up to the project root; spy this in tests to point at a temp dir. |
| `ChatSession` | `src/chat/chat-session.ts:70` | `new ChatSession(opts: ChatSessionOptions)` | Accepts `memoryNamespace` (line 38); `buildMemoryDistill` reads it (line 150). |
| `RunSpawner` | `src/chat/run-spawner.ts:61` | `new RunSpawner(opts: RunSpawnerOptions)` | Spawns detached `run <task> --run-id <id>` (line 111). NO teamId field today. |
| `TeamConfigSchema` / `TeamConfig` | `src/config/schema.ts:361,372` | Zod object | The validated shape of a `teams.<id>` entry. |

**Utilities reviewed:** `src/utils/` (fs, logger, git), `src/state/memory.ts`, `src/config/`, `src/teams/`,
`src/chat/`. No new utility module is needed — this sprint wires existing ones.

---

## 4. Prior Sprint Output

### Sprint 1 (274338b): Team abstraction + loadTeam
**Created:** `src/teams/registry.ts` (exports `loadTeam`), `src/teams/types.ts` (`Team`, `Role`).
`src/config/schema.ts` gained `TeamConfigSchema`/`TeamConfig` (lines 360-372), `teams` record + `defaultTeam` (lines 401-402).
**Connection:** sc-4-4 — `loadTeam(config, 'example')` must return the declared `memoryNamespace`,
`pipelineShape`, and providers MERGED over resolved defaults (registry.ts:47-57). Unspecified roles
keep the default; declared `providers` override (registry.ts:53).

### Sprint 2 (2d89d8c): Per-team memory namespacing
**Created/changed:** `memoryDir(projectRoot, namespace?)` (memory.ts:26); persistence fns thread
`namespace`; `memory.ts` (CLI) `resolveDefaultNamespace` (memory.ts:45); `ChatSession` gained
`ChatSessionOptions.memoryNamespace` (chat-session.ts:38) + `buildMemoryDistill(projectRoot, namespace?)`
(chat-session.ts:48, called at line 150).
**Connection:** sc-4-6/sc-4-7 — chat passes the team namespace into ChatSession; lessons distilled in
that session land under `.bober/memory/<namespace>/`. Sentinel `''` => default path (no `programming/` subdir).

### Sprint 3 (dc3dd4e): runPipeline opts.teamId
**Changed:** `runPipeline` accepts `opts.teamId` (pipeline.ts:980), defaulting `config.defaultTeam`
then `'programming'`; `selectPipelineEngineForTeam(team, config)` (workflow/selector.js) drives the
engine from `team.pipelineShape`.
**Connection:** sc-4-5 — run.ts just passes `teamId: options.team` into the existing opts.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`) — HARD RULES
- **ESM everywhere:** all relative imports use `.js` extensions (NodeNext). `import { loadTeam } from "../../teams/registry.js"`.
- **`import type` for types** (`consistent-type-imports` enforced). e.g. `import type { Command } from "commander"`.
- **No network/real LLM in tests:** temp dirs created with `mkdtemp`, cleaned in `afterEach`; inject fakes.
- **No synchronous fs:** `node:fs/promises` only.
- **Section comments:** `// ── Name ──────` box headers in long files.
- **Small modules; no barrel re-export of internals:** import directly, not via `src/index.ts`.
- **Conventional commits:** `feat: ...` / sprint commits `bober(sprint-4): ...`.
- **Additive CLI mandate:** `--team` mirrors `--run-id` — absent flag = today's behavior, zero regressions.

### Architecture / Research
**Source:** `.bober/research/20260614-chattable-team-of-agents-platform.md`.
- Phase 4 (line 290): "S4.1 Extract Team config … adding a team is data, not code." (line 294).
- Team-is-data model (lines 137-149): `{ id, roles[], memoryNamespace, providers: RoleProviderMap, pipeline: PipelineShape, guardrails }`.
- "Same engine, different encoded SOP" (line 153) — pipeline shape is the SOP axis. Cross-reference this doc's Phase 4 from `docs/teams.md`.
No `.bober/architecture/` ADR is specific to this sprint (dir exists but holds prior-plan specs).

### Other Docs
- `README.md` Full Configuration Reference (lines 555-668) — `teams`/`defaultTeam` MISSING; add after `commands` (line 666).
- `docs/providers.md` — template for `docs/teams.md` structure (topic doc with config snippets).

---

## 6. Testing Patterns

### Unit Test Pattern (CLI command via commander + temp dirs)
**Source:** `src/cli/commands/memory.test.ts` (the closest precedent — a CLI command test with temp dirs,
a `findProjectRoot` spy, and `program.parseAsync`). Skeleton to copy:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-team-cmd-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

it("registers a command and routes through findProjectRoot", async () => {
  const fsUtils = await import("../../utils/fs.js");
  const rootSpy = vi.spyOn(fsUtils, "findProjectRoot").mockResolvedValue(tmpDir);
  try {
    const { Command } = await import("commander");
    const { registerMemoryCommand } = await import("./memory.js");
    const program = new Command();
    program.exitOverride();                         // commander must not call process.exit in tests
    registerMemoryCommand(program);
    await program.parseAsync(["node", "bober", "memory", "list"]);
  } finally { rootSpy.mockRestore(); }
});
```
**Runner:** vitest. **Assertion:** `expect`. **Mock approach:** `vi.spyOn` on `findProjectRoot` + on
`process.stdout.write` to capture output (memory.test.ts:140-147). **File naming:** `<name>.test.ts`
collocated. **Location:** co-located next to source.

### sc-4-5 — assert the team id reaches runPipeline (THE stubbing seam)
`run.ts` imports `runPipeline` from `"../../orchestrator/pipeline.js"`. Stub it with `vi.mock` (ESM):
```ts
import { vi } from "vitest";
vi.mock("../../orchestrator/pipeline.js", () => ({
  runPipeline: vi.fn(async () => ({                 // capture the opts arg
    success: true, duration: 0, spec: { title: "t", features: [] },
    completedSprints: [], failedSprints: [],
  })),
}));
// also stub config: vi.mock("../../config/loader.js") -> configExists: async()=>true,
//   loadConfig: async()=> a minimal config with teams.example
import { runPipeline } from "../../orchestrator/pipeline.js";
import { runRunCommand } from "./run.js";

it("threads --team to runPipeline", async () => {
  await runRunCommand("do x", tmpDir, { team: "example" } as any);
  expect(runPipeline).toHaveBeenCalledWith("do x", tmpDir, expect.anything(),
    expect.objectContaining({ teamId: "example" }));
});
it("absent --team yields programming default (teamId undefined)", async () => {
  await runRunCommand("do x", tmpDir, {} as any);
  const opts = (runPipeline as any).mock.calls.at(-1)[3];
  expect(opts.teamId).toBeUndefined();   // runPipeline then resolves config.defaultTeam ?? 'programming'
});
```
Calling `runRunCommand` directly (not through commander) is the simplest seam for flag PROPAGATION.
For flag PARSE, register via index.ts/commander and assert `runPipeline` received `teamId:"example"`.
**Note:** `run.ts` prompts for a task if none is given — always pass a task in tests.

### sc-4-4 — loadTeam returns declared shape (pure, no temp dir needed)
```ts
import { loadTeam } from "../../teams/registry.js";
const config = { project: { name: "t", mode: "brownfield" },
  /* ...minimal required sections or use ConfigSchema defaults... */
  teams: { example: { memoryNamespace: "example", pipelineShape: "ts", providers: { chat: "openai" } } },
} as any;
const team = loadTeam(config, "example");
expect(team.memoryNamespace).toBe("example");
expect(team.pipelineShape).toBe("ts");
expect(team.providers.chat).toBe("openai");          // override merged over defaults (registry.ts:53)
```

### sc-4-6 / sc-4-7 — chat namespace routing + lesson lands in namespace
**Source pattern:** memory.test.ts:377-414 constructs a `ChatSession` with a fake LLM and uses
`appendLesson`/`loadLessonIndex` to assert namespace routing. Fake LLM shape (memory.test.ts:395-400):
```ts
const fakeLLM = { chat: async () => ({
  text: JSON.stringify({ action: "answer" }),
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
}) } as unknown as LLMClient;
```
sc-4-7 assertion idiom (drive a lesson through the active example team, assert it lands in the namespace,
NOT in the default path):
```ts
import { appendLesson, loadLessonIndex, memoryDir } from "../../state/memory.js";
await appendLesson(tmpDir, lesson, "example");                       // example team namespace
const inNs  = await loadLessonIndex(tmpDir, { limit: 10 }, "example");
const inDef = await loadLessonIndex(tmpDir, { limit: 10 }, undefined);
expect(inNs.map(r => r.lessonId)).toContain(lesson.lessonId);       // landed under .bober/memory/example/
expect(inDef.map(r => r.lessonId)).not.toContain(lesson.lessonId);  // NOT in .bober/memory/
expect(memoryDir(tmpDir, "example")).toMatch(/memory[/\\]example$/);
```
For sc-4-6, assert that a chat command built with team `example` constructs a `ChatSession` whose
`memoryNamespace` is `"example"` (inject the session or spy on ChatSession; or assert via the namespace
the session reads). A `ChatSession` built with no team uses `''`→default path (registry.ts:66, chat-session.ts:90).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|---|---|---|---|
| `src/cli/index.ts` | `runRunCommand` (run.ts) | medium | Adding `--team` must not change `--run-id`/`--provider`/`--mode` parsing; the new flag is purely additive (line 217-238 block). |
| `src/orchestrator/pipeline.ts` | called by run.ts | low | `runPipeline` already accepts `teamId` (line 980). No change there — only a new value flows in. |
| `src/chat/chat-session.ts` | constructed by chat.ts | medium | Passing `memoryNamespace` is supported (line 38); ensure `''` (programming) still collapses to default path (line 90). |
| `src/chat/run-spawner.ts` | used by ChatSession | high (IF you thread teamId) | If you add `--team` to spawned children (line 111), keep it absent by default so existing spawn tests (run-spawner.test.ts) still assert the exact arg array `["run", task, "--run-id", runId]`. |
| `src/cli/commands/memory.ts` | `loadTeam`, namespace | low | Shares the namespace-resolution idiom; don't regress `resolveDefaultNamespace` (lines 45-53). |

### Existing Tests That Must Still Pass
- `src/cli/commands/memory.test.ts` — tests namespace routing (C5, lines 335-415); verify the
  default-team `''`→`.bober/memory/` behavior is unchanged after your chat namespace wiring.
- `src/chat/run-spawner.test.ts` — asserts the spawned arg array. If you DON'T thread teamId into the
  spawner, this is untouched; if you DO, update it and keep absent-team = today's args.
- `src/chat/chat-session-spawn.test.ts`, `chat-session-steer.test.ts`, `chat-session-completion.test.ts`,
  `chat-schema.test.ts` — exercise ChatSession turn loop; verify adding `memoryNamespace` to the
  constructor doesn't change default-namespace behavior.
- Any test importing `runPipeline` or `loadConfig` — unchanged signatures; new opts are additive.

### Features That Could Be Affected
- **`bober run` (programming default)** — shares run.ts/index.ts. Verify `run "x"` with NO `--team`
  calls `runPipeline` with `teamId: undefined` (→ programming). This is the core sc-4-5 regression.
- **`bober chat` (no team)** — shares chat.ts. Verify `chat` with no positional arg uses the programming
  team (`''`→ default memory path).
- **`bober memory distill|list|show`** — shares the namespace mechanism. No change to its default behavior.

### Recommended Regression Checks
1. `npm run build` — zero TS errors (sc-4-1).
2. `npm run typecheck` — zero strict errors (sc-4-2).
3. `npm run test` — full suite green incl. new run.test.ts + chat.test.ts (sc-4-3).
4. New test: `runRunCommand("x", root, {})` → `runPipeline` opts `teamId` is `undefined` (no-flag regression).
5. New test: `runRunCommand("x", root, { team:"example" })` → opts `teamId === "example"`.
6. New test: a lesson written during an active example session lands in `.bober/memory/example/`, NOT `.bober/memory/`.
7. `npm run lint` if available — `consistent-type-imports` + `.js` extensions.

---

## 8. Implementation Sequence

1. **Example team fixture (DATA, in tests)** — add an `example` entry to the in-test config object
   (`teams: { example: { memoryNamespace:"example", pipelineShape:"ts", providers:{ chat:"openai" } } }`).
   Optionally add the same as a commented block in README/docs. No code branch.
   - Verify: `loadTeam(config, "example")` returns the declared namespace/shape/merged providers (sc-4-4 test).
2. **src/cli/commands/run.ts** — add `team?: string` to `RunCommandOptions`; thread `teamId: options.team`
   into the `runPipeline(...)` call (line 148). Optional `logger.info` when set.
   - Verify: typecheck clean; `runRunCommand({})` passes `teamId: undefined`.
3. **src/cli/index.ts** — register `.option("--team <id>", "...")` after `--run-id` (line 220); add
   `team?: string` to the inline cmdOpts type; pass `team: cmdOpts?.team` to `runRunCommand`.
   - Verify: `program.parseAsync(["node","bober","run","x","--team","example"])` reaches runPipeline w/ `teamId:"example"`.
4. **src/cli/commands/chat.ts** — rename `_team`→`team`; `import { loadTeam }`; resolve `activeTeam`;
   pass `memoryNamespace: activeTeam.memoryNamespace` to `ChatSession`; update the top doc comment.
   - Verify: chat with `example` builds a session with namespace `"example"`; chat w/o team → `''`/default.
5. **(Optional) RunSpawner teamId** — only if a test requires spawned children to carry `--team`.
   Thread `teamId` through ChatSessionOptions → RunSpawnerOptions → spawn args; keep absent = today's args.
   - Verify: run-spawner.test.ts still passes (absent team => unchanged arg array).
6. **src/cli/commands/run.test.ts** (CREATE) — sc-4-5: vi.mock runPipeline + loadConfig; assert
   `teamId:"example"` propagates and absent => undefined.
7. **src/cli/commands/chat.test.ts** (CREATE) — sc-4-6: assert chat resolves the named team's namespace;
   no-team → default. sc-4-7: drive `appendLesson(tmpDir, lesson, "example")` and assert it lands in
   `.bober/memory/example/`, not the default path.
8. **README.md** — add `teams`/`defaultTeam` to the config reference (after line 666) + a `--team` run
   example + a "Teams" subsection linking to docs/teams.md.
9. **docs/teams.md** (CREATE) — config shape, three axes, programming default, `run --team` / `chat <team>`
   usage, deferred `.bober/teams/*.json` registry; cross-reference research Phase 4.
10. **Run full verification** — `npm run build`, `npm run typecheck`, `npm run test`.

---

## 9. Pitfalls & Warnings

- **Do NOT branch on team id.** No `if (teamId === "example")`. The example team MUST flow through
  `loadTeam` (registry.ts:40-57). A code branch defeats the entire sprint thesis and will fail evaluator review.
- **run.ts must NOT call `loadTeam`.** `runPipeline` already resolves the team (pipeline.ts:982-983).
  Pre-resolving in run.ts duplicates logic and risks divergence — just pass `teamId`.
- **The flag is registered in index.ts, not run.ts.** `estimatedFiles` lists run.ts but NOT index.ts;
  you still MUST edit index.ts or the flag is dead. Mirror the `--run-id` block exactly (index.ts:217-238).
- **Sentinel `''` collapses to the default path.** Programming team's `memoryNamespace` is `''`
  (registry.ts:66); ChatSession does `opts.memoryNamespace || undefined` (chat-session.ts:90). Passing the
  programming namespace must NOT create a `.bober/memory/programming/` subdir (memory.test.ts:370-374 asserts this).
- **No real LLM / no network in tests.** Inject the fake LLM (memory.test.ts:395-400). Spy `findProjectRoot`
  to a temp dir. Stub `runPipeline` and `loadConfig` with `vi.mock` for the run.ts flag tests.
- **`run.ts` prompts for a task when none is given.** Always pass a task string in tests, else `prompts` hangs.
- **commander `program.exitOverride()`** in tests so a parse error throws instead of `process.exit`-ing the test runner (memory.test.ts:153).
- **`.js` import extensions + `import type`** are hard lint gates (principles.md). `import { loadTeam } from "../../teams/registry.js"`.
- **`docs/sprints/**` is owned by a parallel Sprint-3 documenter — do NOT write there.** README.md and
  docs/teams.md are clear for you.
- **`memoryNamespace` Zod regex** is `/^[a-z0-9_-]+$/i` (schema.ts:364) — keep the example namespace
  to a safe segment like `example` (no slashes/spaces).
- **Don't add a second PRODUCTION team or the file registry** (nonGoals) — `example` is a validation
  fixture; the `.bober/teams/*.json` registry is DEFERRED (document it, don't build it).
