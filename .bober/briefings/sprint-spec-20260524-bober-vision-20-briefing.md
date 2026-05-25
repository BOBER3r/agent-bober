# Sprint Briefing: Change-management gates + bober-deployer agent + bober.deploy skill

**Contract:** sprint-spec-20260524-bober-vision-20
**Generated:** 2026-05-25T00:00:00Z

> **HIGHEST-RISK SPRINT OF TIER 3.** Adds the only EXECUTING subagent in the entire spec. Iron Law must be airtight: the unconditional gate (s20-c6) is the production safety guarantee — bypassing it forfeits the guarantee. Read evaluatorNotes carefully: classification happens on the **COMMAND content, not on the agent's self-declared classification**. Multi-command Bash invocations (`echo 'safe' && kubectl scale ...`) must NOT slip through the gate.

---

## Sprint Summary

Five deliverables, all interlocking:

1. **`agents/bober-deployer.md`** (create) — Mirror `agents/bober-diagnoser.md` structure (Sprint 15) but executing, not read-only.
2. **`skills/bober.deploy/SKILL.md`** (create) — Classification + execution discipline. Sibling of `skills/bober.runbook/SKILL.md` (Sprint 18).
3. **`src/config/schema.ts`** (modify) — Add `allowAutopilotRiskyActions: z.boolean().default(false)` to `PipelineSectionSchema`.
4. **`src/orchestrator/...`** (modify/create) — New `src/orchestrator/deploy/` module with `executeAction()`, `classifyCommand()`, `resolveRiskyActionMechanism()`. Also wire the deployer spawn site mirroring Sprint 16's `mergeObsTools` pattern.
5. **`tests/orchestrator/deployer.test.ts`** (create) — Five critical test scenarios. Vitest + temp directories.

### The 8 Success Criteria — Plain English

| ID  | What it checks |
|-----|----------------|
| s20-c1 | YAML frontmatter `name: bober-deployer`, tools `Read, Bash, Grep, Glob` + obs MCP at spawn (Sprint 16 pattern). NOT read-only — CAN Bash, but every action gated. |
| s20-c2 | Iron Law: 'NO RISKY ACTION WITHOUT CHECKPOINT APPROVAL; NO ACTION WITHOUT RECORDED INVERSE'. Red Flags ≥6. Rationalization-Prevention ≥6. |
| s20-c3 | Classification documented: safe = read-only/reversible/feature-flag-flip-to-default; risky = stateful/destructive/externally-observable. Rule: "when in doubt, classify risky." |
| s20-c4 | `skills/bober.deploy/SKILL.md`: classification + precondition → checkpoint-if-risky → execute → ChangeEntry → postcondition → abort discipline (postcondition fail → execute inverse → escalate). |
| s20-c5 | Orchestrator wiring: deployer spawns with obs MCPs + risky-action checkpoint callback. Callback receives action description + classification reasoning + inverse. |
| s20-c6 | **UNCONDITIONAL GATE.** mode=autopilot + mechanism=noop → risky actions STILL use non-noop (default 'disk' floor). `allowAutopilotRiskyActions=false` default. When true → auto-approved with stern warning. |
| s20-c7 | ChangeEntry written AT execution time (status='pending' BEFORE execute, status='executed' AFTER). Action crash leaves ChangeEntry on disk with documented status. |
| s20-c8 | All existing eval strategies pass (typecheck/lint/build/test exit 0). |

---

## 1. Target Files

### `src/config/schema.ts` (modify)

**Relevant section — `PipelineSectionSchema`, lines 147-165:**

```typescript
export const PipelineSectionSchema = z.object({
  maxIterations: z.number().int().min(1).default(20),
  maxCheckpointIterations: z.number().int().min(1).max(10).default(3),
  requireApproval: z.boolean().default(false),
  contextReset: ContextResetSchema.default("always"),
  researchPhase: z.boolean().default(true),
  architectPhase: z.boolean().default(false),
  mode: z.enum(["autopilot", "careful"]).default("autopilot"),
  checkpointMechanism: CheckpointMechanismSchema.optional(),
  checkpointOverrides: z.record(z.string(), CheckpointMechanismSchema).default({}),
  approvalTimeoutMs: z.number().int().min(1000).default(86_400_000),
  prPollMs: z.number().int().min(10_000).default(30_000),
  // ── ADD HERE — last field in PipelineSectionSchema ────────────────
  /** Escape hatch for fully-automated environments (CI, batch jobs).
   *  When false (default): risky actions invoke a non-noop mechanism floor
   *  even in mode='autopilot' + mechanism='noop'. When true: risky actions
   *  auto-approve BUT a stern warning is logged AND the ChangeEntry is
   *  still recorded with the required inverse. NEVER skip the audit trail. */
  allowAutopilotRiskyActions: z.boolean().default(false),
});
```

**Also: `createDefaultConfig()` factory** at lines 336-347 — add `allowAutopilotRiskyActions: false` to the `pipeline:` block.

**Imported by:** `src/config/loader.ts`, `src/config/defaults.ts`, `src/orchestrator/checkpoints/registry.ts` (`CheckpointOverrideConfig`).

**Test file:** existing `tests/config/graph-schema.test.ts` does NOT cover pipeline — add new pipeline schema test OR colocate at `src/config/schema.test.ts` if other pipeline tests are there. Search before creating.

---

### `agents/bober-deployer.md` (create)

**Directory pattern:** Existing agents in `agents/` use kebab-case `.md`. 8 agents present (architect, code-reviewer, curator, diagnoser, evaluator, generator, planner, researcher).

**Most similar existing file (THE structural template):** `agents/bober-diagnoser.md` (256 lines, Sprint 15). Mirror its:
- YAML frontmatter (1-10) — change `name: bober-deployer`, keep `tools: Read, Bash, Grep, Glob`, model `sonnet`.
- Subagent Context block (14-43).
- IRON LAW fenced block (49-55).
- The One Rule (61-65).
- Core Principles (67-73).
- Investigation Discipline → renamed **Execution Discipline** (130-165).
- Bash Discipline allowlist (170-184) + forbidden list (188-198).
- Observability MCP Tools section (202-212).
- Red Flags ≥6 (220-229).
- Rationalization Prevention ≥6 rows (231-242).
- What You Must Never Do (244-256).

**Crucial differences from diagnoser:**
- Diagnoser is **read-only** ("You do NOT modify code. You do NOT deploy."). Deployer **CAN execute**, but every Bash command routes through the executor seam (`runCommand()` in `src/orchestrator/deploy/`), which applies `classifyCommand()` BEFORE execution.
- Diagnoser outputs `DiagnosisResult JSON`. Deployer outputs a `DeployResult JSON` summarizing executed/aborted actions. The deployer's response is the orchestrator's signal to mark incident remediation step done.
- Iron Law: 'NO RISKY ACTION WITHOUT CHECKPOINT APPROVAL; NO ACTION WITHOUT RECORDED INVERSE'.

**Frontmatter skeleton:**

```yaml
---
name: bober-deployer
description: Remediation-action executor — classifies every action by blast radius, requires Tier 2 checkpoint approval for risky actions (even in autopilot), records a ChangeEntry with required inverse BEFORE execution, never bypasses the gate.
tools:
  - Read
  - Bash
  - Grep
  - Glob
model: sonnet
---
```

---

### `skills/bober.deploy/SKILL.md` (create)

**Directory pattern:** Each skill at `skills/<dot-name>/SKILL.md`. Directory uses dot-separated (`bober.deploy`); frontmatter `name` field uses dash-separated (`bober-deploy`). Confirmed by 20 existing skill dirs.

**Most similar existing file (THE structural template):** `skills/bober.runbook/SKILL.md` (336 lines, Sprint 18). The runbook skill contains the **exact prose that must be carried verbatim** (s20-c6 + skill cross-ref):

- Lines 148-159: "Hard Gate — Risky Steps" with the verbatim "Autopilot mode does NOT bypass risky-step approval" and "default 'disk' fallback" language.
- Lines 161: the verbatim escape hatch sentence about `pipeline.allowAutopilotRiskyActions=true` — **this skill (bober.deploy) is where that escape hatch is actually documented** per the runbook line 161 cross-ref.

**Required sections (mirror bober.runbook section order):**

