# Storage & Database Model

agent-bober is **local-first**. Every piece of state a run produces — facts, findings, research
jobs, vault notes, approval markers, the event log — lives under the project's **`.bober/`**
directory. The **only** database engine is **SQLite**, accessed synchronously through the
[`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) package dependency; everything else
is plain JSON or markdown on disk. There is **no server, no daemon, and no cloud store** by
default, and every cloud/egress path is opt-in and fail-closed (see
[Configuration](#configuration--boberconfigjson) below).

This document is the reference for **where everything is stored and how to set it up**. For the
subsystems that produce these artifacts, see [`./fleet.md`](./fleet.md),
[`./research-scheduler.md`](./research-scheduler.md), [`./telegram.md`](./telegram.md),
[`./providers.md`](./providers.md), and the platform guide
[`./knowledge-platform.md`](./knowledge-platform.md).

---

## The FactStore (SQLite) — `src/state/facts.ts`

`FactStore` is the single SQLite abstraction. It is **bi-temporal** (it tracks both world-time —
when a fact was true — and record-time — when the row was written/closed) and it is **PURE with
respect to the clock**: it **never** calls `Date.now()` or `new Date()`. Every timestamp is a
parameter, injected by the caller at the CLI boundary. This is what makes runs deterministic and
replayable.

```ts
new FactStore(
  dbPath: string,
  opts?: { journalModeWal?: boolean; busyTimeoutMs?: number; readonly?: boolean },
)
```

- `journalModeWal` → issues `PRAGMA journal_mode = WAL` (used by the fleet blackboard for
  concurrent writers).
- `busyTimeoutMs` → issues `PRAGMA busy_timeout = <ms>` so concurrent writers back off instead of
  failing with `SQLITE_BUSY`.
- `readonly` → opens the file read-only and **skips** the `CREATE TABLE` bootstrap.

### Table `semantic_facts`

The constructor bootstraps exactly one table (unless `readonly`):

```sql
CREATE TABLE IF NOT EXISTS semantic_facts (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence REAL NOT NULL,
  source_run_id TEXT,
  t_valid TEXT NOT NULL,
  t_invalid TEXT,
  t_created TEXT NOT NULL,
  t_invalidated TEXT
);
CREATE INDEX IF NOT EXISTS idx_facts_sp ON semantic_facts(scope, subject, predicate);
CREATE INDEX IF NOT EXISTS idx_facts_active ON semantic_facts(scope, t_invalidated);
```

- `t_valid` / `t_invalid` are **world-time** bounds (when the fact became / stopped being true).
- `t_created` / `t_invalidated` are **record-time** bounds (when the row was written / closed).
- A fact is **active** when `t_invalidated IS NULL` — the `idx_facts_active` index makes the active
  scan fast.

### Deterministic ids

`id` is a **deterministic 16-char hex** derived by `factId(scope, subject, predicate, value,
tCreated)` — a `sha256` of `scope|subject|predicate|value|tCreated` sliced to 16 chars. Identical
inputs always produce the same id, with **no wall-clock dependency**, so re-inserting the same fact
is idempotent (via `INSERT OR REPLACE`).

### API

| Method | Behavior |
|--------|----------|
| `insertFact(input)` | Validates `input` with the Zod `FactSchema`, derives the id, and does an `INSERT OR REPLACE`. Returns the persisted `FactRecord`. Throws on schema-invalid input. |
| `getActiveFacts(scope, subject?, predicate?)` | All facts in `scope` where `t_invalidated IS NULL`, optionally narrowed by `subject` and/or `predicate`. |
| `getFact(id)` | A single fact by id **regardless** of invalidation status; `null` if absent. |
| `invalidateFact(id, tInvalidated)` | **Soft-delete**: sets `t_invalidated`. Never deletes rows. Returns `false` if already invalidated or absent. |
| `supersedeFact(id, tInvalidated, tInvalid)` | Closes **both** the record-time (`t_invalidated`) and world-time (`t_invalid`) ends — used by the reconcile layer on `UPDATE`. |
| `close()` | Closes the underlying connection. |

**Rows are never physically deleted** — invalidation is always a soft-delete, so the full history
stays auditable.

### Where the file lives — path helpers

```ts
factsDbPath(projectRoot, namespace?)  // → <memoryDir>/facts.db  (absolute)
ensureFactsDir(projectRoot, namespace?)  // mkdir -p the parent dir
```

- **Default pool:** `factsDbPath(root)` → `.bober/memory/facts.db`.
- **Namespaced pool:** `factsDbPath(root, "medical")` → `.bober/memory/medical/facts.db`. (The
  namespace `"programming"` — and empty/undefined — map to the **default** dir, no subdir.)
- Call **`ensureFactsDir` before opening a file-backed store** — the constructor does not create the
  parent directory. The sentinel path `':memory:'` skips both WAL and directory creation (used in
  tests).

`FactStore` is the store behind: research-run **Findings** (the priority hub), the **fleet
blackboard**, and the **memory / facts** subsystem — all three share the same table shape, isolated
by `scope`, `namespace`, or db file.

---

## The shared fleet blackboard — `src/fleet/shared-blackboard.ts`

`SharedBlackboard` is a thin, bounded inter-agent exchange wrapper over **one** `FactStore` opened
in **WAL mode** with a `busy_timeout` (default **5000 ms**), so concurrent fleet child processes can
publish findings to the same db file without `SQLITE_BUSY` deadlocks. Rounds are capped at
`BLACKBOARD_MAX_ROUNDS = 3`.

```ts
await SharedBlackboard.open({ dbPath, namespace, busyTimeoutMs?, maxRounds? })
```

| Method | Behavior |
|--------|----------|
| `publish({ childFolder, round, payload, confidence? }, now)` | Inserts a fact with `scope = namespace`, `subject = childFolder`, `predicate = "finding"`, `value = payload`, `confidence` defaulting to `1`. **Throws** when `round > maxRounds`. |
| `readSiblings(selfFolder)` | All active `finding` facts in the namespace **except** your own (`subject !== selfFolder`). |
| `readAll()` | All active `finding` facts in the namespace. |
| `close()` | Closes the underlying `FactStore`. |

The db file lives at the **absolute** path `<rootDir>/.bober/memory/<namespace>/facts.db`, resolved
by the fleet head and threaded into each child's config (never re-derived from the child's cwd). See
[`./fleet.md`](./fleet.md) for the round loop, early-stop, and synthesis flow.

---

## JSON stores

| Store | Path | Schema / owner |
|-------|------|----------------|
| **Research jobs** | `.bober/research/jobs/<jobId>.json` | `ResearchJobSchema` (`src/research/types.ts`), managed by `research/job-store.ts`. See [`./research-scheduler.md`](./research-scheduler.md). |
| **Loop sessions** | `.bober/sessions/<sessionId>.json` | `SessionRecordSchema` (`src/orchestrator/session-store.ts`), managed by `SessionStore` (same `safeParse`-both-ways / `null`-on-corrupt pattern as `job-store.ts`). The own agentic loop's provider-agnostic `Message[]` transcript + metadata, persisted per turn **only when opt-in** `AgenticLoopParams.session` is set — **no pipeline role auto-enables it**. `resumeSession` / `forkSession` (loop model-context continuity). **Distinct** from the chat `/resume` store (`.bober/chat/`) and do-bridge's `sessionId`. |
| **Approval markers** | `.bober/` checkpoint marker files (`.pending.json` / `.approved.json` / `.rejected.json`) | `src/state/approval-state.ts`. Written by **both** the `approve` / `reject` CLI **and** the Telegram `/pending` inline buttons — **the same markers**, no separate mechanism. See [`./telegram.md`](./telegram.md). |
| **History / event log** | `.bober/history.jsonl` (+ `history.archive.jsonl`) | Append-only JSONL, **rotated**: the newest `history.maxActiveLines` (default **2000**) entries stay in `history.jsonl`; older overflow moves to `history.archive.jsonl`. |

---

## Generated artifacts (markdown / JSON)

These are outputs a subsystem writes for a human or a downstream reader to consume:

| Artifact | Path | Notes |
|----------|------|-------|
| **Vault notes** | `<vaultRoot>/research/<YYYY-MM-DD>-<marker>.md` | Markdown + YAML frontmatter (`research/note-writer.ts`). Default `vaultRoot` is the **project root**. |
| **Research digests** | `.bober/research/digests/<YYYY-MM-DD>.md` and `.json` | Time-window aggregation (`research/digest.ts`); the `.json` feeds the Telegram silent digest. |
| **Fleet report** | `<rootDir>/.bober/fleet-report.json` | `{ total, completed, failed, other, generatedAt, children, rounds? }`. Written atomically (temp file + rename) on **every** fleet run; `rounds` present only on blackboard runs. |
| **Fleet synthesis** | `<rootDir>/.bober/fleet-synthesis.json` | `{ rounds, childResults, findings[] }` (`src/fleet/synthesis.ts`). Written atomically (temp + rename, mode `0600`) **only on blackboard runs**. Consumed by the Telegram `/fleet` view. |
| **Fleet manifest provenance** | `<out>.meta.json` sidecar + `<out>.bak` | Written by `fleet expand` / `fleet expand-deep`: a provenance sidecar next to the generated manifest, plus preservation of the prior manifest as `.bak` on overwrite. |
| **Security audit** | `.bober/security/<contractId>-security-audit.md` | Human-readable audit artifact rendered by reusing `renderReviewMarkdown(result.review)` (`src/state/security-audit-state.ts`; `saveSecurityAudit`/`readSecurityAudit`/`listSecurityAudits`). **Separate** from the advisory reviewer's `.bober/reviews/` per ADR-3 (no filename collision). Written by the `runSecurityAudit` core (`src/orchestrator/security-auditor-agent.ts`), which persists here on every audit (spec-20260712 sprint 2). As of **sprint 3** the fail-closed pipeline gate (`evaluateSecurityGate`, `src/orchestrator/security-gate.ts`) invokes that core on every passing sprint when `security.enabled === true`; as of **sprint 4** the standalone `bober security-audit [target]` CLI (`src/cli/commands/security-audit.ts`) invokes it on demand (no `enabled: true` required) and persists here too. |

---

## Configuration — `bober.config.json`

Runtime configuration is **one Zod-validated file per project** (or per fleet child),
`bober.config.json`, defined by `BoberConfigSchema` in `src/config/schema.ts`. The sections most
relevant to storage and the local-first / egress posture:

### Fleet (child-visible) — `fleet`

Written into **each child's** `bober.config.json` by the fleet scaffolder. A child with **no**
`fleet` section is **not** part of a blackboard run.

```jsonc
"fleet": {
  "blackboardDbPath": "/abs/path/.bober/memory/<namespace>/facts.db", // absolute
  "blackboardNamespace": "<namespace>",
  "blackboardSubject": "<child-folder>",   // this child's subject id
  "maxRounds": 3                            // 1–3
}
```

The child reads the **absolute** `blackboardDbPath` from this section only — never re-derived from
cwd. See [`./fleet.md`](./fleet.md).

### Egress axes — all default **OFF / fail-closed**

Every outbound-network capability is a distinct, optional, boolean opt-in that defaults to `false`.
**Zero outbound bytes leave the machine unless the corresponding axis is explicitly set to `true`.**

| Config key | Default | Enables |
|------------|---------|---------|
| `research.egress.onlineResearch` | `false` | Online / web research retrieval |
| `medical.egress.cloudInference` | `false` | Cloud inference synthesis (else local Ollama) |
| `medical.egress.literatureRetrieval` | `false` | MedlinePlus literature retrieval |
| `medical.egress.deviceConnection` | `false` | WHOOP device-connection egress |
| `calendar.egress.cloudCalendar` | `false` | Google Calendar (cloud); default connector is local `ics` |
| `taskInbox.gmailEgress` | `false` | Reading a Gmail thread via the MCP connector |
| `telemetry.enabled` | `false` | Local-only JSONL telemetry (no network under any condition) |

When an axis is off, the corresponding client is typically **never even constructed**, so there is
no dormant network path to misfire.

### Tools (opt-in MCP bridge) — `tools`

The optional `tools` section (`ToolsSectionSchema`, `src/config/schema.ts`) carries one **default-off**
axis, `tools.mcpBridge`, that lets the agentic loop's tool catalog be extended by a configured MCP
server (agent-loop-capability-port sprint 10).

```jsonc
"tools": {
  "mcpBridge": {
    "enabled": false,                                  // default; opt-in only
    "server": { "command": "npx", "args": ["-y", "some-mcp-server"] }
  }
}
```

| Config key | Default | Enables |
|------------|---------|---------|
| `tools.mcpBridge.enabled` | `false` | Expose a configured MCP server's tools as `mcp__`-prefixed loop `ToolDef`s |

The bridge reuses the repo's existing `@modelcontextprotocol/sdk` client transport (no new dependency)
and is **not** written by `createDefaultConfig`. Like the egress axes, when disabled **no MCP
process/transport is ever created** and the loop's tool list is unchanged. The bridge is only ever
constructed by a consumer that reads `tools.mcpBridge.enabled === true` at its call site (never at
config parse time), keeping `runAgenticLoop` itself hermetic. See
[`./providers.md`](./providers.md#in-process-subagents--opt-in-mcp-tool-bridge).

### Security auditor (opt-in gate) — `security`

The optional `security` section (`SecuritySectionSchema`, `src/config/schema.ts`) configures the
stack-aware `bober-security-auditor` role (spec-20260712). It is **opt-in and default-off**:
`enabled` defaults to `false` and the whole section is wired `.optional()` on `BoberConfigSchema` with no
top-level default, so a config that omits `security` parses **byte-identically** to before (no key, no
defaults). It is **not** written by `createDefaultConfig` or any preset.

```jsonc
"security": {
  "enabled": false,                     // default; opt-in only
  "failClosed": true,                   // unparseable output / timeout blocks. Default true
  "timeoutMs": 300000,
  "model": "opus",
  "maxTurns": 20,
  "scanners": [],                       // opt-in deterministic pre-filter strategies (EvalStrategy[]) — slither/semgrep parsed into priors (sprint 5)
  "standaloneBlockOn": "critical",      // 'critical' | 'important' — CI blocking threshold for `bober security-audit`
  "hub": true                           // emit critical/important findings to the priority hub (sprint 6). false => zero hub writes
}
```

As of **spec-20260712 sprint 3** the **audit engine is wired into the pipeline as a fail-closed gate**.
Sprint 1's foundation (this schema section, the wrapper types
`SecurityFinding`/`VulnClass`/`SecurityAuditResult`/`deriveVerdict` in
`src/orchestrator/security-audit-types.ts` over the **locked** `ReviewResult`/`ReviewFinding` shapes,
and the `.bober/security/` store) and sprint 2's callable provider-agnostic `runSecurityAudit` core
(`src/orchestrator/security-auditor-agent.ts`) — a **fail-closed** parser (unparseable output →
`parsed:false`, verdict `blocked`, never a silent pass), a stack-knowledge injector
(`resolveStackSecurityContext`, `src/orchestrator/stack-knowledge.ts`), and the read-only
`agents/bober-security-auditor.md` subagent (`Read`/`Grep`/`Glob` only — no `Bash`/`Write`/`Edit`) —
are now driven by `evaluateSecurityGate` (`src/orchestrator/security-gate.ts`). When
`security.enabled === true`, the gate runs at the **top** of `runSprintCycle`'s `if (evaluation.passed)`
branch (before the sprint is marked `passed`): a critical finding, a `Promise.race` timeout
(`timeoutMs`), an unparseable audit, or any thrown audit error **blocks** the sprint (no `sprint-passed`;
a `security-audit-blocked` history event; the findings routed into the next generator iteration's
feedback; code-review + documenter skipped), while a clean audit records `security-audit-clean` and falls
through unchanged. `runSecurityAudit` reads `security.{model,provider,endpoint,providerConfig,maxTurns,budget}`
and honors `config.project.stack`. When `security` is **absent or `enabled !== true`** the branch is
skipped entirely and the pipeline is **byte-identical** to before.

As of **sprint 4** the same core has an on-demand entry point: the **standalone `bober security-audit
[target]` CLI** (`src/cli/commands/security-audit.ts`, `runStandaloneSecurityAudit`). It runs
`runSecurityAudit(descriptor, null, projectRoot, config)` against any local path (or the working tree),
persists the same `.bober/security/` artifact, prints a cited summary, and exits `0`/`2` on a **configurable**
threshold (`standaloneBlockOn` — `critical` default, or `important`; fail-closed on a thrown/unparseable
audit). Unlike the gate, the standalone command does **not** require `enabled: true` (the invocation is the
opt-in) and it reads `standaloneBlockOn`; the gate's critical-only veto is untouched (`thresholdVerdict`
lives in the CLI module, never in `security-gate.ts`).

As of **sprint 5** the `scanners` key is **live**: `runScannerPreFilter`
(`src/orchestrator/security-scanners.ts`) runs each configured `EvalStrategy` command via `execa` under an
`AbortSignal` derived from `timeoutMs`, parses **slither** and **semgrep** JSON output into typed
`SecurityFinding` priors (`parseSlitherOutput` / `parseSemgrepOutput` — pure, fixture-tested, **no binaries
required in CI**), degrades unknown scanners to a bounded raw-text excerpt, and folds the result into
`runSecurityAudit`'s `priors` seam (signature unchanged) so both the gate and the standalone CLI inherit the
priors for free. Each scanner is **isolated** (missing binary / nonzero exit / thrown error yields `[]` for
that scanner only; the pre-filter never rejects) and time-boxed with `killSignal: "SIGKILL"` (partial findings
survive an abort). Scanner findings are **advisory priors** — they seed the auditor prompt but never bypass
the LLM or drive the verdict. With `scanners` **absent or `[]`** no child process is spawned and behavior is
byte-identical to sprint 2 (ADR-4). **Ceiling:** ANY nonzero exit yields `[]` for that scanner, so operators
of tools whose convention is nonzero-on-findings (e.g. `semgrep --error`) must configure an **exit-0**
command.

As of **sprint 6** the `hub` key is **live**: after an audit's verdict/exit code is computed, both the gate
and the standalone CLI map the audit's confirmed **critical** (→ hub severity/urgency **5**) and **important**
(→ **3**) findings into canonical hub `Finding` rows and ingest them into the default FactStore pool
(`.bober/memory/facts.db`) — so audit results now appear in `bober hub list` / `hub priority`. The mapper
(`mapAuditToFindings`, `src/orchestrator/security-hub.ts`) is **pure** and imports the canonical
`FindingSchema` from `src/hub/finding.ts` (never redefined); dedup is delegated to the hub's existing
content-hash id (`sha256(domain|title|kind)`) via a **stable** `[security] <vulnClass> #<discriminator>
at <path>:<line>` title, so retries are idempotent (proven against the real finding-store in a temp dir).
The `#<discriminator>` (prefers `signatureId`, then `cwe`, then a short `sha256` of the finding's own
`description`) was added by **spec-20260714 sprint 1** to fix a title collision (**G10**) where two
distinct vulns of the same `vulnClass` at the same `path:line` hashed to one id; new metadata rides the
`Finding` tags (`cwe:`/`severity:`/`confidence:`/`sig:`) rather than new schema fields. Emission is gated by
`security.hub` (default `true`; `false` → **zero** hub writes) and is strictly **best-effort** — the entire
default-sink sequence (`ensureFactsDir` → `new FactStore` → emit → `close`) is wrapped in a single guard at
both call sites, so a hub/fs failure is caught and logged and can **never** change the audit verdict or exit
code (a clean audit or `hub:false` never even opens the store). `minor` findings and `approvedAreas` are
never emitted.

