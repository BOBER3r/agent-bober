# Sprint Briefing: Gmail thread to task (egress-gated bonus)

**Contract:** sprint-spec-20260628-task-inbox-6
**Generated:** 2026-06-29T00:00:00Z
**Risk:** HIGHEST in this plan — egress gate + injected MCP + a config-schema edit. Read sections 2, 3, 9 carefully.

---

## 0. The Decision You Must Make First — where the gmail egress axis lives

**RECOMMENDATION: add a NEW, isolated `taskInbox` config section with a single `gmailEgress: z.boolean().default(false)` — do NOT touch the medical `EgressGuard` and do NOT reuse `config.hub`.**

Evidence and rationale:
- The medical `EgressGuard` axes are **scoped to `config.medical.egress`** (`src/medical/egress.ts:25-31` reads `config.medical?.egress?.*`). Gmail-for-tasks is not a medical concern; entangling it would force a 4th medical axis. The contract non-goal forbids this ("Do NOT entangle the task gmail axis with the medical EgressGuard's axes").
- `config.hub` is a TRAP: it exists today but is **deliberately read as raw JSON, bypassing Zod** (`src/hub/hub-config.ts:4-7` comment: "Reads config.hub.outVault from the raw config file (bypassing Zod which strips unknown keys)"; `:29-33` reads `raw.hub?.outVault`). There is **no `hub` key in `BoberConfigSchema`** (verified: `grep hub src/config/schema.ts` → none). If you add a Zod `hub` section containing only `gmailEgress`, Zod will strip `outVault`/`repos` from any config loaded via `loadConfig`, which is a latent regression. Avoid `config.hub`.
- A new `taskInbox` section is semantically exact (this IS the task inbox feature) and mirrors the existing isolated single-boolean sections `telemetry`/`incident`/`history` (`src/config/schema.ts:330-346`).
- The axis is resolved via `loadConfig` (Zod-validated, per principles), then `config.taskInbox?.gmailEgress ?? false` — fail-closed when the section or whole config is absent.

---

## 1. Target Files

### src/config/schema.ts (modify)

**Add a new section schema next to TelemetrySection (model it on `src/config/schema.ts:330-337`):**
```ts
// ── Task Inbox Section (Sprint 6 — opt-in Gmail egress axis) ─────────
export const TaskInboxSectionSchema = z.object({
  /** When true, `bober task from-gmail` may read a Gmail thread via the MCP
   *  connector. Default false — zero Gmail egress unless explicitly opted in. */
  gmailEgress: z.boolean().default(false),
});
export type TaskInboxSection = z.infer<typeof TaskInboxSectionSchema>;
```

**Wire it into `BoberConfigSchema` (additive, OPTIONAL — insert near `src/config/schema.ts:482-487`):**
```ts
  // ── Sprint 6: task-inbox Gmail egress axis ──
  taskInbox: TaskInboxSectionSchema.optional(),
```
- **Why this is safe (no parse regression):** the field is `.optional()` at the top level, so existing configs without `taskInbox` still validate. `BoberConfigSchema` has **no `.strict()`** (verified) — unknown keys are stripped, never rejected. `PartialBoberConfigSchema` is `BoberConfigSchema.deepPartial()` (`src/config/schema.ts:495`), so the partial pre-validation path also accepts it. `createDefaultConfig` (`:512-575`) does NOT need a `taskInbox` entry — optional ⇒ absent is fine.
- **Do NOT add it to `createDefaultConfig`'s `base` object** — keep it absent so the default is the fail-closed `undefined`.

**Imported by (low risk — additive optional field):**
- `src/config/loader.ts:5-9` (`BoberConfigSchema`, `PartialBoberConfigSchema`) — validates merged config.
- `src/medical/egress.ts:2`, dozens of consumers of `type BoberConfig`. None assert exact key sets.

**Test file:** `src/config/schema.test.ts` (exists) — no exhaustive top-level `Object.keys`/`.toEqual(wholeConfig)` assertions (verified), so the new optional key does not break it.

---

### src/hub/gmail-to-task.ts (create)

**Directory pattern:** `src/hub/` uses kebab/lower-case `*.ts` with collocated `*.test.ts` (`finding-store.ts`, `task-inbox.ts`, etc.). Section headers use `// ── Name ───`.
**Most similar existing file:** `src/hub/task-inbox.ts` (pure domain fn, `now` injected, no clock) + `src/vault/mcp-adapter.ts` (injected MCP, sanitized errors). Follow BOTH.

