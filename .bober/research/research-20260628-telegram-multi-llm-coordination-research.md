# Research: Telegram bot-to-bot + secretary coordination as a frontend over the multi-LLM fleet

**Research ID:** research-20260628-telegram-multi-llm-coordination
**Generated:** 2026-06-28
**Method:** tokensave code-graph exploration (per repo CLAUDE.md: tokensave, not Explore agents) + direct spec/file reads
**Scope target:** Enrich spec #8 `spec-20260628-telegram-frontend`
**Companion:** web/external findings produced separately by the `/deep-research` harness (validates what Telegram actually permits)

---

## Architecture Overview

Three relevant pieces, two of which already exist in code and one of which is an unbuilt draft:

1. **Planned Telegram adapter (spec #8, draft, NO code in `src/` yet).**
   `.bober/specs/spec-20260628-telegram-frontend.json` defines a *thin, single-bot* presentation adapter: a locally-run long-polling (`getUpdates`) bot, a numeric-id whitelist, plain-text→task capture, slash-command→priority-hub mapping, inline approve/adjust/reject buttons, and per-upload-opt-in document→medical-ingest. It "adds no new domain logic." Its `outOfScope` list **explicitly excludes the exact feature now requested**: *"Bot-to-bot autonomous chaining and multi-user fan-out beyond the static whitelist"* (spec line 153).

2. **Existing multi-LLM substrate (the "multiple LLMs running").**
   The fleet orchestrator already spawns N **isolated, heterogeneous-provider child runs** (DeepSeek / Grok-xAI / Claude / Anthropic), coordinates them through a **shared blackboard**, runs them in **rounds with early-stop**, and produces a **pure head synthesis**. This is, functionally, a "secretary coordinates many specialist agents who exchange findings" pattern — implemented over a SQLite WAL bus, not over Telegram.

3. **Existing approve/steer gate** (`src/state/approval-state.ts`) that the Telegram adapter is already designed to reuse via disk markers.

The central structural fact: **inter-agent coordination already exists below the presentation layer.** Telegram is positioned in spec #8 as a *control-plane presentation/notification surface*, not as a coordination bus.

## Existing Patterns

- **Provider factory** — one factory mints clients for every provider: `createClient` (`src/providers/factory.ts:191`), `isXaiEndpoint` (`src/providers/factory.ts:82`), `validateApiKey` (`src/providers/factory.ts:95`). DeepSeek rides the `openai-compat` provider (`DEEPSEEK_PROVIDER`, `src/fleet/child-config.ts:7`). "Which LLM" is decided here, not at any UI layer.
- **Per-child config + tier routing** — `buildChildConfig` (`src/fleet/child-config.ts`) applies an optional `DifficultyTier → provider` overlay (tier-policy); byte-identical when no tier is set.
- **Child spawning** — `ChildRunner` / `ChildRunSpec` / `ChildSpawnResult` (`src/fleet/runner.ts:56`, `:15`, `:21`) launch isolated child agent runs.
- **Round-based coordination** — `FleetCoordinator.executeRounds(manifest, blackboard, opts)` (`src/fleet/coordinator.ts:54`): re-spawns agents per round, early-stops on no-new-findings, returns `{executions, roundsRun}`.
- **Inter-agent bus (the existing "bot-to-bot")** — `SharedBlackboard` (`src/fleet/shared-blackboard.ts:37`) wraps the WAL `facts.db`; `publish(finding, now): FactRecord` (`:73`); `BlackboardFinding` (`:12`); `SharedBlackboardOpts` (`:19`). CLI surface: `agent-bober blackboard publish <value> [--round N]` (`COMMANDS.md:547`) and a sibling `read`.
- **Head synthesis** — `collect(blackboard, childResults, rounds): SynthesisBundle` (`src/fleet/synthesis.ts:28`, type `:14`) is **pure** (no LLM, no network): collects child outputs → `.bober/fleet-synthesis.json`, threads `roundsRun` into `fleet-report.json`.
- **Approve/steer gate** — disk markers `PendingMarker` / `ApprovedMarker` / `RejectedMarker` (`src/state/approval-state.ts:24-43`) with `savePending/listPending/readPending` (`:24-80`). The Telegram inline buttons write the identical `.approved.json` / `.rejected.json` markers (spec feat-6, resolvedClarification Q4).
- **Facts store** — `FactRecord` (`src/state/facts.ts:36`); the SQLite WAL store the blackboard wraps.
- **Integration convention (already chosen in the spec)** — import a sibling module when it exports a stable typed function (e.g. approval-state helpers); otherwise shell out via `execa` (already a dependency) to `agent-bober <subcommand>` (spec assumptions line 138; resolvedClarification Q1 = hybrid).

## Key Files

| File | Lines | Role |
|---|---|---|
| `.bober/specs/spec-20260628-telegram-frontend.json` | 316 | **Spec #8 to enrich** — thin single-bot adapter, 8 features, bot-to-bot explicitly out of scope |
| `src/providers/factory.ts` | 300 | Provider client factory (DeepSeek/Grok/Claude/Anthropic) |
| `src/fleet/child-config.ts` | 53 | `buildChildConfig` + provider const + tier overlay |
| `src/fleet/runner.ts` | 136 | `ChildRunner` — spawns isolated child runs |
| `src/fleet/coordinator.ts` | 158 | `FleetCoordinator.executeRounds` round loop |
| `src/fleet/shared-blackboard.ts` | 111 | `SharedBlackboard.publish/read` over WAL `facts.db` |
| `src/fleet/synthesis.ts` | 39 | Pure head synthesis (`collect → SynthesisBundle`) |
| `src/fleet/manifest.ts` | 52 | `FleetManifest` — the fleet input format |
| `src/fleet/index.ts` | — | `runFleet`, `resolveBlackboardPath` |
| `src/state/approval-state.ts` | 207 | Disk-marker approve/steer gate (reused by Telegram inline buttons) |
| `src/state/facts.ts` | 306 | `FactRecord` WAL facts store |

## Integration Points

- **Telegram transport:** long-polling `getUpdates` only — no webhook, no listening socket, no public URL (spec feat-1 AC2; security NFR). Each operator runs their own bot against their own checkout.
- **Where "which LLM" is decided:** `buildChildConfig` + provider factory + `FleetManifest` — *not* the Telegram layer. A coordination frontend selects/observes; it does not re-implement routing.
- **Natural read/notify sources for a coordination surface:** the blackboard (`agent-bober blackboard read`), `.bober/fleet-synthesis.json`, and `fleet-report.json` (`rounds`, executions). These are what a Telegram "secretary" view would summarize and push.
- **Approval bridge:** `.bober/approvals/*.pending.json` markers surface as inline `[Approve][Adjust][Reject]`; taps write `.approved.json`/`.rejected.json` (spec feat-6) — one existing gate, no new store.
- **Outbound chokepoint:** the spec's single `sendSafe` funnel (feat-3) is the one place any LLM/fleet output would be summarized before leaving over the non-e2e Telegram channel.
- **Sibling-CLI coupling:** `execa` shell-outs to `agent-bober task ...` / hub commands (spec assumption line 143), already the chosen pattern.

## Test Coverage

- **Existing coordination tests:** `src/fleet/coordinator.test.ts`, `src/fleet/shared-blackboard.test.ts`, `src/cli/commands/blackboard.test.ts`, `src/config/role-providers.test.ts`.
- **Telegram:** **zero** source files and **zero** tests today — `find` for `*telegram*` in `src/` and any `*telegram*.test.*` returns nothing. Spec #8 is an unbuilt draft.
- Suite scale (per project memory): ~2789 total tests; fleet ~276. Provider/blackboard/coordinator paths are already covered, so an enrichment that *reads* the blackboard/synthesis rides on tested substrate.

## Risk Areas

- **Layer mismatch (primary finding).** Inter-LLM coordination already exists via `SharedBlackboard` + `FleetCoordinator.executeRounds` + `synthesis.collect`. Building a *second* coordination bus over Telegram "bot-to-bot" would duplicate — more weakly — what `src/fleet/` already does deterministically and offline. The blackboard *is* the bot-to-bot bus.
- **Telegram platform constraint (to be confirmed by the web pass).** Telegram bots normally do **not** receive messages/updates authored by other bots, so literal bot↔bot chaining is likely blocked at the API; "secretary bot" is likely a group-admin/delegation *convention*, not a coordination API. The `/deep-research` companion validates this.
- **Privacy-surface multiplication.** Spec #8's control-plane funnel exists because Telegram is not end-to-end encrypted (feat-3, feat-7, security NFRs). A many-bots topology multiplies the egress chokepoints, tokens, and per-bot whitelists that must each uphold the summaries-only boundary.
- **Boundary breach of "thin adapter."** Adding bot-to-bot + multi-user fan-out crosses spec #8's own `outOfScope` line 153 and its maintainability NFR ("thin adapter: no ... logic reimplemented here"). Enriching #8 risks turning it into a coordination engine; a sibling spec may be the cleaner home (decision deferred to planning).
- **Dependency budget.** Spec #8 constrains itself to *at most one new npm dependency* (the Telegram library, Sprint 1 only — constraint line 311). A multi-bot/secretary design pressures that budget.

---

*Generated by the bober.research discipline (two-phase intent, executed via tokensave per repo CLAUDE.md) — factual findings; the topology recommendation is deferred to the post-`/deep-research` synthesis.*
