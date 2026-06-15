# Per-team memory namespacing of the lessons store

**Contract:** sprint-spec-20260615-team-abstraction-2  ·  **Spec:** spec-20260615-team-abstraction  ·  **Completed:** 2026-06-15

## What this sprint added

An optional, per-team **namespace** threaded through the lessons memory store
(`src/state/memory.ts`) and the retriever (`src/orchestrator/memory/retrieve.ts`), so two
teams' lessons live in fully isolated directories. The namespace→path rule is centralized
in one place: `memoryDir(projectRoot, namespace?)` maps `undefined`, `""`, or
`"programming"` to the existing `.bober/memory/` path (no subdir, no migration), and any
other value to `.bober/memory/<namespace>/`. The four persistence functions
(`appendLesson`, `loadLessonIndex`, `loadLesson`, `retrieveRelevantLessons`) accept the
namespace as an optional trailing argument; callers — the `bober memory` CLI and the chat
session's `buildMemoryDistill` — derive it from the active team via `loadTeam`, defaulting
to the current path. Pre-existing lessons in `.bober/memory/` stay visible and untouched;
the pure distiller (`distill.ts`) was deliberately **not** changed.

## Public surface

- `memoryDir(projectRoot, namespace?): string` (`src/state/memory.ts:23`) — now **exported**; centralizes the namespace→subdir rule. `undefined | "" | "programming"` → `.bober/memory/`; any other value → `.bober/memory/<namespace>/`.
- `lessonPath(projectRoot, lessonId, namespace?): string` (`src/state/memory.ts:36`) — now **exported**; delegates to `memoryDir`. Returns `<memoryDir>/<lessonId>.md`.
- `indexPath(projectRoot, namespace?): string` (`src/state/memory.ts:40`) — now **exported**; delegates to `memoryDir`. Returns `<memoryDir>/INDEX.md` (the index is **per-namespace**).
- `appendLesson(projectRoot, lesson, namespace?)` (`src/state/memory.ts:212`) — writes the lesson `.md` and upserts its `INDEX.md` line under the namespaced dir.
- `loadLessonIndex(projectRoot, { limit }, namespace?)` (`src/state/memory.ts:259`) — reads `INDEX.md` from the namespaced dir; missing index returns `[]`.
- `loadLesson(projectRoot, lessonId, namespace?)` (`src/state/memory.ts:290`) — reads one lesson `.md` from the namespaced dir; the not-found error message includes the namespaced path.
- `retrieveRelevantLessons(projectRoot, keywords, { topK?, charBudget?, namespace? })` (`src/orchestrator/memory/retrieve.ts:79`) — adds `namespace` to the options bag and forwards it to `loadLessonIndex`, so retrieval is scoped to one namespace.
- `ChatSessionOptions.memoryNamespace?: string` (`src/chat/chat-session.ts:33`) — new optional field; `ChatSession` stores it (`opts.memoryNamespace || undefined`) and threads it into `buildMemoryDistill`.

## How to use / how it fits

The namespace is an **optional trailing argument** everywhere, so any not-yet-updated
caller keeps the current behavior (the default `.bober/memory/` path) with no change. A
team's namespace is resolved from config, not passed by hand:

```ts
// CLI / programmatic: derive the namespace from the active team, never fatal.
const config = await loadConfig(projectRoot);
const ns = loadTeam(config, undefined).memoryNamespace || undefined; // programming → undefined

await appendLesson(projectRoot, lesson, ns);            // .bober/memory/<lessonId>.md
const index = await loadLessonIndex(projectRoot, { limit: 50 }, ns);

// A named team writes/reads its own isolated subdir.
await appendLesson(projectRoot, lesson, "teamA");       // .bober/memory/teamA/<lessonId>.md
```

In `src/cli/commands/memory.ts`, a non-fatal `resolveDefaultNamespace(projectRoot)` helper
(`loadConfig` + `loadTeam(config, undefined).memoryNamespace || undefined`) feeds all four
call sites (`distill`'s before/after index reads, the `appendLesson` upsert, `list`, and
`show`); it swallows config-absence and returns `undefined`. The `show` command's
previously hardcoded `.bober/memory/<id>.md` path now goes through
`memoryDir(projectRoot, ns)` so it prints the correct namespaced file. In
`src/chat/chat-session.ts`, the session carries `memoryNamespace` and passes it to
`buildMemoryDistill`, which forwards it to both `loadLessonIndex` and `loadLesson`.

## Notes for maintainers

- **`distill.ts` is intentionally unchanged** — it is a pure function with no filesystem
  access; the real `appendLesson` calls live in `src/cli/commands/memory.ts`. The diff
  against `main` for `distill.ts` is zero (confirmed by the evaluator).
- **The `INDEX.md` is per-namespace** (`.bober/memory/<ns>/INDEX.md`), so each team has its
  own bounded index — there is no shared/global index across teams.
- **No migration, no `programming/` subdir.** The `programming` / `""` sentinel from
  Sprint 1 maps to the existing `.bober/memory/` path; pre-existing lessons stay where they
  are and remain visible to no-namespace callers.
- **Path-traversal safety is upstream.** Namespace values are constrained to
  `^[a-z0-9_-]+$` by the Sprint 1 `TeamConfigSchema` regex, so `memoryDir` does no
  sanitization of its own — it trusts that config-sourced namespaces are already safe.
- **CLI `--team` / `--namespace` flags do not exist yet.** Memory commands resolve the
  namespace from the **default** team only; selecting a non-default team on the command
  line, an example team, and the user-facing "adding a team is data, not code" docs are
  deferred to Sprint 4. Do not document a `--team` memory flag until it ships.
- **Pipeline-shape selection is still not wired** (Sprint 3); this sprint touches only the
  memory store, the retriever, and their callers.
