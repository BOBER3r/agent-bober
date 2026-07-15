# Sprint Briefing: Free-text guidance injection — /tell <runId> <text> + pipeline read point

**Contract:** sprint-spec-20260615-chat-interrupt-approve-steer-4
**Generated:** 2026-06-15T17:30:00Z

---

## 0. Orientation (read first)

Goal: a runId-keyed guidance channel `.bober/runs/<runId>/guidance.jsonl` appended by `/tell <runId> <text>` (and NL "tell run X to …"), plus ONE additive pipeline read point that drains pending guidance for the active runId at a checkpoint boundary and injects it as extra context into the next agent handoff. With NO guidance, the pipeline is byte-for-byte unchanged.

Four trickiest things (do these carefully):
- (a) **Smallest provably-additive pipeline insertion**, guarded so no-guidance is a deep-equal no-op (sc-4-7).
- (b) **Atomic drain marks-consumed** so a redrain returns `[]` (sc-4-5).
- (c) **runId path-traversal rejection BEFORE any write** (sc-4-4 security NFR). NO existing helper exists — you must write one.
- (d) **Stubbed-agent test harness** for the pipeline boundary (sc-4-6). Prefer testing `runSprintCycle`'s guidance drain at unit granularity rather than driving full `runTsPipeline` (it calls real LLMs).

KEY DECISION on the pipeline insertion point: `runSprintCycle` (pipeline.ts:134) already receives `pipelineRunId` as its 7th parameter (pipeline.ts:141), resolves it to `sprintRunId` (pipeline.ts:149), and builds the generator handoff `compactedHandoff` at pipeline.ts:265. The smallest additive site is INSIDE `runSprintCycle`, just before the generator invocation (pipeline.ts:286), draining `drainGuidance(projectRoot, pipelineRunId)` and appending to the handoff's `issues` (or `instructions`) ONLY when non-empty and runId present. This avoids touching `runTsPipeline` / `runPipeline` at all.

---

## 1. Target Files

### src/state/guidance.ts (create)

**Directory pattern:** `src/state/` uses kebab-case filenames, named `export async function`, `node:fs/promises`, atomic temp+rename writes, `ensureDir` from `./helpers.js`. Mirror `run-state.ts` and `approval-state.ts`.

**Most similar existing file:** `src/state/run-state.ts` (path helpers + atomic write) and `src/state/approval-state.ts` (JSONL-ish list/read). Follow `run-state.ts`'s `runDir` shape exactly so the pipeline reads the SAME directory.

**Path helper to MIRROR — `run-state.ts:19-29`:**
```ts
function runsRoot(projectRoot: string): string {
  return join(projectRoot, ".bober", "runs");
}
function runDir(projectRoot: string, runId: string): string {
  return join(runsRoot(projectRoot), runId);
}
function statePath(projectRoot: string, runId: string): string {
  return join(runDir(projectRoot, runId), "state.json");
}
```
Your `guidancePath` = `join(runDir(projectRoot, runId), "guidance.jsonl")`.

**Atomic write to MIRROR — `run-state.ts:41-53`:**
```ts
export async function writeRunState(projectRoot: string, state: RunState): Promise<void> {
  await ensureDir(runDir(projectRoot, state.runId));
  const filePath = statePath(projectRoot, state.runId);
  const rnd = randomBytes(4).toString("hex");
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${rnd}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  await rename(tmp, filePath);
}
```
Imports it uses: `import { readFile, writeFile, readdir, rename } from "node:fs/promises";`, `import { randomBytes } from "node:crypto";`, `import { join } from "node:path";`, `import { ensureDir } from "./helpers.js";` (run-state.ts:10-14).

