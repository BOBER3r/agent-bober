# priority.md renderer and `bober hub priority` / `bober hub decide`

**Contract:** sprint-spec-20260628-priority-hub-4  ·  **Spec:** spec-20260628-priority-hub  ·  **Completed:** 2026-06-29

## What this sprint added

Sprint 4 gives the hub its **output surface**. It adds a **pure** `renderPriorityMd`
that turns a ranked `Finding[]` into a Dataview-friendly `priority.md` note (YAML
frontmatter + a 7-column table + a per-finding rationale section), a tiny config helper
that resolves the **kb-hub output vault to an absolute path with a documented default**,
and the two end-to-end CLI commands — `bober hub priority` (general / filtered) and
`bober hub decide "X vs Y"` (decision) — that wire the full **collect → scope → judge →
render → write → stdout-summary** pipeline behind a dependency-injected core. The design
boundary continues Sprint 3's contract: **the renderer never re-ranks** — it consumes the
judge's array order verbatim (`rank = index + 1`). No new runtime dependency was added;
the YAML frontmatter is hand-rolled, mirroring `lab-note.ts`.

## Public surface

- `renderPriorityMd(ranked, scopeLabel, now): string` (`src/hub/priority-md.ts:34`) —
  **pure** (no IO, no re-sort, no `Date.now()`). Emits a hand-rolled flat-scalar YAML
  frontmatter block (`generatedAt` = `now.toISOString()`, `scope`, `count`), a markdown
  table `| rank | title | domain | kind | urgency | severity | dueBy |` with one row per
  finding (`rank = i + 1`, missing `dueBy` → empty cell), then a `### <rank>. <title>`
  rationale section listing each finding's `evidence[]` (or `- (no evidence recorded)`).
  Cell values are **pipe-escaped** and newline-collapsed via the module-private `cellValue`
  so the table stays valid for Dataview.
- `resolveOutVault(projectRoot): Promise<string>` (`src/hub/hub-config.ts:26`) — resolves
  the kb-hub output vault to an **ABSOLUTE** path. Reads `hub.outVault` from the **raw**
  config JSON (`bober.config.json` or `.bober/config.json`, bypassing Zod which strips
  unknown keys); if present it is `resolve`d against `projectRoot`, otherwise it **defaults
  to `<parentOfProjectRoot>/kb-hub`**. **Never throws.**
- `priorityMdPath(outVault): string` (`src/hub/hub-config.ts:45`) — the write target,
  `<outVault>/priority.md`.
- `runHubPriority(findings, scope, llm, outVault, now): Promise<void>`
  (`src/cli/commands/hub.ts:128`) — the **DI core** shared by both commands. With the
  `outVault` and `llm` injected it runs fully offline in tests. **Missing-vault gate:** if
  `outVault` does not exist it writes a clear red message to **stderr**, sets
  `process.exitCode = 1`, and returns — **never throws, never auto-creates another repo's
  vault root**. Otherwise it `rankFindings` → `renderPriorityMd` → writes
  `<outVault>/priority.md` → prints a `<rank>. <title>` summary to stdout.
- `bober hub priority [--domain <d>] [--due <days>] [--tag <t>]`
  (`src/cli/commands/hub.ts:206`) — with any of `--domain` / `--due` / `--tag` it builds a
  **filtered** scope, otherwise **general**. Builds the real `LLMClient` via `createClient`
  (the `chat.ts` provider pattern), collects across resolved siblings, resolves the out
  vault, and delegates to `runHubPriority`.
- `bober hub decide <expr>` (`src/cli/commands/hub.ts:250`) — splits `expr` on
  `/\s+vs\s+/i` into `optionA` / `optionB` (a malformed expression → clear stderr error +
  `exitCode = 1`, no throw), builds a **decision** scope, and runs the same pipeline so only
  X/Y-relevant findings are ranked and rendered.

## How to use / how it fits

```bash
# Rank everything pooled across the project's own store + sibling kb-* repos
bober hub priority
# 1. Lipid panel overdue
# 2. Portfolio rebalance due
# → writes <kb-hub>/priority.md (absolute), Dataview-ready

# Filtered scope (any of --domain / --due / --tag triggers filtered mode)
bober hub priority --domain medical --due 14

# Decision scope — only findings relevant to either option survive, ranked in that frame
bober hub decide "take the job offer vs stay"
```

By default `priority.md` lands at `<parentOfProjectRoot>/kb-hub/priority.md` — the kb-hub
sibling vault beside the project root. Override it with `hub.outVault` in
`bober.config.json` (resolved against the project root, may be relative or absolute). The
commands are the first consumers of Sprint 3's internal `rankFindings` judge: the CLI
builds the clock (`new Date()`) and the client at the boundary and passes both down; the
judge produces the order and the renderer only formats it.

## Notes for maintainers

- **The renderer never re-ranks.** `renderPriorityMd` iterates the input array as given and
  assigns `rank = index + 1`. All ordering lives in `compareFindings` / `rankFindings`
  (Sprint 3). If you need a different order, change the judge, not the renderer.
- **No new dependency; hand-rolled YAML.** The frontmatter is a flat-scalar subset built by
  string concatenation (mirroring `lab-note.ts`, which it deliberately does **not** import).
  If quoted strings or nested objects ever become necessary, swap in a vetted YAML library
  rather than extending the hand-rolled writer.
- **Missing-vault discipline.** `runHubPriority` checks `fileExists(outVault)` first and
  **fails closed** (stderr + `exitCode = 1`, no throw) rather than creating another repo's
  vault root. The `ensureDir(dirname(target))` call is a harmless no-op (its parent is the
  already-existing `outVault`), kept for symmetry with `writeLabNote` and defensive safety.
- **`hub.outVault` is read from raw config, not the Zod schema.** Like `hub.repos` (Sprint
  2), `schema.ts` is deliberately untouched — the hub is not yet a typed config field, so
  the key is read straight from the JSON file (Zod strip-mode would drop it).
- **Sibling source stores are never modified.** The collect step opens each sibling
  `facts.db` read-only (Sprint 2); only `<outVault>/priority.md` is written. The eval
  asserts sibling-store mtimes are unchanged.
- **The clock is injected end to end.** The renderer and `runHubPriority` take `now: Date`;
  the CLI actions supply `new Date()` at the boundary. Nothing below the command layer calls
  `Date.now()`.

## Scope

Commit `d82a27f`: 2 created files (`priority-md.ts`, `hub-config.ts`) + their collocated
tests, plus an additive edit to `src/cli/commands/hub.ts` (`runHubList` byte-stable). 5
files changed, **+665 / -13**. No new dependencies; no edits to the `Finding` schema, the
judge, the scope parser, or `schema.ts`. +18 new tests (`priority-md` 11, `hub` 7); the eval
records 25 regression tests (blackboard / medical / chat) green and typecheck / build / lint
clean (2 pre-existing unrelated lint warnings in `eval-persist.test.ts`). All five required
criteria (`sc-4-1..sc-4-5`) passed **iteration 1**. Eval
`eval-sprint-spec-20260628-priority-hub-4-1` → **pass** (5/5 required).

The do-bridge (`Finding.promotesTo`), calendar slot-fill, and the chat hub surface
(Sprint 5) remain explicit non-goals.