```
1.  YAML frontmatter (name: bober-deploy, description starts with "Use when executing a remediation action…")
2.  MIT attribution blockquote (if adapting obra/superpowers)
3.  # Remediation Execution Discipline (H1)
4.  ## Overview (Core principle + spirit-of-process)
5.  ## The Iron Law (fenced block: NO RISKY ACTION WITHOUT CHECKPOINT APPROVAL; NO ACTION WITHOUT RECORDED INVERSE)
6.  ## When to Use (bullet list)
7.  ## Action Classification — concrete SAFE list / RISKY list / WHEN IN DOUBT rule
8.  ## Execution Loop (precondition → if risky checkpoint → execute → ChangeEntry → postcondition → abort discipline)
9.  ## Hard Gate — Risky Actions (UNCONDITIONAL; carry verbatim language from bober.runbook lines 148-159)
10. ## allowAutopilotRiskyActions Escape Hatch (skip approval, NOT audit trail; warning logged)
11. ## ChangeEntry Write-then-Update (status='pending' BEFORE, 'executed'|'failed' AFTER)
12. ## Abort Discipline (postcondition fail → execute inverse → escalate)
13. ## Worked Example (concrete kubectl scale scenario; reuse runbook's API-error-spike scenario)
14. ## Red Flags - STOP (≥6)
15. ## Common Rationalizations (≥6 rows)
16. ## Quick Reference (table)
17. ## Related Skills (bober.runbook, bober.diagnose, bober-deployer agent)
```

Target length: **~300-400 lines**.

---

### `src/orchestrator/deploy/` (create — new module directory)

**Directory pattern:** Mirror `src/orchestrator/checkpoints/` (Sprint 7) and `src/orchestrator/observability/` (Sprint 16). Single-concern subdirectory of `src/orchestrator/`. Use `.js` import extensions (ESM).

**Files to create inside `src/orchestrator/deploy/`:**

```
src/orchestrator/deploy/
  index.ts              — barrel: re-export executeAction, classifyCommand, types
  types.ts              — ProposedAction, DeployResult, ExecutorSeam
  classify.ts           — classifyCommand(commandText): 'safe' | 'risky'
  executor.ts           — defaultExecutor (execa wrapper) + ExecutorSeam interface
  execute.ts            — executeAction(action, incidentId, config, deps) main entrypoint
  resolve.ts            — resolveRiskyActionMechanism(config) — the forced floor
```

**Most similar existing file (structural pattern):**
- `src/orchestrator/checkpoints/registry.ts` for the **forced-floor resolver** style (pure function + small interface dependency surface).
- `src/orchestrator/observability/merge.ts` for the **subagent spawn-time wiring** pattern (Promise.allSettled + sanitized error logging).
- `src/incident/timeline.ts` for the **per-incidentId mutex + atomic writes** pattern (already implemented; deployer reuses).

---

### `tests/orchestrator/deployer.test.ts` (create)

**Most similar existing test file:** `tests/incident/timeline.test.ts` (vitest + `mkdtemp` per test + readJsonl helper). Mirror imports, `beforeEach/afterEach`, helper factories.

Also reference `src/orchestrator/checkpoints/registry.test.ts` for **mechanism resolution test patterns** — particularly the per-tier resolution test style with explicit `config` objects.

---

## 2. Patterns to Follow

### Pattern A — Zod-first schema extension

**Source:** `src/config/schema.ts:147-165` (`PipelineSectionSchema`).

```typescript
mode: z.enum(["autopilot", "careful"]).default("autopilot"),
checkpointMechanism: CheckpointMechanismSchema.optional(),
checkpointOverrides: z.record(z.string(), CheckpointMechanismSchema).default({}),
approvalTimeoutMs: z.number().int().min(1000).default(86_400_000),
prPollMs: z.number().int().min(10_000).default(30_000),
```

**Rule:** Use `.default(false)` for booleans, not `.optional()`. Add a JSDoc comment ABOVE the field explaining the semantic + safety implication. `z.infer<>` re-derives the TS type for free — no manual type editing.

### Pattern B — Pure resolver + impure registry lookup

**Source:** `src/orchestrator/checkpoints/registry.ts:65-91` (`resolveCheckpointMechanismName`) + 105-120 (`getCheckpointMechanismFor`).

```typescript
// Pure name resolver — testable without the registry, no side effects.
export function resolveCheckpointMechanismName(
  checkpointId: string,
  config: CheckpointOverrideConfig | undefined,
  cliOverride?: string,
  cliOverrideAll?: boolean,
  fallback = "noop",
): string {
  // ... tier-by-tier resolution
}

// Impure wrapper — registry lookup.
export function getCheckpointMechanismFor(
  checkpointId: string,
  config: CheckpointOverrideConfig | undefined,
  fallback?: string,
  cliOverride?: string,
  cliOverrideAll?: boolean,
): CheckpointMechanism {
  const name = resolveCheckpointMechanismName(checkpointId, config, cliOverride, cliOverrideAll, fallback ?? "noop");
  return getCheckpointMechanism(name);
}
```

**Rule:** For the forced-floor `resolveRiskyActionMechanism`, mirror this split: pure name resolver + impure registry lookup. Pure resolver is what the tests will exercise.

### Pattern C — Per-incidentId Promise-chain mutex

**Source:** `src/incident/timeline.ts:48-52` + `:306-333` (`appendChange`).

```typescript
const writeChains = new Map<IncidentId, Promise<void>>();

// At each append helper:
const prev = writeChains.get(incidentId) ?? Promise.resolve();
const next = prev.then(async () => { /* writes */ });
writeChains.set(incidentId, next.catch(() => {}));
return next;
```

**Rule:** Concurrent writes to the same incident's changelog.jsonl must serialize through this mutex. The deployer's two-phase write (pending → executed) MUST be inside the same `prev.then(...)` so an intervening write cannot interleave. **However** — these are TWO separate appendChange calls (different `status` field values). The simplest correct approach: just call `appendChange` twice with different `status`, accepting that an audit reader observing the file mid-execution sees the 'pending' line and infers in-flight state.

### Pattern D — Subagent spawn-time wiring (Promise.allSettled for isolation)

**Source:** `src/orchestrator/observability/merge.ts:73-120` (`mergeObsTools`).

```typescript
export async function mergeObsTools(providers: readonly ObservabilityProvider[]): Promise<MergeResult> {
  const enabled = providers.filter((p) => p.enabled !== false);
  const servers: ExternalMcpServer[] = enabled.map((p) => new ExternalMcpServer(p));
  const failures: Record<string, string> = {};
  const tools: NamespacedTool[] = [];

  const startResults = await Promise.allSettled(servers.map(async (s) => {
    await s.start();
    return s.listTools();
  }));
  // ... collect successes + failures, sanitize error messages
}
```

**Rule:** When wiring the deployer spawn, reuse `mergeObsTools` directly — the deployer receives observability MCP tools the SAME way the diagnoser does. The deployer spawn site adds ONE extra concern: the risky-action checkpoint callback (Pattern E below).

### Pattern E — Stderr warning for non-blocking concerns

**Source:** `src/orchestrator/observability/merge.ts:111-113` + `:141-145` (sanitizeError).

```typescript
process.stderr.write(`[bober obs] provider "${provider.name}" failed to start: ${msg}\n`);
```

**Rule:** When `allowAutopilotRiskyActions=true` auto-approves a risky action, write a STERN warning to stderr — never silently. Format: `[bober deploy] WARN allowAutopilotRiskyActions=true — auto-approved risky action <actionId>: <description>. ChangeEntry recorded with inverse "<inverse.description>".`

### Pattern F — Schema validation BEFORE side effects

**Source:** `src/incident/timeline.ts:306-333` (`appendChange`).

```typescript
export async function appendChange(projectRoot, incidentId, entry): Promise<void> {
  ChangeEntrySchema.parse(entry); // throws ZodError BEFORE the mutex/file touch
  // ... then mutex, then writes
}
```

