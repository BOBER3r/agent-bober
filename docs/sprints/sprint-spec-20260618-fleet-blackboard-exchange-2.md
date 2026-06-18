# config.fleet section + manifest.blackboard + path injection + `agent-bober blackboard` CLI

**Contract:** sprint-spec-20260618-fleet-blackboard-exchange-2  ·  **Spec:** spec-20260618-fleet-blackboard-exchange  ·  **Completed:** 2026-06-18

## What this sprint added

The **additive config/manifest surface and the explicit child seam** for Phase B inter-agent
blackboard exchange — the layer that lets the Sprint 1 `SharedBlackboard` module actually be
reached by isolated fleet children. It declares an **optional `fleet` section on
`BoberConfigSchema`** (the child-visible channel — required as a declared section because
`BoberConfigSchema` strips unknown keys, so an ad-hoc field would be dropped before a child
ever sees it), an **optional `blackboard` block on `FleetManifestSchema`**, the head-side
`resolveBlackboardPath(manifest)` that computes **one ABSOLUTE** `.bober/memory/<ns>/facts.db`
path, scaffolder injection of that path into each child's `bober.config.json`, and a new
`agent-bober blackboard publish|read` CLI that reads the absolute path from `config.fleet`
**only** (never re-deriving from cwd). This is the explicit participation seam: there is **no**
auto-wiring into `agent-bober run` and **no** coordinator rounds loop yet (Sprints 3-4). The
no-blackboard fleet path is **byte-identical** to before — the scaffolder writes no `fleet`
key when no blackboard is configured.

## Public surface

- `FleetSectionSchema` (`src/config/schema.ts:405`) — Zod object
  `{ blackboardDbPath: string; blackboardNamespace: string; blackboardSubject: string; maxRounds: int 1–3 }`.
  Declared on `BoberConfigSchema` so it survives the unknown-key strip and reaches children.
- `type FleetSection` (`src/config/schema.ts:415`) — `z.infer` of the above.
- `fleet: FleetSectionSchema.optional()` on `BoberConfigSchema` (`src/config/schema.ts:449`) —
  the optional, child-visible blackboard channel. Absent ⇒ a config parses identically to today.
- `manifest.blackboard` block on `FleetManifestSchema` (`src/fleet/manifest.ts:19`) — optional
  `{ namespace: string (min 1); maxRounds: int 1–3, default 3 }`. `maxRounds > 3` is a `ZodError`;
  an empty namespace is a `ZodError`; a no-blackboard manifest parses identically to today.
- `resolveBlackboardPath(manifest): string | undefined` (`src/fleet/index.ts:41`) — returns the
  **ABSOLUTE** `join(resolve(manifest.rootDir), '.bober', 'memory', <namespace>, 'facts.db')`
  when `manifest.blackboard` is set (absolute even when `rootDir === '.'`, via `resolve()`), else
  `undefined`. This is the realization of ADR-5's caller-side absolute-path responsibility.
- `ChildScaffolder.scaffold(rootDir, child, blackboard?)` (`src/fleet/scaffolder.ts:20`) — gained an
  optional 3rd param `{ dbPath, namespace, maxRounds }`. When present, after `buildChildConfig(child)`
  it sets `config.fleet = { blackboardDbPath: dbPath, blackboardNamespace: namespace,
  blackboardSubject: child.folder, maxRounds }` before `JSON.stringify` + `writeFile`
  (`src/fleet/scaffolder.ts:63`). When absent, output is byte-identical to before (no `fleet` key).
- `agent-bober blackboard publish <value> [--round N]` / `agent-bober blackboard read [--all]` —
  new CLI command (`registerBlackboardCommand`, `src/cli/commands/blackboard.ts:131`; wired in
  `src/cli/index.ts`). See COMMANDS.md "Fleet Commands".
- `runBlackboardPublish(projectRoot, value, opts, nowIso?)` (`src/cli/commands/blackboard.ts:37`)
  and `runBlackboardRead(projectRoot, opts)` (`src/cli/commands/blackboard.ts:90`) — exported,
  DI'd cores for the CLI (testable without spawning a process; `nowIso` is injected for publish).

## How to use / how it fits

`resolveBlackboardPath` runs **head-side** (in the fleet orchestrator) to compute the one shared
`facts.db` path, which the scaffolder writes verbatim into every child's `bober.config.json`.
Each child — running as an isolated process in its own cwd — then participates explicitly via the
CLI, which reads that absolute path back out of `config.fleet` and opens the Sprint 1
`SharedBlackboard`:

```bash
# In a child cwd whose bober.config.json carries a fleet section:
agent-bober blackboard publish "found the auth bug is in token refresh" --round 1
agent-bober blackboard read            # siblings' findings (excludes this child)
agent-bober blackboard read --all      # every child's findings
```

Findings print as `[<subject>] <value>` lines. Because the db path comes from `config.fleet`
(not the cwd), two children in different directories pointing at the **same** absolute
`blackboardDbPath` see each other's findings — the two-cwd shared-visibility test proves this.
With **no** fleet section, both subcommands print a clear `No fleet section in
bober.config.json …` message and set `process.exitCode = 1` (they **never** throw); the
`SharedBlackboard` is always `close()`d in a `finally`.

A manifest opts a fleet run into the blackboard with:

```jsonc
{
  "rootDir": ".",
  "concurrency": 3,
  "blackboard": { "namespace": "fleet-run-123", "maxRounds": 3 },
  "children": [ /* … */ ]
}
```

## Notes for maintainers

- **ADR-5 fulfilled head-side.** Sprint 1's documenter carried forward that the
  caller-side absolute-path responsibility was still pending. Sprint 2 discharges it:
  `resolveBlackboardPath` applies `resolve(rootDir)` so downstream modules (the scaffolder, the
  CLI, and `SharedBlackboard.open`, which rejects non-absolute paths) all receive an absolute path
  directly. See `.bober/architecture/arch-20260618-heterogeneous-multi-provider-agent-team-adr-5.md`.
- **`config.fleet` is not a user-authored config field.** It is a head-injected, child-internal
  seam written by the scaffolder — so it is **not** added to the README "Full Configuration
  Reference" (which documents user-authored config). The user-authored knob is
  `manifest.blackboard`, documented in COMMANDS.md.
- **No-blackboard is byte-identical.** `config.fleet` is set only inside the `if (blackboard)`
  guard in the scaffolder; the no-blackboard test compares the written config to
  `JSON.stringify(buildChildConfig(child), null, 2)`.
- **Round default vs. cap.** `manifest.blackboard.maxRounds` defaults to `3` and is capped at `3`
  by the schema; the CLI's `publish --round` defaults to `1`. The hard ceiling still lives in
  Sprint 1's `BLACKBOARD_MAX_ROUNDS` / `SharedBlackboard.publish` throw.
- **Still no coordinator / synthesis.** This sprint provides config + the CLI seam only. The
  coordinator rounds loop is Sprint 3 and `fleet-synthesis.json` is Sprint 4 — both explicit
  non-goals here. `agent-bober run` is **not** auto-wired into the blackboard; participation is via
  the explicit `agent-bober blackboard` CLI only.
- **Scope.** Commit `2784f71`: `src/config/schema.ts`, `src/fleet/manifest.ts`, `src/fleet/index.ts`,
  `src/fleet/scaffolder.ts`, `src/cli/commands/blackboard.ts` (new), `src/cli/index.ts`, plus the
  collocated tests. Full suite **2775 passed** (only the 6 pre-existing cockpit-integration MCP
  failures remain). All 8 criteria passed iteration 1; no SDK/network import in `blackboard.ts`.
