# GEPA offline prompt evolution `bober evolve` — replay-gated, Pareto-set, never live

**Contract:** sprint-spec-20260615-self-improve-p1-p2-4  ·  **Spec:** spec-20260615-self-improve-p1-p2  ·  **Completed:** 2026-06-15

## What this sprint added

The keystone of Phase 5: an **offline, opt-in `bober evolve --role generator|evaluator` verb**
(GEPA-style prompt evolution) that can *propose* an improved version of the generator or
evaluator agent prompt — but only through the deterministic replay gate, and **never live**.
A new `src/orchestrator/selfimprove/gepa.ts` exports two PURE primitives (`proposeVariants`,
`paretoSet`) and one orchestration entry point (`evolve`); a new `src/cli/commands/evolve.ts`
exposes them as the `bober evolve` CLI verb (registered in `src/cli/index.ts` next to
`registerReplayCommand`). It reads the base prompt via `loadAgentDefinition`, proposes
deterministic seeded variants, scores **each variant only via the Sprint 2 `runReplayHarness`
gate** (no live LLM run), keeps a Pareto frontier, and writes a promoted prompt under
`.bober/evolve/<runId>/promoted/<role>.md` **only** when a variant beats the recorded baseline
with **zero regressions and strictly more improvements** (a tie does **not** promote). The two
load-bearing safety invariants — it never writes `agents/<role>.md`, and it is never imported or
called by `runPipeline` — are proven by a source-text guard test plus independent grep. Full
suite after this sprint: **2309 tests, zero regressions**.

## Public surface

- `proposeVariants(basePrompt: string, seed: number): string[]` (`src/orchestrator/selfimprove/gepa.ts:75`)
  — **PURE**. Produces a deterministic, bounded set of small textual mutations of `basePrompt`.
  A fixed `seed` yields **byte-identical** variants on every call (uses a hand-rolled `mulberry32`
  seeded PRNG; **no `Math.random`**). Three operator classes applied in order: (1) append a
  clarifying constraint sentence; (2) paraphrase the first markdown heading by inserting a
  qualifier; (3) reorder two adjacent guidance bullets. Each operator has a deterministic fallback
  when the base text lacks the target structure (no heading / fewer than two bullets).
- `paretoSet(scored: VariantScore[]): VariantScore[]` (`src/orchestrator/selfimprove/gepa.ts:146`)
  — **PURE**, input not mutated. Returns the non-dominated frontier over two axes:
  `replayPassCount` (higher is better) and `promptLength` (lower is better). A variant is excluded
  iff another dominates it on both axes with at least one strict inequality.
- `evolve(projectRoot, config, opts, deps?): Promise<GepaResult>` (`src/orchestrator/selfimprove/gepa.ts:194`)
  — async orchestration entry point. `opts` is `{ role, seed, dryRun?, runId? }`;
  `deps` is `{ harness? }` — a **DI seam** so tests inject a stub harness (production defaults to the
  real `runReplayHarness`). Returns `GepaResult = { promoted, winnerPath, baselineRegressions, variantsTried }`.
- `bober evolve --role <generator|evaluator> [--seed <n>] [--dry-run]` (`src/cli/commands/evolve.ts:33`,
  `registerEvolveCommand`) — the CLI verb. `--seed` defaults to `0`; `--dry-run` scores and reports
  variants without writing any promoted file. The handler does a **tolerant** `loadConfig` (a missing
  `bober.config.json` is non-fatal), prints with `chalk`, and **never throws** — on error it sets
  `process.exitCode = 1` and returns.
- Types `VariantScore`, `GepaResult`, `EvolveOptions`, `EvolveDeps`, `HarnessFn` exported from
  `gepa.ts` for callers and tests.

## How to use / how it fits

```bash
# Score generator-prompt variants against the frozen replay corpus WITHOUT writing anything.
bober evolve --role generator --dry-run

# Score evaluator-prompt variants with a fixed seed; write a promoted prompt ONLY if a variant wins.
bober evolve --role evaluator --seed 7
```

The verb sits at the end of the Phase 5 chain. It reads the live agent prompt
(`agents/bober-<role>.md`, via `loadAgentDefinition` — the `.md` body after the frontmatter is the
`systemPrompt`), computes a baseline by running `runReplayHarness` once, then scores each proposed
variant through the same harness and keeps the Pareto frontier.

**Promotion predicate (strict — a tie does NOT promote):**

