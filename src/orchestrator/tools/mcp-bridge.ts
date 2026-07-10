/**
 * Opt-in MCP tool bridge (agent-loop-capability-port sprint 10).
 *
 * Exposes a single configured MCP server's tools as provider-agnostic
 * `ToolDef`s the agentic loop can call directly, alongside its own tool set.
 * Reuses the repo's existing SDK-based MCP client path (`src/mcp/external-client.ts`'s
 * `ExternalMcpServer` — spawn `{command,args}` -> `listTools` -> `callTool` ->
 * `stop`) rather than hand-rolling JSON-RPC: the SDK `Client` +
 * `StdioClientTransport` perform the initialize/tools-list/tools-call
 * handshake internally.
 *
 * Disabled by default: nothing in this module runs unless a caller
 * explicitly invokes `createMcpToolBridge` — and callers must only do so
 * after confirming `config.tools?.mcpBridge?.enabled === true` at the CALL
 * SITE, never at config parse time (see `config/schema.ts`
 * `ToolsSectionSchema`). This keeps `runAgenticLoop` itself hermetic (the
 * loop never owns MCP lifecycle) and preserves the hermetic claude-code /
 * fleet child paths (nonGoal #2 — this module is never wired there).
 *
 * Bridged tools are NEVER marked `readOnly` (unknown upstream side effects
 * => serial execution per ADR-2, nonGoal #3) and are namespaced with an
 * `mcp__` prefix so they never collide with the loop's own filesystem/bash
 * tools (Pattern E).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolDef } from "../../providers/types.js";
import type { ToolHandler } from "./handlers.js";

// ── Injectable client interface (Pattern C — mirrors McpServerLike) ───

/**
 * Minimal MCP-client interface satisfied by the real SDK client AND test
 * stubs. Mirrors `McpServerLike` (src/vault/mcp-adapter.ts:31-37) so tests
 * never spawn a real process or import the SDK.
 */
export interface McpBridgeClientLike {
  start(): Promise<void>;
  listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>>;
  callTool(name: string, args: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/** Namespace prefix for bridged tool names (Pattern E). */
const MCP_TOOL_PREFIX = "mcp__";

// ── Default (real) SDK-backed client ──────────────────────────────────

/** Wraps the real `@modelcontextprotocol/sdk` client behind `McpBridgeClientLike`. */
class SdkMcpBridgeClient implements McpBridgeClientLike {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  constructor(private readonly server: { command: string; args: string[] }) {}

  async start(): Promise<void> {
    if (this.client) return; // idempotent
    this.transport = new StdioClientTransport({
      command: this.server.command,
      args: this.server.args,
      env: { ...(process.env as Record<string, string>) },
      stderr: "pipe",
    });
    this.client = new Client(
      { name: "agent-bober-mcp-bridge", version: "0.13.0" },
      { capabilities: {} },
    );
    await this.client.connect(this.transport);
  }

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    if (!this.client) throw new Error("SdkMcpBridgeClient: not started");
    const res = await this.client.listTools();
    return res.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    if (!this.client) throw new Error("SdkMcpBridgeClient: not started");
    return await this.client.callTool({
      name,
      arguments: (args as Record<string, unknown>) ?? {},
    });
  }

  async close(): Promise<void> {
    const clientRef = this.client;
    this.client = null;
    this.transport = null;
    if (!clientRef) return;
    await clientRef.close().catch(() => { /* ignore close errors */ });
  }
}

// ── Result unwrap (Pattern D) ──────────────────────────────────────────

/**
 * Unwrap an SDK `callTool` result. The MCP SDK returns
 * `{ content: [{type:'text', text}], isError }`. Some servers put a
 * staleness/warning line first, so join ALL `type:'text'` entries rather
 * than assuming the payload is `content[0]`.
 */
function unwrapCallToolResult(raw: unknown): { output: string; isError: boolean } {
  const candidate = raw as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  const text = (candidate?.content ?? [])
    .filter((c) => c?.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  return { output: text, isError: candidate?.isError === true };
}

// ── Bridge ─────────────────────────────────────────────────────────────

export interface McpToolBridge {
  tools: ToolDef[];
  handlers: Map<string, ToolHandler>;
  close(): Promise<void>;
}

export interface CreateMcpToolBridgeOpts {
  /** Injected for tests so no real process is ever spawned. Defaults to the real SDK client. */
  clientFactory?: (server: { command: string; args: string[] }) => McpBridgeClientLike;
}

/**
 * Start a configured MCP server, list its tools, and expose them as
 * `mcp__`-prefixed `ToolDef`s + `ToolHandler`s a caller can merge into a
 * loop's own tool set. Callers own the bridge's lifetime — construct ONLY
 * when `config.tools?.mcpBridge?.enabled === true` at the call site, and
 * close it (directly, or via `runWithMcpBridge`) when done.
 */
export async function createMcpToolBridge(
  server: { command: string; args?: string[] },
  opts: CreateMcpToolBridgeOpts = {},
): Promise<McpToolBridge> {
  const args = server.args ?? [];
  const client = (opts.clientFactory ?? ((s) => new SdkMcpBridgeClient(s)))({
    command: server.command,
    args,
  });

  await client.start();
  const descriptors = await client.listTools();

  const tools: ToolDef[] = [];
  const handlers = new Map<string, ToolHandler>();

  for (const d of descriptors) {
    const prefixedName = `${MCP_TOOL_PREFIX}${d.name}`;
    // NOT readOnly — unknown upstream side effects stay serial (ADR-2, nonGoal #3).
    tools.push({
      name: prefixedName,
      description: d.description ?? `Bridged MCP tool '${d.name}'.`,
      input_schema:
        (d.inputSchema as ToolDef["input_schema"] | undefined) ??
        ({ type: "object" as const, properties: {} } satisfies ToolDef["input_schema"]),
    });
    handlers.set(prefixedName, async (input: Record<string, unknown>) => {
      try {
        // Call the ORIGINAL upstream name — the prefix exists only for the
        // loop's own tool list (Pattern E), never sent to the MCP server.
        const raw = await client.callTool(d.name, input);
        return unwrapCallToolResult(raw);
      } catch (err) {
        return { output: err instanceof Error ? err.message : String(err), isError: true };
      }
    });
  }

  return {
    tools,
    handlers,
    close: () => client.close(),
  };
}

/**
 * Run `fn` with the bridge's tools available, closing the underlying MCP
 * connection in a `finally` regardless of how `fn` resolves/rejects. Keeps
 * `runAgenticLoop` itself hermetic — the loop never owns MCP lifecycle; a
 * consumer builds the bridge, merges its tools into the loop's params, runs
 * the loop inside `fn`, and this helper guarantees `close()` at loop end
 * (design decision (d) in the sprint 10 briefing). `runAgenticLoop` resolves
 * exactly once (its `finish()` single exit), so this `finally` always fires
 * after the loop is truly done.
 */
export async function runWithMcpBridge<T>(
  bridge: McpToolBridge,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } finally {
    await bridge.close();
  }
}
