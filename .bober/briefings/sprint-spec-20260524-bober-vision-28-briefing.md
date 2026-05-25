# Sprint Briefing: Config migration + opt-in local-only telemetry hooks

**Contract:** sprint-spec-20260524-bober-vision-28
**Generated:** 2026-05-25T00:00:00Z

This is the FINAL sprint of spec-20260524-bober-vision (28/28). Its two-part charter:

1. **Schema back-compat finalization.** The on-disk `bober.config.json` in this repo (and in every user repo) MUST parse without errors against the post-Sprint-28 schema. All new fields are additive with defaults preserving today's autopilot behavior. The new `telemetry` section is added here.
2. **Opt-in, local-only telemetry hooks.** A new `src/telemetry/` module emits JSONL events to `.bober/telemetry/<date>.jsonl` only when `config.telemetry.enabled === true`. Zero network egress (enforced by ESLint rule). Privacy-by-construction: IDs/counts/enums only — NEVER user-content strings.
3. **Spec completion** — flip `.bober/specs/spec-20260524-bober-vision.json` `status` to `"completed"`, update `.bober/progress.md`, append a `spec-completed` event to `.bober/history.jsonl`. ONLY after the Sprint 27 four-modes regression test still passes.

---

## 1. Target Files

### src/config/schema.ts (modify)

**Current state (lines 268-298 — extension point):**

```ts
// ── Incident Section (Sprint 23 — postmortem automation) ─────────────

export const IncidentSectionSchema = z.object({
  /** When true (default), an incident transition to status='resolved' triggers
   *  asynchronous postmortem generation. ... Sprint 23. */
  autoPostmortem: z.boolean().default(true),
});
export type IncidentSection = z.infer<typeof IncidentSectionSchema>;

// ── Full Config ─────────────────────────────────────────────────────

export const BoberConfigSchema = z.object({
  project: ProjectSectionSchema,
  planner: PlannerSectionSchema,
  curator: CuratorSectionSchema.optional(),
  generator: GeneratorSectionSchema,
  evaluator: EvaluatorSectionSchema,
  sprint: SprintSectionSchema,
  pipeline: PipelineSectionSchema,
  commands: CommandsSectionSchema,
  graph: GraphSectionSchema.optional(),
  codeReview: CodeReviewSectionSchema.optional(),
  // ── Sprint 16: observability MCP plugin slots ──
  observability: ObservabilitySectionSchema.optional(),
  // ── Sprint 23: incident postmortem automation ──
  incident: IncidentSectionSchema.optional(),
});
```

**Required edits:**
1. Add `TelemetrySectionSchema` between `IncidentSectionSchema` and `BoberConfigSchema` (mirror the `IncidentSectionSchema` shape — `z.object` with all-default fields):

```ts
// ── Telemetry Section (Sprint 28 — opt-in local-only event log) ──────

export const TelemetrySectionSchema = z.object({
  /** When true, the orchestrator appends JSONL events to .bober/telemetry/<date>.jsonl
   *  for tracking checkpoint approval rates, incident resolution times, agent retry
   *  counts. Default false (no events written). No network egress under any condition
   *  — see ESLint no-restricted-imports rule in eslint.config.js for src/telemetry/. */
  enabled: z.boolean().default(false),
});
export type TelemetrySection = z.infer<typeof TelemetrySectionSchema>;
```

2. Extend `BoberConfigSchema` with a final optional field:

```ts
  // ── Sprint 28: opt-in local-only telemetry ──
  telemetry: TelemetrySectionSchema.optional(),
```

3. NO changes needed to `PartialBoberConfigSchema` — `deepPartial()` automatically picks up the new field.

4. NO changes needed to `createDefaultConfig` — telemetry stays unset (parses to undefined), preserving "off by default" without writing the field into freshly-init'd configs.

**Critical back-compat invariant:** The on-disk `bober.config.json` (which has NO `telemetry`, NO `observability`, NO `incident`, AND has `pipeline` with only 5 of the 9 fields) MUST still parse with zero errors. The existing `.optional()` chains in lines 285-296 give us this for free for sections; the per-field defaults on `PipelineSectionSchema` (lines 147-173) give it for free for new fields inside an existing section.

**Imports this file uses:** `import { z } from "zod";` (line 1) — no new imports needed.

**Imported by (READERS — DO NOT BREAK):**
- `src/config/loader.ts:6-9` — uses `BoberConfigSchema` + `PartialBoberConfigSchema`
- `src/config/index.ts` — re-exports types
- 41 call sites of `loadConfig` across `src/cli/commands/*` and `src/mcp/tools/*` (grep confirmed). All consume `BoberConfig` as a type — they will keep compiling because we ADD an optional field.

**Test file:** `tests/config/graph-schema.test.ts` (exists — contains backcompat patterns for Sprints 14, 16, 23). Pattern to mirror: add a `describe("Sprint 28 — backward-compat: ...")` block at the bottom.

---

### src/config/loader.ts (modify — minimal touch)

**Relevant section (lines 184-230 — deep-merge defaults block):**

```ts
  // Build a complete config by deep-merging defaults with user overrides
  const merged = deepMerge(
    {
      project: { /* ... */ },
      planner: defaults.planner ?? { /* ... */ },
      // ...
      pipeline: defaults.pipeline ?? {
        maxIterations: 20,
        maxCheckpointIterations: 3,
        // ... existing fields
        allowAutopilotRiskyActions: false,
      },
      commands: defaults.commands ?? {},
    },
    partial as Partial<BoberConfig>,
  );
```

**Required edit:** NONE required. `telemetry` is added as an optional section with all-default fields — the post-merge `BoberConfigSchema.safeParse(merged)` at line 233 fills in defaults from the schema. Confirmed by the Sprint 23 incident section pattern: `IncidentSectionSchema` is also `.optional()` on the full schema and is NOT touched in `loader.ts`'s merge block.

**Optional polish (NOT required for back-compat):** If you want `cfg.telemetry` to always be defined (even when section absent) so consumers don't need `cfg.telemetry?.enabled`, add a `defaults.telemetry ?? { enabled: false }` line to the deepMerge base. The contract success criterion s28-c1 says `telemetry.enabled=false` should be the resolved default — verify whether `cfg.telemetry` should be `{ enabled: false }` (eager) or `undefined` (lazy). The Sprint 23 `incident` section uses LAZY (stays undefined when section absent — see `tests/config/graph-schema.test.ts:124` which asserts `config.observability` is undefined). FOLLOW the Sprint 23 convention: leave `telemetry` undefined when absent; emitters use `config.telemetry?.enabled === true` (strict-true check, default-off).

---

### src/cli/index.ts (modify)

**Relevant sections (lines 25-31 + 266-271 — command registration block):**

```ts
import { registerAuditCommand } from "./commands/audit-show.js";
import { registerRollbackCommand } from "./commands/rollback.js";
import { registerPostmortemCommand } from "./commands/postmortem.js";
import { registerIncidentCommand } from "./commands/incident.js";
import { registerPlaybookCommand } from "./commands/playbook.js";

// ... later ...

  // ── playbook ─────────────────────────────────────────────────────
  registerPlaybookCommand(program);

  // ── Parse ───────────────────────────────────────────────────────
  await program.parseAsync(process.argv);
```

**Required edits:**
1. Add two imports after `registerPlaybookCommand`:
   ```ts
   import { registerConfigCommand } from "./commands/config.js";
   import { registerTelemetryCommand } from "./commands/telemetry.js";
   ```
2. Add two `register*` calls before `// ── Parse ──`:
   ```ts
   // ── config ───────────────────────────────────────────────────────
   registerConfigCommand(program);

   // ── telemetry ────────────────────────────────────────────────────
   registerTelemetryCommand(program);
   ```

**Test file:** none. CLI registration is integration-tested via the colocated command tests.

---

