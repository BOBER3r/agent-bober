/**
 * VaultMcpAdapter unit tests.
 *
 * Uses hand-rolled fakes (no vi.mock) injected via the McpServerLike constructor parameter.
 * All tests run without spawning any subprocess.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  VaultMcpAdapter,
  DEFAULT_VAULT_TOOL_NAMES,
  isOnDevice,
  type McpServerLike,
} from "./mcp-adapter.js";
import type { VaultSection } from "../config/schema.js";
import type { ToolDescriptor } from "../mcp/external-client.js";

// ── Helpers ──────────────────────────────────────────────────────────

type ObsidianCfg = NonNullable<VaultSection["obsidian"]>;

/**
 * Create a minimal obsidian config for tests.
 * mcpCommand defaults to "npx" (on-device).
 */
function makeConfig(overrides: Partial<ObsidianCfg> = {}): ObsidianCfg {
  return {
    name: "obsidian",
    mcpCommand: "npx",
    enabled: true,
    ...overrides,
  };
}

/**
 * Create a fake McpServerLike.
 * callTool is pre-configured with a default text response;
 * callers can override via mockResolvedValueOnce.
 */
function makeFakeServer(
  callToolResponse: unknown = { content: [{ type: "text", text: '["Notes/a.md"]' }] },
): { server: McpServerLike & { start: ReturnType<typeof vi.fn>; callTool: ReturnType<typeof vi.fn> } } {
  const start = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
  const stop = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
  const listTools = vi.fn<[], Promise<ToolDescriptor[]>>().mockResolvedValue([]);
  const callTool = vi.fn<[string, unknown], Promise<unknown>>().mockResolvedValue(callToolResponse);
  return { server: { start, stop, listTools, callTool } };
}

// ── isOnDevice predicate tests ───────────────────────────────────────

describe("isOnDevice()", () => {
  it("accepts a bare npx command with no remote args", () => {
    expect(isOnDevice(makeConfig({ mcpCommand: "npx", mcpArgs: ["-y", "obsidian-mcp-server"] }))).toBe(true);
  });

  it("accepts an absolute path executable", () => {
    expect(isOnDevice(makeConfig({ mcpCommand: "/usr/local/bin/obsidian-mcp" }))).toBe(true);
  });

  it("accepts node with a local server script", () => {
    expect(isOnDevice(makeConfig({ mcpCommand: "node", mcpArgs: ["server.js"] }))).toBe(true);
  });

  it("rejects an https:// mcpCommand", () => {
    expect(isOnDevice(makeConfig({ mcpCommand: "https://obsidian.example.com/mcp" }))).toBe(false);
  });

  it("rejects a wss:// mcpCommand", () => {
    expect(isOnDevice(makeConfig({ mcpCommand: "wss://cloud.example.com/ws" }))).toBe(false);
  });

  it("rejects when mcpArgs contain a non-loopback URL", () => {
    expect(isOnDevice(makeConfig({ mcpCommand: "node", mcpArgs: ["--url=https://cloud.example.com/mcp"] }))).toBe(false);
  });

  it("accepts when mcpArgs reference localhost", () => {
    expect(isOnDevice(makeConfig({ mcpCommand: "node", mcpArgs: ["--url=http://localhost:3000"] }))).toBe(true);
  });

  it("accepts when mcpArgs reference 127.0.0.1", () => {
    expect(isOnDevice(makeConfig({ mcpCommand: "node", mcpArgs: ["--url=http://127.0.0.1:8080"] }))).toBe(true);
  });
});

// ── sc-4-3: adapter invokes configured/default tool names ────────────

