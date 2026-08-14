import { readFile } from "node:fs/promises";
import type { TopologySpec } from "../../contracts/topology.js";

/**
 * Documentation drift between a markdown document and a topology artifact.
 *
 * The core is PURE — `docDrift` takes the document TEXT — and only the thin
 * `checkDocDrift` convenience wrapper touches the filesystem, through
 * `node:fs/promises`. The architecture writes `checkDocDrift(spec, docPath): string[]`;
 * it is `Promise<string[]>` here because the project forbids synchronous filesystem
 * calls, and a reader that cannot be awaited would have to be one.
 *
 * ── The marker convention ───────────────────────────────────────────
 *
 * Node ids are read ONLY from inline code spans inside a delimited block:
 *
 *   <!-- pge:nodes -->
 *   - `research_body` — calls the research subgraph
 *   - `gate_research_in` — boundary gate
 *   <!-- /pge:nodes -->
 *
 * Scanning the whole document instead would report every `TopologySpec` and
 * `graphVersion` mention as an undeclared node, so the checker would be noisy enough to
 * be ignored — the exact failure mode the CI gate exists to prevent. A document with no
 * marker block documents NO nodes, so its drift is every declared node id: an absent
 * block is a loud failure, never a silent pass.
 */

// ── Markers ─────────────────────────────────────────────────────────

export const DOC_NODES_BEGIN = "<!-- pge:nodes -->";
export const DOC_NODES_END = "<!-- /pge:nodes -->";

/** Inline code spans holding a bare identifier: `` `research_body` ``. */
const CODE_SPAN = /`([A-Za-z_][A-Za-z0-9_]*)`/g;

// ── Extraction ──────────────────────────────────────────────────────

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Every `pge:nodes` region of the document, concatenated. */
function markedRegions(docText: string): string {
  const regions: string[] = [];
  let cursor = 0;
  for (;;) {
    const begin = docText.indexOf(DOC_NODES_BEGIN, cursor);
    if (begin === -1) break;
    const contentStart = begin + DOC_NODES_BEGIN.length;
    const end = docText.indexOf(DOC_NODES_END, contentStart);
    if (end === -1) {
      // An unterminated block reads to the end of the document rather than being
      // discarded: dropping it would turn a typo in the closing marker into "every node
      // is undocumented", which reads as a topology problem instead of a doc problem.
      regions.push(docText.slice(contentStart));
      break;
    }
    regions.push(docText.slice(contentStart, end));
    cursor = end + DOC_NODES_END.length;
  }
  return regions.join("\n");
}

/** Node ids the document claims to document, sorted and de-duplicated. */
export function documentedNodeIds(docText: string): string[] {
  const region = markedRegions(docText);
  const found = new Set<string>();
  for (const match of region.matchAll(CODE_SPAN)) {
    found.add(match[1]);
  }
  return [...found].sort(compareStrings);
}

// ── Drift ───────────────────────────────────────────────────────────

export interface DocDriftReport {
  /** Node ids the document declares, sorted. */
  documented: string[];
  /** Node ids the artifact declares, sorted. */
  declared: string[];
  /** Declared but not documented — a node nobody wrote down. */
  missing: string[];
  /** Documented but not declared — a node that no longer exists. */
  extra: string[];
  /** The symmetric difference: `missing` ∪ `extra`, sorted. Empty only when the sets are equal. */
  drift: string[];
}

/** Directional drift report. Pure — takes the document text, not a path. */
export function docDriftReport(spec: TopologySpec, docText: string): DocDriftReport {
  const documentedSet = new Set(documentedNodeIds(docText));
  const declaredSet = new Set(spec.nodes.map((node) => node.id));

  const missing = [...declaredSet].filter((id) => !documentedSet.has(id)).sort(compareStrings);
  const extra = [...documentedSet].filter((id) => !declaredSet.has(id)).sort(compareStrings);

  return {
    documented: [...documentedSet].sort(compareStrings),
    declared: [...declaredSet].sort(compareStrings),
    missing,
    extra,
    drift: [...new Set([...missing, ...extra])].sort(compareStrings),
  };
}

/**
 * The symmetric difference between the node ids in `docText` and the node ids in the
 * artifact. Empty only when the two sets are equal. Pure.
 */
export function docDrift(spec: TopologySpec, docText: string): string[] {
  return docDriftReport(spec, docText).drift;
}

/**
 * Read `docPath` and return {@link docDrift}.
 *
 * Filesystem errors propagate — a missing document is a caller-level usage error, not a
 * clean drift report, and returning `[]` for an unreadable file would let the CI gate
 * pass on a deleted document.
 */
export async function checkDocDrift(spec: TopologySpec, docPath: string): Promise<string[]> {
  const text = await readFile(docPath, "utf8");
  return docDrift(spec, text);
}
