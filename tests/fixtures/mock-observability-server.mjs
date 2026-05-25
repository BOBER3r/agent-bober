/**
 * Mock observability MCP server for Sprint 27 four-mode integration tests.
 *
 * Implements the MCP spec over stdio using @modelcontextprotocol/sdk — a real
 * subprocess speaking the real MCP protocol. This is NOT a JS-function mock.
 * It is a separate process with its own process boundary, testing the actual
 * protocol framing and ExternalMcpServer/mergeObsTools plugin slot architecture.
 *
 * State control:
 *   The test scaffolding writes a JSON control file to MOCK_STATE_FILE (env var)
 *   or defaults to /tmp/mock-obs-server-state.json. The server reads this file
 *   on every tool call so tests can inject different states mid-run.
 *
 * Control file shape:
 *   {
 *     "errorRate": 0.05,      // current metric value for api.error_rate
 *     "latencyP99": 850,      // current metric value for api.latency.p99
 *     "phase": "bug-active"   // "bug-active" | "post-fix" — informational only
 *   }
 *
 * Tools:
 *   query_metric(metricName, windowMinutes) → { dataPoints: [{timestamp, value}] }
 *   query_logs(query, timeRange)            → { logs: [{id, timestamp, message, level}] }
 *   get_log_context(logId)                  → { id, timestamp, message, level, context }
 *
 * Sprint 27 — tests/fixtures/mock-observability-server.mjs
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFile } from "node:fs/promises";

const STATE_FILE = process.env["MOCK_STATE_FILE"] ?? "/tmp/mock-obs-server-state.json";

const DEFAULT_STATE = {
  errorRate: 0.0001,
  latencyP99: 120,
  phase: "post-fix",
};

async function readState() {
  try {
    const raw = await readFile(STATE_FILE, "utf-8");
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function generateDataPoints(metricValue, windowMinutes) {
  const now = Date.now();
  const points = [];
  const sampleCount = Math.min(windowMinutes, 10);
  for (let i = sampleCount - 1; i >= 0; i--) {
    points.push({
      timestamp: new Date(now - i * 60_000).toISOString(),
      value: metricValue,
    });
  }
  return points;
}

const TOOLS = [
  {
    name: "query_metric",
    description: "Query a metric time series from the mock observability provider",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Metric name (e.g. api.error_rate, api.latency.p99)",
        },
        timeRange: {
          type: "object",
          properties: {
            start: { type: "string" },
            end: { type: "string" },
          },
        },
        windowMinutes: {
          type: "number",
          description: "Number of minutes of data to return",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "query_logs",
    description: "Query logs from the mock observability provider",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Log search query",
        },
        timeRange: {
          type: "object",
          properties: {
            start: { type: "string" },
            end: { type: "string" },
          },
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_log_context",
    description: "Get detailed context for a specific log entry",
    inputSchema: {
      type: "object",
      properties: {
        logId: {
          type: "string",
          description: "Log entry ID",
        },
      },
      required: ["logId"],
    },
  },
];

const server = new Server(
  { name: "mock-observability", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const toolName = req.params.name;
  const args = req.params.arguments ?? {};

  process.stderr.write(`[mock-obs] tool=${toolName} args=${JSON.stringify(args)}\n`);

  const state = await readState();

  if (toolName === "query_metric") {
    const metricName = args["name"] ?? args["metricName"] ?? "unknown";
    const windowMinutes = args["windowMinutes"] ?? 10;

    let metricValue;
    if (String(metricName).includes("error_rate") || String(metricName).includes("error")) {
      metricValue = state.errorRate;
    } else if (String(metricName).includes("latency") || String(metricName).includes("p99")) {
      metricValue = state.latencyP99;
    } else {
      metricValue = state.errorRate;
    }

    const dataPoints = generateDataPoints(metricValue, Number(windowMinutes));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            metric: String(metricName),
            labels: { provider: "mock-obs", phase: state.phase },
            dataPoints,
          }),
        },
      ],
    };
  }

  if (toolName === "query_logs") {
    const query = args["query"] ?? "";
    const logs = [
      {
        id: "log-001",
        timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
        message: `Log entry matching query: ${query}. Error rate at ${state.errorRate}. Phase: ${state.phase}.`,
        level: state.errorRate > 0.01 ? "error" : "info",
      },
      {
        id: "log-002",
        timestamp: new Date(Date.now() - 3 * 60_000).toISOString(),
        message: `THRESHOLD configuration value affects metric behavior. Current phase: ${state.phase}.`,
        level: "warn",
      },
      {
        id: "log-003",
        timestamp: new Date(Date.now() - 1 * 60_000).toISOString(),
        message: `Service status: ${state.errorRate > 0.01 ? "degraded" : "healthy"}`,
        level: state.errorRate > 0.01 ? "error" : "info",
      },
    ];

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ logs }),
        },
      ],
    };
  }

  if (toolName === "get_log_context") {
    const logId = args["logId"] ?? "unknown";
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            id: String(logId),
            timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
            message: `Detailed context for ${logId}. Error rate: ${state.errorRate}. Phase: ${state.phase}.`,
            level: state.errorRate > 0.01 ? "error" : "info",
            context: {
              service: "api-gateway",
              threshold: state.errorRate > 0.01 ? "BREACHED" : "OK",
              errorRate: state.errorRate,
              phase: state.phase,
            },
          }),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: `Unknown tool: ${toolName}` }),
      },
    ],
    isError: true,
  };
});

await server.connect(new StdioServerTransport());
