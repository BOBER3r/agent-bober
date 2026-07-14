# On-device Obsidian MCP read/write adapter + config

**Contract:** sprint-spec-20260628-obsidian-vault-store-4  ·  **Spec:** spec-20260628-obsidian-vault-store  ·  **Completed:** 2026-06-28

## What this sprint added

The **fourth of the 5-sprint vault storage layer** (`spec-20260628-obsidian-vault-store`). Sprints
1–3 built the canonical note model, the derived FactStore index, and the `bober vault reindex` CLI —
all reading notes from the **local filesystem** via `note-io`. This sprint adds an **independent
read/write surface**: a config schema section that declares an **on-device Obsidian MCP server**, and
a thin `VaultMcpAdapter` that wraps the existing `ExternalMcpServer` to read, write, and list vault
notes through configurable MCP tool names. A hard **on-device-only guard** rejects any non-local
server declaration **before** the server is ever spawned, and MCP env secrets are never logged. The
adapter is **not** wired into the reindex CLI — it is a standalone surface for talking to a running
Obsidian MCP server.

## Public surface

- `VaultObsidianSchema` / `VaultObsidian` type (`src/config/schema.ts:424`) — Zod schema for one
  on-device Obsidian MCP server. Mirrors `ObservabilityProviderSchema` but drops `kind` and adds
  `toolNames`: `{ name, mcpCommand, mcpArgs?, mcpEnv?, enabled (default true), toolNames? }`. `name`
  is constrained to alphanumeric/underscore (it appears in error messages); `mcpEnv` is a string
  record treated as **opaque secrets**.
- `VaultSectionSchema` / `VaultSection` type (`src/config/schema.ts:448`) — wraps the obsidian schema
  as `{ obsidian?: VaultObsidian }`, registered as the optional top-level `vault` field on
  `BoberConfigSchema` (`src/config/schema.ts:485`). Omitting `vault` parses to `undefined` — no
  behavior change for existing configs.
- `VaultMcpAdapter` class (`src/vault/mcp-adapter.ts:133`) — constructor-injected with an
  `McpServerLike` and a resolved `VaultSection["obsidian"]` config. Exposes
  `readNote(path): Promise<VaultNote>`, `writeNote(note: VaultNote): Promise<void>`,
  `listNotes(dir?): Promise<string[]>`, and `stop(): Promise<void>`. `readNote`/`writeNote`/`listNotes`
  each run the on-device guard, then `start()` the server, then `callTool` the configured tool name.
- `McpServerLike` interface (`src/vault/mcp-adapter.ts:31`) — the minimal `{ start, listTools,
  callTool, stop }` surface that `ExternalMcpServer` already satisfies, so tests inject a hand-rolled
  fake without spawning a subprocess. The adapter depends on this interface, **not** the concrete
  class — `src/mcp/external-client.ts` is untouched (wrapped, not forked).
- `DEFAULT_VAULT_TOOL_NAMES` (`src/vault/mcp-adapter.ts:45`) — the cyanheads/obsidian-mcp-server
  default tool-name mapping (`readNote: "obsidian_read_file"`, `writeNote: "obsidian_update_file"`,
  `listNotes: "obsidian_list_files_in_dir"`). Each entry is overridable via `config.toolNames` to
  target a different server (e.g. the Obsidian Local REST API plugin's built-in MCP).
- `isOnDevice(cfg): boolean` (`src/vault/mcp-adapter.ts:80`) — the exported on-device predicate.
  Returns `false` if `mcpCommand` matches a remote URL scheme (`https?|wss?|ftp|tcp://`) or any
  `mcpArgs` element embeds a non-loopback host; accepts bare executables and loopback-only args. It
  **never inspects `mcpEnv`** (secrets must not drive guard logic).

## How to use / how it fits

Declare an on-device Obsidian MCP server in `bober.config.json`:

```jsonc
{
  "vault": {
    "obsidian": {
      "name": "my_vault",
      "mcpCommand": "npx",
      "mcpArgs": ["-y", "obsidian-mcp-server"],
      "mcpEnv": { "OBSIDIAN_API_KEY": "..." },   // opaque secret — never logged
      "toolNames": {                              // optional — overrides the cyanheads defaults
        "readNote": "custom_read",
        "writeNote": "custom_write",
        "listNotes": "list_vault_files"
      }
    }
  }
}
```

```ts
const server = new ExternalMcpServer(provider); // satisfies McpServerLike
const adapter = new VaultMcpAdapter(server, config.vault.obsidian);
const note = await adapter.readNote("Notes/Foo.md"); // VaultNote (sprint-1 parseNote)
await adapter.writeNote(note);                        // sprint-1 serializeNote → write tool
const paths = await adapter.listNotes("Notes");
```

`readNote` parses the MCP server's returned markdown through the **Sprint 1** `parseNote` into a
`VaultNote`; `writeNote` serializes a `VaultNote` through the Sprint 1 `serializeNote` before calling
the write tool. The adapter tolerates both a raw-string `callTool` result and the SDK envelope
`{ content: [{ text }] }`, and `listNotes` JSON-parses the payload or falls back to newline-splitting.

## Notes for maintainers

- **The on-device guard is a deliberate security/privacy boundary, not a convenience check.** It runs
  inside `guardOnDevice()` (`src/vault/mcp-adapter.ts:157`) **before** `server.start()` on every read/
  write/list, so a non-local declaration is refused with `start()` never invoked (the eval asserts
  `startSpy.not.toHaveBeenCalled` on all three methods). If a remote-transport MCP server is ever
  needed, add a **new** adapter — do not relax this guard.
- **MCP env secrets are never surfaced.** Only `config.name` appears in the refusal error
  (`VaultMcpAdapter refuses non-local server "<name>": on-device only`). No code path stringifies
  `mcpEnv` into a log line, error, or thrown string — this mirrors the secret discipline in
  `src/mcp/external-client.ts`. The `name` field's alphanumeric/underscore constraint keeps it safe to
  echo.
- **Tool names are intentionally vendor-agnostic.** The defaults target cyanheads/obsidian-mcp-server,
  but every logical op is overridable so the adapter is not bound to one Obsidian MCP vendor. Overrides
  are resolved **once** at construction time.
- **Not wired into reindex.** This is a standalone read/write surface; the `bober vault reindex` CLI
  (Sprint 3) still reads notes from the local filesystem via `note-io`, not through this adapter.
  Reconciling MCP-read notes into FactStore would flow through the Sprint 2/3 reindex path — out of
  scope here.
- **Process note.** Iteration 1 shipped the full implementation but failed only on the lint hard-gate
  (an unused `beforeEach` import in `mcp-adapter.test.ts:8`). Iteration 2 removed that single line
  (commit `0185daf`); no production logic changed between iterations. Implementation commit `4f5288d`.
- **Scope.** Commit `4f5288d`: `src/config/schema.ts` (+36, the vault schema), new `src/vault/mcp-adapter.ts`,
  and the collocated `src/config/schema.test.ts` / `src/vault/mcp-adapter.test.ts` (62 tests across
  the two; full suite 2907 green at iter-2). No new deps; `src/mcp/external-client.ts` untouched. All
  four criteria (sc-4-1..sc-4-4) passed at iteration 2.
