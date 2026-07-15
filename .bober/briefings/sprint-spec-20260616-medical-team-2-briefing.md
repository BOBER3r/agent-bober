# Sprint Briefing: Consent gate, append-only audit log, and disclaimer footer (Gate 1 + audit substrate)

**Contract:** sprint-spec-20260616-medical-team-2
**Generated:** 2026-06-16T00:00:00Z

---

## 0. TL;DR (read this first)

Add three small leaf modules under `src/medical/` — `consent.ts` (ConsentGate), `audit.ts` (AuditLog), `disclaimer.ts` (DisclaimerComposer) — plus collocated `*.test.ts`, then wire `ConsentGate` as **Gate 1** into the existing `MedicalSopEngine.run` stub (`src/medical/engine.ts:25-44`).

The hard requirements are ALL satisfied by COPYING existing patterns:
- **Append-only mode-0600 JSONL** → copy `appendOneLine` from `src/incident/timeline.ts:67-82` (canonical) / `src/orchestrator/checkpoints/audit.ts:86-128`.
- **Fail-closed JSON read/write** → copy `CarefulSidecar` from `src/chat/careful-sidecar.ts:1-46`.
- **Injected timestamp (`now: string`)** → the codebase's established pattern (`src/state/memory.ts:66-72`, `src/orchestrator/memory/reconcile.ts:54`). NEVER `Date.now()`/`new Date()` for `acceptedAtIso`/`tIso`.
- **Temp-dir tests, no fs mocks** → copy `src/chat/careful-sidecar.test.ts` + the mode-0600 + append-only test from `src/orchestrator/checkpoints/audit.test.ts:360-373`.

ConsentRecord / AuditEntry / MedicalAnswer shapes come from the architecture data model (`.bober/architecture/arch-20260616-medical-team-architecture.md:204-230`). `MedicalAnswer` is ALREADY declared in `src/medical/types.ts:39-45`. `ConsentRecord` and `AuditEntry` are NOT declared anywhere yet — add them to `src/medical/types.ts`.

---

## 1. Target Files

### src/medical/engine.ts (modify)

**Current state — full file is the Sprint 1 stub (lines 1-45):**
```typescript
// src/medical/engine.ts:22-45
export class MedicalSopEngine implements PipelineEngine {
  readonly name: PipelineEngineName = "medical-sop";

  async run(
    _userPrompt: string,
    _projectRoot: string,
    _config: BoberConfig,
    _opts?: { runId?: string },
  ): Promise<PipelineResult> {
    // Stub: real SOP (consent/gate/numerics/retrieval/answer) lands in S2/S3/S4/S6.
    const spec = createSpec(
      "Medical SOP (stub)",
      "Placeholder spec for the medical-sop engine stub. Real SOP implementation in S2/S3/S4/S6.",
      [],
    );
    return {
      success: true,
      spec,
      completedSprints: [],
      failedSprints: [],
      duration: 0,
    };
  }
}
```

**What to change:** Add Gate 1 (consent) BEFORE any other work. `run` must:
1. Construct/receive `ConsentGate`, `AuditLog`, `DisclaimerComposer` (inject via constructor or an opts param so tests can pass fakes — see §6 and pitfalls).
2. `if (!consentGate.hasConsent())` → append an audit `refuse` entry (`ruleId: "consent-required"`), build a refuse `MedicalAnswer` carrying `disclaimer.footer()`, and return a valid `PipelineResult` WITHOUT touching numerics/LLM/retrieval.
3. Else → run `GuardrailSet.evaluate` (still allow-only this sprint), append an `answer` audit entry, return a placeholder `MedicalAnswer` WITH the footer.

**Critical:** the engine still must return `PipelineResult` (the `PipelineEngine` interface contract — `src/orchestrator/workflow/engine.ts:9-18`). The `MedicalAnswer` is the engine's *domain* product; how it is surfaced inside `PipelineResult` is your design choice, but `PipelineResult` MUST keep `success`, `spec`, `completedSprints`, `failedSprints`, `duration` (see §2 PipelineResult). Reuse `createSpec(...)` exactly as the stub does for the `spec` field. NOTE: `createSpec` internally calls `Date.now()` (`src/contracts/spec.ts:196-197`) — that is pre-existing plumbing for the spec id, NOT a consent/audit timestamp, so it does NOT violate the injected-clock rule. Do not "fix" it.

