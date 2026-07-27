/**
 * CodeReviewGraphBackend — GraphBackend implementation for the
 * `code-review-graph` engine.
 *
 * Registered so backend auto-detection (Sprint 3) can select it when
 * tokensave is not installed but code-review-graph is. As of Sprint 5,
 * 5 of the 6 response *Plan adapters are real (search/impact/reviewContext/
 * overview/changes), validated against the live fixtures captured in
 * Sprint 4 under tests/graph/fixtures/cr-graph/. `queryPlan` (the 4 query
 * sub-patterns: callers/callees/imports/tests) is still NOT implemented —
 * that is Sprint 6. `id`, `processSpec()`, `prereqSpec()`, and `cliMap()`
 * are real as of Sprint 4: enough to be selectable, prereq-checkable, and
 * to run init/sync/status against the real `code-review-graph` CLI.
 */

import type { ImpactReport, NodeRef, SearchHit, StatusResult } from "../types.js";
import type {
  CallPlan,
  CliMap,
  GraphBackend,
  Platform,
  PrereqSpec,
  ProcessSpec,
  QueryPattern,
  SearchOpts,
} from "./types.js";

const NOT_IMPL =
  "code-review-graph adapter not implemented until Sprints 4-6";

/** code-review-graph install hint. Verbatim — pip is the documented install path. */
function codeReviewGraphInstallHint(_platform: Platform): string {
  return "pip install code-review-graph";
}

/**
 * Parse the number of files touched by `code-review-graph build`/`update`.
 *
 * code-review-graph 2.3.7 prints a single plain-text summary line (no ANSI
 * colour, confirmed live — see sprint-4 briefing §7-8) in one of two shapes:
 *   Full build:   "Full build: 2 files, 8 nodes, 15 edges (postprocess=full)"
 *   Incremental:  "Incremental: 1 files updated, 4 nodes, 9 edges (postprocess=full)"
 * A single regex captures the leading file count in both shapes. `-q/--quiet`
 * prints nothing at all — the CLI map never passes `-q` on the sync/init path.
 */
function parseCrGraphSyncOutput(output: string): number {
  // Strip ANSI escape sequences defensively, mirroring tokensave's parser —
  // cr-graph output is plain in this environment, but stay defensive in case
  // a future version colourizes it.
  // eslint-disable-next-line no-control-regex
  const trimmed = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").trim();
  if (!trimmed) return 0;

  const files = /(\d+)\s+files?\b/.exec(trimmed);
  if (files) return parseInt(files[1], 10);

  return 0;
}

/**
 * Parse `code-review-graph status --json` stdout into the shared
 * StatusResult shape.
 *
 * cr-graph 2.3.7 `status --json` returns a single machine-readable object
 * keyed `{nodes, edges, files, languages, last_updated, vcs, ...}` (NOT
 * tokensave's `node_count`/`edge_count`/`file_count`, and no version field —
 * see sprint-4 briefing §2/§7 for the real captured shape).
 */
function parseCrGraphStatusOutput(stdout: string): StatusResult {
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  const files = typeof parsed.files === "number" ? parsed.files : 0;
  const ready = typeof parsed.files === "number" || typeof parsed.nodes === "number";
  return {
    ready,
    indexedFileCount: files,
    // cr-graph `status --json` carries no version field — unlike tokensave's
    // legacy {tokensaveVersion} shape, there is nothing to surface here.
    tokensaveVersion: "",
  };
}

// ── cr-graph node row shape + kind coercion (Sprint 5) ──────────────
//
// Every cr-graph fixture (semantic_search_nodes_tool, get_impact_radius_tool,
// get_review_context_tool, detect_changes_tool) shares the same node-row
// shape, with DIFFERENT field names than tokensave's Ts*Row types:
//   qualified_name -> NodeRef.id, name -> NodeRef.symbol, file_path ->
//   NodeRef.file, line_start -> NodeRef.line, capitalized kind
//   ("Function"|"Class"|"File") -> coerced NodeRef.kind. Factored once here
// so Sprint 6's queryPlan can reuse it (see tests/graph/fixtures/cr-graph/*.json).

