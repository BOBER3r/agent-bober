import { GRAPH_VERSION_PATTERN, TopologySpecSchema } from "../../contracts/topology.js";
import type { TopologySpec } from "../../contracts/topology.js";
import { canonicalize } from "./canonical.js";

/**
 * Structural diff of two topology artifacts.
 *
 * PURE. No filesystem, no process, no network, no clock.
 *
 * Both inputs are parsed through `TopologySpecSchema` (so defaults are applied) and
 * then CANONICALISED before anything is compared, which is why two files that differ
 * only in key ordering, array ordering or omitted defaults produce `empty: true`.
 * The top-level `checksum` is elided by `canonicalize`, so a stale checksum is a
 * validator diagnostic (`ChecksumStale`) rather than a phantom structural change.
 */

// ── Result shape ────────────────────────────────────────────────────

export interface NodeRename {
  from: string;
  to: string;
}

export interface NodeFieldChange {
  id: string;
  /** Top-level node fields whose canonical value differs, sorted. Never includes `id`. */
  fields: string[];
}

export interface RouteLabelChange {
  router: string;
  label: string;
}

export interface TopologyDiff {
  /** True only when every change list is empty. A `graphVersion` bump alone is not a change. */
  empty: boolean;
  graphVersion: { from: string; to: string; bumped: boolean };
  /**
   * Canonical TOP-LEVEL fields that changed but have no dedicated change list above:
   * `entry`, `defaults`, `subgraphs`, `graphId`, `description`, `provenance`,
   * `formatVersion`. Sorted.
   *
   * Without this residual the diff would be blind to exactly the changes it exists to
   * catch — re-pointing `entry`, moving `defaults.supervisorNodeId` (which every
   * subgraph exit must target), or adding a whole subgraph declaration are routing
   * changes that touch no node, edge or channel, and would otherwise report
   * `empty: true` and sail through `--require-version-bump`.
   */
  graphFieldsChanged: string[];
  nodesAdded: string[];
  nodesRemoved: string[];
  nodesRenamed: NodeRename[];
  nodesChanged: NodeFieldChange[];
  edgesAdded: string[];
  edgesRemoved: string[];
  channelsAdded: string[];
  channelsRemoved: string[];
  routeLabelsAdded: RouteLabelChange[];
  routeLabelsRemoved: RouteLabelChange[];
}

// ── Helpers ─────────────────────────────────────────────────────────

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse and canonicalise one side of the diff.
 *
 * Throws `TypeError` rather than returning a partial diff: a diff computed against a
 * half-understood artifact would be reported as a small change when the truth is
 * "this file is not a topology", and the CI gate would pass on it.
 */
function canonicalSide(spec: TopologySpec, side: "left" | "right"): Record<string, unknown> {
  const parsed = TopologySpecSchema.safeParse(spec);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join(".") : "<root>";
    throw new TypeError(
      `diffTopology: the ${side} topology does not match TopologySpecSchema (at ${where}: ${issue?.message ?? "unknown issue"}).`,
    );
  }
  return JSON.parse(canonicalize(parsed.data)) as Record<string, unknown>;
}

function indexById(value: unknown): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(value)) return out;
  for (const entry of value) {
    if (!isPlainObject(entry)) continue;
    const id = entry.id;
    if (typeof id !== "string") continue;
    if (!out.has(id)) out.set(id, entry);
  }
  return out;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function withoutId(entry: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...rest } = entry;
  return rest;
}

/** Top-level fields whose canonical value differs between two entries, sorted, minus `id`. */
function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete("id");
  const changed: string[] = [];
  for (const key of keys) {
    if (stableJson(before[key]) !== stableJson(after[key])) changed.push(key);
  }
  return changed.sort(compareStrings);
}

/**
 * Top-level canonical keys that have their own dedicated change list.
 *
 * `checksum` is absent because `canonicalize` elides it, so a stale stored checksum is a
 * validator diagnostic (`ChecksumStale`) and never a phantom structural change.
 * `graphVersion` is excluded because a version move alone is deliberately not a change.
 */
const ENUMERATED_KEYS = new Set(["nodes", "edges", "channels", "graphVersion"]);