**Functions to implement (per generatorNotes + sc-4-4/4-5):**
- `safeSegment(runId: string): boolean` (or inline guard) — reject empty, reject any string containing `/`, `\`, or `..`, reject path-absolute. Use this BEFORE any path build/write. There is NO existing helper (verified: grep for `safeSegment`/`traversal`/`sanitize` returns nothing in `src/state/`). Pattern note: `src/state/memory.ts:24` explicitly says "path-traversal sanitization is needed here (schema already guards…)" — i.e. the project guards at the edge, so YOU must guard runId here since it comes from chat free text.
- `hasRunDir(projectRoot, runId): Promise<boolean>` — `access(runDir, R_OK)` style true/false (mirror `approval-state.ts pendingExists` at approval-state.ts:145-155). Use for the unknown-run guard.
- `appendGuidance(projectRoot, runId, text): Promise<void>` — validate runId via `safeSegment` FIRST (throw on bad); then guard `hasRunDir` (caller may also guard, but appendGuidance must not create an outside-`.bober/runs` path); `ensureDir(runDir)`; append one line `JSON.stringify({ ts, text, consumed: false })` to guidance.jsonl. Append can be `appendFile`, or read+rewrite-atomic — keep it simple but never write a partial line.
- `drainGuidance(projectRoot, runId): Promise<string[]>` — read all lines, parse each JSON, collect `text` of entries with `consumed !== true`, then atomically rewrite the file with ALL entries marked `consumed:true` (temp+rename per run-state.ts:46-52). Return the drained texts in order. Missing file → return `[]` (never throw — mirror `readRunState`'s try/catch at run-state.ts:62-67). Second drain returns `[]`.

**Test file:** `src/state/guidance.test.ts` (create) — mkdtemp temp dir fixture (mirror `run-state.test.ts:18-26`).

---

### src/chat/chat-session.ts (modify)

**Relevant sections:**

Dispatch call passes optional handlers (lines 186-193) — ADD a `tellHandler`:
```ts
const slashResult = await dispatch(
  input,
  this.roster,
  (runId) => this.handleStop(runId),
  (arg) => this.handleCareful(arg),
  (id) => this.handleApprove(id),
  (id, fb) => this.handleReject(id, fb),
  // NEW: (runId, text) => this.handleTell(runId, text),
);
```

Classify routing block (lines 227-255) — ADD a `tell` branch (mirror the `steer`/`approve` branches at 236-251):
```ts
} else if (action.action === "approve" || action.action === "reject") {
  ... // existing
} else {
  reply = `Unrecognised action...`;  // line 254
}
```
Insert `else if (action.action === "tell") { reply = await this.handleTell(action.runId, action.text); }` BEFORE the final `else`.

`handleStop` is the mirror for `handleTell` (lines 282-292) — it resolves against the disk roster and returns a clear error if not found:
```ts
private async handleStop(runId: string): Promise<string> {
  const states = await this.roster.read();
  const target = states.find((s) => s.runId === runId && s.status === "running");
  if (!target) return `No such running run: ${runId}`;
  ... 
}
```
**`handleTell` should:** read roster (`this.roster.read()`); guard the run exists (`states.find(s => s.runId === runId)` OR `hasRunDir` — prefer roster for parity with handleStop; note guidance can target ANY run per nonGoals, not just running, so DON'T filter on status==="running"); unknown → `return \`No such run: ${runId}\``; else `await appendGuidance(this.projectRoot, runId, text)` and `return \`Queued guidance for run ${runId}.\``. Wrap appendGuidance so a thrown path-traversal error returns a clear message and writes nothing.

**Imports this file uses (add):** `import { appendGuidance, hasRunDir } from "../state/guidance.js";` (alongside existing `import { writeRunState } from "../state/run-state.js";` at chat-session.ts:21).

**Imported by:** `src/cli/commands/chat.ts` (constructs ChatSession). Test files: chat-session-steer.test.ts, chat-session-approval.test.ts, chat-session-spawn.test.ts, chat-session-completion.test.ts.

**Test file:** `src/chat/chat-session-steer.test.ts` exists (this sprint adds a guidance test there per estimatedFiles, OR a new block).

---

### src/chat/slash-commands.ts (modify)

