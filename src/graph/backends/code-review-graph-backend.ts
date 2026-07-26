/**
 * CodeReviewGraphBackend — STUB GraphBackend implementation for the
 * `code-review-graph` engine.
 *
 * Registered so backend auto-detection (Sprint 3) can select it when
 * tokensave is not installed but code-review-graph is. The 6 *Plan adapters
 * and cliMap() are NOT implemented yet — they throw a clear "not implemented
 * until Sprints 4-6" error. Only `id`, `processSpec()`, and `prereqSpec()`
 * are real this sprint (enough to be selectable + prereq-checkable).
 */

import type { ImpactReport, NodeRef, SearchHit } from "../types.js";
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
    // TODO(Sprints 4-6): wire real init/sync/status argv + output parsers.
    throw new Error(NOT_IMPL);
  }
}
