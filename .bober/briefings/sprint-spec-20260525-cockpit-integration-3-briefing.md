# Sprint Briefing: Event stream MCP tool with server-initiated notifications and backpressure

**Contract:** sprint-spec-20260525-cockpit-integration-3
**Generated:** 2026-05-25T00:00:00Z

---

## 0. Critical Tension Between Contract and Existing Code

You MUST acknowledge and resolve these before writing any code:

### 0.1 history.jsonl currently has NO `runId` field

`src/state/history.ts:37-44` defines `HistoryEntrySchema` as:

```ts
export const HistoryEntrySchema = z.object({
  timestamp: z.string().datetime(),
  event: z.string().min(1),
  phase: PhaseSchema,
  sprintId: z.string().optional(),
  details: z.record(z.string(), z.unknown()),
});
```

No `runId` field exists, and the contract explicitly says (sc-3-6): "Lines in history.jsonl/telemetry without a runId field are silently skipped (no broadcast — runId-targeted only)." Existing legacy lines in `.bober/history.jsonl` confirm this — none have runId.

`assumptions[3]` in the contract reads: "history.jsonl events have a runId field when relevant; legacy events without runId are non-runId-scoped and not delivered to runId-scoped subscriptions (this is the intended filter behavior)."

**Resolution:** Do NOT modify `src/state/history.ts` writer code (nonGoals[4] forbids it). Parse the line, attempt to extract `runId` if present (it may appear in `details.runId` OR at the top level — your parser MUST check both), and silently skip lines where no runId can be found OR where it does not match the subscription's runId. The contract is intentionally tolerant: future writers may add `runId` at the top level OR nest it under `details`; both shapes must work.

### 0.2 `.bober/telemetry/` may not exist yet

`telemetry.enabled` defaults to `false` (`src/config/schema.ts:282-289`), and `.bober/telemetry/` is created lazily by `src/telemetry/emit.ts:87` only when a telemetry event is emitted. Your watcher MUST:
- Not crash when the directory does not exist on `subscribe()`.
- Detect later directory + file creation (use `fs.watch(parentDir)` OR poll-on-miss).
- Handle the date-rollover case explicitly: `assumptions[2]` says "the watcher must detect file creation for new-date files, not just appends to the current file."

Telemetry events DO carry `runId` natively (`src/telemetry/emit.ts:42-55`), so filter logic for telemetry is simpler than history.

### 0.3 logger writes to stdout — UNSAFE in MCP stdio context

`src/utils/logger.ts:14` calls `console.log` for `.info` / `.success`. `src/mcp/server.ts:6-7` explicitly states: "stdout is reserved for MCP JSON-RPC protocol messages. All diagnostic output must go to process.stderr." The existing `src/mcp/server.ts:68-72,112-116,182,187` uses `process.stderr.write(...)` directly. Do NOT use `logger.info` from within `event-stream.ts` or the new tool files — use `process.stderr.write` (see server.ts pattern). `logger.warn` is also unsafe (it uses `console.warn` which goes to stderr, which is fine, but pick the explicit `process.stderr.write` idiom to match `server.ts` style).

### 0.4 `pipeline.eventQueueBound` does NOT exist in PipelineSectionSchema

sc-3-3 says "default 1000, configurable via pipeline.eventQueueBound." `src/config/schema.ts:147-173` (PipelineSectionSchema) has no such field. Add it:

```ts
eventQueueBound: z.number().int().min(1).default(1000),
```

Add it to `PipelineSectionSchema` and to the default-config seed at `src/config/schema.ts:371-383`. This is the only schema change needed for this sprint.

### 0.5 EventStreamManager must NOT be a top-level module singleton

`generatorNotes` says: "EventStreamManager is a singleton instantiated alongside the MCP server. ... Wire EventStreamManager into src/mcp/server.ts:107-118 — instantiate after server construction so tool handlers can reference it."

But tools register via the module-level `registry` (`src/mcp/tools/registry.ts:39`) BEFORE the server is constructed. The standard pattern is `registerXxxTool()` at module load. To allow tool handlers to reference the manager + server:

**Recommended:** Export a module-scoped late-bound singleton from `src/mcp/event-stream.ts`:

```ts
// event-stream.ts
let _manager: EventStreamManager | null = null;
export function initEventStream(server: Server, projectRoot: string): EventStreamManager {
  _manager = new EventStreamManager(server, projectRoot);
  return _manager;
}
export function getEventStream(): EventStreamManager {
  if (!_manager) throw new Error("EventStreamManager not initialized");
  return _manager;
}
```

Call `initEventStream(server, projectRoot)` in `src/mcp/server.ts` right after `await server.connect(transport)` (line 179) and before the SIGINT/SIGTERM handlers. The tool handlers then call `getEventStream()` lazily inside the handler body — never at module load. Add manager.shutdown() to the SIGINT/SIGTERM shutdown handler at line 186.

This mirrors how `runManager` is a module-scoped singleton in `src/mcp/run-manager.ts:247`, but with explicit init-after-server-construct ordering.

---

## 1. Target Files

### src/mcp/event-stream.ts (create)

**Most similar existing file:** `src/mcp/run-manager.ts` for the class + module-level singleton pattern, AND `src/graph/hook-handler.ts:31-220` for the queue + drop-oldest backpressure pattern (Sprint 17 already implemented overflow eviction — read it).

**Directory pattern:** Files in `src/mcp/` use **dash-case** filenames (`run-manager.ts`, `external-client.ts`). New file is `event-stream.ts`.

**Structural skeleton:**

