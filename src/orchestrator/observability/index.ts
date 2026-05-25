/**
 * Observability MCP plugin slot barrel (Sprint 16).
 *
 * Exports the public API for starting and merging observability MCP server
 * tool lists into the diagnoser's tool set at spawn time.
 *
 * Sprint 24 (/bober-incident) will import these symbols at the diagnoser
 * spawn site in src/incident/orchestrator.ts.
 */

export {
  mergeObsTools,
  stopAll,
  namespaceToolName,
  type ToolDescriptor,
  type NamespacedTool,
  type MergeResult,
} from "./merge.js";

export { ExternalMcpServer } from "../../mcp/external-client.js";
