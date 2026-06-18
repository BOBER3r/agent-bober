# fleet expand-deep --critique CLI flag (additive, byte-lock preserved)

**Contract:** sprint-spec-20260618-fleet-expand-deep-critique-2  ·  **Spec:** spec-20260618-fleet-expand-deep-critique  ·  **Completed:** 2026-06-18

## What this sprint added

The **user-facing surface** for Phase 4 of the fleet orchestrator: a `--critique`
boolean flag on the existing `agent-bober fleet expand-deep <goal>` subcommand. With
`--critique`, the decomposition routes through Sprint 1's fresh-context critic
critique/refine loop (`runCritiqueLoop`) — one bounded round, accept-best on exhaustion,
total budget `DEEP_CRITIQUE_MAX_TOTAL_CALLS = 8` — so a shape-valid-but-degenerate manifest
is re-expanded before it reaches the human write-and-stop review. Without the flag the path
is **byte-identical to Phase 3**: the decompose argument object carries no `critique` key and
zero extra chat calls are emitted. This is the finale; the Phase-4 plan is now complete (2 of 2).

## Public surface

All three edits are additive in `src/fleet/index.ts` (11 lines, the single deleted line being
the intended rewrite of the one-line `decomposeDeepFn(...)` call into the multi-line
guarded-spread form).

- `--critique` flag on `agent-bober fleet expand-deep <goal>` (`src/fleet/index.ts:416`) —
  `.option("--critique", "Run a fresh-context critic gate that re-expands degenerate manifests")`,
  added beside the existing seven options (`--count`, `--provider`, `--model`, `--root`,
  `--concurrency`, `--out`, `--yes`). No sibling subcommand; the byte-locked command tree
  (`fleet <manifest>` positional + `--concurrency`/`--root`, the `fleet expand` subcommand, and
  the existing expand-deep options) is intact.
- `FleetExpandDeepOptions.critique?: boolean` (`src/fleet/index.ts:277`) — the opt-in option
  field; `undefined`/`false` means the unchanged Phase-3 path.
- The guarded spread in `runFleetExpandDeep` (`src/fleet/index.ts:331`) —
  `...(opts.critique ? { critique: true } : {})` on the `decomposeDeepFn({ goal, client, model })`
  call. The spread makes the decompose argument object **byte-identical** (no `critique` key)
  when the flag is absent, and threads `critique: true` into `decomposeGoalDeep` when present.
  `decomposeGoalDeep` (Sprint 1) routes into `runCritiqueLoop` only when `critique === true`.

The exported action seam `runFleetExpandDeep(goal, opts, deps?)` (`src/fleet/index.ts:301`) and
`registerFleetExpandDeepSubcommand` (`src/fleet/index.ts:403`) keep their signatures; only the
new option field and the guarded spread change behavior, and only on the opt-in path. Steps 1, 3,
4, 5, 6 of `runFleetExpandDeep` (client build + credential fail-fast, assemble, atomic write,
print, `--yes` gate) are untouched.

## How to use / how it fits

```bash
# Default — robust two-stage decompose → write manifest → STOP for review (Phase 3, unchanged)
agent-bober fleet expand-deep "Build a multi-tenant SaaS platform with billing, auth, and an admin console"

# Opt-in — add a fresh-context critic gate that re-expands a degenerate/under-expanded manifest
agent-bober fleet expand-deep "Build a multi-tenant SaaS platform …" --critique

# …or decompose (with the critic gate) AND run immediately, skipping the review gate:
agent-bober fleet expand-deep "Build a multi-tenant SaaS platform …" --critique --yes
```

`--critique` is **opt-in (default off)**. With it off, `fleet expand-deep` is byte-for-byte the
plain Phase-3 command (same decompose argument, same chat-call count, same write-and-stop). With
it on, the critic loop sits strictly **after** the structural `validateManifest` gate and strictly
**before** the atomic write, so a degenerate manifest is caught and re-expanded before the operator
ever sees it. The write-and-stop review gate, the atomic temp+rename write, the shared
`<root>/.bober/fleet-expand.json` output path, the credential fail-fast, and `--yes` as the sole
spawn gate are all **unchanged** — `--critique` only changes how the manifest is *produced*, not
how it is written, reviewed, or spawned. Requires `DEEPSEEK_API_KEY` (the decompose and critic
steps call DeepSeek via the `openai-compat` provider). User-facing usage is in
[`COMMANDS.md`](../../COMMANDS.md) under **Fleet Commands**.

## Notes for maintainers

- **The default no-flag path is byte-locked to Phase 3.** A DI test asserts that without
  `--critique` the decompose argument object has **no `critique` key** (asserted absent, not
  `undefined`) and the recorded chat-call count equals the Phase-3 baseline (zero extra calls).
  The Phase-2 (`fleet expand`) and Phase-3 (`fleet expand-deep` without the flag) surfaces stay
  byte-locked; do not "simplify" the guarded spread into an unconditional `critique: opts.critique`
  — that would emit a `critique: undefined` key and break the byte-identity guarantee.
- **No sibling subcommand (LOCK2).** `--critique` is a flag on the *existing* `expand-deep`
  command, not a new `expand-deep-critique` command. The Commander tree is otherwise unchanged.
- **Spawn-safety is unchanged on the `--critique` path.** Credential fail-fast (`createClient`
  runs first; a missing key writes no file and never calls decompose), write-before-spawn (the
  manifest exists on disk before `runFleet`), and `--yes` as the sole spawn gate all hold — the
  evaluator verified `runFleet` is called exactly once with `outPath` *after* the critic-reviewed
  manifest is written, and never without `--yes`.
- **Bounds and failure modes inherited from Sprint 1.** One critique round, accept-best on
  exhaustion (tiebreak: most children, else the baseline), fail-open on parse exhaustion, total
  budget 8 chat calls, and `runCritiqueLoop` never throws — so the `--critique` result is never
  worse than the Phase-3 baseline. A plan-level degeneracy (a defective PLAN) is **not** correctable
  by the loop; the human write-and-stop review remains the backstop.
- **Byte-lock guarantee.** This sprint touched only `src/fleet/index.ts` (11 lines, the lone
  deletion being the intended decompose-call rewrite) and added `src/fleet/expand-deep-critique.test.ts`
  (9 tests). `decomposer-deep.ts`, `critic-deep.ts`, `decomposer.ts`, `manifest.ts`
  (`FleetManifestSchema`), and `src/cli/index.ts` are byte-unchanged. All 14 fleet suites
  (188 tests) plus the 9 new tests are green; the 6 pre-existing cockpit E2E MCP failures are
  unrelated and not a regression.
- This phase's architecture is in `.bober/architecture/` under
  `arch-20260618-fleet-expand-deep-critique-*` (ADR-1: loop structure / boolean critic /
  accept-best; ADR-2: opt-in `critique` field + guarded spread preserve the byte-identical
  Phase-3 default; ADR-3: verdict parse mirrors `validateOutline`, closed-form fail-open coercion
  budget; ADR-4: reuse `runExpandStage` as the re-expand seam; ADR-5: critic placed after
  `validateManifest`, before the atomic write). It extends Phase 1
  `arch-20260609-fleet-orchestrator-tech-lead-*`, Phase 2
  `arch-20260617-fleet-orchestrator-phase-2-expand-*`, and Phase 3
  `arch-20260617-fleet-robust-decomposition-*`.
</content>
