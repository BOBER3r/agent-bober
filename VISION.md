# agent-bober Vision

## Why agent-bober Exists

agent-bober is a software engineering teammate. It operates in four modes — autopilot for spikes,
careful-flow for production changes, diagnose for incidents, postmortem for retrospectives. The
foundation across all four modes is behavior-shaping discipline ported verbatim from
[obra/superpowers](https://github.com/obra/superpowers): Iron Laws, Red Flags,
Rationalization-Prevention tables. The harness coordinates many agents; the disciplines keep each
one rigorous.

The core insight from Anthropic's [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps):
separating code generation from code evaluation creates a feedback loop that catches errors early.
agent-bober packages those patterns — Researcher, Planner, Curator, Generator, Evaluator — into an
installable workflow with built-in guardrails, context resets, and honest evaluation.

---

## The Four Modes

| Mode | When | Entry Point |
|------|------|-------------|
| **Autopilot** | Feature spikes, greenfield work, no production risk | `bober run` |
| **Careful-Flow** | Production behavior changes, want diff approval at checkpoints | `bober run --mode careful` |
| **Diagnose** | Production system is broken right now | `bober incident start` |
| **Postmortem** | After resolving an incident, want a retrospective | `bober postmortem generate` |

Each mode shares the same agent pipeline (Researcher → Planner → Curator → Generator → Evaluator).
The modes differ in how the pipeline gates checkpoints and handles risky actions.

---

## Mode 1: Autopilot

### When to Use

Use autopilot when you are building a new feature, spiking an idea, or working in a greenfield
environment where a wrong change has low blast radius. Autopilot auto-approves all checkpoints and
lets the pipeline run from start to finish without interruption.

Do NOT use autopilot when the change touches production behavior, modifies user-visible state, or
could cause data loss. Reach for careful-flow instead.

### Command / Skill Entry Point

```
bober run "feature description"
/bober-run
```

or with explicit mode flag:

```bash
bober run "feature description" --mode autopilot
```

### What Gets Created on Disk

```
.bober/
  specs/<specId>.json          Plan specification
  contracts/<contractId>.json  Sprint contracts (one per sprint)
  briefings/<contractId>.md    Curator briefings (codebase context per sprint)
  eval-results/<id>.json       Evaluator output per sprint
  approvals/                   Empty in autopilot (no pending checkpoints)
  progress.md                  Human-readable progress tracker
  history.jsonl                Machine-readable event log
```

### Worked Example

```bash
# Start a full autonomous pipeline — no interruptions
$ bober plan 'Add CSV export to the users table page'
$ bober run
# Pipeline: researcher → planner → curator → generator ↔ evaluator (per sprint)
# 4 sprints execute, each evaluated and committed — approximately 30 minutes
# Output: feature branch bober/csv-export with commits per sprint
```

---

## Mode 2: Careful-Flow

### When to Use

Use careful-flow when the change touches production behavior — a database migration, an API
contract change, an auth flow refactor, or anything where you want a human to review intermediate
artifacts before the pipeline continues. The careful-flow mode inserts disk-based checkpoints
(`.bober/approvals/<id>.pending.json`) at key pipeline transitions. The pipeline blocks until you
run `bober approve`.

Careful-flow is the right default for brownfield work on production systems.

### Command / Skill Entry Point

Two equivalent ways to activate careful-flow:

**Option A — CLI flag (ephemeral, for a single run):**

```bash
bober run "feature description" --mode careful
```

**Option B — config (persistent, for all runs on this project):**

Edit `bober.config.json`:

```json
{
  "pipeline": {
    "mode": "careful"
  }
}
```

You can also control the checkpoint mechanism explicitly:

```bash
bober run --mode careful --checkpoint disk     # write .pending.json files (default)
bober run --mode careful --checkpoint pr       # open a GitHub PR for each checkpoint
bober run --mode careful --checkpoint cli      # block on stdin confirmation
```

### What Gets Created on Disk

```
.bober/
  approvals/<checkpointId>.pending.json   Pending approval requests
  approvals/<checkpointId>.approved.json  Written by `bober approve` to unblock
  approvals/<checkpointId>.rejected.json  Written by `bober reject` to abort
  audit/<runId>.jsonl                     Immutable audit log of all decisions
```

### Worked Example

```bash
# Migrate from JWT to session cookies — production auth change
$ bober plan 'Migrate from JWT to session cookies'
$ bober run --mode careful --checkpoint disk
# Pipeline runs researcher → planner, then pauses

$ bober list-approvals
# CHECKPOINT ID                          AGE      PROMPT
# post-research-spec-20260524-jwt-1      2m 14s   Approve research doc before planning
$ bober approve post-research-spec-20260524-jwt-1
# Pipeline resumes: planner produces contracts, then pauses again

$ bober list-approvals
# post-plan-spec-20260524-jwt-1          1m 05s   Approve sprint plan before executing
$ bober approve post-plan-spec-20260524-jwt-1 --edit ./my-edits.md
# Planner incorporates edits; pipeline proceeds to generator ↔ evaluator loop
```

---

## Mode 3: Diagnose (Incident Response)

### When to Use

Use diagnose when a production system is broken and you need a structured investigation and
remediation loop. The diagnoser agent receives live observability data (configured via
`observability.providers`), proposes hypotheses, executes actions, and verifies resolution
criteria. Risky actions (destructive commands, config changes) automatically trigger approval
checkpoints regardless of `pipeline.mode`.

### Command / Skill Entry Point

```
bober incident start '<symptom>' --severity S1|S2|S3|S4
```

### What Gets Created on Disk

```
.bober/
  incidents/<incidentId>/
    incident.json          Full incident record (status, severity, timeline)
    diagnosis.md           Current diagnosis and confidence score
    actions.jsonl          Executed actions with inverse operations recorded
    postmortem.md          Auto-generated after resolution (if incident.autoPostmortem=true)
```

### Worked Example

```bash
# Production checkout endpoint returning 500 errors
$ bober incident start '500 errors on checkout endpoint' --severity S2
# Incident created: inc-20260524-500-errors-on-checkout
# Artifacts at .bober/incidents/inc-20260524-500-errors-on-checkout/

$ bober incident status inc-20260524-500-errors-on-checkout
# Phase:     investigating
# Severity:  S2
# Duration:  4m 12s
# Diagnosis: connection pool exhausted (confidence: high)
# Actions:   0 executed, 1 proposed
# Proposed risky action: kubectl scale deployment/api --replicas=5

$ bober approve risky-action-act-1  # gate fires for all risky actions
# Diagnoser executes scale; postcondition verifies

$ bober incident status inc-20260524-500-errors-on-checkout
# Phase:     monitoring
# Resolution criteria: api.checkout.error_rate < 0.001 for 10m
# Verifying... (8m remaining)

$ bober incident end inc-20260524-500-errors-on-checkout --verified
# Incident resolved. Postmortem synthesis triggered.
# Postmortem at .bober/incidents/inc-20260524-500-errors-on-checkout/postmortem.md
```

If the situation worsens:

```bash
$ bober rollback inc-20260524-500-errors-on-checkout --dry-run
# Shows plan: revert 1 executed change (kubectl scale back to 2)
$ bober rollback inc-20260524-500-errors-on-checkout
# Executes rollback; each step gated as a risky action

# Or abort entirely:
$ bober incident abort inc-20260524-500-errors-on-checkout \
    --reason "False alarm — alerting misconfiguration" \
    --confirm-rollback
```

---

## Mode 4: Postmortem

### When to Use

Use postmortem after resolving an incident to synthesize a structured retrospective from the
incident timeline, diagnosis history, and executed actions. If `incident.autoPostmortem` is true
(the default), postmortem synthesis fires automatically when you run `bober incident end`. Use
`bober postmortem generate` to regenerate after adding new artifacts or correcting the timeline.

### Command / Skill Entry Point

```
bober postmortem generate <incidentId>
bober postmortem show <incidentId>
```

### What Gets Created on Disk

```
.bober/
  incidents/<incidentId>/
    postmortem.md    Synthesized retrospective document
```

### Worked Example

```bash
# After resolving an incident, view the auto-generated postmortem
$ bober postmortem show inc-20260524-500-errors-on-checkout
# Renders the synthesized postmortem to stdout

# Add additional context, then regenerate
$ echo "## Follow-up" >> .bober/incidents/inc-20260524-500-errors-on-checkout/notes.md
$ bober postmortem generate inc-20260524-500-errors-on-checkout
# Regenerated: .bober/incidents/inc-20260524-500-errors-on-checkout/postmortem.md
```

---

## Choosing a Mode

When you are not sure which mode to use, work through this table:

| Situation | Recommended Mode | Rationale |
|-----------|-----------------|-----------|
| Building a feature in a spike, no prod impact | Autopilot | No checkpoints needed; let the pipeline run |
| Changing production behavior, want diff approval | Careful-Flow | Disk checkpoints let you review before each phase |
| Refactoring code with high test coverage | Autopilot | Evaluator catches regressions; no manual gate needed |
| Refactoring code that touches user-facing behavior | Careful-Flow | Even with tests, user-facing behavior deserves human review |
| Production is broken right now | Diagnose | Structured investigation + risky-action gates |
| After resolving an incident, want a retrospective | Postmortem | Synthesizes timeline, diagnosis, and actions into a document |
| Database migration on production schema | Careful-Flow | Schema changes are irreversible; gate before executing |
| Greenfield project, building everything from scratch | Autopilot | No existing production traffic to protect |
| CI/CD batch job with no human available | Autopilot + `allowAutopilotRiskyActions: true` | Footgun — see Configuration Reference below |

**Gray-area rule of thumb:** if the change is irreversible OR touches user-visible state OR has no
automated rollback path, use careful-flow. When in doubt, careful-flow costs one `bober approve`
per checkpoint. That is a small price for an irreversible mistake.

---

## Configuration Reference

All configuration lives in `bober.config.json` at your project root. Fields are listed below by
section, alphabetically within each section, with default values and the sprint that introduced
each field.

### `pipeline` section

| Field | Type | Default | Since | Description |
|-------|------|---------|-------|-------------|
| `pipeline.allowAutopilotRiskyActions` | `boolean` | `false` | Sprint 20 | Footgun escape hatch for fully-automated environments (CI, batch jobs). When `false`, risky actions always trigger a non-noop checkpoint even in autopilot mode. When `true`, risky actions are auto-approved with a stern warning — the audit trail is still written. Do not set to `true` in interactive environments. |
| `pipeline.approvalTimeoutMs` | `number` | `86400000` (24h) | Sprint 14 | How long (ms) the `disk` and `cli` checkpoint mechanisms wait for approval before timing out. |
| `pipeline.checkpointMechanism` | `'noop'\|'cli'\|'disk'\|'pr'` | unset (derived from `mode`) | Sprint 14 | Global default checkpoint mechanism. When unset, resolved from `pipeline.mode`: `autopilot` → `noop`, `careful` → `disk`. Override per-checkpoint with `checkpointOverrides`. |
| `pipeline.checkpointOverrides` | `Record<string, mechanism>` | `{}` | Sprint 14 | Per-checkpoint mechanism overrides. Keys are checkpoint IDs (e.g., `'post-research'`); values are mechanism names. Use to force `pr` for the plan review while keeping `disk` elsewhere. |
| `pipeline.engine` | `'ts'\|'skill'\|'workflow'` | `'ts'` | 0.16.0 | Orchestration engine selection behind the engine-selection seam. `'ts'` runs the built-in TypeScript pipeline (default). `'skill'` and `'workflow'` select alternative engines; an eligibility probe downgrades `'workflow'` → `'ts'` when ineligible or in `careful` mode. No behavior change on the default `'ts'` path. |
| `pipeline.maxCheckpointIterations` | `number` | `3` | Sprint 12 | Maximum times the router re-invokes a responsible agent after a checkpoint rejection. Range: 1–10. |
| `pipeline.mode` | `'autopilot'\|'careful'` | `'autopilot'` | Sprint 14 | Pipeline execution mode. `autopilot` auto-approves all checkpoints. `careful` defaults to `disk` checkpoint mechanism. Set via config or `--mode` CLI flag on `bober run`. |
| `pipeline.prPollMs` | `number` | `30000` (30s) | Sprint 14 | How often (ms) the `pr` checkpoint mechanism polls for PR merge/close events. Minimum: 10000. |

### `observability` section

| Field | Type | Default | Since | Description |
|-------|------|---------|-------|-------------|
| `observability.providers` | `ObservabilityProvider[]` | `[]` | Sprint 16 | Array of external MCP servers providing observability data to the diagnoser agent. Each entry declares a `name` (alphanumeric/underscore), `kind` (`logs`\|`metrics`\|`traces`\|`errors`\|`custom`), `mcpCommand` (executable to spawn), optional `mcpArgs`, optional `mcpEnv` (for secrets), and `enabled` (default `true`). Tools are namespaced as `obs__<name>__<tool>`. |

Example `observability.providers` entry:

```json
{
  "observability": {
    "providers": [
      {
        "name": "grafana",
        "kind": "metrics",
        "mcpCommand": "node",
        "mcpArgs": ["/usr/local/lib/mcp-grafana/index.js"],
        "mcpEnv": { "GRAFANA_API_KEY": "${GRAFANA_API_KEY}" },
        "enabled": true
      }
    ]
  }
}
```

### `incident` section

| Field | Type | Default | Since | Description |
|-------|------|---------|-------|-------------|
| `incident.autoPostmortem` | `boolean` | `true` | Sprint 23 | When `true`, an incident transition to `status='resolved'` triggers asynchronous postmortem synthesis. The transition returns immediately; synthesis runs fire-and-forget and updates `incident.json.postmortemPath` when complete. Set `false` to disable (e.g., for read-only audits). |

### `incident.playbookAutoInvokeThreshold` — not a config field

The threshold at which the diagnoser automatically follows a matched playbook (currently `0.6`) is
a constant defined in `src/incident/playbook-search.ts`, not a `bober.config.json` field. If the
match confidence exceeds `HIGH_CONFIDENCE_THRESHOLD = 0.6`, the playbook is auto-invoked. If it
exceeds `LOW_CONFIDENCE_THRESHOLD = 0.3` but not `0.6`, the diagnoser surfaces the playbook as a
suggestion. A future sprint may promote this to a configurable field.

### `telemetry` section

| Field | Type | Default | Since | Description |
|-------|------|---------|-------|-------------|
| `telemetry.enabled` | `boolean` | `false` | Sprint 28 | When `true`, the orchestrator appends opt-in local-only JSONL events to `.bober/telemetry/<YYYY-MM-DD>.jsonl` for tracking checkpoint approval rates, incident resolution times, agent retry counts, and sprint pass/fail counts. Default `false` — no files written. No network egress under any condition (enforced by an ESLint no-restricted-imports rule in `eslint.config.js` scoped to `src/telemetry/`). Event payloads contain IDs, durations, counts, and enum outcomes ONLY — no user-content strings, no MCP response bodies, no feedback text. Inspect with `bober telemetry status`, export with `bober telemetry export`, delete with `bober telemetry purge`. |

### `evaluator` section

| Field | Type | Default | Since | Description |
|-------|------|---------|-------|-------------|
| `evaluator.panel.enabled` | `boolean` | `false` | 0.16.0 | Opt-in multi-lens evaluation. When `true`, each sprint evaluation fans out across independent lenses and a reconcile step merges them; per-lens verdicts are recorded as telemetry. When `false` (default), behavior is byte-identical to the single-pass evaluator. |
| `evaluator.panel.lenses` | `string[]` | `[]` | 0.16.0 | Lens set to run. Empty `[]` uses the built-ins: `correctness`, `security`, `regression`, `quality`. Provide a subset or custom lens names to override. |
| `evaluator.panel.maxConcurrent` | `number` | `4` | 0.16.0 | Maximum lenses evaluated in parallel. Minimum 1. |

### `architect` section

| Field | Type | Default | Since | Description |
|-------|------|---------|-------|-------------|
| `architect.panel.enabled` | `boolean` | `false` | 0.16.0 | Opt-in multi-lens architecture review. When `true`, the approach-selection (CP2) and review (CP5) checkpoints fan out across lenses with a fail-closed reconcile. When `false` (default), the single-pass architect runs. |
| `architect.panel.lenses` | `string[]` | `[]` | 0.16.0 | Lens set to run. Empty `[]` uses the built-ins: `scalability`, `security`, `cost`, `operability`, `maintainability`, `reversibility`. |
| `architect.panel.maxConcurrent` | `number` | `4` | 0.16.0 | Maximum lenses evaluated in parallel. Minimum 1. |

---

## The Foundation: Behavior-Shaping Discipline

All agent prompts in agent-bober include three structures ported verbatim from
[obra/superpowers](https://github.com/obra/superpowers) (MIT licensed). These structures are not
documentation — they are executable behavior shapers that run inside every agent context window.

### Iron Laws

Iron Laws are absolute rules that cannot be overridden by context, convenience, or plausible
rationalization. Example from `agents/bober-evaluator.md`:

```
<EXTREMELY-IMPORTANT>
The Iron Law of agent-bober: if a skill applies to what you are doing, you MUST invoke it.
No exceptions. No rationalizations. Skills are behavior-shaping code, not optional reading.
</EXTREMELY-IMPORTANT>
```

Iron Laws are written in uppercase because that is not a stylistic choice — empirical testing
showed that agents comply more consistently with uppercase, hyphenated tags. Do not soften them.

### Red Flags

Red Flags are thought-pattern warnings. When an agent notices itself thinking one of the listed
thoughts, it stops and re-evaluates. Example patterns flagged as dangerous:

- "I'll just skip the eval for this small change"
- "The contract didn't explicitly forbid this improvement"
- "This is obviously correct so I don't need to verify it"
- "The test is probably passing — I didn't run it but I'm confident"

Red Flags catch the specific internal monologue that precedes slop output. They are tuned by
observing real failure modes, not invented from first principles.

### Rationalization-Prevention

Rationalization-Prevention tables list common rationalizations agents use to justify shortcuts,
paired with the correct response. Example:

| Rationalization | Correct response |
|-----------------|-----------------|
| "The tests are slow, I'll skip them for this sprint" | Run the tests. Slow tests exist for a reason. |
| "This change is trivial, no need for a contract" | No contract, no sprint. The planner exists to decompose work. |
| "I already know what the evaluator will say" | The evaluator doesn't know what you know. Independent verification is the point. |

### Anti-Pattern Catalog

The `.bober/anti-patterns/` directory catalogs patterns observed in real sessions that produced
poor outcomes. Each entry includes the pattern name, a concrete `file:line` citation from a real
session, and the correct alternative. New entries require real session evidence — fabricated
examples are rejected.

### HARD-GATEs

HARD-GATEs are pipeline-level stops that cannot be bypassed without an explicit override token and
a logged reason. Current HARD-GATEs:

- **Risky action gate**: Any action with an `inverse` operation (destructive, config-changing, or
  irreversible) requires approval regardless of `pipeline.mode`, unless `allowAutopilotRiskyActions`
  is explicitly set to `true` (see Configuration Reference).
- **Resolution verification gate**: `bober incident end` requires either `--verified` (external
  metric verification) or `--override <reason>` (operator override with audit trail). Neither can
  be omitted.
- **Contract precision gate**: Contracts missing `nonGoals`, `stopConditions`, or with
  `ambiguityScore >= 7` are blocked before the generator runs.

HARD-GATEs exist because experience shows that agents — and humans under time pressure — will
rationalize skipping gates. Making the gate explicit and requiring a token removes the rationalization
path.

### Attribution

The Iron Laws, Red Flags, Rationalization-Prevention tables, and anti-pattern catalog structure are
ported from [obra/superpowers](https://github.com/obra/superpowers) (MIT licensed). Adapted for
the agent-bober skill catalog.

---

## See Also

- [README.md](./README.md) — Installation, quick start, configuration reference
- [AGENTS.md](./AGENTS.md) — Contributor discipline, PR requirements, evidence standards
- [COMMANDS.md](./COMMANDS.md) — Full CLI command reference
- [.bober/anti-patterns/](./.bober/anti-patterns/) — Anti-pattern catalog with real session citations
- [skills/bober.using-bober/SKILL.md](./skills/bober.using-bober/SKILL.md) — Iron Law and instruction priority model