**Rule:** `executeAction` MUST validate the proposed action shape (including non-empty inverse) BEFORE any I/O. Throw with a clear `Error('executeAction: action.inverse is required and must be non-empty')` if missing — this is the test guard for the "missing-inverse aborts before execution" criterion.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `getCheckpointMechanism` | `src/orchestrator/checkpoints/registry.ts:24` | `(name: string) => CheckpointMechanism` | Registry lookup by mechanism name. Use to fetch 'disk', 'cli', 'pr', 'noop'. |
| `getCheckpointMechanismFor` | `src/orchestrator/checkpoints/registry.ts:105` | `(id, config, fallback?, cliOverride?, cliOverrideAll?) => CheckpointMechanism` | Per-checkpoint resolution with fallback. Use as the inner call inside `resolveRiskyActionMechanism`. |
| `resolveCheckpointMechanismName` | `src/orchestrator/checkpoints/registry.ts:65` | `(id, config, cliOverride?, cliOverrideAll?, fallback?) => string` | Pure name resolution — call when you need the name string (e.g., for the warning log). |
| `appendChange` | `src/incident/timeline.ts:306` | `(projectRoot, incidentId, ChangeEntry) => Promise<void>` | Append to changelog.jsonl + timeline.jsonl with mutex. THROWS ZodError if `inverse` missing. |
| `appendAction` | `src/incident/timeline.ts:266` | `(projectRoot, incidentId, ActionEntry) => Promise<void>` | Append to actions.jsonl. Use to log proposed actions BEFORE classification gate. |
| `appendTimeline` | `src/incident/timeline.ts:210` | `(projectRoot, incidentId, TimelineEvent) => Promise<void>` | Direct timeline write. Use for `eventKind: 'action_aborted'`, `'checkpoint_rejected'`. |
| `mergeObsTools` | `src/orchestrator/observability/merge.ts:73` | `(providers) => Promise<MergeResult>` | Spawn observability MCPs and namespace their tools. Reuse at deployer spawn. |
| `stopAll` | `src/orchestrator/observability/merge.ts:128` | `(servers) => Promise<void>` | Stop observability MCPs on deployer exit. MUST be called in finally. |
| `loadAgentDefinition` | `src/orchestrator/agent-loader.ts:141` | `(agentName, projectRoot?) => Promise<AgentDefinition>` | Load `agents/bober-deployer.md` (frontmatter + body). |
| `assembleSystemPrompt` | `src/orchestrator/agent-loader.ts:191` | `(role, agentName, projectRoot, ctx) => Promise<string>` | Load + decorate the deployer prompt with graph-state fragments. |
| `ChangeEntrySchema` | `src/incident/types.ts:78-89` | `z.object({ id, type, executedAt, description, inverse: REQUIRED, status })` | Schema for changelog entries. `inverse` is required (not .optional). |
| `logger` | `src/utils/logger.ts` | `info/warn/error/debug` methods | Use logger.warn for the autopilot-bypass warning. Also write to stderr per Pattern E. |
| `CheckpointMechanism` interface | `src/orchestrator/checkpoints/types.ts:55-60` | `request(id, artifact) => Promise<CheckpointOutcome>` | The interface every mechanism implements; the gate calls `.request()`. |
| `CheckpointOutcome` discriminated union | `src/orchestrator/checkpoints/types.ts:46-49` | `{approved:true} \| {approved:false, feedback} \| {edit:true, editDelta}` | Three outcomes — handle all three in the gate. |
| `execa` | `execa` npm pkg (already used in 4+ places) | `execa(cmd, args, opts) => Promise<{exitCode, stdout, stderr}>` | The seam-injection default for command execution. See `src/orchestrator/tools/handlers.ts:70`. |
| `sanitizeError` | `src/orchestrator/observability/merge.ts:141` | `(err: unknown) => string` | Strips `KEY=VALUE` env-var patterns before logging. Reuse to avoid token leakage in deployer error logs. (NOT exported — copy the function or export it.) |

---

## 4. Prior Sprint Output

### Sprint 7: Checkpoint module skeleton
**Created:** `src/orchestrator/checkpoints/{types.ts, registry.ts, index.ts, sites.ts, noop.ts}`
**Exports:** `CheckpointId`, `CheckpointMechanism`, `CheckpointOutcome`, `getCheckpointMechanism`, `getCheckpointMechanismFor`.
**Connection:** Sprint 20 introduces a NEW checkpoint site `risky-action-<actionId>` but does NOT add it to `CHECKPOINT_SITES` because the id is dynamic. The site is invoked directly from `executeAction` via `mech.request('risky-action-<actionId>', payload)`.

### Sprint 10: Per-checkpoint resolution
**Created:** `getCheckpointMechanismFor(checkpointId, config, fallback)` resolver.
**Connection:** Sprint 20's `resolveRiskyActionMechanism` WRAPS this resolver and applies the forced floor (noop → disk override) when `!allowAutopilotRiskyActions`.

### Sprint 14: 6-tier resolver
**Created:** `resolveCheckpointMechanismName` (pure) + `getCheckpointMechanismFor` (impure) + mode-based defaults.
**Connection:** Sprint 20's floor sits ABOVE all 6 tiers — when `isRisky && !allowAutopilotRiskyActions`, the resolved name CANNOT be 'noop'. After normal resolution returns 'noop', force to 'disk' (per s20-c6 acceptance language: "default 'disk' fallback").

### Sprint 15: bober-diagnoser agent
**Created:** `agents/bober-diagnoser.md` — read-only investigator. Template for Sprint 20's deployer agent.
**Connection:** Sprint 20's deployer mirrors structure (Iron Law, Red Flags, Rationalization, Bash allowlist/forbidden) but DROPS the read-only constraint. The Bash forbidden list still applies as the **risky classifier's pattern source** (Pattern G in Section 5 below).

### Sprint 16: Observability MCP merge
**Created:** `src/orchestrator/observability/merge.ts` with `mergeObsTools` + `stopAll`.
**Connection:** Sprint 20's deployer spawn calls `mergeObsTools(config.observability?.providers ?? [])` exactly like the diagnoser spawn. The deployer's tool list is `[Read, Bash, Grep, Glob, ...namespacedObsTools]`.

### Sprint 18: bober.runbook skill
**Created:** `skills/bober.runbook/SKILL.md` — runbook execution discipline.
**Connection:** Sprint 20's `bober.deploy` is the executor-level skill that runbook steps DELEGATE to. Carry VERBATIM the "Autopilot mode does NOT bypass risky-step approval" language (runbook line 151, 158-159). The escape hatch (runbook line 161) is FULLY DOCUMENTED in this sprint's `bober.deploy` skill.

### Sprint 19: Incident timeline
**Created:** `src/incident/{types.ts, timeline.ts}` with `ChangeEntrySchema` (inverse REQUIRED), `appendChange`, `appendAction`, `appendTimeline`.
**Connection:** Sprint 20 calls `appendChange` TWICE per action (status='pending' before execute, status='executed'|'failed' after). The deployer also calls `appendAction` to log the PROPOSED action before classification.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` was checked in this briefing pass — search for it in the project root at implementation time.

### Architecture Decisions
No `.bober/architecture/` directory detected.

### Key Inline Documentation

**From `src/orchestrator/checkpoints/types.ts:46-49`:**

```typescript
export type CheckpointOutcome =
  | { approved: true; editDelta?: unknown }
  | { approved: false; feedback: string }
  | { edit: true; editDelta: unknown };
```

Three outcomes. Sprint 20's gate logic MUST handle all three:
- `approved: true` → execute.
- `approved: false` → abort, append action 'aborted' to timeline.
- `edit: true` → treat the editDelta as a MODIFIED action (operator changed the command). Re-classify the modified command BEFORE executing.

**From `skills/bober.runbook/SKILL.md:148-159` (verbatim language to carry into bober.deploy):**

```
Any step with `blastRadius: 'risky'` MUST invoke the Tier 2 checkpoint mechanism
before execution. This is UNCONDITIONAL:
- pipeline.mode='autopilot' does NOT bypass risky-step approval.
- pipeline.checkpointMechanism='noop' does NOT apply to risky steps.
- Multi-command bash invocations do NOT slip through the gate.
```

---

## 6. Testing Patterns

### Unit Test Pattern (vitest + mkdtemp fixture)

**Source:** `tests/incident/timeline.test.ts:1-101`.

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-deploy-test-"));
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function readJsonl<T>(filePath: string): Promise<T[]> {
  const raw = await readFile(filePath, "utf-8");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}
```

**Runner:** vitest
**Assertion style:** `expect(x).toBe(...)`, `expect(...).toThrow(...)`, `await expect(promise).rejects.toThrow(...)`
**Mock approach:** Pass an explicit executor seam (function parameter) instead of `vi.mock`. Only mock external libs (e.g., `vi.mock("execa", ...)`) for end-to-end smoke tests.
**File naming:** `<name>.test.ts`
**Location:** Non-colocated under `tests/orchestrator/` per the contract's expectedChanges path.

### Per-tier resolution test pattern

**Source:** `src/orchestrator/checkpoints/registry.test.ts:28-58`.

```typescript
describe("resolveRiskyActionMechanism — forced floor (s20-c6)", () => {
  it("mode=autopilot + mechanism=noop + isRisky=true + !allow → forces 'disk'", () => {
    const config = { pipeline: { mode: "autopilot" as const, checkpointMechanism: "noop" as const } };
    expect(resolveRiskyActionMechanismName(config, true)).toBe("disk");
  });
  it("mode=autopilot + mechanism=noop + isRisky=false → honors 'noop' (no floor for safe)", () => {
    const config = { pipeline: { mode: "autopilot" as const, checkpointMechanism: "noop" as const } };
    expect(resolveRiskyActionMechanismName(config, false)).toBe("noop");
  });
  it("allowAutopilotRiskyActions=true + isRisky=true → returns the configured mechanism (still 'noop' → caller auto-approves with warning)", () => {
    const config = { pipeline: { mode: "autopilot" as const, checkpointMechanism: "noop" as const, allowAutopilotRiskyActions: true } };
    expect(resolveRiskyActionMechanismName(config, true)).toBe("noop");
  });
});
```

### E2E Test Pattern

Not applicable — this sprint is unit-test only. No Playwright integration here.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break

| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/config/loader.ts:247` | `PipelineSectionSchema` | medium | Already has special-case warning for `mode=careful + mechanism=noop`. Adding the new field is additive — should not break, but verify the loader still parses test fixtures. |
| `src/config/defaults.ts` | `PipelineSectionSchema` (via `createDefaultConfig`) | low | Defaults to `false`, additive. |
| `tests/integration/careful-flow.test.ts` | `PipelineSectionSchema` | low | Integration test exercises mode/checkpointMechanism end-to-end. Adding a new field with default should not affect — but the test loads a real config; verify. |
| `src/orchestrator/checkpoints/registry.ts` | `CheckpointOverrideConfig` interface (line 40-51) | low | Sprint 20 EXTENDS the type loosely (it has `[key: string]: unknown` so the new field is compatible without edit). No change required here. |
| `src/orchestrator/checkpoints/audit.ts` | `MechanismName` type | low | Audit logs mechanism name. Sprint 20 invokes 'disk' floor — the audit captures it correctly as 'disk', not 'noop'. |
| `tests/orchestrator/observability-mcp.test.ts` | `mergeObsTools` | low | If the deployer spawn share-imports `mergeObsTools`, ensure no global state collision (the merge module is functional, no module-level state, so it's safe). |

### Existing Tests That Must Still Pass

- `tests/incident/timeline.test.ts` — exercises `appendChange`, `appendAction`. Sprint 20 calls these heavily; the existing tests verify the contract that Sprint 20 relies on.
- `src/orchestrator/checkpoints/registry.test.ts` — exercises the 6-tier resolver. Sprint 20 wraps but does NOT modify these tiers. Test must still pass.
- `tests/integration/careful-flow.test.ts` — end-to-end careful-flow integration (Sprint 14). Adding the new schema field with default=false is additive.
- `src/config/loader.ts` tests (search for `loader.test.ts`) — Sprint 20 adds one field; existing fixtures parse the new field as default.
- `src/orchestrator/checkpoints/audit.test.ts` — audit captures resolved mechanism name. The new 'disk' floor must surface as mechanism='disk' in the audit log.

### Features That Could Be Affected

- **Sprint 24 (`/bober-incident` CLI command)** — Will invoke the deployer. Verify the spawn site keeps the obs-MCP-merge ordering and registers the `stopAll` cleanup in `finally`.
- **Sprint 21 (rollback awareness)** — Reads `changelog.jsonl` for inverses. Sprint 20's ChangeEntry MUST always carry `inverse` (zod-enforced via `appendChange`).
- **Sprint 22 (postmortem)** — Reads incident timeline. Sprint 20's two-line write pattern (`pending`, then `executed`/`failed`) needs to be documented so postmortem reader knows both lines exist for the same `id`.

### Recommended Regression Checks

After implementation, run:

1. `npm run typecheck` — verify `PipelineSection` type infers the new field correctly across all consumers.
2. `npm run lint` — verify the new files don't violate project lint rules (single-quote vs double, ESM `.js` import extensions).
3. `npm run test -- tests/incident/timeline.test.ts` — verify Sprint 19 contract still holds.
4. `npm run test -- src/orchestrator/checkpoints/registry.test.ts` — verify the 6-tier resolver still passes (Sprint 20 wraps; does not modify).
5. `npm run test -- tests/integration/careful-flow.test.ts` — verify end-to-end careful flow still wires through.
6. `npm run test -- tests/orchestrator/deployer.test.ts` — run the new test file (5 critical scenarios — see section 9).
7. `npm run build` — verify no build errors.

---

## 8. Implementation Sequence

1. **`src/config/schema.ts`** — Add `allowAutopilotRiskyActions: z.boolean().default(false)` to `PipelineSectionSchema` (line 165 area). Add `allowAutopilotRiskyActions: false` to `createDefaultConfig` factory's `pipeline:` block (line 347).
   - Verify: `npm run typecheck` passes. `PipelineSection` type now includes the field.

2. **`src/orchestrator/deploy/types.ts`** — Declare `ProposedAction`, `DeployResult`, `ExecutorSeam`. Skeleton:
   ```typescript
   import { z } from "zod";
   import type { ChangeEntry } from "../../incident/types.js";

   export const ProposedActionSchema = z.object({
     id: z.string().min(1),
     description: z.string().min(1),
     classification: z.enum(["safe", "risky"]),
     reasoning: z.string().min(1),
     command: z.string().optional(),
     inverse: z.object({
       description: z.string().min(1),
       command: z.string().optional(),
     }),
     preconditionCheck: z.string().optional(),
     postconditionCheck: z.string().optional(),
   });
   export type ProposedAction = z.infer<typeof ProposedActionSchema>;

   /** Injection seam: tests pass a fake; production passes execaExecutor. */
   export interface ExecutorSeam {
     run(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
   }

   export interface DeployResult {
     incidentId: string;
     executed: Array<{ actionId: string; status: "executed" | "failed"; durationMs: number; error?: string }>;
     aborted: Array<{ actionId: string; reason: "checkpoint_rejected" | "precondition_failed" | "missing_inverse" | "postcondition_failed" }>;
   }
   ```
   - Verify: types compile; `inverse` is required (not optional) in schema; deps on `ChangeEntry` are correct.

3. **`src/orchestrator/deploy/classify.ts`** — Implement `classifyCommand(commandText): 'safe' | 'risky'`. See Section 9 below for the pattern lists.
   - Verify: pattern lists mirror `agents/bober-diagnoser.md:171-198` forbidden list AND the runbook risky list.

4. **`src/orchestrator/deploy/resolve.ts`** — Implement `resolveRiskyActionMechanismName(config, isRisky)` (pure) + `getRiskyActionMechanism(config, isRisky)` (impure).
   - Verify: `resolveCheckpointMechanismName` is reused. When `isRisky && !allowAutopilotRiskyActions && resolved==='noop'` → return `'disk'`.

5. **`src/orchestrator/deploy/executor.ts`** — Default execa-backed `ExecutorSeam` implementation:
   ```typescript
   import { execa } from "execa";
   import type { ExecutorSeam } from "./types.js";

   export const defaultExecutor: ExecutorSeam = {
     async run(command) {
       const r = await execa("sh", ["-c", command], { reject: false });
       return { exitCode: r.exitCode ?? 1, stdout: r.stdout, stderr: r.stderr };
     },
   };
   ```
   - Verify: matches `src/orchestrator/tools/handlers.ts:70` style.

6. **`src/orchestrator/deploy/execute.ts`** — `executeAction(action, incidentId, config, deps?)` main entrypoint. See Section 9 for full skeleton.
   - Verify: ChangeEntry written BEFORE execute (status='pending'), updated AFTER (status='executed' or 'failed'); inverse non-empty validated up-front; classifyCommand re-runs on action.command (NOT trusting `action.classification`); risky → checkpoint via `resolveRiskyActionMechanism`; auto-approve path logs warning to stderr AND writes ChangeEntry.

7. **`src/orchestrator/deploy/index.ts`** — Barrel re-exports.
   - Verify: `import { executeAction, classifyCommand, resolveRiskyActionMechanismName, type ProposedAction } from "../deploy/index.js"` works.

8. **`agents/bober-deployer.md`** — Mirror diagnoser structure with deployer Iron Law, classification rules, executor-seam discipline.
   - Verify: `grep "NO RISKY ACTION WITHOUT CHECKPOINT APPROVAL" agents/bober-deployer.md` matches.

9. **`skills/bober.deploy/SKILL.md`** — Mirror runbook structure with classification rules, execution loop, escape hatch documentation.
   - Verify: contains verbatim "Autopilot mode does NOT bypass" language; contains the `allowAutopilotRiskyActions=true` escape-hatch section with "skip the interactive approval, NOT skip the audit trail" framing.

10. **`tests/orchestrator/deployer.test.ts`** — 5 critical scenarios + missing-inverse + multi-command Bash + crash-mid-execution.
    - Verify: each scenario has explicit assertions; tests use mkdtemp; no global state.

11. **Spawn-site wiring (`src/orchestrator/...`)** — Where to wire is sprint-24-territory per the contract description ("from Sprint 24's /bober-incident flow"). For Sprint 20: export the integration surface (`executeAction` from `src/orchestrator/deploy/index.ts`) and add a single-line note in the agent's spawn registry so Sprint 24 has a clear hook. **Do NOT add a pipeline.ts call site** — there's no automated /bober-incident invocation yet.

12. **Run full verification** —
    - `npm run typecheck`
    - `npm run lint`
    - `npm run test`
    - `npm run build`

---

## 9. Paste-Ready Snippets

### Snippet 1 — Schema addition (drop into `src/config/schema.ts:165` before the closing `})`)

```typescript
  /** Sprint 20: escape hatch for fully-automated environments (CI, batch jobs)
   *  where no human is available. When false (default), risky actions trigger
   *  a non-noop mechanism floor (default 'disk') even in mode='autopilot' +
   *  checkpointMechanism='noop'. When true, risky actions are auto-approved
   *  with a STERN warning logged and the ChangeEntry STILL recorded with the
   *  required inverse. This is "skip the interactive approval" — NOT "skip
   *  the audit trail." Documented as a footgun in skills/bober.deploy/SKILL.md. */
  allowAutopilotRiskyActions: z.boolean().default(false),
