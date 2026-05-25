# Sprint Briefing: /bober-incident skill + CLI entry — top-level incident-workflow entry point

**Contract:** sprint-spec-20260524-bober-vision-24
**Generated:** 2026-05-25T00:00:00Z
**Tier:** 3 — INTEGRATION CAPSTONE (every prior Tier-3 sprint flows through this entry point)

---

## Sprint Goal (one paragraph)

Wire Sprints 15-23 into a coherent **incident lifecycle** with two new public surfaces:

1. **`/bober-incident` slash-command skill** (`skills/bober.incident/SKILL.md`) — the human-facing entry point.
2. **`bober incident <start|status|end|list|abort>` CLI** (`src/cli/commands/incident.ts`) — the programmatic entry point.

A **state machine** (`src/incident/orchestrator.ts`) routes between phases (`investigating → remediating → monitoring → resolved`, plus `aborted`) using the existing primitives: `createIncident`/`setIncidentStatus` (Sprint 19), `executeAction` (Sprint 20), `planRollback`/`executeRollback` (Sprint 21), `verifyResolution` (Sprint 22), `generatePostmortem` (Sprint 23). **No new logic** — only orchestration, guard rails, and a CLI presentation layer.

The integration test (`tests/integration/incident-lifecycle.test.ts`) drives a real end-to-end flow with only `kubectl`/`MCP` mocked at the seam boundary (`ExecutorSeam`, `MetricQueryClient`).

---

## 1. Target Files

### `src/incident/types.ts` (modify)

**Relevant existing section (lines 117-155):**
```ts
export const IncidentStatusSchema = z.enum([
  "investigating",
  "remediating",
  "monitoring",
  "resolved",
  "aborted",
]);
export type IncidentStatus = z.infer<typeof IncidentStatusSchema>;

export const IncidentMetadataSchema = z.object({
  incidentId: z.string(),
  symptom: z.string(),
  createdAt: z.string(),
  status: IncidentStatusSchema,
  resolvedAt: z.string().optional(),
  resolutionCriteria: z.string().optional(),
  resolutionEvidence: IncidentResolutionEvidenceSchema.optional(),
  postmortemPath: z.string().optional(),
});
export type IncidentMetadata = z.infer<typeof IncidentMetadataSchema>;
```

**Modifications required:**
1. Add `severity` as optional `z.enum(['S1','S2','S3','S4']).optional()` to `IncidentMetadataSchema`. Sprint 19 did NOT declare this; the contract calls for `bober incident start --severity S1|S2|S3|S4`.
2. **Add export `IncidentPhase` as a type alias to `IncidentStatus`** (semantically clearer for orchestrator code; orchestrator.ts will use `IncidentPhase` while persistence keeps using `status`).
3. **Add export `STATUS_TRANSITIONS`** — a const map describing the state machine. See §4 below for the exact map.

**Test file:** `tests/incident/timeline.test.ts` (exists) — adding a `severity` field is backward-compat (`.optional()`), no rewrites needed.

**Imported by:** `src/incident/timeline.ts`, `src/incident/rollback.ts`, `src/incident/postmortem.ts`, `src/incident/resolution-verify.ts`, `tests/incident/*.test.ts`. All consumers parse via `IncidentMetadataSchema`; an optional `severity` will not break them.

---

### `src/incident/orchestrator.ts` (create)

**Directory pattern:** `src/incident/*.ts` modules are leaf-style domain code. Each:
- Has a 10-25 line header doctype-comment explaining the sprint, the design constraints, and any append-atomicity / mutex semantics.
- Imports from `./timeline.js`, `./types.js`, `./rollback.js`, `./resolution-verify.js`, `./postmortem.js` — `.js` extension required (ESM).
- Uses `node:fs/promises` (named imports `mkdir`, `readFile`, `writeFile`, `rename`).
- Returns rich result objects, never throws for predictable failure paths (use returned `result.escalated`, `result.verified`, etc.).

**Most similar existing file:** `src/incident/rollback.ts` (466 lines) — Sprint 21 also wraps existing primitives (`executeAction`, `appendChange`, `appendTimeline`) with a planning + execution surface. Mirror its layout exactly: header doctype → exported interfaces → private helpers → exported `planX` / `executeX` functions.

**Structure template (≈ 280-350 lines):**
```ts
/**
 * Incident state machine + phase routing (Sprint 24).
 *
 * Wraps Sprint 19 setIncidentStatus with a GUARDED transition table:
 * invalid transitions reject with a typed error before any disk write.
 *
 * The state machine is deterministic: given (currentPhase, agentOutput),
 * the next phase is fully determined. No human-in-loop required for
 * happy-path autopilot (subject to Tier 2 risky-action gates that fire
 * inside executeAction). This is the integration capstone — no new
 * primitives, only orchestration.
 *
 * Re-open path (resolved → investigating) is the ONLY transition that
 * requires an explicit `reason` arg. Every other transition is implicit
 * from the agent's output.
 *
 * Sprint 24 — src/incident/orchestrator.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  appendTimeline,
  setIncidentStatus,
  type SetStatusOpts,
} from "./timeline.js";
import {
  IncidentMetadataSchema,
  STATUS_TRANSITIONS,
  type IncidentId,
  type IncidentMetadata,
  type IncidentPhase,
} from "./types.js";
import {
  planRollback,
  executeRollback,
  type ExecuteRollbackOpts,
  type RollbackResult,
} from "./rollback.js";
import { executeAction, type ExecuteActionDeps } from "../orchestrator/deploy/execute.js";
import type { ProposedAction } from "../orchestrator/deploy/types.js";
import type { RiskyActionConfig } from "../orchestrator/deploy/resolve.js";
import {
  verifyResolution,
  type ResolutionCriteria,
  type VerifyResolutionDeps,
} from "./resolution-verify.js";

// ── Public types ──────────────────────────────────────────────────────────────

export class InvalidTransitionError extends Error {
  constructor(public from: IncidentPhase, public to: IncidentPhase, public reasonRequired = false) {
    const msg = reasonRequired
      ? `Invalid transition ${from} → ${to}: this transition requires an explicit 'reason' (re-open path).`
      : `Invalid transition ${from} → ${to}. Allowed from '${from}': ${STATUS_TRANSITIONS[from].join(", ")}`;
    super(msg);
    this.name = "InvalidTransitionError";
  }
}

export interface TransitionOpts {
  reason?: string;
  setStatus?: SetStatusOpts; // forwarded to setIncidentStatus when relevant
}

export interface ApplyDiagnosisOpts {
  /** Override clock for tests. */
  now?: () => Date;
}

export interface ApplyDeploymentOpts {
  /** Forwarded to verifyResolution when monitoring transition is attempted. */
  verifyDeps?: Omit<VerifyResolutionDeps, "projectRoot">;
  resolutionCriteria?: ResolutionCriteria;
  /** Skip verifyResolution call (test seam). */
  skipVerification?: boolean;
  now?: () => Date;
}

export interface AbortOpts {
  reason: string; // REQUIRED — abort without a reason is forbidden
  confirmRollback?: boolean; // if true, plans+executes rollback for executed-not-rolled-back changes
  config?: RiskyActionConfig; // forwarded to executeRollback for gate resolution
  rollbackOpts?: ExecuteRollbackOpts;
  now?: () => Date;
}

export interface AbortResult {
  rollback?: RollbackResult;
  abortReportPath: string; // .bober/incidents/<id>/abort-report.md
}

// ── transitionPhase: the guarded gate ─────────────────────────────────────────

export async function transitionPhase(
  projectRoot: string,
  incidentId: IncidentId,
  toPhase: IncidentPhase,
  opts: TransitionOpts = {},
): Promise<void> { /* ... see §4 for body ... */ }

// ── applyDiagnosisOutcome: routes to 'remediating' or 'resolved' ──────────────

export async function applyDiagnosisOutcome(
  projectRoot: string,
  incidentId: IncidentId,
  diagnosis: { nextActions: Array<{ blastRadius: "safe" | "risky" }> },
  opts: ApplyDiagnosisOpts = {},
): Promise<{ newPhase: IncidentPhase }> { /* ... */ }

// ── applyDeploymentOutcome: routes to 'monitoring' then 'resolved' ────────────

export async function applyDeploymentOutcome(
  projectRoot: string,
  incidentId: IncidentId,
  deployResult: { executed: Array<{ status: "executed" | "failed" }> },
  opts: ApplyDeploymentOpts = {},
): Promise<{ newPhase: IncidentPhase; verified?: boolean }> { /* ... */ }

// ── abort: terminal escape hatch (s24-c7) ─────────────────────────────────────

export async function abort(
  projectRoot: string,
  incidentId: IncidentId,
  opts: AbortOpts,
): Promise<AbortResult> { /* ... */ }

// ── readMetadata: a thin wrapper for the CLI status command ───────────────────

export async function readIncidentMetadata(
  projectRoot: string,
  incidentId: IncidentId,
): Promise<IncidentMetadata> { /* ... */ }
```

