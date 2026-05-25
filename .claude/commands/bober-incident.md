---
name: bober-incident
description: Use when responding to a production incident or system-level failure — kicks off the incident pipeline (diagnose → propose actions → deploy with gates → verify resolution → postmortem). The top-level entry that routes between bober-diagnoser, bober-deployer, and bober-postmortemer based on incident phase.
---

# Top-Level Incident Response

## Overview

This skill governs the **full incident lifecycle** — from the first symptom report through root-cause diagnosis, remediation execution, resolution verification, and postmortem synthesis. It is the entry point that routes between all Tier 3 sub-disciplines.

The lifecycle is **phased and deterministic**. Each phase transition is driven by the output of a sub-skill (diagnoser, deployer, verifier) and gated by the incident state machine. No phase can be skipped. No resolution can bypass verification. This is the architecture that prevents "I fixed it" from meaning "I changed something and it seems better now."

Key architectural invariants:
- Every incident has a timeline (`timeline.jsonl`) from creation to resolution.
- Every destructive action passes through a checkpoint gate before execution.
- Every resolution requires a verifiable artifact (metric evidence or an override token with an audit trail).
- Every resolved incident triggers a postmortem automatically.

This skill does **not** replace `bober.diagnose`, `bober.deploy`, `bober.runbook`, or `bober.postmortem`. It orchestrates them.

## The Iron Law

```
NO INCIDENT WITHOUT TIMELINE; NO RESOLUTION WITHOUT VERIFICATION
```

Both clauses are unconditional. They do not have exceptions for urgency, familiarity, or pipeline mode.

## When to Use

Use this skill when:
- A page fires (PagerDuty, OpsGenie, or any on-call alert)
- An SLO breach is detected (error rate, latency, availability below threshold)
- A user-reported outage is confirmed by at least one objective signal
- A deployment causes observable regression (rollout watchdog fires)
- Any system-level failure requires coordinated diagnosis + remediation

Do NOT use this skill for:
- Planned maintenance (no incident, no postmortem required)
- Feature work that happens to touch infrastructure
- Read-only investigation with no remediation intent (use `bober.diagnose` directly)

## Workflow

Execute each phase in order. Do not skip phases. Phase transitions are guarded by the incident state machine.

### Phase 1: Start the Incident

```bash
bober incident start "<symptom>" [--severity S1|S2|S3|S4]
# Returns: incidentId
```

This creates the incident artifact directory (`.bober/incidents/<id>/`) with all required files. The incident is immediately in status `investigating`. The incidentId anchors all subsequent artifacts.

Severity semantics (informational — does NOT affect routing):
- **S1** — Total outage; all users affected; no workaround.
- **S2** — Major degradation; significant user impact; partial workaround available.
- **S3** — Partial degradation; moderate impact; workaround available.
- **S4** — Minor issue; limited impact; no immediate user harm.

### Phase 2: Diagnose

Invoke the `bober-diagnoser` agent with the incidentId and symptom. The diagnoser:
1. Queries observability tools (`obs__*__*`).
2. Writes a `diagnoses/<diagnosisId>.json` with hypotheses + nextActions.
3. Each nextAction declares `blastRadius: safe | risky`.

The incident state machine reads `nextActions`:
- One or more `risky` actions → transition to `remediating`.
- No risky actions (or no actions at all) → stay at `investigating`. Operator ends the incident with `bober incident end`.

### Phase 3: Remediate (if nextActions include risky steps)

Invoke the `bober-deployer` agent for each risky nextAction.

Each action passes through the Sprint 20 gate:
- Gate mechanism is resolved from `bober.config.json` → `pipeline.checkpointMechanism`.
- In `careful` mode: operator must explicitly approve each risky action before execution.
- In `autopilot` mode: gate fires and auto-approves but STILL writes an audit trail.

No action is executed without a `ChangeEntry` (with `inverse.description`) written first.

After execution, verify resolution:
```bash
bober incident end --verified   # if external verification confirms
bober incident end --override "Investigation concluded; no metric available"  # operator override
```

### Phase 4: Verify Resolution

Resolution requires one of:
1. `opts.verifyResult.verified === true` — metric confirmation from `verifyResolution()`.
2. `opts.overrideToken = 'SKIP_METRIC_VERIFY: <reason>'` — operator asserts resolution with documented reason.

Neither path can be skipped. The gate is enforced in `setIncidentStatus` (Sprint 22).

### Phase 5: Postmortem

On transition to `resolved`, Sprint 23's auto-trigger fires:
- `generatePostmortem(projectRoot, incidentId)` synthesizes `postmortem.md` from all artifacts.
- The postmortemPath is written to `incident.json`.

The postmortem is automatic. Operators can view or regenerate:
```bash
bober postmortem show <incidentId>
bober postmortem generate <incidentId>  # re-synthesize
```

## Slash Command Flow (/bober-incident)

When a user invokes `/bober-incident` from Claude Code:

1. **If no symptom provided in the invocation:**
   - Prompt: "What is the symptom or alert? (e.g., '500 errors on checkout endpoint', 'p99 latency >3s on API gateway')"
   - Wait for a clear, specific symptom description before proceeding.
   - Do NOT proceed with a vague symptom like "something is wrong".

2. **If symptom is provided:**
   - Run: `bober incident start "<symptom>" [--severity <S1|S2|S3|S4>]`
   - Surface the incidentId to the user immediately.
   - Transition to diagnosis phase.

3. **At each phase transition:**
   - Announce the transition clearly: "Phase transition: investigating → remediating"
   - Display the incidentId so the operator can track state.
   - Surface any gate approvals required before proceeding.

