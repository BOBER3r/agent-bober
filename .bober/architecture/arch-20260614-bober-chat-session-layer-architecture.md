# Architecture: Bober Chat Session Layer (Chattable-Team Phase 1)

**Architecture ID:** arch-20260614-bober-chat-session-layer
**Generated:** 2026-06-14T00:00:00Z
**Status:** draft

---

## Executive Summary

This is Phase 1 of the chattable-team platform: a persistent `bober chat <team>` CLI session layer that sits above agent-bober's one-shot pipeline. Each turn is classified into exactly one of {answer · spawn · steer/inspect}, with spawn launching detached `runPipeline` workers that survive REPL exit and whose completions are woven into a later turn. The selected approach (Approach A — Pure-Reader Polling Session) keeps the session a stateless reader: roster comes from the non-reconciling `readRunStatesFromDisk`, completions from tailing `.bober/history.jsonl`, and one loose-JSON `LLMClient.chat` call per turn runs identically on Anthropic and DeepSeek. The key tradeoff accepted is polling lag (completions surface a turn late) in exchange for zero SDK leakage and disk-authoritative truth. The primary risk is correlation of detached-worker completions back to runs, resolved by an additive `--run-id` flag and a session-written roster state.

---

## Problem Statement

**Problem:** agent-bober can autonomously build a feature in one shot but has no persistent conversational layer above the pipeline, so a human cannot hold an ongoing terminal conversation with a programming team that spawns, tracks, and reports back on multiple long-running runPipeline/fleet workers across turns.

**Constraints:**
- Latency: no hard numeric budget; spawn turn must ack immediately (non-blocking); completion woven into a later turn via the history log. The per-turn classifier/answerer LLM call is the only synchronous latency.
- Throughput: single human, single terminal.
- Data volume: conversation + roster bounded by `.bober/runs/<id>/state.json` and `.bober/memory/` distill (on disk). No large new store.
- Cost ceiling: one classifier/answerer LLM call per turn; no per-turn re-derivation of roster from the model.
- Backward compatibility: MUST NOT break public APIs of runPipeline (`src/orchestrator/pipeline.ts:969`), RunManager (`src/mcp/run-manager.ts:74`), EventStreamManager (`src/mcp/event-stream.ts:69`), LLMClient.chat (`src/providers/types.ts:216`), memory (`src/state/memory.ts:196,242,272`). Additive reuse only. A2A input-required/paused RunState extension is OUT of Phase-1 scope.

**Consumers:** Primary — CLI user invoking `bober chat <team>`. Secondary — programmatic ESM caller importing the session object. Downstream (unchanged) — runPipeline, FleetCoordinator/ChildRunner.

**Success Criteria:**
- Each turn classified into exactly one of {answer · spawn · steer/inspect}.
- Spawn turn returns immediate ack without blocking.
- Roster read from disk via the non-reconciling reader each turn, never from LLM context.
- A worker completion surfaced in a subsequent turn.
- Session reads `.bober/memory/` distill for continuity.
- Classifier/answerer runs identically through LLMClient.chat on Anthropic AND DeepSeek.

**Locked Dependencies:** filesystem-state-only (no database, no in-memory global as source of truth; disk roster authoritative); provider-agnostic adapters (never leak SDK types); Zod for new config; ESM/NodeNext; async fs; strict TS; collocated tests; reuse RoleProviderMap/resolveRoleProviders + BoberConfig (no LiteLLM). Phase-1 "steer" = inspect + hard-stop only. `<team>` = fixed programming role set (data-driven Team = Phase 4).

---

## System Overview

The chat layer is a thin, mostly-stateless REPL above the existing pipeline. On `bober chat <team>`, `ChatSession` enters a turn loop. Each turn runs a fixed prelude — read roster from disk (`RosterReader` → `readRunStatesFromDisk`), poll the history log for new worker completions (`CompletionTailer`), load recent conversation (`ConversationStore`), and read the `.bober/memory/` distill — then classifies the user input with one loose-JSON `LLMClient.chat` call (`TurnClassifier`). The classified action routes to one of three handlers: **answer** (`Answerer` composes roster + completions + distill + history into a single chat call and returns text), **spawn** (`ChatSession` generates a runId, `RunSpawner` writes the roster `state.json` then launches a detached `agent-bober run <task> --run-id <id>` child and returns an immediate ack), or **steer** (inspect = formatted roster; stop = kill-by-PID via the session sidecar plus a disk `aborted` flip).