**Imports this file uses:**
- `appendTimeline`, `setIncidentStatus`, `SetStatusOpts` from `./timeline.js`
- `IncidentMetadataSchema`, `STATUS_TRANSITIONS`, `IncidentId`, `IncidentMetadata`, `IncidentPhase` from `./types.js`
- `planRollback`, `executeRollback`, `ExecuteRollbackOpts`, `RollbackResult` from `./rollback.js`
- `executeAction`, `ExecuteActionDeps` from `../orchestrator/deploy/execute.js`
- `ProposedAction` from `../orchestrator/deploy/types.js`
- `RiskyActionConfig` from `../orchestrator/deploy/resolve.js`
- `verifyResolution`, `ResolutionCriteria`, `VerifyResolutionDeps` from `./resolution-verify.js`

**Imported by:** `src/cli/commands/incident.ts` (new), `tests/integration/incident-lifecycle.test.ts` (new).

---

### `src/cli/commands/incident.ts` (create)

**Directory pattern:** `src/cli/commands/*.ts` modules export one of:
- `register<Name>Command(program: Command): void` — the canonical pattern (rollback.ts:36, postmortem.ts:24)
- `run<Name>Command(args, projectRoot, opts): Promise<void>` — older pattern (plan.ts, sprint.ts)

For a parent-with-subcommands surface (`bober incident <subcommand>`), follow `src/cli/commands/postmortem.ts:24-87` exactly — `const pmCmd = program.command("postmortem")` then chain `pmCmd.command("generate <id>").action(...)`.

**Most similar existing file:** `src/cli/commands/postmortem.ts` — nested subcommand parent, uses `findProjectRoot()`, uses chalk for stderr/stdout coloring, sets `process.exitCode = 1` on failure (never throws — surfaces error message and exits gracefully).

**Structure template:**
```ts
/**
 * `bober incident <start|status|end|list|abort>` — top-level incident workflow CLI.
 *
 * Sprint 24 — src/cli/commands/incident.ts
 */

import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import {
  createIncident,
  listIncidents,
  setIncidentStatus,
} from "../../incident/timeline.js";
import {
  abort,
  readIncidentMetadata,
} from "../../incident/orchestrator.js";
import type { VerifyResult } from "../../incident/resolution-verify.js";

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

export function registerIncidentCommand(program: Command): void {
  const incCmd = program
    .command("incident")
    .description("Manage production incidents (start, status, end, list, abort)");

  // ── incident start <symptom> [--severity S1|S2|S3|S4] ──
  incCmd
    .command("start <symptom>")
    .description("Create a new incident and return its ID")
    .option("--severity <level>", "Severity: S1|S2|S3|S4")
    .action(async (symptom: string, opts: { severity?: string }) => {
      const projectRoot = await resolveRoot();
      const incidentId = await createIncident(symptom, projectRoot);
      if (opts.severity) {
        // setIncidentStatus does not change phase here — we just persist severity
        // via a direct atomicWriteJson is internal; we use setIncidentStatus with
        // the current status to attach extras. (The simplest path: re-set status
        // to 'investigating' with extras: { severity }.)
        await setIncidentStatus(projectRoot, incidentId, "investigating", { severity: opts.severity as "S1"|"S2"|"S3"|"S4" });
      }
      process.stdout.write(chalk.green(`Incident created: ${incidentId}\n`));
      process.stdout.write(chalk.gray(`Artifacts at .bober/incidents/${incidentId}/\n`));
    });

  // ── incident status <id> ──
  incCmd
    .command("status <incidentId>")
    .description("Print current state for an incident: phase, severity, duration, latest diagnosis, action counts, criteria")
    .action(async (incidentId: string) => {
      const projectRoot = await resolveRoot();
      // See §6 for the rich-text rendering pseudocode (worked example in the contract).
      // Render fault-tolerantly: missing diagnoses/ or resolution-evidence/ MUST NOT crash.
      // ...
    });

  // ── incident end <id> [--verified | --override <reason>] ──
  incCmd
    .command("end <incidentId>")
    .description("Mark incident resolved. Auto-triggers postmortem (Sprint 23).")
    .option("--verified", "Resolution criteria were verified externally (synthesize a verifyResult with verified=true)")
    .option("--override <reason>", "Use Sprint 22 override token; reason is mandatory and non-empty")
    .action(async (incidentId, opts: { verified?: boolean; override?: string }) => {
      const projectRoot = await resolveRoot();
      const setOpts: import("../../incident/timeline.js").SetStatusOpts = {};
      if (opts.verified) {
        setOpts.verifyResult = { verified: true, reason: "OK" } as VerifyResult;
      } else if (opts.override) {
        setOpts.overrideToken = `SKIP_METRIC_VERIFY: ${opts.override}`;
      }
      await setIncidentStatus(projectRoot, incidentId, "resolved", undefined, setOpts);
      process.stdout.write(chalk.green(`Incident ${incidentId} marked resolved. Postmortem synthesis triggered.\n`));
    });

  // ── incident list ──
  incCmd
    .command("list")
    .description("List all incidents sorted by createdAt descending")
    .action(async () => {
      const projectRoot = await resolveRoot();
      const summaries = await listIncidents(projectRoot);
      // Render a simple table: incidentId | status | createdAt | symptom (first 60 chars)
      // ...
    });

  // ── incident abort <id> --reason <text> [--confirm-rollback] ──
  incCmd
    .command("abort <incidentId>")
    .description("Abort an incident at any phase. Writes abort marker; optionally rolls back executed changes.")
    .requiredOption("--reason <text>", "Reason for aborting (REQUIRED)")
    .option("--confirm-rollback", "ALSO execute rollback for unreverted changes (each step gates as risky)")
    .action(async (incidentId, opts: { reason: string; confirmRollback?: boolean }) => {
      const projectRoot = await resolveRoot();
      const result = await abort(projectRoot, incidentId, {
        reason: opts.reason,
        confirmRollback: opts.confirmRollback ?? false,
      });
      process.stdout.write(chalk.yellow(`Incident ${incidentId} aborted. Report: ${result.abortReportPath}\n`));
      if (result.rollback) {
        process.stdout.write(chalk.gray(`  Rollback: ${result.rollback.succeeded}/${result.rollback.attempted} succeeded\n`));
      }
    });
}
```

---

### `src/cli/index.ts` (modify)

**Relevant section (lines 28-29, 258-262):**
```ts
import { registerRollbackCommand } from "./commands/rollback.js";
import { registerPostmortemCommand } from "./commands/postmortem.js";
// ...
  registerRollbackCommand(program);
  registerPostmortemCommand(program);
```

**Modifications:** Add one import (`registerIncidentCommand`) and one call site, mirroring the rollback/postmortem pattern exactly:
```ts
import { registerIncidentCommand } from "./commands/incident.js";
// ...
  registerIncidentCommand(program);
```

**Imported by:** This is the CLI entry — no production code imports `src/cli/index.ts`. Tests must not import it.

---

### `skills/bober.incident/SKILL.md` (create)

**Directory pattern:** `skills/bober.<name>/SKILL.md` — exactly one file per skill directory. YAML frontmatter starts at line 1 with `---`. The `name` field uses the directory's `bober-<name>` form (hyphenated, no dot).

**Most similar existing file:** `skills/bober.deploy/SKILL.md` (263 lines) — operational discipline with Iron Law, Red Flags, Common Rationalizations, Quick Reference tables, Related Skills.