/**
 * Canonical top-level fields that changed but have no dedicated change list.
 *
 * Computed as a RESIDUAL over the key union rather than from a fixed list, so a field
 * added to `TopologySpecSchema` later is covered the moment it exists instead of
 * silently opening a new blind spot in the CI gate.
 */
function changedGraphFields(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (ENUMERATED_KEYS.has(key)) continue;
    if (stableJson(left[key]) !== stableJson(right[key])) changed.push(key);
  }
  return changed.sort(compareStrings);
}

/**
 * Ids present on both sides whose canonical form differs.
 *
 * Reported as a removal PLUS an addition rather than as a silent identity: an edge or a
 * channel is identified by its full shape, so re-pointing `e-doc-approval` from
 * `hitl_commit` to `commit` is not "the same edge, slightly different" — it is a
 * different edge wearing the same id, and a diff that hid it would let a routing change
 * merge as an empty diff. This mirrors the node rule, where anything that is not an
 * exact field-for-field rename is reported as add plus remove.
 */
interface KeyedDiff {
  added: string[];
  removed: string[];
}

function diffKeyed(
  before: Map<string, Record<string, unknown>>,
  after: Map<string, Record<string, unknown>>,
): KeyedDiff {
  const added: string[] = [];
  const removed: string[] = [];
  for (const [id, entry] of before) {
    const other = after.get(id);
    if (other === undefined) {
      removed.push(id);
      continue;
    }
    if (stableJson(entry) !== stableJson(other)) {
      removed.push(id);
      added.push(id);
    }
  }
  for (const id of after.keys()) {
    if (!before.has(id)) added.push(id);
  }
  return { added: added.sort(compareStrings), removed: removed.sort(compareStrings) };
}

/**
 * Outcome labels per router, keyed by node id.
 *
 * Only `kind: "router"` nodes carry labels (ADR-3), so a node that stops being a router
 * loses every label — which is exactly the change an author must see.
 */
function routeLabels(nodes: Map<string, Record<string, unknown>>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [id, node] of nodes) {
    if (node.kind !== "router") continue;
    const targets = node.targets;
    const labels = new Set<string>();
    if (Array.isArray(targets)) {
      for (const target of targets) {
        if (!isPlainObject(target)) continue;
        if (typeof target.label === "string") labels.add(target.label);
      }
    }
    out.set(id, labels);
  }
  return out;
}

// ── graphVersion ────────────────────────────────────────────────────

function parseVersion(value: string): [number, number, number] | undefined {
  if (!GRAPH_VERSION_PATTERN.test(value)) return undefined;
  const parts = value.split(".").map((part) => Number.parseInt(part, 10));
  return [parts[0], parts[1], parts[2]];
}

/**
 * True when `to` is strictly greater than `from` under numeric semver comparison.
 *
 * A DOWNGRADE is deliberately not a bump: the CI gate exists to prove a structural
 * change was accompanied by a forward version move, and `1.1.0 -> 1.0.0` is not one.
 */
export function isVersionBumped(from: string, to: string): boolean {
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (b[i] > a[i]) return true;
    if (b[i] < a[i]) return false;
  }
  return false;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Diff two topology artifacts structurally.
 *
 * Node renames are detected only when an added node and a removed node are identical
 * field for field apart from `id`; anything else is reported as an addition plus a
 * removal rather than as a guessed rename.
 *
 * @throws TypeError when either input fails `TopologySpecSchema.parse`.
 */
