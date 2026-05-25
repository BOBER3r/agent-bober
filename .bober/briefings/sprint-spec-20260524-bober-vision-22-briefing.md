# Sprint Briefing: SLO/metric verification — verifyResolution + setIncidentStatus resolution gate

**Contract:** sprint-spec-20260524-bober-vision-22
**Generated:** 2026-05-25T00:00:00Z

> **PRODUCTION SAFETY SPRINT.** Sprint 17's bober.diagnose Phase 4 declared the ResolutionCriteria shape; this sprint enforces it at the status-transition point. The override token is the operator's escape valve when telemetry itself is broken — its reason field IS the audit trail. Empty reason = bypass = forbidden. Evidence files are written on BOTH verified=true and verified=false (postmortem use). The "every sample meets threshold" rule is intentionally strict: averaging hides spikes.

---

## Sprint Summary (9 success criteria)

| ID | What it checks |
|----|----------------|
| s22-c1 | `src/incident/resolution-verify.ts` exports `verifyResolution(incidentId, criteria): Promise<VerifyResult>`. Criteria/result shapes match contract. |
| s22-c2 | Queries `obs__<provider>__query_metric` via Sprint 16's namespacing. `verified=true` only when EVERY sample meets the threshold. |
| s22-c3 | `setIncidentStatus(id, 'resolved')` REQUIRES `verifyResult.verified=true` OR `overrideToken`. Writes `resolutionEvidence` to `incident.json`. |
| s22-c4 | Override token format: `SKIP_METRIC_VERIFY: <reason>`. Reason REQUIRED; empty rejects. Logs reason to `timeline.jsonl`. |
| s22-c5 | No provider configured → `verified=false`, `reason='NO_PROVIDER'`, actionable hint mentioning `bober.config.json observability.providers` AND override token. |
| s22-c6 | Evidence file written to `.bober/incidents/<id>/resolution-evidence/<timestamp>.json` — even when `verified=false` (audit). |
| s22-c7 | `agents/bober-diagnoser.md` + `agents/bober-deployer.md` reference `verifyResolution` by exact name. |
| s22-c8 | Unit + integration tests: happy-path, outlier, NO_PROVIDER, override with/without reason, boundary (lt vs lte). |
| s22-c9 | typecheck / lint / build / test exit 0. |

---

## 1. Target Files

### `src/incident/resolution-verify.ts` (create)

**Directory pattern:** Files in `src/incident/` use kebab-case file names, named exports, file-header JSDoc with sprint number, zod schemas with `z.infer<typeof X>` type derivation. See sibling `src/incident/timeline.ts` and `src/incident/rollback.ts`.

**Most similar existing file:** `src/incident/rollback.ts` — copies the testable-seam pattern (config?: opts, executor?: ExecutorSeam, writeWarn?: ...) which this sprint needs for the MCP client seam. Copy that opts pattern.

**Structure template (paste-ready skeleton):**

```typescript
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
  observedValue: z.number().optional(),     // e.g. worst-case sample value
  sampledAt: z.string().optional(),         // ISO of last sample
  evidencePath: z.string().optional(),      // .bober/incidents/<id>/resolution-evidence/<ts>.json
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

export interface MetricQueryClient {
  /** Call obs__<provider>__query_metric and return parsed dataPoints. */
  queryMetric(provider: string, args: MetricQueryArgs): Promise<MetricSample[]>;
}

export interface MetricQueryArgs {
  name: string;
  timeRange: { start: string; end: string };
  step?: string;
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
      hint: `No observability provider '${criteria.provider}' configured for metric '${criteria.metricName}'. ` +
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
  const allSamplesPassed = samples.length > 0 && samples.every((s) =>
    sampleMeetsThreshold(s.value, criteria.threshold, criteria.comparison),
  );

  // 6. Worst-case sample for observedValue (the one that FAILED, else last).
  const lastSample = samples[samples.length - 1];
  const failingSample = samples.find((s) =>
    !sampleMeetsThreshold(s.value, criteria.threshold, criteria.comparison),
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
    reason: allSamplesPassed ? "OK" : (samples.length === 0 ? "MCP_ERROR" : "OUTLIER"),
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
  const { tools: _tools, servers } = await mergeObsTools(providers);
  // map providerName -> server
  const serverByName = new Map<string, ExternalMcpServer>(servers.map((s) => [s.name, s]));
  return {
    async queryMetric(provider, args) {
      const server = serverByName.get(provider);
      if (!server) {
        // best-effort stop and rethrow as MCP_ERROR upstream
        await stopAll(servers).catch(() => {});
        throw new Error(`provider '${provider}' not running after mergeObsTools`);
      }
      const toolName = namespaceToolName(provider, "query_metric");
      // upstream tool name is "query_metric" — strip the obs__<provider>__ prefix when invoking.
      const upstreamName = toolName.replace(`obs__${provider}__`, "");
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
  const candidate = (raw as { dataPoints?: unknown; content?: Array<{ text?: string }> });
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
      // fallthrough
    }
  }
  return [];
}
```

**Imports this file needs:**
- `mergeObsTools, namespaceToolName, stopAll` from `../orchestrator/observability/merge.js`
- `ExternalMcpServer` (type-only) from `../mcp/external-client.js`
- `ObservabilityProvider` from `../config/schema.js`
- `IncidentId` from `./types.js`
- `mkdir, writeFile` from `node:fs/promises`
- `join` from `node:path`
- `z` from `zod`

**Test file:** `tests/incident/resolution-verify.test.ts` (does not exist — create).

---

### `src/incident/types.ts` (modify)

**Relevant section (lines 126-135):**
```typescript
export const IncidentMetadataSchema = z.object({
  incidentId: z.string(),
  symptom: z.string(),
  createdAt: z.string(),
  status: IncidentStatusSchema,
  resolvedAt: z.string().optional(),
  resolutionCriteria: z.string().optional(),
  postmortemPath: z.string().optional(),
});
```

