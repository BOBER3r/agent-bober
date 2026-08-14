/**
 * TokensaveBackend — GraphBackend implementation for tokensave 6.1.1.
 *
 * Owns the tokensave_* tool catalog, the raw 6.1.1 row/result shapes, and the
 * narrow() adapters that turn those raw shapes into the shared NodeRef /
 * SearchHit / ImpactReport types. This is a pure adapter: no MCP calls, no
 * filesystem access, no sandbox filtering — GraphClient owns all of that.
 */

import semver from "semver";
import type { ImpactReport, NodeRef, SearchHit, StatusResult } from "../types.js";
import { assertNever } from "../types.js";
import type { CallPlan, CliMap, GraphBackend, Platform, PrereqSpec, ProcessSpec, QueryPattern, SearchOpts } from "./types.js";

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

// ── Process / prereq / CLI specs (verbatim — DO NOT paraphrase) ────
// tokensave binary + supported version range + install hints + CLI verbs.
// These strings are the ONLY place tokensave-specific literals for the
// transport/prereq/cli layers should live (sc-2-5).

export const TOKENSAVE_VERSION_RANGE = ">=6.0.0-beta.1 <7.0.0";

/** Platform-aware install hint. Strings are verbatim from s1-c2 — DO NOT paraphrase. */
function tokensaveInstallHint(platform: Platform): string {
  switch (platform) {
    case "darwin":
      return "brew install aovestdipaperino/tap/tokensave";
    case "win32":
      return "scoop bucket add tokensave https://github.com/aovestdipaperino/scoop-bucket && scoop install tokensave";
    default:
      return "cargo install tokensave";
  }
}

/** Must name both detected and required versions (s1-c2). */
function tokensaveIncompatibleHint(detected: string): string {
  return `tokensave ${detected} is incompatible; required range: ${TOKENSAVE_VERSION_RANGE}`;
}

/**
 * Parse the number of indexed files from tokensave sync output.
 *
 * tokensave 6.x prints a human summary like
 *   "✔ sync done — 3 added, 1 modified, 0 removed in 41ms"
 * (with ANSI colour codes), so we sum added + modified. Legacy JSON
 * (`{"indexed": N}`) and `indexed: N` key-value forms are still accepted.
 */
function parseSyncOutput(output: string): number {
  // Strip ANSI escape sequences before matching.
  // eslint-disable-next-line no-control-regex
  const trimmed = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").trim();
  if (!trimmed) return 0;

  // Try direct JSON parse (legacy shape)
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof obj.indexed === "number") return obj.indexed;
  } catch {
    // Fall through
  }

  // Incremental sync summary: "N added, M modified, K removed"
  const added = /(\d+)\s+added/.exec(trimmed);
  const modified = /(\d+)\s+modified/.exec(trimmed);
  if (added || modified) {
    return (
      (added ? parseInt(added[1], 10) : 0) +
      (modified ? parseInt(modified[1], 10) : 0)
    );
  }

  // Full re-index summary (--force): "indexing done — N files, ... nodes"
  const files = /(\d+)\s+files\b/.exec(trimmed);
  if (files) return parseInt(files[1], 10);

  // Legacy key-value pattern like "indexed: 42"
  const match = /indexed["\s:]+(\d+)/.exec(trimmed);
  if (match) return parseInt(match[1], 10);

  return 0;
}

/** Parse `tokensave status --json` stdout into the shared StatusResult shape. */
function parseStatusOutput(stdout: string): StatusResult {
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  // tokensave `status --json` returns {node_count, edge_count, file_count,
  // nodes_by_kind, ...}. There is no `ready`/`indexedFileCount` field and no
  // version, so derive `ready` from the presence of an index (file_count).
  // Tolerate the legacy {ready, indexedFileCount, tokensaveVersion} shape too.
  const fileCount =
    typeof parsed.file_count === "number"
      ? parsed.file_count
      : typeof parsed.indexedFileCount === "number"
        ? parsed.indexedFileCount
        : 0;
  const ready =
    parsed.ready === true ||
    typeof parsed.file_count === "number" ||
    typeof parsed.node_count === "number";
  return {
    ready,
    indexedFileCount: fileCount,
    tokensaveVersion:
      typeof parsed.tokensaveVersion === "string" ? parsed.tokensaveVersion : "",
  };
}

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

  // ── Process / prereq / CLI specs ────────────────────────────────────

  processSpec(): ProcessSpec {
    return { binary: "tokensave", serveArgs: ["serve"] };
  }

  prereqSpec(): PrereqSpec {
    return {
      versionArgs: ["--version"],
      isCompatible: (version) =>
        semver.satisfies(version, TOKENSAVE_VERSION_RANGE, {
          includePrerelease: true,
        }),
      installHint: (platform) => tokensaveInstallHint(platform),
      incompatibleHint: (detected) => tokensaveIncompatibleHint(detected),
    };
  }

  cliMap(): CliMap {
    return {
      // languageTier is a bober-level concept recorded in the manifest only;
      // it is accepted for caller convenience but NOT forwarded to the binary
      // (tokensave's `init` has no `--tier` flag).
      initArgs: (_opts) => ["init"],
      syncArgs: (paths) => ["sync", ...paths],
      statusArgs: ["status", "--json"],
      parseSync: (out) => parseSyncOutput(out),
      parseStatus: (stdout) => parseStatusOutput(stdout),
    };
  }
}
