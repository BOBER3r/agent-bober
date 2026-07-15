# Sprint Briefing: Auto-producer — deterministic project-fact detector + fact retrieval into context

**Contract:** sprint-spec-20260615-memory-self-improve-p0-5
**Generated:** 2026-06-15T00:00:00Z
**Spec:** spec-20260615-memory-self-improve-p0 (Sprint 5 of 5, FINAL)

---

## 0. TL;DR — what this sprint builds

1. **`fact-detector.ts`** — PURE `detectProjectFacts({ packageJson, boberConfig })` → array of fact drafts. NO fs, NO LLM inside the pure fn. Mirrors how `distill()` is pure.
2. **`fact-retrieve.ts`** — `retrieveRelevantFacts(projectRoot, scope, keywords, {topK})` (one store read + deterministic ranking) and `serializeFactsForContext(records, {charBudget})` (bounded block). Mirrors `retrieve.ts` exactly.
3. **Guarded wiring** in `pipeline.ts` (`runPipeline` start, line 1017) and `chat-session.ts` (`start()`, line 489) — thin IO callers read `package.json` + `bober.config.json`, call the detector, open `FactStore`, `writeFact` each draft, `close()`. ALL wrapped in `try/catch` that logs-and-continues.
4. **Context injection** — serialized facts block added into the planner `userMessage` (planner-agent.ts line 199-209) alongside the project-context block, scope-keyed.

NO LLM produces facts. The only LLM in the whole path is reconcile's ambiguity-branch judge from Sprint 2, which is NOT wired here (no judge passed → deterministic ADD/UPDATE/NOOP only).

---

## 1. Target Files

### src/orchestrator/memory/fact-detector.ts (create)

**Directory pattern:** Files in `src/orchestrator/memory/` use kebab-case (`fact-judge.ts`, `eval-source.ts`, `distill.ts`). Pure logic files have a co-located `*.test.ts`.
**Most similar existing file:** `src/orchestrator/memory/distill.ts` — a PURE function that takes already-parsed inputs and returns drafts; the IMPURE IO counterpart (`eval-source.ts` / the CLI) does the fs reads. Mirror that split exactly.

**Structure template (PURE — no fs, no LLM):**
```typescript
import type { FactInput } from "../../state/facts.js";

/** Already-parsed manifests/config passed in by the thin IO caller. */
export interface ProjectInputs {
  packageJson: Record<string, unknown> | null;   // parsed package.json (or null if absent)
  boberConfig?: Record<string, unknown> | null;  // parsed bober.config.json (optional)
  /** Lockfile presence flags, computed by the caller (no fs in here). */
  lockfiles?: { npm?: boolean; yarn?: boolean; pnpm?: boolean };
}

/** A fact draft — everything EXCEPT the injected timestamps, which the caller stamps. */
export type FactDraft = Omit<FactInput, "tValid" | "tCreated">;

/**
 * PURE: map parsed manifests/config into project-fact drafts.
 * NO fs read, NO Date.now(), NO LLM. Returns [] when nothing detectable.
 */
export function detectProjectFacts(inputs: ProjectInputs, scope = ""): FactDraft[] {
  // ... deterministic mapping, see §5
}
```

**IMPORTANT — scope convention:** Use `scope = ""` for the default/programming team (see §5 + `src/state/memory.ts:27-32` memoryDir mapping). The reconcile test (`reconcile.test.ts:22`) uses `scope: "programming"` as its literal, but the namespace SENTINEL for the default team is `""` (`src/teams/registry.ts:66`). The facts `scope` column is free-form text; what matters is that retrieval queries the SAME scope string the detector wrote. Pick one (`""`) and use it consistently in both detector and retrieval.

---

### src/orchestrator/memory/fact-retrieve.ts (create)

**Most similar existing file:** `src/orchestrator/memory/retrieve.ts` — copy its `tokenize` + `scoreRecord` + serializer shape line-for-line, swapping `LessonIndexRecord` for `FactRecord` and `loadLessonIndex` for a single `FactStore.getActiveFacts(scope)` read.

