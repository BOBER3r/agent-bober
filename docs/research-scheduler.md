# Research Scheduler

The research scheduler (`src/research/`) runs **recurring multi-model research jobs**. A job is a
stored question plus a cadence; **running** a job queries **≥2 distinct provider/model blocks**,
writes a markdown **vault note** recording each model's answer, and emits **exactly one**
priority-hub **Finding** so the result surfaces alongside everything else the platform ranks.
`agent-bober research tick` runs every job that is **due** — idempotently — so a single cron entry
keeps a whole set of standing questions refreshed on a daily / weekly / monthly cadence.

This is the "standing research" leg of the local-first knowledge platform: jobs and their notes are
plain files under `.bober/`, findings land in the same `facts.db` the priority hub reads, and the
Telegram bot delivers the aggregated digest silently. See [`./knowledge-platform.md`](./knowledge-platform.md)
for how the pieces fit together end-to-end.

---

## Concept at a glance

```
research job add ──▶ .bober/research/jobs/<jobId>.json   (a standing question + cadence)
                                │
research run <jobId> ──────────▶│  query ≥2 distinct provider/model blocks
research tick (every due job) ──┘        │
                                         ├─▶ vault note   <vaultRoot>/research/<date>-<marker>.md
                                         └─▶ one hub Finding → .bober/memory/facts.db
                                                    │
research digest ──▶ .bober/research/digests/<date>.{md,json}  ──▶ Telegram silent digest
```

