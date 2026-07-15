# Sprint Briefing: `bober chat hub` surface with scoped /priority and /decide

**Contract:** sprint-spec-20260628-priority-hub-5
**Generated:** 2026-06-29T00:00:00Z

---

## 0. TL;DR for the Generator

Three additive code edits + two test files. NO new module files (estimatedFiles has none).

1. `src/teams/registry.ts` — add a built-in `hub` team branch inside `loadTeam` (mirror the `medical` branch at line 42), `memoryNamespace: "hub"`, default `pipelineShape`.
2. `src/chat/slash-commands.ts` — add `priorityHandler` + `decideHandler` as the **last two optional params** (positions 10 & 11), add `/priority` + `/decide` cases. **DO NOT touch `HELP_TEXT` or any existing branch.**
3. `src/chat/chat-session.ts` — extend the `dispatch(...)` call (lines 201-211) with two new callbacks, add `handleHubPriority()` + `handleHubDecide(expr)` that gate on `this.memoryNamespace === "hub"` and delegate to `collectFindings` → `rankFindings(this.llm)` → `renderPriorityMd`.
4. `src/chat/slash-commands.test.ts` (modify) + `src/chat/chat-session.test.ts` (create) — new tests + regression on existing commands.

**Reuse `this.llm`** (already a `createClient` chat client wired by `chat.ts:33-39`) for the judge — do NOT call `createClient` inside the handler (it would hit the network in tests; the fake LLM is injected via `ChatSession({ llm })`).

---

## 1. Target Files

### src/teams/registry.ts (modify)

**Relevant section — `loadTeam` resolver (lines 35-64):**
```ts
export function loadTeam(config: BoberConfig, teamId?: string): Team {
  if (teamId === undefined || teamId === "programming") {
    return buildProgrammingTeam(config);
  }
  // Built-in medical team
  if (teamId === "medical") {
    return buildMedicalTeam(config);
  }
  // ← ADD THE HUB BRANCH HERE (before the config.teams lookup)
  const entry = config.teams?.[teamId];
  if (!entry) {
    throw new Error(`Unknown team '${teamId}'. ...`);
  }
  ...
}
```
**Imports this file already has (reuse, no new import needed for the hub branch):**
- `resolveRoleProviders` from `../config/role-providers.js` (registry.ts:9)
- `resolveEngineName` from `../orchestrator/workflow/selector.js` (registry.ts:11) — this is the **default pipelineShape**
- `DEFAULT_ROLES` constant (registry.ts:18) — the 7 role descriptors
- `type { Role, Team }` from `./types.js` (registry.ts:13)

**Recommended hub branch (inline, mirrors `buildProgrammingTeam` at lines 68-78):**
```ts
  // Built-in hub team (data): default pipeline, dedicated 'hub' memory namespace.
  if (teamId === "hub") {
    return {
      id: "hub",
      displayName: "Priority hub",
      memoryNamespace: "hub",
      providers: resolveRoleProviders(config),
      pipelineShape: resolveEngineName(config), // default shape
      roles: DEFAULT_ROLES,
      guardrails: undefined,
    };
  }
```
**Why inline (not a new `src/hub/team.ts`):** `estimatedFiles` lists NO new hub team file, and the hub branch needs no guardrails import — so unlike `medical` (which lives in `src/medical/team.ts` to avoid a circular guardrails import, see team.ts:18-21), the hub team has zero extra deps and belongs inline. `DEFAULT_ROLES` is already in-file.

**Imported by:** `src/cli/commands/chat.ts:19,31` (`loadTeam(config, team)`), `src/cli/commands/hub.ts:20,56`, `src/teams/registry.test.ts`. `bober chat hub` will resolve through the **existing** chat command with NO command change — see §2.

**Test file:** `src/teams/registry.test.ts` (exists) — add a hub case there (mirror sc-1-4 programming test at lines 15-23).

---

### src/chat/slash-commands.ts (modify)

