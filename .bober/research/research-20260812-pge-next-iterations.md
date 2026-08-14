# PGE next iterations — grounded closure analysis

**Date:** 2026-08-12
**Branch:** `bober/pge-graph-engineering` (28 commits ahead of `main`, 0 behind, contains `bober/graph-backend-choice`)
**Question:** what are the next iterations that move agent-bober toward a PGE-shaped workflow?

Every claim below is marked **[verified]** (read directly from the code/artifacts in this
working tree during this analysis) or **[reported]** (produced by a sub-investigation and
not independently re-checked). Act on the reported ones only after confirming them.

---

## 0. The finding that reorders the programme

**PgeEngine cannot execute a realistic plan.** Not "diverges on"; cannot execute.

The chain, verified link by link:

1. Every channel in the committed artifact declares `maxInlineBytes: 4096` — all ten of
   them, including `spec` (schemaRef `PlanSpec`) and `sprintContracts` (schemaRef
   `SprintContract`). **[verified]** — `.bober/topology/coding.json`, authored at
   `src/pge/topology/coding.graph.ts:113-190`.
2. `planMaterializeNode` returns `update: { spec: input, sprintContracts: contracts, ... }`
   — the whole `PlanSpec` object and the whole contract array. **[verified]** —
   `src/pge/nodes/plan.ts:418-424`.
3. The interpreter turns each key of `command.update` into **one** `ChannelUpdate` carrying
   that whole value: `for (const [channel, value] of Object.entries(result.command.update ?? {}))
   ... batch.push({ channel, nodeId, branchKey, value })`. **[verified]** —
   `src/pge/runtime/interpreter.ts:1334-1346`.
4. The commit boundary measures `byteSize(update.value)` — `Buffer.byteLength(canonicalJson(value))`
   — against the channel cap and, if over, pushes a `StateBloatError` onto `rejected` and
   `continue`s, so **the write is silently dropped**. **[verified]** —
   `src/pge/runtime/commit.ts:257-259, 357-369`.
5. There is no offload path at that site. `grep` over `src` finds `maxInlineBytes` handled
   only in the schema defaults, the authored graph, fixtures, and that one check. The
   `StateBloatError` message tells the *node author* to offload — which `plan_materialize`
   does not do for these two channels (it does `scratch.put` the spec and write a `refs`
   entry, but writes the full payload inline **as well**). **[verified]** — `commit.ts:80`,
   `plan.ts:415-424`.

Measured against this repository's own artifacts **[verified]**:

| payload | compact bytes | cap |
| --- | ---: | ---: |
| `.bober/specs/spec-20260805-pge-graph-engineering.json` | 29,247 | 4,096 |
| its 14 contracts, written as one `sprintContracts` update | 138,284 | 4,096 |
| all 241 files in `.bober/contracts/` | median 7,479 · max 14,852 | 4,096 |
| **contracts individually over the cap** | **229 of 241** | |

**Why no test caught it.** The largest `PlanSpec`-shaped object anywhere in the 42-case
golden dataset is **1,181 bytes** — 3.6× under the cap, and 25× smaller than the real
spec. **[verified]** by walking every `.bober/golden/*.json`.

The corroborating tell: the runtime's own fixture graph raises exactly the two channels
that would otherwise blow up — `sprintContracts` to 65,536 and `spec` to 8,192 — while the
shipped artifact keeps both at 4,096. **[verified]** —
`src/pge/runtime/__fixtures__/golden-graph.ts:360,366`.

**Consequence for the recorded defect.** With both writes dropped, `state.spec` stays
`null`, so `commit.finalize` throws `FinalizeWithoutSpecError` (`commit.ts:436`). The
crash documented in `docs/pge-graph.md:492-503` as a clarification-path edge case is
**[reported]** to be the *default outcome on real input*. This has not been observed by
running the whole graph — only derived — and Iteration 1 sprint 1 exists to observe it.

**What this does to the conformance work.** It does not invalidate it; the mechanisms held
up under adversarial review. It reorders it. Every divergence in
`conformance.engines.test.ts` is a comparison between two engines on a workload only one of
them survives because it is synthetic. Closing a conformance field before fixing this is
fitting the artifact to the test.

