# ADR-1: Manifest-Driven Fleet with mapBounded Fan-Out and Disk-Primary Aggregation

**Decision:** Build a new `agent-bober fleet <manifest.json>` command and `runFleet` module that reads an author-supplied JSON manifest, scaffolds each subfolder, fans out via `mapBounded(children, cap, fn)`, and aggregates outcomes disk-primary from `.bober/runs/<runId>/state.json`.

**Context:** No layer exists above `runPipeline` (src/orchestrator/pipeline.ts:929) to build N independent small projects in bulk with bounded concurrency, per-child isolation, and one aggregated report. The motivating scenario already enumerates six named folders (plinko, mines, dice, crash, wheel, hilo).

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: Manifest + mapBounded + disk-primary aggregation | Reuses tested `Semaphore`/`mapBounded`; outcome from durable `RunState`; deterministic | Requires author-written manifest; no auto-decomposition |
| B: One-shot LLM decomposition + hand-rolled pool + stdout parsing | No manifest authoring | Re-implements tested concurrency; brittle ANSI stdout scraping; nondeterministic decomposition |
| C: Hybrid manifest + optional `--expand` LLM call | Flexible | Largest surface; LLM-expansion scope unneeded for the six-folder motivating case |

**Rationale:** The CP1 HARD throughput constraint (reuse `mapBounded()`/`Semaphore`, scheduler.ts) and the data constraint (`.bober/runs` `RunState` as the only persistence) eliminate B's hand-rolled pool and stdout scraping; the enumerated six-folder motivating case eliminates C's LLM-expansion surface as unneeded scope.

**Consequences:** A new `src/fleet/` module and `fleet` CLI command ship; consumers author a JSON manifest; outcomes are read from each child's durable `state.json`; the `run` CLI and `runPipeline` contracts are untouched.

**Risk:** If `mapBounded`'s `Promise.all` (scheduler.ts:181) is not wrapped by a never-reject thunk, one child's failure aborts every sibling, violating the per-child isolation constraint.
