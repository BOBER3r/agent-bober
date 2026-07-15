# Sprint Briefing: Chat REPL that answers — walking skeleton, chat role, resumable session

**Contract:** sprint-spec-20260614-bober-chat-session-layer-1
**Generated:** 2026-06-14T00:00:00Z

---

## 0. TL;DR for the Generator

Build a new `src/chat/` module (one small single-purpose file per component, unicode `// ── Section ──` headers) plus three small config edits and one CLI command. ALL LLM calls go through `LLMClient` from `src/providers` — NEVER import `@anthropic-ai/sdk` or `openai` under `src/chat`. Read the disk roster via `readRunStatesFromDisk` (NOT `RunManager.load`), read the memory distill via `loadLessonIndex`/`loadLesson`, persist conversation to `.bober/chat/<sessionId>.jsonl`. Only the `answer` action is handled this sprint; `spawn`/`steer` are acknowledged as not-yet-available. Tests are collocated `*.test.ts`, use real temp dirs (no fs mocks), and a fake `LLMClient` (no network).

---

## 1. Target Files

### src/config/schema.ts (modify)

Add a `ChatSectionSchema` (mirror `CuratorSectionSchema`) and wire it into `BoberConfigSchema`.

**Pattern to copy — `CuratorSectionSchema`, lines 138-146:**
```ts
export const CuratorSectionSchema = z.object({
  model: ModelChoiceSchema.default("opus"),
  maxTurns: z.number().int().min(1).default(25),
  enabled: z.boolean().default(true),
  provider: z.string().optional(),
  endpoint: z.string().nullable().optional(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
});
export type CuratorSection = z.infer<typeof CuratorSectionSchema>;
```
New section should be:
```ts
export const ChatSectionSchema = z.object({
  model: ModelChoiceSchema.default("opus"),
  provider: z.string().optional(),
  endpoint: z.string().nullable().optional(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
});
export type ChatSection = z.infer<typeof ChatSectionSchema>;
```

**Wire into `BoberConfigSchema`, lines 350-372** — add an optional `chat` field alongside the other optional sections (e.g. after `history` at line 371):
```ts
  history: HistorySectionSchema.optional(),
  chat: ChatSectionSchema.optional(),   // ← add this
});
```
`ModelChoiceSchema` is at line 19. Note `PartialBoberConfigSchema` (line 379) is `BoberConfigSchema.deepPartial()` — it auto-picks up the new optional field, no edit needed there.

**sc-1-4 evidence:** parse `{ chat: { model: 'deepseek-chat', provider: 'deepseek' } }` and assert success; assert the default path gives opus/anthropic.

**Imported by:** `src/config/defaults.ts`, `src/config/role-providers.ts`, `src/config/loader.ts`, and many more (`grep -rl "config/schema" src` → ~40 files). The change is purely additive (new optional field) so existing importers are unaffected.

**Test file:** no `schema.test.ts` exists; collocate a new `src/config/schema.test.ts` OR add the chat-role parse assertion in the chat module / a config test. (`src/cli/commands/config.test.ts` exists for the CLI surface.)

---

### src/config/defaults.ts (modify)

`createDefaultConfig` lives in **schema.ts** (lines 396-459), NOT defaults.ts. defaults.ts holds `getDefaults`/preset maps. Per sc-1-4 the **defaults** for chat are opus/anthropic. Two ways to satisfy "defaults set it to opus/anthropic":

1. Because `ChatSectionSchema.model` already `.default("opus")` and provider resolution defaults to anthropic (see `createClient` below), simply documenting that an absent/`{}` chat section yields opus is the minimal path.
2. If an explicit default object is wanted, add `chat: { model: "opus", provider: "anthropic" }` to the base in `createDefaultConfig` (schema.ts:402-452) and/or to `greenfieldBase`/`brownfieldBase` in defaults.ts (lines 182-264).

Keep it minimal and additive. The contract lists `defaults.ts` as a target, so at least add a `chat` default to the relevant base object(s) for explicitness.

---

### src/config/role-providers.ts (modify — full file read, 141 lines)

Add `"chat"` to the role surface so `resolveRoleProviders` returns a provider for it.