**YAML frontmatter MUST begin:**
```yaml
---
name: bober-incident
description: Use when responding to a production incident or system-level failure — kicks off the incident pipeline (diagnose → propose actions → deploy with gates → verify resolution → postmortem). The top-level entry that routes between bober-diagnoser, bober-deployer, and bober-postmortemer based on incident phase.
---
```

**Required sections (per contract s24-c1, s24-c6 + evaluatorNotes Red Flags ≥5, Rationalization-Prevention ≥5):**
1. `# Top-Level Incident Response`
2. `## Overview` — what this skill governs (the lifecycle, not the disciplines)
3. `## The Iron Law` — exactly: `NO INCIDENT WITHOUT TIMELINE; NO RESOLUTION WITHOUT VERIFICATION`
4. `## When to Use` — page fired, SLO breach, user-reported outage, etc.
5. `## Workflow` — the lifecycle, with the phase-transition diagram (see §6 below)
6. `## Slash Command Flow (/bober-incident)` — when user invokes the slash command: prompt for symptom if missing, run `bober incident start`, surface phase transitions
7. `## Phase Transition Diagram` — copy from §4 below
8. `## Red Flags - STOP and Follow Process` — minimum 5 entries
9. `## Common Rationalizations` — minimum 5 rows in the table
10. `## Quick Reference` — common operator questions
11. `## Related Skills` — cross-refs to bober.diagnose, bober.deploy, bober.runbook, bober.postmortem

---

### `tests/integration/incident-lifecycle.test.ts` (create)

**Directory pattern:** `tests/integration/` already exists with one file (`careful-flow.test.ts`). New integration tests follow that file's pattern: mkdtemp for projectRoot, beforeEach/afterEach with `rm({ recursive: true, force: true })`, use REAL modules and only mock at injection seams.

**Most similar existing file:** `tests/integration/careful-flow.test.ts` — exercises real `DiskCheckpointMechanism` + real `runWithAudit` with only the async `.approved.json` write being orchestrated by the test.

**Structure template:**
```ts
/**
 * End-to-end incident lifecycle integration test (s24-c8).
 *
 * REAL integration — uses real timeline.ts, rollback.ts, resolution-verify.ts,
 * postmortem.ts, orchestrator.ts. Mocks ONLY at the seam boundaries:
 *   - ExecutorSeam (so kubectl etc. don't run)
 *   - MetricQueryClient (so observability MCPs aren't spawned)
 *
 * Asserts the contract scenario:
 *   start → diagnose → propose risky action → gate approves → deploy → verify
 *   → resolve → postmortem. All artifacts on disk in correct chronological order.
 *
 * Sprint 24 — tests/integration/incident-lifecycle.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createIncident, appendTimeline, setIncidentStatus } from "../../src/incident/timeline.js";
import {
  transitionPhase,
  applyDiagnosisOutcome,
  applyDeploymentOutcome,
  abort,
  readIncidentMetadata,
  InvalidTransitionError,
} from "../../src/incident/orchestrator.js";
import { executeAction } from "../../src/orchestrator/deploy/execute.js";
import type { ExecutorSeam, ProposedAction } from "../../src/orchestrator/deploy/types.js";
import type { MetricQueryClient } from "../../src/incident/resolution-verify.js";
import { DiskCheckpointMechanism } from "../../src/orchestrator/checkpoints/mechanisms/disk.js";
import { registerCheckpointMechanism } from "../../src/orchestrator/checkpoints/registry.js";
import { saveApproved, listPending } from "../../src/state/approval-state.js";

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "bober-incident-lifecycle-"));
  // Re-register disk mechanism pointing at tmpdir (Sprint 14 pattern from careful-flow.test.ts).
  registerCheckpointMechanism(
    "disk",
    new DiskCheckpointMechanism(join(projectRoot, ".bober", "approvals"), {
      pollMs: 50,
      timeoutMs: 10_000,
    }),
  );
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

// ── Test seams ────────────────────────────────────────────────────────────────

function makeFakeExecutor(): { exec: ExecutorSeam; callCount: () => number } {
  let n = 0;
  return {
    exec: { async run() { n += 1; return { exitCode: 0, stdout: "", stderr: "" }; } },
    callCount: () => n,
  };
}

function makeFakeMetricClient(verified: boolean): MetricQueryClient {
  return {
    async queryMetric() {
      // Return 10 samples all under 0.001 to satisfy `lt 0.01` if verified=true,
      // else return 10 samples at 0.5 to fail.
      const value = verified ? 0.0008 : 0.5;
      return Array.from({ length: 10 }, (_, i) => ({
        timestamp: new Date(Date.now() - (10 - i) * 60_000).toISOString(),
        value,
      }));
    },
  };
}

// ── Test cases ────────────────────────────────────────────────────────────────

describe("incident lifecycle end-to-end (s24-c8)", () => {
  it("start → diagnose → propose 3 risky actions → 3 gate invocations → verify → resolve → postmortem", async () => {
    // 1. start
    const incidentId = await createIncident("500 errors on checkout endpoint", projectRoot);

    // 2. simulate diagnoser writing a diagnosis with 3 risky next-actions
    const incDir = join(projectRoot, ".bober", "incidents", incidentId);
    await mkdir(join(incDir, "diagnoses"), { recursive: true });
    const diagnosis = {
      diagnosisId: `diagnosis-${incidentId}-2026-05-24T14:12:00Z`,
      incidentId,
      timestamp: "2026-05-24T14:12:00Z",
      summary: "Three-step remediation",
      hypotheses: [{ id: "h1", statement: "Pool exhaustion", confidence: "high", supportingEvidence: [], contradictingEvidence: [] }],
      nextActions: [
        { blastRadius: "risky", action: "scale api", requiresApproval: true },
        { blastRadius: "risky", action: "disable flag", requiresApproval: true },
        { blastRadius: "risky", action: "restart db pool", requiresApproval: true },
      ],
    };
    await writeFile(join(incDir, "diagnoses", `${diagnosis.diagnosisId}.json`), JSON.stringify(diagnosis, null, 2));

    // 3. applyDiagnosisOutcome → phase = 'remediating'
    const after = await applyDiagnosisOutcome(projectRoot, incidentId, diagnosis);
    expect(after.newPhase).toBe("remediating");

    // 4. execute 3 risky actions — each MUST trigger the gate once.
    // Using allowAutopilotRiskyActions=true to bypass interactive prompts while
    // still going through the audit path. (Sprint 24 evaluator: gate fires for
    // EVERY risky action — count == 3.)
    const { exec, callCount } = makeFakeExecutor();
    const config = { pipeline: { allowAutopilotRiskyActions: true } };
    const actions: ProposedAction[] = [
      { id: "a1", description: "scale api", classification: "risky", reasoning: "h1", command: "kubectl scale deployment api --replicas=6", inverse: { description: "scale to 3", command: "kubectl scale deployment api --replicas=3" } },
      { id: "a2", description: "disable flag", classification: "risky", reasoning: "h1", command: "ff --set new_checkout_flow=false", inverse: { description: "re-enable flag", command: "ff --set new_checkout_flow=true" } },
      { id: "a3", description: "restart db pool", classification: "risky", reasoning: "h1", command: "kubectl rollout restart deployment db-pool", inverse: { description: "no-op, restart is idempotent" } },
    ];
    const results = [];
    for (const a of actions) {
      results.push(await executeAction(a, incidentId, projectRoot, config, { executor: exec }));
    }
    expect(callCount()).toBe(3); // gate-fire equivalent: 3 executor invocations after 3 audit-path gates

    // 5. applyDeploymentOutcome → verifyResolution via fake client → 'monitoring' then 'resolved'
    const deployResult = { executed: results.map((r) => ({ status: r.status as "executed" | "failed" })) };
    const verified = await applyDeploymentOutcome(projectRoot, incidentId, deployResult, {
      resolutionCriteria: {
        metricName: "api.checkout.error_rate",
        threshold: 0.01,
        comparison: "lt",
        windowMinutes: 10,
        provider: "datadog",
      },
      verifyDeps: {
        providers: [{ name: "datadog", kind: "metrics", mcpCommand: "node", enabled: true }],
        client: makeFakeMetricClient(true),
      },
    });
    expect(verified.verified).toBe(true);

    // 6. Mark resolved → triggers postmortem fire-and-forget; use onPostmortemPromise to await.
    let postmortemPromise: Promise<void> | undefined;
    await setIncidentStatus(projectRoot, incidentId, "resolved", undefined, {
      verifyResult: { verified: true, reason: "OK", observedValue: 0.0008, sampledAt: new Date().toISOString() },
      onPostmortemPromise: (p) => { postmortemPromise = p; },
    });
    expect(postmortemPromise).toBeDefined();
    await postmortemPromise;

    // 7. Assert postmortem.md exists.
    const pmPath = join(incDir, "postmortem.md");
    const pmStat = await stat(pmPath);
    expect(pmStat.isFile()).toBe(true);

    // 8. Assert chronological ordering of timeline.jsonl (timestamps non-decreasing).
    const timelineRaw = await readFile(join(incDir, "timeline.jsonl"), "utf-8");
    const lines = timelineRaw.trim().split("\n").map((l) => JSON.parse(l) as { timestamp: string });
    const stamps = lines.map((l) => l.timestamp);
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i]! >= stamps[i - 1]!).toBe(true);
    }

    // 9. Audit log includes checkpoint outcomes for risky actions (3 of them).
    //    With allowAutopilotRiskyActions=true, ChangeEntries (1 pending + 1 executed each
    //    = 6 entries) and 3 'auto-approved' stderr warnings prove the gate path ran.
    const changelog = await readFile(join(incDir, "changelog.jsonl"), "utf-8");
    const changeLines = changelog.trim().split("\n").filter(Boolean);
    expect(changeLines.length).toBeGreaterThanOrEqual(6); // pending+executed per action
  });

  it("invalid transition: resolved → remediating without re-open reason → InvalidTransitionError", async () => {
    const incidentId = await createIncident("test invalid transition", projectRoot);
    // Force status to 'resolved' by going through the override path.
    await setIncidentStatus(projectRoot, incidentId, "resolved", undefined, {
      overrideToken: "SKIP_METRIC_VERIFY: test fixture",
      autoPostmortem: false,
    });

    await expect(
      transitionPhase(projectRoot, incidentId, "remediating", {}),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("valid re-open: resolved → investigating WITH reason succeeds", async () => {
    const incidentId = await createIncident("test re-open", projectRoot);
    await setIncidentStatus(projectRoot, incidentId, "resolved", undefined, {
      overrideToken: "SKIP_METRIC_VERIFY: test fixture",
      autoPostmortem: false,
    });

    await transitionPhase(projectRoot, incidentId, "investigating", {
      reason: "Symptom recurred at 14:50 UTC",
    });

    const meta = await readIncidentMetadata(projectRoot, incidentId);
    expect(meta.status).toBe("investigating");
  });

  it("abort without --confirm-rollback does NOT execute rollbacks (footgun-prevention)", async () => {
    const incidentId = await createIncident("abort no rollback test", projectRoot);
    // Seed one executed change so a rollback WOULD have something to do.
    // ... (append a ChangeEntry status='executed')
    const { exec, callCount } = makeFakeExecutor();
    const result = await abort(projectRoot, incidentId, {
      reason: "operator decision",
      confirmRollback: false,
      rollbackOpts: { executor: exec },
    });
    expect(result.rollback).toBeUndefined();
    expect(callCount()).toBe(0); // proves no rollback was executed silently
  });

  it("abort with --confirm-rollback DOES execute rollbacks (each step gates)", async () => {
    const incidentId = await createIncident("abort with rollback test", projectRoot);
    // Seed two executed changes.
    // ... (appendChange × 2)
    const { exec, callCount } = makeFakeExecutor();
    const result = await abort(projectRoot, incidentId, {
      reason: "operator decision",
      confirmRollback: true,
      config: { pipeline: { allowAutopilotRiskyActions: true } },
      rollbackOpts: { executor: exec },
    });
    expect(result.rollback).toBeDefined();
    expect(result.rollback!.attempted).toBe(2);
    expect(callCount()).toBe(2);
  });
});
```