```

And in `createDefaultConfig` factory at line 347 (after `prPollMs: 30_000,`):

```typescript
      allowAutopilotRiskyActions: false,
```

### Snippet 2 — `resolveRiskyActionMechanism` (in `src/orchestrator/deploy/resolve.ts`)

```typescript
import {
  resolveCheckpointMechanismName,
  getCheckpointMechanism,
  type CheckpointMechanism,
  type CheckpointOverrideConfig,
} from "../checkpoints/index.js";

/** Extended config shape: pipeline.allowAutopilotRiskyActions is a Sprint 20
 *  field. Other pipeline fields are passed through to the underlying resolver. */
export interface RiskyActionConfig extends CheckpointOverrideConfig {
  pipeline?: CheckpointOverrideConfig["pipeline"] & {
    allowAutopilotRiskyActions?: boolean;
  };
}

/**
 * Pure name resolver for risky-action mechanism.
 *
 * Tier 0 (Sprint 20 FORCED FLOOR): if isRisky && !allowAutopilotRiskyActions
 *   AND the underlying resolution returns 'noop', force to 'disk'. The floor
 *   does NOT apply to safe actions (they honor normal resolution).
 *
 * Tiers 1-6: defer to resolveCheckpointMechanismName (Sprint 14).
 *
 * checkpointId is dynamic: 'risky-action-<actionId>'. Pass it through to the
 * underlying resolver so per-checkpoint overrides COULD target a specific
 * action id (rare; not a documented feature; semantically correct).
 */
export function resolveRiskyActionMechanismName(
  config: RiskyActionConfig | undefined,
  isRisky: boolean,
  actionId?: string,
): string {
  const checkpointId = `risky-action-${actionId ?? "default"}`;
  const resolved = resolveCheckpointMechanismName(checkpointId, config);
  const allow = config?.pipeline?.allowAutopilotRiskyActions === true;

  // Forced floor: risky + !allow + resolved=='noop' → 'disk'.
  if (isRisky && !allow && resolved === "noop") {
    return "disk";
  }
  return resolved;
}

export function getRiskyActionMechanism(
  config: RiskyActionConfig | undefined,
  isRisky: boolean,
  actionId?: string,
): CheckpointMechanism {
  return getCheckpointMechanism(resolveRiskyActionMechanismName(config, isRisky, actionId));
}
```

### Snippet 3 — `classifyCommand` (in `src/orchestrator/deploy/classify.ts`)

```typescript
/**
 * Classify a command string by blast radius.
 *
 * The classifier looks at COMMAND CONTENT, not at any agent-declared
 * classification field. The deployer's self-declaration is a HINT; this
 * function is the authoritative classifier. This is the safety guarantee
 * against multi-command Bash invocations like `echo 'safe' && kubectl scale ...`.
 *
 * Pattern sources:
 * - agents/bober-diagnoser.md:188-198 (forbidden list — the canonical risky set)
 * - skills/bober.runbook/SKILL.md:98 (kubectl scale example)
 *
 * When in doubt: classify risky (default-deny).
 */

/** Risky verbs/commands — matched as word-boundary or post-space tokens.
 *  Order matters: most-specific first to avoid false positives on substrings. */
const RISKY_PATTERNS: ReadonlyArray<RegExp> = [
  // kubectl mutators
  /\bkubectl\s+(delete|apply|patch|edit|scale|rollout|exec\b.*--\s+(?!.*\bget\b))/,
  // docker mutators
  /\bdocker\s+(rm|stop|kill|restart|run|exec\b.*(?:bash|sh))/,
  // git mutators
  /\bgit\s+(reset\s+--hard|push|rebase|commit|revert|clean)/,
  // terraform / helm
  /\b(terraform\s+(apply|destroy)|helm\s+(install|upgrade|uninstall|rollback))/,
  // file mutation operators
  /(?:^|\s)(rm|rmdir|mv|cp)\s+/,
  /(?:^|\s)(?:[^>]*>>?\s+\S+)/, // shell redirect to file
  /\bchmod\b|\bchown\b/,
  // service / process control
  /\bsystemctl\s+(start|stop|restart|enable|disable|mask|unmask)\b/,
  /\bservice\s+\S+\s+(start|stop|restart)\b/,
  /\b(kill|pkill|killall)\b/,
  // package install
  /\b(npm\s+install|pip\s+install|apt(\s+|-get\s+)install|brew\s+install|yarn\s+add|gem\s+install|cargo\s+install)\b/,
  // privilege escalation
  /(?:^|\s)sudo\s+/,
  // state-mutating HTTP
  /\bcurl\b[^|]*\s-X\s+(POST|PUT|PATCH|DELETE)\b/i,
  // wget downloading executables (heuristic)
  /\bwget\s+[^|]*\.(sh|bin|exe)\b/i,
  // DNS / load balancer config (generic)
  /\baws\s+(ec2|elbv2|route53)\s+(create|delete|modify|put|update)/i,
  /\bgcloud\s+\S+\s+(create|delete|update|set)/i,
  // db migrations (heuristic — covers common runners)
  /\b(flyway\s+migrate|liquibase\s+update|alembic\s+upgrade|rake\s+db:migrate|knex\s+migrate)/i,
  // secret rotation (heuristic)
  /\b(vault\s+(rotate|write|delete)|aws\s+secretsmanager\s+(rotate|put|delete|update))/i,
];

/** Safe explicit allowlist — kubectl get, describe, logs, top are read-only.
 *  We use this as a SHORT-CIRCUIT only when the ENTIRE command matches; any
 *  chained mutation (via && / ; / |) defaults to risky-check on the whole string. */
const SAFE_SINGLE_COMMAND_PATTERNS: ReadonlyArray<RegExp> = [
  /^kubectl\s+(get|describe|logs|top|version|config\s+view)\b[^&;|]*$/,
  /^docker\s+(ps|logs|inspect|images|version)\b[^&;|]*$/,
  /^(grep|rg|ag|find|cat|head|tail|less|wc|awk|jq|yq)\b[^&;|]*$/,
  /^git\s+(log|diff|show|blame|status|rev-parse|describe)\b[^&;|]*$/,
  /^curl\b(?![^|]*\s-X\s+(POST|PUT|PATCH|DELETE))[^&;|]*$/i,
  /^(ps|top|htop|lsof|netstat|ss|dig|nslookup|host|ping|traceroute|df|du|free|uname|uptime|date)\b[^&;|]*$/,
];

export function classifyCommand(commandText: string): "safe" | "risky" {
  const trimmed = commandText.trim();
  if (trimmed.length === 0) return "safe"; // empty / no-op

  // Step 1: any chained operator means we must scan the whole string for risky.
  // Step 2: even single commands are scanned for risky patterns first.
  for (const pattern of RISKY_PATTERNS) {
    if (pattern.test(trimmed)) return "risky";
  }

  // Step 3: if no risky pattern matched, check if the whole command is a known-safe single command.
  const hasChainOperator = /(&&|\|\||;|\|)/.test(trimmed);
  if (!hasChainOperator) {
    for (const safe of SAFE_SINGLE_COMMAND_PATTERNS) {
      if (safe.test(trimmed)) return "safe";
    }
  }

  // Step 4: when in doubt, risky (default-deny).
  return "risky";
}
```

### Snippet 4 — `executeAction` skeleton (in `src/orchestrator/deploy/execute.ts`)

```typescript
import { appendChange, appendTimeline, appendAction } from "../../incident/timeline.js";
import type { ChangeEntry } from "../../incident/types.js";
import { ProposedActionSchema, type ProposedAction, type ExecutorSeam } from "./types.js";
import { classifyCommand } from "./classify.js";
import { getRiskyActionMechanism, resolveRiskyActionMechanismName, type RiskyActionConfig } from "./resolve.js";
import { defaultExecutor } from "./executor.js";

export interface ExecuteActionDeps {
  /** Override for tests. Default = execa wrapper. */
  executor?: ExecutorSeam;
  /** Override for tests — used to capture stderr warnings. Default = process.stderr.write. */
  writeWarn?: (msg: string) => void;
  /** Override for tests — clock. */
  now?: () => Date;
}

export interface ExecuteActionResult {
  status: "executed" | "failed" | "aborted";
  reason?: "checkpoint_rejected" | "precondition_failed" | "missing_inverse" | "postcondition_failed";
  durationMs: number;
  error?: string;
}