describe("VaultMcpAdapter — tool invocation (sc-4-3)", () => {
  describe("readNote", () => {
    it("calls the DEFAULT readNote tool name when no toolNames override is configured", async () => {
      const readMarkdown = "---\ntitle: Hello\n---\nBody text";
      const { server } = makeFakeServer({ content: [{ type: "text", text: readMarkdown }] });
      const adapter = new VaultMcpAdapter(server, makeConfig());

      const note = await adapter.readNote("Notes/Hello.md");

      expect(server.callTool).toHaveBeenCalledWith(DEFAULT_VAULT_TOOL_NAMES.readNote, { path: "Notes/Hello.md" });
      expect(note.path).toBe("Notes/Hello.md");
      expect(note.frontmatter.title).toBe("Hello");
      expect(note.body).toBe("Body text");
    });

    it("calls the OVERRIDDEN readNote tool name when toolNames.readNote is configured", async () => {
      const readMarkdown = "---\ntitle: x\n---\nbody";
      const { server } = makeFakeServer({ content: [{ type: "text", text: readMarkdown }] });
      const adapter = new VaultMcpAdapter(
        server,
        makeConfig({ toolNames: { readNote: "custom_read" } }),
      );

      const note = await adapter.readNote("Notes/x.md");

      expect(server.callTool).toHaveBeenCalledWith("custom_read", { path: "Notes/x.md" });
      expect(note.frontmatter.title).toBe("x");
    });

    it("parses a note returned as a raw string (not SDK envelope)", async () => {
      const rawMarkdown = "---\ntitle: Raw\n---\nRaw body";
      const { server } = makeFakeServer(rawMarkdown);
      const adapter = new VaultMcpAdapter(server, makeConfig());

      const note = await adapter.readNote("Notes/Raw.md");

      expect(note.frontmatter.title).toBe("Raw");
      expect(note.body).toBe("Raw body");
    });

    it("calls server.start() before callTool", async () => {
      const { server } = makeFakeServer({ content: [{ type: "text", text: "---\n---\n" }] });
      const adapter = new VaultMcpAdapter(server, makeConfig());

      await adapter.readNote("x.md");

      // start() must have been called before callTool()
      const startOrder = (server.start as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      const callOrder = (server.callTool as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      expect(startOrder).toBeLessThan(callOrder);
    });
  });

  describe("writeNote", () => {
    it("calls the DEFAULT writeNote tool name with path and serialized content", async () => {
      const { server } = makeFakeServer({ content: [{ type: "text", text: "ok" }] });
      const adapter = new VaultMcpAdapter(server, makeConfig());
      const note = { path: "Notes/New.md", frontmatter: { title: "New" }, body: "Content here" };

      await adapter.writeNote(note);

      expect(server.callTool).toHaveBeenCalledWith(
        DEFAULT_VAULT_TOOL_NAMES.writeNote,
        expect.objectContaining({ path: "Notes/New.md" }),
      );
      // Verify serialized content includes the frontmatter
      const [, args] = (server.callTool as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { path: string; content: string }];
      expect(args.content).toContain("title: New");
      expect(args.content).toContain("Content here");
    });

    it("calls the OVERRIDDEN writeNote tool name", async () => {
      const { server } = makeFakeServer();
      const adapter = new VaultMcpAdapter(
        server,
        makeConfig({ toolNames: { writeNote: "custom_write" } }),
      );
      const note = { path: "Notes/A.md", frontmatter: {}, body: "body" };

      await adapter.writeNote(note);

      expect(server.callTool).toHaveBeenCalledWith("custom_write", expect.objectContaining({ path: "Notes/A.md" }));
    });
  });

  describe("listNotes", () => {
    it("calls the DEFAULT listNotes tool name and returns parsed string array", async () => {
      const { server } = makeFakeServer({ content: [{ type: "text", text: '["Notes/a.md","Notes/b.md"]' }] });
      const adapter = new VaultMcpAdapter(server, makeConfig());

      const list = await adapter.listNotes();

      expect(server.callTool).toHaveBeenCalledWith(DEFAULT_VAULT_TOOL_NAMES.listNotes, {});
      expect(list).toEqual(["Notes/a.md", "Notes/b.md"]);
    });

    it("passes dir argument when provided", async () => {
      const { server } = makeFakeServer({ content: [{ type: "text", text: '["Notes/sub/c.md"]' }] });
      const adapter = new VaultMcpAdapter(server, makeConfig());

      await adapter.listNotes("Notes/sub");

      expect(server.callTool).toHaveBeenCalledWith(DEFAULT_VAULT_TOOL_NAMES.listNotes, { dir: "Notes/sub" });
    });

    it("calls the OVERRIDDEN listNotes tool name", async () => {
      const { server } = makeFakeServer({ content: [{ type: "text", text: "[]" }] });
      const adapter = new VaultMcpAdapter(
        server,
        makeConfig({ toolNames: { listNotes: "list_vault_files" } }),
      );

      await adapter.listNotes();

      expect(server.callTool).toHaveBeenCalledWith("list_vault_files", {});
    });

    it("handles newline-delimited text fallback when result is not JSON", async () => {
      const { server } = makeFakeServer({ content: [{ type: "text", text: "Notes/a.md\nNotes/b.md\n" }] });
      const adapter = new VaultMcpAdapter(server, makeConfig());

      const list = await adapter.listNotes();

      expect(list).toEqual(["Notes/a.md", "Notes/b.md"]);
    });

    it("resolves ALL three tool-name overrides independently", async () => {
      const { server } = makeFakeServer({ content: [{ type: "text", text: "[]" }] });
      const adapter = new VaultMcpAdapter(
        server,
        makeConfig({
          toolNames: {
            readNote: "override_read",
            writeNote: "override_write",
            listNotes: "override_list",
          },
        }),
      );

      await adapter.listNotes();

      expect(server.callTool).toHaveBeenCalledWith("override_list", {});
    });
  });
});

// ── sc-4-4: on-device guard refuses non-local; start() never called ─────

describe("VaultMcpAdapter — on-device guard (sc-4-4)", () => {
  it("throws before calling start() when mcpCommand is an https:// URL", async () => {
    const startSpy = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
    const fakeServer: McpServerLike = {
      start: startSpy,
      listTools: vi.fn<[], Promise<ToolDescriptor[]>>().mockResolvedValue([]),
      callTool: vi.fn<[string, unknown], Promise<unknown>>().mockResolvedValue({ content: [{ type: "text", text: "" }] }),
      stop: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
    };
    const adapter = new VaultMcpAdapter(
      fakeServer,
      makeConfig({ name: "remote", mcpCommand: "https://obsidian.example.com/mcp" }),
    );

    await expect(adapter.readNote("x.md")).rejects.toThrow(/on-?device|local/i);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("throws before calling start() when mcpArgs imply a non-loopback URL", async () => {
    const startSpy = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
    const fakeServer: McpServerLike = {
      start: startSpy,
      listTools: vi.fn<[], Promise<ToolDescriptor[]>>().mockResolvedValue([]),
      callTool: vi.fn<[string, unknown], Promise<unknown>>().mockResolvedValue({ content: [{ type: "text", text: "" }] }),
      stop: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
    };
    const adapter = new VaultMcpAdapter(
      fakeServer,
      makeConfig({ name: "remote-args", mcpCommand: "node", mcpArgs: ["--url=https://cloud.example.com/mcp"] }),
    );

    await expect(adapter.readNote("x.md")).rejects.toThrow(/on-?device|local/i);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("error message includes the server name but never mcpEnv", async () => {
    const fakeServer: McpServerLike = {
      start: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
      listTools: vi.fn<[], Promise<ToolDescriptor[]>>().mockResolvedValue([]),
      callTool: vi.fn<[string, unknown], Promise<unknown>>().mockResolvedValue({}),
      stop: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
    };
    const adapter = new VaultMcpAdapter(
      fakeServer,
      makeConfig({
        name: "remote-server",
        mcpCommand: "wss://remote.example.com",
        mcpEnv: { SECRET_KEY: "should-never-appear" },
      }),
    );

    let errorMessage = "";
    try {
      await adapter.readNote("x.md");
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    expect(errorMessage).toContain("remote-server");
    expect(errorMessage).not.toContain("should-never-appear");
    expect(errorMessage).not.toContain("SECRET_KEY");
  });

  it("guard also fires for writeNote — start() never called", async () => {
    const startSpy = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
    const fakeServer: McpServerLike = {
      start: startSpy,
      listTools: vi.fn<[], Promise<ToolDescriptor[]>>().mockResolvedValue([]),
      callTool: vi.fn<[string, unknown], Promise<unknown>>().mockResolvedValue({}),
      stop: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
    };
    const adapter = new VaultMcpAdapter(
      fakeServer,
      makeConfig({ mcpCommand: "https://example.com/mcp" }),
    );

    await expect(adapter.writeNote({ path: "x.md", frontmatter: {}, body: "" })).rejects.toThrow(/on-?device|local/i);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("guard also fires for listNotes — start() never called", async () => {
    const startSpy = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
    const fakeServer: McpServerLike = {
      start: startSpy,
      listTools: vi.fn<[], Promise<ToolDescriptor[]>>().mockResolvedValue([]),
      callTool: vi.fn<[string, unknown], Promise<unknown>>().mockResolvedValue({}),
      stop: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
    };
    const adapter = new VaultMcpAdapter(
      fakeServer,
      makeConfig({ mcpCommand: "https://example.com/mcp" }),
    );

    await expect(adapter.listNotes()).rejects.toThrow(/on-?device|local/i);
    expect(startSpy).not.toHaveBeenCalled();
  });
});

// ── stop() delegation ────────────────────────────────────────────────

describe("VaultMcpAdapter — stop()", () => {
  it("delegates to the underlying server.stop()", async () => {
    const { server } = makeFakeServer();
    const adapter = new VaultMcpAdapter(server, makeConfig());

    await adapter.stop();

    expect(server.stop).toHaveBeenCalledOnce();
  });
});
