import type { TopologySpec } from "../../contracts/topology.js";
import { checksumTopology } from "./canonical.js";

/**
 * The shipped agent-bober coding pipeline, authored as a plain typed object literal.
 *
 * This module is DATA. It imports the topology contract and the pure checksum helper
 * and nothing else — no node body, no registry, no executor. `bober pge dump`
 * serializes it to `.bober/topology/coding.json`, and the runtime (a later sprint)
 * loads THAT JSON, never this module, so the committed artifact stays load-bearing
 * (ADR-2).
 *
 * It describes the pipeline agent-bober already runs imperatively in
 * `src/orchestrator/pipeline.ts`; it is a description of shipped behaviour, not a
 * proposal for new behaviour.
 *
 * ── Where this differs from the architecture's mermaid blueprint ──
 *
 * The blueprint draws `START -> gate_research_in -> {{subgraph research}}` and
 * `supervisor -> gate_sprint_in -> fanout_sprints -> {{subgraph sprint}}`. Under the
 * sprint-1 schema a subgraph boundary must be crossed THROUGH a gate node
 * (`BoundaryNotGated`), so each boundary gate sits on the subgraph side of its
 * boundary and the subgraph call-site node sits at the root:
 *
 *   research_body (root, call site) -> gate_research_in (research) -> research interior
 *   fanout_sprints (root) -fanout-> sprint_body (root, call site) -> gate_sprint_in (sprint)
 *
 * Every node id named in the blueprint is present, and this is the ONLY shape
 * difference: the two entry gates move relative to their call sites. No node changes
 * subgraph membership and no edge is reordered.
 *
 * The blueprint's fan-in order is reproduced exactly:
 *
 *   sprint_exit (sprint) -> gate_sprint_out (sprint) -> reduce_sprints (ROOT) -> supervisor
 *
 * The first two hops are inside the fan-out and run once per dispatched branch;
 * `reduce_sprints` is declared at the ROOT (`subgraph: null`) so it is a single
 * instance where the branches converge, and exactly one edge reaches the supervisor
 * per fan-out rather than one per branch. Its failed-branch retry is
 * `gate.onFail -> fanout_sprints`, matching the blueprint's `BAR --> FAN` edge.
 *
 * Sprint 1's `SubgraphExitNotSupervisor` originally required the exit gate to route
 * DIRECTLY to the supervisor, which made this shape unrepresentable and would have
 * forced the barrier inside the `sprint` subgraph — where, being per-branch, it could
 * not join anything. That rule now also accepts a root-level fan-in barrier gate whose
 * every edge routes to the supervisor (see `collectSubgraphRules` in validate.ts); the
 * invariant "control returns to the supervisor" is preserved, one declared hop later.
 *
 * The plan and evaluation regions are NOT declared subgraphs — the blueprint marks
 * only `research` and `sprint` with the subgraph shape — so their gates
 * (`gate_plan_in/out`, `gate_eval_in`) are ordinary root-level gates.
 */

// ── Schema catalog ──────────────────────────────────────────────────

/**
 * Every `schemaRef` this topology names, as a closed list.
 *
 * `validateTopology(mode: "full")` takes an injected {@link SchemaCatalog}; until the
 * Zod-resolving catalog ships with the compiler, this list IS the catalog the `bober
 * pge validate --mode full` composition root builds. A ref absent from it surfaces as
 * `UnknownSchemaRef` instead of passing silently.
 */
export const CODING_SCHEMA_REFS: readonly string[] = Object.freeze([
  "BranchStatus",
  "BudgetLedger",
  "Counters",
  "FeatureRequest",
  "GraphMessage",
  "PlanSpec",
  "ResearchDigest",
  "RunVerdict",
  "ScratchRef",
  "SprintContract",
  "SprintVerdict",
  "TestAnchors",
]);

// ── Placeholder checksum ────────────────────────────────────────────

/**
 * The literal is sealed in two steps because `canonicalize` elides `checksum`: the
 * unsealed value carries a placeholder, and {@link CODING_GRAPH} replaces it with the
 * checksum of its own canonical form. A hand-maintained hex constant would go stale
 * on the first edit; this cannot.
 */
const UNSEALED_CHECKSUM = `sha256:${"0".repeat(64)}`;

// ── The authored graph ──────────────────────────────────────────────

