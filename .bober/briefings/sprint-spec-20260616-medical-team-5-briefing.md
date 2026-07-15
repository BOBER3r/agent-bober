# Sprint Briefing: Apple Health ingestion (SAX streaming) + `bober medical import`

**Contract:** sprint-spec-20260616-medical-team-5
**Generated:** 2026-06-16T00:00:00Z

---

## 0. TL;DR / Critical Facts

- **No SAX dep is installed.** `package.json` (lines 62-75) has NO `sax`/`saxes`/`node-expat`. You MUST add one. **Use `sax`** (pure-JS, no native build, no network surface) — `npm install sax` + `npm install -D @types/sax`. Ingestion genuinely needs streaming XML, so adding the dep is justified per the contract assumptions (line 73) and ADR risk row (architecture.md:320). Keep the import isolated to `src/medical/adapters/apple-health.ts`.
- **No existing `createReadStream` usage anywhere in the tree** (grep confirmed) — you are introducing the first streaming reader. Mirror Node's documented stream-pause/resume idiom; there is no in-repo precedent to copy, so this briefing supplies the template.
- **Idempotency is FREE** from S4's `HealthDataStore.upsertObservations` (`src/medical/health-store.ts:155-175`): `INSERT OR IGNORE` on SHA-256 `metric|tStart|source|value` returns the NEW-row count (sum of `info.changes`). Re-import => 0 new rows. Do NOT add your own dedup.
- **All types go additively into `src/medical/types.ts`** (do not break existing exports). `HealthObservation` (lines 95-106) and `LabResult` (lines 112-121) already exist — reuse them. The `'ingest'` AuditEvent already exists (types.ts:64-70).
- **CLI registration mirrors `registerFactsCommand`** (`src/cli/commands/facts.ts:54-59`) — a `register<Name>Command(program)` that creates a parent command (`medical`) and a sub-command (`import <file>`). Wire it into `src/cli/index.ts` next to line 314.

---

## 1. Target Files

### `src/medical/types.ts` (modify — ADD types only)

**Relevant section — existing reusable types (lines 95-121):**
```typescript
export interface HealthObservation {
  id?: string;            // optional on input; derived deterministically
  metric: string;
  value: number;
  unit: string;
  tStart: string;         // ISO 8601; INJECTED parameter — never Date.now()
  tEnd?: string;
  source: string;         // e.g. "apple-health" | "whoop"
}

export interface LabResult {
  id?: string;
  biomarker: string;
  value: number;
  unit: string;
  collectedAtIso: string;
  referenceLow?: number;
  referenceHigh?: number;
}
```

**ADD (append in a new `// ── Ingestion (S5) ──` section), matching the ADR interfaces (architecture.md:94-107):**
```typescript
export interface IngestionResult {
  recordsParsed: number;   // total <Record> elements seen (numeric ones)
  newRows: number;         // NEW rows actually inserted (dedup-aware)
}

export interface ObservationSink {
  writeBatch(obs: HealthObservation[], labs: LabResult[]): Promise<void>;
}

export interface IngestionAdapter {
  readonly kind: string;                  // e.g. "apple-health"
  canHandle(filePath: string): boolean;
  ingest(filePath: string, sink: ObservationSink): Promise<IngestionResult>;
}
```

**Imported by:** `src/medical/health-store.ts:22` (`HealthObservation`, `LabResult`, `Baseline`), `src/medical/numerics.ts`, `src/medical/consent.ts`, `src/medical/audit.ts`. Adding new exports is safe (additive); do NOT modify existing interfaces.

**Test file:** none for `types.ts` (type-only module — no runtime tests needed).

---

### `src/medical/ingestion.ts` (create)

**Directory pattern:** `src/medical/*.ts` — kebab/lowercase filenames, one class per file, leading JSDoc block `/** X — short desc (Phase 6, Sprint N). */`, `.js` import extensions, `import type` for type-only imports. See `src/medical/health-store.ts:1-22`, `src/medical/consent.ts:1-6`.

**Most similar existing file:** `src/medical/consent.ts` (small class wrapping a store + a dependency) and `src/medical/health-store.ts` (the store this wraps).

