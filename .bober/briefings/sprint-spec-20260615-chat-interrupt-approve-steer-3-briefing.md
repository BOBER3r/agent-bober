# Sprint Briefing: Resolve approvals from chat — /approve, /reject + feedback, NL

**Contract:** sprint-spec-20260615-chat-interrupt-approve-steer-3
**Generated:** 2026-06-15T17:40:00Z

> Sprint 3 is the WRITE path that closes the HITL loop. Chat writes `.approved.json` / `.rejected.json`
> markers by REUSING `saveApproved` / `saveRejected` (NO new write fns), guarded by `pendingExists`,
> stamped via `resolveApprover`. The detached child's existing `DiskCheckpointMechanism` poll resumes
> automatically; reject feedback round-trips into `runCheckpointWithFeedback`. After resolving, the
> chat-owned RunState clears pending fields and flips back to `running`.

---

## 1. Target Files

### `src/state/approval-state.ts` (REUSE — do NOT modify)

The write store already exists. Reuse exactly these three functions. Verified current line numbers:

**`saveApproved` — line 106, `saveRejected` — line 122, `pendingExists` — line 145:**
```ts
// approval-state.ts:106
export async function saveApproved(projectRoot: string, id: string, m: ApprovedMarker): Promise<void> {
  await ensureDir(approvalsDir(projectRoot));
  await writeFile(approvedPath(projectRoot, id), JSON.stringify(m, null, 2) + "\n", "utf-8");
}
// approval-state.ts:122
export async function saveRejected(projectRoot: string, id: string, m: RejectedMarker): Promise<void> {
  await ensureDir(approvalsDir(projectRoot));
  await writeFile(rejectedPath(projectRoot, id), JSON.stringify(m, null, 2) + "\n", "utf-8");
}
// approval-state.ts:145
export async function pendingExists(projectRoot: string, id: string): Promise<boolean> {
  try { await access(pendingPath(projectRoot, id), constants.R_OK); return true; }
  catch { return false; }
}
```

**Marker shapes — `approval-state.ts:34-44` (use EXACTLY these field names):**
```ts
export interface ApprovedMarker { approvedAt: string; approverId: string; editDelta?: unknown; }
export interface RejectedMarker { rejectedAt: string; rejecterId: string; feedback: string; }
```

**Imports needed by chat-session.ts:** `saveApproved`, `saveRejected`, `pendingExists` (and `ApprovedMarker`/`RejectedMarker` as `import type`) from `../state/approval-state.js`. `listPending` is reached via the existing injected `ApprovalReader`.

---

### `src/cli/commands/approve.ts` (modify — export `resolveApprover`)

`resolveApprover` is ALREADY exported (line 29). It is a pure env read with no commander/chalk coupling, so importing it into chat is safe.

**`resolveApprover` — line 29:**
```ts
export function resolveApprover(): string {
  return process.env["USER"] ?? process.env["USERNAME"] ?? "unknown";
}
```

**The guard pattern to MIRROR — `approve.ts:43-52` (never write a dangling marker):**
```ts
// Guard: pending file must exist — never write a dangling .approved.json
const exists = await pendingExists(projectRoot, checkpointId);
if (!exists) { /* return "no pending checkpoint" message, write nothing */ }
```

**Decision (recommended):** Import `resolveApprover` from `../cli/commands/approve.js` into chat-session.ts. It is already `export`ed, so `estimatedFiles` lists `approve.ts` only because the contract anticipated possibly adding the export — it is already present, so you likely do NOT need to touch approve.ts at all. If you import it, verify no circular-import / side-effect concern (approve.ts only does top-level `import`s; `registerApproveCommand` runs nothing at module load). `reject.ts:29` has an identical `resolveRejecter()` — for the rejecter id you may reuse `resolveApprover()` (same env logic) or import `resolveRejecter`; the contract says `rejecterId` so either env-read value is correct.

