// GraphBackend — per-backend tool catalog, param builders, and response-shape
// adapters. The backend produces {tool, params, narrow}; GraphClient keeps
// ownership of sandbox filtering, staleness, health short-circuits, and
// prefetch dispatch (see src/graph/client.ts).

import type { ImpactReport, NodeRef, SearchHit, StatusResult } from "../types.js";

// ── Public API types shared with GraphClient ───────────────────────

/** Query patterns supported by GraphClient.query(). */
export type QueryPattern =
  | "callers_of"
  | "callees_of"
  | "imports_of"
  | "tests_for";

/** Options accepted by GraphClient.search(). */
export interface SearchOpts {
  limit?: number;
  kind?: NodeRef["kind"];
}

// ── Engine process / prereq / CLI specs ─────────────────────────────

/** Alias of the ambient `NodeJS.Platform` type via `process.platform`,
 *  avoiding a direct `NodeJS.*` reference (eslint no-undef has no type-aware
 *  awareness of the ambient NodeJS namespace in this project's flat config). */
export type Platform = typeof process.platform;

/** How to run the backend's long-lived MCP server. */
export interface ProcessSpec {
  binary: string;
  serveArgs: string[];
}

/** How to detect + version-gate the backend binary. */
export interface PrereqSpec {
  versionArgs: string[];
  isCompatible(version: string): boolean;
  installHint(platform: Platform): string;
  /** Hint shown when a version was detected but does not satisfy isCompatible(). */
  incompatibleHint(detected: string): string;
}

/** How to run the short-lived init/sync/status CLI + parse its output. */
export interface CliMap {
  initArgs(opts: { languageTier?: string }): string[];
  syncArgs(paths: string[]): string[];
  statusArgs: string[];
  parseSync(output: string): number;
  parseStatus(stdout: string): StatusResult;
}

// ── Backend seam ────────────────────────────────────────────────────

/**
 * A single MCP call plan: which tool to invoke, which params to send, and
 * how to narrow the raw JSON payload into a shared, typed value.
 *
 * `narrow` must be pure (no I/O, no sandbox filtering) — GraphClient applies
 * the sandbox post-filter (keepNode) AFTER calling narrow(), because that
 * filter needs `projectRoot` + `incidents`, which the backend does not have.
 */
export interface CallPlan<T> {
  tool: string;
  params: unknown;
  narrow: (raw: unknown) => T;
}

/**
 * Per-backend tool catalog + param builders + response-shape adapters.
 *
 * GraphClient is injected with a concrete GraphBackend at construction and
 * delegates every tool-name/params/narrow decision to it, while keeping all
 * cross-cutting concerns (sandbox, staleness, health short-circuits,
 * fallback, prefetch dispatch) itself.
 */
export interface GraphBackend {
  /** Engine identifier, e.g. "tokensave". */
  readonly id: string;

  searchPlan(q: string, opts?: SearchOpts): CallPlan<SearchHit[]>;
  queryPlan(pattern: QueryPattern, target: NodeRef): CallPlan<NodeRef[]>;
  impactPlan(target: NodeRef | string): CallPlan<ImpactReport>;
  reviewContextPlan(nodes: NodeRef[]): CallPlan<string>;
  overviewPlan(): CallPlan<string>;
  changesPlan(since?: string): CallPlan<NodeRef[]>;

  /** How to spawn the backend's long-lived MCP server (binary + serve args). */
  processSpec(): ProcessSpec;
  /** How to detect + version-gate the backend binary. */
  prereqSpec(): PrereqSpec;
  /** How to run + parse the backend's short-lived init/sync/status CLI. */
  cliMap(): CliMap;
}
