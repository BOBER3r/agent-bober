# Sprint Briefing: Implement the scanner pre-filter with slither and semgrep parsers

**Contract:** sprint-spec-20260712-security-audit-agent-team-5
**Generated:** 2026-07-12T00:00:00Z

---

## 0. TL;DR — What this sprint does

Create `src/orchestrator/security-scanners.ts` exporting `runScannerPreFilter({scanners, projectRoot, signal})` + pure `parseSlitherOutput(json: unknown)` / `parseSemgrepOutput(json: unknown)` + a raw-text fallback. Commit realistic slither/semgrep JSON fixtures under `src/orchestrator/__fixtures__/`. Then wire the pre-filter **inside** `runSecurityAudit` (when `config.security.scanners` is non-empty) so its output becomes the `priors` that already feed the auditor prompt. **Do NOT change `runSecurityAudit`'s signature** (the CLI + gate depend on `typeof runSecurityAudit`).

Two hard invariants: (a) `scanners: []` → **zero child processes spawned**, byte-identical to sprint 2; (b) every scanner is isolated — missing binary/nonzero exit → `[]` for that scanner, other scanners still run; abort → SIGKILL child + partial results; the pre-filter **never rejects**.

---

## 1. Target Files

### src/orchestrator/security-scanners.ts (create)

**Directory pattern:** orchestrator modules are flat kebab-case files (`security-auditor-agent.ts`, `security-audit-types.ts`, `security-gate.ts`, `code-reviewer-agent.ts`, `model-resolver.ts`). Create a **new** flat file here.

**Most similar existing files to mirror:**
- Pure defensive parser + committed fixture: `src/medical/retrieval/medline-source.ts:60-104` (`parseMedline(raw: unknown): Passage[]`).
- execa child-process options style: `src/evaluators/builtin/command-runner.ts:53-59`.
- Injectable runner for CI-offline tests: `src/chat/run-spawner.ts:31-57` (`SpawnFn` / `KillFn` injected, default wraps execa).

**Structure template (based on those files + contract):**
```typescript
import { execa } from "execa";
import type { EvalStrategy } from "../config/schema.js";
import type { SecurityFinding, VulnClass } from "./security-audit-types.js";
import { logger } from "../utils/logger.js";

// ── Injectable runner (keeps tests off real binaries) ──────────────
export interface ScannerRunResult { exitCode: number | undefined; stdout: string; failed: boolean; }
export type ScannerRunner = (
  cmd: string, args: string[],
  opts: { cwd: string; signal: AbortSignal },
) => Promise<ScannerRunResult>;

// default runner wraps execa (reject:false + cancelSignal + SIGKILL + maxBuffer)

// ── Pure parsers (unknown → SecurityFinding[]; never throw) ─────────
export function parseSlitherOutput(json: unknown): SecurityFinding[] { /* defensive narrowing */ }
export function parseSemgrepOutput(json: unknown): SecurityFinding[] { /* defensive narrowing */ }
function rawTextFallback(name: string, output: string): SecurityFinding[] { /* truncate ~2000 chars */ }

// ── Parser selection by scanner name/command ───────────────────────
// slither → parseSlitherOutput, semgrep → parseSemgrepOutput, else → rawTextFallback

export interface ScannerPreFilterInput {
  scanners: EvalStrategy[];
  projectRoot: string;
  signal: AbortSignal;
  runner?: ScannerRunner; // default = execa wrapper; tests inject a fake
}
export async function runScannerPreFilter(input: ScannerPreFilterInput): Promise<SecurityFinding[]> {
  // per-scanner try/catch → [] on any failure; concat surviving findings; never reject
}
```

---

### src/orchestrator/__fixtures__/slither-sample.json + semgrep-sample.json (create)

