# SynthesisStep + fleet-synthesis.json artifact

**Contract:** sprint-spec-20260618-fleet-blackboard-exchange-4  ·  **Spec:** spec-20260618-fleet-blackboard-exchange  ·  **Completed:** 2026-06-18

## What this sprint added

The **head-side synthesis collection** that closes Phase B — the last piece of the
blackboard-exchange data flow. After a blackboard fleet's bounded rounds finish, `runFleet`
now bundles the final-round child results, all blackboard findings, and the round count into a
**pure data** `SynthesisBundle` and atomically writes it to `<rootDir>/.bober/fleet-synthesis.json`
for the head / dynamic-workflow to synthesize. The collection step performs **no LLM call and no
network** — the bober runtime deliberately does **not** synthesize; it only assembles the bundle
the head consumes. The artifact is written **only on a blackboard run**, **after** the unchanged
`fleet-report.json` write; a no-blackboard run writes nothing extra and is **byte-identical** to
Phase A.

## Public surface

- `interface SynthesisBundle` (`src/fleet/synthesis.ts:14`) — `{ rounds: number; childResults: PortfolioReport; findings: FactRecord[] }`.
  `childResults` is the exact `PortfolioReport` the reporter built; `findings` is the blackboard's
  `readAll()` (every active `'finding'` `FactRecord`) or `[]` when there is no blackboard.
- `function collect(blackboard, childResults, rounds)` (`src/fleet/synthesis.ts:30`) —
  `collect(blackboard: SharedBlackboard | null, childResults: PortfolioReport, rounds: number): SynthesisBundle`.
  **Pure:** `return { rounds, childResults, findings: blackboard ? blackboard.readAll() : [] }`.
  No LLM, no network, no IO, no provider/client construction — it only shapes existing in-memory
  data into JSON. When `blackboard` is `null`, `findings` is `[]`.
- `<rootDir>/.bober/fleet-synthesis.json` (output artifact, written by `runFleet`) — the JSON
  serialization of a `SynthesisBundle`. Written **only** on a blackboard run.

`writeSynthesis(rootDir, bundle)` (`src/fleet/index.ts:60`) is a private atomic writer (tmp +
`rename`, `randomBytes` suffix, mode `0o600`, trailing newline) mirroring `PortfolioReporter.write`
— internal, not exported.

## How to use / how it fits

There is **no new user-facing command or flag.** The artifact is produced automatically by
`agent-bober fleet <manifest>` whenever the manifest carries a `blackboard` block (the same opt-in
that drives the Sprint-3 rounds loop). The end-to-end Phase B flow is now:

```
manifest.blackboard → resolveBlackboardPath → SharedBlackboard.open
  → coordinator.executeRounds (bounded re-spawn + early-stop)
  → reporter.build/write  → fleet-report.json     (always, unchanged)
  → collect + writeSynthesis → fleet-synthesis.json (blackboard runs only)
  → bb.close()  (outer finally — WAL checkpoint, runs AFTER collect)
```

`fleet-synthesis.json` is the **hand-off to the head**: the orchestrator / dynamic-workflow reads
it to perform the actual cross-child synthesis over the bundled findings. Example shape:

```json
{
  "rounds": 3,
  "childResults": { "...": "the same PortfolioReport written to fleet-report.json" },
  "findings": [
    { "id": "…", "scope": "fleet-run-123", "subject": "api-server",
      "predicate": "finding", "value": "auth bug is in token refresh", "confidence": 1, "...": "…" }
  ]
}
```

A manifest with **no** `blackboard` block produces no `fleet-synthesis.json` at all, and the run
output is unchanged from Phase A.

## Notes for maintainers

- **`bundle.rounds` is the configured cap, not the executed count.** It is sourced from
  `effectiveManifest.blackboard!.maxRounds`, flagged in the source with a `bober:` ceiling comment
  (`src/fleet/index.ts`). `coordinator.executeRounds` returns only the final-round executions with
  **no** explicit round count, and adding a returned-count shape would mean touching the coordinator
  — an explicit Sprint-4 non-goal (#5). So if a blackboard run early-stops, `rounds` reports the cap
  (e.g. `3`), not the actual number of rounds executed (e.g. `2`). The evaluator accepted this as
  satisfying "the round count" as written; a future sprint that has the coordinator return its
  executed-round count should plumb it through here.
- **Close-ordering is load-bearing.** `bb` and `roundsRun` were hoisted out of the Sprint-3
  `if (dbPath)` block, and `bb.close()` moved to an **outer `finally`**, so `collect()` →
  `bb.readAll()` runs while the db is still **open**. The `finally` also guarantees the WAL is
  checkpointed on any error path. Do not move `close()` back inside the branch.
- **The synthesis write is purely additive + gated.** It sits **after** `reporter.write` under an
  `if (bb)` guard. `fleet-report.json` is always written and its shape is **unchanged**;
  `fleet-synthesis.json` is *additional* and *blackboard-only*. A no-blackboard run never constructs
  a blackboard, so the file is absent and the output is byte-identical to before.
- **`collect` is pure by contract, not just by convention.** `synthesis.ts` imports only
  `type`-level `SharedBlackboard` / `PortfolioReport` / `FactRecord` — zero provider/SDK/network
  imports (a test greps the source to assert this). Keep it that way: the head, not the runtime,
  does the LLM synthesis.
- **Scope.** Commit `297a8f2`: `src/fleet/synthesis.ts` (new), `src/fleet/index.ts` (modified),
  plus collocated `src/fleet/synthesis.test.ts` (new) and `src/fleet/index.test.ts` (modified).
  Full suite **2786 passed**, fleet **273/273** (only the 6 pre-existing cockpit-integration MCP
  failures remain). All 7 criteria (sc-4-1..sc-4-7) passed iteration 1.
