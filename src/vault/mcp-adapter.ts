/**
 * VaultMcpAdapter — read/write/list Obsidian vault notes via a WRAPPED on-device MCP server.
 *
 * Design:
 *   - Accepts any object satisfying McpServerLike (constructor-injected), so tests can
 *     inject a hand-rolled fake without spawning a subprocess.
 *   - Resolves tool names from config.toolNames overrides before falling back to
 *     DEFAULT_VAULT_TOOL_NAMES (cyanheads/obsidian-mcp-server convention).
 *   - Runs an isOnDevice() guard before the first server interaction; rejects any
 *     declaration whose mcpCommand implies a non-local network transport.
 *
 * SECURITY: mcpEnv may contain secrets. This module NEVER includes mcpEnv values in
 * error messages, log lines, or thrown strings. Only config.name is safe to surface.
 *
 * bober: on-device-only guard inspects mcpCommand/mcpArgs (never mcpEnv). If a
 *        remote-transport MCP server is ever needed, add a new adapter — do not relax
 *        this guard; it is a deliberate security/privacy boundary.
 */

import type { ToolDescriptor } from "../mcp/external-client.js";
import type { VaultSection } from "../config/schema.js";
import type { VaultNote } from "./types.js";
import { parseNote, serializeNote } from "./frontmatter.js";

// ── McpServerLike interface ──────────────────────────────────────────

/**
 * Minimal interface satisfied by ExternalMcpServer.
 * Tests inject a hand-rolled fake; no concrete class dependency for the adapter's core.
 */
export interface McpServerLike {
  start(): Promise<void>;
  listTools(): Promise<ToolDescriptor[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
  stop(): Promise<void>;
}

// ── Default tool names ───────────────────────────────────────────────

/**
 * Default MCP tool names for cyanheads/obsidian-mcp-server.
 * Override any entry via config.obsidian.toolNames to support alternative servers
 * (e.g., Obsidian Local REST API plugin's built-in MCP).
 */
export const DEFAULT_VAULT_TOOL_NAMES = {
  readNote: "obsidian_read_file",
  writeNote: "obsidian_update_file",
  listNotes: "obsidian_list_files_in_dir",
} as const;

// ── On-device guard ──────────────────────────────────────────────────

/** URL-scheme pattern that signals a remote (non-local) transport. */
const REMOTE_SCHEME_RE = /^(https?|wss?|ftp|tcp):\/\//i;

/**
 * Detect non-loopback host in a URL-like argument element.
 * Accepts strings of the form scheme://host[/...] and rejects if host is not a
 * loopback alias (localhost / 127.0.0.1 / ::1 / 0.0.0.0).
 */
function argImpliesRemoteHost(arg: string): boolean {
  // Match <scheme>://<host>[:<port>][/...] or --flag=<scheme>://<host>
  const urlMatch = arg.match(/(?:^|=)(https?|wss?|ftp|tcp):\/\/([^/:?\s]+)/i);
  if (!urlMatch) return false;
  const host = urlMatch[2].toLowerCase();
  const loopback = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
  return !loopback.has(host);
}

/**
 * Returns true when the obsidian config describes an on-device (local) MCP server.
 *
 * Predicate:
 *   REJECT if mcpCommand matches a remote URL scheme (https?|wss?|ftp|tcp://).
 *   REJECT if any mcpArgs element embeds a non-loopback host (e.g. --url=https://cloud.example.com).
 *   ACCEPT bare executables (node, npx, /abs/path) with no remote-pointing args.
 *
 * SECURITY: Never inspects mcpEnv values — those are secrets and must not drive guard logic.
 */
export function isOnDevice(cfg: NonNullable<VaultSection["obsidian"]>): boolean {
  if (REMOTE_SCHEME_RE.test(cfg.mcpCommand)) return false;
  for (const arg of cfg.mcpArgs ?? []) {
    if (argImpliesRemoteHost(arg)) return false;
  }
  return true;
}

// ── Envelope parsing ─────────────────────────────────────────────────

/**
 * Extract the text payload from a callTool result.
 * Tolerates both a raw string and the SDK envelope { content: [{ text }] }.
 */
function extractText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  const envelope = raw as { content?: Array<{ text?: string }> };
  if (Array.isArray(envelope.content) && envelope.content[0]?.text != null) {
    return envelope.content[0].text;
  }
  throw new Error("VaultMcpAdapter: unexpected callTool result shape — no text payload found");
}