---

## 1. Three live bugs found on the way, independent of PGE

**(a) Both MCP sprint tools return empty against this repo's own corpus.** **[verified]**
`src/mcp/tools/sprint.ts:147` and `src/mcp/tools/eval.ts:139` both filter
`c.status === "passed"`. The 241 committed contracts hold **209 `completed`, 28 `proposed`,
4 `pending`, and zero `passed`**. Additionally `"pending"` is not a member of
`ContractStatusSchema` (`src/contracts/sprint-contract.ts:38-49`), so four contracts on
disk carry an illegal status. The two engines simply chose different words from the same
enum: ts writes `"passed"` (`src/orchestrator/pipeline.ts:558`), PGE writes `"completed"`
(`src/pge/nodes/sprint-review.ts:203`). The `contracts` conformance divergence is a symptom
of a pre-existing vocabulary split, not something PGE introduced.

**(b) The node-coverage pin counts a node as covered when its span failed.** **[verified]**
`src/pge/golden/coverage.test.ts:108-110` reads `nodeId` off each span and adds it to the
executed set with **no `status` check**. Since `commit` is refused FAIL_CLOSED under the
shipped `noop` mechanism yet still opens a span, the committed "39 of 44 nodes execute"
figure counts at least one node that never ran its body. The number is real as *reached*;
it is weaker than it reads as *exercised*. Correcting this is cheap — assert
`status === "ok"` for the nodes newly claimed — and it should happen before the count is
cited again.

**(c) The end-of-pipeline audit record can name the wrong approver.** **[reported]**
`src/orchestrator/finalize.ts:219-220` resolves the recorded `mechanism` from
`config.pipeline?.checkpointMechanism` alone, while invoking
`getCheckpointMechanismFor("end-of-pipeline", config, "noop")` eleven lines later, which
honours per-checkpoint overrides. Under `pipeline.mode: "careful"` this is said to write
`approverId: "autopilot"` for a decision a human made on disk — on the **ts engine**, today.
Worth confirming and fixing before any golden case pins that record.

---

## 2. Iterations, in dependency order

### Iteration 0 — merge the branch (a gate, not a spec)

`main` has not moved; the merge is a fast-forward and lands the PGE work *and* the
pluggable graph backend together. Every iteration below edits
`src/orchestrator/pipeline.ts`, `src/orchestrator/finalize.ts` or
`.bober/topology/coding.json`; doing that on a second branch guarantees a reconciliation.

**Exit:** `main` contains `src/pge/` and the six blocking `pge-graph-gate` checks pass there.

### Iteration 1 — real-workload viability (5-6 sprints). Everything waits on this.

1. **Observe, don't infer.** Run `PgeEngine` over the committed 29 KB spec with effects
   stubbed; record every `StateBloatError`, the terminal node, and the verdict. Commit the
   measurement as data.
2. Extend to `messages`, `evaluations`, `refs` under real generator/evaluator payloads.
3-5. Implement the chosen remedy; regenerate `coding.json` and `state-audit.json`; bump
   `graphVersion`; changelog entry (CI enforces the pairing).
6. A permanent **workload tier**: a committed corpus of real specs/contracts every cap is
   asserted against, so a fixture can never again be the only evidence.

**Decision required — two remedies:**
- **(a) Size the caps to measured reality**, keeping `StateBloatError` as a runaway guard.
  One artifact revision, MINOR bump, no node rewrites. Cheapest honest fix.
- **(b) Offload to scratch and carry `ScratchRef`s**, which is what the error message tells
  authors to do. Structurally purer, but `resolveContract` (`src/pge/nodes/gates.ts:711-719`)
  and other nodes read `sprintContracts` directly — a state-model rewrite, MAJOR bump,
  invalidates the golden dataset.

**Exit:** a `real-workload.test.ts` where a run over the committed 29 KB spec and its 14
contracts yields zero `StateBloatError` failures, `state.spec !== null`, and a declared
terminal node — plus a two-directional cap pin, so shrinking a cap fails as loudly as growing one.

