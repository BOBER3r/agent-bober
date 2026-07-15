# Architecture: agent-bober IDE/Desktop Shell

**Architecture ID:** arch-20260529-ide-desktop-shell
**Generated:** 2026-05-29T00:00:00Z
**Status:** draft

---

## Executive Summary

agent-bober ships as a custom **all-TypeScript Electron desktop app** that delivers the 7-tab orchestration console (agents, build, discuss, self, repos, ops, inbox) and runs agents **local-first** against the user's own checkout and git. The local runtime lives in the Electron **main process** (node-pty for the Claude Code PTY, `child_process` for the already-Node `agent-bober` CLI/MCP and git, chokidar for `.bober/`), and talks to the React 19 renderer over **Electron IPC** — no loopback HTTP, no Python, no OpenHands. Extensibility, the governing constraint, is delivered by a **typed in-app registry** (`registerTab/registerCommand/registerPanel`) so the solo builder adds a feature with one call in one language. The accepted tradeoffs: a greenfield TS re-implementation of runtime pieces that exist in Python today, and a hand-built Monaco 3-way merge UI in place of an embedded editor. The primary risk is cross-project event leakage under parallel multi-project use, mitigated by per-project isolation lanes (ADR-5).

---

## Problem Statement

**Problem:** agent-bober's multi-project console UX exists only as a no-build prototype (`agent-bober-ui/`, CDN React + Babel) and a partial Vite implementation (`openhands-bober/cockpit/`); there is no shippable desktop application that delivers it as a product running agents local-first on the user's own machine while editing files and resolving merge conflicts.

**Constraints:**
- Latency: keystroke→render p95 <100ms (Claude PTY); control-plane invoke p95 <500ms.
- Throughput: single developer, but explicitly parallel/multi-project — MVP target 1–5 concurrent projects, each with its own PTY + agent run, fully isolated.
- Data volume: per-project `.bober/` artifact tree; xterm scrollback ~1000 lines; artifact event ring-buffer 1000 per project.
- Cost ceiling: Claude billed to the user's pre-authenticated account (zero-key first run); no per-seat license, no cloud compute — runtime is the user's machine.
- Backward compatibility: `.bober/` artifacts must remain byte-identical to headless `agent-bober` CLI runs; the `agent-bober` Zod contract schemas and the `agent-bober mcp` stdio CLI are reused as-is.

**Consumers:** the interactive developer (primary, technical power user); the React renderer; the main-process runtime; the user's local git checkouts and `.bober/` trees; external MCP consumers (Cursor, Windsurf) reading the same artifacts.

**Success Criteria:**
1. Shippable: signed, double-click installer (≥ macOS) booting to the agents tab with zero terminal commands.
2. Local-first proof: a registered local repo runs an agent that writes byte-identical `.bober/*.json` to a headless CLI run — no cloud, no upload.
3. Editor capability: view an inline Monaco diff, edit a file, and resolve a conflict in a 3-way merge view — with no LSP/debugger/marketplace.
4. Zero-key first run: pre-authed Claude CLI, no API key → PTY output in <60s; pre-auth state shown (not a crash) when unauthenticated.
5. Parallel: ≥3 projects registered with independent live state and no cross-project event leakage.
6. Latency preserved: keystroke→render p95 <100ms and control-plane p95 <500ms, measured inside the packaged shell.
7. Design fidelity: 7-tab IA + OKLCH theming (dark/light + accent hue) preserved as the MVP baseline.

**Locked Dependencies:** custom desktop console (NOT a VS Code fork / extension / Theia); editor scope = diffs + edit + merge only; runtime = local-first on the user's machine; delivery = Electron desktop app; the `agent-bober` Node core (CLI + `mcp` stdio server + Zod schemas) and the `.bober/` on-disk layout as the cross-runtime source of truth; frontend floor — React 19, Vite 7, Tailwind 4, Zustand 5, `monaco-editor` 0.55 + `@monaco-editor/react` 4.7, `@xterm/xterm` 6 + `@xterm/addon-fit` 0.11, Node ≥22.12.

---

## System Overview

The product is a single Electron application with two process planes bound by one typed IPC contract. The **main process** is the local-first runtime: it owns the Claude Code PTY (node-pty), spawns the `agent-bober` CLI per run and a long-lived `agent-bober mcp` stdio process per project, runs argv-only `git` inside validated project roots, and watches each project's `.bober/` tree with chokidar. The **renderer** is the React 19 console, porting the prototype's OKLCH design system and 7-tab IA; it holds no authoritative state and is a pure projection of main-process state, rebuilt from main+disk on demand. The two communicate exclusively over Electron IPC (`ipcMain.handle` request/response returning `InvokeResult<T>`, and `webContents.send` pushes) — replacing the prior architecture's loopback REST+WS+SSE surface (ADR-1).

