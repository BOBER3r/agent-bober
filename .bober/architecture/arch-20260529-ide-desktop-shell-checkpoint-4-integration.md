# Integration Strategy — arch-20260529-ide-desktop-shell

> Checkpoint 4 output. Approach A (All-TypeScript Electron). 15 components, main↔renderer over Electron IPC.

## Data Flow (concrete call chains)

### (a) App boot + multi-project hydrate

```
Electron main ready
  → ProjectRegistry.list() reads persisted projects.json → Project[]
  → for each Project p (lazy, on first focus): ArtifactStore.watch(p.boberRoot)
       starts chokidar(p.boberRoot, {ignoreInitial:false}) → emits ArtifactEvent{op:'created'} per file
  → IpcBridge registers all MainApi handlers via ipcMain.handle(id, fn)
  → BrowserWindow loads renderer (Vite build)

Renderer mount: AppShell()
  → IpcClient.invoke('projectList')           // ipcRenderer.invoke → InvokeResult unwrap
      → IpcBridge → ProjectRegistry.list() → InvokeResult<Project[]>{ok:true,value}
  → ProjectStore.setProjects(value)            // Zustand
  → AppShell renders active project's tab from ConsoleRegistry.getTab(activeTabId)
  → for active project: IpcClient.invoke('artifactList', {projectId})
      → IpcBridge → ProjectRegistry.isValidId(projectId) (else IpcError 'invalid-id')
        → ProjectRegistry.resolveRoot(projectId) → ArtifactStore.list(boberRoot)
        → Zod-validates each file → ArtifactEntry[]
  → ProjectStore.hydrate(projectId, entries)
  → IpcClient.invoke('claudeHealth') → ClaudeHealthCheck.detect(false) (30s cache)
  → ProjectStore.setHealth(value); AppShell badges Claude status

Each project gets its OWN ArtifactStore chokidar watcher + its OWN ring-buffer keyed by projectId.
No shared mutable state across projects (see ADR-5).
```

### (b) Zero-key Claude first run via PTY — keystroke loop (<100ms defense)

```
First run, no key:
  AppShell → IpcClient.invoke('claudeHealth')
    → ClaudeHealthCheck.detect(true) → spawns `claude --version` / probes auth
    → ClaudeHealth{installed:true, authenticated:false, authMethod:'none'}
  → renderer shows "Sign in" affordance; TerminalPane spawns Claude PTY for interactive login:
  → IpcClient.invoke('ptySpawn', {runId, cmd:'claude', args:['/login'], cwd:project.root, env:{CLAUDE_CODE_SESSION_ID:runId}})
      → IpcBridge → ClaudePtySupervisor.spawn(runId, opts) → node-pty.spawn(...)
        (EMFILE → PtyExhaustedError → InvokeResult{ok:false,error:{code:'claude-unavailable'}})
      → pty.onData(buf => mainWindow.webContents.send('pty:output', {runId, frame:buf}))

KEYSTROKE LOOP (latency-critical, p95 <100ms keystroke→render):
  xterm.js onData(key) in TerminalPane
    → IpcClient.invoke('ptyWrite', {runId, data:key})   // single async IPC hop, ~sub-ms in-process
      → IpcBridge → ClaudePtySupervisor.write(runId, data) → pty.write(data)   // no Zod on hot path; id checked O(1) Map.has
  PTY echoes → pty.onData → webContents.send('pty:output', {runId, frame:Uint8Array})  // PUSH, not invoke
    → IpcClient.on('pty:output') → TerminalPane.term.write(frame)   // xterm renders

Latency budget: keystroke→pty.write is ONE ipcRenderer.invoke (in-process, no HTTP/loopback per ADR-1,
no JSON re-serialize of large payloads — data is a short string). Echo→render is ONE webContents.send
push carrying a Uint8Array (structured-clone transferable, not JSON). Both hops are in-process Electron IPC;
measured Electron IPC round-trip is single-digit ms, well inside the 100ms p95. NO renderer→main→CLI→Claude
chain on keystrokes — the PTY kernel buffer is authoritative for terminal state (see Consistency Model).
```

### (c) Start an agent-bober run + observe artifacts live (fire-and-observe)