**Current dispatch signature (lines 57-67) — extend with TWO trailing optional params:**
```ts
export async function dispatch(
  input: string,
  roster: RosterReader,
  stopHandler?: (runId: string) => Promise<string>,
  carefulHandler?: (arg: string | undefined) => Promise<string>,
  approveHandler?: (id: string) => Promise<string>,
  rejectHandler?: (id: string, feedback: string) => Promise<string>,
  tellHandler?: (runId: string, text: string) => Promise<string>,
  pauseHandler?: (runId: string) => Promise<string>,
  resumeHandler?: (runId: string) => Promise<string>,
  // ↓ ADD THESE TWO (positions 10 & 11) — preserves all positional callers
  priorityHandler?: () => Promise<string>,
  decideHandler?: (expr: string) => Promise<string>,
): Promise<SlashResult> {
```

**Add two cases to the `switch (command)` block (anywhere among the cases, e.g. after `/resume` at line 149).** Mirror the `/stop` unavailable-fallback pattern (lines 86-93) and the `/tell` remainder-capture pattern (lines 124-135):
```ts
    case "/priority": {
      const output = priorityHandler
        ? await priorityHandler()
        : "Priority is unavailable.";
      return { handled: true, output };
    }

    case "/decide": {
      // Capture everything after '/decide' as the 'X vs Y' expression.
      const expr = trimmed.replace(/^\/decide\s*/i, "").trim();
      if (!expr) return { handled: true, output: "Usage: /decide <X> vs <Y>" };
      const output = decideHandler
        ? await decideHandler(expr)
        : "Decide is unavailable.";
      return { handled: true, output };
    }
```
**Rule:** New cases ONLY. Do NOT edit existing cases. Do NOT add `/priority`/`/decide` to `HELP_TEXT` (lines 17-31) — see Pitfalls §9 (sc-5-4 + nonGoal #1 require `/help` output to stay byte-identical).

**Test file:** `src/chat/slash-commands.test.ts` (exists) — modify (add /priority + /decide dispatch tests).

---

### src/chat/chat-session.ts (modify)

**1. Extend the dispatch call (lines 201-211) — add two callbacks after `resumeHandler`:**
```ts
    const slashResult = await dispatch(
      input,
      this.roster,
      (runId) => this.handleStop(runId),
      (arg) => this.handleCareful(arg),
      (id) => this.handleApprove(id),
      (id, fb) => this.handleReject(id, fb),
      (runId, text) => this.handleTell(runId, text),
      (runId) => this.handlePause(runId),
      (runId) => this.handleResume(runId),
      () => this.handleHubPriority(),          // ← new (param 10)
      (expr) => this.handleHubDecide(expr),    // ← new (param 11)
    );
```
The rest of the `if (slashResult.handled)` block (lines 212-230) is untouched — it already weaves completion/approval notices and persists the turn for ANY handled slash command, so /priority and /decide get that behaviour for free.

**2. Add two private handlers (mirror the structure of `handleTell` at lines 384-397 / `handlePause` at lines 409-420 — return a `string`, async).** The session already exposes everything needed: `this.memoryNamespace` (line 103), `this.llm` (line 88), `this.projectRoot` (line 89).

Suggested shape (delegates to Sprint 2-4 functions; gate is the key correctness point):
```ts
  private async handleHubPriority(): Promise<string> {
    if (this.memoryNamespace !== "hub") {
      return "The /priority command is only available in the hub team. Start it with `bober chat hub`.";
    }
    const scope = parseScope({ mode: "general" });
    return this.rankAndRenderHub(scope, "general");
  }

  private async handleHubDecide(expr: string): Promise<string> {
    if (this.memoryNamespace !== "hub") {
      return "The /decide command is only available in the hub team. Start it with `bober chat hub`.";
    }
    const parts = expr.split(/\s+vs\s+/i);
    if (parts.length !== 2 || !parts[0]!.trim() || !parts[1]!.trim()) {
      return `Expected 'X vs Y', got: ${expr}`;
    }
    const scope = parseScope({
      mode: "decision",
      optionA: parts[0]!.trim(),
      optionB: parts[1]!.trim(),
    });
    return this.rankAndRenderHub(scope, `decide: ${parts[0]!.trim()} vs ${parts[1]!.trim()}`);
  }

  private async rankAndRenderHub(scope: Scope, label: string): Promise<string> {
    const siblings = await resolveSiblingRepos(this.projectRoot);
    const findings = collectFindings(siblings, HUB_SCOPE);
    const now = new Date();
    const ranked = await rankFindings(findings, scope, this.llm, now);
    // Best-effort write of priority.md (skip silently if the vault is absent)
    try {
      const outVault = await resolveOutVault(this.projectRoot);
      if (await fileExists(outVault)) {
        await writeFile(priorityMdPath(outVault), renderPriorityMd(ranked, label, now), "utf-8");
      }
    } catch { /* a write failure must never break the chat turn */ }
    if (ranked.length === 0) return "No findings to prioritize.";
    return ranked.map((f, i) => `${i + 1}. ${f.title}`).join("\n");
  }
```
**Imports to add at the top of chat-session.ts** (all already used elsewhere in the repo — verified paths):
```ts
import { writeFile } from "node:fs/promises";
import { collectFindings } from "../hub/collector.js";
import { rankFindings } from "../hub/judge.js";
import { renderPriorityMd } from "../hub/priority-md.js";
import { resolveSiblingRepos } from "../hub/repo-resolver.js";
import { resolveOutVault, priorityMdPath } from "../hub/hub-config.js";
import { HUB_SCOPE } from "../hub/finding-source.js";
import { parseScope } from "../hub/scope.js";
import type { Scope } from "../hub/scope.js";
import { fileExists } from "../utils/fs.js";
```
(Use `import type` for `Scope` — `consistent-type-imports` is enforced, principles.md:35.)

**The returned-string format** `${i + 1}. ${f.title}` per line is **exactly** what `runHubPriority` prints to stdout (hub.ts:152-154) — sc-5-2 asks for "rank and title per line". Reuse that exact format.

**Imported by / context:** ChatSession is constructed in `src/cli/commands/chat.ts:41-46` and all `src/chat/chat-session-*.test.ts` files.

**Test file:** `src/chat/chat-session.test.ts` — **DOES NOT EXIST** → create.

---

## 2. Patterns to Follow

### Built-in team registration (mirror for `hub`)
**Source:** `src/teams/registry.ts`, lines 41-44 (medical branch) + `src/medical/team.ts`, lines 49-59 (the Team object)
```ts
  if (teamId === "medical") {
    return buildMedicalTeam(config);
  }
```
```ts
export function buildMedicalTeam(config: BoberConfig): Team {
  return {
    id: "medical",
    displayName: "Medical team",
    memoryNamespace: "medical",
    providers: resolveRoleProviders(config),
    pipelineShape: "medical-sop",
    roles: MEDICAL_ROLES,
    guardrails: buildMedicalGuardrails(),
  };
}
```
**Rule:** A team is DATA, not code (principles: team-abstraction). The hub branch returns the same `Team` shape with `memoryNamespace: "hub"`, default `pipelineShape: resolveEngineName(config)`, and `guardrails: undefined`.

### `bober chat hub` needs NO command change
**Source:** `src/cli/commands/chat.ts`, lines 27-46
```ts
.action(async (team?: string) => {
  ...
  const activeTeam = loadTeam(config, team);            // team === "hub"
  const client = createClient(providers.chat, config.chat?.endpoint ?? null,
    config.chat?.providerConfig, config.chat?.model, "chat");  // ← this becomes ChatSession.llm
  const session = new ChatSession({
    llm: client,
    projectRoot,
    sessionId: "default",
    memoryNamespace: activeTeam.memoryNamespace || undefined,  // "hub"
  });
```
**Rule:** Once `loadTeam(config, "hub")` returns a team, `bober chat hub` already threads `memoryNamespace: "hub"` into the session. The chat command is untouched. `this.llm` is the `createClient` chat client — handlers reuse it directly ("as elsewhere" in generatorNotes).

### Additive optional-param dispatch extension
**Source:** `src/chat/slash-commands.ts`, lines 137-141 (`/pause` case + `pauseHandler` fallback) — the exact precedent for adding a new handler additively.
```ts
    case "/pause": {
      const arg = trimmed.split(/\s+/)[1];
      if (!arg) return { handled: true, output: "Usage: /pause <runId>" };
      const output = pauseHandler ? await pauseHandler(arg) : "Pause is unavailable.";
      return { handled: true, output };
    }
```
**Rule:** New handler is the LAST optional param; case returns "Unavailable." when the handler is omitted. Every prior sprint (S4 tell, S5 pause/resume) added handlers this way — see the param JSDoc at slash-commands.ts:42-55.

### Namespace gating (session knows its team via `this.memoryNamespace`)
**Source:** `src/chat/chat-session.ts`, lines 102-103, 111
```ts
  /** Memory namespace for the active team; undefined means the default .bober/memory/ path. */
  private readonly memoryNamespace: string | undefined;
  ...
  this.memoryNamespace = opts.memoryNamespace || undefined;
```
**Rule:** Gate the new commands with `this.memoryNamespace === "hub"`. For any other team it returns an informative no-op string and NEVER calls `this.llm` (generatorNotes: "meaningful only in the hub namespace").

### Two-pass judge contract (what `rankFindings` needs)
**Source:** `src/hub/judge.ts`, lines 174-179
```ts
export async function rankFindings(
  findings: Finding[], scope: Scope, llm: LLMClient, now: Date,
): Promise<Finding[]>
```
**Rule:** Pass `this.llm` and a fresh `new Date()`. For `general`/`decision` scope it makes 1 relevance call + 4 lens calls per finding (so the test fake must script `relevant` + 4 lens JSON responses per finding). `filtered` scope is pure-JS (zero LLM) — not used by /priority or /decide.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `loadTeam` | `src/teams/registry.ts:35` | `(config, teamId?) => Team` | Resolve a team by id; add the `hub` branch here |
| `resolveRoleProviders` | `src/config/role-providers.ts` (imported registry.ts:9) | `(config) => RoleProviderMap` | Default provider map for a team |
| `resolveEngineName` | `src/orchestrator/workflow/selector.ts` (imported registry.ts:11) | `(config) => PipelineEngineName` | The **default** pipelineShape value |
| `dispatch` | `src/chat/slash-commands.ts:57` | `(input, roster, ...9 handlers) => Promise<SlashResult>` | The slash dispatcher to extend |
| `collectFindings` | `src/hub/collector.ts:16` | `(repoPaths, scope=HUB_SCOPE) => Finding[]` | Pool + dedup sibling findings (pure, no LLM) |
| `rankFindings` | `src/hub/judge.ts:174` | `(findings, scope, llm, now) => Promise<Finding[]>` | Two-pass hub judge (the ranking) |
| `renderPriorityMd` | `src/hub/priority-md.ts:34` | `(ranked, scopeLabel, now) => string` | Render priority.md markdown (pure) |
| `resolveSiblingRepos` | `src/hub/repo-resolver.ts:18` | `(projectRoot, configuredRepos?) => Promise<string[]>` | Discover kb-* siblings with a facts.db |
| `resolveOutVault` | `src/hub/hub-config.ts:26` | `(projectRoot) => Promise<string>` | Absolute kb-hub vault path |
| `priorityMdPath` | `src/hub/hub-config.ts:45` | `(outVault) => string` | `<outVault>/priority.md` |
| `parseScope` | `src/hub/scope.ts:39` | `(raw) => Scope` | Build a `Scope` union (never throws) |
| `HUB_SCOPE` | `src/hub/finding-source.ts:8` | `const = "hub"` | FactStore scope for findings |
| `runHubPriority` | `src/cli/commands/hub.ts:128` | `(findings, scope, llm, outVault, now) => Promise<void>` | CLI core — writes md AND prints to stdout. **Reference only**; chat handler returns a string, so replicate collect→rank→render rather than calling this (it prints to stdout + sets exitCode). |
| `fileExists` | `src/utils/fs.ts` (imported hub.ts:16) | `(path) => Promise<boolean>` | Guard the priority.md write |
| `createClient` | `src/providers/factory.ts` (imported chat.ts:17) | `(provider, endpoint, cfg, model, role) => LLMClient` | Already called in chat.ts → becomes `this.llm`. Do NOT re-call inside handlers. |

Utilities reviewed: `utils/`, `hub/`, `teams/`, `chat/`, `cli/commands/` — all relevant ones above.

---

## 4. Prior Sprint Output

### Sprint 1: Finding schema + FactStore source
**Created:** `src/hub/finding.ts` — exports `FindingSchema`, `type Finding` (id, domain, title, kind, urgency 1-5, severity 1-5, evidence[], tags[], status, optional dueBy). `src/hub/finding-source.ts` — exports `HUB_SCOPE = "hub"`, `FactStoreFindingSource`, `interface FindingSource`.
**Connection:** Test fixtures build `Finding` objects; `HUB_SCOPE` is passed to `collectFindings`.

### Sprint 2: Collector + repo resolver
**Created:** `src/hub/collector.ts` (`collectFindings`), `src/hub/repo-resolver.ts` (`resolveSiblingRepos`), `src/hub/scope.ts` (`parseScope`, `applyFilter`, `type Scope`).
**Connection:** Handlers call `resolveSiblingRepos(this.projectRoot)` → `collectFindings(siblings, HUB_SCOPE)`.

### Sprint 3: Judge
**Created:** `src/hub/judge.ts` (`rankFindings`), `src/hub/lenses.ts`.
**Connection:** Handlers call `rankFindings(findings, scope, this.llm, now)` — THE ranking.

### Sprint 4: Renderer + CLI cores + config
**Created:** `src/hub/priority-md.ts` (`renderPriorityMd`), `src/hub/hub-config.ts` (`resolveOutVault`, `priorityMdPath`), `src/cli/commands/hub.ts` (`runHubList`, `runHubPriority`, `registerHubCommand`).
**Connection:** Handlers render with `renderPriorityMd` + write to `priorityMdPath(resolveOutVault(...))`. `runHubPriority` (hub.ts:128) is the exact CLI analogue — the chat handler is the in-session, string-returning twin.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM + `.js` extensions** on every import (NodeNext) — principles.md:27.
- **`import type { ... }`** for type-only imports — `consistent-type-imports` enforced (principles.md:35). Use it for `Scope`, `Finding`, `LLMClient`.
- **Prefix unused params with `_`** (principles.md:36).
- **No synchronous fs** — use `node:fs/promises` (`writeFile`) (principles.md:42).
- **Tests collocated** `*.test.ts` next to source, **Vitest**, temp dirs not fs mocks (principles.md:20, 44).
- **Section comments** `// ── Name ──` box-drawing headers (principles.md:32). Existing hub/chat files all follow this.

### Architecture Decisions
No ADR file specific to this sprint under `.bober/architecture/`. The governing convention is **teams-as-data** (a team is a config/registry entry, not code) — embodied by `loadTeam` (registry.ts) and `buildMedicalTeam` (medical/team.ts). Hub owns the `Finding` schema (finding.ts:5-9: "Do NOT redefine Finding anywhere else").

### Other Docs
`bober chat [team]` is documented behaviour: optional positional team arg routes memory namespace (chat.ts:1-10). No command-surface change is needed for `bober chat hub`.

---

## 6. Testing Patterns

### Unit Test Pattern — driving slash dispatch through a ChatSession
**Source:** `src/chat/chat-session-steer.test.ts` (the canonical pattern for handleTurn slash tests)
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatSession } from "./chat-session.js";
import type { LLMClient, ChatParams, ChatResponse } from "../providers/types.js";