**Structure template:**
```ts
import type { Finding } from "./finding.js";
import type { FactStore } from "../state/facts.js";
import { captureTask } from "./task-inbox.js";

// ── Injection surface (ExternalMcpServer satisfies this structurally) ──
/** Minimal MCP surface fromGmailTask needs. ExternalMcpServer matches it;
 *  tests inject a fake whose callTool is a vi.fn() spy. */
export interface GmailMcpLike {
  start(): Promise<void>;
  callTool(name: string, args: unknown): Promise<unknown>;
  stop(): Promise<void>;
}

// ── Constants ─────────────────────────────────────────────────────────
/** Default MCP tool name to read one Gmail thread. Override per connector. */
export const DEFAULT_GMAIL_READ_TOOL = "gmail_read_thread";

// ── parseGmailThread (PURE — no clock, no network) ────────────────────
/** The clock-independent, id-independent subset of a Finding a thread yields. */
export interface ParsedGmailThread {
  title: string;        // from the thread subject
  kind: "action";       // literal
  status: "open";       // literal
  tags: string[];       // provenance, e.g. ["source:gmail"]
}
export function parseGmailThread(payload: unknown): ParsedGmailThread {
  const subject = extractSubject(payload);          // tolerant extraction below
  return { title: subject, kind: "action", status: "open", tags: ["source:gmail"] };
}

// ── Error sanitization (REPLICATE external-client.ts:69 — NOT exported) ─
/** Strip KEY=VALUE env assignments so connector tokens never leak. */
export function sanitizeConnectorError(msg: string): string {
  return msg.replace(/\b[A-Z_][A-Z0-9_]*=\S+/g, "[redacted]");
}

// ── fromGmailTask ─────────────────────────────────────────────────────
export async function fromGmailTask(args: {
  egressAllowed: boolean;
  mcp: GmailMcpLike;
  threadRef: string;
  store: FactStore;
  now: string;
  toolName?: string;
}): Promise<Finding> {
  // sc-6-2: refuse BEFORE touching mcp — the stub's callTool must stay unused.
  if (!args.egressAllowed) {
    throw new Error(
      "Gmail egress not enabled — set taskInbox.gmailEgress: true in bober.config.json to opt in.",
    );
  }
  await args.mcp.start();
  const raw = await args.mcp.callTool(args.toolName ?? DEFAULT_GMAIL_READ_TOOL, {
    thread: args.threadRef,
  });
  const parsed = parseGmailThread(raw);
  // captureTask is the ONLY write path (contract). It sets kind=action/status=open
  // and stamps id/surfacedAt from `now`. Provenance carried via domain tag.
  return captureTask(args.store, parsed.title, { domain: "gmail", now: args.now });
}
```
**Imports this file needs:** `type Finding` (`./finding.js`), `type FactStore` (`../state/facts.js`), `captureTask` (`./task-inbox.js`). NOTE: import `ExternalMcpServer`/`ToolDescriptor` only in `task.ts`, NOT here — keep `src/hub/` free of the `src/mcp` dependency by using the local `GmailMcpLike` interface (mirrors `McpServerLike` at `src/vault/mcp-adapter.ts:31-36`).

> **CRITICAL reuse note (read twice):** `captureTask(store, text, {domain, now})` takes a **string title**, not a Finding (`src/hub/task-inbox.ts:22-26`). It builds the Finding itself and only adds a `domain:<x>` tag — it will NOT carry a literal `"source:gmail"` tag. So `parseGmailThread`'s `tags` field documents provenance but is not persisted through captureTask. Pass `domain: "gmail"` so the stored Finding gets a `domain:gmail` tag. Do NOT route through `ingestFinding` to force a custom tag — that violates "captureTask is the only write path" (evaluatorNotes).

---

### src/cli/commands/task.ts (modify)

**Add a DI core + a subcommand. Follow the existing `runTaskIngest` + `task ingest` registration pattern (`src/cli/commands/task.ts:267-291` and `:388-413`) and the medical egress-gate boundary (`src/cli/commands/medical.ts:63-75`).**