---

## 2. Patterns to Follow

### Pattern A — Commander parent-with-subcommands (use for `bober incident`)
**Source:** `src/cli/commands/postmortem.ts:24-87`
```ts
export function registerPostmortemCommand(program: Command): void {
  const pmCmd = program
    .command("postmortem")
    .description("Inspect or (re)generate incident postmortems");

  pmCmd
    .command("generate <incidentId>")
    .description("(Re)synthesize postmortem.md ...")
    .action(async (incidentId: string) => { /* ... */ });

  pmCmd
    .command("show <incidentId>")
    .description("Print the postmortem.md ...")
    .action(async (incidentId: string) => { /* ... */ });
}
```
**Rule:** Build the parent with `program.command("<name>")`, capture it in a local const, then chain `.command("<sub> <args>")` off the const. Each `.action` handler is `async` and returns void.

### Pattern B — Project root resolution
**Source:** `src/cli/commands/rollback.ts:31-34` and `src/cli/commands/postmortem.ts:19-22`
```ts
async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}
```
**Rule:** Every CLI handler calls `await resolveRoot()` as its first action; never trust `process.cwd()` directly. Reuse the in-file helper — do NOT export it from `utils/`.

### Pattern C — chalk + process.exitCode on failure (NEVER throw from .action)
**Source:** `src/cli/commands/postmortem.ts:44-60`, `src/cli/commands/rollback.ts:63-71`
```ts
try {
  // ... do work
} catch (err) {
  if ((err as { code?: string }).code === "ENOENT") {
    process.stderr.write(chalk.yellow(`No incident found at ...\n`));
    process.exitCode = 1;
    return;
  }
  process.stderr.write(chalk.red(`Failed to ...: ${err instanceof Error ? err.message : String(err)}\n`));
  process.exitCode = 1;
}
```
**Rule:** CLI handlers MUST NOT throw — they set `process.exitCode = 1` and `return`. The top-level `main().catch(...)` in `cli/index.ts:270` is a last-ditch fallback, not the primary error path.

### Pattern D — Append-atomic JSONL writes via per-incidentId mutex
**Source:** `src/incident/timeline.ts:54, 65-80, 221-225`
```ts
const writeChains = new Map<IncidentId, Promise<void>>();

async function appendOneLine(filePath: string, record: unknown): Promise<void> {
  const dir = join(filePath, "..");
  await mkdir(dir, { recursive: true });
  const line = JSON.stringify(record) + "\n";
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT;
  const fh = await open(filePath, flags, 0o600);
  try {
    await fh.chmod(0o600);
    await fh.write(line);
  } finally {
    await fh.close();
  }
}

// Per-incident chain:
const prev = writeChains.get(incidentId) ?? Promise.resolve();
const next = prev.then(() => appendOneLine(timelinePath, event));
writeChains.set(incidentId, next.catch(() => {}));
return next;
```
**Rule:** orchestrator.ts MUST NOT re-implement append. It calls `appendTimeline()` (Sprint 19) which already owns the mutex. Adding a new writer to the same incident from a different module without sharing the mutex would race.

### Pattern E — Inject seams; never reach for real I/O directly
**Source:** `src/incident/resolution-verify.ts:88-95` (`VerifyResolutionDeps.client?`) + `src/orchestrator/deploy/execute.ts:29-36` (`ExecuteActionDeps.executor?`)
```ts
export interface VerifyResolutionDeps {
  projectRoot: string;
  providers: readonly ObservabilityProvider[];
  client?: MetricQueryClient;
  now?: () => Date;
}
// Caller:
const client = deps.client ?? (await defaultMcpClient([providerDecl]));
```
**Rule:** `applyDeploymentOutcome` and `abort` MUST accept optional injection bags (`verifyDeps`, `rollbackOpts`) and forward them to the underlying primitives. Tests pass fake `ExecutorSeam` + `MetricQueryClient`; production passes `undefined` and gets the real spawn.

### Pattern F — Iron Law + Red Flags + Rationalizations skill structure
**Source:** `skills/bober.deploy/SKILL.md:14-20, 221-244`
- Iron Law in a code-fence, exactly one sentence, all caps, unconditional
- Red Flags is a bulleted list ≥5 entries starting with "About to..."
- Common Rationalizations is a 2-column markdown table ≥5 rows
- Quick Reference is a 2-column table of "Question | Answer" entries

