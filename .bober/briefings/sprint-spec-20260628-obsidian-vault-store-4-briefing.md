# Sprint Briefing: On-device Obsidian MCP read/write adapter + config

**Contract:** sprint-spec-20260628-obsidian-vault-store-4
**Generated:** 2026-06-28T00:00:00.000Z

> Goal: (1) add an optional `vault` config section mirroring `ObservabilityProviderSchema`, and
> (2) add `src/vault/mcp-adapter.ts` — a thin `VaultMcpAdapter` that WRAPS the existing
> `ExternalMcpServer` (do NOT fork it) to readNote/writeNote/listNotes via configurable tool
> names, with an `isOnDevice()` guard that refuses non-local declarations BEFORE `start()`.
> Depends only on Sprint 1 (`VaultNote` + `parseNote`/`serializeNote`).

---

## 1. Target Files

### `src/config/schema.ts` (modify)

**Mirror this exact shape — `ObservabilityProviderSchema`, lines 298-309:**
```ts
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
export type ObservabilityProvider = z.infer<typeof ObservabilityProviderSchema>;   // line 309
```
The new section drops `kind` (Obsidian MCP has no kind) and adds an optional `toolNames`
record. Reuse the `name` regex, `mcpCommand`/`mcpArgs`/`mcpEnv` lines verbatim.

**Insertion site — `BoberConfigSchema`, lines 419-450 (optional top-level sections):**
```ts
export const BoberConfigSchema = z.object({
  project: ProjectSectionSchema,
  ...
  // ── Phase 6: medical team egress config ──
  medical: MedicalSectionSchema.optional(),        // line 447
  // ── Phase B: fleet blackboard (child-visible channel) ──
  fleet: FleetSectionSchema.optional(),            // line 449
});                                                 // line 450
```
Add `vault: VaultSectionSchema.optional(),` as the LAST optional entry (before line 450),
following the exact `// ── comment ──` + `<key>: <Schema>.optional(),` style.
`BoberConfigSchema` has **no `.strict()`/`.passthrough()`** (verified: zero matches) — so adding
an optional field is backward-compatible and existing configs still parse.

**zod record / optional / default idioms already in this file (use these for `toolNames`):**
- `z.record(z.string(), z.string()).optional()` — `mcpEnv`, schema.ts:306 (string→string map)
- `z.record(z.string(), z.unknown()).optional()` — `providerConfig`, schema.ts:354
- `z.record(z.string(), TeamConfigSchema).optional()` — `teams`, schema.ts:444
- `z.boolean().default(true)` — `enabled`, schema.ts:307
- Nested optional sub-object with defaults — `MedicalSectionSchema.egress`, schema.ts:378-387

**Recommended `VaultSectionSchema` skeleton (generator fills tool-name defaults):**
```ts
// ── Vault Section (Sprint 4 — on-device Obsidian MCP) ────────────────
export const VaultObsidianSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9_]+$/i, "name must be alphanumeric/underscore"),
  mcpCommand: z.string().min(1),
  mcpArgs: z.array(z.string()).optional(),
  mcpEnv: z.record(z.string(), z.string()).optional(),   // SECRETS — never log
  enabled: z.boolean().default(true),
  /** Override server tool names per logical op; cyanheads defaults applied at the adapter. */
  toolNames: z
    .object({
      readNote: z.string().optional(),
      writeNote: z.string().optional(),
      listNotes: z.string().optional(),
    })
    .optional(),
});
export const VaultSectionSchema = z.object({ obsidian: VaultObsidianSchema.optional() });
export type VaultSection = z.infer<typeof VaultSectionSchema>;
```

**Imports this file already has:** `import { z } from "zod"` (top of file). No new imports needed.
**Imported by:** ~everything via `BoberConfig`/`ObservabilityProvider` types. Adding an OPTIONAL
field does not break existing consumers (see §7).
**Test file:** `src/config/schema.test.ts` — EXISTS (add a `VaultSectionSchema` describe block).

---

### `src/vault/mcp-adapter.ts` (create)