**New imports to add at top (`src/cli/commands/task.ts:25-33` block):**
```ts
import { ExternalMcpServer } from "../../mcp/external-client.js";
import { fromGmailTask, sanitizeConnectorError } from "../../hub/gmail-to-task.js";
import type { ObservabilityProvider } from "../../config/schema.js";
// loadConfig is already importable via ../../config/loader.js (used by resolveDefaultNamespace)
```

**DI core (mirror `runTaskIngest` shape — never throws, sets exitCode):**
```ts
/**
 * DI core for `task from-gmail`. egressAllowed is resolved at the CLI boundary.
 * When disabled → chalk.yellow opt-in + exitCode=1 + return (caller must NOT
 * have constructed the MCP client). When enabled → fromGmailTask, sanitized errors.
 * Never throws.
 */
export async function runTaskFromGmail(
  store: FactStore,
  mcp: GmailMcpLike,             // import type from gmail-to-task.js
  threadRef: string,
  egressAllowed: boolean,
  now: string,
): Promise<void> {
  try {
    const finding = await fromGmailTask({ egressAllowed, mcp, threadRef, store, now });
    process.stdout.write(chalk.green(`Captured task ${chalk.bold(finding.id)} from Gmail\n`));
    process.stdout.write(`  title: ${finding.title}\n`);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    process.stderr.write(chalk.red(`task from-gmail: ${sanitizeConnectorError(raw)}\n`));
    process.exitCode = 1;
  } finally {
    await mcp.stop().catch(() => { /* ignore */ });
  }
}
```
> NOTE on sc-6-2 layering: the opt-in refusal MUST happen with `callTool` never called. `fromGmailTask` already throws before `mcp.callTool` when `egressAllowed=false`, so `runTaskFromGmail(store, stubMcp, ref, false, now)` yields exitCode=1 AND `stubMcp.callTool` un-called. The `finally` calls `mcp.stop()` — if your sc-6-2 test also asserts `stop` is never called, gate the refusal in the COMMAND (below) before constructing the MCP at all, and assert against the DI core only for the callTool spy. (callTool-never-called is the contract-required assertion.)

**Subcommand registration (add inside `registerTaskCommand`, after `task ingest` at `src/cli/commands/task.ts:413`):**
```ts
  // ── task from-gmail ──────────────────────────────────────────────
  taskCmd
    .command("from-gmail <thread>")
    .description("Capture a Gmail thread as a task (requires opt-in taskInbox.gmailEgress)")
    .action(async (thread: string) => {
      const projectRoot = await resolveRoot();
      try {
        // Resolve the gmail axis fail-closed: any config error ⇒ disabled.
        let gmailAllowed = false;
        let providers: ObservabilityProvider[] = [];
        try {
          const config = await loadConfig(projectRoot);
          gmailAllowed = config.taskInbox?.gmailEgress ?? false;
          providers = config.observability?.providers ?? [];
        } catch {
          gmailAllowed = false;        // missing/invalid config ⇒ fail-closed
        }

        if (!gmailAllowed) {
          process.stderr.write(
            chalk.yellow(
              "task from-gmail: Gmail egress not enabled — set taskInbox.gmailEgress: true in bober.config.json to opt in.\n",
            ),
          );
          process.exitCode = 1;
          return;                       // NO MCP construction (sc-6-2)
        }

        // Enabled path: resolve a gmail provider declaration, construct the MCP client.
        const provider = providers.find((p) => p.name === "gmail" && p.enabled);
        if (!provider) {
          process.stderr.write(
            chalk.red("task from-gmail: no enabled observability provider named 'gmail' configured.\n"),
          );
          process.exitCode = 1;
          return;
        }

        const ns = await resolveDefaultNamespace(projectRoot);
        await ensureFactsDir(projectRoot, ns);
        const now = new Date().toISOString();           // clock ONLY at boundary
        const store = new FactStore(factsDbPath(projectRoot, ns));
        const mcp = new ExternalMcpServer(provider);     // satisfies GmailMcpLike
        try {
          await runTaskFromGmail(store, mcp, thread, gmailAllowed, now);
        } finally {
          store.close();
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(`task from-gmail failed: ${err instanceof Error ? sanitizeConnectorError(err.message) : String(err)}\n`),
        );
        process.exitCode = 1;
      }
    });
```
> The real provider wiring (reading `config.observability.providers` for a `gmail` entry, default tool name) is NOT covered by any success criterion — the sc-tests all use a stubbed `mcp`. Keep it minimal as above; do not invent new schema for the connector itself. Only `taskInbox.gmailEgress` is new config.

