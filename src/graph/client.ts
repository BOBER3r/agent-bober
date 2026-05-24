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
import { sandboxNodePath } from "./sandbox.js";

// Tokensave MCP tool catalog → GraphClient method mapping.
// Names match the canonical tool catalog (per the project CLAUDE.md);
// no `tokensave_` prefix.
const TOOL = {
  search: "semantic_search_nodes",
  query: "query_graph",
  impact: "get_impact_radius",
  reviewContext: "get_review_context",
  overview: "get_architecture_overview",
  changes: "detect_changes",
} as const;

type QueryPattern = "callers_of" | "callees_of" | "imports_of" | "tests_for";

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
    return this.runWithSandbox(TOOL.search, { query: q, ...opts }, (raw) => {
      const hits = (raw as SearchHit[]).filter((h) => this.keepNode(h.node, "search"));
      return hits;
    });
  }

  async query(pattern: QueryPattern, target: NodeRef): Promise<GraphResult<NodeRef[]>> {
    return this.runWithSandbox(TOOL.query, { pattern, target }, (raw) => {
      return (raw as NodeRef[]).filter((n) => this.keepNode(n, "query"));
    });
  }

  async impact(target: NodeRef | string): Promise<GraphResult<ImpactReport>> {
    return this.runWithSandbox(TOOL.impact, { target }, (raw) => {
      const report = raw as ImpactReport;
      return {
        root: report.root, // root may be out-of-sandbox but is informational only
        affected: report.affected.filter((n) => this.keepNode(n, "impact")),
        testsAffected: report.testsAffected.filter((n) =>
          this.keepNode(n, "impact"),
        ),
      };
    });
  }

  async reviewContext(nodes: NodeRef[]): Promise<GraphResult<string>> {
    return this.runRaw<string>(TOOL.reviewContext, { nodes });
  }

  async overview(): Promise<GraphResult<string>> {
    return this.runRaw<string>(TOOL.overview, {});
  }

  async changes(since?: string): Promise<GraphResult<NodeRef[]>> {
    return this.runWithSandbox(TOOL.changes, { since }, (raw) => {
      return (raw as NodeRef[]).filter((n) => this.keepNode(n, "changes"));
    });
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