As of **sprint 7** the operator surface is complete and the feature is fully shipped. An advisory
**`bober.security-audit` skill** (`skills/bober.security-audit/SKILL.md`, mirroring `bober.code-review`)
spawns the same `bober-security-auditor` subagent — or points at the CLI — for on-demand audits, presents
severity-ranked findings, and persists to the same `.bober/security/` artifact (advisory-only: it never
blocks and never writes code fixes). agent-bober's **own** `bober.config.json` now opts into **LLM-only
dogfooding** (`security: { enabled: true, scanners: [] }`), so every future sprint of this repo runs the
fail-closed gate on LLM judgment alone (no `slither`/`semgrep` binaries required). The whole feature —
config reference for all 12 `SecuritySectionSchema` fields, gate semantics, CLI exit codes, scanners, hub
emission, and fail-closed guarantees — is consolidated in
[`docs/security-audit.md`](./security-audit.md). **spec-20260712 is complete (7/7 sprints).** See
[sprint 1](./sprints/sprint-spec-20260712-security-audit-agent-team-1.md),
[sprint 2](./sprints/sprint-spec-20260712-security-audit-agent-team-2.md),
[sprint 3](./sprints/sprint-spec-20260712-security-audit-agent-team-3.md),
[sprint 4](./sprints/sprint-spec-20260712-security-audit-agent-team-4.md),
[sprint 5](./sprints/sprint-spec-20260712-security-audit-agent-team-5.md),
[sprint 6](./sprints/sprint-spec-20260712-security-audit-agent-team-6.md), and
[sprint 7](./sprints/sprint-spec-20260712-security-audit-agent-team-7.md).

