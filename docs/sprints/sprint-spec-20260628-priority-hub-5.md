# `bober chat hub` surface with scoped /priority and /decide

**Contract:** sprint-spec-20260628-priority-hub-5  ·  **Spec:** spec-20260628-priority-hub  ·  **Completed:** 2026-06-29

## What this sprint added

Sprint 5 — the **finale** of the priority-hub plan — gives the hub a **conversational
surface**. It registers a built-in **`hub` team as data** so `bober chat hub` opens a chat
session bound to the `hub` memory namespace, and adds two **additive** in-session slash
commands — `/priority` and `/decide X vs Y` — that delegate to the Sprint 2–4 hub pipeline
(`collectFindings → rankFindings → renderPriorityMd`) and return a ranked `rank. title`
summary while best-effort writing `priority.md`. Both commands are **gated on the hub
namespace** (a no-op informative message — with **zero** LLM call — for any other team), and
all ten pre-existing slash commands are left **byte-identical** (the new commands are
deliberately **not** advertised in `/help`). No new dependency, no collector/judge/renderer
logic — this is pure wiring over the existing hub functions.

## Public surface

- **`bober chat hub`** — opens a chat session whose `memoryNamespace` resolves to `"hub"`.
  Routed entirely through the **existing** `bober chat [team]` command (`src/cli/commands/chat.ts:31,45`)
  via the new `loadTeam` branch below; no change to the chat command itself.
- Built-in **`hub` team** (`src/teams/registry.ts:47`) — registered **as data inline in
  `loadTeam`** (mirroring the `medical` branch): `id`/`displayName` `"Priority hub"`,
  `memoryNamespace: "hub"`, the **default** `pipelineShape` (`resolveEngineName(config)`),
  default roles/providers, and **no guardrails**. It is not a `medical-sop`-style code engine —
  just a namespace + default pipeline.
- **`/priority`** (in-session, hub only) — `dispatch` param 10 + `case "/priority"`
  (`src/chat/slash-commands.ts:71,157`) → `ChatSession.handleHubPriority`
  (`src/chat/chat-session.ts:462`). Ranks the pooled findings under **general** scope and
  returns one `rank. title` line per finding.
- **`/decide <X> vs <Y>`** (in-session, hub only) — `dispatch` param 11 + `case "/decide"`
  (`src/chat/slash-commands.ts:72,164`) → `ChatSession.handleHubDecide`
  (`src/chat/chat-session.ts:482`). Splits the expression on `/\s+vs\s+/i`; a malformed
  expression (not two non-empty sides) returns `Expected 'X vs Y', got: <expr>`. Ranks under
  **decision** scope so only findings relevant to X or Y survive.
- `ChatSession.rankAndRenderHub(scope, label)` (`src/chat/chat-session.ts:506`, private) — the
  shared core: `resolveSiblingRepos → collectFindings(HUB_SCOPE) → rankFindings(findings, scope,
  this.llm, now)`, a **best-effort** `priority.md` write, then the `rank. title` summary
  (`No findings to prioritize.` when the pool is empty).

## How to use / how it fits

```text
$ bober chat hub
> /priority
1. Lipid panel overdue
2. Portfolio rebalance due
> /decide take the job offer vs stay
1. Relocation cost finding
2. Salary delta finding
```

`bober chat hub` is the conversational sibling of the Sprint 4 CLI commands
(`bober hub priority` / `bober hub decide`): both drive the **same** collect → rank → render
pipeline. The difference is only the surface — chat keeps you in the REPL and returns the
summary inline, while still best-effort writing the same `priority.md` to the resolved kb-hub
out vault. The judge's `LLMClient` is the session's **injected** `this.llm`
(`ChatSessionOptions.llm`) — the hub handlers never call `createClient`, so the chat hub path
runs fully offline in tests.

## Notes for maintainers

- **`/priority` and `/decide` are not in `/help`.** `HELP_TEXT` is **byte-identical** to
  before this sprint (required by `sc-5-4`, which asserts every pre-existing command — including
  `/help` — returns its prior output). The two hub commands therefore work but are **not
  discoverable** via `/help`. **Follow-up:** surface them in `/help` (and/or only when the
  session is the hub team) once the byte-identical-`/help` constraint is relaxed — they are
  documented in `COMMANDS.md` in the meantime.
- **Hub-namespace gating is the coupling guard.** `handleHubPriority` / `handleHubDecide`
  early-return an informative string when `this.memoryNamespace !== "hub"` **before** touching
  `this.llm` — a non-hub team gets a no-op and **zero** LLM call (proven in the eval with a
  throwing client). The commands are wired into the dispatch for **every** team but are inert
  outside the hub.
- **The judge client is injected, never freshly constructed.** Unlike the Sprint 4 CLI (which
  builds the client via `createClient`), the chat handlers reuse `this.llm`, so the offline
  testability comes for free and there is no second provider-resolution path to keep in sync.
- **The `priority.md` write is best-effort.** `rankAndRenderHub` wraps `resolveOutVault` +
  `fileExists` + `writeFile` in a `try/catch` and **swallows** any failure — a missing/locked
  out vault must never break a chat turn (the ranked summary is still returned). This is softer
  than the Sprint 4 CLI, which **fails closed** (stderr + non-zero exit) on a missing vault.
- **No new collector/judge/renderer.** Per the contract non-goals, this sprint adds **zero**
  new ranking logic — it reuses `collectFindings` (S2), `rankFindings` (S3), and
  `renderPriorityMd` + `resolveOutVault`/`priorityMdPath` (S4). The richer Telegram
  `/today|/priority|/decide` mapping remains owned by the telegram-frontend spec.

## Scope

Commit `45d3c17`: 6 files changed, **+654 / -1**. Three additive source edits
(`src/teams/registry.ts` +13 — the inline `hub` branch; `src/chat/slash-commands.ts` +25/-1 —
two optional dispatch params + two `case`s, `HELP_TEXT` unchanged; `src/chat/chat-session.ts`
+72 — the two handlers + `rankAndRenderHub` + hub imports) plus their tests
(`registry.test.ts` +6, `slash-commands.test.ts`, new `chat-session.test.ts` +330 covering
sc-5-1/2/3/4). **No new dependencies**; `schema.ts`, the `Finding` schema, the judge, the
scope parser, and the renderer are untouched. All five required criteria (`sc-5-1..sc-5-5`)
passed **iteration 1**; eval `eval-sprint-spec-20260628-priority-hub-5-1` → **pass** (5/5
required), full suite **3264** green, typecheck/build/lint clean (2 pre-existing unrelated lint
warnings in `eval-persist.test.ts`).

**`spec-20260628-priority-hub` is now complete (5 of 5).** The net-new `src/hub/` module
(canonical `Finding` schema + FactStore source, read-only cross-repo collector + sibling
resolver, scope parser + two-pass judge, `priority.md` renderer + out-vault config) plus the
`bober hub list` / `bober hub priority` / `bober hub decide` CLI and the `bober chat hub`
surface ship with a **single** edit to existing core code — the additive `{ readonly?: boolean }`
flag on the `FactStore` constructor (Sprint 2) — and **no new dependency**. The do-bridge
(`Finding.promotesTo`), calendar slot-fill, the scheduler, and the Telegram adapter remain owned
by sibling specs.