**`RoleName` union, lines 10-16** — add `| "chat"`:
```ts
export type RoleName =
  | "planner" | "researcher" | "curator"
  | "generator" | "evaluator" | "codeReview"
  | "chat";   // ← add
```

**`PROMPT_ROLES`, line 30** — add `"chat"` (chat is prompt-only; it must be allowed on claude-code and never force-redirected like tool roles):
```ts
const PROMPT_ROLES: RoleName[] = ["planner", "researcher", "chat"];
```

**`effectiveProvider`, lines 48-71** — add a branch for `chat` reading `config.chat?.model/provider` (mirror the `else` branch at lines 60-64). Example:
```ts
} else if (role === "chat") {
  model = config.chat?.model;
  provider = config.chat?.provider;
} else {
```
`ALL_ROLES` (line 37) auto-includes chat once it's in PROMPT_ROLES. The Step-4 logging loop (lines 134-138) then logs the chat provider too.

**Rule:** chat is a PROMPT role (single text answer, no tool driving), so it must go in `PROMPT_ROLES` not `TOOL_ROLES` — otherwise it would be force-redirected/throw when on claude-code (lines 117-130).

---

### src/chat/turn-classifier.ts (create)

One jsonObjectMode `LLMClient.chat` call returning a `ClassifierAction`; ANY parse failure ⇒ `{ action: "answer" }`.

`ClassifierAction` type (keep EXACTLY this shape even though only `answer` is handled):
```ts
export type ClassifierAction =
  | { action: "answer" }
  | { action: "spawn"; task: string }
  | { action: "steer"; op: "inspect" }
  | { action: "steer"; op: "stop"; runId: string };
```
Validate with a Zod discriminated union and parse defensively: strip ```` ```json ```` fences, extract the first balanced `{...}`, zod-validate; on any throw return `{ action: "answer" }`. Call shape (see ChatParams §3): `client.chat({ model, system, messages: [{role:"user", content: input}], jsonObjectMode: true })`. Read `response.text`.

**sc-1-5 evidence:** fake client returns `` '```json {"action":"answer"}```' `` then garbage `'not json'` — both yield a valid action; garbage ⇒ answer.

---

### src/chat/roster-reader.ts (create)

Thin wrapper over `readRunStatesFromDisk(projectRoot)` (`src/state/run-state.ts:110` → returns `Promise<RunState[]>`). Expose `read()` and `summarize(states)` (a plain string for `/runs` and for prompt context). MUST NOT reference `RunManager.load` (sc-1-6, sc-1-8 grep).

`RunState` shape — `src/mcp/run-manager.ts:35-55`: `{ runId, task, status: "running"|"completed"|"failed"|"aborted", startedAt, completedAt?, progress, projectRoot, specId?, ... }`.

**sc-1-6 evidence:** write a temp `.bober/runs/<id>/state.json` with `status:"running"`; after `read()` the status must still be `"running"` both on disk and in the returned array. `readRunStatesFromDisk` is read-only (delegates to `listRunStateFiles`, run-state.ts:113) — it does NOT reconcile, unlike `RunManager.load`.

---

### src/chat/conversation-store.ts (create)

Append-only JSONL at `.bober/chat/<sessionId>.jsonl` using `node:fs/promises` (async only). `loadRecent(limit)` reads, parses, skips malformed lines, returns newest-last. Use `ensureDir` (`src/utils/fs.ts:45` or `src/state/helpers.ts:6`) before writing.

Turn record shape (your choice, keep small), e.g. `{ role: "user"|"assistant", content: string, ts: string }`.

**Path helper pattern (mirror run-state.ts:19-30):**
```ts
function chatDir(projectRoot: string): string { return join(projectRoot, ".bober", "chat"); }
function sessionPath(projectRoot: string, sessionId: string): string {
  return join(chatDir(projectRoot), `${sessionId}.jsonl`);
}
```
Append with `await appendFile(path, JSON.stringify(record) + "\n", "utf-8")` after `ensureDir`.

**sc-1-7 evidence:** append two turns; construct a FRESH store with same sessionId+projectRoot; `loadRecent(10)` returns the two turns in order (resume).

---

### src/chat/answerer.ts (create)

Composes roster summary + memory distill + recent history into ONE `LLMClient.chat` call (no jsonObjectMode — plain text). Returns `response.text`. Build `messages: Message[]` from recent history (`TextMessage`, role `"user"|"assistant"`, types.ts:96-100) plus the current user input.

---

### src/chat/slash-commands.ts (create)

If `input.trimStart().startsWith("/")`, handle deterministically WITHOUT touching the LLMClient:
- `/runs` → `roster.summarize(await roster.read())`
- `/help` → static command list string
- `/exit` → signal loop end
Return a small discriminated result, e.g. `{ handled: true, output?: string, exit?: boolean }` or `{ handled: false }` so the session falls through to classify/answer.

**sc-1-9 evidence:** a session whose injected LLMClient THROWS if called must still succeed for `/runs`, `/help`, `/exit`.

---

### src/chat/chat-session.ts (create)

Exposes `ChatSession` with `start()` and `handleTurn(input)`. Per turn:
1. If slash command → dispatch deterministically, persist, return.
2. Else read roster (`RosterReader.read`) + memory distill (loadLessonIndex/loadLesson).
3. Classify (`TurnClassifier.classify`, jsonObjectMode). parse-fail ⇒ answer.
4. `answer` → `Answerer` call with roster+distill+recent history. `spawn`/`steer` → reply "that action arrives in a later sprint" (graceful stub).
5. Persist user + assistant turns to `ConversationStore`.

Constructor should take injected deps (`{ llm: LLMClient, projectRoot, sessionId, ... }`) so tests inject a fake client. Use a stable `sessionId` (literal `"default"` is acceptable per assumptions).

---

### src/cli/commands/chat.ts (create)

Use the **register-style** pattern (newer commands use `register<Name>Command(program)`), mirroring `src/cli/commands/memory.ts:37`. Construct a real client from config and call `session.start()`.

**Template (from memory.ts:13-47 + run.ts:79-81):**
```ts
import type { Command } from "commander";
import { findProjectRoot } from "../../utils/fs.js";
import { loadConfig } from "../../config/loader.js";
import { resolveRoleProviders } from "../../config/role-providers.js";
import { createClient } from "../../providers/factory.js";
// ...