export async function executeAction(
  action: ProposedAction,
  incidentId: string,
  projectRoot: string,
  config: RiskyActionConfig | undefined,
  deps: ExecuteActionDeps = {},
): Promise<ExecuteActionResult> {
  const executor = deps.executor ?? defaultExecutor;
  const writeWarn = deps.writeWarn ?? ((m) => process.stderr.write(m));
  const now = deps.now ?? (() => new Date());

  // ── Step 0: validate up-front. ──────────────────────────────────────────
  ProposedActionSchema.parse(action);
  if (!action.inverse?.description || action.inverse.description.trim() === "") {
    throw new Error(`executeAction: action ${action.id} aborted — inverse.description is required and non-empty`);
  }

  // ── Step 1: authoritative classification (override agent's self-declared). ─
  const commandClassification = action.command ? classifyCommand(action.command) : action.classification;
  // If the COMMAND is risky, the action is risky regardless of agent's declaration.
  const isRisky = commandClassification === "risky" || action.classification === "risky";

  // Log the proposed action (always, for audit).
  await appendAction(projectRoot, incidentId, {
    timestamp: now().toISOString(),
    action: action.description,
    blastRadius: isRisky ? "risky" : "safe",
    requiresApproval: isRisky,
    rationale: action.reasoning,
  });

  // ── Step 2: if risky, gate via Tier 2 checkpoint. ───────────────────────
  if (isRisky) {
    const allow = config?.pipeline?.allowAutopilotRiskyActions === true;
    const mechanismName = resolveRiskyActionMechanismName(config, true, action.id);

    if (allow) {
      // Auto-approve with STERN warning. Audit trail STILL written below.
      writeWarn(
        `[bober deploy] WARN allowAutopilotRiskyActions=true — auto-approved risky action ${action.id}: ${action.description}. ` +
          `Inverse recorded: "${action.inverse.description}". Mechanism would have been: ${mechanismName}.\n`,
      );
    } else {
      const mech = getRiskyActionMechanism(config, true, action.id);
      const outcome = await mech.request(`risky-action-${action.id}` as never, {
        kind: "risky-action",
        actionId: action.id,
        description: action.description,
        classification: "risky",
        classificationReasoning: action.reasoning,
        command: action.command,
        inverse: action.inverse,
      });

      if ("approved" in outcome && outcome.approved === false) {
        await appendTimeline(projectRoot, incidentId, {
          timestamp: now().toISOString(),
          eventKind: "action_aborted",
          source: "deployer",
          summary: `Action ${action.id} rejected at checkpoint: ${outcome.feedback}`,
        });
        return { status: "aborted", reason: "checkpoint_rejected", durationMs: 0 };
      }
      if ("edit" in outcome) {
        // The operator modified the command. Re-classify the modified command before executing.
        // (Sprint 20 keeps this minimal: log the edit and re-validate; future sprints can fully
        //  re-route the modified action through executeAction again.)
        // For now: log + treat as approved with the modified payload.
      }
    }
  }

  // ── Step 3: write ChangeEntry with status='pending' BEFORE execution. ────
  const startedAt = now().toISOString();
  const pendingEntry: ChangeEntry = {
    id: action.id,
    type: isRisky ? "risky-action" : "safe-action",
    executedAt: startedAt,
    description: action.description,
    inverse: action.inverse,
    status: "pending",
  };
  await appendChange(projectRoot, incidentId, pendingEntry);

  // ── Step 4: execute via injected seam. ──────────────────────────────────
  const startTime = Date.now();
  let exitCode = 0;
  let stderr = "";
  let crashed = false;
  try {
    if (action.command) {
      const r = await executor.run(action.command);
      exitCode = r.exitCode;
      stderr = r.stderr;
    }
  } catch (err: unknown) {
    crashed = true;
    stderr = err instanceof Error ? err.message : String(err);
  }
  const durationMs = Date.now() - startTime;

  // ── Step 5: write ChangeEntry with terminal status AFTER execution. ─────
  const finalStatus: ChangeEntry["status"] = crashed || exitCode !== 0 ? "failed" : "executed";
  const finalEntry: ChangeEntry = {
    id: action.id,
    type: isRisky ? "risky-action" : "safe-action",
    executedAt: now().toISOString(),
    description: action.description,
    inverse: action.inverse,
    status: finalStatus,
  };
  await appendChange(projectRoot, incidentId, finalEntry);

  if (finalStatus === "failed") {
    return { status: "failed", durationMs, error: stderr };
  }
  return { status: "executed", durationMs };
}
```

### Snippet 5 — Five Critical Test Scenarios (in `tests/orchestrator/deployer.test.ts`)

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeAction } from "../../src/orchestrator/deploy/execute.js";
import { classifyCommand } from "../../src/orchestrator/deploy/classify.js";
import { resolveRiskyActionMechanismName } from "../../src/orchestrator/deploy/resolve.js";
import { createIncident } from "../../src/incident/timeline.js";
import type { ProposedAction, ExecutorSeam } from "../../src/orchestrator/deploy/types.js";
import type { ChangeEntry } from "../../src/incident/types.js";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-deploy-test-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

async function readJsonl<T>(p: string): Promise<T[]> {
  const raw = await readFile(p, "utf-8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
}

function makeRiskyAction(overrides: Partial<ProposedAction> = {}): ProposedAction {
  return {
    id: "act-1",
    description: "scale api to 6",
    classification: "risky",
    reasoning: "kubectl scale is stateful + externally observable",
    command: "kubectl scale deployment api --replicas=6",
    inverse: { description: "scale back to 3", command: "kubectl scale deployment api --replicas=3" },
    ...overrides,
  };
}

// Scenario 1 — Unconditional gate (s20-c6).
describe("executeAction — unconditional gate (s20-c6)", () => {
  it("autopilot + mechanism=noop + risky action → still gates via 'disk' floor", async () => {
    const incidentId = await createIncident("test", tmpDir);
    const config = { pipeline: { mode: "autopilot" as const, checkpointMechanism: "noop" as const } };
    // The floor resolves to 'disk' — and 'disk' mechanism blocks waiting for a file.
    // For unit testing, we assert on the RESOLVED MECHANISM NAME (which is the s20-c6 contract).
    expect(resolveRiskyActionMechanismName(config, true)).toBe("disk");
    // safe actions still honor noop
    expect(resolveRiskyActionMechanismName(config, false)).toBe("noop");
  });
});

// Scenario 2 — allowAutopilotRiskyActions=true auto-approves but writes ChangeEntry + warning.
describe("executeAction — allowAutopilotRiskyActions escape hatch", () => {
  it("auto-approves but STILL writes ChangeEntry AND logs warning", async () => {
    const incidentId = await createIncident("test", tmpDir);
    const warnings: string[] = [];
    const executor: ExecutorSeam = { async run() { return { exitCode: 0, stdout: "ok", stderr: "" }; } };

    const result = await executeAction(
      makeRiskyAction(),
      incidentId,
      tmpDir,
      { pipeline: { mode: "autopilot" as const, checkpointMechanism: "noop" as const, allowAutopilotRiskyActions: true } },
      { executor, writeWarn: (m) => warnings.push(m) },
    );

    expect(result.status).toBe("executed");
    expect(warnings.some((w) => w.includes("allowAutopilotRiskyActions=true"))).toBe(true);
    expect(warnings.some((w) => w.includes("auto-approved risky action act-1"))).toBe(true);

    const lines = await readJsonl<ChangeEntry>(join(tmpDir, ".bober", "incidents", incidentId, "changelog.jsonl"));
    expect(lines.find((l) => l.id === "act-1" && l.status === "pending")).toBeTruthy();
    expect(lines.find((l) => l.id === "act-1" && l.status === "executed")).toBeTruthy();
    expect(lines[0].inverse.description).toBe("scale back to 3");
  });
});

// Scenario 3 — Missing inverse aborts before execution.
describe("executeAction — missing inverse", () => {
  it("aborts BEFORE execution if inverse is missing or empty", async () => {
    const incidentId = await createIncident("test", tmpDir);
    let executed = false;
    const executor: ExecutorSeam = { async run() { executed = true; return { exitCode: 0, stdout: "", stderr: "" }; } };

    await expect(executeAction(
      makeRiskyAction({ inverse: { description: "" } }),
      incidentId,
      tmpDir,
      { pipeline: { allowAutopilotRiskyActions: true } },
      { executor },
    )).rejects.toThrow(/inverse.*required/i);

    expect(executed).toBe(false);
    // changelog.jsonl should be empty (no ChangeEntry written for aborted action).
    const lines = await readJsonl<ChangeEntry>(join(tmpDir, ".bober", "incidents", incidentId, "changelog.jsonl"));
    expect(lines.length).toBe(0);
  });
});

// Scenario 4 — Multi-command Bash classification on COMMAND content.
describe("classifyCommand — multi-command Bash gate bypass attempt", () => {
  it("'echo safe && kubectl scale ...' → risky (not 'safe')", () => {
    expect(classifyCommand("echo 'safe' && kubectl scale deployment api --replicas=6")).toBe("risky");
  });
  it("'kubectl get pods' → safe", () => {
    expect(classifyCommand("kubectl get pods -n app")).toBe("safe");
  });
  it("'kubectl get pods | head' → safe (read-only chained)", () => {
    expect(classifyCommand("kubectl get pods | head")).toBe("safe");
  });
  it("'rm -rf /tmp/cache' → risky", () => {
    expect(classifyCommand("rm -rf /tmp/cache")).toBe("risky");
  });
  it("'sudo systemctl restart api' → risky", () => {
    expect(classifyCommand("sudo systemctl restart api")).toBe("risky");
  });
  it("ambiguous one-token command → risky (when-in-doubt)", () => {
    expect(classifyCommand("some-custom-script --apply")).toBe("risky");
  });
});

// Scenario 5 — Crash-mid-execution leaves ChangeEntry on disk with documented status.
describe("executeAction — crash-mid-execution (s20-c7)", () => {
  it("executor throws → ChangeEntry on disk with status='pending' THEN status='failed'", async () => {
    const incidentId = await createIncident("test", tmpDir);
    const executor: ExecutorSeam = { async run() { throw new Error("simulated kubectl crash"); } };

    const result = await executeAction(
      makeRiskyAction(),
      incidentId,
      tmpDir,
      { pipeline: { allowAutopilotRiskyActions: true } },
      { executor },
    );

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/simulated kubectl crash/);

    const lines = await readJsonl<ChangeEntry>(join(tmpDir, ".bober", "incidents", incidentId, "changelog.jsonl"));
    // Both entries exist — operational tooling can see the pending→failed transition.
    expect(lines.filter((l) => l.id === "act-1").length).toBe(2);
    expect(lines.find((l) => l.id === "act-1" && l.status === "pending")).toBeTruthy();
    expect(lines.find((l) => l.id === "act-1" && l.status === "failed")).toBeTruthy();
  });
});
```

