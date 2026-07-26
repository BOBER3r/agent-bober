/**
 * TokensaveBackend — GraphBackend implementation for tokensave 6.1.1.
 *
 * Owns the tokensave_* tool catalog, the raw 6.1.1 row/result shapes, and the
 * narrow() adapters that turn those raw shapes into the shared NodeRef /
 * SearchHit / ImpactReport types. This is a pure adapter: no MCP calls, no
 * filesystem access, no sandbox filtering — GraphClient owns all of that.
 */

import type { ImpactReport, NodeRef, SearchHit } from "../types.js";
import { assertNever } from "../types.js";
import type { CallPlan, GraphBackend, QueryPattern, SearchOpts } from "./types.js";

// ── Tokensave 6.1.1 tool catalog ────────────────────────────────────
// All tools use the `tokensave_` prefix as emitted by tokensave 6.1.1's tools/list.

const TOOL = {
  search: "tokensave_search",
  impact: "tokensave_impact",
  reviewContext: "tokensave_context",
  overview: "tokensave_module_api",
  changes: "tokensave_changelog",
} as const;

// Per-pattern query tool map: each QueryPattern maps to a distinct tokensave 6.1.1 tool.
const QUERY_TOOL = {
  callers_of: "tokensave_callers",
  callees_of: "tokensave_callees",
  imports_of: "tokensave_file_dependents",
  tests_for: "tokensave_test_map",
} as const;

// ── Raw 6.1.1 row types (adapter-internal only) ────────────────────

/** Raw row returned by tokensave_search */
type TsSearchRow = {
  file: string;
  id: string;
  kind: string;
  line: number;
  name: string;
  score: number;
  signature?: string;
};

/** Raw row returned by tokensave_callers / tokensave_callees */
type TsEdgeRow = {
  edge_kind: string;
  file: string;
  kind: string;
  line: number;
  name: string;
  node_id: string;
  dispatch_via_trait?: boolean;
};

/** Raw object returned by tokensave_file_dependents */
type TsFileDependentsResult = {
  count: number;
  dependents: string[];
  file: string;
};

/** Raw object returned by tokensave_test_map */
type TsTestMapResult = {
  coverage: unknown[];
  covered_symbols: number;
  test_files: string[];
  uncovered: Array<{ file: string; id: string; line: number; name: string }>;
};

/** Raw object returned by tokensave_impact */
type TsImpactResult = {
  edge_count: number;
  node_count: number;
  nodes: Array<{ file: string; id: string; kind: string; line: number; name: string }>;
};

/** Raw object returned by tokensave_module_api */
type TsModuleApiResult = {
  path: string;
  public_symbol_count: number;
  symbols: Array<{ file: string; id: string; kind: string; line: number; name: string; signature?: string }>;
};

/** Raw object returned by tokensave_changelog */
type TsChangelogResult = {
  changed_file_count: number;
  changed_files: string[];
  files_not_indexed: string[];
  from_ref: string;
  symbols_in_changed_files: Array<{ file: string; id: string; kind: string; line: number; name: string; signature?: string }>;
};

// ── Kind coercion ──────────────────────────────────────────────────

/** Valid NodeRef.kind values — 6.1.1 emits wider kinds; coerce unknowns to "symbol". */
const NODE_KINDS = new Set<string>(["function", "class", "module", "symbol"]);

function toNodeRef(row: {
  id?: string;
  node_id?: string;
  name: string;
  file: string;
  line: number;
  kind?: string;
}): NodeRef {
  return {
    id: row.id ?? row.node_id ?? "",
    kind: NODE_KINDS.has(row.kind ?? "") ? (row.kind as NodeRef["kind"]) : "symbol",
    file: row.file,
    line: row.line,
    symbol: row.name,
  };
}

// ── Backend ──────────────────────────────────────────────────────────

export class TokensaveBackend implements GraphBackend {
  readonly id = "tokensave";

