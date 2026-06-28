# Canonical Finding schema, FactStore finding source, and `bober hub list`

**Contract:** sprint-spec-20260628-priority-hub-1  ·  **Spec:** spec-20260628-priority-hub  ·  **Completed:** 2026-06-28

## What this sprint added

Sprint 1 — the **foundational vertical slice** of the priority-hub plan — stands up a new
`src/hub/` module that **owns the one canonical `Finding` Zod schema** for the whole codebase, a
`FindingSource` interface with a `FactStoreFindingSource` implementation that turns
predicate-`finding` FactStore rows into validated `Finding`s, and a `bober hub list` CLI command
that prints the findings held in the project's own FactStore. This is schema → source → CLI: the
spine that later sprints (cross-repo collection, the lens judge, ranking, `priority.md`) build on.
Per the locked design, the hub **owns** the `Finding` definition and all other modules that produce
or consume Findings import it from here — there is intentionally **no second Finding Zod schema**
anywhere in the tree (the medical module emits the same field set as markdown frontmatter only, not
as a competing schema).

## Public surface

- `FindingSchema` (`src/hub/finding.ts:10`) — the canonical Zod object. Field set is **locked**:
  `id` (non-empty string), `domain` (non-empty string), `title` (non-empty string),
  `kind` (enum `action` | `watch` | `risk` | `question`), `urgency` (int 1–5), `severity` (int 1–5),
  `evidence` (`string[]`), `surfacedAt` (ISO datetime), `dueBy` (optional ISO datetime),
  `tags` (`string[]`), `estDurationMin` (optional int), `calendarSafeTitle` (optional string),
  `status` (enum `open` | `in-progress` | `snoozed` | `done` | `dropped`),
  `promotesTo` (optional string).
- `Finding` (`src/hub/finding.ts:27`) — `z.infer<typeof FindingSchema>`, the type siblings import.
- `FindingSource` (`src/hub/finding-source.ts:13`) — `interface { read(): Finding[] }`; the seam any
  future source (vault markdown, cross-repo collector) implements.
- `FactStoreFindingSource` (`src/hub/finding-source.ts:26`) — `implements FindingSource`. Constructor
  `(store: FactStore, scope: string = HUB_SCOPE)`. `read()` calls
  `store.getActiveFacts(scope, undefined, "finding")`, `JSON.parse`es each row's `value`, runs
  `FindingSchema.safeParse`, and collects only successes. **Never throws**: a row with malformed JSON
  or a schema-invalid shape is silently skipped (the valid rows still come back).
- `HUB_SCOPE` (`src/hub/finding-source.ts:8`) — the constant FactStore scope/namespace the hub stores
  its own findings under, currently `"hub"`.
- `runHubList(source: FindingSource): void` (`src/cli/commands/hub.ts:50`) — the **DI core** of the
  command. Reads from the injected source and writes one line per finding
  (`<title>  [<kind>]  urgency=<n>  severity=<n>`), or a gray `No findings found.` when empty. Tests
  drive this directly against an in-memory store without spawning the CLI.
- `registerHubCommand(program: Command): void` (`src/cli/commands/hub.ts:65`) — registers the `hub`
  command group and its `list` subcommand; called from `src/cli/index.ts`.
- `bober hub list` (CLI) — resolves the project root + default team memory namespace, opens the
  team's `facts.db`, and runs `runHubList(new FactStoreFindingSource(store, HUB_SCOPE))`. On error it
  prints a red message and sets `process.exitCode = 1` **without throwing**; the store is always
  closed in a `finally`.

## How to use / how it fits

```bash
bober hub list
# Lipid panel overdue  [question]  urgency=4  severity=2
# LDL trending toward range edge  [watch]  urgency=2  severity=3
# (or, when the hub scope has no findings:)
# No findings found.
```

Findings are stored as FactStore rows at predicate `finding` in the `hub` scope, with the `Finding`
serialized as the row's JSON `value` — mirroring the `SharedBlackboard.publish` convention
(`src/fleet/shared-blackboard.ts`). The read path is `getActiveFacts(scope, undefined, "finding")`
(`src/state/facts.ts:222`), so only active (non-invalidated) finding facts surface. The command reads
from the **project's own** FactStore at the active team's namespace memory path — the same `facts.db`
that `bober facts` and `bober vault reindex` resolve.

This sprint deliberately stops at the local single-store slice. Cross-repo aggregation, sibling
resolution, and dedup are **Sprint 2**; the lens judge, scope parsing, and ranking are **Sprint 3**;
`priority.md` rendering and `decide` are **Sprint 4**; the chat hub surface is **Sprint 5**.

## Notes for maintainers

- **The hub owns the Finding schema — do not redefine it.** `FindingSchema` is the single source of
  truth (the file carries an explicit "Do NOT redefine Finding anywhere else" doc comment). Producers
  in other domains (e.g. `src/medical/analysis/`) emit the same *field set* as markdown frontmatter
  but must not declare a competing Zod schema; downstream they should import `Finding`/`FindingSchema`
  from `src/hub/finding.ts`.
- **`runHubList` is the stable DI seam.** Later sprints that need to list/rank/render findings inject
  a different `FindingSource` (e.g. a multi-store collector) into the same `runHubList` core rather
  than re-implementing the CLI wiring. Keep the `FindingSource.read(): Finding[]` contract stable.
- **`FactStoreFindingSource.read()` never throws by contract.** Malformed or schema-invalid rows are
  skipped silently. If you later want surfaced parse diagnostics, add them without breaking the
  never-throw guarantee that the `list` command (and future callers) rely on.
- **Scope is a small constant for now.** `HUB_SCOPE = "hub"` is intentionally a single constant this
  sprint; scope parsing / multiple scopes are owned by a later sprint.
- **FactStore constructor untouched.** Per the contract non-goals, this sprint did not modify
  `FactStore`; it only reads through the existing `getActiveFacts` path.

## Scope

Commit `2bb3b95`: new module `src/hub/` (`finding.ts` schema + `finding-source.ts` interface &
`FactStoreFindingSource`) and `src/cli/commands/hub.ts`, registered via a 4-line additive edit to
`src/cli/index.ts` (`registerHubCommand`). 21 new collocated tests (12 schema, 6 source, 3 CLI); no
new dependencies. All five required criteria (`sc-1-1..sc-1-5`) passed **iteration 1** (zero
reworks); typecheck + build + lint exit 0 (2 pre-existing unrelated lint warnings), and the
facts / shared-blackboard / blackboard regression suite stayed green. Eval
`eval-sprint-spec-20260628-priority-hub-1-1` → **pass** (5/5 required).
