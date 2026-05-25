# Sprint Briefing: Incident timeline tracking — .bober/incidents/<id>/ structured artifacts

**Contract:** sprint-spec-20260524-bober-vision-19
**Generated:** 2026-05-25T00:00:00Z

This is the biggest Tier 3 code sprint so far. It creates the on-disk incident artifact layout AND the TypeScript append helpers every other Tier 3 sprint will use. Sprints 20 (deployer), 21 (rollback), 22 (postmortem) all consume these helpers.

---

## 1. Target Files

### `src/incident/types.ts` (create)

**Directory pattern:** No `src/incident/` directory exists yet. Sibling pattern: `src/orchestrator/checkpoints/` (single concern, sprint-owned). Naming convention is kebab-case for filenames, camelCase for variables, PascalCase for types/schemas.

**Most similar existing file:** `src/config/schema.ts` (zod-first, schema-then-`z.infer` type). Follow that pattern exactly — see Pattern 1 below.

**What this file MUST export (per contract s19-c1, s19-c5, s19-c6):**

```typescript
// All exports paired (Schema → infer'd Type):
export type IncidentId = string;                                // s19-c1
export const IncidentArtifactKindSchema = z.enum([             // s19-c1
  'timeline', 'observation', 'hypothesis', 'action',
  'change', 'runbook-execution', 'diagnosis', 'postmortem',
]);
export type IncidentArtifactKind = z.infer<typeof IncidentArtifactKindSchema>;

export const TimelineEventSchema = z.object({                  // s19-c4
  timestamp: z.string(),                                       // ISO-8601
  eventKind: z.string(),
  source: z.enum(['diagnoser','deployer','human','observability','system']),
  summary: z.string(),
  refPath: z.string().optional(),
});
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

// ObservationEntry — exact shape per skills/bober.diagnose/SKILL.md lines 74-82
export const ObservationEntrySchema = z.object({
  timestamp: z.string(),
  phase: z.number().int().min(1).max(4),
  observation: z.string(),
  source: z.string(),
  verified: z.boolean(),
});
export type ObservationEntry = z.infer<typeof ObservationEntrySchema>;

export const ActionEntrySchema = z.object({
  timestamp: z.string(),
  action: z.string(),
  blastRadius: z.enum(['safe', 'risky']),
  requiresApproval: z.boolean(),
  rationale: z.string().optional(),
});
export type ActionEntry = z.infer<typeof ActionEntrySchema>;

// ChangeEntry — `inverse` is REQUIRED at zod level. NOT .optional(). (s19-c5)
export const ChangeEntrySchema = z.object({
  id: z.string(),
  type: z.string(),
  executedAt: z.string(),
  description: z.string(),
  inverse: z.object({                              // REQUIRED. Do NOT add .optional()
    description: z.string(),
    command: z.string().optional(),
  }),
  status: z.enum(['pending', 'executed', 'rolled-back', 'failed']),
});
export type ChangeEntry = z.infer<typeof ChangeEntrySchema>;

// RunbookExecutionEntry — exact 7 fields per skills/bober.runbook/SKILL.md lines 187-195
export const RunbookExecutionEntrySchema = z.object({
  timestamp: z.string(),
  runbookName: z.string(),
  stepNumber: z.number().int().min(1),
  status: z.enum([
    'precondition_failed', 'checkpoint_rejected', 'execution_failed',
    'postcondition_failed_no_rollback', 'rollback_failed',
    'recovered_via_rollback', 'success',
  ]),
  preconditionResult: z.enum(['pass', 'fail', 'not_run']),
  postconditionResult: z.enum(['pass', 'fail', 'not_run']),
  rollbackTriggered: z.boolean().optional(),
});
export type RunbookExecutionEntry = z.infer<typeof RunbookExecutionEntrySchema>;

// IncidentMetadata — incident.json shape (s19-c6)
export const IncidentStatusSchema = z.enum([
  'investigating', 'remediating', 'monitoring', 'resolved', 'aborted',
]);
export type IncidentStatus = z.infer<typeof IncidentStatusSchema>;

export const IncidentMetadataSchema = z.object({
  incidentId: z.string(),
  symptom: z.string(),
  createdAt: z.string(),
  status: IncidentStatusSchema,
  resolvedAt: z.string().optional(),
  resolutionCriteria: z.string().optional(),
  postmortemPath: z.string().optional(),
});
export type IncidentMetadata = z.infer<typeof IncidentMetadataSchema>;

// listIncidents return shape (s19-c7)
export interface IncidentSummary {
  incidentId: string;
  symptom: string;
  createdAt: string;
  status: IncidentStatus;
  resolvedAt?: string;
}
```

