# Sprint Briefing: WHOOP sync adapter + CLI

**Contract:** sprint-spec-20260617-medical-whoop-guardrails-3
**Generated:** 2026-06-17T00:00:00Z

---

## 0. TL;DR for the Generator

Build `WhoopSyncAdapter` (`src/medical/whoop/whoop-sync.ts`) — a **network-sync-shaped** adapter (NOT a file-path `IngestionAdapter`, ADR-1). It pages `WhoopClient.fetchPage` across the four collections, maps each `WhoopRecord` to `HealthObservation[]` (`source="whoop"`, a fixed metric+unit per known field, **id left unset** so the store derives it), and writes via the EXISTING `ObservationSink.writeBatch`. Then add a `bober medical whoop sync [--since <iso>]` subcommand in `src/cli/commands/medical.ts` mirroring `medical import`. Two test files. Build/typecheck/test/lint must stay green.

Five non-negotiables (all citation-backed below):
1. **No network import** in `whoop-sync.ts` or `medical.ts` — ESLint bans `fetch`/http in `src/medical/**` AND `src/cli/**`... (verify: ESLint medical boundary is `src/medical/**/*.ts`, see §9). All HTTP stays in `whoop-client.ts`.
2. **Do NOT set `HealthObservation.id`** from the WHOOP UUID — let `upsertObservations` derive the content SHA-256 (`health-store.ts:166`).
3. **On fetch throw, let it propagate** — no catch-and-continue. Committed batches survive (per-batch txn), partial corruption impossible (ADR-4).
4. **CLI never throws** — try/catch, `process.exitCode = 1`, `store.close()` in `finally` (mirror `medical.ts:41-69`).
5. **Default window = last 7 days** computed at the CLI boundary only (`new Date()` in the action); adapter+store never read the clock.

---

## 1. Target Files

### src/medical/whoop/whoop-sync.ts (create)

**Directory pattern:** `src/medical/whoop/` holds `whoop-client.ts`, `whoop-token.ts` (kebab-case, collocated `.test.ts`). Each file opens with a one-line `/** ... */` purpose doc and uses unicode `// ── Section ──` headers.
**Most similar existing file (structure to mirror):** `src/medical/adapters/apple-health.ts` — same shape (a `BATCH_CAP` constant, an adapter class with one async method that accumulates `recordsParsed`, writes via `sink.writeBatch`, reads `newRows` off the sink, returns `IngestionResult`). The KEY difference: this adapter is driven by **pagination over `WhoopClient`**, not a SAX stream, and its entry point is `sync(window, sink)` not `ingest(filePath, sink)`.

**Structure template (skeleton — adapt, do not copy verbatim):**
```typescript
/** WhoopSyncAdapter — network sync of WHOOP v2 records into the ObservationSink (ADR-1). NO network import. */
import type { ObservationSink, HealthObservation, IngestionResult } from "../types.js";
import type { WhoopClient, WhoopCollection, WhoopRecord, SyncWindow } from "./whoop-client.js";

// ── Mapping table ────────────────────────────────────────────────────
// Per-collection: WHOOP score-field name -> fixed (metric, unit). Unmapped fields are SKIPPED.
const WHOOP_FIELD_MAP: Record<WhoopCollection, Record<string, { metric: string; unit: string }>> = {
  recovery: {
    recovery_score:        { metric: "whoop_recovery_score",    unit: "%"   },
    resting_heart_rate:    { metric: "whoop_resting_heart_rate", unit: "bpm" },
    hrv_rmssd_milli:       { metric: "whoop_hrv",                unit: "ms"  },
    spo2_percentage:       { metric: "whoop_spo2",               unit: "%"   },
    skin_temp_celsius:     { metric: "whoop_skin_temp",          unit: "degC" },
  },
  sleep: {
    sleep_performance_percentage:   { metric: "whoop_sleep_performance", unit: "%"  },
    total_in_bed_time_milli:        { metric: "whoop_sleep_in_bed",      unit: "ms" },
    respiratory_rate:               { metric: "whoop_respiratory_rate",  unit: "rpm" },
  },
  cycle: {
    strain:            { metric: "whoop_strain",          unit: "score" },
    average_heart_rate:{ metric: "whoop_avg_heart_rate",  unit: "bpm"  },
    kilojoule:         { metric: "whoop_kilojoule",       unit: "kJ"   },
  },
  workout: {
    strain:            { metric: "whoop_workout_strain",  unit: "score" },
    average_heart_rate:{ metric: "whoop_workout_avg_hr",  unit: "bpm"  },
    kilojoule:         { metric: "whoop_workout_kilojoule", unit: "kJ" },
  },
};

const COLLECTIONS: WhoopCollection[] = ["recovery", "sleep", "cycle", "workout"];

// ── Record mapping ───────────────────────────────────────────────────
function mapWhoopRecords(collection: WhoopCollection, records: WhoopRecord[]): HealthObservation[] {
  const table = WHOOP_FIELD_MAP[collection];
  const out: HealthObservation[] = [];
  for (const rec of records) {
    for (const [field, value] of Object.entries(rec.metrics)) {
      const mapped = table[field];
      if (!mapped) continue;                 // unmapped fields skipped, never guessed
      out.push({
        // id left UNSET — store derives content-derived SHA-256 (do NOT use rec.id)
        metric: mapped.metric,
        value,
        unit: mapped.unit,
        tStart: rec.tStartIso,
        tEnd: rec.tEndIso,
        source: "whoop",
      });
    }
  }
  return out;
}

// ── WhoopSyncAdapter ─────────────────────────────────────────────────
export class WhoopSyncAdapter {
  readonly source = "whoop";
  constructor(private readonly client: WhoopClient) {}

  async sync(window: SyncWindow, sink: ObservationSink): Promise<IngestionResult> {
    let recordsParsed = 0;
    for (const collection of COLLECTIONS) {
      let cursor: string | undefined;
      do {
        const page = await this.client.fetchPage(collection, window, cursor); // throw PROPAGATES (fail-closed)
        const obs = mapWhoopRecords(collection, page.records);
        recordsParsed += obs.length;
        if (obs.length > 0) await sink.writeBatch(obs, []); // per-batch txn commits here
        cursor = page.nextCursor;
      } while (cursor);
    }
    const newRows = "newRows" in sink ? (sink as { newRows: number }).newRows : 0;
    return { recordsParsed, newRows };
  }
}
```
**The mapping table is a PROPOSAL — keep it small and reviewable.** Exact WHOOP v2 score field names are the real-world names; the test fixtures only assert mapped fields you choose. The ONLY hard rule (sc-3-2): mapped rows land with `source="whoop"` and a fixed metric+unit per field, and `recordsParsed`/`newRows` are correct. Pick a coherent subset; unmapped fields skipped.

