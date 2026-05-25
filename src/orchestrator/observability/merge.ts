/**
 * Tool merge helper for observability MCP plugin slots (Sprint 16).
 *
 * At diagnoser spawn time, the orchestrator calls mergeObsTools(providers) to:
 * 1. Start every enabled provider in parallel (ExternalMcpServer.start()).
 * 2. Enumerate each provider's tools (ExternalMcpServer.listTools()).
 * 3. Namespace each tool as obs__<providerName>__<upstreamToolName>.
 * 4. Return the merged list, running servers, and a failure map.
 *
 * Provider failures are isolated via Promise.allSettled — a single failure
 * does NOT abort the whole merge. The diagnoser spawns with whatever providers
 * succeeded; failed providers appear only in the `failures` record and a warning
 * is written to stderr.
 *
 * SECURITY: error messages contain only the provider NAME and a sanitized error
 * string. The provider's mcpEnv (which may contain API tokens) is NEVER logged
 * or included in returned error values.
 *
 * Sprint 24 will import mergeObsTools and stopAll from this module at the
 * /bober-incident spawn site. This module intentionally takes ONLY the providers
 * array — not projectRoot or BoberConfig — so Sprint 24 can inject it freely.
 *
 * Downstream sprint notes:
 * - Sprint 22 (SLO verification) uses obs__<provider>__query_metric — the
 *   namespace convention obs__<providerName>__<upstreamToolName> is stable.
 * - Sprint 28 (telemetry) must NOT include observability MCP response bodies in
 *   telemetry events. The sanitizeError helper here sets the precedent: redact
 *   env var patterns before any external logging boundary.
 */

import type { ObservabilityProvider } from "../../config/schema.js";
import type { ToolDescriptor } from "../../mcp/external-client.js";
import { ExternalMcpServer } from "../../mcp/external-client.js";

export type { ToolDescriptor };

/** A tool that has been namespaced for the diagnoser's tool list. */
export interface NamespacedTool extends ToolDescriptor {
  /** Original tool name as reported by the upstream server. */
  upstreamName: string;
  /** Provider name (alphanumeric/underscore). */
  providerName: string;
}

export interface MergeResult {
  /** Tools successfully merged in obs__<provider>__<tool> form. */
  tools: NamespacedTool[];
  /** Running servers (caller must call stopAll on diagnoser exit). */
  servers: ExternalMcpServer[];
  /** Provider name → sanitized error message for providers that failed to start/list. */
  failures: Record<string, string>;
}

/** Produce the canonical `obs__<provider>__<tool>` namespaced name. */
export function namespaceToolName(providerName: string, toolName: string): string {
  return `obs__${providerName}__${toolName}`;
}

/**
 * Start every enabled provider in parallel and merge their tool lists.
 * Provider failures are isolated — a failure in one does NOT prevent others.
 *
 * Uses Promise.allSettled (NOT Promise.all) so partial failure never aborts
 * the entire batch. See Pattern C in the Sprint 16 briefing.
 *
 * SECURITY: error messages contain only the provider NAME and a sanitized
 * error string. The provider's mcpEnv (which may contain secrets) is
 * never logged.
 *
 * @param providers - The observability.providers array from bober.config.json.
 *                    Callers should pass `config.observability?.providers ?? []`.
 */
export async function mergeObsTools(
  providers: readonly ObservabilityProvider[],
): Promise<MergeResult> {
  const enabled = providers.filter((p) => p.enabled !== false);
  const servers: ExternalMcpServer[] = enabled.map((p) => new ExternalMcpServer(p));
  const failures: Record<string, string> = {};
  const tools: NamespacedTool[] = [];

  // Promise.allSettled: partial failure never aborts the batch (s16-c4).
  const startResults = await Promise.allSettled(
    servers.map(async (s) => {
      await s.start();
      return s.listTools();
    }),
  );

  // Collect surviving servers (only those that succeeded).
  const survivingServers: ExternalMcpServer[] = [];

  for (let i = 0; i < startResults.length; i++) {
    const provider = enabled[i];
    const server = servers[i];
    const r = startResults[i];

    if (r.status === "fulfilled") {
      survivingServers.push(server);
      for (const t of r.value) {
        tools.push({
          ...t,
          upstreamName: t.name,
          providerName: provider.name,
          name: namespaceToolName(provider.name, t.name),
        });
      }
    } else {
      // SECURITY: do NOT include provider.mcpEnv in this message.
      const msg = sanitizeError(r.reason);
      failures[provider.name] = msg;
      process.stderr.write(
        `[bober obs] provider "${provider.name}" failed to start: ${msg}\n`,
      );
      // Best-effort stop of any half-started subprocess — ignore errors.
      void server.stop().catch(() => { /* ignore */ });
    }
  }

  return { tools, servers: survivingServers, failures };
}

/**
 * Stop every server in parallel. Errors are isolated; each server implements
 * SIGTERM → 5s → SIGKILL internally (s16-c3).
 *
 * Callers MUST invoke this when the diagnoser exits to prevent zombie processes.
 */
export async function stopAll(servers: readonly ExternalMcpServer[]): Promise<void> {
  // Promise.allSettled: a failure in one stop() must not prevent others.
  await Promise.allSettled(servers.map((s) => s.stop()));
}

/**
 * Sanitize an error value for safe external logging.
 * Strips anything that looks like an env var assignment (KEY=VALUE) — defensive
 * redaction against accidental token leakage in error messages.
 *
 * SECURITY: used throughout this module before any process.stderr.write or
 * stored failure message. Sprint 28 telemetry must apply the same discipline.
 */
function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Strip KEY=VALUE patterns that may carry API tokens.
  return raw.replace(/\b[A-Z_][A-Z0-9_]*=\S+/g, "[redacted]");
}