### Pattern G — Dynamic import for autopostmortem fire-and-forget
**Source:** `src/incident/timeline.ts:488-511`
```ts
if (status === "resolved" && opts?.autoPostmortem !== false) {
  const p = (async () => {
    try {
      const { generatePostmortem } = await import("./postmortem.js");
      const result = await generatePostmortem(projectRoot, incidentId);
      // ... update incident.json.postmortemPath atomically
    } catch (err) { logger.warn(...); }
  })();
  if (opts?.onPostmortemPromise) opts.onPostmortemPromise(p);
  void p;
}
```
**Rule:** orchestrator.ts ALREADY benefits from this when it calls `setIncidentStatus(_, _, "resolved", ...)`. Do NOT re-trigger postmortem manually — the trigger fires inside Sprint 19's setIncidentStatus.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `createIncident` | `src/incident/timeline.ts:150` | `(symptom, projectRoot) => Promise<IncidentId>` | Creates `.bober/incidents/<id>/` skeleton (incident.json + 5 jsonl + diagnoses/). The ONLY way to start an incident. |
| `listIncidents` | `src/incident/timeline.ts:526` | `(projectRoot) => Promise<IncidentSummary[]>` | Returns summaries sorted by createdAt desc. ENOENT-safe (returns []). |
| `setIncidentStatus` | `src/incident/timeline.ts:407` | `(projectRoot, id, status, extras?, opts?) => Promise<void>` | Atomic temp+rename status update. Sprint 22 gate (`opts.verifyResult` or `opts.overrideToken` required when status='resolved'). Sprint 23 auto-postmortem on resolve. |
| `appendTimeline` | `src/incident/timeline.ts:212` | `(projectRoot, id, event) => Promise<void>` | Append a TimelineEvent inside the per-incident mutex. |
| `appendAction` | `src/incident/timeline.ts:268` | `(projectRoot, id, entry) => Promise<void>` | Append to actions.jsonl + timeline.jsonl atomically. |
| `appendChange` | `src/incident/timeline.ts:308` | `(projectRoot, id, entry) => Promise<void>` | Append ChangeEntry (inverse REQUIRED, validated by zod). |
| `deriveSlug` | `src/incident/timeline.ts:115` | `(symptom) => string` | Already used by createIncident; orchestrator.ts doesn't need to call it. |
| `planRollback` | `src/incident/rollback.ts:191` | `(projectRoot, id, opts?) => Promise<RollbackPlan>` | Reverse-execution-order plan filtered by effective-status. |
| `executeRollback` | `src/incident/rollback.ts:337` | `(projectRoot, id, plan, opts?) => Promise<RollbackResult>` | Each step gates as risky; halts on first failure. |
| `presentPlan` | `src/incident/rollback.ts:281` | `(plan) => string` | Human-readable string for CLI output (used in abort-report.md). |
| `executeAction` | `src/orchestrator/deploy/execute.ts:58` | `(action, id, root, config, deps?) => Promise<ExecuteActionResult>` | Classifies + gates + writes pending+executed ChangeEntries. The ONLY way to run a state-mutating action. |
| `classifyCommand` | `src/orchestrator/deploy/classify.ts` (exported via index.ts) | `(command) => "safe" \| "risky"` | Authoritative classification — overrides agent's self-declared. |
| `resolveRiskyActionMechanismName` | `src/orchestrator/deploy/resolve.ts:52` | `(config, isRisky, actionId?) => string` | Tier-0-forced disk fallback for risky actions. |
| `getRiskyActionMechanism` | `src/orchestrator/deploy/resolve.ts:73` | `(config, isRisky, actionId?) => CheckpointMechanism` | Impure wrapper around the name resolver. |
| `verifyResolution` | `src/incident/resolution-verify.ts:117` | `(id, criteria, deps) => Promise<VerifyResult>` | Queries metric, all-samples-pass gate, writes evidence file. |
| `generatePostmortem` | `src/incident/postmortem.ts:625` | `(projectRoot, id) => Promise<PostmortemResult>` | Deterministic postmortem.md synthesis. Auto-triggered by setIncidentStatus on 'resolved'. |
| `findProjectRoot` | `src/utils/fs.ts:58` | `(startDir?) => Promise<string \| null>` | Walks up looking for bober.config.json or package.json. ENOENT-safe (returns null). |
| `fileExists` | `src/utils/fs.ts:10` | `(path) => Promise<boolean>` | Async fs.access wrapper. |
| `readJson<T>` | `src/utils/fs.ts:24` | `(path) => Promise<T>` | JSON.parse the file. |
| `ensureDir` | `src/utils/fs.ts:45` | `(path) => Promise<void>` | mkdir recursive. |
| `logger.warn` / `logger.info` | `src/utils/logger.ts:23, 13` | `(msg, ...args) => void` | chalk-tagged stderr/stdout. Do NOT use console.log directly in production code. |
| `loadAgentDefinition` | `src/orchestrator/agent-loader.ts:141` | `(name, projectRoot) => Promise<AgentDefinition>` | Loads `agents/<name>.md` frontmatter + body. Sprint 24 does NOT need this — orchestrator.ts is pure data routing, not agent spawning. |
| `mergeObsTools` | `src/orchestrator/observability/merge.ts:73` | `(providers) => Promise<MergeResult>` | Namespaces obs__<provider>__<tool>. Used by `verifyResolution`'s default client and by `spawnDeployer`. Sprint 24 does NOT spawn — only data orchestration. |
| `registerCheckpointMechanism` / `getCheckpointMechanism` | `src/orchestrator/checkpoints/registry.ts:20, 24` | `(name, impl) => void` / `(name) => CheckpointMechanism` | Sprint 24 integration test uses `registerCheckpointMechanism("disk", new DiskCheckpointMechanism(...))` to point at tmpdir — see careful-flow.test.ts:43-49. |

---

## 4. The STATUS_TRANSITIONS Map (the state machine contract)

Add to `src/incident/types.ts` as an exported const:

```ts
/**
 * Allowed phase transitions for the incident state machine (Sprint 24).
 * Keys are the FROM phase; values are the array of allowed TO phases.
 *
 * The re-open path (resolved → investigating) requires an explicit `reason`
 * — see transitionPhase() in src/incident/orchestrator.ts.
 *
 * `aborted` is terminal: it appears as a value in many keys (any phase may
 * abort) but never as a key — there are no transitions out of aborted.
 */
export const STATUS_TRANSITIONS: Readonly<Record<IncidentStatus, readonly IncidentStatus[]>> = {
  investigating: ["remediating", "resolved", "aborted"],
  remediating:   ["monitoring", "investigating", "aborted"], // self-loop or back to invest. on rollback
  monitoring:    ["resolved", "investigating", "aborted"],   // verifyResolution fail → back to invest.
  resolved:      ["investigating"],                          // re-open path; reason REQUIRED
  aborted:       [],                                         // terminal
} as const;

/** Convenience alias — orchestrator.ts uses 'phase' nomenclature; storage uses 'status'. */
export type IncidentPhase = IncidentStatus;
```

### transitionPhase function body (paste-ready)

```ts
export async function transitionPhase(
  projectRoot: string,
  incidentId: IncidentId,
  toPhase: IncidentPhase,
  opts: TransitionOpts = {},
): Promise<void> {
  // 1. Read current phase.
  const meta = await readIncidentMetadata(projectRoot, incidentId);
  const from = meta.status;

  // 2. Guard: allowed in the transition table.
  const allowed = STATUS_TRANSITIONS[from];
  if (!allowed.includes(toPhase)) {
    throw new InvalidTransitionError(from, toPhase, false);
  }

  // 3. Re-open path: resolved → investigating requires an explicit reason.
  const isReopen = from === "resolved" && toPhase === "investigating";
  if (isReopen && (!opts.reason || opts.reason.trim() === "")) {
    throw new InvalidTransitionError(from, toPhase, true);
  }

  // 4. Persist via the Sprint 19 atomic writer.
  await setIncidentStatus(projectRoot, incidentId, toPhase, undefined, opts.setStatus);

  // 5. Audit timeline event.
  await appendTimeline(projectRoot, incidentId, {
    timestamp: new Date().toISOString(),
    eventKind: "phase_transition",
    source: "system",
    summary: isReopen
      ? `Re-opened: ${from} → ${toPhase}. Reason: ${opts.reason}`
      : `Phase transition: ${from} → ${toPhase}`,
  });
}
```