```ts
// ── EventStreamManager ──────────────────────────────────────────────
//
// Tails .bober/history.jsonl + .bober/telemetry/<date>.jsonl for matching
// runIds and forwards events as server-initiated MCP notifications.
//
// stdout-safety: all diagnostic output MUST go to process.stderr.

import { open, stat, watch, type FSWatcher, type StatsBase } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

const NOTIF_EVENT = "bober/events";
const NOTIF_DROPPED = "bober/events.dropped";

interface Subscription {
  subscriptionId: string;
  runId: string;
  startedAt: string;
  server: Server;
  queue: unknown[];                 // bounded by queueBound
  queueBound: number;
  droppedSinceLastDelivery: number; // becomes count in bober/events.dropped
  flushing: boolean;                // single-flight delivery
}

interface FileWatch {
  path: string;
  watcher: FSWatcher;
  offset: number;                   // last-read byte offset
  refCount: number;                 // unsubscribe releases when 0
  partialLine: string;              // buffer for incomplete final line
}

export class EventStreamManager {
  private subscriptions = new Map<string, Subscription>();
  private fileWatches = new Map<string, FileWatch>(); // keyed by absolute path

  constructor(
    private readonly server: Server,
    private readonly projectRoot: string,
    private readonly defaultQueueBound = 1000,
  ) {}

  async subscribe(runId: string, opts: { since?: string; queueBound?: number } = {}): Promise<{
    subscriptionId: string;
    status: "subscribed";
    startedAt: string;
  }> { /* ... */ }

  unsubscribe(subscriptionId: string): { ok: boolean } { /* ... */ }

  shutdown(): void { /* close all watchers, clear all subs */ }

  private openWatch(filePath: string): Promise<void> { /* ... */ }
  private onFileEvent(filePath: string): Promise<void> { /* read from offset, parse JSONL lines, fan-out */ }
  private deliver(sub: Subscription, event: unknown): void { /* push + drain + drop-oldest */ }
}

// ── Late-bound module singleton ──────────────────────────────────────
let _manager: EventStreamManager | null = null;
export function initEventStream(server: Server, projectRoot: string, queueBound?: number): EventStreamManager {
  _manager = new EventStreamManager(server, projectRoot, queueBound);
  return _manager;
}
export function getEventStream(): EventStreamManager {
  if (!_manager) throw new Error("EventStreamManager not initialized; call initEventStream(server, projectRoot) after server.connect().");
  return _manager;
}
```

**Imports this file uses:**
- `Server` from `@modelcontextprotocol/sdk/server/index.js`
- `randomUUID` from `node:crypto`
- `watch, FSWatcher, stat, open` from `node:fs`
- `readFile` from `node:fs/promises`
- `join` from `node:path`

**Imported by:**
- `src/mcp/server.ts` (calls `initEventStream(server, projectRoot)` after `server.connect(transport)`)
- `src/mcp/tools/subscribe-events.ts` (calls `getEventStream()`)
- `src/mcp/tools/unsubscribe-events.ts` (calls `getEventStream()`)

**Test file:** `src/mcp/event-stream.test.ts` (create — colocated, matches `run-manager.test.ts` convention)

---

### src/mcp/event-stream.test.ts (create)

**Most similar existing file:** `src/mcp/run-manager.test.ts` (singleton reset via cast + private field access). Also see `src/mcp/external-client.test.ts:11-38` for mocking `Server` from the SDK.

**Critical setup detail:** EventStreamManager holds a Server reference; for unit tests, pass a fake Server with just a `notification(arg): Promise<void>` method. The test asserts on a `vi.fn()` capturing calls. Do NOT spawn a real subprocess for unit tests — that's the integration-smoke job (stopConditions[2]).

```ts
import { mkdtemp, rm, mkdir, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { EventStreamManager } from "./event-stream.js";

interface FakeServer { notification: ReturnType<typeof vi.fn>; }

function makeFakeServer(): FakeServer {
  return { notification: vi.fn().mockResolvedValue(undefined) };
}

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-events-test-"));
  await mkdir(join(tmpDir, ".bober"), { recursive: true });
});
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

it("delivers a bober/events notification for a matching runId append", async () => {
  const srv = makeFakeServer();
  const mgr = new EventStreamManager(srv as never, tmpDir);
  await mgr.subscribe("run-X");

  const line = JSON.stringify({ timestamp: "2026-05-25T00:00:00Z", event: "x", phase: "init", runId: "run-X", details: {} }) + "\n";
  await appendFile(join(tmpDir, ".bober", "history.jsonl"), line);

  // Wait for fs.watch to fire (event loop tick).
  await new Promise((r) => setTimeout(r, 100));

  expect(srv.notification).toHaveBeenCalled();
  const call = srv.notification.mock.calls[0]![0] as { method: string; params: { subscriptionId: string; event: unknown } };
  expect(call.method).toBe("bober/events");
  expect(call.params.event).toMatchObject({ runId: "run-X" });
});
```

**Required test scenarios (from evaluatorNotes — ALL must pass):**

| # | Scenario | Assertion |
|---|----------|-----------|
| 1 | Subscribe runId=X, append matching line | `srv.notification` called within 1s with `method='bober/events'` |
| 2 | Append 2000 events with 1000-bound | Exactly 1000 deliveries + 1 `bober/events.dropped` notification with `count=1000` |
| 3 | Append line WITHOUT runId | `srv.notification` NOT called |
| 4 | Append line with runId=Y to subscription for X | `srv.notification` NOT called |
| 5 | Unsubscribe; append line with runId=X | `srv.notification` NOT called after unsubscribe |
| 6 | Subscribe + unsubscribe 50× | FSWatcher count stays at 0 (track via `mgr.fileWatches.size` private inspection or assert `srv.notification` still works on a fresh subscribe) |
| 7 | Subscribe with `since=<ts>`; pre-existing lines with timestamp > since AND runId=X | Backfill notifications sent before any live appends |