Extensibility is the spine: a typed `ConsoleRegistry` is the single in-app extension point, so new tabs/commands/panels are added by one `register*` call against a typed contract, not a plugin runtime (ADR-2). The Python `openhands_bober` sidecar and the OpenHands fork are dropped; their *patterns* (id-regex + realpath path containment, atomic-rename artifact writes, PTY supervision, per-project isolation) are ported to TypeScript, and the same `agent-bober` Node core is invoked so `.bober/` artifacts stay byte-identical to CLI runs. Parallel multi-project safety comes from per-project isolation lanes (own watcher, own monotonic `seq`, own MCP process), with every IPC push carrying a `projectId` (ADR-5).

---

## Component Breakdown

Three planes: MAIN (Node runtime), RENDERER (React UI), and the IPC CONTRACT that binds them. Path-bearing components validate every id (regex `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$`) and resolve every path through `realpath` containment before any IO; artifact writes use temp-write + atomic rename for byte-identical output.

### MAIN PLANE

**IpcBridge** — Registers every `MainApi` method as a typed `ipcMain.handle` channel, validates ids, and fans `MainEvents` to renderer windows.
```typescript
interface IpcBridge {
  register(api: MainApi): void;
  emit<K extends keyof MainEvents>(channel: K, payload: MainEvents[K]): void;
  setWindow(win: Electron.BrowserWindow): void;
}
type InvokeResult<T> = { ok: true; value: T } | { ok: false; error: { code: IpcErrorCode; message: string } };
type IpcErrorCode = 'invalid-id' | 'path-escape' | 'project-unknown' | 'claude-unavailable' | 'git-unavailable' | 'mcp-error' | 'internal';
```
**Dependencies:** [ProjectRegistry, ClaudePtySupervisor, BoberPipelineDriver, GitService, ArtifactStore, ClaudeHealthCheck, SecureStore]

**ClaudePtySupervisor** — Owns one node-pty Claude Code subprocess per `runId` and multiplexes stdin/stdout/resize/kill.
```typescript
interface ClaudePtySupervisor {
  spawn(opts: PtySpawnOptions): PtyHandle;            // injects CLAUDE_CODE_SESSION_ID=runId; EMFILE→PtyExhaustedError
  write(runId: string, data: Buffer): void;
  resize(runId: string, cols: number, rows: number): void;
  kill(runId: string): Promise<number>;               // SIGTERM, 2s, SIGKILL
  onOutput(runId: string, cb: (frame: Buffer) => void): Unsubscribe;
  onExit(runId: string, cb: (code: number) => void): Unsubscribe;
}
type PtySpawnOptions = { runId: string; cwd: string; argv?: string[]; env?: Record<string,string>; cols?: number; rows?: number };
```
**Dependencies:** [ProjectRegistry] · External: node-pty

**BoberPipelineDriver** — Spawns/tracks `agent-bober` CLI runs per `runId` and a long-lived `agent-bober mcp` stdio process per project root.
```typescript
interface BoberPipelineDriver {
  startRun(opts: RunSpawnOptions): RunHandle;          // child_process.spawn; one active run per project
  callMcpTool(projectRoot: string, tool: McpToolName, args: unknown): Promise<unknown>;
  abortRun(runId: string): Promise<void>;
  onLog(runId: string, cb: (line: string) => void): Unsubscribe;
  onExit(runId: string, cb: (code: number) => void): Unsubscribe;
  shutdown(): Promise<void>;
}
type McpToolName = 'list-projects' | 'get-project-state' | 'list-specs' | 'list-active-runs' | 'get-run-status' | 'abort-run' | 'subscribe-events';
```
**Dependencies:** [ProjectRegistry, ArtifactStore] · External: child_process, `agent-bober` CLI + `agent-bober mcp`

