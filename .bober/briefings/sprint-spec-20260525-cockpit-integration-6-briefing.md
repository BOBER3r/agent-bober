# Sprint Briefing: Vision-era MCP wrappers + end-to-end fake-cockpit-client integration test

**Contract:** sprint-spec-20260525-cockpit-integration-6
**Generated:** 2026-05-25T18:45:00Z

This is the spec capstone in two halves:

**Half (a) — 8 NEW MCP tools** (thin adapters over `src/incident/*` helpers):
- `bober_incident_start`, `bober_incident_status`, `bober_incident_list`, `bober_incident_abort`
- `bober_rollback_start`
- `bober_postmortem_get`
- `bober_playbook_list`, `bober_playbook_search`

**Half (b) — The correctness gate** — `tests/e2e/cockpit-integration.test.ts` spawns `node dist/cli/index.js mcp` as a real child subprocess, performs the MCP `initialize` handshake, and exercises EVERY new tool from Sprints 1-6 sequentially against a tmpdir fixture.

**Tool count: 29 → 37** after Sprint 6.

> **CRITICAL PATH NOTE.** The contract description says `node dist/cli.js mcp`, but the actual built entrypoint is `node dist/cli/index.js mcp` (verified from `package.json` `"bin": { "agent-bober": "dist/cli/index.js" }` and `dist/cli/index.js` exists). Use `dist/cli/index.js` in the e2e test — `dist/cli.js` does not exist.

---

## 1. Target Files

### `src/mcp/tools/incident.ts` (create — 4 tools in one file)

**Directory pattern:** `src/mcp/tools/<tool-name>.ts` — kebab-case filename, single `registerXxxTool()` export. Each file registers ONE tool via `registerTool({ name, description, inputSchema, handler })`.

**Recommended deviation:** Per generator notes, the four `incident_*` tools may live in ONE file with a single `registerIncidentTools()` (plural) function calling four `registerTool({...})` blocks — this keeps related thin adapters cohesive. Acceptable structure either way.

**Most similar existing files:**
- `src/mcp/tools/list-projects.ts` (lines 1-127) — soft-error JSON pattern with `projectPath` validation
- `src/mcp/tools/get-project-state.ts` (lines 1-120) — `projectPath` absolute-path guard + multi-arg handler
- `src/mcp/tools/abort-run.ts` (lines 1-77) — required string args with `McpError(InvalidRequest)` for hard validation failures

**Structure template (skeleton):**
```ts
// ── bober_incident_<x> tool ──────────────────────────────────────────
// Thin adapter over src/incident/timeline.ts / orchestrator.ts.
// Sprint 6 (cockpit-integration)

import { cwd } from "node:process";
import { isAbsolute } from "node:path";

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { registerTool } from "./registry.js";
import {
  createIncident,
  listIncidents,
  setIncidentStatus,
} from "../../incident/timeline.js";
import {
  abort,
  readIncidentMetadata,
} from "../../incident/orchestrator.js";

export function registerIncidentTools(): void {
  // ── bober_incident_start ──
  registerTool({
    name: "bober_incident_start",
    description: "Create a new incident from a symptom and optional severity. Returns { incidentId, status, createdAt }.",
    inputSchema: {
      type: "object",
      properties: {
        symptom: { type: "string", description: "Human-readable symptom." },
        severity: { type: "string", enum: ["S1", "S2", "S3", "S4"], description: "Optional severity." },
        projectPath: { type: "string", description: "Absolute project root (defaults to cwd)." },
      },
      required: ["symptom"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const symptom = String(args.symptom ?? "").trim();
      if (!symptom) {
        return JSON.stringify({ error: "symptom is required and must be a non-empty string." });
      }
      const projectPath = typeof args.projectPath === "string" ? args.projectPath : cwd();
      if (typeof args.projectPath === "string" && !isAbsolute(args.projectPath)) {
        return JSON.stringify({ error: "projectPath must be absolute" });
      }
      const severity = typeof args.severity === "string" ? args.severity : undefined;
      if (severity && !["S1", "S2", "S3", "S4"].includes(severity)) {
        return JSON.stringify({ error: `Invalid severity '${severity}'. Must be one of: S1, S2, S3, S4` });
      }
      const incidentId = await createIncident(symptom, projectPath);
      if (severity) {
        await setIncidentStatus(projectPath, incidentId, "investigating", { severity: severity as "S1" | "S2" | "S3" | "S4" });
      }
      const meta = await readIncidentMetadata(projectPath, incidentId);
      return JSON.stringify({ incidentId, status: meta.status, createdAt: meta.createdAt, ...(meta.severity ? { severity: meta.severity } : {}) }, null, 2);
    },
  });

  // ── bober_incident_status ──
  // ── bober_incident_list ──
  // ── bober_incident_abort ──
  // ... see CLI handler in src/cli/commands/incident.ts:243-431 for exact mapping
}
```

**Imports this file needs:**
- `createIncident, listIncidents, setIncidentStatus` from `../../incident/timeline.js`
- `abort, readIncidentMetadata, type AbortResult` from `../../incident/orchestrator.js`
- `registerTool` from `./registry.js`
- `McpError, ErrorCode` from `@modelcontextprotocol/sdk/types.js` (only for hard arg validation)
- `cwd` from `node:process`; `isAbsolute` from `node:path`

**Per-tool delegations (verbatim from src/cli/commands/incident.ts):**
- `incident_start({ symptom, severity?, projectPath? })` → `createIncident(symptom, root)` then optional `setIncidentStatus(root, id, "investigating", { severity })` — see CLI handler lines 207-241.
- `incident_status({ incidentId, projectPath? })` → `readIncidentMetadata(root, id)` — return `{ incidentId, symptom, status, severity?, createdAt, resolvedAt?, resolutionEvidence? }` from the metadata. Do NOT recreate the rich CLI rendering at lines 59-198 — that's CLI-only chrome.
- `incident_list({ projectPath? })` → `listIncidents(root)` — return the IncidentSummary[] directly.
- `incident_abort({ incidentId, reason, confirmRollback?, projectPath? })` → `abort(root, id, { reason, confirmRollback })` — return `{ incidentId, status: "aborted", abortReportPath, rollback? }` from `AbortResult`.

---

### `src/mcp/tools/rollback.ts` (create)

**Most similar existing file:** `src/mcp/tools/run-in-worktree.ts` (lines 1-109) — single-export tool that wraps a multi-step orchestrator helper.