**Add a `/tell` case** (mirror `/reject` at lines 100-110 which captures the remainder of the line as free text):
```ts
case "/reject": {
  const parts = trimmed.split(/\s+/);
  const id = parts[1];
  if (!id) return { handled: true, output: "Usage: /reject <checkpointId> [feedback]" };
  const feedback = trimmed.replace(/^\/reject\s+\S+\s*/, "");
  const output = rejectHandler ? await rejectHandler(id, feedback) : "Reject is unavailable.";
  return { handled: true, output };
}
```
Your `/tell`: `const runId = parts[1]; if (!runId) return Usage: /tell <runId> <text>;` then `const text = trimmed.replace(/^\/tell\s+\S+\s*/, "");` then `if (!text) return Usage...;` then `tellHandler ? await tellHandler(runId, text) : "Tell is unavailable."`.

**Add `tellHandler` param** to `dispatch` (signature lines 48-55), as the LAST optional param to preserve back-compat:
```ts
export async function dispatch(
  input: string,
  roster: RosterReader,
  stopHandler?: (runId: string) => Promise<string>,
  carefulHandler?: (arg: string | undefined) => Promise<string>,
  approveHandler?: (id: string) => Promise<string>,
  rejectHandler?: (id: string, feedback: string) => Promise<string>,
  // NEW:
  tellHandler?: (runId: string, text: string) => Promise<string>,
): Promise<SlashResult> {
```

**Update HELP_TEXT** (lines 17-28) — add a `/tell` line (sc-4-8 asserts `/help` lists `/tell`):
```ts
"  /reject <id> [why] — Reject a pending checkpoint with optional feedback",
"  /tell <runId> <text> — Queue free-text guidance for a run (applied at next boundary)",
"  /help              — Show this help message",
```

**Imported by:** chat-session.ts:14 (`import { dispatch }`), slash-commands.test.ts.

---

### src/chat/turn-classifier.ts (modify)

**Add `tell` to the action union** (lines 11-17):
```ts
export type ClassifierAction =
  | { action: "answer" }
  | { action: "spawn"; task: string }
  | { action: "steer"; op: "inspect" }
  | { action: "steer"; op: "stop"; runId: string }
  | { action: "approve"; checkpointId?: string }
  | { action: "reject"; checkpointId?: string; feedback?: string }
  | { action: "tell"; runId: string; text: string };   // NEW
```

**Add to the Zod discriminated union** (lines 21-38):
```ts
z.object({ action: z.literal("tell"), runId: z.string(), text: z.string() }),
```

**Add to `parseClassifierAction` reconstruction** (after the reject block at lines 95-101):
```ts
if (data.action === "tell") {
  return { action: "tell", runId: data.runId, text: data.text };
}
```

**Add to the system prompt** options list (lines 130-137), mirroring the approve/reject lines:
```ts
'  {"action":"tell","runId":"<id>","text":"<instruction>"}  — queue free-text guidance for a run',
```

**Imported by:** chat-session.ts:12, turn-classifier.test.ts.

---

### src/orchestrator/pipeline.ts (modify — PROTECTED, ADDITIVE ONLY)

**THE INVARIANT (lines 568-572) — do NOT disturb phase order:**
```ts
/**
 * Internal implementation: the original TypeScript pipeline body.
 * Extracted so TsPipelineEngine can wrap it without an import cycle.
 * Do NOT change the algorithm, phase order, or .bober/ write behaviour here.
 */
export async function runTsPipeline(
```
This comment block is the "pipeline.ts:571 invariant." It applies to `runTsPipeline`. **You do NOT need to touch `runTsPipeline` at all** — insert inside `runSprintCycle` instead.

**Smallest additive insertion site — inside `runSprintCycle`, between the handoff build (line 265) and the generator invocation (line 286):**

Current code (lines 264-290):
```ts
    // Compact older sprint history if needed
    const compactedHandoff = summarizeOlderSprints(completedSummaryHandoff, 3);

    // ── Generate ───────────────────────────────────────────────
    await runWithAudit({
      projectRoot, runId: sprintRunId, checkpointId: "pre-generator",
      mechanism: configuredMechanismName, iteration,
      fn: () => getCheckpointMechanismFor("pre-generator", config, "noop").request("pre-generator", { contract: currentContract, iteration, handoff: compactedHandoff }),
    });
    logger.phase(`Sprint ${currentContract.contractId} - Generate (Round ${iteration})`);
    ...
    const generatorResult = await runGenerator(
      compactedHandoff,
      projectRoot,
      config,
    );
```