**`newRows` accounting (CRITICAL):** Mirror apple-health exactly — read `newRows` OFF the sink at the end (`apple-health.ts:115-117`), do NOT sum per-batch return values (`writeBatch` returns `void`). `StoreObservationSink.newRows` accumulates across all `writeBatch` calls (`ingestion.ts:17,25`).

---

### src/cli/commands/medical.ts (modify)

**Relevant section to mirror — the `medical import` action (lines 34-70), this is the EXACT error/finally/exitCode template:**
```typescript
medicalCmd
  .command("import <file>")
  .description("Stream-import a health export file into the medical health store")
  .action(async (file: string) => {
    const projectRoot = await resolveRoot();
    try {
      const medicalDir = join(projectRoot, ".bober", "medical");
      await ensureDir(medicalDir);
      const dbPath = join(medicalDir, "health.db");
      const store = new HealthDataStore(dbPath);
      try {
        const sink = new StoreObservationSink(store);
        // ... build pieces, run, print result.recordsParsed / result.newRows ...
      } finally {
        store.close();                       // ALWAYS close (facts.ts:132-134)
      }
    } catch (err) {
      process.stderr.write(chalk.red(`Failed to import: ${err instanceof Error ? err.message : String(err)}\n`));
      process.exitCode = 1;                   // CLI handlers MUST NOT throw (facts.ts:135-142)
    }
  });
```
**Existing imports in this file (lines 2-12):** `join` (node:path), `chalk`, `Command` type (commander), `findProjectRoot`+`ensureDir` (`../../utils/fs.js`), `HealthDataStore`, `IngestionNormalizer`+`StoreObservationSink`, `AppleHealthAdapter`.
**New imports the `whoop sync` action needs (all type-imported where possible per `consistent-type-imports`):**
- `loadConfig` from `../../config/loader.js` (`loadConfig(projectRoot): Promise<BoberConfig>`, loader.ts:142) — import path used across `facts.ts:18`, `eval.ts:3`, etc. **The existing `import` action does NOT load config; the new action MUST**, because `EgressGuard.fromConfig(config)` needs it.
- `EgressGuard` from `../../medical/egress.js`
- `WhoopTokenStore` from `../../medical/whoop/whoop-token.js`
- `WhoopClient` from `../../medical/whoop/whoop-client.js`
- `WhoopSyncAdapter` from `../../medical/whoop/whoop-sync.js`
- `AuditLog` from `../../medical/audit.js` (for the 'ingest' audit entry — see §6 note)