export function registerChatCommand(program: Command): void {
  program
    .command("chat [team]")
    .description("Start an interactive bober chat session")
    .action(async (_team?: string) => {
      const projectRoot = (await findProjectRoot()) ?? process.cwd();
      const config = await loadConfig(projectRoot);
      const providers = resolveRoleProviders(config);
      const client = createClient(
        providers.chat,
        config.chat?.endpoint ?? null,
        config.chat?.providerConfig,
        config.chat?.model,
        "chat",
      );
      // construct ChatSession({ llm: client, projectRoot, sessionId: "default" }) and start()
    });
}
```
Register it in `src/cli/index.ts` near the other `register*Command(program)` calls (lines 290-294, e.g. after `registerMemoryCommand`). Add the import at the top (lines 36-37 area).

`createClient(provider?, endpoint?, providerConfig?, model?, role?)` — factory.ts:172. `loadConfig(projectRoot)` — loader.ts:142. `configExists(projectRoot)` — loader.ts:91.

CLI handlers MUST NOT throw — on error set `process.exitCode = 1` and return (memory.ts:9-11 convention).

---

## 2. Patterns to Follow

### Provider-agnostic LLM call (ChatParams / ChatResponse)
**Source:** `src/providers/types.ts:139-206`
```ts
export interface ChatParams {
  model: string; system: string; messages: Message[];
  jsonObjectMode?: boolean;   // line 183 — loose JSON-object mode (use true for classifier)
  responseSchema?: JsonSchemaObject; // strict; DeepSeek rejects — do NOT use here
}
export interface ChatResponse { text: string; toolCalls: ToolCall[]; stopReason: StopReason; usage: {...}; }
```
**Rule:** classifier uses `jsonObjectMode: true` (loose); answerer uses neither. Always read `response.text`. NEVER use `responseSchema` for the classifier (DeepSeek rejects strict json_schema — types.ts:178-181).

### Message shape
**Source:** `src/providers/types.ts:96-100`
```ts
export interface TextMessage { role: "user" | "assistant"; content: string; }
```
**Rule:** build conversation `messages` as `TextMessage[]`.

### Async fs + path helpers + atomic writes
**Source:** `src/state/run-state.ts:10-30`, `src/utils/fs.ts:45`
**Rule:** import `appendFile`/`readFile` from `node:fs/promises`; build paths with `join(projectRoot, ".bober", ...)`; `ensureDir` before writing. Async only — no sync fs.

### Section comments
**Source:** every file, e.g. `src/config/role-providers.ts:5`, `src/utils/fs.ts:5`
**Rule:** organize files with `// ── Section Name ──────` unicode box headers.

