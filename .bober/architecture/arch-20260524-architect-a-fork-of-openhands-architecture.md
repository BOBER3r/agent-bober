# Architecture: Fork of OpenHands with Claude Code Runtime and agent-bober UI Integration

**Architecture ID:** arch-20260524-architect-a-fork-of-openhands
**Generated:** 2026-05-24T00:00:00Z
**Status:** draft

---

## Executive Summary

This architecture forks `All-Hands-AI/OpenHands` into a downstream product that adds Claude Code CLI as a zero-key first-run agent runtime and surfaces the agent-bober sprint pipeline directly in the OpenHands UI. The chosen approach is a **Sidecar Plane**: a new Python sub-package (`openhands_bober/`) mounted at `/api/v1/bober/*` plus a dedicated `/ws/claude/:conversationId` WebSocket, paired with a new frontend feature tree at `frontend/src/bober/`. All upstream-file edits are confined to three additive insertions (one FastAPI `include_router`, one React Router `route()`, one conversation-tab descriptor). The Python sidecar spawns Claude Code as a PTY per conversation and shells out to the agent-bober CLI for sprint operations, observing `.bober/` via a filesystem watcher so artifacts remain byte-identical between UI- and CLI-driven runs. The primary risk is upstream restructuring of the three insertion points; mitigation is documented line anchors and a planned upstream tab-registry PR.

---

## Problem Statement

**Problem:** First-run friction in OpenHands requires the user to configure an LLM provider and API key before any agent can act, and there is no path to drive `agent-bober` (a separate CLI/MCP harness) from inside the OpenHands UI — preventing a unified, key-less, multi-agent product experience.

**Constraints:**
- Latency: <100ms p95 keystroke→render WS round-trip; <500ms p95 HTTP control-plane. Claude Code first-token bounded by upstream CLI.
- Throughput: v1 single-developer local — 1-5 concurrent conversations, each one Claude PTY + at most one bober sprint subprocess.
- Data volume: xterm default scrollback ~1000 lines; bober artifacts capped via `bober.config.json:51` `sprint.maxSprints:10`.
- Cost ceiling: Claude Code default mode bills the user's pre-auth Claude account; fallback OpenHands path keeps upstream LiteLLM cost model.
- Backward compatibility: `openhands/app_server/settings/settings_router.py`, `frontend/src/routes/llm-settings.tsx`, conversation routes (`frontend/src/routes.ts:41`), socket.io path `/socket.io` MUST keep wire contract.

**Consumers:** Interactive developer using forked UI on :3000; agent-bober CLI (`/Users/bober4ik/agent-bober/dist/cli/index.js`) and MCP server standalone; Claude Code CLI binary (external); downstream agent-bober consumers (Cursor, Windsurf, raw MCP) reading/writing `.bober/` per Zod schemas at `src/contracts/index.ts:1-47`.

**Success Criteria:**
1. Zero-key first-run: user without LLM keys launches UI, starts conversation, Claude Code responds in embedded terminal in <60s, no settings page visited.
2. Fallback intact: upstream `/settings/` route still provisions LiteLLM provider and runs upstream agent loop end-to-end.
3. Bober pipeline from UI: sprint kicked off via UI produces byte-identical `.bober/specs/*.json`, `.bober/handoffs/*.md`, `.bober/eval-results/*.json` as CLI invocation.
4. Merge-safety: `git fetch upstream && git merge upstream/main` produces zero conflicts in `v1_router.py`, `settings/`, `routes.ts`, `conversation.tsx`, `root-layout.tsx`, `conversation-subscriptions-provider.tsx` for typical upstream PRs.

**Locked Dependencies:** Claude Code CLI binary contract (argv/stdin/stdout/exit codes) — external; agent-bober Zod schemas (`SprintContractSchema`, `PlanSpecSchema`, `EvalResultSchema`) — frozen; OpenHands upstream API surface — additive only; agent-bober principles (ESM, provider-agnostic, Zod, FS-state in `.bober/`); frontend deps floor (React 19, React Router 7, Vite 7, Tailwind 4, Zustand 5, socket.io-client 4.8.3, xterm v6, `@xterm/addon-fit` 0.11).

---

## System Overview