**Imports this file uses:** `import { z } from "zod";`
**Test file:** `src/incident/types.test.ts` (optional — schemas tested transitively via `timeline.test.ts`).

---

### `src/incident/timeline.ts` (create)

**Most similar existing file:** `src/orchestrator/checkpoints/audit.ts` (PRIMARY pattern — exact same mutex + atomic append discipline).

**What this file MUST export:**
- `createIncident(symptom: string, projectRoot: string): Promise<IncidentId>` — creates `.bober/incidents/<id>/` skeleton + all 6 jsonl files (empty) + `hypotheses.md` (empty) + `diagnoses/` dir + `incident.json`.
- `deriveSlug(symptom: string): string` (export for testing) — handles edge cases per evaluatorNotes.
- `appendTimeline(projectRoot, incidentId, event)` — writes `timeline.jsonl`.
- `appendObservation(projectRoot, incidentId, entry)` — writes `observations.jsonl` AND `timeline.jsonl`.
- `appendAction(projectRoot, incidentId, entry)` — writes `actions.jsonl` AND `timeline.jsonl`.
- `appendChange(projectRoot, incidentId, entry)` — writes `changelog.jsonl` AND `timeline.jsonl`. Throws if `inverse` missing.
- `appendRunbookExecution(projectRoot, incidentId, entry)` — writes `runbook-execution.jsonl` AND `timeline.jsonl`.
- `setIncidentStatus(projectRoot, incidentId, status, opts?)` — atomic rewrite of `incident.json`. Sets `resolvedAt` automatically when status='resolved'.
- `listIncidents(projectRoot): Promise<IncidentSummary[]>` — handles missing dir gracefully (return `[]`), sorts desc by `createdAt`.

**Imports this file uses:**
```typescript
import { open, mkdir, writeFile, readdir, readFile, rename } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";  // optional, for ChangeEntry.id default
import { z } from "zod";
import {
  IncidentMetadataSchema, TimelineEventSchema, ObservationEntrySchema,
  ActionEntrySchema, ChangeEntrySchema, RunbookExecutionEntrySchema,
  type IncidentId, type IncidentMetadata, type IncidentStatus,
  type IncidentSummary, type TimelineEvent, type ObservationEntry,
  type ActionEntry, type ChangeEntry, type RunbookExecutionEntry,
} from "./types.js";
```

**Note the `.js` extension on the relative import** — this repo is `"type": "module"` and tsc emits ESM, so TS imports MUST include `.js`.

---

### `tests/incident/timeline.test.ts` (create) — OR — `src/incident/timeline.test.ts`

**Contract says `tests/incident/timeline.test.ts`.** Colocated precedent (Sprints 5/7-13, see `src/orchestrator/checkpoints/audit.test.ts:1-11`) prefers `src/incident/timeline.test.ts`. The audit module explicitly documented this deviation in its header.

**Recommendation for the Generator:** Follow the contract exactly (`tests/incident/timeline.test.ts`) — `tests/` IS in use (see `tests/config/`, `tests/integration/`, `tests/orchestrator/`). When colocated and non-colocated both exist in the same repo, defer to the contract.

**Most similar existing file:** `src/orchestrator/checkpoints/audit.test.ts` (tmpdir fixtures, concurrent appends, mode 0o600, ENOENT handling — see Pattern 5).

---

## 2. Patterns to Follow

### Pattern 1 — Zod schema + inferred type (CANONICAL)
**Source:** `src/config/schema.ts:5-6, 28-33, 144-145`
```typescript
export const CheckpointMechanismSchema = z.enum(["noop", "cli", "disk", "pr"]);
export type CheckpointMechanismName = z.infer<typeof CheckpointMechanismSchema>;
```
**Rule:** Always pair `XxxSchema` (the zod object) with `Xxx` (the inferred TS type). Use `z.infer<typeof XxxSchema>`, never write the type by hand — drift is the failure mode.

