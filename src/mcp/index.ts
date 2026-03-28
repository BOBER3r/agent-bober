// ── MCP barrel exports ──────────────────────────────────────────────

export { createBoberMCPServer } from "./server.js";
export {
  registerTool,
  getAllTools,
  getTool,
  registerAllTools,
} from "./tools/index.js";
export type {
  BoberToolDefinition,
  JsonSchemaObject,
  JsonSchemaProperty,
} from "./tools/index.js";