**Imported by:** `src/cli/index.ts` (registers the command). Do NOT change `registerApproveCommand`/`registerRejectCommand` behavior — their CLI tests must stay green.

---

### `src/chat/chat-session.ts` (modify — add `handleApprove` / `handleReject`, route classify actions)

**Mirror `handleStop` — lines 264-274 (the handler model):**
```ts
private async handleStop(runId: string): Promise<string> {
  const states = await this.roster.read();
  const target = states.find((s) => s.runId === runId && s.status === "running");
  if (!target) return `No such running run: ${runId}`;
  const result = await this.spawner.stop(runId, "Stopped via chat");
  return result.killedPid !== undefined ? `Stopped run ${runId} ...` : `...`;
}
```

**New handlers — add after `handleStop` (model: guard → write marker → clear RunState → ack):**
```ts
private async handleApprove(checkpointId: string): Promise<string> {
  if (!(await pendingExists(this.projectRoot, checkpointId)))
    return `No pending checkpoint found: ${checkpointId}`;            // write nothing (sc-3-4)
  await saveApproved(this.projectRoot, checkpointId, {
    approvedAt: new Date().toISOString(), approverId: resolveApprover(),
  });
  await this.clearPending(checkpointId);                              // flip RunState -> running
  return `Approved checkpoint ${checkpointId}. The run will resume.`;
}
private async handleReject(checkpointId: string, feedback: string): Promise<string> {
  if (!(await pendingExists(this.projectRoot, checkpointId)))
    return `No pending checkpoint found: ${checkpointId}`;
  await saveRejected(this.projectRoot, checkpointId, {
    rejectedAt: new Date().toISOString(), rejecterId: resolveApprover(), feedback,
  });
  await this.clearPending(checkpointId);
  return `Rejected checkpoint ${checkpointId}. Feedback sent for rework.`;
}
```

**RunState clear helper — INVERSE of Sprint 2's reflection block at `chat-session.ts:146-163`.** Sprint 2 SET `status:"input-required"` + `pendingCheckpointId/pendingPrompt/pendingSince`. Sprint 3 finds the RunState correlated to this checkpoint (match `pendingCheckpointId === checkpointId`, or `runId` from the pending marker) and writes back `status:"running"` with those three fields dropped:
```ts
private async clearPending(checkpointId: string): Promise<void> {
  const states = await this.roster.read();
  const state = states.find(
    (s) => s.status === "input-required" && s.pendingCheckpointId === checkpointId,
  );
  if (!state) return;
  const { pendingCheckpointId, pendingPrompt, pendingSince, ...rest } = state;
  await writeRunState(this.projectRoot, { ...rest, status: "running" });
}
```
> NOTE: destructuring-out the optional fields is the clean way to DROP them — `RunState` marks them `?`, so omission is valid (run-manager.ts:57-61). Do not set them to `undefined` and serialize (that leaves explicit `null`/`undefined` keys; omission is cleaner and matches `readRunState` expectations).

**Classify-path routing — extend the `if/else` at `chat-session.ts:218-237`** (Sprint 2 added the approval prelude above it at :139-176; the action switch itself is unchanged since Sprint 1). Add `else if (action.action === "approve")` / `"reject"` branches. When `action.checkpointId` is absent, resolve via ApprovalReader (single→use it; multiple→ask, write nothing):
```ts
} else if (action.action === "approve" || action.action === "reject") {
  const target = await this.resolveCheckpoint(action.checkpointId);
  if (target.kind === "ambiguous") reply = target.message;        // ASK, write nothing
  else if (action.action === "approve") reply = await this.handleApprove(target.id);
  else reply = await this.handleReject(target.id, action.feedback ?? "");
}
```
```ts
// absent-checkpoint resolution — uses the injected this.approvalReader (Sprint 2)
private async resolveCheckpoint(id?: string):
  Promise<{ kind: "id"; id: string } | { kind: "ambiguous"; message: string }> {
  if (id) return { kind: "id", id };
  const pending = await this.approvalReader.read();
  if (pending.length === 1) return { kind: "id", id: pending[0]!.checkpointId };
  if (pending.length === 0) return { kind: "ambiguous", message: "No pending checkpoints to act on." };
  const ids = pending.map((p) => p.checkpointId).join(", ");
  return { kind: "ambiguous", message: `Multiple pending checkpoints — which one? ${ids}` };
}
```

