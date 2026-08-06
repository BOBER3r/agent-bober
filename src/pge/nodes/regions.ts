import { TERMINAL_ENDPOINT, TopologySpecSchema } from "../../contracts/topology.js";
import type { EdgeSpec, NodeSpec, TopologySpec } from "../../contracts/topology.js";
import { checksumTopology } from "../topology/canonical.js";

/**
 * A REGION of the committed coding artifact, projected into a topology of its own.
 *
 * ── Why this exists ──
 *
 * The sprint-11 node library implements the research region and the plan region and
 * nothing else; the other thirty-odd nodes are sprint 12. `compile()` is all-or-nothing
 * over `spec.nodes` — it emits `UnregisteredNodeImpl` for every node the registry lacks
 * AND `OrphanNodeImpl` for every implementation the spec lacks (`compiler.ts:435,495`) —
 * so compiling half a registry against the whole artifact is 50 diagnostics, and
 * `compileRegion` (`compiler.ts:358`) is private with no subgraph-scoped entry point.
 *
 * The obvious alternative, `compile(CODING_GRAPH, …).subgraphs.get("research")`, cannot be
 * RUN: a subgraph's `CompiledGraph.spec` is the same whole artifact (`compiler.ts:119`),
 * so its `spec.entry` is `research_body`, which carries `subgraph: null` and is therefore
 * absent from that region's `nodes` map — and the interpreter seeds its frontier at
 * `graph.spec.entry` (`interpreter.ts:1600`) and throws `UnknownNodeInScopeError` for an
 * id it cannot find.
 *
 * So a region is projected into its own `TopologySpec`. EVERY field is copied off the
 * source artifact — node objects, edge objects, ports, labels, channels, defaults, loop
 * bounds, HITL policies — and the only things this module decides are WHICH nodes and
 * edges are in the region and what the projection's own checksum is. Nothing here
 * authors a node, an edge, a port or a route: a hand-built fixture graph would make the
 * committed artifact decorative, which is the one thing the sprint's evaluator notes
 * forbid.
 *
 * ── Why `compile()` and never `loadCompiledGraph()` ──
 *
 * `loadCompiledGraph` runs `validateTopology(mode: "structural")` first
 * (`compiler.ts:663`). A projection necessarily keeps the supervisor — `RouterNodeSchema.
 * targets` is `.min(1)` (`contracts/topology.ts:264`), so its four declared targets are
 * copied verbatim — and three of them name nodes the region does not contain, which the
 * validator reports as `RouterTargetNotDeclared`. `compile()` checks what a projection
 * can satisfy (entry resolves, edge endpoints resolve, node↔impl both directions, port
 * bindings, channels, reducers) and nothing it cannot.
 *
 * The out-of-region targets are unreachable at RUNTIME for the same reason they are
 * unreachable structurally: `resolveDestination` (`interpreter.ts:588`) resolves a label
 * through the compiled adjacency first, and the composition root derives the supervisor's
 * dispatchable label set from the projected node set (see `supervisor.ts`), so a label
 * whose target is out of region is never selected.
 *
 * ── The plan region is a REGION, not a subgraph ──
 *
 * The artifact declares exactly two subgraphs, `research` and `sprint`
 * (`coding.graph.ts:1170-1187`), and every plan node carries `subgraph: null`
 * (`coding.graph.ts:353-442`). The artifact's own header says so at
 * `coding.graph.ts:49-51`, the architecture blueprint marks only `{{subgraph research}}`
 * and `{{subgraph sprint}}`, and `coding.graph.test.ts:213` pins it. The sprint contract's
 * "plan subgraph" wording is therefore an error in the contract, and the artifact is
 * right; {@link regionSpec} projects the plan REGION and declares no subgraph for it.
 */

// ── Region ids ──────────────────────────────────────────────────────

