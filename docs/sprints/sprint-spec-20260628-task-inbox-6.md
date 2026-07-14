# Gmail thread to task (egress-gated bonus)

**Contract:** sprint-spec-20260628-task-inbox-6  ·  **Spec:** spec-20260628-task-inbox  ·  **Completed:** 2026-06-29

## What this sprint added

Sprint 6 adds an **opt-in** `bober task from-gmail <thread>` subcommand that turns a single Gmail
thread into a captured task — and is **default-off**. A new isolated `taskInbox` config section
introduces one boolean axis, `gmailEgress` (default `false`). With the axis off (the default), the
command prints an opt-in refusal, sets `exitCode=1`, and **constructs no MCP client and makes no
network call** — the build performs zero Gmail egress out of the box. With the axis explicitly
enabled (and an `observability` provider named `gmail`), the command reads one thread through the
existing `ExternalMcpServer` MCP connector, parses it **locally** into an open `action` Finding (title
from the thread subject), and captures it through the **sprint-1 `captureTask`** write path. Any
connector failure is caught, surfaced on stderr with `exitCode=1`, and **sanitized** so connector
env vars / tokens never leak. This is the final sprint of the task-inbox plan.

## Public surface

- `TaskInboxSectionSchema` / `taskInbox` config section (`src/config/schema.ts:341`) — a new Zod
  object `{ gmailEgress: z.boolean().default(false) }`, wired as the **optional** `taskInbox` key on
  `BoberConfigSchema` (`src/config/schema.ts:498`). Because it is optional and not `.strict()`,
  existing configs parse byte-identically. The medical `EgressGuard` axes are untouched — this is a
  separate, isolated axis.
- `bober task from-gmail <thread>` CLI subcommand (`src/cli/commands/task.ts:455`) — resolves the
  gmail axis **fail-closed** (any config error ⇒ disabled), refuses with no MCP construction when off,
  and otherwise reads the thread + captures the task. `<thread>` is an opaque thread reference passed
  straight to the connector.
- `parseGmailThread(payload)` (`src/hub/gmail-to-task.ts:90`) — **pure** (no clock, no network).
  Tolerantly extracts the subject from `{ subject }`, `{ messages: [{ subject }] }`, or an MCP SDK
  envelope `{ content: [{ text: "<json>" }] }`, falling back to `"(no subject)"`. Returns a
  `ParsedGmailThread` `{ title, kind: "action", status: "open", tags: ["source:gmail"] }`.
- `fromGmailTask({ egressAllowed, mcp, threadRef, store, now, toolName? })` (`src/hub/gmail-to-task.ts:123`)
  — the DI core. **Throws BEFORE touching `mcp`** (no `mcp.start()`, no `mcp.callTool()`) when
  `egressAllowed` is false; otherwise calls `mcp.callTool` once, parses locally, and captures via
  `captureTask` (the **only** write path, `domain: "gmail"`). Returns the captured `Finding`.
- `sanitizeConnectorError(msg)` (`src/hub/gmail-to-task.ts:103`) — strips `KEY=VALUE` env assignments
  (`/\b[A-Z_][A-Z0-9_]*=\S+/g` → `[redacted]`), the **same regex** as `src/mcp/external-client.ts:69`
  (replicated because there is no exported sanitizer to import).
- `runTaskFromGmail(store, mcp, threadRef, egressAllowed, now)` (`src/cli/commands/task.ts:311`) — the
  never-throwing DI wrapper: prints the captured Finding on success, sanitizes + `exitCode=1` on any
  error, and always attempts `mcp.stop()` in a `finally`.
- `GmailMcpLike` (`src/hub/gmail-to-task.ts:26`) and `DEFAULT_GMAIL_READ_TOOL = "gmail_read_thread"`
  (`src/hub/gmail-to-task.ts:35`) — the minimal injected MCP surface (`ExternalMcpServer` satisfies it
  structurally; tests stub `callTool`) and the default tool name.

## How to use / how it fits

By default the command refuses and touches nothing:

```text
$ bober task from-gmail 18f0a...        # taskInbox.gmailEgress unset/false (the default)
task from-gmail: Gmail egress not enabled — set taskInbox.gmailEgress: true in bober.config.json to opt in.
# exitCode=1, no MCP client constructed, zero network
```

To opt in, set the axis **and** declare an enabled `observability` provider named `gmail` (reusing
the existing external-MCP connector machinery) in `bober.config.json`:

