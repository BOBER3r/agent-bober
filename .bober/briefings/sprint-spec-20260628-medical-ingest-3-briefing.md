# Sprint Briefing: bober medical import-labs <pdf> end-to-end command (fail-closed + audit + dedup)

**Contract:** sprint-spec-20260628-medical-ingest-3
**Generated:** 2026-06-28T00:00:00Z

> Scope: extend `src/cli/commands/medical.ts` with an exported `runImportLabs(projectRoot, pdfPath, deps)` core + a nested `medical import-labs <pdf>` subcommand, and add tests to `src/cli/commands/medical.test.ts`. Mirror the `runWhoopSync` structure exactly. Only TWO files change.

---

## 1. Target Files

### src/cli/commands/medical.ts (modify)

This is the canonical template. `runImportLabs` must mirror `runWhoopSync` byte-for-byte in structure: deps interface, try/finally with `store?.close()`, EgressGuard fail-closed gate, audit append.

**`WhoopSyncDeps` + `runWhoopSync` — THE pattern to mirror (lines 30-121):**
```ts
/** Injectable dependencies for runWhoopSync — production callers pass undefined. */
export interface WhoopSyncDeps {
  client?: WhoopClient;
  nowIso?: string;   // default: new Date().toISOString()
}

export async function runWhoopSync(
  projectRoot: string,
  opts: { since?: string },
  deps: WhoopSyncDeps = {},
): Promise<void> {
  let store: HealthDataStore | undefined;
  try {
    const config = await loadConfig(projectRoot);
    const egress = EgressGuard.fromConfig(config);

    // axis-off branch: clear message, exit 1, NEVER construct the client (FAIL CLOSED)
    if (!egress.isAllowed("device-connection")) {
      process.stderr.write(
        chalk.red(
          "device-connection egress not enabled — set medical.egress.deviceConnection: true in bober.config.json\n",
        ),
      );
      process.exitCode = 1;
      return;                       // <-- returns BEFORE building any client/reading data
    }
    // ... build store + client, run sync ...
    const nowIso = deps.nowIso ?? new Date().toISOString();
    const medicalDir = join(projectRoot, ".bober", "medical");
    await ensureDir(medicalDir);
    store = new HealthDataStore(join(medicalDir, "health.db"));   // dbPath wiring (95-98)
    // ...
    // Audit entry — IDs/enums only (never record counts or health values — PHI rule)
    await new AuditLog(projectRoot).append({ tIso: endIso, event: "ingest" });   // 105-106
  } catch (err) {
    process.stderr.write(chalk.red(`Failed to sync WHOOP: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
  } finally {
    store?.close();   // always close — even if it threw (118-120)
  }
}
```

**Subcommand registration — nest under the existing `medical` tree (lines 130-189).** `import-labs` is NOT a new top-level command. Add it alongside `import` (136-172). Mirror the `.action` error-handling at lines 163-171 (set `process.exitCode = 1`, never throw):
```ts
export function registerMedicalCommand(program: Command): void {
  const medicalCmd = program.command("medical").description("...");

  medicalCmd.command("import <file>") /* ...existing... */;

  // NEW: medical import-labs <pdf>
  medicalCmd
    .command("import-labs <pdf>")
    .description("Parse a lab PDF and ingest results into the medical health store")
    .option("--vault <dir>", "vault dir (default: under .bober/medical)")
    .action(async (pdf: string, opts: { vault?: string }) => {
      const projectRoot = await resolveRoot();        // line 23-26 helper
      await runImportLabs(projectRoot, pdf, {}, opts); // deps={} in production
    });

  const whoopCmd = medicalCmd.command("whoop")...;     // existing (174-188)
}
```
Note: the existing `whoop sync` action (185-188) calls `runWhoopSync(projectRoot, opts)` with no deps — copy that exact shape.

**Imports already present in this file (reuse — do NOT re-add):**
- `join` from `node:path`, `chalk`, `type { Command }` from `commander`
- `findProjectRoot, ensureDir` from `../../utils/fs.js`
- `loadConfig` from `../../config/loader.js`
- `HealthDataStore` from `../../medical/health-store.js`
- `EgressGuard` from `../../medical/egress.js`
- `AuditLog` from `../../medical/audit.js`

**New imports `runImportLabs` needs to add:**
- `import { readFile } from "node:fs/promises";`
- `import { parseLabPdf } from "../../medical/lab-pdf-parser.js";`
- `import { writeLabNote } from "../../medical/lab-note.js";`
- `import { reindexLabNotes } from "../../medical/lab-reindex.js";`
- `import { buildMedicalInferenceClient } from "../../medical/inference.js";`

**Imported by:** `src/cli/commands/index.ts` (or the CLI entry that calls `registerMedicalCommand`). Adding a subcommand is additive — existing `import` / `whoop sync` wiring is untouched.

**Test file:** `src/cli/commands/medical.test.ts` (exists) — extend it.

---

### src/cli/commands/medical.test.ts (modify)

Add `describe` blocks for `runImportLabs` mirroring the existing `runWhoopSync` tests. See Section 6 for the exact templates (config fixture, stderr/stdout spies, audit read-back, spy-never-called).

---

## 2. Patterns to Follow

### Fail-closed ordering (LOAD-BEARING — sc-3-3)
**Source:** `src/cli/commands/medical.ts`, lines 50-62; resolver mirror `src/medical/inference.ts:43-49`
Exact order inside `runImportLabs` (from `generatorNotes`):
1. `const config = await loadConfig(projectRoot);`
2. `const egress = EgressGuard.fromConfig(config);`
3. `if (!egress.isAllowed("cloud-inference")) { stderr message naming medical.egress.cloudInference; process.exitCode = 1; return; }`  ← **BEFORE** any `readFile`, before `buildMedicalInferenceClient`, before `deps.parse`.
4. `const { client, model } = buildMedicalInferenceClient(config, egress);`
5. `const pdfBytes = await readFile(pdfPath);` then `const parse = deps.parse ?? parseLabPdf;` `const report = await parse(pdfBytes, { client, model });`
6. write notes + reindex into store
7. `await new AuditLog(projectRoot).append({ tIso: nowIso, event: "ingest" });`
8. `finally { store?.close(); }`
**Rule:** The egress check is step 3 and `return`s before reading bytes or building the client — sc-3-3 asserts the injected parser spy is called 0 times.

### EgressGuard resolution
**Source:** `src/medical/egress.ts`, lines 25-48
```ts
static fromConfig(config: BoberConfig): EgressGuard { /* all axes default false */ }
isAllowed(axis: EgressAxis): boolean   // "cloud-inference" | "literature-retrieval" | "device-connection"
```
**Rule:** Use `egress.isAllowed("cloud-inference")` (the axis for this sprint — WHOOP used `"device-connection"`).

### Production parse client
**Source:** `src/medical/inference.ts`, lines 31-56
```ts
export function buildMedicalInferenceClient(
  config: BoberConfig, egress: EgressGuard, factory: ClientFactory = createClient,
): { client: LLMClient; model: string }
```
**Rule:** Call `buildMedicalInferenceClient(config, egress)` to get `{ client, model }` and pass them to `parse(pdfBytes, { client, model })`. It is itself fail-closed (cloud config without the axis → local). With no `medical.inference` config it returns a LOCAL openai-compat client that is *constructed but never network-touched* in tests (the injected `deps.parse` ignores it). See Pitfalls.

### Audit append — IDs/enums ONLY
**Source:** `src/cli/commands/medical.ts:105-106`; `src/medical/audit.ts:44-58`; `src/medical/types.ts:80-92`
```ts
await new AuditLog(projectRoot).append({ tIso: nowIso, event: "ingest" });
```
`AuditEntry` (types.ts:80-92) allowed fields ONLY: `tIso` (injected ISO), `event` (AuditEvent enum, includes `"ingest"` at types.ts:71), optional `rulesetVersion?`, `patternsetVersion?`, `ruleId?`, `criticVerdict?`. **There is NO `value`/count/PHI field — never put marker values, panel names, record counts, or prompt text in the audit entry.** For this sprint emit exactly `{ tIso: nowIso, event: "ingest" }`.

### Vault note write + reindex composition (Sprint 2)
**Source:** `src/medical/lab-note.ts:191-236`, `src/medical/lab-reindex.ts:32-58`
```ts
// writeLabNote(vaultDir, marker: ParsedLabMarker, meta: LabNoteMeta): Promise<string>
// LabNoteMeta = { panel: string; collectedAtIso: string; source: string }   (lab-note.ts:26-31)
for (const marker of report.markers) {
  await writeLabNote(vaultDir, marker, {
    panel: report.panel,
    collectedAtIso: report.collectedAtIso,
    source: "lab-pdf",          // a stable source label for this ingest path
  });
}
const newRows = await reindexLabNotes(vaultDir, store);   // returns NEW-row count (dedup via INSERT OR IGNORE)
```
**Rule:** Write one note per marker, then call `reindexLabNotes(vaultDir, store)` ONCE to upsert all notes; its return value IS the "new rows" to report. Dedup is automatic (sc-3-4): a second run over the same notes returns 0.

### Lab parser call surface (Sprint 1)
**Source:** `src/medical/lab-pdf-parser.ts:9-14, 53-78`
```ts
export interface ParseLabPdfDeps { client: LLMClient; model: string }
export async function parseLabPdf(pdfBytes: Uint8Array, deps: ParseLabPdfDeps): Promise<ParsedLabReport>
// ParsedLabReport = { panel: string; collectedAtIso: string; markers: ParsedLabMarker[] }  (lab-types.ts:15-24)
// ParsedLabMarker = { name; value; unit; referenceLow?; referenceHigh?; critical? }        (lab-types.ts:6-13)
```
**Rule:** `deps.parse` in `ImportLabsDeps` is typed `parse?: typeof parseLabPdf` so injected fakes match `(pdfBytes, {client,model}) => Promise<ParsedLabReport>`.

### Store dbPath wiring + getLabSeries
**Source:** `src/cli/commands/medical.ts:144-148, 95-98`; `src/medical/health-store.ts:196-206, 212-230, 265-266`
```ts
const medicalDir = join(projectRoot, ".bober", "medical");
await ensureDir(medicalDir);
store = new HealthDataStore(join(medicalDir, "health.db"));
// store.getLabSeries(biomarker): LabResult[]  (ASC by collected_at) — tests assert the marker appears
// store.upsertLabResult(result): number       (called inside reindexLabNotes; returns 0|1)
// store.close(): void
```
**Rule:** Default `vaultDir` to the medical dir (`join(projectRoot, ".bober", "medical")`) unless `--vault` overrides it; reuse the same `health.db` dbPath. Notes land under `<vaultDir>/labs/...`, store under `<medicalDir>/health.db`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `parseLabPdf` | `src/medical/lab-pdf-parser.ts:53` | `(pdfBytes: Uint8Array, deps:{client,model}) => Promise<ParsedLabReport>` | Sprint 1 PDF→structured parse (inject fake in tests) |
| `buildMedicalInferenceClient` | `src/medical/inference.ts:31` | `(config, egress, factory?) => {client, model}` | Production parse client, cloud-gated, fail-closed |
| `writeLabNote` | `src/medical/lab-note.ts:191` | `(vaultDir, marker, meta) => Promise<string>` | Sprint 2 write one marker as a vault note |
| `reindexLabNotes` | `src/medical/lab-reindex.ts:32` | `(vaultDir, store) => Promise<number>` | Sprint 2 upsert notes→store, returns NEW-row count |
| `EgressGuard.fromConfig` | `src/medical/egress.ts:25` | `(config) => EgressGuard` | Resolve egress axes from config |
| `EgressGuard.isAllowed` | `src/medical/egress.ts:35` | `(axis) => boolean` | Gate check; use `"cloud-inference"` |
| `AuditLog#append` | `src/medical/audit.ts:44` | `(entry: AuditEntry) => Promise<void>` | Append IDs/enums-only audit line |
| `HealthDataStore` | `src/medical/health-store.ts:115` | `new (dbPath)`; `.getLabSeries`, `.upsertLabResult`, `.close` | SQLite derived index |
| `loadConfig` | `src/config/loader.js` (imported medical.ts:8) | `(projectRoot) => Promise<BoberConfig>` | Load + Zod-validate config |
| `ensureDir` | `src/utils/fs.ts:45` | `(path) => Promise<void>` | mkdir -p (async) |
| `findProjectRoot` | `src/utils/fs.ts:58` | `() => Promise<string \| undefined>` | Used by `resolveRoot()` (medical.ts:23-26) |

