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
predicate is false — gates fail **closed**, never through). Two of them additionally
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
| `gate_plan_out` | root | `spec-and-contracts-persisted` | `graceful_failure` | contracts:SprintContract | (none) |
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
- **Both human checkpoints name a checkpoint id that the shipped pipeline actually
  fires** — `post-plan` and `end-of-pipeline`. Earlier revisions of the artifact invented
  ids (`plan-clarify`, `hitl-commit`) that no mechanism answered, which made the gates
  unrunnable; see the [Changelog](#changelog) entry for 1.2.0.
- `plan_clarify` and `hitl_commit` both declare `onReject: graceful_failure` and declare
  **no effects**. An approval node that also wrote something could half-apply a rejected
  decision; separating the approval from the effect is what makes rejection total.

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
what raising `spec` and `sprintContracts` did, and did not, fix.

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

**38 of the 44 declared nodes execute, as of sprint 9 of
`spec-20260812-pge-real-workload-errors`.** The committed figure before that sprint read
**"39 of the 44"**, and the drop is a correction, not a regression: the earlier rule counted
a node as executed the moment its `nodeId` appeared in a span, with no check of that span's
`status`. `commit` is refused FAIL_CLOSED under the autopilot `noop` mechanism yet still
opens a span every time a case reaches it — the interpreter converts the refusal into
`{ status: "interrupted", errorClass: "FailClosed" }` before the node's own body is ever
entered — so the old rule counted `commit` as covered on the strength of a span that recorded
a REFUSAL. **The previous rule counted reached-but-refused nodes as covered; the corrected
rule requires at least one span with `status: "ok"`, which `commit`'s never is.** `commit`
is REACHED by four of the six committed `replay` cases — the `hitl_commit` gate that
precedes it admits every one of them — but never EXECUTED, and the two are different claims.
Nothing else in the executed set moved: the same five nodes the previous rule already
excluded are still excluded, for the same underlying facts (though one of their five
recorded reasons was itself corrected — see below).

The six nodes no case executes are pinned in `NEVER_EXECUTED`. Four are genuine
**structural blocks** — no set of bindings can reach them — and two, `critique` and
`rework_route`, are a **missing scenario** rather than a structural block, which the source
comment says explicitly rather than folding them into the same claim as their four
neighbours:

| node | why no case executes it |
| --- | --- |
| `commit` | reached by every case that reaches `hitl_commit`, but refused FAIL_CLOSED under the autopilot `noop` mechanism before its body runs — the sprint-13 divergence. Its span's status is always `"interrupted"`, never `"ok"`. Covering it needs a durable checkpoint mechanism, and the golden executor pins one config on purpose so a case reproduces everywhere. |
| `finalize` | its only edge in is `commit -> finalize`, and `commit` never completes with status `"ok"` (previous row). Same root cause as `commit`'s own row, not a second, independent block. |
| `context_compact` | its only edge in is `supervisor -> context_compact` under the `compact` label, which the shipped supervisor never selects: `supervisor.reads` is exactly `["branchStatus", "counters", "evaluations", "spec"]` — no `messages` — so the decision would read a channel the artifact does not authorise. Recorded as artifact drift in `nodes/supervisor.ts`. Re-verified against the committed artifact at `1.4.0`; unmoved by the `specDraft` channel sprint 7 added. |
| `critique` | **missing scenario, not a structural block.** Sits behind `route_after_eval`'s `rework` label, chosen whenever `evaluate_global` returns a non-pass verdict. `reduce_sprints`'s own gate refuses to admit the run into evaluation while any branch is `failed`/`abandoned`, re-dispatching it instead — so `evaluate_global` is only ever reached once every branch has already settled `"succeeded"`, and the only way it can still grade the run non-passing is a contract graded `"fail"` (`gradeContracts`, which treats one `fail` verdict anywhere in a contract's history as a PERMANENT fail even after a later `pass`) despite its branch succeeding. No committed case constructs that; it is a gap a new case could close. |
| `rework_route` | inherits `critique`'s gap, and is likewise a missing scenario rather than a structural block — but even the missing case would not make it dispatch anything: its own re-dispatch rule excludes `"succeeded"` branches, and by the time it can run at all every branch already IS `"succeeded"` (`critique`'s row). It would still produce a `status: "ok"` span, choosing `"exhausted"` instead of `"rework"`. |
| `synthesize` | **structural block, and the one recorded reason this sprint rewrote.** Reachable only via `route_after_eval`'s `partial` label, which needs a SECOND invocation of `route_after_eval` with its rework counter at the declared bound of 2 — and that second invocation never happens. `rework_route` reads the identical counter and bound the interpreter enforces on `rework_route` itself, and because `rework_route`'s dispatch set is always empty when it runs (previous row), it never selects its own `"rework"` fan-out — the one edge that would loop back and reach `evaluate_global` again — so it always exits straight to `graceful_failure` on its first and only invocation per run. No golden case can close this; it is dead code by construction. An earlier analysis (sprint 7) attributed this to `rework_route`'s dispatch set being empty "because nothing ever writes `abandoned`" — the conclusion was right, the mechanism was not: `abandoned` is irrelevant, since the exclusion that actually bites is `"succeeded"`, which every branch already is by the time `rework_route` can run at all. |

The pin is **two-directional**, like the conformance divergence set: a node that stops being
executed fails, and a node that *starts* being executed fails too — because each entry above
is a claim about why something is unreachable, and a node leaving the list means one of
those claims stopped being true and the explanation should be deleted deliberately. Sprint 9
proved both directions by mutation against synthetic spans rather than only against the real
six-case dataset — `src/pge/golden/coverage.test.ts`'s "the status-ok rule, mutated in both
directions" block — because the real dataset can only ever demonstrate the direction its own
six cases happen to exercise.

With the corrected rule, `38 / 44 ≈ 86.4%` still clears the dataset's own floor of "strictly
greater than 85%" (`covers a substantial majority of the graph, so the pin is not vacuous`,
same file) without that floor moving — NFR0 forbids lowering a gate to protect a number, and
this sprint did not need to.

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
(`replay-plan-clarify-rounds-exhausted`) does not have at all. At the dataset's current 6 replay
cases this still drifts exactly 2 of them — the same failure count the fixed-count version
produced — so the fix changed nothing about what today's run catches, only whether a future
count keeps catching it.

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
| run status / verdict | `completed` / `failed` (the interpreter's OWN richer verdict; see below) |
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
  `GraphRunResult.verdict` reads `"failed"` (it accounts for the `FailClosed`
  `TaskFailure`), and `PgeEngine.run`'s returned `PipelineResult.success` is still `true`,
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
  `verdict: "failed"` sitting next to `engineOutcome: {kind: "resolved", success: true}`; the
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
  `equivalent: false`, with exactly **four** pinned divergent fields: `history`, `audits`,
  `contracts`, `pipelineResult`. The comparison was non-vacuous: all conformance fields
  were present. The pins live in
  `src/orchestrator/workflow/conformance.engines.test.ts`.
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
- **What the `contracts` divergence IS, and what `spec-20260812-terminal-vocabulary` sprint 1
  did *not* move.** The two engines pick different words out of the same nine-member
  `ContractStatusSchema` for the same outcome: `runSprintCycle` writes `"passed"`, the graph's
  `sprint_review` writes `"completed"` (`src/pge/nodes/sprint-review.ts:203`; the persisted
  value is pinned at `src/pge/nodes/sprint-evaluate.test.ts:762`). That sprint converged the
  **readers** on the split rather than the writers: `src/contracts/sprint-contract.ts` is now
  the single definition site, exposing `isSettledContractStatus` (`passed | completed` —
  *finished successfully*) and `isTerminalContractStatus` (adds `failed` — *stopped at all*,
  derived from the settled set so the two cannot diverge), and six production readers call one
  of them. **No writer changed, so the divergence set above is unmoved** — `contracts` closes
  when the two engines agree on the word, which is that spec's sprints 3 and 5.
- **One graph-runtime reader was deliberately NOT migrated, and it is a live defect.**
  `verdictFrom` (`src/pge/runtime/interpreter.ts:728`) derives a run's verdict from the count of
  `state.sprintContracts` entries whose status is the literal `"passed"` — a word no PGE run
  writes — so for a graph run that count is **zero**, and every consequence under-reports: a
  terminal-declared `success` that the interpreter downgrades because it recorded failures can
  only become `failed`, never `partial`; a declared `failed` never softens to `partial`; and a
  run that reaches a terminal without declaring a verdict is `failed` even when every branch
  settled. **Migrating the literal alone would not fix it.** The same channel keeps the seeded
  `"proposed"` copy of each contract — `appendById` resolves a duplicate `contractId` by
  canonical order, and `"completed" < "proposed"` — asserted as a known limitation at
  `src/pge/nodes/sprint-evaluate.test.ts:775-777`, and the same mechanism the `pipelineResult`
  divergence is blamed on (`src/orchestrator/workflow/conformance.engines.test.ts:291-297`). The rank-aware channel join is the other half. The site is
  carried, with that reason, in `src/contracts/status-vocabulary.invariant.test.ts`'s allowlist,
  so it cannot be forgotten silently.

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
a channel to say so, but the divergence set is still exactly `history`, `audits`,
`contracts`, `pipelineResult` at `equivalent: false` — none of the four was in its scope —
so PGE remains opt-in and `TsPipelineEngine` remains the oracle.

**This decision is enforced, not just recorded.**
`src/orchestrator/workflow/oracle-retention.test.ts` asserts that the schema still defaults
`pipeline.engine` to `"ts"` (read from the schema, never from a checkout's own
`bober.config.json`), that `TsPipelineEngine` still constructs and is still what the
default config *selects*, that it is still the fallback `PgeEngine` downgrades to, and
that `conformance.engines.test.ts` still constructs **both** real engines, is not skipped
or focused, and still pins `equivalent: false` with all four divergent fields named. An
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
