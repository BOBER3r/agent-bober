# Design: Agent Command Center

**Design ID:** `design-20260525-agent-command-center`
**Date:** 2026-05-25
**Status:** draft
**Author:** orchestrator session

---

## TL;DR

Evolve the openhands-bober fork from "embedded Claude terminal + sprint progress panel" into a full **agent command center**: folder-tree navigation of agent teams, per-agent live state, team-lead chat, a dedicated build-assistant chat that ships features into the app itself, PR management, server-log streaming, devops agents on a visual map, and a unified notification feed. Bober becomes tightly bidirectional — UI both observes and commands agent state — and surfaces the new v0.12/v0.13 capabilities (clarification workflows, token-usage telemetry, graph incidents, impact analysis).

---

## 1. Where we are today

### 1.1 openhands-bober (the fork) — what shipped in v0.1.0

- **Backend** (`openhands_bober/` Python sub-package):
  - FastAPI sub-router at `/api/v1/bober/*` + WS `/ws/claude/{conversationId}` + SSE `/api/v1/bober/events`
  - `ClaudePtySupervisor`, `BoberPipelineDriver`, `ArtifactReader`, `ArtifactWatcher`, `ClaudeHealthCheck`, `ProcessRegistry`, `HeartbeatWatcher`, `ArtifactEventBus`, `TmpReaper`, `OrphanScanner`, `PtyTransportProbe`
- **Frontend** (`frontend/src/bober/` TS):
  - Zustand store, REST + SSE hydration, `SprintControlPanel`, `ClaudeTerminalPane`, `PreAuthOverlay`, `DegradedBanner`, `UnsupportedPlatform`
  - Single 3-region layout (control left / terminal right / status bottom) inside the existing OpenHands conversation view
- **CI**: upstream-merge-safety GitHub Action, drift-check test enforcing Zod↔Pydantic parity
- **Three additive upstream insertions**, never mutated

### 1.2 agent-bober (the harness) — what's actually there as of v0.13.0

Far more than what openhands-bober knows about today. Key capabilities NOT yet surfaced in the UI:

| Capability | Source | UI status |
|---|---|---|
| `bober plan` produces `needs-clarification` PlanSpecs with structured questions | v0.12.0 | not surfaced |
| `bober plan answer <specId> [<questionId> <answer>]` | v0.12.0 | not surfaced |
| `PlanSpec.ambiguityScore`, `clarificationQuestions`, `resolvedClarifications` | v0.12.0 | Pydantic mirror missing |
| `SprintContract.nonGoals`, `stopConditions`, `definitionOfDone`, `assumptions`, `outOfScope` | v0.12.0 | Pydantic mirror missing |
| Generator preflight blocks vague contracts → `status: "blocked"` | v0.12.0 | UI doesn't render `blocked` |
| Evaluator nonGoals diff check | v0.12.0 | not surfaced |
| `bober graph init/sync/status` + `.bober/graph/manifest.json` | v0.13.0 | not surfaced |
| `bober onboard` generates 5 onboarding docs in `.bober/onboarding/` | v0.13.0 | not surfaced |
| `bober impact <symbol|file>` writes `.bober/graph/impact/<slug>.md` | v0.13.0 | not surfaced |
| `.bober/graph/incidents.jsonl` (event log) | v0.13.0 | not surfaced |
| `.bober/graph/token-usage.jsonl` (token spend telemetry) | v0.13.0 | not surfaced |
| `tokensave` external CLI version probe + platform-aware install hints | v0.13.0 | not surfaced |
| Six built-in agent types: planner, curator, architect, researcher, generator, evaluator | all versions | only sprint outcomes visible |
| MCP server (`src/mcp/server.ts`) for Cursor/Windsurf | older | unrelated to UI |

### 1.3 Wire reality between the two repos

- **Schemas**: openhands-bober Pydantic models lag agent-bober Zod by two minor versions. The drift-check test will fail on the next mirror update.
- **Filesystem boundary**: openhands-bober reads `$OPENHANDS_BOBER_ROOT` (default `cwd/.bober`). To consume a real project, that env var must be set to wherever the bober CLI is writing. No auto-discovery.
- **CLI invocation**: `BoberPipelineDriver` shells out to `$OPENHANDS_BOBER_CLI_PATH` (or PATH lookup of `bober`). The `--sprint-id` flag is not yet supported upstream → server-generated IDs are ignored, byte-identical artifact guarantee is broken.
- **Direction**: read-only one-way. UI watches `.bober/`. Nothing flows from UI back to bober beyond "start sprint" / "cancel sprint" subprocess invocations.

---

## 2. The vision in one sentence

A single desktop-class web app where every agent across every project is visible, addressable, and chattable, and where the boundary between "use an agent" and "build with an agent" disappears.

---

## 3. The five top-level tabs