```
User clicks "Run sprint":
  → IpcClient.invoke('runStart', {projectId, spec, runId})
      → IpcBridge → ProjectRegistry.resolveRoot(projectId) (else 'project-unknown')
        → BoberPipelineDriver.startRun(runId, {root, spec})
           → child_process.spawn('agent-bober', ['run', ...], {cwd:root})   // fire
           → child.stdout → onLog(runId, line) → webContents.send('run:log', {runId, line})
           → child.on('exit', code => webContents.send('run:exit', {runId, code}))
      → returns InvokeResult{ok:true, value:{runId}}   // returns IMMEDIATELY; run is async

OBSERVE (independent, event-driven — no polling):
  agent-bober process writes .bober/contracts/<id>.json, .bober/handoffs/..., etc.
    → chokidar(boberRoot) in ArtifactStore fires → ArtifactStore.onChange
       → Zod-validate file → push ArtifactEvent{seq:++n, projectId, kind, op:'upserted', id} to ring-buffer
       → webContents.send('artifact:change', event)
    → IpcClient.on('artifact:change') → ProjectStore.applyEvent(event)
       → if event.projectId !== activeProjectId: update that project's slice only (no cross-render)
       → else: re-read via IpcClient.invoke('artifactRead', {projectId, id}) → reduce into store
    → AppShell tab re-renders the updated artifact (e.g. live sprint progress)

Optional control-plane status (p95 <500ms): IpcClient.invoke('mcpCall', {projectId, tool:'get-run-status', args:{runId}})
    → BoberPipelineDriver.callMcpTool(projectId,'get-run-status',args) over the long-lived
      `agent-bober mcp` stdio pool (one process per project root) → McpResult.
```

### (d) Resolve a merge conflict (open → Monaco 3-way → write + markResolved)

```
User opens Conflicts panel:
  → IpcClient.invoke('gitConflicts', {projectId})
      → IpcBridge → ProjectRegistry.resolveRoot(projectId) → GitService.conflicts(root)
         → git diff --name-only --diff-filter=U (argv-only, no shell) → for each: read :1:/:2:/:3: stages
         → ConflictFile[]{path, ours, theirs, base}   (else IpcError 'git-unavailable')
  → ProjectStore.setConflicts(projectId, files); AppShell shows list

User clicks a conflict file:
  → DiffMergeSurface mounts Monaco 3-way merge editor with {ours, theirs, base} from ConflictFile
  → user edits the merged result in-Monaco (pure renderer, no IPC per keystroke)

User clicks "Resolve":
  → IpcClient.invoke('gitWriteFile', {projectId, path, content:merged})
      → GitService.writeFile(root, containedPath, content)   // ProjectRegistry.containedPath guards traversal
        (path outside root → IpcError 'path-escape')
  → IpcClient.invoke('gitMarkResolved', {projectId, path})
      → GitService.markResolved(root, path) → git add <path>
  → IpcClient.invoke('gitConflicts', {projectId})   // refresh; resolved file drops off list
  → ProjectStore.setConflicts(...) → AppShell updates
```

### (e) Extensibility flow (registerTab → AppShell renders it)

```
At renderer startup (or feature module import):
  ConsoleRegistry.registerTab({id:'my-tab', title, slot:'main', component: MyTabComponent})
    → validates SlotId is known; stores in typed registry map
  ConsoleRegistry.registerCommand({id, run})  // optional
  ConsoleRegistry.registerPanel({id, slot:'sidebar', component})  // optional

AppShell render:
  → ConsoleRegistry.getTabs() → Tab[]
  → renders tab bar; on activate → ConsoleRegistry.getTab(activeId).component
  → component receives {projectId, ipc:IpcClient, store:ProjectStore} via context
  → new feature = one registerTab call + one component; no plugin runtime, no IPC contract change (ADR-2)
```

## API Contracts (MainApi)