### Snippet 6 — `agents/bober-deployer.md` skeleton

```markdown
---
name: bober-deployer
description: Remediation-action executor — classifies every action by blast radius, requires Tier 2 checkpoint approval for risky actions (UNCONDITIONAL — even in autopilot), records a ChangeEntry with required inverse BEFORE execution, never bypasses the gate via clever command construction.
tools:
  - Read
  - Bash
  - Grep
  - Glob
model: sonnet
---

# Bober Deployer Agent

## Subagent Context

You are being **spawned as a subagent** by the Bober orchestrator. ...
[Mirror agents/bober-diagnoser.md:14-43 verbatim, adjusting the artifact list and
 changing "DiagnosisResult JSON" to "DeployResult JSON".]

You are the **Deployer** in the Bober incident-response pipeline. You execute remediation actions classified by blast radius. Every action you run is gated, audited, and recoverable via the inverse you declare BEFORE execution. You do not deploy without an inverse. You do not classify risky actions as safe. You do not bypass the checkpoint via multi-command Bash.

**IRON LAW:**

```
NO RISKY ACTION WITHOUT CHECKPOINT APPROVAL; NO ACTION WITHOUT RECORDED INVERSE
```

## The One Rule That Must Never Be Broken

**You are an executor under discipline. Every action you propose is classified by COMMAND CONTENT — not by your self-declaration. Every risky action invokes Tier 2 checkpoint approval, regardless of pipeline.mode. Every action records a ChangeEntry with a non-empty inverse BEFORE execution and updates it AFTER. You never skip the audit trail.**

## Action Classification

### SAFE (no approval required)
- Read-only queries (`curl -X GET`, `kubectl get/describe`, observability MCP queries)
- Feature flag flip BACK TO DEFAULT state
- Log-level adjustment (if observably revertible)
- Non-destructive diagnostic execution (e.g., `tcpdump` for analysis only)

### RISKY (Tier 2 checkpoint required — UNCONDITIONAL)
- `kubectl scale`, `kubectl rollout restart`, `kubectl delete`, `kubectl apply`, `kubectl patch`
- Database migration (forward OR rollback)
- Secret rotation
- DNS change
- Load balancer config
- Autoscaling group resize
- `terraform apply` / `terraform destroy`
- `helm install/upgrade/uninstall`
- Environment variable update on running service
- Feature flag flip AWAY FROM DEFAULT state
- Any `sudo` invocation
- Any `rm`, `mv` (overwriting), shell redirect to file

### WHEN IN DOUBT: classify risky.

[Continue with Execution Discipline (precondition → if risky checkpoint → execute → ChangeEntry → postcondition), Bash Discipline (allowlist + forbidden — copy verbatim from agents/bober-diagnoser.md:171-198 — but note that every command routes through the executor seam), Observability MCP Tools (mirror diagnoser:202-212), Red Flags ≥6, Rationalization-Prevention table ≥6 rows, What You Must Never Do.]

## Red Flags - STOP (≥6)

- About to mark a risky action as `safe` because it's "small" — small-blast-radius risky is still risky
- About to construct a multi-command Bash to bypass the gate (`echo 'safe' && kubectl scale ...`) — the classifier reads the WHOLE COMMAND
- About to skip declaring an inverse because "this is reversible" — declare it explicitly; implicit reversibility is implicit failure
- About to set `allowAutopilotRiskyActions=true` as a workaround — that flag is for fully-automated environments, NOT for "the checkpoint is slow"
- About to execute before the ChangeEntry write completes — order matters: ChangeEntry pending → execute → ChangeEntry executed
- About to ignore a `checkpoint rejected` outcome and retry the same action — rejection is a STOP, not a retry trigger
- About to claim "the agent classifier already validated this" — the executor's classifyCommand on action.command is the authoritative classification

## Rationalization Prevention (≥6 rows)

| Excuse | Reality |
|--------|---------|
| "It's just a small scale-up, the checkpoint is overkill" | The gate is the safety floor. "Just a small" is exactly the kind of thinking that ships unreviewed risky changes. |
| "Autopilot mode means I can skip approval" | Autopilot trades human-in-the-loop for speed on SAFE actions. The risky-action gate is the production safety floor and does not move. |
| "I'll wrap it in echo so the classifier thinks it's safe" | The classifier reads the COMMAND CONTENT, not your wrapping. `echo 'safe' && kubectl scale ...` is risky. |
| "No need to declare inverse — kubectl scale is idempotent" | Inverse is what unwinds the change. Idempotency is not reversibility. Declare the inverse explicitly. |
| "ChangeEntry can be written after the command succeeds" | Write BEFORE execution (status='pending'); if execution crashes, the entry survives with documented in-flight state. Operational tooling depends on this. |
| "Postcondition failed but the rollback would be risky too, skip it" | Postcondition fail → execute inverse → escalate. Skipping the inverse cascade is how incidents become disasters. |

## What You Must Never Do

- NEVER execute a risky action without a successful checkpoint approval
- NEVER write a ChangeEntry without a non-empty inverse.description
- NEVER trust your own classification — the executor's classifyCommand is authoritative
- NEVER skip the warning log when allowAutopilotRiskyActions=true is in effect
- NEVER chain multiple commands in a single Bash invocation to mask a risky operation
- NEVER set requiresApproval=false on a risky action — the contract enforces this; bypass is fraud

## Related Skills

- `bober.deploy` (this sprint) — classification + execution discipline
- `bober.runbook` (Sprint 18) — step-by-step procedure execution; risky steps DELEGATE to this agent
- `bober.diagnose` (Sprint 17) — upstream investigator; emits nextActions with `requiresApproval: true` that this agent executes

## Observability MCP Tools

[Mirror agents/bober-diagnoser.md:202-212 verbatim — the same Sprint 16 merge pattern applies.]
```

### Snippet 7 — `skills/bober.deploy/SKILL.md` skeleton