**New subcommand to add inside `registerMedicalCommand` (after the `import` command block, before the closing `}` at line 71):**
```typescript
const whoopCmd = medicalCmd.command("whoop").description("WHOOP device-connection sync (ADR-1)");
whoopCmd
  .command("sync")
  .description("Sync WHOOP recovery/sleep/cycle/workout into the medical health store")
  .option("--since <iso>", "ISO-8601 window start (default: last 7 days)")
  .action(async (opts: { since?: string }) => {
    const projectRoot = await resolveRoot();
    let store: HealthDataStore | undefined;
    try {
      const config = await loadConfig(projectRoot);
      const egress = EgressGuard.fromConfig(config);
      // axis-off branch — clear message, exit 1, NEVER construct WhoopClient (no HTTP) (sc-3-5)
      if (!egress.isAllowed("device-connection")) {
        process.stderr.write(chalk.red(
          "device-connection egress not enabled — set medical.egress.deviceConnection: true in bober.config.json\n"));
        process.exitCode = 1;
        return;
      }
      const tokenStore = new WhoopTokenStore(projectRoot);
      try {
        tokenStore.clientCredentials();        // throws "set WHOOP_CLIENT_ID/SECRET" (whoop-token.ts:46-56) (sc-3-6)
      } catch (e) {
        process.stderr.write(chalk.red(`${e instanceof Error ? e.message : String(e)}\n`));
        process.exitCode = 1;
        return;
      }
      if ((await tokenStore.readRefreshToken()) === undefined) {  // (sc-3-6)
        process.stderr.write(chalk.red("WHOOP not yet authorised — run `bober medical whoop authorize` first.\n"));
        process.exitCode = 1;
        return;
      }
      // window: --since or now-7d, ISO; clock read ONLY here at the CLI boundary
      const endIso = new Date().toISOString();
      const startIso = opts.since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const medicalDir = join(projectRoot, ".bober", "medical");
      await ensureDir(medicalDir);
      store = new HealthDataStore(join(medicalDir, "health.db"));
      const client = new WhoopClient(egress, tokenStore);
      const adapter = new WhoopSyncAdapter(client);
      const sink = new StoreObservationSink(store);
      const result = await adapter.sync({ startIso, endIso }, sink);
      await new AuditLog(projectRoot).append({ tIso: endIso, event: "ingest" }); // IDs/enums only (§6)
      process.stdout.write(chalk.green("WHOOP sync complete\n"));
      process.stdout.write(`  records parsed: ${result.recordsParsed}\n`);
      process.stdout.write(`  new rows:       ${result.newRows}\n`);
    } catch (err) {
      process.stderr.write(chalk.red(`Failed to sync WHOOP: ${err instanceof Error ? err.message : String(err)}\n`));
      process.exitCode = 1;
    } finally {
      store?.close();                          // close even if sync threw mid-pagination
    }
  });
```
**Note on testability:** the success-path CLI test (sc-3-8) must inject a fixture `WhoopClient` and avoid real HTTP/clock. The action as written constructs `WhoopClient` internally, which is hard to fake from a CLI test without real network — and `fetch` is banned in `src/medical/**` test files. **Recommended refactor:** extract a tested helper `runWhoopSync(projectRoot, opts, deps?)` exported from `medical.ts`, where `deps` optionally injects `{ client, now }`. The `.action()` calls it with no deps (prod). Tests call the helper with a fixture client + fixed now. This mirrors `run.test.ts`'s pattern of calling `runRunCommand(...)` directly and `vi.mock`ing `loadConfig` (`run.test.ts:52-55, 116-120`). Pick whichever keeps the CLI test offline; the contract requires the test "invoke the command action".

**Imported by (who depends on medical.ts):**
- `src/cli/index.ts` (or the CLI registrar) calls `registerMedicalCommand`. Adding a subcommand is purely additive — the `import` command and its export signature are unchanged, so no dependent breaks. (Verify with grep in §7.)

**Test file:** `src/cli/commands/medical.test.ts` — DOES NOT EXIST yet (create it). The contract lists it in `estimatedFiles`.

---

### src/medical/whoop/whoop-sync.test.ts (create)

**Most similar existing test:** `src/medical/adapters/apple-health.test.ts` — temp-dir `HealthDataStore`, real `StoreObservationSink`, asserts `recordsParsed`/`newRows`, idempotent re-run (`apple-health.test.ts:260-293`), recording sink for mapping assertions (`apple-health.test.ts:74-103`). Also `whoop-client.test.ts` for the fixture-`fetchPage` style (but here you fake the WHOLE `WhoopClient`, not `FetchLike`).

**Fake WhoopClient pattern (queue of pages per collection; throws on demand):**
```typescript
import type { WhoopClient, WhoopCollection, WhoopPage, SyncWindow } from "./whoop-client.js";

function fakeClient(pages: Partial<Record<WhoopCollection, WhoopPage[]>>, throwOnNthCall?: number): WhoopClient {
  let call = 0;
  const cursors: Partial<Record<WhoopCollection, number>> = {};
  return {
    async fetchPage(collection: WhoopCollection, _window: SyncWindow, _cursor?: string): Promise<WhoopPage> {
      call++;
      if (throwOnNthCall !== undefined && call === throwOnNthCall) throw new Error("simulated mid-pagination failure");
      const idx = cursors[collection] ?? 0;
      cursors[collection] = idx + 1;
      return (pages[collection] ?? [{ records: [] }])[idx] ?? { records: [] };
    },
  } as unknown as WhoopClient; // duck-typed: sync only calls fetchPage
}
```
**Do NOT call real `fetch`** — `no-restricted-globals: fetch` is errored across all `src/medical/**/*.ts` INCLUDING tests (eslint.config.js:93-96). The fake client never touches the network.

---

## 2. Patterns to Follow

### Pattern A — content-derived id (do NOT set `id`)
**Source:** `src/medical/health-store.ts`, lines 155-175
```typescript
upsertObservations(rows: HealthObservation[]): number {
  const insertAll = this.db.transaction((obs: HealthObservation[]) => {
    let inserted = 0;
    for (const o of obs) {
      const id = o.id ?? observationId(o.metric, o.tStart, o.source, o.value); // <- derives when id unset
      const info = stmt.run(id, o.metric, o.value, o.unit, o.tStart, o.tEnd ?? null, o.source);
      inserted += info.changes;   // INSERT OR IGNORE => 0 for dup, 1 for new
    }
    return inserted;
  });
  return insertAll(rows);
}
```
**Rule:** Leave `HealthObservation.id` undefined in `mapWhoopRecords`. The dedup key is `SHA-256(metric|tStart|source|value)` (`observationId`, health-store.ts:32-42) — this is what makes re-runs idempotent (sc-3-3). Using `rec.id` (the WHOOP UUID) would break dedup.