**Structure template:**
```typescript
import { FactStore, factsDbPath, ensureFactsDir } from "../../state/facts.js";
import type { FactRecord } from "../../state/facts.js";

const DEFAULT_TOP_K = 5;
const DEFAULT_CHAR_BUDGET = 1200;

// tokenize: COPY VERBATIM from retrieve.ts:30-35
function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

// scoreRecord: mirror retrieve.ts:42-61 — score a FactRecord against keyword tokens
function scoreFact(record: FactRecord, keywordTokens: Set<string>): number {
  if (keywordTokens.size === 0) return 0;
  const recordTokens = new Set<string>([
    ...tokenize(record.subject),
    ...tokenize(record.predicate),
    ...tokenize(record.value),
  ]);
  let count = 0;
  for (const t of keywordTokens) if (recordTokens.has(t)) count++;
  return count;
}

/** ONE store read, then pure ranking. Opens + closes the store internally. */
export async function retrieveRelevantFacts(
  projectRoot: string,
  scope: string,
  keywords: string[],
  { topK = DEFAULT_TOP_K, namespace }: { topK?: number; namespace?: string } = {},
): Promise<FactRecord[]> {
  await ensureFactsDir(projectRoot, namespace);
  const store = new FactStore(factsDbPath(projectRoot, namespace));
  try {
    const records = store.getActiveFacts(scope); // scope-isolated by SQL WHERE scope = ?
    const keywordTokens = new Set(keywords.flatMap(tokenize));
    const scored = records
      .map((r) => ({ r, score: scoreFact(r, keywordTokens) }))
      .filter((x) => x.score > 0);
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        a.r.id.localeCompare(b.r.id), // byte-stable final tiebreak (mirror retrieve.ts:103)
    );
    return scored.slice(0, topK).map((x) => x.r);
  } finally {
    store.close();
  }
}

/** Mirror serializeLessonsForPlanner (retrieve.ts:122-144): header + one line/fact + hard charBudget slice. */
export function serializeFactsForContext(
  records: FactRecord[],
  { charBudget = DEFAULT_CHAR_BUDGET }: { charBudget?: number } = {},
): string {
  if (records.length === 0) return "";
  const lines = [
    "## Project facts (durable semantic memory)",
    "",
    ...records.map((r) => `- ${r.subject}/${r.predicate}: ${r.value}`),
    "",
  ];
  return lines.join("\n").slice(0, charBudget); // HARD slice — never exceed budget
}
```

**Design note on `retrieveRelevantFacts` with empty keywords:** retrieve.ts filters `score > 0`, so empty keywords ⇒ empty result. For project facts you may WANT all active facts even with no keyword overlap (they are few and high-value). Decide per the contract: sc-5-5 only requires "ranked deterministically" + scope isolation. The safe choice that still passes scope-isolation tests is to keep the `score > 0` filter (matches retrieve.ts) OR fall back to returning all-active sorted by id when `keywords` is empty. State your choice in a comment.

---

### src/orchestrator/pipeline.ts (modify) — line 1017

**Relevant section (lines 1004-1026), the public `runPipeline` entry — the ONLY safe additive site:**
```typescript
// src/orchestrator/pipeline.ts:1004-1026
import { selectPipelineEngineForTeam } from "./workflow/selector.js";
import { loadTeam } from "../teams/registry.js";

export async function runPipeline(
  userPrompt: string,
  projectRoot: string,
  config: BoberConfig,
  opts?: { runId?: string; teamId?: string },
): Promise<PipelineResult> {
  const teamId = opts?.teamId ?? config.defaultTeam;
  const team = loadTeam(config, teamId);
  // <<< INSERT guarded detect+reconcile block HERE — after team is resolved, BEFORE the engine .run()
  return selectPipelineEngineForTeam(team, config).run(userPrompt, projectRoot, config, opts);
}
```

**Already in scope at the insertion point:** `userPrompt`, `projectRoot`, `config` (typed `BoberConfig`), `team` (has `team.memoryNamespace`). `logger` is already imported at `pipeline.ts:61` (`import { logger } from "../utils/logger.js";`).

**Insertion (additive, guarded):**
```typescript
  // ── Sprint 5: deterministic project-fact auto-producer (best-effort) ──
  // A facts failure must NEVER abort a pipeline run.
  try {
    await seedProjectFacts(projectRoot, team.memoryNamespace || undefined);
  } catch (err) {
    logger.warn(`Project-fact seeding skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
