# Sprint Briefing: Hygiene, docs, and end-to-end verification

**Contract:** sprint-spec-20260615-chat-interrupt-approve-steer-6
**Generated:** 2026-06-15T17:30:00Z

> Integration + polish finale for Phase 2 (chat interrupt/approve/steer). Three behaviors:
> (1) best-effort cleanup of stale markers + RunState fields when a run goes terminal,
> (2) full /help set + docs, (3) an end-to-end test driving the whole loop offline.
> Minimal new abstraction — ONE new file (`steer-cleanup.ts`) + one hook line + docs + 2 tests.
> **HELP_TEXT already lists the full command set** (verified below) — sc-6-6 is just a test.

---

## 1. Target Files

### src/chat/steer-cleanup.ts (create)

**Directory pattern:** `src/chat/*.ts` — kebab-case filenames, named exports, `.js` import suffixes, leading `// ── name.ts ──` banner comment. No default exports anywhere in `src/chat/`.

**Most similar existing file (for the best-effort-unlink + path-helper shape):** `src/state/pause.ts` (`clearPaused` at :78-81 is the canonical best-effort unlink) and `src/state/approval-state.ts` (`deletePending` at :138-140). The cleanup helper is a thin orchestration over already-best-effort primitives.

**What it must do (from contract generatorNotes + assumptions):** Given `(projectRoot, runId)`, when a run R goes terminal:
1. Delete R's pending approval marker(s) in `.bober/approvals/` — found by **correlating `runId`** (markers are checkpointId-keyed, see Pitfalls §9).
2. Unlink `.bober/runs/<runId>/guidance.jsonl` and `.bober/runs/<runId>/paused.json` (best-effort, tolerate ENOENT).
3. Clear the chat-owned RunState pending/paused fields (`pendingCheckpointId`, `pendingPrompt`, `pendingSince`, `pausedAt`) via `writeRunState`.
4. **Never throw** — every step wrapped so a failure cannot break a chat turn.

**Structure template (skeleton — follow pause.ts banner + approval-state best-effort style):**
```ts
// ── steer-cleanup.ts ──────────────────────────────────────────────────
//
// Best-effort hygiene: when the chat process observes a run reach a terminal
// status (completed/aborted), remove its stale pending approval marker(s),
// guidance.jsonl, and paused.json, and clear RunState pending/paused fields.
// NEVER throws — a cleanup failure must not break a chat turn.

import { unlink } from "node:fs/promises";
import { join } from "node:path";

import { deletePending, listPending } from "../state/approval-state.js";
import { readRunState, writeRunState } from "../state/run-state.js";
import { safeSegment } from "../state/guidance.js";

/**
 * Remove all disk + RunState steer artifacts for a run that has gone terminal.
 * Best-effort: each step is individually guarded; the function never throws.
 */
export async function cleanupTerminalRun(
  projectRoot: string,
  runId: string,
): Promise<void> {
  if (!safeSegment(runId)) return; // unsafe id → skip silently (mirrors pause.ts:79)

  // 1. Delete pending markers correlated to this runId (checkpointId-keyed dir).
  try {
    const pending = await listPending(projectRoot);
    for (const m of pending) {
      if (m.runId === runId) {
        await deletePending(projectRoot, m.checkpointId); // already best-effort (:138)
      }
    }
  } catch {
    // never throw into a turn
  }

  // 2. Unlink guidance.jsonl + paused.json under .bober/runs/<runId>/ (tolerate ENOENT).
  const runDir = join(projectRoot, ".bober", "runs", runId);
  await unlink(join(runDir, "guidance.jsonl")).catch(() => {});
  await unlink(join(runDir, "paused.json")).catch(() => {});

  // 3. Clear RunState pending/paused fields (only if a state file exists).
  try {
    const state = await readRunState(projectRoot, runId);
    if (state) {
      const { pendingCheckpointId, pendingPrompt, pendingSince, pausedAt, ...rest } = state;
      void pendingCheckpointId; void pendingPrompt; void pendingSince; void pausedAt;
      await writeRunState(projectRoot, rest);
    }
  } catch {
    // never throw into a turn
  }
}
```
**NOTE on field-clearing:** The destructure-and-spread pattern is the established idiom — see `chat-session.ts:441-447` (`clearPending`) and `:421-424` (`handleResume` dropping `pausedAt`). Do NOT mutate-then-write; build a new object without the optional fields so they are not re-serialized. Preserve `status` as-is from the terminal state (do NOT force it back to "running" — a completed/aborted run must stay completed/aborted).