**A `now: string` (injected ISO timestamp) must reach the consent + audit writes.** Thread it through `run`'s `opts` (e.g. `opts?: { runId?: string; now?: string }`) or an injected clock — the audit `tIso` and the date in the filename derive from it.

**Imports this file already uses:**
- `type { BoberConfig }` from `../config/schema.js`
- `type { PipelineResult }` from `../orchestrator/pipeline.js`
- `type { PipelineEngine, PipelineEngineName }` from `../orchestrator/workflow/engine.js`
- `{ createSpec }` from `../contracts/spec.js`

**New imports to add:** the three new modules (`./consent.js`, `./audit.js`, `./disclaimer.js`) and the new types from `./types.js`.

**Imported by:**
- `src/medical/team.ts` does NOT import the engine (it builds the Team; the engine is selected separately).
- `src/orchestrator/workflow/selector.ts` (`selectPipelineEngineForTeam` constructs `MedicalSopEngine` for `pipelineShape: "medical-sop"` — see §7). **If you add required constructor args to `MedicalSopEngine`, the selector's `new MedicalSopEngine()` call WILL break.** Prefer optional/defaulted constructor args.
- `src/medical/engine.test.ts` (exists — `new MedicalSopEngine()` is called with zero args at lines 24, 29, 42, 65). **Keep the zero-arg constructor working** or you break sc-1-* regression.

**Test file:** `src/medical/engine.test.ts` (EXISTS, 79 lines — extend it, do not replace its Sprint 1 cases).

---

### src/medical/types.ts (modify — add ConsentRecord + AuditEntry)

`MedicalAnswer` is ALREADY here (`src/medical/types.ts:39-45`):
```typescript
export interface MedicalAnswer {
  body: string;
  abstained: boolean;
  citations: Citation[];
  disclaimerFooter: string;
  shortCircuit: boolean;
}
```
A consent refusal sets `{ body: <canned consent-required msg>, abstained: false, citations: [], disclaimerFooter: <footer()>, shortCircuit: true }` (refuse = a short-circuit per the assumptions block in the contract).

**Add `ConsentRecord` and `AuditEntry`** per the data model (`arch-...-architecture.md:204-217`):
```typescript
export interface ConsentRecord {
  consentVersion: string;
  acceptedAtIso: string;     // INJECTED, never Date.now()
  rulesetVersion: string;
  disclaimerVersion: string;
}

export type AuditEvent =
  | "consent" | "short-circuit" | "refuse" | "answer" | "abstain" | "ingest";

export interface AuditEntry {
  tIso: string;              // INJECTED
  event: AuditEvent;
  rulesetVersion?: string;
  patternsetVersion?: string;
  ruleId?: string;           // IDs/enums ONLY — NEVER prompt text or health values
}
```

---

### src/medical/consent.ts (create)