**What it must do:** Wrap `planRollback` + `executeRollback` from `src/incident/rollback.ts` (verified at lines 191-268 and 337-465). Returns the combined plan + execution result.

**Return shape per sc-6-2:**
```
{
  planned: { totalChanges, rollbackableChanges, steps },
  executed: { attempted, succeeded },
  escalated?, remaining?
}
```

**Skeleton:**
```ts
// ── bober_rollback_start tool ────────────────────────────────────────
import { cwd } from "node:process";
import { isAbsolute } from "node:path";
import { registerTool } from "./registry.js";
import { planRollback, executeRollback } from "../../incident/rollback.js";

export function registerRollbackTool(): void {
  registerTool({
    name: "bober_rollback_start",
    description:
      "Plan and execute rollback for an incident. Thin adapter over planRollback + executeRollback. " +
      "Each rollback step still passes through the per-step risky-action gate. " +
      "Returns { planned: { totalChanges, rollbackableChanges, steps }, executed: { attempted, succeeded }, escalated?, remaining? }.",
    inputSchema: {
      type: "object",
      properties: {
        incidentId: { type: "string", description: "Incident to roll back." },
        projectPath: { type: "string", description: "Absolute project root (defaults to cwd)." },
      },
      required: ["incidentId"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const incidentId = typeof args.incidentId === "string" ? args.incidentId.trim() : "";
      if (!incidentId) return JSON.stringify({ error: "incidentId is required" });
      const projectPath = typeof args.projectPath === "string" ? args.projectPath : cwd();
      if (typeof args.projectPath === "string" && !isAbsolute(args.projectPath)) {
        return JSON.stringify({ error: "projectPath must be absolute" });
      }
      const plan = await planRollback(projectPath, incidentId);
      const executed = await executeRollback(projectPath, incidentId, plan);
      return JSON.stringify({
        planned: {
          totalChanges: plan.totalChanges,
          rollbackableChanges: plan.rollbackableChanges,
          steps: plan.steps,
        },
        executed: {
          attempted: executed.attempted,
          succeeded: executed.succeeded,
        },
        ...(executed.escalated ? { escalated: true } : {}),
        ...(executed.remaining.length > 0 ? { remaining: executed.remaining } : {}),
      }, null, 2);
    },
  });
}
```

---

### `src/mcp/tools/postmortem.ts` (create)

**Reference helper:** `generatePostmortem(projectRoot, incidentId): Promise<PostmortemResult>` at `src/incident/postmortem.ts:625-735`. Note **there is no separate "read-only validator"** — sections and citations are computed at GENERATE time and returned in `PostmortemResult { path, content, redactionCount, shallowWarning, citationCount }`.

**Per sc-6-3 design choice:** "reads `.bober/incidents/<id>/postmortem.md` and returns `{ content, sections, citations }` (sections + citations parsed via existing src/incident/postmortem.ts validation helpers)". 

**Recommended implementation:** Read the existing `postmortem.md` from disk; do NOT re-generate. Parse `sections` by splitting on `## ` headers (e.g. TL;DR, Impact, Timeline, etc. — see the canonical list in `four-modes.test.ts:692-699`). Parse `citations` with the same regex used internally — see `countCitations` at `postmortem.ts:603-610`:

```ts
const CITATION_RE = /\([a-z0-9_./-]+(?:#(?:L?\d+|[a-z0-9-]+))?(?:,\s*[a-z0-9_./-]+(?:#(?:L?\d+|[a-z0-9-]+))?)?\)/gi;
```