**Slash dispatch wiring — `chat-session.ts:179-184`** currently threads 2 handlers. Add the two new ones (see slash-commands.ts section for the new params):
```ts
const slashResult = await dispatch(
  input, this.roster,
  (runId) => this.handleStop(runId),
  (arg) => this.handleCareful(arg),
  (id) => this.handleApprove(id),                 // NEW
  (id, fb) => this.handleReject(id, fb),          // NEW
);
```

**Imports to ADD at top of chat-session.ts:** `import { saveApproved, saveRejected, pendingExists } from "../state/approval-state.js";` and `import { resolveApprover } from "../cli/commands/approve.js";` (`writeRunState` is already imported at line 21; `ApprovalReader` already injected at :115-116).

**Test file:** `src/chat/chat-session-approval.test.ts` — EXISTS (Sprint 2, 312 lines). Extend it (the contract lists it in estimatedFiles). Reuse its helpers `makeMarker`, `injectPending`, `injectRunningRun`, `makeAnswerLLM` (lines 32-94).

---

### `src/chat/slash-commands.ts` (modify — add `/approve`, `/reject` cases + handlers + HELP_TEXT)

**Current dispatch signature — line 42-47 (Sprint 1 added 4th param `carefulHandler`):**
```ts
export async function dispatch(
  input: string, roster: RosterReader,
  stopHandler?: (runId: string) => Promise<string>,
  carefulHandler?: (arg: string | undefined) => Promise<string>,
): Promise<SlashResult> {
```
Add two MORE optional params (keep all existing 2-/3-/4-arg callers working — sc-4-6 back-compat is tested):
```ts
  approveHandler?: (id: string) => Promise<string>,
  rejectHandler?: (id: string, feedback: string) => Promise<string>,
```

**The `/stop` case is the threading model — lines 66-73:**
```ts
case "/stop": {
  const arg = trimmed.split(/\s+/)[1];
  if (!arg) return { handled: true, output: "Usage: /stop <runId>" };
  const output = stopHandler ? await stopHandler(arg) : "Stop is unavailable.";
  return { handled: true, output };
}
```

**New `/approve` and `/reject` cases — note `/reject` collects the REMAINDER of the line as feedback:**
```ts
case "/approve": {
  const arg = trimmed.split(/\s+/)[1];
  if (!arg) return { handled: true, output: "Usage: /approve <checkpointId>" };
  const output = approveHandler ? await approveHandler(arg) : "Approve is unavailable.";
  return { handled: true, output };
}
case "/reject": {
  const parts = trimmed.split(/\s+/);
  const id = parts[1];
  if (!id) return { handled: true, output: "Usage: /reject <checkpointId> [feedback]" };
  // everything after the id is feedback (preserve original spacing of the remainder)
  const feedback = trimmed.slice(trimmed.indexOf(id) + id.length).trim();
  const output = rejectHandler ? await rejectHandler(id, feedback) : "Reject is unavailable.";
  return { handled: true, output };
}
```
> Feedback-remainder extraction: `trimmed.split(/\s+/)[1]` gives the id; slice the rest so `/reject post-plan split sprint 2` yields feedback `"split sprint 2"` (matches evaluatorNotes sc-3-5). A safer variant: `trimmed.replace(/^\/reject\s+\S+\s*/, "")`.

**HELP_TEXT — lines 17-26. Add two rows (sc-3-7 asserts /help lists them):**
```ts
"  /approve <id>      — Approve a pending checkpoint (resume the run)",
"  /reject <id> [why] — Reject a pending checkpoint with optional feedback",
```

