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

Artifact facts, as committed: `graphId: "coding"`, `graphVersion: "1.2.0"`,
`formatVersion: 1`, `entry: "research_body"` — **44 nodes, 56 edges, 10 channels,
2 subgraphs**. Node kinds: 15 `llm`, 13 `gate`, 7 `router`, 7 `tool`, 2 `subgraph`.
Graph defaults: `concurrency: 1`, `durability: "superstep"`, `maxInlineBytes: 4096`,
`modelTier: "light"`, `supervisorNodeId: "supervisor"`.

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
| `plan_draft` | llm | Produces a plan-spec draft with sprint contracts and clarification questions from the research digest. |
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

State is not a blob passed from node to node; it is ten typed channels, each with a
declared reducer that merges concurrent writes deterministically. `scope: public` means
the channel is visible across regions; the one `private` channel is per-branch bookkeeping.
Two channels are **scalar** — exactly one node may write them — which is what makes the
spec and the run verdict single-sourced.

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
| `sprintContracts` | public | appendById | SprintContract | plan_materialize, sprint_exit |
| `testAnchors` | public | setUnion | TestAnchors | sprint_evaluate |
| `verdict` | public | replaceIfNewer | RunVerdict | finalize |
<!-- /pge:channels -->

The `counters` channel is where every loop counter listed in
[The loop bounds](#the-loop-bounds) lives; its `maxNumber` reducer is what makes a counter
monotonic under concurrent branch writes, so two branches incrementing the same key cannot
lose an increment and under-count a budget.

## The golden dataset: what it proves and what it does not

`.bober/golden/` holds regression cases: an input, the **pinned provider responses** for
that input, and the expected artifacts. The regression runner replays each case with every
outward call answered from the recording and compares the artifacts produced.

Every case declares, in its own file, how it is **enforced** — there is no default,
because both possible defaults are wrong:

| `enforcement` | what happens to it | where its expectation came from |
| --- | --- | --- |
| `replay` | **executed** against the shipped `PgeEngine` over the committed artifact, and its artifacts compared with the expectation | captured from a real run by `src/pge/golden/capture.ts` |
| `integrity` | checked for schema validity and against the committed graph; **not executed**, and it makes no runtime claim | hand-authored prose plus a partial pin set |

The split exists because the two kinds of case are not interchangeable. A hand-authored
case pins the calls a reader would find interesting rather than the complete call sequence
a run makes, so replaying one throws `MissingRecordingError` at the first call its author
did not think to write down — which says nothing whatsoever about the runtime. A captured
case is complete by construction. Running the hand-authored cases against a real engine
would make the blocking job permanently red, and a permanently-red required job is waived
within a week, taking the enforced half with it.

What stops the split from eroding is a **floor**: `GOLDEN_MIN_REPLAY_CASES` in
`src/pge/golden/case-schema.ts`, checked as part of dataset validity. Relabelling a failing
`replay` case as `integrity` to get a green build drops the count below the floor and fails
the dataset check itself, so the only ways to make a failing case green are to fix the
runtime or to re-capture it — and a re-capture is a visible diff that says which artifacts
changed.

### How much of the graph the executed cases reach

The case count is the wrong number to judge this dataset by: five cases that walk the same
happy path enforce one path. The number that matters is **node coverage**, and it is
measured rather than asserted — `src/pge/golden/coverage.test.ts` executes every committed
`replay` case, reads the node ids out of the resulting span files, and pins the executed
set against the committed artifact.

**39 of the 44 declared nodes execute.** The five that do not are pinned in
`NEVER_EXECUTED`, and every one is a **structural block** rather than a missing scenario —
no set of bindings can reach them:

| node | why no case reaches it |
| --- | --- |
| `finalize` | its only edge in is `commit -> finalize`, and `commit` is refused FAIL_CLOSED under the autopilot `noop` mechanism — the sprint-13 divergence. Covering it needs a durable mechanism, and the executor pins one config so a case reproduces everywhere. |
| `context_compact` | its only edge in is `supervisor -> context_compact` under the `compact` label, which the shipped supervisor never selects: `supervisor.reads` omits `messages`, so the decision would read a channel the artifact does not authorise. Recorded as artifact drift in `nodes/supervisor.ts`. |
| `critique`, `rework_route`, `synthesize` | they sit behind `route_after_eval`'s `rework` and `partial` labels, which need `evaluate_global` to be reached with a non-pass verdict. Every failing path available through the collaborator seam settles earlier — the evaluation-fails case exhausts `fanoutRetries` at `reduce_sprints` and reaches `graceful_failure` without ever reaching the global evaluation. |

The pin is **two-directional**, like the conformance divergence set: a node that stops being
executed fails, and a node that *starts* being executed fails too — because each entry above
is a claim about why something is unreachable, and a node leaving the list means one of
those claims stopped being true and the explanation should be deleted deliberately.

### A defect this coverage work surfaced

A planner that keeps asking for clarification exhausts `planClarifyRounds` and reaches
`graceful_failure` **with `state.spec` still null**, and `commit.finalize` then throws
`FinalizeWithoutSpecError` instead of returning a failed `PipelineResult`. An unattended run
whose plan never settles therefore crashes the engine rather than reporting a failure.

It is not captured as a golden case precisely because it throws — `captureGoldenCase` cannot
record a run that never produces a result. The committed
`replay-plan-clarification-round` case drives one clarification round and settles, which is
what puts `plan_clarify` on an executed path; a `clarifyingBindings(99)` scenario pinning the
bound becomes possible once the terminal path returns a result instead of throwing.

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
  nevertheless reports `success: true`, because `PipelineResult` has no error channel.
  Both engines report success; only the artifacts differ.

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
across real runs, plus an error channel on `PipelineResult` so a fail-closed refusal
cannot be reported as success.

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