**GitService** — Runs argv-only `git` inside a validated root to produce diffs, list conflicts, and write resolved files.
```typescript
interface GitService {
  changedFiles(projectId: string): Promise<ChangedFile[]>;
  fileDiff(projectId: string, relPath: string): Promise<FileDiff>;
  conflicts(projectId: string): Promise<ConflictFile[]>;   // git diff --name-only --diff-filter=U
  readFile(projectId: string, relPath: string): Promise<string>;
  writeFile(projectId: string, relPath: string, content: string): Promise<void>;
  markResolved(projectId: string, relPath: string): Promise<void>;  // git add
}
type ConflictFile = { path: string; ours: string; theirs: string; base: string };
```
**Dependencies:** [ProjectRegistry] · External: git binary

**ArtifactStore** — Reads, Zod-validates, and atomically writes one project's `.bober/` artifacts, pushing change events when its watcher fires.
```typescript
interface ArtifactStore {
  list(projectId: string, kind: ArtifactKind): Promise<ArtifactRef[]>;
  read(projectId: string, kind: ArtifactKind, id: string): Promise<unknown>;  // Zod-validated
  write(projectId: string, kind: ArtifactKind, id: string, data: unknown): Promise<void>;  // atomic
  watch(projectId: string): void;                      // chokidar, awaitWriteFinish
  onChange(cb: (e: ArtifactEvent) => void): Unsubscribe;
  eventsSince(projectId: string, seq: number): ArtifactEvent[];   // ring-buffer 1000
}
type ArtifactKind = 'specs' | 'contracts' | 'eval-results' | 'architecture' | 'incidents';
type ArtifactEvent = { seq: number; projectId: string; kind: ArtifactKind; op: 'created'|'upserted'|'deleted'|'resync'; id: string };
```
**Dependencies:** [ProjectRegistry] · External: chokidar; reuses `agent-bober/src/contracts` Zod schemas directly

**ProjectRegistry** — Source of truth for registered projects; resolves every `projectId` to a canonical absolute root and enforces id validity + path containment.
```typescript
interface ProjectRegistry {
  add(absPath: string): Promise<Project>;              // realpath + .bober probe
  remove(projectId: string): Promise<void>;
  list(): Project[];
  resolveRoot(projectId: string): string;              // throws 'project-unknown'
  containedPath(projectId: string, relPath: string): string;   // realpath containment, throws 'path-escape'
  isValidId(id: string): boolean;
}
type Project = { id: string; name: string; root: string; boberRoot: string; hasBober: boolean };
```
**Dependencies:** []

**ClaudeHealthCheck** — Detects whether `claude` is installed, its version, and its auth method, caching for 30s.
```typescript
interface ClaudeHealthCheck { detect(force?: boolean): Promise<ClaudeHealth>; }
type ClaudeHealth = { installed: boolean; binaryPath: string|null; version: string|null; authenticated: boolean; authMethod: 'subscription'|'api-key'|'unknown'|null; detail: string|null };
```
**Dependencies:** [] · External: claude binary

**SecureStore** — Stores provider credentials in the OS keychain, never persisting secrets to disk.
```typescript
interface SecureStore {
  get(key: CredentialKey): Promise<string|null>;
  set(key: CredentialKey, value: string): Promise<void>;
  delete(key: CredentialKey): Promise<void>;
  list(): Promise<CredentialKey[]>;                    // keys only, never values
}
type CredentialKey = 'anthropic-api-key' | 'github-token' | `provider:${string}`;
```
**Dependencies:** [] · External: Electron `safeStorage`

### RENDERER PLANE

**AppShell** — Renders top-level chrome (TopNav, StatusBar, TweaksPanel, Companion) and mounts the active tab resolved from the registry.
```typescript
interface AppShell { activeTabId: string; setActiveTab(id: string): void; openPalette(): void; }
```
**Dependencies:** [ConsoleRegistry, ProjectStore, CommandPalette]

**ConsoleRegistry** — The single typed extension point for tabs, commands, and panels (the extensibility heart).
```typescript
interface ConsoleRegistry {
  registerTab(tab: TabDef): Unsubscribe;
  registerCommand(cmd: CommandDef): Unsubscribe;
  registerPanel(slot: SlotId, panel: PanelDef): Unsubscribe;
  tabs(): TabDef[];
  commands(ctx: CommandContext): CommandDef[];
  panels(slot: SlotId): PanelDef[];
}
type SlotId = 'agent-detail.sidebar' | 'build.right' | 'self.preview' | 'statusbar.right' | 'project.overview' | (string & {});
type TabDef = { id: string; title: string; icon: string; order: number; Component: React.ComponentType<TabProps>; keybinding?: string };
type CommandDef = { id: string; section: string; title: string; subtitle?: string; icon?: string; keybinding?: string; enabled?(ctx: CommandContext): boolean; run(ctx: CommandContext): void | Promise<void> };
type CommandContext = { activeTabId: string; activeProjectId: string|null; api: IpcClient };
```
**Dependencies:** []

