# ToolRoleGuard (build-time, fail-fast)

**Contract:** sprint-spec-20260618-fleet-tier-provider-routing-3  ·  **Spec:** spec-20260618-fleet-tier-provider-routing  ·  **Completed:** 2026-06-18

## What this sprint added

Rejects, **at manifest-build time, before any child is spawned**, any fleet child
whose resolved `BoberConfig` would place the `claude-code` provider on a **tool
role** (`curator` / `generator` / `evaluator` / `codeReview`). `claude-code` can
drive a subscription chat but cannot drive tools, so a builder child must use an
api-key provider (`anthropic` / `openai-compat`). The same invariant already
existed at config-load time in `config/loader.ts` (a per-process throw when a tool
role lands on `claude-code` with no fallback); this sprint **front-loads** it into
`runFleet`'s fail-fast phase so the whole fleet refuses up front instead of one
child crashing mid-spawn. The check is exposed as a pure, never-throwing `check()`
plus a throwing `assertManifest()`, wired in **before** both
`validateManifestCredentials` and `coordinator.execute`. The never-throw
`validateManifest` is unchanged, and a clean manifest passes with no throw and no
side effects (the no-flag fleet path stays byte-identical). This is **Sprint 3 of
3** and **completes Phase A** of
`arch-20260618-heterogeneous-multi-provider-agent-team` (Grok wiring + tier routing
+ tool-role guard).

## Public surface

- `isToolRole(role: RoleName): boolean` (`src/config/role-providers.ts:44`) — newly
  **exported**; returns `true` for the four tool roles
  (`curator`/`generator`/`evaluator`/`codeReview`) and `false` for the prompt roles
  (`planner`/`researcher`/`chat`). Derived from the authoritative `TOOL_ROLES`
  constant via `TOOL_ROLES.includes(role)` — **not** a re-declared literal.
- `effectiveProvider(role, config): string` (`src/config/role-providers.ts:57`) —
  previously module-private, now **exported** so the guard can resolve the raw
  effective provider per role.
- `type ToolRoleViolation` (`src/fleet/tool-role-guard.ts:16`) —
  `{ childFolder: string; role: RoleName; provider: "claude-code" }`.
- `check(child, resolved): ToolRoleViolation | null` (`src/fleet/tool-role-guard.ts:40`) —
  **pure, never throws.** Iterates all role names, gates on `isToolRole`, and returns
  the first violation where `effectiveProvider(role, resolved) === "claude-code"`, else
  `null`. Safe to call in any context.
- `assertManifest(manifest: FleetManifest): void` (`src/fleet/tool-role-guard.ts:60`) —
  builds each child's resolved config via `buildChildConfig` (tier-aware after
  Sprint 2), runs `check`, and **throws** a named `Error` on the first violation. The
  message identifies the offending `child.folder` and `role`, e.g.
  `Fleet child "<folder>" places claude-code on tool role "<role>" — claude-code cannot
  drive tools. Use an api-key provider (anthropic/openai-compat) for builder roles.`

## How to use / how it fits

`runFleet` calls `assertManifest(effectiveManifest)` in its fail-fast region,
immediately **before** `validateManifestCredentials` and well before
`coordinator.execute` (`src/fleet/index.ts:110`):

```ts
// 3. Build-time + credential fail-fast BEFORE any spawn
assertManifest(effectiveManifest);                // throws if claude-code on a tool role
validateManifestCredentials(effectiveManifest);
```

A clean (including tiered) manifest passes silently. A manifest with, e.g.,
`child.config.generator = { provider: "claude-code" }` throws naming that child and
`"generator"` — and because the throw happens before `coordinator.execute`, **no
child is ever spawned** (a test drives `runFleet` with an injected fake coordinator
and asserts `coordinator.execute` was never called on the throw path).

The tier table from Sprint 2 never emits a `claude-code` block, so in practice the
guard's real job is catching a **hand-authored `child.config`** that does. It checks
the **raw** effective provider before the loader's fallback redirect, so the
violation surfaces as an explicit, named fleet-level rejection rather than a deep
config-load error.

## Notes for maintainers

- **Single source of truth for the tool-role list.** `isToolRole` and `check` both
  derive from `TOOL_ROLES`; there is no second hard-coded tool-role literal (a test
  asserts `isToolRole`'s true-set equals `TOOL_ROLES` membership across all seven role
  names). Add a new tool role to `TOOL_ROLES` and the guard picks it up automatically.
- **Ordering is the guarantee.** `assertManifest` must stay in the pre-spawn region,
  before `coordinator.execute`. Do not move it after execute — that would let a bad
  child spawn before the check fires.
- **`validateManifest` is untouched.** The never-throw `validateManifest` is a
  separate function and was deliberately left byte-identical; the guard is an
  additional throwing call, not a change to it.
- **Front-loaded, not duplicated logic.** This is the same invariant as
  `config/loader.ts` (the tool-role-on-`claude-code` runtime throw); the guard surfaces
  it earlier and with a fleet-child-named message. If the loader rule changes, revisit
  the guard so the two stay consistent.
- **Scope.** Touched `src/config/role-providers.ts` (two new exports),
  `src/fleet/tool-role-guard.ts` (new), `src/fleet/index.ts` (one import + the wired
  call), and their collocated tests only. No new SDK/network imports. +39 tests; full
  suite **2734 passed** — only the 6 pre-existing cockpit-integration MCP failures
  remain (unrelated). All 8 criteria passed iteration 1.