**Directory pattern:** `src/medical/` uses kebab-free single-word lowercase filenames (`engine.ts`, `team.ts`, `types.ts`), named exports, a JSDoc file header, and `// ── Section ──` box headers. Collocated `*.test.ts`.
**Most similar existing file:** `src/chat/careful-sidecar.ts` (class wrapping a `.bober/` JSON file, fail-closed read). Follow its structure.
**Structure template:**
```typescript
/** ConsentGate — fail-closed first-run consent (Phase 6, Sprint 2). */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir } from "../utils/fs.js";
import type { AuditLog } from "./audit.js";
import type { ConsentRecord } from "./types.js";

export class ConsentGate {
  constructor(
    private readonly projectRoot: string,
    private readonly audit: AuditLog,
  ) {}

  private path(): string {
    return join(this.projectRoot, ".bober", "medical", "consent.json");
  }

  /** Fail-closed: missing/corrupt file => false. Never throws. */
  async hasConsent(): Promise<boolean> {
    return (await this.current()) !== undefined;
  }

  /** Parsed ConsentRecord or undefined. Missing/corrupt => undefined. */
  async current(): Promise<ConsentRecord | undefined> {
    try {
      const data = JSON.parse(await readFile(this.path(), "utf-8")) as ConsentRecord;
      // validate required fields here (fail-closed on partial/corrupt)
      return data;
    } catch {
      return undefined;
    }
  }

  /** Persist a ConsentRecord (mode 0600) AND append a 'consent' audit entry. */
  async recordConsent(record: ConsentRecord, nowIso: string): Promise<void> {
    await ensureDir(join(this.projectRoot, ".bober", "medical"));
    await writeFile(this.path(), JSON.stringify(record, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
    await this.audit.append({ tIso: nowIso, event: "consent", rulesetVersion: record.rulesetVersion });
  }
}
```
NOTE: the architecture's `ConsentGate` interface (`arch-...-architecture.md:145-150`) shows `hasConsent(): boolean` / `current(): ConsentRecord | undefined` (sync). The codebase principle is **no sync fs** (`.bober/principles.md:42`) EXCEPT `better-sqlite3`. Consent is a plain JSON file, so use `node:fs/promises` and make these methods `async`. The contract's generatorNotes explicitly say `hasConsent() reads .bober/medical/consent.json` via `node:fs/promises`. Async is correct; deviate from the ADR's illustrative sync signature.

**Test file:** `src/medical/consent.test.ts` (create).

---

### src/medical/audit.ts (create)

**Most similar existing file:** `src/incident/timeline.ts:67-82` (`appendOneLine`) — the canonical mode-0600 O_APPEND helper. Also `src/orchestrator/checkpoints/audit.ts:86-128`.
**Structure template (copy the open/chmod/write/close exactly):**
```typescript
/** AuditLog — append-only IDs/enums-only medical audit log (Phase 6, Sprint 2). */
import { open, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { AuditEntry } from "./types.js";

export class AuditLog {
  constructor(private readonly projectRoot: string) {}

  /** Filename derives from the INJECTED tIso (YYYY-MM-DD slice). Never Date.now(). */
  private path(tIso: string): string {
    const date = tIso.slice(0, 10); // "2026-06-16"
    return join(this.projectRoot, ".bober", "medical", `audit-${date}.jsonl`);
  }

  async append(entry: AuditEntry): Promise<void> {
    const dir = join(this.projectRoot, ".bober", "medical");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const line = JSON.stringify(entry) + "\n";
    const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT;
    const fh = await open(this.path(entry.tIso), flags, 0o600);
    try {
      await fh.chmod(0o600); // guarantee mode even if umask reduced it
      await fh.write(line);
    } finally {
      await fh.close();
    }
  }
}
```
**Critical PHI rule:** `JSON.stringify(entry)` must serialize ONLY `{ tIso, event, rulesetVersion?, patternsetVersion?, ruleId? }`. Never pass prompt text, answer body, or health values into the entry. The type system enforces this — keep `AuditEntry` narrow.

**Test file:** `src/medical/audit.test.ts` (create).

---

### src/medical/disclaimer.ts (create)

**Smallest module.** No fs. Pure.
```typescript
/** DisclaimerComposer — versioned per-response wellness footer (Phase 6, Sprint 2). */
const DISCLAIMER_VERSION = "1.0.0";
const FOOTER_TEXT =
  "General wellness information only — not medical advice, diagnosis, or treatment. " +
  "Consult a licensed professional. In an emergency call your local emergency number.";

export class DisclaimerComposer {
  readonly disclaimerVersion = DISCLAIMER_VERSION;
  footer(): string {
    return `${FOOTER_TEXT} [disclaimer v${this.disclaimerVersion}]`;
  }
}
```
**Wording rule (regulatory):** keep it general-wellness, NON-diagnostic, NON-treatment — consistent with the FFDCA §201(h) / GW-safe-harbor posture (`arch-...-architecture.md:25`, `:28`). `footer()` must be non-empty and must carry `disclaimerVersion` (a test asserts both — sc-2-8). `disclaimerVersion` is recorded into the `ConsentRecord` (sc-2-5).

**Test file:** `src/medical/disclaimer.test.ts` (create).

---

## 2. Patterns to Follow

