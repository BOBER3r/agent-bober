# Sprint Briefing: Proactive trend Findings + vault Finding writer + Dataview dashboard + review pass

**Contract:** sprint-spec-20260628-medical-analysis-1
**Generated:** 2026-06-28T00:00:00.000Z

> Scope: ADD a deterministic, OFFLINE proactive review pass under `src/medical/analysis/`. NO LLM, NO network, NO `*Sync` fs. Reuse `NumericsQueryLayer.getLabTrend` for ALL trend math, `getLabSeries` for series, and the `observationId` SHA-256 recipe for finding ids. Emit vault markdown frontmatter only — do NOT define a canonical Zod Finding schema (owned by spec-20260628-priority-hub).

---

## 1. Target Files

### src/medical/analysis/finding.ts (create)

**Directory pattern:** `src/medical/analysis/` does NOT exist yet — create it fresh. Sibling modules in `src/medical/` use kebab-case filenames, named exports, `.js` import extensions (NodeNext ESM), and a top-of-file doc block stating "PURE / NO network / NO LLM / NO Date.now()".

**Must export:**
- `interface MedicalFinding` — mirrors the common Finding field set (see §5), `domain` fixed to `"medical"`.
- `findingId(...)` — deterministic 16-char hex id via `createHash("sha256").update(...).digest("hex").slice(0,16)`, EXACTLY mirroring `observationId` at `src/medical/health-store.ts:32-42`.
- `serializeFindingToMarkdown(finding): string` — YAML frontmatter + short body.

**Most similar existing file:** `src/medical/lab-note.ts` (hand-rolled flat-scalar YAML frontmatter serializer + deterministic status derivation). Follow its structure. BUT note lab-note serializes ONLY flat scalars; MedicalFinding has arrays (`evidence[]`, `tags[]`) so prefer the array-aware serializer from `src/vault/frontmatter.ts:145-164` (see §2 Pattern C).

---

### src/medical/analysis/finding-writer.ts (create)

**Must export:**
- `writeFinding(vaultDir, finding): Promise<string>` — `ensureDir` then `writeFile` to `<vaultDir>/findings/<finding.id>.md`. Returns the absolute path.
- `writeDashboard(vaultDir): Promise<string>` — writes `<vaultDir>/findings/dashboard.md` containing a fenced ```` ```dataview ```` block (TABLE urgency, severity, kind, status FROM "findings" WHERE domain = "medical" SORT urgency DESC). Returns the path.

**Most similar existing file:** `src/medical/lab-note.ts:191-236` (`writeLabNote`) — same `ensureDir(dirname(notePath))` + `writeFile(notePath, serialized, "utf-8")` recipe.

---

### src/medical/analysis/trends.ts (create)

**Must export:** `analyzeTrends(store: HealthDataStore, biomarkers: string[], opts: { now: string }): MedicalFinding[]` — PURE, synchronous, deterministic.
- Construct `new NumericsQueryLayer(store)` and call `getLabTrend(biomarker)` per biomarker (the ONLY numeric source — no inline slope/delta arithmetic).
- Call `store.getLabSeries(biomarker)` to read `referenceLow`/`referenceHigh` from the latest `LabResult` (LabTrend does not carry the reference range — see §1 numerics note).
- Rule A (range crossing): `latestValue` below `referenceLow` or above `referenceHigh` → `kind: "watch"` (severity 3); when >20% beyond the edge → `kind: "risk"` (severity 4).
- Rule B (slope): `slope != null` and trending toward the nearer reference edge with a projected crossing → `kind: "watch"` (severity 2).
- Abstain when `sampleCount === 0` (no findings for that biomarker).

**Most similar existing file:** `src/medical/numerics.ts:212-250` (`getLabTrend`) — the reuse target, not a template to copy.

---

### src/medical/analysis/review-pass.ts (create)

**Must export:** `runProactiveReview(projectRoot: string, config: BoberConfig, opts: { now: string; biomarkers?: string[] }): Promise<{ findingsWritten: number; dashboardPath: string; findingPaths: string[] }>`
- Open `new HealthDataStore(join(projectRoot, ".bober", "medical", "health.db"))` EXACTLY like `src/medical/engine.ts:350`.
- Resolve `vaultDir = config.medical?.vaultDir ?? join(projectRoot, ".bober", "medical", "vault")`.
- Run `analyzeTrends`, `writeFinding` per finding, then `writeDashboard`.
- `finally { store?.close(); }` — mirrors `src/cli/commands/medical.ts:126-128`.

**Most similar existing file:** `src/cli/commands/medical.ts:155-215` (`runImportLabs`) — same open-store / try / finally-close / vault-resolve shape (a runnable entrypoint the CLI calls with no deps).

> **TESTABILITY for sc-1-4** ("twice against the same seeded store"): the explicit signature opens its own store from `projectRoot`, so the test must seed a FILE-BACKED `<tmpRoot>/.bober/medical/health.db` (via `mkdtemp` + `new HealthDataStore(join(tmpRoot,'.bober/medical/health.db'))`, `upsertLabResult`, `close()`) then call twice. RECOMMENDED ALTERNATIVE: accept an optional `opts.store?: HealthDataStore` and use it when provided (only close stores you opened) — mirrors the injected-store pattern at `src/medical/engine.ts:342-347`. This keeps sc-1-4 a clean `:memory:` test. Pick one and be consistent.

---

### src/config/schema.ts (modify)

**Relevant section — `MedicalSectionSchema`, lines 376-401:**
```ts
export const MedicalSectionSchema = z.object({
  egress: z.object({ /* cloudInference, literatureRetrieval, deviceConnection */ }).optional(),
  inference: z.object({ provider, endpoint, model }).optional(),
});
```
**Change:** add ONE optional key inside the object (e.g. before the closing `})` at line 400):
```ts
  /** Optional vault dir for medical Findings/notes. Default: <projectRoot>/.bober/medical/vault. */
  vaultDir: z.string().optional(),