/**
 * Extract a string list from a callTool result for listNotes.
 * Tries JSON-parsing the text payload; falls back to splitting on newlines.
 */
function extractList(raw: unknown): string[] {
  const text = extractText(raw);
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed as string[];
  } catch {
    // not JSON — split on newlines
  }
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// ── VaultMcpAdapter ─────────────────────────────────────────────────

/**
 * Thin adapter that exposes readNote / writeNote / listNotes over an injected MCP server.
 *
 * Usage (production):
 *   const server = new ExternalMcpServer(provider);  // satisfies McpServerLike
 *   const adapter = new VaultMcpAdapter(server, config.vault.obsidian);
 *   await adapter.readNote("Notes/Foo.md");
 *
 * Usage (tests): inject a hand-rolled fake that satisfies McpServerLike.
 */
export class VaultMcpAdapter {
  private readonly toolNames: {
    readNote: string;
    writeNote: string;
    listNotes: string;
  };

  constructor(
    private readonly server: McpServerLike,
    private readonly config: NonNullable<VaultSection["obsidian"]>,
  ) {
    // Resolve overrides once at construction time.
    this.toolNames = {
      readNote: config.toolNames?.readNote ?? DEFAULT_VAULT_TOOL_NAMES.readNote,
      writeNote: config.toolNames?.writeNote ?? DEFAULT_VAULT_TOOL_NAMES.writeNote,
      listNotes: config.toolNames?.listNotes ?? DEFAULT_VAULT_TOOL_NAMES.listNotes,
    };
  }

  /**
   * Guard that MUST be called before any method that would invoke server.start().
   * Throws a clear Error (naming only config.name) when the declaration is not on-device.
   * SECURITY: error message never includes mcpEnv.
   */
  private guardOnDevice(): void {
    if (!isOnDevice(this.config)) {
      throw new Error(
        `VaultMcpAdapter refuses non-local server "${this.config.name}": on-device only`,
      );
    }
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Read a note at the given vault-relative path.
   * Starts the server (after the on-device guard), calls the configured read tool,
   * and parses the returned markdown into a VaultNote via sprint-1 parseNote.
   */
  async readNote(path: string): Promise<VaultNote> {
    this.guardOnDevice();
    await this.server.start();
    const raw = await this.server.callTool(this.toolNames.readNote, { path });
    const markdown = extractText(raw);
    return parseNote(markdown, path);
  }

  /**
   * Write a note to the vault.
   * Serializes the VaultNote to markdown via sprint-1 serializeNote, then calls
   * the configured write tool with the note's path and serialized content.
   */
  async writeNote(note: VaultNote): Promise<void> {
    this.guardOnDevice();
    await this.server.start();
    const content = serializeNote(note);
    await this.server.callTool(this.toolNames.writeNote, { path: note.path, content });
  }

  /**
   * List notes in a vault directory.
   * Calls the configured list tool and returns an array of path strings.
   */
  async listNotes(dir?: string): Promise<string[]> {
    this.guardOnDevice();
    await this.server.start();
    const raw = await this.server.callTool(this.toolNames.listNotes, dir != null ? { dir } : {});
    return extractList(raw);
  }

  /**
   * Stop the underlying MCP server. Safe to call even if start() was never called.
   */
  async stop(): Promise<void> {
    await this.server.stop();
  }
}