```
Put `seedProjectFacts` (the thin IO caller — reads package.json + bober.config.json, detects lockfiles, calls `detectProjectFacts`, opens `FactStore`, `writeFact` each draft with `now` stamped here, `close()`) in fact-detector.ts OR a small `fact-seed.ts` helper. Mirror the IO discipline in `src/cli/commands/facts.ts:80-134` (ensureFactsDir → new FactStore → writeFact → finally close).

**Imported by (callers of runPipeline):** `src/cli/commands/run.ts` (only non-test caller). Signature is FROZEN — do not change it (comment at pipeline.ts:1011). Your change is additive inside the body only.

**Test file:** `src/orchestrator/pipeline.ts` has multiple `pipeline.*.test.ts` siblings (e.g. `pipeline.guidance.test.ts`). Do NOT add a heavy integration test here; cover the detector+reconcile behavior in `fact-detector.test.ts` and rely on the guard being inspectable (evaluatorNotes sc-5-4 accepts code inspection).

---

### src/chat/chat-session.ts (modify) — `start()` at line 489

**Relevant section (lines 489-498), the startup seam:**
```typescript
// src/chat/chat-session.ts:489-498
async start(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  process.stdout.write(
    "bober chat — type a question, /help for commands, /exit to quit\n> ",
  );
  // <<< INSERT guarded detect+reconcile block HERE — after the banner, before the for-await loop
  for await (const line of rl) {
    // ...
  }
}
```

**Already in scope:** `this.projectRoot` (set in constructor, chat-session.ts:108), `this.memoryNamespace` (chat-session.ts:102/110 — `undefined` means default `.bober/memory/`). **NOTE: ChatSession does NOT receive `BoberConfig`** — there is no config field. The thin IO caller here must read `package.json` + `bober.config.json` from `this.projectRoot` itself (or call `loadConfig(this.projectRoot)`). Reuse the same `seedProjectFacts(projectRoot, namespace)` helper as pipeline.ts.

**Insertion (additive, guarded — same discipline):**
```typescript
  // ── Sprint 5: seed project facts at chat startup (best-effort) ──
  try {
    await seedProjectFacts(this.projectRoot, this.memoryNamespace);
  } catch {
    // A facts failure must NEVER break chat startup. (silent or logger.warn)
  }
