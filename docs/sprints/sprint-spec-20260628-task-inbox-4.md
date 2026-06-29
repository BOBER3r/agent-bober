# Domain finding intake (pool ingest + dedup)

**Contract:** sprint-spec-20260628-task-inbox-4  ·  **Spec:** spec-20260628-task-inbox  ·  **Completed:** 2026-06-29

## What this sprint added

Sprint 4 gives **domains** one entry point for pushing an AUTO-surfaced Finding into the unified
hub pool: an exported `ingestFinding(store, input, {now})` plus a `bober task ingest [file]` CLI
that reads a Finding JSON from a **file path or stdin**. Ingest **validates** the payload against
the Finding schema, derives a **content-stable id** from `${domain}|${title}|${kind}` when none is
supplied, fills `surfacedAt=now` when absent, then persists through the existing `writeFinding`
reconcile path — so **re-surfacing the same finding reconciles to a single active row** (`update`
or `noop`) rather than duplicating. The ingested finding immediately appears in `bober task list`
and to every sibling hub command. Malformed JSON or a schema-invalid payload is **fail-closed**:
the CLI prints to stderr, sets `exitCode=1`, writes nothing, and never throws.

## Public surface

- `ingestFinding(store, input, { now })` (`src/hub/finding-store.ts:140`) — the seam domains call to
  surface a Finding. Validates `input` against `IngestInputSchema` (relaxed), derives/keeps the id,
  sets `surfacedAt=now` when absent, **re-validates the fully-assembled object against the FULL
  `FindingSchema`** before any write, then delegates to `writeFinding` (which routes through
  `writeFact`, so reconcile dedup applies for free). Returns the `ReconcileAction`
  (`add` | `update` | `delete` | `noop`). **PURE w.r.t. the clock** — `now` is injected, never read
  inside. `.parse()` **throws** on a missing required field; the throw is caught at the CLI boundary.
- `IngestInputSchema` (`src/hub/finding-store.ts:129`) — `FindingSchema.partial({ id: true,
  surfacedAt: true })`. The input shape ingest accepts: `id` and `surfacedAt` are optional (ingest
  fills them); every other Finding field is still required and validated up front.
- `deriveFindingId(domain, title, kind)` (`src/hub/finding-store.ts:121`) — module-private helper.
  Content-stable 16-char id = `createHash("sha256").update("${domain}|${title}|${kind}").digest("hex")
  .slice(0, 16)`, mirroring the `factId` idiom in `src/state/facts.ts`. **Deterministic** (same
  inputs → same id) and **clock-free**, which is exactly what makes a re-surfaced finding collide on
  subject and reconcile instead of duplicating.
- **`bober task ingest [file]`** (`src/cli/commands/task.ts:389`, registered in
  `registerTaskCommand`) — read a Finding JSON from the optional `<file>` arg, or from **stdin** when
  the arg is omitted, then ingest it. On success prints a green `Ingested finding (<action>)` where
  `<action>` is the raw `ReconcileAction` (`add`/`update`/`noop`). On invalid JSON or schema failure
  it prints a red message to stderr, sets `process.exitCode = 1`, and returns **without throwing or
  writing**.
- `runTaskIngest(store, raw, now)` (`src/cli/commands/task.ts:267`) — DI core for the command.
  `JSON.parse(raw)` inside a try (bad JSON → red `input is not valid JSON` + `exitCode=1` + return),
  then `ingestFinding` inside a second try (schema failure → red `invalid finding: <message>` +
  `exitCode=1`). **Never throws.**
- `readIngestInput(file?)` (`src/cli/commands/task.ts:249`) — module-private. Returns the raw JSON
  string: `node:fs/promises` `readFile(file, "utf-8")` when `file` is given, else **async-iterates
  `process.stdin`** and concatenates the chunks. No synchronous fs (per principles).

## How to use / how it fits