**Convention (copy EXACTLY from medical):** `src/medical/retrieval/__fixtures__/medlineplus-sample.json` (1473 bytes, committed). Loaded in tests via `new URL("./__fixtures__/slither-sample.json", import.meta.url)` + `readFile` — see `src/medical/retrieval/medline-source.test.ts:16-20`:
```typescript
const fixtureUrl = new URL("./__fixtures__/medlineplus-sample.json", import.meta.url);
const raw = await readFile(fixtureUrl, "utf-8");
return JSON.parse(raw) as unknown;
```
(Alternative in-repo idiom: `src/fleet/runner.test.ts:10-11` uses `fileURLToPath(import.meta.url)` + `join(__dirname, "__fixtures__", ...)`.)

**Canonical tool output shapes** (contract assumptions[2] + `evaluatorNotes` require these look like REAL tool output — do NOT invent fields to match the parser):
- **slither `--json`**: top-level `{ success, error, results: { detectors: [...] } }`. Each detector: `{ check: "reentrancy-eth", impact: "High"|"Medium"|"Low"|"Informational", confidence, description, elements: [{ type, name, source_mapping: { filename_relative, filename_absolute, lines: [42, 43], starting_column } }] }`.
- **semgrep `--json`**: top-level `{ results: [...], errors: [], paths: {...} }`. Each result: `{ check_id: "...", path: "src/x.ts", start: { line: 12, col: 3 }, end: {...}, extra: { severity: "ERROR"|"WARNING"|"INFO", message: "...", lines: "..." } }`.
- **Severity → bucket mapping** (contract assumptions[2]): slither `High` impact and semgrep `ERROR` → treat as **critical** priors; lower → **important**. Since `SecurityFinding` has **no severity field** (see §3 warning), encode the bucket/severity in the `description` text and/or the `source` field (e.g. `source: "slither"`, `description: "[High] reentrancy-eth: ..."`). The LLM auditor uses these as advisory ground truth — it still produces the real `critical`/`important` buckets.

---

### src/orchestrator/security-auditor-agent.ts (modify)

**Relevant sections — the seam is already built; you wire the pre-filter into it.**

Signature — KEEP IT IDENTICAL (`priors` stays the optional last param), lines 44-50:
```typescript
export async function runSecurityAudit(
  contract: SprintContract,
  evaluation: EvaluationRunResult | null,
  projectRoot: string,
  config: BoberConfig,
  priors: SecurityFinding[] = [],   // ← DO NOT change/rename/remove: typeof runSecurityAudit is depended on
): Promise<SecurityAuditResult> {
```

The priors → prompt rendering already exists (lines 158-162 in `buildUserMessage`) — you do NOT touch it:
```typescript
const priorsSection =
  priors.length > 0
    ? `# Deterministic scanner findings (ground truth priors)\n\n${JSON.stringify(priors, null, 2)}\n\n`
    : "";
