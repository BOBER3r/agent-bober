---
name: bober-deploy
description: Use when executing a remediation action — classifies by blast radius, gates risky actions via Tier 2 checkpoint, records a ChangeEntry with inverse BEFORE execution. The execution-level discipline that runbook steps delegate to.
---

# Remediation Execution Discipline

## Overview

The deploy skill governs **how** a remediation action is executed — the precondition check, the risky-action gate, the execution itself, the ChangeEntry write, and the postcondition verification. It is the execution substrate that `bober.runbook` steps delegate to and that the `bober-deployer` agent implements.

The spirit of this discipline: **every change must be auditable, reversible, and gated by proportional human oversight**. Risky changes that cannot be reversed without human judgment must always pass through a checkpoint. This is not bureaucracy — it is the minimum viable safety net for a system that executes shell commands against production infrastructure.

## The Iron Law

```
NO RISKY ACTION WITHOUT CHECKPOINT APPROVAL; NO ACTION WITHOUT RECORDED INVERSE
```

Both clauses are unconditional. They do not have exceptions for urgency, familiarity, or pipeline mode.

## When to Use

Use this skill whenever:
- Executing a remediation action proposed by the `bober-diagnoser` agent
- Executing a runbook step with `blastRadius: 'risky'`
- Running any shell command that modifies system state (cluster, database, secrets, filesystem)
- Recording a deployment, configuration change, or rollback to the incident changelog

Do NOT use this skill for:
- Read-only investigations (use `bober.diagnose`)
- Runbook authoring (see `bober.runbook` for the step format)
- Postmortem writing (see `bober.postmortem`)

## Action Classification

### SAFE Actions

A safe action is one where: (a) it is read-only, (b) it can be reversed by simply re-running it with different parameters (idempotent redo), or (c) it flips a feature flag back to its default state.

| Category | Examples |
|----------|---------|
| Read-only cluster queries | `kubectl get`, `kubectl describe`, `kubectl logs`, `kubectl top` |
| Read-only container queries | `docker ps`, `docker logs`, `docker inspect` |
| Read-only file operations | `cat`, `head`, `tail`, `grep`, `find`, `jq` |
| Read-only HTTP probes | `curl -I`, `curl -X GET` |
| Read-only git operations | `git log`, `git diff`, `git status`, `git show` |
| System state reads | `ps`, `df`, `lsof`, `netstat`, `uptime` |
| Observability queries | All `obs__*__*` tools |
| Feature flag to default | `ff --set my.flag=false` when `false` is the declared default |

### RISKY Actions

A risky action is one that is stateful, destructive, or externally observable — i.e., a failure could affect users, require manual recovery, or leave the system in an indeterminate state.

| Category | Examples |
|----------|---------|
| Kubernetes mutations | `kubectl scale`, `kubectl rollout restart`, `kubectl delete`, `kubectl apply`, `kubectl patch`, `kubectl edit` |
| Infrastructure mutations | `terraform apply`, `terraform destroy`, `helm install/upgrade/uninstall/rollback` |
| Database migrations | `alembic upgrade`, `rake db:migrate`, `flyway migrate`, `knex migrate`, `liquibase update` |
| Secret rotation | `vault write/rotate/delete`, `aws secretsmanager rotate-secret/put-secret-value` |
| DNS changes | `aws route53 change-resource-record-sets`, `gcloud dns record-sets create` |
| Load balancer config | `aws elbv2 modify-listener`, `aws elbv2 modify-target-group-attributes` |
| Process control | `systemctl start/stop/restart`, `service ... restart`, `kill`, `pkill`, `killall` |
| Package installation | `npm install`, `pip install`, `apt install`, `brew install`, `yarn add` |
| Privilege escalation | Any command prefixed with `sudo` |
| State-mutating HTTP | `curl -X POST/PUT/PATCH/DELETE` |
| File mutations | `rm`, `rmdir`, `mv` (overwrite), `cp` (overwrite), shell redirects `>`, `>>` |
| Feature flag from default | Any flag change that moves away from the declared default state |

### Classification Rule

**WHEN IN DOUBT: classify risky.**

The cost of a false-risky classification is one extra checkpoint approval. The cost of a false-safe classification is an unreviewed mutation to production infrastructure.