```jsonc
{
  "taskInbox": { "gmailEgress": true },
  "observability": {
    "providers": [
      { "name": "gmail", "kind": "custom", "mcpCommand": "npx",
        "mcpArgs": ["-y", "some-gmail-mcp-server"], "enabled": true }
    ]
  }
}
```

```text
$ bober task from-gmail 18f0a...
Captured task 1f3c9a0b2e4d6f80 from Gmail
  title: Pay invoice
```

The captured item is an **ordinary open `action` Finding** in the unified hub pool — the exact row
`bober task add` writes — so it immediately appears in `bober task list`, `bober hub list`, and is
eligible for ranking by `priority` / `decide` / `bober chat hub`. The capture path is the **same
`captureTask` reused from Sprint 1**; this sprint adds an egress-gated *source*, not a second write
path. If the axis is on but no enabled `gmail` provider is configured, the command reports that on
stderr with `exitCode=1` rather than guessing.

## Notes for maintainers

- **Default-off, no-network-when-disabled.** The opt-in gate fires at two layers: the CLI
  (`from-gmail` resolves `config.taskInbox?.gmailEgress ?? false` and `return`s **before** any
  `ExternalMcpServer` construction) and the core (`fromGmailTask` throws **before** `mcp.start()` /
  `mcp.callTool()`). `sc-6-2` proves the latter with a stub whose `callTool` spy must stay
  `not.toHaveBeenCalled()`. Do not move the gate below the connector construction.
- **Fail-closed config.** Config resolution is wrapped so a **missing or invalid** config ⇒ axis
  disabled (`gmailAllowed = false`), never an enabled-by-accident path.
- **Error sanitization is load-bearing.** Every connector-error surface runs through
  `sanitizeConnectorError`, whose regex is intentionally **identical** to
  `src/mcp/external-client.ts:69`. `sc-6-4` feeds an error string containing a fake `GMAIL_TOKEN=...`
  and asserts the secret never reaches stderr (only `[redacted]`). If `external-client.ts`'s regex
  ever changes, keep this copy in lockstep (or refactor to a shared export).
- **`parseGmailThread` is pure; the clock stays at the boundary.** The only `new Date()` is stamped in
  the CLI handler and injected as `now`. Keep the parser network/clock-free.
- **Single write path.** Capture reuses `captureTask` from `src/hub/task-inbox.ts` with
  `domain: "gmail"` — do **not** re-implement persistence or call `writeFinding`/`ingestFinding`
  directly from this module.
- **Additive config.** `taskInbox` is optional and not `.strict()`, so every existing
  `bober.config.json` parses unchanged. No medical-`EgressGuard` axis was touched and no new runtime
  dependency was added (the MCP SDK was already present).
- **Intentional limitation.** This reads **one thread on demand** — there is no Gmail polling, label
  automation, or general sync. The thread reference and tool arg shape are passed opaquely; the
  default tool name is `gmail_read_thread` (override via `toolName`).

## Scope

Commit `55d6878`: 5 files changed, **+462 / -1** — `src/config/schema.ts` (+11: the new
`TaskInboxSectionSchema` + optional `taskInbox` key), `src/hub/gmail-to-task.ts` (new, +147: the
`GmailMcpLike` surface, pure `parseGmailThread`, `sanitizeConnectorError`, and the refuse-before-MCP
`fromGmailTask`), and `src/cli/commands/task.ts` (+102: `runTaskFromGmail` DI core and the
`from-gmail` subcommand with the fail-closed gate), plus the collocated tests
`src/hub/gmail-to-task.test.ts` (new, 12 tests) and `src/cli/commands/task.test.ts` (+3 CLI tests).
**No** new dependency. All five criteria (`sc-6-1..sc-6-5`) passed on iteration 1 (**zero reworks**);
eval `eval-sprint-spec-20260628-task-inbox-6-1` → **pass** (5/5 required), full suite **3309 → 3324**
green, build + typecheck + lint clean (0 errors).

> **Plan complete (6/6).** This closes `spec-20260628-task-inbox`: `add` (Sprint 1), `list` +
> `start`/`done`/`drop` (Sprint 2), `snooze` + wake-aware filtering (Sprint 3), the domain-finding
> `ingest` seam (Sprint 4), chat intent-detection capture (Sprint 5), and this egress-gated
> `from-gmail` source (Sprint 6) — all on the single `captureTask` write path into the unified hub pool.
