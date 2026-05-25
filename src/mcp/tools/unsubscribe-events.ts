// ── bober_unsubscribe_events tool ────────────────────────────────────
//
// Unsubscribes the MCP client from a previously registered runId-scoped
// event subscription. Releases all file-watch handles for the subscription
// when no other subscription is watching the same file.
//
// Soft errors (subscription not found) return JSON { error: '...' }.
// Hard errors (missing/empty subscriptionId arg) throw McpError(InvalidRequest).

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { registerTool } from "./registry.js";
import { getEventStream } from "../event-stream.js";

// ── Registration ──────────────────────────────────────────────────────

export function registerUnsubscribeEventsTool(): void {
  registerTool({
    name: "bober_unsubscribe_events",
    description:
      "Unsubscribe from a runId-scoped event stream. " +
      "Releases file-watch handles when the subscription's files are no longer watched. " +
      "Returns { subscriptionId, status: 'unsubscribed' } on success. " +
      "Returns a soft-error JSON when the subscriptionId is not found.",
    inputSchema: {
      type: "object",
      properties: {
        subscriptionId: {
          type: "string",
          description: "The subscriptionId returned by bober_subscribe_events.",
        },
      },
      required: ["subscriptionId"],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const subscriptionId =
        typeof args.subscriptionId === "string" ? args.subscriptionId.trim() : "";
      if (!subscriptionId) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "subscriptionId is required and must be a non-empty string.",
        );
      }

      const mgr = getEventStream();
      const result = mgr.unsubscribe(subscriptionId);
      if (!result.ok) {
        return JSON.stringify(
          { error: `Subscription not found: ${subscriptionId}` },
          null,
          2,
        );
      }

      return JSON.stringify(
        { subscriptionId, status: "unsubscribed" },
        null,
        2,
      );
    },
  });
}
