/**
 * Gmail-to-task bridge — egress-gated.
 *
 * Provides:
 *   - parseGmailThread (PURE — no clock, no network)
 *   - sanitizeConnectorError (replicates external-client.ts:69 regex)
 *   - fromGmailTask (DI: egressAllowed + injected MCP + store + now)
 *
 * Egress guarantee: when egressAllowed=false, fromGmailTask throws BEFORE
 * calling mcp.start() or mcp.callTool() — the stub callTool stays uncalled.
 *
 * Write path: captureTask (from task-inbox.ts) is the ONLY write path.
 * This module never calls writeFinding/ingestFinding directly.
 */

import type { Finding } from "./finding.js";
import type { FactStore } from "../state/facts.js";
import { captureTask } from "./task-inbox.js";

// ── Injection surface (ExternalMcpServer satisfies this structurally) ──

/**
 * Minimal MCP surface fromGmailTask needs. ExternalMcpServer matches it
 * structurally; tests inject a fake whose callTool is a vi.fn() spy.
 */
export interface GmailMcpLike {
  start(): Promise<void>;
  callTool(name: string, args: unknown): Promise<unknown>;
  stop(): Promise<void>;
}

// ── Constants ─────────────────────────────────────────────────────────

/** Default MCP tool name to read one Gmail thread. Override per connector. */
export const DEFAULT_GMAIL_READ_TOOL = "gmail_read_thread";

// ── parseGmailThread (PURE — no clock, no network) ────────────────────

/** The clock-independent, id-independent subset of a Finding a thread yields. */
export interface ParsedGmailThread {
  title: string; // from the thread subject
  kind: "action"; // literal
  status: "open"; // literal
  tags: string[]; // provenance, e.g. ["source:gmail"]
}

/**
 * Extract the subject from a raw Gmail thread payload.
 * Tolerant: accepts { subject }, { messages: [{ subject }] }, or
 * an SDK envelope { content: [{ text: '<json>' }] }.
 * Returns "(no subject)" when nothing parseable is found.
 */
function extractSubject(payload: unknown): string {
  if (payload === null || typeof payload !== "object") return "(no subject)";
  const p = payload as Record<string, unknown>;

  // Direct subject field
  if (typeof p["subject"] === "string" && p["subject"].length > 0) {
    return p["subject"];
  }

  // messages array
  if (Array.isArray(p["messages"]) && p["messages"].length > 0) {
    const first = p["messages"][0] as Record<string, unknown>;
    if (typeof first["subject"] === "string" && first["subject"].length > 0) {
      return first["subject"];
    }
  }

  // MCP SDK envelope: { content: [{ type: "text", text: "<json>" }] }
  if (Array.isArray(p["content"]) && p["content"].length > 0) {
    const item = p["content"][0] as Record<string, unknown>;
    if (typeof item["text"] === "string") {
      try {
        const inner = JSON.parse(item["text"]) as unknown;
        return extractSubject(inner);
      } catch {
        // not JSON — ignore
      }
    }
  }

  return "(no subject)";
}

/**
 * Parse a raw Gmail thread payload into a Finding-shaped record.
 * PURE: never calls the network, never reads the clock.
 */
export function parseGmailThread(payload: unknown): ParsedGmailThread {
  const subject = extractSubject(payload);
  return { title: subject, kind: "action", status: "open", tags: ["source:gmail"] };
}

// ── Error sanitization (replicates external-client.ts:69) ─────────────

/**
 * Strip KEY=VALUE env assignments so connector tokens never surface in
 * error messages. Matches UPPERCASE_KEY=anything-without-whitespace.
 * Replicates the inline regex from src/mcp/external-client.ts:69 —
 * there is no exported sanitizer to import.
 */
export function sanitizeConnectorError(msg: string): string {
  return msg.replace(/\b[A-Z_][A-Z0-9_]*=\S+/g, "[redacted]");
}

// ── fromGmailTask ─────────────────────────────────────────────────────

/**
 * Fetch a Gmail thread via the injected MCP connector, parse it locally,
 * and capture it as an open action Finding through captureTask.
 *
 * sc-6-2 contract: when egressAllowed is false, this function throws BEFORE
 * calling mcp.start() or mcp.callTool() — zero network, zero MCP construction.
 *
 * @param args.egressAllowed - resolved from config.taskInbox?.gmailEgress
 * @param args.mcp           - injected MCP connector (stubbed in tests)
 * @param args.threadRef     - opaque thread reference passed to the connector
 * @param args.store         - open FactStore for persistence
 * @param args.now           - ISO timestamp injected at the CLI boundary (never internal)
 * @param args.toolName      - override tool name (defaults to DEFAULT_GMAIL_READ_TOOL)
 */
export async function fromGmailTask(args: {
  egressAllowed: boolean;
  mcp: GmailMcpLike;
  threadRef: string;
  store: FactStore;
  now: string;
  toolName?: string;
}): Promise<Finding> {
  // sc-6-2: refuse BEFORE touching mcp — the stub's callTool must stay unused.
  if (!args.egressAllowed) {
    throw new Error(
      "Gmail egress not enabled — set taskInbox.gmailEgress: true in bober.config.json to opt in.",
    );
  }

  await args.mcp.start();
  const raw = await args.mcp.callTool(args.toolName ?? DEFAULT_GMAIL_READ_TOOL, {
    thread: args.threadRef,
  });
  const parsed = parseGmailThread(raw);

  // captureTask is the ONLY write path (contract non-goal). It sets kind=action/
  // status=open and stamps id/surfacedAt from `now`. Provenance via domain tag.
  return captureTask(args.store, parsed.title, { domain: "gmail", now: args.now });
}