**ADDITIVE insertion (place it right AFTER line 265, before the pre-generator runWithAudit OR right before `runGenerator`):**
```ts
    // ── Phase 2 guidance injection (additive) ──────────────────
    // Drain any queued free-text guidance for the active run and append it to
    // the handoff. With no guidance (or no runId) this is a no-op and the
    // handoff is byte-for-byte unchanged (sc-4-7 invariant).
    let injectedHandoff = compactedHandoff;
    if (pipelineRunId) {
      const guidance = await drainGuidance(projectRoot, pipelineRunId);
      if (guidance.length > 0) {
        injectedHandoff = {
          ...compactedHandoff,
          issues: [...compactedHandoff.issues, ...guidance.map((g) => `Human guidance: ${g}`)],
        };
      }
    }
```
Then pass `injectedHandoff` to `runGenerator(injectedHandoff, ...)` at line 286. **IMPORTANT:** the `pre-generator` runWithAudit at line 274 also passes `handoff: compactedHandoff` — decide whether to feed it the injected one too. Minimal-change choice: keep the audit passing `compactedHandoff` (the audit record is advisory) OR pass `injectedHandoff` for consistency. Either is additive; document which.

Why `issues` (not `instructions`): `issues` is a `string[]` (context-handoff.ts:52) consumed by `runGenerator` at generator-agent.ts:82 (`handoff.issues.join("\n\n")` under a "# Previous Issues to Fix" header). Appending is a pure spread; with empty guidance the array is identical → deep-equal no-op. `instructions` is a single string (context-handoff.ts:49) — appending requires string concat and is harder to make a clean no-op; prefer `issues`.

**Import to add** (alongside the existing state imports at pipeline.ts:52-59):
```ts
import { drainGuidance } from "../state/guidance.js";
```

**Test file:** `src/orchestrator/pipeline.guidance.test.ts` (create). The existing pipeline test is `src/orchestrator/pipeline-run-id.test.ts` (pure-logic, no LLM) — follow its "extract the pure mapping logic" style if driving full `runSprintCycle` is too heavy. See §6.

---

## 2. Patterns to Follow

### Atomic temp-file + rename write
**Source:** `src/state/run-state.ts`, lines 41-52
```ts
const rnd = randomBytes(4).toString("hex");
const tmp = `${filePath}.${process.pid}.${Date.now()}.${rnd}.tmp`;
await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
await rename(tmp, filePath);
```
**Rule:** Every guidance.jsonl rewrite (the drain) uses temp+rename so a crash never leaves a partial file.

### Never-throw read of an optional file
**Source:** `src/state/run-state.ts`, lines 61-68
```ts
export async function readRunState(projectRoot, runId): Promise<RunState | null> {
  try { const raw = await readFile(statePath(projectRoot, runId), "utf-8"); return JSON.parse(raw) as RunState; }
  catch { return null; }
}
```
**Rule:** `drainGuidance` on a missing file must return `[]`, not throw (the pipeline calls it on every sprint, most runs have no guidance).

### Existence guard via access()
**Source:** `src/state/approval-state.ts`, lines 145-155
```ts
export async function pendingExists(projectRoot, id): Promise<boolean> {
  try { await access(pendingPath(projectRoot, id), constants.R_OK); return true; }
  catch { return false; }
}
```
**Rule:** Mirror this for `hasRunDir` (access the run dir).

### Optional-handler dispatch + back-compat
**Source:** `src/chat/slash-commands.ts`, lines 100-110 (the `/reject` case)
**Rule:** New `/tell` handler is the LAST optional `dispatch` param; when omitted, `/tell` returns "Tell is unavailable." so all existing N-arg callers keep compiling (verified back-compat tests at slash-commands.test.ts:157-175, 295-304).