The classifier (`classifyCommand()` in `src/orchestrator/deploy/classify.ts`) evaluates the **entire command string** — not just the leading verb. A multi-command Bash invocation such as `echo 'safe' && kubectl scale deployment api --replicas=6` is **risky** because `kubectl scale` appears in the command string. Wrapping a risky verb inside a safe-looking command does not change the blast radius.

## Execution Loop

Execute each proposed action in this exact sequence. Do not skip steps. Do not reorder steps.

```
FOR each ProposedAction (id, description, classification, reasoning, command, inverse):

  1. VALIDATE: assert inverse.description is non-empty. If empty → ABORT (reason: missing_inverse).
     No ChangeEntry is written for an aborted action.

  2. CLASSIFY: re-run classifyCommand(action.command). If the executor's classification is
     'risky' even though action.classification is 'safe', treat the action as risky.
     (The executor is the authoritative classifier — the agent's field is a hint.)

  3. LOG: append ActionEntry to actions.jsonl for the audit trail.

  4. PRECONDITION CHECK: if action.preconditionCheck is defined, run it.
     If precondition fails → ABORT (reason: precondition_failed). No ChangeEntry written.

  5. GATE (risky actions only):
     a. Resolve mechanism via resolveRiskyActionMechanismName(config, isRisky=true).
     b. IF allowAutopilotRiskyActions=false (default): invoke mech.request() with the
        action description, classification reasoning, command, and inverse.
     c. IF outcome.approved=false → ABORT (reason: checkpoint_rejected). Append timeline event.
        Do NOT execute. Do NOT write ChangeEntry.
     d. IF outcome.edit=true → re-classify the modified command before executing.
     e. IF allowAutopilotRiskyActions=true → skip interactive approval, log STERN WARNING to
        stderr, proceed to execution. ChangeEntry IS STILL WRITTEN (audit trail preserved).

  6. WRITE ChangeEntry status='pending' to changelog.jsonl BEFORE execution.
     (This ensures the ChangeEntry exists on disk even if the process crashes mid-execution.)

  7. EXECUTE via executor seam (defaultExecutor in production; injected seam in tests).

  8. WRITE ChangeEntry status='executed' | 'failed' to changelog.jsonl AFTER execution.
     (Both 'pending' and terminal entries are present — operational tooling sees the transition.)

  9. POSTCONDITION CHECK: if action.postconditionCheck is defined, run it.
     If postcondition fails → invoke Abort Discipline (see below).

 10. RECORD result in DeployResult (executed or aborted array).
```

## Hard Gate — Risky Actions

Any action classified as risky MUST invoke the Tier 2 checkpoint mechanism before execution. This is UNCONDITIONAL:

- **`pipeline.mode='autopilot'` does NOT bypass risky-action approval.** Autopilot trades human-in-the-loop for speed on SAFE actions; the risky-action gate is the production safety floor and does not move.
- **`pipeline.checkpointMechanism='noop'` does NOT apply to risky actions.** When the configured mechanism is `noop` but the action is risky, the executor uses the default `disk` fallback. The gate cannot be configured away.
- **Multi-command Bash invocations do NOT slip through the gate.** An action that wraps `kubectl scale` inside `echo 'safe' && kubectl scale ...` is classified by COMMAND CONTENT, not by step authorship. The classifier checks for state-mutating verbs in the entire command string.

The gate receives the action description, the classification reasoning, the proposed command, and the declared inverse. The operator can approve, reject, or modify. A modification is re-classified before execution.

<EXTREMELY-IMPORTANT>
Risky actions invoke the Tier 2 checkpoint mechanism regardless of pipeline.mode. Autopilot mode does NOT bypass risky-action approval. If `pipeline.mode='autopilot'` and `pipeline.checkpointMechanism='noop'`, the executor STILL invokes a non-noop mechanism (default 'disk' fallback) for any action classified as risky. This is the production safety guarantee — bypassing it forfeits the guarantee.
</EXTREMELY-IMPORTANT>

## allowAutopilotRiskyActions Escape Hatch

`pipeline.allowAutopilotRiskyActions=true` is available for **fully-automated environments** (CI pipelines, batch remediation jobs) where no human is available to approve a checkpoint. Default: `false`.

When `true`:
- Interactive approval is skipped.
- A STERN WARNING is logged to stderr: `[bober deploy] WARN allowAutopilotRiskyActions=true — auto-approved risky action <id>: <description>. Inverse recorded: "<inverse.description>".`
- The ChangeEntry **IS STILL WRITTEN** with the required `inverse` field. The audit trail is ALWAYS preserved.
- This is **"skip the interactive approval"** — NOT **"skip the audit trail"**.