| Method | Input | Output | Error Cases |
|--------|-------|--------|-------------|
| projectList | `{}` | `Project[]` | internal (persist read fail) |
| projectAdd | `{name, root}` | `Project` | path-escape (root not a dir / unreadable); internal |
| projectRemove | `{projectId}` | `{removed:boolean}` | invalid-id; project-unknown |
| claudeHealth | `{force?:boolean}` | `ClaudeHealth` | claude-unavailable (binary probe failed → returned as value `installed:false`, not thrown); internal |
| credSet | `{key:CredentialKey, value}` | `{ok:true}` | internal (keychain locked/unavailable) |
| credList | `{}` | `CredentialKey[]` | internal (keychain unavailable) |
| runStart | `{projectId, runId, spec}` | `{runId}` | invalid-id; project-unknown; internal (spawn ENOENT → mcp-error) |
| runAbort | `{projectId, runId}` | `{aborted:boolean}` | invalid-id; project-unknown; mcp-error (run not found) |
| mcpCall | `{projectId, tool:McpToolName, args}` | `McpResult` | invalid-id; project-unknown; mcp-error (tool error/timeout); internal |
| ptySpawn | `{runId, cmd, args, cwd, env}` | `{runId}` | path-escape (cwd outside any project root); claude-unavailable (EMFILE/PtyExhaustedError); internal |
| ptyWrite | `{runId, data}` | `{ok:true}` | invalid-id (unknown runId); internal |
| ptyResize | `{runId, cols, rows}` | `{ok:true}` | invalid-id; internal |
| ptyKill | `{runId}` | `{killed:boolean}` | invalid-id |
| gitChangedFiles | `{projectId}` | `ChangedFile[]` | invalid-id; project-unknown; git-unavailable |
| gitFileDiff | `{projectId, path}` | `{path, hunks}` | invalid-id; project-unknown; path-escape; git-unavailable |
| gitConflicts | `{projectId}` | `ConflictFile[]` | invalid-id; project-unknown; git-unavailable |
| gitReadFile | `{projectId, path}` | `{path, content}` | invalid-id; project-unknown; path-escape; git-unavailable |
| gitWriteFile | `{projectId, path, content}` | `{ok:true}` | invalid-id; project-unknown; path-escape; git-unavailable |
| gitMarkResolved | `{projectId, path}` | `{ok:true}` | invalid-id; project-unknown; path-escape; git-unavailable |
| artifactList | `{projectId}` | `ArtifactEntry[]` | invalid-id; project-unknown; internal (Zod parse fail → entry flagged invalid, not thrown) |
| artifactRead | `{projectId, id}` | `ArtifactEntry` | invalid-id; project-unknown; mcp-error (artifact id unknown); internal |
| artifactEventsSince | `{projectId, seq}` | `{events:ArtifactEvent[], resynced:boolean}` | invalid-id; project-unknown (resynced:true if seq < ring-buffer floor) |

All methods return `InvokeResult<T> = {ok:true,value:T} | {ok:false,error:{code:IpcErrorCode,message}}`.
IpcClient unwraps `ok:false` into a thrown `IpcError`. Pushes (`pty:output`, `pty:exit`, `run:log`, `run:exit`, `artifact:change`, `health:change`) carry the projectId/runId in their payload for renderer-side routing.

## Consistency Model

| State | Authoritative location | Model | Invalidation / Replay |
|-------|------------------------|-------|------------------------|
| Project list | ProjectRegistry in-main memory (persisted to projects.json) | Strong (single writer = main) | Renderer is a read-through cache; re-fetched on `projectList` at boot |
| `.bober/` artifacts | On disk (written by agent-bober CLI process) | Eventual → renderer | chokidar `artifact:change` push; on renderer reload, `artifactEventsSince(seq)` replays from ring-buffer (1000), or `resynced:true` + full `artifactList` if seq fell off the floor |
| Terminal/PTY screen state | PTY kernel pty buffer (the spawned process) | Strong (OS-owned) | xterm is a render mirror; on reload, renderer re-attaches to the live runId and may replay a scrollback snapshot (ADR-6). Main NEVER reconstructs terminal state |
| Credentials | OS keychain via Electron safeStorage | Strong (OS-owned) | SecureStore reads on demand; never cached in renderer; `credList` returns keys only, never values |
| Run lifecycle | agent-bober child_process + MCP (process is truth) | Eventual → renderer | `run:log`/`run:exit` pushes; authoritative status via `mcpCall('get-run-status')` |

Renderer (ProjectStore) holds NO authoritative state — it is a projection. Reducers are pure: `applyEvent(MainEvent)`. The renderer can be discarded and rebuilt from main + disk at any time (the reload-resilience invariant, see ADR-6).

Sequence numbers (`ArtifactEvent.seq`) are **per-project monotonic**, assigned by that project's ArtifactStore. Replay is per-project: `artifactEventsSince(projectId, seq)`. This is the addressing primitive that prevents cross-project leakage (ADR-5).