### Iteration 2 — a run that did not do the thing must not report that it did (5-7 sprints)

Iteration 1 makes real runs possible and therefore real *failures* possible. Today PGE has
no channel to report one: under autopilot the `commit` node is refused FAIL_CLOSED and the
run still returns `success: true`.

1. `errors?: readonly PipelineFailure[]` on `PipelineResult`, mapped from `TaskFailure`,
   layered in `PgeEngine.run` — **not** in `finalizePipelineRun` — the same way
   `RunResultFlusher.flush` layers `needsClarification`. The frozen-key-order test in
   `finalize.test.ts` is the guard rail and must stay green.
2. Surface it: non-empty `errors` sets a non-zero exit code in `bober run` and
   `RunState.status = "failed"` in the MCP run manager. Without this the iteration closes
   nothing an operator can see.
3. **Fix `FinalizeWithoutSpecError` with a new channel, not a second writer.** Adding `spec`
   to `plan_clarify.writes` is structurally illegal: `spec`'s reducer `replaceIfNewer` is
   `{ scalar: true }` (`src/contracts/topology.ts:133`) and the validator emits
   `MultipleWritersOnScalarChannel` at severity `error`
   (`src/pge/topology/validate.ts:704-716`). **[verified]** Use a separate scalar
   `specDraft` channel that `finalize` falls back to.