```
eligible  ⟺  result.regressions.length === 0
        AND  result.improvements.length > baseline.improvements.length
```

Among eligible frontier variants the winner is the one with the most improvements, then the
shortest prompt as a deterministic tiebreak.

**Writes (the load-bearing safety boundary).** Everything lands under `.bober/evolve/<runId>/`
(`runId` defaults to `evolve-<Date.now()>`, injectable for deterministic test paths):

| Output | When written |
|--------|--------------|
| `report.json` (Pareto record + per-variant scores + baseline) | **always** |
| `promoted/<role>.md` (the winning prompt text) | **only** when a winner exists **AND** `!dryRun` |

`report.json` records `runId`, `role`, `seed`, `dryRun`, `promoted`, `winnerPath`, the baseline
counts, `variantsTried`, the `paretoFrontier` (each tagged `eligible`), and `allScores`.

### Adopting a winning prompt (the manual promotion workflow)

Promotion into the live `agents/` directory is a **deliberate manual human copy** — it is
intentionally **out of scope** for this verb and for the whole pipeline. To actually adopt a
winner a maintainer:

1. Runs `bober evolve --role generator` (without `--dry-run`) and notes the printed
   `Promoted → .bober/evolve/<runId>/promoted/generator.md` line.
2. Diffs the promoted prompt against the live one (`diff agents/bober-generator.md
   .bober/evolve/<runId>/promoted/generator.md`) and reviews `report.json`.
3. If satisfied, **manually** copies the promoted file over `agents/bober-generator.md` and commits
   it — a human-reviewed change, not an automated write.

There is no code path — in `gepa.ts`, `evolve.ts`, or anywhere in the pipeline — that performs
step 3 for you.

## Notes for maintainers

- **Two safety invariants, both independently proven.** (1) Neither `gepa.ts` nor `evolve.ts` ever
  constructs a write path under `agents/` — all writes are joined under `.bober/evolve/<runId>/`.
  (2) `pipeline.ts` never imports or calls `evolve`/`gepa` — the verb is **CLI-only** and
  unreachable from `runPipeline`. Both are asserted by the `sc-4-7` source-text guard test (reads
  the three source files as text and asserts the forbidden patterns are absent) **and** independently
  confirmed by grep at evaluation time (`grep -n "agents" gepa.ts evolve.ts` → none;
  `grep -n "evolve\|gepa" pipeline.ts` → none). The `git show 46e96f7` diff touches no file under
  `agents/`.
- **The replay gate is the sole scorer — there is no live LLM run.** `evolve` scores variants
  **only** through `runReplayHarness`; it imports no `runGeneratorAgent` / `runEvaluatorAgent` and
  no provider SDK (`@anthropic-ai/sdk` / `openai`). Because the harness re-derives verdicts from the
  frozen `eval_details_json` (it does not vary by prompt text), the variant prompt is passed for
  bookkeeping only — **the gate, not the mutation operator, is load-bearing**. This keeps the verb
  cheap, deterministic, and offline. If a future sprint wants variants to genuinely move the score,
  the harness (or a richer scorer) — not the operator set — is where that work belongs, and any
  LLM call to *generate* variants must still go through `src/providers/factory.ts` `createClient`.
- **`proposeVariants` must stay deterministic.** It uses `mulberry32`, not `Math.random`; a fixed
  seed yields byte-identical variants. The `sc-4-3` test calls it twice with the same seed and
  asserts equality, and asserts `paretoSet` drops a doubly-dominated variant. Do not introduce any
  clock/network/randomness into the two PURE functions.
- **Promotion is strict.** Zero regressions **and** *strictly more* improvements than the baseline.
  A variant that merely ties the baseline (`sc-4-6` covers this case) is **not** promoted and no
  `promoted/<role>.md` is written — only `report.json`.
- **`--dry-run` never writes a promoted file**, even when a winner exists; `report.json` is still
  written with `promoted: false`.
- **DI seam for testing.** `evolve(..., { harness })` lets the `gepa.test.ts` suite inject a
  stubbed/seeded `runReplayHarness`-shaped function to deterministically simulate a regressing
  variant (not promoted, no file), a strictly-improving variant (promoted file written under a temp
  `.bober/evolve/`), and a tie. Production passes no `deps` and uses the real harness.
- **This is the final sprint of Phase 5 — the plan is complete (4 of 4).** With it, the
  safe-self-improvement loop is closed: capture → replay gate → guards → evolve, all offline, all
  replay-gated, all off by default, and the system never edits its own live prompts.