**Imported by:** `src/cli/index.ts:38,322` (`registerTaskCommand`) — additive subcommand, no signature change.
**Test file:** `src/cli/commands/task.test.ts` (exists) — extend it.

---

## 2. Patterns to Follow

### EgressGuard opt-in axis (the pattern to MIRROR, not extend)
**Source:** `src/medical/egress.ts:5,17-32,54-58`
```ts
export type EgressAxis = "cloud-inference" | "literature-retrieval" | "device-connection";
// ...
static fromConfig(config: BoberConfig): EgressGuard {
  const med = config.medical;
  return new EgressGuard(
    med?.egress?.cloudInference ?? false,        // default false when absent
    med?.egress?.literatureRetrieval ?? false,
    med?.egress?.deviceConnection ?? false,
  );
}
assertAllowed(axis: EgressAxis): void {
  if (!this.isAllowed(axis)) throw new Error(`Egress axis '${axis}' not enabled`);
}
```
**Rule:** A new axis = a default-`false` config boolean + a guard that THROWS when off, read via `?? false`. Your gmail axis follows this shape but lives in `taskInbox`, resolved inline (`config.taskInbox?.gmailEgress ?? false`) — it does NOT become a 4th `EgressAxis`.

### CLI axis-off gate that constructs NO client (the sc-6-2 blueprint)
**Source:** `src/cli/commands/medical.ts:63-75`
```ts
const egress = EgressGuard.fromConfig(config);
if (!egress.isAllowed("device-connection")) {
  process.stderr.write(chalk.red("device-connection egress not enabled — set medical.egress.deviceConnection: true ...\n"));
  process.exitCode = 1;
  return;                                  // NEVER construct WhoopClient below
}
// ... new WhoopClient(...) only reached when enabled
```
**Rule:** Check the axis and `return` BEFORE any `new ExternalMcpServer(...)`. Construction-after-gate is what guarantees zero network when off.

### Injected MCP surface + lifecycle ordering
**Source:** `src/vault/mcp-adapter.ts:31-36` (interface), `:172-178` (start→callTool→parse)
```ts
export interface McpServerLike {
  start(): Promise<void>;
  listTools(): Promise<ToolDescriptor[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
  stop(): Promise<void>;
}
// ...
await this.server.start();
const raw = await this.server.callTool(this.toolNames.readNote, { path });
return parseNote(extractText(raw), path);
```
**Rule:** Define a minimal local interface; `ExternalMcpServer` satisfies it structurally; tests inject a fake. Always `start()` before `callTool()`.

### Error sanitization (the sc-6-4 requirement)
**Source:** `src/mcp/external-client.ts:66-77` — the regex is at **line 69**:
```ts
const msg = err instanceof Error ? err.message : String(err);
// Strip anything that looks like an env var assignment (KEY=VALUE).
const sanitized = msg.replace(/\b[A-Z_][A-Z0-9_]*=\S+/g, "[redacted]");
```
**Rule:** This helper is INLINE/PRIVATE inside `start()` — it is NOT exported. **Replicate the exact regex** in `gmail-to-task.ts` as `sanitizeConnectorError`. The regex only catches UPPERCASE `KEY=VALUE`; the contract's `TOKEN=secret` matches it. Apply it to every error string surfaced to stderr.

### captureTask — the single write path
**Source:** `src/hub/task-inbox.ts:22-50`
```ts
export async function captureTask(
  store: FactStore, text: string, { domain, now }: { domain?: string; now: string },
): Promise<Finding> { /* builds Finding kind=action, status=open, id from sha256(title|now); writeFinding */ }
```
**Rule:** Feed it the parsed subject string. It owns Finding construction + persistence (`writeFinding` → `HUB_SCOPE`). Do not build the Finding yourself; do not call `writeFinding`/`ingestFinding` directly.