The UI is restructured as a top-level tabbed application. The existing "Bober" tab inside the OpenHands conversation view becomes the entry point, then the route opens into this five-tab layout.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Bober   [ Agents ] [ Build ] [ Repos ] [ Ops ] [ Inbox ]   ☼ ⚙ 👤      │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│                       (tab content swaps here)                           │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│  ◉ 3 active   ⚡ 142k/200k tokens   ⚠ none   bober v0.13.0   ◐ ◐ ◐      │
└──────────────────────────────────────────────────────────────────────────┘
```

| Tab | Purpose | Primary feed |
|---|---|---|
| **Agents** | Folder tree of teams; click into individual agents; chat with team leads | live agent state |
| **Build** | One-shot: "tell the assistant to change the app and it does" | conversational sprint creation |
| **Repos** | PRs across repos; create / review / approve | GitHub + git state |
| **Ops** | Servers, logs, deploys, devops agents on a visual map | log streams + heartbeats |
| **Inbox** | Unified notification feed: completions, alarms, PRs needing review | event bus aggregate |

Status bar persists across tabs and is the single global indicator of "is anything wrong / how much budget am I burning."

---

## 4. Tab 1: Agents

### 4.1 Three-pane layout

```
┌─────────────┬──────────────────────────────────┬──────────────────────────┐
│  FOLDERS    │   AGENT DETAIL                   │   CONTEXT / CHAT         │
│             │                                  │                          │
│  📁 solex   │   ⬢ Generator-2                  │   ┌──────────────────┐  │
│   ├ 👤 lead │   ─────────────                  │   │ #team-lead-solex │  │
│   ├ 🧠 plan │   Status:  ▶ running             │   │                  │  │
│   ├ 🛠 gen-1│   Task:    sprint-7 iter 2 fix   │   │ You: focus the   │  │
│   ├ 🛠 gen-2│   Phase:   write tests           │   │ team on UI bugs  │  │
│   └ 🧪 eval │   Tokens:  47k / 80k             │   │                  │  │
│             │   Started: 12 min ago            │   │ Lead: routing... │  │
│  📁 openh.. │                                  │   │ Lead: gen-2 will │  │
│   ├ 👤 lead │   ┌─Live activity──────────────┐ │   │ pick up sc-7-4   │  │
│   ├ ⚙ arch  │   │ 13:42 read invalid-...tsx  │ │   └──────────────────┘  │
│   ├ 🧠 plan │   │ 13:43 edit ...row.test.tsx │ │                          │
│   ├ 🛠 gen  │   │ 13:43 npm test -- ...       │ │   [type a message…]    │
│   └ 🧪 eval │   │ 13:44 ✓ 6/6 pass            │ │                          │
│             │   └──────────────────────────── │ │   Tokens today: 1.2M   │
│  📁 personal│                                  │   Incidents (7d): 2     │
│   └ ...     │   [⏸ pause] [⏹ stop] [↻ redirect]│                          │
└─────────────┴──────────────────────────────────┴──────────────────────────┘
```

### 4.2 Folder tree (left, ~22%)

- One folder per project root that has a `.bober/` directory.
- Auto-discovered via a configurable list of project roots in user preferences (or via a "bober daemon" that scans `~`).
- Inside each folder:
  - 👤 **Team Lead** (always pinned at top — proposed new agent type, see §8)
  - One node per agent role configured for that project — planner, architect, researcher, generator, evaluator, curator. Multiple generators get suffixed (`gen-1`, `gen-2`).
- Icons reflect state: ▶ running (green pulse), ◯ idle (grey), ⏸ paused (yellow), ⚠ stuck or needs-clarification (red), ✓ recently completed (fading green).
- Drag-and-drop: drag an agent from one folder to another to reassign it to a different project (advanced; v0.3+).
- Right-click context menu: pause, stop, restart, view config, copy bober ID.

### 4.3 Agent detail (middle, ~50%)

Shown when an individual agent is selected. Sections (top to bottom):

1. **Header**: agent type icon, name, current status badge, active project link.
2. **Current task**: which contract / spec ID, which iteration, which phase (read / plan / write / verify), elapsed time, ETA based on rolling-average historical times.
3. **Token budget**: live usage vs cap, sparkline of last hour, per-model breakdown (Opus vs Sonnet). Data comes from `.bober/graph/token-usage.jsonl`.
4. **Live activity timeline**: append-only stream of `agent.action` events (read, edit, bash, spawn, etc.). Tail-follows by default; clicking an item shows full args.
5. **Files touched this session**: tree-grouped list of file paths the agent has read/written.
6. **Embedded terminal** (collapsible): xterm pane attached to this agent's underlying Claude Code process when applicable. Reuses Sprint 2's `ClaudeTerminalPane`.
7. **Control bar**: ⏸ pause / ⏹ stop / ↻ redirect (opens chat panel pre-filled). Disabled if the agent type doesn't support the verb yet (see §6.2).

### 4.4 Context / Chat (right, ~28%)

Two modes, toggled by sub-tab:

- **Team Lead Chat** — bound to the currently-selected folder's team lead. Persistent thread per project. Used to issue project-level directives: "stop working on PR #42, focus on the regression in `auth.ts`". The team-lead agent interprets and routes to specific subagents.
- **Notifications** — filtered to the current selection. Last 50 events for the selected folder or agent.

The chat input supports slash commands: `/pause`, `/start <spec-id>`, `/spawn generator`, `/budget 50k`, `/escalate human`.

### 4.5 "Overview" mode (no agent selected)

When the folder root is selected, the middle pane shows a project-level dashboard:

- Active agents grid (each card = one agent with mini-state)
- Sprint progress bar across the active spec
- Open clarifications (`PlanSpec.clarificationQuestions` — new in v0.12) — each renders as a card with an inline answer input that calls `bober plan answer` server-side
- Open PRs (links to Repos tab)
- Token spend today + week
- Incidents in the last 7 days (from `.bober/graph/incidents.jsonl`)

### 4.6 Folder-empty mode

When no projects are configured, show an onboarding card: "Point bober at a project root." Walks through `bober init` invocation and adds the path to the configured roots.

---

## 5. Tab 2: Build

The user's "AI agent that automatically adds something to the app" idea. A dedicated full-screen workspace separate from Agents because the use case is different: ad-hoc creative requests, not management of existing work.

### 5.1 Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Build Assistant       target: openhands-bober/main      ⚙ change target  │
├──────────────────────────────────────────┬───────────────────────────────┤
│                                          │                               │
│   CHAT                                   │   PREVIEW                     │
│                                          │                               │
│ You: add a "Recent activity" widget      │   ◉ Tab: Diff                 │
│ to the top of the SprintControlPanel    │     • frontend/src/bober/.../ │
│ showing the last 5 agent events.        │       sprint-control-panel    │
│                                          │       .tsx (+34/-2)           │
│ Assistant: I'll do that. Spawning        │     • frontend/src/bober/.../ │
│ build sprint BUILD-20260525-recent-act.  │       recent-activity         │
│ Plan:                                    │       widget.tsx (new)        │
│  1. Add RecentActivityWidget component   │     • + 1 test file           │
│  2. Wire to BoberStore selector          │                               │
│  3. Insert at top of panel               │   ◯ Tab: Live preview         │
│  4. Add 4 tests                          │     (iframe of dev server)    │
│                                          │                               │
│ Assistant: ⚙ Sprint started → BUILD-... │   ◯ Tab: Logs                 │
│ Generator-build-1 is working...          │     (tail of generator agent) │
│                                          │                               │
│ Assistant: ✓ Done. 4/4 tests pass.       │   [Approve] [Reject] [Edit]  │
│ Ready for review →                       │                               │
│                                          │                               │
│ [▌                                     ] │                               │
└──────────────────────────────────────────┴───────────────────────────────┘
```