### type imports + .js extensions (NodeNext ESM)
**Source:** `src/config/role-providers.ts:1-3`
```ts
import { resolveProviderModel } from "../orchestrator/model-resolver.js";
import type { BoberConfig } from "./schema.js";
```
**Rule:** all relative imports end in `.js`; type-only imports use `import type` (ESLint `consistent-type-imports` is a hard gate). Prefix unused params with `_`.

### CLI register pattern
**Source:** `src/cli/commands/memory.ts:37-47`, registered in `src/cli/index.ts:291`
**Rule:** export `registerChatCommand(program)`, call `program.command(...).action(...)`, register in index.ts.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `readRunStatesFromDisk` | `src/state/run-state.ts:110` | `(projectRoot): Promise<RunState[]>` | Read-only roster of runs from disk. USE THIS, never RunManager.load. |
| `createClient` | `src/providers/factory.ts:172` | `(provider?, endpoint?, providerConfig?, model?, role?): LLMClient` | Build a provider-agnostic LLM client. |
| `resolveRoleProviders` | `src/config/role-providers.ts:92` | `(config): RoleProviderMap` | Resolve effective provider per role (add `chat`). |
| `loadConfig` | `src/config/loader.ts:142` | `(projectRoot): Promise<BoberConfig>` | Load + validate `.bober` config. |
| `configExists` | `src/config/loader.ts:91` | `(projectRoot): Promise<boolean>` | Check config presence. |
| `loadLessonIndex` | `src/state/memory.ts:242` | `(projectRoot, {limit}): Promise<LessonIndexRecord[]>` | Read bounded memory distill index. |
| `loadLesson` | `src/state/memory.ts:272` | `(projectRoot, lessonId): Promise<LessonEntry>` | Read one lesson body. |
| `appendLesson` | `src/state/memory.ts:196` | `(projectRoot, lesson): Promise<void>` | (NOT needed this sprint — read only.) |
| `ensureDir` | `src/utils/fs.ts:45` / `src/state/helpers.ts:6` | `(path): Promise<void>` | mkdir -p before writing. |
| `fileExists` | `src/utils/fs.ts:10` | `(path): Promise<boolean>` | Async existence check. |
| `findProjectRoot` | `src/utils/fs.ts:58` | `(startDir?): Promise<string\|null>` | Walk up to project root. |
| `logger` | `src/utils/logger.ts` | `.info/.error/.verbose` | Structured logging (used by role-providers, run.ts). |
| `ensureBoberDir` | `src/state/index.ts` | `(projectRoot)` | Ensure `.bober/` exists (run.ts:131). |

**Memory distill note:** the contract's "memory distill" = the `.bober/memory/` lesson store (INDEX.md + `<id>.md`). Read it with `loadLessonIndex` (then optionally `loadLesson`) and compose a compact prompt string. Do NOT invent a new distill reader.

Utilities reviewed: `src/utils/` (fs, logger, git), `src/state/` (run-state, memory, helpers, index), `src/config/`, `src/providers/`.

---

## 4. Prior Sprint Output

No prior sprints — this is Sprint 1 of 4 (walking skeleton). Non-goals (do NOT build): RunSpawner (Sprint 2), completion weaving (Sprint 3), steer-stop/kill (Sprint 4), `--run-id` flag (Sprint 2). Do not modify runPipeline, RunManager, EventStreamManager, memory, or provider public APIs.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- ESM everywhere — `.js` extensions on all imports, NodeNext, no CommonJS.
- Provider-agnostic interfaces — ALL LLM interaction goes through `providers/types.ts`; never leak SDK types outside adapter files. (Directly enforces sc-1-8.)
- Zod for config validation in `config/schema.ts`; no hand-rolled validation.
- Filesystem state — all mutable state as files in `.bober/`; no DB, no in-memory globals.
- Section comments — unicode box headers.
- Small single-purpose utility modules.
- `import type` enforced (consistent-type-imports); unused params prefixed `_`.
- TS strict mode (noUnusedLocals/Parameters/noImplicitReturns/etc.) is a hard gate; tests collocated `*.test.ts`; tests use real project / real temp dirs when practical.