```

The `scannerRan` line to reconcile (line 114):
```typescript
scannerRan: priors.length > 0,   // sprint-2 formula
```

**What to add (per generatorNotes[4] + ADR-4):** after the existing setup, before `buildUserMessage` at line 77, compute effective priors:
```typescript
const configuredScanners = config.security?.scanners ?? [];
let effectivePriors = priors;
if (configuredScanners.length > 0) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.security?.timeoutMs ?? 300_000);
  try {
    const scannerPriors = await runScannerPreFilter({
      scanners: configuredScanners, projectRoot, signal: ac.signal,
    });
    effectivePriors = [...priors, ...scannerPriors];
  } finally {
    clearTimeout(timer);
  }
}
// then pass effectivePriors to buildUserMessage and use it for scannerRan
```
Set `scannerRan: configuredScanners.length > 0 || effectivePriors.length > 0` (see §3 + §9 for why — this preserves existing sprint-2 tests that pass `priors` directly).

**Imports this file uses (add one):** `import { runScannerPreFilter } from "./security-scanners.js";` Existing imports at lines 1-15 (note `import type { SecurityFinding, VulnClass }` from `./security-audit-types.js` at line 5 — already present).

**Imported by (impact — see §7):** `src/orchestrator/security-gate.ts:20`, `src/cli/commands/security-audit.ts:38` (both use `typeof runSecurityAudit`), `src/orchestrator/pipeline.test.ts:120` (mocks it), `src/orchestrator/security-gate.test.ts:27-31` (mocks it).

**Test file:** `src/orchestrator/security-auditor-agent.test.ts` (exists — 447 lines; you extend it, see §6).

---

### src/orchestrator/security-scanners.test.ts (create) & security-auditor-agent.test.ts (modify)

See §6 (Testing Patterns) for the exact vitest conventions and what each success criterion demands.

---

## 2. Patterns to Follow

### Pattern A — Pure `unknown → T[]` parser with defensive narrowing, never throws
**Source:** `src/medical/retrieval/medline-source.ts:60-104`
```typescript
function parseMedline(raw: unknown): Passage[] {
  if (!raw || typeof raw !== "object") return [];
  const result = raw as Record<string, unknown>;
  const nlmResult = result["nlmSearchResult"] as Record<string, unknown> | undefined;
  if (!nlmResult) return [];
  const documents = (nlmResult["list"] as Record<string, unknown> | undefined)?.["document"];
  if (!Array.isArray(documents)) return [];
  const passages: Passage[] = [];
  for (const doc of documents) {
    if (!doc || typeof doc !== "object") continue;
    /* narrow each field with typeof checks, push only when required fields present */
  }
  return passages;
}
```
**Rule:** Never trust fixture shape at runtime. Walk the object with `typeof x !== "object"` / `Array.isArray` guards at every level; any mismatch → `[]`. This is exactly how `parseSlitherOutput`/`parseSemgrepOutput` must behave (contract sc-5-1: truncated JSON and valid-JSON-wrong-shape both → `[]`).

### Pattern B — Per-item array narrowing already used for SecurityFinding
**Source:** `src/orchestrator/security-auditor-agent.ts:309-335` (`parseSecurityFindingArray` / `parseEvidenceArray`)
```typescript
return (raw as unknown[])
  .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
  .map((item): SecurityFinding => ({
    description: typeof item.description === "string" ? item.description : "Unknown finding",
    evidence: parseEvidenceArray(item.evidence),          // Array<{path, line, snippet}>
    ...(typeof item.source === "string" ? { source: item.source } : {}),
    ...(typeof item.vulnClass === "string" && isVulnClass(item.vulnClass) ? { vulnClass: item.vulnClass } : {}),
  }));