**Imported by:** `src/chat/chat-session.ts:14` (only caller of `dispatch`). Test file `src/chat/slash-commands.test.ts` EXISTS — extend it.

---

### `src/chat/turn-classifier.ts` (modify — extend action union + schema/prompt)

**Action union — lines 11-15:**
```ts
export type ClassifierAction =
  | { action: "answer" }
  | { action: "spawn"; task: string }
  | { action: "steer"; op: "inspect" }
  | { action: "steer"; op: "stop"; runId: string };
```
Add:
```ts
  | { action: "approve"; checkpointId?: string }
  | { action: "reject"; checkpointId?: string; feedback?: string };
```

**Zod union — lines 19-30 (add two members):**
```ts
z.object({ action: z.literal("approve"), checkpointId: z.string().optional() }),
z.object({ action: z.literal("reject"),  checkpointId: z.string().optional(), feedback: z.string().optional() }),
```

**Reconstruction in `parseClassifierAction` — lines 74-83 (add branches after the `steer` branch, before `return FALLBACK`):**
```ts
if (data.action === "approve") return { action: "approve", checkpointId: data.checkpointId };
if (data.action === "reject")  return { action: "reject", checkpointId: data.checkpointId, feedback: data.feedback };
```

**Prompt — lines 108-118 (jsonObjectMode stays true at :125). Add two option lines:**
```ts
'  {"action":"approve","checkpointId":"<id?>"}  — approve a pending checkpoint',
'  {"action":"reject","checkpointId":"<id?>","feedback":"<why?>"}  — reject a checkpoint',
```
> Keep `jsonObjectMode: true` (line 125) — DeepSeek-safe loose JSON. Any parse failure already falls back to `{action:"answer"}` (line 32 `FALLBACK`).

**Test file:** `src/chat/turn-classifier.test.ts` EXISTS — extend with `ScriptedClient` (lines 9-20) stubbed to return approve/reject JSON.

---

### `src/chat/approval-reader.ts` (REUSE — do NOT modify)

Sprint 2's read-only wrapper. `read()` → `listPending(projectRoot)` (approval-reader.ts:18-20). Use it in `resolveCheckpoint` for the single/ambiguous decision. It is already injected into ChatSession at `chat-session.ts:115-116` as `this.approvalReader`.

---

## 2. Patterns to Follow

### Pattern: Optional-handler threading (back-compat)
**Source:** `slash-commands.ts:42-47, 66-73`
```ts
const output = stopHandler ? await stopHandler(arg) : "Stop is unavailable.";
```
**Rule:** New handler params are appended as OPTIONAL at the end of `dispatch`; when omitted, return an "unavailable" string. This keeps the 2-/3-/4-arg tests (slash-commands.test.ts:96, 111, 160, 170) green.

### Pattern: pendingExists guard before any marker write
**Source:** `approve.ts:43-52`, `reject.ts:43-52`
```ts
const exists = await pendingExists(projectRoot, checkpointId);
if (!exists) { /* clear "no pending checkpoint" message; write nothing */ }
```
**Rule:** Chat handlers MUST guard with `pendingExists` so chat never writes a dangling `.approved.json`/`.rejected.json` (sc-3-4).

### Pattern: RunState transition via writeRunState (full object, not patch)
**Source:** `chat-session.ts:154-160` (Sprint 2 reflection)
```ts
await writeRunState(this.projectRoot, {
  ...state, status: "input-required",
  pendingCheckpointId: m.checkpointId, pendingPrompt: m.prompt, pendingSince: m.requestedAt,
});
```
**Rule:** `writeRunState` (run-state.ts:41) takes a COMPLETE `RunState` and atomically replaces the file. Sprint 3 writes the inverse: spread `...rest` (pending fields destructured out) with `status:"running"`.

### Pattern: Discriminated-union classifier + defensive parse
**Source:** `turn-classifier.ts:19-30, 66-89`
**Rule:** Add union members; every parse failure returns `FALLBACK = {action:"answer"}` (line 32). Never throw from `classify`.