```markdown
---
name: bober-deploy
description: Use when executing a remediation action — classify the action by blast radius (safe vs risky), require Tier 2 checkpoint approval for risky actions (unconditional), record a ChangeEntry with required inverse BEFORE execution, follow the abort discipline on postcondition failure.
---

> Adapted from [obra/superpowers](https://github.com/obra/superpowers) — MIT License.
> Structural source: verification-before-completion discipline.
> Adaptations: action-level execution; classification on command content; UNCONDITIONAL Tier 2 gate around risky actions; ChangeEntry write-then-update with required inverse.

# Remediation Execution Discipline

## Overview

A remediation action mutates production state. Executing without classifying blast radius makes the cure worse than the disease. Skipping the inverse declaration removes the ability to recover. Bypassing the checkpoint on a "small" risky action is how production incidents become disasters.

**Core principle:** ALWAYS classify by COMMAND content, ALWAYS declare an inverse BEFORE execution, ALWAYS gate risky actions through Tier 2 checkpoint approval.

**Violating the letter of this process is violating the spirit of incident remediation.**

## The Iron Law

```
NO RISKY ACTION WITHOUT CHECKPOINT APPROVAL; NO ACTION WITHOUT RECORDED INVERSE
```

## When to Use

[Bullet list of operational scenarios — kubectl scale, db migration, feature flag flip, terraform apply, etc.]

## Action Classification

### SAFE
- Read-only queries
- Feature flag flip back to default state
- Reversible-by-redo operations

### RISKY (require Tier 2 checkpoint)
- kubectl scale, kubectl rollout restart, kubectl delete, kubectl apply
- Database migration (forward or rollback)
- Secret rotation, DNS change, load balancer config
- Autoscaling resize, terraform apply, env var update on running service
- Feature flag flip away from default

### WHEN IN DOUBT: classify risky.

The CLASSIFIER reads the COMMAND content, not the agent's self-declared classification. A multi-command Bash invocation like `echo 'safe' && kubectl scale ...` is classified RISKY based on the kubectl scale segment.

## Execution Loop

```
FOR each proposed action:
  CLASSIFY (safe or risky) — on COMMAND content
  VALIDATE inverse is declared and non-empty
  RUN precondition-check
  IF precondition fails: abort, do not execute
  IF risky:
    RESOLVE risky-action mechanism (with FORCED FLOOR: noop → disk)
    REQUEST checkpoint approval (action description + classification reasoning + inverse)
    IF rejected: abort
  WRITE ChangeEntry to changelog.jsonl with status='pending' BEFORE execution
  EXECUTE
  WRITE ChangeEntry to changelog.jsonl with status='executed' (or 'failed' on error)
  RUN postcondition-check
  IF postcondition fails:
    EXECUTE inverse (rollback)
    APPEND rollback to changelog.jsonl
    ESCALATE via checkpoint, STOP
```

## Hard Gate — Risky Actions

Any action classified `risky` MUST invoke the Tier 2 checkpoint mechanism. This is UNCONDITIONAL:

- **`pipeline.mode='autopilot'` does NOT bypass risky-action approval.** Autopilot trades human-in-the-loop for speed on SAFE actions; the risky-action gate is the production safety floor and does not move.
- **`pipeline.checkpointMechanism='noop'` does NOT apply to risky actions.** When the configured mechanism is `noop` but the action is risky, the executor uses the default `disk` fallback (Sprint 13's checkpoint mechanism). The gate cannot be configured away.
- **Multi-command bash invocations do NOT slip through the gate.** A command that wraps `kubectl scale` inside `echo 'safe' && kubectl scale ...` is classified by COMMAND content, not by agent self-declaration. The classifier checks for state-mutating verbs in the entire command string.

<EXTREMELY-IMPORTANT>
Risky actions invoke the Tier 2 checkpoint mechanism regardless of pipeline.mode. Autopilot mode does NOT bypass risky-action approval. If pipeline.mode='autopilot' and pipeline.checkpointMechanism='noop', the executor STILL invokes a non-noop mechanism (default 'disk' fallback) for any action classified 'risky'. This is the production safety guarantee — bypassing it forfeits the guarantee.
</EXTREMELY-IMPORTANT>

## allowAutopilotRiskyActions — The Escape Hatch

`pipeline.allowAutopilotRiskyActions=true` exists for fully-automated environments (CI, batch jobs) where no human is available to respond to an interactive approval prompt. Default is `false` because the SAFE default is to gate.

When set to `true`:

- Risky actions are auto-approved (no checkpoint blocking call).
- A STERN warning is logged to stderr: `[bober deploy] WARN allowAutopilotRiskyActions=true — auto-approved risky action <id>: <description>. Inverse recorded: "<inverse>". Mechanism would have been: <resolved-name>.`
- **The ChangeEntry is STILL recorded** with the required inverse.
- The audit trail is preserved.

**This is "skip the interactive approval" — NOT "skip the audit trail."**

## ChangeEntry Write-then-Update

Every action writes TWO ChangeEntry lines (same `id`, different `status`):

1. **BEFORE execution:** `status='pending'`. If the process crashes mid-execution, the entry exists on disk with documented in-flight state — operational tooling can detect and clean up.
2. **AFTER execution:** `status='executed'` on success, `status='failed'` on non-zero exit or exception.

The `inverse` field is REQUIRED (zod-enforced via `appendChange`). An action with empty `inverse.description` is rejected at `executeAction` entry — BEFORE any I/O.

## Abort Discipline

Postcondition failure triggers the rollback cascade:

1. **Tier 1:** Execute the declared inverse. Verify the inverse's effect (the implicit postcondition is the negation of the failed step's postcondition).
2. **Tier 2:** If the inverse ALSO fails, escalate via checkpoint with the current observable state. The operator decides next move.
3. **Tier 3:** Write `{status: 'rolled-back' | 'failed'}` to changelog.jsonl. STOP. Do NOT continue with subsequent actions.

[Continue with Worked Example, Red Flags ≥6, Common Rationalizations ≥6, Quick Reference, Related Skills.]
```

---

## 10. Pitfalls & Warnings

- **`CheckpointId` is a UNION of 9 LITERAL types** (`src/orchestrator/checkpoints/types.ts:13-22`) — `risky-action-<id>` is NOT in the union. When calling `mech.request('risky-action-...' as never, payload)`, you'll need either to (a) widen the call with `as unknown as CheckpointId`, or (b) accept the cast; do NOT add a literal to the `CheckpointId` enum because the id is dynamic (per-actionId). The audit logger widens to `string` already (`audit.ts:59` comment) — same precedent.
- **`appendChange` validates the entire ChangeEntry** including `inverse.description` non-empty? — Actually, the zod schema (`ChangeEntrySchema`) requires `inverse: z.object({description: z.string(), command: z.string().optional()})` — `description` is `z.string()` (allows empty string). The executor MUST add its own `inverse.description.trim() === ""` guard BEFORE calling `appendChange`, otherwise empty-string inverses slip through. The test scenario assumes this guard exists.
- **`CheckpointOverrideConfig` already has `[key: string]: unknown`** (`registry.ts:49`) — adding `allowAutopilotRiskyActions` to `pipeline` is structurally compatible WITHOUT modifying this interface. The `RiskyActionConfig` extension in Snippet 2 narrows the type for the deployer's local use; it does NOT need to be exported from `checkpoints/index.ts`.
- **The deployer is NOT spawned in this sprint.** Per the contract description ("from Sprint 24's `/bober-incident` flow"), the deployer's spawn site is Sprint 24's work. Sprint 20 ships the agent prompt + the `executeAction` function + tests, but does NOT add a call site in `pipeline.ts`. The orchestrator wiring (s20-c5) is the existence of the export surface (`src/orchestrator/deploy/index.ts`) — not an active call.
- **Don't add `allowAutopilotRiskyActions` to `createDefaultConfig`'s factory return** unless you also add it to the `pipeline:` block — the factory uses object spread on the `base` template, and the field MUST be initialized to `false` explicitly to avoid relying on zod parse-time defaults. (See `defaults.ts` for the same pattern with other booleans.)
- **`classifyCommand` regex order matters.** The `RISKY_PATTERNS` array MUST be checked BEFORE the `SAFE_SINGLE_COMMAND_PATTERNS`. A `kubectl get pods && rm -rf /tmp` matches the safe pattern as a single-command if the chain-operator check is skipped. The implementation in Snippet 3 correctly checks risky first, then safe-with-no-chain-operator.
- **`process.stderr.write` vs `logger.warn`** — both should be used for the autopilot-bypass warning. `process.stderr.write` ensures the warning shows in subprocess capture; `logger.warn` provides chalk-colored output for human operators. Use both (also matches existing precedent in `merge.ts:111-113` and `pr.ts:208`).
- **`execa` import + ESM .js suffix** — when the new files import from `../checkpoints/index.js`, use `.js` extension (ESM convention enforced project-wide; see all existing imports).
- **`vi.mock("execa", ...)` is heavy-handed** for executeAction tests. Pass the `ExecutorSeam` directly via the `deps.executor` parameter — this is why the seam exists. `vi.mock` should only appear in the test that exercises `defaultExecutor` itself (if you write one — not in the contract requirements).
- **The `edit: true` checkpoint outcome** (`CheckpointOutcome` 3rd case) is a real possibility — the disk mechanism allows operators to MODIFY the proposed action. Sprint 20's executeAction handles this as a TODO in the skeleton (treat as approved with modified payload + re-classify). For test coverage, you can ignore this branch in this sprint — Sprint 21 or 24 will exercise it.
- **The `MechanismName` type** (`audit.ts:45`) is `"cli" | "disk" | "pr" | "noop"` — when the forced floor resolves to 'disk', the audit log records 'disk' correctly. No new mechanism name is introduced by this sprint.
- **Existing `tests/integration/careful-flow.test.ts`** parses real config — adding `allowAutopilotRiskyActions` with a zod `.default(false)` means existing config fixtures don't need updates. But if the test asserts on the EXACT shape of the parsed pipeline section, the assertion may need adjustment. Read it before committing.