### Architecture Decisions
`.bober/architecture/` exists (untracked) but contains briefing-adjacent docs, not chat ADRs. The contract's `generatorNotes`/`evaluatorNotes` ARE the authoritative architecture for this sprint — follow the verified signatures there.

### Other Docs
`AGENTS.md` and `README.md` exist at repo root (CLI conventions). No CLAUDE.md in repo (global one only).

---

## 6. Testing Patterns

### Unit Test Pattern — fake LLMClient (no network)
**Source:** `src/providers/structured.test.ts:34-52`
```ts
class ScriptedClient implements LLMClient {
  readonly calls: ChatParams[] = [];
  private idx = 0;
  constructor(private readonly responses: string[]) {}
  async chat(params: ChatParams): Promise<ChatResponse> {
    this.calls.push(params);
    const text = this.responses[Math.min(this.idx, this.responses.length - 1)] ?? "";
    this.idx += 1;
    return { text, toolCalls: [], stopReason: "end", usage: { inputTokens: 3, outputTokens: 5 } };
  }
}
```
For sc-1-9, also write a `ThrowingClient implements LLMClient { async chat() { throw new Error("should not be called"); } }` to prove slash-commands don't hit the LLM.

### Unit Test Pattern — real temp dirs (no fs mocks)
**Source:** `src/cli/commands/memory.test.ts:11-32`
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-chat-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
```
**Runner:** vitest. **Assertion style:** `expect`. **Mock approach:** hand-written fake classes implementing `LLMClient` (no `vi.mock` for the client); real temp dirs for fs. **File naming:** `<name>.test.ts` collocated next to source. **Location:** co-located.

For sc-1-6: `await mkdir(join(tmpDir, ".bober", "runs", "<id>"), {recursive:true})` then `writeFile(state.json, JSON.stringify({runId, task, status:"running", startedAt, progress:{...}, projectRoot:tmpDir}))`, call `RosterReader.read()`, assert status still `"running"`.

### E2E Test Pattern
Not applicable — this is a CLI/lib sprint; no Playwright. Verify via unit tests + the `handleTurn` entry per stopConditions.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/config/loader.ts` | `config/schema.ts` | low | new `chat` field is optional — existing parse unaffected |
| `src/config/role-providers.ts` | `config/schema.ts` | medium | adding `chat` to `RoleName`/`ALL_ROLES` changes the returned `RoleProviderMap` shape; ensure `chat` resolves and existing roles unchanged |
| ~40 importers of `config/schema.ts` | `config/schema.ts` | low | additive optional field; `BoberConfig` type gains optional `chat` — no breakage |
| `src/cli/index.ts` | new `chat.ts` | low | new register call; mirror existing — don't reorder others |
| anything importing `RoleProviderMap`/`RoleName` | `role-providers.ts` | medium | `Record<RoleName,string>` now requires a `chat` key — TS will flag any object-literal RoleProviderMap built elsewhere |

Run `grep -rn "RoleProviderMap\|RoleName" src` after editing to catch any exhaustive switch/object that now needs a `chat` arm.

### Existing Tests That Must Still Pass
- Any `role-providers` test (grep `src` for `resolveRoleProviders` in `*.test.ts`) — verify still passes with the new role.
- `src/cli/commands/config.test.ts` — config CLI surface; new optional field should not break it.
- `src/config/loader` tests (if present) — additive optional field.
- Full suite: `npm run test`.

### Features That Could Be Affected
- **role/provider resolution** — shared `resolveRoleProviders`; verify all existing roles still resolve to the same provider and the fallback/throw logic for TOOL_ROLES is unchanged (chat is a PROMPT role).

### Recommended Regression Checks
1. `npm run build` — zero TS errors (sc-1-1).
2. `npm run typecheck` (`tsc --noEmit`) — zero errors (sc-1-2).
3. `npm run test` — all pass incl. new collocated tests (sc-1-3..sc-1-9).
4. `grep -rn "@anthropic-ai/sdk\|from \"openai\"\|from 'openai'" src/chat` → MUST be empty (sc-1-8).
5. `grep -rn "RunManager" src/chat` → MUST be empty (sc-1-6).