Utilities reviewed in `utils/`, `lib/`, `helpers/`: only `utils/fs.ts` (`ensureDir`, `findProjectRoot`) is relevant; the rest are medical-module-local.

---

## 4. Prior Sprint Output

### Sprint 1 (be98982): lab PDF parser
**Created:** `src/medical/lab-pdf-parser.ts` — exports `parseLabPdf`, `ParseLabPdfDeps`; `src/medical/lab-types.ts` — exports `ParsedLabReport`, `ParsedLabMarker`, Zod schemas. `buildMedicalInferenceClient` lives in `src/medical/inference.ts`.
**Connection:** `runImportLabs` builds `{client, model}` via `buildMedicalInferenceClient(config, egress)` and feeds them to `parseLabPdf` (or the injected `deps.parse`).

### Sprint 2 (181f30c): vault note writer + reindexer
**Created:** `src/medical/lab-note.ts` — `writeLabNote`, `LabNoteMeta`; `src/medical/lab-reindex.ts` — `reindexLabNotes`.
**Connection:** `runImportLabs` calls `writeLabNote` per marker then `reindexLabNotes(vaultDir, store)` once; the return value is the "new rows" count and provides ingest-time dedup (sc-3-4).

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM .js extensions** on all relative imports (line 27) — `import { parseLabPdf } from "../../medical/lab-pdf-parser.js";`
- **`import type { ... }`** for type-only imports (lines 35, `consistent-type-imports` is a hard lint gate) — e.g. `import type { ImportLabsDeps }` would be self; but `ParsedLabReport` if imported should be `import type`.
- **No `any`** (line 40) — use `unknown` + narrowing (test mocks use `as unknown as X`).
- **No sync fs** (line 42) — use `node:fs/promises` `readFile` for the PDF.
- **Tests create temp dirs, no fs mocks** (line 44) — `mkdtemp` + `rm`, exactly as existing tests do.
- **Section comments** `// -- Name ---` box headers (line 32).