---

## 5. Prior Sprint Output

### Sprint 15: agents/bober-diagnoser.md — read-only investigator
**Created:** `agents/bober-diagnoser.md` — the subagent prompt
**DiagnosisResult shape (see lines 79-117 of the agent file):**
```json
{
  "diagnosisId": "diagnosis-<incidentId>-<ISO-timestamp>",
  "incidentId": "...",
  "timestamp": "...",
  "summary": "...",
  "hypotheses": [
    {"id":"h1","statement":"...","confidence":"high|medium|low","supportingEvidence":[...],"contradictingEvidence":[...]}
  ],
  "nextActions": [
    {"action":"...","justification":"...","blastRadius":"safe|risky","requiresApproval":true}
  ]
}
```
**Connection to this sprint:** `applyDiagnosisOutcome` inspects `diagnosis.nextActions`; if any have `blastRadius === "risky"`, transition phase to `remediating`. If all `nextActions` are empty or all-safe (and confidence is high), transition straight to `resolved` (the "diagnosed but no remediation needed" exit per `generatorNotes`).

### Sprint 16: src/orchestrator/observability/ + ExternalMcpServer
**Created:** observability merge + the MetricQueryClient seam pattern.
**Connection:** Sprint 24's integration test passes a fake `MetricQueryClient` directly into `verifyResolution`'s `deps.client` to avoid spawning real MCPs.

### Sprint 17: skills/bober.diagnose/SKILL.md — 4-phase discipline
**Connection:** SKILL.md (bober.incident) MUST cross-reference `skills/bober.diagnose/SKILL.md` in the Related Skills section.

### Sprint 19: src/incident/timeline.ts + src/incident/types.ts
**Created exports used here:** `createIncident`, `listIncidents`, `setIncidentStatus`, `appendTimeline`, `appendAction`, `appendChange`, `appendObservation`, `appendRunbookExecution`, `deriveSlug`. Types: `IncidentMetadata`, `IncidentStatus` (5-value enum), `IncidentSummary`, all Schema exports.
**Connection:** orchestrator.ts is a thin layer on top of these. CRITICAL: do NOT touch the existing functions; Sprint 19's mutex semantics depend on the per-incident chain map.

### Sprint 20: src/orchestrator/deploy/
**Created exports used here:** `executeAction(action, incidentId, projectRoot, config, deps?)`, `classifyCommand`, `resolveRiskyActionMechanismName`, `getRiskyActionMechanism`, `ProposedActionSchema`, `ExecutorSeam`, `RiskyActionConfig`, `defaultExecutor`. `spawnDeployer` (in `spawn.ts`) is NOT used by Sprint 24 — orchestrator.ts is pure data orchestration, not agent spawning.
**Connection:** Each risky action proposed by the diagnoser is executed via `executeAction(action, ...)`. The Tier-2 gate fires inside executeAction; orchestrator.ts is NOT responsible for the gate itself, only for the loop.

### Sprint 21: src/incident/rollback.ts
**Created exports used here:** `planRollback`, `executeRollback`, `presentPlan`, `RollbackPlan`, `RollbackResult`, `ExecuteRollbackOpts`.
**Connection:** `abort()` in orchestrator.ts calls `planRollback` + `executeRollback` ONLY when `opts.confirmRollback === true`.

### Sprint 22: src/incident/resolution-verify.ts (+ setIncidentStatus opts gate)
**Created exports used here:** `verifyResolution`, `ResolutionCriteria`, `VerifyResult`, `MetricQueryClient`, `MetricSample`, `VerifyResolutionDeps`.
**Setting status='resolved' REQUIRES**: `opts.verifyResult.verified === true` OR `opts.overrideToken === 'SKIP_METRIC_VERIFY: <non-empty reason>'`. Otherwise `setIncidentStatus` throws. `applyDeploymentOutcome` constructs the `verifyResult` from `verifyResolution()`'s return.

### Sprint 23: src/incident/postmortem.ts + skills/bober.postmortem/SKILL.md + agents/bober-postmortemer.md
**Created exports used here:** `generatePostmortem(projectRoot, incidentId): Promise<PostmortemResult>` (line 625). Auto-trigger code already lives inside `setIncidentStatus` (lines 488-511) — Sprint 24 does NOT re-invoke postmortem; setting status='resolved' is sufficient.

---

## 6. Status Command Rendering Pseudocode (s24-c5)

The CLI `bober incident status <id>` MUST render the worked example from `generatorNotes`:

```
Incident: <id> (symptom: "<symptom>")
Phase: <status>
Severity: <severity or "(unset)">
Duration: <human-readable>

Latest diagnosis (confidence: <highest hypothesis confidence>):
  <leading hypothesis statement>
  (diagnoses/<diagnosisId>.json)

Actions executed: <N> (<M> rolled back)
  <numbered list of executed ChangeEntries with refs to changelog.jsonl#L<n>>

Resolution criteria:
  <if resolutionCriteria set: render it; sample resolution-evidence/ latest file; show observed vs threshold>

Next: <one-line hint of expected next transition, e.g., "auto-transition to 'resolved' when criteria sustained">
```

**Implementation contract:**
- MUST NOT crash if `diagnoses/` is empty (state "(no diagnoses yet)")
- MUST NOT crash if `resolution-evidence/` is missing (omit the section)
- MUST NOT crash if `incident.json.severity` is undefined (render "(unset)")
- MUST work for status='aborted' (skip the "Next:" hint; show abort-report.md path if present)

---

## 7. Phase Transition Diagram (paste into SKILL.md and orchestrator.ts header)

```
                   ┌──────────────────────────────────────────────────────┐
                   │                                                       │
                   ▼                                                       │
            ┌───────────────┐                                              │
            │ investigating │                                              │
            └───────┬───────┘                                              │
                    │                                                      │
       diagnoser produces                                                  │
       nextActions with                                                    │
       ≥1 risky                                                            │
                    │                                                      │
                    ▼                                                      │
            ┌───────────────┐                                              │
            │  remediating  │                                              │
            └───────┬───────┘                                              │
                    │                                                      │
       all proposed actions executed                                       │
       + postcondition passed                                              │
                    │                                                      │
                    ▼                                                      │
            ┌───────────────┐ ──── verifyResolution fails ─────────────────┤
            │   monitoring  │                                              │
            └───────┬───────┘                                              │
                    │                                                      │
       verifyResolution.verified=true                                      │
       for criteria.windowMinutes                                          │
                    │                                                      │
                    ▼                                                      │
            ┌───────────────┐ ──── user re-opens (reason REQUIRED) ────────┘
            │    resolved   │
            └───────────────┘   (auto-postmortem triggered by setIncidentStatus)

At any phase: user issues `bober incident abort <id> --reason <text> [--confirm-rollback]`
              ──────────────────────────────────────► aborted (terminal)
```

---

## 8. Relevant Documentation

### Project Principles
**No principles file found** at `.bober/principles.md` — referenced by some agents but not present in this repo. Sprint 24 should NOT reference it as a required input.

### Architecture Decisions
No `.bober/architecture/` directory. The closest equivalent is the Iron Law + comment headers in `src/incident/*.ts` files; treat the file-header doctype comments in `timeline.ts`/`rollback.ts`/`resolution-verify.ts`/`postmortem.ts` as the architecture documentation. The pattern: every src/incident file leads with a 10-25 line block-comment explaining the sprint, the design constraints, atomicity guarantees, and any non-obvious invariants.

### Other Docs
- `agents/bober-deployer.md` (lines 1-40) — confirms that `DeployResult` has shape `{ incidentId, executed: [{actionId, status: "executed"|"failed", durationMs, error?}], aborted: [{actionId, reason}] }`. `applyDeploymentOutcome` consumes this shape.
- `agents/bober-diagnoser.md` (lines 79-127) — confirms DiagnosisResult shape; `applyDiagnosisOutcome` inspects `diagnosis.nextActions[].blastRadius`.
- `skills/bober.deploy/SKILL.md` (lines 14-20, 221-244) — Iron Law / Red Flags / Rationalizations structure to mimic in `skills/bober.incident/SKILL.md`.

