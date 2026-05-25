# Traces MCP Server Contract

A traces MCP server declared as `{ "name": "<provider>", "kind": "traces", ... }` SHOULD expose the following tools. Names below are the upstream tool names; they surface to the diagnoser as `obs__<provider>__<tool>`.

## Required tools

### `query_traces`

Search for distributed traces matching a service and time window.

| Input field | Type | Required | Description |
|-------------|------|----------|-------------|
| `service` | string | yes | Service name to query traces for |
| `timeRange.start` | string (ISO-8601) | yes | Inclusive start time |
| `timeRange.end` | string (ISO-8601) | yes | Inclusive end time |
| `limit` | number | no | Max traces to return. Default 20, max 100. |
| `minDurationMs` | number | no | Only return traces above this latency threshold (useful for finding slow requests) |
| `tags` | object | no | Key-value tag filters (e.g., `{ "http.status_code": "500" }`) |
| `error` | boolean | no | If `true`, return only traces containing an error span |

**Output:** array of trace summaries:
```
[
  {
    "traceId": "<hex trace ID>",
    "rootSpan": {
      "service": "<service name>",
      "operation": "<operation name>",
      "startTime": "<ISO-8601>",
      "durationMs": <number>,
      "status": "ok | error",
      "tags": { "<key>": "<value>", ... }
    },
    "spanCount": <number>,
    "errorSpanCount": <number>
  }
]
```

### `get_trace`

Retrieve all spans for a specific trace ID.

| Input field | Type | Required | Description |
|-------------|------|----------|-------------|
| `traceId` | string | yes | Trace identifier returned by `query_traces` |

**Output:** full trace with all spans:
```
{
  "traceId": "<trace ID>",
  "spans": [
    {
      "spanId": "<span ID>",
      "parentSpanId": "<parent ID or null>",
      "service": "<service>",
      "operation": "<operation>",
      "startTime": "<ISO-8601>",
      "durationMs": <number>,
      "status": "ok | error",
      "tags": { ... },
      "logs": [{ "timestamp": "<ISO-8601>", "fields": { ... } }]
    }
  ]
}
```

## Optional tools

### `get_trace_graph`

Return a service dependency graph derived from trace data for a given time window.

| Input field | Type | Required | Description |
|-------------|------|----------|-------------|
| `timeRange` | object | yes | Time window |

**Output:** `{ "services": ["<name>"], "edges": [{ "from": "<svc>", "to": "<svc>", "requestCount": <number>, "errorRate": <number> }] }`

### `list_services`

Enumerate all services that have emitted traces in the backend.

**Output:** `{ "services": ["<name>", ...] }`

## Diagnoser usage

The diagnoser cites trace evidence as `observability-mcp:<providerName>`:

```json
{
  "source": "observability-mcp:tempo",
  "path": "get_trace(traceId='abc123')",
  "snippet": "Span auth-service.validate_token: status=error, tags={\"error.message\":\"token expired\"}, durationMs=2341"
}
```

A trace with error spans combined with a correlated log entry satisfies the Iron Law for two independent sources.

## Reference community implementations (NOT shipped with agent-bober)

- [`mcp-tempo`](https://github.com/grafana/mcp-grafana) — Grafana Tempo adapter (community)
- [`mcp-jaeger`](https://github.com/jaegertracing/jaeger) — Jaeger adapter (community)

agent-bober does NOT vendor these. Install whichever matches your stack and declare it in `bober.config.json`.