export const RESEARCH_REGION = "research";
export const PLAN_REGION = "plan";
/** Sprint 12: the fan-out, the `sprint` subgraph and the fan-in barrier. */
export const SPRINT_REGION = "sprint";
/** Sprint 12: the documenter, the commit approval gate and the git commit. */
export const TERMINAL_REGION = "terminal";

/** The regions the node library covers: two from sprint 11, two from sprint 12. */
export const REGION_IDS = [RESEARCH_REGION, PLAN_REGION, SPRINT_REGION, TERMINAL_REGION] as const;
export type RegionId = (typeof REGION_IDS)[number];

/** The failure terminal every region keeps, so a fail-closed gate has somewhere to go. */
export const GRACEFUL_FAILURE_NODE_ID = "graceful_failure";

/** The dispatch label the artifact declares for the sprint phase (`coding.graph.ts:331`). */
export const SPRINT_LABEL = "sprints";

/** A region could not be projected because the artifact does not describe it that way. */
export class RegionProjectionError extends Error {
  readonly region: string;

  constructor(region: string, detail: string) {
    super(`Cannot project region "${region}" out of the topology artifact: ${detail}.`);
    this.name = "RegionProjectionError";
    this.region = region;
  }
}

// ── Derivation helpers ──────────────────────────────────────────────

function nodeById(spec: TopologySpec, id: string): NodeSpec | undefined {
  return spec.nodes.find((node) => node.id === id);
}

/**
 * The node the supervisor dispatches for `label`, read off the supervisor's own
 * `targets` in the artifact.
 *
 * Derived rather than spelled: `"gate_plan_in"` written as a literal here would keep
 * working after someone retargeted `e-supervisor-plan`, and the projection would then
 * describe a graph the artifact no longer declares.
 */
export function supervisorTarget(spec: TopologySpec, label: string): string {
  const supervisor = nodeById(spec, spec.defaults.supervisorNodeId);
  if (supervisor === undefined || supervisor.kind !== "router") {
    throw new RegionProjectionError(
      label,
      `the artifact's declared supervisor "${spec.defaults.supervisorNodeId}" is not a router node`,
    );
  }
  const target = supervisor.targets.find((entry) => entry.label === label);
  if (target === undefined) {
    throw new RegionProjectionError(
      label,
      `the supervisor declares no "${label}" target (declared: ${supervisor.targets
        .map((entry) => entry.label)
        .join(", ")})`,
    );
  }
  return target.to;
}

/** The `kind: "subgraph"` call-site node whose `subgraphRef` is `id`. */
function callSiteOf(spec: TopologySpec, id: string): NodeSpec | undefined {
  return spec.nodes.find((node) => node.kind === "subgraph" && node.subgraphRef === id);
}

/**
 * Actual nesting depth per declared subgraph, derived from the CALL-SITE node.
 *
 * The same derivation `validate.ts:1033-1052` uses, and for the same reason: `depth` in a
 * `SubgraphDecl` is a hand-editable number, so trusting it would let an artifact lie
 * about how deeply it nests. A subgraph called from the root is depth 1; one called from
 * inside another is one deeper; a cycle of call sites is infinite.
 */
export function subgraphCallSiteDepths(spec: TopologySpec): Map<string, number> {
  const parents = new Map<string, string | null>();
  for (const node of spec.nodes) {
    if (node.kind !== "subgraph") continue;
    if (!parents.has(node.subgraphRef)) parents.set(node.subgraphRef, node.subgraph);
  }

  const cache = new Map<string, number>();
  const resolve = (id: string, seen: Set<string>): number => {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return Number.POSITIVE_INFINITY;
    seen.add(id);
    const parent = parents.get(id) ?? null;
    const depth = parent === null ? 1 : 1 + resolve(parent, seen);
    cache.set(id, depth);
    return depth;
  };

  const depths = new Map<string, number>();
  for (const decl of spec.subgraphs) depths.set(decl.id, resolve(decl.id, new Set()));
  return depths;
}