### 5.2 Behavior

- The chat is a thread with a dedicated **Build Assistant** agent (proposed new type; see §8).
- The Build Assistant translates each user message into a one-shot bober sprint targeting the configured repo (default: openhands-bober itself — the dogfood loop). The user can change target via the top dropdown.
- While a sprint runs, the preview pane updates:
  - **Diff tab**: streaming git diff of the working tree, file-by-file with collapse/expand
  - **Live preview tab**: an iframe of the running dev server (uses the existing `make run` for openhands-bober)
  - **Logs tab**: tail of the generator agent's activity timeline
- On sprint completion, the user clicks **Approve** (merges into the current branch) or **Reject** (resets the working tree) or **Edit** (opens chat to refine — triggers an iteration).
- All build sprints are tagged with `BUILD-` prefix so they don't get confused with regular planned work in the Agents tab.

### 5.3 The dogfood loop made explicit

When `target: openhands-bober/main` is selected, this tab IS the original "use the agent to edit the agent's own UI" workflow. The Approve action commits to the openhands-bober repo on a feature branch; the merge-safety CI catches anything that would break upstream-pull invariants.

### 5.4 Templates and presets

Below the chat input, a row of templated quick-actions:

- "Add a new tab to the conversation view"
- "Add a setting to the LLM settings page"
- "Add a status indicator for X"
- "Refactor component Y"

Each fills the chat prompt with a structured starting point so the user doesn't write from scratch every time.

---

## 6. Tab 3: Repos

### 6.1 Layout

```
┌─────────────────────────────┬────────────────────────────────────────────┐
│  REPOS                      │   PR DETAIL                                │
│                             │                                            │
│  BOBER3r/openhands-bober    │   #14  Add recent activity widget          │
│   ▸ #14 Add recent...  ◐    │   ────────────────────────────────         │
│   ▸ #13 Fix sse leak   ◉    │   author: build-assistant                  │
│   ▸ #12 ...            ✓    │   status: ◐ CI running (2/5 checks)        │
│                             │                                            │
│  BOBER3r/agent-bober        │   ◉ Tab: Conversation                      │
│   ▸ #15 Add --sprint-… ◯    │     Build-Assistant: I implemented...     │
│   ▸ #14 ...            ✓    │     gen-build-1: ✓ all tests pass         │
│                             │     evaluator: ✓ contract met             │
│  solex-integration-demo     │                                            │
│   ▸ #41 Add new tenant ◐    │   ◉ Tab: Diff (open in Repos)              │
│                             │                                            │
│  + Add repo                 │   ◉ Tab: Checks                            │
│                             │     ✓ lint                                 │
│                             │     ◐ unit-test (running)                  │
│                             │     ✓ typecheck                            │
│                             │     ◯ upstream-merge-safety (queued)       │
│                             │     ✗ build (failed — see logs)            │
│                             │                                            │
│                             │   [Merge] [Request changes] [Comment]      │
└─────────────────────────────┴────────────────────────────────────────────┘
```

### 6.2 Capabilities

- **PR list**: all open PRs across configured repos, fetched via `gh pr list`. Status icon, age, agent author (if any), reviewer.
- **Create PR**: triggered from a completed sprint (Agents tab) OR from a Build chat (Build tab). Auto-fills title and body from the sprint's contract + completion report.
- **PR detail**: conversation feed (merging GitHub comments + bober agent commentary), diff, checks. Inline diff comments are POST'd back via `gh api`.
- **Approve flow**: clicking Merge invokes `gh pr merge`. Configurable: require all checks green, require human approval, require N-min cooling-off after CI green.
- **Watch checks**: live CI status via `gh pr checks --watch` polled or via webhook receiver if configured.

### 6.3 Cross-link

When a PR is created by a build sprint, the PR detail links back to the originating chat thread in Build tab. When a sprint produced multiple PRs, all are listed.

---

## 7. Tab 4: Ops

### 7.1 Layout