### Additive config section (the schema-edit template)
**Source:** `src/config/schema.ts:330-337` (TelemetrySection) + top-level wiring `:471-487`
```ts
export const TelemetrySectionSchema = z.object({ enabled: z.boolean().default(false) });
// ...
telemetry: TelemetrySectionSchema.optional(),
```
**Rule:** Copy this exact shape. Single defaulted boolean, `.optional()` at the top level.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `captureTask` | `src/hub/task-inbox.ts:22` | `(store: FactStore, text: string, {domain?, now}): Promise<Finding>` | THE write path — builds action/open Finding from a title string + persists. |
| `writeFinding` | `src/hub/finding-store.ts:17` | `(store, finding, {now}): Promise<ReconcileAction>` | Lower-level persist (captureTask wraps it — do NOT call directly here). |
| `HUB_SCOPE` | `src/hub/finding-source.ts:8` | `"hub"` const | FactStore scope for hub findings — used in test assertions. |
| `ExternalMcpServer` | `src/mcp/external-client.ts:30` | `new (provider: ObservabilityProvider)`; `start/listTools/callTool/stop` | The injected MCP connector. Construct only on the enabled path. |
| `ExternalMcpServer.callTool` | `src/mcp/external-client.ts:95-103` | `(name: string, args: unknown): Promise<unknown>` | The one connector call. Stub this in tests. |
| `loadConfig` | `src/config/loader.ts:142` | `(projectRoot): Promise<BoberConfig>` | Zod-validated config load. THROWS if no config file — wrap in try/catch ⇒ fail-closed. |
| `EgressGuard` | `src/medical/egress.ts:17` | class, `fromConfig`/`isAllowed`/`assertAllowed` | Reference pattern ONLY — medical-scoped; do NOT add a gmail axis to it. |
| `findProjectRoot` | `src/utils/fs.ts` (used `task.ts:17`) | `(): Promise<string \| undefined>` | Resolve project root (via `resolveRoot()` helper already in task.ts). |
| `FactStore`/`factsDbPath`/`ensureFactsDir` | `src/state/facts.js` (imported `task.ts:20-24`) | — | DB lifecycle at the CLI boundary (already wired in every task subcommand). |
| `resolveDefaultNamespace` | `src/cli/commands/task.ts:49` | `(projectRoot): Promise<string \| undefined>` | Namespace resolver — reuse, do not re-derive. |
| `sanitizeConnectorError` | (CREATE in `gmail-to-task.ts`) | `(msg: string): string` | Replicates external-client.ts:69 regex — there is no exported sanitizer to import. |

Utilities reviewed: `src/utils/`, `src/hub/`, `src/state/`, `src/mcp/`, `src/medical/`, `src/config/`, `src/vault/`. No existing exported error-sanitizer (the one at external-client.ts:69 is inline) — replication is correct, not duplication.

---

## 4. Prior Sprint Output (reuse — DO NOT recreate)

### Sprint 1: task-inbox capture
**Created:** `src/hub/task-inbox.ts` — exports `captureTask`. **Connection:** this sprint's `fromGmailTask` calls `captureTask(store, subject, {domain:"gmail", now})` as its sole write path.
**Created (Sprint 1 substrate):** `src/hub/finding-store.ts` (`writeFinding`, `readFindings`), `src/hub/finding-source.ts` (`HUB_SCOPE`), `src/hub/finding.ts` (`Finding`, `FindingSchema`). **Connection:** `readFindings(store)` + `HUB_SCOPE` are used by your sc-6-3 test to assert the captured Finding.

### Sprints 2–5: list/lifecycle/snooze/ingest + chat
**Created/extended:** `src/cli/commands/task.ts` (`runTaskAdd/List/Transition/Snooze/Ingest` + `registerTaskCommand`). **Connection:** you ADD `runTaskFromGmail` + a `from-gmail` subcommand alongside these — additive, same DI-core + `.action()` boundary pattern. `Finding` type and the `task add`→`captureTask` flow are unchanged.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM `.js` extensions** on every relative import (`:27`). NodeNext.
- **`import type { ... }`** — `consistent-type-imports` is ENFORCED (`:35`). Use it for `Finding`, `FactStore`, `ObservabilityProvider`, `GmailMcpLike`, `Command`.
- **Zod for config** (`:29`) — the gmail axis must be a Zod field validated via `loadConfig`, not hand-rolled.
- **Unused vars are an ERROR** (`:19,:36`); only `_`-prefix escapes. **An earlier sprint in this plan failed once on an unused-var lint error — do NOT leave an unused import/param.** If you import `ToolDescriptor` and don't use it, remove it.
- **No `any`** (`:40`) — use `unknown` + narrowing (parseGmailThread input is `unknown`).
- **No synchronous fs** (`:42`); **collocated `*.test.ts`** (`:20`); **section headers** `// ── Name ──` (`:32`).
- **No new runtime deps** (contract non-goal). `@modelcontextprotocol/sdk@^1.28.0` is already a dependency (`package.json`) — reuse via `ExternalMcpServer`, add nothing.