// ── Node sets ───────────────────────────────────────────────────────

/**
 * Every node id the research region contains.
 *
 * The interior is `subgraph === "research"`, found by membership rather than by name.
 * The call site is the `kind: "subgraph"` node pointing at it — the graph ENTRY, which
 * sits at the root because a subgraph boundary must be crossed through a gate. The
 * supervisor is kept because `e-research-exit` targets it and a region that dropped its
 * exit target would have a dangling edge. The failure terminal is kept because every
 * boundary gate in the region declares `gate.onFail: "graceful_failure"`.
 */
function researchNodeIds(source: TopologySpec): Set<string> {
  const decl = source.subgraphs.find((entry) => entry.id === RESEARCH_REGION);
  if (decl === undefined) {
    throw new RegionProjectionError(RESEARCH_REGION, "the artifact declares no such subgraph");
  }
  const callSite = callSiteOf(source, RESEARCH_REGION);
  if (callSite === undefined) {
    throw new RegionProjectionError(
      RESEARCH_REGION,
      "the artifact declares the subgraph but no node calls it",
    );
  }
  const ids = new Set<string>([callSite.id, source.defaults.supervisorNodeId, GRACEFUL_FAILURE_NODE_ID]);
  for (const node of source.nodes) {
    if (node.subgraph === RESEARCH_REGION) ids.add(node.id);
  }
  return ids;
}

/**
 * Every node id the plan region contains.
 *
 * A closure over the artifact's own edges, entered at whatever the supervisor's `"plan"`
 * label targets and stopped where control returns to the supervisor or reaches the
 * terminal. Nothing is enumerated by hand, so a node added to the plan region in the
 * artifact joins this set without an edit here.
 */
function planNodeIds(source: TopologySpec): Set<string> {
  const supervisorId = source.defaults.supervisorNodeId;
  const ids = new Set<string>([supervisorId, GRACEFUL_FAILURE_NODE_ID]);
  const queue: string[] = [supervisorTarget(source, PLAN_REGION)];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (ids.has(id)) continue;
    ids.add(id);
    for (const edge of source.edges) {
      if (edge.from !== id) continue;
      if (edge.to === TERMINAL_ENDPOINT || edge.to === supervisorId) continue;
      queue.push(edge.to);
    }
  }
  return ids;
}

/**
 * Every node id the SPRINT region contains.
 *
 * The same edge closure the plan region uses, entered at whatever the supervisor's
 * `"sprints"` label targets. It therefore picks up, without enumerating any of them: the
 * fan-out router, the `kind: "subgraph"` call site the fan-out edge targets, every node
 * carrying `subgraph: "sprint"`, and the root-level fan-in barrier the exit gate releases
 * into. A node added to the sprint subgraph in the artifact joins this set without an edit
 * here.
 */
function sprintNodeIds(source: TopologySpec): Set<string> {
  const decl = source.subgraphs.find((entry) => entry.id === SPRINT_REGION);
  if (decl === undefined) {
    throw new RegionProjectionError(SPRINT_REGION, "the artifact declares no such subgraph");
  }
  const supervisorId = source.defaults.supervisorNodeId;
  const ids = new Set<string>([supervisorId, GRACEFUL_FAILURE_NODE_ID]);
  const queue: string[] = [supervisorTarget(source, "sprints")];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (ids.has(id)) continue;
    ids.add(id);
    for (const edge of source.edges) {
      if (edge.from !== id) continue;
      if (edge.to === TERMINAL_ENDPOINT || edge.to === supervisorId) continue;
      queue.push(edge.to);
    }
  }
  return ids;
}