Every module in `src/research/` is **clock-free** — the wall clock is read only at the CLI
`.action()` boundary and injected down (see [Storage & clock discipline](#storage--clock-discipline)).

---

## Jobs: define & manage

A job is a JSON file at `.bober/research/jobs/<jobId>.json`. The `jobId` is a stable 16-char SHA-256
hash of `question|createdAt` (`src/research/job-store.ts:28`), so re-running or advancing a job keeps
the **same** id and the **same** file — the scheduler upserts in place rather than accumulating
duplicates.

### `research job add`

```bash
agent-bober research job add \
  --question "What changed in the 2026 atrial-fibrillation anticoagulation guidance?" \
  --cadence weekly \
  --domain medical
```

| Flag | Required | Default | Purpose |
|------|----------|---------|---------|
| `--question <q>` | **yes** | — | The research question. Must be non-empty (`ResearchJobSchema`). |
| `--cadence <c>` | no | `weekly` | Recurrence: `daily` \| `weekly` \| `monthly`. |
| `--tier <t>` | no | — | Difficulty-tier hint (`cheap` \| `standard` \| `hard` \| `frontier`) — seeds which model block is queried first (see [Run a job once](#run-a-job-once)). |
| `--domain <d>` | no | — | Domain tag (e.g. `medical`, `coding`) — routes the emitted Finding and tags the note. |
| `--target-repo <r>` | no | — | Repository slug to scope the research against (stored for downstream use). |
| `--online-research` | no | off | Stores `onlineResearch=true` on the job. **Egress is still gated** — see [Online-research egress](#online-research-egress-default-off-fail-closed). |

On success it prints the new job id, question, and cadence.

### `research job list`

```bash
agent-bober research job list
# a1b2c3d4e5f60718  weekly  What changed in the 2026 atrial-fibrillation…  [medical]
```

Each line is `<id>  <cadence>  <question>  [domain]` (the `[domain]` suffix appears only when set).
An empty store prints `No research jobs defined.`

### `research job remove`

```bash
agent-bober research job remove a1b2c3d4e5f60718
```

Prints a confirmation, or exits non-zero with `Research job not found: <id>` if there was no match.

### ResearchJob fields

The stored shape (`ResearchJobSchema`, `src/research/types.ts:33`):

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | 16-char hash of `question|createdAt`. |
| `question` | string | Non-empty. |
| `cadence` | `daily` \| `weekly` \| `monthly` | Closed enum. |
| `tier` | string? | Optional difficulty-tier hint. |
| `modelSet` | string[]? | Optional explicit model-set override (reserved). |
| `targetRepo` | string? | Optional repo slug. |
| `domain` | string? | Optional domain tag. |
| `onlineResearch` | boolean | Defaults `false`. |
| `createdAt` | ISO-8601 | Stamped once at the CLI boundary. |
| `nextDueAt` | ISO-8601? | Unset ⇒ due on first tick; advanced after each run. |
| `lastRunAt` | ISO-8601? | Unset until the first successful run. |

---

## Run a job once

```bash
agent-bober research run a1b2c3d4e5f60718
# /Users/you/project/research/2026-07-02-a1b2c3d4e5f6.md
```

`research run <jobId>` executes the job immediately and prints the path of the vault note it wrote.
Under the hood (`src/research/runner.ts`):

### 1. Resolve distinct model blocks

`diverseBlocks(job.tier)` (`src/research/model-diversity.ts:36`) enumerates the fleet difficulty
tiers in the fixed order `cheap, standard, hard, frontier` and **dedups by `provider/model` label**.
The `--tier` hint (if valid) is moved to the front of the scan so its block is queried first.

In the **current tier table** (`src/fleet/tier-policy.ts`) the four tiers resolve to four **distinct**
blocks, so a full run fans out to all of them:

| Block label | Provider | Endpoint |
|-------------|----------|----------|
| `openai-compat/deepseek` | DeepSeek | `https://api.deepseek.com` |
| `openai-compat/grok` | Grok / xAI | `https://api.x.ai/v1` |
| `anthropic/sonnet` | Anthropic | default |
| `anthropic/opus` | Anthropic | default |

Each block is queried via `createClient(provider, endpoint, …, model, "research").chat(…)` — the
`createClient` factory is the **only** place a provider SDK is constructed; the runner itself imports
none. A real run therefore needs the relevant provider keys in the environment:

```bash
export DEEPSEEK_API_KEY=...   # openai-compat/deepseek
export XAI_API_KEY=...        # openai-compat/grok
export ANTHROPIC_API_KEY=...  # covers both anthropic/sonnet and anthropic/opus
```

A missing key fails fast for that block, naming the exact environment variable
(`src/providers/factory.ts`).

> **Grok model ids are placeholders.** The `grok` block maps to a placeholder xAI model id — confirm
> the real xAI catalog id before relying on a live Grok answer.

### 2. Vault note

The note is written to `<vaultRoot>/research/<YYYY-MM-DD>-<marker>.md`, where the date is sliced from
the injected timestamp and `marker` is the **first 12 characters of the jobId**. `vaultRoot` defaults
to the project root (the same default as `agent-bober vault reindex`).

The frontmatter (via `serializeFrontmatter`, `src/research/note-writer.ts:51`) carries `title`,
`jobId`, `question`, `models` (the block labels, as a string array), `generatedAt`, `domain`,
`type: research`, and `status: open` — plus a `sources` list **only** when online retrieval actually
ran. The body is one `### <provider/model>` section per model answer:

```markdown
---
title: Research — What changed in the 2026 atrial-fibrillation anticoagulation guidance?
jobId: a1b2c3d4e5f60718
question: What changed in the 2026 atrial-fibrillation anticoagulation guidance?
models:
  - openai-compat/deepseek
  - openai-compat/grok
  - anthropic/sonnet
  - anthropic/opus
generatedAt: 2026-07-02T09:00:00.000Z
domain: medical
type: research
status: open
---

## What changed in the 2026 atrial-fibrillation anticoagulation guidance?

### openai-compat/deepseek

<deepseek's answer>

### openai-compat/grok

<grok's answer>

### anthropic/sonnet

<sonnet's answer>

### anthropic/opus

<opus's answer>
```

### 3. One priority-hub Finding

After the note is written, the runner emits **exactly one** Finding and ingests it into the FactStore
at `.bober/memory/facts.db` via `ingestFinding`. The default Finding
(`buildFinding`, `src/research/runner.ts:112`):

| Field | Value |
|-------|-------|
| `domain` | `job.domain` if set, else `"research"` |
| `title` | `Research: <question>` |
| `kind` | `watch` |
| `urgency` / `severity` | `2` / `2` |
| `evidence` | per-model snippets (`<label>: <first 120 chars>`) |
| `tags` | `["research"]`, plus `"domain:<d>"` when a domain is set |
| `status` | `open` |

A domain module may call `registerAnalyzer(domain, …)` to customise the Finding for its domain;
**none is registered by default**, so the generic Finding above is what you get out of the box.

---

## Recurring execution: `research tick`

```bash
agent-bober research tick
# research tick: ran 2 job(s): a1b2c3d4e5f60718, 0f9e8d7c6b5a4938
# (or) research tick: no jobs due.
```

`research tick` (`src/research/scheduler.ts`) runs every job that is **due right now**:

- a job with **no `nextDueAt`** is due on its first tick;
- otherwise it is due when `nextDueAt <= now`.

After a job runs, its `nextDueAt` is advanced by `computeNextDue(cadence, now)`
(`src/research/cadence.ts`) and its `lastRunAt` is recorded, then it is upserted back to the same file:

| Cadence | Advance |
|---------|---------|
| `daily` | +1 UTC day |
| `weekly` | +7 UTC days |
| `monthly` | +1 UTC month (JS `setUTCMonth`; day > month length rolls forward — e.g. Jan 31 → Mar 3) |

**Idempotency:** because `computeNextDue` always advances by ≥1 day, a second `tick` at the same
instant sees every just-run job as not-due and skips it. **Failure isolation:** if a job's run
throws, it is **not** advanced or persisted, so it stays due and is retried on the next tick.

### `--watch` (convenience, not production)

```bash
agent-bober research tick --watch --interval 3600000   # default interval = 1h
```

`--watch` keeps the process alive with an in-process `setInterval` loop (default `3600000` ms = 1h).
This is convenient for a foreground session but **dies with the process** — it does not survive a
reboot or sleep and is **not suitable for unattended production**. For that, drive `research tick`
from the OS scheduler (see [Scheduling in production](#scheduling-in-production)).

---

## Online-research egress (default OFF, fail-closed)

Web / online retrieval is **disabled by default** and only happens when **both**:

1. the config axis `research.egress.onlineResearch` is `true`, **and**
2. the job was created with `--online-research`.

When the axis is off, the retrieval client is **never even constructed** — there are **zero**
outbound requests, and the note frontmatter carries no `sources` (`src/research/runner.ts:176`). This
mirrors every other egress axis in the platform (medical, calendar, task-inbox): default-closed, opt-in.

To opt in, add the axis to `bober.config.json`:

```jsonc
{
  "research": {
    "egress": { "onlineResearch": true }
  }
}
```

Even with the axis on, a job without `--online-research` stays offline. See
[`./providers.md`](./providers.md) for the provider/egress model in general.

---

## Digests

```bash
agent-bober research digest
# /Users/you/project/.bober/research/digests/2026-07-02.md
# /Users/you/project/.bober/research/digests/2026-07-02.json
```

`research digest [--since <iso>]` aggregates the research runs in the window `[since, now]` into a
**dual** artifact — `.bober/research/digests/<YYYY-MM-DD>.{md,json}` — and prints both paths. `--since`
defaults to **24 hours before now**. An **empty window** emits an explicit "no new research" digest
rather than throwing, so a scheduled digest job is always safe to run.

The Telegram bot reads the **JSON** side to deliver a **silent** scheduled digest
(`sendDigest`, `{ silent: true }` → `disable_notification`). The scheduler owns the content and
cadence; the bot only delivers the payload with the notification sound off. See
[`./telegram.md`](./telegram.md#streaming-progress--silent-digest-sprint-6).

---

## Scheduling in production

For unattended runs, drive the CLI from the **OS scheduler** (cron / launchd) — it survives reboots,
and the research modules are built to be invoked this way (each `tick` opens and closes its own
resources). An hourly crontab entry:

```cron
0 * * * * /usr/local/bin/agent-bober research tick
```

A matching morning digest, e.g. at 07:00:

```cron
0 7 * * * /usr/local/bin/agent-bober research digest
```

The harness `/schedule` can also fire the CLI on a cadence from inside the agent harness. **Avoid**
hosted-OAuth schedulers and `--watch` for anything that must run unattended — both are process-bound
and unfit for durable scheduling.

---

## Storage & clock discipline

- **FactStore is opened and closed per run/tick.** Each `research run` and each `tick` iteration
  opens the FactStore at `.bober/memory/facts.db`, ingests its Finding, and closes it in a `finally`
  — so no SQLite lock is held across watch-loop iterations. See [`./storage.md`](./storage.md) for the
  `facts.db` model.
- **All timestamps are injected.** The wall clock (`new Date().toISOString()`) is read **only** at the
  CLI `.action()` boundary and threaded into `runResearchJob`, `tick`, `computeNextDue`, and
  `serializeResearchNote`. Those modules never read the clock, which keeps them pure and deterministic
  under test.
- **Jobs are plain JSON; notes and digests are plain markdown/JSON.** Nothing here needs a database to
  inspect — everything lives under `.bober/research/` and the vault's `research/` directory.

---

## Command summary

| Command | Effect |
|---------|--------|
| `agent-bober research job add --question "…" [--cadence] [--tier] [--domain] [--target-repo] [--online-research]` | Store a standing research job. |
| `agent-bober research job list` | List stored jobs (`<id>  <cadence>  <question>  [domain]`). |
| `agent-bober research job remove <jobId>` | Delete a job by id. |
| `agent-bober research run <jobId>` | Run one job now → vault note + one hub Finding; prints the note path. |
| `agent-bober research tick [--watch] [--interval <ms>]` | Run every **due** job idempotently; advances cadence. |
| `agent-bober research digest [--since <iso>]` | Aggregate runs in `[since, now]` → `.md` + `.json`; prints both paths. |

### See also

- [`./telegram.md`](./telegram.md) — the presentation surface that delivers the silent digest and reads hub findings.
- [`./providers.md`](./providers.md) — provider/model configuration and the egress model.
- [`./storage.md`](./storage.md) — the `facts.db` FactStore that holds emitted findings.
- [`./knowledge-platform.md`](./knowledge-platform.md) — the top-level guide tying the platform together.
