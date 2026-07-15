# Sprint Briefing: Add the standalone `bober security-audit` CLI with configurable blocking threshold

**Contract:** sprint-spec-20260712-security-audit-agent-team-4
**Generated:** 2026-07-12T00:00:00Z

---

## 0. TL;DR for the Generator

Create `src/cli/commands/security-audit.ts` exposing `registerSecurityAuditCommand(program, overrides?)` — **structurally identical** to `registerResearchCommand` (`src/cli/commands/research.ts:76`). Wire it into `src/cli/index.ts` next to the other `register*Command(program)` calls. The `.action` stays thin: resolve projectRoot, `loadConfig`, stamp the clock, then delegate to an **exported DI core** `runStandaloneSecurityAudit(deps)` that returns `{ result?, exitCode }` so tests never spawn a process. Threshold logic lives in a **pure exported** `thresholdVerdict(review, standaloneBlockOn)` **in the CLI module — NOT the gate** (that keeps sc-4-4 structural). The audit core `runSecurityAudit` (`src/orchestrator/security-auditor-agent.ts:44`) already exists, accepts `evaluation=null`, and persists internally via `saveSecurityAudit`.

---

## 1. Target Files

### `src/cli/commands/security-audit.ts` (create)

**Directory pattern:** Files in `src/cli/commands/` are kebab-case modules exporting either a `run*Command(...)` core (e.g. `runEvalCommand`) or a `register*Command(program, overrides?)` registrar (e.g. `registerResearchCommand`, `registerDoCommand`). For a NEW top-level verb the **registrar** pattern is correct (matches `research.ts`, `do.ts`, `blackboard.ts`).

**Most similar existing file:** `src/cli/commands/research.ts` — follow its structure exactly: module JSDoc header → imports → `resolveRoot()` helper → injectable-overrides interface → `registerXCommand(program, overrides?)` with a thin `.action`.