**Change:** add a `resolutionEvidence` field (optional). Use a re-exported schema reference rather than importing from resolution-verify.ts to avoid a circular dependency (timeline.ts already imports from types.ts; resolution-verify.ts will need to import types.ts).

```typescript
// Add ABOVE IncidentMetadataSchema:
/**
 * Snapshot of the VerifyResult that authorized the 'resolved' transition.
 * Either verified=true OR an overrideToken with a non-empty reason. Sprint 22.
 */
export const IncidentResolutionEvidenceSchema = z.object({
  verified: z.boolean(),
  observedValue: z.number().optional(),
  sampledAt: z.string().optional(),
  evidencePath: z.string().optional(),
  reason: z.string().optional(),
  hint: z.string().optional(),
  /** Set when transition was authorized via overrideToken. */
  override: z.object({
    reason: z.string().min(1, "override reason is required"),
    at: z.string(),
  }).optional(),
});
export type IncidentResolutionEvidence = z.infer<typeof IncidentResolutionEvidenceSchema>;

// Then add to IncidentMetadataSchema:
export const IncidentMetadataSchema = z.object({
  incidentId: z.string(),
  symptom: z.string(),
  createdAt: z.string(),
  status: IncidentStatusSchema,
  resolvedAt: z.string().optional(),
  resolutionCriteria: z.string().optional(),
  resolutionEvidence: IncidentResolutionEvidenceSchema.optional(), // ← NEW
  postmortemPath: z.string().optional(),
});
```

**Imported by:** `src/incident/timeline.ts`, `src/incident/rollback.ts`, `src/incident/resolution-verify.ts` (new), `tests/incident/timeline.test.ts`, `tests/incident/rollback.test.ts`, `tests/incident/resolution-verify.test.ts` (new).

**Test file:** existing `tests/incident/timeline.test.ts` exercises `IncidentMetadataSchema` via `setIncidentStatus`. New field MUST be optional so all existing tests pass without modification.

---

### `src/incident/timeline.ts` (modify)

**Current `setIncidentStatus` (lines 379-401):**
```typescript
export async function setIncidentStatus(
  projectRoot: string,
  incidentId: IncidentId,
  status: IncidentStatus,
  extras?: Partial<Omit<IncidentMetadata, "incidentId" | "symptom" | "createdAt" | "status">>,
): Promise<void> {
  const dir = incidentDir(projectRoot, incidentId);
  const metaPath = join(dir, "incident.json");

  const raw = await readFile(metaPath, "utf-8");
  const existing = IncidentMetadataSchema.parse(JSON.parse(raw));

  const updated: IncidentMetadata = {
    ...existing,
    ...extras,
    status,
    ...(status === "resolved" && !existing.resolvedAt
      ? { resolvedAt: new Date().toISOString() }
      : {}),
  };

  await atomicWriteJson(metaPath, updated);
}
```

**Required change:** Extend with `opts?: SetStatusOpts` parameter. Backward compat: the existing 4-arg form (with `extras`) MUST continue to work. Approach: add a 5th parameter OR fold opts INTO extras with new field names. Recommended: ADD a 5th parameter so existing call sites are unchanged.

```typescript
// New opts type — add to types.ts OR define locally:
export interface SetStatusOpts {
  /** REQUIRED when status='resolved' (unless overrideToken given). */
  verifyResult?: VerifyResult;
  /** REQUIRED when status='resolved' AND no verifyResult. Format: 'SKIP_METRIC_VERIFY: <reason>'. Empty reason rejects. */
  overrideToken?: string;
}

const OVERRIDE_TOKEN_RE = /^SKIP_METRIC_VERIFY:\s*(.+)$/;

export async function setIncidentStatus(
  projectRoot: string,
  incidentId: IncidentId,
  status: IncidentStatus,
  extras?: Partial<Omit<IncidentMetadata, "incidentId" | "symptom" | "createdAt" | "status">>,
  opts?: SetStatusOpts,
): Promise<void> {
  const dir = incidentDir(projectRoot, incidentId);
  const metaPath = join(dir, "incident.json");

  const raw = await readFile(metaPath, "utf-8");
  const existing = IncidentMetadataSchema.parse(JSON.parse(raw));

  // ── Resolution gate (s22-c3, s22-c4) ──────────────────────────────────────
  let resolutionEvidence: IncidentResolutionEvidence | undefined;
  let timelineEvent: TimelineEvent | undefined;
  const now = new Date().toISOString();

  if (status === "resolved") {
    const verified = opts?.verifyResult?.verified === true;
    const overrideMatch = opts?.overrideToken
      ? OVERRIDE_TOKEN_RE.exec(opts.overrideToken)
      : null;
    const overrideReason = overrideMatch?.[1]?.trim();

    if (verified && opts?.verifyResult) {
      resolutionEvidence = {
        verified: true,
        observedValue: opts.verifyResult.observedValue,
        sampledAt: opts.verifyResult.sampledAt,
        evidencePath: opts.verifyResult.evidencePath,
        reason: opts.verifyResult.reason,
        hint: opts.verifyResult.hint,
      };
      timelineEvent = {
        timestamp: now,
        eventKind: "incident_resolved",
        source: "system",
        summary: `Resolved: metric verified (observedValue=${opts.verifyResult.observedValue ?? "n/a"})`,
        refPath: opts.verifyResult.evidencePath,
      };
    } else if (overrideReason && overrideReason.length > 0) {
      resolutionEvidence = {
        verified: false,
        override: { reason: overrideReason, at: now },
      };
      timelineEvent = {
        timestamp: now,
        eventKind: "incident_resolved_override",
        source: "human",
        summary: `Resolved via override: ${overrideReason}`,
      };
    } else {
      throw new Error(
        `setIncidentStatus to 'resolved' requires opts.verifyResult.verified=true OR opts.overrideToken='SKIP_METRIC_VERIFY: <reason>' with a non-empty reason. ` +
        `Got: verifyResult.verified=${opts?.verifyResult?.verified ?? "<missing>"}, overrideToken=${opts?.overrideToken ? "<empty-reason>" : "<missing>"}.`,
      );
    }
  }

  const updated: IncidentMetadata = {
    ...existing,
    ...extras,
    status,
    ...(status === "resolved" && !existing.resolvedAt ? { resolvedAt: now } : {}),
    ...(resolutionEvidence ? { resolutionEvidence } : {}),
  };

  await atomicWriteJson(metaPath, updated);

  if (timelineEvent) {
    await appendTimeline(projectRoot, incidentId, timelineEvent);
  }
}
```

