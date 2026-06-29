# Promoter registry, FindingStore port, and `bober do --dry-run`

**Contract:** sprint-spec-20260628-do-bridge-1  ·  **Spec:** spec-20260628-do-bridge  ·  **Completed:** 2026-06-29

## What this sprint added

Sprint 1 lays the **spine of the do-bridge** — the layer that turns a hub `Finding` into a launchable
unit of work — in a new `src/do-bridge/` module, plus a **read-only** `bober do <findingId> --dry-run`
CLI command that previews what would be launched. It defines the concrete `PromotionPlan` /
`PromotionRef` types that give `Finding.promotesTo` its meaning, a `PromoterRegistry` that resolves a
promoter by finding `domain` (and optional `kind`), a narrow `FindingStore` read port (with a
FactStore-backed adapter and an in-memory test fake), and the first `codingPromoter` that maps a
`coding`/`projects` Finding to a `{ kind: "bober-run", task, teamId? }` plan. **Nothing in this sprint
launches work, writes an approval marker, or spawns a process** — the dry-run path reads and prints
only. Real launch (Sprint 2) and outcome recording / consolidated docs (Sprint 3) are explicit
non-goals here.

## Public surface

- `PromoterKey` (`src/do-bridge/types.ts:15`) — registry lookup key `{ domain: string; kind?: FindingKind }`;
  `kind` is optional so a domain-only registration is a fallback for any kind in that domain.
- `PromotionPlan` (`src/do-bridge/types.ts:27`) — `{ kind: "bober-run"; task: string; teamId? }`; the
  discriminated, pure data plan a promoter returns. `kind` is a discriminant so Sprint 2 may add plan kinds.
- `PromotionRef` (`src/do-bridge/types.ts:42`) — a `string` alias for a planned/recorded promotion id;
  the value later written to `Finding.promotesTo` after a real launch (kept a plain string this sprint).
- `Promoter` (`src/do-bridge/types.ts:50`) — `(finding: Finding) => PromotionPlan`; pure, no I/O.
  `FindingKind` (`src/do-bridge/types.ts:6`) is derived from `Finding["kind"]`, never redefined.
- `PromoterRegistry` (`src/do-bridge/registry.ts:31`) — `register(key, promoter)` and
  `resolve(key): Promoter | undefined`. Resolution precedence is **domain+kind > domain-only >
  undefined**; `resolve` never throws (modelled on `src/orchestrator/checkpoints/registry.ts`).
- `FindingStore` (`src/do-bridge/finding-port.ts:12`) — the narrow read port `{ readFinding(id): Promise<Finding | null> }`.
  No write path this sprint (the DI core never mutates findings).
- `FactStoreFindingStore` (`src/do-bridge/finding-port.ts:25`) — adapter that delegates to the hub's
  canonical `readFindings()` and filters by id in-process (the hub exposes no by-id read).
- `InMemoryFindingStore` (`src/do-bridge/finding-port.ts:42`) — test fake over a `Map`; exposes a
  `writes: Finding[]` array (always empty this sprint) so tests can assert zero mutation.
- `codingPromoter` (`src/do-bridge/coding-promoter.ts:25`) and `isCodingDomain` (`src/do-bridge/coding-promoter.ts:50`)
  — the concrete promoter for the `CODING_DOMAINS = {coding, projects}` set. Pure: derives the one-line
  `task` from `finding.title` (+ up to 2 `finding.evidence` lines appended as context) and reads an
  optional `teamId` from a `team:<id>` tag (otherwise the default team).
- `runDo(store, registry, findingId, { dryRun })` (`src/cli/commands/do.ts:62`) — the DI core for the
  command; never throws (every failure branch sets `process.exitCode = 1` and returns).
- `bober do <findingId> --dry-run` (`registerDoCommand`, `src/cli/commands/do.ts:114`) — the CLI command,
  registered in `src/cli/index.ts:343` next to `registerHubCommand`.

## How to use / how it fits

`bober do` reads a Finding from the hub pool (the active team's namespace `facts.db` — the same store
`bober hub list` / `bober task list` read), resolves a promoter by the finding's `domain`/`kind`, and
prints the `bober run` task that promoter would launch:

```text
$ bober do 1f3c9a0b2e4d6f80 --dry-run
[dry-run] would launch: bober run "Fix flaky auth test — token refresh races on expiry" (team: default team)
```

The dry-run line always contains the resolved `task` string and the word `dry-run`, names the target
team, and **changes nothing on disk**. Failure paths are also non-throwing:

- Unknown id → stderr `do: no finding with id '<id>'` + exit 1.
- A finding whose `domain` has **no registered promoter** → stderr naming the unsupported domain
  (`do: unsupported domain '<domain>' …`) + exit 1.
- Without `--dry-run` (Sprint 2 territory) the command prints a "Real launch is not implemented yet"
  notice and spawns nothing.

The CLI boundary builds the registry and registers `codingPromoter` under both `{domain:"coding"}` and
`{domain:"projects"}`; the registry is the seam where future domain promoters (medical/financial) plug
in without touching the core.

## Notes for maintainers

- **Read-only by construction this sprint.** `runDo`'s dry-run path reads + prints only. `src/cli/commands/do.ts`
  carries a hard-boundary header forbidding any import of `execa`, `node:child_process`, or a RunSpawner —
  the evaluator verified the dry-run path reaches none of them, performs zero finding writes (the fake's
  `writes` array stays empty), and writes nothing under `.bober/approvals/`. Keep the real-launch wiring in
  Sprint 2; do not add a spawn here.
- **Resolution precedence is load-bearing.** `PromoterRegistry.resolve` serializes keys so domain+kind and
  domain-only never collide (`"coding action"` vs `"coding "`), tries the specific key first, then the
  domain-only key, then returns `undefined`. The CLI converts `undefined` into the unsupported-domain
  exit-1 branch — do not make `resolve` throw.
- **Consume Findings only through the port.** The module reads the Finding shape via `FindingStore` and the
  hub's `readFindings()`; it does **not** modify the task-inbox or priority-hub modules. If task-inbox later
  exposes a by-id read API, the adapter should delegate to it rather than filtering in-process.
- **Promoter purity.** Promoters are pure `(finding) => plan` functions (no clock, no I/O). The `task`
  derivation is intentionally simple (title + ≤2 evidence lines); enrich it without introducing side effects.
- **Single coding promoter only.** Per the non-goals, no medical/financial promoter is registered this
  sprint. `PromotionRef` is a bare string and `FindingStore` has no write method — both are deliberately
  minimal seams that Sprint 3 (outcome recording, `Finding.promotesTo` write-back) may extend.

## Scope

Commit `8370612`: 10 files changed, **+829 / -0**. New module `src/do-bridge/` (`types.ts`,
`registry.ts`, `finding-port.ts`, `coding-promoter.ts` + collocated tests) and `src/cli/commands/do.ts`,
wired via a 4-line additive edit to `src/cli/index.ts`. **32 new tests**; build + typecheck + lint clean,
**134 regression tests** green, no new dependency. All five required criteria (`sc-1-1..sc-1-5`) passed on
iteration 1; eval `eval-sprint-spec-20260628-do-bridge-1-1` → **pass** (5/5 required).

> **User-facing docs** for `bober do <findingId> --dry-run` (dry-run only at this stage) live in
> [`COMMANDS.md`](../../COMMANDS.md) under **Do-Bridge Commands**. The consolidated do-bridge feature
> guide (`docs/do-bridge.md`) is owned by Sprint 3 and is intentionally not created yet.