```
┌─────────────────────────────┬────────────────────────────────────────────┐
│  SERVERS                    │   prod-ec2-1                               │
│                             │   ──────────────                           │
│  ▶ prod-ec2-1     ec2 us-w  │   Status:  ◉ healthy                        │
│  ▶ prod-ec2-2     ec2 us-w  │   Uptime:  14 days                         │
│  ▶ staging        ec2 us-w  │   Load:    0.42                            │
│  ◯ macroperp      docker    │                                            │
│                             │   ◉ Tab: Live log (deploy.log)             │
│  DEVOPS AGENTS              │     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━       │
│                             │     [13:51] api healthy                    │
│  ⬢ deploy-agent             │     [13:52] 200 GET /v1/positions          │
│    deploying sprint-9...    │     [13:52] 200 POST /v1/order             │
│  ⬢ rollback-watcher  ◯ idle │     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━       │
│  ⬢ new-customer-bot         │                                            │
│    provisioning tenant...   │   ◉ Tab: Deploy map                        │
│                             │     [Visualization of deploy stages]       │
│  + Add agent                │                                            │
│                             │   ◉ Tab: Agents on this host               │
│                             │     deploy-agent  ▶ running                │
│                             │     new-customer-bot  ▶ running            │
└─────────────────────────────┴────────────────────────────────────────────┘
```

### 7.2 Capabilities

- **Server registry**: configured list of hosts with metadata (cloud, region, role, SSH credentials reference). v0.4+: auto-discovered from AWS / GCP via SDK.
- **Live log streaming**: per-server, per-file. Backend opens an SSH session and tails a configurable list of log paths. Streamed to UI via the existing SSE channel with a new event kind `log.line`. Supports grep filters and download.
- **Devops agents**: a new agent type whose lifecycle is "watch X, do Y" rather than "do a sprint and stop." Each has its own state row:
  - `deploy-agent`: watches PR merges, triggers deploy pipeline, reports back
  - `rollback-watcher`: watches health metrics, reverts on regression
  - `new-customer-bot`: provisions a fresh tenant (the solex use case!)
- **Deploy map** (visualization): a directed graph of deploy stages — `pr-merge → build → push-image → ec2-deploy → smoke-test → notify`. Each node colored by current state, edges animated on traversal. Selected from a stage shows logs for just that step.

### 7.3 The solex use case made concrete

`+ Add agent → Use template: new-tenant`. Wizard collects:
- tenant name, EC2 target, DB credentials reference (vault key, not the secret)
- The wizard generates a sprint contract on the fly (a parameterized template), spawns a `new-customer-bot`, and shows the live progress on the Ops tab. The bot's "phase" field walks through `provision-db → seed-config → deploy-service → smoke-test → notify-user`. Each phase is a step the agent reports via the same `agent.action` event channel as everything else.

---

## 8. Tab 5: Inbox