### Pattern B — per-batch transaction = partial-failure safety
**Source:** `src/medical/health-store.ts`, lines 162-174 (`this.db.transaction(...)` runs synchronously and commits when `insertAll(rows)` returns)
**Rule:** Each `sink.writeBatch` -> `upsertObservations` is one atomic better-sqlite3 transaction. When a later `fetchPage` throws, every prior batch is already committed (ADR-4). Therefore: in `sync`, **do NOT wrap the whole loop in a try/catch that swallows** — let the throw propagate. sc-3-4 asserts page-1 rows survive after a page-2 throw.

### Pattern C — bounded-batch backpressure + read `newRows` off the sink
**Source:** `src/medical/adapters/apple-health.ts`, lines 96-99, 115-117
```typescript
while (buffer.length >= BATCH_CAP) {
  const batch = buffer.splice(0, BATCH_CAP);
  await sink.writeBatch(batch, []);          // await = backpressure
}
// ...
const newRows = "newRows" in sink ? (sink as { newRows: number }).newRows : 0;
return { recordsParsed, newRows };
```
**Rule:** `await` each `writeBatch`. WHOOP pages are naturally bounded (server page size), so each page can be one batch — no extra buffering needed unless a page is huge. Read `newRows` off the sink at the end; do not track it manually.

### Pattern D — CLI never throws (try/catch + exitCode + finally close)
**Source:** `src/cli/commands/medical.ts`, lines 41-69 (shown in §1)
**Rule:** Wrap the whole action body in try/catch; on error write a chalk.red message to stderr and set `process.exitCode = 1` (never `throw`, never `process.exit`). Close the store in `finally`.

### Pattern E — clear-throw credential check
**Source:** `src/medical/whoop/whoop-token.ts`, lines 46-56
```typescript
clientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env["WHOOP_CLIENT_ID"];
  const clientSecret = process.env["WHOOP_CLIENT_SECRET"];
  if (!clientId || !clientSecret) {
    throw new Error("WHOOP credentials missing — set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET environment variables and try again.");
  }
  return { clientId, clientSecret };
}
```
**Rule:** The CLI calls `tokenStore.clientCredentials()` inside its own try to surface this exact message with exit 1 (sc-3-6). `readRefreshToken()` returns `undefined` when unauthorised (whoop-token.ts:64-73) — that's the "authorize first" branch.

### Pattern F — unicode section headers + one-line module doc
**Source:** every file (e.g. `whoop-client.ts:14`, `apple-health.ts:1`); principles.md:32
**Rule:** Open each new file with `/** OneLine — purpose. */` and organize with `// ── Section ──` headers.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `StoreObservationSink` | `src/medical/ingestion.ts:16` | `new (store): ObservationSink` w/ `newRows: number` + `writeBatch(obs, labs): Promise<void>` | Batched writes into the store; accumulates `newRows`. REUSE — do not write your own sink. |
| `HealthDataStore.upsertObservations` | `src/medical/health-store.ts:155` | `(rows: HealthObservation[]): number` | INSERT OR IGNORE per-batch txn; returns new-row count. Reused via the sink. |
| `observationId` | `src/medical/health-store.ts:32` | `(metric, tStart, source, value): string` | The content-derived SHA-256 dedup key. You never call it directly — the store does. |
| `HealthDataStore.getObservations` | `src/medical/health-store.ts:181` | `(metric, fromIso, toIso): HealthObservation[]` | Query rows in tests to assert `source="whoop"` + counts (sc-3-2/3/4). |
| `HealthDataStore.close` | `src/medical/health-store.ts:265` | `(): void` | Close in CLI `finally` (sc-3-8). |
| `EgressGuard.fromConfig` | `src/medical/egress.ts:25` | `(config: BoberConfig): EgressGuard` | Build the guard from config; axes default false. |
| `EgressGuard.isAllowed` / `assertAllowed` | `src/medical/egress.ts:35,54` | `(axis): boolean` / `(axis): void (throws)` | Use `isAllowed("device-connection")` for the CLI's clean message branch (sc-3-5); `assertAllowed` throws `"Egress axis 'device-connection' not enabled"` if you prefer the catch route. |
| `WhoopTokenStore.clientCredentials` / `readRefreshToken` | `src/medical/whoop/whoop-token.ts:46,64` | `(): {clientId,clientSecret}` (throws) / `(): Promise<string \| undefined>` | Credential + refresh-token checks for sc-3-6 branches. |
| `WhoopClient.fetchPage` | `src/medical/whoop/whoop-client.ts:266` | `(collection, window, cursor?): Promise<WhoopPage>` | The ONLY data source. Calls `assertAllowed("device-connection")` first internally. |
| `AuditLog.append` | `src/medical/audit.ts:44` | `(entry: AuditEntry): Promise<void>` | Append the `event: "ingest"` audit entry (sc-3-8). IDs/enums only — `{ tIso, event: "ingest" }`. |
| `loadConfig` | `src/config/loader.ts:142` | `(projectRoot: string): Promise<BoberConfig>` | Load config in the CLI action (the `import` action does not, but `whoop sync` must). |
| `findProjectRoot` / `ensureDir` | `src/utils/fs.js` (used `medical.ts:6`) | `(): Promise<string\|undefined>` / `(dir): Promise<void>` | Resolve root + create `.bober/medical/`. Already imported in `medical.ts`. |