### Free-text remainder capture
**Source:** `src/chat/slash-commands.ts`, line 105
```ts
const feedback = trimmed.replace(/^\/reject\s+\S+\s*/, "");
```
**Rule:** `/tell <runId> <text…>` captures everything after the runId as the guidance text with `trimmed.replace(/^\/tell\s+\S+\s*/, "")`.

### Loose-JSON classifier action + reconstruction
**Source:** `src/chat/turn-classifier.ts`, lines 92-101 (approve/reject reconstruction) and 21-38 (Zod union)
**Rule:** Add `tell` as a discriminated-union member with required `runId`+`text`; reconstruct explicitly in `parseClassifierAction`; any parse failure already falls through to `FALLBACK = {action:"answer"}` (line 40, 103-106) — no throw.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `ensureDir` | `src/state/helpers.ts:6` | `(dirPath: string): Promise<void>` | mkdir recursive; call before every write |
| `writeRunState` (atomic pattern) | `src/state/run-state.ts:41` | `(projectRoot, state): Promise<void>` | Reference impl for temp+rename atomic write |
| `readRunState` (never-throw read) | `src/state/run-state.ts:61` | `(projectRoot, runId): Promise<RunState\|null>` | Reference impl for try/catch optional read |
| `pendingExists` (access guard) | `src/state/approval-state.ts:145` | `(projectRoot, id): Promise<boolean>` | Reference impl for `hasRunDir` |
| `RosterReader.read` | `src/chat/roster-reader.ts:22` | `(): Promise<RunState[]>` | List known runs for the unknown-run guard (mirrors handleStop) |
| `dispatch` | `src/chat/slash-commands.ts:48` | `(input, roster, …handlers?): Promise<SlashResult>` | Slash dispatcher; add /tell + tellHandler param |
| `createHandoff` / `summarizeOlderSprints` | `src/orchestrator/context-handoff.ts:85,153` | builds/compacts `ContextHandoff` | The handoff object you inject guidance into (`issues: string[]`) |
| `runGenerator` | `src/orchestrator/generator-agent.ts:40` | `(handoff, projectRoot, config)` | Consumes `handoff.issues` (generator-agent.ts:82); injection target |

**Utilities reviewed:** `src/state/` (helpers, run-state, approval-state, memory), `src/chat/` (roster-reader, slash-commands). NO existing safe-segment / path-traversal helper exists — `safeSegment` must be written in guidance.ts (verified by grep; `src/state/memory.ts:24` notes sanitization is left to the edge).

---

## 4. Prior Sprint Output

### Sprint 1 (14c2be6): RunState grammar + careful + RunSpawner careful spawn + run.ts --run-id
**Connection:** `run.ts:181-182` threads `opts.runId` into `runPipeline`; that flows to `runTsPipeline(opts)` (pipeline.ts:577) → `pipelineRunId` (pipeline.ts:585) → `runSprintCycle(…, pipelineRunId)` (pipeline.ts:897 call / pipeline.ts:141 param) → `sprintRunId` (pipeline.ts:149). This is the runId your drain keys on. `RunSpawner.spawn` (chat) creates the run state under `.bober/runs/<runId>/` — same dir your guidance.jsonl lives in.

### Sprint 2 (67495fc): ApprovalReader, RunState reflection, roster waiting=<gate>
**Connection:** establishes the `RosterReader.read()`→find-by-runId pattern reused for the `/tell` unknown-run guard (chat-session.ts:154, 284).