**Imports this file needs (new):**
- `VerifyResult` from `./resolution-verify.js`
- `IncidentResolutionEvidence` from `./types.js`

**Imported by:** `tests/incident/timeline.test.ts`, `src/incident/rollback.ts` (uses appendChange + appendTimeline). The Sprint 19 timeline tests (lines 391-439) for setIncidentStatus DO NOT pass status='resolved'-with-opts; verify those still pass.

**CRITICAL BACKWARD-COMPAT:** Sprint 19 tests at `tests/incident/timeline.test.ts:405-421` call `setIncidentStatus(tmpDir, incidentId, "resolved")` with NO opts. With this change, that call must NOW THROW (which is the intended Sprint 22 behavior — s22-c3). **The existing test at line 405-421 must be UPDATED** to pass `{ verifyResult: { verified: true, ... } }`. List this in regression checks.

---

### `agents/bober-diagnoser.md` (modify)

**Insertion point:** Between Step 5 (SEEK CONTRADICTING evidence) and Step 6 (RECOMMEND next actions), OR appended as a new "Step 7 — DEFINE resolution criteria" section. Recommended: add Step 7. The diagnoser commits to the criteria in Phase 4 of `bober.diagnose`; this section makes that commitment a hard contract.

**Paste-ready block:**

```markdown
### Step 7 — DEFINE resolution criteria (Sprint 22)

Before recommending ANY remediation action, you MUST emit a concrete `ResolutionCriteria` object that the deployer or human partner can pass to `verifyResolution(incidentId, criteria)`. This corresponds to `bober.diagnose` Phase 4: pre-defined criteria are the ONLY way to prove the remediation worked. Criteria written after the fact are retrofitted to the outcome and provide no verification value.

`ResolutionCriteria` shape (from `src/incident/resolution-verify.ts`):

```json
{
  "metricName": "api.checkout.error_rate",
  "threshold": 0.001,
  "comparison": "lt",
  "windowMinutes": 10,
  "provider": "datadog",
  "baselineComparison": "absolute"
}
```

Include this object in your DiagnosisResult `summary` (as a fenced JSON block) OR in a `nextActions` entry's `justification`. The downstream deployer (`agents/bober-deployer.md`) MUST call `verifyResolution(incidentId, criteria)` before declaring resolution; if `verified=false`, the deployer returns to bober.diagnose Phase 4 — NOT to `setIncidentStatus('resolved')`.

**Cross-reference:** `skills/bober.diagnose/SKILL.md` Phase 4 documents all five fields (metric / threshold / window / baseline / source) — your `ResolutionCriteria` MUST populate all of them. Skipping a field is a schema violation.
```

---

### `agents/bober-deployer.md` (modify)

**Insertion point:** New section between "Action Classification" and "Execution Discipline", OR new Step 5 in Execution Discipline ("VERIFY resolution before status='resolved'").

**Paste-ready block:**

```markdown
### Step 5 — VERIFY resolution before declaring 'resolved' (Sprint 22)

BEFORE you write any DeployResult that implies the incident is resolved, AND before any code path that would call `setIncidentStatus(incidentId, 'resolved')`, you MUST call:

```typescript
import { verifyResolution } from '../src/incident/resolution-verify.js';
const result = await verifyResolution(incidentId, criteria, deps);
```

where `criteria` is the `ResolutionCriteria` from the diagnoser's DiagnosisResult. If `result.verified === false`:

1. Do NOT call `setIncidentStatus(incidentId, 'resolved', ...)`. The status transition will THROW unless `verifyResult.verified=true` OR an explicit `overrideToken` is provided.
2. Append the `VerifyResult` to `actions.jsonl` for audit.
3. Either:
   - Re-route to bober-diagnoser to refine the hypothesis (the symptom returned or never resolved), or
   - Call `setIncidentStatus(incidentId, 'monitoring')` to indicate ongoing observation.
4. Only when an operator KNOWS via independent signals that the system has recovered AND the metric pipeline itself is degraded (NO_PROVIDER, MCP_ERROR) is the override path acceptable:
   ```typescript
   setIncidentStatus(incidentId, 'resolved', undefined, {
     overrideToken: 'SKIP_METRIC_VERIFY: <REQUIRED non-empty audit reason>',
   });
   ```
   An empty reason after the colon REJECTS — the reason IS the audit trail.

**Cross-reference:** `skills/bober.diagnose/SKILL.md` Phase 4 declares the criteria; this step enforces them. `src/incident/resolution-verify.ts` is the only sanctioned implementation — do NOT reimplement the gate yourself.
```

---

### `tests/incident/resolution-verify.test.ts` (create)

**Most similar existing file:** `tests/incident/timeline.test.ts`. Copy: mkdtemp/tmpDir fixture, beforeEach/afterEach cleanup, readJsonl helper, vitest `describe/it/expect`, ES module imports with `.js` extension.

**Paste-ready skeleton:**