const CODING_GRAPH_UNSEALED: TopologySpec = {
  formatVersion: 1,
  graphId: "coding",
  graphVersion: "1.0.0",
  description:
    "The agent-bober coding pipeline: research reflexion loop, planner with a clarification loop, supervisor, bounded sprint subgraph with curator/security/evaluation gates, global evaluation with rework, synthesis, documentation, gated commit, graceful failure and context compaction.",
  provenance: "authored",
  entry: "research_body",
  defaults: {
    supervisorNodeId: "supervisor",
    modelTier: "light",
    concurrency: 1,
    durability: "superstep",
    maxInlineBytes: 4096,
  },

  // ── Channels ──────────────────────────────────────────────────────
  channels: [
    {
      id: "messages",
      reducerRef: "appendById",
      schemaRef: "GraphMessage",
      scope: "public",
      maxInlineBytes: 4096,
    },
    {
      id: "evaluations",
      reducerRef: "appendById",
      schemaRef: "SprintVerdict",
      scope: "public",
      maxInlineBytes: 4096,
    },
    {
      id: "refs",
      reducerRef: "appendById",
      schemaRef: "ScratchRef",
      scope: "public",
      maxInlineBytes: 4096,
    },
    {
      id: "counters",
      reducerRef: "maxNumber",
      schemaRef: "Counters",
      scope: "public",
      maxInlineBytes: 4096,
    },
    {
      id: "branchStatus",
      reducerRef: "lastWriteWinsByKey",
      schemaRef: "BranchStatus",
      scope: "private",
      maxInlineBytes: 4096,
    },
    {
      id: "testAnchors",
      reducerRef: "setUnion",
      schemaRef: "TestAnchors",
      scope: "public",
      maxInlineBytes: 4096,
    },
    {
      id: "sprintContracts",
      reducerRef: "appendById",
      schemaRef: "SprintContract",
      scope: "public",
      maxInlineBytes: 4096,
    },
    {
      // Scalar: `replaceIfNewer` makes a second writer a MultipleWritersOnScalarChannel
      // error, which is why only plan_materialize writes it.
      id: "spec",
      reducerRef: "replaceIfNewer",
      schemaRef: "PlanSpec",
      scope: "public",
      maxInlineBytes: 4096,
    },
    {
      id: "ledger",
      reducerRef: "mergeLedger",
      schemaRef: "BudgetLedger",
      scope: "public",
      maxInlineBytes: 4096,
    },
    {
      // Scalar, single writer: `finalize` owns the terminal verdict. The graceful
      // failure path records its failure classes in branchStatus instead.
      id: "verdict",
      reducerRef: "replaceIfNewer",
      schemaRef: "RunVerdict",
      scope: "public",
      maxInlineBytes: 4096,
    },
  ],

  // ── Nodes ─────────────────────────────────────────────────────────
  nodes: [
    // ── Research region ─────────────────────────────────────────────
    {
      id: "research_body",
      kind: "subgraph",
      title: "Research subgraph call site",
      doc: "Root-level call site for the research subgraph; the graph entry point. Holds the feature request and hands it to the research entry gate.",
      subgraph: null,
      role: "utility",
      inputPorts: [],
      outputPorts: [{ key: "request", schemaRef: "FeatureRequest", required: true }],
      reads: [],
      writes: [],
      effects: [],
      subgraphRef: "research",
    },
    {
      id: "gate_research_in",
      kind: "gate",
      title: "Research entry gate",
      doc: "Boundary gate admitting the feature request into the research subgraph. Fails closed to graceful_failure when no feature request is present.",
      subgraph: "research",
      role: "utility",
      inputPorts: [{ key: "request", schemaRef: "FeatureRequest", required: true }],
      outputPorts: [{ key: "request", schemaRef: "FeatureRequest", required: true }],
      reads: [],
      writes: [],
      effects: [],
      gate: { check: "feature-request-present", onFail: "graceful_failure" },
    },
    {
      id: "research_reflect",
      kind: "llm",
      title: "Reflect on the research question",
      doc: "Turns the feature request into the exploration questions the explorer will answer, and records the reflexion round in counters.",
      subgraph: "research",
      role: "researcher",
      modelTier: "frontier",
      promptRef: "research/reflect",
      inputPorts: [{ key: "request", schemaRef: "FeatureRequest", required: true }],
      outputPorts: [{ key: "digest", schemaRef: "ResearchDigest", required: true }],
      reads: ["messages"],
      writes: ["messages", "counters", "ledger"],
      effects: [],
    },
    {
      id: "research_explore",
      kind: "llm",
      title: "Explore the codebase",
      doc: "Answers the reflexion questions against the real codebase and offloads oversized findings to scratch refs.",
      subgraph: "research",
      role: "researcher",
      modelTier: "frontier",
      promptRef: "research/explore",
      inputPorts: [{ key: "digest", schemaRef: "ResearchDigest", required: true }],
      outputPorts: [{ key: "digest", schemaRef: "ResearchDigest", required: true }],
      reads: ["messages"],
      writes: ["messages", "refs", "ledger"],
      effects: [],
    },
    {
      id: "research_critique",
      kind: "llm",
      title: "Critique the research findings",
      doc: "Grades the exploration for unanswered questions and unsupported claims. Effect-free, so it may declare a cache policy.",
      subgraph: "research",
      role: "reviewer",
      modelTier: "light",
      promptRef: "research/critique",
      inputPorts: [{ key: "digest", schemaRef: "ResearchDigest", required: true }],
      outputPorts: [{ key: "digest", schemaRef: "ResearchDigest", required: true }],
      reads: ["messages", "refs"],
      writes: ["messages", "ledger"],
      effects: [],
      cache: { ttlSeconds: 3600, scope: "run" },
    },
    {
      id: "research_route",
      kind: "router",
      title: "Research reflexion router",
      doc: "Sends the critique back for another exploration round until the reflexion budget is spent, then collects what exists.",
      subgraph: "research",
      role: "router",
      modelTier: "light",
      inputPorts: [{ key: "digest", schemaRef: "ResearchDigest", required: true }],
      outputPorts: [],
      reads: ["counters"],
      writes: ["counters"],
      effects: [],
      loop: { counterKey: "researchReflexions", maxIterations: 3, onExhausted: "research_collect" },
      targets: [
        { label: "retry", to: "research_explore" },
        { label: "done", to: "research_collect" },
      ],
    },
    {
      id: "research_collect",
      kind: "tool",
      title: "Collect the research document",
      doc: "Writes the consolidated research document under .bober/research/ and records its scratch ref.",
      subgraph: "research",
      role: "utility",
      inputPorts: [{ key: "digest", schemaRef: "ResearchDigest", required: true }],
      outputPorts: [{ key: "digest", schemaRef: "ResearchDigest", required: true }],
      reads: ["messages", "refs"],
      writes: ["messages", "refs"],
      effects: ["fs-write"],
      toolRef: "research.collect",
    },
    {
      id: "gate_research_out",
      kind: "gate",
      title: "Research exit gate",
      doc: "Boundary gate returning the research digest to the supervisor; fails closed when no research document was produced.",
      subgraph: "research",
      role: "utility",
      inputPorts: [{ key: "digest", schemaRef: "ResearchDigest", required: true }],
      outputPorts: [{ key: "digest", schemaRef: "ResearchDigest", required: true }],
      reads: [],
      writes: [],
      effects: [],
      gate: { check: "research-document-written", onFail: "graceful_failure" },
    },

    // ── Supervisor and context compaction ───────────────────────────
    {
      id: "supervisor",
      kind: "router",
      title: "Supervisor",
      doc: "Dispatches the next phase (plan, sprints, evaluate) and folds each subgraph result back into the run. Bounded so a phase cycle cannot spin forever.",
      subgraph: null,
      role: "router",
      modelTier: "light",
      inputPorts: [],
      outputPorts: [],
      reads: ["branchStatus", "counters", "spec", "evaluations"],
      writes: ["counters"],
      effects: [],
      loop: { counterKey: "supervisorRounds", maxIterations: 12, onExhausted: "graceful_failure" },
      targets: [
        { label: "plan", to: "gate_plan_in" },
        { label: "sprints", to: "fanout_sprints" },
        { label: "evaluate", to: "gate_eval_in" },
        { label: "compact", to: "context_compact" },
      ],
    },
    {
      id: "context_compact",
      kind: "tool",
      title: "Compact the conversation context",
      doc: "Runs at a superstep boundary when the message window crosses the compression threshold: summarises older messages to scratch and re-injects the digest.",
      subgraph: null,
      role: "utility",
      inputPorts: [],
      outputPorts: [],
      reads: ["messages", "refs"],
      writes: ["messages", "refs", "counters"],
      effects: ["fs-write"],
      toolRef: "context.compact",
    },

    // ── Plan region ─────────────────────────────────────────────────
    {
      id: "gate_plan_in",
      kind: "gate",
      title: "Plan entry gate",
      doc: "Admits the run into planning only when a research digest exists and the spec is absent or stale.",
      subgraph: null,
      role: "utility",
      inputPorts: [{ key: "brief", schemaRef: "ResearchDigest", required: true }],
      outputPorts: [{ key: "brief", schemaRef: "ResearchDigest", required: true }],
      reads: ["spec"],
      writes: [],
      effects: [],
      gate: { check: "research-digest-present", onFail: "graceful_failure" },
    },
    {
      id: "plan_draft",
      kind: "llm",
      title: "Draft the plan",
      doc: "Produces a PlanSpec draft with sprint contracts and clarification questions from the research digest.",
      subgraph: null,
      role: "planner",
      modelTier: "frontier",
      promptRef: "planner/draft",
      inputPorts: [{ key: "brief", schemaRef: "ResearchDigest", required: true }],
      outputPorts: [{ key: "draft", schemaRef: "PlanSpec", required: true }],
      reads: ["messages", "spec"],
      writes: ["messages", "ledger"],
      effects: [],
    },
    {
      id: "plan_clarify_check",
      kind: "router",
      title: "Clarification check",
      doc: "Routes to the human clarification interrupt while the draft still carries open questions and the clarification budget holds.",
      subgraph: null,
      role: "router",
      modelTier: "light",
      inputPorts: [{ key: "draft", schemaRef: "PlanSpec", required: true }],
      outputPorts: [{ key: "draft", schemaRef: "PlanSpec", required: true }],
      reads: ["counters", "messages"],
      writes: ["counters"],
      effects: [],
      loop: { counterKey: "planClarifyRounds", maxIterations: 3, onExhausted: "graceful_failure" },
      targets: [
        { label: "clarify", to: "plan_clarify" },
        { label: "ok", to: "plan_materialize" },
      ],
    },
    {
      id: "plan_clarify",
      kind: "gate",
      title: "Plan clarification interrupt",
      doc: "Human-in-the-loop interrupt collecting answers to the planner's open questions. Effect-free: the approval is a separate node from anything that writes.",
      subgraph: null,
      role: "utility",
      inputPorts: [{ key: "draft", schemaRef: "PlanSpec", required: true }],
      outputPorts: [{ key: "draft", schemaRef: "PlanSpec", required: true }],
      reads: ["messages"],
      writes: ["messages"],
      effects: [],
      gate: { check: "clarifications-answered", onFail: "graceful_failure" },
      hitl: { checkpointId: "plan-clarify", onReject: "graceful_failure" },
    },
    {
      id: "plan_materialize",
      kind: "tool",
      title: "Materialize the plan",
      doc: "Persists the PlanSpec and every SprintContract under .bober/. Sole writer of the scalar spec channel.",
      subgraph: null,
      role: "utility",
      inputPorts: [{ key: "draft", schemaRef: "PlanSpec", required: true }],
      outputPorts: [{ key: "contracts", schemaRef: "SprintContract", required: true }],
      reads: ["messages"],
      writes: ["spec", "sprintContracts", "refs"],
      effects: ["fs-write"],
      toolRef: "plan.materialize",
    },
    {
      id: "gate_plan_out",
      kind: "gate",
      title: "Plan exit gate",
      doc: "Returns control to the supervisor once the spec and its contracts are on disk; fails closed when persistence did not happen.",
      subgraph: null,
      role: "utility",
      inputPorts: [{ key: "contracts", schemaRef: "SprintContract", required: true }],
      outputPorts: [{ key: "contracts", schemaRef: "SprintContract", required: true }],
      reads: ["spec", "sprintContracts"],
      writes: [],
      effects: [],
      gate: { check: "spec-and-contracts-persisted", onFail: "graceful_failure" },
    },

    // ── Sprint region ───────────────────────────────────────────────
    {
      id: "fanout_sprints",
      kind: "router",
      title: "Sprint fan-out",
      doc: "Emits one branch per admitted contract. The fan-out edge targets the single sprint subgraph with runtime-determined cardinality, so the topology checksum is invariant to contract count.",
      subgraph: null,
      role: "router",
      modelTier: "light",
      inputPorts: [{ key: "contracts", schemaRef: "SprintContract", required: true }],
      outputPorts: [{ key: "contract", schemaRef: "SprintContract", required: true }],
      reads: ["sprintContracts", "branchStatus", "counters"],
      writes: ["counters"],
      effects: [],
      targets: [
        { label: "dispatch", to: "sprint_body" },
        { label: "drained", to: "supervisor" },
      ],
    },
    {
      id: "sprint_body",
      kind: "subgraph",
      title: "Sprint subgraph call site",
      doc: "Root-level call site for the sprint subgraph. Reached only through a fan-out edge, which is what puts the whole sprint region inside the fan-out region.",
      subgraph: null,
      role: "utility",
      inputPorts: [{ key: "contract", schemaRef: "SprintContract", required: true }],
      outputPorts: [{ key: "contract", schemaRef: "SprintContract", required: true }],
      reads: [],
      writes: [],
      effects: [],
      subgraphRef: "sprint",
    },
    {
      id: "gate_sprint_in",
      kind: "gate",
      title: "Sprint entry gate",
      doc: "Boundary gate admitting one contract branch into the sprint subgraph; a non-admissible contract short-circuits to the branch exit.",
      subgraph: "sprint",
      role: "utility",
      inputPorts: [{ key: "contract", schemaRef: "SprintContract", required: true }],
      outputPorts: [{ key: "contract", schemaRef: "SprintContract", required: true }],
      reads: ["sprintContracts", "branchStatus"],
      writes: [],
      effects: [],
      gate: { check: "contract-admissible", onFail: "sprint_exit" },
    },
    {
      id: "sprint_curate_explain",
      kind: "llm",
      title: "Curate and explain context",
      doc: "Selects the files this contract touches and explains them to the generator. Effect-free, so it may declare a cache policy.",
      subgraph: "sprint",
      role: "curator",
      modelTier: "light",
      promptRef: "curator/explain",
      inputPorts: [{ key: "contract", schemaRef: "SprintContract", required: true }],
      outputPorts: [{ key: "contract", schemaRef: "SprintContract", required: true }],
      reads: ["spec", "sprintContracts", "messages"],
      writes: ["messages", "refs", "ledger"],
      effects: [],
      cache: { ttlSeconds: 1800, scope: "run" },
    },
    {
      id: "sprint_curate_mocks",
      kind: "llm",
      title: "Curate mock boundaries",
      doc: "Writes the fixtures and boundary mocks the sprint's tests need before any implementation exists.",
      subgraph: "sprint",
      role: "curator",
      modelTier: "frontier",
      promptRef: "curator/mocks",
      inputPorts: [{ key: "contract", schemaRef: "SprintContract", required: true }],
      outputPorts: [],
      reads: ["messages", "refs"],
      writes: ["messages", "refs", "ledger"],
      effects: ["fs-write"],
    },
    {
      id: "gate_mock_coverage",
      kind: "gate",
      title: "Mock coverage gate",
      doc: "Rejects a sprint whose declared boundaries are not covered by fixtures, sending it back to the mock curator.",
      subgraph: "sprint",
      role: "utility",
      inputPorts: [],
      outputPorts: [],
      reads: ["refs"],
      writes: [],
      effects: ["process-exec"],
      gate: { check: "mock-coverage-threshold", onFail: "sprint_curate_mocks" },
    },
    {
      id: "sprint_generate",
      kind: "llm",
      title: "Generate the sprint",
      doc: "Implements one sprint contract against the curated context, writing source and collocated tests into the working tree.",
      subgraph: "sprint",
      role: "generator",
      modelTier: "frontier",
      promptRef: "generator/sprint",
      inputPorts: [],
      outputPorts: [],
      reads: ["spec", "sprintContracts", "messages", "refs"],
      writes: ["messages", "refs", "branchStatus", "ledger"],
      effects: ["fs-write"],
    },
    {
      id: "gate_syntax",
      kind: "gate",
      title: "Syntax gate",
      doc: "Runs typecheck and lint under the sandbox policy; any failure routes straight to the corrector without spending an evaluation.",
      subgraph: "sprint",
      role: "syntax",
      inputPorts: [],
      outputPorts: [],
      reads: [],
      writes: ["branchStatus"],
      effects: ["process-exec"],
      gate: { check: "typecheck-and-lint", onFail: "sprint_correct" },
    },
    {
      id: "sprint_security",
      kind: "llm",
      title: "Security audit the sprint diff",
      doc: "Fail-closed security review of the sprint diff; findings are recorded as evaluations before the terminal evaluator runs.",
      subgraph: "sprint",
      role: "reviewer",
      modelTier: "frontier",
      promptRef: "security/audit",
      inputPorts: [],
      outputPorts: [],
      reads: ["refs", "messages"],
      writes: ["messages", "evaluations", "ledger"],
      effects: [],
    },
    {
      id: "sprint_evaluate",
      kind: "llm",
      title: "Evaluate the sprint",
      doc: "Runs the sprint's evaluation strategies, executing the project test command under the sandbox policy and recording the anchor tests it observed green.",
      subgraph: "sprint",
      role: "terminal-evaluator",
      modelTier: "frontier",
      promptRef: "evaluator/sprint",
      inputPorts: [],
      outputPorts: [{ key: "verdict", schemaRef: "SprintVerdict", required: true }],
      reads: ["sprintContracts", "refs", "messages"],
      writes: ["evaluations", "messages", "testAnchors", "ledger"],
      effects: ["process-exec"],
    },
    {
      id: "gate_anchor_regression",
      kind: "gate",
      title: "Anchor regression gate",
      doc: "Re-runs the recorded anchor tests; a regression routes to the corrector regardless of the sprint's own verdict.",
      subgraph: "sprint",
      role: "utility",
      inputPorts: [{ key: "verdict", schemaRef: "SprintVerdict", required: true }],
      outputPorts: [{ key: "verdict", schemaRef: "SprintVerdict", required: true }],
      reads: ["testAnchors"],
      writes: ["branchStatus"],
      effects: ["process-exec"],
      gate: { check: "anchor-tests-still-green", onFail: "sprint_correct" },
    },
    {
      id: "sprint_route",
      kind: "router",
      title: "Sprint iteration router",
      doc: "Retries the branch through the corrector while the iteration budget holds, passes to review on success, and exits the branch when the budget is spent.",
      subgraph: "sprint",
      role: "router",
      modelTier: "light",
      inputPorts: [{ key: "verdict", schemaRef: "SprintVerdict", required: true }],
      outputPorts: [],
      reads: ["counters", "evaluations"],
      writes: ["counters"],
      effects: [],
      loop: { counterKey: "sprintIterations", maxIterations: 3, onExhausted: "sprint_exit" },
      targets: [
        { label: "retry", to: "sprint_correct" },
        { label: "pass", to: "sprint_review" },
        { label: "exhausted", to: "sprint_exit" },
      ],
    },
    {
      id: "sprint_correct",
      kind: "llm",
      title: "Correct the sprint",
      doc: "Applies the evaluator's and the gates' feedback to the working tree, then hands back to the generator for the next attempt.",
      subgraph: "sprint",
      role: "generator",
      modelTier: "frontier",
      promptRef: "generator/correct",
      inputPorts: [],
      outputPorts: [],
      reads: ["evaluations", "messages", "refs"],
      writes: ["messages", "refs", "ledger"],
      effects: ["fs-write"],
    },
    {
      id: "sprint_review",
      kind: "llm",
      title: "Review the sprint diff",
      doc: "Advisory code review of a passing sprint diff against the contract and the anti-pattern catalogue.",
      subgraph: "sprint",
      role: "reviewer",
      modelTier: "frontier",
      promptRef: "reviewer/sprint",
      inputPorts: [],
      outputPorts: [],
      reads: ["refs", "messages"],
      writes: ["messages", "evaluations", "ledger"],
      effects: [],
    },
    {
      id: "sprint_exit",
      kind: "tool",
      title: "Exit the sprint branch",
      doc: "Records the branch verdict and flushes the contract's artifacts; the single per-branch termination point.",
      subgraph: "sprint",
      role: "utility",
      inputPorts: [],
      outputPorts: [],
      reads: ["evaluations"],
      writes: ["branchStatus", "sprintContracts"],
      effects: ["fs-write"],
      toolRef: "sprint.exit",
    },
    {
      id: "gate_sprint_out",
      kind: "gate",
      title: "Sprint exit gate",
      doc: "Boundary gate releasing ONE settled branch out of the sprint subgraph; the sprint subgraph's declared exit gate. It runs per branch, so it cannot itself be the join — it hands off to the root-level barrier reduce_sprints.",
      subgraph: "sprint",
      role: "utility",
      inputPorts: [],
      outputPorts: [],
      reads: ["branchStatus"],
      writes: [],
      effects: [],
      gate: { check: "branch-verdicts-recorded", onFail: "graceful_failure" },
    },
    {
      // ROOT-LEVEL (`subgraph: null`) ON PURPOSE — see the fan-in barrier note in the
      // module header. A barrier declared inside `sprint` would be instantiated once per
      // dispatched branch and could not join anything.
      id: "reduce_sprints",
      kind: "gate",
      title: "Sprint fan-in barrier",
      doc: "The single join for the sprint fan-out: every branch leaves its subgraph through gate_sprint_out and converges here. Waits for every dispatched branch to settle, then makes ONE return to the supervisor. On a failed branch it routes back to the fan-out with jittered backoff (gate.onFail); the retry budget is the global supervisorRounds bound.",
      subgraph: null,
      role: "utility",
      inputPorts: [],
      outputPorts: [],
      reads: ["branchStatus", "counters"],
      writes: ["counters"],
      effects: [],
      gate: { check: "all-branches-settled", onFail: "fanout_sprints" },
    },

    // ── Evaluation region ───────────────────────────────────────────
    {
      id: "gate_eval_in",
      kind: "gate",
      title: "Evaluation entry gate",
      doc: "Admits the run into global evaluation once every sprint branch has settled.",
      subgraph: null,
      role: "utility",
      inputPorts: [],
      outputPorts: [],
      reads: ["branchStatus", "evaluations"],
      writes: [],
      effects: [],
      gate: { check: "all-sprints-settled", onFail: "graceful_failure" },
    },
    {
      id: "evaluate_global",
      kind: "llm",
      title: "Evaluate the whole spec",
      doc: "Grades the run against the spec's acceptance criteria rather than any single contract.",
      subgraph: null,
      role: "terminal-evaluator",
      modelTier: "frontier",
      promptRef: "evaluator/global",
      inputPorts: [],
      outputPorts: [{ key: "verdict", schemaRef: "SprintVerdict", required: true }],
      reads: ["evaluations", "branchStatus", "spec"],
      writes: ["messages", "evaluations", "ledger"],
      effects: [],
    },
    {
      id: "route_after_eval",
      kind: "router",
      title: "Post-evaluation router",
      doc: "Chooses between documenting a passing run, synthesising a partial one, reworking failed branches, and failing gracefully.",
      subgraph: null,
      role: "router",
      modelTier: "light",
      inputPorts: [{ key: "verdict", schemaRef: "SprintVerdict", required: true }],
      outputPorts: [],
      reads: ["evaluations", "counters"],
      writes: ["counters"],
      effects: [],
      targets: [
        { label: "pass", to: "documenter" },
        { label: "partial", to: "synthesize" },
        { label: "rework", to: "critique" },
        { label: "exhausted", to: "graceful_failure" },
      ],
    },
    {
      id: "critique",
      kind: "llm",
      title: "Critique the failing run",
      doc: "Turns the global evaluation into per-branch rework instructions.",
      subgraph: null,
      role: "reviewer",
      modelTier: "frontier",
      promptRef: "evaluator/critique",
      inputPorts: [],
      outputPorts: [],
      reads: ["evaluations", "messages"],
      writes: ["messages", "ledger"],
      effects: [],
    },
    {
      id: "rework_route",
      kind: "router",
      title: "Rework router",
      doc: "Re-dispatches the failed branches through the sprint subgraph while the rework budget holds, and fails gracefully once it is spent.",
      subgraph: null,
      role: "router",
      modelTier: "light",
      inputPorts: [],
      outputPorts: [],
      reads: ["counters", "branchStatus"],
      writes: ["counters"],
      effects: [],
      loop: { counterKey: "reworkRounds", maxIterations: 2, onExhausted: "graceful_failure" },
      targets: [
        { label: "rework", to: "sprint_body" },
        { label: "exhausted", to: "graceful_failure" },
      ],
    },
    {
      id: "synthesize",
      kind: "llm",
      title: "Synthesize a partial result",
      doc: "Produces a qualified answer from the branches that did succeed when the run is only partially complete.",
      subgraph: null,
      role: "documenter",
      modelTier: "frontier",
      promptRef: "synthesizer/partial",
      inputPorts: [],
      outputPorts: [],
      reads: ["evaluations", "messages", "branchStatus"],
      writes: ["messages", "ledger"],
      effects: [],
    },
    {
      id: "documenter",
      kind: "llm",
      title: "Document the run",
      doc: "Writes the sprint documentation and the progress summary for the completed work.",
      subgraph: null,
      role: "documenter",
      modelTier: "frontier",
      promptRef: "documenter/summary",
      inputPorts: [],
      outputPorts: [],
      reads: ["messages", "spec", "evaluations"],
      writes: ["messages", "refs", "ledger"],
      effects: ["fs-write"],
    },

    // ── Terminal region ─────────────────────────────────────────────
    {
      id: "hitl_commit",
      kind: "gate",
      title: "Commit approval",
      doc: "Human-in-the-loop approval guarding the git commit. Effect-free by construction: the approval and the effectful commit are separate nodes.",
      subgraph: null,
      role: "utility",
      inputPorts: [],
      outputPorts: [],
      reads: ["messages"],
      writes: ["messages"],
      effects: [],
      gate: { check: "human-approval", onFail: "graceful_failure" },
      hitl: { checkpointId: "hitl-commit", onReject: "graceful_failure" },
    },
    {
      id: "commit",
      kind: "tool",
      title: "Commit the working tree",
      doc: "Creates the run's commit. Reachable only behind the approval gate, which is what makes the git effect blockable fail-closed.",
      subgraph: null,
      role: "utility",
      inputPorts: [],
      outputPorts: [],
      reads: ["messages"],
      writes: ["messages"],
      effects: ["git"],
      toolRef: "git.commit",
    },
    {
      id: "finalize",
      kind: "tool",
      title: "Finalize the run",
      doc: "Emits the terminal artifacts, the pipeline-complete history event and the completion marker. Sole writer of the scalar verdict channel.",
      subgraph: null,
      role: "utility",
      inputPorts: [],
      outputPorts: [],
      reads: ["evaluations", "branchStatus", "ledger"],
      writes: ["verdict", "refs"],
      effects: ["fs-write"],
      toolRef: "run.finalize",
    },
    {
      id: "graceful_failure",
      kind: "tool",
      title: "Fail gracefully",
      doc: "The single failure terminal: records the failure classes per branch and the human-readable reason, then ends the run without a commit.",
      subgraph: null,
      role: "utility",
      inputPorts: [],
      outputPorts: [],
      reads: ["branchStatus", "messages"],
      writes: ["messages", "branchStatus"],
      effects: ["fs-write"],
      toolRef: "run.gracefulFailure",
    },
  ],

  // ── Edges ─────────────────────────────────────────────────────────
  edges: [
    // Research
    {
      id: "e-research-entry",
      from: "research_body",
      to: "gate_research_in",
      kind: "normal",
      ports: { from: "request", to: "request" },
    },
    {
      id: "e-research-reflect",
      from: "gate_research_in",
      to: "research_reflect",
      kind: "normal",
      ports: { from: "request", to: "request" },
    },
    {
      id: "e-research-explore",
      from: "research_reflect",
      to: "research_explore",
      kind: "normal",
      ports: { from: "digest", to: "digest" },
    },
    {
      id: "e-research-critique",
      from: "research_explore",
      to: "research_critique",
      kind: "normal",
      ports: { from: "digest", to: "digest" },
    },
    {
      id: "e-research-route",
      from: "research_critique",
      to: "research_route",
      kind: "normal",
      ports: { from: "digest", to: "digest" },
    },
    {
      id: "e-research-retry",
      from: "research_route",
      to: "research_explore",
      kind: "conditional",
      label: "retry",
    },
    {
      id: "e-research-done",
      from: "research_route",
      to: "research_collect",
      kind: "conditional",
      label: "done",
    },
    {
      id: "e-research-collected",
      from: "research_collect",
      to: "gate_research_out",
      kind: "normal",
      ports: { from: "digest", to: "digest" },
    },
    { id: "e-research-exit", from: "gate_research_out", to: "supervisor", kind: "normal" },

    // Supervisor dispatch
    {
      id: "e-supervisor-plan",
      from: "supervisor",
      to: "gate_plan_in",
      kind: "conditional",
      label: "plan",
    },
    {
      id: "e-supervisor-sprints",
      from: "supervisor",
      to: "fanout_sprints",
      kind: "conditional",
      label: "sprints",
    },
    {
      id: "e-supervisor-evaluate",
      from: "supervisor",
      to: "gate_eval_in",
      kind: "conditional",
      label: "evaluate",
    },
    {
      id: "e-supervisor-compact",
      from: "supervisor",
      to: "context_compact",
      kind: "conditional",
      label: "compact",
    },
    { id: "e-compact-supervisor", from: "context_compact", to: "supervisor", kind: "normal" },

    // Plan
    {
      id: "e-plan-draft",
      from: "gate_plan_in",
      to: "plan_draft",
      kind: "normal",
      ports: { from: "brief", to: "brief" },
    },
    {
      id: "e-plan-check",
      from: "plan_draft",
      to: "plan_clarify_check",
      kind: "normal",
      ports: { from: "draft", to: "draft" },
    },
    {
      id: "e-plan-clarify",
      from: "plan_clarify_check",
      to: "plan_clarify",
      kind: "conditional",
      label: "clarify",
    },
    { id: "e-plan-clarified", from: "plan_clarify", to: "plan_draft", kind: "normal" },
    {
      id: "e-plan-ok",
      from: "plan_clarify_check",
      to: "plan_materialize",
      kind: "conditional",
      label: "ok",
    },
    {
      id: "e-plan-materialized",
      from: "plan_materialize",
      to: "gate_plan_out",
      kind: "normal",
      ports: { from: "contracts", to: "contracts" },
    },
    { id: "e-plan-exit", from: "gate_plan_out", to: "supervisor", kind: "normal" },

    // Sprint fan-out
    {
      id: "e-sprint-dispatch",
      from: "fanout_sprints",
      to: "sprint_body",
      kind: "fanout",
      label: "dispatch",
    },
    {
      id: "e-sprint-drained",
      from: "fanout_sprints",
      to: "supervisor",
      kind: "conditional",
      label: "drained",
    },
    {
      id: "e-sprint-entry",
      from: "sprint_body",
      to: "gate_sprint_in",
      kind: "normal",
      ports: { from: "contract", to: "contract" },
    },
    {
      id: "e-sprint-explain",
      from: "gate_sprint_in",
      to: "sprint_curate_explain",
      kind: "normal",
      ports: { from: "contract", to: "contract" },
    },
    {
      id: "e-sprint-mocks",
      from: "sprint_curate_explain",
      to: "sprint_curate_mocks",
      kind: "normal",
      ports: { from: "contract", to: "contract" },
    },
    {
      id: "e-sprint-mock-gate",
      from: "sprint_curate_mocks",
      to: "gate_mock_coverage",
      kind: "normal",
    },
    { id: "e-sprint-generate", from: "gate_mock_coverage", to: "sprint_generate", kind: "normal" },
    { id: "e-sprint-syntax", from: "sprint_generate", to: "gate_syntax", kind: "normal" },
    { id: "e-sprint-security", from: "gate_syntax", to: "sprint_security", kind: "normal" },
    { id: "e-sprint-evaluate", from: "sprint_security", to: "sprint_evaluate", kind: "normal" },
    {
      id: "e-sprint-anchor",
      from: "sprint_evaluate",
      to: "gate_anchor_regression",
      kind: "normal",
      ports: { from: "verdict", to: "verdict" },
    },
    {
      id: "e-sprint-route",
      from: "gate_anchor_regression",
      to: "sprint_route",
      kind: "normal",
      ports: { from: "verdict", to: "verdict" },
    },
    {
      id: "e-sprint-retry",
      from: "sprint_route",
      to: "sprint_correct",
      kind: "conditional",
      label: "retry",
    },
    { id: "e-sprint-corrected", from: "sprint_correct", to: "sprint_generate", kind: "normal" },
    {
      id: "e-sprint-pass",
      from: "sprint_route",
      to: "sprint_review",
      kind: "conditional",
      label: "pass",
    },
    { id: "e-sprint-reviewed", from: "sprint_review", to: "sprint_exit", kind: "normal" },
    {
      id: "e-sprint-exhausted",
      from: "sprint_route",
      to: "sprint_exit",
      kind: "conditional",
      label: "exhausted",
    },
    // Blueprint order: sprint_exit -> gate_sprint_out -> reduce_sprints -> supervisor.
    // The first two hops run PER BRANCH inside the fan-out; `reduce_sprints` is the root
    // barrier where the branches converge, so exactly one edge reaches the supervisor per
    // fan-out rather than one per branch.
    { id: "e-sprint-reduce", from: "sprint_exit", to: "gate_sprint_out", kind: "normal" },
    { id: "e-sprint-released", from: "gate_sprint_out", to: "reduce_sprints", kind: "normal" },
    { id: "e-sprint-exit", from: "reduce_sprints", to: "supervisor", kind: "normal" },

    // Evaluation
    { id: "e-eval-global", from: "gate_eval_in", to: "evaluate_global", kind: "normal" },
    {
      id: "e-eval-route",
      from: "evaluate_global",
      to: "route_after_eval",
      kind: "normal",
      ports: { from: "verdict", to: "verdict" },
    },
    {
      id: "e-eval-rework",
      from: "route_after_eval",
      to: "critique",
      kind: "conditional",
      label: "rework",
    },
    { id: "e-eval-critiqued", from: "critique", to: "rework_route", kind: "normal" },
    {
      id: "e-rework-dispatch",
      from: "rework_route",
      to: "sprint_body",
      kind: "fanout",
      label: "rework",
    },
    {
      id: "e-rework-exhausted",
      from: "rework_route",
      to: "graceful_failure",
      kind: "conditional",
      label: "exhausted",
    },
    {
      id: "e-eval-partial",
      from: "route_after_eval",
      to: "synthesize",
      kind: "conditional",
      label: "partial",
    },
    { id: "e-eval-synthesized", from: "synthesize", to: "documenter", kind: "normal" },
    {
      id: "e-eval-exhausted",
      from: "route_after_eval",
      to: "graceful_failure",
      kind: "conditional",
      label: "exhausted",
    },
    {
      id: "e-eval-pass",
      from: "route_after_eval",
      to: "documenter",
      kind: "conditional",
      label: "pass",
    },

    // Terminal
    { id: "e-doc-approval", from: "documenter", to: "hitl_commit", kind: "normal" },
    { id: "e-approval-commit", from: "hitl_commit", to: "commit", kind: "normal" },
    { id: "e-commit-finalize", from: "commit", to: "finalize", kind: "normal" },
    { id: "e-finalize-end", from: "finalize", to: "END", kind: "normal" },
    { id: "e-failure-end", from: "graceful_failure", to: "END", kind: "normal" },
  ],

  checksum: UNSEALED_CHECKSUM,

  // ── Subgraphs ─────────────────────────────────────────────────────
  subgraphs: [
    {
      id: "research",
      graphId: "coding.research",
      depth: 1,
      entryGate: "gate_research_in",
      exitGate: "gate_research_out",
      persistence: "inherit",
    },
    {
      id: "sprint",
      graphId: "coding.sprint",
      depth: 1,
      entryGate: "gate_sprint_in",
      exitGate: "gate_sprint_out",
      persistence: "inherit",
    },
  ],
};