### Pattern: NL handler shared by slash + classify path
**Source:** `chat-session.ts:227-233` (steer:stop routes to the SAME `handleStop` used by `/stop`)
```ts
reply = await this.handleStop(action.runId);   // classify path reuses the slash handler
```
**Rule:** `/approve` and NL-approve both call `handleApprove`; `/reject` and NL-reject both call `handleReject`. One handler, two entry points.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `saveApproved` | `state/approval-state.ts:106` | `(projectRoot, id, ApprovedMarker) => Promise<void>` | Writes `<id>.approved.json` |
| `saveRejected` | `state/approval-state.ts:122` | `(projectRoot, id, RejectedMarker) => Promise<void>` | Writes `<id>.rejected.json` |
| `pendingExists` | `state/approval-state.ts:145` | `(projectRoot, id) => Promise<boolean>` | Guard: pending marker present |
| `listPending` | `state/approval-state.ts:80` | `(projectRoot) => Promise<PendingMarker[]>` | All pending markers (via ApprovalReader) |
| `resolveApprover` | `cli/commands/approve.ts:29` | `() => string` | env USER/USERNAME → 'unknown' (already exported) |
| `resolveRejecter` | `cli/commands/reject.ts:29` | `() => string` | identical env read (optional, for rejecterId) |
| `ApprovalReader.read` | `chat/approval-reader.ts:18` | `() => Promise<PendingMarker[]>` | Read-only pending list (injected as `this.approvalReader`) |
| `writeRunState` | `state/run-state.ts:41` | `(projectRoot, RunState) => Promise<void>` | Atomic temp+rename state write |
| `readRunState` | `state/run-state.ts:61` | `(projectRoot, runId) => Promise<RunState\|null>` | Read state (tests assert with this) |
| `ensureDir` | `state/helpers.ts` (imported by approval-state.ts:5) | `(dir) => Promise<void>` | mkdir -p (already used inside save fns) |

**ApprovedMarker / RejectedMarker / PendingMarker** types: `state/approval-state.ts:25-44` — import as `import type`.
**Utilities reviewed:** `state/`, `cli/commands/`, `chat/`, `utils/fs.ts` (`findProjectRoot`). The chat handler does NOT need `findProjectRoot` — `this.projectRoot` is already set in the constructor (chat-session.ts:98).

---

## 4. Prior Sprint Output

### Sprint 1 (14c2be6): RunState grammar + CarefulSidecar + slash threading
**Created/extended:** `RunState` pending fields (`run-manager.ts:55-63`: `pendingCheckpointId?`, `pendingPrompt?`, `pendingSince?`, `pausedAt?`), `status` union adds `"input-required" | "paused"` (run-manager.ts:38). Added `carefulHandler` as the 4th `dispatch` param.
**Connection:** Sprint 3 CLEARS the pending fields Sprint 1 defined and flips `status` back to `"running"`. Threads `approveHandler`/`rejectHandler` as the 5th/6th `dispatch` params using the SAME optional pattern.

### Sprint 2 (67495fc): ApprovalReader + ApprovalCursor + handleTurn poll-prelude
**Created:** `chat/approval-reader.ts` (read-only `listPending` wrapper), `chat/approval-cursor.ts` (announce-once dedupe), the prelude block `chat-session.ts:139-176` that SETS `status:"input-required"` + pending fields, roster `waiting=<gate>` (`roster-reader.ts:40-41`).
**Connection:** Sprint 3 uses `this.approvalReader` to resolve an absent checkpoint id (single/ambiguous), and writes the INVERSE RunState transition (clear pending → running). The Sprint 2 reflection at :154-160 is the exact template to invert.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` found at project root. Operative discipline from the contract: **"never guess a load-bearing target"** — ambiguous NL approve/reject (multiple pending, none named) must ASK, not guess (contract assumptions; sc-3-6).

### Architecture Decisions
Module-level docstrings are authoritative. `disk.ts:1-11` documents the poll/resume contract. `approve.ts:1-9` / `reject.ts:1-9` document the stateless filesystem-only design. `run-state.ts:1-9` documents atomic temp+rename. No separate ADR file applies to this sprint.

### Other Docs
Stack invariants (from contract): TypeScript ESM/NodeNext strict, `.js` import extensions on ALL relative imports, async `fs` only, Vitest, collocated `*.test.ts`, NO fs mocks (temp dirs via `mkdtemp`), classifier extensions use loose JSON (`jsonObjectMode:true`, DeepSeek-safe).

---

## 6. Testing Patterns

### Unit Test Pattern (chat handlers + RunState)
**Source:** `chat/chat-session-approval.test.ts:21-94` (temp-dir setup + helpers to REUSE)
```ts
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-session-approval-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