The fork runs as the unmodified OpenHands FastAPI process with one extra sub-router mounted at `/api/v1/bober/*` and one extra WebSocket route at `/ws/claude/:conversationId`. All sidecar logic lives in a new Python package `openhands_bober/`; the package is wired into the existing application by exactly one `include_router(bober_router)` line added to `openhands/app_server/v1_router.py`. The sidecar owns three runtime concerns: (a) a **ClaudePtySupervisor** that spawns one `claude` CLI process per conversation under a PTY and proxies bytes to the browser xterm over a binary WebSocket; (b) a **BoberPipelineDriver** that invokes the agent-bober Node CLI as a fresh one-shot subprocess per sprint; (c) an **ArtifactWatcher** that observes `.bober/` via watchdog and emits debounced change events on a single Server-Sent Events stream.

The frontend mounts a new React route `/bober/conversations/:conversationId` in `frontend/src/bober/`, registered via one entry in `frontend/src/routes.ts` and surfaced via one tab descriptor appended to `conversation-tabs.tsx`. The route renders a 3-region layout (sprint-control panel, embedded xterm terminal, status bar), backed by a Zustand store that hydrates from REST and is invalidated by SSE artifact events. The upstream `/settings/` route, socket.io path, and conversation runtime are untouched and remain the fallback for non-Claude flows. The `.bober/` filesystem tree is the single cross-runtime source of truth — UI runs and headless CLI runs produce byte-identical artifacts because the UI path always shells out to the same Node CLI binary.

---

## Component Breakdown

### BoberRouter
**Responsibility:** Single FastAPI APIRouter exposing all `/api/v1/bober/*` REST endpoints, the `/ws/claude/:conversationId` WebSocket, and the `/api/v1/bober/events` SSE stream.
```typescript
interface BoberRouter {
  mountInto(app: FastAPIApp): void;
}
```
**Dependencies:** [ClaudePtySupervisor, BoberPipelineDriver, ArtifactReader, ArtifactWatcher, ClaudeHealthCheck]

### ClaudePtySupervisor
**Responsibility:** Owns one Claude Code PTY child per conversationId and multiplexes stdin/stdout/resize/kill.
```typescript
interface ClaudePtySupervisor {
  spawn(conversationId: string): Promise<PtyHandle>;
  write(conversationId: string, bytes: Uint8Array): void;
  resize(conversationId: string, cols: number, rows: number): void;
  kill(conversationId: string, signal?: string): void;
  onOutput(conversationId: string, cb: (bytes: Uint8Array) => void): Disposable;
  onExit(conversationId: string, cb: (code: number) => void): Disposable;
  get(conversationId: string): PtyHandle | null;
}
```
**Dependencies:** []

### BoberPipelineDriver
**Responsibility:** Invokes the agent-bober CLI as a one-shot subprocess per operation; reports lifecycle and exit state only.
```typescript
interface BoberPipelineDriver {
  runPlan(specId: string): Promise<{pid: number; runId: string}>;
  runSprint(specId: string, sprintId: string): Promise<{pid: number}>;
  status(runId: string): RunStatus;
  cancel(runId: string): Promise<void>;
  onLog(runId: string, cb: (line: string) => void): Disposable;
  onExit(runId: string, cb: (code: number) => void): Disposable;
}
```
**Dependencies:** []

### ArtifactReader
**Responsibility:** Loads `.bober/*.json` from disk and validates each file via Pydantic mirrors of the frozen Zod schemas.
```typescript
interface ArtifactReader {
  readPlanSpec(specId: string): Promise<PlanSpec>;
  readSprintContract(sprintId: string): Promise<SprintContract>;
  readEvalResults(sprintId: string): Promise<EvalResult[]>;
  readHandoff(handoffId: string): Promise<HandoffMarkdown>;
  list(kind: ArtifactKind): Promise<ArtifactSummary[]>;
}
```
**Dependencies:** [BoberDataStore]

### ArtifactWatcher
**Responsibility:** Watches `.bober/{specs,sprints,handoffs,eval-results}/` via watchdog with 100ms debounce and `on_moved` atomic-rename detection.
```typescript
interface ArtifactWatcher {
  start(): void;
  stop(): void;
  subscribe(cb: (event: ArtifactEvent) => void): Disposable;
}
```
**Dependencies:** [BoberDataStore]

### ClaudeHealthCheck
**Responsibility:** Detects whether `claude` is on PATH, its version, and pre-authentication state.
```typescript
interface ClaudeHealthCheck {
  probe(): Promise<ClaudeHealth>;
  isInstalled(): Promise<boolean>;
  isAuthenticated(): Promise<boolean>;
}
type ClaudeHealth = {installed: boolean; binaryPath: string|null; version: string|null; authenticated: boolean; authMethod: "subscription"|"api-key"|null; detail: string};
```
**Dependencies:** []

