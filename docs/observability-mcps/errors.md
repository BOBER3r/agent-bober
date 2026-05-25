# Errors MCP Server Contract

An error-tracking MCP server declared as `{ "name": "<provider>", "kind": "errors", ... }` SHOULD expose the following tools. Names below are the upstream tool names; they surface to the diagnoser as `obs__<provider>__<tool>`.

## Required tools

### `query_errors`

Search for error events within a time range, optionally filtered by severity or service.

| Input field | Type | Required | Description |
|-------------|------|----------|-------------|
| `timeRange.start` | string (ISO-8601) | yes | Inclusive start time |
| `timeRange.end` | string (ISO-8601) | yes | Inclusive end time |
| `severity` | string | no | `fatal \| error \| warning \| info`. Default: all. |
| `service` | string | no | Filter to a specific service/project |
| `query` | string | no | Free-text search within error messages |
| `limit` | number | no | Max error groups to return. Default 20, max 100. |

**Output:** array of error group summaries:
```
[
  {
    "errorId": "<unique group identifier>",
    "title": "<exception class or error title>",
    "message": "<first occurrence message>",
    "service": "<service name>",
    "firstSeen": "<ISO-8601>",
    "lastSeen": "<ISO-8601>",
    "occurrences": <number>,
    "affectedUsers": <number>,
    "severity": "fatal | error | warning | info",
    "status": "unresolved | resolved | ignored"
  }
]
```

### `get_error_detail`

Retrieve the full detail record for a specific error ID, including the stack trace of the first (or most recent) occurrence.

| Input field | Type | Required | Description |
|-------------|------|----------|-------------|
| `errorId` | string | yes | Identifier returned by `query_errors` |

**Output:**
```
{
  "errorId": "<ID>",
  "title": "<title>",
  "message": "<message>",
  "stackTrace": "<stack trace text>",
  "service": "<service>",
  "severity": "fatal | error | warning | info",
  "tags": { "<key>": "<value>", ... },
  "context": { "<key>": "<value>", ... }
}
```

### `get_error_breadcrumbs`

Retrieve the event breadcrumb trail leading up to a specific error occurrence — useful for understanding what the user or system was doing before the crash.

| Input field | Type | Required | Description |
|-------------|------|----------|-------------|
| `errorId` | string | yes | Error group or occurrence identifier |
| `limit` | number | no | Max breadcrumbs to return. Default 50. |

**Output:**
```
{
  "breadcrumbs": [
    {
      "timestamp": "<ISO-8601>",
      "type": "navigation | http | query | ui | default",
      "category": "<string>",
      "message": "<string>",
      "level": "info | warning | error",
      "data": { "<key>": "<value>", ... }
    }
  ]
}
```

## Optional tools

### `get_error_trend`

Return occurrence counts over a time window, bucketed by step (for detecting error rate spikes).

| Input field | Type | Required | Description |
|-------------|------|----------|-------------|
| `errorId` | string | yes | Error group identifier |
| `timeRange` | object | yes | Time window |
| `step` | string | no | Bucket width (e.g., `"5m"`, `"1h"`) |

**Output:** `{ "dataPoints": [{ "timestamp": "<ISO-8601>", "count": <number> }] }`

### `list_releases`

List recent release/deploy events tracked by the error platform (useful for correlating error spikes with deploys).

**Output:** `{ "releases": [{ "version": "<string>", "createdAt": "<ISO-8601>", "service": "<string>" }] }`

## Diagnoser usage

The diagnoser cites error evidence as `observability-mcp:<providerName>`:

```json
{
  "source": "observability-mcp:sentry",
  "path": "query_errors(timeRange={...}, severity='error', service='auth-service')",
  "snippet": "AuthTokenExpired: 47 occurrences in past 30m (vs 2/h baseline), first seen 14:28Z"
}
```

Error tracking data combined with correlated trace or metrics data from a different provider satisfies the Iron Law.

## Reference community implementations (NOT shipped with agent-bober)

- [`mcp-sentry`](https://github.com/modelcontextprotocol/servers/tree/main/src/sentry) — Sentry adapter (community)
- [`mcp-rollbar`](https://rollbar.com) — Rollbar adapter (community)

agent-bober does NOT vendor these. Install whichever matches your stack and declare it in `bober.config.json`.