**Structure template:**
```typescript
/** IngestionNormalizer + ObservationSink — streaming health import (Phase 6, Sprint 5). */
import type { HealthDataStore } from "./health-store.js";
import type {
  HealthObservation,
  LabResult,
  IngestionAdapter,
  IngestionResult,
  ObservationSink,
} from "./types.js";

/** Batches observations into the synchronous HealthDataStore (async wrapper for backpressure). */
export class StoreObservationSink implements ObservationSink {
  public newRows = 0;            // accumulate NEW-row count across batches
  constructor(private readonly store: HealthDataStore) {}

  async writeBatch(obs: HealthObservation[], labs: LabResult[]): Promise<void> {
    if (obs.length > 0) this.newRows += this.store.upsertObservations(obs);  // sync call; returns NEW rows
    for (const lab of labs) this.newRows += this.store.upsertLabResult(lab);
    // async signature lets AppleHealthAdapter await + pause/resume the stream around it
  }
}

export class IngestionNormalizer {
  private readonly adapters: IngestionAdapter[] = [];

  register(adapter: IngestionAdapter): void {
    this.adapters.push(adapter);
  }

  async importFile(filePath: string): Promise<IngestionResult> {
    const adapter = this.adapters.find((a) => a.canHandle(filePath));
    if (!adapter) {
      throw new Error(`No ingestion adapter can handle '${filePath}'`);  // message MUST contain the path (sc-5-7)
    }
    return adapter.ingest(filePath, /* the sink */ ...);
  }
}
```
> NOTE: `importFile` needs the sink. Either construct the `StoreObservationSink` inside `importFile` (pass `store` into the `IngestionNormalizer` constructor) OR have the CLI build the sink and pass it. Simplest: `constructor(private readonly sink: ObservationSink)` and pass the sink in; `importFile` returns `adapter.ingest(filePath, this.sink)`. Pick one and be consistent with the test.

---

### `src/medical/adapters/apple-health.ts` (create)

**Directory pattern:** new `src/medical/adapters/` subdir (the contract `estimatedFiles` puts it there). The registry makes adapters additive (Whoop/CSV are explicit non-goals — contract lines 60-61).

**Most similar existing file:** none for SAX (no precedent). Mirror the medical module header + `.js` import style from `src/medical/health-store.ts:1-22`.

**Structure template (the load-bearing streaming + backpressure logic):**
```typescript
/** AppleHealthAdapter — SAX streaming import of Apple Health export.xml (Phase 6, Sprint 5). */
import { createReadStream } from "node:fs";
import sax from "sax";
import type { HealthObservation, IngestionAdapter, IngestionResult, ObservationSink } from "../types.js";

const BATCH_CAP = 1000;

export class AppleHealthAdapter implements IngestionAdapter {
  readonly kind = "apple-health";

  canHandle(filePath: string): boolean {
    return filePath.toLowerCase().endsWith(".xml");
    // (optionally sniff for "HealthData"/"export.xml" — keep it cheap, no full read)
  }

  ingest(filePath: string, sink: ObservationSink): Promise<IngestionResult> {
    return new Promise<IngestionResult>((resolve, reject) => {
      const parser = sax.createStream(true, { trim: true });  // strict, streaming
      const stream = createReadStream(filePath, { encoding: "utf-8" });
      let recordsParsed = 0;
      let newRows = 0;
      let buffer: HealthObservation[] = [];

      const flush = async (): Promise<void> => {
        if (buffer.length === 0) return;
        const batch = buffer;
        buffer = [];
        stream.pause();          // BACKPRESSURE: stop reading while the sink writes
        const before = newRows;  // (track via sink — see note below)
        await sink.writeBatch(batch, []);
        // capture NEW rows from the sink (e.g. sink.newRows delta) — see StoreObservationSink
        stream.resume();
      };

      parser.on("opentag", (node) => {
        if (node.name !== "Record") return;
        const a = node.attributes as Record<string, string>;
        const value = parseFloat(a.value);
        if (Number.isNaN(value)) return;          // skip non-numeric records (sc assumption)
        recordsParsed++;
        buffer.push({
          metric: a.type,                          // HK type -> metric
          value,                                   // value -> parseFloat
          unit: a.unit ?? "",                      // unit -> unit
          tStart: a.startDate,                     // startDate -> tStart (ISO; injected, never clock)
          tEnd: a.endDate || undefined,            // endDate -> tEnd
          source: "apple-health",                  // sourceName ignored; source is constant
        });
        if (buffer.length >= BATCH_CAP) {
          parser.pause();                          // pause SAX while we await the async flush
          flush().then(() => parser.resume()).catch(reject);
        }
      });
      parser.on("error", reject);
      parser.on("end", () => {
        flush()
          .then(() => resolve({ recordsParsed, newRows /* from sink */ }))
          .catch(reject);
      });
      stream.on("error", reject);
      stream.pipe(parser);
    });
  }
}
```
> CRITICAL: NEVER call `fs.readFile`/`readFileSync` on the whole file (contract non-goal line 65; sc-5-4). Use `createReadStream` + `stream.pipe(parser)` only. The `recordsParsed`/`newRows` accounting: the simplest robust approach is to read `newRows` off the `StoreObservationSink` (a `newRows` counter that accumulates) rather than threading it through `writeBatch`'s void return. Decide the contract for how the adapter learns `newRows` and keep it consistent with the sink shape above.

