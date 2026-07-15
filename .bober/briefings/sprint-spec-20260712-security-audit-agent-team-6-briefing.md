# Sprint Briefing: Emit security audit findings into the priority hub

**Contract:** sprint-spec-20260712-security-audit-agent-team-6
**Generated:** 2026-07-12T00:00:00.000Z

---

## 0. TL;DR — what to build

Create **`src/orchestrator/security-hub.ts`** with two exports:
- `mapAuditToFindings(result: SecurityAuditResult, now: string): Finding[]` — **PURE**. Maps each `result.review.critical[]` (→ hub severity **5**) and `result.review.important[]` (→ hub severity **3**) SecurityFinding into a canonical hub `Finding` (imported from `src/hub/finding.ts`, NEVER redefined). Clean audit (no critical/important) → `[]`.
- `emitSecurityFindings(result, sink, logger, now): Promise<void>` — try/catch, logs failures, **never throws, never alters the verdict**.

Wire emission from the **two callers** (gate + standalone CLI) — NOT inside the `runSecurityAudit` core, so it stays outside the gate's `Promise.race` time-box (protects timing per nonGoals[3]). Each caller binds a sink to the real `ingestFinding(store, f, { now })` (research-runner precedent) and only calls it when `config.security?.hub !== false`.

**The single biggest correctness trap:** `FindingSchema.evidence` is `z.array(z.string())` (finding.ts:17) — an array of **strings**, NOT the `{path,line,snippet}` objects a `ReviewFinding` carries. You MUST flatten. And there is **no `body` field** in FindingSchema — the "description" goes into `evidence[]`, and the `title` must stay **stable** (vulnClass + path:line only) so the derived id is retry-stable and dedup works.

---

## 1. Target Files

### src/orchestrator/security-hub.ts (create)

**Directory pattern:** peer modules in `src/orchestrator/` use kebab-case filenames, box-drawing `// ── Section ──` headers, named exports, `import type` for types (principles L35). Closest siblings to mirror: `security-audit-types.ts` (pure wrapper module) and `security-gate.ts` (pure helper + typed exports).
**Most similar existing file for the map+emit shape:** `src/research/runner.ts` — it imports `type { Finding }` from `../hub/finding.js` (runner.ts:26), defines an injected `FindingSink` type (runner.ts:44), builds a Finding with a locally-replicated sha256 id helper (runner.ts:104-109), and emits via the injected sink exactly once (runner.ts:200).

**Structure template (based on runner.ts + finding-store.ts):**
```typescript
import { createHash } from "node:crypto";
import type { Finding } from "../hub/finding.js";
import type { SecurityAuditResult } from "./security-audit-types.js";
import type { SecurityFinding } from "./security-audit-types.js";
import type { Logger } from "../utils/logger.js"; // confirm exported type name; else use typeof logger

// Hub Finding emitter — mirrors research runner's FindingSink (runner.ts:44).
export type SecurityFindingSink = (finding: Finding) => Promise<void>;

// Local sha256 id helper — finding-store.ts:121 deriveFindingId is NOT exported,
// so replicate the 4-line hash (research/runner.ts:104 does the same). This is
// an id hash, NOT a Finding-shape redefinition (keeps sc-6-4 grep clean).
function deriveFindingId(domain: string, title: string, kind: string): string {
  return createHash("sha256").update(`${domain}|${title}|${kind}`).digest("hex").slice(0, 16);
}

export function mapAuditToFindings(result: SecurityAuditResult, now: string): Finding[] {
  // one Finding per critical (severity 5) + important (severity 3); minor/approved ignored
}

export async function emitSecurityFindings(
  result: SecurityAuditResult,
  sink: SecurityFindingSink,
  logger: /* logger type */,
  now: string,
): Promise<void> {
  try {
    for (const f of mapAuditToFindings(result, now)) await sink(f);
  } catch (err) {
    logger.warn(`Security hub emission failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

**Severity mapping (must be documented in code — sc-6-1). REAL enum values read from finding.ts:16 (`severity: z.number().int().min(1).max(5)`):**
| Audit bucket | Hub `severity` | Hub `urgency` | Rationale |
|--------------|----------------|----------------|-----------|
| `review.critical[]` | **5** (highest applicable) | 5 | blocking vuln |
| `review.important[]` | **3** (mid) | 3 | non-blocking |
| `review.minor[]` / approved | (not emitted) | — | nonGoals[2] |

