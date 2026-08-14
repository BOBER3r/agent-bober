import { TERMINAL_ENDPOINT } from "../../contracts/topology.js";
import type { EdgeSpec, NodeSpec, TopologySpec } from "../../contracts/topology.js";

/**
 * Diagram rendering for a topology artifact.
 *
 * PURE. No filesystem, no process, no network, no clock. Every glyph is derived from
 * `spec.nodes`, `spec.edges` and the node policies — nothing is hand-drawn, so a
 * diagram cannot describe a graph other than the one committed.
 *
 * ── Why the two formats differ ──────────────────────────────────────
 *
 * `dot` emits EXACTLY one node statement per `spec.nodes[]` and EXACTLY one edge
 * statement per `spec.edges[]`. That 1:1 correspondence is the machine-checkable proof
 * that the diagram is derived from the artifact (sc-3-2), so the reserved terminal
 * `END` — which is not a declared node — is never emitted as a node statement;
 * graphviz materialises it from the edge that targets it.
 *
 * `mermaid` is the human diagram and additionally draws the RECOVERY routes declared
 * on node policies (`gate.onFail`, `hitl.onReject`, `loop.onExhausted`) as dotted
 * links. Those are real control flow — `validateTopology` already folds them into its
 * adjacency, and the architecture blueprint draws them (`gSyn -->|fail| sCorr`,
 * `BAR -->|failed-branch retry| FAN`) — but only 3 of the shipped topology's 20 policy
 * endpoints are also declared in `edges[]`, so leaving them out would draw a graph
 * whose failure paths are invisible.
 */

// ── Formats ─────────────────────────────────────────────────────────

export const RENDER_FORMATS = ["mermaid", "dot"] as const;
export type RenderFormat = (typeof RENDER_FORMATS)[number];

/** True when `value` names a supported render format. */
export function isRenderFormat(value: string): value is RenderFormat {
  return (RENDER_FORMATS as readonly string[]).includes(value);
}

// ── Deterministic ordering ──────────────────────────────────────────

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Nodes and edges are emitted in id order, not declaration order, so a diagram is
 * invariant to how the authored literal happens to be arranged — the same property
 * `canonicalize` gives the checksum.
 */
function sortedNodes(spec: TopologySpec): NodeSpec[] {
  return [...spec.nodes].sort((a, b) => compareStrings(a.id, b.id));
}

function sortedEdges(spec: TopologySpec): EdgeSpec[] {
  return [...spec.edges].sort((a, b) => compareStrings(a.id, b.id));
}

// ── Recovery routes ─────────────────────────────────────────────────

export type RecoveryKind = "onFail" | "onReject" | "onExhausted";

/** A control-flow endpoint declared on a node policy rather than on `edges[]`. */
export interface RecoveryRoute {
  from: string;
  kind: RecoveryKind;
  to: string;
}

/** Every policy endpoint in the artifact, ordered deterministically. */
export function recoveryRoutes(spec: TopologySpec): RecoveryRoute[] {
  const routes: RecoveryRoute[] = [];
  for (const node of spec.nodes) {
    if (node.kind === "gate") {
      routes.push({ from: node.id, kind: "onFail", to: node.gate.onFail });
    }
    if (node.hitl?.onReject !== undefined) {
      routes.push({ from: node.id, kind: "onReject", to: node.hitl.onReject });
    }
    if (node.loop !== undefined) {
      routes.push({ from: node.id, kind: "onExhausted", to: node.loop.onExhausted });
    }
  }
  return routes.sort(
    (a, b) =>
      compareStrings(a.from, b.from) || compareStrings(a.kind, b.kind) || compareStrings(a.to, b.to),
  );
}

// ── Mermaid ─────────────────────────────────────────────────────────

/**
 * Mermaid keywords that must never appear as a bare node id. `end` in particular
 * terminates a `subgraph` block and silently corrupts the rest of the diagram.
 */
const MERMAID_RESERVED = new Set([
  "class",
  "classdef",
  "click",
  "direction",
  "end",
  "flowchart",
  "graph",
  "linkstyle",
  "style",
  "subgraph",
]);