---

## 8. Implementation Sequence

1. **src/config/schema.ts** — add `ChatSectionSchema` + type, wire `chat` optional into `BoberConfigSchema`.
   - Verify: `npm run typecheck` clean; a parse of `{chat:{model:'deepseek-chat',provider:'deepseek'}}` succeeds.
2. **src/config/defaults.ts** — add explicit `chat` default (opus/anthropic) to base/greenfield/brownfield as chosen.
   - Verify: defaults produce opus for chat.
3. **src/config/role-providers.ts** — add `"chat"` to `RoleName`, `PROMPT_ROLES`, and an `effectiveProvider` branch.
   - Verify: `resolveRoleProviders(config).chat` returns expected provider; existing roles unchanged.
4. **src/chat/conversation-store.ts** — append-only JSONL + `loadRecent` (no deps beyond fs + ensureDir).
   - Verify: append→fresh-instance resume test (sc-1-7).
5. **src/chat/roster-reader.ts** — `read()` via `readRunStatesFromDisk`, `summarize()`.
   - Verify: temp running-state stays running (sc-1-6); no RunManager ref.
6. **src/chat/turn-classifier.ts** — `ClassifierAction` type + Zod + defensive parse; jsonObjectMode call.
   - Verify: fenced-json ⇒ answer; garbage ⇒ answer (sc-1-5).
7. **src/chat/answerer.ts** — compose roster+distill+history into one chat call.
   - Verify: returns `response.text` from fake client.
8. **src/chat/slash-commands.ts** — deterministic `/runs`,`/help`,`/exit` dispatcher (no LLM).
   - Verify: throwing client never called (sc-1-9).
9. **src/chat/chat-session.ts** — wire 4-8 into `start()`/`handleTurn(input)`; spawn/steer graceful stub.
   - Verify: answers using roster+distill, resumes on 2nd instance.
10. **src/cli/commands/chat.ts** + register in **src/cli/index.ts** — build client via resolveRoleProviders+createClient.
    - Verify: `npm run build`.
11. **Run full verification** — `npm run build`, `npm run typecheck`, `npm run test`, and the two grep checks (sc-1-6, sc-1-8).

---

## 9. Pitfalls & Warnings

- **NEVER call `RunManager.load`** under `src/chat` — it reconciles running→failed (run-manager.ts:251-256) and would mutate disk state. Use `readRunStatesFromDisk` (run-state.ts:110). sc-1-6 greps for this.
- **No SDK imports under `src/chat`** — no `@anthropic-ai/sdk`, no `openai`. All LLM via `LLMClient` from `src/providers`. sc-1-8 greps for this. (principles.md "Provider-agnostic interfaces".)
- **Classifier must use `jsonObjectMode: true`, NOT `responseSchema`** — strict json_schema is rejected by DeepSeek (types.ts:178-181). The whole point is provider-parity.
- **`.js` extensions on every relative import** (NodeNext) or build fails. `import type` for type-only imports or ESLint hard-gate fails.
- **`chat` is a PROMPT role, not a TOOL role** — put it in `PROMPT_ROLES` (role-providers.ts:30). Putting it in TOOL_ROLES would throw/redirect on claude-code.
- **`createDefaultConfig` is in schema.ts (396), not defaults.ts** — don't hunt for it in the wrong file.
- **`RoleProviderMap` becomes `Record<RoleName,string>` with a required `chat` key** — any place that constructs a RoleProviderMap object literal will now fail typecheck until it adds `chat`. Grep before assuming.
- **CLI handlers must not throw** — set `process.exitCode = 1` and return (memory.ts:9-11 convention); the REPL loop itself should catch per-turn errors and keep going.
- **Tests: real temp dirs, no fs mocks; fake/throwing LLMClient, no network** (principle + structured.test.ts pattern). Clean up temp dirs in `afterEach`.
- **Async fs only** — no `*Sync` calls; use `node:fs/promises`.
- **Parse defensively in the classifier** — strip code fences AND extract the first balanced `{...}` before zod; ANY throw ⇒ `{action:"answer"}`. Do not let a parse error escape `handleTurn`.
