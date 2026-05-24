// ── graph_* MCP tools ─────────────────────────────────────────────────
//
// Single factory for the 6 graph_* tools consumed by both:
//   - src/mcp/server.ts (external MCP registration)
//   - src/orchestrator/tools/index.ts via getGraphInternalTools (sprint 5)
//
// DRY: ONE factory (createGraphTools), ONE set of handler closures.

import type { BoberToolDefinition } from "./registry.js";
import { registerTool } from "./registry.js";
import type { GraphClient } from "../../graph/client.js";
import type { GraphFallback } from "../../graph/fallback.js";
import type { SearchHit, NodeRef, ImpactReport } from "../../graph/types.js";
import { MAX_OUTPUT_CHARS } from "../../orchestrator/tools/handlers.js";
import {
  GraphSearchInputSchema,
  GraphQueryInputSchema,
  GraphImpactInputSchema,
  GraphReviewContextInputSchema,
  GraphOverviewInputSchema,
  GraphChangesInputSchema,
} from "./graph-schemas.js";

// ── Deps interface ───────────────────────────────────────────────────

export interface GraphToolDeps {
  client: GraphClient;
  fallback: GraphFallback;
}

// ── Truncation helper ────────────────────────────────────────────────
// NOTE: handlers.ts truncate() produces final length > MAX_OUTPUT_CHARS.
// This helper guarantees EXACTLY MAX_OUTPUT_CHARS when truncation occurs.

const TRUNCATION_MARKER = "...[truncated due to MAX_OUTPUT_CHARS]";