  searchPlan(q: string, opts?: SearchOpts): CallPlan<SearchHit[]> {
    return {
      tool: TOOL.search,
      params: { query: q, ...(opts?.limit !== undefined ? { limit: opts.limit } : {}) },
      narrow: (raw) => {
        const rows = raw as TsSearchRow[];
        const hits: SearchHit[] = rows.map((row) => ({
          node: toNodeRef(row),
          score: row.score,
          snippet: row.signature ?? "",
        }));
        // Post-filter by kind if requested (tokensave_search has no kind param).
        return opts?.kind ? hits.filter((h) => h.node.kind === opts.kind) : hits;
      },
    };
  }

  queryPlan(pattern: QueryPattern, target: NodeRef): CallPlan<NodeRef[]> {
    switch (pattern) {
      case "callers_of":
      case "callees_of": {
        const tool = QUERY_TOOL[pattern];
        return {
          tool,
          params: { node_id: target.id },
          narrow: (raw) => {
            const rows = raw as TsEdgeRow[];
            return rows.map((row) => toNodeRef({ ...row, id: row.node_id }));
          },
        };
      }
      case "imports_of": {
        return {
          tool: QUERY_TOOL.imports_of,
          params: { file: target.file },
          narrow: (raw) => {
            const result = raw as TsFileDependentsResult;
            return result.dependents.map((path): NodeRef => ({
              id: path,
              kind: "module",
              file: path,
              line: 0,
              symbol: path,
            }));
          },
        };
      }
      case "tests_for": {
        return {
          tool: QUERY_TOOL.tests_for,
          params: { file: target.file },
          narrow: (raw) => {
            const result = raw as TsTestMapResult;
            if (result.test_files.length > 0) {
              return result.test_files.map((path): NodeRef => ({
                id: path,
                kind: "module",
                file: path,
                line: 0,
                symbol: path,
              }));
            }
            // Fall back to uncovered symbol rows if test_files is empty.
            return result.uncovered.map((row) => toNodeRef(row));
          },
        };
      }
      default:
        return assertNever(pattern);
    }
  }

  impactPlan(target: NodeRef | string): CallPlan<ImpactReport> {
    const nodeId = typeof target === "string" ? target : target.id;
    return {
      tool: TOOL.impact,
      params: { node_id: nodeId },
      narrow: (raw) => {
        const result = raw as TsImpactResult;
        const allNodes = result.nodes.map((row) => toNodeRef(row));
        const root = allNodes[0] ?? toNodeRef({
          id: nodeId,
          name: nodeId,
          file: typeof target === "string" ? "" : target.file,
          line: 0,
          kind: "symbol",
        });
        const rest = allNodes.slice(1);
        const testsAffected = rest.filter((n) => /test|spec/i.test(n.file));
        const affected = rest.filter((n) => !/test|spec/i.test(n.file));
        return { root, affected, testsAffected };
      },
    };
  }

  reviewContextPlan(nodes: NodeRef[]): CallPlan<string> {
    const task = nodes.map((n) => n.symbol).join(", ");
    return {
      tool: TOOL.reviewContext,
      params: { task },
      narrow: (raw) => raw as string,
    };
  }

  overviewPlan(): CallPlan<string> {
    return {
      tool: TOOL.overview,
      params: { path: "src" },
      narrow: (raw) => {
        // tokensave_module_api returns a JSON object; stringify for string callers.
        const result = raw as TsModuleApiResult;
        return JSON.stringify(result);
      },
    };
  }

  changesPlan(since?: string): CallPlan<NodeRef[]> {
    return {
      tool: TOOL.changes,
      params: { from_ref: since ?? "HEAD~1", to_ref: "HEAD" },
      narrow: (raw) => {
        const result = raw as TsChangelogResult;
        return result.symbols_in_changed_files.map((row) => toNodeRef(row));
      },
    };
  }
}