/**
 * Every node id the TERMINAL region contains, derived from the ONE git effect.
 *
 * Not enumerated, and deliberately not entered at a literal `"documenter"`: the criterion
 * this region exists for (sc-12-9) is about a commit that may happen only behind a recorded
 * approval, so the region is derived from that relationship — the node declaring `git`, the
 * node whose `hitl` policy has a declared edge into it (the same derivation
 * `computeEffectGates` performs at `interpreter.ts:499-512`), and that gate's own sole
 * predecessor. A topology that moved the approval gate would move this region with it.
 *
 * `finalize` is deliberately OUT. It is the sprint-13 node that emits the run's terminal
 * artifacts, and a projection that included it would need an implementation for it; the
 * commit node's successor is therefore absent from the projection, which
 * {@link successorOrEnd} in `gates.ts` resolves to the reserved terminal.
 */
export interface TerminalTriple {
  /** The node whose output the approval gate is asked about. */
  readonly documenter: string;
  /** The node carrying the `hitl` policy that authorises the commit. */
  readonly approvalGate: string;
  /** The single node declaring `effects: ["git"]`. */
  readonly gitNode: string;
}

/** The three terminal nodes, each derived from the one before it. See {@link terminalNodeIds}. */
export function terminalTriple(source: TopologySpec): TerminalTriple {
  const gitNodes = source.nodes.filter((node) => node.effects.includes("git"));
  if (gitNodes.length !== 1) {
    throw new RegionProjectionError(
      TERMINAL_REGION,
      `the artifact declares ${String(gitNodes.length)} nodes carrying the git effect, and exactly one is required`,
    );
  }
  const gitNode = gitNodes[0];
  const approvalEdge = source.edges.find((edge) => {
    if (edge.to !== gitNode.id) return false;
    return nodeById(source, edge.from)?.hitl !== undefined;
  });
  if (approvalEdge === undefined) {
    throw new RegionProjectionError(
      TERMINAL_REGION,
      `no declared edge reaches "${gitNode.id}" from a node carrying a HITL policy, so the git effect is ungated (ADR-6)`,
    );
  }
  const inbound = source.edges.filter(
    (edge) => edge.to === approvalEdge.from && edge.kind === "normal",
  );
  if (inbound.length !== 1) {
    throw new RegionProjectionError(
      TERMINAL_REGION,
      `the approval gate "${approvalEdge.from}" has ${String(inbound.length)} normal inbound edges and exactly one is required to name the documenter`,
    );
  }
  return { documenter: inbound[0].from, approvalGate: approvalEdge.from, gitNode: gitNode.id };
}

function terminalNodeIds(source: TopologySpec): Set<string> {
  const triple = terminalTriple(source);
  return new Set<string>([
    triple.documenter,
    triple.approvalGate,
    triple.gitNode,
    GRACEFUL_FAILURE_NODE_ID,
  ]);
}

/** Every node id in `region`, derived from the artifact. */
export function regionNodeIds(source: TopologySpec, region: RegionId): ReadonlySet<string> {
  switch (region) {
    case RESEARCH_REGION:
      return researchNodeIds(source);
    case PLAN_REGION:
      return planNodeIds(source);
    case SPRINT_REGION:
      return sprintNodeIds(source);
    default:
      return terminalNodeIds(source);
  }
}

/** The graph entry a region run starts at. */
export function regionEntry(source: TopologySpec, region: RegionId): string {
  switch (region) {
    // Research is the artifact's own entry point.
    case RESEARCH_REGION:
      return source.entry;
    // The plan region is entered the way the running graph enters it, through the
    // supervisor's dispatch — the supervisor is IN the region and selects the label itself.
    case PLAN_REGION:
      return source.defaults.supervisorNodeId;
    // The sprint region is entered at the fan-out router rather than at the supervisor.
    // `supervisorNode` (sprint 11) selects only the `plan` label, so a run entered at the
    // supervisor with the sprint region projected would terminate without dispatching; the
    // target is still READ off the supervisor's own declared `targets`, so a retargeted
    // `e-supervisor-sprints` moves this with it.
    case SPRINT_REGION:
      return supervisorTarget(source, SPRINT_LABEL);
    // The terminal region is entered at the documenter — where `route_after_eval`'s `pass`
    // label lands (`coding.graph.ts:752`) — derived from the git effect, not named.
    default:
      return terminalTriple(source).documenter;
  }
}