### Provider fields (on roles)

Each agent role (`planner`, `generator`, `evaluator`, `curator`, `codeReview`, `documenter`,
`chat`, …) accepts optional `provider`, `endpoint`, `providerConfig`, and `model` fields to select
and configure the LLM backend. See [`./providers.md`](./providers.md) for the full provider matrix
and model shorthands.

### API keys are never persisted

agent-bober **never writes API keys to disk**. Provider credentials come from the **environment**
(named env vars, resolved per role) or from a runtime `providerConfig`; `.env` is gitignored. The
config file carries provider *selection*, never secrets.

---

## `.bober/` directory map

```
.bober/
  memory/facts.db                     # FactStore — hub Findings, memory (default pool)
  memory/<namespace>/facts.db         # namespaced FactStore / fleet blackboard (WAL)
  research/jobs/<jobId>.json          # research job store
  research/digests/<date>.{md,json}   # research digests
  sessions/<sessionId>.json           # own agentic-loop transcript (opt-in resume/fork)
  security/<contractId>-security-audit.md  # security-auditor artifact (written by runSecurityAudit; invoked by the fail-closed pipeline gate when security.enabled OR on demand via `bober security-audit`)
  fleet-report.json                   # last fleet run summary (always written)
  fleet-synthesis.json                # last blackboard run (Telegram /fleet reads this)
  history.jsonl                       # event log (rotated → history.archive.jsonl)
  <checkpoint>.pending|approved|rejected.json  # approval markers (CLI + Telegram, same store)
  <vault>/research/<date>-<marker>.md # research vault notes (default vaultRoot: project root)
```