**Per-finding Finding fields (all validate against FindingSchema, finding.ts:10-25):**
- `domain: "security"` — `domain` is a **free `z.string().min(1)`** (finding.ts:12), NOT a closed enum, so `"security"` is valid (resolves contract assumption 3 — no closest-fit compromise needed).
- `kind: "risk"` — `kind` IS a closed enum `["action","watch","risk","question"]` (finding.ts:14); a vulnerability is a "risk". (`"action"` defensible; pick one and document.)
- `title:` STABLE key — e.g. `` `[security] ${f.vulnClass ?? "vulnerability"} at ${path}:${line}` ``. Carries vulnClass + path:line. Must NOT include the free-text description (see Pitfalls — title stability drives the dedup id).
- `id: deriveFindingId("security", title, "risk")` — required by FindingSchema (`id: z.string().min(1)`, finding.ts:11). Stable id = retry-idempotent dedup.
- `severity` / `urgency:` per table above (both `z.number().int().min(1).max(5)`).
- `evidence:` **string[]** — flatten `f.evidence` (`{path,line,snippet}[]`) → e.g. `` `${e.path}:${e.line} — ${e.snippet}` ``, and push `f.description` (the "body"). FindingSchema.evidence is `z.array(z.string())` (finding.ts:17).
- `surfacedAt: now` — `z.string().datetime()` (finding.ts:18); requires the injected `now` param (why the mapper needs `now` — the generatorNote signature omits it).
- `tags: ["security", ...(f.vulnClass ? [\`vuln:${f.vulnClass}\`] : []), \`stack:${result.stack}\`]` — `z.array(z.string())` (finding.ts:20).
- `status: "open"` — enum `["open","in-progress","snoozed","done","dropped"]` (finding.ts:23).

---

### src/orchestrator/security-hub.test.ts (create)

**Most similar test files:** `src/research/runner.test.ts` (temp-dir + recording sink), `src/hub/finding-store.test.ts` (real FactStore + dedup assertion), `src/orchestrator/security-gate.test.ts` (SecurityAuditResult fixtures + vi spies). See section 6.

---

### src/orchestrator/security-gate.ts (modify)

**Relevant section — insert emission after the parse-failure check, BEFORE the persistence/verdict return (lines 104-123):**
```typescript
// gate today: parse-failure elevation, then best-effort save, then verdict return
  if (result.parsed === false) {
    return { blocked: true, reason: "audit-error", result };   // line 104-106 — emit nothing (empty review)
  }

  // >>> INSERT: hub emission here — result.parsed === true, verdict already computed
  // inside runSecurityAudit (result.verdict). This is AFTER verdict, OUTSIDE the
  // Promise.race (line 86-91), so ingest never affects timing/verdict (nonGoals[3]).
  // Guard on config.security.hub (default true). Emit BOTH the blocked-critical and
  // clean-with-important cases (both carry findings to surface).

  try {                                                        // existing best-effort save (line 112-118)
    await saveSecurityAudit(projectRoot, contract.contractId, result);
  } catch (err) { logger.warn(...); }

  return result.verdict === "blocked"                          // line 120-122
    ? { blocked: true, reason: "critical-finding", result }
    : { blocked: false, reason: "clean", result };
```
**Wiring approach (additive, keeps pipeline.ts byte-identical — pipeline.ts is NOT in scope):**
- Add optional `findingSink?: SecurityFindingSink` to `SecurityGateInput` (security-gate.ts:26-31). When absent, bind the default real sink inside the gate: `ensureFactsDir` + `new FactStore(factsDbPath(projectRoot))` → `sink = (f) => ingestFinding(store, f, { now })`, then `close()` in a `finally` AFTER emit resolves.
- Stamp `now` at the gate's emission point (`new Date().toISOString()`) — pipeline.ts is out of scope and already stamps `new Date()` for history events (pipeline.ts:481,525); this is a genuine side-effecting boundary.
- Guard: only emit when `config.security?.hub !== false`.