---

### Pattern 2 — Append-only JSONL via fs.open + O_APPEND + 0o600 (PRIMARY)
**Source:** `src/orchestrator/checkpoints/audit.ts:86-128`
```typescript
async function appendOneLine(projectRoot: string, runId: string, record: ApprovalRecord): Promise<void> {
  const dir = join(projectRoot, ".bober", "audits");
  await mkdir(dir, { recursive: true });
  const path = getAuditPath(projectRoot, runId);

  // Serialize the record — guard against circular references.
  let line: string;
  try {
    line = JSON.stringify(record) + "\n";
  } catch (err) { /* fallback omitted */ }

  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT;
  const fh = await open(path, flags, 0o600);
  try {
    // Guarantee mode 0600 even if umask would have reduced it.
    await fh.chmod(0o600);
    await fh.write(line);
  } finally {
    await fh.close();
  }
}
```
**Rule:** Every JSONL append in Sprint 19 MUST use this exact sequence:
1. `mkdir(dir, { recursive: true })` first (idempotent if exists).
2. `open(path, O_WRONLY|O_APPEND|O_CREAT, 0o600)`.
3. `fh.chmod(0o600)` explicitly to defeat umask.
4. `fh.write(line)` — line MUST end with `"\n"`.
5. `fh.close()` in a `finally` block.

Do NOT use `fs.appendFile` — its mode argument is not honored across all Node versions per the audit.ts comment.

---

### Pattern 3 — Per-key Promise-chain mutex
**Source:** `src/orchestrator/checkpoints/audit.ts:80-82, 141-152`
```typescript
const writeChains = new Map<string, Promise<void>>();

export async function recordApproval(
  projectRoot: string, runId: string, record: ApprovalRecord,
): Promise<void> {
  const prev = writeChains.get(runId) ?? Promise.resolve();
  const next = prev.then(() => appendOneLine(projectRoot, runId, record));
  // Swallow errors in the chain pointer so subsequent appends aren't blocked,
  // but propagate the real error to THIS caller via `next`.
  writeChains.set(runId, next.catch(() => {}));
  return next;
}
```
**Rule:** Sprint 19 uses a per-`incidentId` mutex map (`const writeChains = new Map<IncidentId, Promise<void>>()`). One chain per incident; unrelated incidents proceed in parallel. Concurrent appends to the same incident serialize. Critical for the "appendAction writes both actions.jsonl AND timeline.jsonl" guarantee — both writes happen inside the same mutex-held tick.

**For the double-write helpers (appendObservation/Action/Change/RunbookExecution):** Chain BOTH writes inside the SAME `.then()` so they share the mutex lock:
```typescript
const next = prev.then(async () => {
  await appendOneLine(targetFile, entry);   // e.g., actions.jsonl
  await appendOneLine(timelineFile, timelineEvent); // timeline.jsonl
});
```

---

### Pattern 4 — Existing project-root resolver (REUSE — do NOT recreate)
**Source:** `src/utils/fs.ts:58-79`
```typescript
export async function findProjectRoot(startDir?: string): Promise<string | null> {
  let dir = resolve(startDir ?? process.cwd());
  const markers = ["bober.config.json", "package.json"];
  for (;;) {
    for (const marker of markers) {
      if (await fileExists(join(dir, marker))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
```
**Rule:** Do NOT write a new project-root resolver. The `generatorNotes` mention "ResolveProjectRoot util (if not already in agent-bober's utils)" — IT ALREADY EXISTS. All Sprint 19 helpers accept `projectRoot: string` as a parameter (mirroring audit.ts). The CALLER is responsible for calling `findProjectRoot()`. Do not call it inside timeline.ts helpers.

---