---

### src/chat/chat-session.ts (modify — ONE hook site)

**The completion poll prelude (CURRENT lines 139-146 — verified):**
```ts
  async handleTurn(input: string): Promise<string | null> {
    // ── Poll for run completions (prelude — runs before slash or LLM path) ─
    let completions: CompletionEvent[] = [];
    try {
      completions = await this.tailer.poll();
    } catch {
      // Poll errors must never break the turn
    }
```
**THE HOOK SITE:** `this.tailer.poll()` returns `CompletionEvent[]` — each event with a `runId?` and `phase: "complete" | "failed"`. These are exactly the runs that just went terminal. Add a best-effort cleanup loop **immediately after the poll try/catch (after line 146), before the approval prelude at line 148**:
```ts
    // ── Cleanup hygiene for runs that just went terminal (Sprint 6) ───────
    for (const c of completions) {
      if (c.runId) {
        try {
          await cleanupTerminalRun(this.projectRoot, c.runId);
        } catch {
          // best-effort — a cleanup failure must never break the turn
        }
      }
    }
```
**Why here:** The tailer dedupes by runId across polls (`completion-tailer.ts:200-203`), so a given completion is observed exactly once — cleanup runs once per terminal run. The notice-weaving at `:203-208` (slash path) and `:268-274` (LLM path) still consumes the same `completions` array, so the user still sees `[run R finished: ...]`. Cleanup is additive and does not touch the weaving.

**Import to add (top of file, with the other state imports at lines 21-30):**
```ts
import { cleanupTerminalRun } from "./steer-cleanup.js";
```

**Imported by:** `src/cli/commands/chat.ts` (the CLI entry that constructs `ChatSession`). The `cleanupTerminalRun` addition is internal to `handleTurn` and changes no public signature — zero ripple to callers.

**Test file:** `src/chat/chat-session-completion.test.ts` exists (completion weaving) and `src/chat/chat-session-steer.test.ts` exists — the new e2e lives in a NEW file `src/chat/chat-steer-e2e.test.ts`; cleanup unit lives in `src/chat/steer-cleanup.test.ts`.

---

### src/chat/slash-commands.ts (modify — verify only; likely NO change needed)

**CURRENT HELP_TEXT (lines 17-31 — verified):** Already lists `/runs`, `/stop`, `/pause`, `/resume`, `/careful`, `/approve`, `/reject`, `/tell`, `/help`, `/exit` — i.e. the **full set sc-6-6 requires**.
```ts
const HELP_TEXT = [
  "Available slash commands:",
  "  /runs              — List all active and recent runs",
  "  /stop <runId>      — Stop a run by killing its process (hard stop)",
  "  /pause <runId>     — Soft-pause a run at the next boundary (process stays alive)",
  "  /resume <runId>    — Resume a soft-paused run",
  "  /careful [on|off]  — Toggle approval gates for new runs",
  "  /approve <id>      — Approve a pending checkpoint (resume the run)",
  "  /reject <id> [why] — Reject a pending checkpoint with optional feedback",
  "  /tell <runId> <text> — Queue free-text guidance for a run (applied at next boundary)",
  "  /help              — Show this help message",
  "  /exit              — Exit the chat session",
  "",
  "Any other input is sent to the AI assistant.",
].join("\n");
```
**ACTION:** sc-6-6 is satisfied by HELP_TEXT as-is. The Generator's only required change is a **test** asserting every command in the set appears (see §6). Do NOT reorder or restyle HELP_TEXT — other tests assert specific substrings (`"killing"`, `"process stays alive"` at `chat-session-steer.test.ts:634-635`; `"guidance"` at `:398`). If you touch the text, keep those substrings.

---

### README.md (modify — add a steer subsection)

**Insertion point:** After the `npx agent-bober chat` lines in the CLI block (README.md:447-448) and before `#### New Commands (Sprints 9–25)` (README.md:452). Add a `#### Chat steer commands` subsection (or extend the existing chat description). The careful-flow CLI commands already documented at README.md:457-461 (`list-approvals`/`approve`/`reject`) are the **non-chat** equivalents — cross-reference them, do not duplicate.

**Content to add (per sc-6-7):** `/careful [on|off]` + the curated gates (post-research/post-plan/post-sprint), `/approve`, `/reject [feedback]`, `/tell`, `/pause`//`/resume`, the `/pause` vs `/stop` distinction, plus a one-line pointer to `docs/chat-steer.md` and the single-careful-run limitation.