> BACKPRESSURE NOTE: `sax.createStream` is a Writable. Two valid pause points: pause the **SAX stream** (`parser.pause()`/`parser.resume()` — sax exposes these) OR pause the **source read stream** (`stream.pause()`/`stream.resume()`). The cleanest, test-observable pattern is: on hitting the cap inside `opentag`, `parser.pause()`, `await sink.writeBatch(...)`, then `parser.resume()`. Pausing the SAX parser stops it consuming, which propagates backpressure to the source read stream. Pick the form your sc-5-5 test can assert (the test uses a slow sink and verifies the parser awaited it — see Section 6).

**Test file:** `src/medical/adapters/apple-health.test.ts` (create — collocated, per contract).

---

### `src/cli/commands/medical.ts` (create)

**Most similar existing file:** `src/cli/commands/facts.ts` (parent command + sub-command, `register*Command(program)` export, `resolveRoot()` helper, never-throw handler that sets `process.exitCode = 1`).

**Registration template (mirror facts.ts:54-59 + audit-show.ts:45-52):**
```typescript
/** `bober medical import <file>` — stream-ingest a health export (Phase 6, Sprint 5). */
import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { ensureDir } from "../../utils/fs.js";
import { HealthDataStore } from "../../medical/health-store.js";
import { IngestionNormalizer, StoreObservationSink } from "../../medical/ingestion.js";
import { AppleHealthAdapter } from "../../medical/adapters/apple-health.js";

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

export function registerMedicalCommand(program: Command): void {
  const medicalCmd = program
    .command("medical")
    .description("Medical team utilities (health data import)");

  medicalCmd
    .command("import <file>")
    .description("Stream-import a health export file into the medical health store")
    .action(async (file: string) => {
      const projectRoot = await resolveRoot();
      try {
        await ensureDir(join(projectRoot, ".bober", "medical"));      // mirror consent.ts:76 / audit.ts:45-46
        const dbPath = join(projectRoot, ".bober", "medical", "health.db");
        const store = new HealthDataStore(dbPath);
        try {
          const sink = new StoreObservationSink(store);
          const normalizer = new IngestionNormalizer(sink);
          normalizer.register(new AppleHealthAdapter());
          const result = await normalizer.importFile(file);
          process.stdout.write(chalk.green(`Imported ${file}\n`));
          process.stdout.write(`  records parsed: ${result.recordsParsed}\n`);
          process.stdout.write(`  new rows:       ${result.newRows}\n`);
        } finally {
          store.close();                                              // ALWAYS close (mirror facts.ts:132-134)
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(`Failed to import: ${err instanceof Error ? err.message : String(err)}\n`),
        );
        process.exitCode = 1;                                         // handlers MUST NOT throw (facts.ts:135-142)
      }
    });
}
```

**Test file:** the contract `estimatedFiles` only lists `ingestion.test.ts` + `apple-health.test.ts`. sc-5-8 requires exercising the CLI wiring — you may add CLI assertions inside `ingestion.test.ts` (invoke `registerMedicalCommand` via a programmatic `Command`, per Section 6) OR add `src/cli/commands/medical.test.ts`. Either satisfies sc-5-8.

---

### `src/cli/index.ts` (modify — wire the command)