Since this regex is currently a `function`-internal constant, the new tool may inline it. (Inlining is acceptable per the contract — exporting it from postmortem.ts is a "nice-to-have" refactor but is OUT OF SCOPE per nonGoals #3.)

**Skeleton:**
```ts
import { readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { cwd } from "node:process";
import { registerTool } from "./registry.js";

const CITATION_RE = /\([a-z0-9_./-]+(?:#(?:L?\d+|[a-z0-9-]+))?(?:,\s*[a-z0-9_./-]+(?:#(?:L?\d+|[a-z0-9-]+))?)?\)/gi;

function parseSections(md: string): { name: string; content: string }[] {
  const out: { name: string; content: string }[] = [];
  const re = /^## (.+)$/gm;
  const matches = [...md.matchAll(re)];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index!;
    const end = i + 1 < matches.length ? matches[i + 1].index! : md.length;
    out.push({ name: matches[i][1].trim(), content: md.slice(start, end).trim() });
  }
  return out;
}

export function registerPostmortemTool(): void {
  registerTool({
    name: "bober_postmortem_get",
    description: "Read .bober/incidents/<id>/postmortem.md and return { content, sections, citations }.",
    inputSchema: {
      type: "object",
      properties: {
        incidentId: { type: "string" },
        projectPath: { type: "string", description: "Absolute project root (defaults to cwd)." },
      },
      required: ["incidentId"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const incidentId = typeof args.incidentId === "string" ? args.incidentId.trim() : "";
      if (!incidentId) return JSON.stringify({ error: "incidentId is required" });
      const projectPath = typeof args.projectPath === "string" ? args.projectPath : cwd();
      if (typeof args.projectPath === "string" && !isAbsolute(args.projectPath)) {
        return JSON.stringify({ error: "projectPath must be absolute" });
      }
      const pmPath = join(projectPath, ".bober", "incidents", incidentId, "postmortem.md");
      let content: string;
      try {
        content = await readFile(pmPath, "utf-8");
      } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") {
          return JSON.stringify({ error: `No postmortem found for ${incidentId}` });
        }
        throw err;
      }
      const sections = parseSections(content);
      const citations = (content.match(CITATION_RE) ?? []);
      return JSON.stringify({ content, sections, citations }, null, 2);
    },
  });
}
```

---

### `src/mcp/tools/playbook.ts` (create — 2 tools)

**Wraps `loadPlaybooks` + `searchPlaybooks` from `src/incident/playbook-search.ts`** (verified at lines 217-272 and 308-357). Uses exported thresholds `HIGH_CONFIDENCE_THRESHOLD = 0.6`, `LOW_CONFIDENCE_THRESHOLD = 0.3` (lines 25-28).

**Skeleton (two registerTool calls in one register function):**
```ts
import { cwd } from "node:process";
import { isAbsolute } from "node:path";
import { registerTool } from "./registry.js";
import {
  loadPlaybooks,
  searchPlaybooks,
  HIGH_CONFIDENCE_THRESHOLD,
  LOW_CONFIDENCE_THRESHOLD,
} from "../../incident/playbook-search.js";

function classifyTier(confidence: number): "high" | "suggestion" | "low" {
  if (confidence >= HIGH_CONFIDENCE_THRESHOLD) return "high";
  if (confidence >= LOW_CONFIDENCE_THRESHOLD) return "suggestion";
  return "low";
}

export function registerPlaybookTools(): void {
  registerTool({
    name: "bober_playbook_list",
    description: "List all playbooks from .bober/playbooks/. Returns [{ name, classification, applicableSymptoms }].",
    inputSchema: {
      type: "object",
      properties: { projectPath: { type: "string", description: "Absolute project root (defaults to cwd)." } },
      additionalProperties: false,
    },
    handler: async (args) => {
      const projectPath = typeof args.projectPath === "string" ? args.projectPath : cwd();
      if (typeof args.projectPath === "string" && !isAbsolute(args.projectPath)) {
        return JSON.stringify({ error: "projectPath must be absolute" });
      }
      const pbs = await loadPlaybooks(projectPath);
      return JSON.stringify(
        pbs.map((p) => ({
          name: p.name,
          classification: p.classification,
          applicableSymptoms: p.applicableSymptoms,
        })),
        null, 2,
      );
    },
  });

  registerTool({
    name: "bober_playbook_search",
    description: "Search playbooks matching a symptom. Returns [{ name, confidence, tier, matchedTokens }] sorted desc by confidence.",
    inputSchema: {
      type: "object",
      properties: {
        symptom: { type: "string" },
        projectPath: { type: "string", description: "Absolute project root (defaults to cwd)." },
      },
      required: ["symptom"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const symptom = typeof args.symptom === "string" ? args.symptom.trim() : "";
      if (!symptom) return JSON.stringify({ error: "symptom is required" });
      const projectPath = typeof args.projectPath === "string" ? args.projectPath : cwd();
      if (typeof args.projectPath === "string" && !isAbsolute(args.projectPath)) {
        return JSON.stringify({ error: "projectPath must be absolute" });
      }
      const matches = await searchPlaybooks(symptom, projectPath);
      return JSON.stringify(
        matches.map((m) => ({
          name: m.playbook.name,
          confidence: m.confidence,
          tier: classifyTier(m.confidence),
          matchedTokens: m.matchedTokens,
        })),
        null, 2,
      );
    },
  });
}
```

---

### `src/mcp/tools/index.ts` (modify — register 8 new tools, bump JSDoc count)

**Current state (lines 1-122, fully read).** Imports each `register*Tool` and calls them in `registerAllTools()`. Current count = 29 (per JSDoc at line 40).

**Required edits:**
1. Add imports for the 4 new modules (or fewer if some tools share a module):
```ts
import { registerIncidentTools } from "./incident.js";
import { registerRollbackTool } from "./rollback.js";
import { registerPostmortemTool } from "./postmortem.js";
import { registerPlaybookTools } from "./playbook.js";
```
2. Bump the JSDoc tool count from 29 → 37 and append entries 30-37 to the numbered list (`bober_incident_start`, `_status`, `_list`, `_abort`, `_rollback_start`, `_postmortem_get`, `_playbook_list`, `_playbook_search`).
3. Add a new section in `registerAllTools()`:
```ts
  // ── Vision-era incident/rollback/postmortem/playbook (cockpit-integration sprint 6) ──
  registerIncidentTools();
  registerRollbackTool();
  registerPostmortemTool();
  registerPlaybookTools();
```

**Imported by:**
- `src/mcp/server.ts:22` — server.ts dynamically reads the registry on every `tools/list` call; no static enumeration to update there.
- `src/mcp/tools/tools.test.ts` — count assertion (see next).
- `tests/mcp/external-server-graph.test.ts` — graph-tools count assertion.

---

### `src/mcp/tools/tools.test.ts` (modify — bump count 29 → 37, add 8 names)

**Current state (lines 1-59, fully read).** Three tests:
1. `it("registers exactly 29 tools"...)` — line 8 — bump to **37**.
2. `it("includes all expected tool names"...)` — line 16 — append 8 new names to the `expected` array.
3. `it("does not include the removed bober_ping tool"...)` — unchanged.

**Names to add to the `expected` array (lines 18-48):**
```ts
"bober_incident_start",
"bober_incident_status",
"bober_incident_list",
"bober_incident_abort",
"bober_rollback_start",
"bober_postmortem_get",
"bober_playbook_list",
"bober_playbook_search",
```

---

### `tests/mcp/external-server-graph.test.ts` (modify — bump 29 → 37, 35 → 43)

**Current state (lines 1-133, fully read).** Three count assertions to update:
- Line 38: `expect(tools.length).toBe(29)` → **37**
- Line 48: `expect(baseline).toBe(29)` → **37**
- Line 58: `expect(after.length).toBe(35)` → **43**
- Line 59: bump `expect(after.length).toBe(baseline + 6)` is fine (now 37+6=43)
- Line 95: `expect(boberTools.length).toBe(29)` → **37**
- Line 110: `expect(getAllTools().length).toBe(29)` → **37**

---

### `tests/e2e/cockpit-integration.test.ts` (create — the integration capstone)

**Pattern source:** `tests/e2e/four-modes.test.ts` (lines 1-940, fully read). Mirrors:
- `mkdtemp + tmpdir + rm afterEach` setup (lines 80-100)
- `cp` to scaffold fixture (line 107)
- `import.meta.url` + `fileURLToPath` for fixture resolution (lines 46, 71)
- per-test timeouts via `it(..., async () => {}, 30_000)` (lines 244, 326, 357, 466)

**Recommended transport approach:** Use `Client` + `StdioClientTransport` from `@modelcontextprotocol/sdk` (confirmed available at `node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js`). This is the same approach used by `src/mcp/external-client.ts:20-21` and exercised by `tests/orchestrator/observability-mcp.test.ts`. Mirrors generator-notes preference.

**Skeleton:**
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const CLI_ENTRY = join(REPO_ROOT, "dist", "cli", "index.js");
const FIXTURE_DIR = join(__dirname, "..", "fixtures", "cockpit-baseline");

let projectRoot: string;
let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  // Ensure dist/cli/index.js exists; build if not.
  try { await stat(CLI_ENTRY); } catch {
    await execa("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
  }
});

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "bober-e2e-cockpit-"));
  // Scaffold fixture: cp tests/fixtures/cockpit-baseline → projectRoot
  // ...
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_ENTRY, "mcp"],
    env: { ...process.env, BOBER_TEST_DETERMINISTIC: "1" },
    cwd: projectRoot,
    stderr: "pipe",
  });
  client = new Client({ name: "fake-cockpit-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
});

