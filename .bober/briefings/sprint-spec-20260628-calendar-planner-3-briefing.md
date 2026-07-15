# Sprint Briefing: Google Calendar MCP connector (egress-gated) + safe-title privacy

**Contract:** sprint-spec-20260628-calendar-planner-3
**Generated:** 2026-06-29T00:00:00Z

---

## 0. SECURITY HEADLINE — read this first

This is a security-sensitive sprint. Four non-negotiables, each with a cited reference pattern:

1. **Only `finding.calendarSafeTitle` may leave the device** (fallback to the generic literal `"Focus block"` when absent). NEVER send `evidence`, the full `title`, or `tags`.
   **TRAP:** `slotter.ts:209` sets `PlanItem.title = finding.calendarSafeTitle ?? finding.title`. So `PlanItem.title` IS the full title whenever a finding has no `calendarSafeTitle`. The Google connector must therefore **NOT** use `PlanItem.title` for the event summary. It must look the safe title up from the original `Finding[]` (passed into the factory) and use `calendarSafeTitle ?? "Focus block"` — never `title`. (sc-3-4)
2. **The egress check happens BEFORE the MCP client/adapter is touched.** Mirror `gmail-to-task.ts:131-136` and `medical.ts:67-75`: throw/refuse before any `listTools`/`callTool`/`start`. (sc-3-3)
3. **Errors are sanitized** so a token / MCP env never appears. Replicate the regex at `external-client.ts:69` (see `gmail-to-task.ts:103-105`). (sc-3-6)
4. **The schema change is additive.** A config with no `calendar` key must parse byte-identically. The section is `.optional()` and every field `.default()`-ed; do NOT add it to `createDefaultConfig` (optional sections are not emitted there — see `schema.ts:529-579`). (sc-3-1)

---

## 1. Target Files

### src/config/schema.ts (modify)

**Reference section — `MedicalSectionSchema` (lines 385-412), the exact pattern to mirror:**
```ts
export const MedicalSectionSchema = z.object({
  egress: z
    .object({
      cloudInference: z.boolean().default(false),
      literatureRetrieval: z.boolean().default(false),
      deviceConnection: z.boolean().default(false),
    })
    .optional(),
  // ...
});
export type MedicalSection = z.infer<typeof MedicalSectionSchema>;
```

**Composition site — `BoberConfigSchema` (lines 491-498), add `calendar` here as `.optional()`:**
```ts
  // ── Phase 6: medical team egress config ──
  medical: MedicalSectionSchema.optional(),
  // ── Phase B: fleet blackboard (child-visible channel) ──
  fleet: FleetSectionSchema.optional(),
  // ...
  taskInbox: TaskInboxSectionSchema.optional(),
});           // <- line 499; add `calendar: CalendarSectionSchema.optional(),` before this brace
```

**New schema to add (model on lines 385-396):**
```ts
// ── Calendar Section (Sprint 3 — cloud-calendar egress axis default off) ──
export const CalendarSectionSchema = z.object({
  egress: z
    .object({
      /** When true, Google Calendar (cloud) egress is permitted. Default false (fail-closed). */
      cloudCalendar: z.boolean().default(false),
    })
    .optional(),
  /** Which connector to use. Default 'ics' (local, zero-egress). */
  connector: z.enum(["ics", "google"]).default("ics"),
  /** Optional IANA timezone (informational only). */
  timezone: z.string().optional(),
});
export type CalendarSection = z.infer<typeof CalendarSectionSchema>;
```
**Imported by (after composition):** `src/config/loader.ts` parses `BoberConfigSchema`; consumers read `config.calendar?.egress?.cloudCalendar`.
**Test file:** `src/config/schema.test.ts` exists (verify it still parses configs with NO `calendar` key — additive proof).
**DO NOT** add `calendar` to `createDefaultConfig` (schema.ts:529-579 emits only required sections; optional sections like `medical`/`telemetry`/`vault` are absent there — keep `calendar` absent so existing behavior is byte-identical).