**Relevant section (lines 36-39 imports, 313-320 registration):**
```typescript
import { registerFactsCommand } from "./commands/facts.js";   // line 37
// ...
registerFactsCommand(program);                                // line 314
registerFleetCommand(program);                                // line 317
registerChatCommand(program);                                 // line 320
```

**ADD:** an import `import { registerMedicalCommand } from "./commands/medical.js";` near line 38, and `registerMedicalCommand(program);` in the registration block (e.g. after line 314, with a `// ── medical ──` comment header matching the existing style).

---

## 2. Patterns to Follow

### CLI command registration (parent + subcommand)
**Source:** `src/cli/commands/facts.ts`, lines 54-59
```typescript
export function registerFactsCommand(program: Command): void {
  const factsCmd = program
    .command("facts")
    .description("Inspect and manage semantic bi-temporal facts (add, list, show, invalidate)");
  factsCmd.command("add").description(...).action(async (opts) => { ... });
}
```
**Rule:** Export a `register<Name>Command(program: Command): void`; create a parent `.command("medical")` then a child `.command("import <file>")`. Wire it into `src/cli/index.ts`.

### CLI handler never throws — set exitCode, write to stderr
**Source:** `src/cli/commands/facts.ts`, lines 135-142
```typescript
} catch (err) {
  process.stderr.write(
    chalk.red(`Failed to add fact: ${err instanceof Error ? err.message : String(err)}\n`),
  );
  process.exitCode = 1;
}
```
**Rule:** Wrap the handler body in try/catch; on error write a chalk.red message and set `process.exitCode = 1` — do not rethrow.

### Store lifecycle — open, use in try, close in finally
**Source:** `src/cli/commands/facts.ts`, lines 99-134
```typescript
const store = new FactStore(factsDbPath(projectRoot, ns));
try {
  // ... use store ...
} finally {
  store.close();
}
```
**Rule:** Always `store.close()` in a `finally`. `HealthDataStore.close()` exists at `health-store.ts:265-267`.

### `.bober/medical/` directory + path
**Source:** `src/medical/consent.ts:76` and `src/medical/audit.ts:45-46`
```typescript
await ensureDir(join(this.projectRoot, ".bober", "medical"));   // consent.ts:76
await mkdir(dir, { recursive: true, mode: 0o700 });              // audit.ts:46
```
**Rule:** The medical DB lives at `.bober/medical/health.db`. Use `ensureDir` (from `src/utils/fs.ts:45`) before constructing the store.

### Dedup / idempotency — provided by S4 store
**Source:** `src/medical/health-store.ts:155-175`
```typescript
upsertObservations(rows: HealthObservation[]): number {
  // INSERT OR IGNORE on SHA-256(metric|tStart|source|value); info.changes is 0 dup / 1 new
  const insertAll = this.db.transaction((obs) => {
    let inserted = 0;
    for (const o of obs) { ... inserted += info.changes; }
    return inserted;
  });
  return insertAll(rows);
}
```
**Rule:** Accumulate the return value as `newRows`. A second import of the same file => `upsertObservations` returns 0 (sc-5-6). Do NOT implement your own dedup or call `Date.now()`.