### Pattern A — Append-only mode-0600 JSONL (THE canonical audit write)
**Source:** `src/incident/timeline.ts:67-82`
```typescript
async function appendOneLine(filePath: string, record: unknown): Promise<void> {
  const dir = join(filePath, "..");
  await mkdir(dir, { recursive: true });
  const line = JSON.stringify(record) + "\n";
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT;
  const fh = await open(filePath, flags, 0o600);
  try {
    await fh.chmod(0o600); // Guarantee mode 0600 even if umask would have reduced it.
    await fh.write(line);
  } finally {
    await fh.close();
  }
}
```
**Rule:** Use `fs.open(path, O_WRONLY|O_APPEND|O_CREAT, 0o600)` then `fh.chmod(0o600)` then `fh.write(...)`. NEVER `appendFile` for the audit log — `appendFile` does not reliably honor the mode argument (documented rationale: `src/orchestrator/checkpoints/audit.ts:9-12`).

### Pattern B — Fail-closed `.bober/` JSON sidecar
**Source:** `src/chat/careful-sidecar.ts:26-45`
```typescript
async isCareful(): Promise<boolean> {
  try {
    const data = JSON.parse(await readFile(this.path(), "utf-8")) as { careful?: boolean };
    return data.careful === true;
  } catch { return false; }            // missing/malformed => safe default
}
async setCareful(on: boolean): Promise<void> {
  await ensureDir(join(this.projectRoot, ".bober", "chat"));
  await writeFile(this.path(), JSON.stringify({ careful: on }, null, 2) + "\n",
    { encoding: "utf-8", mode: 0o600 });
}
```
**Rule:** Reads catch-all to a SAFE default (fail-closed = no consent). Writes `ensureDir` first, then `writeFile` with `{ mode: 0o600 }`.

### Pattern C — Injected ISO timestamp (`now: string`), never the wall clock
**Source:** `src/state/memory.ts:66-72`, `src/orchestrator/memory/reconcile.ts:54`, `src/orchestrator/memory/hygiene.ts:41`
```typescript
// src/state/memory.ts:63-72
 * @param now - ISO 8601 wall-clock, injected by the CLI handler
export async function rewriteIndexForQuarantine(
  projectRoot: string,
  quarantinedIds: Set<string>,
  reason: string,
  now: string,          // <-- injected, not Date.now()
  namespace?: string,
): Promise<void> {
```
Also `src/state/facts.ts:20` documents the same invariant: "All timestamps are ISO 8601 strings; the store never reads the clock." And `factId` (`src/state/facts.ts:58-69`) derives a deterministic id from an injected `tCreated`.
**Rule:** Every timestamp (`acceptedAtIso`, audit `tIso`, the `<date>` in the filename) is a function parameter threaded from the caller. Zero `Date.now()` / `new Date()` in consent.ts, audit.ts, disclaimer.ts.

### Pattern D — Module shape (header + section boxes + named exports)
**Source:** `src/medical/team.ts:1-12`, `src/state/facts.ts`
```typescript
/** One-line purpose + (Phase 6, Sprint 2). */
import { ... } from "../utils/fs.js";   // .js extension, NodeNext
// ── Section name ──────────────────────────────────────────
export class Foo { ... }                 // named export, no default
```
**Rule:** `.js` import extensions, `import type` for type-only imports (`consistent-type-imports`, `.bober/principles.md:35`), unicode `// ── … ──` section headers, named exports.

---

## 3. Existing Utilities — DO NOT Recreate