export function diffTopology(a: TopologySpec, b: TopologySpec): TopologyDiff {
  const left = canonicalSide(a, "left");
  const right = canonicalSide(b, "right");

  const beforeNodes = indexById(left.nodes);
  const afterNodes = indexById(right.nodes);

  const nodesAdded: string[] = [];
  const nodesRemoved: string[] = [];
  const nodesChanged: NodeFieldChange[] = [];

  for (const [id, node] of beforeNodes) {
    const other = afterNodes.get(id);
    if (other === undefined) {
      nodesRemoved.push(id);
      continue;
    }
    const fields = changedFields(node, other);
    if (fields.length > 0) nodesChanged.push({ id, fields });
  }
  for (const id of afterNodes.keys()) {
    if (!beforeNodes.has(id)) nodesAdded.push(id);
  }
  nodesAdded.sort(compareStrings);
  nodesRemoved.sort(compareStrings);
  nodesChanged.sort((x, y) => compareStrings(x.id, y.id));

  // Rename detection: an added node and a removed node whose FULL field set matches
  // apart from `id`. Both lists are walked in sorted order and each side is consumed at
  // most once, so the pairing is deterministic.
  const nodesRenamed: NodeRename[] = [];
  const addedByShape = new Map<string, string[]>();
  for (const id of nodesAdded) {
    const shape = stableJson(withoutId(afterNodes.get(id) as Record<string, unknown>));
    const bucket = addedByShape.get(shape);
    if (bucket) bucket.push(id);
    else addedByShape.set(shape, [id]);
  }
  const consumedAdded = new Set<string>();
  const consumedRemoved = new Set<string>();
  for (const id of nodesRemoved) {
    const shape = stableJson(withoutId(beforeNodes.get(id) as Record<string, unknown>));
    const bucket = addedByShape.get(shape);
    if (!bucket) continue;
    const match = bucket.find((candidate) => !consumedAdded.has(candidate));
    if (match === undefined) continue;
    consumedAdded.add(match);
    consumedRemoved.add(id);
    nodesRenamed.push({ from: id, to: match });
  }
  nodesRenamed.sort((x, y) => compareStrings(x.from, y.from));

  const renamedTo = new Map<string, string>(nodesRenamed.map((r) => [r.from, r.to]));

  const edges = diffKeyed(indexById(left.edges), indexById(right.edges));
  const channels = diffKeyed(indexById(left.channels), indexById(right.channels));

  // Route labels are compared per router AFTER applying the rename mapping, so a pure
  // rename of a router does not present as "every label removed, every label added".
  const beforeLabelsRaw = routeLabels(beforeNodes);
  const beforeLabels = new Map<string, Set<string>>();
  for (const [id, labels] of beforeLabelsRaw) {
    beforeLabels.set(renamedTo.get(id) ?? id, labels);
  }
  const afterLabels = routeLabels(afterNodes);

  const routeLabelsAdded: RouteLabelChange[] = [];
  const routeLabelsRemoved: RouteLabelChange[] = [];
  const routerIds = [...new Set([...beforeLabels.keys(), ...afterLabels.keys()])].sort(
    compareStrings,
  );
  for (const router of routerIds) {
    const before = beforeLabels.get(router) ?? new Set<string>();
    const after = afterLabels.get(router) ?? new Set<string>();
    for (const label of [...after].sort(compareStrings)) {
      if (!before.has(label)) routeLabelsAdded.push({ router, label });
    }
    for (const label of [...before].sort(compareStrings)) {
      if (!after.has(label)) routeLabelsRemoved.push({ router, label });
    }
  }

  const finalNodesAdded = nodesAdded.filter((id) => !consumedAdded.has(id));
  const finalNodesRemoved = nodesRemoved.filter((id) => !consumedRemoved.has(id));

  const graphFieldsChanged = changedGraphFields(left, right);

  const from = String(left.graphVersion ?? "");
  const to = String(right.graphVersion ?? "");

  const empty =
    graphFieldsChanged.length === 0 &&
    finalNodesAdded.length === 0 &&
    finalNodesRemoved.length === 0 &&
    nodesRenamed.length === 0 &&
    nodesChanged.length === 0 &&
    edges.added.length === 0 &&
    edges.removed.length === 0 &&
    channels.added.length === 0 &&
    channels.removed.length === 0 &&
    routeLabelsAdded.length === 0 &&
    routeLabelsRemoved.length === 0;

  return {
    empty,
    graphVersion: { from, to, bumped: isVersionBumped(from, to) },
    graphFieldsChanged,
    nodesAdded: finalNodesAdded,
    nodesRemoved: finalNodesRemoved,
    nodesRenamed,
    nodesChanged,
    edgesAdded: edges.added,
    edgesRemoved: edges.removed,
    channelsAdded: channels.added,
    channelsRemoved: channels.removed,
    routeLabelsAdded,
    routeLabelsRemoved,
  };
}

/** Deterministic JSON form of a diff, as `bober pge diff` prints it. */
export function serializeTopologyDiff(diff: TopologyDiff): string {
  return `${JSON.stringify(diff, null, 2)}\n`;
}