// ThrowingClient proves NO LLM call (slash-commands.test.ts:13-17 / steer:56-60)
class ThrowingClient implements LLMClient {
  async chat(_p: ChatParams): Promise<ChatResponse> {
    throw new Error("LLMClient must NOT be called");
  }
}

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-hub-chat-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
```
**Runner:** vitest · **Assertion:** `expect(...).toContain/.toBe` · **Mock:** injected fake `LLMClient` (no `vi.mock` for the LLM) + temp dirs · **File naming:** `*.test.ts` collocated.

### Dispatch-level fake-handler pattern (for slash-commands.test.ts)
**Source:** `src/chat/slash-commands.test.ts`, lines 199-219 (/approve handler test) — mirror for /priority + /decide:
```ts
it("/priority calls priorityHandler", async () => {
  const roster = new RosterReader(tmpDir);
  let called = false;
  const priorityHandler = async () => { called = true; return "1. Foo\n2. Bar"; };
  // positions 3-9 are undefined, 10 = priorityHandler
  const result = await dispatch("/priority", roster,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    priorityHandler);
  expect(called).toBe(true);
  if (result.handled && !result.exit) expect(result.output).toContain("1. Foo");
});

it("/priority without handler returns unavailable (back-compat 9-arg callers)", async () => {
  const roster = new RosterReader(tmpDir);
  const result = await dispatch("/priority", roster); // 2-arg legacy caller
  if (result.handled && !result.exit) expect(result.output).toBe("Priority is unavailable.");
});
```

### Seeding sibling stores for the offline /priority + /decide e2e (the critical test)
**Source:** `src/hub/collector.test.ts`, lines 32-48 (`seedRepo`) + `src/hub/judge.test.ts`, lines 10-20 (`ScriptedClient`). Combine them:
```ts
import { FactStore, factsDbPath, ensureFactsDir } from "../state/facts.js";
import { HUB_SCOPE } from "../hub/finding-source.js";