Directories reviewed: `src/utils/`, `src/state/`, `src/orchestrator/checkpoints/`, `src/incident/`, `src/chat/`.

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `ensureDir` | `src/utils/fs.ts:45-47` | `(path: string): Promise<void>` | `mkdir(path, {recursive:true})` — use before writing consent.json |
| `ensureDir` (alt) | `src/state/helpers.ts:6-8` | `(dirPath: string): Promise<void>` | Same; FactStore uses this one. Either is fine — prefer `src/utils/fs.ts`. |
| `fileExists` | `src/utils/fs.ts:10-17` | `(path: string): Promise<boolean>` | `access(R_OK)` existence check |
| `readJson<T>` | `src/utils/fs.ts:24-27` | `(path: string): Promise<T>` | Read+parse JSON (THROWS on missing — for fail-closed catch it yourself) |
| `writeJson` | `src/utils/fs.ts:34-40` | `(path, data): Promise<void>` | Pretty JSON write — note: NO mode arg, so use raw `writeFile {mode:0o600}` for consent.json |
| `appendOneLine` (pattern) | `src/incident/timeline.ts:67-82` | internal | COPY this body into AuditLog.append (not exported — replicate) |
| `getAuditPath` (reference) | `src/orchestrator/checkpoints/audit.ts:74-76` | `(projectRoot, runId): string` | Path-helper idiom to mirror for `audit-<date>.jsonl` |
| `createSpec` | `src/contracts/spec.ts:189-233` | `(title, description, features, options?): PlanSpec` | Build the `PipelineResult.spec` (already used by the stub) |
| `factId` | `src/state/facts.ts:58-69` | `(scope,subject,predicate,value,tCreated): string` | Deterministic SHA-256 id from injected inputs — reference if you need a deterministic consent/audit id |

Note: `writeJson` (`src/utils/fs.ts:34`) does NOT set mode 0600 — for `consent.json` use raw `writeFile(path, ..., { mode: 0o600 })` like `CarefulSidecar` (`src/chat/careful-sidecar.ts:40-44`).

---

## 4. Prior Sprint Output

### Sprint 1 (commit 60215d2): medical-sop plumbing + medical team registration
- **`src/medical/types.ts`** — exports `GuardrailVerdict`, `GuardrailContext`, `GuardrailSet`, `Citation`, `MedicalAnswer`. **Connection:** add `ConsentRecord`, `AuditEntry`, `AuditEvent` here; reuse `MedicalAnswer` (`:39-45`) for the refuse verdict; reuse `GuardrailSet.rulesetVersion` (`:27`) to populate audit `rulesetVersion`.
- **`src/medical/engine.ts`** — exports `MedicalSopEngine` (stub `run` returns trivial `PipelineResult`, makes ZERO LLM calls). **Connection:** this is THE file you wire Gate 1 into. Preserve the zero-arg constructor (selector + existing test depend on it).
- **`src/medical/team.ts`** — exports `buildMedicalTeam(config)` and an inline `buildMedicalGuardrails()` (allow-all stub, `rulesetVersion = "0.0.0"`, `:33`). **Connection:** the Team's `guardrails.rulesetVersion` is what you record in audit entries. The guardrail still returns `{ kind: "allow" }` this sprint (non-goal: red-flag is S3).
- **`src/orchestrator/workflow/engine.ts:7`** — `PipelineEngineName` includes `"medical-sop"`. **Connection:** `run` still returns `PipelineResult`.
- **`src/config/schema.ts`** — `pipelineShape` Zod enum extended with `medical-sop`. No change needed this sprint.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **No sync fs** except where unavoidable (`:42`) — consent/audit use `node:fs/promises`. (The `better-sqlite3` carve-out does NOT apply this sprint — no DB here.)
- **No fs mocks in tests** (`:44`) — tests create temp dirs and clean up. MANDATORY for this sprint's tests.
- **Tests collocated** `*.test.ts` next to `*.ts` (`:20`) — put tests in `src/medical/`.
- **ESM `.js` extensions / NodeNext** (`:27`), **`import type`** (`:35`), **no `any`** (`:40`), **`_`-prefix unused params** (`:36`).
- **Zero TS errors + zero lint errors are hard gates** (`:18-19`).

