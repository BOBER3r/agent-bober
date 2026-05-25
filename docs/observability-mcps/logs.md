# Logs MCP Server Contract

A logs MCP server declared as `{ "name": "<provider>", "kind": "logs", ... }` SHOULD expose the following tools. Names below are the upstream tool names; they surface to the diagnoser as `obs__<provider>__<tool>`.

## Required tools

### `query_logs`

Free-text or structured query against the logs backend, scoped by time range.

| Input field | Type | Required | Description |
|-------------|------|----------|-------------|
| `query` | string | yes | Backend-native query string (LogQL, Datadog log query, Splunk SPL, etc.) |
| `timeRange.start` | string (ISO-8601) | yes | Inclusive start time |
| `timeRange.end` | string (ISO-8601) | yes | Inclusive end time |
| `limit` | number | no | Max results to return. Default 100, max 1000. |

**Output:** array of log entries:
```
[
  {
    "timestamp": "<ISO-8601>",
    "level": "error | warn | info | debug | trace",
    "message": "<log line text>",
    "labels": { "<key>": "<value>", ... },
    "traceId": "<optional trace correlation ID>"
  }
]
```

### `get_log_context`

Given a log ID returned by `query_logs`, fetch the surrounding context lines.

| Input field | Type | Required | Description |
|-------------|------|----------|-------------|
| `logId` | string | yes | Identifier of the target log entry |
| `windowLines` | number | no | Lines before and after to include. Default 10. |

**Output:** same shape as `query_logs` results, ordered by timestamp.

## Optional tools

### `list_labels`

Discover available label keys in the logs backend. Useful for building queries.

**Output:** `{ "labels": ["<key>", ...] }`

### `list_label_values`

For a given label key, enumerate its known values (autocomplete support).

| Input field | Type | Required | Description |
|-------------|------|----------|-------------|
| `label` | string | yes | Label key to look up |
| `timeRange` | object | no | Scope to a time window |

**Output:** `{ "values": ["<value>", ...] }`

### `get_log_stats`

Aggregate counts or rates for a query (useful for detecting anomalous log volume spikes).

| Input field | Type | Required | Description |
|-------------|------|----------|-------------|
| `query` | string | yes | Same format as `query_logs.query` |
| `timeRange` | object | yes | Time window |
| `step` | string | no | Bucket width (e.g., `"5m"`, `"1h"`) |

**Output:** time-series array of `{ timestamp, count }` objects.

## Diagnoser usage

The diagnoser cites logs evidence in `supportingEvidence.source` as `observability-mcp:<providerName>`:

```json
{
  "source": "observability-mcp:loki",
  "path": "query_logs(query='level=error', timeRange={...})",
  "snippet": "2026-05-01T14:30:00Z ERROR auth-service: JWT validation failed for user_id=42"
}
```

## Reference community implementations (NOT shipped with agent-bober)

- [`mcp-grafana`](https://github.com/grafana/mcp-grafana) — Grafana/Loki adapter (community)
- [`mcp-datadog-logs`](https://github.com/datadog/mcp-datadog) — Datadog logs (community)

agent-bober does NOT vendor these. Install whichever matches your stack and declare it in `bober.config.json`.
