// tests/orchestrator/fixtures/fake-obs-mcp.mjs — minimal MCP server for Sprint 16 tests.
//
// Environment variables (set by tests via mcpEnv):
//   FAKE_MCP_NAME      — server name (default: "fake")
//   FAKE_MCP_TOOLS     — comma-separated tool names (default: "query")
//   FAKE_MCP_CRASH     — if "1", exit(1) immediately before connecting
//   FAKE_MCP_IGNORE_SIGTERM — if "1", swallow SIGTERM (force SIGKILL test)

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const NAME = process.env.FAKE_MCP_NAME ?? "fake";
const TOOLS = (process.env.FAKE_MCP_TOOLS ?? "query").split(",").map((n) => ({
  name: n.trim(),
  description: `fake tool ${n.trim()}`,
  inputSchema: { type: "object", properties: {} },
}));

// Crash-on-start flag — for failure-isolation tests.
if (process.env.FAKE_MCP_CRASH === "1") {
  process.stderr.write(`[fake-obs-mcp:${NAME}] crashing intentionally (FAKE_MCP_CRASH=1)\n`);
  process.exit(1);
}

// SIGTERM ignore flag — for SIGKILL grace-period tests.
if (process.env.FAKE_MCP_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {
    process.stderr.write(`[fake-obs-mcp:${NAME}] ignoring SIGTERM (FAKE_MCP_IGNORE_SIGTERM=1)\n`);
    // Do not exit — force the SIGKILL fallback.
  });
}

const server = new Server(
  { name: NAME, version: "0.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({ tool: req.params.name, args: req.params.arguments ?? {} }),
    },
  ],
}));

await server.connect(new StdioServerTransport());