```typescript
/**
 * Unit + integration tests for src/incident/resolution-verify.ts (Sprint 22).
 *
 * Uses an injected MetricQueryClient to avoid spawning real observability
 * MCPs in tests. Evidence files write to a fresh mkdtemp directory per test.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  verifyResolution,
  sampleMeetsThreshold,
  type ResolutionCriteria,
  type MetricQueryClient,
  type MetricSample,
} from "../../src/incident/resolution-verify.js";
import { createIncident, setIncidentStatus, appendTimeline } from "../../src/incident/timeline.js";
import type { ObservabilityProvider } from "../../src/config/schema.js";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-resverify-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

function fakeProvider(name = "datadog"): ObservabilityProvider {
  return { name, kind: "metrics", mcpCommand: "node", enabled: true };
}

function fakeClient(samples: MetricSample[]): MetricQueryClient {
  return { async queryMetric() { return samples; } };
}

const baseCriteria: ResolutionCriteria = {
  metricName: "api.checkout.error_rate",
  threshold: 0.01,
  comparison: "lt",
  windowMinutes: 10,
  provider: "datadog",
  baselineComparison: "absolute",
};

describe("sampleMeetsThreshold — boundary semantics", () => {
  it("'lt' is strict (value === threshold FAILS)", () => {
    expect(sampleMeetsThreshold(0.01, 0.01, "lt")).toBe(false);
    expect(sampleMeetsThreshold(0.009, 0.01, "lt")).toBe(true);
  });
  it("'lte' is inclusive (value === threshold PASSES)", () => {
    expect(sampleMeetsThreshold(0.01, 0.01, "lte")).toBe(true);
    expect(sampleMeetsThreshold(0.011, 0.01, "lte")).toBe(false);
  });
  it("'gt' is strict", () => {
    expect(sampleMeetsThreshold(0.5, 0.5, "gt")).toBe(false);
    expect(sampleMeetsThreshold(0.51, 0.5, "gt")).toBe(true);
  });
  it("'gte' is inclusive", () => {
    expect(sampleMeetsThreshold(0.5, 0.5, "gte")).toBe(true);
    expect(sampleMeetsThreshold(0.49, 0.5, "gte")).toBe(false);
  });
});

describe("verifyResolution — happy path", () => {
  it("10 samples all under threshold → verified=true", async () => {
    const incidentId = await createIncident("checkout errors", tmpDir);
    const samples = Array.from({ length: 10 }, (_, i) => ({
      timestamp: new Date(2026, 4, 24, 14, 20 + i).toISOString(),
      value: 0.0008,
    }));
    const r = await verifyResolution(incidentId, baseCriteria, {
      projectRoot: tmpDir,
      providers: [fakeProvider()],
      client: fakeClient(samples),
    });
    expect(r.verified).toBe(true);
    expect(r.reason).toBe("OK");
    expect(r.evidencePath).toBeTruthy();
  });
});

describe("verifyResolution — outlier", () => {
  it("9 under threshold + 1 outlier → verified=false, reason='OUTLIER'", async () => {
    const incidentId = await createIncident("spike", tmpDir);
    const samples: MetricSample[] = Array.from({ length: 9 }, (_, i) => ({
      timestamp: new Date(2026, 4, 24, 14, 20 + i).toISOString(),
      value: 0.0008,
    }));
    samples.push({ timestamp: new Date(2026, 4, 24, 14, 29).toISOString(), value: 0.05 });
    const r = await verifyResolution(incidentId, baseCriteria, {
      projectRoot: tmpDir,
      providers: [fakeProvider()],
      client: fakeClient(samples),
    });
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("OUTLIER");
    expect(r.observedValue).toBe(0.05);
  });
});

describe("verifyResolution — boundary at exactly threshold", () => {
  it("comparison='lt' with sample === threshold → verified=false", async () => {
    const incidentId = await createIncident("boundary lt", tmpDir);
    const samples: MetricSample[] = [
      { timestamp: "2026-05-24T14:20:00Z", value: 0.005 },
      { timestamp: "2026-05-24T14:21:00Z", value: 0.01 }, // exactly threshold
    ];
    const r = await verifyResolution(incidentId, { ...baseCriteria, comparison: "lt" }, {
      projectRoot: tmpDir, providers: [fakeProvider()], client: fakeClient(samples),
    });
    expect(r.verified).toBe(false);
  });

  it("comparison='lte' with sample === threshold → verified=true", async () => {
    const incidentId = await createIncident("boundary lte", tmpDir);
    const samples: MetricSample[] = [
      { timestamp: "2026-05-24T14:20:00Z", value: 0.005 },
      { timestamp: "2026-05-24T14:21:00Z", value: 0.01 }, // exactly threshold
    ];
    const r = await verifyResolution(incidentId, { ...baseCriteria, comparison: "lte" }, {
      projectRoot: tmpDir, providers: [fakeProvider()], client: fakeClient(samples),
    });
    expect(r.verified).toBe(true);
  });
});

describe("verifyResolution — NO_PROVIDER", () => {
  it("empty providers → verified=false, reason='NO_PROVIDER', hint mentions bober.config.json AND override token", async () => {
    const incidentId = await createIncident("no provider", tmpDir);
    const r = await verifyResolution(incidentId, baseCriteria, {
      projectRoot: tmpDir,
      providers: [],   // none configured
    });
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("NO_PROVIDER");
    expect(r.hint).toMatch(/bober\.config\.json/);
    expect(r.hint).toMatch(/observability\.providers/);
    expect(r.hint).toMatch(/SKIP_METRIC_VERIFY/);
  });
});

describe("verifyResolution — evidence file", () => {
  it("writes JSON file to .bober/incidents/<id>/resolution-evidence/ even when verified=false", async () => {
    const incidentId = await createIncident("evidence", tmpDir);
    const samples: MetricSample[] = [{ timestamp: "2026-05-24T14:20:00Z", value: 99 }];
    const r = await verifyResolution(incidentId, baseCriteria, {
      projectRoot: tmpDir, providers: [fakeProvider()], client: fakeClient(samples),
    });
    expect(r.verified).toBe(false);
    expect(r.evidencePath).toBeTruthy();
    const raw = await readFile(r.evidencePath!, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.incidentId).toBe(incidentId);
    expect(parsed.allSamplesPassed).toBe(false);
    expect(parsed.samples).toEqual(samples);
    expect(parsed.criteria.metricName).toBe("api.checkout.error_rate");
  });
});

describe("setIncidentStatus 'resolved' gate (s22-c3, s22-c4)", () => {
  it("without verifyResult and without overrideToken → THROWS", async () => {
    const incidentId = await createIncident("gate1", tmpDir);
    await expect(
      setIncidentStatus(tmpDir, incidentId, "resolved")
    ).rejects.toThrow(/verifyResult|overrideToken|SKIP_METRIC_VERIFY/);
  });

  it("with verifyResult.verified=false → THROWS", async () => {
    const incidentId = await createIncident("gate2", tmpDir);
    await expect(
      setIncidentStatus(tmpDir, incidentId, "resolved", undefined, {
        verifyResult: { verified: false, reason: "OUTLIER" },
      })
    ).rejects.toThrow(/verifyResult|verified/);
  });

  it("with verifyResult.verified=true → succeeds + writes resolutionEvidence", async () => {
    const incidentId = await createIncident("gate3", tmpDir);
    await setIncidentStatus(tmpDir, incidentId, "resolved", undefined, {
      verifyResult: {
        verified: true,
        observedValue: 0.0008,
        sampledAt: "2026-05-24T14:30:00Z",
        evidencePath: ".bober/incidents/x/resolution-evidence/y.json",
        reason: "OK",
      },
    });
    const raw = await readFile(join(tmpDir, ".bober", "incidents", incidentId, "incident.json"), "utf-8");
    const meta = JSON.parse(raw);
    expect(meta.status).toBe("resolved");
    expect(meta.resolutionEvidence.verified).toBe(true);
    expect(meta.resolutionEvidence.observedValue).toBe(0.0008);
  });

  it("override with reason → succeeds + logs 'incident_resolved_override' to timeline.jsonl", async () => {
    const incidentId = await createIncident("override ok", tmpDir);
    await setIncidentStatus(tmpDir, incidentId, "resolved", undefined, {
      overrideToken: "SKIP_METRIC_VERIFY: datadog ingestion paused — confirmed via support ticket #1234",
    });
    const tlRaw = await readFile(join(tmpDir, ".bober", "incidents", incidentId, "timeline.jsonl"), "utf-8");
    const lines = tlRaw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const overrideEvt = lines.find((l) => l.eventKind === "incident_resolved_override");
    expect(overrideEvt).toBeTruthy();
    expect(overrideEvt.summary).toMatch(/datadog ingestion paused/);
  });

  it("override with EMPTY reason ('SKIP_METRIC_VERIFY:') → THROWS", async () => {
    const incidentId = await createIncident("override empty", tmpDir);
    await expect(
      setIncidentStatus(tmpDir, incidentId, "resolved", undefined, {
        overrideToken: "SKIP_METRIC_VERIFY:",
      })
    ).rejects.toThrow();
  });

  it("override with whitespace-only reason ('SKIP_METRIC_VERIFY:   ') → THROWS", async () => {
    const incidentId = await createIncident("override ws", tmpDir);
    await expect(
      setIncidentStatus(tmpDir, incidentId, "resolved", undefined, {
        overrideToken: "SKIP_METRIC_VERIFY:    ",
      })
    ).rejects.toThrow();
  });
});

describe("verifyResolution — baselineComparison deferred", () => {
  it("'percent-of-baseline' returns NOT_IMPLEMENTED", async () => {
    const incidentId = await createIncident("baseline deferred", tmpDir);
    const r = await verifyResolution(
      incidentId,
      { ...baseCriteria, baselineComparison: "percent-of-baseline" },
      { projectRoot: tmpDir, providers: [fakeProvider()] },
    );
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("NOT_IMPLEMENTED");
  });
});
```