/**
 * The shipped coding topology, sealed with the checksum of its own canonical form.
 *
 * `bober pge dump` serializes exactly this value; `bober pge dump --check` fails on
 * any byte difference between it and `.bober/topology/coding.json`.
 */
export const CODING_GRAPH: TopologySpec = {
  ...CODING_GRAPH_UNSEALED,
  checksum: checksumTopology(CODING_GRAPH_UNSEALED),
};

/** The graph id of the shipped coding topology. */
export const CODING_GRAPH_ID = CODING_GRAPH.graphId;

/**
 * Every authored topology this repository ships, by graph id.
 *
 * `provenance: "optimizer"` variants under `.bober/topology/variants/` are NOT
 * authored graphs and are deliberately absent (ADR-2: `dump --check` applies only to
 * authored provenance).
 */
export const AUTHORED_GRAPHS: Readonly<Record<string, TopologySpec>> = Object.freeze({
  [CODING_GRAPH_ID]: CODING_GRAPH,
});

/** Look up an authored topology by graph id. Own-property lookup, so `"toString"` misses. */
export function authoredGraph(graphId: string): TopologySpec | undefined {
  return Object.prototype.hasOwnProperty.call(AUTHORED_GRAPHS, graphId)
    ? AUTHORED_GRAPHS[graphId]
    : undefined;
}