**ProjectStore** — Zustand store holding per-project renderer state, applying `MainEvents` deltas; holds no authoritative state.
```typescript
interface ProjectStore {
  useActiveProject(): Project | null;
  useRuns(projectId: string): RunView[];
  useArtifacts(projectId: string, kind: ArtifactKind): ArtifactRef[];
  useHealth(): ClaudeHealth | null;
  applyEvent(e: MainEvents[keyof MainEvents]): void;
  setActiveProject(id: string): void;
}
type RunView = { runId: string; kind: 'plan'|'sprint'|'eval'|'architect'; status: 'running'|'blocked'|'paused'|'done'|'failed'; specId?: string };
```
**Dependencies:** [IpcClient]

**IpcClient** — Renderer-side typed proxy over `ipcRenderer.invoke` (unwraps `InvokeResult`, throws `IpcError`) plus `MainEvents` subscription, via a `contextBridge` preload (no `nodeIntegration`).
```typescript
interface IpcClient extends MainApiProxy {
  on<K extends keyof MainEvents>(channel: K, cb: (p: MainEvents[K]) => void): Unsubscribe;
}
type MainApiProxy = { [K in keyof MainApi]: MainApi[K] extends (...a: infer A) => Promise<InvokeResult<infer R>> ? (...a: A) => Promise<R> : never };
```
**Dependencies:** []

**TerminalPane** — Renders an xterm.js terminal bound to one `runId`, forwarding keystrokes/resize and writing PTY output frames.
```typescript
type TerminalPaneProps = { runId: string; api: IpcClient };
```
**Dependencies:** [IpcClient] · External: @xterm/xterm + @xterm/addon-fit

**DiffMergeSurface** — Renders Monaco inline diffs and the 3-way merge view, writing resolved content back through git.
```typescript
type DiffMergeProps = { projectId: string; file: ChangedFile | ConflictFile; mode: 'view'|'edit'|'merge'; api: IpcClient };
```
**Dependencies:** [IpcClient] · External: monaco-editor + @monaco-editor/react

### IPC CONTRACT PLANE

**MainApi / MainEvents** — The single shared declaration that both `IpcBridge` (main) and `IpcClient` (renderer) implement against: ~22 `invoke` methods plus the push channels. See API Contracts for the method table.
```typescript
interface MainEvents {
  'pty:output': { runId: string; frame: Uint8Array };
  'pty:exit': { runId: string; code: number };
  'run:log': { runId: string; line: string };
  'run:exit': { runId: string; code: number };
  'artifact:change': ArtifactEvent;
  'health:change': ClaudeHealth;
}
```
**Dependencies:** []

---

## Data Model

```typescript
// On-disk (per project root): <root>/.bober/{specs,contracts,eval-results,architecture,incidents}/<id>.json + history.jsonl
// PlanSpec / SprintContract / EvalResult = z.infer of agent-bober/src/contracts/* (reused, not re-mirrored)

type ArtifactRef   = { id: string; kind: ArtifactKind; mtime: number };
type ChangedFile   = { path: string; status: 'M'|'A'|'D'|'R'|'U'; staged: boolean };
type FileDiff      = { path: string; oldText: string; newText: string; binary: boolean };
type PtyHandle     = { runId: string; pid: number; startedAt: number };
type RunHandle     = { runId: string; pid: number; startedAt: string };
type Unsubscribe   = () => void;
```

No new persistent store is introduced — `.bober/` on disk (written by the `agent-bober` core) plus the OS keychain (credentials) are the only durable state. The renderer persists nothing authoritative.

---

## API Contracts

All methods return `InvokeResult<T>`; `IpcClient` unwraps `{ok:false}` into a thrown `IpcError`. Pushes carry `projectId`/`runId` for renderer routing.

