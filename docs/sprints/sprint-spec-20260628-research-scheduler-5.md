# Morning digest artifact for the Telegram bot

**Contract:** sprint-spec-20260628-research-scheduler-5  ·  **Spec:** spec-20260628-research-scheduler  ·  **Completed:** 2026-06-30

## What this sprint added

Sprint 5 — the **finale** of the **research-scheduler** plan (5 of 5) — adds the **morning digest
artifact**: the content the Telegram bot (a sibling spec) will later push as a silent scheduled
message. A new `buildDigest(since, now, deps)` collects every research run produced in the window
`[since, now]`, renders **both** a human-readable markdown body and a machine-readable JSON object,
and writes them side by side to `.bober/research/digests/<YYYY-MM-DD>.{md,json}`. An **empty window**
is a first-class case: it still writes both files with an explicit `_No new research was produced in
this window._` body rather than throwing or leaving an empty file. A new
`bober research digest --since <iso>` (default: the last 24 h) drives it from the CLI. **Transport,
polling, and message rendering are explicitly out of scope** — this sprint produces only the artifact.

## Public surface

- `buildDigest(since, now, deps): Promise<{ digest, mdPath, jsonPath }>` (`src/research/digest.ts:100`)
  — collects in-window runs via `deps.collectRuns(since, now)`, builds a `Digest`, renders both
  outputs, `ensureDir`s `deps.digestsDir`, and writes `<date>.md` + `<date>.json`. The file date is
  `now.slice(0, 10)` (YYYY-MM-DD) — **derived from the injected `now`, never the wall clock**. JSON is
  `JSON.stringify(digest, null, 2) + "\n"`. Returns both written paths.
- `renderDigestMarkdown(digest): string` (`src/research/digest.ts:63`) — **PURE** (no I/O, no
  `Date.now()`, no side effects). Heading + window/generated lines, then one bullet per run:
  `- **<title>** — <topFinding> ([source](<source>))`. When `digest.runs` is empty it emits the
  explicit no-new-research line (sc-5-3).
- `collectRunsFromVault(vaultRoot, since, now): Promise<DigestRun[]>` (`src/research/digest.ts:139`) —
  the **real** collector (bound only by the CLI). Reads vault research notes under
  `<vaultRoot>/research/` via `listNotes`/`readNote`, filters by `frontmatter.generatedAt` in
  `[since, now]` (ISO **lexicographic** compare — safe because all timestamps are fixed-width
  `toISOString()`), and maps each match to a `DigestRun`. A missing `research/` directory ⇒ `[]` (no
  throw). `topFinding` is derived from `frontmatter.question` (falling back to title) — **non-sensitive
  content only**.
- `DigestRun` (`src/research/digest.ts:22`) — `{ title, topFinding, generatedAt, source }`.
- `Digest` (`src/research/digest.ts:34`) — `{ since, now, generatedAt (= now), runs: DigestRun[] }`.
- `DigestDeps` (`src/research/digest.ts:42`) — injected dependencies:
  `{ collectRuns(since, now), digestsDir }`. `collectRuns` is faked in unit tests and bound to
  `collectRunsFromVault` in the CLI; `digestsDir` is an absolute path (a temp dir in tests).
- `bober research digest [--since <iso>]` (`src/cli/commands/research.ts:400`) — writes the two
  artifact files under `.bober/research/digests/` and prints both paths. `--since` defaults to 24 h
  before `now`; the wall clock is stamped **only** at the `.action()` boundary. Never throws (errors ⇒
  stderr + `process.exitCode = 1`).
- `ResearchRunOverrides.digestCollectRuns?` (`src/cli/commands/research.ts:67`) — an optional injected
  collector so tests exercise the CLI action without real vault I/O.

## How to use / how it fits

Produce the morning digest over the default last-24-hour window:

```bash
bober research digest
# /path/to/project/.bober/research/digests/2026-06-30.md
# /path/to/project/.bober/research/digests/2026-06-30.json
```

Or aggregate from an explicit window start:

```bash
bober research digest --since 2026-06-29T00:00:00.000Z
```

The JSON artifact (`{ since, now, generatedAt, runs:[{ title, topFinding, generatedAt, source }] }`)
is the **stable contract the Telegram bot consumes** — it reads the JSON and pushes a silent scheduled
message; the markdown is for a human skim. This is the last layer of the pipeline: Sprint 4's `tick`
produces the research notes on a cadence, and `digest` aggregates the notes from a window into the
push-ready artifact. The clock is read once at the CLI boundary and threaded as `now` into both the
collector and the file-naming, so `buildDigest`/`renderDigestMarkdown` stay fully deterministic.

## Notes for maintainers

- **Data source is vault notes, not hub Findings — and this was a deliberate choice.** The real
  collector reads the **1:1 dated research notes** under `<vaultRoot>/research/` (Sprint 2's
  `runner.ts` writes a new file per run). Hub `Finding`s were **rejected** as the source because they
  are content-deduped by `sha256(domain|title|kind)` and carry no per-run history or note path — so a
  window of several runs over the same metric would silently collapse to one Finding and undercount the
  digest. Vault notes are the historyless-resistant, path-linked artifact. Swap the source only if a
  dedicated digest store is ever introduced (noted in the module header).
- **Non-sensitive content only — Telegram is not E2E-encrypted.** `topFinding` is derived from
  `frontmatter.question`/`title`, **never** from raw note body values. This is an intentional privacy
  constraint (research doc L141): the digest may travel over a non-E2E channel, so it must hold only
  titles + non-sensitive summaries, no raw PHI/financial detail.
- **Empty window never throws.** Both files are written unconditionally; an empty `collectRuns` result
  yields the explicit `_No new research was produced in this window._` body in the markdown and an empty
  `runs: []` in the JSON (sc-5-3).
- **`ensureDir` comes from `src/state/helpers.ts`, not `utils/fs.ts`** — deliberately, to keep the
  existing `research.test.ts` `utils/fs` `vi.mock` stable.
- **Clock discipline.** Neither `buildDigest` nor `renderDigestMarkdown` ever calls `new Date()` /
  `Date.now()`; the only wall-clock read is at the CLI `.action()` boundary (`now` and the default
  `--since`). The file date is sliced from the injected `now`.
- **Transport stays out of scope.** Long-polling, the user whitelist, inline buttons, and message
  sending belong to the Telegram sibling spec; scheduling the digest send belongs to the
  calendar/cadence layer. This sprint ships the content artifact only.

## Sprint criteria

| Criterion | Verified |
|---|---|
| sc-5-1 — `buildDigest` collects runs whose `generatedAt` ∈ `[since, now]` and returns each run's title + top finding | unit-test (2 fake runs ⇒ `runs.length 2`, both titles + findings in md) |
| sc-5-2 — `bober research digest --since <iso>` writes both `<date>.md` and `<date>.json`; md lists each run by title, JSON is machine-readable | unit-test (reads both files back from a temp `.bober/research/digests/`) |
| sc-5-3 — an empty window writes both files with an explicit no-new-research body rather than throwing or leaving an empty file | unit-test (empty `collectRuns` ⇒ no-new-research line + `runs []`) |
| sc-5-4 — project compiles with the digest module and the `digest` subcommand registered | build / typecheck / lint exit 0 |

Commit: `bebe2f5` — *bober(sprint-5): digest builder + CLI subcommand for research scheduler*
(3 files, +398; full suite **3583** green, +8; all 4 required criteria — sc-5-1..sc-5-4 — passed
iteration 1; typecheck/build/lint clean, zero regressions; only `src/research/digest.ts`,
`src/research/digest.test.ts`, and `src/cli/commands/research.ts` changed).