Utilities reviewed: `src/utils/` (fs only relevant), `src/medical/` (ingestion, health-store, egress, audit, whoop/*), `src/config/`. No new utility needs creating — all plumbing exists.

---

## 4. Prior Sprint Output

### Sprint 2 (commit e442cc9): WHOOP client + token store + 3rd egress axis
**Created:** `src/medical/whoop/whoop-client.ts` — exports:
- `class WhoopClient` with `fetchPage(collection: WhoopCollection, window: SyncWindow, cursor?: string): Promise<WhoopPage>` (whoop-client.ts:266) and `ensureAccessToken()`. Constructor: `(egress, tokenStore, fetchImpl?, waiter?, nowIso?)` (whoop-client.ts:151-164) — prod call passes only `(egress, tokenStore)`.
- `type WhoopCollection = "recovery" | "sleep" | "cycle" | "workout"` (whoop-client.ts:17)
- `type SyncWindow = { startIso: string; endIso: string }` (whoop-client.ts:20)
- `type WhoopRecord = { id: string; tStartIso: string; tEndIso?: string; metrics: Record<string, number> }` (whoop-client.ts:23-28) — **`metrics` holds all numeric `score.*` fields**; this is what `mapWhoopRecords` consumes.
- `type WhoopPage = { records: WhoopRecord[]; nextCursor?: string }` (whoop-client.ts:31) — `nextCursor === undefined` means last page; loop `do { ... } while (cursor)`.
- `type FetchLike` (whoop-client.ts:40) — only needed if you inject a fake at the `fetchImpl` level (you don't; fake the whole client).

**Created:** `src/medical/whoop/whoop-token.ts` — exports `class WhoopTokenStore` (`clientCredentials()` throws if env unset, `readRefreshToken(): Promise<string|undefined>`, `writeTokens()`), `interface WhoopTokens`.

**Created/extended:** `EgressGuard` gained `"device-connection"` as the third `EgressAxis` (egress.ts:5) with `fromConfig` reading `med?.egress?.deviceConnection ?? false` (egress.ts:30); config schema `medical.egress.deviceConnection` default false (schema.ts:384-385).

**Connection to this sprint:** `WhoopSyncAdapter` depends on `WhoopClient` (injected) and the WHOOP types. The CLI builds `WhoopTokenStore` + `WhoopClient` + checks `device-connection`. `WhoopClient.fetchPage` already calls `assertAllowed("device-connection")` first (whoop-client.ts:271) — runtime defense-in-depth; the CLI's `isAllowed` check is the user-friendly pre-flight.

### Base medical team (REUSE UNCHANGED)
`ObservationSink`/`StoreObservationSink`/`HealthDataStore`/`IngestionResult`/`HealthObservation`/`AuditLog` — all read above. Do NOT modify `IngestionAdapter`, `ObservationSink`, or the `health_observations` schema (nonGoals).

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM + `.js` import extensions** everywhere (line 27). All new imports MUST end `.js`.
- **`import type { ... }`** — `consistent-type-imports` enforced (line 35). Import `ObservationSink`, `HealthObservation`, `IngestionResult`, `WhoopClient`, `WhoopCollection`, `WhoopRecord`, `SyncWindow`, `BoberConfig` as types.
- **No synchronous fs** (line 42) — irrelevant here (better-sqlite3 is the sanctioned sync exception via the store; you never touch fs directly except `ensureDir`).
- **Unicode section headers** (line 32); **small single-purpose files** (line 33).
- **Prefix unused params with `_`** (line 36) — e.g. fake-client `_window`, `_cursor`.
- **Vitest, collocated `*.test.ts`** (line 20); tests use real temp dirs, no fs mocks (line 44).

### Architecture Decisions
- **ADR-1** (`arch-...-adr-1.md`): WHOOP is a **sink-feeding network adapter with a network `sync(window)` entry point — NOT the file-path `IngestionAdapter`** (`canHandle(filePath)`/`ingest(filePath, sink)` is for file imports only). `WhoopSyncAdapter` reuses `ObservationSink`/`HealthDataStore`/dedup downstream UNCHANGED; all HTTP confined to `whoop-client.ts`; triggered on-demand by `bober medical whoop sync`. Apple Health stays file-import as-is. (arch-1:3, 11, 17)
- **ADR-4** (`arch-...-adr-4.md`): **No cross-batch transaction, no persisted cursor.** Each `writeBatch` is atomic (per-batch better-sqlite3 txn, health-store.ts:163-174); a failed sync is recovered by **re-running** it; `INSERT OR IGNORE` over the content-derived SHA-256 makes it idempotent. A failed sync leaves committed batches intact; `newRows` on resume reflects only genuinely-new rows. **Do NOT add a checkpoint file.** (arch-4:3, 15, 17 — also nonGoals lines 61-62)

### Other Docs (CLAUDE.md / README)
No `CONTRIBUTING.md` coding guideline beyond principles.md. The `bober medical import` help text (medical.ts:36-38) is the description-style template for the new command.

---

## 6. Testing Patterns

### Unit Test Pattern (adapter)
**Source:** `src/medical/adapters/apple-health.test.ts`
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HealthDataStore } from "../health-store.js";
import { StoreObservationSink } from "../ingestion.js";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-whoop-sync-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); vi.restoreAllMocks(); });

it("maps records to source='whoop' rows and reports correct counts (sc-3-2)", async () => {
  const store = new HealthDataStore(join(tmpDir, "health.db"));
  try {
    const sink = new StoreObservationSink(store);
    const client = fakeClient({ recovery: [{ records: [
      { id: "1", tStartIso: "2026-06-16T08:00:00Z", metrics: { recovery_score: 85 } },
    ] }] });
    const adapter = new WhoopSyncAdapter(client);
    const result = await adapter.sync({ startIso: "2026-06-15T00:00:00Z", endIso: "2026-06-17T00:00:00Z" }, sink);
    expect(result.newRows).toBe(result.recordsParsed);
    const rows = store.getObservations("whoop_recovery_score", "2026-06-15", "2026-06-17");
    expect(rows[0]).toMatchObject({ source: "whoop", unit: "%", value: 85 });
  } finally { store.close(); }
});
```
**Idempotent resume (sc-3-3):** run `sync` twice with two fresh `StoreObservationSink`s over the same window/fixture; assert `run1.newRows > 0`, `run2.newRows === 0`, and `getObservations(...)` count unchanged. (Mirror `apple-health.test.ts:260-293`.)
**Partial-failure (sc-3-4):** `fakeClient(pages, throwOnNthCall: 2)` so page 1 commits then page 2 throws; `await expect(adapter.sync(...)).rejects.toThrow()`; then query the store — page-1 rows present and well-formed; then a clean re-run (new fake without the throw) reaches full state.

**Runner:** vitest. **Assertion style:** `expect(...).toBe/.toMatchObject/.rejects.toThrow`. **Mock approach:** duck-typed fakes + `vi.mock` for module deps; real temp-dir store (no fs mocks). **File naming:** `*.test.ts` collocated. **Location:** next to source.

### Unit Test Pattern (CLI)
**Best precedent — drives the REAL commander tree through `medical.ts`:** `src/medical/ingestion.test.ts:180-216` already tests `registerMedicalCommand` for the `import` command. COPY this exact shape for the new `whoop sync` tests (no `medical.test.ts` exists yet — create it):
```typescript
const writes: string[] = [];
const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { writes.push(String(chunk)); return true; });
const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { /* capture */ return true; });
const fsUtils = await import("../utils/fs.js");
const rootSpy = vi.spyOn(fsUtils, "findProjectRoot").mockResolvedValue(tmpDir); // resolveRoot() -> tmpDir
try {
  const { Command } = await import("commander");
  const { registerMedicalCommand } = await import("../cli/commands/medical.js");
  const program = new Command();
  program.exitOverride();
  registerMedicalCommand(program);
  await program.parseAsync(["node", "bober", "medical", "whoop", "sync"]);
} finally { stdoutSpy.mockRestore(); stderrSpy.mockRestore(); rootSpy.mockRestore(); }
expect(writes.join("")).toMatch(/records parsed/);
```
**Mocking deps to keep it offline:** `vi.mock("../config/loader.js", ...)` to return a config with/without `medical.egress.deviceConnection`, and `vi.mock("../cli/commands/whoop-client.js"...)` OR — cleaner — export a `runWhoopSync(projectRoot, opts, deps?)` helper from `medical.ts` and unit-test it directly with an injected fake `WhoopClient` + fixed `now` (avoids module-mock plumbing; mirrors `run.test.ts:116-120` calling `runRunCommand(...)`). Either keeps `fetch` out of the test (banned: eslint.config.js:93-96 — but note `medical.test.ts` is under `src/cli/`, not `src/medical/`, so the ban does not statically apply there; still keep it offline). Note `ingestion.test.ts` lives under `src/medical/` and stays offline by using a real file + spies, never `fetch`.
**sc-3-5 (axis off):** `loadConfig` returns config with `deviceConnection` absent/false; invoke the sync helper; assert stderr contains `device-connection egress not enabled`, `process.exitCode === 1`, and that **no `WhoopClient`/fetch was constructed** (spy: pass an injected fake client/now and assert the fake's `fetchPage` was never called, OR mock the `WhoopClient` module and assert its constructor spy has 0 calls).
**sc-3-6:** axis on + env unset -> assert `set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET` + exit 1; axis on + creds set + no token file -> assert `authorise`/`authorize first` + exit 1. Use `process.env["WHOOP_CLIENT_ID"]=...` / `delete` in beforeEach/afterEach (whoop-client.test.ts:82-83, 93-94).
**sc-3-8:** axis on + creds + token + fixture client -> assert stdout contains `records parsed:` and `new rows:`, that `store.close()` ran (spy on `HealthDataStore.prototype.close` via `vi.spyOn`), and an `event:"ingest"` line exists in `.bober/medical/audit-<date>.jsonl` (read the file; AuditLog mode/path pattern at audit.test.ts:21-28).
- **stdout/stderr capture:** `vi.spyOn(process.stdout, "write")` / `process.stderr, "write"` and read the captured args; assert `process.exitCode`. Reset `process.exitCode = 0` in afterEach so tests don't leak exit state.

### IMPORTANT — 'ingest' audit entry
The existing `medical import` path does **NOT** currently write an audit entry (grep confirms no `AuditLog` usage in `medical.ts` or `ingestion.ts`). The contract (sc-3-8) says "ingestion writes an audit entry event:'ingest' consistent with the existing import path." Resolution: **add the `AuditLog.append({ tIso, event: "ingest" })` call in the new `whoop sync` CLI action** (IDs/enums only — never record counts or health values; `AuditEvent` already includes `"ingest"` at types.ts:71). Optionally add the same one line to the `import` action for true consistency, but that is additive and out of the strict file set — keep it in the whoop action to satisfy sc-3-8. `tIso` = the injected `endIso` ISO string (never a fresh clock read inside AuditLog — AuditLog derives the filename date from the injected `tIso`, audit.ts:30-32).

### E2E Test Pattern
Not applicable — no Playwright in this repo (CLI tool, principles.md:48). Skip.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| CLI registrar (caller of `registerMedicalCommand`) | `src/cli/commands/medical.ts` | low | Adding a subcommand is additive; the `export function registerMedicalCommand(program)` signature is unchanged, `import` command untouched. Run `grep -rn "registerMedicalCommand" src/` to confirm the single call site is unaffected. |
| `src/medical/whoop/whoop-client.ts` | consumed by new `whoop-sync.ts` | low | `whoop-sync.ts` only calls `fetchPage` + uses exported types. No change to client. |
| `src/medical/ingestion.ts`, `health-store.ts`, `egress.ts`, `audit.ts`, `types.ts` | imported (read-only) by new code | none | REUSED UNCHANGED. nonGoals forbid modifying `ObservationSink`/`IngestionAdapter`/schema. |

**Run to confirm dependents (graph-gated fallback):**
```
grep -rn "registerMedicalCommand" src/
grep -rn "from \"./medical.js\"\|from \"../commands/medical" src/cli/
```

### Existing Tests That Must Still Pass
- `src/medical/whoop/whoop-client.test.ts` — tests `fetchPage` pagination/401/429/axis-off; unaffected (client unchanged) — verify still green.
- `src/medical/whoop/whoop-token.test.ts` — token store creds/sidecar; unaffected.
- `src/medical/adapters/apple-health.test.ts` — apple-health import + dedup; unaffected (the `import` command path unchanged).
- **`src/medical/ingestion.test.ts:180-256` — drives `registerMedicalCommand` through the REAL commander tree for `medical import` (stdout/exitCode assertions).** MUST still pass: do NOT edit the `import` command block when adding the `whoop` subcommand. This is the dependent test most likely to break from a careless edit to `medical.ts`.
- `src/medical/audit.test.ts` — if you append an 'ingest' entry, do NOT change `AuditLog`; the new `"ingest"` event is already in the `AuditEvent` union (types.ts:71), so no audit test breaks.
- The full medical suite + CLI suite — run `npm run test` for no regression (sc-3-7).

### Features That Could Be Affected
- **`medical import` (Apple Health)** — shares `medical.ts`, `HealthDataStore`, `StoreObservationSink`. Verify `bober medical import` still parses/dedups after adding the `whoop` subcommand (the action is independent; risk is only an accidental edit to the shared `import` block).
- **Egress zero-default guarantee (ADR-6)** — shares `EgressGuard`. Verify `device-connection` still defaults false and the axis-off branch fires before any HTTP (sc-3-5). Do not weaken the guard.
- **ESLint medical network boundary** — shared invariant. Verify `whoop-sync.ts`, `medical.ts`, and both test files contain NO `fetch`/`http`/`undici` etc.

### Recommended Regression Checks (run after implementation)
1. `npm run build` and `npm run typecheck` — zero errors (sc-3-1).
2. `npm run test` — full suite green, no regression (sc-3-7).
3. `npm run lint` — clean; the medical boundary still passes (sc-3-7). Confirm `whoop-sync.ts` is NOT on the ESLint exception list (only `whoop-client.ts` + `medline-source.ts` are, eslint.config.js:101).
4. `grep -n "fetch\|undici\|node:http\|node:https\| http\b" src/medical/whoop/whoop-sync.ts src/cli/commands/medical.ts` — expect zero network references.

---

## 8. Implementation Sequence

1. **`src/medical/whoop/whoop-sync.ts`** — types/imports first (all `import type`, `.js` extensions), then `WHOOP_FIELD_MAP` constant + `mapWhoopRecords` (pure helper, no deps beyond types), then `WhoopSyncAdapter` class (`source`, ctor, `sync` loop over `COLLECTIONS` with `do/while(cursor)`, propagate throws, read `newRows` off sink).
   - Verify: `npm run typecheck` clean; no network import; `sync` returns `{recordsParsed, newRows}`.
2. **`src/cli/commands/medical.ts`** — add the new imports (`loadConfig`, `EgressGuard`, `WhoopTokenStore`, `WhoopClient`, `WhoopSyncAdapter`, `AuditLog`), then the `whoop`->`sync` subcommand (or the exported `runWhoopSync` helper + thin `.action`). Mirror the `import` action's try/catch/finally/exitCode discipline (medical.ts:41-69). Compute window at the CLI boundary. Append the `event:"ingest"` audit entry on success.
   - Verify: `npm run build`; `bober medical whoop sync --help` lists the option; the `import` command still present and unchanged.
3. **`src/medical/whoop/whoop-sync.test.ts`** — fake `WhoopClient` (queue of pages, optional throw-on-Nth) + temp-dir `HealthDataStore` + real `StoreObservationSink`. Cover: mapping/source/counts (sc-3-2), idempotent resume (sc-3-3), partial-failure + clean re-run (sc-3-4).
   - Verify: `npm run test src/medical/whoop/whoop-sync.test.ts` green.
4. **`src/cli/commands/medical.test.ts`** — `vi.mock` `loadConfig`; invoke the action/helper directly. Cover: axis-off message + exit 1 + no HTTP (sc-3-5), env-unset + no-token branches (sc-3-6), success print + store.close spy + 'ingest' audit entry (sc-3-8). Inject a fixture client so no real network/clock.
   - Verify: `npm run test src/cli/commands/medical.test.ts` green; reset `process.exitCode` in afterEach.
5. **Run full verification** — `npm run build`, `npm run typecheck`, `npm run test`, `npm run lint` (all green, sc-3-1 / sc-3-7).

---

## 9. Pitfalls & Warnings

- **`fetch` is banned in ALL `src/medical/**/*.ts` — including `whoop-sync.ts` AND its test** (`no-restricted-globals: fetch`, eslint.config.js:93-96; `no-restricted-imports` for http/undici, eslint.config.js:76-91). Only `whoop-client.ts` is excepted (eslint.config.js:101). Fake the WHOLE `WhoopClient` in tests — never `FetchLike`/`fetch`. **Do NOT add `whoop-sync.ts` to the ESLint exception list.**
- **`medical.ts` lives under `src/cli/`, not `src/medical/`** — so the medical ESLint network ban does NOT apply there, but per ADR-1/sc-3-7 the CLI still must contain no HTTP (all HTTP stays in `whoop-client.ts`, reached only via `WhoopClient`). Don't import `fetch`/http into the CLI.
- **Do NOT set `HealthObservation.id` from `WhoopRecord.id`** (the WHOOP UUID). Leave `id` undefined; the store derives `SHA-256(metric|tStart|source|value)` (health-store.ts:166). Setting it would break idempotent dedup (sc-3-3) and risk double-counting if WHOOP mutates a record (ADR-1 Risk).
- **On `fetchPage` throw, let it PROPAGATE.** No catch-and-continue inside `sync`. The per-batch transaction already committed prior batches (ADR-4); swallowing the error would be fail-open and could leave a half-synced state silently (violates sc-3-4).
- **CLI MUST NOT throw and MUST NOT call `process.exit()`** — set `process.exitCode = 1` and `return` (medical.ts:67-68, facts.ts:135-142). `store.close()` in `finally` (use `store?.close()` since `store` may be undefined if you fail before constructing it).
- **Read the clock ONLY at the CLI boundary** — `new Date()` for the default 7-day window goes in the `.action`/helper, passed as ISO strings into `sync`. The adapter and store never read the clock (health-store.ts:11 "Never calls Date.now()"; assumption line 76). For testability, inject `now` into the helper.
- **The `import` action does NOT load config; the new `whoop sync` action MUST** (`EgressGuard.fromConfig(config)` needs it). Import `loadConfig` — it is not currently imported in `medical.ts`.
- **Axis-off must short-circuit BEFORE constructing `WhoopClient`** (sc-3-5: "without constructing a WhoopClient that performs HTTP"). Use `egress.isAllowed("device-connection")` for the clean message; do not rely solely on `WhoopClient`'s internal `assertAllowed` (that throws a less friendly message and only after construction).
- **`WhoopPage.nextCursor === undefined` terminates pagination** — `do { page = fetchPage(...); cursor = page.nextCursor } while (cursor)`. A fixture client must eventually return a page with no `nextCursor` or the loop never ends.
- **`newRows` comes from the sink, not from `writeBatch`** — `writeBatch` returns `void` (ingestion.ts:22). Read `sink.newRows` (apple-health.ts:115-117). Summing return values would always give 0.
- **`recordsParsed` counts MAPPED observations** (per the contract/assumption line 74: "recordsParsed counts mapped observations seen"), so increment by `obs.length` after `mapWhoopRecords`, NOT by `page.records.length` (unmapped fields are skipped and shouldn't be counted). Be consistent so sc-3-2 counts line up.
- **Audit entry holds IDs/enums ONLY** — `{ tIso, event: "ingest" }`. NEVER put `recordsParsed`/`newRows`/health values in the audit line (types.ts:64,76-77 PHI rule).
- **ESM `.js` extensions on every import** — `./whoop-client.js`, `../types.js`, `../../config/loader.js`, etc. NodeNext resolution; omitting `.js` fails the build.
