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

## Provider fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Unique identifier. Alphanumeric + underscore only. Becomes the namespace segment. |
| `kind` | yes | Category: `logs` \| `metrics` \| `traces` \| `errors` \| `custom` |
| `mcpCommand` | yes | Executable to spawn (e.g., `"node"`, `"npx"`, `"/usr/local/bin/mcp-grafana"`) |
| `mcpArgs` | no | Command-line arguments array |
| `mcpEnv` | no | Environment variables passed to the child process. May contain secrets — see Security section. |
| `enabled` | no | Default `true`. Set `false` to disable without removing the declaration. |

## Namespace convention

`obs__<providerName>__<upstreamToolName>`. Two providers may each define a tool called `query` — they coexist as `obs__providerA__query` and `obs__providerB__query` without collision.

## Security

`mcpEnv` is passed verbatim to the child process and may contain API tokens. Tokens are NEVER recorded in error messages, the audit trail (`.bober/audits/`), or telemetry events (`telemetry.enabled=false` by default). They live only in the child's environment.

The orchestrator sanitizes error messages from failed provider starts — any `KEY=VALUE` pattern is redacted to `[redacted]` before being written to stderr or stored in the failure record.

## Provider failure isolation

If a provider fails to start (binary missing, env var unset, handshake timeout), the diagnoser still spawns with all remaining providers' tools plus the core `Read | Bash | Grep | Glob`. A warning is written to stderr:

```
[bober obs] provider "loki" failed to start: ExternalMcpServer "loki" failed to connect: ...
```

## Lifecycle

- **Start**: spawned in parallel at diagnoser spawn time using `Promise.allSettled` (failures do not block other providers)
- **Stop**: `SIGTERM` → 5s grace period → `SIGKILL` if still alive; all providers stopped in parallel when the diagnoser exits

## Reference contracts

- [logs.md](./logs.md) — what a logs MCP must expose
- [metrics.md](./metrics.md) — metrics tools contract
- [traces.md](./traces.md) — distributed tracing tools contract
- [errors.md](./errors.md) — error tracking tools contract

## Adding a new provider category

Categories are advisory metadata (`kind: 'logs' | 'metrics' | 'traces' | 'errors' | 'custom'`). For an off-list source (e.g., feature-flag service, secrets manager, CMDB), use `kind: 'custom'`. The merge logic does not branch on `kind` — all providers are treated uniformly.