### Module header + import style
**Source:** `src/medical/health-store.ts:1-22`
```typescript
/** HealthDataStore — ... (Phase 6, Sprint 4). */
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { HealthObservation, LabResult, Baseline } from "./types.js";  // .js extension + import type
```
**Rule:** Leading JSDoc `/** X — desc (Phase 6, Sprint 5). */`; ESM `.js` import extensions; `import type` for type-only imports.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `HealthDataStore` | `src/medical/health-store.ts:115` | `new (dbPath: string)` | SQLite store; ctor creates tables. Use `:memory:` in tests, `.bober/medical/health.db` in CLI. |
| `HealthDataStore.upsertObservations` | `src/medical/health-store.ts:155` | `(rows: HealthObservation[]): number` | INSERT OR IGNORE; returns NEW-row count (= idempotency). |
| `HealthDataStore.upsertLabResult` | `src/medical/health-store.ts:212` | `(result: LabResult): number` | INSERT OR IGNORE lab row; returns 0/1. Use if the sink also handles labs. |
| `HealthDataStore.getObservations` | `src/medical/health-store.ts:181` | `(metric, fromIso, toIso): HealthObservation[]` | Read back rows in tests to assert row count after re-import. |
| `HealthDataStore.close` | `src/medical/health-store.ts:265` | `(): void` | Close DB; call in `finally`. |
| `observationId` | `src/medical/health-store.ts:32` | `(metric, tStart, source, value): string` | Deterministic id; the store derives it — you do not need to call it. |
| `findProjectRoot` | `src/utils/fs.ts:58` | `(startDir?): Promise<string \| null>` | Resolve project root in the CLI handler (spy target in tests). |
| `ensureDir` | `src/utils/fs.ts:45` | `(path: string): Promise<void>` | mkdir -p; call before opening the store. |
| `fileExists` | `src/utils/fs.ts:10` | `(path: string): Promise<boolean>` | Optional: validate the import file exists before streaming. |
| `HealthObservation` / `LabResult` types | `src/medical/types.ts:95` / `:112` | interfaces | Reuse — map Apple Health attrs onto `HealthObservation`. |
| `AuditEntry` + `'ingest'` event | `src/medical/types.ts:76` / `:64-70` | interface / union | `'ingest'` event already supported. Audit wiring for ingest is OPTIONAL for S5 (the SOP audit lands in S6); do not add it unless a success criterion needs it (none do). |
| `chalk` | dep (package.json:66) | — | Colorize CLI output. |
| `commander` `Command` | dep (package.json:67) | — | CLI framework — `program.command(...)`. |

**Utilities reviewed:** `src/utils/` (fs.ts, logger.ts), `src/medical/` (all S1-S4 modules), `src/state/` (facts.ts pattern). No existing streaming/XML/SAX util exists — that is the net-new surface this sprint adds.

---

## 4. Prior Sprint Output

### Sprint 4 (907bae4): HealthDataStore + NumericsQueryLayer
**Created:** `src/medical/health-store.ts` — exports `HealthDataStore` (class), `observationId`, `labResultId`. `upsertObservations(rows): number` returns NEW-row count via INSERT OR IGNORE.
**Connection:** S5's `ObservationSink` wraps `HealthDataStore.upsertObservations`. Idempotent re-import (sc-5-6) is FREE from the S4 dedup — do not reimplement.

### Sprint 1 (60215d2) + S2 (4e0286d) + S3 (6fc7c97)
**Created:** `src/medical/types.ts` (shared types — `HealthObservation`, `LabResult`, `AuditEvent` incl. `'ingest'`), `src/medical/consent.ts`, `src/medical/audit.ts`, `src/medical/engine.ts`, `src/medical/red-flag.ts`.
**Connection:** Add ingestion types ADDITIVELY to `types.ts`. The `'ingest'` AuditEvent is already declared (types.ts:64-70) but wiring audit into ingestion is out of scope for S5 (no success criterion requires it).

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` found in the medical context. The HARD engineering constraints are in the architecture doc (architecture.md:29): ESM/`.js`/NodeNext; provider-agnostic; Zod config; `.bober/` JSON/SQLite state; `better-sqlite3` sync (like FactStore); strict TS zero-error gates; `node:fs/promises`; no unjustified `any`. PURE timestamp rule: stores never read the clock — all timestamps are injected ISO strings (health-store.ts:11-12, types.ts:101).

### Architecture Decisions
- **architecture.md:94-108 — IngestionNormalizer/IngestionAdapter/ObservationSink interfaces.** These are the EXACT type shapes to implement (reproduced in Section 1). `importFile` "Throws if no adapter `canHandle`" (API contract table, architecture.md:250).
- **architecture.md:281-285 — Ingestion data flow:** `bober medical import` → `importFile` → `adapter.canHandle` → `adapter.ingest` (SAX stream) → `sink.writeBatch` (bounded ~1000, pause/resume backpressure) → `upsertObservations` (INSERT OR IGNORE).
- **architecture.md:320 — Risk row:** "4GB SAX ingestion blocks event loop ... Streaming SAX parse + bounded ~1000-row batches with pause/resume backpressure; never loads whole document." This is the mandate for sc-5-4/5-5.
- **architecture.md:22 — Constraint:** "Apple Health export XML up to ~4GB → ingestion MUST stream (SAX/iterative), never load whole document."
- **Apple Health element shape** (contract assumption line 73 + data model architecture.md:184-192): `<Record type="..." unit="..." value="..." startDate="..." endDate="..." sourceName="..."/>`. Mapping: `type→metric`, `parseFloat(value)→value`, `unit→unit`, `startDate→tStart`, `endDate→tEnd`, constant `"apple-health"→source`. Skip records where `parseFloat(value)` is `NaN`.
- ADR-5 is about the chat detached-spawn contract (NOT ingestion) — not directly relevant to S5 beyond confirming the medical team boundary. No dedicated SAX/ingestion ADR file exists; the ingestion interface + risk guidance live in the main architecture doc above.

### Other Docs
`CLAUDE.md` / README: no medical-specific guidelines beyond the strict-TS/ESM gates already captured.

---

## 6. Testing Patterns

### Unit Test Pattern — temp dir + fixture file on disk
**Source:** `src/medical/health-store.test.ts:1-8, 143-170` (store/dedup) + `src/cli/commands/memory.test.ts:11-33` (temp dir + writeFile fixture)
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-ingest-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
```
**Runner:** vitest 3 (`package.json:99`, `"test": "vitest"`)
**Assertion style:** `expect(...).toBe(...)` / `.toHaveLength(...)`
**Mock approach:** `vi.spyOn` (e.g. `vi.spyOn(fsUtils, "findProjectRoot").mockResolvedValue(tmpDir)` — memory.test.ts:147; `vi.spyOn(process.stdout, "write")` — memory.test.ts:140-143). Restore with `vi.restoreAllMocks()` or per-spy `.mockRestore()`.
**File naming:** `<module>.test.ts`, collocated next to the source.
**Location:** co-located (NOT a separate `__tests__/` dir).