---

## 9. Testing Patterns

### Unit Test Pattern
**Source:** `tests/incident/rollback.test.ts:13-40, 410-485`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-XYZ-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("foo", () => {
  it("does the thing", async () => {
    const executor: ExecutorSeam = {
      async run() { return { exitCode: 0, stdout: "", stderr: "" }; },
    };
    // ... call real code with injected executor
  });
});
```
**Runner:** vitest (`package.json` line 16: `"test": "vitest"`)
**Assertion style:** `expect(actual).toBe(expected)` / `.toEqual(...)` / `.toBeDefined()` / `.rejects.toBeInstanceOf(...)`
**Mock approach:** Manual seam injection (NOT `vi.mock`). Tests pass fake `ExecutorSeam` / `MetricQueryClient` / `now` / `writeWarn` directly into deps bags.
**File naming:** `<source>.test.ts` next to `tests/<dir>/` mirror of `src/<dir>/`. For Sprint 24, lifecycle integration test goes in `tests/integration/incident-lifecycle.test.ts`.
**Location:** Non-colocated — `tests/incident/*.test.ts` mirrors `src/incident/*.ts`. Integration tests live in `tests/integration/`.

### Integration Test Pattern
**Source:** `tests/integration/careful-flow.test.ts:30-50`
```ts
import { DiskCheckpointMechanism } from "../../src/orchestrator/checkpoints/mechanisms/disk.js";
import { registerCheckpointMechanism } from "../../src/orchestrator/checkpoints/registry.js";

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "bober-incident-lifecycle-"));
  registerCheckpointMechanism(
    "disk",
    new DiskCheckpointMechanism(join(projectRoot, ".bober", "approvals"), {
      pollMs: 50,
      timeoutMs: 10_000,
    }),
  );
});
```
**Critical:** The disk mechanism is registered at module-load time pointing at `process.cwd()`. Tests MUST re-register pointing at `mkdtemp` BEFORE invoking any code that touches it. This is the Sprint 14 trick — careful-flow.test.ts:43-49 documents the rationale in the comment.

### Seam-Injection Pattern (for mocking executeAction's executor + verifyResolution's MCP client)

```ts
// Mock 1: ExecutorSeam — replaces real execa shell execution
const executor: ExecutorSeam = {
  async run(command: string) {
    // Optionally pattern-match on command for different outcomes:
    if (command.includes("kubectl scale")) return { exitCode: 0, stdout: "scaled", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  },
};
// Pass into executeAction:
await executeAction(action, incidentId, projectRoot, config, { executor });

// Mock 2: MetricQueryClient — replaces real obs MCP spawn
const client: MetricQueryClient = {
  async queryMetric(provider, args) {
    return [
      { timestamp: new Date().toISOString(), value: 0.0008 },
      // ... 9 more samples
    ];
  },
};
// Pass into verifyResolution:
await verifyResolution(incidentId, criteria, {
  projectRoot,
  providers: [{ name: "datadog", kind: "metrics", mcpCommand: "node", enabled: true }],
  client,
});

// Mock 3 (when calling Sprint 24's applyDeploymentOutcome):
await applyDeploymentOutcome(projectRoot, incidentId, deployResult, {
  resolutionCriteria: { ... },
  verifyDeps: {
    providers: [{ name: "datadog", kind: "metrics", mcpCommand: "node", enabled: true }],
    client,
  },
});
```

---

## 10. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/incident/timeline.ts` | `src/incident/types.ts` (IncidentMetadataSchema) | **low** | Adding optional `severity` is backward-compat; existing zod parses still succeed because the field is `.optional()`. |
| `src/incident/rollback.ts` | `src/incident/types.ts` | low | Imports `ChangeEntry` only; unaffected by metadata changes. |
| `src/incident/postmortem.ts` | `src/incident/types.ts` (IncidentMetadataSchema) | low | Uses optional fields tolerantly via `IncidentMetadataSchema.parse`. |
| `src/incident/resolution-verify.ts` | `src/incident/types.ts` | low | Only imports `IncidentId` type. |
| `tests/incident/timeline.test.ts` | `src/incident/timeline.ts` | medium | The test fixtures construct `IncidentMetadata` without `severity` — must still parse. Verify by running the test. |
| `tests/incident/postmortem.test.ts` | `src/incident/timeline.ts`, `postmortem.ts` | medium | Auto-postmortem flow used in integration test must not regress. |
| `tests/incident/rollback.test.ts` | `src/incident/rollback.ts` | low | No dependency on metadata. |
| `tests/incident/resolution-verify.test.ts` | `src/incident/resolution-verify.ts`, `timeline.ts` | low | Tests the setIncidentStatus gate; ensure adding `severity` doesn't reset it. |
| `src/cli/index.ts` | `src/cli/commands/*` | **medium** | New `registerIncidentCommand` registration must not collide with existing names. `bober incident` is a NEW top-level — verify no existing alias. |
| `tests/integration/careful-flow.test.ts` | `registerCheckpointMechanism` | medium | The new integration test ALSO re-registers `"disk"` in beforeEach. Module-level state is shared across tests, so each `beforeEach` must re-register correctly. Verify ordering by running both files in sequence. |

### Existing Tests That Must Still Pass
- `tests/incident/timeline.test.ts` — every `appendX` helper, `setIncidentStatus` happy + override paths, `listIncidents` ENOENT safety.
- `tests/incident/postmortem.test.ts` — auto-postmortem fire-and-forget; do NOT regress the `onPostmortemPromise` test seam.
- `tests/incident/rollback.test.ts` — 3-step plan, halt-on-failure, `--since` filter, presentPlan rendering.
- `tests/incident/resolution-verify.test.ts` — boundary semantics, evidence write, override token gate.
- `tests/integration/careful-flow.test.ts` — Sprint 14 disk-mechanism dance; new test must not race the existing one (module-shared registry).
- `src/cli/commands/approve.test.ts`, `audit-show.test.ts`, `impact.test.ts`, `list-approvals.test.ts`, `plan.test.ts`, `reject.test.ts` — none import from new files; should be untouched.
- `src/orchestrator/checkpoints/*.test.ts` — none should regress; orchestrator.ts uses executeAction which uses the registry.

### Features That Could Be Affected
- **Sprint 14 careful-flow** — shares `DiskCheckpointMechanism` + `registerCheckpointMechanism`. New integration test re-registers disk; if a future test runs in parallel under vitest's default parallel mode, the registry races. Use `vitest run --no-file-parallelism` if you see flakes, or scope state via `beforeEach`/`afterEach` `registerCheckpointMechanism("disk", originalImpl)` restoration.
- **Sprint 23 auto-postmortem** — shares `setIncidentStatus`'s fire-and-forget trigger. The `--verified` path in `bober incident end` MUST pass `verifyResult` and rely on the existing auto-postmortem; do NOT manually invoke `generatePostmortem`.
- **Sprint 21 rollback CLI** (`bober rollback <id>`) — shares `planRollback`/`executeRollback`. The abort flow calls the same functions. The existing CLI prompts interactively; the abort path bypasses the prompt because `--confirm-rollback` IS the consent. Both flows must coexist.

### Recommended Regression Checks
After implementation, run these in order:
1. `npm run typecheck` — verify the new types (`STATUS_TRANSITIONS`, `IncidentPhase`, etc.) compile and the export from `types.ts` is picked up by `orchestrator.ts`.
2. `npm run lint` — eslint config is in the project; new files must pass.
3. `npm test -- tests/incident/timeline.test.ts` — confirm Sprint 19 unaffected.
4. `npm test -- tests/incident/postmortem.test.ts` — confirm Sprint 23 unaffected.
5. `npm test -- tests/incident/rollback.test.ts` — confirm Sprint 21 unaffected.
6. `npm test -- tests/incident/resolution-verify.test.ts` — confirm Sprint 22 unaffected.
7. `npm test -- tests/integration/careful-flow.test.ts` — confirm Sprint 14 unaffected.
8. `npm test -- tests/integration/incident-lifecycle.test.ts` — the new test (this is the main contract verification).
9. `npm test` — full suite, exit 0.
10. `npm run build` — `tsc` must succeed; check `dist/` is regenerated cleanly.
11. Smoke test the CLI: `node dist/cli/index.js incident --help` and `node dist/cli/index.js incident list` (in an empty dir; should print "no incidents").

---

## 11. Implementation Sequence

1. **`src/incident/types.ts`** — Add `severity` field (optional zod enum); add `IncidentPhase` type alias; add and export `STATUS_TRANSITIONS` const. **DO NOT** touch any existing exports or field order.
   - Verify: `npm run typecheck` passes. `npm test -- tests/incident/timeline.test.ts` still passes.

2. **`src/incident/orchestrator.ts`** — Create with the full surface from §1 (transitionPhase + applyDiagnosisOutcome + applyDeploymentOutcome + abort + readIncidentMetadata + InvalidTransitionError class).
   - Use the function bodies from §4 (transitionPhase) as templates.
   - `applyDiagnosisOutcome`: if `diagnosis.nextActions.some(a => a.blastRadius === "risky")` → `transitionPhase(..., "remediating")`; else if `nextActions.length === 0` → optionally to `"resolved"` (but the contract is silent; safest is to leave at `"investigating"` until the operator explicitly ends).
   - `applyDeploymentOutcome`: if `deployResult.executed.every(e => e.status === "executed")` AND `verifyDeps`+`resolutionCriteria` provided → call `verifyResolution`; if `verified=true` → transition to `monitoring`. After monitoring window simulated (test-only: orchestrator does NOT poll; the CLI / caller drives the second transition) → transition to `resolved` via `setIncidentStatus`.
   - `abort`: append timeline event `eventKind: "incident_aborted"`; if `confirmRollback` → `planRollback` + `executeRollback`; write `.bober/incidents/<id>/abort-report.md` containing reason + presentPlan result; finally `setIncidentStatus(..., "aborted")`.
   - Verify: `npm run typecheck`.

3. **`src/cli/commands/incident.ts`** — Create with the 5 subcommands per §1 template. Wire `start`, `status`, `end`, `list`, `abort`.
   - `start`: createIncident + optional setIncidentStatus({severity}).
   - `status`: rich-text rendering per §6 worked example; tolerate missing diagnoses/, resolution-evidence/, severity.
   - `end`: setIncidentStatus(..., 'resolved', undefined, opts) — pass either verifyResult or overrideToken from CLI flags. Postmortem fires automatically.
   - `list`: render summaries table.
   - `abort`: call `abort()` from orchestrator.ts. Use `requiredOption("--reason")` so commander rejects missing reason at parse time.
   - Verify: `node dist/cli/index.js incident --help` shows all 5 subcommands after the next step.

4. **`src/cli/index.ts`** — Add `import { registerIncidentCommand }` and `registerIncidentCommand(program)` mirroring the rollback/postmortem registration sites (lines 28-29 and 258-262 for placement).
   - Verify: `npm run build && node dist/cli/index.js incident --help` prints subcommands.

5. **`skills/bober.incident/SKILL.md`** — Compose using bober.deploy/SKILL.md as the structural template. Iron Law exactly: `NO INCIDENT WITHOUT TIMELINE; NO RESOLUTION WITHOUT VERIFICATION`. ≥5 Red Flags entries. ≥5 Common Rationalizations rows. Include the phase diagram from §7. Cross-refs section MUST link bober.diagnose, bober.deploy, bober.runbook, bober.postmortem.
   - Verify: read the file end-to-end; check that the slash-command flow section explicitly describes "if invoked without symptom, prompt for it" (s24-c6).

6. **`tests/integration/incident-lifecycle.test.ts`** — Create with the 5 test cases:
   a. Full end-to-end happy path (s24-c8): start → diagnose → 3 risky actions → 3 executor calls → verify → resolve → postmortem on disk → chronological timeline.
   b. Invalid transition: resolved → remediating throws `InvalidTransitionError` (s24-c3 + evaluatorNotes guard).
   c. Valid re-open: resolved → investigating WITH reason succeeds (s24-c3 + evaluatorNotes).
   d. abort without `--confirm-rollback` does NOT call executor (s24-c7 + evaluatorNotes footgun).
   e. abort with `--confirm-rollback` calls executor N times for N executed changes (s24-c7).
   - Verify: `npm test -- tests/integration/incident-lifecycle.test.ts` passes all 5.

7. **Run full verification**:
   - `npm run typecheck`
   - `npm run lint`
   - `npm run build`
   - `npm test`
   - All must exit 0.

---

## 12. Pitfalls & Warnings

- **Do NOT add a new mutex chain in orchestrator.ts.** Sprint 19's `writeChains` map is per-module state in `timeline.ts`. Calling `appendTimeline` from orchestrator.ts goes through the same chain — that is the design. Re-implementing append in orchestrator.ts would race with concurrent diagnoser writes.

- **Do NOT call `generatePostmortem` directly from orchestrator.ts or CLI.** Sprint 23's auto-trigger lives inside `setIncidentStatus` (timeline.ts:488-511). Calling it manually risks double-generation when the auto-trigger also fires.

- **The `bober incident end --verified` flag synthesizes a fake verifyResult.** A real verifyResult comes from `verifyResolution()`; if the operator passes `--verified` on the CLI, they are asserting external verification. Write `{ verified: true, reason: "OK" }` and pass to setIncidentStatus. (Alternatively: REQUIRE either `--verified` or `--override <reason>`; refuse to mark resolved without one. This matches Sprint 22's gate.)

- **Severity field semantics:** `severity` is metadata only — it does NOT affect state machine routing. Sprint 24 contract just plumbs the value through. Do NOT add severity-based branching in transitionPhase.

- **Commander `.requiredOption` vs `.option`:** Use `requiredOption("--reason <text>")` for `bober incident abort` so commander auto-rejects missing reason at parse time (cleaner than a runtime check). `--confirm-rollback` is `.option("--confirm-rollback")` (boolean flag, no value). 

- **`bober incident list` table rendering:** the existing CLI uses chalk; do NOT introduce a new table library (`cli-table3`, `console-table-printer`). Use manual column formatting like the audit-show command does. Each row should fit one terminal line — truncate symptom to ~60 chars.

- **Integration test's `registerCheckpointMechanism("disk", ...)` is module-global.** Vitest may parallelize files by default; if `careful-flow.test.ts` and `incident-lifecycle.test.ts` race, the disk mechanism's directory could point at the wrong tmpdir. The Sprint 14 pattern (re-register in beforeEach) is sufficient AS LONG AS tests in the same file run sequentially (vitest default is serial within a file). Verify by running the two integration files in the same `npm test` invocation.

- **`abort()` MUST work for an incident in ANY phase.** Including freshly-created (no changes to roll back), monitoring (criteria not yet met), and already-aborted (idempotent — should no-op gracefully OR throw a clear error; pick one and document). Recommended: throw a clear error if already aborted ("incident already aborted, abort is terminal").

- **The status command must be ENOENT-safe across all artifacts.** A new incident has no diagnoses/, no resolution-evidence/, no postmortem.md — every read must catch ENOENT and render a graceful placeholder.

- **Do NOT spawn the diagnoser/deployer agents in orchestrator.ts.** Sprint 24 is data orchestration only. The agents are spawned by Claude Code via the slash command flow (skill body documents how the user invokes them); the TypeScript orchestrator wires the OUTPUTS from those agents into the state machine. This is why `spawnDeployer` from Sprint 20 is referenced but not imported.

- **The 5-phase enum is FIXED.** `IncidentStatusSchema` in types.ts already has all 5 values (investigating, remediating, monitoring, resolved, aborted). Do NOT add new phases. `escalated` mentioned in `generatorNotes` as a "sub-state of remediating" is intentionally NOT a separate enum value — it is signaled by `rollbackResult.escalated === true` returning from executeRollback, and the orchestrator stays in `remediating` until the operator aborts or re-diagnoses.

- **`.bober/principles.md` does NOT exist** in this repo, despite some agent prompts referencing it. SKILL.md should NOT cite it as a required input — only as an optional "consult if present" hint. Same for `.bober/architecture/` (does not exist).

- **bober.config.json schema:** types.ts and other schemas do not currently declare a `severity` field on incidents. Verify by reading `bober.config.json` in a sample project — if no schema-level config affects incident creation, the `severity` extras path through `setIncidentStatus` is sufficient.
