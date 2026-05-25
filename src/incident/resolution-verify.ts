/**
 * Resolution verification gate (Sprint 22).
 *
 * verifyResolution queries the configured observability MCP provider for the
 * named metric over the named window, applies the comparison per-sample (lt is
 * strict <, lte is <=, gt is strict >, gte is >=), and returns verified=true
 * ONLY when EVERY sample meets the threshold. One outlier = not verified.
 *
 * Evidence persistence: every call (verified=true OR false) writes raw samples
 * to `.bober/incidents/<id>/resolution-evidence/<ISO-timestamp>.json` for
 * audit and postmortem reconstruction. Presence of the evidence file does
 * NOT imply resolution — only the VerifyResult.verified boolean does.
 *
 * No provider configured: returns verified=false, reason='NO_PROVIDER', hint.
 * Override path: handled by setIncidentStatus in src/incident/timeline.ts,
 * not here. This module ONLY measures.
 *
 * Sprint 22 — src/incident/resolution-verify.ts
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { mergeObsTools, namespaceToolName, stopAll } from "../orchestrator/observability/merge.js";
import type { ExternalMcpServer } from "../mcp/external-client.js";
import type { ObservabilityProvider } from "../config/schema.js";
import type { IncidentId } from "./types.js";

// ── Schemas ────────────────────────────────────────────────────────────────────

export const ComparisonSchema = z.enum(["lt", "gt", "lte", "gte"]);
export type Comparison = z.infer<typeof ComparisonSchema>;

export const BaselineComparisonSchema = z.enum(["absolute", "percent-of-baseline"]);
export type BaselineComparison = z.infer<typeof BaselineComparisonSchema>;

export const ResolutionCriteriaSchema = z.object({
  metricName: z.string().min(1),
  threshold: z.number(),
  comparison: ComparisonSchema,
  windowMinutes: z.number().int().positive(),
  provider: z.string().min(1),
  baselineComparison: BaselineComparisonSchema.optional(),
});
export type ResolutionCriteria = z.infer<typeof ResolutionCriteriaSchema>;

export const MetricSampleSchema = z.object({
  timestamp: z.string(),
  value: z.number(),
});
export type MetricSample = z.infer<typeof MetricSampleSchema>;

export const VerifyResultSchema = z.object({
  verified: z.boolean(),
  /** Worst-case sample value (the one that failed, else last sample). */
  observedValue: z.number().optional(),
  /** ISO timestamp of the witness sample. */
  sampledAt: z.string().optional(),
  /** Path to the evidence file: .bober/incidents/<id>/resolution-evidence/<ts>.json */
  evidencePath: z.string().optional(),
  reason: z.enum(["OK", "OUTLIER", "NO_PROVIDER", "NOT_IMPLEMENTED", "MCP_ERROR"]).optional(),
  hint: z.string().optional(),
});
export type VerifyResult = z.infer<typeof VerifyResultSchema>;

export const ResolutionEvidenceSchema = z.object({
  incidentId: z.string(),
  verifiedAt: z.string(),
  criteria: ResolutionCriteriaSchema,
  samples: z.array(MetricSampleSchema),
  allSamplesPassed: z.boolean(),
});
export type ResolutionEvidence = z.infer<typeof ResolutionEvidenceSchema>;

// ── MCP client seam (testability) ──────────────────────────────────────────────

export interface MetricQueryArgs {
  name: string;
  timeRange: { start: string; end: string };
  step?: string;
}

export interface MetricQueryClient {
  /** Call obs__<provider>__query_metric and return parsed dataPoints. */
  queryMetric(provider: string, args: MetricQueryArgs): Promise<MetricSample[]>;
}

export interface VerifyResolutionDeps {
  projectRoot: string;
  providers: readonly ObservabilityProvider[];
  /** Injected for tests; default = real spawn via mergeObsTools. */
  client?: MetricQueryClient;
  /** Injected clock for tests. Default = () => new Date(). */
  now?: () => Date;
}

// ── Per-sample comparator ──────────────────────────────────────────────────────

/**
 * Apply the comparison per the criteria. Boundary semantics:
 *   - 'lt'  : value <  threshold  (strict; value === threshold FAILS)
 *   - 'lte' : value <= threshold  (inclusive; value === threshold PASSES)
 *   - 'gt'  : value >  threshold  (strict)
 *   - 'gte' : value >= threshold  (inclusive)
 */
export function sampleMeetsThreshold(value: number, threshold: number, comparison: Comparison): boolean {
  switch (comparison) {
    case "lt":  return value <  threshold;
    case "lte": return value <= threshold;
    case "gt":  return value >  threshold;
    case "gte": return value >= threshold;
  }
}

// ── Main entry point ───────────────────────────────────────────────────────────