### Fixture XML + streaming/bounded/backpressure assertions (sc-5-4, sc-5-5, sc-5-6)
Write a small Apple Health XML fixture into `tmpDir` with `writeFile` (memory.test.ts:37-60 shows writing a fixture into a temp dir), e.g.:
```typescript
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" value="70.0" startDate="2026-01-01 06:00:00 +0000" endDate="2026-01-01 06:00:00 +0000" sourceName="Health"/>
  <Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" value="70.5" startDate="2026-01-02 06:00:00 +0000" endDate="2026-01-02 06:00:00 +0000" sourceName="Health"/>
</HealthData>`;
const file = join(tmpDir, "export.xml");
await writeFile(file, xml, "utf-8");
```
- **sc-5-4 (streaming, no whole-file read):** spy on `node:fs` — assert `createReadStream` is invoked and `readFile`/`readFileSync` is NOT. Either `vi.spyOn(fs, "createReadStream")` (import `* as fs from "node:fs"`) and assert called, OR drive ingest with a recording sink and assert batch sizes `<= BATCH_CAP`. A robust approach: a recording sink that pushes each batch's length into an array, then `expect(Math.max(...sizes)).toBeLessThanOrEqual(1000)`.
- **sc-5-5 (backpressure):** use a SLOW sink whose `writeBatch` returns a Promise that resolves after a delay, and record an ordering marker (e.g. push `"write-start"`/`"write-end"` around the await and a `"parse-resumed"` after). Assert the parser awaited the sink — i.e. no second `writeBatch` began before the first resolved, OR assert total observations == fixture count (proving nothing was dropped while paused). The evaluator (evaluatorNotes) expects "a sink that records batch sizes and introduces an await delay; assert every batch size <= the cap and that ingest awaited the slow sink."
- **sc-5-6 (idempotent):** run `importFile` on the fixture twice against the SAME `HealthDataStore`; assert second `IngestionResult.newRows === 0` and `store.getObservations(...)` length unchanged. (Mirrors health-store.test.ts:154-170.)
- **sc-5-7 (unknown file throws):** `await expect(normalizer.importFile(join(tmpDir, "x.bin"))).rejects.toThrow(/x\.bin/)` — message must contain the path.

### CLI wiring test (sc-5-8)
**Source:** `src/cli/commands/memory.test.ts:140-163` (programmatic commander invocation)
```typescript
const writes: string[] = [];
const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((c) => { writes.push(String(c)); return true; });
const fsUtils = await import("../../utils/fs.js");
const rootSpy = vi.spyOn(fsUtils, "findProjectRoot").mockResolvedValue(tmpDir);
try {
  const { Command } = await import("commander");
  const { registerMedicalCommand } = await import("./medical.js");   // or "../cli/commands/medical.js" depending on test location
  const program = new Command();
  program.exitOverride();                       // prevent process.exit in tests
  registerMedicalCommand(program);
  await program.parseAsync(["node", "bober", "medical", "import", file]);
} finally { stdoutSpy.mockRestore(); rootSpy.mockRestore(); }
expect(writes.join("")).toMatch(/new rows/);
```
> The fixture XML must be written under `tmpDir` AND `findProjectRoot` spied to `tmpDir` so the CLI writes `health.db` under `tmpDir/.bober/medical/`. Pass the absolute fixture path as `<file>`.

### E2E Test Pattern
Not applicable — no Playwright config in this repo. (Confirmed: no `playwright.config.ts`.)

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/medical/health-store.ts` | `src/medical/types.ts` | low | Adding new exported types to `types.ts` cannot break existing imports (purely additive). Do NOT modify `HealthObservation`/`LabResult`. |
| `src/medical/numerics.ts`, `consent.ts`, `audit.ts`, `engine.ts` | `src/medical/types.ts` | low | Same — additive type changes are safe. Verify no existing interface is renamed. |
| `src/cli/index.ts` | new `medical.ts` | low | Adding one import + one `register...(program)` line. The new `medical` command name must not collide (it does not — grep of index.ts confirms no `medical` command exists). |
| `package.json` | new `sax` dep | medium | Adding `sax` + `@types/sax`. Run `npm install` so `npm run build`/`typecheck`/`test` resolve the module. Ensure lockfile updates. |