### Architecture Decisions
- **`arch-...-architecture.md:142-170`** — `ConsentGate` / `AuditLog` / `DisclaimerComposer` component contracts (consent depends on AuditLog).
- **`arch-...-architecture.md:204-230`** — DATA MODEL for `ConsentRecord`, `AuditEntry`, `MedicalAnswer` (authoritative shapes; copy these field names exactly).
- **`arch-...-architecture.md:269`** — `ConsentGate.hasConsent` is GATE 1 (fail-closed), runs first in `run`.
- **`arch-...-architecture.md:327`** ("Audit PHI leak" risk row) — "IDs/enums only — never prompt text or health values; file mode 0600, O_APPEND|O_CREAT".
- **ADR-1 (`arch-...-adr-1.md`)** — code-enforced (not prompt-only) refusals; additive enum/switch, byte-zero impact on existing engines.
- **ADR-2 (`arch-...-adr-2.md:16`)** — `patternsetVersion` is recorded in the audit log (the optional `patternsetVersion` field exists for S3's RedFlagDetector; leave it unset this sprint).
- **ADR-6 (`arch-...-adr-6.md`)** — egress is OUT OF SCOPE this sprint, but note the FFDCA local-first posture that informs the disclaimer wording.

### Other Docs
No `CLAUDE.md`/`CONTRIBUTING.md` coding-guideline file in repo root governs this module beyond `.bober/principles.md`.

---

## 6. Testing Patterns

**Runner:** Vitest. **Assertion:** `expect`. **Mock:** `vi.fn()` / `vi.mock()`. **File naming/location:** `*.test.ts` collocated in `src/medical/`. **No fs mocks** — real temp dirs.

### Pattern — Temp-dir lifecycle (use in ALL three new test files + engine.test.ts additions)
**Source:** `src/orchestrator/checkpoints/audit.test.ts:27-39`, `src/chat/careful-sidecar.test.ts:14-22`
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-medical-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); vi.restoreAllMocks(); });
```

### Pattern — mode-0600 assertion (sc-2-6)
**Source:** `src/orchestrator/checkpoints/audit.test.ts:362-372`
```typescript
it("created audit file has mode 0600 on POSIX", async () => {
  if (process.platform === "win32") return;          // <-- guard, copy this
  await audit.append({ tIso: "2026-06-16T10:00:00.000Z", event: "answer" });
  const fileStat = await stat(join(tmpDir, ".bober", "medical", "audit-2026-06-16.jsonl"));
  expect(fileStat.mode & 0o777).toBe(0o600);
});
```

### Pattern — append-only / two-lines-first-intact (sc-2-6)
**Source idiom:** `src/orchestrator/checkpoints/audit.test.ts:57-64` (readAuditLines: split `\n`, filter Boolean, JSON.parse each)
```typescript
await audit.append({ tIso: "2026-06-16T10:00:00.000Z", event: "consent" });
const firstRaw = await readFile(path, "utf-8");
await audit.append({ tIso: "2026-06-16T11:00:00.000Z", event: "answer" });
const secondRaw = await readFile(path, "utf-8");
expect(secondRaw.startsWith(firstRaw)).toBe(true);    // first line byte-intact
expect(secondRaw.split("\n").filter(Boolean)).toHaveLength(2);
```

### Pattern — round-trip (sc-2-5)
**Source idiom:** `src/chat/careful-sidecar.test.ts:31-38` (write via one instance, read via a FRESH instance)
```typescript
const gate = new ConsentGate(tmpDir, audit);
await gate.recordConsent({ consentVersion:"1.0.0", acceptedAtIso:"2026-06-16T10:00:00.000Z",
  rulesetVersion:"0.0.0", disclaimerVersion:"1.0.0" }, "2026-06-16T10:00:00.000Z");
