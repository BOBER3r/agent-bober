# Sprint Briefing: Observability MCP plugin slot architecture

**Contract:** sprint-spec-20260524-bober-vision-16
**Generated:** 2026-05-25T00:00:00.000Z

---

## Sprint Summary

This sprint makes agent-bober an **MCP CLIENT** that consumes external observability MCP servers (datadog/sentry/grafana/custom) declared in `bober.config.json` under `observability.providers`. At diagnoser spawn time, each declared MCP server is started, its `tools/list` is enumerated, and the tools are merged into the diagnoser's tool set with the namespace `obs__<provider>__<tool>`. The MCP SERVER side of agent-bober (in `src/mcp/server.ts`) is unchanged — this sprint adds the *inverse* role (client of external servers).

**Critical scope discipline:**
- The diagnoser (Sprint 15) is currently NOT spawned anywhere — Sprint 24 (`/bober-incident`) wires the actual spawn. This sprint must therefore deliver the **API surface** (a pure callable like `mergeObsTools(coreTools, providers)`) and **unit-test it directly** — there is no live spawn site to integrate with yet.
- Docs in `docs/observability-mcps/` are **CONTRACT-ONLY** (what tools an MCP must expose). No vendor code, no working integrations. The user explicitly chose "Generic / BYO observability."
- **Security:** `mcpEnv` may carry API tokens. Error messages, audit trail entries, and any future telemetry events MUST NOT include token values.

---

## 1. Target Files

### `src/config/schema.ts` (modify)

**Current relevant section (lines 147-166 — `PipelineSectionSchema`, your template for shape):**

```typescript
export const PipelineSectionSchema = z.object({
  maxIterations: z.number().int().min(1).default(20),
  maxCheckpointIterations: z.number().int().min(1).max(10).default(3),
  requireApproval: z.boolean().default(false),
  contextReset: ContextResetSchema.default("always"),
  researchPhase: z.boolean().default(true),
  architectPhase: z.boolean().default(false),
  mode: z.enum(["autopilot", "careful"]).default("autopilot"),
  checkpointMechanism: CheckpointMechanismSchema.optional(),
  checkpointOverrides: z.record(z.string(), CheckpointMechanismSchema).default({}),
  approvalTimeoutMs: z.number().int().min(1000).default(86_400_000),
  prPollMs: z.number().int().min(10_000).default(30_000),
});
export type PipelineSection = z.infer<typeof PipelineSectionSchema>;
```

**Full BoberConfigSchema (lines 226-238) — the insertion point:**

```typescript
export const BoberConfigSchema = z.object({
  project: ProjectSectionSchema,
  planner: PlannerSectionSchema,
  curator: CuratorSectionSchema.optional(),
  generator: GeneratorSectionSchema,
  evaluator: EvaluatorSectionSchema,
  sprint: SprintSectionSchema,
  pipeline: PipelineSectionSchema,
  commands: CommandsSectionSchema,
  graph: GraphSectionSchema.optional(),     // ← precedent: optional sub-section
  codeReview: CodeReviewSectionSchema.optional(),
  // ↓ ADD HERE
  observability: ObservabilitySectionSchema.optional(),
});
```

**What to add (mirror `GraphSectionSchema` at lines 198-222 for shape; mirror `EvalStrategySchema` at lines 56-69 for the per-item zod pattern):**

```typescript
// ── Observability Section (Sprint 16 — MCP plugin slots) ────────────

/** Categories of observability data a provider can serve. */
export const ObservabilityProviderKindSchema = z.enum([
  "logs",
  "metrics",
  "traces",
  "errors",
  "custom",
]);
export type ObservabilityProviderKind = z.infer<typeof ObservabilityProviderKindSchema>;

/**
 * One declared external MCP server providing observability tools.
 * At diagnoser spawn time the orchestrator spawns mcpCommand with
 * mcpArgs and mcpEnv, lists its tools, and merges them into the
 * diagnoser's tool set under the prefix `obs__<name>__<tool>`.
 */
export const ObservabilityProviderSchema = z.object({
  /** Unique name used in the obs__<name>__<tool> namespace prefix. */
  name: z.string().min(1).regex(/^[a-z0-9_]+$/i, "name must be alphanumeric/underscore"),
  kind: ObservabilityProviderKindSchema,
  /** Executable to spawn (e.g., "node", "/usr/local/bin/mcp-grafana"). */
  mcpCommand: z.string().min(1),
  mcpArgs: z.array(z.string()).optional(),
  /** Env vars passed to the child — may contain SECRETS (treat as opaque). */
  mcpEnv: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().default(true),
});
export type ObservabilityProvider = z.infer<typeof ObservabilityProviderSchema>;

export const ObservabilitySectionSchema = z.object({
  providers: z.array(ObservabilityProviderSchema).default([]),
});
export type ObservabilitySection = z.infer<typeof ObservabilitySectionSchema>;
```

**Then update the index barrel `src/config/index.ts` (currently lines 1-49):** export the new schemas and types (mirror the way `GraphSectionSchema`/`GraphSection` is implicitly exported via the re-export block — note that the current index does NOT re-export `GraphSectionSchema` either, so be consistent: at minimum export `ObservabilityProviderSchema`, `ObservabilitySectionSchema`, `type ObservabilityProvider`, `type ObservabilitySection`, `type ObservabilityProviderKind`).

**Imports this file uses:** only `zod`.
**Imported by:** `src/config/loader.ts`, `src/config/defaults.ts`, `src/mcp/server.ts`, `src/orchestrator/pipeline.ts`, plus ~40 other files via `BoberConfig` type.

**Test file:** `tests/config/graph-schema.test.ts` — extend this with Sprint 16 backward-compat tests (see s16-c8 below). **Do NOT colocate** with `src/config/schema.ts` since the existing backward-compat test lives at `tests/config/graph-schema.test.ts` and that's where Sprint 14's pattern was added.

---

### `src/config/loader.ts` (review-only — likely NO change required)

**Why:** the loader uses `deepMerge(defaults, partial)` then runs `BoberConfigSchema.safeParse(merged)`. The default for `observability` is `undefined` (the section is `.optional()`), and `providers: []` is the inner default when the section IS present. Since `observability` is at the top level (not inside one of the sections that has hard-coded fallbacks in the giant `deepMerge` literal at lines 186-227), nothing in the literal needs to change. Verify by adding a Sprint 16 backward-compat test (see test patterns section).

**If you choose to add an explicit `observability: { providers: [] }` default** (mirroring how Sprint 14 added a default `checkpointOverrides: {}`), do it at lines 186-227 *additively*. Either approach passes s16-c8 — zod's `.default([])` already gives you the empty array when the section is present, and `.optional()` makes the section itself omittable.

---

### `src/mcp/external-client.ts` (create)

**Directory pattern:** files in `src/mcp/` are kebab-case: `server.ts`, `index.ts`, `run-manager.ts`, `run-manager.test.ts`. New file uses **kebab-case** + colocated test → `external-client.ts` + `external-client.test.ts`.

**Most similar existing file:** `src/graph/mcp-client.ts` (374 lines). That class is the long-running subprocess pattern: spawn child with `execa`, JSON-RPC handshake over stdio, multiplex calls via a pending map, stop with `SIGTERM → wait → SIGKILL`. Read it end-to-end before writing — your class is structurally the same with these deltas:

| Concern | `TokensaveMcpClient` (existing) | `ExternalMcpServer` (new) |
|---------|---------------------------------|---------------------------|
| Wire format | Raw JSON-RPC over newline-delimited stdio (custom) | MCP JSON-RPC (use SDK transport) |
| Lifecycle owner | Pipeline-wide singleton | Per-diagnoser-spawn (start at spawn, stop at exit) |
| Restart on crash | Circuit breaker, 3-per-60s | NOT required — observability MCPs are best-effort; on crash, log to stderr and treat that provider as failed for the spawn |
| SIGKILL grace | 2 s | **5 s** (per contract s16-c3) |
| API | `start() / call(tool, params) / stop()` | `start() / listTools() / callTool(name, args) / stop()` |

**STRONGLY PREFER the official SDK over hand-rolled JSON-RPC.** `@modelcontextprotocol/sdk` v1.28.0 is already in `package.json` and `src/mcp/server.ts:13-20` already imports from it. The client side ships at `node_modules/@modelcontextprotocol/sdk/dist/esm/client/`:

```typescript
// Recommended imports (mirror src/mcp/server.ts:13-14 style):
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
```

`StdioClientTransport` (signature in `node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.d.ts:46-76`) takes `{ command, args?, env?, stderr?, cwd? }` and internally spawns + frames stdio. The `Client` class exposes `connect(transport)`, `listTools()`, `callTool({name, arguments})`, and `close()`.

**Structure template (copy-paste skeleton — adapt freely):**

```typescript
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
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ObservabilityProvider } from "../config/schema.js";
import { logger } from "../utils/logger.js";

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
    this.transport = new StdioClientTransport({
      command: this.provider.mcpCommand,
      args: this.provider.mcpArgs ?? [],
      env: { ...process.env as Record<string, string>, ...(this.provider.mcpEnv ?? {}) },
      stderr: "pipe",
    });
    this.client = new Client(
      { name: "agent-bober-obs-client", version: "0.13.0" },
      { capabilities: {} },
    );
    await this.client.connect(this.transport);
  }

  async listTools(): Promise<ToolDescriptor[]> {
    if (!this.client) throw new Error(`provider ${this.provider.name} not started`);
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
    if (!this.client) throw new Error(`provider ${this.provider.name} not started`);
    return await this.client.callTool({
      name,
      arguments: (args as Record<string, unknown>) ?? {},
    });
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    // SDK Client.close() closes the transport which sends SIGTERM-equivalent
    // to the child. Wrap with our own 5s timeout + SIGKILL fallback.
    const closePromise = this.client?.close().catch(() => { /* ignore */ });

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // The SDK transport stores the child internally; we need a fallback
        // SIGKILL. The transport exposes `pid` getter. Use process.kill().
        const pid = this.transport?.pid;
        if (pid != null) {
          try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
        }
        resolve();
      }, 5_000);
      void closePromise?.then(() => { clearTimeout(timer); resolve(); });
    });

    this.client = null;
    this.transport = null;
  }
}
```

**Key SDK signatures (from `node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.d.ts`):**
- Line 110: `class Client<...> extends Protocol<...>`
- Line 429: `callTool(params: { name, arguments }, resultSchema?, options?): Promise<...>`
- Line 536: `listTools(params?, options?): Promise<{ tools: Tool[] }>`
- StdioClientTransport line 72 exposes `get pid(): number | null` — use this for the SIGKILL fallback.

---

### `src/orchestrator/observability/merge.ts` (create — new dir)

**Why a new module rather than `src/orchestrator/subagent-spawn.ts`:** the contract's `expectedChanges` lists `src/orchestrator/subagent-spawn.ts (or main spawn file)` — but **that file does not exist** and the diagnoser is not yet spawned (Sprint 24 wires the spawn site). Adding `subagent-spawn.ts` now would create dead code. The clean alternative: ship a small pure module that Sprint 24 will import and call.

**Directory pattern:** sibling subfolders in `src/orchestrator/` already exist (`checkpoints/`, `tools/`). Add `observability/` with:
- `observability/merge.ts` — pure tool-merge helper
- `observability/lifecycle.ts` — wraps `startAll(providers) / stopAll(servers)` with `Promise.allSettled` for error isolation
- `observability/index.ts` — barrel

**Most similar existing file:** `src/orchestrator/checkpoints/index.ts` is a small barrel; `src/orchestrator/checkpoints/feedback-router.ts` is a similar "compose lower-level primitives" module. The `Promise.allSettled` idiom is in `src/graph/client.ts:123` and `src/evaluators/plugin-loader.ts:122` — both are good references.

**Structure template — `merge.ts`:**

```typescript
import type { ObservabilityProvider } from "../../config/schema.js";
import type { ToolDescriptor } from "../../mcp/external-client.js";
import { ExternalMcpServer } from "../../mcp/external-client.js";
import { logger } from "../../utils/logger.js";

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
  /** Provider name → error message for providers that failed to start/list. */
  failures: Record<string, string>;
}

/** Produce the `obs__<provider>__<tool>` namespaced name. */
export function namespaceToolName(providerName: string, toolName: string): string {
  return `obs__${providerName}__${toolName}`;
}

/**
 * Start every enabled provider in parallel and merge their tool lists.
 * Provider failures are isolated — a failure in one does NOT prevent others.
 *
 * SECURITY: error messages contain only the provider NAME and a sanitized
 * error string. The provider's mcpEnv (which may contain secrets) is
 * never logged.
 */
export async function mergeObsTools(
  providers: readonly ObservabilityProvider[],
): Promise<MergeResult> {
  const enabled = providers.filter((p) => p.enabled !== false);
  const servers: ExternalMcpServer[] = enabled.map((p) => new ExternalMcpServer(p));
  const failures: Record<string, string> = {};
  const tools: NamespacedTool[] = [];

  const startResults = await Promise.allSettled(
    servers.map(async (s) => {
      await s.start();
      return s.listTools();
    }),
  );

  for (let i = 0; i < startResults.length; i++) {
    const provider = enabled[i];
    const server = servers[i];
    const r = startResults[i];
    if (r.status === "fulfilled") {
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
      // Best-effort stop of half-started subprocess; ignore errors.
      void server.stop().catch(() => { /* ignore */ });
    }
  }
  return { tools, servers, failures };
}

/** Stop every server. Errors are isolated; SIGKILL after 5s is in stop(). */
export async function stopAll(servers: readonly ExternalMcpServer[]): Promise<void> {
  await Promise.allSettled(servers.map((s) => s.stop()));
}

function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Strip anything that looks like an env var assignment (KEY=VALUE) — defensive.
  return raw.replace(/\b[A-Z_][A-Z0-9_]*=\S+/g, "[redacted]");
}
```

---

### `agents/bober-diagnoser.md` (modify)

**Current relevant section (lines 26-28, 141-150) — observability is already referenced as a forward link to Sprint 16. You're now fulfilling that forward link:**

```markdown
  - `bober.config.json` — for observability MCP server configuration
- ...
- At spawn time, the orchestrator may have merged observability MCP tools (logs/traces/metrics queries) into your tool list (Sprint 16 wires this). If present, use them as the primary data source for system metrics, logs, and traces. If absent, fall back to file reads from incident artifacts and `Bash` for read-only shell queries.
```