**Imports this file uses (security-gate.ts:16-22):** `type BoberConfig`, `type SprintContract`, `type EvaluationRunResult`, `type { SecurityAuditResult, SecurityFinding }` from `./security-audit-types.js`, `runSecurityAudit`, `saveSecurityAudit`, `logger`.
**New imports needed:** `mapAuditToFindings/emitSecurityFindings/type SecurityFindingSink` from `./security-hub.js`; `ingestFinding` from `../hub/finding-store.js`; `FactStore, factsDbPath, ensureFactsDir` from `../state/facts.js`; `type Finding` from `../hub/finding.js`.
**Imported by:** `src/orchestrator/pipeline.ts:37` (`evaluateSecurityGate`, `renderSecurityFeedback`), `src/orchestrator/security-gate.test.ts`.
**Test file:** `src/orchestrator/security-gate.test.ts` (exists).

---

### src/cli/commands/security-audit.ts (modify)

**Relevant section — `runStandaloneSecurityAudit` (lines 132-165); insert emission after `result.parsed` confirmed:**
```typescript
export async function runStandaloneSecurityAudit(deps: StandaloneAuditDeps): Promise<StandaloneAuditOutcome> {
  const runAudit = deps.runAudit ?? runSecurityAudit;
  const security = deps.config.security ?? SecuritySectionSchema.parse({});  // hub defaults to TRUE here (schema.ts:227)
  ...
  try { result = await runAudit(descriptor, null, deps.projectRoot, runConfig); }
  catch (err) { ...; return { exitCode: 2 }; }        // line 141-150 — no emit (audit threw)

  if (!result.parsed) { ...; return { result, exitCode: 2 }; }   // line 152-160 — no emit (empty review)

  // >>> INSERT: emit here — result.parsed === true, deps.now already stamped at .action() boundary.
  // Guard on security.hub !== false. Fire-and-forget with caught errors — must NOT change exitCode.
  const blocked = thresholdVerdict(result.review, security.standaloneBlockOn);   // line 162
  ...
}
```
**Wiring approach:** Add optional `findingSink?: SecurityFindingSink` to `StandaloneAuditDeps` (line 104-112) — mirrors `ResearchRunOverrides.findingSink` (research.ts:69). Default binds `ingestFinding` to a real `FactStore(factsDbPath(projectRoot))` (open, emit, close in finally). `deps.now` is already the injected clock (line 108, stamped at .action() boundary line 228).
**Imports this file uses (lines 28-38):** `chalk`, `type Command`, `findProjectRoot`, `loadConfig`, `SecuritySectionSchema`, `type BoberConfig`, `type SprintContract`, `type ReviewResult`, `type SecurityAuditResult`, `runSecurityAudit`.
**New imports needed:** same hub/facts imports as the gate + `security-hub.js`.
**Imported by:** `src/cli/index.ts` (via `registerSecurityAuditCommand`), `src/cli/commands/security-audit.test.ts`.
**Test file:** `src/cli/commands/security-audit.test.ts` (exists).

---

### src/orchestrator/security-auditor-agent.ts (modify — LIKELY UNNEEDED)

