# Zero-friction task capture: persistence helper + `bober task add`

**Contract:** sprint-spec-20260628-task-inbox-1  ·  **Spec:** spec-20260628-task-inbox  ·  **Completed:** 2026-06-29

## What this sprint added

Sprint 1 — the opening sprint of the **task-inbox** plan — gives the hub a **zero-friction
capture path**. It adds a thin Finding **persistence helper** (`src/hub/finding-store.ts`:
`writeFinding` / `readFindings`) over the existing `FactStore`, a deterministic, synchronous
`captureTask` function (`src/hub/task-inbox.ts`), and the `bober task add <text> [--domain <d>]`
CLI command (`src/cli/commands/task.ts`). A plain string becomes **one open `kind=action`
Finding** in the **unified hub pool** (`scope='hub'`, `predicate='finding'`, `subject=id`,
`value=JSON`), with all unknown fields left empty/omitted. Capture is **pure** — it never calls
the clock and never prompts or blocks — so it can never get in the user's way. The canonical
`Finding` schema is **imported** from the priority-hub module (`src/hub/finding.ts`); it is **not**
redefined here.

## Public surface

- **`bober task add <text> [--domain <domain>]`** (`src/cli/commands/task.ts:87`,
  `registerTaskCommand`) — capture a plain task as an open action Finding in the hub pool.
  Prints `Captured task <id>` plus the title and domain, exits `0` on success and `1` on error
  (empty text or persistence failure), **never throwing** out of the handler. Wired into the root
  program in `src/cli/index.ts:322`.
- `runTaskAdd(store, text, opts, now)` (`src/cli/commands/task.ts:58`) — the DI core of `task add`:
  takes an already-open `FactStore` and an injected `now`, so tests drive it without spawning the
  CLI or opening a real DB. Trims `text`, rejects empty input to stderr with `exitCode=1`, and
  catches all errors.
- `captureTask(store, text, { domain?, now })` (`src/hub/task-inbox.ts:22`) — builds a `Finding`
  (`kind='action'`, `status='open'`, `title=text.trim()`, `surfacedAt=now`, deterministic
  `id = sha256(title|now).slice(0,16)`, `tags=['domain:<d>']` when a domain is given) and persists
  it via `writeFinding`. Returns the captured `Finding`. **Never** calls `Date.now()`/`new Date()`.
- `writeFinding(store, finding, { now })` (`src/hub/finding-store.ts:16`) — serialize a `Finding`
  into a `FactInput` (`scope='hub'`, `subject=finding.id`, `predicate='finding'`,
  `value=JSON.stringify(finding)`, `confidence=1`, `tValid=tCreated=now`) and route it through
  `writeFact` (the reconcile layer), **not** a raw `insertFact`, so dedup/supersede works later.
  Returns the `ReconcileAction`.
- `readFindings(store)` (`src/hub/finding-store.ts:44`) — read all active hub Findings:
  `getActiveFacts('hub', undefined, 'finding').map(r => FindingSchema.parse(JSON.parse(r.value)))`.
  **Throws** on a malformed row (strict `parse`), unlike the lenient safeParse-and-skip path in
  `FactStoreFindingSource` used by `bober hub list`.

## How to use / how it fits

```bash
$ bober task add "renew passport"
Captured task 1f3c9a0b2e4d6f80
  title:  renew passport
  domain: inbox

$ bober task add "book annual physical" --domain medical
Captured task ...
  title:  book annual physical
  domain: medical
```

`bober task add` is the **producer** front-end for the hub pool that the priority-hub commands
already **consume**: a captured task is an ordinary `kind=action` Finding, so it immediately shows
up in `bober hub list` and is eligible for ranking by `bober hub priority` / `bober hub decide` /
`bober chat hub`. The command opens the `FactStore` and stamps `now = new Date().toISOString()` at
the **handler boundary only** (`src/cli/commands/task.ts`), then delegates to the pure
`runTaskAdd` → `captureTask` → `writeFinding` chain; the store is always closed in a `finally`.

## Notes for maintainers

- **Deterministic enrichment only — no LLM, no clock in the hub layer.** Per the contract
  non-goals, capture is synchronous and side-effect-light so it can never block. LLM-based triage
  is a deliberate later, separate concern. `src/hub/finding-store.ts` and `src/hub/task-inbox.ts`
  contain **no** `Date.now()`/`new Date()` — `now` is always injected from the CLI boundary.
- **Neutral defaults fill required schema fields.** `FindingSchema` requires `domain` (`min(1)`),
  `urgency` (1–5), and `severity` (1–5). Capture sets `domain='inbox'` (overridable via `--domain`),
  `urgency=3`, and `severity=1` rather than prompting — these are placeholder neutral values, not
  user intent. When `--domain` is given, capture both sets `Finding.domain` **and** adds a
  `domain:<d>` tag; with no `--domain` there is no `domain:` tag and the domain falls back to
  `inbox`.
- **`writeFinding` routes through the reconcile layer on purpose.** Using `writeFact` (not a raw
  insert) means later dedup/supersede behaves correctly. The deterministic `id` (sha256 of
  `title|now`) means re-capturing identical text at the same `now` produces the same row.
- **`readFindings` is strict; `bober hub list` is lenient.** `readFindings` uses
  `FindingSchema.parse` and **throws** on a bad row, so it is for trusted/own-store reads. The
  cross-repo listing path deliberately uses safeParse-and-skip so one corrupt sibling row never
  breaks the listing — do not "fix" `readFindings` to swallow errors; they are different contracts.
- **Later sprints own the rest of the inbox.** `list` / `done` / `snooze` / `drop` / ingest / chat
  / gmail are explicitly out of scope here — only initial `status='open'` capture ships in this
  sprint.

## Scope

Commit `0e39c15`: 7 files changed, **+434 / -0** (all additions). Three new source files
(`src/hub/finding-store.ts` +48, `src/hub/task-inbox.ts` +50, `src/cli/commands/task.ts` +121),
their three collocated test files (`finding-store.test.ts`, `task-inbox.test.ts`,
`task.test.ts` — 17 new tests, run against an in-memory `:memory:` FactStore), and a 4-line
additive edit to `src/cli/index.ts` (the `registerTaskCommand` import + call). **No** new runtime
dependency; `src/hub/finding.ts` (the canonical `Finding` schema), `facts.ts`, and the priority-hub
collector/judge/renderer are untouched. All five criteria (`sc-1-1..sc-1-5`, four required) passed
**iteration 1**; eval `eval-sprint-spec-20260628-task-inbox-1-1` → **pass** (5/5), full suite
**3264 → 3281** green, build + typecheck clean (2 pre-existing unrelated lint warnings).