### Sprint 3 (fb4b787): /approve, /reject, NL classifier intents, handleApprove/handleReject
**Created/extended:** the optional-handler dispatch params (slash-commands.ts:53-54), the classifier action members + reconstruction (turn-classifier.ts:32-37, 92-101), the chat-session classify-branch routing (chat-session.ts:243-251), and the HELP_TEXT entries (slash-commands.ts:22-23). **Mirror ALL of these for `/tell`.** This is the closest template — copy its shape exactly.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` found. Conventions enforced by the codebase (cited inline above): NodeNext ESM `.js` import extensions, `node:fs/promises` only, atomic temp+rename writes, collocated `*.test.ts` with `mkdtemp` temp-dir fixtures (no fs mocks), Zod `jsonObjectMode` loose-JSON classifier, never-throw reads of optional files.

### Architecture Decisions
`.bober/architecture/` exists (git status) but contains prior-plan ADRs; none are guidance-channel-specific. The pipeline.ts header references ADR-9 (preflight context injection, pipeline.ts:2) — unrelated; do not touch preflight.

### Other Docs
Contract `generatorNotes` + `evaluatorNotes` (in the .json) are authoritative and cited throughout this briefing. The assumptions block (contract lines 75-79) confirms: guidance.jsonl is append-only one-JSON-per-line `{ts, text, consumed?}`; drain rewrites atomically; active runId reaches the pipeline via `opts.runId` / `pipelineRunId`.

---

## 6. Testing Patterns

### Unit Test Pattern — temp dir fixture
**Source:** `src/state/run-state.test.ts`, lines 8-44
```ts
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-guidance-test-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
```
**Runner:** vitest. **Assertion:** `expect`. **Mocks:** none — real temp dirs. **File naming:** collocated `*.test.ts`. **Location:** co-located.

**guidance.test.ts must cover (sc-4-4, sc-4-5):**
- `appendGuidance` then read guidance.jsonl → assert one `{ts, text, consumed:false}` line.
- unknown run (no run dir) via `handleTell`/`hasRunDir` → assert no file written + clear error (test the guard).
- `appendGuidance(tmpDir, "../evil", "x")` → assert it REJECTS (throws/returns error) and writes NOTHING outside `.bober/runs` (e.g. assert no file at `join(tmpDir, "..", "evil")`). Also test `runId` containing `/`.
- append two entries → `drainGuidance` returns both texts in order → `drainGuidance` again returns `[]`; assert the file's entries are all `consumed:true`.

### Pipeline boundary test (sc-4-6 / sc-4-7) — the trickiest
**Source pattern:** `src/orchestrator/pipeline-run-id.test.ts:1-13` extracts pure logic instead of driving real LLMs. Driving full `runSprintCycle` invokes `runCurator`/`runGenerator`/`runEvaluatorAgent` (real agents) — too heavy. **Two viable approaches:**

1. **Unit-test the injection logic directly** (recommended, mirrors pipeline-run-id.test.ts): seed guidance via `appendGuidance(tmpDir, "R", "prefer Zod")`, call `drainGuidance(tmpDir, "R")`, build a minimal `ContextHandoff` (use `createHandoff` from context-handoff.ts:85 with a stub `ProjectContext`/`PlanSpec`), apply the SAME spread the pipeline applies, and assert the guidance string lands in `handoff.issues`. For sc-4-7: with NO guidance file, `drainGuidance` returns `[]`, the handoff is spread-unchanged → `expect(injected).toEqual(original)` (deep-equal no-op).

2. **Stubbed-agent integration** (if exercising `runSprintCycle`): inject a config with `curator.enabled:false` and a stub generator. NOTE `runGenerator` is a module function, not injected — there is no clean DI seam, so approach (1) is strongly preferred. If you must, factor the injection into a tiny exported helper `injectGuidance(handoff, guidance): ContextHandoff` in pipeline.ts (or guidance.ts) and unit-test THAT helper — it keeps the pipeline edit a one-liner and gives a clean deep-equal target.

**Recommended:** extract `export function injectGuidanceIntoHandoff(handoff: ContextHandoff, guidance: string[]): ContextHandoff` (pure, returns same ref/value when guidance empty) — test it for both sc-4-6 (non-empty surfaces into `issues`) and sc-4-7 (`expect(injectGuidanceIntoHandoff(h, [])).toEqual(h)`).

### Chat handler NL-write test (sc-4-8)
**Source:** `src/chat/chat-session-steer.test.ts:32-39` (scripted LLM returning a fixed classifier JSON) + chat-session-approval.test.ts:41-58.
```ts
function makeTellLLM(runId: string, text: string): LLMClient {
  return { chat: async () => ({
    text: JSON.stringify({ action: "tell", runId, text }),
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  }) } as unknown as LLMClient;
}
```
Seed a run (write a RunState via `writeRunState` so the roster knows it — see steer test lines 162-171), feed `session.handleTurn("tell run R to prefer Zod")`, assert guidance.jsonl has the entry. Add a `/help` assertion that output contains `/tell` (mirror slash-commands.test.ts:148-155, 221-229).

### E2E
Not applicable — no Playwright config for this CLI sprint.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/commands/chat.ts` | constructs `ChatSession` | low | Constructor signature unchanged (only internal handler added) |
| `src/chat/slash-commands.ts` callers (chat-session.ts:14, slash-commands.test.ts) | `dispatch` signature | medium | New `tellHandler` is the LAST optional param → all existing 2-6-arg calls still compile. Back-compat tests at slash-commands.test.ts:157-175,295-304 assert this. |
| `src/chat/turn-classifier.ts` consumers (chat-session.ts:223) | `ClassifierAction` union | medium | Adding a union member is additive; existing branches unaffected. The chat-session switch must handle `tell` or fall to the `else` (line 252) — add the branch. |
| `src/orchestrator/pipeline.ts` → `runTsPipeline` / `runPipeline` | unchanged | HIGH (protected) | The :571 invariant. Do NOT edit `runTsPipeline`. Only `runSprintCycle` gets the additive drain. Diff review must show zero phase-order change. |
| `src/orchestrator/pipeline.ts` → TsPipelineEngine wrapper (workflow/selector.js) | `runTsPipeline` body | high | Untouched — the drain lives in `runSprintCycle`, which the engine already calls transitively. |

