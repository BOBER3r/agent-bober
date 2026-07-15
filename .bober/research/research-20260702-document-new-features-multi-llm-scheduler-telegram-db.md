# Research: Document new branch features — multi-LLM fleet, research scheduler, Telegram frontend, DB/storage

**Research ID:** research-20260702-document-new-features-multi-llm-scheduler-telegram-db
**Generated:** 2026-07-02
**Branch:** bober/medical-team
**Method:** tokensave graph + direct reads of CLI/config/provider entry points (no Explore agents, per global CLAUDE.md tokensave rule)
**Questions Explored:** 8
**Files Explored:** 22

---

## Architecture Overview

Four feature families ship on `bober/medical-team`, all wired into the single Commander CLI at `src/cli/index.ts` (bin: `agent-bober` → `dist/cli/index.js`). They compose into a **local-first personal knowledge platform**: research jobs and fleet runs produce **Findings** and **vault notes**; the priority hub ranks Findings; the Telegram bot is the read/act presentation surface.

1. **Multi-LLM fleet** (`src/fleet/`) — a head process (Claude Code, on subscription) fans out N isolated `agent-bober run <task>` child processes, each spawned via `execa(process.execPath, [dist/cli/index.js, "run", task], {cwd})` (`runner.ts:85`). Children are heterogeneous: default provider is DeepSeek (openai-compat), overridable per-child by a **difficulty tier** (`cheap`→DeepSeek, `standard`→Grok/xAI, `hard`→Sonnet, `frontier`→Opus; `tier-policy.ts`). An optional **shared blackboard** (one WAL SQLite `facts.db`) lets children exchange findings across up to 3 bounded rounds; a **pure synthesis** step then bundles the final results into `.bober/fleet-synthesis.json` for the head/Telegram to read.

2. **Research scheduler** (`src/research/`) — recurring multi-model research **jobs** stored as JSON under `.bober/research/jobs/`. Running a job queries ≥2 distinct provider/model blocks (`model-diversity.ts` enumerates distinct tiers), writes a markdown **vault note** (`.../research/<date>-<marker>.md`) and emits exactly one **hub Finding**. `research tick` runs every due job idempotently (cadence math in `cadence.ts`); `research digest` aggregates a time window into `.md`+`.json` for the Telegram bot to deliver silently.

3. **Telegram frontend** (`src/telegram/`) — a locally-run **getUpdates long-poll** bot (grammy, the ONE new dep, isolated to `bot.ts`). A numeric-id whitelist gates every sender; all outbound text flows through the `sendSafe`/`sendSafeKeyboard` funnel. Commands: `/start`, `/pending` (inline approve/adjust/reject over existing disk markers), `/today`, `/priority`, `/decide X vs Y`, `/fleet` (reads `fleet-synthesis.json`); plain text → zero-friction inbox capture; document upload → per-upload medical-ingest opt-in.

4. **Database / storage layer** — SQLite via `better-sqlite3` (`FactStore`, `src/state/facts.ts`, table `semantic_facts`, bi-temporal, clock-injected). `SharedBlackboard` (`src/fleet/shared-blackboard.ts`) wraps one WAL `facts.db` for concurrent child writes. Research jobs are JSON files; vault notes / digests / synthesis / fleet-report are JSON+markdown artifacts under `.bober/`. All config is one Zod-validated `bober.config.json` (`src/config/schema.ts`).

---

## Existing Patterns