### Architecture Decisions
ADR-6 (zero-egress, axes default false) governs the fail-closed gate; ADR-3 (deterministic JS numerics / no-LLM status) governs `deriveLabStatus`. PHI rule (audit.ts:1, types.ts:64) governs the audit shape. No new ADR doc needed for this sprint.

### Other Docs
None additional. `bober.config.json` medical schema at `src/config/schema.ts:374-401`.

---

## 6. Testing Patterns

**Runner:** vitest. **Assertion:** `expect`. **Mocks:** `vi.mock` for `loadConfig`; spies via `vi.spyOn`. **File naming:** collocated `medical.test.ts`. **Temp dirs:** `mkdtemp(join(tmpdir(), "bober-medical-cli-"))` + `rm` in `afterEach`. **process.exitCode** saved/restored in `beforeEach`/`afterEach` (test lines 50-65).

### Config fixture (extend the existing helper — medical.test.ts:27-32)
The existing `makeConfig(deviceConnection)` only sets `deviceConnection`. Add a cloud-inference variant:
```ts
function makeLabsConfig(cloudInference: boolean): BoberConfig {
  return {
    project: { name: "test", mode: "greenfield" },
    medical: { egress: { cloudInference, deviceConnection: false, literatureRetrieval: false } },
  } as unknown as BoberConfig;
}
```