---

### src/calendar/calendar-egress.ts (create)

**Most similar existing file:** `src/medical/egress.ts:1-59` — copy the class shape (constructor stores booleans, `fromConfig` reads the optional section, `assertAllowed`-style method throws naming the flag).
**Structure template (derived from egress.ts):**
```ts
import type { BoberConfig } from "../config/schema.js";

export class CalendarEgressGuard {
  constructor(private readonly cloudCalendar: boolean) {}

  static fromConfig(config: BoberConfig): CalendarEgressGuard {
    return new CalendarEgressGuard(config.calendar?.egress?.cloudCalendar ?? false);
  }

  isCloudCalendarAllowed(): boolean {
    return this.cloudCalendar;
  }

  /** Throws naming the flag when off; returns void when allowed (mirrors egress.ts:54-58). */
  assertCloudCalendarAllowed(): void {
    if (!this.cloudCalendar) {
      throw new Error(
        "cloud-calendar egress not enabled — set calendar.egress.cloudCalendar: true in bober.config.json",
      );
    }
  }
}
```
**Rule:** The thrown string MUST contain `calendar.egress.cloudCalendar` (sc-3-3 asserts on it).

---

### src/calendar/calendar-token.ts (create)

**Most similar existing file:** `src/medical/whoop/whoop-token.ts:31-87` — 0600 sidecar reader; `readRefreshToken` returns `undefined` when absent/corrupt (fail-closed).
**Structure template (derived from whoop-token.ts):**
```ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir } from "../utils/fs.js";   // NOTE: ../utils (calendar is one level under src)

export class CalendarTokenStore {
  constructor(private readonly projectRoot: string) {}

  private path(): string {
    return join(this.projectRoot, ".bober", "calendar", "google-token.json");
  }

  /** Returns the stored token, or undefined when the sidecar is absent/corrupt (fail-closed). */
  async readToken(): Promise<string | undefined> {
    try {
      const data = JSON.parse(await readFile(this.path(), "utf-8")) as { token?: string };
      return typeof data.token === "string" ? data.token : undefined;
    } catch {
      return undefined;
    }
  }

  async writeToken(token: string): Promise<void> {
    await ensureDir(join(this.projectRoot, ".bober", "calendar"));
    await writeFile(this.path(), JSON.stringify({ token }, null, 2) + "\n", {
      encoding: "utf-8",
      mode: 0o600,   // <- mirrors whoop-token.ts:84
    });
  }
}
```
**Rule:** The connector refuses (clear message + `.ics` fallback suggestion) when `readToken()` returns `undefined`. OAuth acquisition is OUT OF SCOPE — the token is provisioned out-of-band into the 0600 sidecar (as with WHOOP).

---

### src/calendar/google-connector.ts (create)