- **CLI registration**: every feature exposes a `register<Feature>Command(program)` called from `src/cli/index.ts:277-356`. Fleet is registered via `registerFleetCommand` imported from `../fleet/index.js:39`. CLI handlers **never throw** — they set `process.exitCode=1` and return (telegram.ts:53, research.ts:22, blackboard.ts:8).
- **Provider abstraction**: `createClient(provider, endpoint, providerConfig, model, role)` in `src/providers/factory.ts:192` is the single provider constructor. Supported: `anthropic | openai | google | openai-compat | claude-code` (`factory.ts:13`). `validateApiKey` (factory.ts:96) fails fast per role with a named env var.
- **Model shorthands**: `resolveProviderModel` (`orchestrator/model-resolver.ts:61`) maps `opus`→`claude-opus-4-8`, `sonnet`→`claude-sonnet-4-6`, `haiku`→`claude-haiku-4-5`, `deepseek`→`deepseek-v4-pro`@api.deepseek.com, `grok`→`grok-4`@api.x.ai/v1, `ollama/<model>`→localhost:11434/v1. **Grok model ids (`grok-4`) are placeholders** — confirm real xAI ids before live use.
- **Tier→provider overlay**: `buildChildConfig` (`fleet/child-config.ts:22`) sets DeepSeek on planner/generator/evaluator, then overlays `tierPolicy.resolveTier(child.tier)` when tier ≠ `default`. Config byte-identical to base when tier is absent.
- **Clock discipline**: `FactStore`, `runner.ts`, `cadence.ts`, `scheduler.ts`, `note-writer.ts` never read the wall clock — `now` is always injected at the CLI `.action()` boundary and threaded down.
- **Egress axes (default OFF, fail-closed)**: `research.egress.onlineResearch`, `medical.egress.{cloudInference,literatureRetrieval,deviceConnection}`, `calendar.egress.cloudCalendar`, `taskInbox.gmailEgress` (`config/schema.ts`). Retrieval client is never even constructed when the axis is off (`research/runner.ts:176`).
- **Provider-neutral SDK isolation**: grammy types live ONLY in `telegram/bot.ts`; `SynthesisBundle`/`FactRecord` are TYPE-ONLY imports in `fleet-view.ts:7-8` so the bot has zero runtime coupling to `src/fleet`/`better-sqlite3`.

## Key Files