### sc-3-2 happy path (mirror the success test at medical.test.ts:177-247)
```ts
const { loadConfig } = await import("../../config/loader.js");
vi.mocked(loadConfig).mockResolvedValue(makeLabsConfig(true));   // axis ON

const stdoutWrites: string[] = [];
const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((c) => { stdoutWrites.push(String(c)); return true; });
const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

const fakeParse = vi.fn(async () => ({
  panel: "CBC", collectedAtIso: "2026-06-01T08:00:00.000Z",
  markers: [{ name: "Hgb", value: 14.2, unit: "g/dL", referenceLow: 13, referenceHigh: 17 }],
}));

const { runImportLabs } = await import("./medical.js");
const fixedNow = "2026-06-17T12:00:00.000Z";
// NOTE: writeFile a dummy pdf so readFile succeeds — bytes content is irrelevant (parser is faked)
await import("node:fs/promises").then(({ writeFile, mkdir }) =>
  mkdir(join(tmpDir, ".bober", "medical"), { recursive: true }).then(() =>
    writeFile(join(tmpDir, "labs.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46]))));
await runImportLabs(tmpDir, join(tmpDir, "labs.pdf"), { parse: fakeParse, nowIso: fixedNow });

stdoutSpy.mockRestore(); stderrSpy.mockRestore();
expect(fakeParse).toHaveBeenCalledTimes(1);

// note written + reindexed: getLabSeries returns the marker
const store = new HealthDataStore(join(tmpDir, ".bober", "medical", "health.db"));
expect(store.getLabSeries("Hgb").length).toBeGreaterThan(0);
store.close();

// audit gained an 'ingest' entry (IDs/enums only) — read-back pattern from audit.test.ts:35-44 / medical.test.ts:233-246
const auditPath = join(tmpDir, ".bober", "medical", `audit-${fixedNow.slice(0,10)}.jsonl`);
const auditContent = await readFile(auditPath, "utf-8");
const entry = JSON.parse(auditContent.split("\n").filter(Boolean)[0]!) as { event: string; tIso: string };
expect(entry.event).toBe("ingest");
expect(entry.tIso).toBe(fixedNow);
expect(auditContent).not.toContain("14.2");   // PHI: no health value in audit
expect(auditContent).not.toContain("Hgb");    // no marker name
```