**Most similar existing files:** `src/calendar/ics-connector.ts:54-76` (factory returning a `CalendarConnector`) + `src/vault/mcp-adapter.ts:31-101` (MCP injection surface + envelope parsing) + `src/hub/gmail-to-task.ts:123-147` (refuse-before-MCP + sanitize).
**Structure template:**
```ts
import type { Finding, BusyInterval, PlanItem } from "./types.js";
import type { CalendarConnector, FreeBusyWindow, WriteResult } from "./connector.js";
import type { CalendarEgressGuard } from "./calendar-egress.js";
import type { ToolDescriptor } from "../mcp/external-client.js";

/** Injection surface — ExternalMcpServer satisfies this structurally; tests inject a stub. */
export interface GoogleCalendarToolAdapter {
  listTools(): Promise<ToolDescriptor[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
}

/** Strip KEY=VALUE env assignments (replicates external-client.ts:69 — no exported sanitizer to import). */
export function sanitizeCalendarError(msg: string): string {
  return msg.replace(/\b[A-Z_][A-Z0-9_]*=\S+/g, "[redacted]");
}

const PLACEHOLDER_TITLE = "Focus block";

export function createGoogleConnector(opts: {
  adapter: GoogleCalendarToolAdapter;
  egress: CalendarEgressGuard;
  token: string | undefined;
  findings: Finding[];        // source of truth for calendarSafeTitle — NEVER use PlanItem.title
  freeBusyTool?: string;
  writeEventTool?: string;
}): CalendarConnector {
  // Build safe-title lookup ONCE — id -> calendarSafeTitle (may be undefined)
  const safeTitleById = new Map(opts.findings.map((f) => [f.id, f.calendarSafeTitle] as const));

  function guard(): void {
    opts.egress.assertCloudCalendarAllowed();           // throws naming calendar.egress.cloudCalendar
    if (opts.token === undefined) {
      throw new Error(
        "Google Calendar token absent — provision the 0600 sidecar, or use the local .ics fallback " +
          "(`bober calendar plan --export-ics`).",
      );
    }
  }

  return {
    name: "google",
    async readFreeBusy(window: FreeBusyWindow): Promise<BusyInterval[]> {
      guard();                                           // BEFORE any adapter call (sc-3-3)
      try {
        // discover tool via listTools, then callTool, then parse the SDK envelope (vault extractText idiom)
        // ... map result -> BusyInterval[] ...
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        throw new Error(`google free/busy failed: ${sanitizeCalendarError(m)}`);  // sc-3-6
      }
    },
    async writeEvents(items: PlanItem[]): Promise<WriteResult> {
      guard();                                           // BEFORE any adapter call (sc-3-3)
      let written = 0;
      try {
        for (const item of items) {
          const summary = safeTitleById.get(item.findingId) ?? PLACEHOLDER_TITLE; // NEVER item.title
          await opts.adapter.callTool(opts.writeEventTool ?? "google_calendar_create_event", {
            summary,                                     // ONLY safe title leaves the device
            start: item.startIso,
            end: item.endIso,
          });
          written++;
        }
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        throw new Error(`google write failed: ${sanitizeCalendarError(m)}`);       // sc-3-6
      }
      return { writtenCount: written, target: "google" };
    },
  };
}
```
**Module doc-comment MUST state:** hosted OAuth is unfit for unattended/cron runs; scheduled runs should use the `.ics` fallback (Sprint 2). (sc-3-6 source/doc scan)

---

### docs/calendar.md (create)

No `docs/calendar.md` exists yet (verified). Existing docs use plain markdown headings (see `docs/teams.md`, `docs/do-bridge.md`). Must contain a clear caveat: **hosted Google OAuth is unfit for unattended/cron runs** and **recommend the `.ics` fallback** (`bober calendar plan --export-ics`). sc-3-6's doc scan greps for this text.

---

## 2. Patterns to Follow

### Egress guard (class + fromConfig + throwing assert)
**Source:** `src/medical/egress.ts:17-58`
```ts
export class EgressGuard {
  static fromConfig(config: BoberConfig): EgressGuard {
    const med = config.medical;
    return new EgressGuard(med?.egress?.cloudInference ?? false, /* ... */);
  }
  assertAllowed(axis: EgressAxis): void {
    if (!this.isAllowed(axis)) throw new Error(`Egress axis '${axis}' not enabled`);
  }
}
```
**Rule:** Default-false, read the optional config section with `?.` + `?? false`, throw naming the flag.

### Refuse BEFORE constructing/touching the MCP client
**Source:** `src/hub/gmail-to-task.ts:131-141`
```ts
if (!args.egressAllowed) {
  throw new Error("Gmail egress not enabled — set taskInbox.gmailEgress: true ...");
}
await args.mcp.start();                 // only reached when allowed
const raw = await args.mcp.callTool(...);
```
Also `src/cli/commands/medical.ts:67-75` (axis-off branch returns before `new WhoopClient`).
**Rule:** The guard MUST precede `start`/`listTools`/`callTool`. Tests assert the stub's spies recorded zero calls.