```

**Test file:** `src/chat/chat-session.test.ts` exists (ChatSession has injected deps for testing — see `ChatSessionOptions` at chat-session.ts:35-55). If you add a test, inject a tmpdir `projectRoot`; the existing tests construct ChatSession with injected `rl`/`spawner`/`tailer`.

---

## 2. Patterns to Follow

### Pattern A — PURE producer + thin IO caller (the core invariant of this whole feature)
**Source:** `src/orchestrator/memory/reconcile.ts:1-9` (purity docblock) and `src/cli/commands/facts.ts:84-97` (where `now` is stamped at the boundary).
```typescript
// reconcile.ts:51-55 — now is INJECTED, never read inside
export async function reconcileFact(
  store: FactStore,
  incoming: FactInput,
  { judge, now }: { judge?: FactJudge; now: string },
): Promise<ReconcileAction> {
```
```typescript
// facts.ts:85-97 — caller stamps wall-clock at the boundary
const now = new Date().toISOString();
const input = { scope, subject, predicate, value, confidence, sourceRunId: ..., tValid: now, tCreated: now };
```
**Rule:** The detector is PURE and returns drafts WITHOUT timestamps. The thin caller stamps `now = new Date().toISOString()` once, applies it as `tValid` + `tCreated` to every draft, and passes `{ now }` to `writeFact`. Never call `Date.now()` / `new Date()` inside `detectProjectFacts`.

### Pattern B — writeFact is the ONLY write path (gives free idempotency)
**Source:** `src/cli/commands/facts.ts:99-134`
```typescript
const store = new FactStore(factsDbPath(projectRoot, ns));
try {
  const action = await writeFact(store, input, { now }); // NO judge → deterministic NOOP/ADD/UPDATE
  // ...
} finally {
  store.close();
}
```
**Rule:** Always route writes through `writeFact(store, input, { now })` (re-exported from `src/state/facts.ts:13`). Same value → NOOP (no dup); changed value → supersede (one active row per predicate). Never call `store.insertFact` directly — that skips reconciliation.

### Pattern C — deterministic ranking + byte-stable tiebreak
**Source:** `src/orchestrator/memory/retrieve.ts:94-106`
```typescript
const scored = records
  .map((r) => ({ r, score: scoreRecord(r, keywordTokens) }))
  .filter((x) => x.score > 0);
scored.sort(
  (a, b) =>
    b.score - a.score ||                       // 1. token overlap (DOMINANT)
    b.r.occurrences - a.r.occurrences ||        // 2. (facts have no occurrences — drop this line)
    a.r.lessonId.localeCompare(b.r.lessonId),  // 3. byte-stable final tiebreak
);
return scored.slice(0, topK).map((x) => x.r);
```
**Rule:** Sort by `score DESC` then `id.localeCompare` ASC for byte-stable output. Facts have no `occurrences` field — use `score DESC || r.id.localeCompare` only.

### Pattern D — serializer: header + per-line + HARD charBudget slice
**Source:** `src/orchestrator/memory/retrieve.ts:122-144`
```typescript
if (records.length === 0) return "";
const lines = ["## Lessons from past sprints (bounded memory index)", "", ...records.map(r => `- ...`), ""];
const block = lines.join("\n");
return block.slice(0, charBudget); // C3 guarantee — hard truncation
```
**Rule:** Empty input → `""`. Otherwise header line + one `-` line per fact, joined with `\n`, then `.slice(0, charBudget)`. Output length is GUARANTEED ≤ charBudget by the final slice (sc-5-5).

### Pattern E — deterministic id from signature (no wall-clock in id)
**Source:** `src/state/facts.ts:58-69` (`factId`) and `src/orchestrator/memory/distill.ts:88-99` (`lessonIdFromSignature`).
**Rule:** You do NOT compute ids in this sprint — `insertFact` derives them. But note: `factId` includes `tCreated`, so two writes with different `tCreated` produce different ids even for the same value. `writeFact`/reconcile dedups on `scope|subject|predicate` value-equality (NOOP), NOT on id — so idempotency comes from reconcile, not the id. This is why sc-5-3's double-reconcile test must use writeFact, not insertFact.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `FactStore` | `src/state/facts.ts:136` | `new FactStore(dbPath: string)` | SQLite-backed bi-temporal store; `':memory:'` for tests, file path for prod |
| `FactStore.getActiveFacts` | `src/state/facts.ts:213` | `(scope, subject?, predicate?): FactRecord[]` | Scope-isolated active rows (`WHERE scope=? AND t_invalidated IS NULL`) — the scope-isolation guarantee for sc-5-5 |
| `FactStore.close` | `src/state/facts.ts:294` | `(): void` | Close DB — ALWAYS in a `finally` |
| `writeFact` | re-exported `src/state/facts.ts:13` (impl `reconcile.ts:148`) | `(store, incoming: FactInput, {judge?, now}): Promise<ReconcileAction>` | Reconcile-then-write; NOOP/ADD/UPDATE; idempotent; use for ALL detector writes |
| `reconcileFact` | `src/orchestrator/memory/reconcile.ts:51` | same as writeFact | Underlying reconcile; writeFact is the public wrapper |
| `FactSchema` / `FactInput` | `src/state/facts.ts:22,33` | Zod schema → `{scope,subject,predicate,value,confidence,sourceRunId,tValid,tCreated}` | The exact shape the detector's drafts (+ injected timestamps) must satisfy |
| `FactRecord` | `src/state/facts.ts:37-49` | interface | Return type of getActiveFacts / what serializer renders |
| `factsDbPath` | `src/state/facts.ts:77` | `(projectRoot, namespace?): string` | Resolves `.bober/memory[/<ns>]/facts.db` |
| `ensureFactsDir` | `src/state/facts.ts:86` | `(projectRoot, namespace?): Promise<void>` | mkdir before file-backed FactStore; call before `new FactStore(path)` |
| `factId` | `src/state/facts.ts:58` | `(scope,subject,predicate,value,tCreated): string` | Deterministic id (test assertions only) |
| `memoryDir` | `src/state/memory.ts:27` | `(projectRoot, namespace?): string` | Namespace→dir mapping: `undefined\|""\|"programming"` → `.bober/memory/`, else `.bober/memory/<ns>/` |
| `loadTeam` | `src/teams/registry.ts` | `(config, teamId?): Team` (has `.memoryNamespace`) | Resolve active team → its `memoryNamespace` (`""` for default, registry.ts:66) |
| `loadConfig` | `src/config/loader.ts:142` | `(projectRoot): Promise<BoberConfig>` | Load bober.config.json (chat caller may use this, or read the file raw) |
| `findProjectRoot` | `src/utils/fs.ts:58` | `(): Promise<string \| undefined>` | Resolve project root (used by CLI handlers) |
| `logger` | `src/utils/logger.js` (imported pipeline.ts:61) | `.warn/.info/.error/...` | Use `logger.warn(...)` in the pipeline guard's catch |
| `tokenize` (lessons) | `src/orchestrator/memory/retrieve.ts:30` | `(s): string[]` | NOT exported — COPY the 4-line body into fact-retrieve.ts (do not import) |

Utilities reviewed: `src/state/`, `src/orchestrator/memory/`, `src/utils/`, `src/config/`, `src/teams/` — all relevant ones above. No util/lib/helpers/shared dir hides a JSON-manifest parser; the planner reads package.json inline (`planner-agent.ts:97-100`).

---

## 4. Prior Sprint Output

### Sprint 1: FactStore (`src/state/facts.ts`)
**Created:** `FactStore` class + `insertFact`/`getActiveFacts(scope,subject?,predicate?)`/`getFact`/`invalidateFact`/`supersedeFact`/`close`; `FactSchema`/`FactInput`/`FactRecord`; `factId`; `factsDbPath`/`ensureFactsDir`; `memoryDir` mapping reused from `src/state/memory.ts:27`. DB at `.bober/memory/facts.db`.
**Connection to this sprint:** The retrieval reads via `getActiveFacts(scope)` (scope isolation = SQL `WHERE scope=?`); the detector's drafts must satisfy `FactSchema`.

### Sprint 2: reconcile + writeFact (`src/orchestrator/memory/reconcile.ts`)
**Created:** `reconcileFact(store, incoming, {judge?, now})` → `ReconcileAction` ("add"|"update"|"delete"|"noop"); `writeFact` wrapper (re-exported from facts.ts:13). Deterministic NOOP (same value) / ADD (new) / UPDATE-supersede (changed). Idempotent. Judge consulted ONLY on normalized-key collision when provided.
**Connection to this sprint:** The detector writes EVERY draft through `writeFact(store, input, { now })` with NO judge → purely deterministic. sc-5-3's "no duplication" follows directly: re-running the detector with unchanged manifests yields NOOP, changed scripts yield supersede (one active row per predicate).

### Sprint 3 (reference, not a hard dependency): `retrieve.ts`
**Created:** `tokenize` (retrieve.ts:30) + `scoreRecord` (retrieve.ts:42) ranking + `serializeLessonsForPlanner` (retrieve.ts:122). **Connection:** `fact-retrieve.ts` MIRRORS these exactly (different record type, single store read instead of index file). NOTE: `serializeLessonsForPlanner`/`retrieveRelevantLessons` are currently UNWIRED into the planner (only `buildMemoryDistill` at chat-session.ts:64 uses the lesson index) — so the "next to the lessons block" injection target is the planner `userMessage` assembly (§ below), not an existing lessons-block call site.

---

## 5. Deterministic Detection Rules (concrete mapping)

From a parsed `package.json` (the planner reads it raw at `planner-agent.ts:97-100`) and lockfile presence, produce these drafts (all `subject = "project"`, `scope = ""`):

| Predicate | Source | Rule |
|-----------|--------|------|
| `project/testCommand` | `packageJson.scripts.test` | if truthy → value = the script string (e.g. `"vitest run"`). Omit if absent. |
| `project/buildCommand` | `packageJson.scripts.build` | if truthy → value = the script string. Omit if absent. |
| `project/packageManager` | lockfile presence | `package-lock.json`→`"npm"`, `yarn.lock`→`"yarn"`, `pnpm-lock.yaml`→`"pnpm"`. First match wins (deterministic order). Omit if none present. |
| `project/framework` | `dependencies`+`devDependencies` keys | `next`→`"next"`, `react`→`"react"`, `vue`→`"vue"`. Check in a FIXED order (e.g. next before react). Omit if none. |

**This repo's own `package.json`** (read it to build the fixture) yields, e.g. `scripts.test` and `scripts.build` (verify exact strings with `Read /Users/.../package.json`). Lockfile in this repo determines packageManager; no react/next/vue dep → no framework fact. Use a SYNTHETIC fixture in the test (a `package.json` literal with `scripts.test`, `scripts.build`, and a react dep) so assertions are stable and independent of the repo evolving.

**Scope convention (cite):** `src/state/memory.ts:27-32` — `memoryDir(projectRoot, ns)` maps `undefined | "" | "programming"` to the bare `.bober/memory/` dir. The default team's `memoryNamespace` is the sentinel `""` (`src/teams/registry.ts:66`). Use `scope = ""` in detector drafts AND `retrieveRelevantFacts(..., scope = "", ...)`. The `namespace` arg to `factsDbPath`/`ensureFactsDir` is SEPARATE from `scope`: namespace picks the DB FILE location, scope is the in-DB partition column. For the default team pass `namespace = team.memoryNamespace || undefined` (→ bare dir) and `scope = ""`.

---

## 6. Testing Patterns

### Unit Test Pattern — in-memory FactStore (reconcile/retrieve)
**Source:** `src/orchestrator/memory/reconcile.test.ts:1-78`
```typescript
import { describe, it, expect, afterEach } from "vitest";
import { FactStore, factId } from "../../state/facts.js";
import { writeFact } from "./reconcile.js";

describe("...", () => {
  let store: FactStore;
  afterEach(() => { store?.close(); });

  it("changed value supersedes → 'update'", async () => {
    store = new FactStore(":memory:");
    const t1 = "2026-06-15T00:00:00.000Z";
    await writeFact(store, makeInput({ value: "metformin", tValid: t1, tCreated: t1 }), { now: t1 });
    const a2 = await writeFact(store, makeInput({ value: "ozempic", tValid: t2, tCreated: t2 }), { now: t2 });
    expect(a2).toBe("update");
    const active = store.getActiveFacts("programming", "patient", "medication");
    expect(active).toHaveLength(1);
    expect(active[0].value).toBe("ozempic");
  });
});
```
**Runner:** vitest. **Assertion:** `expect`. **Mock:** none needed — use `new FactStore(":memory:")`. **Naming:** co-located `*.test.ts`. **Setup/teardown:** `let store; afterEach(() => store?.close());`.

### Unit Test Pattern — fixture project with tmpdir (for the detector + IO seed, if needed)
**Source:** `src/orchestrator/memory/retrieve.test.ts:1-22`
```typescript
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-fact-detector-test-"));
  await mkdir(join(tmpDir, ".bober"), { recursive: true });
});
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
```
For the PURE detector test you do NOT need tmpdir — pass a `packageJson` literal directly to `detectProjectFacts(...)` and assert the returned drafts. Only use tmpdir if you test the IO seed end-to-end (write a real `package.json`, run seed, assert `getActiveFacts` has `project/testCommand`).

### Pure-fn test with injected NOW (no clock)
**Source:** `src/orchestrator/memory/hygiene.test.ts:16-38` — fixed `const NOW = "2026-01-01T00:00:00.000Z"`, injected, never read inside. Apply the same for any timestamp in detector-IO tests.

### sc-5-3 double-reconcile idempotency test (REUSE Sprint 2 shape)
```typescript
it("running the detector twice produces no duplicates (NOOP on unchanged)", async () => {
  const store = new FactStore(":memory:");
  const now = "2026-06-15T00:00:00.000Z";
  const drafts = detectProjectFacts({ packageJson: { scripts: { test: "vitest", build: "tsc" } } });
  for (const d of drafts) await writeFact(store, { ...d, tValid: now, tCreated: now }, { now });
  for (const d of drafts) {
    const action = await writeFact(store, { ...d, tValid: now, tCreated: now }, { now });
    expect(action).toBe("noop");           // unchanged → NOOP
  }
  expect(store.getActiveFacts("", "project", "testCommand")).toHaveLength(1); // one active per predicate
  store.close();
});
```

### sc-5-5 scope-isolation test (facts in A never surface for B)
```typescript
it("scope A facts never surface for scope B", async () => {
  const store = new FactStore(":memory:");
  const now = "2026-06-15T00:00:00.000Z";
  await writeFact(store, { scope: "A", subject: "project", predicate: "testCommand", value: "vitest", confidence: 1, sourceRunId: null, tValid: now, tCreated: now }, { now });
  expect(store.getActiveFacts("B")).toEqual([]);          // store-level isolation
  // and via retrieveRelevantFacts(projectRoot, "B", ["vitest"]) on a file-backed tmpdir store → []
});
```

**No E2E/Playwright** in this repo for this path (`fact-*` are CLI/lib). evaluatorNotes sc-5-4 explicitly accepts code inspection + a focused integration test in lieu of a full `bober run`.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/commands/run.ts` | `runPipeline` (pipeline.ts:1017) | low | Only the BODY of runPipeline changes (additive, guarded); signature frozen. run.ts unaffected. |
| `src/chat/*` callers of `ChatSession.start()` | chat-session.ts:489 | low | Additive block after banner; existing turn loop untouched. Verify chat still prints `> ` and accepts input. |
| any importer of `src/state/facts.ts` | unchanged | none | facts.ts is NOT modified. |
| any importer of `src/orchestrator/memory/retrieve.ts` | unchanged | none | retrieve.ts is NOT modified; fact-retrieve.ts is a new sibling. |