### sc-3-3 fail-closed, spy NEVER called (mirror axis-off test at medical.test.ts:67-107)
```ts
vi.mocked(loadConfig).mockResolvedValue(makeLabsConfig(false));   // axis OFF (default)
const stderrWrites: string[] = [];
const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((c) => { stderrWrites.push(String(c)); return true; });
const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

const parseSpy = vi.fn(async () => ({ panel: "x", collectedAtIso: "2026-01-01", markers: [] }));
// write a pdf so we can prove it was NOT read
await import("node:fs/promises").then(({ writeFile }) =>
  writeFile(join(tmpDir, "labs.pdf"), Buffer.from([1])));

const { runImportLabs } = await import("./medical.js");
await runImportLabs(tmpDir, join(tmpDir, "labs.pdf"), { parse: parseSpy, nowIso: "2026-06-17T12:00:00Z" });
stderrSpy.mockRestore(); stdoutSpy.mockRestore();

expect(stderrWrites.join("")).toContain("medical.egress.cloudInference");  // names the axis
expect(process.exitCode).toBe(1);
expect(parseSpy).not.toHaveBeenCalled();                                   // spy callCount 0 — never reached
// no note file written
const labsDir = join(tmpDir, ".bober", "medical", "labs");
await expect(import("node:fs/promises").then(({ stat }) => stat(labsDir))).rejects.toThrow();  // ENOENT
```