/** Valid NodeRef.kind values; cr-graph's "File" kind maps to "module"
 *  (mirrors how tokensave treats file-level nodes). Unknown -> "symbol". */
const CR_NODE_KINDS = new Set<string>(["function", "class", "module", "symbol"]);

/** Coerce cr-graph's capitalized Kind ("Function"|"Class"|"File") to NodeRef.kind. */
function crKind(kind: string | undefined): NodeRef["kind"] {
  const k = (kind ?? "").toLowerCase();
  if (k === "file") return "module";
  return CR_NODE_KINDS.has(k) ? (k as NodeRef["kind"]) : "symbol";
}

/** Raw cr-graph node row shape shared by search results, impact/changes nodes,
 *  and reviewContext's graph.changed_nodes/impacted_nodes. `id` is a NUMBER in
 *  cr-graph (search rows omit it entirely) — NodeRef.id is a string, so we
 *  prefer the stable `qualified_name` and only fall back to `String(id)`. */
type CrNodeRow = {
  id?: number | string;
  name: string;
  qualified_name?: string;
  file_path: string;
  line_start?: number;
  kind?: string;
  is_test?: boolean;
};

/** cr-graph field -> NodeRef field: qualified_name -> id, name -> symbol,
 *  file_path -> file, line_start -> line (line_end is ignored), kind (coerced). */
function crToNodeRef(row: CrNodeRow): NodeRef {
  return {
    id: row.qualified_name ?? String(row.id ?? ""),
    kind: crKind(row.kind),
    file: row.file_path,
    line: row.line_start ?? 0,
    symbol: row.name,
  };
}

/** search-result row: shares the CrNodeRow shape plus `score`/`signature`. */
type CrSearchRow = CrNodeRow & { score?: number; signature?: string };

/** Partition an impacted-node row into test vs non-test: prefer cr-graph's
 *  explicit `is_test` boolean; fall back to the /test|spec/i path heuristic
 *  (same heuristic tokensave-backend.ts uses) when `is_test` is absent. */
function isTestRow(row: CrNodeRow): boolean {
  return typeof row.is_test === "boolean" ? row.is_test : /test|spec/i.test(row.file_path);
}

export class CodeReviewGraphBackend implements GraphBackend {
  readonly id = "code-review-graph";

  searchPlan(q: string, opts?: SearchOpts): CallPlan<SearchHit[]> {
    return {
      tool: "semantic_search_nodes_tool",
      params: { query: q, ...(opts?.limit !== undefined ? { limit: opts.limit } : {}) },
      narrow: (raw) => {
        const rows = (raw as { results?: CrSearchRow[] }).results ?? [];
        const hits: SearchHit[] = rows.map((row) => ({
          node: crToNodeRef(row),
          score: typeof row.score === "number" ? row.score : 0,
          snippet: row.signature ?? "",
        }));
        // Post-filter by kind if requested, mirroring tokensave's searchPlan
        // (semantic_search_nodes_tool has no kind param of its own).
        return opts?.kind ? hits.filter((h) => h.node.kind === opts.kind) : hits;
      },
    };
  }

  queryPlan(_pattern: QueryPattern, _target: NodeRef): CallPlan<NodeRef[]> {
    throw new Error(NOT_IMPL);
  }