### src/cli/commands/config.ts (create)

**Directory pattern:** Files in `src/cli/commands/` use kebab-case names (e.g., `audit-show.ts`, `list-approvals.ts`) when the subcommand has a hyphen; otherwise plain names (`incident.ts`, `playbook.ts`, `postmortem.ts`). Use `config.ts`.

**Most similar existing file:** `src/cli/commands/postmortem.ts` — nested subcommand pattern with `pmCmd.command("generate <id>")` and `pmCmd.command("show <id>")`. Use this as the structural template.

**Structural template (mirror postmortem.ts):**

```ts
/**
 * `bober config migrate` — write all new schema fields with default values into
 *   bober.config.json. Informative; back-compat parsing handles missing fields
 *   transparently. Useful for users who want their config file to be self-documenting.
 *
 * Sprint 28 — src/cli/commands/config.ts
 */

import { readFile, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

export function registerConfigCommand(program: Command): void {
  const cfgCmd = program
    .command("config")
    .description("Inspect and migrate bober.config.json");

  cfgCmd
    .command("migrate")
    .description("Add all new schema fields with default values to bober.config.json")
    .option("--dry-run", "Print the merged config without writing")
    .action(async (opts: { dryRun?: boolean }) => {
      const projectRoot = await resolveRoot();
      const configPath = join(projectRoot, "bober.config.json");
      try {
        const raw = await readFile(configPath, "utf-8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;

        // Add new sections explicitly, preserving any existing values.
        const migrated = {
          ...parsed,
          pipeline: { mode: "autopilot", checkpointOverrides: {}, allowAutopilotRiskyActions: false, ...((parsed.pipeline as object) ?? {}) },
          observability: { providers: [], ...((parsed.observability as object) ?? {}) },
          incident: { autoPostmortem: true, ...((parsed.incident as object) ?? {}) },
          telemetry: { enabled: false, ...((parsed.telemetry as object) ?? {}) },
        };

        const out = JSON.stringify(migrated, null, 2) + "\n";

        if (opts.dryRun) {
          process.stdout.write(out);
          return;
        }

        // Backup then write.
        await copyFile(configPath, configPath + ".bak");
        await writeFile(configPath, out, "utf-8");
        process.stdout.write(chalk.green(`Migrated ${configPath} (backup: ${configPath}.bak)\n`));
      } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") {
          process.stderr.write(chalk.yellow(`No bober.config.json found at ${configPath}.\n`));
          process.exitCode = 1;
          return;
        }
        process.stderr.write(chalk.red(`Failed to migrate: ${err instanceof Error ? err.message : String(err)}\n`));
        process.exitCode = 1;
      }
    });
}
```

**Test file:** `src/cli/commands/config.test.ts` (create — colocated per Sprint 13 precedent established by `src/cli/commands/audit-show.test.ts`).

---

### src/cli/commands/telemetry.ts (create)

**Subcommands required (s28-c6):**
- `bober telemetry status` — prints `enabled: <bool>` and event counts grouped by `eventType` from today's `.bober/telemetry/<YYYY-MM-DD>.jsonl` (and possibly recent files).
- `bober telemetry purge` — deletes ALL files in `.bober/telemetry/` after a `prompts.confirm` y/N prompt (mirror `src/cli/commands/rollback.ts:81-100` confirm-pattern using the `prompts` package — confirmed installed).
- `bober telemetry export` — concatenates every `.bober/telemetry/*.jsonl` to stdout for offline analysis.

**Structural template (mirror playbook.ts list/show/search pattern):**

```ts
/**
 * `bober telemetry <status|purge|export>` — local telemetry inspection CLI.
 *
 * Sprint 28 — src/cli/commands/telemetry.ts
 */

import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import prompts from "prompts";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { loadConfig } from "../../config/loader.js";

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

export function registerTelemetryCommand(program: Command): void {
  const telCmd = program
    .command("telemetry")
    .description("Inspect, export, or purge local telemetry events (opt-in, local-only)");

  telCmd
    .command("status")
    .description("Print whether telemetry is enabled and recent event counts")
    .action(async () => {
      const projectRoot = await resolveRoot();
      const config = await loadConfig(projectRoot);
      const enabled = config.telemetry?.enabled === true;
      process.stdout.write(`telemetry.enabled: ${enabled ? chalk.green("true") : chalk.gray("false")}\n`);
      // Tabulate event counts from .bober/telemetry/*.jsonl ...
      // (Use readdir of .bober/telemetry, readFile each, count per eventType.)
    });

  telCmd
    .command("purge")
    .description("Delete all .bober/telemetry/*.jsonl files (requires confirmation)")
    .action(async () => {
      const projectRoot = await resolveRoot();
      const telDir = join(projectRoot, ".bober", "telemetry");
      const answer = await prompts({
        type: "confirm",
        name: "ok",
        message: `Delete all telemetry files in ${telDir}?`,
        initial: false,
      });
      if (!answer.ok) {
        process.stdout.write(chalk.gray("Aborted.\n"));
        return;
      }
      await rm(telDir, { recursive: true, force: true });
      process.stdout.write(chalk.yellow(`Purged ${telDir}.\n`));
    });

  telCmd
    .command("export")
    .description("Print all telemetry events as JSONL for offline analysis")
    .action(async () => {
      const projectRoot = await resolveRoot();
      // Concat every .bober/telemetry/*.jsonl to stdout ...
    });
}
```

**Test file:** `src/cli/commands/telemetry.test.ts` (create — colocated).

---

### src/telemetry/ (create)

**Directory pattern:** New top-level module under `src/`. Mirror `src/incident/` structure:
- `src/telemetry/types.ts` — Zod schemas + types (mirror `src/incident/types.ts` minimal shape)
- `src/telemetry/emit.ts` — the `emit()` function (the public API)
- `src/telemetry/config.ts` — `isTelemetryEnabled(projectRoot)` and `resolveTelemetryPath(projectRoot)` helpers

**Most similar existing files:**
- For the JSONL writer: `src/orchestrator/checkpoints/audit.ts:86-128` (`appendOneLine`). This is the GOLD STANDARD pattern in this repo: `fs.open(path, O_WRONLY|O_APPEND|O_CREAT, 0o600)` + explicit `fh.chmod(0o600)` + per-file Promise-chain mutex. **MIRROR THIS, including the comment block explaining why `appendFile` is rejected.** (See `src/incident/timeline.ts:11-15` for the verbatim explanation of why `appendFile` is unsafe across Node versions.)
- For the event-shape Zod schema: `src/state/history.ts:25-44`.

**Structural template for `src/telemetry/emit.ts`:**