### sc-3-4 second-run dedup = 0 new rows
```ts
vi.mocked(loadConfig).mockResolvedValue(makeLabsConfig(true));
// ... write dummy pdf + fakeParse returning the SAME report both runs ...
const { runImportLabs } = await import("./medical.js");
const stdout1: string[] = [];
const s1 = vi.spyOn(process.stdout, "write").mockImplementation((c) => { stdout1.push(String(c)); return true; });
vi.spyOn(process.stderr, "write").mockImplementation(() => true);
await runImportLabs(tmpDir, pdfPath, { parse: fakeParse, nowIso: "2026-06-17T12:00:00Z" });
await runImportLabs(tmpDir, pdfPath, { parse: fakeParse, nowIso: "2026-06-18T12:00:00Z" });  // 2nd run
// First run added >=1 row; second adds 0. Assert via store.getLabSeries length unchanged
// (mirror reindex test lab-reindex.test.ts:105-124) OR assert the printed "new rows: 0" on run 2.
```
Reference dedup test: `src/medical/lab-reindex.test.ts:105-124` (first run 3 rows, second 0).

### Commander wiring smoke (optional, mirror medical.test.ts:297-332)
Register the tree, `program.parseAsync(["node","bober","medical","import-labs", pdfPath])` with axis off and assert `process.exitCode === 1`. Confirms `import-labs` is nested under `medical`, not top-level.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| CLI entry registering `registerMedicalCommand` (`src/cli/commands/index.ts` or `src/cli.ts`) | `medical.ts` export | low | Export signature of `registerMedicalCommand` is unchanged (additive subcommand only) |
| `src/cli/commands/medical.test.ts` | `runWhoopSync`, `registerMedicalCommand` | low | Existing `runWhoopSync` tests must still pass — do NOT alter `runWhoopSync` or `WhoopSyncDeps` |
| `src/medical/lab-pdf-parser.ts` / `lab-note.ts` / `lab-reindex.ts` / `inference.ts` | (consumed, not changed) | none | Read-only consumption; their own tests are unaffected |

`runImportLabs` is a NEW export; nothing imports it yet, so it adds no downstream break surface.

### Existing Tests That Must Still Pass
- `src/cli/commands/medical.test.ts` — sc-3-5/sc-3-6/sc-3-8 WHOOP cases (lines 67-332). Verify they still pass since you share `tmpDir`/exitCode lifecycle and the same module.
- `src/medical/lab-pdf-parser.test.ts`, `lab-note.test.ts`, `lab-reindex.test.ts`, `audit.test.ts`, `egress.test.ts`, `inference.test.ts` — must be untouched/green (you only consume those modules).

### Features That Could Be Affected
- **medical import / whoop sync** — share the `medical` command tree and `health.db`. Verify both still register and that `import-labs` does not collide with the `import <file>` command name (it does not — distinct command strings).

### Recommended Regression Checks
1. `npm run build` (tsc, zero errors — sc-3-1).
2. `npx vitest run src/cli/commands/medical.test.ts` — all WHOOP + new import-labs cases green.
3. `npx vitest run src/medical/` — Sprint 1/2 modules still green.
4. Manual: confirm `import-labs` appears under `bober medical --help`, not at top level.

---

## 8. Implementation Sequence

1. **Add imports** to `src/cli/commands/medical.ts` — `readFile` from `node:fs/promises`; `parseLabPdf`, `writeLabNote`, `reindexLabNotes`, `buildMedicalInferenceClient`.
   - Verify: tsc resolves all `.js`-suffixed paths.
