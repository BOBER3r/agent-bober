/**
 * TokensaveMcpClient — long-lived `tokensave serve` subprocess over JSON-RPC 2.0.
 *
 * Responsibilities:
 *   - Spawn and own exactly ONE `tokensave serve` child per instance.
 *   - Multiplex concurrent call() invocations via a numeric-id PendingMap.
 *   - Restart on crash with 3-per-60s circuit breaker (health → 'broken' when
 *     tripped; subsequent call() rejects immediately).
 *   - Reject in-flight call() promises on child exit rather than leaving them
 *     to time out.
 */

import { execa } from "execa";
import type { Subprocess } from "execa";
import type { GraphSection } from "./types.js";
import type { IncidentLog } from "./incidents.js";
import { logger } from "../utils/logger.js";

// ── Constants ──────────────────────────────────────────────────────

const BREAKER_WINDOW_MS = 60_000;
const BREAKER_MAX_RESTARTS = 3;
const HANDSHAKE_TIMEOUT_MS = 5_000;

// ── Types ──────────────────────────────────────────────────────────

export type EngineHealth = "starting" | "ready" | "restarting" | "broken";

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown;
}

interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: number;
  result: unknown;
}

interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: number;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

// ── Structured errors ──────────────────────────────────────────────

function makeGraphError(reason: string, detail: string): Error {
  const err = new Error(`${reason}: ${detail}`);
  (err as Error & { reason: string; detail: string }).reason = reason;
  (err as Error & { reason: string; detail: string }).detail = detail;
  return err;
}

// ── MCP content unwrap ─────────────────────────────────────────────

/**
 * Unwrap a tools/call MCP result into the actual payload.
 *
 * tokensave 6.1.1 returns result.content as a MULTI-ENTRY array where
 * content[0] may be a plain-text staleness WARNING (not JSON) and the
 * actual JSON payload is a later entry. We scan ALL text entries and
 * return the first one that JSON.parses; if none parse, return the
 * first text entry as a raw string.
 *
 * Also handles the MCP in-band isError shape per spec (sc-1-5).
 * bober: naive linear scan over content[]; upgrade if content grows large.
 */
function unwrapMcpContent(result: unknown): unknown {
  const r = result as {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
  };
  const texts = (r?.content ?? [])
    .filter((c) => c?.type === "text")
    .map((c) => c.text ?? "");
  const joined = texts.join("");
  if (r?.isError === true) {
    throw makeGraphError("GRAPH_ERROR", joined || "tool returned isError");
  }
  // Prefer the first text entry that parses as JSON; fall back to first text.
  for (const t of texts) {
    try {
      return JSON.parse(t);
    } catch {
      // not JSON — keep looking
    }
  }
  return texts[0] ?? "";
}

// ── TokensaveMcpClient ─────────────────────────────────────────────

export class TokensaveMcpClient {
  // Exposed so pipeline-lifecycle can read the child PID for the PID file
  childPid: number | null = null;

  private child: Subprocess | null = null;
  private handshakeId = 0;
  private healthState: EngineHealth = "starting";
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private restartTimestamps: number[] = [];
  private stdoutBuf = "";
  private stopping = false;

  constructor(
    private readonly projectRoot: string,
    private readonly cfg: GraphSection,
    private readonly incidents: IncidentLog,
    private readonly binary: string = "tokensave",
  ) {}

  health(): EngineHealth {
    return this.healthState;
  }

  // ── start ──────────────────────────────────────────────────────

  /**
   * Spawn the child process and wait for the JSON-RPC handshake.
   * Resolves once health flips to 'ready'.
   * Rejects within HANDSHAKE_TIMEOUT_MS if the child exits early or the
   * handshake never arrives.
   */
  async start(): Promise<void> {
    this.stopping = false;
    this.healthState = "starting";
    await this.spawnAndHandshake();
  }

  // ── stop ───────────────────────────────────────────────────────