```
**Imported by:** root `BoberConfigSchema` at `src/config/schema.ts:481` (`medical: MedicalSectionSchema.optional()`); `BoberConfig` type at `:487`. Runtime consumers of `config.medical`: `src/medical/inference.ts:36`, `src/medical/egress.ts:26`. Adding an OPTIONAL field is backward-compatible — no consumer breaks.

**Test file:** no direct `schema.test.ts`; covered transitively by config-loader tests.

---

### src/cli/commands/medical.ts (modify)

**Relevant section — clock-at-boundary + finally-close (lines 96-128, `runWhoopSync`):**
```ts
    // window: --since or now-7d; clock read ONLY here at the CLI boundary
    const nowIso = deps.nowIso ?? new Date().toISOString();
    ...
  } finally {
    store?.close(); // always close — even if sync threw mid-pagination
  }
```

**Relevant section — subcommand registration (lines 224-292):**
```ts
export function registerMedicalCommand(program: Command): void {
  const medicalCmd = program.command("medical")...;
  medicalCmd.command("import-labs <pdf>")
    .option("--vault <dir>", "...")
    .action(async (pdf, opts) => {
      const projectRoot = await resolveRoot();
      await runImportLabs(projectRoot, pdf, {}, opts);
    });
  // ...whoop sync, supplements, profile...
}
```

**Change:** add a `medicalCmd.command("review")` subcommand near the others. Its `.action` MUST: `const projectRoot = await resolveRoot();` → `loadConfig(projectRoot)` → read the clock ONLY here (`new Date().toISOString()`) → call `runProactiveReview(projectRoot, config, { now })` → print `findingsWritten` + `dashboardPath` to stdout → on error set `process.exitCode = 1` and NEVER throw (mirror lines 257-265).

**Imports already present to reuse:** `findProjectRoot, ensureDir` (`:9`), `loadConfig` (`:10`), `HealthDataStore` (`:11`), `chalk` (`:6`), `join` (`:5`).

**Imported by:** `src/cli/index.ts:40,320` (`registerMedicalCommand(program)`).

**Test file:** `src/cli/commands/medical.test.ts` (EXISTS) — drives commands via `registerMedicalCommand` + `program.parseAsync([...])` with mocked `loadConfig`.

---

## 2. Patterns to Follow

### Pattern A — Deterministic SHA-256 id (MIRROR for findingId)
**Source:** `src/medical/health-store.ts:32-42`
```ts
export function observationId(metric, tStart, source, value): string {
  return createHash("sha256")
    .update(`${metric}|${tStart}|${source}|${value}`)
    .digest("hex")
    .slice(0, 16);
}
```
**Rule:** `findingId` must use the IDENTICAL `createHash("sha256").update(<stable pipe-joined content>).digest("hex").slice(0,16)` recipe over stable finding content (e.g. `domain|biomarker|kind` — NOT `now`) so the same condition maps to the same `<id>.md` across runs (idempotency for sc-1-4). Import `createHash` from `node:crypto`.

### Pattern B — Hand-rolled flat-scalar YAML frontmatter + writer
**Source:** `src/medical/lab-note.ts:95-108` (serialize) and `:231-235` (write)
```ts
const lines: string[] = ["---"];
lines.push(`marker: ${fm.marker}`);
// ...one `key: value` per scalar...
lines.push("---");
return lines.join("\n") + "\n";
// writer:
await ensureDir(dirname(notePath));
await writeFile(notePath, serialized, "utf-8");
```
**Rule:** Use `node:fs/promises` `writeFile` + `ensureDir(dirname(...))` only — NO `writeFileSync`. lab-note proves the medical-side convention.

### Pattern C — Array-aware YAML serializer (for evidence[] / tags[])
**Source:** `src/vault/frontmatter.ts:145-164` (`serializeFrontmatter`)
```ts
for (const [key, val] of Object.entries(frontmatter)) {
  if (Array.isArray(val)) {
    lines.push(`${key}:`);
    for (const item of val as unknown[]) lines.push(`  - ${String(item)}`);
  } else {
    lines.push(`${key}: ${String(val)}`);
  }
}
lines.push("---");
return lines.join("\n") + "\n" + body;
```
**Rule:** MedicalFinding frontmatter has arrays (`evidence`, `tags`); the lab-note serializer only handles flat scalars. Either (a) `import { serializeFrontmatter } from "../../vault/frontmatter.js"` and reuse it, or (b) hand-roll an equivalent block-list serializer inline. Reusing the vault helper avoids reinvention — note `lab-note.ts` deliberately did NOT import it (a "no cross-import" stylistic choice, NOT a ban). Either is acceptable; prefer reuse + cite the source.

### Pattern D — CLI action: resolveRoot → try → process.exitCode → never throw
**Source:** `src/cli/commands/medical.ts:235-266` (`import` action)
```ts
.action(async (file) => {
  const projectRoot = await resolveRoot();
  try { /* ...work, write to process.stdout... */ }
  catch (err) {
    process.stderr.write(chalk.red(`Failed...: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;   // MUST NOT throw
  }
});
```
**Rule:** the `review` action follows this exact shape; read the wall clock ONLY inside the action.

### Pattern E — finally-close the store
**Source:** `src/cli/commands/medical.ts:161,212-214` (and `:126-128`)
```ts
let store: HealthDataStore | undefined;
try { store = new HealthDataStore(...); /* ... */ }
finally { store?.close(); }
```
**Rule:** `runProactiveReview` opens a store → always close in `finally` (skip if you injected `opts.store`).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `observationId` | `src/medical/health-store.ts:32-42` | `(metric,tStart,source,value): string` | SHA-256→16hex id recipe to MIRROR for `findingId` |
| `HealthDataStore` | `src/medical/health-store.ts:115` | `new (dbPath)`; `getLabSeries`, `upsertLabResult`, `close` | Opens `.bober/medical/health.db`; lab series source |
| `HealthDataStore.getLabSeries` | `src/medical/health-store.ts:196` | `(biomarker): LabResult[]` | Lab series (collected_at ASC) incl. `referenceLow/High` |
| `NumericsQueryLayer.getLabTrend` | `src/medical/numerics.ts:212` | `(biomarker): LabTrend` | ONLY trend math (slope + latestValue) — no hand-rolled arithmetic |
| `ensureDir` | `src/utils/fs.ts:45` | `(path): Promise<void>` | `mkdir(path,{recursive:true})` — use before writeFile |
| `fileExists` | `src/utils/fs.ts:10` | `(path): Promise<boolean>` | Async existence check |
| `findProjectRoot` | `src/utils/fs.ts:58` | `(startDir?): Promise<string\|null>` | Walks up to bober.config.json/package.json (CLI `resolveRoot`) |
| `loadConfig` | `src/config/loader.ts:142` | `(projectRoot): Promise<BoberConfig>` | Load+validate config; CLI passes result into review-pass |
| `serializeFrontmatter` | `src/vault/frontmatter.ts:145` | `(fm: Record<string,unknown>, body): string` | Array-aware YAML frontmatter serializer (reuse for evidence/tags) |
| `parseFrontmatter` | `src/vault/frontmatter.ts:53` | `(raw): {frontmatter,body}` | Parse YAML frontmatter (useful for round-trip tests) |
| `writeNote` / `readNote` | `src/vault/note-io.ts:38 / :27` | `(note: VaultNote)` / `(path)` | Generic vault note write/read (ensureDir+writeFile) — optional reuse |
| `slugify` | `src/medical/lab-note.ts:58` | `(s): string` | URL-safe slug (NOT needed if filename is `<id>.md`) |
| `deriveLabStatus` | `src/medical/lab-note.ts:71` | `(value,refLow?,refHigh?,critical?): LabStatus` | Reference-range classification precedent for Rule A |
| `AuditLog.append` | `src/medical/audit.ts:44` | `(entry): Promise<void>` | IDs/enums-only audit (do NOT log health values; optional) |

**Type imports:** `LabTrend` (`src/medical/types.ts:176`), `LabResult` (`:118`), `NumericPrimitive` whitelist (`:142`), `VaultNote`/`NoteStatus` (`src/vault/types.ts:12,30`), `BoberConfig` (`src/config/schema.ts:487`).

> A vault-store module EXISTS at `src/vault/` (`frontmatter.ts`, `note-io.ts`, `types.ts`, `reindex.ts`, `mcp-adapter.ts`, `index-map.ts`, `profile.ts`, `conventions.ts`). Its frontmatter serializer is array-aware and reusable. Reuse it for `evidence[]`/`tags[]` rather than rebuilding array YAML.

---

## 4. Prior Sprint Output

No prior sprints in THIS spec. Reuse the SHIPPED medical substrate (specs medical-team / medical-ingest / medical-grounding-critic / medical-whoop-guardrails):
- `src/medical/health-store.ts` — `HealthDataStore`, `observationId`, `getLabSeries`, `upsertLabResult`. **Connection:** review-pass opens this store; trends.ts reads series.
- `src/medical/numerics.ts` — `NumericsQueryLayer.getLabTrend`. **Connection:** the only slope/latest source for trends.ts.
- `src/medical/types.ts` — `LabTrend`, `LabResult`, `NumericPrimitive`. **Connection:** type imports.
- `src/medical/lab-note.ts` — frontmatter writer precedent + `deriveLabStatus`. **Connection:** structural template for finding.ts/finding-writer.ts.
- `src/medical/engine.ts` — health.db path resolution at `:350`. **Connection:** review-pass mirrors it. **DO NOT MODIFY this file** (evaluator asserts `git diff` touches no engine.ts).
- `src/config/schema.ts:376` `MedicalSectionSchema`. **Connection:** add `vaultDir?`.
- `src/cli/commands/medical.ts` — command tree + `runImportLabs`/`runWhoopSync` precedents. **Connection:** add `review` subcommand.

---

## 5. Relevant Documentation

### Project Principles
No top-level `.bober/principles.md` was located for this exploration; the binding rules are inline doc-block invariants repeated across `src/medical/*`:
- **PURE / deterministic:** `src/medical/numerics.ts:9-11` — "NO async. NO fs. NO network. NO LLM import ... Identical input => identical output." trends.ts must honor this.
- **No wall-clock reads:** `src/medical/health-store.ts:11` and `types.ts:107` — "Never calls Date.now() ... every timestamp is an injected parameter." All `surfacedAt` values come from `opts.now`; the clock is read ONLY in the CLI action (`medical.ts:97`).
- **No sync fs:** `src/medical/audit.ts:2`, `src/vault/note-io.ts:8` — use `node:fs/promises` only (evaluator greps for `*Sync`).
- **Audit = IDs/enums only, no PHI:** `src/medical/audit.ts:15-17` and `types.ts:64,79-80` — never write health values into audit (this sprint should not need audit at all).

### Architecture Decisions
- **ADR-3 (closed numeric whitelist):** `src/medical/numerics.ts:3-7` — the LLM never does arithmetic; computations are a closed `NumericPrimitive` union (`types.ts:142-150`). Do NOT hand-roll slope; reuse `getLabTrend`.
- **ADR-4 (deterministic SHA-256 id, single-table):** `src/medical/health-store.ts:12,153`. findingId follows the same determinism contract.
- **Research §3a — Common Finding schema** (`.bober/research/research-20260627-knowledge-platform-landscape.md:121-126`):
  ```
  Finding { id, domain, title, kind: action|watch|risk|question,
    urgency 1-5, severity 1-5, evidence[], surfacedAt, dueBy?,
    tags[], estDurationMin?, calendarSafeTitle?, status, promotesTo? }
  ```
  Emit these as YAML frontmatter; `domain` fixed to `"medical"`. Required-by-contract keys for the emitted frontmatter (sc-1-6): `id, domain, kind, urgency, severity, surfacedAt, status` (+ `title, evidence, tags`). Do NOT add a competing canonical Zod (owned by spec-20260628-priority-hub, research `:128`).
- **Research §3b — vault is canonical sink** (`:150-151`): Findings are markdown-with-frontmatter notes; SQLite is a derived index. This sprint's sink is the vault, not FactStore.

### Other Docs
- ESM/NodeNext: ALL relative imports use `.js` extensions (e.g. `health-store.ts:22` `import ... from "./types.js"`). New `analysis/*` files import siblings as `../numerics.js`, `../health-store.js`, `../types.js`, and utils as `../../utils/fs.js`, config as `../../config/schema.js`.

---

## 6. Testing Patterns

### Unit Test Pattern — :memory: store + seeded labs (for trends.test.ts)
**Source:** `src/medical/numerics.test.ts:279-296`
```ts
import { describe, it, expect, afterEach } from "vitest";
import { HealthDataStore } from "./health-store.js";   // analysis/ tests use ../health-store.js
// ...
store = new HealthDataStore(":memory:");
const labs: LabResult[] = [
  { biomarker: "cholesterol", value: 180, unit: "mg/dL", collectedAtIso: "2026-01-01T08:00:00.000Z" },
  { biomarker: "cholesterol", value: 200, unit: "mg/dL", collectedAtIso: "2026-02-01T08:00:00.000Z" },
];
for (const lab of labs) store.upsertLabResult(lab);
// afterEach(() => store?.close());
```
For sc-1-2 ("ldl latest exceeds referenceHigh"), seed a series with `referenceHigh` set and the last value above it, e.g.:
```ts
store.upsertLabResult({ biomarker: "ldl", value: 95,  unit: "mg/dL", collectedAtIso: "2026-01-01T08:00:00.000Z", referenceHigh: 130 });
store.upsertLabResult({ biomarker: "ldl", value: 160, unit: "mg/dL", collectedAtIso: "2026-03-01T08:00:00.000Z", referenceHigh: 130 });
```

### Unit Test Pattern — temp dir vault + readFile assertions (for finding-writer.test.ts / review-pass.test.ts)
**Source:** `src/medical/lab-reindex.test.ts:53-72` (mkdtemp + cleanup) and `src/medical/lab-note.test.ts:101-118` (write → readFile → assert)
```ts
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-finding-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
// ...
const p = await writeFinding(tmpDir, finding);
const raw = await readFile(p, "utf-8");
expect(raw.startsWith("---\n")).toBe(true);
expect(raw).toContain("domain: medical");
```
- **Runner:** vitest. **Assertion:** `expect(...).toBe/.toContain/.not.toBeNull`. **Mock:** none for pure modules; `vi.mock("../../config/loader.js")` only at the CLI layer.
- **File naming:** collocated `<module>.test.ts` beside the source (e.g. `src/medical/analysis/trends.test.ts`).
- **Location:** co-located (NOT a separate `__tests__/` or `tests/`).
- **sc-1-6 (surfacedAt == injected now):** pass `opts.now = "2026-06-28T12:00:00.000Z"` and assert the serialized frontmatter contains exactly `surfacedAt: 2026-06-28T12:00:00.000Z`.
- **sc-1-5 (dashboard):** assert the dashboard string contains a fenced ```` ```dataview ```` block AND the substrings `urgency` and `kind`.
- **sc-1-4 (idempotency):** seed a file-backed `<tmpRoot>/.bober/medical/health.db`, call `runProactiveReview` twice with the same `opts.now`, count files under `<vaultDir>/findings/` via `glob`/`readdir` both times, assert equal.

### CLI Test Pattern (for the `review` action — sc-1-7 manual, optional to unit-test)
**Source:** `src/cli/commands/medical.test.ts:468-484`
```ts
vi.mock("../../config/loader.js", () => ({ loadConfig: vi.fn() }));
const rootSpy = vi.spyOn(fsUtils, "findProjectRoot").mockResolvedValue(tmpDir);
const { Command } = await import("commander");
const { registerMedicalCommand } = await import("./medical.js");
const program = new Command(); program.exitOverride(); registerMedicalCommand(program);
await program.parseAsync(["node", "bober", "medical", "review"]);
expect(process.exitCode).not.toBe(1);
```

### E2E Test Pattern
Not applicable — no Playwright config relevant to this CLI/server sprint.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/config/schema.ts:481,487` (`BoberConfigSchema`/`BoberConfig`) | `MedicalSectionSchema` | low | Adding OPTIONAL `vaultDir?` is backward-compatible; existing configs still validate |
| `src/medical/inference.ts:36` | `config.medical` | low | Reads `.inference` only — untouched by a new sibling key |
| `src/medical/egress.ts:26` | `config.medical` | low | Reads `.egress` only — unaffected |
| `src/cli/index.ts:40,320` | `registerMedicalCommand` | medium | New `review` subcommand registers inside the existing tree; verify CLI still builds & lists `review` |
| Existing `medical` subcommands (import/import-labs/whoop/supplements/profile) | shared `registerMedicalCommand` body | medium | Adding a sibling `.command("review")` must not reorder/alter existing ones |

### Existing Tests That Must Still Pass
- `src/cli/commands/medical.test.ts` — drives `registerMedicalCommand` + `parseAsync`; verify still green after adding `review`.
- `src/medical/ingestion.test.ts:181-239` — also exercises `registerMedicalCommand`; must remain green.
- `src/medical/numerics.test.ts` — covers `getLabTrend`/`getLabSeries` (the reuse target); must be untouched and green.
- `src/medical/health-store.test.ts` — covers `observationId`/`getLabSeries`/`upsertLabResult`; untouched.
- `src/medical/engine.test.ts` — **MUST stay byte-identical** (evaluator asserts `git diff` touches no engine.ts).
- Config-loader tests (transitive over `BoberConfigSchema`) — must still parse valid configs.

### Features That Could Be Affected
- **Reactive medical Q&A (`MedicalSopEngine`, `src/medical/engine.ts`)** — shares `HealthDataStore`/`NumericsQueryLayer` but is READ-only reuse; do NOT modify engine.ts. Verify Q&A path unchanged.
- **priority-hub (spec-20260628-priority-hub, future)** — owns the canonical Zod Finding. This sprint emits the SAME field set as frontmatter only; do not define a competing schema (avoids a future collision).

### Recommended Regression Checks
1. `npm run build` (tsc) — zero type errors (sc-1-1).
2. `npx vitest run src/medical/analysis` — new collocated tests pass.
3. `npx vitest run src/medical src/cli/commands/medical.test.ts src/config` — no new failures in medical/CLI/config suites.
4. `git diff --name-only` — confirm `src/medical/engine.ts` is NOT listed.
5. `grep -rn "Sync(\|from \"node:fs\"\b\|fetch(\|providers/factory\|ollama\|http" src/medical/analysis` — expect ZERO matches (offline/no-LLM/no-sync-fs).
6. `bober medical review` against a seeded `.bober/medical/health.db` → prints counts + dashboard path, exits 0 (sc-1-7).

---

## 8. Implementation Sequence

1. **src/medical/analysis/finding.ts** — define `MedicalFinding` interface + `findingId` (mirror `observationId`) + `serializeFindingToMarkdown` (array-aware frontmatter).
   - Verify: `serializeFindingToMarkdown` output starts with `---\n`, includes `domain: medical`, `surfacedAt: <now>`, and block-list `evidence:`/`tags:`.
2. **src/medical/analysis/finding.test.ts** — assert frontmatter keys (sc-1-6) + deterministic id stability.
   - Verify: same finding content → same id; `surfacedAt` equals injected now.
3. **src/medical/analysis/finding-writer.ts** — `writeFinding` (→ `findings/<id>.md`) + `writeDashboard` (→ `findings/dashboard.md` with dataview block).
   - Verify: file written under `<vaultDir>/findings/`; dashboard contains fenced ```` ```dataview ```` + `urgency`/`kind`.
4. **src/medical/analysis/finding-writer.test.ts** — temp-dir write → readFile assertions (sc-1-5).
5. **src/medical/analysis/trends.ts** — `analyzeTrends(store, biomarkers, {now})` using `getLabTrend` + `getLabSeries`; Rules A & B; abstain on sampleCount 0.
   - Verify: deterministic; no inline slope arithmetic (only `getLabTrend`).
6. **src/medical/analysis/trends.test.ts** — sc-1-2 (ldl over referenceHigh → watch/risk, 'ldl' in title), sc-1-3 (flat in-range → 0 findings; rising crossing → exactly 1).
7. **src/medical/analysis/review-pass.ts** — `runProactiveReview` (open store like engine.ts:350, resolve vaultDir, analyze, write, return summary, finally-close).
   - Verify: returns `{findingsWritten, dashboardPath, findingPaths}`.
8. **src/medical/analysis/review-pass.test.ts** — sc-1-4 idempotency (twice → identical file count) using a file-backed temp health.db (or injected `opts.store`).
9. **src/config/schema.ts** — add `vaultDir: z.string().optional()` inside `MedicalSectionSchema` (line ~400).
   - Verify: `tsc` clean; existing configs still validate.
10. **src/cli/commands/medical.ts** — register `medicalCmd.command("review")`; action reads clock once, `loadConfig`, calls `runProactiveReview`, prints counts + dashboardPath, `process.exitCode=1` on error (never throw).
    - Verify: `medical.test.ts` + `ingestion.test.ts` still green; `bober medical review` exits 0.
11. **Run full verification** — `npm run build`; `npx vitest run`; `git diff --name-only | grep engine.ts` (expect empty).

---

## 9. Pitfalls & Warnings

- **DO NOT modify `src/medical/engine.ts`** — evaluator asserts `git diff` touches no engine.ts (and its tests). Only READ it for the health.db path recipe (`:350`).
- **`LabTrend` carries NO reference range.** `getLabTrend` returns `{biomarker, sampleCount, latestValue, latestUnit, latestCollectedAt, slope}` (`types.ts:176-187`). For Rule A range crossings you MUST read `referenceLow`/`referenceHigh` from `store.getLabSeries(biomarker)` (the latest `LabResult`), then compare against `latestValue`. Skip a biomarker whose latest result has no reference bounds.
- **No hand-rolled slope/delta.** Reuse `getLabTrend.slope`. The evaluator greps for inline arithmetic; do not compute `(v2-v1)/(t2-t1)` yourself.
- **`surfacedAt` must equal `opts.now` exactly** — never call `new Date()`/`Date.now()` inside finding.ts/trends.ts/review-pass.ts/finding-writer.ts. The ONLY clock read is in the CLI `.action` (mirror `medical.ts:97`).
- **`findingId` must exclude `now`** from its hashed content, or re-running with a different `now` would create duplicate files and break sc-1-4 idempotency. Hash stable content (e.g. `medical|<biomarker>|<kind>` or `<biomarker>|<rule>`).
- **Filenames have no colons.** ISO timestamps contain `:`; `<id>.md` (hex only) is safe. If you ever put a date in a filename, use the `YYYY-MM-DD` slice trick (`lab-note.ts:222`).
- **`node:fs/promises` only — no `*Sync`.** Evaluator greps for `Sync(`. `ensureDir` (`utils/fs.ts:45`) + `writeFile` is the sanctioned combo.
- **No network / no LLM imports in `src/medical/analysis/*`.** Do NOT import `providers/`, `inference.ts`, `literature`, `fetch`, `http`, or `ollama`. This whole module is offline and deterministic.
- **Array YAML:** `lab-note.ts`'s serializer is flat-scalar ONLY and will stringify an array as `[object Object]`-ish junk. Use the array-aware `serializeFrontmatter` (`vault/frontmatter.ts:145`) OR hand-roll block lists for `evidence[]`/`tags[]`.
- **Config field is OPTIONAL.** `MedicalSection` and the root `medical` key are both `.optional()`; resolve `vaultDir` defensively: `config.medical?.vaultDir ?? join(projectRoot, ".bober", "medical", "vault")`.
- **Do NOT write findings into the audit log or FactStore.** The vault `findings/` dir is the sole sink for this sprint (research §3b:150). Audit stays IDs/enums-only; FactStore aggregation is owned by priority-hub.
- **Close stores you open, not ones injected.** If you add `opts.store`, only `close()` the store this function created (guard with a `weOpenedIt` flag) to avoid closing a caller's `:memory:` store mid-test.