### Pattern 5 — Atomic rewrite via rename-after-write
**Source:** `src/utils/fs.ts:34-40` (writeJson — but it's NOT atomic; use temp+rename for setIncidentStatus)
**For setIncidentStatus, use:**
```typescript
async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  await rename(tmp, path);  // POSIX rename within the same dir is atomic
}
```
**Rule:** `incident.json` is rewritten by `setIncidentStatus`. Use temp-file-then-rename to avoid leaving a half-written file if the process crashes mid-write. The temp file MUST be in the SAME directory as the destination so `rename` stays atomic on the same filesystem.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `findProjectRoot` | `src/utils/fs.ts:58` | `(startDir?: string) => Promise<string \| null>` | Walks up looking for bober.config.json or package.json. USE THIS — do not invent another. |
| `fileExists` | `src/utils/fs.ts:10` | `(path: string) => Promise<boolean>` | Async access(R_OK) wrapper. Useful for `listIncidents` to check if `.bober/incidents/` exists before readdir. |
| `readJson<T>` | `src/utils/fs.ts:24` | `(path: string) => Promise<T>` | Read+parse. Use for `incident.json` reads inside `listIncidents`. |
| `writeJson` | `src/utils/fs.ts:34` | `(path: string, data: unknown) => Promise<void>` | Pretty-print JSON write. NOT ATOMIC — for `setIncidentStatus` write your own temp+rename pattern. |
| `ensureDir` | `src/utils/fs.ts:45` | `(path: string) => Promise<void>` | `mkdir({recursive:true})` wrapper. Use in `createIncident` skeleton creation. |
| `logger` | `src/utils/logger.js` | `{ warn, info, error, debug }` | If you need to log non-fatal errors (e.g., a malformed `incident.json` in listIncidents), use this — don't `console.log`. |

**Note:** Re-export `findProjectRoot` is in `src/index.ts:185` — top-level public API. Don't touch `src/index.ts` unless the contract asks for it (it doesn't).

---

## 4. Prior Sprint Output

### Sprint 13: Checkpoint Audit Logger
**Created:** `src/orchestrator/checkpoints/audit.ts` — exports `recordApproval`, `runWithAudit`, `getAuditPath`, `resolveApproverId`. This is your PRIMARY copy-pattern source.
**Connection to this sprint:** The mutex pattern, the O_APPEND atomic write, the mode-0o600 chmod-after-open dance — ALL of these are replicated in Sprint 19. Read audit.ts end-to-end before writing timeline.ts.

### Sprint 15: bober-diagnoser agent
**Created:** `agents/bober-diagnoser.md` — defines `DiagnosisResult` JSON. Mentions saving to `.bober/incidents/<id>/diagnoses/<diagnosisId>.json`.
**Connection to this sprint:** `createIncident` MUST create the `diagnoses/` subdirectory inside the incident folder. The diagnoser is sandboxed and cannot write itself — the orchestrator writes the diagnosis JSON file there.

### Sprint 17: bober.diagnose skill
**Created:** `skills/bober.diagnose/SKILL.md` — locks the ObservationEntry shape at lines 74-82: `{timestamp, phase, observation, source, verified}` (5 fields). The skill writes `phase: 1` or `phase: 2` etc.
**Connection to this sprint:** `appendObservation` writes to `observations.jsonl`. The shape MUST match exactly (see Pattern 1 schema above). Phase is 1-4 (int).