const fresh = new ConsentGate(tmpDir, audit);
expect(await fresh.hasConsent()).toBe(true);
expect((await fresh.current())?.acceptedAtIso).toBe("2026-06-16T10:00:00.000Z");
```

### Pattern — fail-closed + ZERO downstream calls (sc-2-4)
**Source:** `src/medical/engine.test.ts:1-11` already mocks `../utils/logger.js` and `../orchestrator/workflow/eligibility.js`. Extend with spies.
```typescript
const llmSpy = { chat: vi.fn() };                     // LLMClient fake
const numericsSpy = vi.fn();                          // numerics fake
const engine = new MedicalSopEngine(/* inject fakes */);
const result = await engine.run("my blood pressure is 180", tmpDir, config, { now: "2026-06-16T10:00:00.000Z" });
// no consent on disk => refuse
expect(/* refuse semantics on result/answer */).toBe(true);
expect(llmSpy.chat).not.toHaveBeenCalled();
expect(numericsSpy).not.toHaveBeenCalled();
```
NOTE: to make the spies observable you must INJECT them. The simplest design that keeps the zero-arg constructor (selector compatibility): give `MedicalSopEngine` an OPTIONAL constructor `deps` object (`{ consentGate?, auditLog?, disclaimer?, llm?, numerics? }`) that defaults to real instances built from `projectRoot`/`config` inside `run`. The contract's generatorNotes endorse "construct MedicalSopEngine with fakes." Document the seam.

### Pattern — PHI-leak (sc-2-7)
```typescript
await engine.run("SECRETBP=180 my blood pressure is 180", tmpDir, config, { now: "2026-06-16T10:00:00.000Z" });
const bytes = await readFile(join(tmpDir, ".bober", "medical", "audit-2026-06-16.jsonl"), "utf-8");
expect(bytes).not.toContain("SECRETBP");
expect(bytes).not.toContain("180");
for (const line of bytes.split("\n").filter(Boolean)) {
  const keys = Object.keys(JSON.parse(line));
  expect(keys.every(k => ["tIso","event","rulesetVersion","patternsetVersion","ruleId"].includes(k))).toBe(true);
}
```

### Pattern — deterministic timestamp (sc-2-8)
Inject a fixed ISO and assert it appears verbatim in BOTH the consent record file and the audit entry; assert `footer()` non-empty and contains the version.

### E2E
Not applicable — no Playwright config governs `src/medical/`. Unit tests only.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/workflow/selector.ts` | `MedicalSopEngine` (constructs via `new MedicalSopEngine()` in `selectPipelineEngineForTeam`) | **high** | If you add REQUIRED constructor args the selector won't compile/run. Keep the zero-arg path working (optional `deps`). |
| `src/medical/engine.test.ts` | `new MedicalSopEngine()` at lines 24,29,42,65 | **high** | Existing sc-1-4/sc-1-5 cases call zero-arg constructor and expect `run` to return a valid `PipelineResult`. Must stay green. |
| `src/medical/team.ts` | `src/medical/types.ts` (`GuardrailSet`, `GuardrailVerdict`, `GuardrailContext`) | **low** | You're ADDING types to types.ts, not changing existing ones. No break expected. |
| consumers of `PipelineResult` shape | `src/orchestrator/pipeline.ts:67-81` | **low** | `run` must keep returning the full `PipelineResult` (success/spec/completedSprints/failedSprints/duration). |

### Existing Tests That Must Still Pass
- `src/medical/engine.test.ts` — tests `MedicalSopEngine.name`, selector returns `MedicalSopEngine`, ts-engine regression, and stub `run` result shape. Your engine changes must not break these (zero-arg constructor + valid `PipelineResult`).
- `src/medical/team.test.ts` — tests `buildMedicalTeam` / `buildMedicalGuardrails`. Adding types to `types.ts` should not affect it; run it to confirm.
- The full pre-existing suite (~2300+ tests per project memory) — sc-2-3 requires it stays green. No existing module imports the three new files, so blast radius is limited to `src/medical/`.

### Features That Could Be Affected
- **Programming team / `ts|skill|workflow` engines** — share `PipelineEngineName` and `PipelineResult`. Verify byte-zero behavior (architecture HARD constraint, ADR-1). You only ADD a `medical-sop` code path; do not touch the other engines.
- **Sprint 3 (red-flag gate)** consumes `patternsetVersion` in audit entries — leave the optional field in `AuditEntry` so S3 can populate it without a schema change.

### Recommended Regression Checks
1. `npm run typecheck` — zero errors (sc-2-2).
2. `npm run build` — zero errors (sc-2-1).
3. `npx vitest run src/medical/` — all medical tests green (Sprint 1 + new).
4. `npx vitest run` — full suite green (sc-2-3); confirm Sprint 1 plumbing untouched.
5. `npx eslint src/medical/` — zero lint errors (consistent-type-imports, no-explicit-any).

---

## 8. Implementation Sequence

1. **`src/medical/types.ts`** — add `ConsentRecord`, `AuditEvent`, `AuditEntry`. (No deps; everything else imports these.)
   - Verify: `npm run typecheck` clean; `MedicalAnswer` untouched.