### Existing Tests That Must Still Pass
- `src/medical/health-store.test.ts` — tests dedup + upsert counts; your sink relies on this exact behavior. Must stay green (you are not modifying health-store.ts).
- `src/medical/numerics.test.ts`, `consent.test.ts`, `audit.test.ts`, `engine.test.ts`, `red-flag.test.ts`, `team.test.ts` — all import from `types.ts`; verify additive type changes don't break compilation.
- `src/cli/commands/*.test.ts` (facts, memory, chat, audit-show, etc.) — verify your `src/cli/index.ts` edit doesn't break the command tree (these tests register their own commands programmatically, so index.ts edits rarely affect them, but build/typecheck must pass).

### Features That Could Be Affected
- **Medical SOP engine (S6, not yet built)** — shares `HealthDataStore` and `types.ts`. Keep new types additive so S6 can consume `IngestionResult`/`ObservationSink` without churn.
- **Programming team / other pipelineShapes** — byte-unaffected (architecture.md:24 HARD constraint). Your changes are confined to `src/medical/`, a new adapter dir, one CLI command, and one index registration line.

### Recommended Regression Checks
1. `npm run build` — zero TS errors (sc-5-1).
2. `npm run typecheck` — zero errors (sc-5-2). Ensure `@types/sax` is installed or provide a local `.d.ts`/typed import so strict mode passes.
3. `npm test` — full suite green incl. new ingestion tests (sc-5-3..5-8). Run the whole suite, not just new files, to confirm S1-S4 medical tests + CLI tests stay green.
4. Confirm `npm install sax @types/sax` (sax as dep, @types/sax as devDep) landed in `package.json` + lockfile.

---

## 8. Implementation Sequence

1. **`npm install sax` + `npm install -D @types/sax`** — add the streaming XML parser (no native build, no network surface).
   - Verify: `package.json` `dependencies.sax` + `devDependencies.@types/sax` present; `node_modules/sax` exists.
2. **`src/medical/types.ts`** — append `IngestionResult`, `ObservationSink`, `IngestionAdapter` (Section 1). Types only, no logic.
   - Verify: `npm run typecheck` — no errors; existing types untouched.
3. **`src/medical/ingestion.ts`** — `StoreObservationSink` (wraps `HealthDataStore.upsertObservations` + `upsertLabResult`, accumulates `newRows`) + `IngestionNormalizer` (`register`, `importFile` with no-adapter throw containing the path).
   - Verify: import-only typecheck passes; `importFile` throws on unknown file.