  /**
   * SIGTERM the child; wait up to 2000ms; SIGKILL if still alive.
   */
  async stop(): Promise<void> {
    this.stopping = true;

    // Reject any pending calls gracefully
    this.rejectAllPending(makeGraphError("GRAPH_ERROR", "engine stopped"));

    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.child = null;
      this.childPid = null;
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        // Fallback: SIGKILL
        try {
          child.kill("SIGKILL");
        } catch {
          // Already dead
        }
        resolve();
      }, 2_000);

      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(timeout);
        resolve();
      }
    });

    this.child = null;
    this.childPid = null;
  }

  // ── call ───────────────────────────────────────────────────────

  /**
   * Send a JSON-RPC 2.0 request and await the matching response.
   * Rejects immediately when health is 'broken' or the engine is stopped.
   */
  async call<T>(tool: string, params: unknown): Promise<T> {
    if (this.healthState === "broken") {
      throw makeGraphError("GRAPH_UNAVAILABLE", "engine breaker tripped");
    }

    if (this.stopping || !this.child || this.healthState !== "ready") {
      throw makeGraphError("GRAPH_ERROR", "engine not ready");
    }

    const id = this.nextId++;
    const timeoutMs = this.cfg.queryTimeoutMs ?? 5_000;

    const rawResult = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(makeGraphError("GRAPH_TIMEOUT", `call to ${tool} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: tool, arguments: params },
      };

      try {
        this.child!.stdin!.write(JSON.stringify(request) + "\n");
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(makeGraphError("GRAPH_ERROR", `stdin write failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

    return unwrapMcpContent(rawResult) as T;
  }

  // ── Private: spawn + handshake ─────────────────────────────────

  private async spawnAndHandshake(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Spawn without shell — argv array per ADR-10
      const child = execa(this.binary, ["serve"], {
        cwd: this.projectRoot,
        stdio: ["pipe", "pipe", "pipe"],
        reject: false,
      });

      this.child = child;
      this.childPid = child.pid ?? null;
      this.stdoutBuf = "";

      // Reserve an id for the initialize request from the same counter as
      // call() so ids never collide.
      this.handshakeId = this.nextId++;
      child.stdin?.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: this.handshakeId,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "agent-bober", version: "0" },
          },
        }) + "\n",
      );

      // Route stderr to debug log — never to user stdout
      child.stderr?.on("data", (chunk: unknown) => {
        logger.debug(`[tokensave-serve stderr] ${String(chunk).trimEnd()}`);
      });

      let settled = false;

      const handshakeTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("tokensave serve handshake timed out"));
        }
      }, HANDSHAKE_TIMEOUT_MS);

      // Early exit before handshake
      child.once("exit", (code: number | null, signal: string | null) => {
        clearTimeout(handshakeTimer);
        if (!settled) {
          settled = true;
          reject(
            new Error(
              `tokensave serve exited before handshake (code=${String(code)}, signal=${String(signal)})`,
            ),
          );
        }
        if (!this.stopping) {
          // Async crash handling — don't block handshake promise
          void this.onExit(code, signal);
        }
      });

      // Process stdout line by line
      child.stdout?.on("data", (chunk: unknown) => {
        this.stdoutBuf += String(chunk);
        const lines = this.stdoutBuf.split("\n");
        // Keep the last (potentially incomplete) line in the buffer
        this.stdoutBuf = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            logger.debug(`[tokensave-serve] non-JSON stdout: ${trimmed}`);
            continue;
          }

          // Handshake: resolve ONLY when the correlated initialize response
          // (same id as our initialize request) arrives — NOT on any first line.
          if (!settled && typeof msg.id === "number" && msg.id === this.handshakeId) {
            clearTimeout(handshakeTimer);
            settled = true;
            this.healthState = "ready";
            resolve();
            // Send the notifications/initialized notification AFTER resolving
            child.stdin?.write(
              JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
            );
            continue; // skip handleResponse for the handshake response
          }

          // Correlation: if it has an id, it's a response to a pending call
          if (typeof msg.id === "number") {
            this.handleResponse(msg as unknown as JsonRpcResponse);
          }
        }
      });
    });
  }

  // ── Private: response dispatch ─────────────────────────────────

  private handleResponse(msg: JsonRpcResponse): void {
    const entry = this.pending.get(msg.id);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.pending.delete(msg.id);

    if ("error" in msg && msg.error) {
      entry.reject(
        makeGraphError("GRAPH_ERROR", msg.error.message ?? "JSON-RPC error"),
      );
    } else {
      entry.resolve((msg as JsonRpcSuccessResponse).result);
    }
  }

  // ── Private: crash handling ────────────────────────────────────

  private async onExit(
    code: number | null,
    signal: string | null,
  ): Promise<void> {
    if (this.stopping) return;

    // 1. Reject every in-flight pending immediately and clear the map
    this.rejectAllPending(
      makeGraphError("GRAPH_ERROR", "engine restarted mid-call"),
    );

    // 2. Log the restart incident
    try {
      await this.incidents.append({
        ts: new Date().toISOString(),
        event: "restart",
        pid: this.childPid,
        exitCode: code,
        signal: signal ?? null,
      });
    } catch {
      // Incident write failure must not block restart
    }

    // 3. Circuit breaker rolling window
    const now = Date.now();
    this.restartTimestamps.push(now);
    this.restartTimestamps = this.restartTimestamps.filter(
      (t) => now - t <= BREAKER_WINDOW_MS,
    );

    if (this.restartTimestamps.length >= BREAKER_MAX_RESTARTS) {
      this.healthState = "broken";
      logger.warn(
        `[graph] Circuit breaker tripped after ${this.restartTimestamps.length} restarts in ${BREAKER_WINDOW_MS / 1_000}s`,
      );
      try {
        await this.incidents.append({
          ts: new Date().toISOString(),
          event: "breaker-tripped",
          restartCount: this.restartTimestamps.length,
          windowMs: BREAKER_WINDOW_MS,
        });
      } catch {
        // Incident write failure must not crash
      }
      return; // Do NOT respawn
    }

    // 4. Attempt restart
    this.healthState = "restarting";
    this.child = null;
    this.childPid = null;

    try {
      await this.spawnAndHandshake();
      this.healthState = "ready";
    } catch (err) {
      logger.warn(
        `[graph] Restart failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.healthState = "broken";
    }
  }

  // ── Private: pending cleanup ───────────────────────────────────

  private rejectAllPending(err: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(id);
    }
  }
}
