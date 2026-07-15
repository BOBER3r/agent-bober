# Design Brief — Agent Command Center

**Project codename:** Bober Console
**Brief for:** UI/UX designer
**Date:** 2026-05-25
**Deliverable expected:** high-fidelity mockups + interactive prototype for the screens described below, plus a small reusable design system (tokens, components, states)
**Platform:** desktop web app, dark-mode primary, light-mode secondary, ≥1280px target, graceful to 1024px, no mobile
**Tone:** serious developer tool — Linear / Vercel / Cursor / Raycast neighborhood. Dense but not cluttered. No marketing language anywhere in the UI.

---

## 1. One-paragraph product summary

A single web app where a developer sees and controls every AI agent working on their code, in real time. Agents are grouped into folders (one per project), each folder has a "team lead" agent that the user chats with at a project level, and individual agents (planner, builder, evaluator, devops, etc.) can be inspected, paused, redirected, or replaced. A separate workspace lets the user describe a feature in plain English and watch an agent build it, with live diff + preview. Another workspace shows pull requests across all repos and lets the user create, review, and merge them. Another shows running servers, live log tails, and devops agents that handle deploys and tenant provisioning. Across the top of everything is a notification feed of completions, failures, requests for review, and budget warnings.

Think of it as: **the IDE for managing your agents, not for writing code.**

---

## 2. Who uses this

**Primary user:** A solo or small-team developer who has 3–10 agents running across 2–6 projects at any time, day-in day-out, often unattended for hours.

**A day in their life:**
- Morning: opens the app, sees the Inbox tab — 4 overnight events: a PR is ready for review, a sprint failed and needs clarification, a deploy succeeded, a token budget warning.
- Walks through each, taking action.
- Switches to Agents tab. Folder for `solex` is highlighted — 3 active agents. Clicks the planner that's waiting on a clarification, answers inline.
- Switches to Build tab. Types: "add a feedback widget to the settings page of solex." Watches the assistant produce a plan, asks for one tweak, watches it ship.
- While that runs, switches to Ops tab. Tails the prod EC2 log because something looked weird earlier. Sees the rollback-watcher agent is healthy.
- Closes the laptop. Comes back four hours later. Sees Inbox showing the build assistant finished, the PR is up, CI passed, ready to merge.

**What they care about (in order):**
1. Knowing what every agent is doing right now without having to ask
2. Being able to stop / redirect anything in one click
3. Trusting that an agent's "done" actually means done
4. Visibility into spend (tokens are money)
5. Not being interrupted unless something needs them

**What they hate:**
- Modals that block multi-tasking
- Notifications they can't snooze
- "Are you sure?" dialogs for reversible actions
- Dashboards that look impressive but bury the action they need
- Anything that requires more than two clicks to get back to "what's running right now"

---

## 3. Reference products (visual & interaction anchors)

The designer should look at all of these before sketching. Each is referenced for a specific reason:

| Product | What to take from it |
|---|---|
| **Linear** | Information density done well. Sidebar nav. Keyboard-first. Subtle but confident motion. Color used sparingly and meaningfully. |
| **Vercel dashboard** | The way deployments are visualized as a pipeline. The way log streams are presented. Status badges. |
| **Cursor** (the IDE) | Side-by-side chat + code/preview pattern. How agent commentary mixes with user input. |
| **Raycast** | Command-palette as a primary navigation method. Action-first UX. |
| **Datadog / Grafana** | Live sparkline charts for time-series data (token usage). |
| **GitHub web (PR review)** | The structure of a PR detail view — conversation, diff, checks tabs. |
| **Discord** | Persistent multi-channel chat with notification states. |
| **Things 3 / Linear inbox** | Notification feed UX, snooze patterns. |

What to NOT reference:
- ChatGPT / Claude.ai (too consumer, too whitespace-heavy, no info density)
- Slack (too noisy, too generic for a focused tool)
- Notion (too document-heavy)

---

## 4. What exists today (the baseline to improve on)

Today the product is an open-source IDE called OpenHands with one small custom tab added called "Bober". When the user opens that tab, they see:

- A two-column layout: a thin **sprint control panel** on the left listing specs and sprints from disk, an **embedded terminal** on the right showing a Claude Code session, and a **status bar** along the bottom showing health flags.
- The terminal is fully functional — the user can type in it and Claude responds.
- The sprint control panel can list `PlanSpec` files (a structured description of work) and `SprintContract` files (a single unit of work the agent executes), but only the most basic fields are surfaced. Clicking "Start Sprint" launches a backend agent that does the work; progress streams in as JSON files appear on disk.
- A status bar shows "degraded mode" banners when something is wrong (e.g. WebSocket can't carry binary frames, no API key configured, Claude CLI not authenticated, etc.).

It works but it's a **single-conversation, single-project, single-agent view**. There is no concept of multiple projects, multiple agents, agent inspection beyond their final output, chat with anyone other than Claude itself, PR awareness, server awareness, or notifications. The new design replaces this with a much larger surface — but the existing per-conversation embedded view stays for in-context use.

---

## 5. Design principles

These are the rules the designer should follow. Pin them on the wall.

1. **Show, don't hide.** Defaults to showing everything; the user collapses what they don't want. Never hide info behind a tooltip if it can be shown inline.
2. **One click to "what's running."** The Agents tab is the home base. From any screen, the user can get back to it with one click or one key.
3. **Density is a feature.** Developers can read dense layouts. Don't pad just for the sake of it. Linear-level density, not Notion-level whitespace.
4. **Status is color, action is text.** Status (running, idle, failed, blocked) is communicated by color + icon. Actions (pause, stop, merge, deploy) are text buttons. Never overload color with action meaning.
5. **Live by default.** Anything that can be live should be live. No "click refresh." The only Refresh button anywhere is in the status bar (for manual recovery).
6. **Keyboard everything.** Every primary action has a keyboard shortcut. A command palette (Cmd+K) can reach any screen and any action.
7. **No modal walls.** Side panels, drawers, and inline expansions over modals. Modals are reserved for "this action is irreversible, are you sure" — and only when the action is *actually* irreversible.
8. **Honest empty states.** When there's nothing to show, say what would appear here and how the user causes it to appear. Never just say "No items."
9. **No success-only design.** Every screen has a degraded / error / loading mock. Don't sketch the happy path alone.
10. **The tone is "your colleague who actually knows what's going on."** Never cute. Never apologetic. Direct.

---

## 6. Information architecture

Top-level navigation is **five tabs** + a persistent **status bar** + a hideable global **command palette** (Cmd+K).

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ⬢ Bober   Agents  •  Build  •  Repos  •  Ops  •  Inbox       ⌘K  ⚙ 👤  │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│                       ( SELECTED TAB CONTENT )                           │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│  ◉ 3 active   ⚡ 142k / 200k   ⚠ none   bober v0.13   ● ● ●              │
└──────────────────────────────────────────────────────────────────────────┘
```

Each tab is described below as its own screen. The status bar and command palette span all tabs.

---

## 7. Tab 1 — Agents

This is the home base. Three columns.

```
┌─────────────┬──────────────────────────────────┬──────────────────────────┐
│             │                                  │                          │
│   LEFT      │           MIDDLE                 │         RIGHT            │
│   ~22%      │           ~50%                   │         ~28%             │
│             │                                  │                          │
│  Folders    │   Detail of the selected         │   Chat with the team     │
│  & agents   │   item (a folder, an agent,      │   lead of the selected   │
│             │   or "no selection")             │   folder. Or filtered    │
│             │                                  │   notifications.         │
│             │                                  │                          │
└─────────────┴──────────────────────────────────┴──────────────────────────┘
```

### 7.1 Left column — agent folder tree

A vertical tree, like a file explorer. Each top-level node is a **project folder**. Inside each folder are its **agents**.

Folder row:
- Folder icon, project name, total active agents badge (e.g. `solex` `3`)
- Expand/collapse caret on the left
- Subtle row hover + selected state

Agent row (indented under folder):
- Small **agent type icon** (each agent type has its own glyph; see component library section)
- Agent name (e.g. `gen-1`, `planner`, `lead`, `deploy-bot`)
- Right-aligned **status pip** (a small circle: green = running, grey = idle, yellow = paused, red = blocked/stuck, fading green = completed recently)
- A subtle one-line current-task ellipsis if running

Folder root has a special agent always pinned at the top: the **team lead** (👤). Visually different from individual agents — slightly larger, separated by a thin divider.

States to design:
- Empty state: no projects configured — onboarding card explaining how to add one
- Loading state: skeleton rows
- Many projects (≥6 folders) — the tree should remain scannable; consider collapsed-by-default for inactive
- Many agents in one folder (≥8) — still scannable, no horizontal overflow

Interactions:
- Click folder = select folder (middle pane shows project overview)
- Click agent = select agent (middle pane shows agent detail, right pane shows team-lead chat)
- Right-click = context menu (pause, stop, redirect, view config, copy ID)
- Drag agent to another folder = reassign (optional, can be v2)

### 7.2 Middle column — selected item detail

Three modes depending on what's selected:

**Mode A — Nothing selected (first load)**
A short hint: "Select a project or agent on the left."

**Mode B — Project folder selected (overview)**
A dashboard for the project:
- Header: project name, path on disk, primary repo link, "Open in Build" shortcut
- **Active agents grid**: small cards, one per running agent, showing name + task + status pip
- **Open clarification questions**: cards for any spec in `needs-clarification` state. Each card shows the question text + an inline answer input + a submit button. Critical pattern — these are the only things blocking progress.
- **Current sprint progress**: if a sprint is in flight, show the progress as a horizontal stepper (e.g. plan → research → write → verify → done) with current phase highlighted.
- **Recent activity**: last 10 events from the project (sprint completed, PR opened, etc.) — compact rows.
- **Token spend today / week**: small chart, color-coded (green under 50% of cap, yellow 50–80%, red above 80%).
- **Open PRs** (links to Repos tab): compact row list.

**Mode C — Individual agent selected (agent detail)**
This is the most important screen. Sections, top to bottom:

1. **Header**:
   - Large agent type icon, name, status badge, "in project: solex" link
   - Action buttons on the right: ⏸ Pause, ⏹ Stop, ↻ Redirect, ⋯ More

2. **Current task** card:
   - What it's working on (contract title + spec link)
   - Current phase (e.g. "writing tests")
   - Elapsed / ETA
   - "Started 12 min ago"

3. **Token budget** card:
   - Donut or bar: used / cap
   - Tiny sparkline of the last hour
   - Per-model breakdown (e.g. Opus 30k / Sonnet 17k)
   - "View detail" link to expanded chart

4. **Live activity timeline**:
   - Each event = one row with timestamp + verb icon (read / write / bash / spawn / done) + summary
   - Tail-follows by default; can pause-on-hover
   - Clicking a row expands inline to show full details (file path, command args, output)
   - Filterable by event type via small chips above

5. **Files touched in this session**:
   - Tree-grouped, scrollable
   - Click a file → opens read-only preview drawer from the right

6. **Embedded terminal** (collapsible, defaults to collapsed):
   - When this agent has a backing Claude Code process, show its terminal here
   - Looks like the existing xterm pane (black background, mono font)
   - Full-screen toggle

7. **History** (collapsible, defaults to collapsed):
   - Past sprints this agent has worked on, pass/fail outcome

States to design:
- Idle agent (only Header + simple "this agent is idle, last completed: …")
- Paused agent (Pause button becomes Resume; activity timeline grays out)
- Blocked agent (red banner at top explaining why)
- Failed agent (different banner color + "View failure report" CTA)

### 7.3 Right column — team-lead chat / notifications

Two sub-tabs at the top: **Chat** and **Notifications**.

**Chat** (default):
- Standard chat layout: messages stacked, newest at bottom, input at bottom
- Two participant types:
  - **You** (right-aligned, accent color)
  - **Team Lead** (left-aligned, neutral color, agent-type icon)
- Lead replies can include rich blocks: "Routed to gen-2" (clickable to jump to that agent), "Started sprint X" (clickable to jump to detail), "Surfaced clarification" (link to clarification card)
- Input supports slash commands: `/pause`, `/start <spec-id>`, `/spawn generator`, `/budget 50k`, `/escalate`. Autocomplete dropdown like Slack.
- Long thread: scroll preserves position; "scroll to latest" pill appears when not at bottom.

**Notifications**:
- Same feed as Inbox tab but filtered to the current folder selection
- Compact rows: severity dot, age, kind, one-line summary
- Click → jumps to source

States to design:
- Empty chat (lead has not spoken yet — say so + suggest things to try)
- Lead is typing (3-dot animation)
- Lead is unavailable (e.g. daemon not running) — clear instruction to fix
- Long chat (scrolling, day separators)

### 7.4 Responsive collapse

At <1280px, the right column collapses to a vertical icon strip (chat + bell). Clicking either opens the panel as an overlay over the middle pane.

---

## 8. Tab 2 — Build

A completely different layout from Agents. **Two columns, full height.** Designed for sustained focus on a single feature being built.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Build Assistant      target: openhands-bober/main   ⚙ change             │
├──────────────────────────────────────────┬───────────────────────────────┤
│                                          │                               │
│   LEFT — CHAT                            │   RIGHT — PREVIEW             │
│   ~45%                                   │   ~55%                        │
│                                          │                               │
│   Conversation with the Build Assistant. │   Tabs at top:                │
│   Bottom-anchored input.                 │   ◉ Diff   ◯ Live   ◯ Logs   │
│   Quick-action chips above input.        │                               │
│                                          │   Content of selected tab.    │
│                                          │                               │
│                                          │   Bottom action bar:          │
│                                          │   [Approve] [Reject] [Edit]   │
│                                          │                               │
└──────────────────────────────────────────┴───────────────────────────────┘
```

### 8.1 Top bar

- "Build Assistant" label
- **Target dropdown**: which repo this conversation will modify. Default: openhands-bober/main. Other options: any configured repo.
- ⚙ change settings

### 8.2 Left column — chat

Standard chat. The Build Assistant is a single agent persona — its voice is direct, terse, action-oriented. Messages include rich progress blocks:

- "Spawned sprint BUILD-20260525-recent-activity"
- "Planning: 1) add component 2) wire state 3) add tests"
- "Generator gen-build-1 is working" (status pip animating)
- "✓ 4/4 tests pass"
- "Ready for review →" (action button)

Quick-action chips above input (designer to determine final set):
- "Add a new tab"
- "Add a setting"
- "Refactor a component"
- "Fix the bug in…"
- "Improve the design of…"

States to design:
- First-time empty state (welcome screen, examples, "what can I build for you?")
- Mid-conversation, sprint in progress
- Sprint done, awaiting decision
- User editing a request after rejection
- Multiple completed builds in same conversation (scroll history)

### 8.3 Right column — preview

Three switchable sub-tabs:

**Diff** (default):
- Streaming git diff, file-by-file
- Each file collapsible
- +/- gutter colors (green/red)
- Click a file path → expand inline
- Search within diff (Cmd+F)

**Live**:
- An iframe rendering the dev server
- Toolbar: refresh, viewport size switcher (desktop / tablet / mobile preview frames inside the pane)
- "Open in new tab" link

**Logs**:
- Tail of the generator agent's activity timeline (same component as Agents-tab activity timeline)

### 8.4 Bottom action bar (right column)

- **Approve** (primary button): merges the sprint branch into the target branch. Confirmation modal — this is one of the rare cases where a modal is warranted because the action is irreversible.
- **Reject**: discards the changes (with confirmation)
- **Edit**: returns focus to chat input, pre-fills with "refine the implementation:" so the user can iterate

Buttons disabled while sprint is in progress.

### 8.5 Multiple targets

If the user has many repos configured, the target dropdown is the only way to switch. We do NOT allow multiple Build conversations open at once in v1 — one focused workspace.

---

## 9. Tab 3 — Repos

Two columns.

```
┌─────────────────────────────┬────────────────────────────────────────────┐
│  LEFT (~30%)                │  RIGHT (~70%)                              │
│                             │                                            │
│  Grouped PR list:           │  PR detail view                            │
│   - One repo header per     │  (similar to GitHub web)                   │
│     configured repo         │                                            │
│   - PRs under each repo     │  Tabs: Conversation / Diff / Checks        │
│   - Status icon per PR      │                                            │
│   - "+ Add repo" at bottom  │  Action bar: [Merge] [Request changes]     │
│                             │  [Comment]                                 │
│                             │                                            │
└─────────────────────────────┴────────────────────────────────────────────┘
```

### 9.1 Left column

Repo header rows are sticky. Each repo:
- Repo icon, owner/name
- Caret to collapse
- Open PR count badge

Per PR:
- PR number, title (truncated)
- Status icon (open / draft / merged / closed)
- CI mini-indicator: ✓ ◯ ✗ (passed, running, failed)
- Author avatar (small) — show agent icon if author is a bober agent
- Subtle age text ("2h ago")

States:
- No repos configured
- No PRs (one or more empty repos)
- Loading
- Long PR list (virtualized scroll)

### 9.2 Right column — PR detail

Header:
- PR title (large)
- "#14 in openhands-bober" subheader
- Status badge, author, age
- Right-aligned actions: Open on GitHub, Refresh

Three tabs:

**Conversation**:
- Merged feed of GitHub PR comments + bober agent commentary
- Agent comments are visually distinct (subtle agent icon, slightly different background)
- Inline comment box at bottom

**Diff**:
- File tree on the left (within the PR pane)
- Selected file expanded on the right
- Same diff UX as Build tab's diff view (consistent)

**Checks**:
- List of CI check rows
- Per row: name, status icon, duration, "View logs" link
- Logs open in a drawer from the right

Action bar:
- **Merge** (primary): triggers `gh pr merge`. Disabled until all required checks pass.
- **Request changes**: free-form review with comment
- **Comment**: just adds a comment without status change

States to design:
- PR awaiting first review
- PR with failing checks (red banner at top: "CI failed — 2 of 5 checks")
- Merged PR (entire view in a "completed" state)
- Closed without merging
- PR you created (no Merge button — wait for review)
- PR by an agent (small "Built by gen-build-1" attribution)

---

## 10. Tab 4 — Ops

Two columns.

```
┌─────────────────────────────┬────────────────────────────────────────────┐
│  LEFT (~30%)                │  RIGHT (~70%)                              │
│                             │                                            │
│  SERVERS section            │  Detail of selected server / agent         │
│   - One row per host        │                                            │
│   - Status pip              │  Tabs at top:                              │
│                             │  ◉ Live log   ◯ Deploy map                 │
│  DEVOPS AGENTS section      │  ◯ Agents on this host                     │
│   - One row per long-       │                                            │
│     running agent           │  Content of selected tab                   │
│                             │                                            │
│  + Add server               │                                            │
│  + Add agent                │                                            │
└─────────────────────────────┴────────────────────────────────────────────┘
```

### 10.1 Left column

**Servers section**:
- Group header with "Servers" label
- Per server: status pip (green / yellow / red / grey), name, host type ("ec2 us-west", "docker", etc.), region tag

**Devops agents section**:
- Group header
- Per agent: type icon, name, current task ellipsis, status pip
- These are different from Agents-tab agents because they're "watch X, do Y" long-lived processes (deploy-watcher, rollback-bot, new-tenant-provisioner, etc.)

### 10.2 Right column — server detail

Header:
- Server name (large), host details, uptime, "SSH" copy-cmd shortcut

Tabs:

**Live log** (default):
- File picker at top (e.g. "deploy.log", "app.log", "/var/log/nginx/access.log") — configurable per server
- Live tailing terminal-style pane
- Grep filter input above (filter without re-fetching)
- Pause / Resume tail
- Download as file

**Deploy map**:
- A horizontal directed graph: PR merge → build → push-image → deploy → smoke-test → notify
- Each node = a stage, colored by latest state (green completed, blue in-progress, red failed, grey idle)
- Edges animate when traversal happens
- Click a node = show logs for that stage (drawer from right)

**Agents on this host**:
- List of long-running agents currently bound to this server
- Per agent: name, current task, status, "Open detail" → switches selection to that agent

### 10.3 Selected devops agent

When the user clicks a devops agent in the left column (not a server), the right column shows that agent's detail — same structure as the Agents-tab agent detail screen (header, current task, activity timeline) but with one extra section: **operations history** (e.g. last 20 deploys with outcome + duration).

States to design:
- No servers configured
- No devops agents
- Server unreachable (red pip, "Last seen 2 hours ago" + reconnect button)
- Mid-deploy (visualization animating)
- Failed deploy (deploy-map shows red node + an inline "View failure" CTA)
- Production-destructive action waiting for confirmation (banner at top of pane)

---

## 11. Tab 5 — Inbox

A single-column feed. Simple but does heavy lifting.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Inbox                                       [All] [Unread]  ⚙ Settings  │
├──────────────────────────────────────────────────────────────────────────┤
│  ◯  2m   sprint-completed     openhands-bober · sprint-7-iter-3          │
│  ●  18m  needs-clarification  solex · spec-20260525-add-leaderboard      │
│  ●  47m  pr-needs-review      openhands-bober · #14                      │
│  ●  1h   ci-failed            agent-bober · #15 build                    │
│  ●  3h   deploy-completed     solex · prod-ec2-1                         │
│  ◯  5h   budget-warning       generator-2 reached 80% of 80k cap         │
│  ◯  1d   incident             sprint-9 evaluator flagged regression      │
└──────────────────────────────────────────────────────────────────────────┘
```

### 11.1 Row anatomy

Per row, left to right:
- **Unread dot** (filled = unread, hollow = read)
- **Age** (relative, abbreviated: 2m, 18m, 1h, 1d)
- **Kind** label with a kind-specific subtle color tag
- **Source** (project · ref) — the ref is clickable to jump to the source screen
- One-line summary
- On hover: action buttons appear at the right (Snooze, Archive, Open)

Click row = expand inline to show full details + action buttons.

### 11.2 Filtering & settings

Filter chips at top: All / Unread / by-kind (Completions / Failures / Reviews / Ops / Budget / Incidents).

Settings drawer (⚙):
- Per-kind notification preference: silent / toast / OS notification
- Default snooze duration
- Sound on/off

States to design:
- Empty inbox ("All clear" — minimal celebratory but understated)
- Many unread (100+) — virtualized scroll, "Mark all read" sticky at top
- Filter active (clear-filter chip prominent)
- Snoozed items (separate collapsed section "Snoozed (3)" at bottom)

---

## 12. Persistent status bar

Across the bottom of every tab.

```
◉ 3 active     ⚡ 142k / 200k tokens     ⚠ none      bober v0.13.0     ● ● ●
```

Each segment:

- **● 3 active** — count of running agents across all projects. Hover → popover lists them with status pips and quick-jump.
- **⚡ 142k / 200k tokens** — today's spend vs daily cap. Color shifts: green <50%, yellow 50–80%, red >80%. Hover → per-agent breakdown sparkline.
- **⚠ none** — degraded-mode aggregator. When something is wrong (polling fallback active, WS in text mode, etc.), this becomes "⚠ 2 degraded" in yellow/red. Click → expanded list of what and how to fix.
- **bober v0.13.0** — connected backend version. Red badge if version mismatch with frontend.
- **● ● ●** — three small dots = SSE / WS / GitHub connection health. Each clickable to force-reconnect.

Hover behavior is critical: the status bar is the user's at-a-glance "is anything wrong" indicator. It must communicate state without taking up scarce vertical space.

---

## 13. Command palette (Cmd+K)

A floating modal-less input that appears top-center. Lets the user reach any screen, any agent, any PR, any action via fuzzy search.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ⌘K   ▍                                                                  │
├──────────────────────────────────────────────────────────────────────────┤
│  Navigate to                                                             │
│    Agents tab                                                            │
│    Build tab                                                             │
│    solex / generator-2                                                   │
│    openhands-bober / #14                                                 │
│  Actions                                                                 │
│    Pause all agents in solex                                             │
│    Start build: …                                                        │
│    Tail prod-ec2-1 app.log                                               │
└──────────────────────────────────────────────────────────────────────────┘
```

Designer: please mock both the empty state and the filtered state with several result sections. This is one of the most-used features for power users — treat it as a first-class screen.

---

## 14. Component library (recurring elements that need design)

The designer should produce a small design system covering these atoms and molecules:

| Element | Notes |
|---|---|
| **Status pip** | Small filled circle. Must be readable when very small (4–6px). 5 colors: running (green, pulsing), idle (grey), paused (yellow), blocked/failed (red), completed-recent (fading green). |
| **Agent type icon** | One glyph per agent type: planner, architect, researcher, generator, evaluator, curator, team-lead, build-assistant, devops-deploy, devops-rollback, devops-tenant. Distinct silhouettes. |
| **Agent card (small)** | Used in project-overview grid + status-bar popover. Icon, name, task ellipsis, status pip. |
| **Activity timeline row** | Timestamp + verb icon + summary. Subtle alternating background. Expand-on-click. |
| **Token budget chart** | Tiny inline (sparkline) and larger (donut + bar). Color-coded by % of cap. |
| **Clarification card** | Inline answerable card. Question text, input field, submit. Must look "this is blocking work." |
| **PR row** | Title + status icon + checks indicator + author avatar + age. Used in Repos list. |
| **Chat message bubbles** | Two participant types (you, agent). Agent messages support rich blocks (links, status pills, action buttons inside the bubble). |
| **Notification row** | Per §11.1. |
| **Status bar segment** | The 5 atoms of the bottom bar. |
| **Tab header** | Top nav: serif/sans, weight, active-state treatment. |
| **Empty state illustration** | A single illustration style usable across all empty states. Subtle, not cartoonish. Think Linear-empty-state quality. |
| **Skeleton loader** | For lists and detail panes. |
| **Toast** | Lower-right, auto-dismiss, severity color. |
| **Slash-command autocomplete dropdown** | Used in chat inputs. |
| **Confirmation modal** | The one place modals are allowed. |
| **Drawer (right side)** | For inline detail expansions (file preview, log detail, check logs). |
| **Code/diff blocks** | Monospace, with syntax highlighting variant. |

Designer should also produce:
- A **type ramp** (probably 4–6 sizes)
- A **color system** for both dark and light modes
- A **spacing scale**
- A **motion guideline** (durations + easings)
- Naming for components (so the engineering implementation matches)

---

## 15. Tone & microcopy

A few examples of how the product should sound. These are not final copy — they're tone calibration.

| Don't say | Say |
|---|---|
| "Oops! Something went wrong." | "Couldn't reach prod-ec2-1. Last seen 3 minutes ago." |
| "Great job! Your sprint was successful!" | "Sprint 7 passed. 8/8 criteria. Open PR →" |
| "Are you sure you want to delete this?" | "Merge #14 into main? CI is green. This commit will be on origin." |
| "Loading…" | (Use a skeleton — don't say "loading" with text unless it's been >5s) |
| "Welcome to Bober Console!" | "Add a project to start." (used on empty state) |
| "Your tokens are running low ⚠️" | "Generator-2 is at 80% of its 80k token cap." |

Voice in agent messages: short sentences, no filler. Agents always cite what they did, not how they feel. "Wrote 3 files. Ran tests. 4/4 passed." not "I'm excited to share that the tests are all passing!"

---

## 16. Accessibility expectations

- All interactive elements have visible focus indicators (2px ring, accent color).
- Color is never the only carrier of meaning (always paired with icon + text).
- Keyboard navigation reaches everything (tab order tested per screen).
- Live regions (`role="status"`, `role="alert"`) are used in the design spec for the notification toasts and the status-bar degraded banner.
- Minimum text contrast WCAG AA in both modes.
- The terminal pane is allowed to be `role="application"` and capture keys, but Esc always returns focus to the surrounding shell.

---

## 17. Edge cases the designer must consider for every screen

Make a mock for each of these for at least the Agents tab; consider for others:

- First-time user (no projects, no agents, no data)
- Loading / hydrating
- Single agent / single project (sparse)
- Many agents / many projects (dense)
- One agent blocked, others running
- Backend disconnected (lost SSE)
- Degraded mode active (banner)
- Long activity timeline (auto-scroll behavior)
- Long chat conversation (day separators, scroll-to-bottom pill)
- Error fetching specific data (per-section retry)
- Read vs unread vs snoozed in inbox
- PR with conflict (special state)
- Server unreachable
- Token budget exhausted (agent stopped — what does this look like?)

---

## 18. Out of scope for this design pass

- Mobile views
- Tablet portrait
- Multi-user / team sharing (single developer assumed)
- Settings screens (LLM provider config, etc. — defer; the existing OpenHands settings stays for now)
- Authentication / sign-in (no accounts, single-machine)
- Internationalization (English only for v1)
- A marketing / landing page

---

## 19. Deliverables expected from the designer

1. **High-fidelity mockups** for every screen in §7–§13, in both dark and light mode, both default and at least 3 edge states per screen (loading, empty, error)
2. **Interactive prototype** (Figma or equivalent) covering the primary user flows:
   - Onboarding (add first project)
   - Agent inspection (folder → agent → pause → resume)
   - Clarification answer flow
   - Build session end-to-end (chat → diff → approve)
   - PR review and merge
   - Server log tail
   - Notification → action → resolution
3. **Component library** in Figma, organized for engineer handoff (auto-layout, variants, named tokens)
4. **Design tokens export** (JSON or Tokens Studio format) covering color, type, spacing, radius, shadow, motion
5. **A walkthrough document** (10–20 slides or a Loom) explaining the rationale behind major decisions
6. **Iconography**: agent type icons + status icons + a small set of action icons (pause, stop, redirect, merge, deploy, etc.)

---

## 20. Open questions for the designer to help answer

These are decisions we'd like a designer's input on, not constraints:

1. **Brand identity**: should this be a clear sub-brand of OpenHands (their logo + ours co-billed), a soft re-brand (our name primary, theirs in a corner), or fully our own? Cost of full re-brand is design effort; benefit is product clarity.
2. **Status pip vs status badge**: a pip is denser, a badge is more readable. Probably both, depending on context — designer to define when each is used.
3. **Iconography style**: solid? duotone? line? Each works for the genre. Need a definitive call.
4. **Color system depth**: are we OK with a Linear-like ~5 accent colors total, or do we want a richer palette? Genre suggests less.
5. **Dark mode primary**: confirm. Light mode is a secondary deliverable.
6. **Motion budget**: how much animation feels right? Linear is restrained, Vercel a bit more playful. Probably between them.
7. **Empty state illustration vs no illustration**: opinions vary. We lean toward "no illustration, just useful text + CTA" — but happy to be persuaded.

---

## 21. Constraints from the engineering side

The designer doesn't need to optimize around these, but should be aware:

- The UI is embedded in a fork of an existing open-source product (OpenHands). The Bober Console is reachable via a new top-level route — it's a full-page takeover, not a modal inside OpenHands. The existing OpenHands UI continues to live on its own routes.
- Backend data arrives via Server-Sent Events for live updates and standard REST for snapshots. Designer should assume any data shown can change live at any time.
- The terminal pane is a real terminal (xterm.js). Black background, monospace font, ANSI colors. Style it consistently with the rest of the system but don't try to "tame" it — it's a real OS terminal.
- All agent state lives on disk as JSON. There is no database. This affects nothing visually but does affect latency assumptions (sub-second reads, ~100ms writes).

---

## 22. Timeline & process suggestion

Suggested designer engagement shape (adjust to designer's preferred process):

- **Week 1**: discovery — designer reviews this doc, asks questions, looks at the existing baseline (today's Bober tab in openhands-bober), maps the IA, sketches at low fidelity. Deliverable: clickable wireframe of the 5 tabs.
- **Week 2**: visual language — type, color, components atoms in both modes. Deliverable: component library v1 + 2–3 sample screens in hi-fi.
- **Week 3–4**: hi-fi screens for all tabs + main edge states. Deliverable: all default + 1 edge state per screen.
- **Week 5**: remaining edge states + prototype wiring. Deliverable: interactive prototype.
- **Week 6**: handoff — engineer review, designer iteration, design tokens export.

---

## 23. Reference appendix

If the designer wants more context after reading this brief:

- Today's product (the baseline being improved on): `/Users/bober4ik/WebstormProjects/openhands-bober` running via `make run` — open http://localhost:3001 and click the "Bober" tab in any conversation view. Empty state if no project is configured, which is fine to see.
- Technical architecture doc (for engineers; designer can skim §1–2 for context only): `.bober/architecture/arch-20260524-architect-a-fork-of-openhands-architecture.md`
- Longer technical design doc covering implementation specifics: `.bober/designs/design-20260525-agent-command-center.md` (companion to this brief)
- Token-usage and incidents log formats (only relevant if designer wants to mock specific data shapes accurately): see `.bober/graph/token-usage.jsonl` and `.bober/graph/incidents.jsonl` after running a bober sprint

---

**End of brief.**