4. **`src/medical/adapters/apple-health.ts`** — `AppleHealthAdapter`: `createReadStream` + `sax.createStream` pipe; `opentag` maps `<Record>` attrs → `HealthObservation`; buffer to `BATCH_CAP` (1000); pause → `await sink.writeBatch` → resume; flush remainder on `end`; resolve `IngestionResult`.
   - Verify: ingest a 2-record fixture → `recordsParsed === 2`, rows in store; NEVER `readFile` the whole file.
5. **`src/cli/commands/medical.ts`** — `registerMedicalCommand(program)`: `medical import <file>` builds store at `.bober/medical/health.db`, sink, normalizer, registers `AppleHealthAdapter`, calls `importFile`, prints counts, closes store, never-throw handler.
   - Verify: programmatic commander invocation prints `new rows`.
6. **`src/cli/index.ts`** — add import + `registerMedicalCommand(program)` in the registration block (near line 314).
   - Verify: `npm run build` succeeds; `agent-bober medical import --help` would resolve.
7. **`src/medical/ingestion.test.ts`** — normalizer registry + no-adapter-throw + idempotent re-import (sc-5-6, sc-5-7) + CLI wiring (sc-5-8, programmatic Command).
8. **`src/medical/adapters/apple-health.test.ts`** — fixture XML; streaming (createReadStream used, not readFile) + bounded batches `<= 1000` (sc-5-4) + slow-sink backpressure ordering (sc-5-5).
9. **Run full verification** — `npm run build`, `npm run typecheck`, `npm test`.

---

## 9. Pitfalls & Warnings

- **NO `sax` dep installed yet** — the import will fail to compile/run until `npm install sax @types/sax`. Do this FIRST. If `@types/sax` is unavailable in the registry at build time, add a minimal local declaration (`declare module "sax";`) — but prefer `@types/sax` (it exists on npm).
- **`sax` default export style:** `sax` is CommonJS. Under NodeNext ESM use `import sax from "sax"` then `sax.createStream(...)`. If TS complains about default interop, `import * as sax from "sax"` is the fallback. Verify which compiles under the repo's strict NodeNext.
- **NEVER read the whole file** — no `readFile`/`readFileSync`/`fs.promises.readFile` on the import path. sc-5-4 explicitly asserts `createReadStream` is used. The 4GB constraint (architecture.md:22) is the whole reason this sprint exists.
- **Backpressure must be REAL, not cosmetic** — actually `await sink.writeBatch(...)` between `pause()` and `resume()`. A fire-and-forget `void sink.writeBatch(...)` would buffer unbounded rows and FAIL sc-5-5. The `ingest` Promise must not resolve until the final flush completes.
- **`newRows` accounting** — `writeBatch` returns `void` (the architecture interface). Read the NEW-row count off the `StoreObservationSink` (a `newRows` accumulator) — do NOT change the `ObservationSink` interface signature away from the ADR shape. `recordsParsed` is counted in the adapter (count of numeric `<Record>` elements).
- **Skip non-numeric records** — `parseFloat(a.value)` returns `NaN` for category/correlation records; skip them (don't push, don't count toward `recordsParsed` per the assumption, or count consistently — pick one and assert it).
- **Idempotency is the store's job** — do not add a Set/dedup in the adapter or sink. Re-import correctness (sc-5-6) comes entirely from `upsertObservations`' `INSERT OR IGNORE` (health-store.ts:157-159). Use the SAME store instance/db file across both imports in the test.
- **Timestamps are injected, never read** — `tStart`/`tEnd` come from the XML `startDate`/`endDate`. Never call `Date.now()`/`new Date()` in the adapter or sink (PURE-store contract, health-store.ts:11-12). Apple Health date format is `"2026-01-01 06:00:00 +0000"` — store it as-is (the store treats `tStart` as an opaque sortable string; it does NOT require canonical ISO-8601, though ISO sorts lexicographically per types.ts:178-180). Map the attribute value through unchanged unless a test demands normalization.
- **CLI handler must not throw** — wrap in try/catch, set `process.exitCode = 1`, write to stderr (facts.ts:135-142). In tests, `program.exitOverride()` (memory.test.ts:153) prevents `process.exit`.
- **Always `store.close()` in finally** — leaked better-sqlite3 handles can lock the temp DB file and break `afterEach` cleanup on some platforms.
- **`src/cli/commands/medical.ts` name collision** — none today, but the `medical` command is new; keep the sub-command exactly `import <file>` (sc-5-8 + definitionOfDone).
