/**
 * ExternalMcpServer — manages one externally-spawned MCP server subprocess.
 *
 * Lifecycle:
 *   - start(): spawn child via SDK StdioClientTransport, perform MCP handshake.
 *   - listTools(): return tool descriptors from the server (cached after first call).
 *   - callTool(name, args): invoke a tool, return its result.
 *   - stop(): SIGTERM the child, wait up to 5s, SIGKILL if still alive.
 *
 * SECURITY: providerConfig.mcpEnv may contain API tokens. NEVER include the
 * env contents in error messages, log lines, or returned errors. Only the
 * provider NAME is safe to expose externally.
 *
 * Error isolation: ExternalMcpServer does NOT implement circuit-breaker or
 * restart-on-crash logic. Observability MCPs are best-effort — a crashed
 * provider is simply absent from the diagnoser's tool list for that spawn.
 * The caller (mergeObsTools) uses Promise.allSettled to handle partial failure.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ObservabilityProvider } from "../config/schema.js";

export interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export class ExternalMcpServer {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private toolsCache: ToolDescriptor[] | null = null;
  private stopping = false;

  constructor(private readonly provider: ObservabilityProvider) {}

  get name(): string {
    return this.provider.name;
  }

  async start(): Promise<void> {
    if (this.client) return; // idempotent

    // SECURITY: merge process.env FIRST so the child inherits PATH and other
    // essentials; then overlay provider.mcpEnv. The merged object is passed to
    // the child only — it is never logged or included in error messages.
    this.transport = new StdioClientTransport({
      command: this.provider.mcpCommand,
      args: this.provider.mcpArgs ?? [],
      env: {
        ...(process.env as Record<string, string>),
        ...(this.provider.mcpEnv ?? {}),
      },
      stderr: "pipe",
    });

    this.client = new Client(
      { name: "agent-bober-obs-client", version: "0.13.0" },
      { capabilities: {} },
    );

    try {
      await this.client.connect(this.transport);
    } catch (err) {
      // SECURITY: do NOT include provider.mcpEnv in the rethrown error.
      const msg = err instanceof Error ? err.message : String(err);
      // Strip anything that looks like an env var assignment (KEY=VALUE).
      const sanitized = msg.replace(/\b[A-Z_][A-Z0-9_]*=\S+/g, "[redacted]");
      this.client = null;
      this.transport = null;
      // SECURITY: message is sanitized; the original error is attached as cause
      // for debug-time stack traces but must NOT be logged externally.
      throw new Error(
        `ExternalMcpServer "${this.provider.name}" failed to connect: ${sanitized}`,
        { cause: err },
      );
    }
  }

  async listTools(): Promise<ToolDescriptor[]> {
    if (!this.client) {
      throw new Error(`provider "${this.provider.name}" not started`);
    }
    if (this.toolsCache) return this.toolsCache;
    const res = await this.client.listTools();
    this.toolsCache = res.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    return this.toolsCache;
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    if (!this.client) {
      throw new Error(`provider "${this.provider.name}" not started`);
    }
    return await this.client.callTool({
      name,
      arguments: (args as Record<string, unknown>) ?? {},
    });
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    // SDK Client.close() closes the transport which sends SIGTERM to the child.
    // Wrap with a 5s timeout + SIGKILL fallback as required by s16-c3.
    const clientRef = this.client;
    const transportRef = this.transport;

    this.client = null;
    this.transport = null;

    if (!clientRef) return;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // The SDK transport exposes the child's pid via the `pid` getter.
        // Use process.kill() as the SIGKILL fallback.
        const pid = transportRef?.pid;
        if (pid != null) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // already dead — ignore
          }
        }
        resolve();
      }, 5_000);

      void clientRef.close().catch(() => { /* ignore close errors */ }).then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