**Directory pattern:** `src/vault/*.ts` use a leading `/** ... */` module doc block, then
`import ... from "./x.js"` (ESM `.js` extensions), then `// ── Section ──` banners. See
`src/vault/note-io.ts:1-19` and `src/vault/reindex.ts:1-30`.

**Most similar existing files (follow their structure):**
- `src/vault/note-io.ts` — the FS analog: `readNote`/`writeNote`/`listNotes` over `parseNote`/
  `serializeNote`. The MCP adapter is the SAME three ops over an injected MCP server instead of fs.
  Do NOT recreate note-io; the adapter is a parallel surface (the FS one is for sprint-2/3 reindex).
- `src/incident/resolution-verify.ts:83-95` — the canonical "inject a minimal interface so tests
  fake it" pattern (`MetricQueryClient` + `deps.client?`).

**Structure template (skeleton — names/defaults are generator decisions):**
```ts
/** VaultMcpAdapter — read/write/list Obsidian notes via a WRAPPED ExternalMcpServer. */
import type { ToolDescriptor } from "../mcp/external-client.js";   // NOT re-exported by mcp/index.ts
import type { VaultSection } from "../config/schema.js";
import type { VaultNote } from "./types.js";
import { parseNote, serializeNote } from "./frontmatter.js";

/** Minimal injectable surface — ExternalMcpServer satisfies this; tests pass a fake. */
export interface McpServerLike {
  start(): Promise<void>;
  listTools(): Promise<ToolDescriptor[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
  stop(): Promise<void>;
}

export const DEFAULT_VAULT_TOOL_NAMES = {
  readNote: "obsidian_read_file",      // generator: confirm cyanheads names; MUST stay overridable
  writeNote: "obsidian_update_file",
  listNotes: "obsidian_list_files_in_dir",
} as const;

export class VaultMcpAdapter {
  constructor(
    private readonly server: McpServerLike,
    private readonly config: NonNullable<VaultSection["obsidian"]>,
  ) {}
  // readNote(path) -> callTool(read) -> parseNote(markdown, path)
  // writeNote(note) -> callTool(write, { path: note.path, content: serializeNote(note) })
  // listNotes(dir?) -> callTool(list) -> string[]
}
```

> NOTE: cyanheads/obsidian-mcp-server exact tool names are NOT in this repo or the research doc
> (research-20260627 line 49 only says "14 tools: read/write/search/surgical-frontmatter").
> Pick documented defaults, expose them as `DEFAULT_VAULT_TOOL_NAMES`, and let `config.toolNames`
> override each — the OVERRIDABILITY is the hard requirement (non-goal: vendor lock-in), not the
> specific default strings.

---

## 2. Patterns to Follow

### ExternalMcpServer method surface (wrap, do not fork)
**Source:** `src/mcp/external-client.ts`, lines 24-105
```ts
export interface ToolDescriptor { name: string; description?: string; inputSchema?: unknown; }  // 24-28
export class ExternalMcpServer {
  constructor(private readonly provider: ObservabilityProvider) {}     // 36
  get name(): string { return this.provider.name; }                    // 38-40
  async start(): Promise<void> { ... }                                 // 42 (idempotent; spawns stdio child)
  async listTools(): Promise<ToolDescriptor[]> { ... }                 // 81
  async callTool(name: string, args: unknown): Promise<unknown> { ... }// 95
  async stop(): Promise<void> { ... }                                  // 105
}
```
**Rule:** Inject `{ start, listTools, callTool, stop }` (the `McpServerLike` interface above) so the
adapter accepts a real `ExternalMcpServer` in prod and a fake in tests; never construct/spawn inside.

### mcpEnv secret-handling discipline (mirror this — NON-GOAL to violate)
**Source:** `src/mcp/external-client.ts`, lines 10-12 and 66-77
```ts
// SECURITY: providerConfig.mcpEnv may contain API tokens. NEVER include the
// env contents in error messages, log lines, or returned errors. Only the
// provider NAME is safe to expose externally.                        // 10-12
...
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  const sanitized = msg.replace(/\b[A-Z_][A-Z0-9_]*=\S+/g, "[redacted]");  // 69 strip KEY=VALUE
  throw new Error(
    `ExternalMcpServer "${this.provider.name}" failed to connect: ${sanitized}`,  // 74-75 name only
    { cause: err },
  );
}
```
**Rule:** Any error the adapter throws may include `config.obsidian.name` but NEVER `mcpEnv`
(no `JSON.stringify(config)`, no `${config.mcpEnv}`, no spreading config into a log). The evaluator
greps the adapter for exactly this — there must be zero code paths that stringify `mcpEnv`.

