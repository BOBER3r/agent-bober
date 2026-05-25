// ── MCP Server ──────────────────────────────────────────────────────
//
// Creates and configures the agent-bober MCP server using
// @modelcontextprotocol/sdk with stdio transport.
//
// IMPORTANT: stdout is reserved for MCP JSON-RPC protocol messages.
// All diagnostic output must go to process.stderr.

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";

import { registerAllTools, getAllTools, getTool } from "./tools/index.js";
import { configExists, loadConfig } from "../config/loader.js";
import { runManager } from "./run-manager.js";

// ── Package version loader ──────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadVersion(): Promise<string> {
  try {
    // dist/mcp/ → up 2 levels to repo root
    const pkgPath = join(__dirname, "..", "..", "package.json");
    const raw = await readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ── Server factory ──────────────────────────────────────────────────

/**
 * Creates, configures, and connects the agent-bober MCP server.
 *
 * The server uses StdioServerTransport so it communicates over the
 * current process's stdin/stdout. Callers must NOT write anything to
 * stdout after this function is called — that channel belongs to the
 * MCP JSON-RPC protocol.
 *
 * @param projectRoot - Absolute path to the project being served.
 *   Passed to tool handlers so they can operate on the right directory.
 * @returns The connected Server instance.
 */
export async function createBoberMCPServer(
  projectRoot: string,
): Promise<Server> {
  const version = await loadVersion();

  // ── Register all tools before creating the server ────────────────
  registerAllTools();

  // ── Reconcile prior run state from disk (cockpit-integration sprint 1) ───
  try {
    await runManager.load(projectRoot);
  } catch (err) {
    process.stderr.write(
      `[agent-bober mcp] runManager.load failed (continuing): ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }

  // ── Conditionally register graph_* tools ─────────────────────────
  // Per sprint 4 spec: only when bober.config.json has
  // graph.enabled === true AND graph.exposeOnExternalMcp === true.
  // Failures here MUST NOT prevent server boot.
  try {
    if (await configExists(projectRoot)) {
      const config = await loadConfig(projectRoot);
      if (config.graph?.enabled && config.graph?.exposeOnExternalMcp !== false) {
        const { GraphFallback } = await import("../graph/fallback.js");
        const { GraphArtifactStore } = await import("../graph/artifact-store.js");
        const { IncidentLog } = await import("../graph/incidents.js");
        const { TokensaveMcpClient } = await import("../graph/mcp-client.js");
        const { GraphClient } = await import("../graph/client.js");
        const { registerGraphTools } = await import("./tools/graph.js");

        const cfg = config.graph;
        const store = new GraphArtifactStore(projectRoot);
        const incidents = new IncidentLog(projectRoot);
        const mcpClient = new TokensaveMcpClient(
          projectRoot,
          cfg,
          incidents,
          cfg.tokensavePath ?? "tokensave",
        );
        const graphFallback = new GraphFallback("dual");
        const client = new GraphClient(
          projectRoot,
          mcpClient,
          store,
          graphFallback,
          incidents,
          cfg,
        );
        registerGraphTools({ client, fallback: graphFallback });
      }
    }
  } catch (err) {
    process.stderr.write(
      `[agent-bober mcp] graph tool registration skipped: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }

  // ── Create the server ────────────────────────────────────────────
  const server = new Server(
    {
      name: "agent-bober",
      version,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // ── tools/list handler ───────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, () => {
    const tools = getAllTools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    return { tools };
  });

  // ── tools/call handler ───────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = getTool(name);

    if (!tool) {
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Tool not found: ${name}`,
      );
    }

    try {
      const result = await tool.handler(
        (args as Record<string, unknown>) ?? {},
      );
      return {
        content: [
          {
            type: "text" as const,
            text: result,
          },
        ],
      };
    } catch (err: unknown) {
      // Re-throw McpError as-is so the client gets the intended error code/message
      if (err instanceof McpError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${message}`);
    }
  });

  // ── Connect stdio transport ───────────────────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `[agent-bober mcp] Server v${version} started (project: ${projectRoot})\n`,
  );

  // ── Graceful shutdown ────────────────────────────────────────────
  const shutdown = (): void => {
    process.stderr.write("[agent-bober mcp] Shutting down...\n");
    server.close().catch(() => {
      // Ignore close errors during shutdown
    });
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server;
}
