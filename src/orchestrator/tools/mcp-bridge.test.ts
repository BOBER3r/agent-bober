/**
 * Unit tests for the opt-in MCP tool bridge (sprint 10: sc-10-5, plus the
 * bridge half of sc-10-4).
 *
 * Injects a recording stub satisfying `McpBridgeClientLike` so no real MCP
 * server process is ever spawned — mirrors the repo's `McpServerLike`
 * inject-for-tests idiom (src/vault/mcp-adapter.ts:31-37). sc-10-4's "disabled
 * by default => nothing spawned" half is covered by
 * `src/config/schema.test.ts`'s "tools section is optional" suite (the
 * config axis this module is gated behind) plus the structural fact that
 * `createMcpToolBridge` is the ONLY function in this module capable of
 * constructing a client — it is never invoked as an import-time side effect.
 */

import { describe, it, expect } from "vitest";
import { createMcpToolBridge, runWithMcpBridge, type McpBridgeClientLike } from "./mcp-bridge.js";

function makeStub(
  calls: string[],
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
): McpBridgeClientLike {
  return {
    async start() {
      calls.push("start");
    },
    async listTools() {
      calls.push("listTools");
      return tools;
    },
    async callTool(name: string, args: unknown) {
      calls.push(`callTool:${name}:${JSON.stringify(args)}`);
      return { content: [{ type: "text", text: "ok" }], isError: false };
    },
    async close() {
      calls.push("close");
    },
  };
}

describe("createMcpToolBridge", () => {
  it("sc-10-5: bridged tools appear mcp__-prefixed, are NOT readOnly, and a call round-trips to the ORIGINAL upstream name", async () => {
    const calls: string[] = [];
    const stub = makeStub(calls, [
      { name: "echo", description: "echoes", inputSchema: { type: "object", properties: {} } },
    ]);

    const bridge = await createMcpToolBridge({ command: "x", args: [] }, { clientFactory: () => stub });

    expect(calls).toEqual(["start", "listTools"]);
    expect(bridge.tools).toHaveLength(1);
    expect(bridge.tools[0].name).toBe("mcp__echo");
    expect(bridge.tools[0].description).toBe("echoes");
    // Unknown upstream side effects -> stays serial (ADR-2, nonGoal #3).
    expect(Object.hasOwn(bridge.tools[0], "readOnly")).toBe(false);

    const handler = bridge.handlers.get("mcp__echo");
    expect(handler).toBeDefined();
    const result = await handler!({ q: "hi" });

    expect(result).toEqual({ output: "ok", isError: false });
    // The handler calls the ORIGINAL upstream name — the mcp__ prefix is only
    // for the loop's own tool list (Pattern E), never sent to the MCP server.
    expect(calls).toContain('callTool:echo:{"q":"hi"}');

    await bridge.close();
    expect(calls[calls.length - 1]).toBe("close");
  });

  it("sc-10-5: falls back to a bare object-schema and a generated description when the descriptor omits them", async () => {
    const calls: string[] = [];
    const stub = makeStub(calls, [{ name: "bare" }]);

    const bridge = await createMcpToolBridge({ command: "x" }, { clientFactory: () => stub });

    expect(bridge.tools[0].name).toBe("mcp__bare");
    expect(bridge.tools[0].description).toContain("bare");
    expect(bridge.tools[0].input_schema).toEqual({ type: "object", properties: {} });
  });

  it("sc-10-5: runWithMcpBridge runs close() exactly once in a finally on a successful run", async () => {
    const calls: string[] = [];
    const stub = makeStub(calls, []);
    const bridge = await createMcpToolBridge({ command: "x" }, { clientFactory: () => stub });

    const result = await runWithMcpBridge(bridge, async () => "done");

    expect(result).toBe("done");
    expect(calls.filter((c) => c === "close")).toHaveLength(1);
  });

  it("sc-10-5: runWithMcpBridge runs close() exactly once in a finally even when the wrapped fn throws", async () => {
    const calls: string[] = [];
    const stub = makeStub(calls, []);
    const bridge = await createMcpToolBridge({ command: "x" }, { clientFactory: () => stub });

    await expect(
      runWithMcpBridge(bridge, async () => {
        throw new Error("loop blew up");
      }),
    ).rejects.toThrow("loop blew up");

    expect(calls.filter((c) => c === "close")).toHaveLength(1);
  });

  it("unwraps a multi-part callTool text result, joining ALL type:'text' entries (not just the first)", async () => {
    const stub: McpBridgeClientLike = {
      async start() {},
      async listTools() {
        return [{ name: "multi", description: "d" }];
      },
      async callTool() {
        return {
          content: [
            { type: "text", text: "warning: stale cache\n" },
            { type: "text", text: "the real payload" },
          ],
        };
      },
      async close() {},
    };

    const bridge = await createMcpToolBridge({ command: "x" }, { clientFactory: () => stub });
    const handler = bridge.handlers.get("mcp__multi")!;
    const result = await handler({});

    expect(result).toEqual({ output: "warning: stale cache\nthe real payload", isError: false });
  });

  it("maps a callTool isError:true result to an isError tool result, never throwing", async () => {
    const stub: McpBridgeClientLike = {
      async start() {},
      async listTools() {
        return [{ name: "fails" }];
      },
      async callTool() {
        return { content: [{ type: "text", text: "boom" }], isError: true };
      },
      async close() {},
    };
    const bridge = await createMcpToolBridge({ command: "x" }, { clientFactory: () => stub });
    const handler = bridge.handlers.get("mcp__fails")!;
    const result = await handler({});

    expect(result).toEqual({ output: "boom", isError: true });
  });

  it("a throwing callTool never escapes the handler (always isError, never a throw)", async () => {
    const stub: McpBridgeClientLike = {
      async start() {},
      async listTools() {
        return [{ name: "crashy" }];
      },
      async callTool() {
        throw new Error("upstream died");
      },
      async close() {},
    };
    const bridge = await createMcpToolBridge({ command: "x" }, { clientFactory: () => stub });
    const handler = bridge.handlers.get("mcp__crashy")!;
    const result = await handler({});

    expect(result.isError).toBe(true);
    expect(result.output).toContain("upstream died");
  });

  it("passes command/args through to the injected clientFactory, defaulting args to []", async () => {
    const seen: Array<{ command: string; args: string[] }> = [];
    const stub = makeStub([], []);

    await createMcpToolBridge(
      { command: "my-mcp-server" },
      {
        clientFactory: (server) => {
          seen.push(server);
          return stub;
        },
      },
    );

    expect(seen).toEqual([{ command: "my-mcp-server", args: [] }]);
  });
});
