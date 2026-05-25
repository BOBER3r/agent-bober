# Bober Playbook Library

Curated, version-controlled incident response playbooks. Each playbook is a markdown file with YAML frontmatter and numbered runbook steps following the [bober.runbook](../../skills/bober.runbook/SKILL.md) parse format (Sprint 18).

The diagnoser agent automatically searches this library at the start of every investigation via `searchPlaybooks(symptom)` from `src/incident/playbook-search.ts`. High-confidence matches are executed under the [bober.runbook](../../skills/bober.runbook/SKILL.md) discipline. Low-confidence matches surface as suggestions.

---

## Playbook Index

### build-failure

**Classification:** standard
**File:** [build-failure.md](./build-failure.md)

**Applicable symptoms:**
- ci build fails
- build red
- compilation error
- tests fail in ci
- github actions failing
- pipeline failing
- build broken

**Summary:** Identify the failing CI job, fetch logs via observability MCP or CI API, classify the failure (transient / real-code-error / dependency-error / infra-issue / test-setup-error / unknown), act based on classification (retry, surface fix, escalate), correlate with recent commits, and record outcome.

---

### migration-timeout

**Classification:** emergency
**File:** [migration-timeout.md](./migration-timeout.md)

**Applicable symptoms:**
- database migration timing out
- migration hanging
- db migration stuck
- alembic timeout
- flyway hung
- liquibase blocked
- migration not completing
- schema change stuck

**Summary:** Identify the hung migration, check for blocking locks or long-running transactions, classify whether aborting is safe (DDL-only) or unsafe (partial writes), decide kill-or-wait with operator approval (risky), verify outcome and database integrity, and execute a rollback migration if killed mid-write.

**Note:** classification='emergency' because mid-migration kills on write-heavy migrations can corrupt data. The kill-or-wait step is marked `blastRadius: risky` with an explicit rollback path.

---

### error-spike

**Classification:** emergency
**File:** [error-spike.md](./error-spike.md)

**Applicable symptoms:**
- error rate spike
- 5xx surge
- 500 errors increasing
- error budget burning
- sli below objective
- high error rate
- error rate elevated
- api errors spiking
- service error rate high

**Summary:** Gather error rate metrics across service boundaries, correlate with recent deploys (read .bober/incidents/<id>/changelog.jsonl), identify scope (single endpoint vs cross-cutting), classify cause (deploy-regression / capacity-exhaustion / dependency-failure / feature-flag-induced / unknown), execute remediation via deployer, and verify error rate recovery.

---

### latency-regression

**Classification:** standard
**File:** [latency-regression.md](./latency-regression.md)

**Applicable symptoms:**
- p95 latency increase
- p99 latency spike
- response time degradation
- slow responses
- latency regression
- high latency
- response time elevated
- api slow
- p50 latency increase
- requests taking too long

**Summary:** Identify the affected service and establish a latency baseline, check resource saturation (CPU/memory/connections), check downstream dependencies (database, cache, external APIs), correlate with recent deploys, classify cause (capacity-exhaustion / downstream-bottleneck / code-regression / cache-invalidation / traffic-spike / unknown), execute remediation, and verify p95 recovery.

---

## How to Add a New Playbook

Every playbook MUST follow the [bober.runbook parse format](../../skills/bober.runbook/SKILL.md#runbook-parse-format) exactly. The format is enforced at parse time — a malformed playbook is silently skipped during `loadPlaybooks()`.

### File naming

`<kebab-case-name>.md` — place the file in `.bober/playbooks/`. The `name` field in frontmatter MUST match the filename (without `.md`).

### Frontmatter (REQUIRED fields)

```yaml
---
name: <kebab-case-name>
classification: standard | emergency
applicableSymptoms:
  - <lowercase symptom phrase 1>
  - <lowercase symptom phrase 2>
  - <...at least 3 symptoms>
prerequisites:
  - <human-readable prerequisite 1>
  - <...>
---
```

- `classification: emergency` — use for playbooks where incomplete execution can cause data loss or extended downtime (e.g., mid-migration kills, production deployments). Marks the playbook in the CLI as high-priority.
- `applicableSymptoms` — lowercase phrases that users or monitoring systems might report. Include synonyms and partial phrases. The search engine uses token overlap, so `'ci build fails'` matches queries like `'build is failing in ci'`.

### Step sections (REQUIRED structure)

Each step is an H2 (`## Step N: <description>`) followed by four required fields:

```markdown
## Step N: <one-line description>
blastRadius: safe | risky

precondition-check:
  - <condition to verify BEFORE executing this step>

execute:
  - <the actual operation>

postcondition-check:
  - <condition to verify AFTER executing this step>

rollback:  # OPTIONAL — omit if step is trivially reversible or read-only
  - <operation to run if postcondition-check fails>
```

**Field rules:**
- `blastRadius: risky` REQUIRES a `rollback:` entry — a risky step without a rollback forces escalation on failure.
- `precondition-check` and `postcondition-check` are REQUIRED on every step. A playbook missing either field on any step is malformed.
- Minimum 5 steps per playbook.

### Full worked example

See the [bober.runbook SKILL.md worked example](../../skills/bober.runbook/SKILL.md#runbook-parse-format) for a complete two-step playbook with frontmatter.

---

## How to Test a Playbook

### Search by symptom

```bash
bober playbook search "database migration is timing out"
# → migration-timeout  (confidence: 0.80)  matched: [migration, timing, out]

bober playbook search "error rate spike on checkout"
# → error-spike  (confidence: 0.75)  matched: [error, rate, spike]
```

### Show full playbook content

```bash
bober playbook show migration-timeout
# → full markdown content of migration-timeout.md
```

### List all playbooks

```bash
bober playbook list
# → table: NAME | CLASSIFICATION | SYMPTOMS SUMMARY
```

### Confidence thresholds

| Confidence | Range | Diagnoser behavior |
|------------|-------|--------------------|
| High | ≥ 0.6 | Follow playbook via bober.runbook discipline |
| Low | 0.3 – 0.59 | Surface as 'consider playbook X' suggestion |
| No match | < 0.3 | Freeform investigation |

---

## Integration with Diagnoser and Deployer

The diagnoser (`agents/bober-diagnoser.md`) calls `searchPlaybooks(incident.symptom)` at the start of Phase 1. When a high-confidence match is found, it follows the playbook steps under [bober.runbook](../../skills/bober.runbook/SKILL.md) discipline — verifying preconditions before each step and postconditions before advancing.

The deployer (`agents/bober-deployer.md`) executes any step marked `blastRadius: risky` with the Sprint 20 checkpoint gate — even in autopilot mode.

See [skills/bober.runbook/SKILL.md](../../skills/bober.runbook/SKILL.md) for the full execution discipline (precondition → execute → postcondition loop, rollback cascade, hard gate for risky steps).