**Decisions required:** un-freezing `PipelineResult` (frozen twice in the PGE spec, and in
sprint-13's non-goals) — and `success` semantics. Keeping `success` as-is while callers
treat non-empty `errors` as failure is the contained option; making a FAIL_CLOSED refusal
set `success: false` moves the completion marker and the terminal history event, which adds
a **fifth** divergent field. That belongs to the default-flip decision, not before it.

**Certain blast radius, budget it:** all five `replay` golden cases terminate at
`graceful_failure` and so gain an `errors` key — every one must be re-captured. Two
hand-authored integrity cases become false statements and must be **re-authored**:
`pipeline-result-reports-success-with-no-error-channel.json` and
`commit-refused-fail-closed-under-noop-gate.json`.

### Iteration 3 — make the golden gate execute the paths that matter (4-5 sprints)

Do this while the dataset is being re-captured anyway.

1. **Per-case config in the golden executor.** A prerequisite, not a nicety: flipping the
   global config to reach `commit`/`finalize` would delete the only executed coverage of the
   shipped autopilot fail-closed refusal.
2. **Reach `commit` and `finalize`** via a rebound approver under the already-allowed
   `"disk"` name — the technique already shipping in `nodes/commit.test.ts`. The
   registration must sit at **module scope of `executor.ts`**, because the CI script loads
   `dist/pge/golden/gate.js`; a registration inside a `*.test.ts` is invisible there and CI
   would resolve the real disk mechanism and hang. **[reported, but verified by experiment]**
   — the sub-investigation applied this, ran a replay case, observed the audit records and
   spans, and reverted.
3. **Reach `critique` and `rework_route`** — no artifact change, no version bump. A stateful
   evaluator binding that fails call 1 and passes after reaches both.
4. **Make coverage mean something** — assert span `status === "ok"`, per bug (b) above.

**Exit:** `NEVER_EXECUTED` shrinks to `["context_compact", "synthesize"]` (42/44), with an
`ok`-status span required for `commit` and `finalize`.

### Track A — opus5 Group A, in parallel from Iteration 0 (5 sprints)

`spec-20260804-opus5-adaptation` splits by **layer**, not by sprint number. The prompt- and
agent-layer sprints are reached by **both** engines through `src/pge/nodes/effects.ts`, so
they create no divergence and touch no pin. They are also the only work here that directly
improves output quality. Three amendments first:

- The completion verdict must be folded into the `EvalResult` that `runEvaluatorAgent`
  *returns*, not into `pipeline.ts`'s pass decision — otherwise the graph engine silently
  passes sprints the ts engine fails, an **invisible** divergence no conformance field reports.
- `sc-1-5` is internally contradictory (its text says `.bober/history.jsonl`; its notes say
  reuse `emit()`, which writes telemetry and is a no-op unless telemetry is enabled).
- Its sprint 3 builds a second process spawner; add it to the ESLint denylist group that
  already fences `src/pge/nodes/**` off from `src/graph/**` and `src/discovery/**`, or state
  why the sandbox guarantee is unaffected.

**Also in this track, and cheap:** `PRICE_TABLE` in `src/providers/cost-meter.ts:48-50`
prices `claude-opus-4`/`claude-sonnet-4`, while `SHORTHAND_MAP`
(`src/orchestrator/model-resolver.ts:27,31`) resolves `opus → claude-opus-5` and
`sonnet → claude-sonnet-5`. Longest-prefix match finds nothing, so `estimateCostUsd`
returns `undefined` for every run on the current default models and budget guardrails go
inert. The file's own header claims the two tables are kept in sync; **no test ties them
together** — `PRICE_TABLE` is referenced only by its own module and test. **[verified]**

### Iteration 4 — one terminal vocabulary (4-5 sprints)

The only conformance divergence worth closing on its own merits, because it is bug (a)
above: a live defect that makes two MCP tools return empty regardless of PGE. Pick the
terminal word (or a shared `isSettled()` predicate), apply it across both engines' readers
and writers, and replace duplicate-resolution in `mergeEntries` with the rank-aware join
already shipping as `versionRank`.

**Decisions required:** the vocabulary itself — each engine matches a different existing
convention, so this is a pre-existing ambiguity conformance surfaced, not one PGE created —
and whether a monotone `version` may enter the shared `SprintContract` schema serialised
into every user's `.bober/contracts/*.json`.

Deliberate pin edits required in `conformance.engines.test.ts`, `oracle-retention.test.ts`
and `sprint-evaluate.test.ts`, plus the `docs/pge-graph.md` disposition **in the same commit**.

### Iteration 5 — opus5 Group B, mirrored (conditional)

The sprints that edit `runSprintCycle` reach only `TsPipelineEngine`. Build them **after**
the convergence decision. The curator-skip sprint is the dangerous one: skipping the curator
on the ts side while PGE's `gate_sprint_in → sprint_curate_explain` edge stays unconditional
moves `briefings` out of the equivalent set and produces a **fifth** divergent field.

---

## 3. What not to do

**`history` — accept permanently.** There is no `curator` node to emit a
`curator-start`/`curator-complete` pair from; one PGE node runs both curator calls, so
emitting the pair would name the log after the oracle rather than after the run. Deleting
the ts event stream instead removes the only human-readable progress record a `bober run`
produces. **Do instead, cheaply:** harden the pin in `oracle-retention.test.ts` — the
substring `"history"` is satisfied by the import path `../../state/history.js`, so that pin
would pass after the field was removed. A gate that cannot fail is worse than no gate.

**`audits` — accept permanently.** Five of the eight checkpoint ids are per-sprint and land
inside the fan-out region, where any HITL is an `InterruptInsideFanOut` error — a frozen
ADR-6 decision that removed a real duplicate-write hazard. Record-count parity is
structurally unattainable: a hoisted approval fires once per run where the ts engine fires
once per sprint per retry iteration. A green result would be an artifact of the
one-sprint fixture.

**`synthesize` — accept, but fix the recorded reason.** **[reported]** The explanation
currently committed in `coverage.test.ts` is wrong: `synthesize` is unreachable because
`rework_route`'s dispatch set is always empty (nothing in the graph ever writes
`abandoned`), so the `partial` label is dead code — not because of where failing paths
settle. Since each `NEVER_EXECUTED` entry is a *claim*, a wrong claim should be corrected
even though the pin still passes.

**`context_compact` — not now.** The supervisor has no compact branch at all
(`COMPACT_LABEL` is referenced nowhere), and `context_compact` *grows* `messages`, so a
threshold-only rule loops to exhaustion. Revisit after Iteration 1, which changes what a
channel may hold and therefore when compaction matters.