---

## 2. Patterns to Follow

### Pattern A — Zod schema + `z.infer<typeof X>` type
**Source:** `src/incident/types.ts` lines 36-48
```typescript
export const TimelineEventSchema = z.object({
  timestamp: z.string(),
  eventKind: z.string(),
  source: z.enum(["diagnoser", "deployer", "human", "observability", "system"]),
  summary: z.string(),
  refPath: z.string().optional(),
});
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;
```
**Rule:** Define a schema constant ending in `Schema`, derive the type with `z.infer<typeof X>`. Never write the type by hand.

### Pattern B — Atomic JSON write via temp + rename
**Source:** `src/incident/timeline.ts` lines 82-89
```typescript
async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  await rename(tmp, filePath);
}
```
**Rule:** When updating incident.json or any structured artifact, write to `.tmp` then rename. Crash-safe.

### Pattern C — Injectable seam for testability
**Source:** `src/incident/rollback.ts` lines 66-75
```typescript
export interface ExecuteRollbackOpts {
  config?: RiskyActionConfig;
  executor?: ExecutorSeam;           // injected for tests
  writeWarn?: (msg: string) => void;
  now?: () => Date;                  // injected clock
}
```
**Rule:** Expose all I/O behind an optional dep object. Tests pass mocks; production uses real default. Apply this to `MetricQueryClient` in resolution-verify.ts.

### Pattern D — obs__\<provider\>__\<tool\> namespacing
**Source:** `src/orchestrator/observability/merge.ts` lines 55-57
```typescript
export function namespaceToolName(providerName: string, toolName: string): string {
  return `obs__${providerName}__${toolName}`;
}
```
**Rule:** When calling an observability MCP tool, use the upstream name via `ExternalMcpServer.callTool('query_metric', args)` — the namespacing is for the diagnoser's tool LIST surface. When calling directly via the server reference returned from `mergeObsTools`, use the upstream (un-namespaced) name.