```
**Rule:** Build `SecurityFinding` objects with `description` + `evidence: [{path, line, snippet}]` (+ optional `source`, `vulnClass`). `path`/`line` live INSIDE `evidence`, NOT at top level (see §3).

### Pattern C — execa options style (reject:false, timeout, bounded output)
**Source:** `src/evaluators/builtin/command-runner.ts:48-62`
```typescript
const parts = this.command.split(/\s+/);
const cmd = parts[0]; const args = parts.slice(1);
const result = await execa(cmd, args, {
  cwd: projectRoot,
  timeout,
  reject: false,          // nonzero exit resolves (not throws) — matches sc-5-2
  all: true,
  env: { ...process.env, FORCE_COLOR: "0" },
});
const passed = result.exitCode === 0;
```
**Rule:** Use `reject: false` so a nonzero exit resolves normally; wrap in per-scanner try/catch anyway (ENOENT for a missing binary can still throw). Add `maxBuffer` (bound stdout, e.g. `1024 * 1024 * 10`) so a pathological scanner can't exhaust memory (contract assumptions[2]). Split a `command: string` (EvalStrategy carries `command`, not argv) on whitespace as shown.

### Pattern D — AbortSignal → SIGKILL child, then resolve
**Source:** `src/graph/mcp-client.ts:145-186` (SIGTERM → wait → SIGKILL fallback)
```typescript
const timeout = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* dead */ } resolve(); }, 2_000);
child.once("exit", () => { clearTimeout(timeout); resolve(); });
try { child.kill("SIGTERM"); } catch { clearTimeout(timeout); resolve(); }
```
**Rule (sc-5-3):** execa `^9.5.2` (`package.json:68`) supports the `cancelSignal` option + `forceKillAfterDelay` (per generatorNotes[2]) — pass `cancelSignal: signal` and force a SIGKILL (`killSignal: "SIGKILL"` or `forceKillAfterDelay: 0`). On abort, the child is killed and the scanner contributes `[]`; the pre-filter resolves with findings gathered before the abort. The generatorNotes[5] test uses a real `node -e "...sleep..."` command (node is always in CI) with a short signal fire — no scanner binary needed.

### Pattern E — Injectable runner keeps CI offline (no real binaries)
**Source:** `src/chat/run-spawner.ts:31-57, 74-82` — `SpawnFn`/`KillFn` injected, default wraps execa.
```typescript
export type SpawnFn = (file: string, args: string[], options: {...}) => {...};
this.spawnFn = opts.spawn ?? ((file, args, options) => execa(file, args, options) as unknown as {...});
```
**Rule:** Give `runScannerPreFilter` an optional injected `runner?: ScannerRunner` (default wraps execa). Tests inject a fake runner returning fixture stdout/exit codes → deterministic, zero real processes. This is the cleanest way to satisfy sc-5-2 (missing binary / nonzero exit) and sc-5-4 (assert **zero execa calls** with `scanners:[]`) without shelling out. Keep the real `node -e` route available for the sc-5-3 abort test per generatorNotes[5].

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `SecurityFinding` (type) | `src/orchestrator/security-audit-types.ts:23-25` | `interface SecurityFinding extends ReviewFinding { vulnClass?: VulnClass }` | The pre-filter's element type — REUSE, do not redefine |
| `ReviewFinding` (type) | `src/orchestrator/code-reviewer-agent.ts:17-22` | `{ description: string; evidence: Array<{path,line,snippet}>; antiPattern?; source? }` | Locked base shape — path/line live in `evidence`, NO top-level severity |
| `VulnClass` (type) | `src/orchestrator/security-audit-types.ts:9-15` | union of 6 classes | Optional finding tag |
| `ALL_VULN_CLASSES` / `isVulnClass` | `src/orchestrator/stack-knowledge.ts` (imported at `security-auditor-agent.ts:14`); guard at `security-auditor-agent.ts:305-307` | `(value: string): value is VulnClass` | Validate a vulnClass before attaching |
| `EvalStrategy` (type) | `src/config/schema.ts` (`EvalStrategySchema`) | `{ type: string; plugin?; command?; required: boolean; config?; label? }` | Each `scanners[]` entry — parser selection uses `type`/`command` |
| `deriveVerdict` | `src/orchestrator/security-audit-types.ts:52-54` | `(review: ReviewResult) => "pass"\|"blocked"` | Verdict derivation (not changed by this sprint) |
| `logger` | `src/utils/logger.ts` (imported at `security-auditor-agent.ts:15`) | `logger.info/debug/warn(...)` | Structured logging; log per-scanner failures at `debug`/`warn` |
| execa | dep `^9.5.2` (`package.json:68`) | `execa(cmd, args, opts)` | Child process — ALREADY a dep; do NOT add npm deps (nonGoals[2]) |

**CRITICAL SHAPE WARNING:** `SecurityFinding` (via `ReviewFinding`) has **`description` + `evidence: Array<{path, line, snippet}>` + optional `antiPattern`/`source`/`vulnClass`** — there is **NO top-level `path`, `line`, or `severity`**. Contract sc-5-1 phrases "path, line, severity bucket" loosely; the real target is `{ description, evidence: [{path, line, snippet}], vulnClass?, source? }`. Encode severity in `description`/`source` text (§1).

**Utilities reviewed:** `src/utils/` (git.ts, logger.ts, fs.ts), `src/medical/retrieval/`, `src/evaluators/builtin/`, `src/chat/`, `src/graph/` — no existing scanner-output parser exists; you are building the first. Reuse the execa+parser patterns above; do not add a new child-process helper.

---

## 4. Prior Sprint Output

### Sprint 1 (f76ee2e/fc20eae/4ae188f)
**Created:** `src/orchestrator/security-audit-types.ts` — exports `SecurityFinding`, `VulnClass`, `SecurityAuditResult`, `deriveVerdict`. `SecuritySectionSchema` in `src/config/schema.ts:210-228` (has `scanners: z.array(EvalStrategySchema).default([])` at line 223, `timeoutMs` default `300_000` at line 218).
**Connection:** Import `SecurityFinding`/`VulnClass` from here; read `config.security.scanners` (`EvalStrategy[]`) and `config.security.timeoutMs`.

### Sprint 2 (0990156/ddf27bc/e5cf267/40c1488) — THE seam this sprint fills
**Created:** `src/orchestrator/security-auditor-agent.ts` — `runSecurityAudit(contract, evaluation|null, projectRoot, config, priors?: SecurityFinding[] = [])`. The `priors` param renders a `# Deterministic scanner findings (ground truth priors)` prompt section (lines 158-162) when non-empty; `scannerRan: priors.length > 0` (line 114).
**Connection:** You supply `priors` from `runScannerPreFilter` internally. Existing tests at `security-auditor-agent.test.ts:304-326` already lock the priors-section + `scannerRan` behavior — they MUST keep passing (see §7/§9).

