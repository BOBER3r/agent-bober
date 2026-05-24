import type { FallbackHint, GraphFailureReason } from "./types.js";
import { assertNever } from "./types.js";

export type FallbackMode = "gated" | "dual";

/**
 * Maps a GraphFailureReason to a user-facing FallbackHint.
 * The hint tells the agent which non-graph tools to fall back to and
 * whether retrying is worthwhile.
 */
export class GraphFallback {
  constructor(private readonly mode: FallbackMode = "dual") {}

  hint(reason: GraphFailureReason, detail?: string): FallbackHint {
    switch (reason) {
      case "GRAPH_DISABLED":
        return {
          message:
            "Graph integration is disabled. Use filesystem tools instead." +
            (detail ? ` (${detail})` : ""),
          suggestedTools: ["grep", "glob", "read_file"],
          retryable: false,
        };
      case "GRAPH_UNAVAILABLE":
        // In gated mode, grep/glob have been removed — only read_file remains.
        // In dual mode, all filesystem tools are still on the role's tool surface.
        return {
          message:
            "Graph engine is unavailable (subprocess down or breaker tripped)." +
            (detail ? ` (${detail})` : ""),
          suggestedTools:
            this.mode === "gated" ? ["read_file"] : ["grep", "glob", "read_file"],
          retryable: false,
        };
      case "GRAPH_STALE":
        return {
          message:
            "Graph index is stale. Results may be missing recent edits. " +
            "Run `agent-bober graph sync` to refresh." +
            (detail ? ` (${detail})` : ""),
          suggestedTools:
            this.mode === "gated" ? ["graph_search"] : ["graph_search", "grep"],
          retryable: true,
        };
      case "GRAPH_TIMEOUT":
        return {
          message:
            "Graph query timed out. Retry with a narrower query or fall back to filesystem search." +
            (detail ? ` (${detail})` : ""),
          suggestedTools:
            this.mode === "gated" ? ["read_file"] : ["grep", "read_file"],
          retryable: true,
        };
      case "GRAPH_ERROR":
        return {
          message:
            "Graph engine returned an error." +
            (detail ? ` (${detail})` : ""),
          suggestedTools:
            this.mode === "gated" ? ["read_file"] : ["grep", "glob", "read_file"],
          retryable: false,
        };
      default:
        return assertNever(reason);
    }
  }
}