<EXTREMELY-IMPORTANT>
`pipeline.allowAutopilotRiskyActions=true` is a footgun. Setting it to `true` in a non-automated environment (i.e., a human-supervised incident response) removes the human checkpoint that catches misclassifications, operator errors, and cascade failures. Default `false` is the SAFE default. Set `true` ONLY when no human is available AND the risk of delayed remediation exceeds the risk of unreviewed execution. Document the justification in the incident postmortem.
</EXTREMELY-IMPORTANT>

## ChangeEntry Write-then-Update

Every executed action writes TWO ChangeEntries to `changelog.jsonl`:

1. **Before execution** — `status: 'pending'`. Written BEFORE the executor seam is called.
   Purpose: if the process crashes mid-execution, the entry exists on disk. Operational tooling
   can detect 'pending' entries that never transitioned to 'executed' or 'failed' and flag them
   for manual review.

2. **After execution** — `status: 'executed'` or `status: 'failed'`. Written AFTER the executor
   returns (or throws). Both entries share the same `id` field; readers correlate by `id`.

The `inverse` field is REQUIRED on BOTH entries. Sprint 21 rollback awareness reads `inverse` from
changelog entries to reconstruct the rollback plan. An entry without `inverse` is a schema violation
(Zod will throw at write time).

```jsonl
{"id":"act-1","type":"risky-action","executedAt":"2026-05-25T12:00:00Z","description":"scale api to 6","inverse":{"description":"scale back to 3","command":"kubectl scale deployment api --replicas=3"},"status":"pending"}
{"id":"act-1","type":"risky-action","executedAt":"2026-05-25T12:00:02Z","description":"scale api to 6","inverse":{"description":"scale back to 3","command":"kubectl scale deployment api --replicas=3"},"status":"executed"}
```

## Abort Discipline

When a postcondition check fails after execution, follow this three-step cascade:

**Step 1 — Execute the declared inverse.**
The inverse is the rollback command declared in `action.inverse.command`. Run it via the executor seam. The inverse itself is classified by `classifyCommand()` — if it is risky, it requires checkpoint approval too.

