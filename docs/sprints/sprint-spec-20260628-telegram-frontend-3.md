# Scoped prioritization commands (`/today`, `/priority`, `/decide X vs Y`)

**Contract:** sprint-spec-20260628-telegram-frontend-3  ·  **Spec:** spec-20260628-telegram-frontend  ·  **Completed:** 2026-06-29

## What this sprint added

Sprint 3 puts the **first hub-query commands** behind the Sprint 1 transport spine: a whitelisted
operator can now send `/today`, `/priority`, or `/decide X vs Y` and get back a **numbered ranked
list** of finding titles sourced from the priority hub (`spec-20260628-priority-hub`). The router
(`router.ts`) gains a **pure** `parseScopeFromCommand` that derives an **ephemeral** hub `Scope`
from the command text only (never persisted), and a new handler (`handlers/prioritize.ts`) calls an
**injected** hub query with that scope and renders the returned findings **in the hub's order**
(the adapter never re-ranks). The production default shells out to the **hub CLI subprocess** via
`execa` — so the subprocess owns every LLM call and this adapter never constructs an `LLMClient`
(`src/telegram/` imports no provider). `bot.ts` dispatch is wired for `today`/`priority`/`decide`;
`/start` and the `Unknown command` fallback are unchanged, and every reply still leaves through the
Sprint 1 `sendSafe` funnel.

## Public surface

- `parseScopeFromCommand(name, args)` (`src/telegram/router.ts:60`) — **pure** (no I/O, no network,
  no clock) mapper from a slash-command name + trailing args to a hub `Scope` (`src/hub/scope.ts`)
  or `null`. `"today"` → `{ mode:"filtered", dueWithinDays:1 }`; `"priority"` → `{ mode:"general" }`;
  `"decide"` → split args on `/\s+vs\s+/i`, trim both ⇒ `{ mode:"decision", optionA, optionB }`,
  returning **`null`** unless the split yields **exactly two non-empty** options. Any other name
  → `null` (caller falls through to the `Unknown command` stub). The scope is **ephemeral** — each
  command re-derives it from its own text and it is never written to disk (`sc-3-2`, nonGoal #2).
- `HubResult` (`src/telegram/handlers/prioritize.ts:21`) — the minimal hub-query result the adapter
  reads: `{ title: string }`. Only the title is rendered (the hub `Finding` has **no `summary`
  field**, so the reply is **title-only** — nonGoal #3).
- `HubQuery` (`src/telegram/handlers/prioritize.ts:29`) — the injected query type,
  `(scope: Scope) => Promise<HubResult[]>`. Production passes `defaultPrioritize`; unit tests pass a
  fake returning fixture findings **without spawning any subprocess** (`sc-3-3`/`sc-3-4`).
- `PrioritizeFn` (`src/telegram/handlers/prioritize.ts:35`) — alias of `HubQuery`, the type of the
  `prioritize` parameter on `startPollLoop` (mirrors `InboxCapture` for `capture`).
- `defaultPrioritize(scope)` (`src/telegram/handlers/prioritize.ts:56`) — the production `HubQuery`.
  Resolves the project root (falling back to `process.cwd()`) and the CLI entry
  (`resolveCliEntry()`), then runs the **hub CLI in a subprocess** via `execa(process.execPath, …)`:
  `decision` → `hub decide "<optionA> vs <optionB>"`; `filtered` → `hub priority` (+ optional
  `--due`/`--domain`/`--tag`); `general` → `hub priority`. It parses the CLI's `N. <title>` stdout
  lines into `HubResult[]` and **throws** on a non-zero exit (the error surfaces in the Telegram
  reply via `sendSafe`). **The subprocess fully owns any LLM/model call — this adapter never
  constructs an LLM client** (nonGoal #5).
- `handlePrioritize(name, args, query = defaultPrioritize)` (`src/telegram/handlers/prioritize.ts:117`)
  — parses the scope, returns the `Unknown command: /<name>` stub when it is `null`, calls the
  injected `query`, and returns a numbered list (`1. <title>\n2. …`) **in the hub's returned order**
  (verbatim — no re-sort, nonGoal #1), or `No findings to prioritize.` when the hub returns none. It
  has **no** transport access; the caller passes the returned string to `sendSafe` (`sc-3-4`).
- `startPollLoop(transport, signal, capture = defaultCapture, prioritize = defaultPrioritize)`
  (`src/telegram/bot.ts:104`) — gains an **optional** fourth parameter (the hub query, default
  `defaultPrioritize`) so the loop is testable with a fake. The whitelisted-sender command branch now
  routes `today` / `priority` / `decide` to `handlePrioritize` (`bot.ts:163`); `start` → `helpReply()`
  and every other command → `Unknown command: /<name>` are unchanged — all replies via `sendSafe`.

## How to use / how it fits

Run the bot as before (`agent-bober telegram`, credentials from env). Then, from a whitelisted
account:

```
/priority            → numbered ranked list of all pooled findings (general scope)
/today               → numbered ranked list filtered to findings due within 1 day
/decide A vs B       → numbered ranked list of findings relevant to A or B (decision scope)
```

The bot delegates ranking to the **same** priority hub the CLI uses — `defaultPrioritize` invokes
`node <cliEntry> hub priority` / `hub decide` (`src/cli/commands/hub.ts:207`/`:251`) in a subprocess
and parses its `N. <title>` output. This keeps the adapter thin: all relevance filtering, lens-panel
judging, and any model calls happen **inside the hub subprocess**, never in `src/telegram/`. The
reply order is the hub's ranking unchanged.

## Notes for maintainers

- **Title-only rendering.** The hub `Finding` carries no `summary`, so the reply is titles only.
  `sc-3-4` was written as "titles/summaries"; the evaluator accepted title-only as faithful to the
  current schema. If `Finding` ever gains a short summary, extend the `HubResult` shape and the
  `handlePrioritize` formatter — keep it to titles/short summaries only (no raw domain detail).
- **Subprocess per command.** `defaultPrioritize` spawns one child `node` process per
  `/today`/`/priority`/`/decide`. A `bober:` marker in `prioritize.ts` notes that this can be swapped
  for in-process `rankFindings`/`collectFindings` if subprocess startup latency ever exceeds an
  acceptable Telegram response time. The subprocess boundary is **deliberate** — it is what keeps the
  LLM out of the adapter; do not collapse it without preserving that guarantee.
- **No provider import in `src/telegram/`.** The evaluator confirmed no `LLMClient`/provider is
  imported anywhere under `src/telegram/` (the hub subprocess owns model calls). Keep it that way.
- **Ephemeral scope.** `parseScopeFromCommand` writes nothing — each command re-derives its scope.
  There is no scope persistence to migrate or clear.
- **`sendSafe` invariant preserved.** `handlePrioritize` returns a string; the loop sends it via
  `sendSafe`. No new direct `transport.sendMessage` call was added.
- **Decision parsing is strict.** `/decide` requires a literal case-insensitive ` vs ` separator
  yielding exactly two non-empty options; `/decide foo` or `/decide a vs b vs c` returns `null` ⇒ the
  `Unknown command` stub (no partial decision).

Commit: `54f7d98` — *bober(sprint-3): scoped priority commands /today /priority /decide X vs Y*
(5 files, +346/-6; **no** new dependency). Build/typecheck 0 errors; full suite **3629** green
(**+15 telegram tests**: router parser + prioritize handler). All 4 required criteria
(`sc-3-1`..`sc-3-4`) passed iteration 1; the manual `sc-3-5` (live `/priority` against the real hub
pool) was not run in CI. No regressions.
