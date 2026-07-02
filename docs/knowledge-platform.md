# agent-bober as a Personal Multi-LLM Knowledge Platform

This is the **umbrella guide** that ties the newer `bober/medical-team` features together:
the [multi-LLM fleet](./fleet.md), the [research scheduler](./research-scheduler.md), the
[priority hub](#2-how-the-pieces-connect), the [Telegram frontend](./telegram.md), and the
[local storage model](./storage.md). Each subsystem has its own reference doc; this page is the
map that shows **how they compose into one platform** and **how to stand it up end-to-end**.

---

## 1. What this is

agent-bober is, at heart, a **local-first, multi-LLM personal knowledge platform**. Recurring
**research jobs** and multi-agent **fleet** runs produce **Findings** and **vault notes**; the
**priority hub** ranks those Findings across domains; and a locally-run **Telegram bot** is the
read/act surface you talk to from your phone.

- **No server. No cloud store by default.** There is no inbound HTTP server, no webhook, no
  daemon — the Telegram bot is an outbound long-poll, and every piece of state lives under the
  project's **`.bober/`** directory as SQLite, JSON, or markdown.
- **Every egress axis is off unless you opt in.** Online research retrieval, cloud inference,
  cloud calendar, Gmail read, WHOOP device sync, and telemetry are **all default-`false`** and
  fail-closed — zero outbound bytes leave the machine unless you explicitly flip an axis on in
  `bober.config.json` (see [`./storage.md`](./storage.md#egress-axes--all-default-off--fail-closed)).
- **API keys are never persisted.** Provider credentials are read from the **environment**;
  `.env` is gitignored and the config file carries provider *selection*, never secrets.

---

## 2. How the pieces connect

Two producers feed the same **Findings** store; the hub ranks; Telegram reads and acts. A shared
**storage layer** sits underneath all of it.

```
                        ┌──────────────────────────────────────────────┐
  research scheduler ──▶│  vault note   +   one hub Finding             │
  (≥2 distinct models)  │  (markdown)       (→ .bober/memory/facts.db)  │
                        └───────────────────────┬──────────────────────┘
                                                │
                                                ▼
                                    ┌───────────────────────┐        ┌──────────────────────────┐
                                    │      priority hub      │──────▶ │  Telegram bot            │
                                    │  (ranks the Findings)  │        │  /today  /priority       │
                                    └───────────────────────┘        │  /decide X vs Y  /pending │
                                                                     │  /fleet                  │
  fleet  ──▶  optional blackboard  ──▶  fleet-synthesis.json ──────▶ │  (read / act surface)    │
  (head = Claude Code,     (WAL facts.db,         (per-agent          └──────────────────────────┘
   N heterogeneous          bounded rounds)        findings bundle)
   children)

        ┌──────────────────────────────────────────────────────────────────────────────┐
        │  Storage layer:  FactStore / SQLite (better-sqlite3)  +  JSON  +  markdown     │
        │  all under .bober/                                                             │
        └──────────────────────────────────────────────────────────────────────────────┘
```

The named pieces, each linked to its reference doc:

- **research scheduler** — recurring multi-model jobs → vault note + one hub Finding. See
  [`./research-scheduler.md`](./research-scheduler.md).
- **priority hub** — ranks pooled Findings; the Telegram `/today` · `/priority` · `/decide`
  commands delegate to its CLI. See [`./telegram.md`](./telegram.md#scoped-prioritization-sprint-3).
- **fleet** — one head (Claude Code) fans out N heterogeneous child runs; an optional
  **blackboard** (one WAL `facts.db`) lets children exchange findings across bounded rounds, and a
  pure synthesis step writes `fleet-synthesis.json`. See [`./fleet.md`](./fleet.md).
- **Telegram bot** — the read/act surface; `/fleet` renders the latest synthesis. See
  [`./telegram.md`](./telegram.md#multi-llm-secretary-fleet-view-sprint-7).
- **storage layer** — the `FactStore` (SQLite) plus JSON/markdown artifacts under `.bober/`. See
  [`./storage.md`](./storage.md).

---

## 3. One-time setup

### Install / build

```bash
npm install
npm run build     # compiles TypeScript to dist/; the bin is `agent-bober` (dist/cli/index.js)
```

All commands on this page use the **`agent-bober`** binary. (A **Claude Code plugin** alternative
also exists — `/plugin marketplace add BOBER3r/agent-bober` then `/plugin install bober@agent-bober`
— which runs the pipeline as Claude Code subagents on your subscription instead of calling
providers directly. The plugin-vs-CLI distinction, and which one provider selection applies to, is
covered in [`./providers.md`](./providers.md).)

### Environment variables

agent-bober **never persists API keys** — they come from the environment (`.env` is gitignored).
You only need the keys for the providers/tiers you actually use.

| Env var | Needed for | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | default Anthropic roles; fleet `hard` (Sonnet) / `frontier` (Opus) tiers; research `hard` / `frontier` blocks | |
| `DEEPSEEK_API_KEY` | default fleet children; `cheap` tier; `fleet expand` decomposer; research `cheap` block | endpoint `api.deepseek.com` |
| `XAI_API_KEY` | fleet `standard` tier (Grok); research `standard` block | endpoint `api.x.ai/v1`; **Grok model ids are placeholders — confirm before live use** |
| `OPENAI_API_KEY` | optional `openai` provider | |
| `GOOGLE_API_KEY` or `GEMINI_API_KEY` | optional `google` provider | |
| `TELEGRAM_BOT_TOKEN` | the Telegram bot | from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_ALLOWED_USERS` | Telegram whitelist | comma-separated numeric user ids |
| `BOBER_TEST_DETERMINISTIC=1` | tests only | returns a stub LLM client, no real calls |

### Config

Runtime configuration is **one Zod-validated `bober.config.json` per project** (each fleet child
gets its own). Every egress axis defaults to **`false`**:

- `research.egress.onlineResearch`
- `medical.egress.cloudInference` · `medical.egress.literatureRetrieval` · `medical.egress.deviceConnection`
- `calendar.egress.cloudCalendar`
- `taskInbox.gmailEgress`
- `telemetry.enabled`

For the full config/egress reference see [`./storage.md`](./storage.md#configuration--boberconfigjson);
for per-role provider configuration see [`./providers.md`](./providers.md).

---

## 4. Quick-start walkthroughs

Three short, copy-pasteable recipes.

### a) Talk to it from Telegram

```bash
export TELEGRAM_BOT_TOKEN=123456:ABC-your-bot-token
export TELEGRAM_ALLOWED_USERS=11111111,22222222   # your numeric Telegram user id(s)
agent-bober telegram                              # starts the outbound long-poll bot (Ctrl+C to stop)
```

Then, in the Telegram chat with your bot:

```
/start        → help stub
/today        → findings due within one day, ranked
/priority     → all pooled findings, ranked
```

Plain text you send is captured as an inbox task; `/pending` surfaces approval checkpoints with
inline `[Approve][Adjust][Reject]` buttons. Full command surface in [`./telegram.md`](./telegram.md).

### b) Recurring research → Findings

```bash
export DEEPSEEK_API_KEY=...   # openai-compat/deepseek block
export XAI_API_KEY=...        # openai-compat/grok  block (standard)
export ANTHROPIC_API_KEY=...  # anthropic/sonnet + anthropic/opus blocks

agent-bober research job add \
  --question "What changed in the 2026 atrial-fibrillation anticoagulation guidance?" \
  --cadence weekly
agent-bober research run <jobId>   # queries ≥2 distinct model blocks → vault note + one hub Finding
```

The emitted Finding then shows up via `/priority` or `/today` in Telegram. For unattended refresh,
drive the idempotent `research tick` from OS cron:

```cron
0 * * * * /usr/local/bin/agent-bober research tick
```

Details in [`./research-scheduler.md`](./research-scheduler.md).

### c) Multi-LLM fleet with a blackboard → `/fleet`

A minimal manifest with a `blackboard` section and two children on different tiers:

```jsonc
// fleet.json
{
  "rootDir": "./runs/research",
  "concurrency": 2,
  "children": [
    { "folder": "market", "task": "Survey the competitive landscape", "tier": "cheap" },
    { "folder": "tech",   "task": "Assess the technical feasibility",  "tier": "standard" }
  ],
  "blackboard": { "namespace": "research", "maxRounds": 3 }
}
```

```bash
export DEEPSEEK_API_KEY=...   # cheap tier + default children
export XAI_API_KEY=...        # standard tier (Grok)
agent-bober fleet fleet.json  # runs the rounds → writes ./runs/research/.bober/fleet-synthesis.json
```

Then `/fleet` in Telegram reads that `fleet-synthesis.json` and shows one section per agent. A
**non-blackboard** run writes no synthesis file, and `/fleet` then replies "no recent fleet run".
Full manifest schema, tiers, and synthesis shape in [`./fleet.md`](./fleet.md).

---

## 5. Where things are stored

Everything is local, under the project's **`.bober/`** directory — SQLite for facts/findings, plain
JSON/markdown for jobs, notes, digests, and reports:

```
.bober/
  memory/facts.db                     # FactStore — hub Findings + memory (default pool)
  memory/<namespace>/facts.db         # namespaced FactStore / fleet blackboard (WAL)
  research/jobs/<jobId>.json          # research job store
  research/digests/<date>.{md,json}   # research digests (JSON feeds the Telegram silent digest)
  fleet-report.json                   # last fleet run summary (always written)
  fleet-synthesis.json                # last blackboard run (Telegram /fleet reads this)
  history.jsonl                       # event log (rotated → history.archive.jsonl)
  <checkpoint>.pending|approved|rejected.json  # approval markers (CLI + Telegram, same store)
  <vault>/research/<date>-<marker>.md # research vault notes (default vaultRoot: project root)
```

The full schema, table shape, path helpers, and engineering notes are in
[`./storage.md`](./storage.md#bober-directory-map).

---

## 6. Known limitations / follow-ups

- **Grok model ids are placeholders.** The `grok` / `standard`-tier model ids (`grok-4`,
  `grok-4-fast`) are placeholders — confirm the real xAI catalog ids before any live `standard`-tier
  fleet run or Grok research block.
- **No live smoke tests are committed.** The Telegram bot, fleet child spawn, and do-bridge
  streaming paths need real tokens/keys to exercise end-to-end; the manual criteria for those were
  skipped in CI.
- **`--watch` and hosted schedulers are unfit for unattended runs.** `research tick --watch` uses an
  in-process `setInterval` that dies with the process — use OS cron/launchd for durable scheduling.
- **The blackboard is single-host.** It is one WAL SQLite file on one machine; there is no
  cross-machine exchange today.
- **Branch `bober/medical-team` is unmerged** and also carries the full medical template on top of
  these features.
- **Minor:** some in-code CLI help text still uses the stale bare name `bober` instead of
  `agent-bober`. This is cosmetic (a code follow-up, not a docs issue) — the real binary is
  `agent-bober`.

---

## 7. Doc map

| Doc | Covers |
|-----|--------|
| **[`./knowledge-platform.md`](./knowledge-platform.md)** (this page) | Umbrella guide: how the fleet, research scheduler, hub, and Telegram compose; setup; quick-starts. |
| [`./fleet.md`](./fleet.md) | Multi-LLM fleet: manifest schema, difficulty tiers, blackboard rounds, synthesis, goal decomposers. |
| [`./research-scheduler.md`](./research-scheduler.md) | Recurring multi-model research jobs, vault notes, `research tick`, digests, cron scheduling. |
| [`./telegram.md`](./telegram.md) | The Telegram frontend: whitelist, funnel, commands (`/today` · `/priority` · `/decide` · `/pending` · `/fleet`), upload opt-in. |
| [`./providers.md`](./providers.md) | Provider/model selection, endpoints, env-var setup, CLI-vs-plugin distinction. |
| [`./storage.md`](./storage.md) | Local storage / DB model: the `FactStore`, blackboard, JSON stores, config, egress axes, `.bober/` map. |

Related domain docs also exist: [`./teams.md`](./teams.md) (domain-agnostic teams + the medical
team's egress model), [`./calendar.md`](./calendar.md) (deterministic calendar planner), and
[`./do-bridge.md`](./do-bridge.md) (promote a Finding into a `bober run`).