### MCP injection surface + SDK envelope parsing
**Source:** `src/vault/mcp-adapter.ts:31-36` (interface) and `:94-101` (envelope extract)
```ts
export interface McpServerLike {
  start(): Promise<void>;
  listTools(): Promise<ToolDescriptor[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
  stop(): Promise<void>;
}
function extractText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  const envelope = raw as { content?: Array<{ text?: string }> };
  if (Array.isArray(envelope.content) && envelope.content[0]?.text != null) return envelope.content[0].text;
  throw new Error("unexpected callTool result shape ...");
}
```
**Rule:** `callTool` returns an SDK envelope `{ content: [{ text }] }` OR a raw value — tolerate both when parsing free/busy. The adapter interface is constructor/factory-injected so tests pass a hand-rolled stub.

### Error sanitization (replicate; do NOT import across modules)
**Source:** `src/mcp/external-client.ts:69` (canonical regex) and `src/hub/gmail-to-task.ts:97-105` (replication precedent)
```ts
const sanitized = msg.replace(/\b[A-Z_][A-Z0-9_]*=\S+/g, "[redacted]");
```
**Rule:** Replicate the regex inline in `google-connector.ts`. Do NOT `import` from `src/hub` or `src/mcp` — `src/calendar/types.ts:7-11` documents that calendar deliberately avoids cross-spec coupling.

### Connector factory implementing CalendarConnector
**Source:** `src/calendar/ics-connector.ts:63-76`
```ts
export function createIcsConnector(opts: IcsConnectorOptions): CalendarConnector {
  return {
    name: "ics",
    async readFreeBusy(_window) { ... },
    async writeEvents(items) { ... },
  };
}
```
**Rule:** Return an object literal satisfying `CalendarConnector` (connector.ts:23-27). Findings/token/egress arrive via the factory `opts`, NOT via the `writeEvents` signature (the interface must stay interchangeable with the .ics connector — DoD).

### 0600 token sidecar
**Source:** `src/medical/whoop/whoop-token.ts:64-86`
```ts
async readRefreshToken(): Promise<string | undefined> {
  try { /* JSON.parse(readFile(...)) */ } catch { return undefined; } // absent/corrupt => fail-closed
}
await writeFile(this.path(), JSON.stringify(tokens, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
```
**Rule:** `readToken()` fail-closed to `undefined`; write with `mode: 0o600` after `ensureDir`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `EgressGuard` | `src/medical/egress.ts:17` | `class; static fromConfig(c); assertAllowed(axis)` | MODEL for `CalendarEgressGuard` (do not reuse — calendar gets its own guard) |
| `ExternalMcpServer` | `src/mcp/external-client.ts:30` | `class(provider); start/listTools/callTool/stop` | Production MCP subprocess the GoogleCalendarToolAdapter wraps |
| `ToolDescriptor` | `src/mcp/external-client.ts:24` | `{ name; description?; inputSchema? }` | Type for the adapter's `listTools()` return — import as `type` |
| `sanitizeConnectorError` | `src/hub/gmail-to-task.ts:103` | `(msg: string) => string` | Precedent for the redaction regex — REPLICATE inline (do NOT import from hub) |
| `planSlots` | `src/calendar/slotter.ts:169` | `(findings, busy, constraints) => ProposedPlan` | sc-3-5: free/busy from the connector flows into this |
| `createIcsConnector` | `src/calendar/ics-connector.ts:63` | `(opts) => CalendarConnector` | Sibling connector — structural template + interchangeability target |
| `CalendarConnector` / `FreeBusyWindow` / `WriteResult` | `src/calendar/connector.ts:8,14,23` | interfaces | The contract the Google connector implements |
| `Finding` / `PlanItem` / `BusyInterval` | `src/calendar/types.ts:29,69,37` | types | Import as `type` from `./types.js` |
| `ensureDir` | `src/utils/fs.ts` | `(dir) => Promise<void>` | Token sidecar dir creation (imported by whoop-token.ts:4) |
| `readJson` | `src/utils/fs.ts` | `<T>(path) => Promise<T>` | JSON read (imported by finding-source.ts:4) |
| `findProjectRoot` | `src/utils/fs.ts` | `() => Promise<string \| undefined>` | CLI root resolution (calendar.ts:6) |
| `loadConfig` | `src/config/loader.ts` | `(root) => Promise<BoberConfig>` | Parse config to read the new `calendar` section (medical.ts:12) |