The selected Approach A manifests as strict reader/writer separation: the session is a pure reader of run state (`readRunStatesFromDisk`, never the destructive `RunManager.load()`), the single writer of its own conversation JSONL and pid sidecar, and the writer of exactly two run-state mutations it owns (the spawn-time `state.json` and the stop-time `aborted` flip). Worker completions are discovered by tailing the same `.bober/history.jsonl` that EventStreamManager watches, made rotation-safe with a cursor-reset + runId-dedupe scheme. No MCP server shim, no second in-memory inbox, no provider SDK types cross the session boundary.

---

## Component Breakdown

### ChatSession

**Responsibility:** Owns the REPL turn loop and the only mutable session state (byte cursor, seen-completion set).

**Interface:**
```typescript
interface ChatSession {
  start(): Promise<void>;
  handleTurn(userInput: string): Promise<string>;
}
```

**Dependencies:** [TurnClassifier, RosterReader, CompletionTailer, RunSpawner, ConversationStore, Answerer]

---

### TurnClassifier

**Responsibility:** Classifies a single user input into exactly one action via one loose-JSON `LLMClient.chat` call.

**Interface:**
```typescript
interface TurnClassifier {
  classify(input: ClassifyInput): Promise<ClassifierAction>;
}

type ClassifyInput = { client: LLMClient; model: string; userInput: string; rosterSummary: string };

type ClassifierAction =
  | { action: "answer" }
  | { action: "spawn"; task: string }
  | { action: "steer"; op: "inspect" }
  | { action: "steer"; op: "stop"; runId: string };
```

**Dependencies:** [] (calls injected LLMClient; parse-failure deterministically returns `{action:"answer"}`)

---

### RosterReader

**Responsibility:** Reads the current run roster from disk non-destructively and summarizes it for prompts.

**Interface:**
```typescript
interface RosterReader {
  read(): Promise<RunState[]>;            // delegates to readRunStatesFromDisk(projectRoot)
  summarize(states: RunState[]): string;
}
```

**Dependencies:** [] (calls `readRunStatesFromDisk`, run-state.ts:110 — never `RunManager.load()`)

---

### CompletionTailer

**Responsibility:** Polls `.bober/history.jsonl` from a byte cursor and returns new `pipeline-complete` events, rotation-safe.

**Interface:**
```typescript
interface CompletionTailer {
  poll(cursor: number): Promise<{ events: CompletionEvent[]; cursor: number }>;
}

type CompletionEvent = {
  runId?: string;
  phase: "complete" | "failed";
  completed: number;
  failed: number;
  durationMs: number;
  timestamp: string;
};
```

**Dependencies:** [] (reads `.bober/history.jsonl`; resets cursor on size-shrink, see ADR-4)

---

### RunSpawner

**Responsibility:** Launches a detached worker for a session-generated runId and hard-stops one by PID.

**Interface:**
```typescript
interface RunSpawner {
  spawn(task: string, runId: string): Promise<SpawnAck>;
  stop(runId: string, reason: string): Promise<StopResult>;
}

type SpawnAck = { runId: string; task: string; pid: number; cwd: string; spawnError?: string };
type StopResult = { stopped: boolean; runId: string; killedPid?: number; fallbackFlagOnly?: boolean };
```

**Dependencies:** [] (writes roster `state.json` via `writeRunState`; `execa(process.execPath,[cliEntry,"run",task,"--run-id",runId],{cwd,detached:true,stdio:"ignore"}).unref()`; records pid sidecar; `process.kill` on stop — see ADR-3, ADR-5)

---

### ConversationStore

**Responsibility:** Single-writer persistence of the per-session conversation JSONL and its cursor file.

**Interface:**
```typescript
interface ConversationStore {
  append(turn: ChatTurn): Promise<void>;
  loadRecent(limit: number): Promise<ChatTurn[]>;
  cursorPath(): string;
}
```

**Dependencies:** [] (writes `.bober/chat/<sessionId>.jsonl`)

---

### Answerer

**Responsibility:** Composes roster, completions, memory distill, and recent history into one `LLMClient.chat` answer call and returns its text.

**Interface:**
```typescript
interface Answerer {
  answer(input: AnswerInput): Promise<string>;
}

type AnswerInput = {
  client: LLMClient; model: string; userInput: string;
  rosterSummary: string; completions: CompletionEvent[];
  memoryDistill: string; history: ChatTurn[];
};
```

**Dependencies:** [ConversationStore, RosterReader, CompletionTailer]

---

## Data Model

