// ── bober_subscribe_events tool ──────────────────────────────────────
//
// Subscribes the MCP client to runId-scoped events. The server begins
// emitting `bober/events` notifications whenever a matching line is
// appended to .bober/history.jsonl or .bober/telemetry/<date>.jsonl.
// On per-subscription queue overflow, a `bober/events.dropped` notification
// is sent and oldest events are evicted.

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { registerTool } from "./registry.js";
import { getEventStream } from "../event-stream.js";

// ── Registration ──────────────────────────────────────────────────────

export function registerSubscribeEventsTool(): void {
  registerTool({
    name: "bober_subscribe_events",
    description:
      "Subscribe to runId-scoped events streamed via MCP notifications. " +
      "Returns a subscriptionId; the server emits `bober/events` notifications " +
      "for matching lines appended to .bober/history.jsonl and .bober/telemetry/<date>.jsonl. " +
      "When the per-subscription queue overflows, a `bober/events.dropped` notification is " +
      "emitted with the count of dropped events.",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "The runId to filter events by.",
        },
        since: {
          type: "string",
          description:
            "ISO 8601 timestamp; only deliver events after this time. " +
            "Triggers a one-time backfill of pre-existing events on subscribe.",
        },
      },
      required: ["runId"],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const runId = typeof args.runId === "string" ? args.runId.trim() : "";
      if (!runId) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "runId is required and must be a non-empty string.",
        );
      }
      const since = typeof args.since === "string" ? args.since : undefined;

      const mgr = getEventStream();
      const result = await mgr.subscribe(runId, since !== undefined ? { since } : {});
      return JSON.stringify(result, null, 2);
    },
  });
}
