# Multi-LLM "secretary" fleet view (`/fleet` command + per-agent streaming sections)

**Contract:** sprint-spec-20260628-telegram-frontend-7  ·  **Spec:** spec-20260628-telegram-frontend  ·  **Completed:** 2026-06-30

> **Final sprint — this completes `spec-20260628-telegram-frontend` (7/7 sprints).** See the plan
> close-out summary at the bottom of [`docs/telegram.md`](../telegram.md).

## What this sprint added

A **read-only "secretary" view** of the most recent fleet run, surfaced two ways from one renderer.
A whitelisted operator can run `/fleet` and receive **one labeled section per agent** from the most
recent fleet run — agent label + a one-line summary of that agent's latest finding + the run's round
count + confidence + finding count, under a header showing `bundle.rounds`. The view reads the
head-written `.bober/fleet-synthesis.json` artifact (`SynthesisBundle { rounds, childResults,
findings }`) and groups `findings` by `FactRecord.subject` (the per-agent `childFolder`). The **same**
`renderFleetView` renderer also feeds the Sprint 6 streaming path (`streamFleetView`), so a live run
streams those per-agent sections by editing one message in place.

This stays a **thin read+render adapter**: **no run / fleet / scheduler logic** is added, and
`SynthesisBundle` / `FactRecord` are **type-only** imports — the compiled `dist/telegram/fleet-view.js`
has **zero** runtime coupling to `src/fleet` or `better-sqlite3` (evaluator-confirmed). Missing/empty
synthesis yields a graceful "no recent fleet run" reply (never a throw), `/fleet` is whitelist-gated
**before** the reader is touched, and every byte leaves through the `sendSafe` funnel with raw finding
values truncated to one line. **No npm dependency was added.**

## Public surface

### `src/telegram/fleet-view.ts` (new)

- `renderFleetView(bundle: SynthesisBundle): string[]` (`src/telegram/fleet-view.ts:67`) — **PURE**
  (no IO, no throw, deterministic). Returns `string[]`: index `0` is the header
  (`Fleet Run — Rounds: <rounds> | Total findings: <n>`, carrying `bundle.rounds`), and each subsequent
  element is one agent section, built by grouping `bundle.findings` by `FactRecord.subject`. Per section:
  the subject (agent label), `Summary:` = the latest finding's value collapsed to one line, then
  `Round: <rounds> | Confidence: <c> | Findings: <count>`. **The round comes from `bundle.rounds`** (the
  run-level count) for both the header and every section — `FactRecord` has **no** `round` field (round is
  lost at `publish()` in `shared-blackboard.ts`), so `finding.round` is never referenced. "Latest" within a
  group = max `tCreated` (ISO-8601 strings sort lexicographically). Empty `findings` ⇒ returns `[header]`
  only.
- `handleFleet(senderId, allowed, reader?)` (`src/telegram/fleet-view.ts:115`) — the `/fleet` command
  handler. Returns a plain `string` for the caller to pass through `sendSafe` (no transport access).
  Sequence: **(1) whitelist gate FIRST** — a non-whitelisted sender gets `denialReply(senderId)` and the
  reader is **never called** (`sc-7-6`); **(2)** read the bundle via the injected `reader` (default
  `defaultSynthesisReader`); **(3)** `null` or zero findings ⇒ the friendly
  `"No recent fleet run. Run a fleet command with --blackboard to see per-agent findings here."`;
  **(4)** otherwise `renderFleetView(bundle).join("\n\n")`.
- `SynthesisReader` type (`src/telegram/fleet-view.ts:30`) — `() => Promise<SynthesisBundle | null>`. The
  injection seam so unit tests drive fixtures without disk.
- `defaultSynthesisReader()` (`src/telegram/fleet-view.ts:40`) — production reader: reads
  `<projectRoot>/.bober/fleet-synthesis.json` via `node:fs/promises` + `JSON.parse`. Returns `null` on
  `ENOENT` **or** parse failure (a non-blackboard run leaves the file absent by design), so the handler
  degrades to the empty state instead of throwing.

### `src/telegram/streaming.ts`

- `streamFleetView(transport, chatId, bundle)` (`src/telegram/streaming.ts:55`) — streams the per-agent
  fleet sections as in-place edits to **one** message. Calls the **shared** `renderFleetView` to produce
  the sections, then feeds them into `streamProgress` via an **accumulating** async generator (each yield
  appends the next section, so the message grows from header to full summary in place). Because it reuses
  `renderFleetView`, the same one-line truncation that protects `/fleet` (`sc-7-5`) applies here too —
  verbatim payloads never reach the transport via either surface.