### Architecture Decisions
No ADR file maps to gmail/task egress (`.bober/architecture/` is new/untracked). The medical EgressGuard cites "ADR-6" inline (`src/medical/egress.ts:1`) — informative precedent only; this sprint introduces an isolated `taskInbox` axis, not a medical ADR axis.

### Other Docs
`CLAUDE.md`/`README` add no constraints beyond principles for this sprint.

---

## 6. Testing Patterns

### Unit Test Pattern (DI cores) — `src/cli/commands/task.test.ts`
**Runner:** vitest · **Assertion:** `expect` · **Mock:** `vi.spyOn` / hand-rolled `vi.fn()` fakes (no `vi.mock` needed for injection) · **Naming:** `*.test.ts` collocated · **Store:** `new FactStore(":memory:")`.
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FactStore } from "../../state/facts.js";

const T = "2026-06-28T00:00:00.000Z";
const originalExitCode = process.exitCode;
beforeEach(() => { process.exitCode = 0; });
afterEach(() => { vi.restoreAllMocks(); process.exitCode = originalExitCode as number | undefined; });
```
(Source: `src/cli/commands/task.test.ts:1-19`. Note the exitCode reset — REQUIRED, since you assert `process.exitCode`.)

### Injected-MCP fake with a callTool spy — `src/vault/mcp-adapter.test.ts:40-48`
```ts
function makeFakeMcp(callToolResponse: unknown) {
  const start = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
  const stop = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
  const callTool = vi.fn<[string, unknown], Promise<unknown>>().mockResolvedValue(callToolResponse);
  return { start, stop, callTool, listTools: vi.fn().mockResolvedValue([]) };
}
```

### "spy never called" assertion (the sc-6-2 shape) — `src/vault/mcp-adapter.test.ts:236-252`
```ts
const startSpy = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
// ... act on the guarded/disabled path ...
expect(startSpy).not.toHaveBeenCalled();      // <- mirror with callTool for sc-6-2
```

### Sanitize assertion (the sc-6-4 shape) — `src/mcp/external-client.test.ts:103-118`
```ts
mockConnect.mockRejectedValueOnce(new Error("LOKI_TOKEN=secret connection refused"));
// ...
expect(caughtError?.message).not.toContain("secret");
expect(caughtError?.message).toContain("[redacted]");
```

### Paste-ready test skeletons for THIS sprint (put in `src/hub/gmail-to-task.test.ts`)
```ts
import { describe, it, expect, vi } from "vitest";
import { FactStore } from "../state/facts.js";
import { fromGmailTask, parseGmailThread, sanitizeConnectorError } from "./gmail-to-task.js";
import { readFindings } from "./finding-store.js";

const T = "2026-06-28T00:00:00.000Z";
const makeMcp = (resp: unknown) => ({
  start: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
  stop: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
  callTool: vi.fn<[string, unknown], Promise<unknown>>().mockResolvedValue(resp),
});

// sc-6-2: axis OFF → throws, callTool NEVER invoked (no network)
it("sc-6-2: egressAllowed=false refuses and never calls callTool", async () => {
  const store = new FactStore(":memory:");
  const mcp = makeMcp({});
  await expect(
    fromGmailTask({ egressAllowed: false, mcp, threadRef: "t1", store, now: T }),
  ).rejects.toThrow(/not enabled/i);
  expect(mcp.callTool).not.toHaveBeenCalled();
  store.close();
});

// sc-6-3: axis ON + stub payload → one open action-Finding, title=subject
it("sc-6-3: captures one open action Finding with title from subject", async () => {
  const store = new FactStore(":memory:");
  const mcp = makeMcp({ /* shape your parser accepts, e.g.: */ subject: "Renew passport" });
  const finding = await fromGmailTask({ egressAllowed: true, mcp, threadRef: "t1", store, now: T });
  expect(mcp.callTool).toHaveBeenCalledTimes(1);
  expect(finding.kind).toBe("action");
  expect(finding.status).toBe("open");
  expect(finding.title).toBe("Renew passport");
  const all = readFindings(store);
  expect(all).toHaveLength(1);
  expect(all[0]!.title).toBe("Renew passport");
  store.close();
});