async function injectPending(root, m: PendingMarker) { /* writes <id>.pending.json directly */ }
async function injectRunningRun(root, runId): Promise<RunState> { /* writeRunState status:running */ }
```
**RunState assertion (the model for sc-3-7) — chat-session-approval.test.ts:213-218:**
```ts
const after = await readRunState(tmpDir, runId);
expect(after?.status).toBe("input-required");          // Sprint 3 inverts: toBe("running")
expect(after?.pendingCheckpointId).toBe(checkpointId); // Sprint 3 inverts: toBeUndefined()
```
**Runner:** vitest · **Assertion:** `expect` · **Mock approach:** NO fs mocks — real temp dirs; LLM stubbed via hand-rolled `LLMClient` object · **File naming:** collocated `*.test.ts` · **Location:** co-located in `src/chat/`.

### Stubbed-classifier LLM pattern (sc-3-6)
**Source:** `chat-session-steer.test.ts:32-39` (LLM that emits a fixed classifier JSON)
```ts
function makeSteerStopLLM(runId): LLMClient {
  return { chat: async () => ({ text: JSON.stringify({ action: "steer", op: "stop", runId }), usage:{...} }) } as unknown as LLMClient;
}
```
For Sprint 3: `chat: async () => ({ text: JSON.stringify({ action: "approve" }) ... })` (no checkpointId → tests the single-pending shortcut and multi-pending ambiguity).

### Classifier unit test (turn-classifier.test.ts)
**Source:** `turn-classifier.test.ts:9-20, 25-31` — `ScriptedClient` replays canned response strings:
```ts
const client = new ScriptedClient(['{"action":"approve","checkpointId":"post-plan"}']);
const result = await new TurnClassifier(client, "test-model").classify("approve it");
expect(result).toEqual({ action: "approve", checkpointId: "post-plan" });
```

### Integration test — DiskCheckpointMechanism round-trip (sc-3-5, the trickiest)
**Source:** `mechanisms/disk.test.ts:54-84` — IMPORTANT: `DiskCheckpointMechanism.request()` DELETES any pre-existing `.approved/.rejected/.timeout` markers BEFORE polling (disk.ts:81-83). So you CANNOT write the marker first then call request — write it AFTER request starts polling, via `setTimeout`, exactly like the existing test:
```ts
const m = new DiskCheckpointMechanism(tmpApprovalsDir, { pollMs: 10 });
const id = "post-plan" as CheckpointId;
// First seed a pending marker so the chat handler's pendingExists guard passes,
// then call handleReject AFTER request() is polling:
setTimeout(() => { void session.handleReject(id, "split sprint 2"); }, 30);
const outcome = await m.request(id, { type: "plan-spec" });
expect(outcome).toEqual({ approved: false, feedback: "split sprint 2" });
```
> `tmpApprovalsDir = join(tmpDir, ".bober", "approvals")` — must match where `saveRejected` writes. Pre-seed the `.pending.json` (so the handler's `pendingExists` guard passes) BEFORE the `setTimeout`. `CheckpointOutcome` for reject is `{ approved: false; feedback: string }` (types.ts:46-48). This PROVES the chat write integrates with the existing resume+feedback path — do NOT modify disk.ts or feedback-router.ts.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/chat/chat-session.ts` | `slash-commands.ts dispatch` | medium | New optional params must not change behavior for the existing 4-arg call at :179-184; add 5th/6th args |
| `src/cli/index.ts` | `approve.ts`/`reject.ts` exports | low | `registerApproveCommand`/`registerRejectCommand` unchanged; `resolveApprover` already exported (no new export needed) |
| `src/chat/chat-session.ts` classify switch | `turn-classifier.ts ClassifierAction` | medium | New union members are additive; the existing `else` (:234-237) still catches unknowns |
| Any importer of `ClassifierAction` | `turn-classifier.ts:11` | low | Union widening is backward-compatible (consumers narrow on `action`) |