### BoberRouteComponent
**Responsibility:** Renders `/bober/conversations/:conversationId` with a 3-region layout (sprint-control left, terminal right, status bottom).
```typescript
interface BoberRouteComponent {
  loader(args: {params: {conversationId: string}}): Promise<{health: ClaudeHealth; specs: PlanSpec[]}>;
  Component(): JSX.Element;
}
```
**Dependencies:** [SprintControlPanel, ClaudeTerminalPane, BoberStore]

### ClaudeWebSocketHook
**Responsibility:** Connects to `/ws/claude/:conversationId`; emits binary stdin out, decodes binary stdout + JSON control frames in.
```typescript
interface ClaudeSocket {
  state: "connecting"|"open"|"closed"|"error";
  sendInput(bytes: Uint8Array): void;
  sendResize(cols: number, rows: number): void;
  onData(cb: (bytes: Uint8Array) => void): Disposable;
  close(): void;
}
function useClaudeSocket(conversationId: string): ClaudeSocket;
```
**Dependencies:** []

### ClaudeTerminalPane
**Responsibility:** Mounts xterm v6 + addon-fit, wires keystrokes and ResizeObserver to the ClaudeSocket.
```typescript
interface ClaudeTerminalPaneProps { conversationId: string }
function ClaudeTerminalPane(props: ClaudeTerminalPaneProps): JSX.Element;
```
**Dependencies:** [ClaudeWebSocketHook]

### BoberStore
**Responsibility:** Zustand 5 store holding specs, sprints, evalResults, activeSpecId, activeSprintId, and health.
```typescript
interface BoberStore {
  specs: Record<string, PlanSpec>;
  sprints: Record<string, SprintContract>;
  evalResults: Record<string, EvalResult[]>;
  activeSpecId: string|null;
  activeSprintId: string|null;
  health: ClaudeHealth|null;
  hydrate(): Promise<void>;
  setActiveSpec(id: string): void;
  setActiveSprint(id: string): void;
  applyArtifactEvent(event: ArtifactEvent): void;
  startSprint(specId: string): Promise<StartSprintResponse>;
}
```
**Dependencies:** [BoberApiClient, BoberSseHook]

### SprintControlPanel
**Responsibility:** Renders the spec list, active sprint status, and the Start Sprint button; dispatches via BoberStore.
```typescript
function SprintControlPanel(): JSX.Element;
```
**Dependencies:** [BoberStore]

### BoberTabIntegration
**Responsibility:** Exports the single tab descriptor inserted into `conversation-tabs.tsx` (the only upstream insertion point on the frontend).
```typescript
export const boberTabDescriptor: TabDescriptor;
```
**Dependencies:** []

### BoberDataStore
**Responsibility:** On-disk `.bober/` tree using temp-write + atomic-rename for terminal-state immutability; `history.jsonl` is append-only NDJSON.
*(Pure data — no methods.)*
**Dependencies:** []

---

## Data Model

```typescript
// On-disk layout (BoberDataStore)
// .bober/
//   specs/<specId>.json          PlanSpec
//   sprints/<sprintId>.json      SprintContract (atomic-rename on terminal state)
//   eval-results/<sprintId>/<n>.json  EvalResult
//   handoffs/<handoffId>.md      HandoffMarkdown
//   history.jsonl                append-only NDJSON

type ArtifactKind = "spec" | "sprint" | "eval" | "handoff";
type ArtifactOp = "created" | "modified" | "deleted" | "moved";

type ArtifactEvent = {
  kind: ArtifactKind;
  op: ArtifactOp;
  id: string;
  payload?: PlanSpec | SprintContract | EvalResult | null;
};

type StartSprintRequest = { specId: string };
type StartSprintResponse = { sprintId: string; pid: number; startedAt: string };

type WsClientMessage =
  | { type: "resize"; cols: number; rows: number }
  | { type: "signal"; signal: "SIGINT" | "SIGTERM" };

type WsServerMessage =
  | { type: "exit"; code: number }
  | { type: "error"; code: string; message: string };

type ClaudeHealth = {
  installed: boolean;
  binaryPath: string | null;
  version: string | null;
  authenticated: boolean;
  authMethod: "subscription" | "api-key" | null;
  detail: string;
};
```
PlanSpec / SprintContract / EvalResult shapes are imported verbatim from the Zod schemas at `/Users/bober4ik/agent-bober/src/contracts/index.ts:1-47` and mirrored as Pydantic models in `openhands_bober/artifacts/models.py`.

---

## API Contracts