function escapeMermaid(text: string): string {
  return text.replace(/"/g, "#quot;");
}

/**
 * Stable node id → mermaid identifier map.
 *
 * Built over SORTED ids so the mapping (including any collision suffix) cannot change
 * when the authored literal is reordered. `END` is reserved up front so a declared
 * node can never collide with the terminal.
 */
function mermaidIdMap(spec: TopologySpec): Map<string, string> {
  const used = new Set<string>([TERMINAL_ENDPOINT]);
  const map = new Map<string, string>();
  for (const node of sortedNodes(spec)) {
    if (map.has(node.id)) continue;
    let base = node.id.replace(/[^A-Za-z0-9_]/g, "_");
    if (!/^[A-Za-z_]/.test(base) || MERMAID_RESERVED.has(base.toLowerCase())) {
      base = `n_${base}`;
    }
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    map.set(node.id, candidate);
  }
  return map;
}

interface MermaidShape {
  open: string;
  close: string;
  label: string;
}

/**
 * Shapes follow the architecture blueprint: `{{...}}` for a subgraph call site,
 * `[[...]]` for a human-in-the-loop node, `([...])` for the reserved terminal, and
 * `[...]` for everything else, with the kind carried in the label exactly as the
 * blueprint writes it (`SUP[router supervisor]`, `RS{{subgraph research}}`,
 * `hC[[hitl hitl_commit]]`).
 */
function mermaidShape(node: NodeSpec): MermaidShape {
  if (node.hitl) return { open: "[[", close: "]]", label: `hitl ${node.id}` };
  if (node.kind === "subgraph") return { open: "{{", close: "}}", label: `subgraph ${node.id}` };
  if (node.kind === "router") return { open: "[", close: "]", label: `router ${node.id}` };
  return { open: "[", close: "]", label: node.id };
}

function mermaidLink(edge: EdgeSpec): { arrow: string; label: string | undefined } {
  if (edge.kind === "fanout") return { arrow: "==>", label: edge.label ?? "fanout" };
  return { arrow: "-->", label: edge.label };
}

function renderMermaid(spec: TopologySpec): string {
  const ids = mermaidIdMap(spec);
  const nodes = sortedNodes(spec);
  const edges = sortedEdges(spec);
  const routes = recoveryRoutes(spec);

  const resolve = (endpoint: string): string | undefined =>
    endpoint === TERMINAL_ENDPOINT ? TERMINAL_ENDPOINT : ids.get(endpoint);

  const terminalReferenced =
    edges.some((edge) => edge.to === TERMINAL_ENDPOINT) ||
    routes.some((route) => route.to === TERMINAL_ENDPOINT);

  const lines: string[] = ["flowchart TD"];
  lines.push(
    `  %% ${spec.graphId} v${spec.graphVersion} - ${spec.nodes.length} nodes, ${spec.edges.length} edges - generated by bober pge render`,
  );

  for (const node of nodes) {
    const shape = mermaidShape(node);
    const id = ids.get(node.id) as string;
    lines.push(`  ${id}${shape.open}"${escapeMermaid(shape.label)}"${shape.close}`);
  }
  if (terminalReferenced) {
    lines.push(`  ${TERMINAL_ENDPOINT}(["${TERMINAL_ENDPOINT}"])`);
  }

  for (const edge of edges) {
    const from = resolve(edge.from);
    const to = resolve(edge.to);
    // A dangling endpoint is a validator diagnostic, not a rendering decision: the
    // renderer draws what resolves and never invents a node to hang an edge on.
    if (from === undefined || to === undefined) continue;
    const link = mermaidLink(edge);
    const label = link.label === undefined ? "" : `|"${escapeMermaid(link.label)}"|`;
    lines.push(`  ${from} ${link.arrow}${label} ${to}`);
  }

  for (const route of routes) {
    const from = resolve(route.from);
    const to = resolve(route.to);
    if (from === undefined || to === undefined) continue;
    lines.push(`  ${from} -.->|"${route.kind}"| ${to}`);
  }

  return `${lines.join("\n")}\n`;
}

// ── Graphviz dot ────────────────────────────────────────────────────

function escapeDot(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function dotShape(node: NodeSpec): string {
  switch (node.kind) {
    case "router":
      return "diamond";
    case "subgraph":
      return "hexagon";
    case "tool":
      return "component";
    case "gate":
      return "box";
    case "llm":
      return "box";
    default:
      return "box";
  }
}

function dotEdgeAttributes(edge: EdgeSpec): string {
  const attrs: string[] = [];
  if (edge.label !== undefined) attrs.push(`label="${escapeDot(edge.label)}"`);
  if (edge.kind === "fanout") attrs.push("style=bold");
  else if (edge.kind === "conditional") attrs.push("style=dashed");
  return attrs.length === 0 ? "" : ` [${attrs.join(", ")}]`;
}

function renderDot(spec: TopologySpec): string {
  const lines: string[] = [`digraph "${escapeDot(spec.graphId)}" {`];
  lines.push(
    `  // ${spec.graphId} v${spec.graphVersion} - ${spec.nodes.length} nodes, ${spec.edges.length} edges - generated by bober pge render`,
  );
  lines.push("  rankdir=TB;");
  lines.push("  node [shape=box];");

  for (const node of sortedNodes(spec)) {
    const attrs = [`label="${escapeDot(node.id)}"`, `shape=${dotShape(node)}`];
    if (node.hitl) attrs.push("peripheries=2");
    lines.push(`  "${escapeDot(node.id)}" [${attrs.join(", ")}];`);
  }

  for (const edge of sortedEdges(spec)) {
    lines.push(
      `  "${escapeDot(edge.from)}" -> "${escapeDot(edge.to)}"${dotEdgeAttributes(edge)};`,
    );
  }

  lines.push("}");
  return `${lines.join("\n")}\n`;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Render a topology as a diagram source string.
 *
 * Deterministic and order-invariant: the same artifact always produces the same bytes,
 * and reordering `nodes[]`/`edges[]` does not change them.
 */
export function renderTopology(spec: TopologySpec, format: RenderFormat): string {
  return format === "mermaid" ? renderMermaid(spec) : renderDot(spec);
}