```bash
# A domain's proactive pass writes a Finding JSON, then hands it to the seam:
$ echo '{"domain":"medical","title":"LDL trending up","kind":"watch","urgency":3,"severity":2,"summary":"3 of last 4 panels rising","tags":[]}' \
    | bober task ingest
Ingested finding (add)

$ bober task ingest finding.json    # …or from a file
Ingested finding (add)

# Re-surfacing the SAME domain+title+kind reconciles to the existing row — no duplicate:
$ bober task ingest finding.json
Ingested finding (noop)        # (or "update" if a non-key field changed)

$ bober task list               # the ingested finding shows up like any other task
ID                 STATUS       DOMAIN       TITLE
--------------------------------------------------------------------------------
a1b2c3d4e5f60718   open         medical      LDL trending up
```

`ingestFinding` is the **only** entry point a domain pipeline needs in order to surface a finding —
it does not duplicate `captureTask`'s persistence; it reuses `writeFinding` / `writeFact` so the
existing reconcile `add` / `update` / `noop` logic, supersede history, and sibling visibility all
apply unchanged. The CLI handler stamps `now = new Date().toISOString()` at the boundary, opens the
active team's namespace `FactStore`, and closes it in a `finally`, exactly like the other task
handlers. An ingested finding is an ordinary active `hub`-scope `finding` row, so it is equally
visible to `bober task list`, `bober hub list`, and `priority` / `decide` / `chat hub`.

## Notes for maintainers

- **Schema is never bypassed.** Validation happens **twice** and both gate the write: once via
  `IngestInputSchema.parse` (relaxed: id/surfacedAt optional) on the raw input, then again via the
  **full `FindingSchema.parse`** on the assembled `{...parsed, id, surfacedAt}` object before
  `writeFinding`. A missing required field throws *before* any row is written. Keep the
  validate-then-write order if you touch this.
- **Dedup is content-addressed, not time-addressed.** The id derives from `domain|title|kind` only —
  not from `now`, `summary`, `urgency`, or `tags`. Two surfacings that agree on those three fields
  collide and reconcile; changing the title or kind mints a *new* finding. A caller that supplies its
  own `id` keeps it (the derive only fills an absent id).
- **`now` stays out of the hub layer.** `ingestFinding` and `deriveFindingId` never read the clock;
  the only clock read is `new Date().toISOString()` at the CLI handler boundary. Preserve that if you
  extend ingest.
- **stdin is read by async iteration.** `readIngestInput` async-iterates `process.stdin` and concats
  `Buffer` chunks rather than casting a file descriptor to a `PathLike` for `readFile` — see the
  inline note if Node typings later expose `fd` as `PathLike`. No synchronous fs anywhere.
- **No schema change, no new deps.** `src/hub/finding.ts` is untouched; `createHash` comes from the
  Node builtin `node:crypto`. This sprint is **additive** — `captureTask`, `transitionFinding`, the
  snooze/list filters, and the priority-hub collector/judge/renderer are all unchanged.
- **Scope boundary.** This is the ingest *entry point only*. No domain's proactive review pass that
  *generates* findings ships here (chat capture is sprint 5, the Gmail bridge sprint 6, and
  ranking/judging of ingested findings belongs to priority-hub).

## Scope

Commit `5c77a49`: 4 files changed, **+245 / -2** — `src/hub/finding-store.ts` (+38:
`deriveFindingId`, `IngestInputSchema`, `ingestFinding`) and `src/cli/commands/task.ts` (+83:
`readIngestInput`, `runTaskIngest`, the `ingest [file]` registration, `node:buffer` /
`node:fs/promises` imports), plus the collocated `finding-store.test.ts` (+71) and `task.test.ts`
(+55), all against an in-memory `:memory:` FactStore. **No** new runtime dependency. All five
criteria (`sc-4-1..sc-4-5`, all required) passed on iteration 1 (**zero reworks**); eval
`eval-sprint-spec-20260628-task-inbox-4-1` → **pass** (5/5), full suite **3297 → 3303** green, build +
typecheck + lint clean (0 errors).