**Step 2 — Verify the inverse's effect.**
After executing the inverse, run the original precondition (or the action's postcondition with inverted expected state) to confirm the rollback held. If the inverse also fails, proceed to Step 3.

**Step 3 — Escalate via checkpoint and STOP.**
Even if Step 1 failed, escalate via the Tier 2 checkpoint mechanism with the full context: the failed action, the postcondition result, the inverse attempt result, and the current observable state. STOP — do not proceed to subsequent actions. Their preconditions may assume this action's postcondition held, which it did not.

<EXTREMELY-IMPORTANT>
If a postcondition fails AND the declared inverse also fails (or no inverse was declared), the incident state is now indeterminate. The executor MUST escalate via checkpoint — do not silently proceed, do not retry the failed action. Only a human (or the configured escalation handler) can decide the next move from an indeterminate state.
</EXTREMELY-IMPORTANT>

## Worked Example — Scaling API Deployment

**Context:** Diagnoser hypothesizes replica exhaustion. Next action: `kubectl scale deployment api --replicas=6`.

**ProposedAction:**
```json
{
  "id": "act-scale-1",
  "description": "Scale api deployment to 6 replicas to relieve replica pressure",
  "classification": "risky",
  "reasoning": "kubectl scale is stateful and externally observable — changes live traffic routing",
  "command": "kubectl scale deployment api --replicas=6 -n prod",
  "inverse": {
    "description": "Scale api deployment back to 3 replicas",
    "command": "kubectl scale deployment api --replicas=3 -n prod"
  },
  "preconditionCheck": "kubectl get deployment api -n prod -o jsonpath='{.status.readyReplicas}'",
  "postconditionCheck": "kubectl get deployment api -n prod -o jsonpath='{.status.readyReplicas}' | grep -q '^6$'"
}
```

**Execution trace:**
1. `inverse.description` is non-empty — validation passes.
2. `classifyCommand("kubectl scale deployment api --replicas=6 -n prod")` → `'risky'` (kubectl scale verb).
3. ActionEntry written to `actions.jsonl`.
4. Precondition check: `kubectl get deployment api ...` → returns `3` (replicas currently 3) — passes.
5. Gate: mechanism resolves to `disk` (floor applies; checkpointMechanism=noop but action is risky). Operator approves via `.bober/approvals/` file.
6. ChangeEntry `{id: "act-scale-1", status: "pending", inverse: {...}}` written to `changelog.jsonl`.
7. Executor: `kubectl scale deployment api --replicas=6 -n prod` → exit code 0.
8. ChangeEntry `{id: "act-scale-1", status: "executed", inverse: {...}}` written to `changelog.jsonl`.
9. Postcondition check: `kubectl get deployment api ... | grep -q '^6$'` → passes.
10. DeployResult: `executed: [{actionId: "act-scale-1", status: "executed", durationMs: 1240}]`.

## Red Flags — STOP

- About to execute without an `inverse.description` on the ProposedAction — stop, you have no exit strategy.
- About to classify `echo 'safe' && kubectl scale ...` as safe — the classifier reads the entire string. `kubectl scale` makes it risky.
- About to skip the checkpoint because the pipeline is in autopilot mode — Iron Law: risky actions always gate.
- About to skip the ChangeEntry write because "the action is small" — the audit trail is the safety net for the next operator. Every change is recorded.
- About to skip the precondition check because "the incident confirms the bad state" — the precondition is also a guard against executing the wrong remediation on the wrong environment.
- About to continue to the next action after a postcondition failure — this is the most common failure mode. Stop. Execute the inverse. Escalate. Let the operator decide.
- About to set `allowAutopilotRiskyActions=true` in a human-supervised context — this flag is for unattended automation. In a live incident with a human in the loop, leave it `false`.
- About to skip the stern warning when `allowAutopilotRiskyActions=true` auto-approves — the warning is the audit signal that human approval was bypassed.

## Common Rationalizations

| Rationalization | Reality |
|-----------------|---------|
| "The pipeline is in autopilot, so risky actions auto-approve" | Iron Law: risky actions always gate, regardless of pipeline.mode. Autopilot only skips approval for SAFE actions. |
| "kubectl scale is a minor operation — it's basically safe" | kubectl scale is stateful and externally observable. It is in the RISKY list explicitly. Classify it risky. |
| "I'll add the inverse after I see what the execution does" | The inverse must be declared BEFORE execution. Discovering it post-hoc means you cannot roll back if the execution crashes. |
| "allowAutopilotRiskyActions=true means skip all safety" | It means skip interactive approval. ChangeEntry IS still written. Audit trail IS still preserved. Warning IS still logged. |
| "The diagnoser recommended this — it's pre-approved" | Recommendation is not approval. Every risky action needs a checkpoint approval regardless of its source. |
| "The precondition passed last time — I won't check again" | System state changes. The precondition check is run immediately before execution, every time. |
| "Different words so the rule doesn't apply" | Spirit over letter. When in doubt, classify risky, require approval, record inverse. |
| "I can bundle two mutations into one command to save time" | Bundled mutations have bundled inverses. A failure mid-bundle leaves the system in a half-mutated state. Split them. |

## Quick Reference

| Question | Answer |
|----------|--------|
| Is `kubectl get pods` safe? | Yes — read-only. |
| Is `kubectl scale` safe? | No — risky, requires checkpoint. |
| Is `echo 'ok' && kubectl delete pod x` safe? | No — `kubectl delete` is risky; entire string is risky. |
| Can autopilot mode bypass risky-action checkpoint? | No — Iron Law applies unconditionally. |
| What does `allowAutopilotRiskyActions=true` skip? | Interactive approval only. ChangeEntry is still written. Warning is still logged. |
| What happens if inverse is missing? | executeAction throws BEFORE execution. No ChangeEntry is written. |
| What happens if postcondition fails? | Execute inverse → escalate via checkpoint → STOP. |
| What happens if the executor crashes mid-execution? | ChangeEntry with status='pending' exists on disk. Final status may be absent or 'failed'. Operational tooling detects the 'pending' state. |

## Related Skills

- **`bober.runbook`** (`skills/bober.runbook/SKILL.md`) — multi-step runbook execution. Runbook steps delegate to this skill's execution discipline for each step.
- **`bober.diagnose`** (`skills/bober.diagnose/SKILL.md`) — the investigation skill that produces `nextActions`. This skill executes what the diagnoser recommends.
- **`bober-deployer` agent** (`agents/bober-deployer.md`) — the agent that uses this skill. The agent prompt implements the discipline described here.