2. **`src/medical/disclaimer.ts`** — `DisclaimerComposer` (pure, no deps).
   - Verify: `footer()` non-empty and contains `disclaimerVersion`.
3. **`src/medical/audit.ts`** — `AuditLog` (depends on `AuditEntry`; copy `appendOneLine` body from `timeline.ts:67-82`).
   - Verify: writes `audit-<date>.jsonl` from injected `tIso`; mode 0600; append-only.
4. **`src/medical/consent.ts`** — `ConsentGate` (depends on `AuditLog` + `ConsentRecord`).
   - Verify: fail-closed (missing/corrupt => false/undefined); `recordConsent` writes mode-0600 JSON AND appends a `consent` audit entry; round-trips.
5. **`src/medical/engine.ts`** — wire Gate 1. Optional `deps` constructor; build real instances from `projectRoot`/`config` in `run` when not injected; thread injected `now`. No consent => refuse `MedicalAnswer` + `refuse` audit + footer + ZERO downstream calls; else allow-only guardrail + `answer` audit + footer.
   - Verify: existing `engine.test.ts` Sprint 1 cases still pass; zero-arg `new MedicalSopEngine()` still works for the selector.
6. **`src/medical/disclaimer.test.ts`, `audit.test.ts`, `consent.test.ts`, extend `engine.test.ts`** — temp-dir lifecycle, sc-2-4..sc-2-8 patterns from §6.
   - Verify: each new SC has a dedicated test.
7. **Run full verification** — `npm run typecheck` && `npm run build` && `npx vitest run` && `npx eslint src/medical/`.

---

## 9. Pitfalls & Warnings

- **DO NOT use `appendFile` for the audit log.** It does not reliably honor the mode argument across Node versions (`src/orchestrator/checkpoints/audit.ts:9-12`). Use `open(O_WRONLY|O_APPEND|O_CREAT, 0o600)` + `fh.chmod(0o600)` + `fh.write`.
- **DO NOT call `Date.now()` / `new Date()`** in consent.ts, audit.ts, disclaimer.ts, or the new engine gate. All timestamps are injected params. (`createSpec`'s internal `Date.now()` at `src/contracts/spec.ts:196` is pre-existing plumbing for a spec id and is fine — don't touch it.)
- **DO NOT add a REQUIRED constructor arg to `MedicalSopEngine`.** `selectPipelineEngineForTeam` and `engine.test.ts` call `new MedicalSopEngine()` with zero args. Use an OPTIONAL `deps` object that defaults to real instances inside `run`.
- **DO NOT put prompt text or health values into `AuditEntry`.** Keep the type narrow (`tIso/event/rulesetVersion?/patternsetVersion?/ruleId?`); the sc-2-7 test reads raw bytes and asserts absence of a distinctive token AND the numeric value.
- **DO NOT make any LLM/numerics/retrieval call when consent is absent.** Gate 1 returns before any downstream work. sc-2-4 spies assert zero calls.
- **The ADR shows `hasConsent(): boolean` (sync); use `async` (`Promise<boolean>`).** Project principle forbids sync fs except `better-sqlite3` (`.bober/principles.md:42`); consent is a JSON file. The contract's generatorNotes confirm async fs.
- **`writeJson` (`src/utils/fs.ts:34`) does not set mode 0600** — for `consent.json` use raw `writeFile(..., { mode: 0o600 })` (copy `careful-sidecar.ts:40-44`).
- **Filename date = `tIso.slice(0,10)`** from the INJECTED timestamp, not the system clock. A test injects `2026-06-16T...` and expects `audit-2026-06-16.jsonl`.
- **Guard mode-assertion tests with `if (process.platform === "win32") return;`** (`audit.test.ts:364`) — Windows has no POSIX mode bits.
- **Non-goals (do NOT implement):** red-flag detection (S3 — guardrail stays allow-only), HealthDataStore/numerics (S4), ingestion (S5), EgressGuard/full SOP/medications (S6), literature retrieval (S7). The `numerics` "fake" in sc-2-4 is just a spy you assert is NEVER called — you are not building a numerics layer.