Directories reviewed: `src/utils/`, `src/calendar/`, `src/mcp/`, `src/medical/`, `src/hub/`, `src/vault/`, `src/config/`. The closest-matching utilities are listed above.

---

## 4. Prior Sprint Output

### Sprint 1 (0d141c1): types + slotter + finding-source + CLI
**Created:** `src/calendar/types.ts` — exports `Finding`/`FindingSchema` (with `calendarSafeTitle?`, `evidence[]`, `title`, `tags[]`), `PlanItem`, `BusyInterval`, `ProposedPlan`; `src/calendar/slotter.ts` — `planSlots(findings, busy, constraints)`.
**Connection:** sc-3-5 — `readFreeBusy()` returns `BusyInterval[]` that `planSlots` consumes end-to-end to a `ProposedPlan`. **CRITICAL:** `slotter.ts:209` makes `PlanItem.title = calendarSafeTitle ?? title`, so `PlanItem.title` is NOT safe — re-derive the summary from `Finding.calendarSafeTitle` in the connector.

### Sprint 2 (0481407): connector interface + ics connector
**Created:** `src/calendar/connector.ts` — `CalendarConnector { readonly name; readFreeBusy(window): Promise<BusyInterval[]>; writeEvents(items: PlanItem[]): Promise<WriteResult> }`, plus `WriteResult`, `FreeBusyWindow`; `src/calendar/ics-connector.ts` — `createIcsConnector(opts)`.
**Connection:** The Google connector implements the SAME `CalendarConnector` interface so it is interchangeable behind it (DoD + sc-3-2 typecheck). The `.ics` connector is the documented fallback for unattended runs.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM `.js` imports** for NodeNext (`:27`). All new imports use `.js` extensions.
- **`import type { ... }`** — `consistent-type-imports` is enforced (`:35`). Import `Finding`, `PlanItem`, `BusyInterval`, `ToolDescriptor`, `CalendarConnector` as types.
- **No sync fs** — use `node:fs/promises` only (`:42`).
- **Zod for all config** (`:29`) — the `calendar` section is a Zod schema in `config/schema.ts`.
- **Section comments** `// ── Name ──` (`:32`). Tests collocated `*.test.ts` (`:20`).

### Architecture Decisions
No `.bober/architecture/` ADR doc specific to calendar found. The egress-axis-default-false pattern is the medical ADR-6 lineage (`egress.ts:1`, `:4`). Sprint docs exist at `docs/sprints/sprint-spec-20260628-calendar-planner-1.md` and `-2.md`.

### Other Docs
`CLAUDE.md` global rule mandates tokensave for code exploration (already used). Existing connector module docs (e.g. `ics-connector.ts:1`) carry a one-line egress posture comment — follow that style.

---

## 6. Testing Patterns