// ── Edges ───────────────────────────────────────────────────────────

/** Every declared edge with both endpoints inside the region (or the terminal). */
export function regionEdges(source: TopologySpec, region: RegionId): EdgeSpec[] {
  const ids = regionNodeIds(source, region);
  return source.edges.filter(
    (edge) => ids.has(edge.from) && (edge.to === TERMINAL_ENDPOINT || ids.has(edge.to)),
  );
}

/**
 * The region's exit edges: every in-region edge that returns control to the supervisor.
 *
 * The structural claim sc-11-6 makes about a region is about THESE, so they are derived
 * from `defaults.supervisorNodeId` rather than from the edge ids `e-research-exit` and
 * `e-plan-exit`. Reading the ids would assert that two strings exist; reading the
 * supervisor asserts that control comes back.
 */
export function regionExitEdges(source: TopologySpec, region: RegionId): EdgeSpec[] {
  const supervisorId = source.defaults.supervisorNodeId;
  const ids = regionNodeIds(source, region);
  return source.edges.filter(
    (edge) => edge.from !== supervisorId && ids.has(edge.from) && edge.to === supervisorId,
  );
}

// ── Projection ──────────────────────────────────────────────────────

/** Placeholder, replaced by the checksum of the projection's own canonical form. */
const UNSEALED_CHECKSUM = `sha256:${"0".repeat(64)}`;

/**
 * `region`, as a `TopologySpec` the compiler and the interpreter can consume.
 *
 * Channels, defaults, provenance, `graphVersion` and every node and edge OBJECT come
 * from `source` untouched. Three things are the projection's own:
 *
 *  - `graphId` gains a region suffix, matching the artifact's own naming for the region
 *    it does declare (`subgraphs[0].graphId === "coding.research"`), so a checkpoint
 *    written by a region run cannot be replayed into the full graph by mistake;
 *  - `entry` is the region's entry (see {@link regionEntry});
 *  - `checksum` is recomputed, because a projection is a different structure and
 *    carrying the parent's checksum would make `assertCheckpointMatchesGraph` accept a
 *    checkpoint written against a different node set.
 *
 * The result is parsed through `TopologySpecSchema` before it is returned: a projection
 * that produced an object the artifact schema rejects is a defect in THIS module, and
 * discovering it at `compile()` would blame the compiler.
 */
export function regionSpec(source: TopologySpec, region: RegionId): TopologySpec {
  const ids = regionNodeIds(source, region);
  const entry = regionEntry(source, region);
  if (!ids.has(entry)) {
    throw new RegionProjectionError(region, `its entry "${entry}" is not one of its own nodes`);
  }

  const nodes = source.nodes.filter((node) => ids.has(node.id));
  const edges = regionEdges(source, region);
  // Only a subgraph whose interior survived the projection: a declaration with no nodes
  // in the region would compile to an empty `CompiledGraph` and claim a structure that
  // is not there.
  const subgraphs = source.subgraphs.filter((decl) =>
    nodes.some((node) => node.subgraph === decl.id),
  );

  const projected: TopologySpec = {
    ...source,
    graphId: `${source.graphId}.${region}`,
    entry,
    nodes,
    edges,
    subgraphs,
    checksum: UNSEALED_CHECKSUM,
  };

  const sealed: TopologySpec = { ...projected, checksum: checksumTopology(projected) };
  // Round-tripped through JSON first, exactly as `golden-graph.ts` does: the schema is
  // the artifact contract, and a value that only satisfies it in memory is not one.
  return TopologySpecSchema.parse(JSON.parse(JSON.stringify(sealed)) as unknown);
}