**Fleet:** `src/fleet/index.ts` (runFleet/expand/expand-deep + `registerFleetCommand`), `manifest.ts` (Zod `FleetManifestSchema`: rootDir, concurrency, children[{folder,task,config,tier}], optional `blackboard{namespace,maxRounds 1-3}`), `tier-policy.ts` (tier table), `child-config.ts` (tier overlay), `coordinator.ts` (`execute` single-pass / `executeRounds` blackboard loop + early-stop), `runner.ts` (child spawn), `scaffolder.ts` (writes each child's `bober.config.json` incl. `config.fleet`), `shared-blackboard.ts` (WAL wrapper), `synthesis.ts` (pure `collect`→bundle), `tool-role-guard.ts` (claude-code-cannot-drive-tools assert), `reporter.ts` (fleet-report.json), `manifest-write.ts` (provenance sidecar).

**Research scheduler:** `src/research/types.ts` (`ResearchJobSchema`), `job-store.ts` (JSON add/list/remove/read), `runner.ts` (`runResearchJob` → note + Finding), `model-diversity.ts` (`diverseBlocks` ≥2 distinct blocks), `note-writer.ts` (note path/frontmatter), `cadence.ts` (`computeNextDue` daily/weekly/monthly UTC), `scheduler.ts` (`tick` idempotent), `digest.ts`+`egress.ts`+`online-retrieval.ts`. CLI: `src/cli/commands/research.ts` (`job add|list|remove`, `run`, `tick [--watch]`, `digest [--since]`).

**Telegram:** `src/telegram/bot.ts` (`GrammyTransport`, `startPollLoop`, `helpReply`), `router.ts` (classify + `parseScopeFromCommand`), `whitelist.ts` (`parseAllowedUsers`/`isAllowed`/`denialReply`), `outbound.ts` (`sendSafe`/`sendSafeKeyboard`), `keyboard.ts`, `fleet-view.ts` (`handleFleet`/`renderFleetView`/`defaultSynthesisReader`), `digest.ts` (`sendDigest` silent), `streaming.ts`, `handlers/{capture,prioritize,approvals,upload}.ts`. CLI: `src/cli/commands/telegram.ts`.

**Storage / config:** `src/state/facts.ts` (`FactStore`, `factsDbPath`, `ensureFactsDir`, table `semantic_facts`), `src/config/schema.ts` (`BoberConfigSchema` incl. `FleetSectionSchema`, `ResearchSectionSchema`, `MedicalSectionSchema`, `VaultSectionSchema`, `CalendarSectionSchema`), `src/providers/factory.ts`, `src/cli/commands/blackboard.ts`, `src/hub/finding-store.ts` (`ingestFinding`).

## Integration Points

- **Research → hub + vault**: `runResearchJob` writes the vault note then calls `findingSink` exactly once; the CLI binds `findingSink` to `ingestFinding(FactStore, finding, {now})` (research.ts:247-259). The FactStore is opened at `factsDbPath(projectRoot)` = `.bober/memory/facts.db`.
- **Fleet → blackboard → synthesis → Telegram**: `runFleet` detects `manifest.blackboard`, resolves an ABSOLUTE db path `<rootDir>/.bober/memory/<namespace>/facts.db` (`index.ts:47`), runs `executeRounds`, writes `fleet-report.json`, then (blackboard runs only) `collect()` → `.bober/fleet-synthesis.json`. Telegram `/fleet` (`fleet-view.ts:41`) reads that exact file; absent file → friendly "no recent fleet run".
- **Child blackboard access**: the scaffolder writes `config.fleet{blackboardDbPath(abs),blackboardNamespace,blackboardSubject=folder,maxRounds}` into each child's `bober.config.json` (scaffolder.ts:62). Children publish/read via `agent-bober blackboard publish|read` which reads the abs path from `config.fleet` only — never re-derived from cwd (blackboard.ts:12-14).
- **Telegram → approval gate**: `/pending` and inline taps write the SAME disk markers the `approve`/`reject` CLI writes (`state/approval-state.ts` `listPending`); no new approval mechanism.
- **Research digest → Telegram**: `research digest` writes `.bober/research/digests/<date>.{md,json}`; the bot's `sendDigest` delivers a scheduler-supplied string with `{silent:true}`.
- **Scheduling**: `research tick` is meant to be driven by OS cron/launchd (`0 * * * * agent-bober research tick`) or the harness `/schedule`; `--watch` uses an in-process `setInterval` that dies with the process.

## Test Coverage

Nearly every module has a co-located `*.test.ts` (fleet: coordinator/child-config/tier-policy/shared-blackboard/synthesis/manifest/tool-role-guard/reporter/scaffolder; research: cadence/digest/egress/job-store/note-writer/runner/scheduler; telegram: router/whitelist/outbound/keyboard/streaming/digest/fleet-view + handlers/*). Full suite ~3686 tests green (per project memory). `BOBER_TEST_DETERMINISTIC=1` returns a stub LLM client (`factory.ts:29`) so e2e tests never hit real providers.

## Risk Areas

- **Grok/xAI model ids are placeholders** (`grok-4`, `grok-4-fast`) — must be confirmed against real xAI catalog before any live `standard`-tier or Grok research run.
- **No live smoke test committed**: fleet child spawn, Telegram bot, and do-bridge streaming need real `TELEGRAM_BOT_TOKEN` / provider keys; manual criteria were skipped in the build.
- **`--watch` and hosted schedulers are unfit for unattended runs** — the code itself points operators to OS cron/launchd (research.ts:293-297).
- **Blackboard is single-host** — one WAL SQLite file; no cross-machine exchange.
- **Fleet manifest default out-path** `.bober/fleet-expand.json` is shared across `expand`/`expand-deep`; provenance sidecar + `.bak` mitigate clobber but the path is shared.
- **Branch `bober/medical-team` is unmerged** and carries all of this plus the medical template.

---

*Generated by bober.research (tokensave-backed) — factual findings only, no implementation recommendations.*
