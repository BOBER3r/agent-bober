# Single-shot multi-model research run → vault note + hub Finding

**Contract:** sprint-spec-20260628-research-scheduler-2  ·  **Spec:** spec-20260628-research-scheduler  ·  **Completed:** 2026-06-29

## What this sprint added

Sprint 2 — the **execution layer** of the **research-scheduler** plan (2 of 5) — turns a stored
`ResearchJob` (Sprint 1's definition) into an actual run. It adds a deterministic, **offline,
clock-injected** runner that queries **at least two distinct provider/model blocks** resolved from
fleet tier-policy, synthesizes their answers into a markdown research note written to the target
vault, and emits **exactly one** Finding to the priority hub via an injected sink. The new
`bober research run <jobId>` CLI subcommand wires the real provider client and the real hub
`ingestFinding` writer to that runner. **No web/online retrieval happens** — the runner uses only
its injected provider clients (online egress is Sprint 3); there is no cadence/scheduling (Sprint 4)
or digest (Sprint 5) yet.

## Public surface

- **`bober research run <jobId>`** (`src/cli/commands/research.ts:193`) — load the stored job, query
  ≥2 model blocks, write a vault note, emit one hub Finding, and **print the note path** to stdout.
  Stamps `now = new Date().toISOString()` once at the `.action()` boundary, defaults `vaultRoot` to
  the project root, binds `queryModel` to `createClient(...).chat(...)` (the only SDK-import site) and
  `findingSink` to `ingestFinding(store, finding, { now })` over a `.bober/` FactStore that is always
  `close()`d in a `finally`. A missing job prints a red message and sets `process.exitCode = 1`; the
  handler **never throws**.
- `runResearchJob(job, deps)` (`src/research/runner.ts:142`) — the engine. `deps: RunDeps`
  = `{ queryModel, findingSink, now, vaultRoot }`. Resolves ≥2 blocks (throws if fewer), queries each,
  writes the note via `note-writer`, builds **one** Finding, awaits `findingSink(finding)` exactly
  once, and returns `RunResult { notePath, models, finding }`. This module never reads the clock and
  imports **no** provider SDK.
- `RunDeps` / `RunResult` / `QueryModel` / `FindingSink` (`src/research/runner.ts:39`–`64`) — the
  injection contract. `QueryModel = (block, prompt) => Promise<string>`;
  `FindingSink = (finding: Finding) => Promise<void>`.
- `registerAnalyzer(domain, analyzer)` + `DomainAnalyzer` type (`src/research/runner.ts:90`/`:77`) —
  a pluggable domain-analyzer **registry hook** (a `Map<string, DomainAnalyzer>`). If a domain has a
  registered analyzer it produces the Finding; otherwise the generic `buildFinding` default is used.
  No `src/medical/` analyzer is registered here (that is a later sprint).
- `diverseBlocks(tier?)` (`src/research/model-diversity.ts:36`) — returns the distinct
  `RoleProviderBlock[]` for a multi-model run by enumerating **different** tiers
  (`cheap → standard → hard → frontier`) via `tierPolicy.resolveTier(t)?.generator` and deduping by
  `provider/model` label. The optional `tier` arg seeds the scan order by moving that tier to the
  front. In the current tier table this yields 4 distinct labels
  (`openai-compat/deepseek`, `openai-compat/grok`, `anthropic/sonnet`, `anthropic/opus`); the runner
  takes ≥2. PURE — no fs/network/clock; reads only the static tier table.
- `modelLabel(block)` (`src/research/model-diversity.ts:20`) — the canonical `"<provider>/<model>"`
  label used in note bodies and Finding evidence.
- `serializeResearchNote(job, labels, contributions, now)` (`src/research/note-writer.ts:51`) — PURE
  markdown serializer. Frontmatter `{ title, jobId, question, models[], generatedAt, domain, type,
  status }` via `serializeFrontmatter`; body = one `### <label>` section per model contribution.
  `models` is a **string[] of labels** (never `RoleProviderBlock[]`, which would render as
  `[object Object]`).
- `researchNotePath(vaultRoot, marker, now)` (`src/research/note-writer.ts:23`) — derives
  `<vaultRoot>/research/<YYYY-MM-DD>-<marker>.md`; the date is sliced from the injected `now`, never
  the wall clock.
- `ModelContribution` (`src/research/note-writer.ts:31`) — one labelled model answer
  `{ label, text }` collected by the runner.
- `ResearchRunOverrides` (`src/cli/commands/research.ts:60`) — optional `{ queryModel?, findingSink? }`
  passed to `registerResearchCommand(program, overrides?)` so tests inject a fake provider and a
  recording sink without mocking extra modules.

## How to use / how it fits

```bash
$ bober research run 3f8a1c0b9d2e4f76
/path/to/vault/research/2026-06-29-3f8a1c0b9d2e.md
```

The command resolves ≥2 distinct provider/model blocks from `src/fleet/tier-policy.ts`, asks each the
job's `question`, writes a markdown note (frontmatter records `jobId`, `question`, the `models`
queried, and `generatedAt`) under `<vaultRoot>/research/`, and emits one `kind: "watch"` Finding to
the priority hub. The Finding carries `domain` (the job's `domain`, default `"research"`), a
`Research: <question>` title, `evidence` = per-model contribution snippets, `surfacedAt` = the
injected `now`, and a content-stable `id = sha256(domain|title|kind).slice(0,16)` — validated against
the **canonical** `FindingSchema` from `src/hub/finding.ts` (the runner imports the `Finding` type;
it does not redefine it).

This sits between Sprint 1's job-definition surface and the later scheduler sprints: Sprint 1 defines
and stores jobs; Sprint 2 executes **one** job on demand. Sprint 3 will add the online-research egress
axis, Sprint 4 the cadence/tick runner that drives `runResearchJob` on a schedule, and Sprint 5 the
digest.

## Notes for maintainers

- **Model diversity crosses tiers, not roles.** Within a single tier `planner/generator/evaluator`
  all point at the same block, so `diverseBlocks` deduplicates **across** tiers (using each tier's
  `generator` block). If tier-policy ever collapses to a single block, it falls back to whatever is
  available; the runner guards with a `< 2` throw. A configurable model list is a future upgrade path.
- **Clock discipline holds.** Neither `runner.ts` nor `note-writer.ts` core calls `new Date()` /
  `Date.now()`; `now` is stamped once at the CLI `.action()` boundary and threaded through
  (`generatedAt`, `surfacedAt`, and the note-path date all derive from it).
- **Exactly-one Finding.** `findingSink` is awaited once per run; the CLI binds it to the real hub
  `ingestFinding(store, finding, { now })` (`src/hub/finding-store.ts:140`) and opens a `FactStore`
  only on the real path, closing it in a `finally`. Tests inject a recording sink and assert a single
  call with `FindingSchema.parse` not throwing.
- **No web egress yet.** Sprint 2's runner only calls its injected `queryModel`; there is no online
  retrieval and no egress axis (that is Sprint 3, a contract non-goal here). The runner also does
  **not** use `FleetCoordinator` — diversity is a lightweight loop over tier-policy blocks.
- **Domain-analyzer hook is inert by default.** The registry exists for later domain-specific Finding
  shaping (e.g. medical), but Sprint 2 registers nothing and never imports `src/medical/`.
- **fs boundary.** All filesystem writes live in `runner.ts`/`note-writer.ts`; `research.ts` only reads
  the job (JSON) and opens the FactStore, keeping its `utils/fs.js` import surface minimal so the
  module's test `vi.mock` stays stable.
- **Deferred to later sprints:** online-research egress (Sprint 3), cadence due-date + the tick runner
  (Sprint 4), digest aggregation (Sprint 5), and the hub's ranking of the emitted Finding (owned by
  `spec-20260628-priority-hub`).

Commit: `20d42cb` — *bober(sprint-2): multi-model research runner → vault note + hub Finding*
(7 files, +807/−3; full suite **3540** green, +21; all 4 required criteria — sc-2-1..sc-2-4 — passed
iteration 1; typecheck/build/lint clean).