### Existing Tests That Must Still Pass
- `src/orchestrator/pipeline-run-id.test.ts` — tests runId resolution + RunCommandOptions.runId; your edits don't touch that logic → must stay green.
- `src/chat/slash-commands.test.ts` — back-compat N-arg dispatch tests (157-175, 295-304) + `/help` content tests (148-155, 221-229). Adding `/tell` and a 7th param must not break these. The `/help` tests assert substrings; new lines are additive.
- `src/chat/turn-classifier.test.ts` — existing answer/spawn/approve/reject parses (25-133) must still pass after adding the `tell` union member.
- `src/chat/chat-session-steer.test.ts`, `chat-session-approval.test.ts`, `chat-session-spawn.test.ts`, `chat-session-completion.test.ts` — exercise `handleTurn`; the new `tell` branch must not alter existing answer/spawn/steer/approve routing.
- `src/state/run-state.test.ts`, `approval-state.test.ts` — unaffected (you add a new file, don't edit these).

### Features That Could Be Affected
- **Sprint 3 approve/reject (same files):** chat-session.ts classify routing, slash-commands dispatch, turn-classifier union. Verify approve/reject still route after the `tell` branch is added (don't reorder the `else if` so approve/reject still match first).
- **Pipeline sprint cycle (all runs):** every sprint cycle now calls `drainGuidance`. For runs with no guidance file it must be a zero-cost no-op (`[]`, no handoff change). This is the core regression risk — sc-4-7 guards it.

### Recommended Regression Checks
1. `npm run build` — zero TS errors (sc-4-1).
2. `npm run typecheck` — strict mode clean (sc-4-2).
3. `npm run test` — full suite green, incl. pipeline-run-id, slash-commands, turn-classifier, all chat-session-*, run-state, approval-state (sc-4-3).
4. Targeted: `npx vitest run src/state/guidance.test.ts src/orchestrator/pipeline.guidance.test.ts src/chat/slash-commands.test.ts src/chat/turn-classifier.test.ts src/chat/chat-session-steer.test.ts`
5. Manual diff review of `src/orchestrator/pipeline.ts`: confirm ONLY the additive guidance block + one import were added; `runTsPipeline` and phase order untouched.

---

## 8. Implementation Sequence

1. **src/state/guidance.ts** — types-first then helpers: `safeSegment` guard → `runDir`/`guidancePath` helpers (mirror run-state.ts:19-25) → `hasRunDir` (mirror approval-state.ts:145) → `appendGuidance` (validate FIRST, ensureDir, append line) → `drainGuidance` (read, filter unconsumed, atomic rewrite all consumed, return texts).
   - Verify: file imports compile; no dependency on chat or pipeline (pure state layer).
2. **src/state/guidance.test.ts** — append/read, unknown-run no-op, path-traversal rejection, drain-then-redrain.
   - Verify: `npx vitest run src/state/guidance.test.ts` green.
3. **src/orchestrator/pipeline.ts** — add `import { drainGuidance } from "../state/guidance.js";` + (recommended) `injectGuidanceIntoHandoff` helper + the single commented "Phase 2 guidance injection (additive)" block before `runGenerator` (line 286), guarded on `pipelineRunId` and non-empty guidance. Pass `injectedHandoff` to `runGenerator`.
   - Verify: `npm run typecheck` clean; diff shows zero phase-order change.
4. **src/orchestrator/pipeline.guidance.test.ts** — sc-4-6 (seed guidance → drained text surfaces in `issues`) and sc-4-7 (no guidance → deep-equal no-op via `injectGuidanceIntoHandoff(h, [])` toEqual `h`).
   - Verify: both tests green; existing pipeline-run-id.test.ts still green.
5. **src/chat/turn-classifier.ts** — add `tell` union member, Zod object, reconstruction, system-prompt line.
   - Verify: turn-classifier.test.ts green; add a `tell` parse test.
6. **src/chat/slash-commands.ts** — add `tellHandler` param (last), `/tell` case, HELP_TEXT line.
   - Verify: slash-commands.test.ts green; add `/tell` dispatch + `/help` assertion tests.
7. **src/chat/chat-session.ts** — add `handleTell` (mirror handleStop), wire `tellHandler` into the `dispatch(...)` call, add the `tell` classify branch, import `appendGuidance`/`hasRunDir`.
   - Verify: chat-session-* tests green; add the sc-4-8 NL-write test.
8. **Run full verification** — `npm run build`, `npm run typecheck`, `npm run test`.

---

## 9. Pitfalls & Warnings

- **Do NOT edit `runTsPipeline` or `runPipeline`** (pipeline.ts:573, 976). The protected :571 invariant applies there. The drain belongs in `runSprintCycle` (pipeline.ts:134), which the engine already calls — that is provably additive and keeps phase order.
- **Inject into `issues` (string[]), not `instructions` (string).** Empty-guidance spread of an array is a clean deep-equal no-op (sc-4-7); concatenating a string is not. `issues` is consumed by the generator (generator-agent.ts:82).
- **Guard on `pipelineRunId` truthiness AND `guidance.length > 0`** before mutating the handoff. With either falsy, pass the original `compactedHandoff` reference so no-guidance is byte-for-byte identical.
- **Validate runId BEFORE building any path** (sc-4-4). `safeSegment` must run first in `appendGuidance`; reject `..`, `/`, `\`, empty, and absolute. No existing helper exists — write it; `join(root, ".bober", "runs", "../evil")` WOULD escape, so the check is load-bearing security, not cosmetic.
- **`drainGuidance` must never throw on a missing file** — it runs every sprint cycle. Return `[]` (mirror readRunState's try/catch). A throw here would break every pipeline run that has no guidance.
- **Drain must mark consumed atomically** (temp+rename), else a redrain re-injects the same guidance (sc-4-5 fails). Filter on `consumed !== true` and rewrite ALL lines as consumed.
- **`tellHandler` is the LAST `dispatch` param.** Inserting it earlier shifts positional args and breaks every existing caller + back-compat test (slash-commands.test.ts:157-175,295-304).
- **`handleTell` must NOT filter on `status === "running"`** (unlike handleStop). Guidance can be queued for any known run (contract nonGoals line 68); only the existence check matters, drained only at executing boundaries.
- **Add the `tell` classify branch BEFORE the final `else`** (chat-session.ts:252) and AFTER approve/reject so existing routing order is preserved.
- **`.bober/runs/<id>/guidance.jsonl` shares the dir with `state.json`.** Use the SAME `runDir` shape as run-state.ts so the pipeline and chat agree on the path. Do not invent a parallel directory.