function truncateForGraph(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return s.slice(0, MAX_OUTPUT_CHARS - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

// ── Output formatters ────────────────────────────────────────────────

function formatSearchHits(hits: SearchHit[]): string {
  return hits
    .map(
      (h) =>
        `${h.node.file}:${h.node.line} — ${h.node.symbol} — ${h.snippet.trim()} — score=${h.score.toFixed(3)}`,
    )
    .join("\n");
}

function formatNodeRefList(nodes: NodeRef[]): string {
  return nodes
    .map((n) => `- \`${n.symbol}\` (${n.kind}) — ${n.file}:${n.line}`)
    .join("\n");
}

function formatImpactReport(r: ImpactReport): string {
  return [
    `## Impact analysis`,
    `**Root:** \`${r.root.symbol}\` — ${r.root.file}:${r.root.line}`,
    ``,
    `### Affected (${r.affected.length})`,
    formatNodeRefList(r.affected) || "_none_",
    ``,
    `### Tests affected (${r.testsAffected.length})`,
    formatNodeRefList(r.testsAffected) || "_none_",
  ].join("\n");
}

// ── Factory ──────────────────────────────────────────────────────────

/**
 * Single source of truth — returns 6 BoberToolDefinitions.
 * Consumed by registerGraphTools (external MCP) and getGraphInternalTools
 * (internal orchestrator, sprint 5).
 */
export function createGraphTools(deps: GraphToolDeps): BoberToolDefinition[] {
  const { client, fallback } = deps;

  return [
    // ── graph_search ─────────────────────────────────────────────
    {
      name: "graph_search",
      description:
        "Semantic + keyword search of the project's code graph. Returns ranked symbol " +
        "matches with file:line and a code snippet. Prefer this over grep when looking " +
        "for functions, classes, or concepts by name or meaning. " +
        "Args: query (string), limit (number, default 20).",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query — symbol name, keyword, or natural-language concept.",
          },
          limit: {
            type: "number",
            description: "Max results to return (1–100, default 20).",
            default: 20,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      handler: async (args: Record<string, unknown>): Promise<string> => {
        const parsed = GraphSearchInputSchema.safeParse(args);
        if (!parsed.success) {
          return JSON.stringify({ error: "Invalid input: " + parsed.error.message });
        }
        const r = await client.search(parsed.data.query, { limit: parsed.data.limit });
        if (!r.ok) {
          return fallback.hint(r.reason, r.detail).message;
        }
        return truncateForGraph(formatSearchHits(r.data));
      },
    },

    // ── graph_query ──────────────────────────────────────────────
    {
      name: "graph_query",
      description:
        "Traverse the code graph by relationship. patterns: 'callers_of' (who calls this), " +
        "'callees_of' (what this calls), 'imports_of' (who imports this), " +
        "'tests_for' (which tests cover this). " +
        "Args: pattern (enum), target (symbol-or-file:line string). " +
        "Prefer this over grep for callers/callees/imports — much more precise.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            enum: ["callers_of", "callees_of", "imports_of", "tests_for"],
            description: "Relationship to traverse.",
          },
          target: {
            type: "string",
            description: "Target symbol or file:line string (e.g. 'myFunction' or 'src/foo.ts:42').",
          },
        },
        required: ["pattern", "target"],
        additionalProperties: false,
      },
      handler: async (args: Record<string, unknown>): Promise<string> => {
        const parsed = GraphQueryInputSchema.safeParse(args);
        if (!parsed.success) {
          return JSON.stringify({ error: "Invalid input: " + parsed.error.message });
        }
        const targetStr = parsed.data.target;
        const targetNode: NodeRef = {
          id: targetStr,
          kind: "symbol",
          file: targetStr.includes(":") ? targetStr.split(":")[0]! : targetStr,
          line: 0,
          symbol: targetStr,
        };
        const r = await client.query(parsed.data.pattern, targetNode);
        if (!r.ok) {
          return fallback.hint(r.reason, r.detail).message;
        }
        return truncateForGraph(formatNodeRefList(r.data));
      },
    },

    // ── graph_impact ─────────────────────────────────────────────
    {
      name: "graph_impact",
      description:
        "Compute the blast radius of changing a symbol or file. Returns the root, " +
        "affected nodes, and affected tests. Use BEFORE editing any function/class/file " +
        "that may be widely called. Args: target (string).",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "Symbol or file path to analyse impact for.",
          },
        },
        required: ["target"],
        additionalProperties: false,
      },
      handler: async (args: Record<string, unknown>): Promise<string> => {
        const parsed = GraphImpactInputSchema.safeParse(args);
        if (!parsed.success) {
          return JSON.stringify({ error: "Invalid input: " + parsed.error.message });
        }
        const r = await client.impact(parsed.data.target);
        if (!r.ok) {
          return fallback.hint(r.reason, r.detail).message;
        }
        return truncateForGraph(formatImpactReport(r.data));
      },
    },

    // ── graph_review_context ─────────────────────────────────────
    {
      name: "graph_review_context",
      description:
        "Retrieve source snippets for a set of nodes for code-review context — " +
        "token-efficient, returns only the relevant lines. Args: nodes (NodeRef[]).",
      inputSchema: {
        type: "object",
        properties: {
          nodes: {
            type: "array",
            description: "Array of NodeRef objects to retrieve source context for.",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                kind: {
                  type: "string",
                  enum: ["function", "class", "module", "symbol"],
                },
                file: { type: "string" },
                line: { type: "number" },
                symbol: { type: "string" },
              },
              required: ["id", "kind", "file", "line", "symbol"],
            },
            minItems: 1,
          },
        },
        required: ["nodes"],
        additionalProperties: false,
      },
      handler: async (args: Record<string, unknown>): Promise<string> => {
        const parsed = GraphReviewContextInputSchema.safeParse(args);
        if (!parsed.success) {
          return JSON.stringify({ error: "Invalid input: " + parsed.error.message });
        }
        const r = await client.reviewContext(parsed.data.nodes);
        if (!r.ok) {
          return fallback.hint(r.reason, r.detail).message;
        }
        return truncateForGraph(r.data);
      },
    },

    // ── graph_overview ────────────────────────────────────────────
    {
      name: "graph_overview",
      description:
        "High-level architecture overview of the codebase: modules, communities, " +
        "top-level structure. Use at the start of exploring an unfamiliar repo. No args.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      handler: async (args: Record<string, unknown>): Promise<string> => {
        const parsed = GraphOverviewInputSchema.safeParse(args);
        if (!parsed.success) {
          return JSON.stringify({ error: "Invalid input: " + parsed.error.message });
        }
        const r = await client.overview();
        if (!r.ok) {
          return fallback.hint(r.reason, r.detail).message;
        }
        return truncateForGraph(r.data);
      },
    },

    // ── graph_changes ─────────────────────────────────────────────
    {
      name: "graph_changes",
      description:
        "List nodes changed since a given commit/ref. Use for code review or impact triage. " +
        "Args: since (string, optional — defaults to last sync).",
      inputSchema: {
        type: "object",
        properties: {
          since: {
            type: "string",
            description: "Git ref or commit SHA to compare from (optional — defaults to last sync).",
          },
        },
        additionalProperties: false,
      },
      handler: async (args: Record<string, unknown>): Promise<string> => {
        const parsed = GraphChangesInputSchema.safeParse(args);
        if (!parsed.success) {
          return JSON.stringify({ error: "Invalid input: " + parsed.error.message });
        }
        const r = await client.changes(parsed.data.since);
        if (!r.ok) {
          return fallback.hint(r.reason, r.detail).message;
        }
        return truncateForGraph(formatNodeRefList(r.data));
      },
    },
  ];
}

/**
 * External-server registration: loops over createGraphTools and calls registerTool.
 * Called from src/mcp/server.ts when graph.enabled && graph.exposeOnExternalMcp.
 */
export function registerGraphTools(deps: GraphToolDeps): void {
  for (const tool of createGraphTools(deps)) {
    registerTool(tool);
  }
}