---

### src/mcp/tools/subscribe-events.ts (create)

**Directory pattern:** `src/mcp/tools/` uses dash-case (`list-active-runs.ts`, `get-run-status.ts`, `abort-run.ts`). New: `subscribe-events.ts`, `unsubscribe-events.ts`.

**Most similar existing file:** `src/mcp/tools/abort-run.ts` (lines 1-76) — a registerTool pattern with required `runId` arg + soft-error JSON + delegation to a manager singleton.

**Structure template (mirror abort-run.ts):**

```ts
// ── bober_subscribe_events tool ──────────────────────────────────────
//
// Subscribes the MCP client to runId-scoped events. The server begins
// emitting `bober/events` notifications whenever a matching line is
// appended to .bober/history.jsonl or .bober/telemetry/<date>.jsonl.
// On per-subscription queue overflow, a `bober/events.dropped` notification
// is sent and oldest events are evicted.

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { registerTool } from "./registry.js";
import { getEventStream } from "../event-stream.js";

export function registerSubscribeEventsTool(): void {
  registerTool({
    name: "bober_subscribe_events",
    description:
      "Subscribe to runId-scoped events streamed via MCP notifications. " +
      "Returns a subscriptionId; the server emits `bober/events` notifications " +
      "for matching lines appended to .bober/history.jsonl and .bober/telemetry/<date>.jsonl.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "The runId to filter events by." },
        since: {
          type: "string",
          description: "ISO 8601 timestamp; only deliver events after this time. One-time backfill on subscribe.",
        },
      },
      required: ["runId"],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const runId = typeof args.runId === "string" ? args.runId.trim() : "";
      if (!runId) {
        throw new McpError(ErrorCode.InvalidRequest, "runId is required and must be a non-empty string.");
      }
      const since = typeof args.since === "string" ? args.since : undefined;

      const mgr = getEventStream();
      const result = await mgr.subscribe(runId, since !== undefined ? { since } : {});
      return JSON.stringify(result, null, 2);
    },
  });
}
```

---

### src/mcp/tools/unsubscribe-events.ts (create)

**Most similar existing file:** `src/mcp/tools/abort-run.ts`.

**Behavior contract:**
- If subscriptionId exists → release watchers (when refcount reaches 0), return `{ subscriptionId, status: "unsubscribed" }`.
- If subscriptionId not found → return `{ error: "Subscription not found: <id>" }` (soft error, consistent with `get-run-status.ts` / `abort-run.ts`).
- Missing/empty subscriptionId → `throw new McpError(ErrorCode.InvalidRequest, ...)`.

```ts
inputSchema: {
  type: "object",
  properties: {
    subscriptionId: { type: "string", description: "The subscriptionId returned by bober_subscribe_events." },
  },
  required: ["subscriptionId"],
  additionalProperties: false,
}
```

---

### src/mcp/tools/index.ts (modify)

**Relevant sections (lines 23-25, 53, 73-76):**

```ts
import { registerListActiveRunsTool } from "./list-active-runs.js";
import { registerGetRunStatusTool } from "./get-run-status.js";
import { registerAbortRunTool } from "./abort-run.js";
// ADD:
import { registerSubscribeEventsTool } from "./subscribe-events.js";
import { registerUnsubscribeEventsTool } from "./unsubscribe-events.js";
```

In the docstring at lines 31-52, change count from "20 total" → "22 total" and add entries 21, 22.

In `registerAllTools()` at lines 73-76, add:

```ts
registerListActiveRunsTool();
registerGetRunStatusTool();
registerAbortRunTool();
// ADD:
registerSubscribeEventsTool();
registerUnsubscribeEventsTool();
```

**Test file:** `src/mcp/tools/tools.test.ts:8` asserts `tools.length).toBe(20)`. Change to `22`. At lines 18-39, the expected name array — append `"bober_subscribe_events"` and `"bober_unsubscribe_events"`. `tests/mcp/external-server-graph.test.ts:38, 47-48, 58-59, 110` also assert 20/26 — update to 22/28.

---

### src/mcp/server.ts (modify)

**Relevant sections (lines 22-24, 119-130, 178-197):**

Imports (after the existing `runManager` import on line 24):

```ts
import { initEventStream, getEventStream } from "./event-stream.js";
```

After `await server.connect(transport)` (line 179) and before the stderr `started` log:

```ts
// ── Initialize event-stream subsystem (cockpit-integration sprint 3) ───
// Must run AFTER server.connect() so the transport is live for notifications.
const queueBound = await loadConfig(projectRoot).then(c => c.pipeline.eventQueueBound ?? 1000).catch(() => 1000);
initEventStream(server, projectRoot, queueBound);
```

Modify the `shutdown` closure at lines 186-191 to release event-stream watchers before closing the server:

```ts
const shutdown = (): void => {
  process.stderr.write("[agent-bober mcp] Shutting down...\n");
  try { getEventStream().shutdown(); } catch { /* not initialized — ignore */ }
  server.close().catch(() => {});
  process.exit(0);
};
```

**Note:** `loadConfig` is already imported (line 23). Reading config a second time is acceptable — the file is small. Alternatively, hoist the config load above the existing graph-block at line 80 so both blocks reuse one read.

---

### src/config/schema.ts (modify)

**Relevant section (lines 147-173) — add ONE field to `PipelineSectionSchema`:**