### Unit Test Pattern — injectable stub adapter + axis-off zero-call
**Source:** `src/hub/gmail-to-task.test.ts:12-18, 72-81, 105-125` (the closest template)
```ts
import { describe, it, expect, vi } from "vitest";

function makeAdapter(resp: unknown) {
  return {
    listTools: vi.fn<[], Promise<ToolDescriptor[]>>().mockResolvedValue([]),
    callTool: vi.fn<[string, unknown], Promise<unknown>>().mockResolvedValue(resp),
  };
}

// sc-3-3: axis OFF → refuses, adapter NEVER touched
it("refuses when cloudCalendar=false and never calls the adapter", async () => {
  const adapter = makeAdapter({});
  const egress = CalendarEgressGuard.fromConfig({ calendar: { egress: { cloudCalendar: false } } } as BoberConfig);
  const conn = createGoogleConnector({ adapter, egress, token: "t", findings: [], });
  await expect(conn.writeEvents([])).rejects.toThrow(/calendar\.egress\.cloudCalendar/);
  expect(adapter.callTool).not.toHaveBeenCalled();
  expect(adapter.listTools).not.toHaveBeenCalled();
});

// sc-3-6: simulated adapter error is sanitized of KEY=VALUE
it("redacts tokens in thrown errors", async () => {
  const adapter = {
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockRejectedValue(new Error("GOOGLE_TOKEN=supersecret 500")),
  };
  const egress = CalendarEgressGuard.fromConfig({ calendar: { egress: { cloudCalendar: true } } } as BoberConfig);
  const conn = createGoogleConnector({ adapter, egress, token: "t", findings: [], });
  await expect(conn.writeEvents([{ findingId: "f1", title: "x", startIso: "...", endIso: "..." }]))
    .rejects.toThrow();
  // assert the message does NOT contain "supersecret" and DOES contain "[redacted]"
});
```
**sc-3-4 safe-title mapping (the privacy core):**
```ts
it("event summary equals calendarSafeTitle; payload excludes evidence/full title", async () => {
  const adapter = makeAdapter({});
  const finding: Finding = { id: "f1", title: "FULL SECRET TITLE", calendarSafeTitle: "Wellness block",
    evidence: ["LDL 190 mg/dL"], tags: ["medical"], /* ...required fields... */ } as Finding;
  const egress = CalendarEgressGuard.fromConfig({ calendar: { egress: { cloudCalendar: true } } } as BoberConfig);
  const conn = createGoogleConnector({ adapter, egress, token: "t", findings: [finding] });
  await conn.writeEvents([{ findingId: "f1", title: "FULL SECRET TITLE", startIso: "...", endIso: "..." }]);
  const [, payload] = adapter.callTool.mock.calls[0]!;
  const serialized = JSON.stringify(payload);
  expect((payload as { summary: string }).summary).toBe("Wellness block");
  expect(serialized).not.toContain("FULL SECRET TITLE");
  expect(serialized).not.toContain("LDL 190 mg/dL");
});
```
**sc-3-5 free/busy → slotter end-to-end:**
```ts
import { planSlots } from "./slotter.js";
it("readFreeBusy feeds planSlots to a ProposedPlan", async () => {
  const adapter = makeAdapter({ content: [{ text: JSON.stringify([{ startIso: "...", endIso: "..." }]) }] });
  const conn = createGoogleConnector({ adapter, egress: allowGuard, token: "t", findings });
  const busy = await conn.readFreeBusy({ windowStartIso: "...", windowEndIso: "..." });
  const plan = planSlots(findings, busy, constraints);
  expect(plan.scheduled.length).toBeGreaterThanOrEqual(0);
});
```
**Runner:** vitest. **Assertion:** `expect(...)`. **Mock:** `vi.fn()` injected stub (NO module mocks; NO real subprocess). **Naming:** `*.test.ts` collocated. **Env-var token restore idiom** (if reading env): see `whoop-token.test.ts:27-39` (save → delete → restore in `finally`).

### Source-scan test idiom (sc-3-6 doc/caveat presence)
**Source:** `src/calendar/ics-connector.test.ts:130-145`
```ts
const src = await readFile(join(dir, "google-connector.ts"), "utf8"); // or docs/calendar.md
expect(src).toMatch(/unattended|cron/i);
expect(src).toMatch(/\.ics/);
```