## Integration Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Renderer reload (Cmd-R / Vite HMR) mid-run orphans live PTYs / loses xterm buffer | high | PTYs live in MAIN keyed by runId and survive reload (ADR-6). On remount, TerminalPane re-attaches via `ptyWrite`/`pty:output` on the same runId; a bounded scrollback snapshot (last N KB per runId) is kept in ClaudePtySupervisor and replayed on attach. Never kill PTYs on `webContents` reload — only on `ptyKill` or `pty:exit`. |
| chokidar coalesces / drops FS events on macOS (FSEvents debounce, atomic rename) | high | ArtifactStore uses `awaitWriteFinish` + writes are atomic (temp+rename). Each event carries monotonic `seq`; renderer detects gaps and calls `artifactEventsSince`. On chokidar `error`/`raw` overflow, ArtifactStore emits `op:'resync'` forcing renderer full `artifactList`. Ring-buffer (1000) backs replay. |
| IPC backpressure under high PTY throughput (e.g. `yes`, build logs) floods renderer | high | `pty:output` frames are sent as raw `Uint8Array` (structured clone, no JSON). ClaudePtySupervisor coalesces pty data within a ~16ms frame window before `webContents.send` (one frame per paint). xterm has its own write buffer. If renderer is unfocused/throttled, main caps in-flight frames per runId and drops to a periodic flush (terminal content stays correct because PTY buffer is authoritative). |
| Parallel multi-project event cross-leakage (≥3 isolated projects) | critical | Every push and every artifact event carries `projectId`; each project has its OWN ArtifactStore + chokidar watcher + per-project `seq` + own MCP stdio process (ADR-5). ProjectStore keys all state by projectId; reducers reject events whose projectId is not registered. No shared mutable buffer across projects. |
| agent-bober CLI/MCP schema drift vs renderer Zod expectations | high | ArtifactStore Zod-validates on read; a parse failure flags the entry `{valid:false, error}` rather than throwing/crashing the watcher. `.bober/` schema is pinned to the bundled agent-bober version; version is surfaced in health so mismatch is visible. MCP results validated at BoberPipelineDriver boundary → `mcp-error` on shape mismatch. |
| Path traversal via projectId / file path (`../`, absolute, symlink escape) | critical | IpcBridge validates every id (`ProjectRegistry.isValidId` → `invalid-id`). GitService/ArtifactStore resolve `path` only through `ProjectRegistry.containedPath(root, path)` which `realpath`-normalizes and asserts the result is inside `root` → `path-escape`. node-pty `cwd` must resolve inside a known project root. No path reaches `fs`/git argv unvalidated. |
| Claude not authenticated on first run | medium | `claudeHealth` returns `authenticated:false` as a VALUE (not error); AppShell renders sign-in affordance and opens an interactive `claude /login` PTY. Zero-key first run targets <60s by going straight to the login PTY rather than failing a run. |
| node-pty native module ABI mismatch after Electron version bump | high | Pin Electron + node-pty versions; `electron-rebuild` in postinstall and CI. App boot probes ClaudePtySupervisor.spawn of a no-op once; on `NODE_MODULE_VERSION` mismatch, surface a blocking diagnostic (`claude-unavailable` with detail) instead of a silent white screen. CI gate: build artifact must launch a PTY smoke test on each target platform. |
| Concurrent runs racing on the same project's `.bober/` (two `runStart` same project) | medium | BoberPipelineDriver enforces one active run per (projectId) — second `runStart` on a busy project returns `mcp-error{message:'run-in-progress'}`. agent-bober itself writes artifacts atomically; the single-active-run rule prevents two CLI processes interleaving writes to the same contract files. |
| MCP stdio pool process dies mid-session | medium | BoberPipelineDriver detects `onExit` of the per-project mcp process, marks pool entry dead, lazily respawns on next `callMcpTool`; in-flight call rejects with `mcp-error`. Renderer retries idempotent reads. |
| safeStorage unavailable (Linux without keyring / locked) | low | `credSet`/`credList` return `internal` with a clear message; app degrades to per-session in-memory key entry rather than persisting. Never write plaintext credentials to disk. |

## External Dependencies

| Service | Used By | Failure Mode | Fallback |
|---------|---------|--------------|----------|
| node-pty (native) | ClaudePtySupervisor | EMFILE (PtyExhaustedError); ABI mismatch on Electron bump | Cap concurrent PTYs per project; surface `claude-unavailable`; electron-rebuild + CI smoke test gate |
| `claude` binary | ClaudeHealthCheck, ClaudePtySupervisor | Not installed / not on PATH / not authenticated | Health returns `installed:false`/`authenticated:false` as values; UI guides install or `/login` PTY; never hard-crash |
| `agent-bober` CLI + `agent-bober mcp` | BoberPipelineDriver | spawn ENOENT; process crash; MCP tool timeout; schema drift | `mcp-error`/`internal` surfaced to renderer; MCP pool respawn; Zod-guard at boundary; pin bundled version |
| `git` binary | GitService | Not installed; not a repo; merge state absent | `git-unavailable` IpcError; Conflicts/Diff panels show empty-state, not crash |
| OS keychain (Electron safeStorage) | SecureStore | Keyring locked / unavailable (esp. headless Linux) | `internal` error; degrade to in-memory session keys; no plaintext fallback |
| chokidar / FS (FSEvents on macOS) | ArtifactStore | Event coalescing, dropped events, overflow on atomic rename | `awaitWriteFinish`, monotonic `seq` gap-detection, `op:'resync'` + full relist, ring-buffer replay |