### callTool result envelope parsing (for readNote/listNotes)
**Source:** `src/incident/resolution-verify.ts`, lines 250-275 (defensive envelope parse)
```ts
// The MCP SDK callTool returns { content: [{type:'text',text:...}], isError }.   // 251
const candidate = raw as { dataPoints?: unknown; content?: Array<{ text?: string }> };
...
if (Array.isArray(candidate.content) && candidate.content[0]?.text) {             // 261
  const parsed = JSON.parse(candidate.content[0].text);                          // 263
  ...
}
```
Also seen live in `tests/e2e/four-modes.test.ts:869-875`:
```ts
const content = result as { content?: Array<{ text?: string }> };
const parsed = JSON.parse(content.content![0]!.text!) as { ... };
```
**Rule:** `callTool` returns `unknown`. readNote must extract the markdown string from the SDK
envelope (`result.content[0].text`) before `parseNote(markdown, path)`; tolerate both a raw string
and the `{ content: [{ text }] }` shape defensively. Mock fakes return `{ content:[{type:"text",text}] }`.

### Production wrap sequence (the order the adapter mirrors, with guard inserted)
**Source:** `src/orchestrator/observability/merge.ts:77-90` — `new ExternalMcpServer(p)` -> `start()`
-> `listTools()` -> ... -> `stop()`. The adapter inserts `if (!isOnDevice(cfg)) throw ...` BEFORE `start()`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `parseNote` | `src/vault/frontmatter.ts:172` | `(raw: string, path: string): VaultNote` | Parse MCP-returned markdown into a VaultNote (use for readNote). |
| `serializeNote` | `src/vault/frontmatter.ts:180` | `(note: VaultNote): string` | Serialize a VaultNote to raw markdown (use for writeNote). |
| `parseFrontmatter` | `src/vault/frontmatter.ts:53` | `(raw): { frontmatter; body }` | Lower-level parse; `parseNote` wraps it — don't call directly. |
| `serializeFrontmatter` | `src/vault/frontmatter.ts:145` | `(frontmatter, body): string` | Lower-level serialize; `serializeNote` wraps it. |
| `ExternalMcpServer` | `src/mcp/external-client.ts:30` | `class { start; listTools; callTool; stop }` | The MCP stdio server to WRAP (non-goal: fork it). |
| `ToolDescriptor` | `src/mcp/external-client.ts:24` | `{ name; description?; inputSchema? }` | `listTools()` return element type — import for `McpServerLike`. |
| `ObservabilityProviderSchema` | `src/config/schema.ts:298` | `z.object` | The shape `VaultSectionSchema` mirrors. |
| `VaultNote` | `src/vault/types.ts:12` | `{ frontmatter; body; path }` | Sprint-1 return/arg type for read/write. |

> `ToolDescriptor` and `ExternalMcpServer` are NOT re-exported from `src/mcp/index.ts` (barrel only
> exports `server` + `tools`, verified) — import directly from `../mcp/external-client.js`.
> Utilities reviewed: `src/utils/` (`fs.ts` ensureDir used by note-io), `src/vault/` — none other applicable.

---

## 4. Prior Sprint Output

