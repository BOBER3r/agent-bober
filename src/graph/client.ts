/**
 * GraphClient — the single typed facade the rest of the harness imports.
 *
 * All methods return Promise<GraphResult<T>> and NEVER throw for expected
 * failure modes. Callers branch on `.ok`. (ADR-3)
 *
 * Sandbox post-filter is a single chokepoint here — every NodeRef.file
 * is validated via sandboxNodePath before returning to callers.
 */

import type { TokensaveMcpClient } from "./mcp-client.js";
import type { GraphArtifactStore } from "./artifact-store.js";
import { type GraphFallback } from "./fallback.js";
import type { IncidentLog } from "./incidents.js";
import type {
  FallbackHint,
  GraphFailureReason,
  GraphResult,
  GraphSection,
  ImpactReport,
  NodeRef,
  PrefetchSpec,
  SearchHit,
  StalenessVerdict,
} from "./types.js";
import { assertNever } from "./types.js";
import { sandboxNodePath } from "./sandbox.js";

// Tokensave MCP tool catalog → GraphClient method mapping.
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

type QueryPattern = "callers_of" | "callees_of" | "imports_of" | "tests_for";

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

export interface SearchOpts {
  limit?: number;
  kind?: NodeRef["kind"];
}

export class GraphClient {
  /** Session-level cached staleness verdict. Read once on first method call;
   *  may be invalidated by markFresh() when GraphHookHandler (sprint 8)
   *  signals a sync just completed. */
  private staleCache: StalenessVerdict | null = null;

  constructor(
    private readonly projectRoot: string,
    private readonly mcpClient: TokensaveMcpClient,
    private readonly artifactStore: GraphArtifactStore,
    private readonly fallback: GraphFallback,
    private readonly incidents: IncidentLog,
    private readonly config: GraphSection,
  ) {}

  /** Invalidate the session staleness cache. Called by GraphHookHandler (sprint 8). */
  markFresh(): void {
    this.staleCache = { stale: false };
  }

  /**
   * Return a user-facing FallbackHint for a given failure reason.
   * Consumed by GraphMcpTools (sprint 4) to generate fallback guidance.
   */
  hintFor(reason: GraphFailureReason, detail?: string): FallbackHint {
    return this.fallback.hint(reason, detail);
  }

  // ── Public API ──────────────────────────────────────────────────

  async search(q: string, opts?: SearchOpts): Promise<GraphResult<SearchHit[]>> {
    return this.runWithSandbox(
      TOOL.search,
      { query: q, ...(opts?.limit !== undefined ? { limit: opts.limit } : {}) },
      (raw) => {
        const rows = raw as TsSearchRow[];
        const hits: SearchHit[] = rows.map((row) => ({
          node: toNodeRef(row),
          score: row.score,
          snippet: row.signature ?? "",
        }));
        // Post-filter by kind if requested (tokensave_search has no kind param).
        const filtered = opts?.kind
          ? hits.filter((h) => h.node.kind === opts.kind)
          : hits;
        return filtered.filter((h) => this.keepNode(h.node, "search"));
      },
    );
  }

  async query(pattern: QueryPattern, target: NodeRef): Promise<GraphResult<NodeRef[]>> {
    switch (pattern) {
      case "callers_of":
      case "callees_of": {
        const tool = QUERY_TOOL[pattern];
        return this.runWithSandbox(tool, { node_id: target.id }, (raw) => {
          const rows = raw as TsEdgeRow[];
          return rows
            .map((row) => toNodeRef({ ...row, id: row.node_id }))
            .filter((n) => this.keepNode(n, "query"));
        });
      }
      case "imports_of": {
        return this.runWithSandbox(
          QUERY_TOOL.imports_of,
          { file: target.file },
          (raw) => {
            const result = raw as TsFileDependentsResult;
            return result.dependents
              .map((path): NodeRef => ({
                id: path,
                kind: "module",
                file: path,
                line: 0,
                symbol: path,
              }))
              .filter((n) => this.keepNode(n, "query"));
          },
        );
      }
      case "tests_for": {
        return this.runWithSandbox(
          QUERY_TOOL.tests_for,
          { file: target.file },
          (raw) => {
            const result = raw as TsTestMapResult;
            if (result.test_files.length > 0) {
              return result.test_files
                .map((path): NodeRef => ({
                  id: path,
                  kind: "module",
                  file: path,
                  line: 0,
                  symbol: path,
                }))
                .filter((n) => this.keepNode(n, "query"));
            }
            // Fall back to uncovered symbol rows if test_files is empty.
            return result.uncovered
              .map((row) => toNodeRef(row))
              .filter((n) => this.keepNode(n, "query"));
          },
        );
      }
      default:
        return assertNever(pattern);
    }
  }

  async impact(target: NodeRef | string): Promise<GraphResult<ImpactReport>> {
    const nodeId = typeof target === "string" ? target : target.id;
    return this.runWithSandbox(TOOL.impact, { node_id: nodeId }, (raw) => {
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
      return {
        root, // root may be out-of-sandbox but is informational only
        affected: affected.filter((n) => this.keepNode(n, "impact")),
        testsAffected: testsAffected.filter((n) => this.keepNode(n, "impact")),
      };
    });
  }

  async reviewContext(nodes: NodeRef[]): Promise<GraphResult<string>> {
    const task = nodes.map((n) => n.symbol).join(", ");
    return this.runRaw<string>(TOOL.reviewContext, { task });
  }

  async overview(): Promise<GraphResult<string>> {
    return this.runWithSandbox<string>(TOOL.overview, { path: "src" }, (raw) => {
      // tokensave_module_api returns a JSON object; stringify for string callers.
      const result = raw as TsModuleApiResult;
      return JSON.stringify(result);
    });
  }