### Sprint 3 (e60422c)
**Created:** `src/orchestrator/security-gate.ts` — `evaluateSecurityGate` wraps `runSecurityAudit` in `Promise.race` against a `setTimeout(reject, timeoutMs)` (lines 86-96). It does **NOT** thread an AbortSignal into `runSecurityAudit` — so on timeout the audit keeps running in the background. That is exactly why the AbortController must live **inside** `runSecurityAudit` (generatorNotes[4]).
**Connection:** Gate is NOT modified (nonGoals[3]); it inherits priors transparently because you keep the signature stable.

### Sprint 4 (61e055a)
**Created:** `src/cli/commands/security-audit.ts` — injects `runAudit?: typeof runSecurityAudit` (lines 110-135). Depends on the exact `runSecurityAudit` type.
**Connection:** NOT modified (nonGoals[3]). Keeping the signature identical keeps `typeof runSecurityAudit` valid.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere** — all imports use `.js` extensions (NodeNext). New file imports `./security-scanners.js`, `../config/schema.js`, etc.
- **`import type` for types** — ESLint `consistent-type-imports` is enforced (e.g. `import type { EvalStrategy } from "../config/schema.js"`).
- **No `any`** — use `unknown` + narrowing (matches Pattern A). `no-explicit-any` is warned; aim zero.
- **Prefix unused params with `_`.** Tests create temp dirs / inject fakes; **no fs mocks** (line 44 of principles) — but child-process injection via an injected runner is the accepted pattern here (cf. run-spawner).
- **Section comments** — `// ── Name ──────` unicode box headers (see every file cited).
- **Vitest, tests collocated** `*.test.ts` next to source.

### Architecture (ADR-4, `arch-...-adr-4.md`)
> "When `config.security.scanners` is non-empty, `runSecurityAudit` runs the scanner commands inside the same `Promise.race` time-box, parses output into `SecurityFinding` priors, and **prepends them to the auditor prompt**; when empty, the audit is a **pure LLM pass**." Risk mitigation: "running the pre-filter under the shared audit `AbortSignal`/time-box."

`SecurityScannerPreFilter` interface (architecture §Component Breakdown, lines 196-211): `run({scanners, projectRoot, signal}) => Promise<SecurityFinding[]>`, "Never throws. Missing binary / nonzero exit → that scanner yields `[]`; AbortSignal fired → SIGKILL child, partial findings."