### Existing Tests That Must Still Pass
- `src/cli/commands/approve.ts` CLI tests (search `approve.test`/`approve` under `tests/` and `src/cli`) — assert env-var approver + dangling-guard; UNCHANGED behavior required (contract non-goal: do not change CLI commands).
- `src/cli/commands/reject.ts` CLI tests — same; `--feedback` requiredOption behavior unchanged.
- `src/chat/slash-commands.test.ts` — 2-/3-/4-arg back-compat cases (:96, :111, :160, :170) must stay green after appending 5th/6th params.
- `src/chat/chat-session-approval.test.ts` (Sprint 2, sc-2-5..2-8) — the poll-prelude reflection (:194-219) must still SET input-required; Sprint 3 only clears it on RESOLVE.
- `src/chat/chat-session-steer.test.ts` / `chat-session-spawn.test.ts` / `chat-session-completion.test.ts` — classify routing widened, not replaced.
- `src/chat/turn-classifier.test.ts` — existing answer/spawn/steer parse tests must still pass after union extension.
- `src/orchestrator/checkpoints/mechanisms/disk.test.ts` + `feedback-router.test.ts` — do NOT modify disk.ts / feedback-router.ts; these prove the consume side is unchanged.

### Features That Could Be Affected
- **Sprint 2 approval surfacing** — shares `chat-session.ts` handleTurn + `this.approvalReader`. Verify the prelude (:139-176) still announces and reflects; Sprint 3's clear runs only inside handleApprove/handleReject, not in the prelude.
- **CLI approve/reject (Phase-1/Sprint-9)** — shares the marker format on disk. The chat-written markers MUST be byte-compatible (same field names) so the CLI and disk poll read them identically (sc-3-5 integration test proves this).

### Recommended Regression Checks
1. `npm run build` — zero TS errors (sc-3-1)
2. `npm run typecheck` — zero strict errors (sc-3-2)
3. `npm run test` — full suite green incl. new approve/reject/NL/marker/integration tests (sc-3-3)
4. `npx vitest run src/chat/slash-commands.test.ts src/chat/chat-session-approval.test.ts src/chat/turn-classifier.test.ts` — chat layer
5. `npx vitest run src/orchestrator/checkpoints/mechanisms/disk.test.ts src/orchestrator/checkpoints/feedback-router.test.ts` — prove consume side unbroken
6. `npx vitest run src/cli/commands` (or wherever approve/reject CLI tests live) — CLI commands unchanged

---

## 8. Implementation Sequence

1. **`src/cli/commands/approve.ts`** — verify `resolveApprover` is exported (it is, line 29). Likely NO edit needed; just import it into chat. If lint flags the cross-layer import, lift `resolveApprover` to a tiny shared helper or inline the one-liner `process.env["USER"] ?? process.env["USERNAME"] ?? "unknown"`.
   - Verify: `npm run typecheck` still clean.
2. **`src/chat/turn-classifier.ts`** — extend `ClassifierAction` union (:11), Zod union (:19), `parseClassifierAction` branches (:74), prompt options (:108). Keep `jsonObjectMode:true`.
   - Verify: `npx vitest run src/chat/turn-classifier.test.ts` (after adding new cases) green; existing cases unaffected.