| Endpoint | Input | Output | Error Cases |
|---|---|---|---|
| GET /api/v1/bober/health | — | `{claudeOnPath, version, preAuth, boberCliVersion}` | 503 FS unreachable |
| GET /api/v1/bober/specs | — | `{specs: PlanSpec[]}` | 422 partial validation; 500 IO |
| GET /api/v1/bober/specs/{specId} | path | PlanSpec | 404; 400 regex; 422 |
| GET /api/v1/bober/sprints | — | `{sprints}` | 422 partial; 500 IO |
| GET /api/v1/bober/sprints/{sprintId} | path | SprintContract | 404; 400; 422 |
| GET /api/v1/bober/sprints/{sprintId}/evals | path | `{evals}` | 404; 400 |
| POST /api/v1/bober/sprints | `{specId}` | 202 `{sprintId, pid, startedAt}` | 400; 404 spec; 409 already running; 500 spawn |
| DELETE /api/v1/bober/sprints/{sprintId} | path | 204 | 404; 409 terminal; 500 SIGKILL fail |
| GET /api/v1/bober/events | Last-Event-ID? | text/event-stream | 503 watcher down |
| WS /ws/claude/{conversationId} | binary stdin / JSON control | binary stdout / JSON status | close 1008 bad id, 1011 spawn fail, 1013 claude missing |

**WS client→server control:** `{type:"resize", cols, rows}`, `{type:"signal", signal}`.
**WS server→client status:** `{type:"exit", code}`, `{type:"error", code, message}`.
**SSE frame:** `event: artifact\nid: <monotonic>\ndata: {kind, op, id, payload}\n\n` plus a 15s keep-alive comment frame.

---

## Integration Strategy

### Data Flow — Zero-key first-run
```
Browser → /bober/conversations/new
  → BoberRouteComponent.loader
    → GET /api/v1/bober/health    (ClaudeHealthCheck.probe)
    → GET /api/v1/bober/specs     (ArtifactReader.list)
  → BoberStore.hydrate
  → ClaudeTerminalPane mounts xterm
    → ClaudeWebSocketHook → WS /ws/claude/:id (binary frames)
      → BoberRouter → ClaudePtySupervisor.spawn → claude CLI under PTY
  → keystroke loop: xterm onData → WS binary → PTY stdin
                    PTY stdout → WS binary → xterm.write(Uint8Array)
```

### Data Flow — Start sprint (fire-and-observe per ADR-6)
```
UI click → BoberStore.startSprint(specId)
  → POST /api/v1/bober/sprints {specId}
    → ProcessRegistry.reserve(sprintId, asyncio.Lock per specId)
    → BoberPipelineDriver.runSprint → subprocess.Popen(node dist/cli/index.js sprint --spec --sprint-id)
  → 202 {sprintId, pid, startedAt}     (HTTP returns <500ms)
CLI → writes .bober/sprints/<id>.json via temp+atomic-rename
  → ArtifactWatcher.on_moved → 100ms debounce
    → SSE emit {kind:"sprint", op:"modified", id, payload}
      → BoberStore.applyArtifactEvent → React re-render
```

### Data Flow — PTY resize
ResizeObserver → addon-fit.fit() → xterm.resize → WS JSON `{type:"resize",cols,rows}` → ClaudePtySupervisor.resize → `fcntl.ioctl(pty_fd, TIOCSWINSZ, …)` → kernel SIGWINCH to Claude.

### Consistency Model
- **PTY WS** = strict in-order byte stream guaranteed by kernel pipe; 1MB backpressure buffer; overflow → close 1009 → client reconnect rebuilds from xterm screen cache.
- **`.bober/` via SSE** = **eventual**, bounded by 100ms debounce + flush; REST snapshots are lower bound, SSE is authoritative; atomic-rename guarantees no torn reads.
- **REST control plane** = **strong** req/response; POST /sprints serializes via `asyncio.Lock` keyed on specId; ProcessRegistry is in-memory truth for active pids; backend restart rebuilds it from disk and reclassifies orphan in-progress sprints as failed.

### Source-of-truth Matrix
| Concern | Authority | Invalidator |
|---|---|---|
| spec/sprint/eval JSON | `.bober/` filesystem | SSE artifact event |
| Active sprint pids | ProcessRegistry (backend memory) | SSE exit event |
| PTY screen state | Kernel pty buffer | Full repaint on WS reconnect |
| LLM credentials | Upstream settings store | (no bober cache) |