### `src/telegram/bot.ts`

- `/fleet` is registered in the poll-loop command dispatch — a whitelisted sender's `/fleet` calls
  `handleFleet(senderId, allowed, fleetReader)` and replies via `sendSafe`.
- `helpReply()` gains a `/fleet — latest multi-LLM fleet run findings` line.
- `startPollLoop(...)` gains an **optional 7th** `fleetReader: SynthesisReader = defaultSynthesisReader`
  parameter — all existing two-arg (and longer) callers compile unchanged.

## How to use / how it fits

```bash
# 1. Run a fleet with the blackboard so the head writes .bober/fleet-synthesis.json
agent-bober fleet ./fleet.json --blackboard

# 2. In Telegram, as a whitelisted operator:
/fleet
# Fleet Run — Rounds: 2 | Total findings: 3
#
# grok-child
# Summary: anomaly found in Q3 ledger
# Round: 2 | Confidence: 0.90 | Findings: 2
#
# deepseek-child
# Summary: schema mismatch detected
# Round: 2 | Confidence: 0.70 | Findings: 1
```

`/fleet` is the on-demand surface; `streamFleetView` is the live surface (a running fleet streams the
same per-agent sections into one in-place-edited message via the Sprint 6 streaming funnel). Both read
the **same** artifact and call the **same** renderer, so they never drift. When no fleet has run with a
blackboard (the artifact is absent), `/fleet` replies with the friendly empty-state line.

## Notes for maintainers

- **Round comes from `bundle.rounds`, not the finding.** `FactRecord` carries no `round` field (it is
  dropped at `publish()` in `src/fleet/shared-blackboard.ts`), so both the header and each section show the
  run-level `bundle.rounds`. Do **not** reach for `finding.round` — it does not exist.
- **Type-only coupling is load-bearing.** `SynthesisBundle` (from `../fleet/synthesis.js`) and `FactRecord`
  (from `../state/facts.js`) are imported with `import type` and **erased at compile**. The evaluator
  verified `dist/telegram/fleet-view.js` has **zero** runtime references to `fleet/synthesis`, `state/facts`,
  or `better-sqlite3`. Keep these type-only — a runtime import would drag `better-sqlite3` into the bot
  process. The shape of `fleet-synthesis.json` is the on-disk contract; if the head ever changes the write
  path or shape, update `defaultSynthesisReader` / the `SynthesisBundle` type, not a runtime import.
- **One renderer, two surfaces — keep truncation in `renderFleetView`.** `oneLine()`
  (`MAX_LINE_LENGTH = 120`) collapses a multi-line value to its first line and caps length so a verbatim
  payload never reaches the transport. Both `/fleet` and `streamFleetView` rely on this; don't add a
  second rendering path that bypasses it.
- **Deferred follow-ups (not in scope here).** The live `sc-6-5` do-bridge streaming wire (the seam at
  `src/do-bridge/do.ts`) is still pending, and live smoke tests — including the manual `sc-7-7` (a real
  fleet run streaming sections in Telegram) — need a **real bot token** and were not run in CI. **Tier 2**
  (per-LLM bot identities / Bot API 10.0 bot-to-bot) and **Tier 3** (Secretary Mode) are deferred to
  **sibling specs** per the spec's out-of-scope.

Commit: `1a9a628` — *bober(sprint-7): multi-LLM secretary fleet view (/fleet command + per-agent
streaming)* (4 files, +341/-1; **no** new dependency; diff confined to `src/telegram/`). Build/typecheck
0 errors; full suite **3686** green (**+8 tests**). All 6 required criteria (`sc-7-1`..`sc-7-6`) passed
iteration 1: type-only imports (no runtime `src/fleet`/`better-sqlite3`); one section per distinct
`FactRecord.subject` with label + one-line summary + round + confidence + count; null/empty reader ⇒
graceful "no recent fleet run" (no throw); header shows `bundle.rounds`; over-long value truncated to one
line and routed via `sendSafe` (verbatim never reaches the transport, on both `/fleet` and
`streamFleetView`); non-whitelisted `/fleet` denied with the id-echo and the injected reader **never
called**. The manual `sc-7-7` (live fleet streaming in Telegram) is **not required** and was skipped (needs
a real bot token). No regressions.