### Pattern E — Sanitized error message (no env leakage)
**Source:** `src/orchestrator/observability/merge.ts` lines 141-145
```typescript
function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/\b[A-Z_][A-Z0-9_]*=\S+/g, "[redacted]");
}
```
**Rule:** Strip `KEY=VALUE` patterns from any error string that crosses an external boundary (return value, log, evidence file hint). API tokens in mcpEnv must never appear in evidence files.

### Pattern F — vitest fixture: mkdtemp per test
**Source:** `tests/incident/timeline.test.ts` lines 36-46
```typescript
let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-incident-test-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
```
**Rule:** Every test gets its own temp projectRoot. Never write to the repo's `.bober/`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `mergeObsTools` | `src/orchestrator/observability/merge.ts:73` | `(providers): Promise<MergeResult>` | Spawns all observability MCPs, returns `{tools, servers, failures}`. Use to get an ExternalMcpServer to call query_metric on. |
| `namespaceToolName` | `src/orchestrator/observability/merge.ts:55` | `(providerName, toolName): string` | Produce `obs__<provider>__<tool>` — for the DIAGNOSER's tool-list surface, NOT for direct `server.callTool()` (which takes the upstream name). |
| `stopAll` | `src/orchestrator/observability/merge.ts:128` | `(servers): Promise<void>` | Stop every spawned MCP server with SIGTERM→5s→SIGKILL. MUST be called in a finally after callTool. |
| `ExternalMcpServer.callTool` | `src/mcp/external-client.ts:95` | `(name: string, args: unknown): Promise<unknown>` | Invoke a tool on a running server. `name` is the UPSTREAM name (e.g. `'query_metric'`), not the namespaced one. Returns the raw MCP envelope. |
| `appendTimeline` | `src/incident/timeline.ts:210` | `(projectRoot, incidentId, event): Promise<void>` | Append a TimelineEvent to timeline.jsonl atomically via the per-incidentId mutex. Use for `incident_resolved` and `incident_resolved_override` events. |
| `setIncidentStatus` | `src/incident/timeline.ts:379` | `(projectRoot, incidentId, status, extras?)` → being EXTENDED in this sprint | Sprint 22 adds `opts?: SetStatusOpts` as 5th arg. |
| `IncidentMetadataSchema` | `src/incident/types.ts:126` | zod schema | Being EXTENDED with `resolutionEvidence?` field. |
| `createIncident` | `src/incident/timeline.ts:148` | `(symptom, projectRoot): Promise<IncidentId>` | Use in tests to create a fresh incident directory. |
| `atomicWriteJson` (internal) | `src/incident/timeline.ts:82` | private — re-use the SAME pattern in resolution-verify.ts when writing evidence (or use `writeFile` directly with mode 0o600 since evidence files are write-once). |
| `ObservabilityProviderSchema` | `src/config/schema.ts:250` | zod schema | The provider declaration shape. `providers.find(p => p.name === criteria.provider && p.enabled !== false)` is the lookup. |

**DO NOT** create: new MCP client wrapper, new sample comparator, new "metric query" types, new incident directory helper. Use what exists.

---

## 4. Prior Sprint Output

### Sprint 16: Observability MCP plugin slots
**Created:** `src/mcp/external-client.ts` — exports `ExternalMcpServer` class with `start/listTools/callTool/stop`.
**Created:** `src/orchestrator/observability/merge.ts` — exports `mergeObsTools`, `stopAll`, `namespaceToolName`.
**Created:** `src/config/schema.ts` ObservabilityProviderSchema + ObservabilitySectionSchema.
**Connection:** Sprint 22 calls `mergeObsTools(providers)` to spawn the provider declared in `criteria.provider`, then uses the returned `ExternalMcpServer` to `callTool('query_metric', {...})`. The namespace `obs__<provider>__query_metric` is the diagnoser-facing surface; the server callTool itself uses the upstream name.

### Sprint 17: bober.diagnose skill
**Created:** `skills/bober.diagnose/SKILL.md` — Phase 4 declares the 5 required fields (metric, threshold, window, baseline, source).
**Connection:** Sprint 22 enforces this declaration at the status-transition point. The `ResolutionCriteria` zod schema MUST match the documented Phase 4 shape (lines 158-169 of SKILL.md).

### Sprint 19: Incident timeline + status helpers
**Created:** `src/incident/timeline.ts` (`createIncident`, `appendTimeline`, `appendObservation`, ..., `setIncidentStatus`, `listIncidents`).
**Created:** `src/incident/types.ts` (IncidentMetadataSchema, TimelineEventSchema, ...).
**Connection:** Sprint 22 EXTENDS `setIncidentStatus` with a 5th opts parameter for the resolution gate, and ADDS `resolutionEvidence` to IncidentMetadataSchema. The existing 4-arg signature must continue to work for non-'resolved' transitions; only `status === 'resolved'` triggers the gate.

### Sprint 20: bober-deployer + classifyCommand
**Created:** `agents/bober-deployer.md`, `src/orchestrator/deploy/spawn.ts` (uses mergeObsTools).
**Connection:** Sprint 22 modifies `agents/bober-deployer.md` to instruct the deployer to call `verifyResolution` before `setIncidentStatus('resolved')`.

### Sprint 21: Rollback awareness
**Created:** `src/incident/rollback.ts` — sibling pattern for resolution-verify.ts (testable seam, write helpers).
**Connection:** No direct code dependency; structural pattern source only.

---

## 5. Relevant Documentation

### Project Principles
**`.bober/principles.md`** — does NOT exist in this repo. Use the contract's `evaluatorNotes` as the authoritative principle source: strict per-sample comparison, evidence-on-failure, override-reason-required, exact-function-name discipline in agent prompts.

### Architecture Decisions
**`.bober/architecture/`** — directory does NOT exist. The Sprint 17 SKILL.md Phase 4 (lines 154-189) is the de-facto ADR for resolution-criteria shape. The Sprint 16 briefing/merge.ts header comment (`Downstream sprint notes`, lines 23-28) explicitly anticipates this sprint:

> Sprint 22 (SLO verification) uses obs__<provider>__query_metric — the namespace convention obs__<providerName>__<upstreamToolName> is stable.

### Observability MCP contracts
**`docs/observability-mcps/metrics.md`** — the `query_metric` tool input/output contract:
- Inputs: `name`, `timeRange.start`, `timeRange.end`, optional `aggregation`, `step`, `labels`.
- Output: `{ metric, labels, dataPoints: [{ timestamp, value }] }`.

Sprint 22 implementation MUST shape its `MetricQueryArgs` to match this contract and parse `dataPoints` into `MetricSample[]`.

### Other docs
**`CLAUDE.md`** — the user-level instructions mention `code-review-graph` MCP tools and "never push to main". Not relevant to implementation, but useful when committing: create branch + PR, never push direct to main.

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `tests/incident/timeline.test.ts` (lines 1-499) — vitest + mkdtemp + ESM imports with `.js`
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-resverify-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

it("appended event is valid JSON", async () => {
  const incidentId = await createIncident("network error", tmpDir);
  // ... assertions
});
```
**Runner:** vitest (per `package.json` `"test": "vitest"`)
**Assertion style:** `expect(value).toBe(...)`, `expect(fn).rejects.toThrow(/pattern/)`
**Mock approach:** Dependency injection — NO `vi.mock`. Inject a `MetricQueryClient` to avoid spawning real MCPs.
**File naming:** `*.test.ts` (NOT `*.spec.ts`)
**Location:** `tests/incident/resolution-verify.test.ts` — mirrors `tests/incident/timeline.test.ts` placement. The `tests/` tree is the project convention (NOT co-located in src/).

### E2E Test Pattern
Not applicable. No Playwright in this project (no `playwright.config.ts`, no `e2e/` directory).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break

| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `tests/incident/timeline.test.ts` | `setIncidentStatus` | **HIGH** | Lines 405-421 call `setIncidentStatus(tmpDir, id, "resolved")` with NO opts. Sprint 22 makes this THROW. The existing test MUST be updated to pass `{ verifyResult: { verified: true, ... } }`. Lines 423-438 ("does not overwrite existing resolvedAt") likewise must pass verifyResult on the first resolve. |
| `src/incident/rollback.ts` | imports from `./timeline.js` (appendChange, appendTimeline) | LOW | Does not call `setIncidentStatus`. Safe. |
| `src/incident/types.ts` consumers | IncidentMetadataSchema | LOW | New `resolutionEvidence` is OPTIONAL — backward-compatible. All existing parses succeed. |
| `tests/incident/rollback.test.ts` | imports from `./timeline.js` | LOW | Verify still parses incident.json correctly. |
| Other call sites of `setIncidentStatus` | — | NONE FOUND | `grep setIncidentStatus src/` finds only timeline.ts itself + tests. No CLI/orchestrator call site to update in this sprint. |

### Existing Tests That Must Still Pass
- `tests/incident/timeline.test.ts` ALL non-resolved cases (status: 'remediating', 'aborted', concurrent appends, slug derivation, createIncident skeleton, file permissions).
- `tests/incident/timeline.test.ts` lines 405-438 will need ONE-LINE updates to include the new opts parameter.
- `tests/incident/rollback.test.ts` ALL cases (planRollback, executeRollback, --since, --dry-run, halt-on-failure).
- `tests/integration/careful-flow.test.ts` — does not touch incident status; safe.
- All non-incident tests: unaffected.

### Features That Could Be Affected
- **bober.diagnose Phase 4** (skills) — semantically anchored to this sprint. No code change in the skill; the SKILL.md cross-reference is the contract that resolution-verify.ts validates.
- **Sprint 24 /bober-incident orchestrator wiring** — future sprint. It will import `verifyResolution` and the extended `setIncidentStatus`. Make sure the public exports from `src/incident/resolution-verify.ts` are stable.
- **bober-deployer agent prompt** — modified in this sprint. The exact function name `verifyResolution` MUST match the export. Drift = silent breakage at agent runtime.

### Recommended Regression Checks
After implementation, the Generator MUST verify:
1. `npm run typecheck` — exit 0.
2. `npm run lint` — exit 0.
3. `npm run build` — exit 0.
4. `npm run test -- tests/incident/` — ALL incident tests pass, including the UPDATED `setIncidentStatus` resolved-transition test in `timeline.test.ts:405`.
5. `npm run test -- tests/incident/resolution-verify.test.ts` — new file, all cases green (boundary lt/lte, NO_PROVIDER hint mentions config + override, evidence file written on failure, override empty rejects, override with reason succeeds + writes timeline event).
6. `npm run test` — full suite green.
7. `grep -n 'verifyResolution\|ResolutionCriteria' agents/bober-diagnoser.md agents/bober-deployer.md` — both must match.
8. `grep -n 'SKIP_METRIC_VERIFY' src/incident/timeline.ts` — regex must be present.

---

## 8. Implementation Sequence

1. **`src/incident/types.ts`** — add `IncidentResolutionEvidenceSchema` constant and `resolutionEvidence?` field to `IncidentMetadataSchema`. No other change.
   - Verify: `npm run typecheck` exit 0.
   - Verify: `tests/incident/timeline.test.ts` lines 137-147 still parse incident.json (field is optional).

2. **`src/incident/resolution-verify.ts`** — create with full schema set, `sampleMeetsThreshold` helper, `verifyResolution` function, and `defaultMcpClient` helper. Use the paste-ready skeleton in Section 1.
   - Verify: file exports `verifyResolution`, `ResolutionCriteria` type, `VerifyResult` type, `sampleMeetsThreshold`, `MetricQueryClient` interface.
   - Verify: zero references to non-injected I/O (i.e., no top-level `mergeObsTools` call — only inside `defaultMcpClient`).

3. **`src/incident/timeline.ts`** — extend `setIncidentStatus` with optional 5th param `opts?: SetStatusOpts`. Add the override-token regex constant. Throw on 'resolved' without verifyResult+verified=true and without overrideToken+non-empty-reason. Write `resolutionEvidence` to metadata AND emit `incident_resolved` or `incident_resolved_override` timeline event.
   - Verify: imports `VerifyResult` from `./resolution-verify.js` (type-only is fine).
   - Verify: existing non-'resolved' calls still work (4-arg form unchanged).

4. **Update existing test** `tests/incident/timeline.test.ts` lines 405-438 — the two `setIncidentStatus(..., "resolved")` calls now require opts. Add `{ verifyResult: { verified: true, observedValue: 0, sampledAt: "...", reason: "OK" } }`.
   - Verify: existing 3 tests in the `setIncidentStatus` describe block still pass.

5. **`tests/incident/resolution-verify.test.ts`** — create with all 10+ test cases per Section 1 skeleton.
   - Verify: every contract criterion (s22-c1 through s22-c8) has at least one test.

6. **`agents/bober-diagnoser.md`** — insert the Step 7 block (paste-ready in Section 1). Include exact function name `verifyResolution` and the ResolutionCriteria JSON example.
   - Verify: `grep -n 'verifyResolution\|ResolutionCriteria' agents/bober-diagnoser.md` matches.

7. **`agents/bober-deployer.md`** — insert the Step 5 block (paste-ready in Section 1). Include exact function name `verifyResolution` and the override-token format.
   - Verify: `grep -n 'verifyResolution\|SKIP_METRIC_VERIFY' agents/bober-deployer.md` matches.

8. **Run full verification** — `npm run typecheck && npm run lint && npm run build && npm run test` — all exit 0. Then verify s22-c7 with the two greps in Section 7.

---

## 9. Pitfalls & Warnings

- **Callsite of `ExternalMcpServer.callTool`:** the `name` argument is the UPSTREAM tool name (`'query_metric'`), NOT the namespaced one. The `obs__<provider>__<tool>` form only exists for the diagnoser/deployer agent's tool-LIST surface (per merge.ts:54-57 comment). Calling `callTool('obs__datadog__query_metric', ...)` directly on a server will FAIL — the upstream MCP doesn't know that name.

- **MCP response envelope:** `Client.callTool()` from `@modelcontextprotocol/sdk` returns `{ content: [{type:'text', text:string}], isError?: boolean }`. The actual `dataPoints` array may be embedded as JSON in `content[0].text` rather than at the top level. The `extractSamples` helper in Section 1's skeleton handles both. Real-provider tests don't exist in Sprint 22 (we mock the client), so this is defensive but cheap.

- **`stopAll` MUST be called in a `finally` block** after the metric query — otherwise the spawned MCP processes leak as zombies. The `defaultMcpClient` helper in the skeleton calls `stopAll` inside a `finally`; if you refactor that, preserve the discipline.

- **Provider security:** `ObservabilityProvider.mcpEnv` may contain API tokens. NEVER include the env contents in the evidence file, the VerifyResult.hint, or any thrown error message. Use the `sanitizeError` regex pattern (`/\b[A-Z_][A-Z0-9_]*=\S+/g` → `[redacted]`) from `merge.ts:144` on any error message that crosses an external boundary.

- **Override token regex boundary:** `/^SKIP_METRIC_VERIFY:\s*(.+)$/` will match `'SKIP_METRIC_VERIFY:   '` (whitespace-only after colon) because `.+` is greedy on whitespace. After matching, `trim()` the capture and check `length > 0`. The test at "override with whitespace-only reason" verifies this.

- **Empty `samples` array:** if the MCP returns zero data points (e.g., the metric doesn't exist), `every()` returns `true` on an empty array — that would falsely report `verified=true`. Guard with `samples.length > 0 && samples.every(...)` (the skeleton does this).

- **`baselineComparison='percent-of-baseline'`** is a DOCUMENTED-AS-DEFERRED scope choice. Return `verified: false, reason: 'NOT_IMPLEMENTED'` with a hint. Do NOT attempt to implement baseline retrieval — there is no baseline data infrastructure in the repo (`grep -rn baseline src/incident src/orchestrator/observability` confirms zero hits relevant to metric baselines). The evaluator's `evaluatorNotes` explicitly authorizes this deferral.

- **Backward-compat trap on `setIncidentStatus`:** existing tests at `tests/incident/timeline.test.ts:405-438` PASS `status='resolved'` with no opts. Sprint 22 INTENTIONALLY breaks this — but the test file MUST be updated as part of the sprint (it's the same test file that proves s22-c3). Do not skip the update or revert the gate.

- **Evidence file path:** the contract specifies `.bober/incidents/<id>/resolution-evidence/<timestamp>.json`. ISO timestamps contain `:` and `.` which are valid on POSIX but cause issues on Windows. The skeleton replaces both with `-` for portability: `evidence.verifiedAt.replace(/[:.]/g, "-")`. Keep this.

- **Exact function name discipline:** the agent prompts in `bober-diagnoser.md` and `bober-deployer.md` reference `verifyResolution` and `ResolutionCriteria` by name. If you rename the export, you MUST update the prompts in the same commit — drift is silent breakage at agent runtime (s22-c7 grep check catches this).

- **Hint message wording:** the NO_PROVIDER hint MUST mention BOTH `bober.config.json observability.providers` AND the override token format. The evaluator notes specifically check for this: "actionable: 'No observability provider configured for metric X. Add to bober.config.json observability.providers, or use --override-verify with a reason'". The skeleton hint satisfies this.

- **CLAUDE.md instruction:** the repo's CLAUDE.md says "never push to main" — when committing, create a branch + PR. Not a code requirement, but a commit-time discipline.