export async function verifyResolution(
  incidentId: IncidentId,
  criteria: ResolutionCriteria,
  deps: VerifyResolutionDeps,
): Promise<VerifyResult> {
  ResolutionCriteriaSchema.parse(criteria);

  // 1. baselineComparison = 'percent-of-baseline' is documented but deferred.
  //    Sprint 22 does not implement baseline retrieval — there is no baseline
  //    data infrastructure in the repo. Return NOT_IMPLEMENTED as per contract.
  if (criteria.baselineComparison === "percent-of-baseline") {
    return {
      verified: false,
      reason: "NOT_IMPLEMENTED",
      hint: "baselineComparison='percent-of-baseline' is not implemented in Sprint 22. Use 'absolute' or omit. Tracked as a follow-up.",
    };
  }

  // 2. Provider lookup. No provider → NO_PROVIDER with actionable hint.
  const providerDecl = deps.providers.find((p) => p.name === criteria.provider && p.enabled !== false);
  if (!providerDecl) {
    return {
      verified: false,
      reason: "NO_PROVIDER",
      hint:
        `No observability provider '${criteria.provider}' configured for metric '${criteria.metricName}'. ` +
        `Add it to bober.config.json under observability.providers, or use overrideToken='SKIP_METRIC_VERIFY: <reason>' when calling setIncidentStatus(..., 'resolved', { overrideToken }).`,
    };
  }

  // 3. Window → ISO time range.
  const now = (deps.now ?? (() => new Date()))();
  const end = now.toISOString();
  const start = new Date(now.getTime() - criteria.windowMinutes * 60_000).toISOString();

  // 4. Query the metric via injected client (default = spawn via mergeObsTools).
  let samples: MetricSample[];
  try {
    const client = deps.client ?? (await defaultMcpClient([providerDecl]));
    samples = await client.queryMetric(criteria.provider, {
      name: criteria.metricName,
      timeRange: { start, end },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      verified: false,
      reason: "MCP_ERROR",
      hint: `Failed to query metric: ${msg.replace(/\b[A-Z_][A-Z0-9_]*=\S+/g, "[redacted]")}`,
    };
  }

  // 5. Per-sample comparison; allSamplesPassed is the gate.
  //    Guard: empty samples array → every() returns true on empty, so guard with length > 0.
  const allSamplesPassed =
    samples.length > 0 &&
    samples.every((s) => sampleMeetsThreshold(s.value, criteria.threshold, criteria.comparison));

  // 6. Worst-case sample for observedValue (the one that FAILED, else last).
  const lastSample = samples[samples.length - 1];
  const failingSample = samples.find(
    (s) => !sampleMeetsThreshold(s.value, criteria.threshold, criteria.comparison),
  );
  const witness = failingSample ?? lastSample;

  // 7. Write evidence file ALWAYS (audit/postmortem).
  const evidencePath = await writeEvidenceFile(deps.projectRoot, incidentId, {
    incidentId,
    verifiedAt: end,
    criteria,
    samples,
    allSamplesPassed,
  });

  return {
    verified: allSamplesPassed,
    observedValue: witness?.value,
    sampledAt: witness?.timestamp,
    evidencePath,
    reason: allSamplesPassed ? "OK" : samples.length === 0 ? "MCP_ERROR" : "OUTLIER",
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function writeEvidenceFile(
  projectRoot: string,
  incidentId: IncidentId,
  evidence: ResolutionEvidence,
): Promise<string> {
  const dir = join(projectRoot, ".bober", "incidents", incidentId, "resolution-evidence");
  await mkdir(dir, { recursive: true });
  const fname = `${evidence.verifiedAt.replace(/[:.]/g, "-")}.json`;
  const fpath = join(dir, fname);
  await writeFile(fpath, JSON.stringify(evidence, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  return fpath;
}

async function defaultMcpClient(providers: readonly ObservabilityProvider[]): Promise<MetricQueryClient> {
  const { servers } = await mergeObsTools(providers);
  // Map providerName → server for direct callTool invocations.
  const serverByName = new Map<string, ExternalMcpServer>(
    servers.map((s) => [s.name, s] as [string, ExternalMcpServer]),
  );
  return {
    async queryMetric(provider, args) {
      const server = serverByName.get(provider);
      if (!server) {
        // best-effort stop before throwing
        await stopAll(servers).catch(() => {});
        throw new Error(`provider '${provider}' not running after mergeObsTools`);
      }
      // The upstream name is 'query_metric'; namespaceToolName is for the diagnoser's tool list,
      // NOT for direct callTool invocation on the server (per Pattern D in briefing).
      const upstreamName = namespaceToolName(provider, "query_metric").replace(`obs__${provider}__`, "");
      try {
        const raw = await server.callTool(upstreamName, args);
        return extractSamples(raw);
      } finally {
        await stopAll(servers).catch(() => {});
      }
    },
  };
}

/**
 * Parse the metrics MCP response shape (from docs/observability-mcps/metrics.md):
 *   { metric, labels, dataPoints: [{ timestamp, value }] }
 * Tolerates the SDK callTool() envelope (which may wrap content in `content`).
 */
function extractSamples(raw: unknown): MetricSample[] {
  // The MCP SDK callTool returns { content: [{type:'text',text:...}], isError }.
  // Real implementations may return structured JSON in `content[0].text` OR
  // a typed result. Accept both shapes defensively.
  const candidate = raw as { dataPoints?: unknown; content?: Array<{ text?: string }> };
  if (Array.isArray(candidate.dataPoints)) {
    return candidate.dataPoints
      .map((p) => MetricSampleSchema.safeParse(p))
      .filter((r) => r.success)
      .map((r) => (r as { data: MetricSample }).data);
  }
  if (Array.isArray(candidate.content) && candidate.content[0]?.text) {
    try {
      const parsed = JSON.parse(candidate.content[0].text);
      if (Array.isArray(parsed?.dataPoints)) {
        return parsed.dataPoints
          .map((p: unknown) => MetricSampleSchema.safeParse(p))
          .filter((r: { success: boolean }) => r.success)
          .map((r: { data: MetricSample }) => r.data);
      }
    } catch {
      // fallthrough — return empty array
    }
  }
  return [];
}
