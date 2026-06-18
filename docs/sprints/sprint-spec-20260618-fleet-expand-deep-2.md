# fleet expand-deep CLI subcommand (additive, spawn-safe, byte-lock preserved)

**Contract:** sprint-spec-20260618-fleet-expand-deep-2  ·  **Spec:** spec-20260618-fleet-expand-deep  ·  **Completed:** 2026-06-18

## What this sprint added

The user-facing CLI that wraps Sprint 1's robust two-stage engine: a new
`agent-bober fleet expand-deep <goal>` subcommand, attached additively in `src/fleet/index.ts`
as a sibling of the locked `fleet <manifest>` runner and the Phase-2 `fleet expand` command.
It turns one high-level goal into a children-only `FleetManifest` via `decomposeGoalDeep`
(bounded **PLAN → EXPAND**, the robust path for large/ambiguous goals), atomically writes the
manifest to `<root>/.bober/fleet-expand.json` (or `--out`), prints it plus a review hint, and
**stops by default** (write-and-stop, exit `0`, no spawn). `--yes` is the **sole** gate that
then chains into the locked `runFleet(outPath)` to launch the child runs. Every existing line is
byte-identical — `fleet expand` (single-shot), `runFleetExpand`, and the `fleet <manifest>`
registration are untouched (the evaluator confirmed zero deleted lines; only `src/fleet/index.ts`
and the new test changed).

## Public surface

All new exports are additive in `src/fleet/index.ts`.

- `runFleetExpandDeep(goal, opts, deps?): Promise<void>` (`src/fleet/index.ts:299`) — the
  exported, testable action seam. Mirrors `runFleetExpand` step-for-step: (1) build the DeepSeek
  `LLMClient` via `createClient` — **credential fail-fast before any IO** (missing
  `DEEPSEEK_API_KEY` throws, no file written, decompose never reached); (2) fold the `--count`
  soft hint into the goal and call `decomposeGoalDeep({ goal, client, model })`; (3) assemble
  `{ rootDir, concurrency, children }`; (4) atomic temp+rename write to `outPath` with an
  overwrite notice; (5) print the manifest + `Review then run: agent-bober fleet "<outPath>"`;
  (6) call `runFleet(outPath)` **only** inside `if (opts.yes)` (then print the Fleet Summary),
  else `process.exitCode = 0`. Differs from `runFleetExpand` in exactly one line — it calls
  `decomposeGoalDeep` instead of `decomposeGoal`.
- `registerFleetExpandDeepSubcommand(fleet): void` (`src/fleet/index.ts:396`) — attaches
  `.command("expand-deep <goal>")` to the existing `fleet` command with the same seven options as
  `expand` (`--count`, `--provider`, `--model`, `--root`, `--concurrency`, `--out`, `--yes`) and a
  thin try/catch action wrapper (`logger.error("Fleet expand-deep failed: …")` + `exitCode = 1` on
  throw).
- `FleetExpandDeepOptions` interface (`src/fleet/index.ts:261`) — `{ count?, provider?, model?,
  root?, concurrency?, out?, yes? }` (string options; `yes` boolean), the same shape as
  `FleetExpandOptions`.
- `FleetExpandDeepDeps` interface (`src/fleet/index.ts:278`) — `{ decomposeDeep?, runFleet?,
  createClient? }`, the DI seam tests inject (fake decomposer, `runFleet` spy, fake client
  builder) so the suite needs no network or spawn.
- The wiring: `registerFleetExpandDeepSubcommand(fleet)` is called on the line **after**
  `registerFleetExpandSubcommand(fleet)` inside `registerFleetCommand` (`src/fleet/index.ts:522`)
  — no existing line edited, so `fleet <manifest>` and `fleet expand` register byte-identically.

## How to use / how it fits

```bash
# Robustly decompose a large/ambiguous goal → write manifest → STOP for review (default)
agent-bober fleet expand-deep "Build a multi-tenant SaaS platform with billing, auth, and an admin console"
#   …writes <root>/.bober/fleet-expand.json and prints:
#   Review then run: agent-bober fleet "<root>/.bober/fleet-expand.json"

# Review/edit the written manifest, then run it with the Phase-1 runner:
agent-bober fleet ".bober/fleet-expand.json"

# …or decompose AND run immediately, skipping the review gate:
agent-bober fleet expand-deep "Build a multi-tenant SaaS platform …" --yes
```

`expand-deep` is the **robust sibling** of Phase-2 `fleet expand`: use it when the goal is large
or ambiguous and single-shot `decomposeGoal` would yield one giant low-quality child or fail
validation. It is otherwise interchangeable — same options, same default output path
(`<root>/.bober/fleet-expand.json`), same write-and-stop review gate, same `--yes` semantics — so
the only operator-visible difference is the underlying two-stage decomposer. Requires
`DEEPSEEK_API_KEY` (the decomposition step calls DeepSeek via the `openai-compat` provider).
User-facing usage is documented in [`COMMANDS.md`](../../COMMANDS.md) under **Fleet Commands**.

## Notes for maintainers

- **`fleet expand` and `expand-deep` share `fleet-expand.json` by design.** There is no distinct
  default output path — running one then the other overwrites (with a printed notice). Use `--out`
  to keep both manifests side by side. This was an explicit non-goal, not an oversight.
- **`--yes` is the only spawn gate.** No interactive `y/N` prompt and no TTY check. The write
  precedes the gate, so with `--yes` the manifest exists on disk *before* `runFleet` runs (the
  evaluator verified the ordering and that `runFleet` is never called without `--yes`).
- **`--provider` / `--model` override the decomposer LLM only**, not the children's per-run
  providers. The model default is `deepseek-v4-pro`; the endpoint is hard-wired to
  `https://api.deepseek.com`.
- **Intentional limitations (inherited from Sprint 1, deferred).** The EXPAND call is not
  self-judged (a shape-valid-but-coarse manifest can still pass — Approach B / a bounded critique
  round is the recorded remedy) and there is no hard `--count` cap. The write-and-stop default,
  which forces operator review before any spawn, is the mitigation.
- **Byte-lock guarantee.** This sprint touched only `src/fleet/index.ts` (additive, zero deleted
  lines) and added `src/fleet/expand-deep.test.ts`. `decomposer.ts`, `decomposer-deep.ts`,
  `manifest.ts` (`FleetManifestSchema` / `FleetChildSchema`), `buildChildConfig`, `runFleet`, and
  `src/cli/index.ts` are unchanged. Full suite: 2294 passed.
- This phase's architecture is in `.bober/architecture/` under
  `arch-20260617-fleet-robust-decomposition-*` (extends Phase 1
  `arch-20260609-fleet-orchestrator-tech-lead-*` and Phase 2
  `arch-20260617-fleet-orchestrator-phase-2-expand-*`).
</content>
</invoke>
