# The PGE coding graph

This document describes `.bober/topology/coding.json` — the serializable topology artifact
that the Prompt Graph Engine (PGE) executes. It is the human-readable half of that
artifact: what the pipeline does, which node does it, which gate can stop it, and where
every loop runs out of budget.

> **This document is enforced, not decorative.** A drift checker
> (`src/pge/topology/docs.ts`, shipped sprint 3) reads the node ids out of the
> `pge:nodes` regions below and compares them with the node ids the committed artifact
> declares. The two sets must be **equal** — a node that exists but is not written down
> here fails the check, and so does a node written down here that no longer exists. The
> gate table, the loop table, the router table, the edge table and the channel table are
> compared field by field against the artifact by `src/pge/topology/docs.test.ts`.
> **Every future change to the topology therefore needs a matching edit to this file, or
> CI goes red.** That is the point: an artifact nobody gates on is an artifact nobody
> maintains.

Artifact facts, as committed: `graphId: "coding"`, `graphVersion: "1.4.0"`,
`formatVersion: 1`, `entry: "research_body"` — **44 nodes, 56 edges, 11 channels,
2 subgraphs**. Node kinds: 15 `llm`, 13 `gate`, 7 `router`, 7 `tool`, 2 `subgraph`.
Graph defaults: `concurrency: 1`, `durability: "superstep"`, `maxInlineBytes: 4096`,
`modelTier: "light"`, `supervisorNodeId: "supervisor"`. A default is what a channel inherits
when it declares nothing of its own — as of `1.4.0` three channels (`spec`, `specDraft`,
`sprintContracts`) declare a cap ABOVE the default, so do not read `4096` as the cap
everywhere (see [Channels](#channels)).

## Contents

- [How to read this document](#how-to-read-this-document)
- [What the pipeline does](#what-the-pipeline-does)
- [How the regions compose](#how-the-regions-compose)
- [The node inventory](#the-node-inventory)
- [The gates](#the-gates)
- [The loop bounds](#the-loop-bounds)
- [Routers and outcome labels](#routers-and-outcome-labels)
- [Edges](#edges)
- [Channels](#channels)
- [The golden dataset: what it proves and what it does not](#the-golden-dataset-what-it-proves-and-what-it-does-not)
- [The graph engine against a real workload](#the-graph-engine-against-a-real-workload)
- [Engine migration disposition](#engine-migration-disposition)
- [Changelog](#changelog)

## How to read this document

The node inventory lives inside three HTML-comment regions, each opened by a `pge:nodes`
marker comment and closed by its `/pge:nodes` counterpart. (The literal marker text is
deliberately not reproduced in this paragraph: the checker scans for it, so quoting it in
prose would open a fourth, empty region.) Inside a region, **any backticked bare
identifier is read as a claimed node id**. That is why the description column of those
three tables contains no code spans at all: writing a schema name, a channel name or a
counter key in backticks inside a region would register it as a node that does not exist
and fail the drift check. Everything that is not a node id — schema names, counter keys,
file paths, CLI invocations — is either written in plain text inside the regions, or
backticked outside them, where the checker never looks.

The remaining tables sit in their own regions (`pge:gates`, `pge:loops`, `pge:routers`,
`pge:edges`, `pge:channels`), which the drift checker ignores and the test suite reads.
Backticks are free there.

To check this document against the artifact locally, run the `pge docs` command against
this file from the repository root; CI runs the same check on every pull request, as a
blocking step.

**This document, not the design record, is the current description.**
`.bober/architecture/arch-20260805-pge-graph-engineering-architecture.md` is the dated `draft`
design artifact the graph engine was built from, and it is deliberately left as written: it
records what was designed on 2026-08-05, which is not the same question as what ships today. Two
of its figures have since moved and are worth knowing before citing it — it states that
`OverallState` has *"Exactly 15 keys"* (16 since the `specDraft` channel at `1.4.0`) and that
channel values cap at 4 KiB (true of eight channels; `spec` is 131,072 and `sprintContracts`
524,288 since `1.3.0`, both sized off a measured corpus). Nothing gates that file. Everything
below is gated.

## What the pipeline does

The graph is the agent-bober coding pipeline expressed as data. A run goes through five
phases, and a supervisor sits in the middle of all of them:

1. **Research.** The run enters at `research_body`, the call site of the research
   subgraph. Inside it, the feature request becomes exploration questions, the questions
   are answered against the real codebase, the answers are critiqued, and the loop
   repeats until the reflexion budget is spent. What survives is written to
   `.bober/research/` as a research document and returned to the supervisor as a digest.
2. **Planning.** The supervisor admits the digest into planning. A planner drafts a
   spec with sprint contracts and open questions; while questions remain and the
   clarification budget holds, a human-in-the-loop interrupt collects answers and the
   draft is redone. When the draft is clean it is materialised to disk — the spec and
   every sprint contract — and control returns to the supervisor.
3. **Sprints.** The supervisor fans out one branch per admitted contract into the sprint
   subgraph. Each branch curates its context, writes fixtures, generates code, passes a
   syntax gate, a security review, an evaluation and an anchor-regression gate, then
   either retries through the corrector, goes to review, or exits. Every branch leaves
   through the sprint exit gate and converges on a single root-level barrier, which makes
   exactly one return to the supervisor.
4. **Global evaluation.** Once every branch has settled, the run is graded against the
   spec's acceptance criteria rather than against any single contract. The post-evaluation
   router then documents a passing run, synthesises a partial one, sends failures back
   through a critique and a rework fan-out, or gives up.
5. **Commit and finalise.** Documentation is written, a human approves the commit, the
   commit is made, and the run finalises. Any fail-closed condition anywhere routes to the
   single failure terminal, which ends the run **without** a commit.

Two properties are worth stating up front because they explain most of the shape:

- **The git effect is behind a human gate.** `commit` is the only node carrying the git
  effect and it is reachable only from the approval gate. The approval gate itself is
  effect-free, so an approval mechanism that grants nothing blocks the commit rather than
  half-performing it.
- **Every cycle carries its own budget.** There is no global step limit standing in for
  loop control. Each cycle names a counter, a maximum and a node to fall through to when
  the maximum is reached — see [The loop bounds](#the-loop-bounds).

## How the regions compose

The graph has a root region and two subgraphs, declared with an explicit entry gate and
exit gate each, at depth 1, inheriting the root's persistence:

| subgraph | graphId | entry gate | exit gate | depth | persistence |
| --- | --- | --- | --- | --- | --- |
| `research` | `coding.research` | `gate_research_in` | `gate_research_out` | 1 | inherit |
| `sprint` | `coding.sprint` | `gate_sprint_in` | `gate_sprint_out` | 1 | inherit |

Composition rules the artifact enforces structurally:

- A subgraph is entered and left **only through its declared boundary gates**. Every edge
  that crosses a region boundary passes through one of the four gates above.
- A subgraph call site is a node of kind `subgraph` in the parent region
  (`research_body`, `sprint_body`); the bodies are ordinary nodes tagged with the
  subgraph they belong to.
- The sprint subgraph is the **fanned-out** region: both `fanout_sprints` and
  `rework_route` reach `sprint_body` over an edge of kind `fanout`, so the same single
  call site runs once per contract with runtime-determined cardinality. The topology
  checksum is therefore invariant to how many contracts a spec happens to have.
- `gate_sprint_out` runs **per branch**, so it cannot be the join. The join is
  `reduce_sprints`, a root-level barrier that waits for every dispatched branch and makes
  one return to the supervisor.

## The node inventory

Three tables, one per region, in flow order. Every node id in the committed artifact
appears exactly once across them.

### Root graph — 23 nodes

<!-- pge:nodes -->
| node | kind | what it does |
| --- | --- | --- |
| `research_body` | subgraph | Root-level call site for the research subgraph, and the graph entry point. |
| `supervisor` | router | Dispatches the next phase (plan, sprints, evaluate) and folds each subgraph result back into the run. |
| `context_compact` | tool | Runs at a superstep boundary when the message window crosses the compression threshold: summarises older messages to scratch and re-injects the digest. |
| `gate_plan_in` | gate | Admits the run into planning only when a research digest exists and the spec is absent or stale. |
| `plan_draft` | llm | Produces a plan-spec draft with sprint contracts and clarification questions from the research digest. Sole writer of the scalar specDraft channel. |
| `plan_clarify_check` | router | Routes to the human clarification interrupt while the draft still carries open questions and the clarification budget holds. |
| `plan_clarify` | gate | Human-in-the-loop interrupt collecting answers to the planner's open questions. Effect-free by construction. |
| `plan_materialize` | tool | Persists the plan spec and every sprint contract under the project state directory. Sole writer of the scalar spec channel. |
| `gate_plan_out` | gate | Returns control to the supervisor once the spec and its contracts are on disk, and fails closed when persistence did not happen. |
| `fanout_sprints` | router | Emits one branch per admitted contract into the sprint subgraph, or reports the queue drained. |
| `sprint_body` | subgraph | Root-level call site for the sprint subgraph, reached only over a fan-out edge. |
| `reduce_sprints` | gate | The single fan-in barrier: every branch converges here, and one return is made to the supervisor. |
| `gate_eval_in` | gate | Admits the run into global evaluation once every sprint branch has settled. |
| `evaluate_global` | llm | Grades the run against the spec's acceptance criteria rather than against any single contract. |
| `route_after_eval` | router | Chooses between documenting a passing run, synthesising a partial one, reworking failed branches, and failing gracefully. |
| `critique` | llm | Turns the global evaluation into per-branch rework instructions. |
| `rework_route` | router | Re-dispatches the failed branches through the sprint subgraph while the rework budget holds, and fails gracefully once it is spent. |
| `synthesize` | llm | Produces a qualified answer from the branches that did succeed when the run is only partially complete. |
| `documenter` | llm | Writes the sprint documentation and the progress summary for the completed work. |
| `hitl_commit` | gate | Human-in-the-loop approval guarding the git commit. Effect-free: the approval and the effectful commit are separate nodes. |
| `commit` | tool | Creates the run's commit. Reachable only behind the approval gate, which is what makes the git effect blockable fail-closed. |
| `finalize` | tool | Emits the terminal artifacts, the pipeline-complete history event and the completion marker. Sole writer of the scalar verdict channel. |
| `graceful_failure` | tool | The single failure terminal: records the failure classes per branch and the reason, then ends the run without a commit. |
<!-- /pge:nodes -->

### Research subgraph — 7 nodes

<!-- pge:nodes -->
| node | kind | what it does |
| --- | --- | --- |
| `gate_research_in` | gate | Boundary gate admitting the feature request into the research subgraph. |
| `research_reflect` | llm | Turns the feature request into the exploration questions the explorer will answer, and records the reflexion round. |
| `research_explore` | llm | Answers the reflexion questions against the real codebase and offloads oversized findings to scratch refs. |
| `research_critique` | llm | Grades the exploration for unanswered questions and unsupported claims. Effect-free, so it declares a run-scoped cache policy of one hour. |
| `research_route` | router | Sends the critique back for another exploration round until the reflexion budget is spent, then collects what exists. |
| `research_collect` | tool | Writes the consolidated research document to the research directory and records its scratch ref. |
| `gate_research_out` | gate | Boundary gate returning the research digest to the supervisor, and failing closed when no research document was produced. |
<!-- /pge:nodes -->

### Sprint subgraph — 14 nodes

<!-- pge:nodes -->
| node | kind | what it does |
| --- | --- | --- |
| `gate_sprint_in` | gate | Boundary gate admitting one contract branch into the sprint subgraph; a non-admissible contract short-circuits to the branch exit. |
| `sprint_curate_explain` | llm | Selects the files this contract touches and explains them to the generator. Effect-free, so it declares a run-scoped cache policy of thirty minutes. |
| `sprint_curate_mocks` | llm | Writes the fixtures and boundary mocks the sprint's tests need before any implementation exists. |
| `gate_mock_coverage` | gate | Rejects a sprint whose declared boundaries are not covered by fixtures, sending it back to the mock curator. |
| `sprint_generate` | llm | Implements one sprint contract against the curated context, writing source and collocated tests into the working tree. |
| `gate_syntax` | gate | Runs typecheck and lint under the sandbox policy; any failure routes straight to the corrector without spending an evaluation. |
| `sprint_security` | llm | Fail-closed security review of the sprint diff; findings are recorded as evaluations before the terminal evaluator runs. |
| `sprint_evaluate` | llm | Runs the sprint's evaluation strategies under the sandbox policy and records the anchor tests it observed green. |
| `gate_anchor_regression` | gate | Re-runs the recorded anchor tests; a regression routes to the corrector regardless of the sprint's own verdict. |
| `sprint_route` | router | Retries the branch through the corrector while the iteration budget holds, passes to review on success, and exits the branch when the budget is spent. |
| `sprint_correct` | llm | Applies the evaluator's and the gates' feedback to the working tree, then hands back to the generator for the next attempt. |
| `sprint_review` | llm | Advisory code review of a passing sprint diff against the contract and the anti-pattern catalogue. |
| `sprint_exit` | tool | Records the branch verdict and flushes the contract's artifacts; the single per-branch termination point. |
| `gate_sprint_out` | gate | Boundary gate releasing one settled branch out of the sprint subgraph; the subgraph's declared exit gate. |
<!-- /pge:nodes -->

## The gates

Thirteen nodes have kind `gate`. Each carries a `gate` block with a `check` (the named
predicate the runtime evaluates) and an `onFail` endpoint (where control goes when the
predicate is false — gates fail **closed**, never through). Three of them additionally
carry a human-in-the-loop checkpoint.

**What a gate validates** is the schema on its input ports: a gate with
`inputPorts: [{ key: "verdict", schemaRef: "SprintVerdict" }]` validates a sprint verdict
on the way in. Six gates declare **no ports at all** — that is data, not a gap: those
gates are barriers or side-condition checks over channel state
(`branchStatus`, `counters`, `evaluations`, `testAnchors`) rather than value-passing
boundaries, so there is no port payload for them to type.

<!-- pge:gates -->
| gate | region | check | routes to on failure | validates (port key:schema) | human checkpoint |
| --- | --- | --- | --- | --- | --- |
| `gate_anchor_regression` | sprint | `anchor-tests-still-green` | `sprint_correct` | verdict:SprintVerdict | (none) |
| `gate_eval_in` | root | `all-sprints-settled` | `graceful_failure` | (none) | (none) |
| `gate_mock_coverage` | sprint | `mock-coverage-threshold` | `sprint_curate_mocks` | (none) | (none) |
| `gate_plan_in` | root | `research-digest-present` | `graceful_failure` | brief:ResearchDigest | (none) |
| `gate_plan_out` | root | `spec-and-contracts-persisted` | `graceful_failure` | contracts:SprintContract | post-sprint-contract |
| `gate_research_in` | research | `feature-request-present` | `graceful_failure` | request:FeatureRequest | (none) |
| `gate_research_out` | research | `research-document-written` | `graceful_failure` | digest:ResearchDigest | (none) |
| `gate_sprint_in` | sprint | `contract-admissible` | `sprint_exit` | contract:SprintContract | (none) |
| `gate_sprint_out` | sprint | `branch-verdicts-recorded` | `graceful_failure` | (none) | (none) |
| `gate_syntax` | sprint | `typecheck-and-lint` | `sprint_correct` | (none) | (none) |
| `hitl_commit` | root | `human-approval` | `graceful_failure` | (none) | end-of-pipeline |
| `plan_clarify` | root | `clarifications-answered` | `graceful_failure` | draft:PlanSpec | post-plan |
| `reduce_sprints` | root | `all-branches-settled` | `fanout_sprints` | (none) | (none) |
<!-- /pge:gates -->

Notes a reader will want:

- **Nine of the thirteen fail to a terminal.** Eight route to `graceful_failure`, the run
  terminal, which ends the run without a commit; `gate_sprint_in` routes to `sprint_exit`,
  the per-branch terminal, so an inadmissible contract loses its branch and not the run.
  Only four gates fail into ordinary work: the two that fail to `sprint_correct` (a syntax
  break or an anchor regression is a fixable defect, not a dead run), `gate_mock_coverage`
  which fails back to the mock curator, and `reduce_sprints` which fails back to the
  fan-out to retry a failed branch.
- **`reduce_sprints` failing to `fanout_sprints` is a cycle**, and it is the only gate
  whose `onFail` creates one. That is why the barrier carries its own loop bound.
- **All three human checkpoints name a checkpoint id that the shipped pipeline actually
  fires** — `post-plan`, `post-sprint-contract` and `end-of-pipeline`. Earlier revisions
  of the artifact invented ids (`plan-clarify`, `hitl-commit`) that no mechanism
  answered, which made the gates unrunnable; see the [Changelog](#changelog) entry for
  1.2.0. `post-sprint-contract` was declared in 1.5.0 — see that entry for why
  `gate_plan_out`, not `plan_materialize`, is the legal host.
- `plan_clarify`, `hitl_commit` and `gate_plan_out` all declare `onReject:
  graceful_failure` and declare **no effects**. An approval node that also wrote
  something could half-apply a rejected decision; separating the approval from the
  effect is what makes rejection total.

## The loop bounds

**Loop bounds live on nodes, not on edges.** No edge in this artifact carries loop
metadata; the edge record is only `from`, `to`, `kind`, `label`, `ports`. Eight nodes
carry a `loop` block naming a counter key, a maximum number of iterations and the node to
fall through to once the maximum is reached. Every cycle in the graph contains at least
one of them — that invariant is pinned in `src/pge/topology/coding.graph.test.ts`
("bounds every cycle with a declared loop").

<!-- pge:loops -->
| node | kind | counterKey | maxIterations | onExhausted |
| --- | --- | --- | --- | --- |
| `gate_mock_coverage` | gate | `mockCurationRounds` | 2 | `sprint_exit` |
| `plan_clarify_check` | router | `planClarifyRounds` | 3 | `graceful_failure` |
| `reduce_sprints` | gate | `fanoutRetries` | 2 | `graceful_failure` |
| `research_route` | router | `researchReflexions` | 3 | `research_collect` |
| `rework_route` | router | `reworkRounds` | 2 | `graceful_failure` |
| `sprint_correct` | llm | `sprintIterations` | 3 | `sprint_exit` |
| `sprint_route` | router | `sprintIterations` | 3 | `sprint_exit` |
| `supervisor` | router | `supervisorRounds` | 12 | `graceful_failure` |
<!-- /pge:loops -->

### The counter-to-node mapping is 1:N, not 1:1

Eight nodes carry a loop bound but they name only **seven distinct counter keys**.
`sprint_correct` and `sprint_route` deliberately share `sprintIterations`. The artifact's
own note on the corrector states why:

> The counterKey is deliberately the SAME sprintIterations budget the router spends, so a
> branch gets three correction attempts in total however it got here.

The reason is that not every route into the corrector goes through the router:
`gate_syntax` and `gate_anchor_regression` reach `sprint_correct` directly through their
`onFail`, and those cycles never touch `sprint_route`. Counting them on the same budget is
what stops a branch from getting three router-driven retries *plus* unbounded
gate-driven ones. Do not build a map from counter key to node and expect eight entries;
you get seven keys over eight nodes.

`gate_mock_coverage` is the mirror-image decision and the artifact explains that one too:
its re-curation cycle never reaches `sprint_route`, so borrowing `sprintIterations` would
have let mock curation eat the correction budget. It carries its own.

### Where each loop stops the work

- `researchReflexions` (3) — exhausting it does **not** fail the run; it falls through to
  `research_collect`, so a run always leaves research with whatever was found.
- `planClarifyRounds` (3) — a plan that still has open questions after three human rounds
  is a failed run, not a run that proceeds on guesses.
- `sprintIterations` (3) — three correction attempts per branch, from any route; then the
  branch exits with its verdict recorded rather than the whole run failing.
- `mockCurationRounds` (2) — two re-curations, then the branch exits.
- `fanoutRetries` (2) — two re-dispatches of a failed branch from the barrier. This retry
  re-enters the fan-out **without** passing through the supervisor, so `supervisorRounds`
  does not bound it; without this budget the barrier could re-dispatch for ever.
- `reworkRounds` (2) — two global rework passes after a failed evaluation.
- `supervisorRounds` (12) — the outermost phase budget. Twelve supervisor turns is the
  ceiling on the whole run's phase cycling.

## Routers and outcome labels

A router body selects an **outcome label**, never a node id. The label is bound to a
destination in the router's own `targets`, and the same binding appears on the labelled
edge. That indirection is what makes a structural diff of routing meaningful: a routing
change is visible as a changed binding rather than hidden inside a prompt.

<!-- pge:routers -->
| router | outcome label | routes to |
| --- | --- | --- |
| `fanout_sprints` | dispatch | `sprint_body` |
| `fanout_sprints` | drained | `supervisor` |
| `plan_clarify_check` | clarify | `plan_clarify` |
| `plan_clarify_check` | ok | `plan_materialize` |
| `research_route` | done | `research_collect` |
| `research_route` | retry | `research_explore` |
| `rework_route` | exhausted | `graceful_failure` |
| `rework_route` | rework | `sprint_body` |
| `route_after_eval` | exhausted | `graceful_failure` |
| `route_after_eval` | partial | `synthesize` |
| `route_after_eval` | pass | `documenter` |
| `route_after_eval` | rework | `critique` |
| `sprint_route` | exhausted | `sprint_exit` |
| `sprint_route` | pass | `sprint_review` |
| `sprint_route` | retry | `sprint_correct` |
| `supervisor` | compact | `context_compact` |
| `supervisor` | evaluate | `gate_eval_in` |
| `supervisor` | plan | `gate_plan_in` |
| `supervisor` | sprints | `fanout_sprints` |
<!-- /pge:routers -->

## Edges

56 edges: 37 `normal`, 17 `conditional`, 2 `fanout`. A `conditional` or `fanout` edge
carries the router outcome label that selects it; a `normal` edge is unconditional
sequencing. 15 edges additionally carry a **port binding** — the output port of the source
bound to the input port of the target — which is how a typed value crosses a hop instead
of being fished out of a channel.

Two edges end at the reserved endpoint `END`: the run terminates either through
`finalize` (success) or through `graceful_failure` (no commit).

<!-- pge:edges -->
| from | to | kind | label | port binding |
| --- | --- | --- | --- | --- |
| `commit` | `finalize` | normal | (none) | (none) |
| `context_compact` | `supervisor` | normal | (none) | (none) |
| `critique` | `rework_route` | normal | (none) | (none) |
| `documenter` | `hitl_commit` | normal | (none) | (none) |
| `evaluate_global` | `route_after_eval` | normal | (none) | verdict->verdict |
| `fanout_sprints` | `sprint_body` | fanout | dispatch | (none) |
| `fanout_sprints` | `supervisor` | conditional | drained | (none) |
| `finalize` | `END` | normal | (none) | (none) |
| `gate_anchor_regression` | `sprint_route` | normal | (none) | verdict->verdict |
| `gate_eval_in` | `evaluate_global` | normal | (none) | (none) |
| `gate_mock_coverage` | `sprint_generate` | normal | (none) | (none) |
| `gate_plan_in` | `plan_draft` | normal | (none) | brief->brief |
| `gate_plan_out` | `supervisor` | normal | (none) | (none) |
| `gate_research_in` | `research_reflect` | normal | (none) | request->request |
| `gate_research_out` | `supervisor` | normal | (none) | (none) |
| `gate_sprint_in` | `sprint_curate_explain` | normal | (none) | contract->contract |
| `gate_sprint_out` | `reduce_sprints` | normal | (none) | (none) |
| `gate_syntax` | `sprint_security` | normal | (none) | (none) |
| `graceful_failure` | `END` | normal | (none) | (none) |
| `hitl_commit` | `commit` | normal | (none) | (none) |
| `plan_clarify` | `plan_draft` | normal | (none) | (none) |
| `plan_clarify_check` | `plan_clarify` | conditional | clarify | (none) |
| `plan_clarify_check` | `plan_materialize` | conditional | ok | (none) |
| `plan_draft` | `plan_clarify_check` | normal | (none) | draft->draft |
| `plan_materialize` | `gate_plan_out` | normal | (none) | contracts->contracts |
| `reduce_sprints` | `supervisor` | normal | (none) | (none) |
| `research_body` | `gate_research_in` | normal | (none) | request->request |
| `research_collect` | `gate_research_out` | normal | (none) | digest->digest |
| `research_critique` | `research_route` | normal | (none) | digest->digest |
| `research_explore` | `research_critique` | normal | (none) | digest->digest |
| `research_reflect` | `research_explore` | normal | (none) | digest->digest |
| `research_route` | `research_collect` | conditional | done | (none) |
| `research_route` | `research_explore` | conditional | retry | (none) |
| `rework_route` | `graceful_failure` | conditional | exhausted | (none) |
| `rework_route` | `sprint_body` | fanout | rework | (none) |
| `route_after_eval` | `critique` | conditional | rework | (none) |
| `route_after_eval` | `documenter` | conditional | pass | (none) |
| `route_after_eval` | `graceful_failure` | conditional | exhausted | (none) |
| `route_after_eval` | `synthesize` | conditional | partial | (none) |
| `sprint_body` | `gate_sprint_in` | normal | (none) | contract->contract |
| `sprint_correct` | `sprint_generate` | normal | (none) | (none) |
| `sprint_curate_explain` | `sprint_curate_mocks` | normal | (none) | contract->contract |
| `sprint_curate_mocks` | `gate_mock_coverage` | normal | (none) | (none) |
| `sprint_evaluate` | `gate_anchor_regression` | normal | (none) | verdict->verdict |
| `sprint_exit` | `gate_sprint_out` | normal | (none) | (none) |
| `sprint_generate` | `gate_syntax` | normal | (none) | (none) |
| `sprint_review` | `sprint_exit` | normal | (none) | (none) |
| `sprint_route` | `sprint_correct` | conditional | retry | (none) |
| `sprint_route` | `sprint_exit` | conditional | exhausted | (none) |
| `sprint_route` | `sprint_review` | conditional | pass | (none) |
| `sprint_security` | `sprint_evaluate` | normal | (none) | (none) |
| `supervisor` | `context_compact` | conditional | compact | (none) |
| `supervisor` | `fanout_sprints` | conditional | sprints | (none) |
| `supervisor` | `gate_eval_in` | conditional | evaluate | (none) |
| `supervisor` | `gate_plan_in` | conditional | plan | (none) |
| `synthesize` | `documenter` | normal | (none) | (none) |
<!-- /pge:edges -->

The gate `onFail` endpoints in [The gates](#the-gates) are **not** edges — a fail-closed
route is a property of the gate, not a declared hop — and neither are the `onExhausted`
endpoints in [The loop bounds](#the-loop-bounds). Reading only the edge table therefore
under-states reachability; the failure routes are in those two tables.

## Channels

State is not a blob passed from node to node; it is eleven typed channels, each with a
declared reducer that merges concurrent writes deterministically. `scope: public` means
the channel is visible across regions; the one `private` channel is per-branch bookkeeping.
Three channels are **scalar** — exactly one node may write them — which is what makes the
spec, the latest plan draft and the run verdict single-sourced.

<!-- pge:channels -->
| channel | scope | reducer | schema | written by |
| --- | --- | --- | --- | --- |
| `branchStatus` | private | lastWriteWinsByKey | BranchStatus | gate_anchor_regression, gate_syntax, graceful_failure, sprint_exit, sprint_generate |
| `counters` | public | maxNumber | Counters | context_compact, fanout_sprints, gate_mock_coverage, plan_clarify_check, reduce_sprints, research_reflect, research_route, rework_route, route_after_eval, sprint_correct, sprint_route, supervisor |
| `evaluations` | public | appendById | SprintVerdict | evaluate_global, sprint_evaluate, sprint_review, sprint_security |
| `ledger` | public | mergeLedger | BudgetLedger | critique, documenter, evaluate_global, plan_draft, research_critique, research_explore, research_reflect, sprint_correct, sprint_curate_explain, sprint_curate_mocks, sprint_evaluate, sprint_generate, sprint_review, sprint_security, synthesize |
| `messages` | public | appendById | GraphMessage | commit, context_compact, critique, documenter, evaluate_global, graceful_failure, hitl_commit, plan_clarify, plan_draft, research_collect, research_critique, research_explore, research_reflect, sprint_correct, sprint_curate_explain, sprint_curate_mocks, sprint_evaluate, sprint_generate, sprint_review, sprint_security, synthesize |
| `refs` | public | appendById | ScratchRef | context_compact, documenter, finalize, plan_materialize, research_collect, research_explore, sprint_correct, sprint_curate_explain, sprint_curate_mocks, sprint_generate |
| `spec` | public | replaceIfNewer | PlanSpec | plan_materialize |
| `specDraft` | public | replaceIfNewer | PlanSpec | plan_draft |
| `sprintContracts` | public | appendById | SprintContract | plan_materialize, sprint_exit |
| `testAnchors` | public | setUnion | TestAnchors | sprint_evaluate |
| `verdict` | public | replaceIfNewer | RunVerdict | finalize |
<!-- /pge:channels -->

The `counters` channel is where every loop counter listed in
[The loop bounds](#the-loop-bounds) lives; its `maxNumber` reducer is what makes a counter
monotonic under concurrent branch writes, so two branches incrementing the same key cannot
lose an increment and under-count a budget.

`specDraft`, added `1.4.0`, holds the LATEST plan draft — clarifying or settled — written
by `plan_draft` on every round of the plan region, regardless of whether clarification ever
converges. `commit.finalize` (`src/pge/runtime/commit.ts`) falls back to it when `spec` is
still null at the finalize boundary; see [A defect this coverage work
surfaced](#a-defect-this-coverage-work-surfaced) for what that fixed.

Eight of the eleven channels declare the graph default `maxInlineBytes: 4096`; `spec`
declares 131,072, `sprintContracts` declares 524,288 and `specDraft` declares 65,536 — all
three sized off the committed workload corpus, none by analogy to a schema-identical
sibling (see the `1.3.0` and `1.4.0` changelog entries and [A committed workload
corpus](#a-committed-workload-corpus)). `specDraft`'s corpus maximum is this repository's
own real committed plan restated under the `specDraft` channel — a real payload rather than
an invented one, because `spec` and `specDraft` hold IDENTICAL bytes by construction
whenever clarification settles without a round trip, the common case. Leaving it at the
graph's brand-new-channel default of 4,096 would have silently dropped that exact real
write the moment this channel started being written — the identical defect `1.3.0` fixed
for `spec` itself.
The commit boundary measures a write against a channel's own cap in **canonical** bytes —
`canonicalJson`, `src/pge/runtime/commit.ts` — not in the bytes the value happens to occupy
on disk. A write over the cap is refused with `StateBloatError` and the run continues with
the channel unwritten. The original 4,096-byte default on every channel was measured
against a real plan rather than a fixture and did not survive contact with one; see
[The graph engine against a real workload](#the-graph-engine-against-a-real-workload) for
what raising `spec` and `sprintContracts` did, and did not, fix. Every one of the eleven caps
above now also has an OBSERVED number — the largest single write a real run actually asked the
boundary to commit, recorded per channel in the committed measurement; see [Every channel and
every node this real run touches](#every-channel-and-every-node-this-real-run-touches--sprint-10),
including what that observation does and does not prove.

## The golden dataset: what it proves and what it does not

`.bober/golden/` holds regression cases: an input, the **pinned provider responses** for
that input, and the expected artifacts. The regression runner replays each case with every
outward call answered from the recording and compares the artifacts produced.

Every case declares, in its own file, how it is **enforced** — there is no default,
because both possible defaults are wrong:

| `enforcement` | what happens to it | where its expectation came from | what a behaviour change demands of it |
| --- | --- | --- | --- |
| `replay` | **executed** against the shipped `PgeEngine` over the committed artifact, and its artifacts compared with the expectation | captured from a real run by `src/pge/golden/capture.ts` | a **re-CAPTURE** — mechanical (`GOLDEN_CAPTURE=1`), and the resulting diff is the statement of what moved |
| `integrity` | checked for schema validity and against the committed graph; **not executed**, and it makes no runtime claim | hand-authored prose plus a partial pin set | a **re-AUTHOR** — a judgement call, sentence by sentence; it **cannot be re-captured at all** |

The last column is the one that gets forgotten, so it is stated here rather than only in the
worked example below. A `replay` case that goes red is a question for the runtime, and the
maintenance path is to re-record it. An `integrity` case that goes *false* is a question for a
writer: replaying it would throw `MissingRecordingError` at the first call its partial pin set
does not answer, so no rerun can repair its prose, and **nothing in CI can tell you it needs
repairing** — nothing executes it, and English is not schema-checked. Its `title`, `intent`,
`tags`, `notes` **and its caseId** are all claims, and only the pins are machine-checked.
Sprints 5, 7 and 8 of `spec-20260812-pge-real-workload-errors` are the worked example of both
halves: two recaptures, then two re-authorings of the cases the same change had falsified.

**A caseId is a claim too, and correcting one is a rename, not an edit.** A case named for
behaviour the runtime has falsified is worse than a stale comment, because the filename is what a
reader greps for. `validateGoldenDataset` requires every file to be named `${caseId}.json`
(`src/pge/golden/runner.ts:394-397` — *"a case whose id and filename disagree cannot be found from
a failure message"*), so fixing one means a new file plus a deletion of the old, and the pinned
artifact block should be verified byte-identical across the move or the rename has quietly become
an unreviewed recapture.

The split exists because the two kinds of case are not interchangeable. A hand-authored
case pins the calls a reader would find interesting rather than the complete call sequence
a run makes, so replaying one throws `MissingRecordingError` at the first call its author
did not think to write down — which says nothing whatsoever about the runtime. A captured
case is complete by construction. Running the hand-authored cases against a real engine
would make the blocking job permanently red, and a permanently-red required job is waived
within a week, taking the enforced half with it.

**The guarantee is "an unpinned call cannot produce a passing case" — not "the executor
throws".** Those stopped being the same sentence at `1.4.0`. The replay registry still raises
`MissingRecordingError` at the call it cannot answer, but the interpreter treats that as a failed
node and routes onwards, so what reaches the caller depends on how much of the pipeline the
truncation left standing: truncated before `plan_draft` ever runs, `finalize` still throws
`FinalizeWithoutSpecError`; truncated after it, sprint 7's `specDraft` fallback **resolves** with
`success: false` instead. `src/pge/golden/executor.test.ts` therefore asserts `passed === false`
through `runGoldenRegression` — the same per-case logic the CI job runs — rather than pinning a
throw, which would have been pinning where a truncation happens to land.

What stops the split from eroding is a **floor**: `GOLDEN_MIN_REPLAY_CASES` in
`src/pge/golden/case-schema.ts`, checked as part of dataset validity. Relabelling a failing
`replay` case as `integrity` to get a green build drops the count below the floor and fails
the dataset check itself, so the only ways to make a failing case green are to fix the
runtime or to re-capture it — and a re-capture is a visible diff that says which artifacts
changed.

### How much of the graph the committed cases execute

(The heading used to read *"…the executed cases reach"*. Since sprint 9 of
`spec-20260812-pge-real-workload-errors` this section turns on the difference between
REACHED and EXECUTED, so the word that names the figure had to stop being the wrong one.)

The case count is the wrong number to judge this dataset by: five cases that walk the same
happy path enforce one path. The number that matters is **node coverage**, and it is
measured rather than asserted — `src/pge/golden/coverage.test.ts` executes every committed
`replay` case, reads the node ids and the STATUS of the resulting span files, and pins the
executed set against the committed artifact.

**42 of the 44 declared nodes execute, as of sprint 8 of `spec-20260814-pge-full-convergence`
(reconfirmed, unmoved, by sprint 9 — see "What that implied for the two sprints that inherit
it" below).**

> **This figure is the DATASET's, and it is not the same number as one real run's.** Sprint 10
> of `spec-20260814-pge-full-convergence` measured a single real-workload run's own coverage at
> **36 of 44** ([Every channel and every node this real run
> touches](#every-channel-and-every-node-this-real-run-touches--sprint-10)). The gap is not a
> regression and the two are not comparable: a golden dataset is many cases engineered to reach
> every region, one real run is one path. Six of that run's eight misses are workload-specific
> and provably execute somewhere in THIS dataset — which is exactly what the pin below
> guarantees, since the dataset's missing set is exactly `context_compact` and `synthesize`.

The figure moved three times, and each move is worth separating. Sprint 9 of
`spec-20260812-pge-real-workload-errors` corrected the RULE — the committed figure before
that sprint read **"39 of the 44"**, and the drop to **"38 of the 44"** was a correction, not
a regression: the earlier rule counted a node as executed the moment its `nodeId` appeared in
a span, with no check of that span's `status`, so `commit`'s FAIL_CLOSED refusal (which still
opens a span, ending `{ status: "interrupted", errorClass: "FailClosed" }` before the node's
own body is ever entered) counted as coverage on the strength of a REFUSAL. **The corrected
rule requires at least one span with `status: "ok"`.**

Sprint 2 of `spec-20260814-pge-full-convergence` then moved the COUNT, from 38 to 40, by
giving `commit` an actual `"ok"` span rather than by touching the rule again: a seventh
`replay` case, `replay-full-run-commit-approved`, pins the same scenario
`replay-full-run-evaluation-passes` does but executed under `goldenApprovedConfig()`
(`src/pge/golden/executor.ts`) instead of `goldenConfig()` — `end-of-pipeline` resolves to
the real, unmodified `DiskCheckpointMechanism` and a real approval answers it while the run
is blocked, so `commit`'s body runs its one `git.commit` call for real (against a throwaway
run root, never this checkout — see `withGoldenApproval` in that file) and `finalize` is
reached immediately after. `commit` was REACHED by four of the (then six) committed `replay`
cases before this — the `hitl_commit` gate that precedes it admits every one of them — but
never EXECUTED, and the two remained different claims until this case existed.

Sprint 8 of `spec-20260814-pge-full-convergence` moved the count again, from 40 to 42, by
closing the gap `critique` and `rework_route` were then filed under: **missing scenario, not
a structural block.** `replay-corrected-sprint-still-grades-fail` exploits an asymmetry
between two rules that both read the same evaluation history and disagree — `branchOutcome`
(`nodes/sprint-review.ts`) settles a branch on its LAST decisive verdict, so a branch that
fails once and then passes settles `"succeeded"`, while `gradeContracts` (`nodes/root.ts`)
reduces over every recorded verdict and lets one `"fail"` row outrank a later `"pass"`
permanently. A branch that needed one correction round therefore settles `"succeeded"` (so
`reduce_sprints` admits it) while its contract stays graded `"fail"` forever (so
`evaluate_global` returns non-pass), and `route_after_eval` selects `"rework"` — reaching
`critique`, and through its sole successor edge, `rework_route`. That successor relationship
means the two nodes could not be closed independently: `rework_route`'s own dispatch set is
always empty by the time it runs (`reduce_sprints`'s gate already guarantees every dispatched
branch is `"succeeded"`, which `dispatchableContracts` excludes), so it selects `"exhausted"`
rather than re-offering the branch, still ending a `status: "ok"` span. The contract this
sprint executed against had a nonGoal asking for `rework_route` to stay out of scope; it was
recorded, ahead of implementation, as structurally unsatisfiable — forced by the graph's
topology rather than a scope choice — and honoured by shrinking scope for the sprint that
follows rather than by contriving a case that reaches `critique` without also reaching
`rework_route`.

The two nodes no case executes are pinned in `NEVER_EXECUTED`. Both are genuine
**structural blocks** — no set of bindings, however imaginative, can reach them:

| node | why no case executes it |
| --- | --- |
| `context_compact` | its only edge in is `supervisor -> context_compact` under the `compact` label, and the shipped supervisor's handler (`nodes/supervisor.ts:140-177`) has **no code path that returns that label at all** — its five branches select `plan`, `sprints`, `evaluate`, the graceful-failure hop for a refusal, or end the run; `COMPACT_LABEL` is declared and referenced nowhere else in `src/`. The committed artifact's `supervisor.reads` — exactly `["branchStatus", "counters", "evaluations", "spec"]`, still no `messages` at `graphVersion 1.5.0`, re-verified for sprint 8 — is WHY no such path exists: a supervisor cannot decide a message window crossed a compression threshold without reading the messages. The block is therefore at LABEL SELECTION, one step upstream of the node itself — `contextCompactNode`'s own body would return a `status: "ok"` span even below its threshold if it were ever entered, so this is not a token-threshold problem and enlarging a case's message count changes nothing. What would close it — teaching the supervisor to measure the window and select `COMPACT_LABEL`, which first requires adding `messages` to `supervisor.reads` — is a topology change (a minor `graphVersion` bump) plus a shipped-code change, not a case. Recorded as artifact drift in `nodes/supervisor.ts`, and backed by a claim test in `nodes/supervisor.test.ts` that fails the moment the handler gains a path returning `COMPACT_LABEL`. |
| `synthesize` | **structural block, and the one recorded reason sprint 9 of spec-20260812-pge-real-workload-errors rewrote.** Reachable only via `route_after_eval`'s `partial` label, which needs a SECOND invocation of `route_after_eval` with its rework counter at the declared bound of 2 — and that second invocation never happens. `rework_route` reads the identical counter and bound the interpreter enforces on `rework_route` itself, and because `rework_route`'s dispatch set is always empty when it runs (previous paragraph), it never selects its own `"rework"` fan-out — the one edge that would loop back and reach `evaluate_global` again — so it always exits straight to `graceful_failure` on its first and only invocation per run. No golden case can close this; it is dead code by construction. An earlier analysis (sprint 7 of spec-20260812-pge-real-workload-errors) attributed this to `rework_route`'s dispatch set being empty "because nothing ever writes `abandoned`" — the conclusion was right, the mechanism was not: `abandoned` is irrelevant, since the exclusion that actually bites is `"succeeded"`, which every branch already is by the time `rework_route` can run at all. **Sprint 9 of `spec-20260814-pge-full-convergence` genuinely tried to drive this node before accepting the block** (per that sprint's `preFlightFinding` and its own stopCondition), independently re-derived the same conclusion from a SECOND code path — `supervisorNode` itself never selects its `"evaluate"` label while `dispatchableContracts(state, state.sprintContracts)` is non-empty (`nodes/supervisor.ts:165` checks `"sprints"` first), so the all-succeeded state that guard requires is exactly what `rework_route` still sees — and closed the one gap the earlier analysis left open: unlike `context_compact`, whose claim `nodes/supervisor.test.ts` backs with a test, this claim was prose only. `src/pge/nodes/root.test.ts` (new, sprint 9) now backs it the same way, in four mutation-proven pieces, and separately proves `evalRouterNode`'s `"partial"`/`"exhausted"` branches are themselves correctly implemented — unlike `context_compact`'s label-selection code, which does not exist at all, the precondition is what is unreachable here, not the code that would react to it. Node coverage did not move: still 42/44. |

The pin is **two-directional**, like the conformance divergence set: a node that stops being
executed fails, and a node that *starts* being executed fails too — because each entry above
is a claim about why something is unreachable, and a node leaving the list means one of
those claims stopped being true and the explanation should be deleted deliberately. Sprint 9
of spec-20260812-pge-real-workload-errors proved both directions by mutation against
synthetic spans rather than only against the real dataset — `src/pge/golden/coverage.test.ts`'s
"the status-ok rule, mutated in both directions" block — because the real dataset can only
ever demonstrate the direction its own cases happen to exercise. Sprint 2 of
`spec-20260814-pge-full-convergence` is one concrete instance the mutation-proof anticipated,
where `commit` and `finalize` left the list because the claim behind their membership
stopped being true; sprint 8 is a second, independent instance, adding a control that proves
the guard bites for `critique` re-entering the list and for `context_compact` leaving it, each
by injecting a synthetic span rather than by driving the real golden executor.

With the corrected rule, `42 / 44 ≈ 95.5%` still clears the dataset's own floor of "strictly
greater than 85%" (`covers a substantial majority of the graph, so the pin is not vacuous`,
same file) without that floor moving — NFR0 forbids lowering a gate to protect a number, and
neither the sprint that moved the count to 40 nor the one that moved it to 42 needed to. The
sprint-8 evaluator checked the diff for exactly that: the `0.85` comparison
(`src/pge/golden/coverage.test.ts:272`) is untouched, and **no production `.ts` file changed
at all** — the figure rose because a case was written that exercises behaviour the shipped
graph already had, not because anything about the graph, the interpreter or the coverage rule
moved.

**These are TOPOLOGY findings, not coverage footnotes — and `spec-20260814-pge-full-convergence`
has now produced FOUR of them.** `context_compact` (sprint 8) was the third; `synthesize`
(sprint 9) is the fourth, established by a sprint that tried to drive the node before accepting
the block rather than inheriting sprint 8's finding by assumption. The four are worth reading
together, because they are the same KIND of finding and nothing else in this document places
them side by side:

| where | limit | what the shipped architecture cannot express | cost to close |
| --- | --- | --- | --- |
| sprint 1/3 → ADR-1 | `audits` — five checkpoint ids permanently undeclarable | a per-branch interrupt inside a fan-out: `Checkpoint.interrupt` is one slot, and `grantScope`/`clearScope`/`resumeMessageId` carry no branch key (`.bober/architecture/arch-20260814-pge-full-convergence-adr-1.md`) | a keyed, branch-aware interrupt slot plus branch discriminators through the resume path — a runtime redesign |
| sprint 6 | `pipelineResult.errors` | an imperative-engine write site for a FAIL_CLOSED refusal — no interpreter, and an auto-commit (`src/orchestrator/pipeline.ts:451`) that calls `commitAll` inside a `try`/`catch` which only debug-logs, with no HITL gate to refuse | giving the imperative engine a checkpoint-gated commit — an architecture change |
| sprint 8 | `context_compact` unreachable | a supervisor decision that reads the message window: no handler path returns `COMPACT_LABEL`, and `supervisor.reads` does not authorise `messages` | a topology reads-list change + a minor `graphVersion` bump + new handler logic |
| sprint 9 | `synthesize` unreachable | the PRECONDITION its one inbound edge needs: `route_after_eval` selects `partial` only at `reworkRoundsTaken >= 2`, and two independent barriers stop any run reaching a second `route_after_eval` — the supervisor checks `sprints` strictly before `evaluate` (`nodes/supervisor.ts:165`), and `reduce_sprints` refuses any run holding a badly-settled branch (`nodes/gates.ts:1001-1028`). Unlike `context_compact`, the reacting CODE exists and is correct — `evalRouterNode`'s `partial`/`exhausted` branches are proven right against synthetic state — it is simply never fed the precondition | a production change to how the graph DECIDES: the supervisor's dispatch order, or `reduce_sprints`' refusal predicate. No case, binding, seed or fixture substitutes for either |

What makes them one kind rather than four coincidences: each was established by RUNNING or
reading the shipped system rather than by assuming (the `context_compact` block was confirmed
against a fresh trace, `pipelineResult.errors` by running the harness after the fix that was
supposed to close it, `synthesize` by attacking SEVEN candidate paths to the node and finding
none); each was RECORDED rather than worked around, on the authority of the owning contract's
own stop condition; each carries a named, non-trivial cost in **shipped production code** that
no case, binding, seed or fixture can substitute for; and in each the implementation was right
while the CONTRACT's premise was wrong, which is why all four were adjudicated `pass-AMENDED`
rather than sent back for a retry. Read together they say something about how this spec was
scoped — it assumed missing writers and missing cases everywhere, and in four places the answer
was a missing capability.

**What that implied for the two sprints that inherit it.** Sprint 9's real remaining target was
`synthesize` alone: its `sc-9-1` (`rework_route` executes) was satisfied by sprint 8, forced by
topology. Its `sc-9-3` ("`NEVER_EXECUTED` is empty") and `sc-9-4` ("every node in the committed
topology executed") were **unsatisfiable as literally written**, because `context_compact`
cannot execute without production code that does not exist; the amended intent recorded on that
contract was the honest form — `NEVER_EXECUTED` contains ONLY nodes proven structurally
unreachable, each with a recorded reason and a claim test, and coverage asserts every node
executes EXCEPT those, computed against the topology artifact rather than a hardcoded count,
with the guard still biting in BOTH directions. **Deleting the guard is not a way to satisfy
the criterion.** Sprint 11 therefore owned three unsatisfiable-as-written criteria rather than
one — `sc-11-1` (`equivalent: true`, "Engine migration disposition" below) plus these two — and
the satisfiable work in each case is the same: re-specify the bar around a named, accepted,
individually-justified exception set rather than around emptiness. **Sprint 9 closed its own
two against that amended form**, so what sprint 11 actually inherits is `sc-11-1` alone plus
the write-up — see "What four structural limits mean for sprint 11's `sc-11-1`" below.

**Sprint 9's own outcome.** Both amended criteria are now met against that re-specified bar:
`sc-9-1` reconfirmed (`rework_route` still executes, unchanged since sprint 8); `synthesize`
investigated on its own merits rather than assumed structurally blocked by inheritance, and
independently reconfirmed unreachable from a second code path (the table row above); coverage
computed against the artifact, unchanged at 42/44; the two-directional guard proven to bite —
by mutation, not assertion — three ways: `nodes/supervisor.ts:165`'s dispatch-order guard
reverted (`CLAIM 1`), `reworkRouterNode`'s own `"exhausted"` branch disabled (`CLAIM 3`), and a
committed golden case removed in a scratch edit, each restored after confirming red
(`src/pge/nodes/root.test.ts`, `src/pge/golden/coverage.test.ts`). Node coverage did not move,
and was not expected to: no production `.ts` file's runtime behaviour changed, only a new test
file and doc-comment additions that back a claim already recorded.

**The SECOND proof chain for `synthesize`, and the one gap in it.** The sprint-9 evaluator
re-derived the block through two independent chains, not one, and the second is worth recording
in its own right because it holds for a completely different reason:

- **Chain A — dispatch order (ENCODED as tests).** `supervisorNode` checks `SPRINTS_LABEL`
  strictly before `EVALUATE_LABEL` (`nodes/supervisor.ts:165`), so the only state
  `evaluate_global` is ever dispatched from is one where every planned contract has settled
  `"succeeded"`; and `evaluate_global`, `route_after_eval` and `critique` declare writes of
  exactly `["messages","evaluations","ledger"]`, `["counters"]` and `["messages","ledger"]` —
  none of them touches `sprintContracts` or `branchStatus` — so that state is EXACTLY what
  `rework_route` inspects. This is what `src/pge/nodes/root.test.ts`'s four `CLAIM` blocks
  encode.
- **Chain B — `reduce_sprints`' refusal (ARGUED, NOT encoded as a test).**
  `reduceSprintsGate` (`nodes/gates.ts:1001-1028`) refuses — routing back to `fanout_sprints`,
  **not** to `supervisor` — whenever ANY `branchStatus` entry is `"failed"` or `"abandoned"`,
  and its own `fanoutRetries` budget (`coding.graph.ts:791`, `maxIterations: 2`,
  `onExhausted: "graceful_failure"`) degrades straight to the failure terminal once spent.
  `sprint_exit` is the ONLY node that writes a new terminal `branchStatus`
  (`nodes/sprint-review.ts`), and `"abandoned"` is grep-verified as never written by any
  production `.ts` — every non-test occurrence is a read or a filter. So **every branch is
  provably `"succeeded"` by the time a run can reach `evaluate_global` at all**: a run still
  holding a bad branch never passes the join, it is re-fanned-out twice and then ends at
  `graceful_failure`.

Either chain alone is sufficient. `maxIterations: 2` on `rework_route` (`coding.graph.ts:872`)
is a fixed topology constant rather than a `bober.config.json` knob, and moot either way — both
blocks sit upstream of the loop bound entirely. The apparent contradiction in `CLAIM 3`'s
negative control is reconciled by chain B: `reworkRouterNode` genuinely CAN select `"rework"`
given a `"failed"` `branchStatus` entry, and that state provably never arises at `rework_route`.

**The gap, stated plainly: chain B is not backed by a test.** The four `CLAIM` blocks cover
chain A only; chain B lives in prose here, in `coverage.test.ts`'s doc block and in sprint 9's
eval result. If `reduce_sprints`' refusal predicate were relaxed, or a production writer began
setting `"abandoned"`, chain B would stop holding and nothing would report it — and because
chain A would still hold, the `NEVER_EXECUTED` entry would remain correct, which is precisely
what makes the silence easy to miss. Encoding it (a gate-predicate claim test beside the
existing ones, plus a source scan for `"abandoned"` writers) is the obvious follow-up.

**What four structural limits mean for sprint 11's `sc-11-1`.** That criterion asks the
conformance harness to report `equivalent: true` on a real run. It is **unsatisfiable by
building** — not "not yet built". The divergence set is `["audits", "pipelineResult"]`, both
entries architectural and both tracing to one root cause (the graph has a checkpoint-gated
commit the imperative engine lacks), and no further implementation inside this spec's scope
moves either. The same is true one level away for node coverage: **`NEVER_EXECUTED` will not
empty and coverage will not reach 44/44**, because `context_compact` and `synthesize` are
blocked by shipped-code and decision-order facts rather than by missing cases. Sprint 11's
satisfiable work is the re-specification its `sc-11-3`/`sc-11-5` already ask for — name the
accepted exception set, justify each member individually, and phrase the bar around it rather
than around emptiness. Anything that appears to satisfy `sc-11-1`, or to empty
`NEVER_EXECUTED`, without the production changes named in the table above should be treated as
a contrivance and rejected.

### A defect this coverage work surfaced

**Fixed at `1.4.0`.** A planner that kept asking for clarification exhausted `planClarifyRounds` and reached
`graceful_failure` **with `state.spec` still null**, and `commit.finalize` then threw
`FinalizeWithoutSpecError` instead of returning a failed `PipelineResult`. An unattended run
whose plan never settled therefore crashed the engine rather than reporting a failure. This
was not the clarification path's only route to the symptom: a separate measurement against a
real plan — [The graph engine against a real workload](#the-graph-engine-against-a-real-workload) —
reached the identical terminal, with `state.spec` null and the identical throw, on a planner
that settled on its first answer but whose spec was too large for the channel to accept.
Sprint 3 of spec-20260812-pge-real-workload-errors closed that second route by sizing the
`spec`/`sprintContracts` caps off a real corpus; the `planClarifyRounds` route above was the
one still open, and the obvious fix for it — adding `spec` to a second node's `writes` — is
**structurally illegal**: `spec`'s reducer `replaceIfNewer` is declared scalar
(`src/contracts/topology.ts:133`) and the validator emits `MultipleWritersOnScalarChannel` at
severity `error` for any scalar channel with more than one writer
(`src/pge/topology/validate.ts:704-716`).

**Sprint 7 of spec-20260812-pge-real-workload-errors fixed it with a new channel instead.**
`specDraft` (`1.4.0`, see [Channels](#channels)) is a second scalar `PlanSpec` channel, sole
writer `plan_draft`, written on EVERY round of the plan region — clarifying or settled — so a
run whose `planClarifyRounds` budget runs out still leaves a draft behind even though
`plan_materialize` never ran. `commit.finalize` (`src/pge/runtime/commit.ts`) now falls back
to `state.specDraft` when `state.spec` is null: the run RESOLVES with `success: false`,
`needsClarification: true` and a populated `errors` array (layered onto the returned
`PipelineResult` by `PgeEngine.run` from the interpreter's own `LoopExhausted` `TaskFailure`
— sprint 5's machinery, unmodified) instead of throwing. `FinalizeWithoutSpecError` is
NARROWED, not deleted: it is reachable only when NEITHER `spec` NOR `specDraft` was ever
written — a run that never dispatched `plan_draft` at all.

**The case the old crash made impossible to record is now captured.** The committed
`replay-plan-clarification-round` case still drives one clarification round and settles,
which is what puts `plan_clarify` on an executed path; the NEW committed
`replay-plan-clarify-rounds-exhausted` case is the `clarifyingBindings(99)`-style scenario
this section used to say was blocked — a planner that never accepts an answer, driving
`planClarifyRounds` to its declared bound of 3 and reaching `graceful_failure` with a
resolved, failed `PipelineResult` rather than a thrown error. Both cases together put every
node the plan region's clarification loop touches on an executed path, at both ends of the
loop: settling early, and exhausting the bound.

**A permanently-green golden dataset is not evidence of generation quality.** This is a
limitation of the method, not a gap to be closed later. The runtime's own replay module
(`src/pge/runtime/replay.ts`) states it exactly:

> **WHAT A REPLAY REGRESSION-TESTS** — The RUNTIME and the ARTIFACT SHAPE, and nothing
> else. A replay re-executes a recorded run with every outward call answered from the
> recording, so what it proves is that the interpreter, the commit boundary, the reducers
> and the `.bober/` writers still turn the SAME provider answers into the SAME artifacts.
> It says nothing whatsoever about whether those answers were any good — model output
> quality is not observable here and **a replay that "passed" a bad plan is working
> exactly as designed**.

Concretely, a green dataset proves that the interpreter, the reducers, the gates, the
loop counters and the artifact writers behave identically to the recorded run. It proves
nothing about whether the plan was good, the code was right, or the evaluation was fair.
Measuring generation quality needs a benchmark against human judgement, which is
explicitly out of scope for this design.

**A captured expectation is a change detector, not a proof of correctness.** It is
captured from the code under test, so a green `replay` case says the artifacts have not
changed — never that they were right in the first place. That is the strongest claim any
golden dataset can make, and stating it here is what stops it being cited for more.

**Recapture is a deliberate act.** `GOLDEN_CAPTURE=1 npx vitest run
src/pge/golden/capture.test.ts` re-records every `replay` case and rewrites the committed
files; every other run of that test re-captures and asserts the committed bytes are
unchanged, so a case nobody can reproduce fails immediately. The resulting diff IS the
statement "these artifacts changed, and here is how" — a recapture pushed without reading
the diff defeats the gate as surely as deleting it.

Sprint 5 of spec-20260812-pge-real-workload-errors is the worked example of reading one. Adding
`errors` to `PipelineResult` changed the shape of a terminal artifact, so all five `replay` cases
went red at once (**0 of 5**, against the CI gate's 80 % threshold) and the recapture was moved
into the sprint that caused it rather than deferred. The diff was then checked to be exactly what
the change predicted: **52 insertions, zero deletions**, every added key inside a new `errors`
array in `pipelineResult[0]`, no other field moved, and the replay count still exactly
`GOLDEN_MIN_REPLAY_CASES` with no case relabelled `integrity`. It also **corrected the prediction**
— the blast-radius measurement expected four cases (those with a `FailClosed` `commit` span) and
the fifth, `replay-full-run-evaluation-fails`, gained `errors` too, from three `LoopExhausted`
failures, because the field is populated from *any* non-empty failure list rather than from one
`errorClass`. Contrast this with sprint 3's recapture above: that one was a version **stamp**
moving with no artifact change, this one is an artifact change with no version move.

**Two `integrity` cases were RE-AUTHORED, not recaptured, once their prose went false.**
Sprint 5 added `PipelineResult.errors`, which falsified what both hand-authored cases said in
their `title`/`intent` — that the type has no error channel at all. A recapture cannot fix a
hand-authored case (replaying a partial pin set throws `MissingRecordingError` at the first call
its author did not think to write down), so sprint 8 rewrote the prose by judgement instead:

- `pipeline-result-reports-success-with-no-error-channel.json`'s own **caseId and filename**
  asserted the falsehood, not just its prose — a caseId that contradicts the shipped runtime is
  worse than a stale comment, because it is what a reader greps for. It is now
  `pipeline-result-omits-errors-key-on-a-clean-run.json` (new file, old one deleted by the same
  commit), and its claim narrowed to what is still true: a run with nothing to report carries no
  `errors` KEY at all — the OTHER half of the same optional field, not a channel that never
  exists. Its pinned artifact was never wrong (a clean run's shape did not move under sprint 5)
  and is byte-identical to before the rename.
- `commit-refused-fail-closed-under-noop-gate.json` kept its caseId (accurate: the refusal is
  still fail-closed, still under the noop gate) and gained a `pipelineResult` artifact entry
  pinning what sprint 5 and sprint 6 added: `errors` carrying one `PipelineFailure`
  (`nodeId: "commit"`, `errorClass: "FailClosed"`) alongside `success: true` (Option A), plus
  prose naming the two downstream consumers — `bober run`'s exit code and "Refused:" block, and
  the MCP `RunManager`'s `RunState.status: "failed"` — neither of which is a conformance field
  `collectRunArtifacts` collects, so neither is expressible as a pinned artifact; both are named
  in `intent` and left to their own unit tests (`run.test.ts`, `run-manager.test.ts`) to prove.

Both cases stay `enforcement: "integrity"` — re-authoring is orthogonal to what a case claims to
prove, and relabelling either as `replay` would still throw `MissingRecordingError` on the first
call their partial pin sets do not answer.

**A MINOR `graphVersion` bump forces a recapture even though `checkCaseAgainstGraph`'s own
integrity rule is deliberately MAJOR-only, and the two policies genuinely disagree.**
`case-schema.ts`'s major-only rule (:348-357) exists specifically so a minor bump does not
force two dozen files to be rewritten — that is its whole stated reason for being
major-only. But `capture.test.ts`'s "is exactly what a fresh capture produces" check
compares committed bytes to a *fresh* capture, and a fresh capture embeds whatever
`graphVersion` is current at capture time (`capture.ts`, via `CODING_GRAPH.graphVersion`)
into `goldenCase.graph.graphVersion`. So the moment `graphVersion` moves at all — MAJOR or
MINOR — the byte-exact replay comparison goes red on every committed `replay` case, even
though `checkCaseAgainstGraph`'s own major-only rule says the same bump does not
structurally invalidate any of them. Sprint 3 of spec-20260812-pge-real-workload-errors hit
this at `1.2.0 → 1.3.0`: all five committed `replay` cases failed `capture.test.ts` with a
diff of exactly one field, `graph.graphVersion`, and nothing else — confirming the bump
changed no recorded artifact, only the stamp. The resolution taken was to recapture (the
`graph.graphVersion` field is a FACT about what the case validates against, and five files
asserting a version that no longer matches the shipped one is a worse state than a
one-field diff), **not** to weaken `capture.test.ts`'s byte-exact comparison — byte-exactness
is the stronger gate, and NFR0 (spec-20260812-pge-real-workload-errors) forbids weakening a
gate to reach green. The two policies are not reconciled here, only named: `case-schema.ts`
answers "does this version bump invalidate the case's STRUCTURE" (major-only, by design) and
`capture.test.ts` answers "does this version bump invalidate the case's BYTES" (any bump, by
construction) — a change to either check should read this paragraph first, because they are
answering different questions on purpose and making them agree would remove one of the two
signals. **It recurred at `1.3.0 → 1.4.0`** (sprint 7, the `specDraft` channel), exactly as
this paragraph predicts and with the same resolution: the five pre-existing `replay` cases
were recaptured after verifying each diff was confined to the `graph.graphVersion` stamp,
and the sixth case in that recapture is new rather than restamped. Expect this on every
topology bump; it is a cost of the byte-exact gate, not a symptom of anything.

**Growth plan.** The dataset ships at the low end of its 20-to-50 range because each case
is hand-curated content, not generated. It grows on two triggers, and both are cheaper
than authoring cases speculatively:

1. **Every reproducible defect becomes a case.** When a bug in the runtime, a reducer, a
   gate or an artifact writer is fixed, the recording that reproduced it is added, so the
   dataset accumulates exactly the shapes that have actually broken.
2. **Every new node or channel gets at least one case that exercises it.** A node with no
   case is a node whose runtime behaviour is unpinned; the node inventory above is the
   checklist.

Cases are read from the directory at runtime, never from a hardcoded list, so adding a
file is the whole of the work.

### What the blocking CI step enforces

Both halves are live. This section says what each one can and cannot catch, because a
reader who assumed the wrong thing would take a green build for more evidence than it
carries.

**Dataset integrity against the committed graph, for every case.** Every case loads and
parses against the case schema, the directory holds between 20 and 50 files and nothing
else, ids are unique and match their filenames, the dataset keeps its floor of executed
cases, and — the half with teeth over time — every node id and effect name a case pins
still exists in `.bober/topology/coding.json` and in the shipped effect catalog. Renaming a
node or dropping an effect fails this step until the affected cases are re-pinned.

**The runtime pass rate, for every `replay` case.** Each one is executed by
`src/pge/golden/executor.ts`, which is the shipped code path throughout: the engine is
`new PgeEngine(...)` — the object `selectPipelineEngine` returns — the graph is the
committed `.bober/topology/coding.json` copied into a throwaway root, and the reducers,
the commit boundary, the trace writer, the scratch store and all forty-four node bodies are
the shipped ones. The only substitution is at the effect seam, where
`createReplayEffectRegistry` answers from the case's pinned responses and **throws** for
anything else. Two further doors are shut: `withNetworkDisabled` installs a `fetch` that
throws, and every collaborator binding is bound to a function that throws — so reaching a
shipped agent fails the case by name rather than quietly calling a model. The artifacts are
read back through `collectRunArtifacts`, the same collection `EngineConformanceHarness`
uses, so "identical" means one thing in this repository.

A replay produces the artifacts the run's own machinery writes — the commit boundary's
channel writes and `finalize`'s terminal writes. It does not produce the artifacts a
collaborator writes from inside an effect (`.bober/briefings/`, `.bober/reviews/`,
`.bober/eval-results/`), because no collaborator runs. `executor.test.ts` asserts their
absence, which is the proof the effect boundary answered from the recording.

**The executor is not optional.** An earlier revision of this sprint ran the pass-rate half
only when a `GoldenExecutor` was injected, and the CI script looked for one in
`dist/pge/golden/executor.js` — a module nobody had written. The job therefore enforced
dataset shape alone while its name claimed a regression pass rate, and the pass-rate branch
was reachable from unit tests and from nowhere else. The gate now builds the real executor
itself and there is no spelling of its options that runs the dataset half alone; a caller
that genuinely wants validation without execution calls `validateGoldenDataset` and says so
in its own name. `src/pge/topology/ci-gate.test.ts` fails if that wiring is removed again.

The one alternative worth naming, because it is tempting: an executor that echoed each
case's own expectation back would make every case pass for ever — a gate that cannot fail,
which is worse than no gate because it reads as coverage.

The threshold arithmetic is pinned by unit tests at 79, 80 and 81 percent against a
threshold of 80 — the comparison is strictly greater than, so 80 against 80 fails — and it
is applied to the executed cases, with the log stating that denominator explicitly so a
pass rate over the executed cases can never read as a pass rate over the whole dataset —
the runner prints both counts on every run. The decision and
both of its branches live in `src/pge/golden/gate.ts`, under test in
`src/pge/golden/gate.test.ts` and `src/pge/golden/executor.test.ts`, deliberately not in the
`.mjs` script: a script is invisible to `tsc`, to ESLint and to Vitest, so a rule
implemented there is a rule no negative control can reach.

### The six blocking checks, and the test that proves each one bites

A gate that exists but cannot fail is worse than no gate, because it reads as coverage
while granting none. Each check the `pge-graph-gate` job runs therefore has a test that
deliberately breaks its precondition and asserts a **non-zero** exit:

| check | what it catches | negative control |
| --- | --- | --- |
| `pge dump --check` | a stale committed artifact | `src/cli/commands/pge.test.ts` — "exits non-zero after a single-character mutation and does not repair the file" |
| `pge validate --mode full` | an invalid artifact | `src/cli/commands/pge.test.ts` — "exits non-zero and prints EXACTLY that code for the $code fixture", parameterised over all 32 diagnostic codes |
| `pge docs --check` | an undocumented or phantom node | `src/cli/commands/pge.test.ts` — "exits non-zero when a declared node is missing from the default document" (and its mirror for a documented node that does not exist, and for an absent document) |
| `pge diff --require-version-bump` | a structural change with no version bump | `src/cli/commands/pge.test.ts` — "FAILS when the topology changed and graphVersion did not move" (plus "treats a version DOWNGRADE as no bump at all") |
| `pge audit-state` then `git diff --exit-code` | a stale committed state audit | `src/pge/audit-git-gate.test.ts` — "exits non-zero once a drifted audit is committed", which builds a real git repository and drives the pair |
| the golden regression runner (dataset half) | a dataset that has drifted off the graph | `src/pge/golden/gate.test.ts` — "exits non-zero when a case pins a node the graph no longer has" |
| the golden regression runner (runtime half) | a run that stopped producing the same artifacts | `src/pge/golden/executor.test.ts` — "exits non-zero when a committed replay case stops reproducing its expectation", and "exits non-zero when the replay cases are relabelled as integrity" |

The job itself is guarded the same way. `src/pge/topology/ci-gate.test.ts` parses the real
workflow file and fails if `continue-on-error: true` appears in the job, if a job-level
`if:` lets it skip itself, if the workflow stops triggering on pull requests, if the
checkout stops using full history, or if any one of the six commands goes missing — each
proven by mutating an in-memory copy of the file and asserting the audit reports exactly
that violation. `continue-on-error` detection is additionally proven against real data:
the shipped informational `kpi-gate` job sets the key, so reporting `false` for the graph
gate is a measurement rather than a coincidence.

### A negative control can stop biting as the dataset grows, and nothing fails when it does

The two pass-rate controls in the table above — plus `src/pge/golden/dataset.test.ts`'s
equivalent over the runner — inject failures as a **fixed fraction or a fixed count** of the
executed cases, while the threshold they must miss is a fraction of the same growing
denominator. So a control that fails today can be neutralised by nothing more than the dataset
getting bigger. It happened at `1.4.0`. Adding the sixth `replay` case (`replay-plan-clarify-rounds-exhausted`) took
`dataset.test.ts`'s and `gate.test.ts`'s "every fourth case regresses" injection from 1 failure
in 5 — an exact 80 % pass rate, which the strictly-greater-than comparison refuses — to 1 in 6,
a **83 % pass rate that clears the bar**; `executor.test.ts`'s single mutated case moved the same
way. All three controls would have gone on passing while proving nothing, and no test anywhere
would have reported it.

Sprint 7 of spec-20260812-pge-real-workload-errors fixed two of the three in the same commit
that grew the dataset, and the evaluator confirmed the fix by reverting each control and
observing the pre-sprint version produce a **false pass** against the six-case set.
`dataset.test.ts` and `gate.test.ts` now inject a third of the cases (`seen % 3`), which cannot
clear 80 % at any count from the floor upward. `executor.test.ts`'s own control was left as a
fixed count of 2 — its comment claimed that was safe "regardless of how many more cases the
replay set grows to hold", which this section's own arithmetic already contradicted: `(n-2)/n`
crosses 80 % at **n = 11**.

**Sprint 8 fixed the third.** `executor.test.ts`'s negative control now injects the identical
`(index + 1) % 3 === 0` fraction, over ALL replay cases rather than two named ones, mutating
`pipelineResult[0].success` — a field every case's expectation carries exactly one of
(`pipelineResult` is a `SCALAR_ARTIFACT_FIELDS` entry and `PipelineResult.success` is required),
where the previous version mutated `contracts[0].title`, a field one committed case
(`replay-plan-clarify-rounds-exhausted`) does not have at all. At the 6 replay cases the dataset
held then, this drifted exactly 2 of them — the same failure count the fixed-count version
produced — so the fix changed nothing about what that run caught, only whether a future count
keeps catching it. At **7** (sprint 2 of `spec-20260814-pge-full-convergence` added
`replay-full-run-commit-approved`) the fraction still drifted exactly 2, indices 2 and 5 — a
different pair of cases, since the new caseId sorts first, but the same count. At the current
**8** (sprint 8 of the same spec added `replay-corrected-sprint-still-grades-fail`, which sorts
ahead of every other replay caseId) `(index + 1) % 3 === 0` selects indices 2 and 5 once more —
2 of 8, a 75 % pass rate, still comfortably under the bar it must miss, and a different pair
again for the same sorting reason. The comment inside `executor.test.ts` (now at `:378`) still
says "current 6".

**The general rule, for anyone adding a case or a control:** a control whose failure injection
does not scale with `replayCases.length` has a case count at which it silently stops being a
control — compute that number and write it down, or make the injection a fraction. As of the fix
above, no control in this table injects a fixed count; all three are `seen % 3` or its
index-parity equivalent, so none of them has a breakpoint to compute.

## The graph engine against a real workload

Everything the golden dataset enforces, it enforces against fixtures, and fixtures are small:
the largest `PlanSpec`-shaped object anywhere in the committed cases is **1,181 bytes**, so no
case puts a plan-sized value anywhere near the 4,096-byte cap. A green regression job
therefore says nothing at all about what a real plan does to the channels.

That gap is now measured rather than argued. `src/pge/engine/real-workload.test.ts` drives a
real `PgeEngine` over the committed `.bober/topology/coding.json` with this repository's own
committed 14-sprint `PlanSpec` — `spec-20260805-pge-graph-engineering`, the plan that built
this engine — as the planner's output, every effect answered from a stub and `fetch` replaced
by a throwing implementation. Only the planner and materialize collaborators are re-pointed at
the real artifacts; every node body, the reducers, the commit boundary and the trace writer
are the shipped ones. What the run does is committed as data in
`.bober/topology/measurements/real-workload.json`.

**As committed at `graphVersion 1.2.0`, the engine did not execute that plan** — both writes
were rejected. Sprint 3 of spec-20260812-pge-real-workload-errors raised `spec` and
`sprintContracts` off the corpus (see the changelog entry for `1.3.0` and the corpus table
below) and re-ran this exact harness. The rejections were gone, but the run still did not
reach a terminal node — for a different reason: a SECOND, independent ceiling on the
interpreter's own superstep loop. **Sprint 4 diagnosed that ceiling BY MEASUREMENT before
touching it** — running the same harness at two different contract counts (1 and 14) to
distinguish "the ceiling is simply too low for real work" from "something in the fan-out
does not converge" — and found the former: node activity kept advancing through all 14
distinct contracts, every dispatched branch settled `"succeeded"` on its first attempt, and
the cost scaled with the declared cross-contract `dependsOn` graph under
`defaults.concurrency: 1`, not with a stuck loop. `PGE_ENGINE_MAX_SUPERSTEPS`
(`src/pge/engine/pge-engine.ts`) now raises the ceiling `PgeEngine.run` configures to a
measured basis, and **the engine executes this repository's own real plan end to end** —
though not all the way to `finalize` (see below).

| measured, as committed at `graphVersion 1.2.0` (before sprint 3) | value |
| --- | --- |
| `spec` write by `plan_materialize`, superstep 12 | **29,214** canonical bytes against a declared limit of **4,096** — REJECTED |
| `sprintContracts` write by `plan_materialize`, superstep 12 | **135,106** canonical bytes, being the 14 contracts, against **4,096** — REJECTED |
| failures recorded | two, both `StateBloatError` |
| `state.spec` at the finalize boundary | `null` |
| terminal node reached | `graceful_failure` |
| run status / verdict | `completed` / `failed` |
| what `PgeEngine.run` returned | nothing — its own `commit.finalize` threw `FinalizeWithoutSpecError` |

| measured, as committed at `graphVersion 1.3.0` (after sprint 3, before sprint 4) | value |
| --- | --- |
| `spec` write by `plan_materialize`, superstep 12 | **29,214** canonical bytes against a declared limit of **131,072** — admitted |
| `sprintContracts` write by `plan_materialize`, superstep 12 | **135,106** canonical bytes against **524,288** — admitted |
| failures recorded | none — the interpreter itself never returns a result (next row) |
| `GraphRunResult` | never produced: the interpreter throws `SuperstepLimitExceededError` at `DEFAULT_MAX_SUPERSTEPS = 200` (`src/pge/runtime/interpreter.ts:386`, thrown at `:1060`) before reaching a terminal node |
| what `PgeEngine.run` returned | nothing — the same interpreter throw propagates out of `PgeEngine.run` |
| how the committed file recorded it | `engineOutcome: {kind: "threw", errorClass: "SuperstepLimitExceededError"}`, and `rejections` / `failures` / `terminalNodeId` / `status` / `verdict` / `specChannelNullAtBoundary` all **`null`** — there was no `GraphRunResult` to read them off. `verdict: null` was load-bearing beyond this table: see the (now resolved) corpus-rebuild hazard below |

**Sprint 4 measured the ceiling at two contract counts before touching it** — the diagnostic
question the sprint existed to answer, run through the SAME harness
(`src/pge/engine/real-workload.test.ts`) with the interpreter's own `ctx.maxSupersteps`
raised far enough to observe a run end to end:

| contract count | supersteps consumed | terminal node | every branch settled |
| --- | --- | --- | --- |
| 1 (no `dependsOn`) | **39** | `graceful_failure` | 1 of 1, `"succeeded"`, first attempt |
| 14 (this repository's real, `dependsOn`-linked contracts) | **234** | `graceful_failure` | 14 of 14, `"succeeded"`, first attempt |

Those two rows are the committed data — `contractCountScaling` in
`.bober/topology/measurements/real-workload.json`, which also gained the run's own
`supersteps` and a `superstepCeiling` `{configured, measuredBasis, headroomFactor}` record of
the shipped constants in the table below.

The relationship is the whole diagnosis: cost scales with declared work — `(234 − 39) / 13` is
exactly **15 supersteps of marginal cost per additional contract**, not "the same regardless of
count" — node activity advances through every distinct contract rather than repeating one, and
the branch set fully drains rather than stalling. That is **INSUFFICIENT CEILING**, not
NON-CONVERGENCE — the alternative verdict the sprint was equally prepared to record and stop at,
unfixed, had the evidence pointed there. Evaluation re-derived the same relationship
independently at five contract counts rather than two — 1: 39, 4: 84, 7: 129, 10: 174,
14: 234, a marginal 15 at every interval — which is linear in declared work, neither flat (the
signature NON-CONVERGENCE would show) nor unbounded; only the two end points are committed as
data.

(The apparent "extra" trace volume is bookkeeping about waiting, not repeated execution.
`sprint_body` accounts for **1,272** spans in the 14-contract run: **14** with status `ok`, one
per branch, and **1,258** with status `serialized`. A `serialized` span is written once per
deferral — the frontier planner defers a task whose `dependsOn` is unmet before it ever
considers the concurrency cap (`src/pge/runtime/frontier.ts:216-227`), and the interpreter
records that deferral as a span (`recordDeferral`, `src/pge/runtime/interpreter.ts:898`, called
at `:1068` for every deferral whose reason is not `concurrencyCap`), so under
`defaults.concurrency: 1` a blocked task writes one per superstep it stays blocked. Every OTHER
per-branch node in the trace appears exactly once per branch, matching the 1-contract baseline.
That span decomposition was read off the raw trace during evaluation; unlike the numbers in the
tables here, it is not pinned by a committed artifact.)

`PGE_ENGINE_MAX_SUPERSTEPS` (`src/pge/engine/pge-engine.ts`) is now the ceiling `PgeEngine.run`
configures, and it is a MEASURED-basis function, never a hand-picked literal — mirroring
`capForCorpusMax`'s discipline exactly:

| measured, as committed at `graphVersion 1.4.0` (after sprint 4, current — the ceiling and every number below are unchanged by sprint 7's `specDraft` channel, which added no node and no edge) | value |
| --- | --- |
| `MEASURED_REAL_WORKLOAD_SUPERSTEPS` | **234** — the natural completion cost above, pinned in `real-workload.test.ts` against a fresh measurement |
| `SUPERSTEP_HEADROOM_FACTOR` | **2**, the same factor and the same discipline as `CAP_HEADROOM_FACTOR` |
| `PGE_ENGINE_MAX_SUPERSTEPS` | **512** — `superstepsForMeasuredCost(234)`: next power of two at or above `234 × 2`, floored at the interpreter's own `DEFAULT_MAX_SUPERSTEPS` (200) so the function can only ever raise the guard, never lower it |
| failures recorded | exactly one: `{nodeId: "commit", errorClass: "FailClosed", superstep: 232}` |
| `state.spec` / `state.sprintContracts.length` at the boundary | non-null / **14** |
| terminal node reached | `graceful_failure` — **explicitly NOT `finalize`** |
| run status / verdict | `completed` / `partial` (the interpreter's OWN richer verdict, see below — read `"failed"` here before sprint 7 of `spec-20260814-pge-full-convergence`; see [The evidence](#the-evidence) for the `verdictFrom` fix that moved it) |
| what `PgeEngine.run` returned | `success: true` — still, by the Option-A decision — **plus**, as of sprint 5, `errors: [{nodeId: "commit", branchKey: null, errorClass: "FailClosed", message: …}]`, so the refusal does now reach the returned `PipelineResult` even though `success` does not account for it (next paragraph) |

Five consequences a reader should not have to derive:

- **Raising the caps fixed exactly what it was scoped to fix, and nothing more.** The two
  `StateBloatError` rejections are gone — `byteSize(spec) < 131,072` and
  `byteSize(sprintContracts) < 524,288` both hold, proven directly in
  `src/pge/engine/real-workload.test.ts`. What happened to the run AFTER `plan_materialize`
  succeeded was a separate question sprint 3 did not set out to answer.
- **Admitting the writes uncovered a second ceiling, and it was real work, not a bug.** With
  `state.spec` no longer null, the run proceeded into the fan-out across the real 14 sprint
  contracts through the sprint subgraph, and — under `defaults.concurrency: 1` and this
  repository's own genuine cross-contract `dependsOn` graph — that fan-out ran long enough to
  trip the interpreter's runaway guard before any terminal node was reached. The
  `FinalizeWithoutSpecError` crash recorded in [A defect this coverage work
  surfaced](#a-defect-this-coverage-work-surfaced) and the `SuperstepLimitExceededError`
  above were two DIFFERENT defects that happened to share one symptom — "the engine never
  reaches a terminal node" — because the first always cut the run off before the second
  could ever be reached. Both were the same class of gap the 4,096-byte cap itself was: a
  runaway guard's default sized for a workload nothing had ever actually run.
- **The measured, function-derived ceiling closed it.** `PGE_ENGINE_MAX_SUPERSTEPS = 512`
  comfortably covers the measured 234-superstep cost with the same two-directional-pin
  discipline the channel caps use: `real-workload.test.ts` proves the shipped value equals
  `superstepsForMeasuredCost(MEASURED_REAL_WORKLOAD_SUPERSTEPS)` (never a hand-picked
  literal) and separately proves that LOWERING it back to the interpreter's own
  `DEFAULT_MAX_SUPERSTEPS` (200) reproduces `SuperstepLimitExceededError` over the identical
  workload — so the fix is provably necessary, not merely sufficient. `finalize` is still
  not reached — `commit` is still FAIL_CLOSED-refused under the autopilot `noop` mechanism,
  the sprint-13 divergence covered in [How much of the graph the committed cases
  execute](#how-much-of-the-graph-the-committed-cases-execute) — closing that is a durable
  checkpoint mechanism's territory, a later sprint's, not this one's. `commit` itself is
  REACHED on this workload and, since sprint 9 of the same spec, no longer counted as
  covered: its span ends `{ status: "interrupted", errorClass: "FailClosed" }`, never
  `"ok"`.
- **The `commit` refusal now reaches the caller — `success` still does not account for it.**
  `GraphRunResult.verdict` reads `"partial"` (it accounts for the `FailClosed`
  `TaskFailure`, but all 14 dispatched branches settled `"succeeded"` — read `"failed"` here
  before sprint 7 of `spec-20260814-pge-full-convergence` fixed `verdictFrom`'s dead
  `"passed"`-literal comparison; see [The evidence](#the-evidence)), and `PgeEngine.run`'s
  returned `PipelineResult.success` is still `true`,
  still computed from the frozen `deriveRunSuccess` formula shared with the imperative
  engine — sprint-split based, and blind to a terminal-node failure that is not a sprint
  (Option A, spec-20260812-pge-real-workload-errors resolvedClarifications D3). What
  changed in sprint 5 of that spec: `PipelineResult` now carries an optional `errors` field
  populated from the SAME `TaskFailure` records this measurement's `failures` array reads,
  so `success: true` and a non-empty `errors` can now both be true on the SAME
  `PipelineResult` — the caller no longer has to reach through the engine's own
  `interpreterFactory` seam to learn a run refused its commit. This closes the recorded
  limitation named in [Engine migration
  disposition](#engine-migration-disposition). The committed measurement carries both
  halves of the divergence in one file, on real-workload data:
  `failures: [{nodeId: "commit", errorClass: "FailClosed", superstep: 232}]` and
  `verdict: "partial"` sitting next to `engineOutcome: {kind: "resolved", success: true}`; the
  returned `PipelineResult` now additionally carries
  `errors: [{nodeId: "commit", branchKey: null, errorClass: "FailClosed", message: "..."}]`.
- **And as of sprint 6, a person sees it.** An error channel nobody surfaces closes nothing,
  so the two places a human or a CI job actually meets a run now read it: `bober run` sets a
  **non-zero exit code** and prints a `Refused:` block naming each failure's `nodeId` and
  `errorClass` (`src/cli/commands/run.ts:250-261`, a branch *beside* the pre-existing
  `!result.success` check — every `process.exitCode` site in that file only ever writes `1`,
  so the two cannot fight), and the MCP run manager resolves such a run to
  `RunState.status = "failed"` with `RunState.error` populated
  (`src/mcp/run-manager.ts:227-233`) rather than the pre-existing unconditional
  `"completed"`. Neither needed a schema change. **`success` is still `true` on that same
  run** — so a refused MCP run now literally carries `status: "failed"` beside
  `result.success: true`, a disagreement pinned by a test rather than tolerated by accident.
  An operator sees the refusal and a CI job fails on it; a *programmatic* caller reading
  `success` alone is still told the wrong thing, which is the Option-B question this spec
  does not answer.

Re-deriving the measurement is a deliberate act —
`MEASURE_REAL_WORKLOAD=1 npx vitest run src/pge/engine/real-workload.test.ts` rewrites the
committed file, and every other run of that test re-derives it and asserts the committed
bytes are unchanged. The numbers above therefore go red the moment they stop being true, and
the diff is the statement that they changed.

### Every channel and every node this real run touches — sprint 10

Everything above answers "does the run complete" and checks three of eleven channels
(`messages`, `evaluations`, `refs`) against a STATIC corpus payload — real data, but not
data from THIS run, and not every channel. Sprint 10 of `spec-20260814-pge-full-convergence`
closes both gaps directly, in response to a carried finding from that spec's own sprint 5:
`sprint_evaluate` (`src/pge/nodes/sprint-evaluate.ts`) now writes one `evaluations` entry
carrying THREE independent copies of unbounded model text — `summary` (decorated, but
containing the raw evaluator text), `evaluatorFeedback` (`result.summary`, raw) and
`generatorNotes` (`generated.notes`, raw) — a tripling the node's own `bober:` comment names
as a potential `StateBloatError` source once a real (non-stub) evaluator's free text is long
enough. The corpus `evaluations` entries `corpusHeadroom` reads predate all three fields, so
that check cannot see the risk. This section can, because it measures THIS run's own commit
traffic instead.

**`observedWrites`**: `real-workload.test.ts`'s `recordingCommitBoundary` wraps the real
`CommitBoundary` the run drives and records, for every `ChannelUpdate` it sees, `byteSize`
BEFORE the boundary's own accept/reject decision — the exact metric `commit.ts:388-400`
compares against `maxInlineBytes`, repeated for all eleven declared channels rather than
three:

> **Read every number in this table with its caveat attached: the DATA is real, the
> COLLABORATORS are STUBS.** `realWorkloadBindings`
> (`src/pge/engine/__fixtures__/real-workload.ts`) replaces only the planner and materialize
> collaborators — everything downstream is `wholeGraphBindings`' shipped stub set. The bytes
> in the `spec`, `specDraft` and `sprintContracts` rows are this repository's genuine
> committed plan; the bytes in the `evaluations`, `messages` and `ledger` rows are what SHORT
> STUB TEXT costs. The two are not the same kind of evidence, and the paragraph after the
> table says which conclusions each one can carry.

| channel | largest single write (bytes) | writes | declared cap | over cap? |
| --- | --- | --- | --- | --- |
| `branchStatus` | 108 | 28 | 4,096 | no |
| `counters` | 70 | 47 | 4,096 | no |
| `evaluations` | **368** | 43 | 4,096 | **no** |
| `ledger` | 221 | 90 | 4,096 | no |
| `messages` | 267 | 93 | 4,096 | no |
| `refs` | 287 | 46 | 4,096 | no |
| `spec` | 29,214 | 1 | 131,072 | no |
| `specDraft` | 29,214 | 1 | 65,536 | no |
| `sprintContracts` | 135,106 | 15 | 524,288 | no |
| `testAnchors` | 22 | 14 | 4,096 | no |
| `verdict` | 0 | **0** | 4,096 | n/a — never written this run |

**The carried finding did not materialise on this measurement — reported as a fact, not
engineered around.** `evaluations`' largest single write is 368 bytes against a 4,096-byte
cap, comfortably under, even carrying all three copies the `bober:` comment names. Why:
this run's collaborators are the shipped STUB set (`sharedAgents`,
`src/pge/engine/__fixtures__/whole-graph.ts`) — `generator.notes` is the literal string
`` `generated ${contractId}` `` and the stub evaluator's `summary` is the literal
`"all criteria met"` — so even three copies of a few dozen bytes stay two orders of
magnitude under the cap. **This measurement proves the STUB corpus does not breach; it does
NOT prove a real evaluator's longer free-text summary and feedback would not.** The `bober:`
comment's own upgrade path — stop decorating `summary` for the passing case, where it and
`evaluatorFeedback` would then be identical — remains unexercised and is not this sprint's
territory (tuning is an explicit nonGoal). Per this sprint's own stopCondition, had any row
above come back `wouldReject: true`, the obligation was to report the breach here, not raise
the cap that caught it — none did.

**What this measurement can and cannot be cited for.** The split matters enough that a later
flip decision should not have to re-derive it, so it is stated here in the same words the
sprint's evaluation recorded (`realSpec: true`, `realCollaborators: false`):

- **CAN support:** *the graph engine correctly processes this repository's real 29 KB spec and
  14 contracts through 234 supersteps without any channel or superstep-ceiling breach on the
  observed path.* The 29,214-byte figure was re-derived independently, from scratch, with a
  key-sorted `JSON.stringify`.
- **CANNOT support:** *the `evaluations` channel is safe under production (non-stub) evaluator
  output.* That is an OPEN, NAMED risk. Nothing in this section retires it, and no later
  sprint should inherit it as settled.

The precise stub literals, for anyone checking the arithmetic: `generator.notes` is
`` `generated ${contractId}` `` (`src/pge/engine/__fixtures__/whole-graph.ts:284`) and the
evaluator stub's `summary` is `"all criteria met"` (`stubEvaluation`,
`src/pge/nodes/__fixtures__/sprint-harness.ts:222`).

`verdict`'s row reads `writeCount: 0` rather than a false "measured and found small": its
sole writer is `finalize` (`nodes/root.ts`'s own doc comment), and `finalize` is one of the
eight nodes the next table names as not executed on this run — so `verdict`'s 4,096-byte cap
was exercised zero times by this measurement, a fact distinct from headroom.

**`nodeCoverage`**: this run's own spans, filtered to `status: "ok"` — the same rule
`src/pge/golden/coverage.test.ts`'s `executedNodeIdsFromSpans` applies to the golden
dataset — against all 44 declared nodes. **36 of 44 execute; 8 do not**, and this is
DELIBERATELY not the golden dataset's `NEVER_EXECUTED` (`context_compact`, `synthesize`
only, [How much of the graph the committed cases
execute](#how-much-of-the-graph-the-committed-cases-execute)): a golden dataset is many
cases engineered to reach every region, and one real run is one path through the graph, so
it misses every node whose triggering condition this workload's real spec and stub
collaborators never produce, in addition to the two the golden dataset itself cannot reach
by any input:

| node | reached on this run? | why not |
| --- | --- | --- |
| `commit` | reached, span `"interrupted"` | FAIL_CLOSED refusal under the autopilot `noop` mechanism — no durable approval recorded for checkpoint `end-of-pipeline`. The golden dataset's `replay-full-run-commit-approved` case proves `commit` DOES complete `"ok"` under `goldenApprovedConfig()`; this measurement runs the plain `conformanceConfig()`, so this is a fact about this measurement's config, not a structural block. |
| `finalize` | not reached | sole inbound edge is `commit -> finalize` (normal); `commit` never resolves `"ok"` on this run's config, so the edge is never crossed. Same root cause as `commit`, not independent. |
| `critique` | not reached | reachable only via `route_after_eval`'s `rework` label, selected when `evaluate_global`'s verdict is not a pass; this workload's stub evaluator passes every one of the 14 branches on its first attempt (`branchStatus[*].attempts === 1`, asserted above), so `route_after_eval` never selects `rework`. The golden dataset's `replay-corrected-sprint-still-grades-fail` case proves `critique` DOES run given a branch `gradeContracts` grades `"fail"`. |
| `rework_route` | not reached | sole inbound edge is `critique -> rework_route` (normal); not reached for the identical reason `critique` is not. |
| `sprint_correct` | not reached | reachable via `gate_syntax`/`gate_anchor_regression`'s `sprint-correct` label or `sprint_route`'s `retry` label — all three require a generated sprint to fail a check or need another attempt. This workload's stub generator and evaluator both succeed on the first attempt for all 14 contracts, so no correction is ever triggered. |
| `plan_clarify` | not reached | reachable only via `plan_clarify_check`'s `clarify` label, selected when the planner's output needs clarification. This workload's planner stub resolves `{kind: "ready", spec}` directly with the real committed spec, so clarification is never needed. |
| `context_compact` | not reached — **structural** | same block the golden dataset records: the shipped supervisor has no code path that selects the `compact` label at all ([the golden coverage table](#how-much-of-the-graph-the-committed-cases-execute)). Independent of this workload's inputs. |
| `synthesize` | not reached — **structural** | same block the golden dataset records: reachable only behind a second `route_after_eval` invocation that the graph's own routing order makes impossible ([the golden coverage table](#how-much-of-the-graph-the-committed-cases-execute)). Independent of this workload's inputs. |

Six of the eight — everything except `context_compact` and `synthesize` — are proven
REACHABLE elsewhere in this repository (a named golden case for each), so this table is
evidence about what ONE real spec and ONE stub-driven run happens to exercise, not a second,
independent claim of unreachability. Only `context_compact` and `synthesize` carry that
stronger claim, and this table does not re-derive it — it cites the golden dataset's own
proof.

Both `observedWrites` and `nodeCoverage` are committed alongside the fields sprints 1–4
established, in the same `.bober/topology/measurements/real-workload.json`, gated by the
same byte-identical re-derivation `real-workload.test.ts` already enforced.

### A committed workload corpus

A cap sized from a fixture is a cap sized from nothing, and a plan-and-contracts measurement
alone does not say whether the OTHER nine channels are anywhere near their limit. Both gaps
are closed by a corpus of **122 real payloads**, committed at **`.bober/workload/`** (never
`.bober/golden/` — a workload entry is not a golden case, and the two directories are enforced
by disjoint gates) and read at test time by `src/pge/golden/workload.ts`.

Every entry is `{ entryId, channel, provenance, value }`, one file per entry, named for its
own `entryId` — the same "the directory is the truth, not a list" discipline
[The golden dataset](#the-golden-dataset-what-it-proves-and-what-it-does-not) uses. `provenance` says where the
value came from: `"file"` (a byte-exact copy of one committed file's parsed value), `"file-group"`
(assembled from several files — the whole `SprintContract[]` one spec's `sprints` resolves to),
or `"observed"` (no committed file anywhere in the repository carries a payload for this
channel; captured instead from a real `PgeEngine` run's own `ChannelUpdate`s, through a
`RunContext.commit` spy, rather than invented).

| channel | corpus maximum (canonical bytes) | declared limit | source |
| --- | --- | --- | --- |
| `spec` | 48,097 | **131,072** | every `.bober/specs/*.json` that parses AND is at a terminal status (50 of 53 — see below) |
| `sprintContracts` | 135,106 | **524,288** | one entry per terminal-status spec, the whole `SprintContract[]` its `sprints` resolve to (27) |
| `specDraft` | 29,214 | **65,536** | `spec-20260805-pge-graph-engineering`'s own real committed plan, restated under this channel — the same spec `real-workload.test.ts` plans with — plus one small observed entry; added `1.4.0` (see that changelog entry) |
| `messages` | 1,292 | 4,096 | a representative sample of `.bober/handoffs/gen-report-*.json` `notes` |
| `evaluations` | 1,067 | 4,096 | a representative sample of `.bober/eval-results/*.json` summaries |
| `refs` | 283 | 4,096 | observed from a real run |
| `ledger` | 221 | 4,096 | observed from a real run |
| `branchStatus` | 102 | 4,096 | observed from a real run |
| `testAnchors` | 114 | 4,096 | one real committed contract's own `successCriteria`, via `anchorId()` |
| `counters` | 64 | 4,096 | observed from a real run |
| `verdict` | 8 | 4,096 | this section's own committed measurement's real `verdict` |

Every declared limit above is exactly `capForCorpusMax` (`src/pge/golden/workload.ts`) of
that row's own corpus maximum — the next power of two at or above 2× the maximum, floored
at 4,096 — pinned two-directionally in `src/pge/golden/workload.test.ts` (`1.3.0` changelog
entry). The pin is written over EVERY declared channel rather than per channel, so a channel
added later inherits it with no new test: that is how `specDraft` was caught at `1.4.0`
(see that entry). `sc-2-2` (the maximum is computed with the commit boundary's OWN `byteSize`
(`src/pge/runtime/commit.ts`), never a reimplementation) and `sc-2-4` (every declared channel
has at least one entry, proven to bite by deleting one from a temp copy) are unit-tested in
the same file. The `messages`/`evaluations`/`refs` maxima above are also recorded in the
committed measurement itself, as `corpusHeadroom` — the same "corpus-sized payload against
the declared limit" question, extended to the channels real generator and evaluator output
flows through, and (for `spec`/`sprintContracts`) the direct byte-vs-cap comparison
[The graph engine against a real workload](#the-graph-engine-against-a-real-workload)
documents.

`corpusHeadroom` answers a STATIC question — how a stored corpus payload would fare against
the cap — for three channels only, and the payloads it reads predate `evaluations`' current
three-copy shape. Sprint 10 added the complementary DYNAMIC question, for all eleven: what a
real run's own commit traffic actually weighed, recorded as `observedWrites` in the same file.
Neither supersedes the other — the corpus is the sizing basis, the observation is the
sighting — and the observation carries a caveat of its own about stub collaborators. See
[Every channel and every node this real run
touches](#every-channel-and-every-node-this-real-run-touches--sprint-10).

**60 of 250 committed contracts and 1 of 53 committed specs do not parse** under their own
schema (an earlier contract/spec era) and are skipped rather than crashing the corpus build —
`src/pge/golden/__fixtures__/workload-build.ts` records which, with `safeParse`.

**A further 2 of the 52 that DO parse are excluded for a different reason: they are still
"in-flight."** `spec` / `sprintContracts` are the only two channels sourced from files that
are mutated IN PLACE while a spec's own pipeline run proceeds —
`.bober/contracts/<sprintId>.json` is rewritten with a new `status` / `completedAt` /
`iterationHistory` as each of that spec's sprints completes, using the same filename
throughout. A corpus entry captured for a spec whose own sprints are not all done yet is a
snapshot of a file that is about to change again — not eventually, but during the very run
that built the snapshot. This is exactly what happened: the `sprintContracts` entry for
`spec-20260812-pge-real-workload-errors` — the spec whose own sprint 3 wrote this
sentence — went stale between the corpus being built and sprint 3 running, because sprint 2
completed in between and rewrote its own contract file. `src/pge/golden/__fixtures__/workload-build.ts`
now excludes any spec whose `status` is not `"completed"` or `"abandoned"` (see
`TERMINAL_SPEC_STATUSES` there) from both the `spec` and `sprintContracts` channels — a
property of the spec, not a name, so a future spec that is mid-run when the corpus is
rebuilt is excluded the same way automatically. An exclusion is **not** a parse failure, so
it is reported through its own `BuildReport` field, `excludedInFlightSpecs`, alongside
`skippedSpecs` / `skippedContracts` rather than mixed into them. Applying it removed three
committed entries — the corpus went from 123 to **120** (`spec` 52 → 50, `sprintContracts`
28 → 27) — and **none of the three was its channel's maximum**, so no cap and no
`graphVersion` follows from the removal. **`messages` and `evaluations` do NOT share
this failure mode and were deliberately left alone**: their sources
(`.bober/handoffs/gen-report-*.json`, `.bober/eval-results/*.json`) are written once per
`(contract, iteration)` under an iteration-suffixed filename and are never rewritten in
place — the only instability there is which files a rebuild's representative *sample*
picks (see the next paragraph and `capForCorpusMax`'s doc comment in
`src/pge/golden/workload.ts`), a different class of drift that the power-of-two headroom
bucket already absorbs.

Regenerate the whole corpus with:

```
BUILD_WORKLOAD_CORPUS=1 npx vitest run src/pge/golden/workload.test.ts
MEASURE_REAL_WORKLOAD=1 npx vitest run src/pge/engine/real-workload.test.ts
```

in that order — the second command reads the corpus the first one just wrote. **The hazard
recorded as of `1.3.0` (before sprint 4) is now RESOLVED, and is kept here as the record of
why the two sprints stayed in that order.** The `verdict` channel's only corpus entry is
sourced from the committed measurement's own `verdict`; while the superstep ceiling made the
run throw before returning a `GraphRunResult`, that field was `null`, and a full
`BUILD_WORKLOAD_CORPUS=1` rebuild would have dropped the `verdict` channel's only entry and
failed `sc-2-4`'s channel-coverage check. Sprint 4's ceiling fix (see [The graph engine
against a real workload](#the-graph-engine-against-a-real-workload)) makes the real-workload
run reach a terminal node and record `verdict: "failed"` — non-null — so the rebuild command
above is safe to run again. It was not re-run as part of sprint 4: this sprint's own scope
was the measurement (`.bober/topology/measurements/real-workload.json`), not the corpus
(`.bober/workload/`), and the corpus is unaffected by anything this sprint changed — a
deliberate rebuild is left as a follow-up rather than bundled in here.

**A regeneration is only partly pinned, and the asymmetry is worth knowing before you read the
diff.** The `spec` and `sprintContracts` entries take *every* file that parses and are keyed to
committed filenames, so a new spec adds an entry rather than displacing one. The
`messages`/`evaluations` entries are a six-item representative sample drawn from a **live
`readdir`** of `.bober/handoffs/` and `.bober/eval-results/` — deterministic for a given
directory listing, but the listing is not pinned to a commit, so regenerating once more run
artifacts have accumulated silently swaps committed entries for different real ones. The sample
always keeps the genuine maximum, so the numbers above stay honest; the churn is in *which*
payloads are held, not in whether the largest one is. Check a large `messages`/`evaluations`
diff is a sample shift before committing it.

**`spec` and `sprintContracts` are sized from this corpus, as of `graphVersion 1.3.0`.** The
other eight channels' declared limits already matched `capForCorpusMax` of their own corpus
maximum before that sprint touched anything, which is what made it safe to pin all ten
rather than only the two that moved (see the `1.3.0` changelog entry above). **`specDraft`,
added at `1.4.0`, was sized the same way and is the case that shows the pin is not a
formality**: because the pin is an EQUALITY over every declared channel, it applied to a
channel that did not exist when it was written, and it rejected `131,072` — the value a
reader reaches for by analogy, `specDraft` and `spec` being the same schema — before any
test had to be added for the new channel (`src/pge/golden/workload.test.ts` is unchanged by
that sprint). Sizing by analogy is not sizing from a corpus, and the pin cannot tell the
difference between an analogy and a guess.

## Engine migration disposition

This section records — in writing, as the deliverable it is — where the graph engine
stands relative to the imperative pipeline, and what was decided about the code that
serves both.

### The evidence

- `PgeEngine` ships behind the engine seam. `config.pipeline.engine` still **defaults to
  `"ts"`** (`src/config/schema.ts`), and `TsPipelineEngine` is both the default and the
  fallback in `selectPipelineEngine` (`src/orchestrator/workflow/selector.ts`).
- The conformance harness compared the **two real engines** — not a stub — and reported
  `equivalent: false`, with exactly **two** pinned divergent fields: `audits` and
  `pipelineResult`. `history` CLOSED at sprint 4 of `spec-20260814-pge-full-convergence` and
  `contracts` CLOSED at sprint 6 (see "The decision" below); neither is one of them any
  longer. `pipelineResult` no longer diverges through `contracts` (its contract-container
  portion closed alongside `contracts`) — it stays pinned for a separate, independent
  reason found at sprint 6: `errors`, populated only on the graph side. **Both remaining
  fields are ARCHITECTURAL rather than unbuilt, and they share one root cause: the graph has
  a checkpoint-gated commit that the imperative engine lacks.** Every divergence that was a
  missing writer is now closed; what is left cannot be closed by building. The comparison was
  non-vacuous: all conformance fields were present. The pins live in
  `src/orchestrator/workflow/conformance.engines.test.ts` (`:408-412`).
- The most consequential divergence: **under the shipped autopilot configuration a PGE run
  does not commit.** The git-effect node `commit` is refused `FAIL_CLOSED` because the
  autopilot gate mechanism is `noop` and a noop mechanism grants nothing. The run
  nevertheless reports `success: true` — `deriveRunSuccess` stays sprint-split based by
  deliberate decision (Option A, spec-20260812-pge-real-workload-errors
  resolvedClarifications D3) — but as of that spec's sprint 5, `PipelineResult` carries an
  optional `errors` array populated from the refusal, so the fact is no longer invisible to
  a caller that checks it, and as of sprint 6 the two shipped callers **do** check it:
  `bober run` exits non-zero and prints a `Refused:` block naming the refused node and its
  error class, and the MCP run manager reports `RunState.status = "failed"` with `error`
  populated. Both engines still report `success: true`; the artifacts differ, and now so
  does the presence of `errors`.
- **What the `contracts` divergence WAS, and what `spec-20260812-terminal-vocabulary` sprint 1
  did *not* move — the status word, closed at sprint 5.** The two engines used to pick
  different words out of the same nine-member `ContractStatusSchema` for the same outcome:
  `runSprintCycle` wrote `"passed"`, the graph's `sprint_review` wrote `"completed"`
  (`src/pge/nodes/sprint-review.ts:290`; the persisted value is pinned at
  `src/pge/nodes/sprint-evaluate.test.ts:778`). Sprint 1 converged the **readers** on the
  split rather than the writers: `src/contracts/sprint-contract.ts` is the single definition
  site, exposing `isSettledContractStatus` (`passed | completed` — *finished successfully*)
  and `isTerminalContractStatus` (adds `failed` — *stopped at all*, derived from the settled
  set so the two cannot diverge), and six production readers called one of them at that point
  — **ten production files call one today** (`pipeline.ts` joined at sprint 5 of this spec;
  `src/pge/runtime/interpreter.ts` and `src/pge/runtime/commit.ts` at sprint 7 of
  `spec-20260814-pge-full-convergence`). **Sprint 5
  changed the WRITER**: `runSprintCycle` now writes `"completed"` at `pipeline.ts:589` —
  exactly what `sprint_review` already wrote — and its own reader at `pipeline.ts:1052`
  (the `completedSprints`/`failedSprints` split) was migrated to `isSettledContractStatus` in
  the same step, so the write and its own consumer never went out of sync. The `status`
  field of the `contracts` divergence is CLOSED: both engines now write the identical word
  for a settled sprint, pinned by asserting `tsContract.status` against `pgeContract.status`
  directly (`src/orchestrator/workflow/conformance.engines.test.ts:435-437`) rather than
  against a literal, so the claim pinned is the convergence itself.
- **The `contracts` divergence went from three field deltas to FOUR at sprint 3, and back
  down to THREE at sprint 5 — but `contracts` stays in the diverged set, because the other
  three do not close by a vocabulary change.** The original three were `status`,
  `evaluatorFeedback` and `generatorNotes` (the graph populates neither of the latter two).
  Sprint 3 added a fourth: `sprint_exit` writes a monotone `version: attempts` on the
  settled contract (`src/pge/nodes/sprint-review.ts:222`), the ordering discriminator
  `versionRank` (`src/pge/registry/reducers.ts:366-393`) reads, and `runSprintCycle` writes
  none — pinned at `src/orchestrator/workflow/conformance.engines.test.ts:435-444`.
  `conformance.ts`'s comparison strips a **10-key** `VOLATILE_KEYS` list (`:65-76`) and
  `version` is deliberately **not** on it: stripping it would hide a genuine difference in
  what the two engines write, which is the one thing this harness exists to find. Sprint 5
  closed `status`, leaving exactly **three** open — `evaluatorFeedback`, `generatorNotes`,
  `version` — and `contracts` stays in the pinned divergence set for that reason. Sprint 5's
  own contract pre-authorised exactly this outcome: `sc-5-2` required only that the status
  delta be closed with the others "either closed too or **recorded with a stated reason**",
  and its stop condition read *"Closing the status delta does not close the contracts
  divergence because another delta remains — that is a finding to record, not to force."*
  The reason recorded for the remaining three, AS OF THAT SPEC's CLOSE — later narrowed
  further, see the next bullet: `evaluatorFeedback`/`generatorNotes` have no
  PGE writer anywhere in `src/pge/` (a `grep -rn 'evaluatorFeedback' src/pge/` outside tests
  returns zero hits) — closing either means adding a writer to a PGE node body, which is a
  graph-node change, not a vocabulary change, and outside that sprint's scope; `version` is
  deliberately excluded from `VOLATILE_KEYS` for the reason above. Full record:
  [`docs/sprints/sprint-spec-20260812-terminal-vocabulary-3.md`](./sprints/sprint-spec-20260812-terminal-vocabulary-3.md)
  and
  [`docs/sprints/sprint-spec-20260812-terminal-vocabulary-5.md`](./sprints/sprint-spec-20260812-terminal-vocabulary-5.md).
- **`evaluatorFeedback`/`generatorNotes` CLOSED at sprint 5 of
  `spec-20260814-pge-full-convergence` — the `contracts` divergence narrows to `version`
  ALONE.** The "no PGE writer anywhere" finding two paragraphs above was the honest state of
  the tree at the time it was written; it stopped being true this sprint. `sprint_evaluate`
  (`src/pge/nodes/sprint-evaluate.ts`) now carries the RAW `EvaluationRunResult.summary` and
  the RAW `GeneratorResult.notes` onto the decisive `SprintVerdict` it emits — via two new
  OPTIONAL fields on `SprintVerdictSchema` (`src/pge/state/overall.ts`), not a new channel —
  and `sprint_exit` (`src/pge/nodes/sprint-review.ts`) writes them onto the settled contract
  from that verdict, never from the seeded copy. Both match the imperative engine's own
  expressions exactly: `pipeline.ts:592`/`:719` write `evaluatorFeedback := evaluation.summary`
  (verbatim, on both the pass and the fail branch) and `pipeline.ts:428` writes
  `generatorNotes := generatorResult.notes`. Asserted against the OTHER engine's own answer
  (`src/orchestrator/workflow/conformance.engines.test.ts`, Pattern D), not a literal — the
  claim pinned is the convergence itself. No topology change and no `graphVersion` bump:
  `sprint_evaluate` and `sprint_exit`'s declared `reads`/`writes` are unchanged, because the
  raw values ride on the EXISTING `evaluations` channel's entries rather than a new one — the
  same channel `version` already crosses. Two fields have no graph analogue and are
  deliberately NOT synthesised: `pipeline.ts:418-421`'s literal
  `"Generator failed to complete the implementation."` (a max-iterations fail path
  `sprint_generate` does not branch on) and `pipeline.ts:520-525`'s rendered security
  feedback (the graph's security block routes to `sprint_correct`, not to a settle). A
  refusal, or a decisive verdict from a call site that never populated either field, leaves
  it genuinely ABSENT on the settled contract rather than standing in a plausible-looking
  placeholder — the honest answer sc-5's stop condition asks for. `contracts` therefore
  narrows to **one** field delta — `version` — asserted directly by a `canonical`-based
  whole-object comparison with `version` stripped from both sides
  (`conformance.engines.test.ts`, sc-5-4), not merely inferred from two field-by-field
  checks. Full record:
  [`docs/sprints/sprint-spec-20260814-pge-full-convergence-5.md`](./sprints/sprint-spec-20260814-pge-full-convergence-5.md).
- **`version` CLOSED at sprint 6 of `spec-20260814-pge-full-convergence` — `contracts` is
  FULLY CLOSED and no longer appears in the divergence set.** `sprint_exit` has written
  `version: attempts` — a count of non-`skipped` `evaluations` entries, floored at 1 — since
  sprint 3 of `spec-20260812-terminal-vocabulary`; `runSprintCycle` wrote none. Sprint 6 gave
  `runSprintCycle` its OWN count of the same shape: `settledAttempts`
  (`src/orchestrator/pipeline.ts`), a variable hoisted above the retry loop and incremented
  once per round that reaches a decisive verdict (the round the evaluator actually ran for),
  written onto the settled contract as `Math.max(1, settledAttempts)` at all four of the
  function's settle sites, always BEFORE the `updateContract` call at each site so the disk
  copy and the returned object carry the same number. A generator-failure round does NOT
  increment it — mirroring the graph side, where `gate_syntax` routes such a round to the
  corrector "without spending an evaluation" (`src/pge/topology/coding.graph.ts:642`) — so the
  two counts agree on every round shape the golden dataset and the conformance fixture
  exercise, not merely on the one-round case (`pipeline.test.ts`'s two-round
  fail-then-pass and generator-failure-then-pass tests discriminate this from the simpler,
  rejected rule of writing the raw loop-iteration count). Neither a clock, an ordering nor a
  superstep is touched, for the reasons at
  [`docs/sprints/sprint-spec-20260812-terminal-vocabulary-3.md`](./sprints/sprint-spec-20260812-terminal-vocabulary-3.md).
  `version` stays deliberately excluded from `VOLATILE_KEYS` (still ten keys, unchanged) and
  the schema field stays `.optional()`, never `.default(...)` — both would have made this
  closure fake rather than real. `contracts` is asserted CLOSED by a whole-object `canonical`
  comparison with NOTHING stripped (`conformance.engines.test.ts`, sc-6-3), superseding
  sprint 5's `version`-stripped control. Full record:
  [`docs/sprints/sprint-spec-20260814-pge-full-convergence-6.md`](./sprints/sprint-spec-20260814-pge-full-convergence-6.md).
- **Sprint 4 closed the seeded-copy defect the `pipelineResult` bullet below used to blame.
  Its CONTRACT-CONTAINER portion then reduced exactly to `contracts`'s divergence through
  sprints 5 and 6 of `spec-20260814-pge-full-convergence`, and CLOSED when `contracts`
  closed at sprint 6 — but `pipelineResult` itself does NOT leave the divergence set,
  because sprint 6 found a SECOND, INDEPENDENT delta inside it: `errors`.**
  `PipelineResult.completedSprints`/`failedSprints` carry whole `SprintContract` objects
  (`src/orchestrator/pipeline.ts`), so once the channel join converges on the settled copy
  (sprint 4) and the two engines agree on every field inside that contract (sprint 6), what a
  caller sees inside `completedSprints`/`failedSprints` is exactly what `listContracts` sees
  on disk — no more, no less — on BOTH engines, asserted directly
  (`src/orchestrator/workflow/conformance.engines.test.ts`, "4. pipelineResult":
  `pgeResult?.completedSprints[0]` `toEqual`s `pgeContract`, and its ts-side counterpart
  added at sprint 6). **That was the sprint's whole premise — "closing `contracts` closes
  `pipelineResult` as a CONSEQUENCE" — and it is true for exactly that portion of the field,
  no more.** `PipelineResult` also carries `errors?: readonly PipelineFailure[]`
  (spec-20260812-pge-real-workload-errors, sprint 5), populated ONLY by `PgeEngine.run` from
  the interpreter's own `TaskFailure` records
  (`src/pge/engine/pge-engine.ts:551-572`) — and on the conformance fixture ALWAYS non-empty,
  because the same FAIL_CLOSED `commit`-node refusal the `audits` bullet describes surfaces
  here too. `runTsPipeline` has no interpreter and no `TaskFailure` concept at all, and its
  own auto-commit (`commitAll`, unconditional when `config.generator.autoCommit` is true) is
  not gated behind any checkpoint the way the graph's `git`-effect `commit` node is — there
  is no refusal for the imperative engine to ever report, so there is no honest write site
  for an equivalent `errors` entry, the same category of absence sprint 6's own stop
  condition protects for `version`. `pipelineResult` therefore stays pinned in the divergence
  set for `errors` alone — an ARCHITECTURAL gap in the same sense `audits` is one, discovered
  mid-sprint rather than assumed, and recorded here rather than papered over by adding
  `errors` to `VOLATILE_KEYS` (which would hide it) or by fabricating a refusal event the
  imperative engine never produces (which would misreport its actual behaviour). Closing it
  — an equivalent checkpoint-gated commit step for the imperative engine, or joining `audits`
  as a permanently-accepted divergence — is a decision for a future sprint.

  **The finding was confirmed independently by sprint 6's evaluator, from source, and it is
  what turned `sc-6-3` into a `pass` under an AMENDED DISPOSITION rather than a retry**
  (`.bober/eval-results/eval-sprint-spec-20260814-pge-full-convergence-6-1.json`,
  `architecturalFinding`; the amendment is mirrored on the contract itself under
  `amendedDisposition`). Three checks, each reproducible: `PipelineResult.errors` has
  **exactly one write site repo-wide**, `PgeEngine.run`, and both it and its doc comment
  PRE-DATE this sprint — this sprint's diff does not touch the `PipelineResult` interface at
  all. The imperative engine's auto-commit (`src/orchestrator/pipeline.ts:449-462`) calls
  `commitAll` **unconditionally** when `config.generator.autoCommit` is true, inside a
  `try`/`catch` that only `logger.debug`s and continues — no HITL gate at any point — and
  `finalizePipelineRun` requests the `end-of-pipeline` checkpoint AFTER the completion marker
  and the history event are written (`src/orchestrator/finalize.ts:21`, "ORDER IS
  LOAD-BEARING") without gating on its outcome. The graph instead routes its git effect
  through an explicit `hitl_commit` gate (`src/pge/topology/coding.graph.ts:911-923`) into a
  separate `commit` tool node (`:926-937`) whose own `doc` says it is *"reachable only behind
  the approval gate, which is what makes the git effect blockable fail-closed."* Adding
  `errors` to `VOLATILE_KEYS` would also violate that set's own documented bar: a key belongs
  there only when two runs of the **same** engine over the same input would differ on it, and
  `errors` differs **between** engines on the **same** input — precisely the class
  `VOLATILE_KEYS` exists not to hide. **Why nobody saw this earlier:** the divergence was
  MASKED, because `contracts`/`version` was diverging under the same `pipelineResult` field
  name; isolating the container portion from the whole is what exposed it. Full record:
  [`docs/sprints/sprint-spec-20260814-pge-full-convergence-6.md`](./sprints/sprint-spec-20260814-pge-full-convergence-6.md).

  **The two remaining divergences share ONE root cause, and it is architectural: the graph has
  a checkpoint-gated commit that the imperative engine lacks.** `audits` diverges because a
  graph run records at most two of the imperative pipeline's eight checkpoint ids;
  `pipelineResult` diverges because the graph's gated `commit` can be refused FAIL_CLOSED and
  the imperative engine's ungated `commitAll` can never be. Neither is a missing writer — the
  two divergences that WERE missing writers, `history` and `contracts`, are both closed
  (sprints 4 and 6). See point 1 under "What a flip would still require" below for the
  disposition this implies and for the decision that is recommended but NOT yet taken.
- **Both remaining `"passed"`-literal runtime readers were migrated and are now live, as of
  `spec-20260814-pge-full-convergence` sprint 7.** `verdictFrom`
  (`src/pge/runtime/interpreter.ts:734`) derives a run's verdict from the count of
  `state.sprintContracts` entries that have *settled* — before sprint 7 that count was the
  literal `c.status === "passed"`, a word neither engine's settled-sprint writer produces
  (`sprint_exit` and `runSprintCycle` both write `"completed"`), so the count was
  structurally zero for every run and `verdictFrom`'s downgrade branches — a declared
  `failed` softening to `partial` when work had landed, a declared `success` with recorded
  failures downgrading only as far as `partial` rather than always `failed`, and the
  fallback `success`/`partial` outcomes when no verdict was declared at all — were
  unreachable in production. Sprint 7 migrated the comparison to
  `isSettledContractStatus(c.status)` (`src/contracts/sprint-contract.ts`), the same
  predicate `state/history.ts`'s "Passed" row and `pipeline.ts`'s completed/failed split
  already use — a **strict widening**: every contract the literal counted is still counted,
  `"completed"` now joins it, and the count can only move toward a verdict of *less*
  severity, never more. `src/pge/runtime/commit.ts:535`'s completed/failed split moved the
  same way, in the same sprint, from `c.status === "passed"` to
  `isSettledContractStatus(c.status) || succeededBranches.has(c.contractId)` — a fallback
  that only matters when a `"completed"` contract has no `branchStatus` row at all, since
  `sprint_exit` writes both in the same update for every run that reaches it. Verified by
  execution, not by reading: `src/pge/runtime/__tests__/partial-failure.test.ts` (sc-7-2)
  drives a run to a declared `"failed"` terminal with two branches settled `"completed"`
  (the production word, via a `handlerOverrides` seam rather than the fixture's own
  `"passed"`-writing body) and asserts the reported verdict is `"partial"` — a test proven,
  in a disposable worktree, to fail against the pre-migration counter with `"failed"`
  received. Both sites' entries are gone from
  `src/contracts/status-vocabulary.invariant.test.ts`'s allowlist, which now fails in either
  direction if the code and the allowlist disagree. The 44-case committed `.bober/golden/`
  dataset was re-captured and its diff is **empty**: `verdict` is not one of
  `CONFORMANCE_FIELDS` (`src/orchestrator/workflow/types.ts`) and `PgeEngine.run` never
  reads it (`src/pge/engine/pge-engine.ts`), so no committed golden artifact carries it —
  real in-memory verdict movement and zero golden-dataset movement are both true at once, for
  different reasons. One committed artifact OUTSIDE `.bober/golden/` does carry `verdict` —
  `.bober/topology/measurements/real-workload.json`
  (`src/pge/engine/real-workload.test.ts`), which reads the interpreter's own
  `GraphRunResult.verdict` directly — and it moved from `"failed"` to `"partial"`, re-captured
  in the same sprint: all 14 dispatched branches settle `"succeeded"`, and the only recorded
  failure is the already-documented `commit` `FailClosed` refusal, so `"partial"` is the more
  accurate report of a run whose work landed but whose commit was gated, not a regression.
  **What is left after sprint 7, so the residual set is on the record and not only the closed
  part:** three PGE *node* bodies stay allowlisted with a per-entry reason and a `file:line` —
  `src/pge/nodes/sprint-curate.ts`, `sprint-generate.ts`, `documenter.ts` — outside every
  migrating sprint's `estimatedFiles` so far; plus `src/orchestrator/workflow/flusher.ts:76`,
  which the scan cannot see by construction (below). No runtime reader compares the retired
  literal any more.

### The decision

**Conformance did not converge, so the plan's pre-authorised end state applies:**

- **PGE is permanently opt-in.** `config.pipeline.engine` keeps `"ts"` as its default. A
  run reaches the graph engine only by explicit configuration.
- **`TsPipelineEngine` is retained permanently as the oracle.** It is the reference the
  conformance harness compares against; removing it would remove the only definition of
  "correct" the graph engine is measured by.
- **Nothing is deleted.** No test, no engine, no workflow module was removed to reach this
  state.

Flipping the default is a separate decision that requires sustained green conformance
across real runs. `PipelineResult` gained the error channel this paragraph used to say was
missing (spec-20260812-pge-real-workload-errors, sprint 5), and sprint 6 migrated the two
callers this repository ships — the `bober run` CLI and the MCP run manager — so a refusal
is visible to an operator and fails a CI job. `success` itself still cannot say a
fail-closed refusal happened, by the same Option-A decision, so a flip still requires every
*remaining* caller that decides on `success` alone to be migrated to check `errors` too.

`spec-20260812-pge-real-workload-errors` closed at its sprint 9 **without moving this
disposition**. It made the engine able to run a real workload at all and gave a refused run
a channel to say so, but the divergence set at that spec's close was still exactly
`history`, `audits`, `contracts`, `pipelineResult` at `equivalent: false` — none of the four
was in its scope — so PGE remains opt-in and `TsPipelineEngine` remains the oracle.
(`history` left that set later, at sprint 4 of `spec-20260814-pge-full-convergence`, and
`contracts` at sprint 6; the other two still diverge. Point 1 below is the current record.)

**`spec-20260812-terminal-vocabulary` closed at its sprint 6 having NOT moved this
disposition either — and its own description said it would.** That description read "closes
two of the four conformance divergences"; a real run of both engines, driven exactly as
`conformance.engines.test.ts` drives them, still reports `equivalent: false` with the
identical four field names it reported before this spec's first sprint. **The set never
shrank.** What the spec's six sprints actually did was close two things one level *below*
the field: the `pipelineResult` MECHANISM (sprint 4 — the channel reducer stopped keeping
the seeded `"proposed"` copy of a settled contract), and the `contracts` STATUS DELTA
(sprint 5 — both engines write `"completed"` for a settled sprint, pinned by asserting one
engine's answer against the other's, `conformance.engines.test.ts:642-644`). Neither closure
removed a field from the pinned set: `pipelineResult` remains, because
`PipelineResult.completedSprints`/`failedSprints` are containers of whole `SprintContract`
objects, so its divergence REDUCES to `contracts`'s and cannot close independently of it
(`conformance.engines.test.ts:698-699`) — **that last clause was true of the CONTAINER
portion only, and reading it as a statement about the whole field is the error sprint 6 of
`spec-20260814-pge-full-convergence` inherited and corrected: `contracts` closed, the
container portion closed with it, and `pipelineResult` stayed in the set on an `errors` delta
that never depended on `contracts` at all**; `contracts` remains, because three deltas still sit
inside it — `evaluatorFeedback`, `generatorNotes` (PGE has no writer for either anywhere in
`src/pge/`) and `version` (deliberately excluded from the ten-key `VOLATILE_KEYS`,
`conformance.ts:65-76`, because stripping it would hide a real difference rather than close
one). (All three of those deltas are CLOSED today, and so is the field: sprint 5 of
`spec-20260814-pge-full-convergence` built the missing `evaluatorFeedback`/`generatorNotes`
writer, narrowing `contracts` to `version` ALONE, and sprint 6 built the imperative `version`
writer — `contracts` has left the divergence set entirely. `pipelineResult` did NOT leave with
it: its contract-container portion closed, and sprint 6 isolated a separate `errors` delta
underneath the same field name — see the disposition bullets above.) This is exactly this sprint's own stop condition, applied to itself: *"The divergence
set is not what this spec predicted — record what it actually is and why, rather than
adjusting anything to match the prediction."* No test and no production source were changed
to make "two closed" come true; `conformance.engines.test.ts`'s pinned array was the same
four literals it was before sprint 1. (It holds TWO literals today — `audits` and
`pipelineResult`, at `conformance.engines.test.ts:408-412`. `history` left it at sprint 4 of
`spec-20260814-pge-full-convergence` and `contracts` at sprint 6, each by building the missing
writer, never by adjusting the pin.)

**What a flip would still require beyond everything this spec did — four things, none of
them this spec's to do (`nonGoals`):**

1. **`audits` is recommended for permanent acceptance — and since sprint 6, so is
   `pipelineResult.errors`, on the same ground; `history` CLOSED at sprint 4.** A
   prior version of this paragraph paired the two under one "no curator node" ground. **That
   ground was FALSE:** the topology always declared TWO `role: "curator"` nodes —
   `sprint_curate_explain` (`src/pge/topology/coding.graph.ts:576`) and `sprint_curate_mocks`
   (`:592`) — so a node capable of hosting a history write existed from the start. The FALSE
   claim was corrected (commit `e48962e`, 2026-08-14, before this sprint) to "`history` is
   OPEN WORK, not permanently accepted" — a MISSING WRITER, not a missing place to put one:
   `appendHistory` (`src/state/history.ts:81`) is an ordinary exported async function the
   imperative engine calls inline at ten sites in `src/orchestrator/pipeline.ts`, and
   `grep -rn "appendHistory\|history.jsonl" src/pge --include="*.ts"` (non-test) returned
   ZERO hits.

   **Sprint 4 of `spec-20260814-pge-full-convergence` closed that gap.**
   `src/pge/runtime/history.ts` exports `emitPhaseEvent`, which delegates to the SAME
   `appendHistory` the imperative engine calls — no parallel writer, no parallel file
   (sc-4-4) — and nine graph nodes now call it at the node's real lifecycle boundary, not
   replayed as a block at `finalize`: `research_body` (entry, `pipeline-start`),
   `plan_materialize` (after persisting, `planning-complete`), `sprint_curate_explain`
   (before/after `curator.brief`, `curator-start`/`curator-complete` — the latter only on a
   cache MISS, since a cache HIT never fetches the `SprintBriefing` its three counts come
   from), `sprint_generate` (entry, `generator-start`), `sprint_evaluate` (entry,
   `evaluator-start`; on the passing return path, `sprint-passed`, carrying the RAW
   `result.summary` rather than the `evaluations`-channel's decorated copy), `sprint_review`
   (after `reviewer.sprint`, `code-review-complete`) and `documenter` (after
   `documenter.summary`, `sprint-docs-complete` — never on the nothing-to-document early
   return). `grep -rn "appendHistory\|history.jsonl" src/pge --include="*.ts"` (non-test)
   now returns exactly ONE hit: src/pge/runtime/history.ts — the nine emitting node bodies
   call `emitPhaseEvent`, not `appendHistory` directly.
   `src/orchestrator/workflow/conformance.engines.test.ts` ("1. history") asserts the pge
   run's ordered event list against the ts run's OWN answer rather than a literal, so the
   claim pinned is the convergence itself: `history` no longer appears in the divergence set
   (`src/orchestrator/workflow/conformance.ts`'s `report.diffs`), and the pin fails in both
   directions (sc-4-3). The tenth imperative event, `pipeline-complete`, was already shared
   (`finalizePipelineRun`, both engines) and is untouched. The one non-obvious correctness
   fix: `iteration` (events 5-7) could not be read from `sprint-evaluate.ts`'s `iterationOf`
   or from the shared `sprintIterations` loop counter — both were tried against a real golden
   capture and both produced a WRONG number for a multi-round branch, for two independent
   reasons documented at `src/pge/nodes/gates.ts`'s `generateAttemptsSoFar`.

   The `audits` disposition below is UNCHANGED by this closure — it rests on ADR-6/ADR-1
   runtime evidence this paragraph does not touch. `audits`: the
   imperative pipeline records EIGHT checkpoints under eight distinct ids; a graph run
   records at most TWO of them, `post-sprint-contract` and `end-of-pipeline` (the latter
   three times) — the SET still diverges 8-vs-2, so declaring one more id narrows the
   divergence's shape without closing the field. Five of the eight
   (`pre-curator`, `pre-generator`, `pre-evaluator`, `pre-code-reviewer`, `post-sprint`) sit
   inside the sprint fan-out region, where `InterruptInsideFanOut`
   (`src/pge/topology/validate.ts:1089-1099`) is a BLOCKING validation error
   (`severity: "error"`) by ADR-6
   (`.bober/architecture/arch-20260805-pge-graph-engineering-adr-6.md`) — they cannot be
   declared there. **`spec-20260814-pge-full-convergence` sprint 1 revisited that ADR**
   (`.bober/architecture/arch-20260814-pge-full-convergence-adr-1.md`) and concluded the
   fan-out clause STANDS, now for a runtime-grounded reason ADR-6 itself never gave:
   `Checkpoint.interrupt` holds one pending interrupt (`checkpointer.ts:247`), `grantScope`
   carries no branch key so a sibling branch's arrival evicts a prior branch's grant
   (`interrupt.ts:268,371-375,485`), and `resumeMessageId` collapses every branch's decision
   onto one message row (`interrupt.ts:332`, consumed at `nodes/plan.ts:142-144`) — a defect
   that is concurrency-dependent (`frontier.ts:13,29-32`), colliding with this graph's
   byte-identical-at-cap-1-and-8 determinism criterion. Those five are RECOMMENDED FOR
   PERMANENT ACCEPTANCE for that runtime-grounded reason, not merely an unrevisited rule.
   **Sprint 3 declared the sixth, `post-sprint-contract`** — the only one of the seven
   undeclared checkpoint ids that sat outside the fan-out region — on `gate_plan_out`
   (`src/pge/topology/coding.graph.ts:513-526`), the effect-free exit gate that fires
   immediately after `plan_materialize` persists the same `contracts` payload the
   imperative pipeline's own checkpoint of that name answers
   (`src/orchestrator/pipeline.ts:1017-1025`); `plan_materialize` itself could not host it,
   since it declares `effects: ["fs-write"]`, which trips `EffectfulNodeContainsHitl`. The
   revisit also corrected ADR-6's own record: its Consequences claimed `hitl_commit` "sits
   at the fan-in barrier" — false for the shipped artifact, whose only in-region barrier
   gate, `reduce_sprints`, could not host a HITL node under ADR-6's own rule either. A
   further correction folded in with this record: the committed artifact now declares
   **three** HITL checkpoint ids, not one — `hitl_commit -> end-of-pipeline`
   (`coding.graph.ts:911-924`, line numbers as of 1.5.0), `plan_clarify -> post-plan`
   (`coding.graph.ts:484-497`) and, since 1.5.0, `gate_plan_out -> post-sprint-contract`
   (`coding.graph.ts:513-526`) — but on any single conformance run at most two are ever
   *evaluated*: `post-plan` is reachable only through the conditional edge
   `e-plan-clarify` that a settled plan never takes, so a run whose plan needs no
   clarification records `post-sprint-contract` and `end-of-pipeline` but never `post-plan`.
   Closing `audits` fully is nonGoal 3's territory anyway ("closing history or audits");
   permanent acceptance, now for a smaller and more precisely named remainder, is the
   disposition this record states.

   **`pipelineResult.errors` is RECOMMENDED to join that same acceptance — recommended, not
   yet decided.** Sprint 6 established that the last remaining `pipelineResult` delta is
   architectural for the SAME reason `audits` is, and that the two share one root cause: *the
   graph has a checkpoint-gated commit that the imperative engine lacks* (the bullet above in
   "The evidence" carries the source-level account). Both sprint 6's generator and its
   evaluator recommended, independently, that the field be joined to `audits`' acceptance
   rather than left as open work, and the contract's `amendedDisposition.carryTo` names the
   owner: **sprint 11**, the flip-bar sprint. **No ADR has been written or amended for it.**
   `arch-20260814-pge-full-convergence-adr-1` decides the fan-out interrupt question and
   nothing else; extending its acceptance to `pipelineResult.errors` is a decision someone
   must take deliberately, in the same place `audits`' was taken, before this document may
   state it as settled. Until then this paragraph records a recommendation with two named
   backers and an unowned decision — which is exactly what it is.
2. **Option B success semantics.** The term of art, defined at
   `spec-20260812-pge-real-workload-errors.json`'s `resolvedClarifications` D3: making
   `PipelineResult.success` false when a gated-effect node is refused FAIL_CLOSED, instead of
   the frozen `deriveRunSuccess` formula both engines share today (Option A, the one this
   repository ships — a run whose `commit` was refused still reports `success: true`). Option
   B was rejected for that spec and remains out of this one's `outOfScope[3]` for the same
   reason: it moves `.bober/runs/<runId>.completed.json` and the `pipeline-complete` history
   phase, which would add `completionMarker` to the divergence set — the one field currently
   asserted IDENTICAL across both engines
   (`conformance.engines.test.ts`, "is EQUIVALENT on every field outside the recorded
   divergence set") and the one the chat layer tails. Taking it trades one open divergence for
   another; it does not close anything by itself.
3. **A durable checkpoint mechanism for `commit` and `finalize` — RESOLVED at sprint 2 of
   `spec-20260814-pge-full-convergence`.** Four mechanisms are registered — `cli`, `disk`,
   `pr`, `noop` (`src/pge/runtime/interrupt.ts:318`) — and the gap this item named was never
   that a durable mechanism was missing; it was that nothing in this repository ever ran
   `commit`/`finalize` under one, because the shipped `conformanceConfig()` (and the golden
   executor's own `goldenConfig()`) are autopilot by construction. `noop` is documented as
   the mechanism that grants nothing (`interrupt.ts:38-46`, enforced at `:523`,
   `if (mechanismName !== "noop") granted.set(key, outcome);`), so a gated-effect node
   proceeds only under a DURABLE record of approval — a disk marker, a PR review, an
   interactive CLI answer. Sprint 2 added a SECOND pinned config,
   `goldenApprovedConfig()` (`src/pge/golden/executor.ts`), that routes `end-of-pipeline` to
   the real, unmodified `disk` mechanism, and one golden case,
   `replay-full-run-commit-approved`, that supplies a real, file-backed approval while the
   run is blocked (`withGoldenApproval`, same file) — never against this checkout, which is
   rooted instead at a throwaway run root for exactly this reason. `commit` and `finalize`
   are no longer in `NEVER_EXECUTED` (`src/pge/golden/coverage.test.ts`) — see "How much of
   the graph the committed cases execute" above. What this does NOT do: it does not touch
   the autopilot path `conformanceConfig()` still runs, and it does not move any of the four
   conformance fields below — a real run under a durable mechanism was always reachable
   through config; this sprint is what finally exercised it, in the dataset that measures
   node coverage rather than in the harness that measures engine equivalence.
4. **An explicit re-specification of the bar itself.** The bar as written above —
   *"requires sustained green conformance across real runs"*, operationally `equivalent:
   true` — is UNSATISFIABLE BY DESIGN, and **since sprint 6 it is unsatisfiable for BOTH
   remaining fields, not one.** `audits` (point 1) is recommended for permanent acceptance,
   and that alone was always sufficient — one field that can never close means `diffs` can
   never become empty. What changed at sprint 6 is the character of the remainder. An earlier
   version of this paragraph read: *"The other two (`contracts`, `pipelineResult`) are
   unbuilt, not architecturally barred."* **That is no longer true, and the two halves of it
   failed for different reasons.** `contracts` was indeed unbuilt, and it is now **CLOSED** —
   sprint 5 built the `evaluatorFeedback`/`generatorNotes` writer and sprint 6 built the
   imperative `version` writer, so it has left the divergence set entirely.
   `pipelineResult` was never merely unbuilt: it stayed in the set on its own
   `errors` delta, which sprint 6 isolated for the first time and which has **no honest
   imperative write site**, and it is therefore ARCHITECTURAL in exactly the sense `audits`
   is. **The set is `['audits', 'pipelineResult']`, both entries architectural, both tracing
   to one root cause — the graph has a checkpoint-gated commit the imperative engine lacks.**
   `diffs` can never become empty under the bar's current wording, and now no amount of
   further building would make it so: the bar itself has to be re-specified, on purpose,
   before "flip the default" is a live question again. **What this implies for
   `spec-20260814-pge-full-convergence`'s own sprint 11:** its `sc-11-1` asks the harness to
   report `equivalent: true` on a real run, and that criterion cannot be met as written. The
   satisfiable part of that sprint is its `sc-11-3`/`sc-11-5` — rewrite this disposition,
   state plainly which fields did not converge and why, and re-specify the bar around a
   named, accepted divergence set rather than around emptiness. Doing that re-specification
   was explicitly this spec's earlier sprints' `nonGoals`/`outOfScope[2]`, and it is not this
   record's to perform.

   **Since sprint 8, `sc-11-1` is not the only criterion in that condition.** Sprint 9's
   `sc-9-3` ("`NEVER_EXECUTED` is empty") and `sc-9-4` ("every node in the committed topology
   executed") are unsatisfiable as literally written for the SAME class of reason, one level
   away from conformance: `context_compact` is structurally unreachable by case authoring.
   That finding, the two sibling structural limits it belongs with, and the amended form the
   two criteria should take are recorded in "How much of the graph the committed cases
   execute" above. Sprint 11 consolidates three such criteria, not one, and the remedy is
   identical in each: a named, accepted, individually-justified exception set instead of a bar
   phrased as emptiness.

   **Sprint 9 closed its own two against that amended form** — `synthesize` investigated on
   its own merits and independently reconfirmed structurally unreachable, `NEVER_EXECUTED`
   unchanged at `['context_compact', 'synthesize']` with both entries claim-tested, and node
   coverage computed against the artifact at 42/44 — so sprint 11 inherits `sc-9-3`/`sc-9-4`
   as CLOSED, and its own remaining work is `sc-11-1` alone plus the write-up `sc-11-3`/
   `sc-11-5` ask for.

   **And `sc-11-1` is unsatisfiable BY BUILDING, not merely as written.** `synthesize` is the
   FOURTH structural limit this spec has produced (`audits`, `pipelineResult.errors`,
   `context_compact`, `synthesize` — tabulated together in "How much of the graph the committed
   cases execute" above). Two of the four ARE the divergence set; the other two block the
   coverage bar one level away. No further implementation inside this spec's scope closes any
   of them, so sprint 11 cannot reach `equivalent: true` by writing more code, and should not
   be asked to try. Its whole deliverable is the honest re-specification.

**One carried-forward fact from sprint 5/6 is now CLOSED, not merely unchanged — see the
sprint 7 bullet above.** An earlier version of this paragraph read: *"`verdictFrom`
(`src/pge/runtime/interpreter.ts:728`) is now structurally dead for BOTH engines: no writer
anywhere produces the literal `"passed"` for a settled sprint any more, so its counter is
permanently zero and its downgrade paths are unreachable ... (allowlisted at
`src/contracts/status-vocabulary.invariant.test.ts:205-208`)."* **That is no longer true.**
`spec-20260814-pge-full-convergence` sprint 7 migrated the counter (now
`src/pge/runtime/interpreter.ts:734`) to `isSettledContractStatus`, its downgrade paths are
reachable again (proven by execution, sc-7-2), and the cited allowlist entry no longer
exists — the two lines that section used to name are gone from ALLOWLIST entirely.

The other carried-forward fact remains true and unchanged.
`src/orchestrator/workflow/flusher.ts:76` decides the completed/failed split against a bare
local variable rather than the shared predicate, invisible to the sc-1-4 source scan by
construction (it keys on the `.status` member-access spelling); the ternary above it bounds
the value today (only `"completed"`, `"needs-rework"` or `"failed"` are possible, never
`"passed"`), so this is safe, not silently wrong — recorded, not fixed, because fixing it is
outside sprint 7's `estimatedFiles` and changes nothing its own success criteria were scoped
to change.

**A recurring hazard this spec's own history demonstrates, worth naming rather than
repeating quietly a sixth time:** sprints 3, 4 and 5 each had to correct a stale `path:line`
citation a prior sprint's edit had shifted, and this sprint fixed four more in the very
section above (`sprint-review.ts:205→215` and `:215→222`, `sprint-evaluate.test.ts:765→776`,
`sprint-contract.ts:213→214`) plus two that this sprint's OWN prose edit shifted
(`conformance.engines.test.ts:417-419→435-437`, `:417-426→435-444`). Nothing in CI validates
a `path:line` citation — `pge docs --check` diffs node ids inside the node-inventory
regions only ("How to read this document" above; `src/pge/topology/docs.ts:66-105`, the
literal marker text deliberately not reproduced here for the same reason that section
gives) and cannot see prose citations at all, so a stale one ages silently until a reader
follows it and finds the wrong line. **Weighed and
declined for this sprint:** a general citation-freshness guard would need to parse
free-text `path:line` and `path:line-range` references out of prose reliably — distinguishing
them from version strings, code spans and ordinary punctuation — and check each cited range
against the live file, across a ~1,500-line document with dozens of citations in varying
shorthand. That is a real capability, not a cheap addition bolted onto a closing record, and
building it under this sprint's docs-only, four-file scope risks exactly the scope creep
`nonGoals` exists to prevent. Recorded here as a follow-up worth its own sprint, not
performed.

**A related, unrelated-to-fix repo hazard also worth recording here, because a closing
record is exactly where an unusual hazard belongs:** `src/pge/topology/docs.test.ts` — the
file that gates this very section — carries two literal NUL bytes at its own line 308, used
as deliberate key separators inside a `join()` call. Plain `grep` silently skips the file as
binary; `grep -a` or a direct read is required to see its contents at all. The same hazard
was found pre-existing in `src/pge/registry/reducers.ts` and `src/pge/runtime/frontier.ts`
by an earlier sprint's security audit and spawned as its own task; it is not this sprint's to
fix, but a document whose own gate is invisible to `grep` is worth one sentence in the
record that names it.

**This decision is enforced, not just recorded.**
`src/orchestrator/workflow/oracle-retention.test.ts` asserts that the schema still defaults
`pipeline.engine` to `"ts"` (read from the schema, never from a checkout's own
`bober.config.json`), that `TsPipelineEngine` still constructs and is still what the
default config *selects*, that it is still the fallback `PgeEngine` downgrades to, and
that `conformance.engines.test.ts` still constructs **both** real engines, is not skipped
or focused, and still pins `equivalent: false` with the two currently-diverging fields
named (`oracle-retention.test.ts` also checks that `history` and `contracts` are still
named in that file's source, since their CLOSURE is recorded there too — a field leaving the
divergence set must not make the file stop mentioning it entirely). An
oracle that exists but is unreachable from selection is not retained; an oracle nothing
compares against is not exercised. Both are asserted separately, so neither can be
satisfied by the other.

If a future change makes the two engines equivalent, the assertion that pins
`equivalent: false` is the one to revisit **first and deliberately** — accompanied by an
update to this section — rather than the default quietly moving underneath it.

### The dormant `src/orchestrator/workflow/` subtree — RETAIN

Eighteen modules were audited for production callers, where "production caller" means
imported from a non-test file:

- **Sixteen are live or reachable in production.** `budget.ts`, `scheduler.ts`,
  `reconciler.ts`, `synthesizer.ts`, `retry.ts`, `conformance.ts`, `engine.ts`,
  `ts-engine.ts`, `selector.ts` and `types.ts` have direct production callers;
  `workflow-engine.ts`, `eligibility.ts`, `args-builder.ts`, `flusher.ts`,
  `resume-cursor.ts` and `errors.ts` are reachable through `selector.ts`, which
  `src/orchestrator/pipeline.ts` calls to select an engine. Eight named units among them —
  `Scheduler`, `Semaphore` and `mapBounded` (all in `scheduler.ts`), `Budget` (in
  `budget.ts`), and the modules `retry.ts`, `reconciler.ts`, `synthesizer.ts` and
  `conformance.ts` — are permanently retained by design decision, not by accident.
- **Exactly two are genuinely dormant:** `interpreter.ts` and `pure-sprint.ts`. The only
  importer of `interpreter.ts` anywhere is its own test; `pure-sprint.ts` is reachable
  only from that dormant interpreter, and only for its types.

**Decision: retain both.** Deleting them would delete `interpreter.test.ts` and
`pure-sprint.test.ts`, and no test may be deleted to make a gate pass. Retirement is
therefore conditional, and the criterion is written down here rather than left to
judgement:

> A dormant workflow module may be retired only when **every assertion in its test file
> has a passing counterpart against the graph runtime**, demonstrated by a per-assertion
> mapping, and the deletion leaves **no net loss of covered invariants**. Until that
> mapping exists, retention costs a few hundred dormant lines and deletes nothing;
> deletion costs coverage that nothing else provides.

### `bober sprint` and `bober_sprint` — a deliberate, documented escape hatch

Three entry points exist and they are **not** equivalent. The CLI command `bober sprint`
and the MCP tool `bober_sprint` diverge from the full pipeline in three specific ways:

1. **Both run generator then evaluator, and nothing else.** Neither runs the curator, the
   code reviewer, the documenter or the security auditor, and neither fires any
   checkpoint. Both bypass the audited-checkpoint wrapper entirely, so **no approval
   record is written for either**.
2. **Neither is routed through engine selection**, so neither is affected by
   `config.pipeline.engine`. They cannot run on PGE even when the configuration asks for
   it — they are engine-blind by construction.
3. **They scope work differently.** `bober sprint` refuses to run against a spec in
   `needs-clarification` and scopes contracts to the latest spec; `bober_sprint` scopes
   only by pending status.

**Decision: keep them, and treat them as a documented escape hatch rather than a bug.**
They exist to advance one sprint quickly under human supervision, which is precisely the
situation in which the full cycle's gates and checkpoints are being supplied by the human
instead. Re-pointing them at the full cycle would change observable behaviour for two of
three entry points and is deliberately out of scope here. What is **not** acceptable is
the divergence being undiscovered: anyone reading a run that produced no approval record
and no reviewer output should be able to find, in this section, that the entry point never
ran them.

## Changelog

Keyed by `graphVersion`. A structural change to the topology requires a version bump and
an entry here; CI enforces the pairing, so this section is the changelog the version-bump
gate reads.

### 1.5.0 — declaring the sixth checkpoint id, and naming the five that cannot be

Sprint 3 of `spec-20260814-pge-full-convergence` closed the ONE checkpoint id sprint 1's
ADR left open: `gate_plan_out` now carries
`hitl: { checkpointId: "post-sprint-contract", onReject: "graceful_failure" }`
(`src/pge/topology/coding.graph.ts:513-526`).

- **Why `gate_plan_out` and not `plan_materialize`.** The imperative pipeline records
  `post-sprint-contract` immediately after `materializeContracts` persists the spec and its
  contracts, before the sprint loop begins (`src/orchestrator/pipeline.ts:1017-1025`).
  `plan_materialize` is the graph node at that same moment, but it is the WRITER — it
  declares `effects: ["fs-write"]` — and a `hitl` block on an effectful node trips
  `EffectfulNodeContainsHitl` (`src/pge/topology/validate.ts:1101-1111`). `gate_plan_out`,
  one hop downstream, is effect-free by construction and reads the same `contracts` payload
  the imperative checkpoint answers, so it is the legal host.
- **`onReject: "graceful_failure"`**, matching the other two HITL nodes: a human who
  refuses the materialised contracts has refused the plan, and every downstream node is
  about to consume them. A rejection now routes to `graceful_failure` exactly as the
  imperative pipeline's own `post-sprint-contract` refusal aborts before the sprint loop.
- **The other five checkpoint ids the imperative pipeline records —
  `pre-curator`, `pre-generator`, `pre-evaluator`, `pre-code-reviewer`, `post-sprint` —
  remain PERMANENTLY UNDECLARABLE.** Every one sits inside the sprint fan-out region
  (`computeFanOutRegion`, `src/pge/runtime/interpreter.ts:490`), where declaring a `hitl`
  is `InterruptInsideFanOut` at `severity: "error"` — confirmed empirically for this
  release by running the shipped validator against a clone of the committed artifact with
  each of the five ids attached, one at a time, to its natural in-region node
  (`src/pge/topology/coding.graph.test.ts`, "the five checkpoint ids
  arch-20260814-pge-full-convergence-adr-1 leaves undeclarable"). See
  `.bober/architecture/arch-20260814-pge-full-convergence-adr-1.md` for the runtime
  argument: `Checkpoint.interrupt` holds one pending interrupt, `grantScope`/`clearScope`
  are branch-blind, and `resumeMessageId` collapses every branch's decision onto one
  message row.
- **`audits` STAYS in the conformance divergence set** pinned in
  `src/orchestrator/workflow/conformance.engines.test.ts` (unchanged by this entry — four
  fields at 1.5.0; sprint 4 of the same spec has since dropped `history` from that pin and
  sprint 6 dropped `contracts`, leaving two — `audits` and `pipelineResult` — and `audits` is
  unaffected either way).
  Declaring one more id narrows what the divergence records — the graph now records at
  most two distinct checkpoint ids per run (`post-sprint-contract`, `end-of-pipeline`)
  instead of one, against the imperative engine's eight — but the SET still diverges, so
  the field does not close. See [Engine migration disposition](#engine-migration-disposition)
  point 1 for the full, currently-measured record.
- **What did NOT move:** the golden dataset's node-coverage floor (`gate_plan_out` was
  already executed; see [How much of the graph the committed cases
  execute](#how-much-of-the-graph-the-committed-cases-execute)), and the imperative
  pipeline's own behaviour — `outOfScope[5]` of this spec forbids changing it, so the
  shared conformance config (`conformanceConfig()`,
  `src/pge/engine/__fixtures__/whole-graph.ts`) was left exactly as autopilot as before.

### 1.4.0 — a new scalar channel so a plan that never settles can report failure

Sprint 7 of spec-20260812-pge-real-workload-errors fixed the defect recorded in [A defect
this coverage work surfaced](#a-defect-this-coverage-work-surfaced): a planner that never
converges exhausts `planClarifyRounds`, reaches `graceful_failure` with `state.spec` still
null, and `commit.finalize` used to throw `FinalizeWithoutSpecError` instead of returning a
failed `PipelineResult`.

- **A new scalar channel, `specDraft`.** `PlanSpec`-schemaed, reducer `replaceIfNewer`, sole
  writer `plan_draft`. Adding `spec` itself to a second node's `writes` was verified
  structurally illegal rather than merely costly: `spec`'s reducer is declared scalar
  (`src/contracts/topology.ts:133`) and the validator emits
  `MultipleWritersOnScalarChannel` at severity `error` for any scalar channel with more than
  one writer (`src/pge/topology/validate.ts:704-716`) — `plan_materialize` already writes
  `spec`, and `plan_clarify` writes only `messages`.
- **`plan_draft` writes it on EVERY round**, clarifying or settled, so a run whose
  `planClarifyRounds` budget runs out still leaves a draft behind even though
  `plan_materialize` never ran and `state.spec` stays null.
- **`maxInlineBytes: 65,536` — `capForCorpusMax(29,214)`**, MEASURED rather than sized by
  analogy to `spec`'s own 131,072, even though the two channels share a schema:
  `capForCorpusMax` is a function of a corpus, never a value someone picks because a sibling
  channel happens to be PlanSpec-shaped too. The corpus's `specDraft` maximum
  (`.bober/workload/specDraft-spec-20260805-pge-graph-engineering.json`, provenance "file",
  29,214 canonical bytes — see [A committed workload corpus](#a-committed-workload-corpus))
  is this repository's OWN real committed plan, restated under the `specDraft` channel — a
  real payload rather than an invented one, because `spec` and `specDraft` hold IDENTICAL
  bytes by construction whenever clarification settles without a round trip (the common
  case, including the very measurement `real-workload.test.ts` makes). Leaving this channel
  at the graph's brand-new-channel default of 4,096 would have silently dropped that exact
  real write, reproducing for `specDraft` the identical defect `1.3.0` fixed for `spec`
  itself — caught by `real-workload.test.ts`'s own zero-`StateBloatError`-rejections
  guarantee (sc-4-1) going false the moment this channel started being written. Pinned
  two-directionally in `src/pge/golden/workload.test.ts` exactly like every other channel.
- **`commit.finalize` (`src/pge/runtime/commit.ts`) falls back to `state.specDraft`** when
  `state.spec` is null: the run now RESOLVES with `success: false`, `needsClarification:
  true` and a populated `errors` array (layered onto the returned `PipelineResult` by
  `PgeEngine.run` from the interpreter's own `LoopExhausted` `TaskFailure` — sprint 5's
  machinery, unmodified) instead of throwing. `FinalizeWithoutSpecError` is NARROWED, not
  deleted: it still throws when NEITHER `spec` NOR `specDraft` was ever written.
- **The case the old crash made impossible to record is now captured**: the committed
  `replay-plan-clarify-rounds-exhausted` golden case drives a planner that never accepts an
  answer to the `planClarifyRounds` bound of 3 and reaches `graceful_failure` with a
  resolved, failed `PipelineResult`. All six committed `replay` cases were recaptured for
  the `graphVersion` bump; the diff outside the new case is confined to the
  `graph.graphVersion` stamp, the same discipline `1.3.0`'s recapture used.
- Node, edge and subgraph counts are unchanged: 44 / 56 / 2. Channel count moves 10 → 11.

### 1.3.0 — sizing the channel caps to the committed corpus

Sprint 3 of spec-20260812-pge-real-workload-errors sized the two implicated channels off
the committed workload corpus (**A committed workload corpus** above) instead of the
shipped default, using `capForCorpusMax` (`src/pge/golden/workload.ts`): the next power of
two at or above **2×** the corpus maximum, floored at `DEFAULT_MAX_INLINE_BYTES` (4,096).

- **`spec`: 4,096 → 131,072.** Corpus maximum **48,097** canonical bytes, the largest of
  the 50 committed `.bober/specs/*.json` files that both parse under their own schema and
  are at a terminal status (see **A committed workload corpus** above). `2 × 48,097 =
  96,194`; the next power of two at or above that is 131,072 (2¹⁷).
- **`sprintContracts`: 4,096 → 524,288.** Corpus maximum **135,106** canonical bytes, the
  largest `SprintContract[]` one spec's `sprints` resolves to (this repository's own
  14-sprint `spec-20260805-pge-graph-engineering`). `2 × 135,106 = 270,212`; the next
  power of two at or above that is 524,288 (2¹⁹).
- **The other eight channels are unchanged at 4,096** — each already satisfies
  `capForCorpusMax` of its own corpus maximum (see the corpus table above), so raising them
  would not be justified by anything this repository has ever actually committed.
  `defaults.maxInlineBytes` also stays 4,096: it is the conservative value a brand-new
  channel inherits before anyone has measured a corpus for it, not a value to track the two
  channels this sprint raised.
- Every cap is pinned two-directionally against the corpus in
  `src/pge/golden/workload.test.ts`: lowering a cap below what `capForCorpusMax` of its
  corpus maximum requires fails, and raising one with no corpus payload justifying it fails
  too, because the pin is EQUALITY to the derived function rather than an inequality.
  `StateBloatError` (`src/pge/runtime/commit.ts`) is unchanged — the check is re-sized, not
  removed, proven by a negative control that still rejects a value above the new cap.
- **What this did not fix, and what closed it afterwards.** Raising the two caps admits
  `plan_materialize`'s writes against this repository's own real spec and its 14 contracts —
  the rejections recorded in [The graph engine against a real
  workload](#the-graph-engine-against-a-real-workload) are gone, re-measured with the same
  harness. It did not, on its own, make the run reach a terminal node: with the caps raised,
  the fan-out across 14 real sprint contracts ran long enough to trip the interpreter's own
  runaway guard, `SuperstepLimitExceededError` at `DEFAULT_MAX_SUPERSTEPS = 200`
  (`src/pge/runtime/interpreter.ts`), before `commit.finalize` was ever reached — a
  different, newly-surfaced fact from the old `FinalizeWithoutSpecError`, recorded rather
  than chased inside a `maxInlineBytes` sprint's scope. Sprint 4 then measured that ceiling
  and raised the one `PgeEngine` itself configures (`PGE_ENGINE_MAX_SUPERSTEPS`, see the
  section linked above); the run reaches `graceful_failure` today. **That fix carries no
  changelog entry of its own and no version bump, because it changed no topology** — the
  ceiling is runtime configuration on the interpreter's `RunContext`, not a field of the
  committed artifact, so `1.3.0` stayed the current `graphVersion` through sprint 4, until
  the `specDraft` channel moved it to `1.4.0` in sprint 7.
- Node, edge, channel and subgraph counts are unchanged: 44 / 56 / 10 / 2.

### 1.2.0 — correcting two defects that made the graph unrunnable

- **Human checkpoint ids now name checkpoints that exist.** `hitl_commit` moved from the
  invented `hitl-commit` to the shipped `end-of-pipeline`, and `plan_clarify` from the
  invented `plan-clarify` to the shipped `post-plan`. The validator could not have caught
  this: a checkpoint id is a free string, and structural validation has no way to know
  which ids a mechanism answers. Both gates would have blocked for ever.
- **Process execution is now gated.** `gate_syntax`, `gate_anchor_regression` and
  `sprint_evaluate` moved from the ungated `process-exec` effect to `sandbox-exec`, and
  `gate_mock_coverage` — which does not execute anything — dropped its effect entirely.
- Node, edge, channel and subgraph counts are unchanged: 44 / 56 / 10 / 2.

### 1.1.0 — closing three unbounded cycles

- `gate_mock_coverage` gained the loop bound `mockCurationRounds` (2, then `sprint_exit`).
  Its re-curation cycle never reaches `sprint_route`, so it could not borrow that budget.
- `reduce_sprints` gained `fanoutRetries` (2, then `graceful_failure`). Its retry
  re-enters the fan-out without passing through the supervisor, so `supervisorRounds` did
  not bound it and the barrier could re-dispatch indefinitely.
- `sprint_correct` gained an explicit `sprintIterations` bound (3, then `sprint_exit`),
  deliberately sharing the router's counter so that gate-driven corrections
  (`gate_syntax`, `gate_anchor_regression`) are counted against the same three attempts.
- All three nodes additionally read and write `counters`, which is what makes their
  budgets observable.

### 1.0.0 — the initial authored artifact

- The first serializable topology: 44 nodes, 56 edges, 10 channels, 2 subgraphs, entry at
  `research_body`, sealed with a checksum over its canonical form.
- Established the invariants the validator enforces: boundary gates on every subgraph
  crossing, one writer per scalar channel, a cache policy only on effect-free nodes, the
  git effect only behind a human-in-the-loop node, and a declared loop bound in every
  cycle.