---

## 4. Is flipping the default to `"pge"` reachable?

**Not on the currently written bar — and the bar is the problem, not the engine.**
`docs/pge-graph.md:660-666` sets the precondition as sustained green conformance across real
runs plus an error channel. "Green" means all eleven fields equivalent, and two of the four
open fields are recommended above for **permanent** acceptance on architectural grounds. The
stated precondition is therefore unsatisfiable by design, not by neglect.

The full remaining path, if the flip is genuinely wanted:

1. Iteration 1 — real workloads run at all. Non-negotiable, and today unmet.
2. Iteration 2 — error channel, plus `success: false` on a fail-closed refusal, which is
   where the completion marker deliberately leaves the equivalent set.
3. Iteration 4 — `contracts` and `pipelineResult` closed, so the engines agree about work done.
4. Iteration 3 — `commit` and `finalize` executed under a durable mechanism, so the terminal
   path has ever run inside a gate.
5. **A decision to re-specify the bar** — from "equivalent on eleven fields" to "equivalent
   on the fields that describe work done, with `history` and `audits` recorded as permanently
   engine-shaped and a written justification for each" — then edit
   `conformance.engines.test.ts`, `oracle-retention.test.ts` and the `docs/pge-graph.md`
   disposition in one reviewed commit. Honest, but it must be a stated decision, never a
   side effect.

**What stays unproven even then.** The harness compares eleven **artifact** fields; it
cannot see control flow. PGE runs `sprint_security` *before* `sprint_evaluate`; the ts
engine runs it *after* evaluation and only on pass. That divergence is invisible to every
field and would survive a fully green report. Also unproven: PGE under `mode: "suspend"`
with real resume (there is no resume entry point on the seam), multi-sprint fan-out at real
payload sizes, and the parallel ceiling — measured at 1.34×, which means the flip must be
justified by determinism, replay and inspectability, never by speed.

---

## 5. Decisions taken (2026-08-12)

**Goal: drive toward flipping `config.pipeline.engine` to `"pge"`.** Iterations 0-5 are all
in scope, including Iteration 4's terminal-vocabulary work and the monotone discriminator on
the shared `SprintContract` schema, `success: false` semantics on a fail-closed refusal, and
an explicit re-specification of the conformance bar. Consequences accepted deliberately:

- The two-directional pins in `conformance.engines.test.ts` and `oracle-retention.test.ts`
  will need edits. Each edit is a decision, made in the same commit as the
  `docs/pge-graph.md` disposition it changes — never as a side effect.
- `history` and `audits` are still recommended for permanent acceptance on architectural
  grounds. Flipping the default therefore requires re-specifying the bar from "equivalent on
  eleven fields" to "equivalent on the fields that describe work done", with a written
  justification per accepted divergence. That re-specification is itself a gated decision,
  taken *after* Iterations 1-4 land, not assumed by them.
- What stays unproven even after a green flip is recorded in section 4 and does not become
  false by deciding to proceed: control-flow divergence is invisible to the harness,
  `mode: "suspend"` resume has no entry point on the seam, and the parallel ceiling is 1.34×.

**Byte-cap remedy: size the caps to measured reality.** Raise `spec`, `sprintContracts`,
`messages` and any other channel the measurement implicates to caps derived from a committed
workload corpus, keeping `StateBloatError` as a runaway guard rather than removing the check.
MINOR `graphVersion` bump, no node rewrites, golden dataset survives. The caps are pinned
two-directionally against the corpus so shrinking one fails as loudly as growing one.

Rejected: scratch offload with `ScratchRef`s. Structurally purer and what the error message
tells node authors to do, but it rewrites the state model, forces a MAJOR bump and
invalidates all 42 golden cases — cost out of proportion to a defect that a cap revision
closes.

**Still open, and deliberately deferred to the iteration that reaches it:** the terminal
word itself (`passed` vs `completed` vs a shared `isSettled()` predicate), and whether
`version` may enter `SprintContractSchema` and be serialised into every user's
`.bober/contracts/*.json`. Both belong to Iteration 4.