afterEach(async () => {
  await client.close().catch(() => {});
  await rm(projectRoot, { recursive: true, force: true });
});

describe("cockpit-integration end-to-end (Sprint 6)", () => {
  it("sc-6-5: initialize handshake; every Sprint 1-6 tool is registered", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    const EXPECTED = [
      "bober_run_in_worktree", "bober_list_active_runs", "bober_get_run_status", "bober_abort_run",
      "bober_subscribe_events", "bober_unsubscribe_events",
      "bober_list_pending_approvals", "bober_approve_checkpoint", "bober_reject_checkpoint",
      "bober_list_projects", "bober_list_specs", "bober_get_project_state",
      "bober_incident_start", "bober_incident_status", "bober_incident_list", "bober_incident_abort",
      "bober_rollback_start", "bober_postmortem_get", "bober_playbook_list", "bober_playbook_search",
    ];
    for (const name of EXPECTED) expect(names).toContain(name);
  }, 30_000);

  // scenario A (sc-6-6): multi-run lifecycle
  // scenario B (sc-6-7): events subscribe/notification/unsubscribe
  // scenario C (sc-6-8): careful-flow approve + reject
  // scenario D (sc-6-9): discovery (list_projects + list_specs + get_project_state)
  // scenario E (sc-6-10): vision-era incident lifecycle
});
```

---

### `tests/fixtures/cockpit-baseline/` (create)

**Pattern source:** `tests/fixtures/four-modes-baseline/` (verified: 4 files — `bober.config.json`, `package.json`, `src/threshold.js`, `tests/threshold.node.js`).

**Required contents (minimum):**
1. `bober.config.json` — minimum schema for `loadConfig` to succeed. Example:
```json
{
  "project": { "name": "cockpit-baseline", "mode": "brownfield" },
  "pipeline": { "mode": "autopilot", "checkpointMechanism": "noop" }
}
```
2. `.gitignore` — must include `.bober/` so `bober worktree` checks pass (per worktree.ts:60-71 `isBoberGitignored`).
3. `package.json` — minimal (mirrors four-modes-baseline package.json).
4. (Optional) one `.bober/specs/<id>.json` so `bober_list_specs` returns non-empty in scenario D.

**Setup in beforeEach:** Use `cp(FIXTURE_DIR, projectRoot, { recursive: true })`. Then run `git init && git add . && git commit -m init` so worktrees work (mirrors `tests/mcp/tools/run-in-worktree.test.ts:83-88`).

---

### `tests/helpers/fake-cockpit-client.ts` (create — optional, per generator's choice)

Per generator-notes: "a small helper module inside the test file or under tests/helpers/fake-cockpit-client.ts". **Recommended:** keep the helper INLINE in the e2e test for visibility — the StdioClientTransport from the SDK already wraps stdio framing, so no custom JSON-RPC framing code is needed. Only extract to `tests/helpers/` if the test file exceeds ~500 lines.

**If extracted, the helper exposes:**
```ts
export interface FakeCockpitClient {
  client: Client;
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
  onNotification(method: string, cb: (n: Notification) => void): void;
  close(): Promise<void>;
}
export async function spawnFakeCockpitClient(projectRoot: string): Promise<FakeCockpitClient>;
```

---

### `CHANGELOG.md` (modify — append Sprint 6 entry)

Append an entry under the current Unreleased section in the same prose style as prior Sprint commits (see recent commits: `bober(sprint-3): event-stream MCP tool`, `bober(sprint-2): three run-management MCP tools`).

---

## 2. Patterns to Follow

### Pattern A — Soft-error JSON for handler-level failures
**Source:** `src/mcp/tools/list-projects.ts:61-78`, `src/mcp/tools/approve-checkpoint.ts:51-72`
```ts
const projectPath = typeof args.projectPath === "string" ? args.projectPath : cwd();
if (typeof args.projectPath === "string" && !isAbsolute(args.projectPath)) {
  return JSON.stringify({ error: "projectPath must be absolute" });
}
```
**Rule:** Validation/lookup failures return `JSON.stringify({ error: "..." })`. Only required-arg-missing throws `McpError(ErrorCode.InvalidRequest, ...)`.

### Pattern B — `projectPath` defaulting + absolute-path guard
**Source:** `src/mcp/tools/list-pending-approvals.ts:36-44`
```ts
const projectPath = typeof args.projectPath === "string" ? args.projectPath : cwd();
if (typeof args.projectPath === "string" && !isAbsolute(args.projectPath)) {
  return JSON.stringify({ error: "projectPath must be absolute" });
}
```
**Rule:** All Sprint 5/6 tools accept optional `projectPath` defaulting to `process.cwd()`; when provided it MUST be absolute.

### Pattern C — JSON.stringify(result, null, 2) for tool responses
**Source:** `src/mcp/tools/run-in-worktree.ts:97-106`, `src/mcp/tools/get-project-state.ts:116`
```ts
return JSON.stringify({ runId, branch, worktreePath, status: "running" }, null, 2);
```
**Rule:** All non-error responses are pretty-printed JSON (2-space indent). The MCP server wraps in `{ content: [{ type: "text", text: result }] }`.

### Pattern D — Thin adapter (NO business logic in MCP layer)
**Source:** `src/mcp/tools/list-projects.ts` calls `readRunStatesFromDisk` from `src/state/run-state.ts`; `src/mcp/tools/run-in-worktree.ts:79-91` calls `runInWorktree` from `src/orchestrator/worktree.ts`. The MCP file contains argument validation, projectPath resolution, and a SINGLE call into the domain helper.
**Rule:** If the new MCP file contains code that does NOT appear in the underlying `src/incident/*` module, that's a contract violation per evaluator-notes Layer 1.

### Pattern E — Unit-test scaffold for a single MCP tool
**Source:** `src/mcp/tools/list-active-runs.test.ts:1-202`, `src/mcp/tools/get-project-state.test.ts:1-240`
```ts
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-<name>-test-"));
  registerXxxTool();  // explicit registration — do NOT call registerAllTools
});
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
it("is registered with the correct name", () => {
  expect(getTool("bober_xxx")).toBeDefined();
});
it("returns ...", async () => {
  const tool = getTool("bober_xxx")!;
  const result = JSON.parse(await tool.handler({ ... }));
  expect(result).toMatchObject({ ... });
});
```
**Rule:** Each new tool MUST have its own `<name>.test.ts` file colocated in `src/mcp/tools/`.

### Pattern F — E2E test scaffold with subprocess
**Source:** `tests/e2e/four-modes.test.ts:80-101` (tmpdir + fixture cp + afterEach cleanup); `src/mcp/external-client.ts:42-79` (StdioClientTransport spawn + connect + sanitized error)
```ts
transport = new StdioClientTransport({
  command: process.execPath,  // = node
  args: [CLI_ENTRY, "mcp"],
  env: { ...process.env, BOBER_TEST_DETERMINISTIC: "1" },
  cwd: projectRoot,
  stderr: "pipe",
});
client = new Client({ name: "...", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);
```
**Rule:** Use `process.execPath` (current node binary) rather than the literal string `"node"` — guarantees identity with the test runner's Node version.

### Pattern G — Notification listener (for sc-6-7 events scenario)
**Source:** `tests/mcp/event-stream-smoke.test.ts:130-152`
```ts
const receivedNotifications: Notification[] = [];
client.fallbackNotificationHandler = async (notification) => {
  receivedNotifications.push(notification);
};
// poll until received or deadline
const deadline = Date.now() + 5000;
while (receivedNotifications.length === 0 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 50));
}
expect(receivedNotifications.length).toBeGreaterThan(0);
```
**Rule:** Use `client.fallbackNotificationHandler` for any `bober/events`-like notifications. Bound the wait with a deadline polling loop (NOT a long sleep).

### Pattern H — Strong assertions via `toMatchObject`
**Source:** `tests/mcp/event-stream-smoke.test.ts:161` `expect(notif.params.event).toMatchObject({ runId: "smoke-run-2" });`
**Rule:** Per evaluator-notes — prefer `expect(x).toMatchObject({ shape })` over `expect(x).toBeDefined()`. The latter is too weak and would not catch a return-shape regression (the sanity-sabotage scenario).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `createIncident` | `src/incident/timeline.ts:152` | `(symptom: string, projectRoot: string) => Promise<IncidentId>` | Creates `.bober/incidents/<id>/` directory + initial files |
| `listIncidents` | `src/incident/timeline.ts:547` | `(projectRoot: string) => Promise<IncidentSummary[]>` | Lists all incidents sorted desc by createdAt |
| `setIncidentStatus` | `src/incident/timeline.ts:416` | `(root, id, status, extras?, opts?) => Promise<void>` | Atomic JSON write + timeline event; gated for 'resolved' |
| `readIncidentMetadata` | `src/incident/orchestrator.ts:158` | `(root, id) => Promise<IncidentMetadata>` | Reads `.bober/incidents/<id>/incident.json` |
| `abort` | `src/incident/orchestrator.ts:316` | `(root, id, AbortOpts) => Promise<AbortResult>` | Writes abort marker + abort-report.md; optional rollback |
| `transitionPhase` | `src/incident/orchestrator.ts:169` | `(root, id, toPhase, opts?) => Promise<void>` | Guarded state-machine transition — NOT needed by Sprint 6 tools |
| `planRollback` | `src/incident/rollback.ts:191` | `(root, id, opts?) => Promise<RollbackPlan>` | Builds rollback plan from changelog |
| `executeRollback` | `src/incident/rollback.ts:337` | `(root, id, plan, opts?) => Promise<RollbackResult>` | Runs each step through risky-action gate |
| `presentPlan` | `src/incident/rollback.ts:281` | `(plan: RollbackPlan) => string` | Renders plan to human-readable string (CLI-only; NOT for MCP) |
| `generatePostmortem` | `src/incident/postmortem.ts:625` | `(root, id) => Promise<PostmortemResult>` | Generates postmortem.md — NOT used by `postmortem_get` (read-only) |
| `loadPlaybooks` | `src/incident/playbook-search.ts:217` | `(root: string) => Promise<Playbook[]>` | Loads & parses `.bober/playbooks/*.md` |
| `searchPlaybooks` | `src/incident/playbook-search.ts:308` | `(symptom, root?) => Promise<PlaybookMatch[]>` | Token-overlap scoring + sort desc |
| `HIGH_CONFIDENCE_THRESHOLD` | `src/incident/playbook-search.ts:25` | `0.6` | Use directly to derive tier — do NOT redefine |
| `LOW_CONFIDENCE_THRESHOLD` | `src/incident/playbook-search.ts:28` | `0.3` | Use directly to derive tier — do NOT redefine |
| `registerTool` | `src/mcp/tools/registry.ts:45` | `(tool: BoberToolDefinition) => void` | Single registration entry point |
| `runManager` | `src/mcp/run-manager.ts` (singleton export) | `RunManager` | Used by Sprints 1-2 tools — NOT needed by Sprint 6 tools |
| `resolveApprover` | `src/cli/commands/approve.ts` (re-exported) | `() => string` | Identity for approval markers — NOT used by Sprint 6 tools |
| `Client` (SDK) | `@modelcontextprotocol/sdk/client/index.js` | `new Client({ name, version }, { capabilities })` | Use in e2e test |
| `StdioClientTransport` | `@modelcontextprotocol/sdk/client/stdio.js` | `new StdioClientTransport({ command, args, env, cwd, stderr })` | Use in e2e test |
| `InMemoryTransport` | `@modelcontextprotocol/sdk/inMemory.js` | `InMemoryTransport.createLinkedPair()` | NOT for sc-6-5; the contract requires a REAL subprocess |

---

## 4. Prior Sprint Output

### Sprint 1: RunManager multi-run + disk persistence
**Created/modified:** `src/mcp/run-manager.ts`, `src/state/run-state.ts` — exports `runManager` singleton (now supports multiple runs), `writeRunState`, `readRunState`, `listRunStateFiles`, `readRunStatesFromDisk`.
**Connection to this sprint:** None directly used by Sprint 6 tools, but the e2e test scenario A (sc-6-6) invokes `bober_run_in_worktree` → which uses `runManager.startRun` internally.

### Sprint 2: Run-management MCP tools
**Created:** `src/mcp/tools/list-active-runs.ts`, `get-run-status.ts`, `abort-run.ts` — these are EXISTING tools the e2e test exercises in scenario A (sc-6-6).

### Sprint 3: Event-stream MCP tool
**Created:** `src/mcp/tools/subscribe-events.ts`, `unsubscribe-events.ts`, `src/mcp/event-stream.ts`. Server-initiated notifications via `bober/events` method. `getEventStream()` is initialized in `src/mcp/server.ts:194`.
**Connection to this sprint:** Scenario B (sc-6-7) subscribes via the existing tool, asserts at least one notification arrives within 5s, then unsubscribes and verifies no further notifications.

### Sprint 4: Worktree adapter
**Created:** `src/orchestrator/worktree.ts` exports `runInWorktree`; `src/mcp/tools/run-in-worktree.ts` exports `registerRunInWorktreeTool`.
**Connection to this sprint:** Scenario A uses `bober_run_in_worktree` to start a parallel run for the run-management lifecycle test.

### Sprint 5: Careful-flow + discovery MCP wrappers
**Created:** `src/mcp/tools/list-pending-approvals.ts`, `approve-checkpoint.ts`, `reject-checkpoint.ts`, `list-projects.ts`, `list-specs.ts`, `get-project-state.ts`. Added `listPendingApprovals` to `src/state/approval-state.ts` and `readRunStatesFromDisk` to `src/state/run-state.ts`.
**Connection to this sprint:** Scenarios C and D (sc-6-8, sc-6-9) exercise these tools. The `projectPath` validation pattern (Pattern B above) was canonicalized in Sprint 5 and MUST be mirrored.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` exists at the repo root (verified). However:
- `.bober/anti-patterns/` directory exists; the curator may inspect specific files there if needed during implementation (out of scope for this briefing).
- The contract `nonGoals` enumerate the explicit anti-patterns to avoid (see "Pitfalls" §9).

### Architecture Decisions
The repo references ADR-9 in `src/orchestrator/pipeline.ts:1-12` (PreflightContextInjector) but no broader `.bober/architecture/` directory exists. The cockpit-integration spec itself (`PlanSpec` at `.bober/specs/`) is the canonical architecture doc for this sprint.

### Other Docs
- `/Users/bober4ik/CLAUDE.md` — instructs use of `code-review-graph` MCP tools first, but this is curator/generator guidance, not project code conventions.
- `package.json` scripts (lines 11-17): `npm run build` → `tsc`; `npm run test` → `vitest`; `npm run typecheck` → `tsc --noEmit`; `npm run lint` → `eslint src/`.
- `bin` entry: `"agent-bober": "dist/cli/index.js"` — confirms the e2e test must spawn `dist/cli/index.js`, NOT a nonexistent `dist/cli.js`.

---

## 6. Testing Patterns

### Unit Test Pattern (per new MCP tool)
**Source:** `src/mcp/tools/get-project-state.test.ts:97-239` (240 lines, fully read).
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerIncidentTools } from "./incident.js";
import { getTool } from "./registry.js";
import { createIncident } from "../../incident/timeline.js";

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-incident-tool-test-"));
  registerIncidentTools();
});
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

describe("bober_incident_start", () => {
  it("is registered with the correct name", () => {
    expect(getTool("bober_incident_start")).toBeDefined();
  });
  it("creates an incident and returns { incidentId, status, createdAt }", async () => {
    const tool = getTool("bober_incident_start")!;
    const result = JSON.parse(await tool.handler({ symptom: "errors spiking", projectPath: tmpDir }));
    expect(result).toMatchObject({ status: "investigating" });
    expect(result.incidentId).toMatch(/^inc-/);
    expect(result.createdAt).toBeTruthy();
  });
  it("returns soft-error for relative projectPath", async () => {
    const tool = getTool("bober_incident_start")!;
    const result = JSON.parse(await tool.handler({ symptom: "x", projectPath: "./relative" }));
    expect(result.error).toBe("projectPath must be absolute");
  });
});
```
**Runner:** `vitest` (per package.json line 16). **Assertion style:** `expect().toMatchObject()` / `.toBe()`. **Mock approach:** prefer NO mocks — exercise real helpers against tmpdir. Use `vi.fn()` only for pipeline injection where unavoidable. **File naming:** `<tool>.test.ts` colocated. **Location:** colocated in `src/mcp/tools/`.

### E2E Test Pattern
**Source:** `tests/e2e/four-modes.test.ts` + `tests/mcp/event-stream-smoke.test.ts` (both fully read).
```ts
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm, stat, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, "..", "..", "dist", "cli", "index.js");
const FIXTURE = join(__dirname, "..", "fixtures", "cockpit-baseline");

beforeAll(async () => {
  try { await stat(CLI_ENTRY); }
  catch { await execa("npm", ["run", "build"], { cwd: join(__dirname, "..", "..") }); }
}, 120_000);

beforeEach(async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "bober-cockpit-e2e-"));
  await cp(FIXTURE, projectRoot, { recursive: true });
  await execa("git", ["init", "-q", "-b", "main"], { cwd: projectRoot });
  await execa("git", ["-c", "user.email=t@t.com", "-c", "user.name=t", "add", "."], { cwd: projectRoot });
  await execa("git", ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: projectRoot });
  // ... store projectRoot, spawn transport, connect client
});
```
**Selector convention:** N/A (no Playwright). **Navigation:** sequential tool calls via `client.callTool({ name, arguments })`. **Timeout:** per-test `30_000` or higher; total budget under 90s (sc-6-11).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/mcp/tools/index.ts` | All 8 new tool modules | medium | The 4 new `import` lines must resolve; `registerAllTools()` must call all 4 register functions before `tests/mcp/tools/tools.test.ts` runs |
| `src/mcp/tools/tools.test.ts` | `registerAllTools()` total count | high | If count not bumped 29→37, test fails immediately |
| `tests/mcp/external-server-graph.test.ts` | Same count + naming assertions | high | Three count assertions must all be bumped consistently |
| `src/mcp/server.ts:134-142` | `getAllTools()` for `tools/list` | low | Dynamic enumeration; no edits needed but verify the e2e test sees 37+ tools |
| `tests/e2e/four-modes.test.ts` | `registerAllTools` not called directly | low | Independent — should still pass |
| `tests/mcp/event-stream-smoke.test.ts` | `registerAllTools()` total set | low | Test does not assert tool count, only that specific tools exist; should still pass |
| `src/incident/timeline.ts`, `src/incident/rollback.ts`, `src/incident/postmortem.ts`, `src/incident/playbook-search.ts` | NEW callers from MCP layer | low | These modules are NOT modified — only newly imported by MCP wrappers. The set of CLI callers in `src/cli/commands/{incident,rollback,postmortem,playbook}.ts` remains intact. |

### Existing Tests That MUST Still Pass
- `src/mcp/tools/list-active-runs.test.ts`, `get-run-status.test.ts`, `abort-run.test.ts` — Sprint 1/2 run-management tools; the e2e test exercises them so any regression surfaces immediately.
- `src/mcp/tools/subscribe-events.test.ts`, `unsubscribe-events.test.ts` — Sprint 3.
- `src/mcp/tools/run-in-worktree.test.ts` — Sprint 4.
- `src/mcp/tools/list-pending-approvals.test.ts`, `approve-checkpoint.test.ts`, `reject-checkpoint.test.ts`, `list-projects.test.ts`, `list-specs.test.ts`, `get-project-state.test.ts` — Sprint 5.
- `tests/mcp/event-stream-smoke.test.ts` — Sprint 3 server-notification integration smoke.
- `tests/orchestrator/incident-lifecycle.test.ts` (if exists) — exercises the same `src/incident/*` helpers wrapped by Sprint 6.
- `tests/e2e/four-modes.test.ts` — Sprint 27 (vision-era) end-to-end test; must remain green.
- `src/incident/timeline.test.ts`, `src/incident/rollback.test.ts`, `src/incident/postmortem.test.ts`, `src/incident/playbook-search.test.ts` (whichever exist) — domain-helper tests.

### Features That Could Be Affected
- **Cockpit careful-flow surface (feat-5)** — Sprint 5 wrappers share `src/state/approval-state.ts`; verify scenario C (sc-6-8) still passes after any tooling reordering in index.ts.
- **Event stream surface (feat-3)** — Sprint 3 owns notifications; scenario B (sc-6-7) must successfully subscribe + receive ≥1 notification + unsubscribe. The fixture must seed a runId that triggers events (e.g., append to `.bober/history.jsonl` after subscribing).
- **Multi-run lifecycle (feat-2)** — Sprint 2 tools; scenario A (sc-6-6) is the lifecycle test.

### Recommended Regression Checks
After implementation, the Generator MUST run:
1. `npm run build` — confirms TypeScript compiles cleanly.
2. `npm run typecheck` — explicit `tsc --noEmit` gate.
3. `npm run lint` — ESLint on src/.
4. `npm run test` — vitest full suite. Must show ALL prior tests still pass + the new e2e test passes.
5. Specifically watch for: `src/mcp/tools/tools.test.ts` and `tests/mcp/external-server-graph.test.ts` count-assertion failures (sign you forgot to bump 29→37 / 35→43).
6. Smoke-time the e2e test alone: `npx vitest run tests/e2e/cockpit-integration.test.ts` — must finish in under 90s, and a SECOND consecutive invocation must also pass (deterministic-mock requirement per stopConditions).
7. **Sanity sabotage (manual, per stopConditions[3])** — temporarily comment out `registerAbortRunTool()` in `src/mcp/tools/index.ts`, run the e2e test, confirm it fails with a CLEAR "tool not found" error (not a timeout). Restore the registration.

---

## 8. Implementation Sequence

1. **Read `src/incident/{timeline,orchestrator,rollback,postmortem,playbook-search}.ts` thoroughly** — confirm exported function signatures match what the briefing shows. (No code change.)
   - Verify: ts-imports resolve without compile error.

2. **Create `src/mcp/tools/incident.ts`** — register 4 incident_* tools in one file.
   - Verify: `node -e "(await import('./dist/mcp/tools/incident.js')).registerIncidentTools()"` (after build) succeeds. Or check via unit test in next step.

3. **Create `src/mcp/tools/incident.test.ts`** — unit-test each of the 4 tools (registration + happy path + soft-error JSON for invalid args).
   - Verify: `npx vitest run src/mcp/tools/incident.test.ts` passes.

4. **Create `src/mcp/tools/rollback.ts` + `rollback.test.ts`**.
   - Verify: rollback tool returns the exact shape from sc-6-2 (`planned: { totalChanges, rollbackableChanges, steps }`).

5. **Create `src/mcp/tools/postmortem.ts` + `postmortem.test.ts`**.
   - Verify: returns `{ content, sections, citations }` for a seeded postmortem.md.

6. **Create `src/mcp/tools/playbook.ts` + `playbook.test.ts`**.
   - Verify: `list` returns array of `{ name, classification, applicableSymptoms }`; `search` returns sorted-desc-by-confidence array with `tier` derived from thresholds.

7. **Modify `src/mcp/tools/index.ts`** — add 4 imports + 4 register calls + bump JSDoc count 29→37 + append 8 entries to the numbered list.
   - Verify: `npx tsc --noEmit` passes.

8. **Bump `src/mcp/tools/tools.test.ts`** — count 29→37 + add 8 names.
   - Verify: `npx vitest run src/mcp/tools/tools.test.ts` passes.

9. **Bump `tests/mcp/external-server-graph.test.ts`** — 5 count-assertion updates (29→37 four times, 35→43 once).
   - Verify: `npx vitest run tests/mcp/external-server-graph.test.ts` passes.

10. **Create `tests/fixtures/cockpit-baseline/`** — `bober.config.json`, `.gitignore` (with `.bober/`), `package.json`, optionally a seeded `.bober/specs/<id>.json`.
    - Verify: `ls tests/fixtures/cockpit-baseline/` shows expected files.

11. **Create `tests/e2e/cockpit-integration.test.ts`** — build CLI in beforeAll; tmpdir + cp + git init in beforeEach; one `describe` block with scenarios A-E (sc-6-6 through sc-6-10) plus the handshake test (sc-6-5).
    - Verify: `npx vitest run tests/e2e/cockpit-integration.test.ts` passes in <90s.

12. **Append CHANGELOG entry** — Sprint 6 description in the same style as recent commits.

13. **Run full verification** — in order:
    - `npm run build`
    - `npm run typecheck`
    - `npm run lint`
    - `npm run test`
    - Re-run the e2e test alone 3 consecutive times to confirm determinism.

---

## 9. Pitfalls & Warnings

- **`dist/cli.js` does NOT exist.** The built CLI is at `dist/cli/index.js`. Use `join(REPO_ROOT, "dist", "cli", "index.js")` in the e2e test. The contract description is inaccurate on this point.

- **`BOBER_TEST_DETERMINISTIC` is not yet implemented anywhere.** A grep over the repo finds zero references (verified). The e2e test should still SET this env var on the spawned subprocess — but the subprocess will simply ignore it. To make sc-6-11 actually deterministic, the e2e test must AVOID code paths that spawn LLM calls. Practically this means:
  - DO NOT call `bober_run` or `bober_sprint` with real model providers in the test.
  - Scenario A's `bober_run_in_worktree` invocation will internally call `runPipeline` which calls `runPlanner` which calls `createClient` from `src/providers/factory.ts` — which throws if `ANTHROPIC_API_KEY` is missing. EITHER set a dummy key OR set `BOBER_TEST_DETERMINISTIC` and add a guard at the top of `src/providers/factory.ts`/`src/orchestrator/planner-agent.ts` that returns a stub response when the env var is set. The contract assumptions field says: "if the var is not yet implemented for all spawn points, the generator extends the suppression to cover the new bober_run_in_worktree path." So the generator MAY need to add a small `if (process.env.BOBER_TEST_DETERMINISTIC === "1") return { ...stub }` guard in the planner/orchestrator entry that scenario A would trigger. Alternatively, scenario A can pass `task` such that the pipeline rejects early (e.g., empty config fails fast), then assert the runId still shows up in `list_active_runs` with status='failed'. **The simplest robust approach:** inject a noop `pipelineFn` via a test-only env hook, or use a non-LLM operation (e.g., simulate the run via `runManager.startRun` directly inside the test file, but that defeats the point of spawning a subprocess). Generator's call.

- **Tool registry is a module-level singleton.** `vi.resetModules()` is needed if a test wants a fresh registry (see `tests/mcp/external-server-graph.test.ts:30-32`). For Sprint 6 unit tests, follow the existing pattern (per-test `registerXxxTool()` in beforeEach, do NOT call `registerAllTools()` — that registers the global set and pollutes other tests).

- **`runManager` is also a module-level singleton.** Tests that interact with run state MUST clear it in beforeEach: `(runManager as unknown as { runs: Map<string, unknown> }).runs.clear();` (verified pattern at `src/mcp/tools/list-active-runs.test.ts:77`).

- **Event stream initialization order matters.** `initEventStream(server, tmpDir, queueBound)` MUST run AFTER `server.connect(transport)` so the transport is live for notifications. The MCP server already handles this (server.ts:184-195). In the e2e test using StdioClientTransport, the spawned subprocess handles this automatically; no test-side action needed.

- **Notification handler API.** Use `client.fallbackNotificationHandler` (NOT `client.onNotification` — that's wrong). Verified at `tests/mcp/event-stream-smoke.test.ts:132`.

- **Postmortem.md does not auto-exist.** Scenario E (sc-6-10) calls `bober_incident_abort`. Abort writes an `abort-report.md` (not a postmortem). If the e2e test also exercises `bober_postmortem_get`, it must FIRST end the incident with `setIncidentStatus(..., "resolved", { verifyResult: { verified: true, reason: "OK" } })` — which fires the auto-postmortem-synthesis trigger (verified at `src/incident/timeline.ts:509-532`). Sprint 6's `bober_incident_*` tools do NOT expose `setIncidentStatus(resolved)` — so testing `postmortem_get` end-to-end requires either: (a) seeding a fake postmortem.md directly with `writeFile` in the test, OR (b) calling `setIncidentStatus` directly from the test imports (bypassing MCP). Per sc-6-10 only abort flow is asserted; postmortem_get unit-test coverage is sufficient.

- **Hard arg errors throw `McpError`, soft errors return JSON.** Per pattern A: required-arg-missing → `throw new McpError(ErrorCode.InvalidRequest, ...)`. Lookup/validation failures (incident not found, projectPath relative) → `return JSON.stringify({ error: "..." })`. Mixing these patterns will fail evaluator review.

- **The cli/index.ts already registers BOTH `bober incident` AND the new MCP tools** — no new CLI registration needed for Sprint 6. The MCP wrappers are NEW tools that REUSE the existing CLI's underlying `src/incident/*` helpers. Verified: `src/cli/index.ts:28-31` already imports `registerIncidentCommand, registerRollbackCommand, registerPostmortemCommand, registerPlaybookCommand`. Do NOT modify these.

- **`presentPlan` is CLI-only.** Do NOT call it from `bober_rollback_start` — it returns a chalk-decorated string for human consumption. The MCP tool returns the structured plan + executed result JSON per sc-6-2.

- **Severity validation must mirror CLI.** `bober_incident_start({ severity })` accepts `"S1" | "S2" | "S3" | "S4"`. Invalid value → soft-error JSON (mirrors `src/cli/commands/incident.ts:217-224`). Do NOT throw McpError for this.

- **Avoid `restart-on-crash` / `circuit-breaker` logic in the e2e test.** Per `src/mcp/external-client.ts:18` SECURITY/isolation note — the subprocess is allowed to crash; the test must FAIL loudly when that happens (e.g., via `client.connect()` throwing). Do NOT add retry loops.

- **Do NOT add new npm dependencies.** Per nonGoals #5: the MCP SDK already provides `Client` + `StdioClientTransport`; `execa` is already in dev deps (see existing tests).

- **Per-test timeout > total timeout.** `it("scenario", async () => {...}, 30_000)` per test; total runtime budget is 90s for the whole describe block. Plan ~5 sub-tests at 15s each.

- **Sanity sabotage is a stopCondition, not a written test.** Per generator-notes: "Sanity-sabotage instructions can be folded into a `.skip`'d test demonstrating the failure mode (or just documented in evaluatorNotes for manual verification)." Recommended: document the sabotage procedure as a `// ── SANITY SABOTAGE INSTRUCTIONS ──` comment block at the top of the e2e test file rather than committing a skipped test that could be accidentally enabled.