### External Dependencies
| Service | Used By | Failure Mode | Fallback |
|---|---|---|---|
| Claude Code CLI | ClaudePtySupervisor | Missing / version incompatible | Diagnostic overlay; route to upstream /settings/llm |
| agent-bober CLI | BoberPipelineDriver | Missing / version null | Start Sprint button disabled; 5min no-heartbeat → synthetic fail |
| Host FS `.bober/` | ArtifactReader, ArtifactWatcher | Unreachable / readonly | Startup sentinel probe; `.tmp` reaper; /health 503 |
| Host OS PTY | ClaudePtySupervisor | Alloc fail; Windows out of scope v1 | WS close 1011; fall back to upstream OpenHands flow |

---

## Architecture Decision Records

- [ADR-1: Sidecar Plane Over Upstream Agent Adapter](.bober/architecture/arch-20260524-architect-a-fork-of-openhands-adr-1.md)
- [ADR-2: CLI-subprocess + filesystem watching for Python<->Node boundary](.bober/architecture/arch-20260524-architect-a-fork-of-openhands-adr-2.md)
- [ADR-3: Pydantic mirrors of the frozen Zod contract schemas](.bober/architecture/arch-20260524-architect-a-fork-of-openhands-adr-3.md)
- [ADR-4: Raw binary WebSocket frames for Claude PTY, JSON only for control](.bober/architecture/arch-20260524-architect-a-fork-of-openhands-adr-4.md)
- [ADR-5: Server-Sent Events for artifact-event delivery](.bober/architecture/arch-20260524-architect-a-fork-of-openhands-adr-5.md)
- [ADR-6: Sprint-run lifecycle is fire-and-observe](.bober/architecture/arch-20260524-architect-a-fork-of-openhands-adr-6.md)
- [ADR-7: ID validation and path containment as defence-in-depth](.bober/architecture/arch-20260524-architect-a-fork-of-openhands-adr-7.md)

---

## Risk Assessment

| Risk | Severity | Owner | Mitigation |
|---|---|---|---|
| macOS FSEvents coalesces under load → missed artifact updates | high | ArtifactWatcher | 5s periodic resync events + full glob on every change |
| Docker bind-mount loses inotify → no events | high | ArtifactWatcher | Sentinel-file probe at startup + polling fallback; expose `watcherMode` in /health |
| Backend crash leaves PTY orphans | medium | ClaudePtySupervisor | Run children in process group; `os.killpg(0)` on shutdown; startup scan for ppid=1 procs by `CLAUDE_CODE_SESSION_ID` env |
| Corp proxy downgrades WS binary frames | high | ClaudeWebSocketHook | Nonce-echo binary probe; base64-over-text fallback path; expose `wsMode` in /health |
| Concurrent POST /sprints race for same specId | medium | BoberRouter | Server-generated sprintId + `asyncio.Lock` per specId + CLI `--sprint-id` override |
| CLI schema bump breaks Pydantic validation | medium | ArtifactReader | Mixed `{valid, invalid}` responses; greyed rows in UI; expose `boberCliVersion` in /health |
| Claude not pre-authenticated | high | ClaudeHealthCheck | `claude --print-auth-status` probe; show "Run `claude login`" overlay instead of mounting xterm |
| Upstream restructures `conversation-tabs.tsx` | high | BoberTabIntegration | Compile-time test asserting boberTabDescriptor present in rendered tab list; consider upstream tab-registry PR |
| Path traversal via URL ids | critical | BoberRouter, ArtifactReader | Regex `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$` at routing layer + `Path.resolve().relative_to(bober_root)` before IO (two layers per ADR-7) |
| Watchdog observer dies silently | high | ArtifactWatcher | 10s `is_alive()` heartbeat + observer restart + SSE resync + 15s SSE keep-alive |
| CLI exits non-zero before writing terminal artifact | medium | BoberPipelineDriver | Driver writes synthetic `{status:"failed", note:"exited code N…"}` via atomic-rename |
| SSE event collision across projects | low | BoberRouter | Each SSE stream filtered by conversationId on the server |

---

## Open Questions

- **Upstream tab-registry PR upstreaming:** the fork's one-line tab insertion is robust until upstream restructures `conversation-tabs.tsx` into a registry. Assumed: no upstream refactor in next 6 months. If wrong, the insertion becomes a recurring merge surface and the planned upstream PR moves from optional to required.
- **Windows PTY support:** explicitly out of scope for v1; Windows users fall back to the upstream OpenHands flow. Assumed acceptable for single-developer local target. If wrong, Windows users see no Claude pane and must use settings-based fallback.
- **Multi-user concurrent fork deployment:** ProcessRegistry is in-memory single-process. Assumed v1 single-developer local. If multi-user/remote deployment becomes a target, ProcessRegistry must move to a shared store (Redis or a coordination DB) and `.bober/` must be per-user-scoped.