2. **`ImportLabsDeps` interface** (types only) — `export interface ImportLabsDeps { parse?: typeof parseLabPdf; nowIso?: string }`.
   - Verify: `typeof parseLabPdf` resolves; no `any`.
3. **`runImportLabs(projectRoot, pdfPath, deps = {}, opts = {})`** — implement the 8-step ordered body from Section 2 (load config → EgressGuard → fail-closed gate → build client → readFile+parse → writeLabNote per marker → reindexLabNotes → AuditLog.append → finally store?.close()). Print `records parsed` (markers.length) and `new rows` (reindex count) on success.
   - Verify: fail-closed `return` is positioned before `readFile`/`buildMedicalInferenceClient`; `store` declared `let store: HealthDataStore | undefined` and closed in `finally`.
4. **Register `import-labs <pdf>` subcommand** under `medicalCmd` in `registerMedicalCommand` (mirror lines 136-188), `.action` delegates to `runImportLabs` and never throws.
   - Verify: nested under `medical`, `--vault` optional, action sets nothing that throws.
5. **Tests** in `medical.test.ts` — add `makeLabsConfig`, then sc-3-2 (happy), sc-3-3 (fail-closed spy-never-called), sc-3-4 (dedup 0), optional commander smoke.
   - Verify: each asserts `process.exitCode`; sc-3-3 asserts spy callCount 0 + no note file.
6. **Run full verification** — `npm run build`; `npx vitest run src/cli/commands/medical.test.ts src/medical/`.

---

## 9. Pitfalls & Warnings

- **Order is the test.** sc-3-3 fails if you `readFile(pdfPath)` or call `buildMedicalInferenceClient`/`deps.parse` before the `cloud-inference` gate. The gate must `return` first. Mirror `runWhoopSync` lines 53-62 exactly.
- **Name the axis in the message.** sc-3-3 asserts the stderr text contains `medical.egress.cloudInference`. WHOOP's message says `medical.egress.deviceConnection` — change the axis name AND the key.
- **Use `"cloud-inference"`, not `"device-connection"`.** This sprint's axis differs from WHOOP's.
- **Audit entry is IDs/enums ONLY.** Emit `{ tIso: nowIso, event: "ingest" }`. Never add marker values, panel, record counts, or prompt text. Tests assert health values do NOT appear in the audit file (PHI rule, audit.ts:1, types.ts:64).
- **`nowIso` default at the boundary.** `const nowIso = deps.nowIso ?? new Date().toISOString();` — read the clock only once, only here; the AuditLog filename derives from it (audit.ts:30-32).
- **`buildMedicalInferenceClient` with no `medical.inference` returns a LOCAL openai-compat client.** `createClient` (factory.ts:264-282) only *constructs* an adapter (stores endpoint/model) — no network until `.chat()`. Since tests inject `deps.parse`, `.chat()` is never called, so no real network occurs even with the axis ON. Do NOT add a client factory to `ImportLabsDeps` — the contract specifies only `{ parse?, nowIso? }`.
- **One reindex call, not per-marker.** Call `reindexLabNotes(vaultDir, store)` once after writing all notes; its return value is the reported "new rows" and gives sc-3-4 dedup for free.
- **`store?.close()` in `finally`.** Declare `let store: HealthDataStore | undefined;` and only assign after the gate, so the fail-closed path closes nothing (mirrors medical.ts:48,118-120).
- **Subcommand, not top-level.** Attach to `medicalCmd.command("import-labs <pdf>")`, never `program.command(...)` (nonGoal in contract).
- **`.action` must not throw.** Wrap in `runImportLabs`'s own try/catch (set `process.exitCode = 1`); the action just `await runImportLabs(...)` (mirror medical.ts:163-171, 185-188).
- **ESM `.js` extensions + `import type`** are hard lint/build gates (principles.md:27,35).