const T = "2026-06-28T00:00:00.000Z";
function findingJson(id: string, title: string): string {
  return JSON.stringify({ id, domain: "medical", title, kind: "action",
    urgency: 3, severity: 4, evidence: ["e"], surfacedAt: T, tags: ["x"], status: "open" });
}
async function seedRepo(repoRoot: string, entries: [string, string][]) {
  await ensureFactsDir(repoRoot);
  const store = new FactStore(factsDbPath(repoRoot));
  for (const [id, title] of entries) {
    store.insertFact({ scope: HUB_SCOPE, subject: id, predicate: "finding",
      value: findingJson(id, title), confidence: 1, sourceRunId: null, tValid: T, tCreated: T });
  }
  store.close();
}

// ScriptedClient: relevance + 4 lens responses per finding (general scope)
class ScriptedClient implements LLMClient {
  private idx = 0;
  constructor(private readonly responses: string[]) {}
  async chat(): Promise<ChatResponse> {
    const text = this.responses[Math.min(this.idx, this.responses.length - 1)] ?? "";
    this.idx += 1;
    return { text, toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}
```
**Wiring the e2e test (note projectRoot must be a SUBDIR so kb-* are siblings — repo-resolver.ts:37 scans `dirname(projectRoot)`):**
```ts
const projectRoot = join(tmpDir, "hub-root");
await mkdir(join(projectRoot, ".bober"), { recursive: true });
await seedRepo(join(tmpDir, "kb-a"), [["f-1", "Alpha"], ["f-2", "Beta"]]);
await mkdir(join(tmpDir, "kb-hub"), { recursive: true }); // so priority.md write succeeds

const llm = new ScriptedClient([
  '{"relevant":true}', '{"relevant":true}',                 // pass-1 for f-1, f-2
  '{"include":true,"score":9}','{"include":true,"score":9}', // f-1 lenses x4
  '{"include":true,"score":9}','{"include":true,"score":9}',
  '{"include":true,"score":3}','{"include":true,"score":3}', // f-2 lenses x4
  '{"include":true,"score":3}','{"include":true,"score":3}',
]);
const session = new ChatSession({ llm, projectRoot, sessionId: "t", memoryNamespace: "hub" });
const reply = await session.handleTurn("/priority");
expect(reply).toContain("1. Alpha");
expect(reply).toContain("2. Beta");
```
**Non-hub gate test (proves no LLM call + no-op):**
```ts
const session = new ChatSession({ llm: new ThrowingClient(), projectRoot, sessionId: "t" /* no memoryNamespace */ });
const reply = await session.handleTurn("/priority");
expect(reply).toContain("only available in the hub team"); // informative no-op, ThrowingClient never fired
```

### `bober chat hub` namespace resolution test (registry-level, sc-5-1)
**Source pattern:** `src/cli/commands/chat.test.ts`, lines 58-75
```ts
const { loadTeam } = await import("../../teams/registry.js");
const team = loadTeam(config, "hub");
expect(team.memoryNamespace).toBe("hub");
// ChatSession threads it:
const session = new ChatSession({ llm: fakeLLM, projectRoot: tmpDir, sessionId: "t",
  memoryNamespace: team.memoryNamespace || undefined });
expect(session).toBeDefined();
```
(`createDefaultConfig("test","greenfield")` from `../config/schema.js` is the standard config builder used in registry.test.ts:5.)

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/chat/chat-session.ts` | `dispatch` (slash-commands.ts) | medium | The 2 new dispatch params are appended; the existing 7-handler call gains 2 callbacks. Existing handler order unchanged. |
| `src/cli/commands/chat.ts` | `loadTeam` (registry.ts) | low | `loadTeam(config, "hub")` now resolves instead of throwing; non-hub teams unchanged. |
| `src/cli/commands/hub.ts` | `loadTeam` (registry.ts) | low | Calls `loadTeam(config, undefined)` only — hub branch never on its path. Byte-behaviour unchanged. |
| All `src/chat/chat-session-*.test.ts` | `ChatSession.handleTurn` | medium | Existing slash + NL paths must return identical output (the new dispatch args are appended, not reordered). |
| `src/chat/slash-commands.test.ts` | `dispatch` arity | medium | Existing positional callers (2–9 args) must still compile + return identical output — new params are optional and trailing. |
| `src/teams/registry.test.ts` | `loadTeam` | low | Existing programming/medical/declared-team/unknown-id tests unchanged. |

### Existing Tests That Must Still Pass
- `src/chat/slash-commands.test.ts` — tests every existing command via positional `dispatch(...)` calls (2–9 args). The trailing optional params keep all these byte-identical. **The /help-contains tests (lines 148-155, 221-229, 360-367, 433-440, 490-497, 527-549) assert `toContain` on existing commands — leaving HELP_TEXT untouched keeps them green.**
- `src/chat/chat-session-steer.test.ts`, `-spawn`, `-approval`, `-completion`, `chat-steer-e2e.test.ts` — drive `handleTurn` for /stop /pause /resume /tell + NL paths; must be unchanged.
- `src/teams/registry.test.ts` — programming/medical/declared/unknown-id resolution.
- `src/cli/commands/chat.test.ts` — team resolution + namespace routing.
- `src/hub/*.test.ts` — collector/judge/scope/priority-md/repo-resolver (the delegated functions); unaffected (no hub source files change).

### Features That Could Be Affected
- **Existing chat slash commands** (/runs /stop /careful /approve /reject /tell /pause /resume /help /exit) — share `dispatch` + `handleTurn`. Verify each returns its prior output (sc-5-4).
- **`bober chat` / `bober chat medical`** — share `loadTeam` + `ChatSession`. The default (non-hub) team path must be byte-identical (nonGoal #5); the gate ensures /priority and /decide no-op there.
- **`bober hub priority` / `bober hub decide` CLI** — share the delegated hub functions; unchanged (no edits to `src/hub/` or `src/cli/commands/hub.ts`).

### Recommended Regression Checks
1. `npm run build` — zero TS errors (sc-5-5; strict mode + `consistent-type-imports`).
2. `npx vitest run src/chat/slash-commands.test.ts src/chat/chat-session-steer.test.ts src/chat/chat-session-spawn.test.ts src/chat/chat-session-approval.test.ts src/chat/chat-session-completion.test.ts` — existing chat behaviour intact.
3. `npx vitest run src/teams/registry.test.ts src/cli/commands/chat.test.ts` — team resolution intact.
4. `npx vitest run src/chat/chat-session.test.ts src/chat/slash-commands.test.ts` — new hub tests pass.
5. `npx vitest run src/hub/` — delegated hub functions unaffected.

---

## 8. Implementation Sequence

1. **`src/teams/registry.ts`** — add the `if (teamId === "hub")` branch in `loadTeam` (after the medical branch, before `config.teams` lookup). Reuse in-file `DEFAULT_ROLES`, `resolveRoleProviders`, `resolveEngineName`.
   - Verify: add/extend `src/teams/registry.test.ts` → `loadTeam(cfg, "hub").memoryNamespace === "hub"` and `id === "hub"`; `npm run build` clean.
2. **`src/chat/slash-commands.ts`** — add `priorityHandler` + `decideHandler` as params 10 & 11; add `/priority` + `/decide` cases. Do NOT touch `HELP_TEXT` or existing cases.
   - Verify: existing slash-commands tests still pass (positional back-compat); build clean.
3. **`src/chat/chat-session.ts`** — add the hub imports; append the 2 callbacks to the `dispatch(...)` call (lines 201-211); add `handleHubPriority`, `handleHubDecide`, `rankAndRenderHub` private methods with the `this.memoryNamespace === "hub"` gate.
   - Verify: build clean; `this.llm` is used (not `createClient`); gate returns no-op for non-hub.
4. **`src/chat/slash-commands.test.ts`** — add dispatch tests: /priority + /decide call their handlers; return "unavailable" when omitted (back-compat); /decide parses the expr; legacy positional callers unchanged.
   - Verify: `npx vitest run src/chat/slash-commands.test.ts`.
5. **`src/chat/chat-session.test.ts`** (CREATE) — sc-5-1 namespace resolution; sc-5-2 /priority ranked summary (seeded siblings + ScriptedClient + kb-hub vault); sc-5-3 /decide X vs Y decision scope; non-hub gate (ThrowingClient proves no LLM); regression: an existing command (e.g. /help) via handleTurn returns its prior output.
   - Verify: `npx vitest run src/chat/chat-session.test.ts`.
6. **Run full verification** — `npm run build`, `npx vitest run` (or the targeted suites in §7), confirm zero TS errors + all green.

---

## 9. Pitfalls & Warnings

- **DO NOT modify `HELP_TEXT` (slash-commands.ts:17-31).** sc-5-4 lists `/help` among commands that MUST "return the same output they did before," and nonGoal #1 forbids altering any existing command's dispatch result. Adding `/priority`/`/decide` lines changes `/help` output → criterion failure. The new commands are hub-gated; they do not belong in the global help. (This BREAKS the prior-sprint habit of self-registering in HELP_TEXT — intentionally.)
- **DO NOT reorder or edit existing `dispatch` params or `switch` cases.** Append the 2 handlers as the LAST optional params; all positional callers (slash-commands.test.ts passes 2–9 args) must keep compiling and returning identical output.
- **Use `this.llm`, NOT `createClient`, inside the handlers.** `createClient` would open a real provider client and the offline tests (which inject a fake `LLMClient` via `ChatSession({ llm })`) could not intercept it. The chat command already built the client via `createClient` (chat.ts:33-39) → it is `this.llm`. (generatorNotes mentions createClient meaning "the same client built elsewhere", i.e. `this.llm`.)
- **Gate strictly on `this.memoryNamespace === "hub"`.** For any other team /priority and /decide must return an informative no-op and must NOT call `this.llm` (proven with `ThrowingClient`). This is the "no-op informative message when not the hub team" requirement.
- **`chat-session.ts` is large (531 lines) and central.** Touch only: (a) the import block, (b) the dispatch call at lines 201-211, (c) add the 3 new private methods near the other `handleX` methods. Leave the LLM path (lines 232-298) and all other handlers byte-identical.
- **Return a string; do not call `runHubPriority`.** `runHubPriority` (hub.ts:128) writes priority.md AND prints to stdout AND can set `process.exitCode=1` — none of which a chat handler wants. Replicate `collectFindings → rankFindings → renderPriorityMd` and build the return string.
- **priority.md write is best-effort.** In tests the kb-hub vault may be absent; guard the write with `fileExists(outVault)` (or try/catch) so a missing vault never breaks the chat turn or the test. The ranked summary is still returned.
- **Test projectRoot must be a SUBDIR of tmpDir.** `resolveSiblingRepos` scans `dirname(projectRoot)` for `kb-*` (repo-resolver.ts:37). Put `kb-a`, `kb-hub` as siblings of a `hub-root` projectRoot, exactly like collector.test.ts.
- **`.js` extensions + `import type`** on every new import (NodeNext + `consistent-type-imports`) — omitting either is a hard build/lint gate failure (principles.md:27,35).
- **Scripted LLM call budget for general scope:** 1 relevance + 4 lens calls PER finding (judge.ts:104-131, 191-210). Script enough responses or the ScriptedClient repeats its last entry (judge.test.ts:16) — keep that in mind for deterministic ranking assertions.