  impactPlan(target: NodeRef | string): CallPlan<ImpactReport> {
    // cr-graph's get_impact_radius_tool takes file paths, not node ids
    // (_args.json: {changed_files: ["src/math_utils.py"]}). A string target
    // may be a qualified_name ("<file>::<symbol>"); take the file portion.
    const file = typeof target === "string" ? (target.split("::")[0] ?? target) : target.file;
    return {
      tool: "get_impact_radius_tool",
      params: { changed_files: [file] },
      narrow: (raw) => {
        const payload = raw as { changed_nodes?: CrNodeRow[]; impacted_nodes?: CrNodeRow[] };
        const changed = (payload.changed_nodes ?? []).map(crToNodeRef);
        const root =
          changed[0] ??
          crToNodeRef({
            name: typeof target === "string" ? target : target.symbol,
            qualified_name: file,
            file_path: file,
            line_start: 0,
            kind: "File",
          });
        const impacted = payload.impacted_nodes ?? [];
        return {
          root,
          affected: impacted.filter((row) => !isTestRow(row)).map(crToNodeRef),
          testsAffected: impacted.filter((row) => isTestRow(row)).map(crToNodeRef),
        };
      },
    };
  }

  reviewContextPlan(nodes: NodeRef[]): CallPlan<string> {
    // cr-graph's get_review_context_tool takes changed file paths, not a
    // joined symbol list (_args.json: {changed_files: ["src/main.py"]}).
    // NOTE: GraphClient.reviewContext() calls runRaw(), which bypasses this
    // narrow entirely (client.ts:91-94) — it is only exercised by unit tests.
    return {
      tool: "get_review_context_tool",
      params: { changed_files: [...new Set(nodes.map((n) => n.file))] },
      narrow: (raw) => (typeof raw === "string" ? raw : JSON.stringify(raw)),
    };
  }

  overviewPlan(): CallPlan<string> {
    return {
      tool: "get_architecture_overview_tool",
      params: {},
      narrow: (raw) => {
        // get_architecture_overview_tool returns a JSON object (communities,
        // cross_community_edges, warnings); stringify for the string-typed
        // caller, mirroring how tokensave overview stringifies module_api.
        return typeof raw === "string" ? raw : JSON.stringify(raw);
      },
    };
  }

  changesPlan(since?: string): CallPlan<NodeRef[]> {
    return {
      tool: "detect_changes_tool",
      params: { base: since ?? "HEAD~1" },
      narrow: (raw) => (raw as { changed_functions?: CrNodeRow[] }).changed_functions?.map(crToNodeRef) ?? [],
    };
  }

  // ── Process / prereq / CLI specs ────────────────────────────────────

  processSpec(): ProcessSpec {
    return { binary: "code-review-graph", serveArgs: ["serve"] };
  }

  prereqSpec(): PrereqSpec {
    return {
      versionArgs: ["--version"],
      // bober: accept-any version for now — code-review-graph has no
      // published compatibility range yet. Tighten this once the adapter
      // (Sprints 4-6) pins a supported version range, mirroring
      // TOKENSAVE_VERSION_RANGE in tokensave-backend.ts.
      isCompatible: (_version: string) => true,
      installHint: (platform) => codeReviewGraphInstallHint(platform),
      incompatibleHint: (detected) =>
        `code-review-graph ${detected} version gate is a TODO (Sprints 4-6)`,
    };
  }

  cliMap(): CliMap {
    return {
      // cr-graph `build` has no --tier flag; languageTier is a bober-level
      // manifest concept only (not forwarded to the binary), same as tokensave.
      initArgs: (_opts) => ["build"],
      // bober: cr-graph's `update` verb is git-diff-base driven (--base
      // HEAD~1 by default), NOT a positional-path receiver like tokensave's
      // `sync <path>...`. Forwarding the generic CliMap's `paths` here
      // mirrors the shared interface shape (sc-4-3) but cr-graph will reject
      // unrecognized positional argv if paths are ever non-empty in
      // practice. Reconciling the generic sync(paths) call site with
      // cr-graph's diff-based incremental model is deferred to whichever
      // sprint wires cr-graph into the live `graph sync` CLI path (out of
      // scope here — Sprint 4 covers the backend/adapter surface only).
      syncArgs: (paths) => ["update", ...paths],
      statusArgs: ["status", "--json"],
      parseSync: (out) => parseCrGraphSyncOutput(out),
      parseStatus: (stdout) => parseCrGraphStatusOutput(stdout),
    };
  }
}