New persisted types only. All disk-authoritative; reuses existing `RunState` (run-manager.ts:35-55) for the roster without modification.

```typescript
// .bober/chat/<sessionId>.jsonl  (one JSON object per line; single-writer = ConversationStore)
type ChatTurn = {
  ts: string;                       // ISO-8601
  role: "user" | "assistant";
  content: string;
  action?: ClassifierAction["action"];   // the classified action for this turn, if any
};

// .bober/chat/<sessionId>.pids.json  (session-owned PID sidecar; keyed by runId — see ADR-5)
type PidSidecar = {
  [runId: string]: { pid: number; task: string; spawnedAt: string };
};

// .bober/chat/<sessionId>.cursor.json  (session-local tail state — see ADR-4)
type CursorFile = {
  byteCursor: number;               // offset into .bober/history.jsonl
  lastSize: number;                 // last observed file size, for rotation/shrink detection
  seenRunIds: string[];             // dedupe set for already-woven completions
};
```

No database. No new global store. The run roster (`.bober/runs/<id>/state.json`), completion markers (`.bober/runs/<id>.completed.json`, `.bober/history.jsonl`), and memory distill (`.bober/memory/`) are existing on-disk artifacts read as-is.

---

## API Contracts

| Method | Input | Output | Error Cases |
|--------|-------|--------|-------------|
| ChatSession.handleTurn | `userInput: string` | `string` (reply / ack / inspect text) | Never throws to REPL; classify-fail → answer path |
| TurnClassifier.classify | `ClassifyInput` | `ClassifierAction` | Parse/LLM error → `{action:"answer"}` |
| RosterReader.read | — | `RunState[]` | Missing `.bober/runs` → `[]` |
| CompletionTailer.poll | `cursor: number` | `{events, cursor}` | File missing → `{events:[], cursor:0}`; size-shrink → reset cursor=0 |
| RunSpawner.spawn | `task, runId` | `SpawnAck` | spawn failure → `SpawnAck.spawnError` set, no throw |
| RunSpawner.stop | `runId, reason` | `StopResult` | Unknown pid → `fallbackFlagOnly:true`, disk `aborted` flip only |
| ConversationStore.append | `ChatTurn` | `void` | fs error propagates (single-writer) |
| Answerer.answer | `AnswerInput` | `string` | LLM error → surfaced as error reply text |

External-facing additive contract: `agent-bober run <task> --run-id <id>` — new optional flag, no change to existing run invocations (ADR-3).

---

## Integration Strategy

### Data Flow

```
ChatSession.handleTurn(userInput)
  -- prelude (every turn) --
  → RosterReader.read() → readRunStatesFromDisk(projectRoot)
  → RosterReader.summarize(states)
  → CompletionTailer.poll(cursor) → {events, cursor'}   // weave events into reply context
  → ConversationStore.loadRecent(limit)
  → read .bober/memory/ distill
  → TurnClassifier.classify({userInput, rosterSummary}) → action

  -- route --
  action=answer → Answerer.answer({...,completions}) → LLMClient.chat → text
  action=spawn  → session generates runId
                → RunSpawner.spawn: writeRunState(state.json) THEN
                  execa(detached, --run-id) .unref() → record pid sidecar → immediate ack
  action=steer/inspect → format roster summary
  action=steer/stop    → resolve runId from roster → RunSpawner.stop:
                         process.kill(pid from sidecar) + writeRunState(status:"aborted")
                         (pid unknown → disk "aborted" flag only)

  → ConversationStore.append(user turn, assistant turn)
ChatSession returns reply
```

Completion-weaving: a worker that finished since the last poll appears as a `CompletionEvent` in the next turn's prelude and is folded into the Answerer context and surfaced in the reply, then its runId is added to `seenRunIds` (dedupe).

### Consistency Model

Mixed, all disk-rooted (eventual across processes):
- **Run roster** — source of truth = disk via `readRunStatesFromDisk`. Session is a pure reader EXCEPT two mutations it owns: the spawn-time `state.json` write and the stop-time `aborted` flip.
- **Conversation** — `.bober/chat/<sessionId>.jsonl`, single-writer (this session), strongly consistent within the session.
- **Completion fact** — `.bober/history.jsonl` (tailed) + `.bober/runs/<id>.completed.json` marker; eventual, surfaced on the next poll.
- **Byte cursor + dedupe set** — session-local, persisted in `.bober/chat/<sessionId>.cursor.json` alongside the conversation.

### External Dependencies