### E2E Test Pattern
Not applicable — no Playwright in this repo; all verification is vitest + tsc.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/config/loader.ts` | `BoberConfigSchema` | low | New `.optional()` field — existing configs still parse (additive) |
| `src/config/schema.test.ts` | `BoberConfigSchema` / `createDefaultConfig` | low | Configs without `calendar` still parse; `createDefaultConfig` output unchanged |
| `src/cli/commands/calendar.ts` | `CalendarConnector`, `planSlots` | low | This sprint does NOT modify it; ensure `CalendarConnector` shape unchanged so `createIcsConnector` wiring (`:112-122`) still typechecks |
| `src/cli/commands/calendar.test.ts` | `Finding`, `BusyInterval` | low | Imports calendar types — unaffected by additive connector |
| every `EgressGuard.fromConfig` caller | `config.medical` | none | Calendar guard is SEPARATE; do not touch `medical` egress |

### Existing Tests That Must Still Pass
- `src/medical/egress.test.ts` — covers `EgressGuard`; verify untouched (you create a NEW `CalendarEgressGuard`, do not edit `egress.ts`).
- `src/calendar/ics-connector.test.ts` — `.ics` connector + no-egress boundary scan; must stay green (do not edit `ics-connector.ts`).
- `src/calendar/slotter.test.ts` — `planSlots` purity; unchanged (read-only consumption in sc-3-5).
- `src/config/schema.test.ts` — config parsing; the additive `calendar` field must not change existing results.
- `src/mcp/external-client.test.ts` — sanitization/`listTools`/`callTool`; unchanged (you replicate the regex, not edit the file).
- `src/hub/gmail-to-task.test.ts` — the template; unchanged.

### Features That Could Be Affected
- **Calendar `.ics` connector (Sprint 2)** — shares `CalendarConnector` and `src/calendar/types.ts`. Verify the interface is implemented, not modified; both connectors remain interchangeable.
- **Sprint 4 approval gate (out of scope)** — will call this connector; keep the factory signature clean and the `CalendarConnector` surface intact.
- **Medical egress (Phase 6)** — shares the egress-guard PATTERN only; the calendar axis is INDEPENDENT and must not read or mutate `config.medical`.

### Recommended Regression Checks (run after implementation)
1. `npm run build` — zero tsc errors (sc-3-1).
2. `npm run typecheck` — `createGoogleConnector` return value structurally satisfies `CalendarConnector` (sc-3-2).
3. `npx vitest run src/calendar` — new + existing calendar tests green.
4. `npx vitest run src/config/schema.test.ts src/medical/egress.test.ts src/mcp/external-client.test.ts` — no regressions in touched-pattern neighbors.
5. `npx vitest run` (full suite) — confirm no count regression.

---

## 8. Implementation Sequence

1. **src/config/schema.ts** — add `CalendarSectionSchema` (model lines 385-396) + `CalendarSection` type; compose `calendar: CalendarSectionSchema.optional()` into `BoberConfigSchema` near line 498. Do NOT touch `createDefaultConfig`.
   - Verify: `npm run typecheck`; a config object `{}` plus `{ calendar: {} }` both parse; `config.calendar?.egress?.cloudCalendar` resolves to `false`/`undefined`.
2. **src/calendar/calendar-egress.ts** — `CalendarEgressGuard` (model `egress.ts:17-58`) with `fromConfig` reading `config.calendar?.egress?.cloudCalendar ?? false` and `assertCloudCalendarAllowed()` throwing a message containing `calendar.egress.cloudCalendar`.
   - Verify: a unit test asserts `assertCloudCalendarAllowed` throws when off, no-throw when on.
3. **src/calendar/calendar-token.ts** — `CalendarTokenStore` (model `whoop-token.ts:31-87`): `readToken()` fail-closed `undefined`, `writeToken()` `mode: 0o600`.
   - Verify: read-absent returns `undefined`; written file is `0o600` (POSIX-guarded test like `whoop-token.test.ts:96-106`).
4. **src/calendar/google-connector.ts** — `GoogleCalendarToolAdapter` interface + `sanitizeCalendarError` (replicate `external-client.ts:69`) + `createGoogleConnector` returning a `CalendarConnector`. Guard (egress + token) FIRST in both methods; `writeEvents` summary = `calendarSafeTitle ?? "Focus block"` from the findings map (NEVER `PlanItem.title`); sanitize all thrown errors. Add the unattended-OAuth caveat in the module doc-comment.
   - Verify: `npm run typecheck` (implements `CalendarConnector`); axis-off throws with zero adapter calls.
5. **docs/calendar.md** — caveat (hosted OAuth unfit for unattended/cron) + `.ics` fallback recommendation.
   - Verify: `grep -i "unattended\|cron" docs/calendar.md` and `grep "\.ics" docs/calendar.md` both hit.
6. **src/calendar/calendar-egress.test.ts + src/calendar/google-connector.test.ts** — sc-3-3 (axis-off zero-call), sc-3-4 (safe-title mapping, payload excludes evidence/full title), sc-3-5 (free/busy → `planSlots`), sc-3-6 (sanitized error + caveat source/doc scan).
   - Verify: `npx vitest run src/calendar`.
7. **Full verification** — `npm run build`, `npm run typecheck`, `npx vitest run`.

---

## 9. Pitfalls & Warnings

- **DO NOT use `PlanItem.title` as the event summary.** `slotter.ts:209` falls it back to the full `Finding.title`, leaking the sensitive "why". Map `findingId -> calendarSafeTitle` from the injected `findings`, and use `?? "Focus block"`. (sc-3-4)
- **Guard BEFORE the adapter.** Call `egress.assertCloudCalendarAllowed()` and the token-present check at the TOP of `readFreeBusy`/`writeEvents`, before any `listTools`/`callTool`. sc-3-3 asserts the stub's spies recorded zero calls. (See `gmail-to-task.ts:131-136`.)
- **Replicate the sanitizer; do NOT import it.** `sanitizeConnectorError` is exported from `src/hub/gmail-to-task.ts:103`, but `src/calendar/types.ts:7-11` documents calendar avoids cross-spec imports. Inline the regex `\b[A-Z_][A-Z0-9_]*=\S+/g -> "[redacted]"` (matches `external-client.ts:69`).
- **Schema must be additive.** `calendar` is `.optional()`; every field `.default()`-ed. Do NOT add `calendar` to `createDefaultConfig` (schema.ts:529-579 omits optional sections — `medical`/`vault`/`telemetry` are absent there too). A config with no `calendar` key must behave byte-identically.
- **Do NOT edit `src/medical/egress.ts` or `src/calendar/ics-connector.ts` or `src/calendar/connector.ts`.** Create a new guard and a new connector; the `CalendarConnector` interface stays frozen so both connectors remain interchangeable (DoD + sc-3-2).
- **`callTool` returns an SDK envelope OR a raw value.** Parse free/busy tolerantly (`{ content: [{ text }] }` then `JSON.parse`, else raw) — model `vault/mcp-adapter.ts:94-101`. Validate the parsed array against a Zod `BusyInterval` shape (model `finding-source.ts:10-15`) before returning.
- **Import paths from `src/calendar/`:** `../config/schema.js`, `../mcp/external-client.js`, `../utils/fs.js` (one `..`, calendar is `src/calendar/`). The whoop store uses `../../` because it sits one level deeper (`src/medical/whoop/`).
- **Token never in errors.** Even the "token absent" refusal must not echo a token value (there is none yet) — keep messages generic and point to the `.ics` fallback. Tokens/MCP env are sanitized out of all adapter-error rethrows.
- **OAuth handshake is OUT OF SCOPE.** Do not implement live OAuth or call real Google APIs in tests. Token is provisioned out-of-band into the 0600 sidecar; tests inject a stub adapter.