// sc-6-4: connector error is sanitized (no TOKEN=secret leak)
it("sc-6-4: connector error message is sanitized of KEY=VALUE secrets", () => {
  expect(sanitizeConnectorError("boom GMAIL_TOKEN=secret here")).not.toContain("secret");
  expect(sanitizeConnectorError("boom GMAIL_TOKEN=secret here")).toContain("[redacted]");
});

// parseGmailThread purity
it("parseGmailThread is pure: action/open + title from subject", () => {
  const p = parseGmailThread({ subject: "Pay invoice" });
  expect(p).toMatchObject({ title: "Pay invoice", kind: "action", status: "open" });
});
```
For the CLI-core sc-6-4 (exitCode path), add in `task.test.ts`:
```ts
it("sc-6-4: runTaskFromGmail catches connector error, exitCode=1, no token leak", async () => {
  const store = new FactStore(":memory:");
  const stderr: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((c) => { stderr.push(String(c)); return true; });
  const mcp = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn().mockRejectedValue(new Error("GMAIL_TOKEN=secret 500")),
  };
  await runTaskFromGmail(store, mcp, "t1", true, T);
  expect(process.exitCode).toBe(1);
  expect(stderr.join("")).not.toContain("secret");
  store.close();
});
```

### E2E Test Pattern
Not applicable — no Playwright in this CLI sprint (verified: vitest only).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/config/loader.ts` | `BoberConfigSchema`, `PartialBoberConfigSchema` (`:5-9`) | low | New field is `.optional()` + no `.strict()` ⇒ existing configs still validate. |
| `src/cli/index.ts` | `registerTaskCommand` (`:38,322`) | low | Additive subcommand; signature unchanged. |
| `src/cli/commands/task.test.ts` | `runTask*` cores | low | You ADD tests; existing ones untouched. |
| `src/hub/hub-config.ts` | raw `config.hub.*` (`:29-33`) | low | UNAFFECTED **iff** you use `taskInbox` (NOT `config.hub`). Adding a Zod `hub` section WOULD risk stripping `outVault`/`repos` — avoid. |
| Every `type BoberConfig` consumer (`src/medical/*`, `src/teams/*`, etc.) | `schema.ts` types | low | Additive optional field; no consumer asserts an exact key set. |