```ts
export const PipelineSectionSchema = z.object({
  maxIterations: z.number().int().min(1).default(20),
  maxCheckpointIterations: z.number().int().min(1).max(10).default(3),
  // ... existing fields ...
  allowAutopilotRiskyActions: z.boolean().default(false),
  /** Sprint 3 (cockpit-integration): per-subscription bounded queue for the
   *  event-stream notification fan-out. Default 1000. When the queue overflows,
   *  the oldest events are dropped and a single `bober/events.dropped`
   *  notification with `{ subscriptionId, dropped: N }` is emitted per
   *  overflow window. */
  eventQueueBound: z.number().int().min(1).default(1000),
});
```

Also update the seed at `src/config/schema.ts:371-383` (the `pipeline: { ... }` block in `createDefaultConfig`) to include `eventQueueBound: 1000`.

**Imported by (these will fail typecheck if you forget the seed default):**
- `src/mcp/run-manager.test.ts` (`makeFakeConfig` — sets `pipeline: { maxIterations, requireApproval, contextReset }`) — Zod default fills it; should not need updating.
- All other test helpers that build a `BoberConfig` literal — only update if TypeScript complains. Zod defaults handle missing fields when parsed; literal object construction with `as const` should NOT need updates because the field is optional via z.default.

Note: `BoberConfig` is `z.infer<typeof BoberConfigSchema>`. With `.default(1000)`, the input type makes `eventQueueBound` optional but the output type makes it required. Test fixtures that construct a `BoberConfig` literal directly (NOT via parse) WILL break unless you add `eventQueueBound: 1000` to them. Search: `grep -rn 'pipeline: {' src/ tests/` and add the field where TypeScript errors.

---

### CHANGELOG.md (modify)

Add an unreleased entry summarizing the new tools, the EventStreamManager, and the `pipeline.eventQueueBound` config field. Mirror format used by past sprints.

---

## 2. Patterns to Follow

### 2.1 MCP server-initiated notification (THE critical idiom)

**Source:** `/Users/bober4ik/agent-bober/node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.d.ts:381-383`, implementation at `protocol.js:789-820`.

```ts
// Server inherits from Protocol; notification() sends a one-way message.
// Method names are open — assertNotificationCapability in server/index.js:173-208
// has a default case that allows any unknown method (e.g., "bober/events").
await server.notification({
  method: "bober/events",
  params: { subscriptionId, event },
});
```

**Rule:** Use `server.notification({ method, params })`. Do NOT use `sendLoggingMessage` (that requires `capabilities.logging` which the bober server does NOT declare). Custom methods like `bober/events` and `bober/events.dropped` are permitted by the SDK because they fall through the capability-assert switch.

**Critical (from evaluatorNotes):** "If the implementation polls or stuffs events into a tool's return value, that violates the architecture requirement (rejection criterion)." Notifications MUST be server-initiated via `server.notification(...)`.

**Server type quirk:** `Server` is `Server<RequestT, NotificationT, ResultT>` (server/index.d.ts:73). The default `NotificationT = Notification` is permissive enough that custom-method notifications pass type-check. If TypeScript complains in your tool file, cast: `await server.notification({ method: "bober/events", params } as never)` — or, cleaner, declare the params object as `{ method: string; params: Record<string, unknown> }`.

---

### 2.2 Module-scoped late-bound singleton

**Source:** `src/mcp/run-manager.ts:247` for the module-scoped singleton baseline; `src/mcp/server.ts:62-73` for "load runtime state after server import but before connect."

```ts
// run-manager.ts: eager singleton (state is OK at module load)
export const runManager = new RunManager();

// event-stream.ts: LATE-bound — server must exist before instantiation
let _manager: EventStreamManager | null = null;
export function initEventStream(server: Server, projectRoot: string): EventStreamManager { /* ... */ }
export function getEventStream(): EventStreamManager { /* ... */ }
```

**Rule:** When a module needs the live `Server` instance, expose `initX(server)` + `getX()` instead of an eager `export const x = new X()`. Tool handlers call `getX()` lazily inside the handler body so server-init order is enforced at runtime.

---

### 2.3 Per-key Promise-chain mutex (for ordered async appends)

**Source:** `src/incident/timeline.ts:52-56,223-227` AND `src/orchestrator/checkpoints/audit.ts:82,141-152`.

```ts
const writeChains = new Map<string, Promise<void>>();

async function serializedRun(key: string, fn: () => Promise<void>): Promise<void> {
  const prev = writeChains.get(key) ?? Promise.resolve();
  const next = prev.then(fn);
  writeChains.set(key, next.catch(() => {}));
  return next;
}
```

**Rule:** When fan-out to many subscriptions for ONE file must preserve append order, serialize the per-file watch handler. Use a `Map<filePath, Promise<void>>` chain. Subscriptions on DIFFERENT files proceed in parallel.

---

### 2.4 Drop-oldest bounded queue with overflow notification

**Source:** `src/graph/hook-handler.ts:69-97` (Sprint 17 implemented this exact pattern for path queues).

```ts
private deliver(sub: Subscription, event: unknown): void {
  sub.queue.push(event);
  if (sub.queue.length > sub.queueBound) {
    const overflow = sub.queue.length - sub.queueBound;
    sub.queue.splice(0, overflow);   // drop oldest
    sub.droppedSinceLastDelivery += overflow;
  }
  // flush asynchronously; single-flight via sub.flushing
  void this.flush(sub);
}

private async flush(sub: Subscription): Promise<void> {
  if (sub.flushing) return;
  sub.flushing = true;
  try {
    while (sub.queue.length > 0) {
      const event = sub.queue.shift()!;
      await sub.server.notification({
        method: "bober/events",
        params: { subscriptionId: sub.subscriptionId, event },
      });
    }
    if (sub.droppedSinceLastDelivery > 0) {
      const count = sub.droppedSinceLastDelivery;
      sub.droppedSinceLastDelivery = 0;
      await sub.server.notification({
        method: "bober/events.dropped",
        params: { subscriptionId: sub.subscriptionId, dropped: count },
      });
    }
  } finally {
    sub.flushing = false;
  }
}
```