4. **Output format:**
   - Use markdown headers for phases.
   - Use code blocks for commands.
   - Use bold for incidentId and phase names.
   - Show `bober incident status <id>` output at each transition.

Example invocation flow:
```
/bober-incident 500 errors spiking on checkout endpoint

→ Incident created: inc-20260524-500-errors-on
→ Phase: investigating
→ Severity: S2 (user-visible checkout failure)

[Diagnoser output: connection pool exhausted after migration 042]

→ Phase transition: investigating → remediating
→ Risky actions proposed: 2

  1. Scale deployment api 3→6 replicas (risky)
  2. Disable flag new_checkout_flow (risky)

[Gate approval required for each step]
```

## Phase Transition Diagram

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

State machine constraints enforced by `transitionPhase()` in `src/incident/orchestrator.ts`:
- `aborted` is **terminal**: no transitions out.
- `resolved → remediating` is **forbidden** (must re-open to `investigating` first).
- `resolved → investigating` requires an explicit `reason` (re-open path).
- All other transitions follow the table exactly; invalid transitions throw `InvalidTransitionError`.

## Red Flags - STOP and Follow Process

Encountering any of these signals means the incident is being handled incorrectly. STOP the current action and follow the documented path.

- **About to mark resolved without a verifyResult or overrideToken.** Resolution without evidence is conjecture. Use `--verified` or `--override <reason>` — never skip the gate.
- **About to execute a rollback without `--confirm-rollback`.** Silent rollback is a footgun. Rollback changes system state; it must be explicit. If you want rollback, use `bober incident abort <id> --reason <text> --confirm-rollback`.
- **About to run a risky action directly in the shell, bypassing `executeAction`.** Any command that modifies system state MUST go through the deploy gate so an inverse is recorded. No exceptions for "trivial" changes.
- **About to batch-approve multiple risky actions in a single gate invocation.** Each risky action requires its own checkpoint approval. Per-step gates exist to prevent "approve all" disasters.
- **About to close an incident without a timeline event.** Every phase transition and every action MUST be recorded in `timeline.jsonl`. Closing an incident with an empty timeline means the postmortem will have no evidence to synthesize.
- **About to re-open a resolved incident without a reason.** The re-open path (`resolved → investigating`) requires an explicit reason. A reason-less re-open erases the audit trail of why the incident was re-opened.
- **About to skip the diagnoser and go straight to remediation.** "I know what's wrong" is the most dangerous statement in incident response. Run the diagnoser first to document hypotheses.

## Common Rationalizations

| Rationalization | Why It's Wrong |
|----------------|---------------|
| "I know what's wrong — skipping diagnosis to save time." | Without documented hypotheses, the postmortem will have no root cause. Skipping diagnosis means you cannot verify the fix addressed the actual cause. |
| "The metric is unavailable but I know it's resolved." | Use `--override <reason>` with a documented reason. This creates an audit trail. Do NOT skip the gate entirely — the `resolved` gate exists to prevent wishful resolution. |
| "It's a tiny change — the gate is overkill." | The gate's cost is one approval. The cost of an ungated risky change to production is a potential second incident. Classify risky when in doubt. |
| "The rollback will fix the abort side-effects automatically." | Rollback must be explicitly confirmed with `--confirm-rollback`. Silent rollback could make the situation worse. Document the abort reason first; then decide on rollback separately. |
| "I'll write the postmortem later when I have more time." | The postmortem auto-triggers on `resolved`. If you are deferring it, you are either not marking the incident resolved or suppressing auto-generation. Both are process violations. |
| "We don't need a severity — it's obvious." | Severity is metadata that feeds into postmortem priority, SLO budgets, and escalation decisions. Set it at `bober incident start` so downstream tooling can use it. |

## Quick Reference

| Question | Answer |
|---------|--------|
| How do I start a Severity 1 incident? | `bober incident start "<symptom>" --severity S1` |
| How do I check the current phase? | `bober incident status <id>` |
| How do I end an incident after external verification? | `bober incident end <id> --verified` |
| How do I end an incident when no metric is available? | `bober incident end <id> --override "reason here"` |
| How do I abort without rolling back? | `bober incident abort <id> --reason "<text>"` |
| How do I abort AND roll back? | `bober incident abort <id> --reason "<text>" --confirm-rollback` |
| How do I re-open a resolved incident? | `bober incident start "<symptom>"` (new incident) OR `transitionPhase(..., 'investigating', { reason })` programmatically |
| Where are the artifacts? | `.bober/incidents/<incidentId>/` |
| What gates a risky action? | `resolveRiskyActionMechanismName()` → disk/cli/pr/noop per `bober.config.json` |
| When is the postmortem generated? | Automatically when `setIncidentStatus(_, _, 'resolved', ...)` is called |

## Related Skills

| Skill | Use when |
|-------|---------|
| [`bober.diagnose`](../bober.diagnose/SKILL.md) | Running the 4-phase root-cause investigation. Invoked by `/bober-incident` after `start`. |
| [`bober.deploy`](../bober.deploy/SKILL.md) | Executing a remediation action with gate discipline. Invoked for each risky nextAction. |
| [`bober.runbook`](../bober.runbook/SKILL.md) | Executing a known remediation procedure step-by-step. Runbook steps delegate to `bober.deploy` for risky steps. |
| [`bober.postmortem`](../bober.postmortem/SKILL.md) | Synthesizing the incident postmortem after resolution. Auto-triggered; also available manually via `bober postmortem generate <id>`. |