### Existing Tests That Must Still Pass
- `src/config/schema.test.ts` — validates section parsing; no exhaustive top-level key assertion (verified), so the new optional key does not break it. Run it.
- `src/config/loader.test.ts` — full load+merge+validate path; the additive optional field must not change existing fixtures' output. Run it.
- `src/cli/commands/task.test.ts` — all Sprint 1–5 task cores. Must stay green after you append `from-gmail` tests + imports.
- `src/mcp/external-client.test.ts`, `src/vault/mcp-adapter.test.ts` — untouched source; should stay green (sanity that your new imports don't perturb them).

### Features That Could Be Affected
- **kb-hub priority/decide** — shares `config.hub.*` (read raw via `src/hub/hub-config.ts`). Verify you did NOT add a Zod `hub` section: `grep -n "hub:" src/config/schema.ts` should still return nothing.
- **Task add/list/snooze/ingest (Sprints 1–5)** — share `captureTask`/`FactStore`/`registerTaskCommand`. Verify `task add` still captures and `task list` still renders after your edits.

### Recommended Regression Checks (concrete, runnable)
1. `npm run build` → exits 0 (sc-6-1).
2. `npm run typecheck` → exits 0 (sc-6-5).
3. `npx vitest run src/hub/gmail-to-task.test.ts src/cli/commands/task.test.ts` → new sc-6-2/6-3/6-4 + all prior task tests green.
4. `npx vitest run src/config/schema.test.ts src/config/loader.test.ts` → config parsing unaffected.
5. `grep -n "hub:" src/config/schema.ts` → no output (confirms no Zod `hub` section was introduced).
6. `npm run test` → full suite green, no regressions.

---

## 8. Implementation Sequence (dependency-ordered)

1. **src/config/schema.ts** — add `TaskInboxSectionSchema` + `taskInbox: TaskInboxSectionSchema.optional()`.
   - Verify: `npm run typecheck` clean; `grep -n "TaskInboxSection" src/config/schema.ts` shows both the schema and the top-level wiring.
2. **src/hub/gmail-to-task.ts** — `GmailMcpLike`, `DEFAULT_GMAIL_READ_TOOL`, `ParsedGmailThread`, `parseGmailThread` (pure), `sanitizeConnectorError`, `fromGmailTask`. (Depends only on `task-inbox.ts` + types.)
   - Verify: `npm run typecheck` clean; `fromGmailTask` returns `Finding`; no `src/mcp` import here; no `any`; no unused imports.
3. **src/cli/commands/task.ts** — add imports, `runTaskFromGmail` DI core, `from-gmail <thread>` subcommand with the fail-closed config gate + gated `ExternalMcpServer` construction.
   - Verify: `npm run build` clean; refusal path constructs no MCP; clock read only at the `.action()` boundary.
4. **src/hub/gmail-to-task.test.ts** + **src/cli/commands/task.test.ts** — sc-6-2 (callTool never called), sc-6-3 (one open action-Finding, title=subject), sc-6-4 (sanitized error, exitCode=1), parse purity.
   - Verify: `npx vitest run src/hub/gmail-to-task.test.ts src/cli/commands/task.test.ts` green.
5. **Run full verification** — `npm run build` · `npm run typecheck` · `npm run test`.

---

## 9. Pitfalls & Warnings

- **UNUSED VARS = LINT ERROR (this plan failed on it once).** If you import `ToolDescriptor`, `EgressGuard`, or `type Finding` and don't use it, the build/lint fails. `_`-prefix is the only escape (`principles.md:36`). Double-check every new import is used.
- **Do NOT add the gmail axis to `EgressGuard`** (`src/medical/egress.ts`). It is medical-scoped (`config.medical.egress`). Use the new isolated `taskInbox.gmailEgress`.
- **Do NOT add a Zod `hub` section.** `config.hub.outVault`/`repos` are read raw, bypassing Zod (`src/hub/hub-config.ts:4-7,29-33`). A Zod `hub` section would silently strip them in any `loadConfig` consumer. Use `taskInbox`.
- **Refuse BEFORE constructing the MCP.** The opt-in check (`fromGmailTask` throw + the command's pre-construction `return`) must precede `new ExternalMcpServer(...)` and `mcp.callTool(...)`. sc-6-2 asserts the stub's `callTool` was NEVER called — `fromGmailTask` short-circuits on `egressAllowed=false` before `mcp.start()/callTool()`.
- **The sanitizer is NOT exported** from `external-client.ts` (it's inline at line 69). Replicate the regex `/\b[A-Z_][A-Z0-9_]*=\S+/g` in `gmail-to-task.ts`; do not try to `import` a phantom symbol. The regex only catches UPPERCASE `KEY=VALUE` (matches the contract's `TOKEN=secret`); a lowercase token would slip through — fine for sc-6-4, but don't claim broader coverage.
- **captureTask takes a string, not a Finding** (`task-inbox.ts:22-26`). Feed it the subject; let it build the Finding. Routing through `writeFinding`/`ingestFinding` to force a `source:gmail` tag VIOLATES "captureTask is the only write path" (evaluatorNotes). Use `domain:"gmail"` for provenance.
- **`now` is injected at the CLI boundary only** (`task.ts:312` style). `parseGmailThread` and `fromGmailTask` must NEVER call `Date.now()`/`new Date()` — `now` flows in as a param (mirrors `captureTask` purity, `task-inbox.ts:13-21`).
- **`loadConfig` THROWS when no config file exists** (`loader.ts:142-148`). Wrap it in try/catch and default `gmailAllowed=false` ⇒ fail-closed (a missing config must refuse, not crash).
- **`.js` extensions** on all relative imports (`gmail-to-task.js`, `task-inbox.js`, `external-client.js`, `finding.js`). NodeNext will fail without them.
- **No new runtime deps.** `@modelcontextprotocol/sdk` is already present; reuse `ExternalMcpServer`. Adding any package violates a contract non-goal.
- **`parseGmailThread` input shape is under-specified (ambiguityScore 6).** Pick ONE tolerant shape (e.g. `{ subject }`, or `{ messages: [{ subject }] }`, or SDK envelope `{ content: [{ text }] }` with JSON) and make your sc-6-3 stub return exactly that. Keep extraction defensive (`unknown` → narrow) and throw a clear error if no subject is found (the CLI will sanitize+exit 1).