**Rule:** Use Array.splice for drop-oldest; track `droppedSinceLastDelivery` and emit ONE summary notification per "overflow window" (= one drained flush cycle), NOT one per dropped event (sc-3-3 requires exactly 1 dropped notification per overflow window).

---

### 2.5 JSONL line parsing (skip malformed)

**Source:** `src/state/history.ts:85-99` (loadHistory) and `src/graph/hook-handler.ts:207-218`.

```ts
for (const line of raw.split("\n")) {
  const t = line.trim();
  if (!t) continue;
  let rec: unknown;
  try {
    rec = JSON.parse(t) as unknown;
  } catch {
    continue;  // skip malformed
  }
  // ... runId extraction + filter ...
}
```

**Rule:** `split("\n")` + per-line `try/catch JSON.parse`. Never throw on a malformed line — log to stderr (optional) and continue.

**Watcher-specific gotcha:** A read may end mid-line if a writer is mid-append. Maintain a `partialLine` buffer on each `FileWatch`: after split, hold the LAST element back (it may be incomplete or empty), prepend it on next read. Only emit lines that ended with `\n` in the read buffer.

---

### 2.6 Standard MCP tool shape

**Source:** `src/mcp/tools/abort-run.ts:21-76`.

```ts
export function registerXxxTool(): void {
  registerTool({
    name: "bober_xxx",
    description: "...",
    inputSchema: {
      type: "object",
      properties: { /* JSON Schema */ },
      required: ["..."],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      // 1. Validate REQUIRED args → throw McpError(ErrorCode.InvalidRequest, ...)
      // 2. Look up / mutate state via a singleton
      // 3. Return JSON.stringify(result, null, 2)
      // SOFT errors (not-found, not-active) → return JSON.stringify({ error: "..." })
    },
  });
}
```

**Rule:** Hard errors (missing/empty required arg) throw `McpError`. Domain errors (not-found, wrong-state) return JSON `{ error: "..." }`. Always `JSON.stringify(x, null, 2)`.

---

### 2.7 Stderr-only diagnostic output

**Source:** `src/mcp/server.ts:7,68-72,112-116,182,187`.

```ts
process.stderr.write(`[agent-bober mcp] message\n`);
```