```ts
/**
 * Opt-in local-only telemetry event emitter (Sprint 28).
 *
 * When config.telemetry.enabled === true, appends one newline-terminated JSON
 * line to .bober/telemetry/<YYYY-MM-DD>.jsonl. When disabled (default), emit()
 * is a no-op and performs ZERO file IO.
 *
 * File is created with mode 0600 on first append via fs.open(O_WRONLY|O_APPEND|
 * O_CREAT). Mirrors the Sprint 13 audit pattern verbatim (see audit.ts:86 for
 * the rationale on why fs.appendFile is NOT used).
 *
 * NETWORK EGRESS: forbidden by design. No import of node:http, node:https,
 * node:net, node:tls, undici, or fetch — enforced by ESLint no-restricted-imports
 * rule scoped to src/telemetry/** in eslint.config.js.
 *
 * PRIVACY: event payloads MUST be IDs / counts / enum outcomes only. NEVER pass
 * user-content strings (feedbackText, prompts, file contents, MCP response
 * bodies). Reviewers grep `emit(` across src/ to enforce this discipline.
 *
 * Sprint 28 — src/telemetry/emit.ts
 */

import { open, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

import type { BoberConfig } from "../config/schema.js";
import { logger } from "../utils/logger.js";

export type TelemetryEventType =
  | "checkpoint-approved"
  | "checkpoint-rejected"
  | "checkpoint-edited"
  | "sprint-pass"
  | "sprint-fail-retry"
  | "incident-resolved"
  | "incident-aborted"
  | "agent-spawn"
  | "agent-error";

/** Allowed payload fields. NO string values from user input. */
export interface TelemetryEventData {
  runId?: string;
  incidentId?: string;
  specId?: string;
  sprintId?: string;
  contractId?: string;
  agentName?: string;
  checkpointId?: string;
  iteration?: number;
  durationMs?: number;
  outcome?: string;       // ENUM only (e.g., "passed", "failed")
  retryCount?: number;
  errorKind?: string;     // ENUM only (e.g., "timeout", "rate-limit")
}

const writeChain = new Map<string, Promise<void>>();

function telemetryDir(projectRoot: string): string {
  return join(projectRoot, ".bober", "telemetry");
}

function telemetryPath(projectRoot: string): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return join(telemetryDir(projectRoot), `${date}.jsonl`);
}

/** Emit a telemetry event. No-op when telemetry.enabled !== true. */
export async function emit(
  projectRoot: string,
  config: BoberConfig,
  eventType: TelemetryEventType,
  data: TelemetryEventData = {},
): Promise<void> {
  if (config.telemetry?.enabled !== true) return;

  const event = {
    timestamp: new Date().toISOString(),
    eventType,
    ...data,
  };

  const filePath = telemetryPath(projectRoot);

  const prev = writeChain.get(filePath) ?? Promise.resolve();
  const next = prev.then(async () => {
    await mkdir(telemetryDir(projectRoot), { recursive: true });
    const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT;
    const fh = await open(filePath, flags, 0o600);
    try {
      await fh.chmod(0o600);
      await fh.write(JSON.stringify(event) + "\n");
    } finally {
      await fh.close();
    }
  }).catch((err: unknown) => {
    logger.warn(`[telemetry] Failed to emit ${eventType}: ${err instanceof Error ? err.message : String(err)}`);
  });
  writeChain.set(filePath, next);
  return next;
}
```

**Emit call-site map (~15-20 sites total per generatorNotes):** wire `emit()` AFTER existing `appendHistory()` calls in `src/orchestrator/pipeline.ts` at:
- line 388: `event: "sprint-passed"` → `emit(projectRoot, config, "sprint-pass", { sprintId: currentContract.contractId, iteration, durationMs: ... })`
- line 463: `event: "evaluation-failed"` (with `iteration < maxIterations`) → `emit("sprint-fail-retry", { sprintId, iteration, retryCount: iteration })`
- Wrap each `runWithAudit` outcome — when the audit `outcome` resolves, also `emit("checkpoint-approved"|"checkpoint-rejected"|"checkpoint-edited", { checkpointId, iteration, durationMs })`. Cleanest seam: extend `runWithAudit` in `src/orchestrator/checkpoints/audit.ts:275-333` to call `emit()` after `recordApproval()` — BUT this would couple the audit module to telemetry. PREFER: in the pipeline.ts wrapper that already calls `runWithAudit`, fire-and-forget `emit()` based on the returned outcome. This keeps the telemetry module a leaf.
- `src/incident/timeline.ts:481-510` — inside the `setIncidentStatus` resolved branch (after the timeline event write) → `emit("incident-resolved", { incidentId, durationMs })` where `durationMs = Date.now() - new Date(existing.createdAt).getTime()`.
- `src/incident/orchestrator.ts:340` (the abort emit) → `emit("incident-aborted", { incidentId })`.
- Agent spawn seams: top of `runCurator` (`src/orchestrator/curator-agent.ts:57`), `runGenerator`, `runEvaluatorAgent`, etc. → `emit("agent-spawn", { agentName: "curator", contractId })`. On thrown error in those functions → `emit("agent-error", { agentName, errorKind: classifyError(err) })`. NOTE: pass `config` through — these functions already accept `config: BoberConfig`.

**Privacy bar (s28-c5):** every `emit(...)` payload MUST consist only of fields from the `TelemetryEventData` interface above. NEVER write `feedbackText`, `description`, `command`, `mcpResponseBody`, or any string sourced from user/LLM/MCP input.

---

### eslint.config.js (modify)

**Current state (lines 5-45):**

```js
export default [
  js.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: { /* ... */ },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [ /* ... */ ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    ignores: ["dist/", "node_modules/", "templates/"],
  },
];
```

**Required edit:** Add a third array element (a third flat-config block) BEFORE the `ignores` block, scoped to `src/telemetry/`:

```js
  {
    files: ["src/telemetry/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "undici", message: "Network access forbidden in telemetry module (Sprint 28 — local-only)" },
            { name: "got", message: "Network access forbidden in telemetry module" },
            { name: "axios", message: "Network access forbidden in telemetry module" },
            { name: "node-fetch", message: "Network access forbidden in telemetry module" },
          ],
          patterns: [
            { group: ["http", "https", "net", "tls", "dgram", "node:http", "node:https", "node:net", "node:tls", "node:dgram"], message: "Network/socket imports forbidden in src/telemetry/ — Sprint 28 local-only guarantee" },
          ],
        },
      ],
      "no-restricted-globals": ["error", { name: "fetch", message: "Network access forbidden in telemetry module" }],
    },
  },
```

**Verification per s28-c4:** write a temp file `src/telemetry/_lint-check.ts` containing `import "http";`, run `npm run lint`, confirm it errors. Then delete the file. (Document this as the "regression-prevention test" per evaluatorNotes.)

---

### VISION.md (modify)

**Current state (lines 347-350):**

```md
### `telemetry` section — Sprint 28

`telemetry.enabled` will be added in Sprint 28. It is not present in the current schema. Do not
set this field before Sprint 28 ships.
```

**Required edit:** REPLACE this paragraph with a full configuration-reference subsection mirroring the `incident` section format (lines 333-345):

```md
### `telemetry` section

| Field | Type | Default | Since | Description |
|-------|------|---------|-------|-------------|
| `telemetry.enabled` | `boolean` | `false` | Sprint 28 | When `true`, the orchestrator appends opt-in local-only JSONL events to `.bober/telemetry/<YYYY-MM-DD>.jsonl` for tracking checkpoint approval rates, incident resolution times, agent retry counts, and sprint pass/fail counts. Default `false` — no files written. No network egress under any condition (enforced by an ESLint no-restricted-imports rule in `eslint.config.js` scoped to `src/telemetry/`). Event payloads contain IDs, durations, counts, and enum outcomes ONLY — no user-content strings, no MCP response bodies, no feedback text. Inspect with `bober telemetry status`, export with `bober telemetry export`, delete with `bober telemetry purge`. |
```

---

### AGENTS.md (modify)

**Required edit:** Add a new H2 section (anywhere natural — e.g., after "Evidence Requirements") titled "Telemetry Guarantee" with:
- Opt-in (default off)
- Local-only (no network egress, ESLint-enforced)
- What is collected (IDs, counts, durations, enum outcomes)
- What is NEVER collected (user code, feedback text, MCP responses, prompts)
- How to disable / purge (`bober telemetry purge`)

Match the voice of existing AGENTS.md sections (capitalized invariants, file:line evidence references).

---

### .bober/specs/spec-20260524-bober-vision.json (modify — LAST STEP)

**Required edit:** Change line ~7 from:
```json
  "status": "draft",
```
to:
```json
  "status": "completed",
  "completedAt": "<ISO-8601 now>",
```

Do this ONLY after the Sprint 27 four-modes regression test (`tests/e2e/four-modes.test.ts`) passes and the full `npm run typecheck && npm run lint && npm run build && npm test` sweep is green.

---

### .bober/progress.md (modify)

**Current state (line 137-141):**

```md
### Tier 4 — Integration & polish (sprints 26-28)
26. [completed] VISION.md + README update — Passed iter 1 ...
27. [proposed] End-to-end four-mode integration test — Fixture project ...
28. [proposed] Config migration + opt-in local-only telemetry — Backward-compat ...
```

Sprint 27 line should already be `[completed]` (commit `733a863`). Required edit: change `28. [proposed]` to `[completed]` with a one-line summary. Add a final block:

```md
**Tier 4 COMPLETE** — 3/3 sprints passed (sprints 26-28). Spec status='completed'.

## Spec Completion Summary: spec-20260524-bober-vision
- Total sprints: 28/28 passed
- Total tests: <count from npm test output>
- Branch: bober/bober-vision
- ...
```

---

### .bober/history.jsonl (append)

**Format (per `src/state/history.ts:37-44` HistoryEntrySchema):**

```jsonc
{"timestamp":"<ISO>","event":"spec-completed","phase":"complete","details":{"specId":"spec-20260524-bober-vision","totalSprints":28,"ambiguityScoreAtStart":5,"ambiguityScoreFinal":5,"deferredDecisions":[]}}
```

Append via `appendHistory(projectRoot, entry)` — DO NOT hand-write the line. Use the canonical helper at `src/state/history.ts:51`. Per evaluatorNotes: include `totalSprints`, `ambiguityScore at start vs revised`, `list of any deferred decisions documented in resolvedClarifications`.

---

## 2. Patterns to Follow

### Pattern: JSONL append with mode 0600 (the gold standard)
**Source:** `src/orchestrator/checkpoints/audit.ts:86-128`

```ts
async function appendOneLine(projectRoot: string, runId: string, record: ApprovalRecord): Promise<void> {
  const dir = join(projectRoot, ".bober", "audits");
  await mkdir(dir, { recursive: true });
  const path = getAuditPath(projectRoot, runId);

  const line = JSON.stringify(record) + "\n";

  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT;
  const fh = await open(path, flags, 0o600);
  try {
    await fh.chmod(0o600);   // umask may have reduced it — force back to 0600
    await fh.write(line);
  } finally {
    await fh.close();
  }
}
```

**Rule:** ALWAYS use `fs.open(O_WRONLY|O_APPEND|O_CREAT, 0o600)` + explicit `fh.chmod(0o600)`. NEVER use `fs.appendFile` for telemetry/audit/incident JSONL files — it does not reliably honor the mode argument across Node versions (verbatim warning from `src/incident/timeline.ts:11-13` and `src/orchestrator/checkpoints/audit.ts:11`).

### Pattern: Per-key Promise-chain mutex (no external locks)
**Source:** `src/orchestrator/checkpoints/audit.ts:78-83 + 141-152`

```ts
const writeChains = new Map<string, Promise<void>>();

export async function recordApproval(/* ... */): Promise<void> {
  const prev = writeChains.get(runId) ?? Promise.resolve();
  const next = prev.then(() => appendOneLine(projectRoot, runId, record));
  writeChains.set(runId, next.catch(() => {}));  // swallow on chain pointer, propagate to caller
  return next;
}
```

**Rule:** When multiple async callers may append to the same file, serialize via a Map<key, Promise>. Swallow errors on the stored chain pointer (so subsequent writes are not blocked) but propagate via the returned promise. Mirror this for `src/telemetry/emit.ts` using `filePath` as the key.

### Pattern: Zod section schema with all-default fields + optional on Full Config
**Source:** `src/config/schema.ts:270-278 + 296` (Sprint 23 IncidentSectionSchema)

```ts
export const IncidentSectionSchema = z.object({
  autoPostmortem: z.boolean().default(true),
});

export const BoberConfigSchema = z.object({
  // ...
  incident: IncidentSectionSchema.optional(),
});
```

**Rule:** Every new config section must be `z.object({ ...all-default fields })` and added to `BoberConfigSchema` as `.optional()`. This is the back-compat invariant: when the section is absent in the JSON file, Zod accepts it; when present (even as `{}`), defaults fill in. Mirror exactly for `TelemetrySectionSchema`.

### Pattern: CLI nested subcommands with kebab-case
**Source:** `src/cli/commands/postmortem.ts:24-95` + `src/cli/commands/playbook.ts:36-166`

```ts
export function registerPostmortemCommand(program: Command): void {
  const pmCmd = program
    .command("postmortem")
    .description("Inspect or (re)generate incident postmortems");

  pmCmd.command("generate <incidentId>").description("...").action(async (id) => { /* ... */ });
  pmCmd.command("show <incidentId>").description("...").action(async (id) => { /* ... */ });
}
```

**Rule:** A subcommand group is `program.command("group").description(...)` followed by `groupCmd.command("verb [args]")` for each verb. Use this for both `bober config <verb>` and `bober telemetry <verb>`.

### Pattern: CLI error handling — Pattern C (no throw from action handlers)
**Source:** `src/cli/commands/playbook.ts:9-13` (header comment), `src/cli/commands/incident.ts:11-15`

> Error handling: CLI handlers MUST NOT throw. They set `process.exitCode=1` and return on all errors (Pattern C per briefing). Top-level `main().catch()` is the last-ditch fallback, not the primary error path.

```ts
.action(async (...) => {
  try {
    /* work */
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      process.stderr.write(chalk.yellow(`No file found at ${path}.\n`));
      process.exitCode = 1;
      return;
    }
    process.stderr.write(chalk.red(`Failed: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
  }
})
```

**Rule:** Wrap action bodies in try/catch. Distinguish ENOENT (yellow) from generic errors (red). NEVER re-throw — set exitCode and return.

### Pattern: Stderr-warning idiom (loader warns, does not throw)
**Source:** `src/config/loader.ts:248-253`

```ts
if (cfg.pipeline.mode === "careful" && cfg.pipeline.checkpointMechanism === "noop") {
  process.stderr.write(
    "warn: pipeline.mode='careful' with checkpointMechanism='noop' — checkpoints will auto-approve. " +
    "Did you mean 'disk' or 'cli'?\n",
  );
}
```

**Rule:** Use `process.stderr.write` (NOT `console.warn`) for loader-time warnings. Match this voice in any new warnings (e.g., if telemetry directory writes fail).

### Pattern: prompts confirm for destructive CLI actions
**Source:** `src/cli/commands/rollback.ts:21 + ~95-110` (uses `prompts.confirm`)

```ts
import prompts from "prompts";