Under the recommended two-caller design, `runSecurityAudit` (lines 48-168) needs **no change** — its signature `(contract, evaluation, projectRoot, config, priors=[])` stays intact and its `Promise.race` (in the gate) stays free of ingest. This file is in `estimatedFiles` but the generatorNote says "anchors may have drifted." Only touch it if you co-locate the helper here instead of a new `security-hub.ts` (note 2's "or a section ... if tiny") — **not recommended**; a dedicated module is cleaner and matches the runner.ts precedent. If left untouched, note it in the sprint handoff. Do NOT import `finding-store` deep into this core (generatorNote 1).

---

## 2. Patterns to Follow

### Injected FindingSink + local sha256 id (research-runner precedent)
**Source:** `src/research/runner.ts`, lines 43-44, 103-137, 200
```typescript
/** Hub Finding emitter — called exactly once after the note is written. */
export type FindingSink = (finding: Finding) => Promise<void>;
...
function deriveFindingId(domain: string, title: string, kind: string): string {
  return createHash("sha256").update(`${domain}|${title}|${kind}`).digest("hex").slice(0, 16);
}
...
  return { id, domain, title, kind, urgency: 2, severity: 2, evidence, surfacedAt: now,
           tags: ["research", ...], status: "open" };
...
  await findingSink(finding);
```
**Rule:** Take the sink as an injected dependency; the mapper is pure and stamps `surfacedAt` from injected `now` (never `new Date()` inside the module). Replicate the tiny id hash locally — do not import a private helper.

### CLI binds ingestFinding at the boundary (open → emit → close)
**Source:** `src/cli/commands/research.ts`, lines 244-259
```typescript
let store: FactStore | null = null;
const fs: FindingSink =
  overrides?.findingSink ??
  (async (finding) => {
    if (store === null) throw new Error("FactStore was closed before findingSink was called");
    await ingestFinding(store, finding, { now });
  });
if (overrides?.findingSink === undefined) {
  await ensureFactsDir(projectRoot);
  store = new FactStore(factsDbPath(projectRoot));
}
```
**Rule:** Default to the real `ingestFinding` bound to a file-backed `FactStore`; let tests inject a spy `findingSink`. Close the store in a `finally` AFTER emission resolves — never before (the guard above catches the ordering bug).

### ingestFinding does validation + id/surfacedAt fill + dedup
**Source:** `src/hub/finding-store.ts`, lines 140-153
```typescript
export async function ingestFinding(store, input, { now }): Promise<ReconcileAction> {
  const parsed = IngestInputSchema.parse(input);           // validate BEFORE any write (throws on bad shape)
  const id = parsed.id ?? deriveFindingId(parsed.domain, parsed.title, parsed.kind);
  const finding = FindingSchema.parse({ ...parsed, id, surfacedAt: parsed.surfacedAt ?? now });
  return writeFinding(store, finding, { now });            // reuse — reconcile dedups
}
```
**Rule:** Use `ingestFinding` as the sink target — it is the canonical ingest path. It re-derives id and re-validates, so your mapper's id/surfacedAt are belt-and-suspenders (still supply them so the mapper output validates against FindingSchema for sc-6-1).

### Content-hash dedup → single active row (why stable titles matter)
**Source:** `src/orchestrator/memory/reconcile.ts`, lines 63-77; id keys at `src/state/facts.ts:58-69`; behavior proven at `src/hub/finding-store.test.ts:93-110`
```typescript
// reconcileFact: match on (scope, subject, predicate) among ACTIVE rows
  const same = exactMatches.find((r) => r.value === incoming.value);
  if (same !== undefined) return "noop";        // identical value → NOOP (same `now`)
  // different value (e.g. different surfacedAt) → supersede old + insert new = still ONE active row
```
**Rule:** Dedup keys on `subject = finding.id` (= sha256 of `domain|title|kind`). Emitting the same vuln twice → exactly one **active** row (NOOP if `now` identical, UPDATE/supersede if not). So the **title must be stable** (vulnClass + path:line, no varying description) or a second emission creates a second id → a duplicate. `readFindings`/`getActiveFacts` return active-only, so sc-6-3 counts stay at 1.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `ingestFinding` | `src/hub/finding-store.ts:140` | `(store: FactStore, input: unknown, {now}) => Promise<ReconcileAction>` | Canonical hub ingest — validate + fill id/surfacedAt + dedup. Bind the sink to this. |
| `writeFinding` | `src/hub/finding-store.ts:17` | `(store, finding: Finding, {now}) => Promise<ReconcileAction>` | Lower-level persist (ingestFinding wraps it). Prefer ingestFinding. |
| `readFindings` | `src/hub/finding-store.ts:45` | `(store: FactStore) => Finding[]` | Read active hub Findings — use for the sc-6-3 dedup count assertion. |
| `FindingSchema` / `Finding` | `src/hub/finding.ts:10,27` | Zod schema + `z.infer` type | THE canonical shape. Import; NEVER redefine (sc-6-4). Use `FindingSchema.parse` in tests. |
| `HUB_SCOPE` | `src/hub/finding-source.ts:8` | `const = "hub"` | FactStore scope hub findings live under (for direct `getActiveFacts` queries in tests). |
| `FactStore` | `src/state/facts.ts:136` | `new FactStore(dbPath, opts?)` | SQLite-backed fact store. `":memory:"` or a temp file path. |
| `factsDbPath` | `src/state/facts.ts:77` | `(projectRoot, namespace?) => string` | Resolve `<memoryDir>/facts.db`. Use for the real default sink. |
| `ensureFactsDir` | `src/state/facts.ts:86` | `(projectRoot, namespace?) => Promise<void>` | Create the dir before a file-backed FactStore (research.ts:257). |
| `deriveVerdict` | `src/orchestrator/security-audit-types.ts:52` | `(review: ReviewResult) => "pass"\|"blocked"` | Already computed into `result.verdict`; don't re-derive. |
| `logger` | `src/utils/logger.ts` | `logger.warn/info/debug` | Log emission failures (gate uses `logger.warn`, security-gate.ts:94). |

**Utilities reviewed: `src/utils/`, `src/hub/`, `src/state/`, `src/orchestrator/` — the above are the applicable ones. Do NOT build a new hash, store-opener, or Finding shape.**

---

## 4. Prior Sprint Output

### Sprint 1: config + types + state
**Created:** `SecuritySectionSchema` (`src/config/schema.ts:210-228`) — carries **`hub: z.boolean().default(true)`** (schema.ts:227), the boolean THIS sprint consumes; `src/orchestrator/security-audit-types.ts` (`SecurityAuditResult`, `SecurityFinding`, `VulnClass`, `deriveVerdict`); `src/state/security-audit-state.ts` (`saveSecurityAudit`).
**Connection:** Read `config.security?.hub !== false` to gate emission. `SecurityAuditResult.review.critical[]/important[]` are the source arrays; entries are `SecurityFinding` (= `ReviewFinding` + optional `vulnClass`).

### Sprint 2: runSecurityAudit core
**Created:** `runSecurityAudit(contract, evaluation|null, projectRoot, config, priors=[])` (`src/orchestrator/security-auditor-agent.ts:48`) — findings land in `result.review.critical[]`/`important[]`; `result.parsed` false ⇒ empty review (emit nothing). `verdict` already derived (line 146).
**Connection:** Emission consumes `result` AFTER `runSecurityAudit` returns (verdict already computed at line 146). `ReviewFinding` shape = `{ description, evidence: {path,line,snippet}[], antiPattern?, source? }` (`code-reviewer-agent.ts:17-22`).

### Sprint 3: security-gate.ts (this sprint modifies it)
**Created:** `evaluateSecurityGate` (security-gate.ts:72) — `Promise.race` time-box (lines 86-91), parse-failure elevation (line 104), best-effort save (line 112). Emission inserts after line 106, before line 120 — **outside the race**.

### Sprint 4: standalone CLI (this sprint modifies it)
**Created:** `runStandaloneSecurityAudit(deps)` (security-audit.ts:132) with DI `StandaloneAuditDeps` (line 104) and injected `now` (line 108). `config.security` may be absent → synthesized via `SecuritySectionSchema.parse({})` (line 136) ⇒ `hub` defaults **true**.

### Sprint 5: scanner pre-filter
**Created:** `security-scanners.ts` — folds priors into the audit; no direct interaction with hub emission. Suite at 4019 going in.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere:** all imports use `.js` extensions (L27). `import type` for types — `consistent-type-imports` enforced (L35).
- **Zod for validation** (L29); **filesystem state only**, no DB globals (L31). (FactStore IS SQLite but is the sanctioned hub store — consume, don't add a new store.)
- **Section comments:** `// ── Section ──` box headers (L32).
- **Tests collocated** `*.test.ts` next to source; **run against real fs via temp dirs, NO fs mocks** (L20, L44) — directly drives the sc-6-3 real-store-in-temp-dir test.
- **No `any`** without justification; use `unknown` + narrowing (L40).

### Architecture Decisions (`.bober/architecture/arch-20260712-security-audit-agent-team-architecture.md`)
- **Open Question — Important-bucket surfacing (line 363):** "wiring important findings into the priority hub as low-severity Findings is a follow-up that must respect the hub's canonical `FindingSchema`." THIS sprint is that follow-up — hence critical→5 AND important→3 both emit, and FindingSchema is imported not redefined.
- **Store failure must not change the verdict** (Risk table line 351; API contract line 262) — same fail-open-side-effect posture applies to hub emission.
- Additive / byte-identical-when-unconfigured is a HARD repo invariant (line 24) — `hub:false` (and disabled security) ⇒ zero hub writes.

### Other Docs
- `CLAUDE.md`/README: no additional hub-emission guidance beyond the above.

---

## 6. Testing Patterns

### Unit Test Pattern — recording sink + REAL schema validation
**Source:** `src/research/runner.test.ts:8-11,48-53,66-69` (temp dir + recording sink), `src/orchestrator/security-gate.test.ts:99-114` (SecurityAuditResult fixture)
```typescript
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FindingSchema } from "../hub/finding.js";
import type { Finding } from "../hub/finding.js";

// sc-6-1: validate EVERY mapped object with the REAL schema (evaluatorNotes)
it("maps critical→sev5 / important→sev3 and validates against FindingSchema", () => {
  const findings = mapAuditToFindings(RESULT_WITH_CRIT_AND_IMPORTANT, NOW);
  for (const f of findings) expect(() => FindingSchema.parse(f)).not.toThrow();
  expect(findings.find((f) => /* the critical one */).severity).toBe(5);
  expect(findings.find((f) => /* the important one */).severity).toBe(3);
});

// sc-6-2: recording sink + throwing sink
it("emit calls the sink per finding; a throwing sink is swallowed + logged", async () => {
  const calls: Finding[] = [];
  const warn = vi.spyOn(logger, "warn");
  await emitSecurityFindings(RESULT, async (f) => { calls.push(f); }, logger, NOW);
  expect(calls).toHaveLength(/* N */);
  await expect(emitSecurityFindings(RESULT, async () => { throw new Error("x"); }, logger, NOW))
    .resolves.toBeUndefined();      // never throws
  expect(warn).toHaveBeenCalled();
});

// sc-6-4: clean audit emits nothing
it("clean review emits zero findings", async () => {
  const calls: Finding[] = [];
  await emitSecurityFindings(CLEAN_RESULT, async (f) => { calls.push(f); }, logger, NOW);
  expect(calls).toHaveLength(0);
});
```

### Dedup test with the REAL finding-store in a temp dir (sc-6-3)
**Source:** `src/hub/finding-store.test.ts:93-110` (dedup → single active row), `src/research/runner.test.ts:48-53` (temp-dir lifecycle)
```typescript
import { FactStore, factsDbPath, ensureFactsDir } from "../state/facts.js";
import { ingestFinding, readFindings } from "../hub/finding-store.js";

let tmpRoot: string;
beforeEach(async () => { tmpRoot = await mkdtemp(join(tmpdir(), "bober-sec-hub-")); });
afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }); });

it("emitting the same audit result twice leaves one active row per finding", async () => {
  const store = new FactStore(join(tmpRoot, "facts.db"));   // real, file-backed
  const sink = async (f: Finding) => { await ingestFinding(store, f, { now: NOW }); };
  await emitSecurityFindings(RESULT_WITH_ONE_CRITICAL, sink, logger, NOW);
  const firstCount = readFindings(store).length;
  await emitSecurityFindings(RESULT_WITH_ONE_CRITICAL, sink, logger, NOW);   // second emission
  expect(readFindings(store).length).toBe(firstCount);       // dedup absorbed it
  store.close();
});
```
**Runner:** vitest. **Assertion style:** `expect`. **Mock approach:** `vi.fn`/`vi.spyOn` for the sink/logger; **real FactStore + real ingestFinding** for dedup (principles L44 — no fs mocks). **File naming:** `security-hub.test.ts` collocated. **Location:** co-located next to source.

**Caller-side gating tests (sc-6-2 "hub:false ⇒ zero writes"):** in `security-gate.test.ts` / `security-audit.test.ts`, pass a spy `findingSink` in the input/deps, run with `security.hub:false` (fixture already includes `hub: true` at security-gate.test.ts:87) → assert the spy has 0 calls; with `hub:true` → N calls; and verify the verdict/exitCode is identical either way.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/pipeline.ts` | `evaluateSecurityGate` (line 454), `SecurityGateInput` | **low** | Only if you add a NON-optional field to `SecurityGateInput`. Keep `findingSink?` optional ⇒ pipeline byte-identical (it passes no sink; gate binds default). |
| `src/cli/index.ts` | `registerSecurityAuditCommand` | **low** | `StandaloneAuditDeps.findingSink?` is optional; command registration unchanged. |
| `src/orchestrator/security-gate.test.ts` | `evaluateSecurityGate`, mocks `runSecurityAudit`+`saveSecurityAudit` | **medium** | Existing tests mock those two modules; hub emission will try to open a real FactStore unless the test injects `findingSink` or the hub path is guarded. Default the sink lazily so mocked tests without `hub` interaction don't touch fs, OR add `findingSink` to fixtures. |
| `src/cli/commands/security-audit.test.ts` | `runStandaloneSecurityAudit` | **medium** | Same — ensure existing DI tests don't open a real store; inject a no-op `findingSink` or verify the default only constructs the store when `hub !== false` AND no sink injected. |
| `src/hub/*` | — | **none** | MUST NOT modify (nonGoals). Consume only. |

### Existing Tests That Must Still Pass
- `src/orchestrator/security-gate.test.ts` — verdict/reason table + store-failure guard; verify verdict/reason **unchanged** with emission added and with `hub:false`.
- `src/cli/commands/security-audit.test.ts` — exit-code + fail-closed tests; verify exitCode unchanged with emission added.
- `src/orchestrator/security-auditor-agent.test.ts` — core unchanged (two-caller design) → must stay green untouched.
- `src/hub/finding-store.test.ts`, `src/hub/finding-source.test.ts` — hub unchanged; must stay green (sc-6-5 "existing hub tests unchanged").
- `src/research/runner.test.ts` — precedent, unrelated; ensure no accidental shared-module drift.

### Features That Could Be Affected
- **In-pipeline security gate** — shares `security-gate.ts`; verify the gate's verdict, `renderSecurityFeedback`, and history events (`security-audit-blocked/clean`) are untouched; emission is a pure side effect after the verdict.
- **Standalone `bober security-audit` CLI** — shares `security-audit.ts`; verify exit codes 0/2 and `standaloneBlockOn` threshold logic unchanged.
- **Priority hub / task-inbox** — shares the FactStore hub scope; new `domain:"security"` Findings appear alongside `medical`/`research`/`inbox` findings — confirm they don't break hub reads (FindingSchema-valid, so `FactStoreFindingSource.read()` accepts them, finding-source.ts:43).

### Recommended Regression Checks (all runnable)
1. `npm run build` — clean tsc output.
2. `npm run typecheck` — zero type errors.
3. `npx eslint src/orchestrator/security-hub.ts src/orchestrator/security-hub.test.ts src/orchestrator/security-gate.ts src/cli/commands/security-audit.ts` — zero errors (`consistent-type-imports`, no unused).
4. `npm test` — full suite green (≈4019+); hub + prior security tests unchanged.
5. `grep -n "z.object" src/orchestrator/security-hub.ts` — must return NOTHING (sc-6-4: no Finding-shape redefinition).
6. `grep -n "from \"../hub/finding" src/orchestrator/security-hub.ts` — imports point at `src/hub/` (sc-6-4).

---

## 8. Implementation Sequence

1. **`src/orchestrator/security-hub.ts`** — define `SecurityFindingSink` type + local `deriveFindingId` + pure `mapAuditToFindings(result, now)` (critical→sev5, important→sev3, flatten evidence to strings, stable title, domain "security", kind "risk") + `emitSecurityFindings(result, sink, logger, now)` (try/catch, logs, never throws).
   - Verify: `npm run typecheck`; `grep -n "z.object" security-hub.ts` returns nothing.
2. **`src/orchestrator/security-hub.test.ts`** — sc-6-1 (FindingSchema.parse each mapped object + severity assertions), sc-6-2 (recording sink N calls; throwing sink swallowed+logged; clean→0), sc-6-3 (REAL FactStore in temp dir, emit twice, `readFindings` count stable).
   - Verify: `npx vitest run src/orchestrator/security-hub.test.ts` green.
3. **`src/orchestrator/security-gate.ts`** — add optional `findingSink?` to `SecurityGateInput`; after the parse-failure check (line 106), guard `config.security?.hub !== false`, bind default sink (open FactStore) or use injected, `await emitSecurityFindings(...)`, close store in `finally`. Verdict/reason returns unchanged.
   - Verify: `npx vitest run src/orchestrator/security-gate.test.ts`; verdict/reason identical with `hub:true`/`hub:false`.
4. **`src/cli/commands/security-audit.ts`** — add optional `findingSink?` to `StandaloneAuditDeps`; after `result.parsed` confirmed (line 152), guard `security.hub !== false`, emit using `deps.now`, close store. exitCode unchanged.
   - Verify: `npx vitest run src/cli/commands/security-audit.test.ts`; exit codes unchanged.
5. **`src/orchestrator/security-auditor-agent.ts`** — expected NO change under the two-caller design; leave untouched (record in handoff). Only edit if co-locating the helper (not recommended).
   - Verify: `security-auditor-agent.test.ts` green untouched.
6. **Run full verification** — `npm run build`, `npm run typecheck`, `npx eslint ...`, `npm test` (full suite), plus the two sc-6-4 greps.

---

## 9. Pitfalls & Warnings

- **`FindingSchema.evidence` is `string[]`, not objects** (finding.ts:17). `ReviewFinding.evidence` is `{path,line,snippet}[]` (code-reviewer-agent.ts:19). You MUST flatten (e.g. `` `${e.path}:${e.line} — ${e.snippet}` ``) or `FindingSchema.parse` fails sc-6-1.
- **No `body` field in FindingSchema.** The "description" (sc-6-1 asks for it) has no dedicated field — put it in `evidence[]`; keep it OUT of the `title`.
- **Title MUST be stable** = vulnClass + path:line only. The id derives from `domain|title|kind`; a title that embeds the free-text description changes across retries → a new id → a duplicate hub entry (breaks sc-6-3). Assumption 2 in the contract spells this out.
- **`domain` is a free string, `kind` is a closed enum.** `domain:"security"` is fine (finding.ts:12). `kind` must be one of `action|watch|risk|question` (finding.ts:14) — use `"risk"`; do NOT invent `"security"` as a kind.
- **Never put ingest inside the gate's `Promise.race`** (security-gate.ts:86-91). Emit AFTER the verdict is in hand, outside the race, or a slow/hung ingest can manufacture a false `timeout` block (nonGoals[3], timing).
- **Do NOT import `finding-store` into the `runSecurityAudit` core** (generatorNote 1). Inject the sink at the gate/CLI boundary (research precedent).
- **Close the FactStore in a `finally` AFTER emit resolves** — never before awaiting (research.ts:250-251 guards the exact "closed before findingSink" bug).
- **`deriveFindingId` in finding-store.ts:121 is NOT exported.** Replicate the 4-line sha256 helper locally (research/runner.ts:104 sets the precedent). This is an id hash, not a schema redefinition — keeps the sc-6-4 grep clean.
- **`surfacedAt` needs the injected `now`.** The generatorNote's `mapAuditToFindings(result)` signature is incomplete — add `now: string` (FindingSchema requires a datetime `surfacedAt`; clock discipline forbids `new Date()` inside the pure mapper).
- **Do NOT emit `minor`/`approvedAreas` or unconfirmed scanner priors** (nonGoals[2]) — only `review.critical[]` + `review.important[]`.
- **Do NOT modify `src/hub/`** (nonGoals[1]) — import `FindingSchema`/`ingestFinding` only. sc-6-4 greps for redefinition and schema drift.
- **Existing gate/CLI tests mock `runSecurityAudit`/`saveSecurityAudit` but not the hub store** — guard the default real-store construction so those tests (which don't inject `findingSink` and may not set `hub`) don't accidentally hit the filesystem; the fixtures already carry `hub:true` (security-gate.test.ts:87), so construct the store lazily only when emitting AND no sink injected.