### Existing Tests That Must Still Pass
- `src/orchestrator/memory/reconcile.test.ts` — tests writeFact NOOP/ADD/UPDATE; your detector reuses writeFact, do not change its behavior.
- `src/orchestrator/memory/retrieve.test.ts` — tests lessons ranking/serializer; you COPY (not modify) its patterns, so it stays green.
- `src/chat/chat-session.test.ts` (if present) — constructs ChatSession with injected deps; verify your `start()` insertion doesn't run a failing seed in the test path. Guard with try/catch so a missing package.json in a tmp test root is swallowed.
- Any `pipeline.*.test.ts` — verify the additive runPipeline block (wrapped in try/catch) doesn't throw in test configs (e.g. when `.bober/memory/` can't be created — the catch must swallow it).

### Features That Could Be Affected
- **Memory distill / lessons (`buildMemoryDistill` chat-session.ts:64, `distill.ts`)** — shares `.bober/memory/` dir. Facts live in `facts.db` (separate file via `factsDbPath`), lessons in `INDEX.md`. No collision. Verify `ensureFactsDir` reuses `memoryDir` so namespaced teams keep facts under their subdir.
- **Planner context (`gatherProjectContext` planner-agent.ts:90-131)** — your facts block is appended to `userMessage` (planner-agent.ts:199-209). Verify the spec JSON output contract is unchanged (the block is just extra context text, not a schema change).