### Sprint 1: VaultNote model + frontmatter pure functions
**Created:** `src/vault/types.ts` — exports `interface VaultNote { frontmatter: Record<string,unknown>; body: string; path: string }` (types.ts:12-22) and `type NoteStatus` (types.ts:30).
**Created:** `src/vault/frontmatter.ts` — exports `parseNote(raw, path): VaultNote` (172) and `serializeNote(note): string` (180), both PURE (no fs/clock).
**Connection:** `readNote` parses MCP markdown via `parseNote`; `writeNote` serializes via `serializeNote`. This is the ONLY dependency — Sprints 2/3 (reindex/FactStore) are out of scope.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` found at repo root (not checked into a discoverable path for this sprint).
Governing constraints come from the contract `nonGoals`/`outOfScope`: wrap not fork external-client,
never log `mcpEnv`, on-device only (no OAuth/cloud sync), tool names overridable, do not wire into
the reindex CLI.

### Architecture Decisions
`.bober/architecture/` exists but no ADR specific to the vault-store sprint was found. The relevant
in-code "ADR" is the SECURITY contract in `src/mcp/external-client.ts:10-17` (mcpEnv opacity +
best-effort error isolation). Mirror it.

### Other Docs
Research grounding: `.bober/research/research-20260627-knowledge-platform-landscape.md:49,148` —
"Obsidian is the v1 UI"; AI reads/writes via community MCP servers (cyanheads/obsidian-mcp-server,
Obsidian Local REST API plugin's built-in MCP). This is why tool names must be overridable.

---

## 6. Testing Patterns

### Unit Test Pattern — config schema round-trip (sc-4-2)
**Source:** `src/config/schema.test.ts:126-162`
```ts
import { describe, it, expect } from "vitest";
import { BoberConfigSchema } from "./schema.js";

const minimalBase = {
  project: { name: "test-project", mode: "greenfield" },
  planner: {}, generator: {}, evaluator: { strategies: [] },
  sprint: {}, pipeline: {}, commands: {},
};

it("parses a config with a complete vault.obsidian section and round-trips mcpEnv", () => {
  const result = BoberConfigSchema.safeParse({
    ...minimalBase,
    vault: { obsidian: {
      name: "obsidian", mcpCommand: "npx",
      mcpArgs: ["-y", "obsidian-mcp-server"],
      mcpEnv: { OBSIDIAN_API_KEY: "secret" },
      toolNames: { readNote: "custom_read" },
    } },
  });
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.vault?.obsidian?.mcpEnv?.OBSIDIAN_API_KEY).toBe("secret"); // round-trip
    expect(result.data.vault?.obsidian?.toolNames?.readNote).toBe("custom_read");
  }
});
```
**Runner:** vitest. **Assertion style:** `expect(...)`. **File naming:** `<name>.test.ts`,
co-located. Also assert `vault` is `undefined` when omitted (mirror schema.test.ts:137-143).

### Unit Test Pattern — inject a fake server + assert exact tool name (sc-4-3)
**DI-fake-interface source:** `src/incident/resolution-verify.ts:83-95` (interface + `deps.client?`)
and `tests/incident/resolution-verify.test.ts:40-42`:
```ts
function fakeClient(samples: MetricSample[]): MetricQueryClient {
  return { async queryMetric() { return samples; } };     // a hand-rolled fake of the injected interface
}
// injected at the call site: verifyResolution(id, criteria, { ..., client: fakeClient(samples) })  // :89
```
**callTool result shape a fake should return** (from `src/mcp/external-client.test.ts:20-22`):
```ts
const mockCallTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
```
**Exact-name assertion** (from `external-client.test.ts:149-155`):
```ts
expect(mockCallTool).toHaveBeenCalledWith({ name: "query_logs", arguments: { query: "error" } });
```
**Template for the adapter test:**
```ts
import { describe, it, expect, vi } from "vitest";
const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "---\ntitle: x\n---\nbody" }] });
const fakeServer = { start: vi.fn().mockResolvedValue(undefined), listTools: vi.fn(), callTool,
                     stop: vi.fn().mockResolvedValue(undefined) };
const adapter = new VaultMcpAdapter(fakeServer, { name: "obsidian", mcpCommand: "npx", enabled: true,
                     toolNames: { readNote: "custom_read" } });