### Sprint 18: bober.runbook skill
**Created:** `skills/bober.runbook/SKILL.md` — locks the RunbookExecutionEntry shape at lines 187-195. EXACT 7 camelCase fields: `timestamp, runbookName, stepNumber, status, preconditionResult, postconditionResult, rollbackTriggered?`.
**Connection to this sprint:** `appendRunbookExecution` writes to `runbook-execution.jsonl`. The skill explicitly notes (line 208): "Do NOT introduce field-name variants — `step_number` vs `stepNumber` — schema drift between sprints breaks the timeline." Sprint 19 IS the writer; the lock is on you.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` file found. Implicit principles from completed sprints:
- ESM imports require `.js` extension on relative paths (`"type": "module"` in package.json).
- Colocation precedent for tests, but contract overrides — use `tests/incident/timeline.test.ts` as contract specifies.
- File permissions `0o600` for any artifact that may contain prod data (audit.ts precedent).
- Errors NEVER break the pipeline silently — log via `logger.warn`, propagate via promise rejection where the caller can recover.

### Architecture Decisions
No formal ADRs in `.bober/architecture/`. The `evaluatorNotes` in this contract IS the architecture spec for Sprint 19 — re-read it before any judgment call:
- inverse field REQUIRED at zod level
- timeline.jsonl updated by every append helper
- Crash mid-append → valid lines only
- mode 0o600
- Slug handles edge cases (empty/punct/unicode/long)
- listIncidents missing dir → []

### Skill-driven schema locks
- `ObservationEntry`: 5 fields (`timestamp, phase, observation, source, verified`) — locked by skills/bober.diagnose/SKILL.md.
- `RunbookExecutionEntry`: 7 camelCase fields — locked by skills/bober.runbook/SKILL.md line 208.
- `ChangeEntry.inverse`: REQUIRED at zod level — locked by sprint contract s19-c5 AND evaluatorNotes paragraph 1 (Sprint 21 depends on this).

---

## 6. Testing Patterns

### Unit Test Pattern (vitest)
**Source:** `src/orchestrator/checkpoints/audit.test.ts:1-65`
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-incident-"));  // unique prefix per test file
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// Helper: factory for valid test inputs
function makeChange(overrides: Partial<ChangeEntry> = {}): ChangeEntry {
  return {
    id: "chg-1",
    type: "k8s_scale",
    executedAt: new Date().toISOString(),
    description: "scale to 6",
    inverse: { description: "scale to 3", command: "kubectl scale --replicas=3" },
    status: "executed",
    ...overrides,
  };
}

// Helper: read JSONL → array
async function readJsonl<T>(path: string): Promise<T[]> {
  const raw = await readFile(path, "utf-8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
}
```
**Runner:** vitest (`npm run test` invokes `vitest`)
**Assertion style:** `expect(...).toBe(...)`, `.toEqual(...)`, `.rejects.toThrow(...)`, `.toContain(...)`, `.toHaveLength(...)`
**Mock approach:** `vi.mock()` + dynamic re-import (only used in disk-mechanism resolveApproverId test — Sprint 19 should NOT need any mocks).
**File naming:** `<module>.test.ts`
**Location:** Contract says `tests/incident/timeline.test.ts`. Follow contract.

### Concurrent-appends test (DIRECTLY APPLICABLE — see Pattern 3)
**Source:** `src/orchestrator/checkpoints/audit.test.ts:242-263`
```typescript
it("100 parallel appends produce 100 distinct, parseable lines", async () => {
  const incidentId = await createIncident("concurrent test", tmpDir);
  await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      appendObservation(tmpDir, incidentId, {
        timestamp: new Date().toISOString(),
        phase: 1, observation: `obs-${i}`, source: "test", verified: true,
      }),
    ),
  );
  const obsPath = join(tmpDir, ".bober", "incidents", incidentId, "observations.jsonl");
  const lines = (await readFile(obsPath, "utf-8")).split("\n").filter(Boolean);
  expect(lines).toHaveLength(100);
  for (const line of lines) {
    expect(() => JSON.parse(line)).not.toThrow();
  }
  // ALSO verify timeline.jsonl got 100 lines (double-write pattern)
  const tlPath = join(tmpDir, ".bober", "incidents", incidentId, "timeline.jsonl");
  const tlLines = (await readFile(tlPath, "utf-8")).split("\n").filter(Boolean);
  expect(tlLines).toHaveLength(100);
});
```

### File-mode test (POSIX-only)
**Source:** `src/orchestrator/checkpoints/audit.test.ts:362-373`
```typescript
it("created jsonl file has mode 0600 on POSIX", async () => {
  if (process.platform === "win32") return;
  const incidentId = await createIncident("mode test", tmpDir);
  await appendTimeline(tmpDir, incidentId, {/*...*/});
  const fileStat = await stat(join(tmpDir, ".bober", "incidents", incidentId, "timeline.jsonl"));
  expect(fileStat.mode & 0o777).toBe(0o600);
});
```

