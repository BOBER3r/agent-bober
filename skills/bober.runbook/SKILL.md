---
name: bober-runbook
description: Use when executing a runbook or step-by-step recovery procedure — verify precondition before each step, execute, verify postcondition before advancing; hard gate around destructive operations
---

> Adapted from [obra/superpowers](https://github.com/obra/superpowers) — MIT License.
> Structural source: verification-before-completion discipline (precondition → execute → postcondition loop).
> Adaptations: applied to runbook step execution; explicit hard gate around steps with blastRadius='risky'; rollback cascade for postcondition failures.

# Runbook Execution Discipline

## Overview

A runbook is a contract between the author and the executor: each step asserts what must be true before it runs and what must be true after. Blindly running steps without verification turns a recovery procedure into a second incident. A step that succeeds silently while leaving the system in an unexpected state is MORE dangerous than a step that fails loudly.

**Core principle:** ALWAYS verify the precondition before executing each step, and the postcondition before advancing.

**Violating the letter of this process is violating the spirit of incident recovery.**

## The Iron Law

```
NO STEP EXECUTION WITHOUT VERIFIED PRECONDITION; NO ADVANCE WITHOUT VERIFIED POSTCONDITION
```

A runbook is a contract: each step asserts what must be true BEFORE it runs and what must be true AFTER. Executing without verifying preconditions makes the incident worse. Advancing without verifying postconditions hides failures that the next step assumes have been handled.

## When to Use

Use for ANY step-by-step operational procedure:
- Recovering from a production incident via a named runbook
- Following a disaster-recovery procedure
- Executing a curated playbook from `.bober/playbooks/`
- Rolling back a deployment via prescribed steps
- Running a database migration procedure
- Applying a pre-approved scaling policy

**Use this ESPECIALLY when:**
- An incident is active and seconds count (pressure makes step-skipping tempting)
- The runbook author is not in the room to answer questions
- The procedure involves destructive or stateful operations
- You are executing a runbook you have never run before in production

**Don't skip when:**
- "Everyone knows this runbook" — tribal knowledge is not a verified precondition
- "We ran it last week and it was fine" — system state changes; the precondition may no longer hold
- "The operator says skip the precondition" — the Iron Law is not advisory; get an explicit checkpoint approval if you must proceed without a check

## Runbook Parse Format

A runbook is a markdown file with YAML frontmatter and numbered step sections.

**Frontmatter:**

```yaml
---
name: <kebab-case runbook name>
classification: standard | emergency
prerequisites:
  - <human-readable prerequisite>
  - <another prerequisite>
---
```

**Each step section:**

- `## Step <N>: <description>` — H2 with step number and one-line description
- `blastRadius: safe | risky` — REQUIRED. `safe` = read-only or trivially reversible (e.g., a kubectl get, a feature flag flip back to default). `risky` = stateful, destructive, externally-observable (e.g., kubectl scale, kubectl rollout, terraform apply, db migration).
- `precondition-check:` — REQUIRED. A bulleted list of conditions to verify BEFORE the step runs. Each bullet is either a concrete command (e.g., `kubectl get deployment api -o json | jq .spec.replicas — value is 3`) or a human-readable check (e.g., `acknowledgement received in channel`).
- `execute:` — REQUIRED. A bulleted list of the actual operation. For safe steps, may be a single command. For risky steps, ALWAYS a single command (multi-command risky steps must be split into separate numbered steps so each gets its own checkpoint).
- `postcondition-check:` — REQUIRED. A bulleted list of conditions to verify AFTER the step runs. Same format as precondition.
- `rollback:` — OPTIONAL. A bulleted list of operations to run if postcondition-check fails. If omitted, postcondition failure triggers immediate escalation (see Rollback Cascade).

**Worked frontmatter + two-step example:**

~~~markdown
---
name: high-error-rate-recovery
classification: emergency
prerequisites:
  - logged in as production-on-call
  - error rate observable in obs__datadog
---

## Step 1: Confirm error rate exceeded threshold
blastRadius: safe

precondition-check:
  - Read obs__datadog metric `api.error_rate`; current value > 1% for >= 5 minutes

execute:
  - (description only) Open the runbook approver in the team channel

postcondition-check:
  - Acknowledgement received in channel from at least one approver

## Step 2: Scale up replicas
blastRadius: risky  # destructive — requires checkpoint approval

precondition-check:
  - kubectl get deployment api-service -o json | jq .spec.replicas — value is 3

execute:
  - kubectl scale deployment api-service --replicas=6

postcondition-check:
  - kubectl get pods -l app=api-service -o json | jq '.items | map(select(.status.phase=="Running")) | length' — value is 6

rollback:
  - kubectl scale deployment api-service --replicas=3
~~~

<EXTREMELY-IMPORTANT>
BEFORE executing the first step, you MUST parse the runbook end-to-end and verify every step has a precondition-check and a postcondition-check declared. A runbook with an undeclared precondition-check on ANY step is malformed — abort and escalate via checkpoint. Do NOT silently default to "no check" — the absence of a check is a parse-time failure, not a runtime convenience.
</EXTREMELY-IMPORTANT>

## Execution Discipline

For each step in the runbook, run the four-stage loop. Do not skip stages. Do not reorder.

```
FOR each step IN runbook:
  RUN precondition-check
  IF precondition fails: STOP, report 'precondition_failed', do not advance
  IF step.blastRadius == 'risky':
    INVOKE checkpoint(pre-execute) — even in autopilot mode
    IF checkpoint rejected: STOP, abort runbook
  EXECUTE step (command, or await human action via checkpoint if description-only)
  RUN postcondition-check
  IF postcondition fails:
    IF step.rollback defined: EXECUTE rollback
      IF rollback postcondition still fails: ESCALATE via checkpoint, STOP
    IF rollback NOT defined: ESCALATE via checkpoint, STOP
  ADVANCE to next step
MARK runbook complete; write summary entry to .bober/incidents/<id>/runbook-execution.jsonl
```

**STOP conditions enumerated:**

- **Precondition fails** → STOP. Write `{status: 'precondition_failed'}` to runbook-execution.jsonl. Do NOT execute.
- **Risky-step checkpoint rejected** → STOP. Write `{status: 'checkpoint_rejected'}`. Do NOT execute.
- **Step execution errors** → STOP. Write `{status: 'execution_failed'}`. Trigger rollback if defined; otherwise escalate.
- **Postcondition fails AND rollback fails (or no rollback)** → STOP. Write `{status: 'rollback_failed'}` (or `{status: 'postcondition_failed_no_rollback'}`). Escalate via checkpoint.

ADVANCE happens ONLY when the postcondition-check explicitly passes. Default behavior on uncertainty is STOP, not ADVANCE.

## Hard Gate — Risky Steps

Any step with `blastRadius: 'risky'` MUST invoke the Tier 2 checkpoint mechanism before execution. This is UNCONDITIONAL:

- **`pipeline.mode='autopilot'` does NOT bypass risky-step approval.** Autopilot trades human-in-the-loop for speed on SAFE steps; the risky-step gate is the production safety floor and does not move.
- **`pipeline.checkpointMechanism='noop'` does NOT apply to risky steps.** When the configured mechanism is `noop` but the step is risky, the runbook executor uses the default `disk` fallback (Sprint 13's checkpoint mechanism). The gate cannot be configured away.
- **Multi-command bash invocations do NOT slip through the gate.** A step that wraps `kubectl scale` inside `echo 'safe' && kubectl scale ...` is classified by COMMAND content, not by step authorship. The classifier checks for state-mutating verbs in the entire command string.

The gate receives the step's classification reasoning, the proposed command, and the declared rollback. The operator can approve, reject, or modify (the modification is recorded in `changelog.jsonl` via Sprint 19's `appendChange` with the required `inverse` field).

<EXTREMELY-IMPORTANT>
Risky steps invoke the Tier 2 checkpoint mechanism regardless of pipeline.mode. Autopilot mode does NOT bypass risky-step approval. If `pipeline.mode='autopilot'` and `pipeline.checkpointMechanism='noop'`, the runbook executor STILL invokes a non-noop mechanism (default 'disk' fallback) for any step with `blastRadius: 'risky'`. This is the production safety guarantee — bypassing it forfeits the guarantee.
</EXTREMELY-IMPORTANT>

The escape hatch — `pipeline.allowAutopilotRiskyActions=true` — is documented in `skills/bober.deploy/SKILL.md` (Sprint 20) and exists for fully-automated environments (CI, batch jobs) where no human is available. Default `false`. When set to `true`, risky steps are auto-approved BUT a stern warning is logged and the `ChangeEntry` is still recorded with the required `inverse`. This is "skip the interactive approval" — NOT "skip the audit trail."

## Rollback Cascade

When a step's postcondition-check fails, the runbook executor follows a three-tier cascade. Each tier MUST be exhausted before falling to the next.

**Tier 1 — Run the declared rollback (if any).**
The rollback is itself a mini-step: it has an `execute` command and an implicit postcondition (the inverse of the failed step's postcondition). Run the rollback command. Then check whether the rollback's effect held — for example, if the original step scaled to 6 replicas and failed, the rollback `kubectl scale --replicas=3` is verified by `kubectl get deployment ... | jq .spec.replicas == 3`.

**Tier 2 — If rollback fails OR no rollback was declared, escalate via checkpoint.**
The checkpoint payload includes: the failed step number, the postcondition-check result, the rollback-attempt result (if attempted), and the current observable state. The operator (or the configured escalation handler) decides the next move — manual intervention, abort, or override.

**Tier 3 — Write the indeterminate state to the observation log and STOP the runbook.**
Regardless of which tier resolved (or did not resolve) the failure, append a complete record to `.bober/incidents/<id>/runbook-execution.jsonl` with `rollbackTriggered: true` (Tier 1 ran) and `status: 'rollback_failed' | 'escalated' | 'recovered_via_rollback'` as appropriate. Do NOT continue with subsequent steps — their preconditions assume the failed step's postcondition held, which it did not.

<EXTREMELY-IMPORTANT>
If a step's postcondition fails AND its declared rollback ALSO fails (or no rollback was declared), the runbook executor MUST escalate via the Tier 2 checkpoint mechanism — do not silently proceed, do not retry the failed step. The incident state is now indeterminate; only a human (or the configured escalation handler) can decide the next move.
</EXTREMELY-IMPORTANT>

## Observation Log

Every step execution writes one line to `.bober/incidents/<id>/runbook-execution.jsonl`. Sprint 19's `appendRunbookExecution` helper provides the write primitive; this skill documents the schema.

**Line shape:**

```json
{
  "timestamp": "<ISO-8601, when the step completed (or failed)>",
  "runbookName": "<frontmatter name from the runbook file>",
  "stepNumber": "<integer, 1-indexed from the H2 ## Step N: ...>",
  "status": "'precondition_failed' | 'checkpoint_rejected' | 'execution_failed' | 'postcondition_failed_no_rollback' | 'rollback_failed' | 'recovered_via_rollback' | 'success'",
  "preconditionResult": "'pass' | 'fail' | 'not_run'",
  "postconditionResult": "'pass' | 'fail' | 'not_run'",
  "rollbackTriggered": "<boolean — true if Tier 1 of the cascade ran, false or omitted otherwise>"
}
```

**Worked log entries (one runbook execution, three steps):**

```jsonl
{"timestamp": "2026-05-24T14:10:00Z", "runbookName": "high-error-rate-recovery", "stepNumber": 1, "status": "success", "preconditionResult": "pass", "postconditionResult": "pass"}
{"timestamp": "2026-05-24T14:12:00Z", "runbookName": "high-error-rate-recovery", "stepNumber": 2, "status": "success", "preconditionResult": "pass", "postconditionResult": "pass"}
{"timestamp": "2026-05-24T14:15:00Z", "runbookName": "high-error-rate-recovery", "stepNumber": 3, "status": "recovered_via_rollback", "preconditionResult": "pass", "postconditionResult": "fail", "rollbackTriggered": true}
```

The timeline.jsonl (Sprint 19) ALSO gains a corresponding line per step via Sprint 19's pattern that "every other append helper ALSO writes a corresponding timeline event." Operators get a chronological view via `cat timeline.jsonl`, and a runbook-specific view via `cat runbook-execution.jsonl`.

**Field-name lock:** The exact 7 field names above (`timestamp, runbookName, stepNumber, status, preconditionResult, postconditionResult, rollbackTriggered`) are the schema Sprint 19's writer will use. Do NOT introduce field-name variants — `step_number` vs `stepNumber`, `runbook_name` vs `runbookName` — schema drift between sprints breaks the timeline.

## Worked Example — Recovering from API Error Spike

A worked end-to-end execution of `high-error-rate-recovery` (the runbook in §Runbook Parse Format).

**Setup:** Datadog alert fires at 14:00 UTC. `api.error_rate` at 4.2%. Diagnoser (via `bober.diagnose` Phase 1-3) hypothesizes "replicas exhausted under load, scaling up will relieve pressure." `nextActions[0]` is `{action: "follow runbook high-error-rate-recovery", blastRadius: "risky", requiresApproval: true}`. Orchestrator invokes this skill.

**Step 1 — Confirm error rate exceeded threshold (`blastRadius: safe`):**

Precondition-check:

```bash
$ curl -s "https://datadog/api/v1/query?query=avg:api.error_rate{*}&from=now-5m" | jq .series[0].pointlist[-1][1]
0.042   # 4.2% > 1% threshold — PASS
```

Execute (description-only): "Open the runbook approver in the team channel" — agent awaits human action via checkpoint.

Postcondition-check:

```bash
$ grep -c "approved" /tmp/channel-acks.log
1   # at least one approver — PASS
```

Status: `success`. ADVANCE to Step 2.

**Step 2 — Scale up replicas (`blastRadius: risky`):**

Precondition-check:

```bash
$ kubectl get deployment api-service -o json | jq .spec.replicas
3   # matches expected — PASS
```

**Risky step — HARD GATE invoked.** Even though `pipeline.mode='autopilot'`, the checkpoint mechanism (default 'disk' fallback because configured 'noop' is overridden for risky steps) presents the action to the operator. Payload includes:
- Action: `kubectl scale deployment api-service --replicas=6`
- Classification reasoning: scale operation is stateful + externally-observable
- Proposed rollback: `kubectl scale deployment api-service --replicas=3`

Operator approves. Step executes.

Execute:

```bash
$ kubectl scale deployment api-service --replicas=6
deployment.apps/api-service scaled
```

Postcondition-check:

```bash
$ kubectl get pods -l app=api-service -o json | jq '.items | map(select(.status.phase=="Running")) | length'
6   # 6 pods Ready — PASS
```

Status: `success`. ADVANCE.

**Log entries written:**

```jsonl
{"timestamp": "2026-05-24T14:11:00Z", "runbookName": "high-error-rate-recovery", "stepNumber": 1, "status": "success", "preconditionResult": "pass", "postconditionResult": "pass"}
{"timestamp": "2026-05-24T14:14:00Z", "runbookName": "high-error-rate-recovery", "stepNumber": 2, "status": "success", "preconditionResult": "pass", "postconditionResult": "pass"}
```

**Counter-example — rollback cascade in action.** Suppose Step 2's postcondition had returned `4` (only 4 pods Running). The runbook executor would:

1. Run rollback `kubectl scale deployment api-service --replicas=3`.
2. Verify rollback's effect: `kubectl get deployment api-service -o json | jq .spec.replicas == 3` → PASS.
3. Write `{status: "recovered_via_rollback", rollbackTriggered: true, ...}` and STOP.

If the rollback ITSELF had failed (e.g., kubectl API errored), the executor escalates via checkpoint with `{status: "rollback_failed", rollbackTriggered: true, ...}` and STOPs. The operator decides next move; the runbook does NOT continue.

## Red Flags - STOP and Follow Process

If you catch yourself thinking:
- "The precondition check is obvious, just run the step"
- "The postcondition is just a sanity check, advance anyway"
- "It's a small scale-up, skip the checkpoint"
- "The rollback should be safe to skip, the change was tiny"
- "Autopilot mode said skip approval"
- "The step failed but the next one might fix it, try advancing"
- "No rollback declared, that means it's safe to skip the cascade"
- "The runbook is in the playbook library so it must be safe"
- "Precondition timed out, retry without checking"
- Advancing to the next step without an explicit postcondition PASS result
- **"No time to check preconditions, the incident is live"**

**ALL of these mean: STOP. Return to the verification loop — parse, check, execute, verify.**

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "The precondition is just paperwork, the team always runs this step without checking" | Tribal-knowledge preconditions are precisely what the runbook formalizes. Run the check — if it's always true, it costs nothing; if it's not always true, you just averted an incident. |
| "The postcondition can be verified later, we're behind schedule" | Postcondition deferred is postcondition skipped. The next step's precondition assumes this step's postcondition held. Defer the verification, defer the failure into a worse moment. |
| "Autopilot mode is explicitly opt-in for trusted runbooks" | Autopilot mode trades human-in-the-loop for speed on SAFE steps. Risky-step approval is the safety floor — autopilot does NOT bypass it. Read the Iron Law again. |
| "Rollback failed but the system looks fine, mark step complete" | If the rollback failed, you do not know the system state. "Looks fine" is not state knowledge. Escalate via checkpoint — the operator decides whether to mark complete or treat as undetermined. |
| "No rollback declared because the step is reversible by retrying" | Retry-as-rollback is acceptable ONLY when declared as the rollback. An undeclared "we'll just retry" is implicit state, not a recoverable plan. Declare the rollback at runbook-write time. |
| "The runbook came from the playbook library, trust the author" | Trust the discipline, not the author. The parse format and the four-stage loop apply to every runbook regardless of author. The library passed review for SHAPE, not for situation fit. |
| "The step is idempotent so skipping the precondition is harmless" | Idempotency is a property of the happy path. An idempotent step run against an unexpected precondition state is NOT guaranteed idempotent — the precondition defines the state the idempotency guarantee assumes. |
| "It worked in staging, precondition must be fine" | Staging is a hypothesis about production state, not a verification. The precondition-check runs in production, against production state, immediately before the step executes. Staging results are not portable. |

## Quick Reference

| Stage | Key Activities | Success Criteria |
|-------|---------------|------------------|
| **1. Parse** | Read frontmatter (name, classification, prerequisites); enumerate steps; verify each step has precondition-check + postcondition-check + blastRadius | Runbook is structurally valid; no undeclared checks |
| **2. Precondition** | Run precondition-check command (or read the condition); compare to expected state | Result matches expected; otherwise STOP |
| **3. Execute** | If step is risky → invoke Tier 2 checkpoint (regardless of pipeline.mode); on approval, run the step's command (or await human action) | Step ran without error |
| **4. Postcondition** | Run postcondition-check; if pass → advance; if fail → run rollback; if rollback also fails → escalate via checkpoint | Either step's postcondition holds OR rollback's postcondition holds OR escalation triggered |

## Related Skills

- **`bober.diagnose`** (`skills/bober.diagnose/SKILL.md`, Sprint 17) — Upstream skill. The diagnoser identifies "follow runbook X" as a next-action; that next-action is then executed under this skill's discipline. Diagnose says WHAT to do; runbook says HOW to do each step safely.
- **`bober.deploy`** (`skills/bober.deploy/SKILL.md`, Sprint 20) — Downstream execution wiring. `bober.deploy` is the agent-level execution discipline (action classification, checkpoint gate enforcement, ChangeEntry recording with required inverse). `bober.runbook` is the operator-level discipline for executing a step-by-step procedure; `bober.deploy` is what actually runs the risky step. Risky steps in this skill DELEGATE to `agents/bober-deployer.md` for execution.
- **`.bober/playbooks/`** (Sprint 25) — Library of curated runbooks (`build-failure.md`, `migration-timeout.md`, `error-spike.md`, `latency-regression.md`). Each playbook MUST conform to the parse format documented in this skill. The diagnoser invokes `searchPlaybooks(symptom)` to find a matching playbook; matched playbooks are executed under this skill's discipline.
- **`.bober/anti-patterns/`** — Pattern catalog. Two anti-patterns are especially common in runbook execution: **Single-Layer Validation** (`defense-in-depth.md` — postcondition skipped because step "looked successful") and **Symptom-Fix Instead of Root-Cause** (`root-cause-tracing.md` — running a recovery runbook to mask an underlying defect).

## Real-World Impact

From incident response patterns:
- Runbook execution with pre/post verification: regressions caught at the step boundary, not as downstream failures
- Runbook execution without postcondition checks: failures propagate silently, next-step preconditions assume state that no longer exists
- Risky steps with hard-gate enforcement: blast radius contained to the declared scope of the step
- Risky steps executed without approval in autopilot mode: unreviewed changes to production infrastructure with no audit trail