| Service | Used By | Failure Mode | Fallback |
|---------|---------|--------------|----------|
| LLMClient.chat (Anthropic / DeepSeek) | TurnClassifier, Answerer | Provider error / malformed JSON | Classifier → `{action:"answer"}`; Answerer → error reply text |
| Detached `agent-bober run` child | RunSpawner.spawn | Spawn failure | `SpawnAck.spawnError` set; roster `state.json` already written reflects intent |
| OS process (`process.kill`) | RunSpawner.stop | Pid stale/unknown | Disk `aborted` intent-flag only (`fallbackFlagOnly`) |
| `.bober/history.jsonl` | CompletionTailer | Rotation/shrink | Cursor reset to 0 + runId dedupe (ADR-4) |
| `.bober/memory/` distill | ChatSession prelude | Missing distill | Empty distill string; continuity degraded, turn proceeds |

---

## Architecture Decision Records

- [ADR-1: Pure-Reader Polling Session](.bober/architecture/arch-20260614-bober-chat-session-layer-adr-1.md)
- [ADR-2: Loose-JSON Turn Classifier via jsonObjectMode](.bober/architecture/arch-20260614-bober-chat-session-layer-adr-2.md)
- [ADR-3: Detached-Child Fire-and-Forget with Session-Generated runId](.bober/architecture/arch-20260614-bober-chat-session-layer-adr-3.md)
- [ADR-4: Rotation-Safe History Tail with Cursor-Reset and Dedupe](.bober/architecture/arch-20260614-bober-chat-session-layer-adr-4.md)
- [ADR-5: Kill-by-PID Stop Semantics with Disk Intent-Flag Fallback](.bober/architecture/arch-20260614-bober-chat-session-layer-adr-5.md)
- [ADR-6: Per-Turn Roster via readRunStatesFromDisk, Never RunManager.load()](.bober/architecture/arch-20260614-bober-chat-session-layer-adr-6.md)

---

## Risk Assessment

| Risk | Severity | Owner | Mitigation |
|------|----------|-------|------------|
| `pipeline-complete` line carries no runId (pipeline.ts:923-932); child self-generates `run-${Date.now()}` (pipeline.ts:583) | critical | RunSpawner | Session-generated runId via additive `--run-id` flag; `.bober/runs/<id>.completed.json` keyed on shared id (ADR-3) |
| `.bober/history.jsonl` rotates via `rotateIfNeeded(...,2000)` (history.ts:99, history-rotation.ts:89-100) → byte cursor invalid on shrink → completions dropped | high | CompletionTailer | Size-shrink detection → cursor reset to 0 + runId dedupe (ADR-4) |
| `RunManager.abortRun` no-ops cross-process (run-manager.ts:123) → stop silently fails | high | RunSpawner | Kill-by-PID from sidecar + disk `aborted` flip; never use abortRun cross-process (ADR-5) |
| `RunManager.load()` reconciles `running`→`failed` (run-manager.ts:251-256) → live detached workers shown failed | high | RosterReader | Use `readRunStatesFromDisk` only; collocated unit guard test (ADR-6) |
| DeepSeek rejects strict json_schema (types.ts:177-178) → classifier behaves differently per provider | medium | TurnClassifier | `jsonObjectMode:true` loose JSON + tolerant parse; parse-fail → answer (ADR-2) |
| OS pid reuse → `process.kill` signals wrong process | medium | RunSpawner | Kill only session-recorded pids this lifetime; stale entries fall through to disk-flag-only (ADR-5) |
| Completion line rotated away before any poll | low | CompletionTailer | `.bober/runs/<id>.completed.json` marker as fallback correlation source (ADR-4) |

---

## Open Questions

- **Cursor file location vs. EventStreamManager:** Assumed the session-local cursor lives in `.bober/chat/<sessionId>.cursor.json`, independent of any EventStreamManager cursor. If EventStreamManager later exposes a shared, rotation-aware cursor API, the CompletionTailer could delegate to it and drop its own shrink-detection — a simplification, not a correctness change.
- **Session id generation:** Assumed `<sessionId>` is generated per `bober chat` invocation (e.g. timestamp-based) and conversation is NOT resumed across invocations in Phase 1. If multi-session resume is required, `ConversationStore.loadRecent` and the pid sidecar would need a stable session-id handshake; deferred to a later phase.
- **`memoryDistill` read path:** Assumed the `.bober/memory/` distill is read with the existing memory reader (memory.ts:196,242,272) as a plain string for prompt context. If a richer structured distill is needed, the Answerer prompt composition changes; no structural impact.