### Recommended Regression Checks (concrete, runnable)
1. `npm run build` → exit 0 (sc-5-1)
2. `npm run typecheck` → zero errors (sc-5-1)
3. `npm test -- fact-detector fact-retrieve` → new tests green (sc-5-3, sc-5-5)
4. `npm test -- reconcile retrieve` → prior memory tests still green
5. `npm run lint` → zero errors on new + modified files (sc-5-6)
6. Best-effort: in a temp project run `bober facts list --scope ""` after a run/chat startup and confirm `project/testCommand` + `project/buildCommand` are active (evaluatorNotes best-effort).

---

## 8. Implementation Sequence (dependency-ordered)

1. **`src/orchestrator/memory/fact-detector.ts`** — PURE `detectProjectFacts({packageJson, boberConfig, lockfiles}, scope="")` → `FactDraft[]`. Also add the thin IO seed (`seedProjectFacts(projectRoot, namespace?)`) here or in a `fact-seed.ts`: read package.json + bober.config.json, detect lockfiles (fs.access), call detector, ensureFactsDir → new FactStore → for each draft `writeFact(store, {...draft, tValid: now, tCreated: now}, { now })` → finally close.
   - Verify: pure fn has NO `readFile`/`fs`/`createClient`/`Date` inside (sc-5-2). `import` graph of the pure fn touches only `../../state/facts.js` types.