### Where the pre-filter hooks in — UNAMBIGUOUS
It lives in a **separate module** (`security-scanners.ts`) but is **invoked from INSIDE `runSecurityAudit`** (not the gate, not the CLI). ADR-4 consequence + generatorNotes[4] are explicit. The gate/CLI get priors transparently. Do not add scanner calls to `security-gate.ts` or `security-audit.ts`.

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/orchestrator/security-auditor-agent.test.ts:1-45` (mock convention) and `src/medical/retrieval/medline-source.test.ts:16-20` (fixture load).
```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
// module-mock heavy deps at top-level, then dynamic-import the SUT:
vi.mock("./agentic-loop.js", () => ({ runAgenticLoop: loopSpy }));
const { runSecurityAudit } = await import("./security-auditor-agent.js");
```
Fixture load (for the parser tests in `security-scanners.test.ts`):
```typescript
import { readFile } from "node:fs/promises";
const slitherUrl = new URL("./__fixtures__/slither-sample.json", import.meta.url);
const raw = JSON.parse(await readFile(slitherUrl, "utf-8")) as unknown;
expect(parseSlitherOutput(raw)).toHaveLength(/* N */);
```
**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach:** `vi.mock` + `vi.fn()` spies; dynamic `await import()` after mocks. **File naming:** `<name>.test.ts` collocated. **Location:** co-located in `src/orchestrator/`.

**What each criterion demands:**
- **sc-5-1 (parsers):** load `slither-sample.json` / `semgrep-sample.json` → assert exact `SecurityFinding[]` (description, `evidence[0].path`, `evidence[0].line`, vulnClass). Malformed tests: truncated JSON string (`JSON.parse` throws upstream, or pass a partial object) AND valid-JSON-wrong-shape (`{}`, `[1,2,3]`, `{results:"nope"}`) → all `[]`, never throw.
- **sc-5-2 (isolation):** three-scanner input where the middle `command` is a nonexistent binary → assert the other two contribute and the call resolves (no rejection). Use the injected `runner` (fake returns fixture stdout for scanner 1 & 3, throws ENOENT for scanner 2) OR a real nonexistent binary name.
- **sc-5-3 (abort):** per generatorNotes[5], a fake long-running command `node -e "setTimeout(()=>{}, 60000)"`; fire the `AbortSignal` shortly after; assert the pre-filter resolves quickly with partial findings and the child is killed. Keep it fast (short timer).
- **sc-5-4 (wiring + no-spawn):** in `security-auditor-agent.test.ts`, capture the fake `loopSpy` prompt (`loopSpy.mock.calls[0][0].userMessage`) with scanners configured (priors section present, `scannerRan:true`) vs `scanners:[]` (no priors section, `scannerRan:false`, **zero runner/execa calls** — inject a runner spy and assert `.not.toHaveBeenCalled()`). Mirror the existing tests at lines 304-326.
- **sc-5-5 (build):** grep new tests contain NO real `slither`/`semgrep` invocation.

### E2E Test Pattern
Not applicable — this sprint has no Playwright/UI surface.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/commands/security-audit.ts:38,110-135` | `typeof runSecurityAudit` | **high** | KEEP the signature identical (`priors` stays last optional param). Any new required param breaks `typeof` and the injected `runAudit` fake. |
| `src/orchestrator/security-gate.ts:20,87` | calls `runSecurityAudit(contract, evaluation, projectRoot, config)` (4 args) | medium | 4-arg call must stay valid; `priors` default `[]` preserves it. Gate's `Promise.race` timeout is unchanged. |
| `src/orchestrator/security-auditor-agent.test.ts:304-326` | `runSecurityAudit(..., config, priors)` + `scannerRan` | **high** | Tests pass `priors` directly with `scanners:[]` and assert `scannerRan===true` for non-empty priors, `false` for empty. Your `scannerRan` formula must still satisfy these (see §9). |
| `src/orchestrator/pipeline.test.ts:120,287-498` | `vi.fn()` mock of `runSecurityAudit` | low | Mocked — unaffected by internal changes. |
| `src/orchestrator/security-gate.test.ts:27-31` | `vi.fn()` mock of `runSecurityAudit` | low | Mocked — unaffected. |
| `src/cli/commands/security-audit.test.ts` | `typeof runSecurityAudit` casts | low | Only breaks if signature changes. |