---

### docs/chat-steer.md (create)

**Most similar existing file:** `docs/teams.md` — follow its structure: `# Title`, an intro paragraph that **cross-references the research doc by path + line range**, a `---` separator, then `## What Is …`, tables, and a closing limitations note. See `docs/teams.md:1-9` for the exact cross-reference style:
```md
# Teams: Adding a Team is Data, Not Code

This guide covers the agent-bober team abstraction introduced in Phase 4 ...

See the research document at
`.bober/research/20260614-chattable-team-of-agents-platform.md` (Phase 4,
lines 290–330) for the full motivation and architecture.
```
**Required cross-references for docs/chat-steer.md:**
- `.bober/research/20260614-chattable-team-of-agents-platform.md` — **Phase 2 section at line 277** (`### Phase 2 — Interrupt/approve/steer in chat`) and the substrate table at line 51.
- `docs/teams.md` — for the `bober chat <team>` surface this layers onto.

**Required sections (sc-6-7 — the `Limitations / follow-ups` section MUST be explicit):**
1. The cross-process model (chat process owns RunState; child run reads markers at curated gates).
2. `/careful` toggle → spawns with `--approve-gates post-research,post-plan,post-sprint`.
3. The three curated gates and what each pauses on.
4. `/approve` and `/reject <feedback>` (writes `.approved.json` / `.rejected.json`, clears RunState pending fields).
5. `/tell <runId> <text>` — additive guidance drained at the next boundary.
6. `/pause`//`/resume` — cooperative soft-pause, **explicitly distinct from `/stop`** (no kill; process stays alive).
7. **`## Limitations and follow-ups`** — MUST explicitly state:
   - **Single careful run at a time:** pending markers in `.bober/approvals/` are **checkpointId-keyed in a shared dir** (`approval-state.ts:13-14`), not runId-scoped, so two concurrent careful runs hitting the same gate id would collide. Document this as the current constraint.
   - **runId-scoped-marker follow-up (sc-6-7):** the upgrade path is to embed the runId in the marker filename so markers are per-run; this also tightens completion→cleanup correlation (today cleanup correlates by reading each marker's `runId` field — see `steer-cleanup.ts` §1).

---

## 2. Patterns to Follow

### Best-effort unlink (tolerate ENOENT, never throw)
**Source:** `src/state/approval-state.ts`, lines 138-140 and `src/state/pause.ts`, lines 78-81
```ts
export async function deletePending(projectRoot: string, id: string): Promise<void> {
  await unlink(pendingPath(projectRoot, id)).catch(() => {});
}
// pause.ts:78-81
export async function clearPaused(projectRoot: string, runId: string): Promise<void> {
  if (!safeSegment(runId)) return; // best-effort — unsafe id → skip silently
  await unlink(pausePath(projectRoot, runId)).catch(() => {});
}
```
**Rule:** Always `.catch(() => {})` a best-effort `unlink`; guard the runId with `safeSegment` before building any path under `.bober/runs/<runId>/`.

### Drop optional RunState fields by destructure-and-spread (do not mutate)
**Source:** `src/chat/chat-session.ts`, lines 441-447 (`clearPending`) and 421-424 (`handleResume`)
```ts
const { pendingCheckpointId, pendingPrompt, pendingSince, ...rest } = state;
void pendingCheckpointId; void pendingPrompt; void pendingSince;
await writeRunState(this.projectRoot, { ...rest, status: "running" });
```
**Rule:** Build a NEW object without the optional fields and `void` the unused destructured vars (strict mode). For terminal cleanup, keep `status` from the terminal state (do NOT force "running").

### Prelude that "must never break the turn"
**Source:** `src/chat/chat-session.ts`, lines 140-146 and 148-185
```ts
let completions: CompletionEvent[] = [];
try {
  completions = await this.tailer.poll();
} catch {
  // Poll errors must never break the turn
}
```
**Rule:** Every prelude step is wrapped in try/catch with a no-op catch and a comment stating it must not break the turn. The cleanup loop follows the same pattern.

### Named exports + `.js` import suffix + banner comment
**Source:** `src/state/pause.ts`, lines 1-21 (banner + imports), all `export async function`
**Rule:** No default exports; import siblings with `./name.js`; lead the file with a `// ── name.ts ──` banner describing purpose + invariants.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `deletePending` | `src/state/approval-state.ts:138` | `(projectRoot, id) => Promise<void>` | Best-effort unlink a `<id>.pending.json` marker (already tolerates ENOENT). Cleanup uses this for stale pending markers. |
| `listPending` | `src/state/approval-state.ts:80` | `(projectRoot) => Promise<PendingMarker[]>` | List all pending markers (each has a `.runId?` field). Cleanup filters by `m.runId === runId` to correlate. |
| `pendingExists` | `src/state/approval-state.ts:145` | `(projectRoot, id) => Promise<boolean>` | Guard used by handleApprove/handleReject (already wired — do not touch). |
| `writeRunState` | `src/state/run-state.ts:41` | `(projectRoot, state) => Promise<void>` | Atomic RunState write (temp+rename). Cleanup uses it to persist the cleared state. |
| `readRunState` | `src/state/run-state.ts:61` | `(projectRoot, runId) => Promise<RunState \| null>` | Read RunState; null if missing/malformed (never throws). |
| `clearPaused` | `src/state/pause.ts:78` | `(projectRoot, runId) => Promise<void>` | Best-effort remove `paused.json`. (Cleanup could call this instead of a raw unlink — same effect; raw unlink is fine since cleanup already builds the runDir path.) |
| `isPaused` | `src/state/pause.ts:91` | `(projectRoot, runId) => Promise<boolean>` | Test assertion helper — used in e2e to assert pause/resume transitions. |
| `safeSegment` | `src/state/guidance.ts:48` | `(runId) => boolean` | Path-traversal guard. Cleanup must call this before building `.bober/runs/<runId>/` paths. |
| `hasRunDir` | `src/state/guidance.ts:66` | `(projectRoot, runId) => Promise<boolean>` | Existence guard (used by handleTell — not by cleanup, but referenced in e2e). |
| `appendGuidance` / `drainGuidance` | `src/state/guidance.ts:87 / :120` | `(projectRoot, runId, text)` / `(projectRoot, runId)` | Guidance write/drain. **Note:** guidance has NO single-file removal helper — cleanup unlinks `guidance.jsonl` directly (per contract). |
| `fileExists` | `src/utils/fs.ts:10` | `(path) => Promise<boolean>` | Generic existence check (handy in tests). |

**Test-harness helpers to REUSE (do not rewrite — import or copy the established shape):**

| Helper | Location | Purpose |
|--------|----------|---------|
| `makeStopCapturingSpawner` | `src/chat/chat-session-steer.test.ts:64-78` | RunSpawner with injected `spawn`/`kill`/`cliEntry`/`nodeBin`/`now` capturing kill calls. |
| `makeFakeSpawner` | `src/chat/chat-session-spawn.test.ts:33-42` | RunSpawner with injected `spawn` returning a fake child `{pid, unref}`. |
| `makeFakeSpawn` (calls-capturing) | `src/chat/run-spawner.test.ts` (used at :134, :155) | Captures `{file, args, options}` per spawn — the pattern for asserting `--approve-gates` in the careful spawn. |
| `ThrowingClient` | `src/chat/chat-session-steer.test.ts:56-60` | LLMClient that throws if called — proves slash path never hits LLM. |
| `injectPending` | `src/chat/chat-session-approval.test.ts:81-89` | Writes a `<id>.pending.json` directly to `.bober/approvals/` (simulates the child reaching a gate). |
| `injectRunningRun` | `src/chat/chat-session-approval.test.ts:92-103` | Writes a running RunState for a runId. |
| `makeMarker` | `src/chat/chat-session-approval.test.ts:61-78` | Builds a synthetic `PendingMarker` (with `runId`/`checkpointId`/`prompt`). |
| `injectCompletion` | `src/chat/chat-session-completion.test.ts:47-74` | Writes a `pipeline-complete` history line + `<runId>.completed.json` marker so `CompletionTailer.poll()` returns the event — **THE way to simulate a run going terminal in the e2e cleanup step**. |
| `makeAnswerLLM` | `chat-session-approval.test.ts:41` / `chat-session-completion.test.ts:26` | LLM that classifies "answer" then returns fixed text (2 calls per turn). |
| `makeClassifyLLM` | `chat-session-approval.test.ts:451-468` | LLM returning a fixed classify JSON then "answer" — drives NL approve/reject/tell/pause/resume routing deterministically. |
| `make{Tell,Pause,Resume}LLM` | `chat-session-steer.test.ts:289-296 / 405-412 / 415-422` | One-shot classify-JSON LLMs for NL steer routing. |

---

## 4. Prior Sprint Output

### Sprint 1 (14c2be6): careful spawn + RunState grammar
**Created/modified:** `RunState` status union + Phase 2 fields (`run-manager.ts:38, 55-64`); `CarefulSidecar` (`careful-sidecar.ts:13` — `isCareful()`/`setCareful()`); `RunSpawner.spawn(task, runId, {careful})` appends `--approve-gates post-research,post-plan,post-sprint` (`run-spawner.ts:114-115`).
**Connection:** The e2e starts with `setCareful(true)` then spawns and asserts the captured `--approve-gates` args (pattern from `run-spawner.test.ts:154-183`).

### Sprint 2 (67495fc): approval surfacing + RunState reflection
**Created/modified:** ApprovalReader/ApprovalCursor; the approval prelude in `handleTurn` (`chat-session.ts:148-185`) that reflects a pending marker onto the running RunState as `status: "input-required"` + pending fields.
**Connection:** The e2e turn after injecting a post-plan pending marker asserts the surfaced notice + `RunState.status === "input-required"`.

### Sprint 3 (fb4b787): /approve, /reject, clear-on-resolve
**Created/modified:** `handleApprove`/`handleReject` (`chat-session.ts:330-360`) + `clearPending` (`:435-448`) — writes `.approved.json`/`.rejected.json`, clears pending fields.
**Connection:** The e2e `/approve post-plan` step asserts `.approved.json` exists and RunState pending fields cleared.

### Sprint 4 (b74dfcb): guidance channel
**Created/modified:** `src/state/guidance.ts` (`appendGuidance`/`drainGuidance`/`hasRunDir`/`safeSegment`); `handleTell` (`chat-session.ts:371-384`).
**Connection:** The e2e `/tell` step asserts a `guidance.jsonl` entry; cleanup unlinks that file on completion.

### Sprint 5 (bd14e02): pause channel
**Created/modified:** `src/state/pause.ts` (`setPaused`/`clearPaused`/`isPaused`/`waitWhilePaused`); `handlePause`/`handleResume` (`chat-session.ts:396-427`).
**Connection:** The e2e `/pause` → `/resume` steps assert `paused.json` + `RunState.status` transitions; cleanup unlinks `paused.json` on completion.

### Phase 1 (#44): completion observation site
**Created/modified:** `CompletionTailer` (`completion-tailer.ts`) + the completion poll prelude (`chat-session.ts:140-146`) — **the hook site for cleanup**. RosterReader; `/stop`.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` found at project root. Conventions are codified in code (banner comments + the patterns in §2) and the contract's Tech Stack: TypeScript ESM/NodeNext strict, Vitest, Zod, `.js` imports, async fs only, best-effort unlink (tolerate ENOENT), collocated `*.test.ts`, NO fs mocks (use temp dirs), NO network, classifier loose-JSON.

### Architecture Decisions
No dedicated ADR for this sprint. The authoritative design doc is the research file: `.bober/research/20260614-chattable-team-of-agents-platform.md` — **Phase 2 at line 277** (`### Phase 2 — Interrupt/approve/steer in chat`); substrate mapping table at line 51 (approval-state.ts + resume-cursor.ts as the interrupt/resume substrate); two-interrupt-classes note at line 179 (hard stop = abortRun; soft steer = input-required + approval-state). docs/chat-steer.md MUST cross-reference this.

### Other Docs
- `README.md` chat surface: CLI lines 447-448 (`npx agent-bober chat` / `chat <team>`); careful-flow CLI commands at 457-461; Teams section at 553+.
- `docs/teams.md:1-9` — the cross-reference + structure template for the new docs page.
- `docs/sprints/` — per-sprint spec markdown lives here (informational; this sprint adds `docs/chat-steer.md` at the docs/ root, NOT under sprints/).

---

## 6. Testing Patterns

### Unit Test Pattern (steer-cleanup.test.ts — sc-6-4)
**Source:** `src/chat/chat-session-approval.test.ts:28-103` (temp-dir setup + inject helpers)
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-cleanup-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
```
**sc-6-4 test shape:** seed a run with (a) a pending marker carrying `runId` (`injectPending` + `makeMarker({checkpointId, runId})`), (b) a `guidance.jsonl` (write a line or call `appendGuidance`), (c) a `paused.json` (`setPaused`), (d) a RunState with pending+paused fields (`writeRunState` with `pendingCheckpointId`/`pausedAt`). Call `cleanupTerminalRun(tmpDir, runId)`. Assert: the `.pending.json` is gone (`access` throws / `pendingExists` false), `isPaused(tmpDir, runId)` is false, `guidance.jsonl` gone (`fileExists` false), and `readRunState` returns a state with `pendingCheckpointId`/`pendingPrompt`/`pendingSince`/`pausedAt` all `undefined`. **Run a SECOND scenario for the aborted status** (seed `status: "aborted"`) to prove cleanup is status-agnostic and does NOT force status back to running. Also assert cleanup on a runId with NO markers does not throw (idempotent/ENOENT-tolerant).

**Asserting markers gone (established idiom):** `chat-session-approval.test.ts:354-362`
```ts
let existed = false;
try { await access(approvedPath, constants.R_OK); existed = true; } catch { /* expected */ }
expect(existed).toBe(false);
```

**Runner:** vitest. **Assertion style:** `expect`. **Mock approach:** NO mocks — real temp dirs + inject helpers (`mkdtemp`/`rm`). **File naming:** `<name>.test.ts` collocated in `src/chat/`. **Location:** co-located.

### E2E Test Pattern (chat-steer-e2e.test.ts — sc-6-5) — THE INTEGRATION PROOF
Drive the WHOLE loop through `ChatSession.handleTurn` / the `handle*` methods, offline, in a temp dir. Build on the established harness:

**1. Careful-on + spawn capturing `--approve-gates`** (combine `careful-sidecar` + the calls-capturing spawn from `run-spawner.test.ts:154-183`):
```ts
const calls: Array<{ file: string; args: string[]; options: unknown }> = [];
const spawner = new RunSpawner({
  projectRoot: tmpDir, sessionId: "e2e",
  spawn: (file, args, options) => { calls.push({ file, args, options });
    return { pid: 4242, unref: () => {} }; },
  kill: () => {}, cliEntry: "/fake/cli/index.js", nodeBin: "/fake/node",
  now: () => "2026-06-15T00:00:00.000Z",
});
// careful ON via the slash path (deterministic, no LLM):
const session = new ChatSession({ llm: new ThrowingClient(), projectRoot: tmpDir,
  sessionId: "e2e", spawner, now: () => 1718323200000 });
await session.handleTurn("/careful on");
// spawn via the spawn-classifier LLM OR directly via spawner.spawn(...,{careful:true});
// then assert: expect(calls[0].args).toContain("--approve-gates");
//              expect(calls[0].args).toContain("post-research,post-plan,post-sprint");
```
> NOTE: `/careful on` uses `ThrowingClient`; the *spawn* turn needs a spawn-classifier LLM (`makeSpawnClassifierLLM` from `chat-session-spawn.test.ts:23-30`). Either use two sessions/LLMs or call `spawner.spawn(task, runId, {careful:true})` directly after reading `carefulSidecar.isCareful()`. Simplest deterministic route: set careful via `new CarefulSidecar(tmpDir, "e2e").setCareful(true)`, then drive spawn with `makeSpawnClassifierLLM`.

**2. Simulate child reaching post-plan** — `injectPending(tmpDir, makeMarker({ checkpointId: "post-plan", runId, prompt }))` + ensure a running RunState exists (`injectRunningRun`). Then `await session.handleTurn("any updates?")` (answer-LLM) and assert the reply contains the surfaced notice AND `readRunState(tmpDir, runId)?.status === "input-required"` with `pendingCheckpointId === "post-plan"`.

**3. /tell** — `await session.handleTurn("/tell <runId> prefer Zod")` (ThrowingClient session), assert `guidance.jsonl` has an entry with `text: "prefer Zod"`, `consumed: false` (pattern: `chat-session-steer.test.ts:317-324`).

**4. /approve post-plan** — `await session.handleTurn("/approve post-plan")`, assert `.approved.json` exists (pattern: `chat-session-approval.test.ts:337-343`) and `readRunState` pending fields cleared back to running (pattern: `:584-590`).

**5. Simulate post-sprint pending then /pause → /resume** — `injectPending(makeMarker({checkpointId:"post-sprint", runId}))`; ensure running RunState; `handleTurn("/pause <runId>")` → assert `isPaused` true + `RunState.status === "paused"` + `pausedAt` truthy + **NO kill** (pattern: `chat-session-steer.test.ts:441-460`). Then `handleTurn("/resume <runId>")` → assert `isPaused` false + status running + `pausedAt` undefined (pattern: `:544-573`).

**6. Simulate completion → cleanup asserted** — `injectCompletion(tmpDir, runId, "complete")` (writes history line + `.completed.json`), then `await session.handleTurn("done?")`. Assert the cleanup ran: stale `post-sprint.pending.json` gone, `guidance.jsonl` gone, `paused.json` gone, and `readRunState` has no pending/paused fields. The completion notice should also be woven into the reply (`[run R finished: complete]`).

**Assertion level:** disk-artifact (`access`/`fileExists`/`isPaused`/`pendingExists`) + RunState (`readRunState`). NO mocks, NO network, deterministic clock.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/chat/chat-session.ts` | adds `cleanupTerminalRun` call in `handleTurn` | medium | The cleanup loop must sit AFTER the poll try/catch (line 146) and BEFORE the approval prelude (line 148); it must never throw; the `completions` array is still consumed by the weaving at :203 and :268. |
| `src/cli/commands/chat.ts` (constructs ChatSession) | `ChatSession` | low | No signature change — `handleTurn` is internal. Verify the CLI still builds. |
| `src/chat/slash-commands.ts` | HELP_TEXT substrings | low | If you edit HELP_TEXT, preserve `"killing"`, `"process stays alive"`, `"guidance"`, `/runs`, `/exit` (asserted by existing tests). Best: do NOT edit it. |

### Existing Tests That Must Still Pass (grep: tests touching the completion prelude + HELP_TEXT)
- `src/chat/chat-session-completion.test.ts` — weaves/dedupes completion notices; **most at-risk** because cleanup hooks the same poll. The "weaves a completion notice" test seeds a `.completed.json` for `run-99999` with no RunState/markers; cleanup must be a no-op there (idempotent, ENOENT-tolerant). Verify all 4 cases still pass, especially `accepts an injected tailer` (`:129-149`).
- `src/chat/chat-session-approval.test.ts` — approval surfacing/clear; cleanup runs in the SAME `handleTurn` but only for completed runs (these tests use running runs + no completion markers, so cleanup is a no-op). Verify sc-2-5..sc-3-7 still green.
- `src/chat/chat-session-steer.test.ts` — pause/resume/tell/stop + the `/help` substring asserts (`killing`, `process stays alive`, `guidance`). Verify untouched.
- `src/chat/slash-commands.test.ts` — `/help` includes `/runs`, `/careful`, `/approve`, `/reject`, `/tell` (`:36-37, :148-153, :221-227`). The new sc-6-6 test extends this set; do not regress it.
- `src/chat/run-spawner.test.ts` — sc-1-7 careful args vector (`:154-183`). The e2e reuses this assertion shape; the source test must stay green.

### Features That Could Be Affected
- **Completion weaving (Phase 1):** shares the `completions` array. Verify the cleanup loop does NOT mutate/consume `completions` (it only reads `c.runId`).
- **Approval surfacing (Sprint 2):** shares `handleTurn`. A completed run that ALSO has a stale pending marker: cleanup deletes the pending marker before the approval prelude reads it — desired (no zombie surfacing of a finished run's gate). Confirm the prelude at :148 tolerates the now-empty approvals (it already returns `[]` gracefully via `listPending`/ApprovalReader).

### Recommended Regression Checks (run after implementation)
1. `npm run build` — zero TS errors (sc-6-1).
2. `npm run typecheck` — zero strict errors (sc-6-2).
3. `npm run test` — full suite green, incl. new `steer-cleanup.test.ts` + `chat-steer-e2e.test.ts` (sc-6-3/4/5).
4. Targeted: `npx vitest run src/chat/chat-session-completion.test.ts src/chat/chat-session-approval.test.ts src/chat/chat-session-steer.test.ts src/chat/slash-commands.test.ts` — confirm no regression in the shared `handleTurn`/HELP_TEXT surface.
5. Manual (sc-6-7): confirm `docs/chat-steer.md` exists and its `## Limitations and follow-ups` section explicitly states BOTH the single-careful-run-at-a-time limitation AND the runId-scoped-marker follow-up; confirm the README chat subsection lists careful/curated-gates/approve/reject/tell/pause/resume.

---

## 8. Implementation Sequence

1. **src/chat/steer-cleanup.ts** (create) — `cleanupTerminalRun(projectRoot, runId)`: guard with `safeSegment`; `listPending` → `deletePending` for markers where `m.runId === runId`; unlink `guidance.jsonl` + `paused.json` (`.catch(()=>{})`); `readRunState` → destructure-out pending/paused fields → `writeRunState`; wrap each phase so it never throws.
   - Verify: `npm run typecheck` clean for the new module; it imports only existing exports (`deletePending`, `listPending`, `readRunState`, `writeRunState`, `safeSegment`).
2. **src/chat/steer-cleanup.test.ts** (create) — sc-6-4 unit: completed + aborted scenarios + no-markers idempotent case.
   - Verify: `npx vitest run src/chat/steer-cleanup.test.ts` green.
3. **src/chat/chat-session.ts** (modify) — add the `import { cleanupTerminalRun }` and the cleanup loop after line 146 (before the approval prelude).
   - Verify: `npx vitest run src/chat/chat-session-completion.test.ts` still green (the no-op cleanup case), build clean.
4. **src/chat/slash-commands.ts** (verify only) — confirm HELP_TEXT has the full set (it does, :17-31). No edit unless a command is missing.
   - Verify: read HELP_TEXT; add the sc-6-6 test asserting each of `/careful /approve /reject /tell /pause /resume /stop /runs /exit /help` appears.
5. **README.md** (modify) — add the chat-steer subsection near :447-452.
6. **docs/chat-steer.md** (create) — full model + the explicit `## Limitations and follow-ups` section + cross-references to research Phase 2 (:277) and docs/teams.md.
   - Verify (sc-6-7): both limitation + follow-up sentences present.
7. **src/chat/chat-steer-e2e.test.ts** (create) — the full-loop test per §6.
   - Verify: `npx vitest run src/chat/chat-steer-e2e.test.ts` green.
8. **Run full verification** — `npm run build`, `npm run typecheck`, `npm run test`.

---

## 9. Pitfalls & Warnings

- **Hook placement:** Put the cleanup loop AFTER the poll try/catch (`chat-session.ts:146`) and BEFORE the approval prelude (`:148`). Putting it after the prelude would let a finished run's stale pending marker get re-surfaced as `input-required` for one extra turn. Do NOT add it inside the weaving blocks at :203/:268 (those run on every turn including no-completion turns).
- **Cleanup correlation is the documented limitation:** pending markers are **checkpointId-keyed** in the shared `.bober/approvals/` dir (`approval-state.ts:13-14`). To find a run's markers you must `listPending` and filter on each marker's `runId` field (set when the gate was created). A marker with NO `runId` cannot be correlated and is left alone — this is exactly the single-careful-run limitation docs/chat-steer.md must state, with runId-scoped filenames as the follow-up.
- **Never force status back to "running" on cleanup.** The terminal RunState is completed/aborted; only DROP the pending/paused fields, keep `status`. Forcing "running" would resurrect a dead run in the roster. (Contrast: `clearPending`/`handleResume` DO set "running" because the run is still live — different situation.)
- **Best-effort means every phase guarded.** `unlink(...).catch(()=>{})` for files; try/catch around the `listPending`/`deletePending` loop and the `readRunState`/`writeRunState` block. A single broken artifact must not abort the others or throw into the turn.
- **No fs mocks, no network.** Use temp dirs (`mkdtemp`/`rm`) and the inject* helpers. The classifier path in the e2e must use stub LLMs (`makeSpawnClassifierLLM`/`makeAnswerLLM`/`ThrowingClient`) — never a real provider.
- **`.completed.json` markers are the terminal signal, not RunState.status.** The e2e simulates "run went terminal" via `injectCompletion` (history line + `.completed.json`) so `CompletionTailer.poll()` returns the event. Writing a `status:"completed"` RunState alone will NOT trigger the cleanup hook (the hook keys off the tailer's CompletionEvent). Match the real signal.
- **`.js` import suffix in strict NodeNext** — import `./steer-cleanup.js` (not `.ts`), `../state/approval-state.js`, etc. A missing/`.ts` suffix fails the build.
- **HELP_TEXT is already complete** — resist "improving" it. Existing tests assert exact substrings; sc-6-6 only needs a new assertion test, not a text change.
- **`docs/chat-steer.md` goes at the `docs/` root**, not under `docs/sprints/` (that dir is auto-generated per-sprint spec mirrors).
- **`npm run update-all` is a human follow-up**, NOT part of this sprint — note it in docs if relevant, do not run it.