const answer = await prompts({
  type: "confirm",
  name: "ok",
  message: `Delete all telemetry files in ${telDir}?`,
  initial: false,
});
if (!answer.ok) {
  process.stdout.write(chalk.gray("Aborted.\n"));
  return;
}
```

**Rule:** Any destructive CLI command (`telemetry purge`) must prompt with `initial: false`. Honor SIGINT (prompts returns `{ok: undefined}` on Ctrl-C — treat as abort).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `appendHistory` | `src/state/history.ts:51` | `(projectRoot, HistoryEntry) → Promise<void>` | Validated JSONL append to `.bober/history.jsonl`. Use for the `spec-completed` event. |
| `loadHistory` | `src/state/history.ts:74` | `(projectRoot) → Promise<HistoryEntry[]>` | Load all history entries, skipping malformed lines. |
| `updateProgress` | `src/state/history.ts:108` | `(projectRoot, SprintContract[], PlanSpec\|null) → Promise<void>` | Re-render `progress.md` from contract state. NOT used here — progress.md is a narrative doc the human edits; we append a Spec Completion Summary by hand. |
| `loadConfig` | `src/config/loader.ts:141` | `(projectRoot) → Promise<BoberConfig>` | Resolution: find file → migrateV1 → partial parse → deepMerge defaults → full parse. Telemetry consumers read via this. |
| `configExists` | `src/config/loader.ts:90` | `(projectRoot) → Promise<boolean>` | True if bober.config.json (or `.bober/config.json`) exists. |
| `findProjectRoot` | `src/utils/fs.ts` (used everywhere in CLI commands) | `() → Promise<string\|null>` | Walks up from cwd to find the project root. Always use this in new CLI commands (see `resolveRoot()` helper duplicated in every CLI file). |
| `ensureDir` | `src/state/helpers.ts` (imported by `src/state/history.ts:7`) | `(dirPath) → Promise<void>` | mkdir -p wrapper. |
| `runWithAudit` | `src/orchestrator/checkpoints/audit.ts:275` | `({projectRoot, runId, checkpointId, mechanism, iteration, fn}) → Promise<T>` | The canonical checkpoint wrapper. It already writes ApprovalRecords. Telemetry will fire AFTER its outcome resolves (in the pipeline caller, NOT inside this function — keep telemetry module a leaf). |
| `recordApproval` | `src/orchestrator/checkpoints/audit.ts:141` | `(projectRoot, runId, ApprovalRecord) → Promise<void>` | Per-runId mutex-serialized JSONL append to `.bober/audits/<runId>.jsonl`. Mirror its mutex pattern. |
| `appendOneLine` | `src/incident/timeline.ts:65` (and `audit.ts:86`) | `(filePath, record) → Promise<void>` | The canonical mode-0600 single-line append. Duplicate this in `src/telemetry/emit.ts` (do not import — different file paths, different mutex). |
| `appendTimeline` | `src/incident/timeline.ts:212` | `(projectRoot, incidentId, TimelineEvent) → Promise<void>` | Timeline JSONL append (per-incidentId mutex). The setIncidentStatus emit-site reference. |
| `chalk` (red/yellow/green/cyan/gray/bold) | `chalk` npm package (already a dep) | colorize output | Use for all CLI output. |
| `prompts` | `prompts` npm package (used by `src/cli/commands/rollback.ts`) | interactive prompts | Use for `telemetry purge` confirmation. |
| `logger.warn` / `logger.info` | `src/utils/logger.ts` | structured logger | Use for non-fatal telemetry write failures (mirror `audit.ts:325`). |
| `sanitizeError` | `src/mcp/external-client.ts` (imported as redaction reference) | `(err) → string` | Redacts KEY=VALUE tokens from error messages. Reference precedent for the "no secret leakage" principle — Sprint 28 telemetry should not need this because we only emit IDs/enums, but the discipline is the source of truth. |

---

## 4. Prior Sprint Output

### Sprint 14: Mode + mechanism config
**Created/modified:** `src/config/schema.ts` (PipelineSectionSchema — added mode, checkpointMechanism, checkpointOverrides, maxCheckpointIterations, approvalTimeoutMs, prPollMs, allowAutopilotRiskyActions); `src/orchestrator/checkpoints/registry.ts` (`resolveCheckpointMechanismName`).
**Connection:** Established the precedent that all new pipeline fields have defaults (`autopilot`, `noop`, `{}`, `86400000`, etc.) — backward-compat invariant lives in `tests/config/graph-schema.test.ts:161-232`. Sprint 28 must preserve this invariant for the on-disk `bober.config.json`.

### Sprint 16: Observability MCP plugin slots
**Created:** `src/config/schema.ts:235-266` (`ObservabilityProviderSchema`, `ObservabilitySectionSchema` — providers default []).
**Connection:** Reference for adding a NEW section as `.optional()` on `BoberConfigSchema`. See `tests/config/graph-schema.test.ts:111-159` for the canonical backcompat test pattern Sprint 28 must reuse.

### Sprint 19: Incident timeline tracking
**Created:** `src/incident/timeline.ts` (the per-incidentId mutex pattern + appendOneLine + setIncidentStatus + autoPostmortem hook).
**Connection:** Source of the "double-write" pattern (`appendObservation` writes BOTH to `observations.jsonl` AND `timeline.jsonl` in the same mutex tick). Telemetry does NOT need double-write (only one file: today's date.jsonl), but the per-key mutex pattern carries over.

### Sprint 23: bober-postmortemer + IncidentSectionSchema
**Created:** `src/config/schema.ts:270-278` (`IncidentSectionSchema.autoPostmortem: z.boolean().default(true)`).
**Connection:** The most recent example of adding a new optional section to BoberConfigSchema. `TelemetrySectionSchema` mirrors this shape exactly.

### Sprint 27: Four-mode e2e integration test
**Created:** `tests/e2e/four-modes.test.ts` (1083+ tests baseline; commit `733a863`).
**Connection:** This test MUST still pass after Sprint 28 changes. The Sprint 28 evaluator MUST re-run this test as part of the final regression sweep BEFORE flipping spec status to "completed".

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` file in this repo (confirmed via `cat`). The functional equivalents are:
- **AGENTS.md** at repo root (148 lines) — contributor + AI-agent guidelines, voice rules, evidence requirements
- **VISION.md** at repo root (438 lines) — operating modes, configuration reference, behavior-shaping discipline (Iron Laws, Red Flags, Rationalization-Prevention)
- **`.bober/anti-patterns/`** — MIT-attributed obra/superpowers anti-pattern catalog