| Method | Input | Output | Error Cases |
|--------|-------|--------|-------------|
| projectList / projectAdd / projectRemove | `{}` / `{name,root}` / `{projectId}` | `Project[]` / `Project` / `{removed}` | invalid-id; project-unknown; path-escape; internal |
| claudeHealth | `{force?}` | `ClaudeHealth` | (unauth returned as value, not thrown); internal |
| credSet / credList | `{key,value}` / `{}` | `{ok}` / `CredentialKey[]` | internal (keychain locked/unavailable) |
| runStart / runAbort | `{projectId,runId,spec}` / `{projectId,runId}` | `{runId}` / `{aborted}` | invalid-id; project-unknown; mcp-error (run-in-progress / not-found); internal |
| mcpCall | `{projectId,tool,args}` | `unknown` | invalid-id; project-unknown; mcp-error (timeout/shape); internal |
| ptySpawn / ptyWrite / ptyResize / ptyKill | `{runId,...}` | `{runId}` / `{ok}` / `{ok}` / `{killed}` | invalid-id; path-escape (cwd); claude-unavailable (EMFILE) |
| gitChangedFiles / gitFileDiff / gitConflicts | `{projectId[,path]}` | `ChangedFile[]` / `FileDiff` / `ConflictFile[]` | invalid-id; project-unknown; path-escape; git-unavailable |
| gitReadFile / gitWriteFile / gitMarkResolved | `{projectId,path[,content]}` | `{content}` / `{ok}` / `{ok}` | invalid-id; project-unknown; path-escape; git-unavailable |
| artifactList / artifactRead | `{projectId[,kind,id]}` | `ArtifactRef[]` / `unknown` | invalid-id; project-unknown; (bad-Zod flagged, not thrown) |
| artifactEventsSince | `{projectId,seq}` | `{events,resynced}` | invalid-id; project-unknown (resynced if seq < ring floor) |

---

## Integration Strategy

### Data Flow (key chains)
```
Keystroke (latency-critical):
  xterm.onData(key) → IpcClient.invoke('ptyWrite',{runId,data})   // one in-process IPC hop, no JSON re-serialize
    → IpcBridge → ClaudePtySupervisor.write → pty.write
  pty.onData → webContents.send('pty:output',{runId,frame:Uint8Array})   // push, structured-clone, not JSON
    → IpcClient.on('pty:output') → xterm.write(frame)
  // No renderer→main→CLI→Claude chain per keystroke; both hops in-process → inside 100ms p95.

Start run + observe (fire-and-observe):
  invoke('runStart',{projectId,runId,spec}) → BoberPipelineDriver.startRun → child_process.spawn → returns {runId} immediately
  agent-bober writes .bober/* → chokidar → ArtifactStore.onChange (Zod-validate, seq++)
    → send('artifact:change',event) → ProjectStore.applyEvent → tab re-renders

Resolve conflict:
  invoke('gitConflicts',{projectId}) → ConflictFile[]{ours,theirs,base}
    → DiffMergeSurface Monaco 3-way (edit pure-renderer)
    → invoke('gitWriteFile') → invoke('gitMarkResolved') → refresh

Extensibility:
  ConsoleRegistry.registerTab({id,title,Component}) → AppShell renders from registry  // no IPC-contract change
```

### Consistency Model
The renderer holds **no authoritative state** — it is a pure projection rebuildable from main+disk. Authority: project list = main memory (persisted to `projects.json`); `.bober/` = disk (written by the CLI); terminal = PTY kernel buffer (main never reconstructs it); credentials = OS keychain. `ArtifactEvent.seq` is **per-project monotonic**; the renderer gap-detects and calls `artifactEventsSince(projectId, seq)`, with `op:'resync'` forcing a full relist if seq fell off the 1000-entry ring. This per-project sequencing is the addressing primitive that prevents cross-project leakage (ADR-5).

### External Dependencies
| Service | Used By | Failure Mode | Fallback |
|---------|---------|--------------|----------|
| node-pty (native) | ClaudePtySupervisor | EMFILE; ABI mismatch on Electron bump | Cap PTYs/project; `claude-unavailable`; electron-rebuild + CI PTY smoke test |
| `claude` binary | ClaudeHealthCheck, ClaudePtySupervisor | Missing / unauthenticated | Health returns values; UI guides install or `/login` PTY; never hard-crash |
| `agent-bober` CLI + `mcp` | BoberPipelineDriver | spawn ENOENT; crash; tool timeout; schema drift | `mcp-error`/`internal`; MCP pool respawn; Zod-guard; pin bundled version |
| `git` binary | GitService | Missing; not a repo | `git-unavailable`; panels show empty-state |
| OS keychain (safeStorage) | SecureStore | Keyring locked/unavailable | `internal`; degrade to in-memory session keys; no plaintext fallback |
| chokidar / FS (FSEvents) | ArtifactStore | Coalescing, dropped events | awaitWriteFinish; `seq` gap-detect; `op:'resync'` relist; ring-buffer replay |