**Structure template (synthesized from research.ts + do.ts + the contract's generatorNotes):**
```typescript
import chalk from "chalk";
import { join } from "node:path";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { loadConfig } from "../../config/loader.js";
import { SecuritySectionSchema } from "../../config/schema.js";
import type { BoberConfig } from "../../config/schema.js";
import type { SprintContract } from "../../contracts/sprint-contract.js";
import type { ReviewResult } from "../../orchestrator/code-reviewer-agent.js";
import type { SecurityAuditResult } from "../../orchestrator/security-audit-types.js";
import { runSecurityAudit } from "../../orchestrator/security-auditor-agent.js";

// ── Pure threshold (lives HERE, never in security-gate.ts) — sc-4-4 ──
export function thresholdVerdict(
  review: ReviewResult,
  blockOn: "critical" | "important",
): boolean {
  if (review.critical.length > 0) return true;
  if (blockOn === "important" && review.important.length > 0) return true;
  return false;
}

// ── Synthetic descriptor: never collides with pipeline `sprint-*` ids ──
function buildAuditDescriptor(target: string | undefined, now: string): SprintContract {
  const slug = now.replace(/[:.]/g, "-");               // ISO-ish timestamp slug
  const scope = target ?? "working tree";
  return {
    contractId: `security-audit-${slug}`,               // timestamped; distinct from sprint-*
    specId: "security-audit-standalone",
    sprintNumber: 1,
    title: `Standalone security audit: ${scope}`,
    description: `On-demand security audit of ${scope}.`,
    status: "in-progress",
    dependsOn: [], features: [],
    successCriteria: [{
      criterionId: "audit",
      description: "Audit the target for exploitable security vulnerabilities.",
      verificationMethod: "manual", required: true,
    }],
    nonGoals: ["Standalone audit — not a pipeline sprint."],
    stopConditions: ["The auditor emits a ReviewResult."],
    definitionOfDone: "A cited security review of the target is produced.",
    assumptions: [], outOfScope: [],
    estimatedFiles: target ? [target] : [],
    iterationHistory: [], lastEvalId: null,
  };
}

// ── Injectable deps so tests never hit a real provider ──
export interface StandaloneAuditDeps {
  projectRoot: string;
  config: BoberConfig;
  target?: string;
  now: string;                                          // ISO, stamped at .action boundary
  runAudit?: typeof runSecurityAudit;                   // default = real core
}

export async function runStandaloneSecurityAudit(
  deps: StandaloneAuditDeps,
): Promise<{ result?: SecurityAuditResult; exitCode: 0 | 2 }> {
  const runAudit = deps.runAudit ?? runSecurityAudit;
  // config.security absent => synthesize defaults; standalone does NOT require enabled:true
  const security = deps.config.security ?? SecuritySectionSchema.parse({});
  const runConfig: BoberConfig = { ...deps.config, security };
  const descriptor = buildAuditDescriptor(deps.target, deps.now);

  let result: SecurityAuditResult;
  try {
    result = await runAudit(descriptor, null, deps.projectRoot, runConfig);
  } catch (err) {
    process.stderr.write(chalk.red(`security-audit failed: ${err instanceof Error ? err.message : String(err)}\n`));
    return { exitCode: 2 };                              // fail-closed
  }

  if (!result.parsed) {
    process.stderr.write(chalk.red("security-audit: auditor output could not be parsed (fail-closed).\n"));
    // still print/return with exit 2
    return { result, exitCode: 2 };
  }

  const blocked = thresholdVerdict(result.review, security.standaloneBlockOn);
  // print summary (verdict, per-bucket counts, top findings path:line, artifact path)
  return { result, exitCode: blocked ? 2 : 0 };
}

export function registerSecurityAuditCommand(
  program: Command,
  overrides?: { runAudit?: typeof runSecurityAudit },
): void {
  program
    .command("security-audit [target]")
    .description("Run an on-demand stack-aware security audit against a local path (or the working tree).")
    .action(async (target?: string) => {
      const projectRoot = (await findProjectRoot()) ?? process.cwd();
      const now = new Date().toISOString();             // clock ONLY at .action boundary
      try {
        const config = await loadConfig(projectRoot);
        const { exitCode } = await runStandaloneSecurityAudit({
          projectRoot, config, target, now, runAudit: overrides?.runAudit,
        });
        process.exitCode = exitCode;                     // set, do NOT process.exit()
      } catch (err) {
        process.stderr.write(chalk.red(`security-audit failed: ${err instanceof Error ? err.message : String(err)}\n`));
        process.exitCode = 2;                            // fail-closed (e.g. no config file)
      }
    });
}
```
**Note:** the skeleton above is a *guide*, not a spec — re-locate anchors by pattern (contract generatorNotes: "Anchors may have drifted").

---

### `src/cli/commands/security-audit.test.ts` (create)

**Most similar existing file:** `src/cli/commands/research.test.ts` — reuse its harness verbatim: `makeProgram()` calling `program.exitOverride()` + the registrar, a `parse(program, args)` helper that calls `parseAsync([...], { from: "node" })`, `process.stdout/stderr.write` spies, and `process.exitCode` reset in `beforeEach/afterEach` (`research.test.ts:26-50`).

**BUT** for the threshold matrix (evaluatorNotes demand 10 cells), prefer calling the **DI core `runStandaloneSecurityAudit(deps)` directly** with a fake `runAudit` — this avoids Commander entirely and lets you assert the returned `exitCode` for each cell. Only add 1-2 `parseAsync`-level tests to prove the command is wired and sets `process.exitCode`.

---

### `src/cli/index.ts` (modify)

**Relevant sections (lines 42-48, import block):**
```typescript
import { registerResearchCommand } from "./commands/research.js";
import { registerCalendarCommand } from "./commands/calendar.js";
import { registerVaultCommand } from "./commands/vault.js";
import { registerBlackboardCommand } from "./commands/blackboard.js";
import { registerHubCommand } from "./commands/hub.js";
import { registerDoCommand } from "./commands/do.js";
import { registerTelegramCommand } from "./commands/telegram.js";
```
→ **add** `import { registerSecurityAuditCommand } from "./commands/security-audit.js";`

**Relevant sections (lines 349-356, registration block):**
```typescript
  // ── hub ───────────────────────────────────────────────────────────────
  registerHubCommand(program);
  // ── do ────────────────────────────────────────────────────────────────
  registerDoCommand(program);
  // ── telegram ──────────────────────────────────────────────────────────
  registerTelegramCommand(program);
  // ── Parse ───────────────────────────────────────────────────────
  await program.parseAsync(process.argv);
```
→ **add** a `registerSecurityAuditCommand(program);` block **before** the `// ── Parse ──` line (the parse call must remain last).

**Imported by:** this is the CLI entry (`bin` target); it has **no** `index.test.ts`. Verification is the built-dist smoke test (§7).
**Test file:** none — do not create one; the built-dist `--help` smoke is the check.

---

## 2. Patterns to Follow

### Command-registration module
**Source:** `src/cli/commands/research.ts`, lines 76-82
```typescript
export function registerResearchCommand(
  program: Command,
  overrides?: ResearchRunOverrides,
): void {
  const researchCmd = program
    .command("research")
    .description("Recurring multi-model research jobs");
```
**Rule:** Export a single `register<Verb>Command(program, overrides?)` that calls `program.command(...).description(...).action(...)`; pass optional `overrides` for test-time dependency injection.

### Injectable overrides for testing
**Source:** `src/cli/commands/research.ts`, lines 224-242 (`overrides?.queryModel ?? realImpl`)
```typescript
const qm: QueryModel =
  overrides?.queryModel ??
  ((block, prompt) => { /* real createClient path */ });
```
**Rule:** The default value is the REAL implementation; the override is the injected fake. Tests never mock the provider module — they pass a fake through the registrar. Mirror this with `runAudit?: typeof runSecurityAudit`.

### Clock discipline (no `Date.now()`/`new Date()` in core)
**Source:** `src/cli/commands/research.ts`, lines 110-112, 216-217
```typescript
// Stamp wall-clock time ONLY here — never inside the store
const now = new Date().toISOString();
```
**Rule:** Stamp `new Date().toISOString()` ONCE at the `.action` boundary and pass it into the core as `deps.now`. The descriptor id derives from it — keeps the core deterministic/testable.

### CLI error handling — never throw, set `process.exitCode`
**Source:** `src/cli/commands/research.ts`, lines 131-138; header contract `do.ts:4` ("CLI handlers MUST NOT throw. Set process.exitCode=1 and return.")
```typescript
} catch (err) {
  process.stderr.write(
    chalk.red(`research job add failed: ${err instanceof Error ? err.message : String(err)}\n`),
  );
  process.exitCode = 1;
}
```
**Rule:** Wrap the action body in try/catch, write errors to `process.stderr` with `chalk.red`, and set `process.exitCode` (NEVER call `process.exit()` mid-flow). **For this command the blocked/fail-closed code is `2`, not `1`** (reserve `1` for Commander's own usage errors — generatorNotes point 3).

### Config loading
**Source:** `src/cli/commands/do.ts`, lines 16, 47-52; `src/config/loader.ts:142`
```typescript
import { loadConfig } from "../../config/loader.js";
// ...
try {
  const config = await loadConfig(projectRoot);
  return loadTeam(config, undefined).memoryNamespace || undefined;
} catch { return undefined; }
```
**Rule:** `loadConfig(projectRoot)` **throws** when no config file exists — wrap it. `config.security` is `.optional()`; when absent, build defaults with `SecuritySectionSchema.parse({})` (never require `enabled:true` for standalone — nonGoals[0]).

### Finding → `path:line` rendering (reuse for the summary)
**Source:** `src/orchestrator/security-gate.ts`, lines 164-171
```typescript
for (const finding of criticalFindings.slice(0, MAX_RENDERED_FINDINGS)) {
  const evidence = finding.evidence[0];
  const path = evidence?.path ?? "unknown";
  const line = evidence?.line ?? 0;
  const vulnPrefix = finding.vulnClass ? `${finding.vulnClass}: ` : "";
  parts.push(`[CRITICAL] ${vulnPrefix}${finding.description} at ${path}:${line} — ...`);
}
```
**Rule:** A `ReviewFinding`'s path:line lives at `finding.evidence[0].{path,line}` — NOT on the finding directly (`code-reviewer-agent.ts:17-22`). Copy this access pattern for the CLI's "top findings with path:line" summary (sc-4-3).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `runSecurityAudit` | `src/orchestrator/security-auditor-agent.ts:44` | `(contract: SprintContract, evaluation: EvaluationRunResult \| null, projectRoot: string, config: BoberConfig, priors?: SecurityFinding[]) => Promise<SecurityAuditResult>` | THE audit core; accepts `evaluation=null` for standalone; persists internally via `saveSecurityAudit` (line 119). Call this — do not reimplement. |
| `SecurityAuditResult` | `src/orchestrator/security-audit-types.ts:32` | `{ review: ReviewResult; stack: string; scannerRan: boolean; parsed: boolean; verdict: "pass"\|"blocked" }` | Return shape; `review.critical`/`review.important` drive the threshold; `parsed:false` ⇒ fail-closed. |
| `deriveVerdict` | `src/orchestrator/security-audit-types.ts:52` | `(review: ReviewResult) => "pass" \| "blocked"` | Critical-only verdict. NOTE: your `thresholdVerdict` is the CLI-specific extension (adds `important`) — keep it separate; do NOT edit `deriveVerdict`. |
| `saveSecurityAudit` | `src/state/security-audit-state.ts:29` | `(projectRoot, contractId, result) => Promise<void>` | Writes `.bober/security/<safeId>-security-audit.md`. Core already calls it; re-calling is idempotent (see gate `security-gate.ts:112-118`). |
| `SecuritySectionSchema` | `src/config/schema.ts:210` | Zod object; `.parse({})` yields defaults incl. `standaloneBlockOn:"critical"` | Build the section when `config.security` is absent (contract assumption L62). |
| `loadConfig` | `src/config/loader.ts:142` | `(projectRoot: string) => Promise<BoberConfig>` | Loads+validates config; **throws** if no config file. |
| `createDefaultConfig` | `src/config/schema.ts:658` | `(name, mode, preset?, overrides?) => BoberConfig` | TEST helper — produces a config with `security` ABSENT (verified: does not set `security`). Use it to exercise the sc-4-3 defaults path. |
| `findProjectRoot` | `src/utils/fs.js` (used at `research.ts:31,55-58`) | `() => Promise<string \| null>` | Resolve project root; fall back to `process.cwd()`. |
| `ReviewResult` / `ReviewFinding` | `src/orchestrator/code-reviewer-agent.ts:17,27` | see §2 | Locked shapes; `evidence: Array<{path,line,snippet}>`. |
| `logger` | `src/utils/logger.js` | `.info/.warn/.debug` | Structured logging (research/do use `process.stdout.write`+`chalk` for primary output; `logger` for diagnostics). |

**Directories reviewed:** `src/utils/` (`fs.ts`, `logger.ts`), `src/config/`, `src/orchestrator/` (security core + types + gate), `src/state/`. No new util needed — everything the sprint requires already exists; the only new pure helpers are `thresholdVerdict` + `buildAuditDescriptor`, which are CLI-local by design (generatorNotes point 4).

---

## 4. Prior Sprint Output

### Sprint 1 (f76ee2e/fc20eae/4ae188f): schema + types + store
**Created/extended:** `SecuritySectionSchema` (`src/config/schema.ts:210`, incl. `standaloneBlockOn: z.enum(["critical","important"]).default("critical")` at :225); `security-audit-types.ts` (`SecurityAuditResult`, `SecurityFinding`, `VulnClass`, `deriveVerdict`); `security-audit-state.ts` (`saveSecurityAudit`/`readSecurityAudit`/`listSecurityAudits`).
**Connection:** Read `security.standaloneBlockOn` for the exit-code threshold; use `SecuritySectionSchema.parse({})` for the config-absent fallback; the artifact path convention comes from `security-audit-state.ts:16-19`.

### Sprint 2 (0990156/…/40c1488): the audit core — **this sprint's `dependsOn`**
**Created:** `runSecurityAudit(contract, evaluation|null, projectRoot, config, priors?)` (`security-auditor-agent.ts:44`) — accepts `null` evaluation (standalone), fail-closed parse (`parsed:false` ⇒ `verdict:"blocked"` at :109), persists internally at :119; plus `stack-knowledge.ts` and `agents/bober-security-auditor.md`.
**Connection:** The CLI calls `runSecurityAudit(descriptor, null, projectRoot, runConfig)`. The descriptor is a synthetic `SprintContract` (§1). Standalone omits the eval-context prompt section automatically (`security-auditor-agent.ts:143-156`).

### Sprint 3 (e60422c): the pipeline gate — **must stay untouched**
**Created:** `security-gate.ts` (`evaluateSecurityGate` critical-only veto + `renderSecurityFeedback`), wired into `pipeline.ts`.
**Connection (constraint):** sc-4-4 — the gate is critical-only (ADR-2). Your `standaloneBlockOn` logic must live ONLY in the CLI module. Do NOT touch `security-gate.ts` or `pipeline.ts`.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere** — all imports use `.js` extensions (NodeNext). No CommonJS.
- **`import type { ... }`** enforced by ESLint `consistent-type-imports` — import `BoberConfig`, `SprintContract`, `ReviewResult`, `SecurityAuditResult` as types.
- **Prefix unused params with `_`** — the only escape hatch for `noUnusedParameters`.
- **Zod for config validation** — use `SecuritySectionSchema.parse({})`, never hand-roll defaults.
- **Tests collocated** (`*.test.ts` next to source); **no fs mocks** — use temp dirs (`mkdtemp`) as `research.test.ts` does.
- **Section headers** — `// ── Section ──` unicode box-drawing headers in long files.
- **Type safety hard gate** — strict mode (`noUnusedLocals`, `noImplicitReturns`, etc.); zero type errors, zero lint errors.

### Architecture Decisions (`.bober/architecture/arch-20260712-security-audit-agent-team-architecture.md`)
- **Data Flow 2 — Standalone CLI** (lines 304-314): `bober security-audit [target]` → `runSecurityAudit(descriptor, null, projectRoot, config)` → `saveSecurityAudit` → print summary → `exit = verdict blocked ? 2 : 0`.
- **Open Question resolved** (lines 362): `security.standaloneBlockOn` is the sanctioned extension point for stricter standalone gating, **distinct from the gate's critical-only veto**.
- **ADR-2** — fail-closed posture: an incomplete/unparseable audit is NEVER "clean"; standalone exits 2 on audit-error/`parsed:false` (API contract table line 263: "audit-error to stderr; exit 2 on blocked, 0 on pass").
- **Risk table** (line 346): `parsed:false` must be treated as blocking — do not let an empty fallback review yield a false exit 0.

### Other Docs
`CLAUDE.md`: none project-specific beyond principles. No `CONTRIBUTING.md` guidance for CLI beyond the principles above.

---

## 6. Testing Patterns

### Unit Test Pattern (Commander-level harness)
**Source:** `src/cli/commands/research.test.ts`, lines 54-75
```typescript
function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();            // prevent commander from calling process.exit()
  registerResearchCommand(program);
  return program;
}
async function parse(program: Command, args: string[]): Promise<void> {
  await program.parseAsync(["node", "bober", ...args], { from: "node" });
}
```
**Lifecycle (research.test.ts:27-50):** reset `process.exitCode = 0` in `beforeEach`, restore in `afterEach`; spy `process.stdout.write`/`process.stderr.write` to capture output; `mkdtemp` a temp root and `rm` it after.

**Runner:** vitest · **Assertion style:** `expect(...)` · **Mock approach:** dependency injection via the registrar's `overrides` (preferred) — module `vi.mock` only for `../../utils/fs.js` if you need `findProjectRoot` to point at a temp dir · **File naming:** `security-audit.test.ts` collocated in `src/cli/commands/`.

### DI-core fixture pattern (for the threshold matrix — evaluatorNotes)
**Source:** `src/orchestrator/security-auditor-agent.test.ts:49-93` (a full valid `SprintContract` fixture + `SecuritySection` defaults + `createDefaultConfig`).
```typescript
const testContract: SprintContract = { contractId: "security-audit-test", specId: "test-spec",
  sprintNumber: 2, title: "...", description: "...", status: "in-progress", dependsOn: [],
  features: [], successCriteria: [{ criterionId: "sc", description: "...(>=25 chars)...",
  verificationMethod: "unit-test", required: true }], nonGoals: ["..."], stopConditions: ["..."],
  definitionOfDone: "...(>=20 chars)...", assumptions: [], outOfScope: [], estimatedFiles: [],
  iterationHistory: [], lastEvalId: null };
```
**For this sprint's tests:** build a fake `runAudit` that returns a canned `SecurityAuditResult` per cell, then assert `(await runStandaloneSecurityAudit({ projectRoot, config, now, runAudit: fake })).exitCode`.

**Required matrix (10 cells — evaluatorNotes for sc-4-2):** `standaloneBlockOn ∈ {critical, important}` × result ∈ `{critical findings, important-only, clean, parsed:false, core throws}`:
| blockOn | critical>0 | important-only | clean | parsed:false | runAudit throws |
|---------|-----------|----------------|-------|--------------|-----------------|
| critical | **2** | 0 | 0 | **2** | **2** |
| important | **2** | **2** | 0 | **2** | **2** |

**For sc-4-3:** pass a config from `createDefaultConfig("t","brownfield")` (no `security` key) and assert (a) the audit still runs and (b) the injected fake receives a `config.security` object (spy the arg → `runConfig.security.standaloneBlockOn === "critical"`).

**For sc-4-1:** assert the fake `runAudit` was called with a descriptor whose `contractId` starts with `security-audit-` and does NOT match `/^sprint-/` (no collision with pipeline ids).

### E2E Test Pattern
Not applicable (no Playwright for CLI). The equivalent is the **built-dist smoke** in §7 (the "medical sax bug" lesson — evaluatorNotes for sc-4-5).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/index.ts` | new `security-audit.js` import + registration | low | Additive block before `parseAsync`; import path uses `.js`. No `index.test.ts` exists — covered by build + `--help` smoke. |
| `src/orchestrator/security-auditor-agent.ts` | new caller (CLI) of `runSecurityAudit` | low | Signature UNCHANGED (`evaluation` already accepts `null`). Do NOT modify the core unless TS forces a narrower descriptor type (contract assumption L63) — building a full `SprintContract` avoids that. |
| `src/state/security-audit-state.ts` | `saveSecurityAudit` (called by core) | none | Artifact path `.bober/security/<safeId>-security-audit.md` (`security-audit-state.ts:16-19`); descriptor id is already fs-safe. |

### Existing Tests That Must Still Pass
- `src/orchestrator/security-gate.test.ts` — sc-4-4: gate veto unchanged; it holds a `standaloneBlockOn` value ONLY in a config fixture (`:86`), never in gate logic. Verify no gate code path reads it.
- `src/orchestrator/pipeline.test.ts` — has `standaloneBlockOn` only in a fixture (`:212`); pipeline gate logic untouched.
- `src/config/schema.test.ts:649-738` — the `standaloneBlockOn` schema tests (default `critical`, rejects `minor`); do not alter the schema.
- `src/orchestrator/security-auditor-agent.test.ts` — core unchanged.
- `src/cli/commands/research.test.ts` — your test copies this harness; keep it green (unrelated but same pattern).

### Features That Could Be Affected
- **Pipeline security gate (sprint 3)** — shares `runSecurityAudit`; verify the critical-only veto still holds and no CLI code leaks `standaloneBlockOn` into the gate.
- **Sprint 5 (scanner priors) / Sprint 6 (hub emission)** — out of scope, but do NOT preclude them: call the SAME core; the `priors` param defaults to `[]` (nonGoals[1]).

### Recommended Regression Checks (run after implementation)
1. `npm run build`
2. `node dist/cli/index.js security-audit --help` → prints usage, exits without crashing (built-dist smoke).
3. `npm run typecheck` → zero errors.
4. `npx eslint src/cli/commands/security-audit.ts src/cli/commands/security-audit.test.ts src/cli/index.ts` → zero errors.
5. `npx vitest run` → full suite green.
6. `grep -rn "standaloneBlockOn" src/` → appears ONLY in `config/schema.ts`, the new CLI module, and `*.test.ts` files — NEVER in `security-gate.ts` or `pipeline.ts` (sc-4-4 structural proof).

---

## 8. Implementation Sequence

1. **`src/cli/commands/security-audit.ts`** — write in dependency order within the file:
   - `thresholdVerdict(review, blockOn)` (pure) → then `buildAuditDescriptor(target, now)` (pure) → then `StandaloneAuditDeps` + `runStandaloneSecurityAudit(deps)` (DI core) → then `registerSecurityAuditCommand(program, overrides?)` (thin `.action`).
   - Verify: `npm run typecheck` compiles the new module.
2. **`src/cli/index.ts`** — add the import (near line 48) and the `registerSecurityAuditCommand(program);` block (before `// ── Parse ──`, line ~358).
   - Verify: `npm run build` then `node dist/cli/index.js security-audit --help` lists the command.
3. **`src/cli/commands/security-audit.test.ts`** — DI-core threshold matrix (10 cells) + config-absent defaults (sc-4-3) + descriptor-id assertion (sc-4-1) + 1-2 `parseAsync` wiring tests (sc-4-5 registration).
   - Verify: `npx vitest run src/cli/commands/security-audit.test.ts`.
4. **Run full verification** — `npm run build`, `npm run typecheck`, `npx eslint …`, `npx vitest run`, the `--help` smoke, and the `grep standaloneBlockOn` structural check (§7).

---

## 9. Pitfalls & Warnings

- **Exit code is `2`, not `1`.** Blocked-by-threshold AND fail-closed (throw / `parsed:false`) both exit `2`. Commander's own usage errors keep `1` (generatorNotes point 3). Set `process.exitCode`, never call `process.exit()` mid-flow (the `.action` must return cleanly for tests).
- **Do NOT put `standaloneBlockOn` in `security-gate.ts` or `pipeline.ts`.** sc-4-4 is verified structurally by grep. Threshold logic is CLI-local.
- **`config.security` may be absent — that is legal for standalone.** Do NOT gate on `enabled:true`; the CLI invocation IS the opt-in (nonGoals[0]). Build the section via `SecuritySectionSchema.parse({})` and pass `{ ...config, security }` to the core so the injected fake can inspect the section (sc-4-3 / evaluatorNotes).
- **`parsed:false` must exit 2 even though `review.critical` is empty.** The fail-closed fallback (`security-auditor-agent.ts:289-302`) returns an empty review; `thresholdVerdict` alone would say "not blocked". Check `!result.parsed` FIRST and force exit 2 (mirror gate `security-gate.ts:104-106`).
- **Descriptor id must not collide with pipeline `sprint-*` contractIds.** Use `security-audit-<timestamp-slug>`; keep chars fs-safe (only `[A-Za-z0-9_-]`) so the printed artifact path matches `security-audit-state.ts:17` sanitization exactly.
- **`ReviewFinding` has no top-level `path`/`line`.** They live at `finding.evidence[0].{path,line}` (`code-reviewer-agent.ts:19`). Reuse the access from `security-gate.ts:164-171` for the summary.
- **ESM `.js` import extensions + `import type`.** Every relative import ends in `.js`; type-only imports use `import type` (ESLint `consistent-type-imports` is a hard gate).
- **Don't modify the core to synthesize the descriptor.** `security-auditor-agent.ts` is NOT in `estimatedFiles`. Build a full `SprintContract` literal (all required fields present, e.g. `nonGoals` min 1, `successCriteria` min 1, `definitionOfDone` ≥ 20 chars) so TS strict mode is satisfied without touching the core. Only tighten the core's param type if TS genuinely blocks you (contract assumption L63 — unlikely).
- **The core already persists.** `runSecurityAudit` calls `saveSecurityAudit` internally (`security-auditor-agent.ts:119`); sc-4-1 is satisfied by that call. If you also call `saveSecurityAudit` from the CLI for belt-and-suspenders (matching gate `security-gate.ts:112-118`), guard it in try/catch and remember the injected fake `runAudit` in tests won't persist — so compute/print the artifact path from the descriptor id rather than reading the file back.