### Existing Tests That Must Still Pass
- `src/orchestrator/security-auditor-agent.test.ts` (447 lines) — ALL sc-2 tests, especially **304-326** (priors section + `scannerRan`) and **354-364** (loop-reject propagates, not persisted). Your wiring runs a pre-filter only when `scanners` non-empty; these tests use `scanners:[]` so the pre-filter must be a no-op for them.
- `src/orchestrator/security-gate.test.ts` — gate behavior unchanged.
- `src/orchestrator/pipeline.test.ts` — gate/pipeline integration unchanged.
- `src/cli/commands/security-audit.test.ts` — CLI unchanged.

### Features That Could Be Affected
- **In-pipeline security gate (sprint 3):** shares `runSecurityAudit`. Verify the `Promise.race` time-box still bounds the whole audit; the new internal AbortController is a nested safety net, not a replacement.
- **Standalone `bober security-audit` (sprint 4):** shares `runSecurityAudit`. Verify it still runs with `evaluation=null` and no priors when scanners unconfigured.

### Recommended Regression Checks
1. `npm run build` — clean tsc output (contract sc-5-5).
2. `npm run typecheck` — zero type errors.
3. `npm run lint` (or the project ESLint script) — zero errors (`consistent-type-imports`, no unused).
4. `npx vitest run src/orchestrator/security-auditor-agent.test.ts src/orchestrator/security-scanners.test.ts src/orchestrator/security-gate.test.ts src/cli/commands/security-audit.test.ts` — all green.
5. Full suite: `npm test` — must stay green (baseline suite 4004, sprint should ADD tests).
6. Confirm CI-offline: `grep -nE "\b(slither|semgrep)\b" src/orchestrator/security-scanners.test.ts` shows only fixture/parser references, NO real binary invocation (evaluatorNotes).

---

## 8. Implementation Sequence

1. **`src/orchestrator/__fixtures__/slither-sample.json` + `semgrep-sample.json`** — write realistic minimal tool output (§1 shapes). Include at least one High/ERROR (critical-bucket) and one lower-severity entry each.
   - Verify: `node -e` or a scratch parse confirms valid JSON; field names match real tool docs (evaluatorNotes: circular fixtures are flagged).
2. **`src/orchestrator/security-scanners.ts`** — types first (`ScannerRunResult`, `ScannerRunner`, `ScannerPreFilterInput`), then pure `parseSlitherOutput`/`parseSemgrepOutput`/`rawTextFallback` (no deps beyond types), then parser-selection, then `runScannerPreFilter` (uses execa via injectable runner + per-scanner try/catch + abort→SIGKILL).
   - Verify: `npm run typecheck` clean; parsers importable.
3. **`src/orchestrator/security-scanners.test.ts`** — fixture-backed parser tests (sc-5-1), isolation (sc-5-2), abort (sc-5-3) using an injected runner + `node -e` for the real-abort case.
   - Verify: `npx vitest run src/orchestrator/security-scanners.test.ts` green; no real slither/semgrep.
4. **Wire into `src/orchestrator/security-auditor-agent.ts`** — add `import { runScannerPreFilter } from "./security-scanners.js";`; before `buildUserMessage`, compute `effectivePriors` (internal AbortController keyed to `config.security.timeoutMs`); pass `effectivePriors` to `buildUserMessage`; set `scannerRan` (§9). Keep signature unchanged.
   - Verify: existing `security-auditor-agent.test.ts:304-326` still green.