### Architecture Decisions
No `.bober/architecture/` directory in this repo. The closest authority for Sprint 28 design constraints lives in:
- **`src/orchestrator/observability/merge.ts:23-28`** — explicit forward-link: "Sprint 28 (telemetry) must NOT include observability MCP response bodies in telemetry events. The sanitizeError helper here sets the precedent: redact env var patterns before any external logging boundary." Treat this comment as the design contract for the privacy bar.
- **`src/orchestrator/checkpoints/audit.ts`** (whole file) — the gold-standard JSONL writer Sprint 28 telemetry must mirror.

### Other Docs
- **README.md** — operating modes summary, new commands section. Sprint 28 may add a one-liner about `bober telemetry`/`bober config migrate` (not required by contract, but matches Sprint 26 voice).
- **COMMANDS.md** — full CLI reference (created in Sprint 26). Sprint 28 SHOULD append the new `bober telemetry` and `bober config migrate` subcommands here (contract does not require it, but the file exists specifically for this purpose — see Sprint 26 progress note that COMMANDS.md was created in that sprint).
- **CHANGELOG.md** — versioned changelog. Sprint 28 should add a `0.14.0` entry (or whatever version is bumped to) calling out the new telemetry + config-migrate commands. Sprint 27 evidence (tests/cli/skill-bundles.test.ts:160-187) shows CHANGELOG.md is tested for version-entry presence.

---

## 6. Testing Patterns

### Unit Test Pattern — schema backcompat
**Source:** `tests/config/graph-schema.test.ts:163-232` (Sprint 14 backcompat tests)

```ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { BoberConfigSchema, PartialBoberConfigSchema } from "../../src/config/schema.js";
import { loadConfig } from "../../src/config/loader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");

describe("Sprint 28 — backward-compat: existing bober.config.json parses without telemetry section", () => {
  it("repo's bober.config.json (no telemetry section) parses successfully via BoberConfigSchema", async () => {
    const raw = await readFile(resolve(repoRoot, "bober.config.json"), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const result = BoberConfigSchema.safeParse(parsed);
    expect(result.success, `parse failed: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    if (result.success) {
      expect(result.data.telemetry).toBeUndefined();
    }
  });

  it("loadConfig returns config with telemetry undefined when section absent", async () => {
    const config = await loadConfig(repoRoot);
    expect(config.telemetry).toBeUndefined();
  });

  it("BoberConfigSchema accepts telemetry section with enabled=true", () => {
    const minimal = {
      project: { name: "test", mode: "brownfield" },
      planner: {}, generator: {}, evaluator: { strategies: [] },
      sprint: {}, pipeline: {}, commands: {},
      telemetry: { enabled: true },
    };
    const result = BoberConfigSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.telemetry?.enabled).toBe(true);
  });

  it("telemetry.enabled defaults to false when section is {}", () => {
    const minimal = {
      project: { name: "test", mode: "brownfield" },
      planner: {}, generator: {}, evaluator: { strategies: [] },
      sprint: {}, pipeline: {}, commands: {},
      telemetry: {},
    };
    const result = BoberConfigSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.telemetry?.enabled).toBe(false);
  });
});
```

**Runner:** vitest (per `package.json:18 "test": "vitest"`)
**Assertion style:** `expect(...).toBe(...)` / `.toEqual(...)` / `.toBeUndefined()`
**Mock approach:** None needed for schema tests. For CLI/telemetry tests use `vi.mock` (see `src/orchestrator/code-reviewer-agent.test.ts:42`).
**File naming:** `<name>.test.ts`
**Location:** Either colocated (`src/.../*.test.ts` — Sprint 5+ convention) OR cross-cutting in `tests/<area>/` (Sprint 14+ convention for integration tests). For Sprint 28:
- Schema backcompat → `tests/config/graph-schema.test.ts` (EXTEND existing file with new describe block)
- Telemetry unit tests → `tests/telemetry/emit.test.ts` (NEW directory mirrors `tests/incident/`)
- CLI command tests → COLOCATED at `src/cli/commands/telemetry.test.ts` and `src/cli/commands/config.test.ts` (per Sprint 13 audit-show.test.ts precedent)

### Unit Test Pattern — JSONL writer with tmpdir
**Source:** `src/cli/commands/audit-show.test.ts:8-35`

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-telemetry-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("telemetry emit — file IO", () => {
  it("writes a JSONL line with mode 0600 when enabled", async () => {
    const config = { telemetry: { enabled: true }, /* ...minimal stub */ } as BoberConfig;
    await emit(tmpDir, config, "checkpoint-approved", { checkpointId: "post-plan", iteration: 1 });
    const today = new Date().toISOString().slice(0, 10);
    const path = join(tmpDir, ".bober", "telemetry", `${today}.jsonl`);
    const raw = await readFile(path, "utf-8");
    expect(raw.trim().split("\n")).toHaveLength(1);
    const parsed = JSON.parse(raw.trim()) as { eventType: string; checkpointId: string };
    expect(parsed.eventType).toBe("checkpoint-approved");
    expect(parsed.checkpointId).toBe("post-plan");

    // Mode check (s28-c4 / Sprint 13 pattern)
    const { stat } = await import("node:fs/promises");
    const s = await stat(path);
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("is a no-op when enabled=false (default)", async () => {
    const config = { telemetry: { enabled: false } } as BoberConfig;
    // OR: const config = {} as BoberConfig;  (undefined branch)
    await Promise.all(Array.from({ length: 100 }, () =>
      emit(tmpDir, config, "checkpoint-approved", { checkpointId: "x", iteration: 1 })
    ));
    const { access } = await import("node:fs/promises");
    await expect(access(join(tmpDir, ".bober", "telemetry"))).rejects.toThrow();
  });
});
```

### Unit Test Pattern — privacy assertion
**Source:** `tests/incident/postmortem.test.ts` (Sprint 23 — redaction test that AKIA fake key is NOT in output)

For Sprint 28 privacy enforcement, write a similar test:
```ts
it("emit() never writes user-content strings even when prod-looking data is in scope", async () => {
  const config = { telemetry: { enabled: true } } as BoberConfig;
  const userFeedback = "AKIASECRET123 user-database-credentials-leaked";  // simulated bad input
  // The call site MUST emit only feedbackLength — not feedbackText — per privacy bar.
  await emit(tmpDir, config, "checkpoint-rejected", { checkpointId: "post-plan", iteration: 1, /* NO feedback field */ });
  const today = new Date().toISOString().slice(0, 10);
  const raw = await readFile(join(tmpDir, ".bober", "telemetry", `${today}.jsonl`), "utf-8");
  expect(raw).not.toContain("AKIASECRET123");
  expect(raw).not.toContain("user-database-credentials-leaked");
});
```

### Integration Test Pattern — careful-flow style (real disk, real mutex)
**Source:** `tests/integration/careful-flow.test.ts:36-100`

Use this template for the `tests/telemetry/integration.test.ts` that verifies the emit call sites in pipeline.ts actually fire when telemetry is enabled. Per the contract: simulate each of the 9 EventTypes and verify a line is written for each.

### E2E Test Pattern (regression sweep)
**Source:** `tests/e2e/four-modes.test.ts` (Sprint 27 — the gate)

Sprint 28's evaluator MUST re-run this entire test. Per evaluatorNotes: "FINAL REGRESSION SWEEP: re-run the Sprint 27 four-modes integration test as part of THIS sprint's eval. If it fails, the spec is not 'completed'." This is the literal gate — DO NOT flip spec status until `npx vitest run tests/e2e/four-modes.test.ts` exits 0.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
Files that import from or depend on the changed files:

| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/config/loader.ts` | `src/config/schema.ts` | low | `BoberConfigSchema.safeParse(merged)` — new optional field can't break existing parse paths |
| `src/config/index.ts` | `src/config/schema.ts` | low | Re-export the new `TelemetrySectionSchema` and `type TelemetrySection` to maintain the public surface |
| `src/cli/commands/sprint.ts`, `eval.ts`, `run.ts`, `impact.ts`, `graph.ts` | `loadConfig` | low | These read `config.pipeline`, `config.evaluator`, etc. — none read `config.telemetry` today; no compilation break |
| `src/mcp/server.ts` + 9 `src/mcp/tools/*.ts` files | `loadConfig` | low | Same — pure config readers |
| `src/orchestrator/pipeline.ts` | `loadConfig`, `appendHistory`, `runWithAudit` | medium | Sprint 28 ADDS `emit()` calls after existing appendHistory/runWithAudit sites. Risk: an `emit()` failure (e.g., disk full) must NOT break the pipeline. The emit() implementation MUST catch internally and log via logger.warn — never throw. Mirror `audit.ts:324-328` pattern. |
| `src/incident/timeline.ts:setIncidentStatus` | (modified to emit `incident-resolved`) | medium | The async postmortem fire-and-forget IIFE at lines 488-510 is sensitive to changes — DO NOT modify that block. ADD `emit()` BEFORE the postmortem IIFE (or after `appendTimeline` at line 481). |
| `src/incident/orchestrator.ts:abort` | (modified to emit `incident-aborted`) | low | One additional call after `appendTimeline` at line 340-345 |
| `src/orchestrator/curator-agent.ts`, `generator-agent.ts`, `evaluator-agent.ts`, etc. | (modified to emit `agent-spawn`/`agent-error`) | medium | Each agent runner gets `emit("agent-spawn", { agentName })` at function-entry and an `emit("agent-error", ...)` in a top-level try/catch. Must NOT alter agent behavior — emit is fire-and-forget. |
| `eslint.config.js` | (new no-restricted-imports block) | low | New rule scoped to `src/telemetry/**` only — no impact on other src/ files |
| `src/cli/index.ts` | (new register calls) | low | Two new register imports + invocations at the bottom |
| `tests/config/graph-schema.test.ts` | `BoberConfigSchema`, `loadConfig` | medium | EXTEND with Sprint 28 backcompat block; do not modify existing Sprint 14/16/23 blocks |
| `bober.config.json` (repo on-disk) | (none — it's the test fixture) | high IF MODIFIED | DO NOT modify this file in Sprint 28 unless explicitly running `bober config migrate`. The s28-c1 verification REQUIRES the current shape parses successfully. |

### Existing Tests That Must Still Pass

| Test | Covers | Why Sprint 28 might affect it |
|------|--------|-------------------------------|
| `tests/config/graph-schema.test.ts` | Schema backcompat for Sprints 14, 16, 23 | New `telemetry` field could break the parse if not optional |
| `tests/e2e/four-modes.test.ts` | Sprint 27 four-mode gate (THE regression sweep) | Pipeline `emit()` insertions could change timing or throw — MUST still pass |
| `tests/integration/careful-flow.test.ts` | Sprint 14 disk-mechanism approval dance | runWithAudit emit hookup could affect audit log assertions |
| `tests/integration/incident-lifecycle.test.ts` | Sprint 24 capstone — full incident lifecycle | setIncidentStatus emit insertion could affect timeline assertions |
| `tests/incident/timeline.test.ts` (31 tests) | mutex serialization, double-write, 0o600 mode | Any change to setIncidentStatus mutex tick could break |
| `tests/incident/rollback.test.ts` (27 tests) | rollback execution + escalation | abort emit insertion sits adjacent |
| `tests/incident/postmortem.test.ts` (7 tests) | postmortem synthesis, citation count, redaction, timing | The Sprint 23 fire-and-forget IIFE in setIncidentStatus must remain functionally unchanged |
| `tests/orchestrator/observability-mcp.test.ts` (10) | MCP merge + namespace + Promise.allSettled isolation | Should not be touched, but is a regression canary |
| `tests/orchestrator/deployer.test.ts` (22) | Sprint 20 risky-action gate | Should not be touched |
| `src/cli/commands/audit-show.test.ts`, `approve.test.ts`, `reject.test.ts`, `list-approvals.test.ts`, `impact.test.ts`, `plan.test.ts` | colocated CLI command tests | Should not be touched; serve as templates for new `telemetry.test.ts` and `config.test.ts` |
| `src/orchestrator/checkpoints/audit.test.ts` | recordApproval + runWithAudit | Telemetry emit MUST NOT be added inside audit.ts — keep audit module a leaf |

### Features That Could Be Affected
- **Sprint 23 auto-postmortem** — fire-and-forget IIFE in `setIncidentStatus`. If Sprint 28 wraps emit calls poorly around this block, the postmortem timing test (`tests/incident/postmortem.test.ts` < 500ms assertion) could flake. Add the `emit("incident-resolved")` BEFORE the IIFE starts so it does not race with postmortem synthesis.
- **Sprint 14 disk mechanism** — careful-flow test relies on `runWithAudit` writing exactly one audit record per checkpoint. If Sprint 28 also fires telemetry through the same code path, that should be in the caller (pipeline.ts), not inside `runWithAudit`.
- **Sprint 20 deployer gate** — risky-action approval flow. NO emit changes inside `src/orchestrator/deploy/*` are required by the contract; do not touch this module.
- **Sprint 21 rollback CLI** — destructive command. Use the same `prompts.confirm` pattern for `telemetry purge`.

### Recommended Regression Checks
After implementation, the Generator MUST verify ALL of these pass (in this order):

1. `npm run typecheck` — exit 0
2. `npm run lint` — exit 0 (the new no-restricted-imports rule must not trigger on existing code)
3. `npm run build` — exit 0
4. `npx vitest run tests/config/graph-schema.test.ts` — all existing + new tests pass
5. `npx vitest run tests/telemetry/` — new telemetry unit tests pass
6. `npx vitest run src/cli/commands/config.test.ts src/cli/commands/telemetry.test.ts` — new CLI tests pass
7. `npx vitest run tests/integration/` — careful-flow + incident-lifecycle still green
8. `npx vitest run tests/incident/` — all 4 incident test files still green (timeline/rollback/postmortem/resolution-verify)
9. **`npx vitest run tests/e2e/four-modes.test.ts`** — THE regression sweep gate (per evaluatorNotes)
10. `npm test` — full suite green
11. Sanity: write a temp `src/telemetry/_egress-check.ts` containing `import "http";`, run `npm run lint`, confirm error, then delete the file (s28-c4 regression-prevention test)
12. ONLY THEN: edit `.bober/specs/spec-20260524-bober-vision.json` `status` → `"completed"`, run `appendHistory(...)` for `spec-completed`, update `.bober/progress.md`

---

## 8. Implementation Sequence

1. **`src/config/schema.ts`** — add `TelemetrySectionSchema` + `type TelemetrySection`; extend `BoberConfigSchema` with `telemetry: TelemetrySectionSchema.optional()`.
   - Verify: `BoberConfigSchema.safeParse(JSON.parse(readFileSync('bober.config.json')))` returns `{success: true, data: { telemetry: undefined, ... }}`.

2. **`src/config/index.ts`** — re-export `TelemetrySectionSchema` and `type TelemetrySection` (mirror line 23/45 for observability).
   - Verify: `npm run typecheck` exit 0.

3. **`tests/config/graph-schema.test.ts`** — append Sprint 28 backcompat describe block (mirror Sprint 14 block at lines 161-232).
   - Verify: `npx vitest run tests/config/graph-schema.test.ts` — 4+ new tests pass + existing tests preserved.

4. **`src/telemetry/types.ts`** — Zod schemas for `TelemetryEvent`, `TelemetryEventType` enum, `TelemetryEventData` type. (Optional but recommended; alternative: inline in `emit.ts`.)
   - Verify: typecheck.

5. **`src/telemetry/emit.ts`** — `emit(projectRoot, config, eventType, data)` function with per-filepath Promise-chain mutex + mode-0600 append. Pure leaf module (no deps on orchestrator/incident).
   - Verify: typecheck + unit test enables=false no-op (zero file writes from 100 calls).

6. **`eslint.config.js`** — add the `src/telemetry/**/*.ts` files block with `no-restricted-imports` + `no-restricted-globals`.
   - Verify: `npm run lint` exit 0. Then write a throwaway `src/telemetry/_egress.ts` with `import "http"`, re-run lint, confirm error, delete the file.

7. **`tests/telemetry/emit.test.ts`** (create new directory `tests/telemetry/`) — unit tests: enabled=true writes mode-0600 line, enabled=false is no-op, mutex serializes concurrent calls (50 parallel emits → 50 well-formed lines no torn-write).
   - Verify: `npx vitest run tests/telemetry/`.

8. **`src/cli/commands/config.ts`** — `bober config migrate` subcommand. Register in `src/cli/index.ts`.
   - Verify: `npx tsx src/cli/index.ts config migrate --dry-run` prints the merged config.

9. **`src/cli/commands/telemetry.ts`** — `bober telemetry status/purge/export` subcommands. Register in `src/cli/index.ts`.
   - Verify: `npx tsx src/cli/index.ts telemetry status` prints `telemetry.enabled: false`.

10. **`src/cli/commands/config.test.ts` + `telemetry.test.ts`** — colocated CLI tests (mirror `audit-show.test.ts` tmpdir pattern).
    - Verify: `npx vitest run src/cli/commands/config.test.ts src/cli/commands/telemetry.test.ts`.

11. **Telemetry call-site wiring** — INCREMENTAL. For each call site, add the `emit()` after the existing event boundary AND verify the relevant test still passes:
    - `src/orchestrator/pipeline.ts:387-393` (sprint-passed) → `emit("sprint-pass", { sprintId, iteration })`
    - `src/orchestrator/pipeline.ts:462-468` (evaluation-failed) → `emit("sprint-fail-retry", { sprintId, iteration })` when `iteration < maxIterations`
    - `src/orchestrator/pipeline.ts` — at each of the 9 `runWithAudit(...)` sites: after the `await runWithAudit(...)` resolves, fire-and-forget `emit("checkpoint-approved"|...)` based on the outcome
    - `src/incident/timeline.ts:481-487` (incident_resolved/override timeline event) → `emit("incident-resolved", { incidentId, durationMs })` BEFORE the autoPostmortem IIFE
    - `src/incident/orchestrator.ts:339-345` (incident_aborted timeline event) → `emit("incident-aborted", { incidentId })`
    - `src/orchestrator/curator-agent.ts:64` (entry) + try/catch around the agent loop → `emit("agent-spawn", { agentName: "curator", contractId })` + `emit("agent-error", { agentName: "curator", errorKind })` on throw
    - Repeat for `generator-agent.ts`, `evaluator-agent.ts`, `architect-agent.ts`, `research-agent.ts`, `code-reviewer-agent.ts`, `planner-agent.ts`, `postmortem.ts` (synthesizer is offline but still an agent boundary), `bober-diagnoser` spawn point if applicable
    - Verify after each wave: `npm run typecheck && npm run lint && npx vitest run tests/integration/` exit 0

12. **`tests/telemetry/call-sites.test.ts`** — integration test: simulate each of the 9 EventTypes via the real pipeline code paths with `telemetry.enabled=true`; assert one JSONL line per event with correct shape. Per s28-c3.
    - Verify: `npx vitest run tests/telemetry/`.

13. **Privacy audit** — grep `src/` for `emit(` and inspect every data payload. Confirm zero `feedback`, `description`, `command`, `mcpResponseBody`, raw error message strings. Document the audit list in the PR description.
    - Verify: `grep -rn "emit(" src/ | grep -v "src/telemetry/"` — manually review each call.

14. **Network egress regression-prevention test** — write `src/telemetry/_egress-check.ts` containing `import "http";`, run `npm run lint`, confirm it errors with the no-restricted-imports message, delete the file. Document in PR.

15. **`VISION.md` + `AGENTS.md` + COMMANDS.md + CHANGELOG.md** — docs updates per Section 1.
    - Verify: `grep -n "telemetry" VISION.md AGENTS.md COMMANDS.md CHANGELOG.md` returns the new prose.

16. **FINAL REGRESSION SWEEP** — `npm run typecheck && npm run lint && npm run build && npm test` AND `npx vitest run tests/e2e/four-modes.test.ts` — both exit 0.
    - Verify: total test count >= 1083 (Sprint 25 baseline) + Sprint 28 additions (≥10 new tests expected).

17. **SPEC COMPLETION** — execute IN THIS ORDER:
    1. Edit `.bober/specs/spec-20260524-bober-vision.json`: `status: "completed"` + `completedAt: "<ISO now>"`.
    2. Append `spec-completed` event to `.bober/history.jsonl` via `appendHistory(projectRoot, { event: "spec-completed", phase: "complete", details: { specId, totalSprints: 28, ambiguityScoreAtStart: 5, ambiguityScoreFinal: 5, deferredDecisions: [] }, timestamp: <now> })`.
    3. Update `.bober/progress.md` Sprint 28 line to `[completed]` + add Spec Completion Summary block + "Tier 4 COMPLETE" line.
    - Verify: `grep "completed" .bober/specs/spec-20260524-bober-vision.json` + `tail -1 .bober/history.jsonl | jq .event` = `"spec-completed"`.

---

## 9. Pitfalls & Warnings

- **DO NOT modify `bober.config.json` at the repo root.** This file is the live back-compat test fixture (`tests/config/graph-schema.test.ts:163-208` reads it). Adding fields to it breaks the test's "existing file parses with new defaults" semantic. Use the `bober config migrate` command in a tmpdir for end-to-end verification, not against the on-disk fixture.

- **DO NOT use `fs.appendFile` for `.bober/telemetry/*.jsonl`.** Per `src/orchestrator/checkpoints/audit.ts:11-13` and `src/incident/timeline.ts:11-15`: it does not reliably honor the mode argument across Node versions. Use `fs.open(O_WRONLY|O_APPEND|O_CREAT, 0o600)` + `fh.chmod(0o600)` + `fh.write(line)` + `fh.close()` in a try/finally.

- **DO NOT import `node:http`, `node:https`, `node:net`, `node:tls`, `node:dgram`, `undici`, `got`, `axios`, `node-fetch`, or `fetch` in `src/telemetry/`.** The ESLint rule will catch you. The verification per s28-c4 explicitly grep-asserts this.

- **DO NOT add `emit()` inside `runWithAudit`** (`src/orchestrator/checkpoints/audit.ts:275`). Keep telemetry module a leaf — audit imports nothing telemetry-related. Fire emit from the pipeline caller after `runWithAudit` resolves. This avoids a circular-dep risk and keeps the audit-module test surface unchanged.

- **DO NOT emit user-content strings.** PRIVACY BAR: every `emit(...)` data payload field must be drawn from `TelemetryEventData` (IDs, durations, counts, enum outcomes). If you ever find yourself writing `emit(..., { feedback: text })`, STOP — the correct shape is `emit(..., { feedbackLength: text.length })`. Per evaluatorNotes: "Any field that takes a string from user input is a privacy fail."

- **DO NOT block on `emit()`.** If telemetry write fails (disk full, permission denied), the pipeline MUST continue. Mirror `src/orchestrator/checkpoints/audit.ts:324-328` — `.catch()` with `logger.warn`. NEVER let an emit failure throw to the caller.

- **DO NOT flip `.bober/specs/spec-20260524-bober-vision.json` to `"completed"` until the four-modes e2e test passes.** Per evaluatorNotes: "FINAL REGRESSION SWEEP: re-run the Sprint 27 four-modes integration test as part of THIS sprint's eval. If it fails, the spec is not 'completed'." This is the literal gate. The status flip is the LAST step of the sprint, after all other verification passes.

- **DO NOT use `console.log` or `console.warn`.** Use `process.stdout.write` and `process.stderr.write` (CLI handlers) or `logger.warn`/`logger.info` (module code). Mirror `src/cli/commands/playbook.ts:50-53` and `src/orchestrator/checkpoints/audit.ts:325`.

- **DO NOT skip the `prompts.confirm` for `telemetry purge`.** Destructive CLI commands MUST confirm with `initial: false` per `src/cli/commands/rollback.ts:~95`. Treat `{ ok: undefined }` (SIGINT) as abort.

- **DO NOT alter the Sprint 23 autoPostmortem fire-and-forget IIFE** at `src/incident/timeline.ts:488-510`. Add the `emit("incident-resolved")` either BEFORE the IIFE (preferred — same mutex tick as `appendTimeline`) or fire-and-forget from inside `setIncidentStatus` AFTER all the existing logic. Do not restructure the IIFE.

- **DO NOT include `pipeline.maxCheckpointIterations` or `pipeline.playbookAutoInvokeThreshold` as Sprint 28 defaults.** `maxCheckpointIterations` defaults are already in PipelineSectionSchema (Sprint 12); `playbookAutoInvokeThreshold` is a constant in `src/incident/playbook-search.ts`, NOT a config field (VISION.md:339-345 explicitly documents this). The contract's `generatorNotes` mentions `incident.playbookAutoInvokeThreshold default 0.6` — this is INFORMATIONAL only (the default to be referenced when discussing matches), NOT a new schema field to add. Adding it would conflict with the existing constant.

- **DO NOT add Zod validation of telemetry events at the `emit()` boundary.** It's overhead on a hot path. The TypeScript type `TelemetryEventData` is the contract; the test suite asserts shape per event type. Mirror `src/state/history.ts:58-65` only if you want validated history-style events — but for the high-frequency telemetry path, type-only is correct.

- **AGENT-SPAWN emit cardinality** — there are 7-9 agent runners (curator, generator, evaluator, planner, researcher, architect, code-reviewer, postmortemer, diagnoser-via-spawn). Don't accidentally double-count by emitting both at the wrapper boundary AND inside the spawned process. Emit ONLY at the orchestrator-level call site (e.g., the top of `runCurator`, NOT inside the spawned curator subagent).

- **DO NOT forget `tests/cli/skill-bundles.test.ts:160-187`** — it asserts `package.json` version is `0.13.0` and CHANGELOG has a `0.13.0` entry. If you bump the version (e.g., to 0.14.0) you must update this test too. If you do NOT bump the version, leave both alone.