---

## Architecture Decision Records

- [ADR-1: Electron IPC as the main↔renderer transport](.bober/architecture/arch-20260529-ide-desktop-shell-adr-1.md)
- [ADR-2: Typed in-app registry, not a runtime plugin system](.bober/architecture/arch-20260529-ide-desktop-shell-adr-2.md)
- [ADR-3: PTY ownership in the Electron main process via node-pty](.bober/architecture/arch-20260529-ide-desktop-shell-adr-3.md)
- [ADR-4: Monaco-based 3-way merge editor, not OpenVSCode](.bober/architecture/arch-20260529-ide-desktop-shell-adr-4.md)
- [ADR-5: Per-project event addressing and isolation](.bober/architecture/arch-20260529-ide-desktop-shell-adr-5.md)
- [ADR-6: PTYs live in main and survive renderer reload](.bober/architecture/arch-20260529-ide-desktop-shell-adr-6.md)

---

## Risk Assessment

| Risk | Severity | Owner | Mitigation |
|------|----------|-------|------------|
| Parallel multi-project event cross-leakage | critical | ArtifactStore, ProjectStore | Per-project lanes (own watcher/seq/MCP); every push carries projectId; reducers reject unregistered projectIds (ADR-5) |
| Path traversal via projectId / file path | critical | IpcBridge, ProjectRegistry | id-regex at IPC boundary + `containedPath` realpath assertion before any IO |
| Renderer reload mid-run orphans PTYs / loses buffer | high | ClaudePtySupervisor | PTYs in main, reattach by runId + bounded scrollback replay; never kill on reload (ADR-6) |
| chokidar coalescing / dropped FS events (macOS) | high | ArtifactStore | awaitWriteFinish + atomic writes + monotonic seq gap-detect + `op:'resync'` relist + ring-buffer |
| IPC backpressure under high PTY throughput | high | ClaudePtySupervisor | Raw Uint8Array frames; ~16ms frame-window coalesce; cap in-flight, drop-to-flush (PTY buffer authoritative) |
| node-pty native ABI mismatch on Electron bump | high | ClaudePtySupervisor | Pin Electron+node-pty; electron-rebuild in CI; boot PTY smoke test → blocking diagnostic on mismatch |
| agent-bober CLI/MCP schema drift vs renderer Zod | high | ArtifactStore, BoberPipelineDriver | Zod-validate on read (flag invalid, don't crash watcher); pin bundled version; surface in health |
| Concurrent runs racing on same project `.bober/` | medium | BoberPipelineDriver | One active run per projectId; second `runStart` → `mcp-error{run-in-progress}`; atomic artifact writes |
| MCP stdio process dies mid-session | medium | BoberPipelineDriver | Detect onExit, mark dead, lazy respawn on next call; in-flight call → `mcp-error` |
| Claude not authenticated on first run | medium | ClaudeHealthCheck | Return `authenticated:false` as value; open interactive `claude /login` PTY toward <60s target |
| safeStorage unavailable (headless Linux) | low | SecureStore | `internal` with message; degrade to in-memory session keys; never plaintext on disk |

---

## Open Questions

- **Cross-platform at MVP:** Success criterion 1 gates on macOS (the dev platform). Assumed Windows/Linux are later. If cross-platform is required at MVP, node-pty/safeStorage/FSEvents fallbacks and per-platform CI signing all move from later to now.
- **Monaco 3-way merge UX cost:** ADR-4 assumes a hand-built 3-pane merge is acceptable since Monaco has no turnkey merge widget. If the UX proves too costly, the documented fallback (merge-only OpenVSCode iframe) re-imports the LSP/marketplace surface the constraints forbid — a tradeoff to revisit, not a silent default.
- **Migration vs rebuild of the renderer:** Assumed the renderer is rebuilt fresh from the `agent-bober-ui` prototype design into a Vite/React-19 app rather than evolving `openhands-bober/cockpit` in place. If reusing cockpit is preferred, the IPC client and Zustand store shapes here must be reconciled with cockpit's existing REST-based API client.
- **PTY survival across main-process crash:** ADR-6 keeps PTYs alive across renderer reloads but not main crashes (the detached-child design was rejected for reintroducing a socket transport). Assumed acceptable since a main crash also loses the window. If durable-across-restart runs become a requirement, ADR-1/ADR-6 must be revisited.