2. **`src/orchestrator/memory/fact-detector.test.ts`** — fixture package.json literal → assert drafts; double-`writeFact` → NOOP + one active per predicate (sc-5-3); changed script → supersede.
   - Verify: `npm test -- fact-detector` green.
3. **`src/orchestrator/memory/fact-retrieve.ts`** — `retrieveRelevantFacts` (single store read + rank) + `serializeFactsForContext` (header + per-line + hard slice). COPY tokenize from retrieve.ts:30-35.
   - Verify: `serializeFactsForContext(recs, {charBudget: 50}).length <= 50`; empty records → `""`.
4. **`src/orchestrator/memory/fact-retrieve.test.ts`** — in-memory store ranking + scope isolation (A written, `retrieveRelevantFacts(..., "B", ...)` → `[]`) + charBudget cap (sc-5-5).
   - Verify: `npm test -- fact-retrieve` green.
5. **`src/orchestrator/pipeline.ts`** — insert guarded `seedProjectFacts` call inside `runPipeline` body (after `loadTeam`, before engine `.run()`), wrapped in try/catch with `logger.warn` on failure (sc-5-4).
   - Verify: `npm run build`; a thrown seed error is swallowed (run continues).
6. **`src/chat/chat-session.ts`** — insert guarded `seedProjectFacts(this.projectRoot, this.memoryNamespace)` in `start()` after the banner write (line 498), same try/catch (sc-5-4).
   - Verify: `npm run build`; chat tests green.