### Required-field rejection test (s19-c5)
```typescript
it("appendChange without inverse throws schema error", async () => {
  const incidentId = await createIncident("rollback test", tmpDir);
  // @ts-expect-error — intentionally omitting required field
  const badChange = { id: "c1", type: "k8s_scale", executedAt: new Date().toISOString(),
                       description: "scale", status: "executed" };
  await expect(appendChange(tmpDir, incidentId, badChange)).rejects.toThrow(/inverse/);
  // Verify changelog.jsonl was NOT written at all
  const changelogPath = join(tmpDir, ".bober", "incidents", incidentId, "changelog.jsonl");
  const raw = await readFile(changelogPath, "utf-8");
  expect(raw).toBe("");  // file exists (empty from createIncident) but no line added
});
```

### Slug edge-cases test (s19-c3 + evaluatorNotes paragraph 5)
```typescript
it.each([
  ["500 errors on checkout endpoint", /^inc-\d{8}-500-errors-on$/],
  ["", /^inc-\d{8}-untitled$/],                                     // empty → 'untitled'
  ["!!!  !!!  ???", /^inc-\d{8}-untitled$/],                        // all-punct → 'untitled'
  ["a".repeat(200), /^inc-\d{8}-a{1,30}$/],                         // long → truncated ≤30 char slug
  ["数据库 连接 失败", /^inc-\d{8}-/],                              // unicode does not crash
])("deriveSlug(%j) → %s", async (symptom, pattern) => {
  const id = await createIncident(symptom, tmpDir);
  expect(id).toMatch(pattern);
});
```

### listIncidents missing-dir test (evaluatorNotes paragraph 6)
```typescript
it("listIncidents returns [] when .bober/incidents/ does not exist", async () => {
  // tmpDir has no .bober/incidents at all
  const result = await listIncidents(tmpDir);
  expect(result).toEqual([]);
});

it("listIncidents returns 3 sorted desc by createdAt", async () => {
  const id1 = await createIncident("first", tmpDir);
  await new Promise((r) => setTimeout(r, 10));  // ensure distinct createdAt
  const id2 = await createIncident("second", tmpDir);
  await new Promise((r) => setTimeout(r, 10));
  const id3 = await createIncident("third", tmpDir);
  const list = await listIncidents(tmpDir);
  expect(list).toHaveLength(3);
  expect(list[0].incidentId).toBe(id3);  // newest first
  expect(list[2].incidentId).toBe(id1);
});
```

### E2E Test Pattern
Not applicable — Sprint 19 is library code only. No HTTP/UI surface.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
Sprint 19 creates NEW files in a new directory (`src/incident/`). Nothing imports from `src/incident/*` today (verified via grep — zero matches). Risk surface is minimal.

| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/index.ts` | (re-exports public API) | low | Sprint 19 does NOT need to add re-exports unless contract requests it (it doesn't). Skip. |
| (none other) | — | low | New module is internally consistent. |

### Existing Tests That Must Still Pass
- `src/orchestrator/checkpoints/audit.test.ts` — your pattern source. Should be untouched by Sprint 19. Verify it still passes (regression sanity).
- `tests/config/**` — config schema tests. Unaffected. Verify.
- Full `npm run test` — must still exit 0 (s19-c9).

### Features That Could Be Affected
- **Sprint 13 audit logging** — same `.bober/` directory hierarchy. No conflict: audit writes to `.bober/audits/<runId>.jsonl`, Sprint 19 writes to `.bober/incidents/<id>/*`. Disjoint.
- **Sprint 17 diagnose skill** — references `observations.jsonl` shape. Sprint 19 IS the writer; align the schema exactly with the skill's documented 5 fields.
- **Sprint 18 runbook skill** — same: references `runbook-execution.jsonl` 7-field shape. Align exactly.
- **Future Sprint 20 (deployer)** — will call `appendChange`. The required-`inverse` constraint is the contract sprint 20 must honor.
- **Future Sprint 21 (rollback awareness)** — reads `changelog.jsonl` and inverses every change with `status='executed'`. If `inverse` is optional/missing, sprint 21 fails silently. This is WHY s19-c5 mandates the zod-required constraint.

### Recommended Regression Checks
After implementation, the Generator MUST verify (in order):
1. `npm run typecheck` — exit 0 (no TS errors anywhere in repo).
2. `npm run lint` — exit 0.
3. `npm run build` — exit 0 (tsc compiles `src/incident/*` to `dist/`).
4. `npm run test` — exit 0 (all existing tests + new Sprint 19 tests pass).
5. Manual sanity: create a throwaway directory, instantiate an incident, append one of each helper type, `cat` the resulting `timeline.jsonl` and verify ≥4 lines (one per append) all valid JSON.

---

## 8. Implementation Sequence

1. **`src/incident/types.ts`** — Write all zod schemas + paired inferred types (see Pattern 1 + Section 1 paste-ready code). No runtime logic.
   - Verify: `npm run typecheck` passes. `ChangeEntrySchema.parse({...without inverse})` should throw at this point (sanity check in a scratch script if you want).

2. **`src/incident/timeline.ts` — Step A: `deriveSlug`** — Pure function. No FS. Handles: lowercase, kebab from first 3 words, strip non-`[a-z0-9-]` chars, truncate ≤30 chars, fallback `'untitled'` if empty/all-stripped.
   - Verify: write 4 inline assertions (or unit tests immediately) for the four edge cases.

3. **`src/incident/timeline.ts` — Step B: per-incidentId mutex map + low-level `appendOneLine`** — Copy from `audit.ts:82, 86-128`. Parameterize by file path so the SAME helper writes any jsonl.
   - Verify: nothing yet; compiles.

4. **`src/incident/timeline.ts` — Step C: `createIncident`** — Compute `incidentId = 'inc-YYYYMMDD-<slug>'` (use `new Date().toISOString().slice(0,10).replace(/-/g,'')` for date). `mkdir` skeleton with `{recursive:true}`. Touch each empty file (`open(path, O_WRONLY|O_CREAT, 0o600)` then close — or use writeFile with empty string + mode). Write `incident.json` via the atomic-rename pattern.
   - Verify: write 1 test: `createIncident('500 errors on checkout endpoint')` returns `'inc-YYYYMMDD-500-errors-on'` AND all 7 files + `diagnoses/` directory exist.

5. **`src/incident/timeline.ts` — Step D: `appendTimeline`** — Validate input with `TimelineEventSchema.parse(event)` (throws on invalid). Then mutex-guarded `appendOneLine(timelinePath, line)`.
   - Verify: 1 test — append one event, read back via `JSON.parse(readFile)`, fields match.

6. **`src/incident/timeline.ts` — Step E: the four double-write helpers** (`appendObservation`, `appendAction`, `appendChange`, `appendRunbookExecution`). Each one:
   - Validate input with its zod schema (`.parse()`). For `appendChange`, this is where the inverse-required throw lands BEFORE any file write.
   - Inside a single mutex `then()`: `appendOneLine(specificFile)` then `appendOneLine(timelineFile)`.
   - Synthesize a `TimelineEvent` from the entry (e.g., `eventKind: 'action_taken'`, `source: 'system'` or domain-appropriate, `summary: <truncated entry description>`, `refPath: <relative path to the entry's source file>`).
   - Verify after each: double-write test passes.

7. **`src/incident/timeline.ts` — Step F: `setIncidentStatus`** — Read `incident.json`, mutate, atomic temp+rename write (Pattern 5). If new status is `'resolved'`, set `resolvedAt = new Date().toISOString()` automatically.
   - Verify: 1 test — create incident, set status to 'resolved', read incident.json, verify `status` AND `resolvedAt` are set.

8. **`src/incident/timeline.ts` — Step G: `listIncidents`** — `try { await readdir(incidentsDir) } catch (err) { if (err.code === 'ENOENT') return []; throw err; }`. For each entry, read `incident.json`, parse via schema (skip malformed with `logger.warn`). Sort by `createdAt` desc.
   - Verify: 2 tests — missing dir returns `[]`; create 3 incidents → returns 3 sorted desc.

9. **`tests/incident/timeline.test.ts`** — Round out coverage:
   - createIncident: skeleton structure, slug correct, all 4 slug edge cases (empty/punct/unicode/long).
   - appendTimeline: single line written.
   - Each of the four double-writers: writes BOTH files (regular file + timeline.jsonl).
   - appendChange: missing-inverse throws AND changelog.jsonl unmodified.
   - 100x concurrent appendObservation: 100 valid lines in observations.jsonl AND 100 valid lines in timeline.jsonl.
   - Mode 0o600 on a written jsonl.
   - setIncidentStatus: rewrites incident.json, sets resolvedAt when status='resolved'.
   - listIncidents: missing dir → [], 3-incident sort.
   - (Optional) malformed incident.json: listIncidents skips it without crashing.

10. **Run full verification** — `npm run typecheck && npm run lint && npm run build && npm run test`. All must exit 0.

---

## 9. Pitfalls & Warnings

- **`inverse` is REQUIRED at the zod level.** The contract s19-c5 AND evaluatorNotes paragraph 1 are explicit: `inverse: z.object({...})` with NO `.optional()`. Test MUST cover this — calling `appendChange` without inverse must throw BEFORE the file is touched (which means `.parse()` must run BEFORE the mutex enter).
- **EVERY append helper writes timeline.jsonl too** (s19-c4, evaluatorNotes paragraph 2). The only exception is `appendTimeline` itself (it writes ONLY timeline.jsonl). Both writes per double-helper MUST happen inside the same mutex tick so the order is deterministic.
- **Don't use `fs.appendFile`** — the audit.ts comment lines 11-13 explicitly notes it does not reliably honor the mode argument. Use `fs.open(...)` with O_WRONLY|O_APPEND|O_CREAT + explicit `fh.chmod(0o600)`.
- **The mode-0o600 chmod-after-open is NOT redundant** — the umask may have masked off bits during `open`. The `fh.chmod` AFTER open guarantees the mode regardless of umask. See audit.ts:122-123.
- **JSONL atomicity:** O_APPEND single-line writes <PIPE_BUF (4KB) are atomic on POSIX. The mutex guarantees in-process serialization. A crash mid-write would leave a partial last line — split-by-`\n` + `filter(Boolean)` reading is robust to this. State the assumption: tests use `lines.filter(Boolean)` exactly as audit.test.ts does.
- **`.js` extension on relative imports** — `"type": "module"` in package.json means tsc's emit assumes `.js` paths even in `.ts` source. Forgetting this causes runtime "Cannot find module" failures. ALL relative imports inside `src/incident/*.ts` MUST end in `.js`.
- **Slug edge cases:** `'!!!  !!!'.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')` → empty string. MUST fall back to `'untitled'`. Same for empty input or unicode-only input that strips to nothing.
- **Unicode in slugs:** Don't reject unicode — just strip it via the `[^a-z0-9-]` regex like everything else. The fallback to `'untitled'` handles the all-unicode case automatically.
- **Date in incidentId:** Use UTC date. `new Date().toISOString().slice(0,10).replace(/-/g,'')` gives YYYYMMDD UTC. Tests in different timezones must still produce predictable IDs.
- **Don't recreate `findProjectRoot`** — it exists in `src/utils/fs.ts:58`. The generatorNotes hedge ("if not already in agent-bober's utils") is misleading — it IS already there. All Sprint 19 helpers accept `projectRoot` as a param; callers are responsible for resolution.
- **`listIncidents` ENOENT handling:** Use `err.code === 'ENOENT'` after `readdir` failure to return `[]`. Don't `fileExists` first then `readdir` — that's TOCTOU. Just try, catch ENOENT, rethrow anything else.
- **Avoid mutating module state across test files:** The `writeChains` Map persists across tests in the same vitest worker (module is cached). This is FINE because each test uses a unique `incidentId` from `mkdtemp` + `createIncident`. But if tests reuse an incidentId, leftover chain pointers can cause cross-test interference. Use fresh incidentIds per test (the `createIncident` UUID-via-slug-and-date approach guarantees this naturally with different symptoms).
- **`tests/` vs colocated:** Contract says `tests/incident/timeline.test.ts`. Audit precedent (line 1-11 of audit.test.ts) chose colocated and documented the deviation. EITHER is acceptable but the contract is the source of truth — go with `tests/incident/timeline.test.ts`. If you choose colocated, document the deviation in the test file's header like audit.test.ts does.
- **Don't add `src/incident/*` to `src/index.ts` re-exports** unless the contract asks for it. It doesn't. Keep the change footprint small.