5. **Extend `src/orchestrator/security-auditor-agent.test.ts`** — add sc-5-4 tests: scanners-configured (inject a runner via config? — see §9 note) asserting priors section present + `scannerRan:true`; `scanners:[]` asserting no priors section + `scannerRan:false` + zero runner/execa calls.
   - Verify: new tests green; old tests still green.
6. **Run full verification** — `npm run build`, `npm run typecheck`, `npm run lint`, `npm test` (all green, CI-offline confirmed).

---

## 9. Pitfalls & Warnings

- **DO NOT change `runSecurityAudit`'s signature.** `src/cli/commands/security-audit.ts` and `security-audit.test.ts` cast to `typeof runSecurityAudit` and inject a fake; the gate calls it with 4 args. Keep `priors: SecurityFinding[] = []` as the last optional param; invoke the pre-filter internally.
- **`scannerRan` reconciliation (subtle).** Sprint 2 sets `scannerRan: priors.length > 0`, and existing tests at lines 304-326 rely on it (non-empty priors passed directly → `true`; empty → `false`). sc-5-4 additionally requires: `scanners:[]` → `false`; scanners configured (producing priors) → `true`. Safe formula: `scannerRan: configuredScanners.length > 0 || effectivePriors.length > 0`. This keeps ALL existing tests green AND satisfies sc-5-4. (A plain `configuredScanners.length > 0` would BREAK the line-304 test which passes priors with `scanners:[]`.)
- **How does the sc-5-4 test inject a fake runner into `runSecurityAudit`?** `runSecurityAudit` calls `runScannerPreFilter` by import. Two clean options: (a) in `security-auditor-agent.test.ts`, `vi.mock("./security-scanners.js", () => ({ runScannerPreFilter: spy }))` and assert the spy is/ isn't called (mirrors the existing `vi.mock("./agentic-loop.js")` at line 25) — cleanest for the "zero calls with scanners:[]" assertion; (b) give `runScannerPreFilter` an injected `runner` default and unit-test the pre-filter separately in `security-scanners.test.ts`. Use BOTH: mock the whole module in the agent test, inject the runner in the scanner test.
- **`path`/`line` are inside `evidence`, not top-level.** Emit `{ description, evidence: [{path, line, snippet}], vulnClass?, source? }`. There is no `severity` field on `SecurityFinding` — encode severity/bucket in `description`/`source` text.
- **Fixtures must look like REAL tool output.** evaluatorNotes flags "a fixture invented to match the parser is circular." Cross-check field names against slither `--json` (`results.detectors[].elements[].source_mapping.lines`, `.impact`, `.check`) and semgrep `--json` (`results[].path`, `.start.line`, `.extra.severity`, `.check_id`, `.extra.message`).
- **Never throw from `runScannerPreFilter` or the parsers.** Wrap each scanner in try/catch → `[]`; parsers return `[]` on any shape mismatch. The whole pre-filter resolves (partial findings) even on abort. A thrown pre-filter would surface as a gate `audit-error` block — wrong.
- **Bound scanner output.** Set execa `maxBuffer` and truncate the raw-text fallback to ~2000 chars (generatorNotes[2]) so a pathological scanner can't exhaust memory or blow the prompt.
- **`.js` import extensions + `import type`.** ESM NodeNext requires `./security-scanners.js`; ESLint `consistent-type-imports` requires `import type` for `EvalStrategy`, `SecurityFinding`, `VulnClass`.
- **vulnClass mapping is optional — do not force wrong classes.** Slither Solidity detectors (reentrancy, etc.) don't map cleanly to the 6 `VulnClass` values; leave `vulnClass` undefined unless a clean mapping exists (generatorNotes[1]). Only attach a class validated via `isVulnClass`.
- **`src/orchestrator/__fixtures__/` does not exist yet** — you create it. Do not confuse with the existing `src/orchestrator/workflow/__fixtures__/`.