---

## Engineering notes

- **Clock-free stores.** `FactStore` (and the research/fleet pipelines around it) never read the
  wall clock; every timestamp is injected at the CLI `.action()` boundary and threaded down. This
  keeps runs deterministic and replayable.
- **Close per operation.** The FactStore is opened and `close()`d per CLI operation to avoid
  cross-iteration file locks.
- **Atomic writes.** JSON artifacts (`fleet-report.json`, `fleet-synthesis.json`) are written to a
  temp file and `rename`d into place (mode `0600` where PHI-adjacent) so a crash never leaves a
  half-written file.
- **Driver is swappable.** `better-sqlite3` sits behind the `FactStore` interface. Two future swaps
  are flagged as `bober:` comments in the source: **`node:sqlite`** once `engines.node` is raised to
  ≥ 22.5, and a **network WAL (Turso / libSQL)** if a fleet ever needs cross-machine exchange (the
  blackboard is single-host today).

---

## Cross-links

- [`./fleet.md`](./fleet.md) — the multi-LLM fleet, the blackboard round loop, and synthesis.
- [`./research-scheduler.md`](./research-scheduler.md) — research jobs, vault notes, digests.
- [`./telegram.md`](./telegram.md) — the presentation adapter, approval markers, `/fleet` view.
- [`./providers.md`](./providers.md) — provider selection, endpoints, model shorthands.
- [`./knowledge-platform.md`](./knowledge-platform.md) — the top-level platform guide.
