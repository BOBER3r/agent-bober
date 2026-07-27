/**
 * CodeReviewGraphBackend — GraphBackend implementation for the
 * `code-review-graph` engine.
 *
 * Registered so backend auto-detection (Sprint 3) can select it when
 * tokensave is not installed but code-review-graph is. The 6 response
 * *Plan adapters are NOT implemented yet — they throw a clear "not
 * implemented until Sprints 4-6" error (Sprints 5-6 consume the fixtures
 * captured this sprint under tests/graph/fixtures/cr-graph/). `id`,
 * `processSpec()`, `prereqSpec()`, and `cliMap()` are real as of this
 * sprint (Sprint 4): enough to be selectable, prereq-checkable, and to
 * run init/sync/status against the real `code-review-graph` CLI.
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

export class CodeReviewGraphBackend implements GraphBackend {
  readonly id = "code-review-graph";

  searchPlan(_q: string, _opts?: SearchOpts): CallPlan<SearchHit[]> {
    throw new Error(NOT_IMPL);
  }

  queryPlan(_pattern: QueryPattern, _target: NodeRef): CallPlan<NodeRef[]> {
    throw new Error(NOT_IMPL);
  }

  impactPlan(_target: NodeRef | string): CallPlan<ImpactReport> {
    throw new Error(NOT_IMPL);
  }

  reviewContextPlan(_nodes: NodeRef[]): CallPlan<string> {
    throw new Error(NOT_IMPL);
  }

  overviewPlan(): CallPlan<string> {
    throw new Error(NOT_IMPL);
  }

  changesPlan(_since?: string): CallPlan<NodeRef[]> {
    throw new Error(NOT_IMPL);
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