  async changes(since?: string): Promise<GraphResult<NodeRef[]>> {
    return this.runWithSandbox(
      TOOL.changes,
      { from_ref: since ?? "HEAD~1", to_ref: "HEAD" },
      (raw) => {
        const result = raw as TsChangelogResult;
        return result.symbols_in_changed_files
          .map((row) => toNodeRef(row))
          .filter((n) => this.keepNode(n, "changes"));
      },
    );
  }

  async prefetch(
    queries: PrefetchSpec[],
  ): Promise<Record<string, GraphResult<unknown>>> {
    if (queries.length === 0) return {};

    const dispatched = queries.map((q) => this.dispatch(q));
    const settled = await Promise.allSettled(dispatched);

    const out: Record<string, GraphResult<unknown>> = {};
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i]!;
      const s = settled[i]!;
      if (s.status === "fulfilled") {
        out[q.key] = s.value;
      } else {
        // Should never happen because dispatch returns GraphResult,
        // never throws — but defend just in case.
        out[q.key] = {
          ok: false,
          reason: "GRAPH_ERROR",
          detail: s.reason instanceof Error ? s.reason.message : String(s.reason),
        };
      }
    }
    return out;
  }

  // ── Internals ──────────────────────────────────────────────────

  private dispatch(q: PrefetchSpec): Promise<GraphResult<unknown>> {
    switch (q.op) {
      case "search":
        return this.search(
          (q.args as { q: string }).q,
          q.args as SearchOpts,
        ) as Promise<GraphResult<unknown>>;
      case "query":
        return this.query(
          (q.args as { pattern: QueryPattern; target: NodeRef }).pattern,
          (q.args as { pattern: QueryPattern; target: NodeRef }).target,
        ) as Promise<GraphResult<unknown>>;
      case "impact":
        return this.impact(
          (q.args as { target: NodeRef | string }).target,
        ) as Promise<GraphResult<unknown>>;
      case "reviewContext":
        return this.reviewContext(
          (q.args as { nodes: NodeRef[] }).nodes,
        ) as Promise<GraphResult<unknown>>;
      case "overview":
        return this.overview() as Promise<GraphResult<unknown>>;
      case "changes":
        return this.changes(
          (q.args as { since?: string }).since,
        ) as Promise<GraphResult<unknown>>;
      default:
        // exhaustiveness — TypeScript will complain if a PrefetchOp is added
        // without a case here.
        return Promise.resolve({
          ok: false,
          reason: "GRAPH_ERROR" as const,
          detail: `unknown prefetch op: ${String(q.op)}`,
        });
    }
  }

  /**
   * Common path for methods that need NodeRef sandbox filtering.
   * Runs the MCP call, times it, narrows result, sandboxes nodes, returns GraphResult.
   */
  private async runWithSandbox<T>(
    tool: string,
    params: unknown,
    narrow: (raw: unknown) => T,
  ): Promise<GraphResult<T>> {
    if (!this.config.enabled) {
      return { ok: false, reason: "GRAPH_DISABLED", detail: "graph.enabled=false" };
    }
    const health = this.mcpClient.health();
    if (health === "broken" || health === "restarting") {
      return {
        ok: false,
        reason: "GRAPH_UNAVAILABLE",
        detail: health === "broken" ? "engine breaker tripped" : "engine is restarting",
      };
    }

    const stale = await this.checkStaleness();

    const t0 = Date.now();
    try {
      const raw = await this.mcpClient.call<unknown>(tool, params);
      const data = narrow(raw);
      // TODO(phase-2): map backend to 'binding' when EngineBinding ships.
      const result: GraphResult<T> = {
        ok: true,
        data,
        backend: "mcp",
        durationMs: Date.now() - t0,
      };
      if (stale) (result as { stale?: true }).stale = true;
      return result;
    } catch (err) {
      return this.toFailureResult(err);
    }
  }

  /** Same as runWithSandbox but the result type is T with no NodeRef post-filter. */
  private async runRaw<T>(tool: string, params: unknown): Promise<GraphResult<T>> {
    return this.runWithSandbox<T>(tool, params, (raw) => raw as T);
  }

  /** Convert a makeGraphError-tagged Error from TokensaveMcpClient.call into a
   *  GraphResult.ok=false. mcp-client.ts:58-63 sets .reason on the Error. */
  private toFailureResult<T>(err: unknown): GraphResult<T> {
    const reason =
      (err as { reason?: GraphFailureReason } | undefined)?.reason ?? "GRAPH_ERROR";
    const detail =
      (err as { detail?: string } | undefined)?.detail ??
      (err instanceof Error ? err.message : String(err));
    return { ok: false, reason, detail };
  }

  /** One-time staleness probe, cached for the session. */
  private async checkStaleness(): Promise<boolean> {
    if (this.staleCache === null) {
      this.staleCache = await this.artifactStore.staleness();
    }
    return this.staleCache.stale;
  }

  /** Returns true if the node should be kept; false → silently dropped + incident logged. */
  private keepNode(node: NodeRef | undefined, source: string): boolean {
    if (!node || !node.file) {
      void this.logSandboxDrop(node?.file ?? null, source);
      return false;
    }
    const sb = sandboxNodePath(this.projectRoot, node.file);
    if (!sb.ok) {
      void this.logSandboxDrop(node.file, source);
      return false;
    }
    return true;
  }

  private async logSandboxDrop(file: string | null, source: string): Promise<void> {
    try {
      await this.incidents.append({
        ts: new Date().toISOString(),
        event: "sandbox-drop",
        file: file ?? "<null>",
        source,
      });
    } catch {
      // Incident-write failures must not break agent flow.
    }
  }
}
