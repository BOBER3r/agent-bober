# Metrics MCP Server Contract

A metrics MCP server declared as `{ "name": "<provider>", "kind": "metrics", ... }` SHOULD expose the following tools. Names below are the upstream tool names; they surface to the diagnoser as `obs__<provider>__<tool>`.

## Required tools

### `query_metric`

Query a named metric over a time range with an optional aggregation function.

| Input field | Type | Required | Description |
|-------------|------|----------|-------------|
| `name` | string | yes | Metric name or query expression (PromQL, Datadog query syntax, etc.) |
| `timeRange.start` | string (ISO-8601) | yes | Inclusive start time |
| `timeRange.end` | string (ISO-8601) | yes | Inclusive end time |
| `aggregation` | string | no | Aggregation function: `avg`, `sum`, `max`, `min`, `count`. Backend-specific. |
| `step` | string | no | Resolution step (e.g., `"1m"`, `"5m"`). Default chosen by backend. |
| `labels` | object | no | Label/tag filters as key-value pairs. |

**Output:** time-series data:
```
{
  "metric": "<name>",
  "labels": { "<key>": "<value>", ... },
  "dataPoints": [
    { "timestamp": "<ISO-8601>", "value": <number> }
  ]
}
```

## Optional tools

### `list_metrics`

Enumerate all available metric names (filtered by prefix or label).

| Input field | Type | Required | Description |
|-------------|------|----------|-------------|
| `prefix` | string | no | Filter metrics starting with this prefix |
| `labels` | object | no | Filter by label constraints |

**Output:** `{ "metrics": ["<name>", ...] }`

### `get_metric_metadata`

Return the description, type, and label keys for a given metric.

| Input field | Type | Required | Description |
|-------------|------|----------|-------------|
| `name` | string | yes | Metric name |

**Output:**
```
{
  "name": "<metric name>",
  "type": "counter | gauge | histogram | summary",
  "description": "<human-readable description>",
  "labels": ["<key>", ...]
}
```

### `query_instant`

Point-in-time metric evaluation (no time range — returns a single value or vector).

| Input field | Type | Required | Description |
|-------------|------|----------|-------------|
| `query` | string | yes | Metric expression |
| `time` | string (ISO-8601) | no | Evaluation time. Default: now. |

**Output:** `{ "result": [{ "labels": {...}, "value": <number> }] }`

## Diagnoser usage

The diagnoser cites metrics evidence in `supportingEvidence.source` as `observability-mcp:<providerName>`:

```json
{
  "source": "observability-mcp:datadog",
  "path": "query_metric(name='system.cpu.user', timeRange={...})",
  "snippet": "CPU user time spiked from 12% to 94% at 14:28Z on host web-01"
}
```

Metrics data combined with a correlated log entry from a different provider satisfies the Iron Law (two independent sources for medium/high confidence).

## Reference community implementations (NOT shipped with agent-bober)

- [`mcp-prometheus`](https://github.com/prometheus-community/mcp-prometheus) — Prometheus/Thanos adapter (community)
- [`mcp-datadog-metrics`](https://github.com/datadog/mcp-datadog) — Datadog metrics (community)

agent-bober does NOT vendor these. Install whichever matches your stack and declare it in `bober.config.json`.