**Insertion point:** add a new `## Observability MCP Tools` section AFTER `## Bash Discipline` (line 167) and BEFORE `## Related Skills` (line 202). This places it adjacent to the Bash discipline (the "how to gather evidence" section) and before downstream skill references.

**Content to add (the contract's s16-c7 spec — exact text required, plus context):**

```markdown
## Observability MCP Tools

Your available observability tools are configured at `bober.config.json` under `observability.providers`. The Bober orchestrator starts each declared MCP server at your spawn time, enumerates its tools, and merges them into your tool list under the namespace prefix `obs__<provider>__<tool>`.

**Use these tools as the primary data source for system metrics, logs, and traces.** They are the multi-source evidence channel the Iron Law requires — a log query (`obs__loki__query_logs`) plus a metric query (`obs__datadog__query_metric`) from two distinct providers is two independent sources.

**Identifying provider tools at runtime.** Any tool name starting with `obs__` is provider-merged. The format is `obs__<providerName>__<upstreamToolName>` — for example `obs__datadog__query_logs`, `obs__sentry__query_events`, `obs__grafana_loki__query_range`. The `providerName` segment tells you which provider's data you are querying (cite it in `supportingEvidence.source` as `observability-mcp:<providerName>`).

**Provider failure isolation.** If a declared provider failed to start at your spawn time, you will simply not see its `obs__<provider>__*` tools. The orchestrator logs a warning to stderr but does not block your spawn. When your primary data source is missing, record that as a hypothesis with low confidence (e.g., `"monitoring stack degraded: <provider> tools unavailable"`) — do NOT invent values for the missing telemetry.

**No providers configured?** When `observability.providers` is empty (or all providers failed), only the core tools `Read | Bash | Grep | Glob` are available. Fall back to reading the recorded artifacts in `.bober/incidents/<id>/timeline.jsonl` and using `Bash` allowlisted commands for read-only system queries.
```

**Also update the existing line 28 (the forward link) to past tense / present:** change `"(Sprint 16 wires this)"` to `"(see 'Observability MCP Tools' section below)"`.

**Do NOT** add the prefixed tool names to the YAML frontmatter `tools:` list (lines 4-9). Per Sprint 15's design (briefing line 64): the frontmatter is the CORE list only; merged MCP tools are runtime additions.

**Verification (s16-c7):**
```bash
grep -E 'obs__|observability\.providers' agents/bober-diagnoser.md  # must find non-zero matches
```

---

### `docs/observability-mcps/` (create — directory + 5 files)

**Directory does NOT exist yet** (`ls docs/` returned ENOENT). Create:
- `docs/observability-mcps/README.md`
- `docs/observability-mcps/logs.md`
- `docs/observability-mcps/metrics.md`
- `docs/observability-mcps/traces.md`
- `docs/observability-mcps/errors.md`

**CONTRACT-ONLY rule (s16-c5, evaluatorNotes):** each file describes the TOOLS an MCP server in that category MUST expose (name, input schema, expected output shape) and may NAME existing community implementations — but ships zero TypeScript, zero JSON, zero "drop-in adapter." The evaluator will reject any file containing a working integration.

**README.md template (~80 lines):**

```markdown
# Observability MCP Plugin Slots

agent-bober's diagnoser agent (`agents/bober-diagnoser.md`) consumes external observability data via the **MCP plugin slot** architecture (Sprint 16). You declare MCP servers in `bober.config.json`; the orchestrator starts them at diagnoser spawn time and merges their tools into the diagnoser's tool set.

## Why plugin slots (not built-in integrations)

agent-bober ships ZERO hard-coded observability integrations. The choice of logs backend (Loki, Datadog, Splunk, CloudWatch, ...), metrics backend (Prometheus, Datadog, ...), traces backend (Tempo, Jaeger, Honeycomb, ...) and errors backend (Sentry, Rollbar, ...) belongs to YOUR team. The agent-bober contract is what tools an observability MCP must expose; the IMPLEMENTATION is yours to install (or write).

## Declaring providers

```json
{
  "observability": {
    "providers": [
      {
        "name": "loki",
        "kind": "logs",
        "mcpCommand": "npx",
        "mcpArgs": ["-y", "@your-org/mcp-grafana-loki"],
        "mcpEnv": { "LOKI_URL": "https://loki.example.com", "LOKI_TOKEN": "${LOKI_TOKEN}" }
      },
      {
        "name": "datadog",
        "kind": "metrics",
        "mcpCommand": "/usr/local/bin/mcp-datadog",
        "mcpEnv": { "DD_API_KEY": "${DD_API_KEY}", "DD_APP_KEY": "${DD_APP_KEY}" }
      }
    ]
  }
}
```

`name` becomes the namespace segment — tools surface as `obs__loki__query_logs`, `obs__datadog__query_metric`, etc.

## Namespace convention

`obs__<providerName>__<upstreamToolName>`. Two providers may each define a tool called `query` — they coexist as `obs__providerA__query` and `obs__providerB__query`.

## Security

`mcpEnv` is passed verbatim to the child process and may contain API tokens. Tokens are NEVER recorded in error messages, the audit trail (`.bober/audits/`), or telemetry events (`telemetry.enabled=false` by default). They live only in the child's environment.

## Provider failure isolation

If a provider fails to start (binary missing, env var unset, handshake timeout), the diagnoser still spawns with all remaining providers' tools plus the core `Read | Bash | Grep | Glob`. A warning is written to stderr.

## Reference contracts

- [logs.md](./logs.md) — what a logs MCP must expose
- [metrics.md](./metrics.md) — metrics
- [traces.md](./traces.md) — traces
- [errors.md](./errors.md) — error tracking

## Adding a new provider category

Categories are advisory metadata (`kind: 'logs' | 'metrics' | 'traces' | 'errors' | 'custom'`). For an off-list source (e.g., feature-flag service, secrets manager, CMDB), use `kind: 'custom'`. The merge logic does not branch on `kind`.
```

**Per-category template (logs.md / metrics.md / traces.md / errors.md — ~50-80 lines each):**

```markdown
# Logs MCP Server Contract

A logs MCP server declared as `{ "name": "<provider>", "kind": "logs", ... }` SHOULD expose the following tools. Names below are the upstream tool names; they surface to the diagnoser as `obs__<provider>__<tool>`.

## Required tools

### query_logs

Free-text or structured query against the logs backend, scoped by time range.

| Input field | Type | Required | Description |
|-------------|------|----------|-------------|
| `query` | string | yes | Backend-native query (LogQL, Datadog log query, etc.) |
| `timeRange.start` | string (ISO-8601) | yes | Inclusive start |
| `timeRange.end` | string (ISO-8601) | yes | Inclusive end |
| `limit` | number | no | Default 100, max 1000 |

**Output:** array of `{ timestamp, level, message, labels?, traceId? }`.

### get_log_context

Given a log ID returned by `query_logs`, fetch the surrounding ±N lines.

## Optional tools

### list_labels — discover available label keys.
### list_label_values — for autocomplete.

## Reference community implementations (NOT shipped with agent-bober)

- [`mcp-grafana-loki`](https://example.com) — Loki adapter
- [`mcp-datadog-logs`](https://example.com) — Datadog logs

agent-bober does NOT vendor these. Install whichever matches your stack and declare it in `bober.config.json`.
```

(Apply the same shape for metrics.md `query_metric`, `list_metrics`, `get_metric_metadata` — traces.md `query_traces`, `get_trace` — errors.md `query_errors`, `get_error_detail`, `get_error_breadcrumbs`. The `generatorNotes` in the contract enumerate these.)

---

### Test file path — IMPORTANT DEVIATION FROM CONTRACT

The contract's `expectedChanges` lists `tests/orchestrator/observability-mcp.test.ts`. **However, this repo's tests for new `src/` files are COLOCATED**, not under `tests/`. Evidence:

- `src/mcp/run-manager.test.ts` (NEXT to `run-manager.ts`)
- `src/orchestrator/agent-loader.test.ts`, `model-resolver.test.ts`, `code-reviewer-agent.test.ts`
- `src/orchestrator/checkpoints/audit.test.ts`, `feedback-router.test.ts`, `registry.test.ts`, `checkpoints.test.ts`
- `src/contracts/sprint-contract.test.ts`, `src/contracts/spec.test.ts`
- `src/providers/*.test.ts`, `src/graph/*.test.ts` (most), `src/discovery/*.test.ts`

`tests/` is reserved for **cross-cutting integration tests** that span multiple `src/` files (e.g., `tests/graph/mcp-client.test.ts` exercises a binary subprocess; `tests/config/graph-schema.test.ts` reads on-disk templates).

**Recommended split:**

| File | Location | What it covers |
|------|----------|----------------|
| `src/mcp/external-client.test.ts` | colocated | `ExternalMcpServer` unit tests with a tiny fixture MCP server |
| `src/orchestrator/observability/merge.test.ts` | colocated | `mergeObsTools` namespace prefix, error isolation, allSettled behaviour |
| `tests/config/graph-schema.test.ts` (extend) | existing | s16-c8 — backward-compat: bober.config.json without `observability` parses fine |
| `tests/orchestrator/observability-mcp.test.ts` | new (per contract) | End-to-end integration: declare 3 providers (one fails), call mergeObsTools, verify tool list + failure record, verify stopAll terminates all children |

This is the same pattern Sprint 13 used (`src/orchestrator/checkpoints/audit.test.ts` colocated AND a cross-cutting test under `tests/`). Document the deviation explicitly in your sprint completion notes so the evaluator does not flag the path mismatch.

---

## 2. Patterns to Follow

### Pattern A: Zod section schema with defaults (extending BoberConfigSchema)
**Source:** `src/config/schema.ts:147-166` (PipelineSectionSchema — Sprint 14)
```typescript
export const PipelineSectionSchema = z.object({
  mode: z.enum(["autopilot", "careful"]).default("autopilot"),
  checkpointMechanism: CheckpointMechanismSchema.optional(),
  checkpointOverrides: z.record(z.string(), CheckpointMechanismSchema).default({}),
  approvalTimeoutMs: z.number().int().min(1000).default(86_400_000),
});
```
**Rule:** every NEW field needs a `.default(...)` so existing configs without it still parse. Optional sub-sections use `.optional()` at the parent `BoberConfigSchema` level.

### Pattern B: Long-running subprocess client with SIGTERM→SIGKILL stop
**Source:** `src/graph/mcp-client.ts:104-148` (TokensaveMcpClient.stop)
```typescript
async stop(): Promise<void> {
  this.stopping = true;
  this.rejectAllPending(makeGraphError("GRAPH_ERROR", "engine stopped"));
  const child = this.child;
  if (!child || child.exitCode !== null) { this.child = null; return; }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      resolve();
    }, 2_000);  // Sprint 16 uses 5_000 per s16-c3
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
    try { child.kill("SIGTERM"); } catch { clearTimeout(timeout); resolve(); }
  });
  this.child = null;
}
```
**Rule:** SIGTERM first, race against a timer, SIGKILL on timeout. Always clean up `this.child = null` so a follow-up `stop()` is idempotent.

### Pattern C: Promise.allSettled for failure-isolated fan-out
**Source:** `src/graph/client.ts:121-125`
```typescript
const dispatched = items.map((i) => this.dispatch(i));
const settled = await Promise.allSettled(dispatched);
for (let i = 0; i < settled.length; i++) {
  const r = settled[i];
  if (r.status === "fulfilled") { ... } else { /* log r.reason */ }
}
```
**Source:** `src/evaluators/plugin-loader.ts:122`
```typescript
const results = await Promise.allSettled(strategies.map(...));
```
**Rule:** use `Promise.allSettled` (NOT `Promise.all`) when partial failure must not abort the whole batch. Cite this in code comments to make the design intent explicit.

### Pattern D: stderr warnings for non-fatal config issues
**Source:** `src/config/loader.ts:244-252`
```typescript
if (cfg.pipeline.mode === "careful" && cfg.pipeline.checkpointMechanism === "noop") {
  process.stderr.write(
    "warn: pipeline.mode='careful' with checkpointMechanism='noop' — checkpoints will auto-approve. " +
    "Did you mean 'disk' or 'cli'?\n",
  );
}
```
**Source:** `src/mcp/server.ts:100-105`
```typescript
process.stderr.write(
  `[agent-bober mcp] graph tool registration skipped: ${
    err instanceof Error ? err.message : String(err)
  }\n`,
);
```
**Rule:** the project uses `process.stderr.write(...)` directly for spawn-time warnings (NOT `logger.warn`). Match the bracket-prefix `[bober obs] ...` style.

### Pattern E: MCP SDK import style
**Source:** `src/mcp/server.ts:13-20`
```typescript
import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
```
**Rule:** subpath imports with `.js` extension on leaf files (ESM TypeScript convention used repo-wide). For the CLIENT side, mirror as `@modelcontextprotocol/sdk/client/index.js` and `@modelcontextprotocol/sdk/client/stdio.js`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `execa` | `node_modules/execa` (re-exported nowhere — import directly) | `execa(command, args?, opts?) → Subprocess` | Spawn subprocess. Used 12+ places in `src/`. Prefer SDK's `StdioClientTransport` for MCP children, but `execa` is the underlying primitive if you need it. |
| `logger` | `src/utils/logger.ts` | `logger.info/warn/error/debug/success/phase/progress(...)` | Project-wide structured logger. Used in `src/graph/mcp-client.ts:17`. NOTE: this writes to stderr-adjacent channels — for raw spawn warnings, the codebase uses `process.stderr.write` directly (Pattern D). |
| `BoberConfig` type | `src/config/schema.ts:238` (`type BoberConfig = z.infer<typeof BoberConfigSchema>`) | type | The top-level config type. Add the new `observability` field to BoberConfigSchema and BoberConfig type updates automatically via `z.infer`. |
| `BoberConfigSchema.safeParse(...)` | `src/config/schema.ts:226` | `(value) → { success, data?, error? }` | The validation entry point. Tests in `tests/config/graph-schema.test.ts:32-109` use `safeParse` (not `parse`) so they can inspect issues. |
| `loadConfig(projectRoot)` | `src/config/loader.ts:141` | `(string) → Promise<BoberConfig>` | Full load + merge + validate. Test exercises in `tests/config/graph-schema.test.ts:141-158`. |
| `Subprocess` type | `import type { Subprocess } from "execa"` | type | Used in `src/graph/mcp-client.ts:14, 71` for typed child references. |
| Existing MCP server | `src/mcp/server.ts:55` (`createBoberMCPServer`) | `(projectRoot) → Promise<Server>` | DO NOT TOUCH — this is the SERVER side. Sprint 16 is the CLIENT side. |
| `registerTool / getAllTools` | `src/mcp/tools/index.ts:9, 47` | tool registry | Used by the SERVER to register agent-bober's OWN tools. Sprint 16's merged obs tools do NOT go through this registry — they live in the diagnoser's spawn-time tool list. |
| `resolveRoleTools` | `src/orchestrator/tools/index.ts:176` | `(role, projectRoot, ctx?, graphDeps?) → ToolSet` | Builds the base tool set for an orchestrator agent role. The diagnoser is NOT in `ROLE_TOOLS` (line 60-68) — Sprint 24 will add it. Your `mergeObsTools` returns a list compatible with what Sprint 24 will compose. |
| `Promise.allSettled` (native) | n/a | builtin | Used in `src/graph/client.ts:123` and `src/evaluators/plugin-loader.ts:122` for failure-isolated parallelism. |
| `randomUUID` | `node:crypto` | `() → string` | Used in `src/mcp/run-manager.ts:83` for runId. You probably don't need this for Sprint 16, but if you want to give each spawn a session id, this is the convention. |

**Crucial non-duplication check:** the `TokensaveMcpClient` class (`src/graph/mcp-client.ts:67`) is structurally similar to `ExternalMcpServer` but is SPECIFIC to the tokensave binary and uses raw JSON-RPC framing. Do NOT try to generalize it — the SDK already does the framing, and tokensave's circuit breaker is graph-specific and not appropriate for observability MCPs (per evaluatorNotes, failed providers are simply dropped from the merge, not retried).

---

## 4. Prior Sprint Output

### Sprint 14: pipeline.mode / checkpointMechanism / overrides / timeouts
**Modified:** `src/config/schema.ts` (added `PipelineSectionSchema` Sprint 14 fields), `tests/config/graph-schema.test.ts` (added backward-compat block at lines 111-182).
**Connection to this sprint:** mirror the EXACT same backward-compat test pattern. The block at lines 113-182 of that file ("Sprint 14 — backward-compat") is your template for the Sprint 16 backward-compat block. Add a similar `describe("Sprint 16 — backward-compat: ...")` block.

### Sprint 15: bober-diagnoser.md agent definition
**Created:** `agents/bober-diagnoser.md` (244 lines, tools `Read | Bash | Grep | Glob`, model `sonnet`).
**Connection to this sprint:**
- Sprint 15 already pre-declares the integration (lines 25, 28) — "Sprint 16 wires this." Sprint 16 fulfills that promise by adding the new `## Observability MCP Tools` section AND updating the line 28 forward-link to point to the new section instead of "(Sprint 16 wires this)".
- Diagnoser is NOT yet spawned anywhere — Sprint 24 spawns it. Your merge helper must therefore be tested in isolation, not through a live spawn.
- The diagnoser's `supportingEvidence.source` enum (line 91) already lists `'observability-mcp:tempo'` as an example. Your new section should reinforce: providers contribute to that source convention as `observability-mcp:<providerName>`.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` file checked in — searched `.bober/` directory listing. The project's behavioral principles live in the agent .md files (e.g., the diagnoser's "Iron Law", "Red Flags", "Rationalization Prevention" sections). For this sprint the relevant principle from `agents/bober-diagnoser.md:208-218` is **"If your primary data source is down, record that as a hypothesis ... Do not invent values."** — the diagnoser is told to TREAT missing observability as a hypothesis, which exactly maps to the error-isolation contract (s16-c4): a failing provider must surface as "no tools from this provider" rather than crashing.

### Architecture Decisions
- **PlanSpec (`.bober/specs/spec-20260524-bober-vision.json`):**
  - Line 50: "MCP plugin slots are declared as additions to bober.config.json `observability.providers` array; the diagnoser agent's tool list is computed at spawn time by merging core tools with configured MCP servers"
  - Line 60: "Specific observability MCP integrations (Datadog/Sentry/Grafana/etc.) shipped in core" is OUT OF SCOPE — "Reference adapter docs ARE in scope (one example .md per major observability category)"
  - Line 136 (AC3): "bober.config.json existing files (pre-this-spec) parse successfully with the extended schema after defaults are applied; new fields (... observability.providers, ...) all have sensible defaults preserving current behavior."
  - Line 171: "observability MCP slots run user-configured commands only — no credential storage in agent-bober artifacts"

- **Sprint 28 (telemetry, future):** the contract for Sprint 28 (`sprint-spec-20260524-bober-vision-28.json:9, 33`) explicitly forbids telemetry from including "observability MCP response bodies" — this means even when telemetry lands later, the obs MCP tool RESULTS won't leak into telemetry. Sprint 16 should set up its own logs/errors to follow the same discipline.

### Other Docs
- `CLAUDE.md` (user-level, not repo-level) recommends using `code-review-graph` MCP tools first, but for THIS subagent task (write a Sprint Briefing) standard file reads were appropriate because we're cataloguing concrete code locations.
- No `CONTRIBUTING.md` in repo root. The CLI is invoked via `npm run` scripts in `package.json` lines 13-19.

---

## 6. Testing Patterns

### Vitest Setup
**Source:** `package.json:18` (`"test": "vitest"`), all `.test.ts` files use `vitest`.
**Runner:** vitest
**Assertion style:** `expect(x).toBe(y) / .toEqual(...) / .toMatchObject(...) / .rejects.toThrow(...)`
**Mock approach:** `vi.fn()`, `vi.mock("module-name", () => ({ ... }))`, `vi.resetModules()` between tests when module-level singletons matter.
**File naming:** `<source-file>.test.ts` (colocated) for unit tests; `tests/<category>/<feature>.test.ts` for integration.

### Unit Test Pattern — colocated unit test with `vi.fn()` mocks
**Source:** `src/mcp/run-manager.test.ts:14-95`
```typescript
import { describe, it, expect, vi } from "vitest";
import { RunManager } from "./run-manager.js";

describe("RunManager", () => {
  describe("startRun()", () => {
    it("returns a non-empty runId string immediately", () => {
      const manager = new RunManager();
      const neverResolves = new Promise<PipelineResult>(() => { /* hangs */ });
      const mockPipeline = vi.fn().mockReturnValue(neverResolves);
      const runId = manager.startRun("task", "/tmp", makeFakeConfig(), mockPipeline);
      expect(typeof runId).toBe("string");
      expect(runId.length).toBeGreaterThan(0);
    });

    it("throws when called while already running", () => {
      const manager = new RunManager();
      const mockPipeline = vi.fn().mockReturnValue(new Promise<PipelineResult>(() => {}));
      manager.startRun("first", "/tmp", makeFakeConfig(), mockPipeline);
      expect(() => manager.startRun("second", "/tmp", makeFakeConfig(), mockPipeline)).toThrow(/already running/);
    });
  });
});
```

### Integration test with a child-process MCP server
**Source:** `tests/graph/mcp-client.test.ts:33-112` (fake-subprocess pattern via `vi.mock("execa")` + `PassThrough` streams)

Two viable approaches for Sprint 16. **Recommended: approach (B) — fixture script** because it tests the SDK transport end-to-end, including real stdio framing and signal handling.

#### Approach A — mock the SDK Client (fast, no subprocess)
```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({ tools: [{ name: "query_logs" }] }),
    callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({ pid: 99999 })),
}));

import { ExternalMcpServer } from "./external-client.js";

it("listTools returns server tools after start", async () => {
  const srv = new ExternalMcpServer({
    name: "fake", kind: "logs", mcpCommand: "node", enabled: true,
  });
  await srv.start();
  const tools = await srv.listTools();
  expect(tools).toEqual([{ name: "query_logs", description: undefined, inputSchema: undefined }]);
});
```

#### Approach B — real fixture MCP server (recommended for integration test)
Write a tiny Node script that speaks the MCP protocol via the SDK's `Server` (the same one `src/mcp/server.ts` uses). Place it under `tests/orchestrator/fixtures/fake-obs-mcp.mjs`:

```javascript
// tests/orchestrator/fixtures/fake-obs-mcp.mjs — minimal MCP server for tests.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const NAME = process.env.FAKE_MCP_NAME ?? "fake";
const TOOLS = (process.env.FAKE_MCP_TOOLS ?? "query").split(",").map((n) => ({
  name: n, description: `fake tool ${n}`, inputSchema: { type: "object", properties: {} },
}));

const server = new Server({ name: NAME, version: "0.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: "text", text: JSON.stringify({ tool: req.params.name, args: req.params.arguments }) }],
}));

// Optional crash-on-start flag for failure-isolation tests.
if (process.env.FAKE_MCP_CRASH === "1") {
  process.stderr.write("fake mcp crashing intentionally\n");
  process.exit(1);
}
// Optional hang-on-stop flag — never exits on SIGTERM (for SIGKILL test).
if (process.env.FAKE_MCP_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => { /* swallow */ });
}

await server.connect(new StdioServerTransport());
```

Test pattern using the fixture:

```typescript
// tests/orchestrator/observability-mcp.test.ts
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mergeObsTools, stopAll } from "../../src/orchestrator/observability/merge.js";
import type { ObservabilityProvider } from "../../src/config/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "fixtures/fake-obs-mcp.mjs");

function provider(name: string, env: Record<string,string> = {}): ObservabilityProvider {
  return { name, kind: "logs", mcpCommand: process.execPath, mcpArgs: [FIXTURE], mcpEnv: env, enabled: true };
}

describe("mergeObsTools (Sprint 16 — observability MCP plugin slots)", () => {
  it("merges tools from a single provider with obs__<name>__<tool> prefix", async () => {
    const { tools, servers, failures } = await mergeObsTools([
      provider("datadog", { FAKE_MCP_NAME: "datadog", FAKE_MCP_TOOLS: "query_logs,get_log_context" }),
    ]);
    expect(failures).toEqual({});
    expect(tools.map((t) => t.name).sort()).toEqual([
      "obs__datadog__get_log_context",
      "obs__datadog__query_logs",
    ]);
    await stopAll(servers);
  });

  it("namespace prevents collisions across providers (s16-c6)", async () => {
    const { tools, servers } = await mergeObsTools([
      provider("provA", { FAKE_MCP_NAME: "provA", FAKE_MCP_TOOLS: "query" }),
      provider("provB", { FAKE_MCP_NAME: "provB", FAKE_MCP_TOOLS: "query" }),
    ]);
    expect(tools.map((t) => t.name).sort()).toEqual(["obs__provA__query", "obs__provB__query"]);
    await stopAll(servers);
  });

  it("isolates a single provider failure (s16-c4)", async () => {
    const { tools, servers, failures } = await mergeObsTools([
      provider("good", { FAKE_MCP_NAME: "good", FAKE_MCP_TOOLS: "query" }),
      provider("bad",  { FAKE_MCP_NAME: "bad",  FAKE_MCP_CRASH: "1" }),
    ]);
    expect(tools.map((t) => t.name)).toEqual(["obs__good__query"]);
    expect(failures.bad).toMatch(/./);  // some non-empty error
    expect(failures.good).toBeUndefined();
    await stopAll(servers);
  });

  it("all-failure case: tools is empty, failures populated, diagnoser would spawn with core tools only", async () => {
    const { tools, servers, failures } = await mergeObsTools([
      provider("a", { FAKE_MCP_CRASH: "1" }),
      provider("b", { FAKE_MCP_CRASH: "1" }),
    ]);
    expect(tools).toEqual([]);
    expect(Object.keys(failures).sort()).toEqual(["a", "b"]);
    await stopAll(servers);
  });

  it("stopAll reaps all children (no zombies)", async () => {
    const { servers } = await mergeObsTools([provider("x"), provider("y"), provider("z")]);
    const pids = servers.map((s) => (s as unknown as { transport: { pid?: number } }).transport?.pid);
    await stopAll(servers);
    // After stopAll, attempting to signal each pid should fail with ESRCH (no such process).
    for (const pid of pids) {
      if (pid != null) {
        let err: NodeJS.ErrnoException | null = null;
        try { process.kill(pid, 0); } catch (e) { err = e as NodeJS.ErrnoException; }
        expect(err?.code).toBe("ESRCH");
      }
    }
  });

  it("SIGTERM hang triggers SIGKILL within 5s (s16-c3)", async () => {
    const { servers } = await mergeObsTools([
      provider("hung", { FAKE_MCP_IGNORE_SIGTERM: "1" }),
    ]);
    const start = Date.now();
    await stopAll(servers);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(6_000);  // SIGKILL within 5s grace + overhead
    expect(elapsed).toBeGreaterThanOrEqual(4_900);  // SIGTERM grace actually waited
  }, 10_000);
});
```

### Backward-compat test (s16-c8) — extend tests/config/graph-schema.test.ts
**Source:** `tests/config/graph-schema.test.ts:111-182` (Sprint 14 backward-compat block)

Add a parallel block:

```typescript
describe("Sprint 16 — backward-compat: existing bober.config.json parses without observability (s16-c8)", () => {
  it("repo's bober.config.json (no observability section) parses successfully via BoberConfigSchema", async () => {
    const raw = await readFile(resolve(repoRoot, "bober.config.json"), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const result = BoberConfigSchema.safeParse(parsed);
    expect(result.success, `bober.config.json parse failed: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    if (result.success) {
      expect(result.data.observability).toBeUndefined();
    }
  });

  it("loadConfig returns config with observability undefined when no section present", async () => {
    const config = await loadConfig(repoRoot);
    expect(config.observability).toBeUndefined();
  });

  it("BoberConfigSchema accepts observability section with providers array", () => {
    const minimalWithObs = {
      project: { name: "test", mode: "brownfield" },
      planner: {}, generator: {}, evaluator: { strategies: [] },
      sprint: {}, pipeline: {}, commands: {},
      observability: {
        providers: [
          { name: "loki", kind: "logs", mcpCommand: "npx", mcpArgs: ["mcp-grafana-loki"] },
        ],
      },
    };
    const result = BoberConfigSchema.safeParse(minimalWithObs);
    expect(result.success, `parse failed: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    if (result.success) {
      expect(result.data.observability?.providers).toHaveLength(1);
      expect(result.data.observability?.providers[0].enabled).toBe(true); // default
    }
  });

  it("observability.providers defaults to [] when section is present but providers omitted", () => {
    const minimalEmpty = {
      project: { name: "test", mode: "brownfield" },
      planner: {}, generator: {}, evaluator: { strategies: [] },
      sprint: {}, pipeline: {}, commands: {},
      observability: {},
    };
    const result = BoberConfigSchema.safeParse(minimalEmpty);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.observability?.providers).toEqual([]);
  });
});
```

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break

| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `tests/config/graph-schema.test.ts` | `src/config/schema.ts` (BoberConfigSchema shape) | LOW | Add Sprint 16 backward-compat block alongside existing Sprint 14 block. Existing tests at lines 32-109 already validate "no graph section" — they should still pass unchanged. |
| `src/config/loader.ts:185-227` (the literal merge defaults) | `BoberConfigSchema` shape | LOW | No code change required (observability is `.optional()` at top level, has no hard-coded fallback in the literal). Verify via the backward-compat test. |
| `src/config/defaults.ts` | `BoberConfig` type | LOW | `Partial<BoberConfig>` accepts the new optional field — type compatibility maintained. No code change required. |
| `src/mcp/server.ts` | `BoberConfig` (via `loadConfig`) | LOW | The SERVER-side file is unaffected — Sprint 16 adds CLIENT-side code. Just verify build still passes. |
| `src/orchestrator/pipeline.ts` | `BoberConfig` | LOW | Reads `config.observability` is not added by THIS sprint; Sprint 24 does. No code change. |
| `agents/bober-diagnoser.md` line 28 | (text only) | LOW | Update forward link from "(Sprint 16 wires this)" to reference the new section. Pure documentation change. |
| Templates `templates/brownfield/bober.config.json`, `templates/presets/*/bober.config.json` | parse via PartialBoberConfigSchema | LOW | No template change required — they omit `observability`. The existing test at `tests/config/graph-schema.test.ts:46-60` ("every preset template parses without graph section") proves the optionality pattern. |
| `bober.config.json` (repo root) | parse | LOW | Currently has no observability section. After Sprint 16, it still parses fine because the section is optional. |
| `tests/graph/mcp-client.test.ts` | `vi.mock("execa", ...)` | LOW | This test mocks `execa` globally for tokensave. Sprint 16's `ExternalMcpServer` uses the SDK's `StdioClientTransport` (not `execa` directly), so the existing mock does not interfere — but if you co-locate `external-client.test.ts` in `src/mcp/` it lives in a SEPARATE test file so module-level mocks don't leak across files. |

### Existing Tests That Must Still Pass

Tests that touch the modified paths:

- `tests/config/graph-schema.test.ts` — ALL existing blocks (Sprint 14 backward-compat, graph-section backward-compat) must still pass. Adding new fields with defaults must not change any existing assertion.
- `tests/mcp/external-server-graph.test.ts` (the existing test for the SERVER side) — should be unaffected; verify still passes.
- `tests/mcp/graph-tools.test.ts` — unaffected by client-side changes.
- `src/mcp/run-manager.test.ts` — unaffected (no schema dependency in this file's mock config).
- `tests/graph/mcp-client.test.ts` — unaffected (TokensaveMcpClient is separate code path).
- `src/orchestrator/*.test.ts` (`agent-loader.test.ts`, `model-resolver.test.ts`, `code-reviewer-agent.test.ts`) — unaffected; they don't touch BoberConfig.observability.

### Features That Could Be Affected

- **Sprint 24 (/bober-incident pipeline)** — will IMPORT `mergeObsTools` from `src/orchestrator/observability/merge.ts` and call it at diagnoser spawn time. Keep the API minimal and pure so Sprint 24 can compose it freely. Specifically: the function signature should NOT take a `projectRoot` or a full `BoberConfig` — it should take only the `ObservabilityProvider[]` array so Sprint 24 can inject it from anywhere.
- **Sprint 22 (SLO verification)** — `verifyResolution` will use `obs__<provider>__query_metric`. Your namespace convention must be stable: `obs__<providerName>__<upstreamToolName>` is the contract.
- **Sprint 28 (config migration + telemetry)** — the contract `sprint-spec-20260524-bober-vision-28.json:9` already expects `observability.providers=[]` as the default. Your Sprint 16 schema must produce exactly this default (verified by the backward-compat test).
- **Sprint 28 telemetry privacy** — Sprint 28 contract line 33 forbids telemetry from including "observability MCP response bodies." Your `sanitizeError` helper sets the precedent — when telemetry lands, the SAME redaction discipline applies. Document this in code comments.

### Recommended Regression Checks

After implementation, the Generator MUST verify:

1. `npm run typecheck` exits 0 — no broken types in any consumer of `BoberConfig`.
2. `npm run lint` exits 0 — new files conform to ESLint rules.
3. `npm run build` exits 0 — `tsc` compiles all new and modified files.
4. `npm run test` exits 0 — all existing tests pass plus new Sprint 16 tests.
5. `grep -E 'obs__|observability\.providers' agents/bober-diagnoser.md` returns non-zero matches (s16-c7 verification).
6. `ls docs/observability-mcps/` lists exactly 5 files: `README.md logs.md metrics.md traces.md errors.md` (s16-c5).
7. `grep -RE "(LOKI_TOKEN|DD_API_KEY|API_KEY|TOKEN)=" docs/observability-mcps/` finds only example placeholders inside fenced code blocks (no actual secret values).
8. `grep -RE "import .* from ['\"]@datadog|import .* from ['\"]@sentry|import .* from ['\"]grafana" docs/observability-mcps/ src/` finds zero matches (s16-c5 contract-only enforcement).
9. Manual: read `src/orchestrator/observability/merge.ts` — verify `Promise.allSettled` is used (not `Promise.all`) and no `provider.mcpEnv` access appears in any error message or log line.
10. Run the Sprint 16 integration test ALONE: `npx vitest run tests/orchestrator/observability-mcp.test.ts` — should pass in <10s and leave zero zombie node processes (`ps -A | grep fake-obs-mcp` should return empty after).

---

## 8. Implementation Sequence

Build in dependency order so each step is independently verifiable.

1. **`src/config/schema.ts`** — add `ObservabilityProviderKindSchema`, `ObservabilityProviderSchema`, `ObservabilitySectionSchema`, and the optional `observability` field on `BoberConfigSchema`.
   - Verify: `npm run typecheck` exits 0; `tests/config/graph-schema.test.ts` existing tests still pass.

2. **`src/config/index.ts`** — re-export the new types/schemas (optional but consistent with the existing barrel).
   - Verify: `npm run build` exits 0.

3. **`tests/config/graph-schema.test.ts`** — add the Sprint 16 backward-compat describe block (s16-c8).
   - Verify: `npx vitest run tests/config/graph-schema.test.ts` all pass.

4. **`src/mcp/external-client.ts`** — implement `ExternalMcpServer` class (start/listTools/callTool/stop).
   - Verify: `npm run typecheck`. Manual: SDK imports resolve at compile time.

5. **`src/mcp/external-client.test.ts`** — colocated unit tests with mocked SDK Client (Approach A from §6) — fastest feedback for class logic.
   - Verify: `npx vitest run src/mcp/external-client.test.ts` passes.

6. **`src/orchestrator/observability/merge.ts`** — implement `mergeObsTools`, `stopAll`, `namespaceToolName`, `sanitizeError`. Use `Promise.allSettled`.
   - Verify: `npm run typecheck`.

7. **`src/orchestrator/observability/merge.test.ts`** — colocated unit tests for the merge helper using mocked `ExternalMcpServer` (vi.mock the './external-client.js' module).
   - Verify: `npx vitest run src/orchestrator/observability/merge.test.ts` passes.

8. **`src/orchestrator/observability/index.ts`** — barrel exporting `mergeObsTools`, `stopAll`, `ExternalMcpServer` re-export, types.
   - Verify: `npm run build` exits 0.

9. **`tests/orchestrator/fixtures/fake-obs-mcp.mjs`** — fixture MCP server script.
   - Verify: `node tests/orchestrator/fixtures/fake-obs-mcp.mjs` starts cleanly with FAKE_MCP_TOOLS=q, then Ctrl-C cleanly exits. Crash-mode (`FAKE_MCP_CRASH=1`) exits 1 immediately.

10. **`tests/orchestrator/observability-mcp.test.ts`** — integration tests using the fixture script (5 tests from §6 Approach B).
    - Verify: `npx vitest run tests/orchestrator/observability-mcp.test.ts` all pass; no zombies after.

11. **`agents/bober-diagnoser.md`** — update line 28 forward link, add `## Observability MCP Tools` section between line 167 and line 202.
    - Verify: `wc -l agents/bober-diagnoser.md` shows total ≤ ~290 lines (was 244). `grep -c 'obs__' agents/bober-diagnoser.md` ≥ 3.

12. **`docs/observability-mcps/`** — create directory + 5 markdown files (README, logs, metrics, traces, errors). CONTRACT-ONLY.
    - Verify: `ls docs/observability-mcps/ | wc -l` = 5. Manual: each .md contains ZERO code blocks importing or instantiating a real vendor SDK.

13. **Run full verification** — `npm run typecheck && npm run lint && npm run build && npm run test`. All must exit 0.

---

## 9. Pitfalls & Warnings

1. **DO NOT vendor `@datadog/*`, `@sentry/*`, `grafana-*` or any observability vendor package.** This is the central scope violation evaluator notes flag (s16-c5, evaluatorNotes). Reference adapter docs name community implementations but do not import them. Adding such an import will cause the evaluator to reject this sprint.

2. **DO NOT leak `mcpEnv` in error messages.** `provider.mcpEnv` may contain `DD_API_KEY`, `LOKI_TOKEN`, etc. Audit every `throw new Error(...)`, `process.stderr.write(...)`, `logger.warn(...)` for accidental inclusion. Defensive: route all error rendering through `sanitizeError(err)`.

3. **DO NOT shoehorn the merge logic into `src/orchestrator/subagent-spawn.ts`** — that file does not exist. Creating it as a stub would be dead code until Sprint 24. Ship the pure helper at `src/orchestrator/observability/merge.ts` and document in the contract completion notes that Sprint 24 will compose it.

4. **DO NOT add the obs__ tool names to `agents/bober-diagnoser.md` frontmatter `tools:`** list. Per Sprint 15 design (briefing line 64), the frontmatter is the CORE list only; MCP-merged tools are runtime additions. Putting them in frontmatter implies static availability, which would mislead the model when providers are absent.

5. **DO NOT use raw JSON-RPC framing.** `@modelcontextprotocol/sdk` v1.28.0 is already in package.json — use `Client` + `StdioClientTransport`. Hand-rolled framing duplicates code and gets out of sync with protocol updates. The single exception in the repo (`src/graph/mcp-client.ts`) predates the SDK upgrade and targets a non-MCP-compliant binary; do not copy that pattern.

6. **DO NOT use `Promise.all` for the merge fan-out.** `Promise.all` rejects on first failure — a single bad provider would crash the entire merge. The contract (s16-c4) explicitly requires isolation; `Promise.allSettled` is mandatory.

7. **DO NOT forget the SIGKILL fallback.** The contract (s16-c3) requires SIGTERM → 5s → SIGKILL. The SDK's `Client.close()` sends SIGTERM but does not enforce the kill timeout. Wrap with the `Promise.race` + `setTimeout` pattern from `src/graph/mcp-client.ts:122-144`.

8. **The colocated-vs-tests/-path question.** The contract names `tests/orchestrator/observability-mcp.test.ts`. Sprints 5/7/8/10/11/12/13 all colocate. Recommended: ship BOTH — colocated unit tests AND a `tests/orchestrator/observability-mcp.test.ts` integration test using the fixture script. Document the split in the sprint completion notes.

9. **ESM import extensions.** All TypeScript imports in this repo use `.js` extensions (e.g., `from "./external-client.js"` even though the file is `.ts`). The `package.json` `"type": "module"` enforces this. Forgetting the `.js` extension will pass typecheck (TS knows) but BREAK the runtime build because `tsc` doesn't rewrite imports.

10. **Fixture script extension.** The fixture MCP server should be `.mjs` (or `.js` in an `.mjs`-equivalent way) so `process.execPath tests/orchestrator/fixtures/fake-obs-mcp.mjs` runs without a build step. If you make it `.ts`, you need `tsx`/`ts-node`, which adds a dependency and slows the test. Recommended: `.mjs` with no transpilation.

11. **Test cleanup discipline.** Every test in `tests/orchestrator/observability-mcp.test.ts` MUST call `await stopAll(servers)` in either the test body or an `afterEach`. Otherwise child processes leak across test runs on macOS/Linux and the test suite gets progressively slower. Consider an `afterEach(() => stopAll(allServers))` helper if writing many tests.

12. **The diagnoser spawn site does not exist yet.** Do NOT search for "where bober-diagnoser is invoked" and integrate there. Sprint 24 creates that integration. Sprint 16's deliverable is the API surface (`mergeObsTools`) plus its tests; the wiring happens in Sprint 24 (`/bober-incident` skill + `src/incident/orchestrator.ts` per sprint 24's contract).

13. **Defaults precedence with optional sections.** Zod's `.default(...)` only fires when the FIELD is present but its sub-value is undefined. If the entire `observability` section is omitted (most common case for existing configs), the `providers: z.array(...).default([])` default does NOT fire — `result.data.observability` is `undefined`. Your downstream code should handle both shapes: `config.observability?.providers ?? []`. Document this in `mergeObsTools` callers.

14. **`StdioClientTransport` `env` field overrides PATH.** The SDK's `getDefaultEnvironment()` only inherits a small allowlist of env vars (see `node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js`). If you pass `env: provider.mcpEnv`, the child may not find `node`, `npx`, etc. Always merge with `process.env` first: `env: { ...process.env, ...provider.mcpEnv }`. The example in section 1's `ExternalMcpServer.start()` shows the correct pattern.