### 8.1 Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Inbox                                              [All] [Unread] [⚙]   │
├──────────────────────────────────────────────────────────────────────────┤
│  ◯  2 min ago    sprint-completed   bober/sprint-7-iter-3                │
│  ●  18 min ago   needs-clarification spec-20260525-add-leaderboard       │
│  ●  47 min ago   pr-needs-review     openhands-bober#14                  │
│  ●  1 hr ago     ci-failed           agent-bober#15  build               │
│  ●  3 hr ago     deploy-completed    solex prod-ec2-1                    │
│  ◯  5 hr ago     budget-warning      generator-2 reached 80% of 80k cap  │
│  ◯  yesterday    incident            sprint-9 evaluator flagged regress  │
└──────────────────────────────────────────────────────────────────────────┘
```

### 8.2 Capabilities

- Aggregated feed of every notification-worthy event across all tabs.
- Each event row links back to its source (PR, sprint, server, agent).
- Filtering: by kind, by project, by severity.
- Settings: per-event-kind toast vs silent vs OS notification (via `Notification` API).
- Snooze: dismiss for an hour / a day / until resolved.
- Bulk actions: mark all read, archive, export.

### 8.3 Event sources (and where each comes from on disk)

| Event | Source |
|---|---|
| `sprint-started/completed/failed` | `.bober/history.jsonl` (already written) |
| `needs-clarification` | `.bober/specs/*.json` watcher detects status change |
| `pr-needs-review` | GitHub webhook (preferred) or `gh pr list --search "review-requested"` poll |
| `ci-failed` | GitHub Actions webhook (preferred) or `gh run watch` poll |
| `deploy-completed/rollback` | devops agent writes to `.bober/ops/events.jsonl` (new) |
| `budget-warning` | per-agent: token-usage > threshold% of budget — derived from `.bober/graph/token-usage.jsonl` |
| `incident` | `.bober/graph/incidents.jsonl` watcher (new in v0.13) |

---

## 9. Status bar (persistent across all tabs)

```
◉ 3 active      ⚡ 142k / 200k tokens    ⚠ none      bober v0.13.0    ◐ ◐ ◐
```

- **3 active**: count of running agents across all folders. Hover → list.
- **142k / 200k tokens**: rolled-up token spend across all agents today vs configured daily cap. Hover → per-agent breakdown.
- **⚠ degraded modes**: aggregates `health.degradedReasons` from each running backend (watcherMode='polling', wsMode='text-fallback', etc.). Click → expanded list.
- **bober v0.13.0**: connected bober CLI version. Red badge if openhands-bober's Pydantic mirrors are out of sync (drift detected).
- **◐ ◐ ◐**: live connection indicators — SSE, WS, GitHub. Each clickable for reconnect.

---

## 10. Bidirectional integration model

The single most important architectural change. Today the UI reads `.bober/` and that's it. The new model has three flows:

### 10.1 Read flow (already mostly works)

```
agent-bober CLI writes  →  .bober/{specs,sprints,eval-results,handoffs}/*.json
                       →  .bober/history.jsonl (append)
                       →  .bober/graph/{incidents,token-usage}.jsonl (append, v0.13)
                       →  .bober/agents/<agent-id>/state.json (NEW)
ArtifactWatcher (openhands-bober) → SSE → BoberStore → UI re-render
```

The NEW piece is `.bober/agents/<agent-id>/state.json` — see §11.1.

### 10.2 Write/command flow (NEW)

```
UI button click → BoberApiClient → POST /api/v1/bober/agents/<id>/command
                                 → openhands_bober/agents/command_dispatcher.py
                                 → writes .bober/agents/<id>/commands/<uuid>.json
                                 → agent-bober CLI watches that dir, picks up command
                                 → executes, writes result back to state.json
                                 → ArtifactWatcher picks it up → SSE → UI
```

File-based command queue keeps the boundary subprocess-only (per ADR-2). Each command is a JSON object: `{type: "pause" | "stop" | "redirect" | "redo", payload?, requestedAt, requestedBy}`. Agent processes the queue on its next event-loop tick.

### 10.3 Chat flow (NEW — used by Team Lead and Build tabs)

```
UI message  →  POST /api/v1/bober/chat/<channel-id>/message
            →  appends to .bober/chat/<channel-id>/messages.jsonl
            →  agent-bober "lead" agent watches the channel,
               replies by appending its own message + optionally
               spawning subagent work
SSE event   ←  ArtifactWatcher detects new line  ←  message written
UI displays
```

Channels are identified by `{project-root}-{team-name}` for team-lead chats, and `build-{nonce}` for build sessions. Each chat is durable and resumable across browser refreshes.

---

## 11. Required bober additions

The above can only work if agent-bober grows the following surfaces. These are net-new features to add to the agent-bober repo (separate from the openhands-bober work).

### 11.1 Agent runtime state emitter

Every running agent (planner, generator, evaluator, curator, lead, devops-*) writes to:

```
.bober/agents/<agent-id>/state.json    # current snapshot, atomic rename
.bober/agents/<agent-id>/activity.jsonl # append-only event log
.bober/agents/<agent-id>/commands/      # inbox for control verbs
```

`AgentRuntimeState` schema (proposed Zod):

```ts
{
  agentId: string,
  agentType: "planner" | "curator" | "architect" | "researcher"
            | "generator" | "evaluator" | "team-lead" | "build-assistant"
            | "devops-deploy" | "devops-rollback" | "devops-tenant" | ...,
  projectRoot: string,
  status: "idle" | "running" | "paused" | "stuck" | "blocked-on-clarification" | "completed-recent",
  currentTask?: {
    contractId?: string,
    specId?: string,
    phase: string,
    startedAt: string,
    estimatedEndAt?: string,
  },
  tokens: { used: number, cap: number, model: string }[],
  lastHeartbeatAt: string,
  filesTouched: string[], // bounded to last 50
  pendingCommands: number, // count of unconsumed commands
}
```

Emitter cost: one atomic-write per agent per ~5s while running. Cheap.

### 11.2 Command receiver

Each agent's main loop polls `.bober/agents/<agent-id>/commands/*.json` (sorted by mtime). On each tick:
- `pause`: stop after current model call, mark state paused, await `resume`
- `stop`: terminate cleanly, mark state idle
- `redirect`: inject a new instruction into the next prompt
- `budget <n>`: update token cap dynamically

### 11.3 Team-lead agent type (NEW)

A new agent definition `agents/bober-team-lead.md`. Spawned automatically when a project has ≥2 active agents. Responsibilities:
- Owns the team chat channel
- Translates natural-language project-level directives into specific subagent commands
- Surfaces blockers from any subagent up to the user
- Can spawn / pause / stop other agents in the team
- Reports rollup status in its own state.json

Single most important new agent. Without it, the "chat with team lead" feature has nothing to bind to.

### 11.4 Build-assistant agent type (NEW)

A new agent definition `agents/bober-build-assistant.md`. Each Build chat instantiates one. Responsibilities:
- Translates a freeform user request into a `PlanSpec` + one or more `SprintContract`s scoped to the configured target repo
- Spawns generator + evaluator subagents to execute
- Reports progress back to the chat channel
- Surfaces approve/reject/edit decision points

### 11.5 DevOps agent types (NEW)

Initial set: `bober-devops-deploy`, `bober-devops-rollback`, `bober-devops-tenant`. Each is a long-lived "watch X, do Y" agent — different lifecycle from sprint agents. Needs a new `AgentLifecycle: "sprint" | "long-lived"` distinction in the agent definition format.

### 11.6 Schema migrations

Update openhands-bober's Pydantic mirrors to reflect v0.12/v0.13:
- `PlanSpec`: + `status` (incl. `needs-clarification`), `mode`, `ambiguityScore`, `clarificationQuestions`, `resolvedClarifications`, `assumptions`, `outOfScope`
- `SprintContract`: + `nonGoals`, `stopConditions`, `definitionOfDone`, `assumptions`, `outOfScope`, `ambiguityScore`
- New: `AgentRuntimeState`, `ChatMessage`, `Notification`, `DevopsTask`, `ServerEntry`

Drift-check test (Sprint 4) will catch these — needs updating in lockstep.

### 11.7 Clarification answer endpoint

UI needs to POST clarification answers. Either:
- (a) UI shells out via subprocess to `bober plan answer <specId> <qId> "<answer>"` (uses existing CLI; cheapest)
- (b) Add an `agent-bober` REST surface (would force agent-bober to grow into a daemon — big architectural change)

Recommend (a) for v0.2. Promote to (b) only if multi-host becomes a requirement.

### 11.8 Token-usage normalization

`.bober/graph/token-usage.jsonl` is per-line per-call. UI needs both raw stream and rolled-up `per-agent / per-hour / per-day` aggregates. Either:
- (a) UI rolls up in-memory (simple; recomputed on hydrate)
- (b) bober writes pre-aggregated `.bober/graph/token-usage-daily.json` snapshot

Start with (a). Move to (b) only when the jsonl file gets large (>10MB).

---

## 12. Component breakdown for openhands-bober

New TS components in `frontend/src/bober/v2/`. The existing v1 SprintControlPanel remains as the per-conversation embedded view. v2 is the full command center accessed via a separate route, likely `/bober/console` (still under the additive route added by Sprint 1, but a child route).

| Component | File | Responsibility |
|---|---|---|
| BoberConsoleRoute | `v2/routes/bober-console.tsx` | Top-level five-tab shell + status bar |
| AgentsTab | `v2/tabs/agents-tab.tsx` | 3-pane layout host |
| AgentFolderTree | `v2/components/agent-folder-tree.tsx` | Sidebar tree with live state badges |
| AgentDetailView | `v2/components/agent-detail-view.tsx` | Middle pane with header/timeline/budget/files |
| AgentActivityTimeline | `v2/components/agent-activity-timeline.tsx` | Live tail of activity.jsonl |
| AgentTokenSparkline | `v2/components/agent-token-sparkline.tsx` | Last-hour token-usage micro-chart |
| AgentControlBar | `v2/components/agent-control-bar.tsx` | Pause/stop/redirect buttons |
| TeamLeadChat | `v2/components/team-lead-chat.tsx` | Project-level chat surface |
| ProjectOverviewPanel | `v2/components/project-overview-panel.tsx` | Folder-root dashboard |
| ClarificationCard | `v2/components/clarification-card.tsx` | Inline answer input for needs-clarification specs |
| BuildTab | `v2/tabs/build-tab.tsx` | Split chat + preview |
| BuildChat | `v2/components/build-chat.tsx` | Build-Assistant conversation |
| BuildPreviewPane | `v2/components/build-preview-pane.tsx` | Diff / iframe / logs sub-tabs |
| BuildApprovalBar | `v2/components/build-approval-bar.tsx` | Approve/Reject/Edit |
| ReposTab | `v2/tabs/repos-tab.tsx` | PR list + detail |
| RepoList | `v2/components/repo-list.tsx` | Grouped PR sidebar |
| PRDetailView | `v2/components/pr-detail-view.tsx` | Conversation/diff/checks tabs |
| OpsTab | `v2/tabs/ops-tab.tsx` | Servers + devops agents |
| ServerList | `v2/components/server-list.tsx` | Configured hosts + status |
| LogStream | `v2/components/log-stream.tsx` | Live tail of remote log |
| DeployMap | `v2/components/deploy-map.tsx` | DAG visualization of deploy stages |
| DevopsAgentList | `v2/components/devops-agent-list.tsx` | Long-lived agents inventory |
| InboxTab | `v2/tabs/inbox-tab.tsx` | Notification feed |
| NotificationRow | `v2/components/notification-row.tsx` | Per-event row |
| GlobalStatusBar | `v2/components/global-status-bar.tsx` | Persistent bottom bar |
| AgentStateStore | `v2/state/agent-state-store.ts` | Zustand store for all agent runtime states (extends BoberStore) |
| ChatStore | `v2/state/chat-store.ts` | Per-channel message history |
| NotificationStore | `v2/state/notification-store.ts` | Aggregated feed |
| BoberV2ApiClient | `v2/api/v2-client.ts` | Extends Sprint 7's client with new endpoints |

Existing v1 components (SprintControlPanel, ClaudeTerminalPane, etc.) are reused — the AgentDetailView's terminal sub-section embeds `ClaudeTerminalPane`; the ProjectOverviewPanel reuses Sprint-7 components for the sprint progress row.

---

## 13. New backend endpoints (openhands_bober)

| Endpoint | Method | Purpose |
|---|---|---|
| `GET /api/v1/bober/projects` | GET | List configured project roots |
| `GET /api/v1/bober/projects/<root>/agents` | GET | Per-project agent list with state |
| `GET /api/v1/bober/agents/<id>/state` | GET | Single agent snapshot |
| `GET /api/v1/bober/agents/<id>/activity` | SSE | Live activity stream for one agent |
| `POST /api/v1/bober/agents/<id>/command` | POST | Enqueue control verb (writes to commands/ dir) |
| `GET /api/v1/bober/chat/<channel>/messages` | GET | Message history |
| `POST /api/v1/bober/chat/<channel>/message` | POST | Append user message + signal lead agent |
| `GET /api/v1/bober/chat/<channel>/stream` | SSE | Live message stream |
| `POST /api/v1/bober/specs/<id>/clarify` | POST | Answer a clarification question (shells to `bober plan answer`) |
| `GET /api/v1/bober/graph/incidents` | GET / SSE | Tail of incidents.jsonl |
| `GET /api/v1/bober/graph/token-usage` | GET | Aggregated token usage (per-agent / per-hour / per-day) |
| `GET /api/v1/bober/repos` | GET | Configured repo list (uses gh cli to enrich) |
| `GET /api/v1/bober/repos/<owner>/<name>/prs` | GET | PR list (gh pr list passthrough) |
| `POST /api/v1/bober/repos/<owner>/<name>/prs` | POST | Create PR (gh pr create) |
| `GET /api/v1/bober/repos/<owner>/<name>/prs/<n>` | GET | PR detail (gh pr view) |
| `POST /api/v1/bober/repos/<owner>/<name>/prs/<n>/merge` | POST | Merge (gh pr merge) |
| `GET /api/v1/bober/servers` | GET | Server list |
| `GET /api/v1/bober/servers/<id>/logs/<path>` | SSE | Tail remote log via SSH |
| `GET /api/v1/bober/notifications` | GET / SSE | Aggregated feed |

All additive under the existing `/api/v1/bober/*` prefix — no upstream insertion changes required.

---

## 14. Data model summary

New Pydantic mirrors needed in `openhands_bober/artifacts/models.py`:

- `AgentRuntimeState` (mirrors agent-bober Zod, see §11.1)
- `ChatMessage` { id, channelId, author, authorType, content, createdAt, references?: { specId?, contractId?, prUrl? } }
- `Notification` { id, kind, severity, title, body, source, createdAt, readAt? }
- `Repo` { owner, name, url, defaultBranch }
- `PullRequest` { number, title, author, status, checksSummary, createdAt, mergedAt? }
- `Server` { id, name, host, region, role, sshCredentialRef }
- `DevopsTask` { id, agentId, kind, phase, payload, startedAt, completedAt? }

Plus the v0.12/v0.13 field additions to PlanSpec / SprintContract called out in §11.6.

---

## 15. Phased rollout

| Phase | Scope | Estimated bober changes | Estimated UI changes |
|---|---|---|---|
| **0** (prerequisite) | Update Pydantic mirrors to v0.13 schema + add clarification answer endpoint via subprocess + bump drift-check test | None to agent-bober; ~3 files openhands-bober | one screen (clarification card on existing SprintControlPanel) |
| **1: Agents tab read-only** | Folder tree + agent detail + activity timeline + token sparkline + project overview. Read-only — no commands yet. | Agent-bober: add state emitter to every agent type (write state.json + activity.jsonl). ~1 sprint. | ~12 components, 1 store, 5 endpoints. ~2-3 sprints. |
| **2: Agent commands** | Pause / stop / redirect. Requires bober command receiver in every agent's main loop. | Agent-bober: add command poll in agent loops. ~1 sprint. | Adds AgentControlBar + 1 endpoint. ~1 sprint. |
| **3: Team-lead chat** | Spawnable team-lead agent type + chat backbone | New `bober-team-lead.md` agent + chat write/read primitives. ~2 sprints. | TeamLeadChat + ChatStore + 3 endpoints. ~1 sprint. |
| **4: Build tab** | Build-assistant agent + the dogfood loop made first-class | New `bober-build-assistant.md` agent + repo-targeting in sprint contracts. ~1-2 sprints. | BuildTab + BuildChat + BuildPreviewPane + BuildApprovalBar + iframe dev-server integration. ~2 sprints. |
| **5: Repos tab** | PR list / detail / create / merge via gh CLI passthrough | None to agent-bober. | ReposTab + PRDetailView + 5 endpoints (gh CLI wrappers). ~1-2 sprints. |
| **6: Ops tab v1** | Server registry + live log streaming via SSH | None to agent-bober. Backend grows SSH log tailer. | OpsTab + ServerList + LogStream + 2 endpoints. ~1-2 sprints. |
| **7: Devops agents** | new-tenant + deploy + rollback agents + deploy-map visualization | New devops agent types (long-lived lifecycle). ~2-3 sprints. | DevopsAgentList + DeployMap + 1 endpoint. ~1-2 sprints. |
| **8: Inbox + status-bar polish** | Unified notification feed + persistent status bar + OS notification opt-in | Minor: incidents writer for non-graph events. | InboxTab + NotificationStore + GlobalStatusBar. ~1 sprint. |

**Total realistic estimate**: 8 phases over ~6 months of focused 6-day sprints. Phase 0 is a 1-week prereq before any UI work begins; recommend doing it BEFORE Phase 1 because the drift-check test will start failing otherwise.

---

## 16. Open questions / decisions before any of this starts

1. **Where do project roots get configured?**
   - Option A: user settings file `~/.bober/console.toml` listing absolute paths
   - Option B: auto-scan `~` for `.bober/` dirs at startup
   - Option C: every project registers itself in `~/.bober/registry.json` when `bober init` runs there
   - Recommend: C, with B as bootstrap-on-first-run, A as fallback.

2. **Does agent-bober become a daemon, or stay subprocess-per-run?**
   - Current: subprocess per sprint, dies when sprint terminates
   - For team-lead chat to work, lead needs to be long-lived (always listening). Means either bober gets a `bober daemon` mode, or the team-lead is implemented as a separate per-project always-on process.
   - Recommend: add `bober daemon` mode in Phase 3, opt-in. Existing subprocess model remains the default for sprint agents; daemon hosts team-lead + devops + build-assistant long-lived types.

3. **GitHub auth — PAT vs `gh` CLI?**
   - Phase 5 needs GitHub access. `gh` CLI passthrough is zero-setup (uses user's existing auth) but ties us to subprocess. PAT requires a setup step but enables headless / multi-host.
   - Recommend: `gh` CLI passthrough for v0.2. PAT as opt-in for advanced users.

4. **SSH credential storage for Ops tab?**
   - macOS keychain is the right answer. `keytar` npm package (frontend) or `python-keyring` (backend) — backend is the right place since SSH happens server-side.
   - Recommend: backend uses `keyring` with backend selection (keychain on macOS). v0.4+ adds a cloud-vault adapter.

5. **Build-Assistant target repo discovery?**
   - Phase 4. Default is "the currently-running openhands-bober checkout" (dogfood). Other targets: any configured project root.
   - Open: does Build-Assistant need write access to the target repo's git? Yes if it commits. Means we need a git-author identity per target.

6. **Multi-user / multi-tenancy?**
   - Out of scope for v0.1-v0.8. The whole design assumes single developer / single machine.
   - If multi-user is ever needed, the file-based command queue + chat channels become a database. Big rewrite. Don't plan for it now.

7. **Mobile?**
   - Out of scope.

8. **Existing Sprint 7 SprintControlPanel — kept or deprecated?**
   - Recommend: kept. It's the per-conversation embedded view; v2 is the standalone console. Two surfaces, different jobs.

9. **iframe live-preview in Build tab — same-origin issues?**
   - Vite dev server runs on a different port. CSP / same-origin policies may bite. Workaround: use an `<iframe sandbox>` with explicit origin allowlist, or proxy the preview through openhands-bober backend.
   - Recommend: prototype both, decide in Phase 4 spike.

10. **Token cap enforcement — bober side or UI side?**
    - bober side: real enforcement, agent stops at cap.
    - UI side: visualization only, no enforcement.
    - Recommend: BOTH. bober enforces (already does, via `preflight-budgets.ts`). UI visualizes + warns at 80%.

---

## 17. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Schema drift between agent-bober Zod and openhands-bober Pydantic accelerates as bober ships features faster than mirrors update | high | Drift-check test ALREADY catches this (sc-4-4). Make CI blocking. Add a `bober-pydantic-mirror` CLI to agent-bober that generates the Python types — eliminates manual sync. |
| File-based command queue has race conditions (UI sends two commands to one agent simultaneously) | medium | Atomic rename + monotonic IDs. Agent processes in mtime order. Most commands are idempotent. |
| Team-lead agent grows into an LLM-prompted dispatcher that hallucinates routing → wrong subagent gets the work | high | Lead emits explicit routing as JSON (not free text) in its state.json. UI surfaces routing decisions. User can override. Add a contract-style test: given fixture user messages, lead routes to specific subagent types. |
| Build-Assistant approve flow merges broken code to main | critical | Approve requires: (a) all eval strategies pass, (b) CI green on the branch, (c) user confirms in modal. No auto-merge. |
| Devops agents accidentally take down prod (rm -rf on the wrong host) | critical | Every devops agent runs in dry-run mode by default. Switching to live requires explicit user confirmation per session. Production-destructive verbs require a separate `--confirm-prod` flag. Log every action to `.bober/ops/audit.jsonl` for forensics. |
| Notification volume becomes overwhelming | medium | Configurable per-kind: toast / silent / OS notif. Default to silent for low-severity. Snooze + bulk-archive. |
| Browser tab pinned for hours holds many SSE connections → memory growth | medium | Periodic connection cycling (close + reopen every 30 min); explicit cleanup on visibility-hidden. |
| Backend startup time grows as we add SSH log tailers + GitHub pollers + watcher self-heals | medium | Lazy-init: don't start a log tailer until the Ops tab opens with that server selected. |
| Cross-repo absolute paths in docs become wrong on other machines (we hit this in Sprint 7) | low | Sprint 9's lesson: never hardcode absolute paths in any committed file. Reuse the same rule. |

---

## 18. Open questions for the user (please answer before Phase 0)

1. Confirm openhands-bober remains the host frontend (vs. a brand new Electron / Tauri shell). The design assumes openhands-bober. If you'd rather strip OpenHands and build a dedicated app, the whole §12 changes.
2. Confirm the team-lead concept makes sense for your workflow. If you mostly drive a single agent at a time per project, team-lead is overhead. Worth keeping?
3. How many projects (project roots) are you likely to have configured at once? (Affects sidebar density.)
4. For Ops tab — what concrete servers are in scope for v0.6? Just the solex prod EC2, or also staging, macroperp, anything else?
5. For Build tab — should the default target be openhands-bober (dogfood) or solex (your actual product)?

---

## 19. What to do next

Suggested immediate sequence:

1. **Read this doc, answer §18.** ~30 min.
2. **Phase 0 sprint**: bump Pydantic mirrors + add clarification endpoint + display existing v0.13 fields in SprintControlPanel. ~3-5 days of bober-run.
3. **Run a thought-experiment session against §15 phases**: which phases are must-have for your daily workflow, which can wait? Re-order if needed.
4. **Phase 1 sprint plan**: spec out the Agents tab as a bober plan. Likely 3-4 sprints. The dogfood loop fully kicks in: Phase 1 itself can be built via the Build tab once Phase 4 lands, but Phase 1 is needed first to make Phase 4 visible.
5. **Use the existing bober sprint flow** to execute. Same 9-sprint cadence we just used for v0.1.0.

---

## 20. Out of scope (for this doc)

- Concrete pixel-level visual design (colors, spacing, typography). Defer to a separate design spike with Figma or v0 mocks.
- Onboarding flow for new users.
- Plugin architecture for third-party agents.
- Marketplace / sharing of agent definitions.
- Mobile.
- Multi-user.
- Cloud-hosted variant (everything assumed single-machine).
- Pricing / billing model if this ever becomes a product.

---

**End of design.**