const note = await adapter.readNote("Notes/x.md");
expect(callTool).toHaveBeenCalledWith("custom_read", expect.anything());   // OVERRIDE took effect
expect(note.frontmatter.title).toBe("x");                                  // parsed via parseNote
// default-name test: omit toolNames -> expect callTool called with DEFAULT_VAULT_TOOL_NAMES.readNote
```

### Unit Test Pattern — on-device guard refuses + start() NEVER called (sc-4-4)
**never-called assertion source:** `src/mcp/external-client.test.ts:179-183`
```ts
it("is safe to call without ever calling start()", async () => {
  const srv = new ExternalMcpServer(makeProvider());
  await expect(srv.stop()).resolves.toBeUndefined();
  expect(mockClose).not.toHaveBeenCalled();   // <-- the "never invoked" pattern
});
```
**Template:**
```ts
const startSpy = vi.fn();
const fakeServer = { start: startSpy, listTools: vi.fn(), callTool: vi.fn(), stop: vi.fn() };
const adapter = new VaultMcpAdapter(fakeServer, {
  name: "remote", mcpCommand: "https://obsidian.example.com/mcp", enabled: true,  // non-local
});
await expect(adapter.readNote("x.md")).rejects.toThrow(/on-?device|local/i);
expect(startSpy).not.toHaveBeenCalled();   // guard fired BEFORE any spawn
```

> No "mock-mcp-server fake implementing start/callTool injected into a wrapper" precedent exists for
> a WRAPPER yet — `external-client.test.ts` mocks the SDK via `vi.mock`, while `resolution-verify.test.ts`
> hand-rolls a fake of an injected interface. For this sprint use the resolution-verify hand-rolled-fake
> approach (cleaner: no `vi.mock`, the adapter takes the server by constructor injection).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| every `BoberConfig` consumer | `schema.ts` BoberConfigSchema | low | Adding an OPTIONAL `vault` field is non-strict & backward-compatible (no `.strict()` — verified); existing configs still parse. |
| `src/config/loader.ts` | `BoberConfigSchema` / `PartialBoberConfigSchema` | low | `deepPartial().extend(...)` at schema.ts:457 auto-includes new optional fields; loader needs no change. |
| `src/config/defaults.ts` | `createDefaultConfig` (schema.ts:474) | low | `vault` is optional and absent by default — do NOT add a default vault section. |
| `src/mcp/external-client.ts` | (none — adapter imports IT) | none | NON-GOAL to modify. Adapter imports `ExternalMcpServer`/`ToolDescriptor`; keep that surface untouched. |
| `src/vault/frontmatter.ts` | (adapter imports IT) | none | `parseNote`/`serializeNote` are PURE & unchanged. |

### Existing Tests That Must Still Pass
- `src/config/schema.test.ts` — existing BoberConfig optional-section tests; your new `vault` describe block must not alter the `minimalBase` expectations.
- `src/config/loader.test.ts` — config load/parse; verify it still parses with no `vault`.
- `src/config/role-providers.test.ts` — consumes BoberConfig; unaffected by an optional field.
- `src/mcp/external-client.test.ts` — must stay green (you do not touch external-client.ts).
- `src/vault/frontmatter.test.ts`, `src/vault/note-io.test.ts`, `src/vault/reindex.test.ts`, `src/vault/index-map.test.ts` — sprint-1..3 vault tests; the adapter is additive and must not regress them.

### Features That Could Be Affected
- **Observability MCP (Sprint 16)** — shares `ObservabilityProviderSchema` + `ExternalMcpServer`. You reuse, not modify, both. Verify `merge.ts`/`resolution-verify.ts` behavior is untouched (no edits to those files).
- **Vault reindex (Sprints 2/3)** — shares `parseNote`/`serializeNote`/`VaultNote`. Out of scope to wire MCP→FactStore; keep the adapter an independent read/write surface (non-goal: wire into reindex CLI).

### Recommended Regression Checks
1. `npm run build` — tsc clean (sc-4-1).
2. `npm test -- src/config/schema.test.ts src/vault/mcp-adapter.test.ts` — new tests pass.
3. `npm test` — full suite, zero pre-existing regressions (stopCondition).
4. `grep -n "mcpEnv" src/vault/mcp-adapter.ts` — confirm `mcpEnv` is only passed to the server config, never stringified into an error/log (evaluator check).

---

## 8. On-Device Guard Predicate (generator decision — concrete recommendation)

`ExternalMcpServer` ONLY ever connects via `StdioClientTransport` spawning a LOCAL child
(`external-client.ts:48-56`) — there is **no network transport and no `url`/`host` field** in the
schema. So a "non-local network endpoint" can only be expressed through `mcpCommand`/`mcpArgs`. The
guard must therefore inspect those two (NEVER `mcpEnv` values — secrets).

**Recommended `isOnDevice(cfg)` predicate (document it in a JSDoc on the function):**
- REJECT if `mcpCommand` matches a URL scheme: `/^(https?|wss?|ftp|tcp):\/\//i`.
- REJECT if any `mcpArgs` element contains a `<scheme>://<host>` whose host is NOT a loopback/local
  host (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`), OR a `--url`/`--host`/`--endpoint`/`--remote`
  flag pointing at a non-loopback host.
- ACCEPT a bare executable (`node`, `npx`, `/abs/path/bin`, `python`) whose args carry no remote URL.
- Run the guard at the TOP of the first method that would `start()` (or in the constructor) — the
  test asserts `start()` is never reached on rejection, so it must precede the wrapped `start()`.

Throw a clear `Error` like `VaultMcpAdapter refuses non-local server "<name>": on-device only`
— include the server NAME, never `mcpEnv`.

---

## 9. Implementation Sequence

1. **`src/config/schema.ts`** — add `VaultObsidianSchema` + `VaultSectionSchema` + `type VaultSection`
   right after `FleetSection` (≈line 416); register `vault: VaultSectionSchema.optional()` in
   `BoberConfigSchema` before line 450.
   - Verify: `npm run build` clean; `BoberConfigSchema.safeParse({...minimal, vault:{...}}).success === true`.
2. **`src/vault/mcp-adapter.ts`** — define `McpServerLike`, `DEFAULT_VAULT_TOOL_NAMES`, `isOnDevice`,
   and `VaultMcpAdapter` (constructor-injected server; readNote/writeNote/listNotes; guard before start).
   Import `ToolDescriptor` from `../mcp/external-client.js`, `parseNote`/`serializeNote` from
   `./frontmatter.js`, `VaultNote` from `./types.js`, `VaultSection` from `../config/schema.js`.
   - Verify: `npm run build` clean; no `mcpEnv` ever interpolated into a string.
3. **`src/config/schema.test.ts`** — add a `VaultSectionSchema` describe block: round-trips mcpEnv +
   toolNames (sc-4-2), and `vault` is `undefined` when omitted.
   - Verify: `npm test -- src/config/schema.test.ts` green.
4. **`src/vault/mcp-adapter.test.ts`** — fake-server injection asserting exact tool NAME called
   (default + override) and parsed `VaultNote` result (sc-4-3); non-local declaration rejected with
   `expect(startSpy).not.toHaveBeenCalled()` (sc-4-4).
   - Verify: `npm test -- src/vault/mcp-adapter.test.ts` green.
5. **Full verification** — `npm run build`, then `npm test` (no pre-existing test regresses).

---

## 10. Pitfalls & Warnings

- **Do NOT modify `src/mcp/external-client.ts`** (explicit non-goal). Wrap it; import its types.
- **`ExternalMcpServer`/`ToolDescriptor` are NOT in the `src/mcp/index.ts` barrel** — import directly
  from `../mcp/external-client.js`, not `../mcp/index.js`.
- **Never stringify `mcpEnv`** — no `JSON.stringify(config)`, no template-literal of the whole config,
  no logging the provider object. Errors may name the server but nothing else (external-client.ts:10-12).
- **`callTool` returns `unknown`** — you MUST narrow/parse the `{ content: [{ text }] }` envelope
  before `parseNote`. A raw cast to `string` will compile-fail or yield `[object Object]`.
- **Guard runs BEFORE `start()`** — if you guard inside/after `start()`, sc-4-4 fails because the
  fake's `start` spy will have been called. Constructor-time or first-line-of-method guarding is safest.
- **`vault` is optional and has NO default** — do not add it to `createDefaultConfig`/`defaults.ts`;
  the PartialBoberConfig `deepPartial()` (schema.ts:457) picks it up automatically.
- **cyanheads tool names are unknown to the repo** — defaults are placeholders; the REQUIREMENT is
  that `config.obsidian.toolNames` overrides them (test both the default-name and override-name paths).
- **ESM `.js` extensions** on every relative import (this is a `"type":"module"` codebase).