3. **`src/chat/chat-session.ts`** — add imports; add `handleApprove`, `handleReject`, `clearPending`, `resolveCheckpoint`; thread 5th/6th args into `dispatch` (:179); add `approve`/`reject` branches to the classify switch (:218-237).
   - Verify: `npm run typecheck`; RunState clears to `running` with pending fields dropped.
4. **`src/chat/slash-commands.ts`** — add `approveHandler`/`rejectHandler` params (:42-47); add `/approve`, `/reject` cases (model: `/stop` :66-73, `/reject` collects line remainder as feedback); add HELP_TEXT rows (:17-26).
   - Verify: `npx vitest run src/chat/slash-commands.test.ts` — back-compat cases + new /help assertions green.
5. **Tests (collocated)** — extend `chat-session-approval.test.ts` (handleApprove writes/not-writes per pendingExists; handleReject feedback; RunState→running; ambiguous-asks), `slash-commands.test.ts` (/approve, /reject threading, HELP_TEXT), `turn-classifier.test.ts` (stubbed approve/reject JSON), and the DiskCheckpointMechanism round-trip integration test (write rejected via handler → `request()` resolves `{approved:false, feedback}`).
   - Verify: each new test asserts file-written / not-written and the exact `{approved:false, feedback}` the mechanism returns.
6. **Full verification** — `npm run build` && `npm run typecheck` && `npm run test`.

---

## 9. Pitfalls & Warnings

- **disk.ts deletes stale markers at the START of request()** (disk.ts:81-83). The integration test MUST write the chat marker AFTER `request()` begins polling (via `setTimeout`), NOT before — otherwise request() unlinks it and times out. Mirror disk.test.ts:74-77.
- **Marker field names are load-bearing.** disk.ts reads `parsed.feedback` (line 133) and `parsed.editDelta` (line 119). Use EXACTLY `RejectedMarker.feedback` / `ApprovedMarker.editDelta`. A typo (e.g. `reason` instead of `feedback`) silently breaks the round-trip.
- **Never write a dangling marker.** Both handlers MUST `pendingExists`-guard first (sc-3-4 asserts NO file written for a non-existent checkpoint). Do not write then check.
- **Ambiguous NL approve/reject must ASK, not guess.** With ≥2 pending and no named id, return a clarifying message and write NOTHING (sc-3-6, "never guess a load-bearing target").
- **Do NOT add new write functions to approval-state.ts.** Reuse `saveApproved`/`saveRejected` (contract: "do NOT add new write fns"). approval-state.ts stays unchanged.
- **Do NOT modify disk.ts or feedback-router.ts.** Sprint 3 only WRITES markers; the resume + rework consume side already exists (contract non-goals).
- **RunState clear must DROP the optional fields, not set them to undefined.** Destructure `{ pendingCheckpointId, pendingPrompt, pendingSince, ...rest }` and write `...rest`. `JSON.stringify` omits `undefined` keys anyway, but destructuring is the unambiguous intent and matches run-manager.ts:57-61 optionality.
- **`.js` import extensions everywhere.** `import { saveApproved } from "../state/approval-state.js"` (NodeNext). Forgetting `.js` fails the build.
- **Back-compat: dispatch new params are optional and APPENDED.** Existing 4-arg call at chat-session.ts:179 and the 2-/3-/4-arg tests must keep working — return "Approve/Reject is unavailable." when the handler is omitted.
- **`/reject` feedback is the line remainder, not just argv[2].** `/reject post-plan split the sprint` → feedback `"split the sprint"`. Use a slice/replace on the trimmed line, not `split(/\s+/)[2]`.
- **`chat-session-approval.test.ts` already exists.** EXTEND it (don't overwrite); reuse its `injectPending`/`injectRunningRun`/`makeMarker`/`makeAnswerLLM` helpers (lines 32-94).