**Rule:** Inside `src/mcp/**`, NEVER use `console.log`, `console.info`, or `logger.info` / `logger.success`. Use `process.stderr.write` directly. The MCP stdio transport owns stdout. `logger.warn` goes to console.warn → stderr → technically safe, but the explicit `process.stderr.write` pattern matches server.ts and is clearer.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `runManager` (singleton) | `src/mcp/run-manager.ts:247` | `RunManager` | The pattern your EventStreamManager-singleton should mirror. |
| `RunManager.getRun(id)` | `src/mcp/run-manager.ts:86-88` | `(runId: string) => RunState \| null` | Use to validate a subscribe's runId exists, if you choose to (contract does NOT require runId-must-exist; subscribing to an unknown runId returns a subscription that just never fires). |
| `registerTool` | `src/mcp/tools/registry.ts:45-47` | `(tool: BoberToolDefinition) => void` | Register the two new tools via this. |
| `BoberToolDefinition` type | `src/mcp/tools/registry.ts:26-35` | interface | Use for the new tool shape. |
| `ensureDir` | `src/state/helpers.ts:6-8` | `(dirPath: string) => Promise<void>` | If you need to create `.bober/telemetry/`. Sprint 3 should NOT create it (read-only), but useful for test fixtures. |
| `fileExists` | `src/utils/fs.ts:10-17` | `(path: string) => Promise<boolean>` | Use to gate "telemetry file exists yet?" before opening a watcher. |
| `loadConfig` | `src/config/loader.ts` (already imported in server.ts:23) | `(projectRoot: string) => Promise<BoberConfig>` | Use to read `pipeline.eventQueueBound`. |
| `logger` | `src/utils/logger.ts:87` | `Logger` | AVOID inside src/mcp/** — use `process.stderr.write` instead. |
| `appendOneLine` pattern | `src/incident/timeline.ts:67-82` | private fn | The INVERSE of what you need; cited in generatorNotes. For the reader side, mirror its structure but use `fs.read` from offset. |
| `appendHistory` | `src/state/history.ts:51-68` | `(projectRoot, entry) => Promise<void>` | Useful for test fixtures (write a history line, expect notification). Or use raw `appendFile` from `node:fs/promises`. |
| `EventStreamManager` | DOES NOT EXIST — create it | — | (placeholder so future briefings find this) |

**Critical "do not recreate":**
- The drop-oldest queue logic in `hook-handler.ts:69-97` is the canonical pattern — copy its shape, do NOT reinvent.
- The per-key Promise-chain mutex in `timeline.ts:52` + `audit.ts:82` is the canonical pattern — re-use.

---

## 4. Prior Sprint Output

### Sprint 1 (cockpit-integration): Multi-run RunManager + disk persistence

**Created/modified:**
- `src/mcp/run-manager.ts` — `RunState { runId, projectRoot, specId?, ... }`, `RunManager.startRun → runId`, `RunManager.load(projectRoot)`.
- `src/state/run-state.ts` — `writeRunState`, `readRunState`, `listRunStateFiles` for `.bober/runs/<runId>/state.json`.

**Connection to this sprint:**
- `runId` is the key the cockpit will subscribe to.
- `runManager.load(projectRoot)` is already called in `src/mcp/server.ts:66`. Your `initEventStream` call goes AFTER `server.connect(transport)` (line 179), not in the same try-block.
- You do NOT need to coordinate with `RunState`; events flow independently. If a subscribe-events caller passes an unknown runId, just register the subscription — it simply never fires until a writer eventually emits a line with that runId.

### Sprint 2 (cockpit-integration): list/get/abort run tools

**Created:**
- `src/mcp/tools/list-active-runs.ts` (registerListActiveRunsTool)
- `src/mcp/tools/get-run-status.ts` (registerGetRunStatusTool)
- `src/mcp/tools/abort-run.ts` (registerAbortRunTool)
- Added `RunManager.listAllRuns()`, `RunState.status` widened with `"aborted"`, fields `abortedAt`, `abortReason`.

**Connection to this sprint:**
- Tool-shape template: copy from `abort-run.ts` for `subscribe-events.ts` and `unsubscribe-events.ts`.
- Tool registration ordering: append your two registers AFTER `registerAbortRunTool()` in `src/mcp/tools/index.ts:73-76`.
- Test fixtures: copy the `mkdtemp` + `runManager.runs.clear()` pattern from `list-active-runs.test.ts:70-78`.

---

## 5. Relevant Documentation

### Project Principles

`/Users/bober4ik/agent-bober/.bober/principles.md` exists. Key points relevant here (read the file in full before starting):
- Append-only event logs are sacred (don't rewrite history.jsonl).
- stdio safety in MCP context — diagnostic output to stderr only.
- Tests live colocated next to source for `src/`, separate `tests/` dir only for cross-cutting integration tests.
- Use `node:` prefix on built-in module imports (project uses ESM).

### Architecture Decisions

Check `/Users/bober4ik/agent-bober/.bober/architecture/` for ADRs touching MCP server boundaries. The graph subsystem has ADRs (mentioned in `src/config/schema.ts:192` as "ADR-9"). Read any ADR concerning multi-run or cockpit boundaries.

### Other Docs

- `src/mcp/server.ts:6-8` — module header explicitly states the stdout reservation.
- `src/telemetry/emit.ts:11-19` — privacy + network-egress prohibitions (your event-stream reads telemetry events; the read side has no privacy implications because cockpit-bound recipients are local).
- `nonGoals` of the sprint contract — re-read them after writing code: NO chokidar unless justified, NO persistence of subscriptions, NO modifying the writers, NO cross-runId broadcast.

---

## 6. Testing Patterns

### Unit Test Pattern

**Source:** `src/mcp/tools/abort-run.test.ts:1-80` and `src/mcp/tools/list-active-runs.test.ts:1-100`.

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { registerSubscribeEventsTool } from "./subscribe-events.js";
import { getTool } from "./registry.js";

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-subscribe-test-"));
  registerSubscribeEventsTool();
  // Reset the EventStreamManager singleton between tests
  // (cast to access private; mirror runManager pattern from list-active-runs.test.ts:76)
});
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

it("is registered with the correct name", () => {
  expect(getTool("bober_subscribe_events")).toBeDefined();
});
```

**Runner:** vitest
**Assertion style:** `expect(...).toBe()` / `.toMatchObject()` / `.toHaveBeenCalled()`
**Mock approach:** `vi.fn()` + `vi.mock()` (see `external-client.test.ts:24-38` for SDK mocking)
**File naming:** `<source>.test.ts` colocated in same directory
**Location:** colocated next to source (`src/mcp/event-stream.test.ts`, NOT `tests/mcp/`)

**Singleton-reset pattern (from `list-active-runs.test.ts:76`):**

```ts
// Reset the singleton's internal state to isolate tests
(runManager as unknown as { runs: Map<string, unknown> }).runs.clear();
```

For EventStreamManager, the analog is constructing a NEW manager per-test (you control the constructor) rather than mutating the late-bound module singleton. Prefer constructing `new EventStreamManager(srv, tmpDir)` directly in unit tests — avoid `initEventStream` entirely. Only the integration smoke test should use the late-bound singleton.

### Integration Test Pattern (for stopConditions[3])

**Source:** `tests/mcp/external-server-graph.test.ts:1-133` — module-import-based, NOT subprocess-spawn (note: that file does NOT actually spawn a subprocess — it imports `registerAllTools` and asserts in-process).

For the JSON-RPC integration smoke (stopConditions[3] — "subscribe via JSON-RPC, append a line, verify a bober/events notification received within 1 second"), the closest existing pattern is `src/mcp/external-client.test.ts:24-50` which uses mocked `Client` and `StdioClientTransport`. A real integration test that spawns the server as a subprocess and connects via `StdioClientTransport` does NOT yet exist in this repo. For this sprint, your options (in order of preference):

1. **In-process integration test (recommended):** Wire a fake transport pair (input/output streams) between a real `Server` instance and a real `Client` instance, both in the same process. The SDK supports this via `InMemoryTransport` — but check if it's exported; if not, use `Duplex.from` shim or just construct both sides with `StdioClientTransport` + spawned subprocess.

2. **Subprocess spawn (matches the contract's "integration smoke"):** Spawn `node dist/cli.js mcp` or equivalent as a child, attach a `StdioClientTransport`, perform `tools/call bober_subscribe_events`, append to history.jsonl in `projectRoot`, listen for the notification on the Client side via `client.setNotificationHandler(...)`. This is the canonical test for "use REAL server-initiated notifications." Search `node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.d.ts` for `setNotificationHandler` to find the client-side counterpart.

**Where to put it:** `tests/mcp/event-stream-smoke.test.ts`. The directory `tests/mcp/` already exists.

### E2E Test Pattern

Not applicable — no Playwright in this sprint.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break

| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/mcp/tools/tools.test.ts` | `src/mcp/tools/index.ts` exports `registerAllTools` returning N tools | high | Asserts `toBe(20)` at line 12 — must become 22. Asserts expected name list at lines 18-39 — must add 2 names. |
| `tests/mcp/external-server-graph.test.ts` | Same as above (20-base, +6 graph = 26) | high | Asserts 20/26 at lines 38, 47, 48, 58, 59, 110. Must become 22/28. |
| `src/mcp/server.ts` | `loadConfig(projectRoot)` happy path | medium | Adding a second `loadConfig` call inside the try-block is safe; the existing graph-block already pattern-matches this. |
| Any test file constructing a `BoberConfig` literal | `PipelineSectionSchema` shape | low | After adding `eventQueueBound: z.number().int().min(1).default(1000)`, the OUTPUT type makes the field required. Search `grep -rn 'pipeline: {' src/ tests/` — `src/mcp/tools/list-active-runs.test.ts:38-44` and `src/mcp/tools/abort-run.test.ts:40-44` build literal pipeline objects; TypeScript MAY complain depending on whether the test casts to `BoberConfig` directly. Fix by adding `eventQueueBound: 1000` to these literals if typecheck fails. |
| `.bober/runs/<runId>/state.json` files | RunState shape unchanged | low | No change to RunState in this sprint. |

### Existing Tests That Must Still Pass

- `src/mcp/tools/tools.test.ts` — count/name assertions (update required).
- `tests/mcp/external-server-graph.test.ts` — count/name assertions (update required).
- `src/mcp/run-manager.test.ts` — RunManager state machine (no change expected).
- `src/state/run-state.test.ts` — disk persistence (no change expected).
- `src/mcp/tools/list-active-runs.test.ts`, `get-run-status.test.ts`, `abort-run.test.ts` — Sprint 2 tools (no change expected).
- `src/mcp/external-client.test.ts` — SDK Client mocks (no change expected).
- `src/telemetry/emit.ts` and its test (no change — we are read-side only).
- `src/state/history.ts` and `loadHistory` callers (no change — we are read-side only).

### Features That Could Be Affected

- **Cockpit Integration sprint 4-6** — they will depend on the EventStreamManager + the two new tools. Keep the public surface (subscribe / unsubscribe / shutdown) minimal and stable.
- **Telemetry (Sprint 28)** — your watcher reads `.bober/telemetry/<date>.jsonl`. Verify `src/telemetry/emit.ts` still writes ONE line per emit and that you parse those lines successfully (telemetry events have `runId` at the TOP LEVEL, not inside `details` — see `src/telemetry/emit.ts:42-55`).
- **Incident timeline subsystem** — not directly impacted; you don't watch incident jsonl files (nonGoals[3]).
- **bober_run / bober_status / bober_list_active_runs** — no impact.

### Recommended Regression Checks

After implementation, run (in order):

1. `npm run typecheck` — MUST pass. Catches missing `eventQueueBound` in test fixtures.
2. `npm run lint` — MUST pass. Watch for unused imports / `any` casts in the SDK Server type workaround.
3. `npm run build` — MUST pass.
4. `npm run test -- src/mcp/event-stream.test.ts` — your new unit tests.
5. `npm run test -- src/mcp/tools/subscribe-events.test.ts src/mcp/tools/unsubscribe-events.test.ts` — your new tool tests.
6. `npm run test -- src/mcp/tools/tools.test.ts tests/mcp/external-server-graph.test.ts` — verify count assertions updated.
7. `npm run test` — full suite. Sprint passes ONLY if total green.
8. Manually test stopConditions[2]: write a small node script that appends 2000 lines to a tmpdir's `.bober/history.jsonl` after subscribing — assert 1000 delivered + 1 dropped.
9. Manually verify no resource leak: in your sub/unsub-50x test, log `mgr.fileWatches.size` after teardown — must be 0.

---

## 8. Implementation Sequence

Execute in dependency order. Verify after each step.

1. **`src/config/schema.ts`** — Add `eventQueueBound: z.number().int().min(1).default(1000)` to `PipelineSectionSchema` and to the `createDefaultConfig` seed.
   - Verify: `npm run typecheck` passes; `src/config/loader.ts` callers still work.

2. **`src/mcp/event-stream.ts`** — Implement `EventStreamManager` class + `initEventStream` / `getEventStream` exports. Inside the class: `subscribe()`, `unsubscribe()`, `shutdown()`, private `openWatch()`, `onFileEvent()`, `deliver()`, `flush()`.
   - Verify: file imports cleanly (`tsc --noEmit src/mcp/event-stream.ts` or equivalent). No tests yet.

3. **`src/mcp/event-stream.test.ts`** — Write unit tests for all 7 scenarios (table in §1). Use a `FakeServer` with `vi.fn()` notification; use `mkdtemp` for `projectRoot`.
   - Verify: `npm run test -- src/mcp/event-stream.test.ts` all green.

4. **`src/mcp/tools/subscribe-events.ts`** + **`subscribe-events.test.ts`** — Tool wrapper around `getEventStream().subscribe(runId, opts)`.
   - Verify: tool registers; handler validates `runId`; returns JSON.

5. **`src/mcp/tools/unsubscribe-events.ts`** + **`unsubscribe-events.test.ts`** — Tool wrapper around `getEventStream().unsubscribe(subscriptionId)`.
   - Verify: soft-error JSON on unknown subscriptionId; McpError on missing arg.

6. **`src/mcp/tools/index.ts`** — Import + register both new tools in `registerAllTools()`; update docstring (20 → 22).
   - Verify: `getAllTools().length === 22`.

7. **`src/mcp/tools/tools.test.ts`** — Update count to 22 + add 2 names to expected array.

8. **`tests/mcp/external-server-graph.test.ts`** — Update 20→22 and 26→28 at lines 38, 47, 48, 58, 59, 110.
   - Verify: `npm run test -- src/mcp/tools/tools.test.ts tests/mcp/external-server-graph.test.ts` all green.

9. **`src/mcp/server.ts`** — Add `initEventStream` import; call `initEventStream(server, projectRoot, queueBound)` after `await server.connect(transport)`; call `getEventStream().shutdown()` in `shutdown()`.
   - Verify: server still boots; `bober_subscribe_events` callable via in-process tools/call test.

10. **`tests/mcp/event-stream-smoke.test.ts`** (NEW — for stopConditions[3]) — In-process or subprocess integration test that subscribes, appends a line, and asserts a `bober/events` notification within 1s.
    - Verify: `npm run test -- tests/mcp/event-stream-smoke.test.ts` passes.

11. **`CHANGELOG.md`** — Add an Unreleased entry describing the new tools, the manager, the config field. Mirror past sprint entries (look at the most recent few entries for style).

12. **Run full verification** —
    ```
    npm run typecheck && npm run lint && npm run build && npm run test
    ```
    All four must exit 0.

---

## 9. Pitfalls & Warnings

- **DO NOT** use `logger.info` / `logger.success` from `src/mcp/event-stream.ts` or the new tool files — they write to stdout and corrupt the MCP JSON-RPC stream. Use `process.stderr.write` (`src/mcp/server.ts:182` is the canonical example).

- **DO NOT** call `initEventStream` at module-load time. The `Server` instance only exists after `new Server(...)` + `await server.connect(transport)` in `src/mcp/server.ts`. Call it AFTER `server.connect`.

- **DO NOT** attempt to use `sendLoggingMessage`. It requires `capabilities.logging` to be declared, which the bober server does NOT declare (only `tools: {}` at `src/mcp/server.ts:126-128`). Use the generic `server.notification({ method: "bober/events", params })` — custom method names pass the SDK's `assertNotificationCapability` default case (`server/index.js:173-207`).

- **DO NOT** swallow `JSON.parse` errors silently AND skip the line — that's correct behavior for malformed lines, BUT make sure to also handle the partial-line case at end-of-read separately (keep `partialLine` buffer per FileWatch). Otherwise the LAST line of a mid-append read will be discarded permanently.

- **DO NOT** open a new `fs.watch` per subscription. Open one per unique file path (`.bober/history.jsonl`, current `.bober/telemetry/<date>.jsonl`), share via refcount. The contract sc-3-5 specifically tests "subscribe + unsubscribe 50× → no watcher leak." This means: when the LAST subscription for a given file is removed, you MUST call `watcher.close()` and delete the FileWatch map entry. Use a `refCount` field.

- **DO NOT** assume `.bober/telemetry/` exists. It's lazily created by `src/telemetry/emit.ts:87`. Either check + skip (no current telemetry → no watcher yet), OR watch the parent `.bober/` and add the telemetry watcher when the file first appears. The contract assumption (#2) says: "the watcher must detect file creation for new-date files, not just appends to the current file." Cleanest approach: poll a small `setInterval` (e.g., every 5s, `unref()`'d) that checks for `<today>.jsonl` and rotates the watcher when the date changes.

- **DO NOT** add chokidar unless you hit a documented platform issue (nonGoals[2]). Node's `fs.watch` works on macOS + Linux for append-only JSONL files. If you DO add chokidar, justify it in the commit message AND in CHANGELOG.

- **DO NOT** persist subscriptions to disk (nonGoals[0]). Subscriptions are in-process only. On server restart the cockpit re-subscribes.

- **DO NOT** modify `src/state/history.ts` or `src/telemetry/emit.ts` (nonGoals[4]). This sprint is read-side only. If you find yourself needing a writer change, you're out of scope — stop and re-read the nonGoals.

- **DO NOT** broadcast events without a runId (sc-3-6). Lines whose runId cannot be extracted (top-level OR `details.runId`) are silently skipped, even if a subscription exists for ANY runId.

- **DO NOT** trust that `fs.watch` will fire exactly once per append. On macOS, an append often produces multiple `change` events. Your `onFileEvent` handler must be idempotent: read from the recorded offset, advance the offset by exactly the number of bytes consumed, ignore re-reads of the same range (they will produce zero new lines).

- **DO NOT** await `server.notification(...)` inside the `fs.watch` callback synchronously without a Promise-chain serializer for the file. Out-of-order delivery is a likely failure mode if the watcher fires twice quickly. Use the per-file Promise chain from §2.3.

- **DO NOT** read the entire file on every watch event. Use `fs.open` + `fs.read` from the recorded `offset` (or `readFile` with `position` not supported — use the lower-level `fs.read` API) so that 2000-line files don't get re-read on every append.

- **DO NOT** forget to call `watcher.unref()` if you want to allow Node to exit naturally on SIGINT. Match the `src/graph/hook-handler.ts:60-61` precedent.

- **VERIFY**: the `Server` type's `notification(...)` typing may complain about the custom method string. If TypeScript yells, declare a narrow interface for the parameter object and pass it (don't widen to `as any`). Example: `interface BoberNotification { method: string; params: Record<string, unknown> }` then cast `as unknown as ServerNotification` at the call site — keep the cast localized and commented.

- **VERIFY**: the integration smoke test (stopConditions[3]) MUST use the REAL server-initiated notification path, not a mock. Otherwise the evaluator will flag (per evaluatorNotes) that the test does not prove the contract. Spawn the server (or wire a real in-memory Server+Client pair) and assert on a `client.setNotificationHandler` callback receiving the notification.