7. **Context injection** — in `planner-agent.ts` `runPlanner` (around line 199-209), retrieve facts for `scope=""` using keywords from `userPrompt` (`retrieveRelevantFacts(projectRoot, "", tokenize(userPrompt))`) and append `serializeFactsForContext(facts)` into `userMessage` ALONGSIDE the `# Project Context` block. Optionally do the same in the curator path if it assembles its own context. Guard with try/catch so retrieval failure never blocks planning.
   - Verify: planner still emits valid PlanSpec JSON; facts block appears in `userMessage`.
8. **Run full verification** — `npm run build`, `npm run typecheck`, `npm test -- fact-detector fact-retrieve reconcile retrieve`, `npm run lint`.

---

## 9. Pitfalls & Warnings

- **`scope` vs `namespace` are different axes.** `namespace` (→ `factsDbPath`/`ensureFactsDir`) selects the DB FILE location; `scope` is the in-DB column queried by `getActiveFacts(scope)`. For the default team: `namespace = team.memoryNamespace || undefined` (→ `.bober/memory/facts.db`), `scope = ""`. Write and read with the SAME scope string or retrieval returns nothing.
- **Detector MUST be pure (sc-5-2).** No `readFile`, no `fs`, no `createClient`, no `Date.now()`/`new Date()` inside `detectProjectFacts`. The evaluator reads the file to confirm. All IO and the `now` stamp live in the thin caller.
- **Facts failure must NEVER abort a run (sc-5-4).** Both wiring sites wrap the ENTIRE detect+open+write+close block in try/catch. In pipeline.ts use `logger.warn`; in chat-session keep it silent or `process.stderr`. Do not `throw` out of the guard. The evaluator traces that the run continues after a thrown facts error.
- **`charBudget` is a HARD cap (sc-5-5).** End `serializeFactsForContext` with `.slice(0, charBudget)`. Output length MUST be ≤ budget even mid-line. Do not "round up to a line boundary".
- **Use `writeFact`, never `insertFact`, for detector writes.** `insertFact` bypasses reconciliation → duplicate/zombie rows and breaks sc-5-3's NOOP-on-unchanged assertion.
- **`runPipeline` signature is frozen** (comment pipeline.ts:1011). Change only the body. Do NOT add params or change the return type.
- **ChatSession has no `config` field.** Don't assume `this.config` — it doesn't exist (constructor chat-session.ts:106-129). Read manifests from `this.projectRoot` directly or call `loadConfig(this.projectRoot)` inside the guarded seed.
- **Missing scripts / absent lockfile are the NORMAL case, not an error.** Omit the corresponding draft; return whatever subset is detectable (possibly `[]`). Never throw from the pure detector on missing fields.
- **The "lessons block" you inject next to is NOT yet wired into the planner.** `serializeLessonsForPlanner` is currently unused outside its test. Inject the facts block into the planner `userMessage` (planner-agent.ts:199-209) next to `# Project Context` — that is the live context-assembly site. Do not search for a non-existent lessons-block call site and stall.
- **`getActiveFacts` already enforces scope isolation** via SQL `WHERE scope = ?` (facts.ts:241-247). You get sc-5-5 isolation for free as long as you never query across scopes in a single call.
- **better-sqlite3 is synchronous; `FactStore` ops are sync.** Only `ensureFactsDir`/`writeFact` are async. Don't `await` `store.getActiveFacts(...)` — it returns directly.
- **Keep `.bober/memory/facts.db` out of context budgets** — never read the DB into the planner prompt; only the bounded serialized block (≤ charBudget) goes in.
