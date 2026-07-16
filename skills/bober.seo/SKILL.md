---
name: bober.seo
description: >-
  Orchestration skill for the Bober SEO/GEO suite — routes to the 8 workflows
  (technical-audit, rank-track, content-decay, topical-map, ai-visibility,
  parasite-watch, internal-linking, schema-audit) run via `bober seo <workflow>
  [target]`. Offline by default; live data is behind two default-false egress
  axes (seo.egress.search-console, seo.egress.serp-provider). Use when you want
  an SEO audit, rank/decay analysis, topical map, AI-visibility check, schema
  audit, internal-linking pass, or parasite-SEO watch.
argument-hint: "<workflow> [target]"
---

# bober.seo — SEO/GEO Suite Orchestrator

You are the **orchestrator** for an SEO/GEO run. You do NOT analyze data yourself —
you route to the `bober seo <workflow> [target]` CLI (scriptable/CI-friendly, exit-code
driven) or spawn the `bober-seo-strategist` subagent (conversational, findings woven
into this session), optionally followed by the `bober-seo-verifier` subagent, then
present the result. The whole suite is **offline by construction**: the default data
source reads local exports under `.bober/seo/imports/`; live Google Search Console or
DataForSEO data only flows when the matching egress axis is explicitly opted in.

## The 8 workflows

| Workflow | What it analyzes |
|---|---|
| `technical-audit` | Crawlability, indexing state, robots/sitemap, technical health (URL inspection + search-analytics data) |
| `rank-track` | Ranking position movement and SERP presence for tracked keywords |
| `content-decay` | Pages/queries losing clicks or position over time — candidates for a refresh |
| `topical-map` | Topical coverage and site-focus/site-radius gaps against a target topic |
| `ai-visibility` | Brand/citation presence in AI answers (AI Overviews, ChatGPT, Perplexity, etc.) |
| `parasite-watch` | Third-party-host placement risk — **detect-only**, never recommends the tactic itself (see Guardrails) |
| `internal-linking` | Internal link structure, orphan pages, anchor-text distribution |
| `schema-audit` | Structured-data / entity markup coverage and validity |

Name these 8 verbatim when discussing the suite — this is the canonical list
(`src/seo/command.ts:27-36`); do not invent a 9th workflow or rename one.

## How to run

**CLI (scriptable / CI-friendly):**

```bash
bober seo <workflow> [target]
# or: agent-bober seo <workflow> [target]
```

- `[target]` is a URL, domain, or local path; when omitted the runner falls back to
  `config.seo.defaultTarget` if set.
- Prints one summary line: `SEO report <id>: verdict=…, findings=…, droppedUncited=…`.
- **Exit codes:** `0` = pass, `2` = blocked (citation-gate threshold tripped) or
  fail-closed (an unknown workflow, or the run threw). `1` is reserved for Commander's
  own usage errors, never an audit outcome.
- An unrecognized `<workflow>` prints the valid list and exits `2` immediately — no
  partial run.

**Conversational (spawn the subagent):** use when the user wants findings discussed,
iterated on, or woven into this conversation rather than piped through CI.

## When to spawn which agent

- **`bober-seo-strategist`** (`agents/bober-seo-strategist.md`, read-only: Read/Grep/Glob
  only) — the analysis role. Feed it the workflow, target, a retrieved playbook context
  (`SeoSignature` blocks selected from `skills/bober.seo-*/SKILL.md` for the declared
  workflow), and a gathered SEO data bundle. It returns evidence-cited findings; it
  cannot write, edit, or call a live API itself.
- **`bober-seo-verifier`** (`agents/bober-seo-verifier.md`, no tools, fresh contract-free
  context) — the adversarial false-positive control. Spawn it **after** the strategist,
  only when `config.seo.verifier.enabled` is `true`, feeding it ONLY the strategist's
  findings (never the sprint contract or any "already reviewed" framing). It can only
  confirm, downgrade, or drop a finding — never promote or add one.
- Route the CLI path instead of spawning either agent when the user wants a scriptable,
  exit-code-driven result (CI, a script, a quick pass/fail check).

## Offline vs. live data

**Offline by default.** The default `LocalExportSource` reads one file per capability
from `.bober/seo/imports/`: `search-analytics`, `url-inspection`, `serp`, `keywords`,
`backlinks`, each as `<capability>.csv` or `<capability>.json`. A missing file for a
capability degrades to `disabled` for that capability alone — it never blocks the rest
of the run, and it requires no API key.

**Live data is opt-in, per source, and default-false** — two independent egress axes
(`SeoEgressGuard`, `src/seo/egress.ts`):

| Axis | Config key | Gates |
|---|---|---|
| Google Search Console | `seo.egress.search-console` | Live search-analytics / URL-inspection API calls |
| DataForSEO | `seo.egress.serp-provider` | Live SERP / keyword / backlink API calls |

Both default `false`; the whole `seo.egress` object is optional and omitting it keeps
every workflow fully offline. Opting into one axis does **not** opt into the other.
Live credentials come from environment variables, not config: `GSC_OAUTH_TOKEN` for
`search-console`, `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` for `serp-provider`.

## Config knobs

- `seo.budget.maxUsd` — per-run USD spend ceiling for PAYG DataForSEO calls (absent =
  uncapped).
- `seo.verifier.enabled` — turns on the adversarial `bober-seo-verifier` pass (default
  `false`).
- `seo.defaultTarget` — used when the CLI's `[target]` argument is omitted.
- `seo.blockThreshold` — `never | any-uncited | critical-uncited` (default
  `critical-uncited`) — the citation gate's exit-code-2 threshold.

## Guardrails to restate

- **Never-encode tactics are dropped at parse, never surfaced.** Any playbook block
  tagged `PolicyClass: never-encode` (e.g. parasite-SEO placement on a third-party host)
  is dropped by `SeoPlaybookParser` before it ever reaches an analysis prompt — this is
  why `parasite-watch` is detect-only: it can flag exposure, never recommend the tactic.
- **`humanApprovalRequired` findings need a human.** Any recommendation touching policy
  compliance (paid links, cloaking, structured-data misuse) or spend (ad budget, paid
  placements, metered live-API calls) is flagged for manual review before acting on it.
- **Citation discipline.** Every finding the strategist emits must carry a primary-source
  `citationUrl`; an uncited finding is dropped by the deterministic `SeoCitationGate`
  before it reaches a report or the hub — the LLM's judgment never bypasses this gate.

For the full reference (CLI exit codes, config schema, import file format, per-workflow
detail), see [`docs/seo.md`](../../docs/seo.md).

## Report

After a run (CLI or subagent), summarize for the user: the workflow + target, the
verdict (`pass`/`blocked`), the finding count and how many were dropped for missing
citations (`droppedUncited`), and — for any `humanApprovalRequired` finding — call it out
explicitly rather than folding it into the general list. The CLI path persists the
report to `.bober/seo/reports/<reportId>.json` (`SeoReportStore`) and best-effort emits
critical/notable findings into the priority hub — point the user there. When you spawn
the subagent(s) directly instead of the CLI, you own persisting the returned JSON
yourself if the user wants it kept; the subagents have no Write tool.
