# Sprint Briefing: bober.runbook skill — runbook-execution discipline

**Contract:** sprint-spec-20260524-bober-vision-18
**Generated:** 2026-05-25T09:10:00.000Z
**Target file:** `skills/bober.runbook/SKILL.md` (create — single deliverable)

---

## Sprint Summary

Create ONE new markdown file — `skills/bober.runbook/SKILL.md` — the **runbook-execution sibling** of `skills/bober.diagnose/SKILL.md` (Sprint 17, just shipped). Where `bober.diagnose` is the investigator's discipline (gather → hypothesize → disprove → verify), `bober.runbook` is the executor's discipline: **parse the runbook → verify precondition → execute step → verify postcondition → advance** — with a hard gate around any step classified `blastRadius: 'risky'` that CANNOT be bypassed by `pipeline.mode='autopilot'`.

This skill is heavier discipline than even bober.diagnose because runbooks include destructive operations (kubectl scale, terraform apply, db migrations). A runbook that's run wrong makes the incident WORSE. The Iron Law requires VERIFIED preconditions AND postconditions for EVERY step — not just risky ones. A "safe" step that fails silently is worse than a risky step that fails loudly.

### What this sprint is NOT

- NOT TypeScript — single static Markdown file. No parser implementation, no tests. The skill TEACHES the parse format and execution loop; Sprint 20's deployer (bober.deploy) and Sprint 25's playbooks consume it.
- NOT a code-level skill — runbooks are operational/incident-response artifacts.
- NOT a verbatim port — `bober.runbook` is more original than `bober.diagnose` (which adapts obra/superpowers' systematic-debugging). MIT attribution is appropriate but as "Adapted from … verification-before-completion discipline" — see Pattern B.

### Verification (the 9 success criteria, in plain English)

| ID | What it checks |
|----|----------------|
| s18-c1 | YAML frontmatter `name: bober-runbook`, description starts with `Use when executing a runbook or step-by-step recovery procedure`. MIT attribution where applicable. |
| s18-c2 | Iron Law `NO STEP EXECUTION WITHOUT VERIFIED PRECONDITION; NO ADVANCE WITHOUT VERIFIED POSTCONDITION` (or equivalent). Red Flags ≥5. Rationalization-Prevention ≥5 rows. |
| s18-c3 | Parse format documented: frontmatter (name, classification, prerequisites) + numbered steps with description, command, precondition-check, postcondition-check, blastRadius (safe\|risky), rollback. |
| s18-c4 | Execution discipline: BEFORE each step run precondition; if fails STOP. EXECUTE. AFTER each step run postcondition; if fails STOP and trigger rollback. Explicit STOP conditions. |
| s18-c5 | **Hard gate**: risky steps INVOKE Tier 2 checkpoint regardless of `pipeline.mode`. Cannot be bypassed via autopilot. (Evaluator: verify "autopilot mode does NOT bypass" verbatim.) |
| s18-c6 | Rollback CASCADE: postcondition fails → rollback runs → if rollback also fails OR no rollback defined, escalate via checkpoint. Three-tier failure handling. |
| s18-c7 | Observation log: `.bober/incidents/<id>/runbook-execution.jsonl` with 7 fields: `timestamp, runbookName, stepNumber, status, preconditionResult, postconditionResult, rollbackTriggered?`. |
| s18-c8 | Cross-refs: `bober.diagnose`, `bober.deploy` (Sprint 20), `.bober/playbooks/` (Sprint 25). |
| s18-c9 | Build/lint/typecheck/tests still pass (single .md file → trivially satisfied). |

Target length: **~250-350 lines** (denser than bober.diagnose's 254 lines because of the parse-format example + execution pseudocode block + worked kubectl example).

---

## 1. Target File

### `skills/bober.runbook/SKILL.md` (create)

**Directory pattern:** Each skill lives at `skills/<dot-name>/SKILL.md`. Directory uses **dot-separated** (`bober.runbook`); the frontmatter `name` field uses **dash-separated** (`bober-runbook`). Confirmed by 20 existing skill dirs in `skills/`.

**Most similar existing file (THE structural template):** `skills/bober.diagnose/SKILL.md` (254 lines, just shipped). Mirror its:
- YAML frontmatter shape (1-4)
- MIT attribution blockquote shape (6-8)
- `## The Iron Law` fenced block (20-26)
- `<EXTREMELY-IMPORTANT>` gate blocks between phases (84-86, 118-120, 150-152)
- `## Red Flags - STOP and Follow Process` bullet list (191-206)
- `## Common Rationalizations` two-column table (209-219)
- `## Quick Reference` summary table (223-229)
- `## Related Skills` cross-references (243-246)

**Secondary reference:** `skills/bober.debug/SKILL.md` (300 lines, the original obra/superpowers verbatim port). Use for confirming any structural detail that bober.diagnose may have evolved.

**Tertiary reference:** `agents/bober-diagnoser.md` — confirms `blastRadius: 'safe' | 'risky'` enum (lines 123, 168). The runbook step's blastRadius enum MUST match this exact spelling.

**Directory creation note:** `skills/bober.runbook/` does not yet exist (`ls skills/` confirmed; only existing siblings include `bober.diagnose`, `bober.debug`, `bober.verify`, etc.). Generator must create both the directory and the `SKILL.md` file inside it.

**Skill file structure to follow (mirror bober.diagnose section order):**

```
1.  YAML frontmatter (name: bober-runbook, description)
2.  MIT attribution blockquote (3 lines, "Adapted from obra/superpowers")
3.  # Runbook Execution Discipline (H1)
4.  ## Overview (2-3 sentences + **Core principle:** + spirit-of-process line)
5.  ## The Iron Law (fenced block — single all-caps assertion)
6.  ## When to Use (bullet list; "ESPECIALLY when"; "Don't skip when")
7.  ## Runbook Parse Format (worked frontmatter + numbered step example)
8.  ## Execution Discipline (the four-stage loop with STOP conditions)
9.  ## Hard Gate — Risky Steps (UNCONDITIONAL Tier 2 checkpoint section)
10. ## Rollback Cascade (3-tier failure handling)
11. ## Observation Log (.bober/incidents/<id>/runbook-execution.jsonl schema)
12. ## Worked Example (concrete kubectl scale deployment scenario)
13. ## Red Flags - STOP and Follow Process (bullet list, ≥5)
14. ## Common Rationalizations (table, ≥5 rows)
15. ## Quick Reference (table summarizing the loop)
16. ## Related Skills (cross-refs: bober.diagnose, bober.deploy, .bober/playbooks/)
17. ## Real-World Impact (optional closer)
```

---

## 2. Patterns to Follow — Extracted from `skills/bober.diagnose/SKILL.md`

### Pattern A: YAML frontmatter (bober.diagnose:1-4)

```yaml
---
name: bober-diagnose
description: Use when investigating a production incident or system-level failure — gather evidence at component boundaries, hypothesize-and-disprove, verify resolution against pre-defined criteria
---
```

**For bober.runbook — required wording per s18-c1:**

```yaml
---
name: bober-runbook
description: Use when executing a runbook or step-by-step recovery procedure — verify precondition before each step, execute, verify postcondition before advancing; hard gate around destructive operations
---
```

**Hard requirements (s18-c1):**
- `name:` MUST be exactly `bober-runbook` (dash, not dot — matches dir-name → name-field convention)
- `description:` MUST start with the literal string `Use when executing a runbook or step-by-step recovery procedure`
- Frontmatter is the ONLY content before the H1; no blank line at top; `---` on line 1

### Pattern B: MIT attribution blockquote (bober.diagnose:6-8)

bober.diagnose's attribution is "Adapted from" (not verbatim), structural source = obra/superpowers's systematic-debugging. For bober.runbook, the closest upstream pattern is obra/superpowers's **verification-before-completion** discipline (the same precondition→execute→postcondition loop applied to skill execution). Per the orchestrator's guidance: "attribution optional, but adding the verbatim-voice attribution to obra/superpowers's verification-before-completion discipline is appropriate".

**Recommended attribution for bober.runbook:**

```markdown
> Adapted from [obra/superpowers](https://github.com/obra/superpowers) — MIT License.
> Structural source: verification-before-completion discipline (precondition → execute → postcondition loop).
> Adaptations: applied to runbook step execution; explicit hard gate around steps with blastRadius='risky'; rollback cascade for postcondition failures.
```

**Rule:** Attribution MUST be present (s18-c1 says "MIT attribution where applicable" — this sprint adapts the verification discipline, so attribution applies). Use "Adapted from" not "Verbatim port" because the runbook parse format and three-tier cascade are original to this sprint.

### Pattern C: Iron Law block (bober.diagnose:20-26)

```markdown
## The Iron Law

```
NO REMEDIATION WITHOUT VERIFIED ROOT CAUSE AT TWO INDEPENDENT BOUNDARIES
```

If your evidence comes from a single component, you have a candidate hypothesis — not a verified root cause. Continue gathering at independent boundaries before proposing any remediation.
```

**For bober.runbook — required wording per s18-c2:**

```markdown
## The Iron Law

```
NO STEP EXECUTION WITHOUT VERIFIED PRECONDITION; NO ADVANCE WITHOUT VERIFIED POSTCONDITION
```

A runbook is a contract: each step asserts what must be true BEFORE it runs and what must be true AFTER. Executing without verifying preconditions makes the incident worse. Advancing without verifying postconditions hides failures that the next step assumes have been handled.
```

**Required shape:**
- `## The Iron Law` H2 header
- Blank line
- Triple-backtick fenced block (NO language tag) containing the single-line all-caps assertion, no period
- Blank line
- 1-2 sentence consequence statement

### Pattern D: `<EXTREMELY-IMPORTANT>` gate blocks (bober.diagnose:84-86, 118-120, 150-152)

bober.diagnose has 3 gate blocks — one between each pair of phases. For bober.runbook, place gate blocks at:
1. **End of "Runbook Parse Format" section** — before "Execution Discipline" — ensuring parse must complete before execution begins
2. **Inside "Hard Gate — Risky Steps" section** — the unconditional autopilot-cannot-bypass assertion
3. **Inside "Rollback Cascade" section** — the rollback-also-fails → escalate-via-checkpoint assertion

**Verbatim template from bober.diagnose:84-86:**

```markdown
<EXTREMELY-IMPORTANT>
BEFORE proceeding to Phase 2, you MUST have completed Phase 1 in writing — symptom confirmed current, scope confirmed, timing confirmed, observations.jsonl appended. If any of these is incomplete, return to Phase 1. Skipping Phase 1 makes Phase 2 evidence-gathering ungrounded.
</EXTREMELY-IMPORTANT>
```

**Required adaptations for bober.runbook (3 gates):**

**Gate 1 (end of "Runbook Parse Format"):**
```markdown
<EXTREMELY-IMPORTANT>
BEFORE executing the first step, you MUST parse the runbook end-to-end and verify every step has a precondition-check and a postcondition-check declared. A runbook with an undeclared precondition-check on ANY step is malformed — abort and escalate via checkpoint. Do NOT silently default to "no check" — the absence of a check is a parse-time failure, not a runtime convenience.
</EXTREMELY-IMPORTANT>
```

**Gate 2 (inside "Hard Gate — Risky Steps"):**
```markdown
<EXTREMELY-IMPORTANT>
Risky steps invoke the Tier 2 checkpoint mechanism regardless of pipeline.mode. Autopilot mode does NOT bypass risky-step approval. If `pipeline.mode='autopilot'` and `pipeline.checkpointMechanism='noop'`, the runbook executor STILL invokes a non-noop mechanism (default 'disk' fallback) for any step with `blastRadius: 'risky'`. This is the production safety guarantee — bypassing it forfeits the guarantee.
</EXTREMELY-IMPORTANT>
```

**Gate 3 (inside "Rollback Cascade"):**
```markdown
<EXTREMELY-IMPORTANT>
If a step's postcondition fails AND its declared rollback ALSO fails (or no rollback was declared), the runbook executor MUST escalate via the Tier 2 checkpoint mechanism — do not silently proceed, do not retry the failed step. The incident state is now indeterminate; only a human (or the configured escalation handler) can decide the next move.
</EXTREMELY-IMPORTANT>
```

**Rule (s18-c5, s18-c6):** Gate 2 verbiage "autopilot mode does NOT bypass risky-step approval" is required VERBATIM per evaluatorNotes. Gate 3 verbiage encoding "escalate via checkpoint" three-tier cascade is required per s18-c6 evaluator scrutiny.

### Pattern E: Red Flags list shape (bober.diagnose:191-206)

```markdown
## Red Flags - STOP and Follow Process

If you catch yourself thinking:
- "The dashboard looks better, mark it resolved"
- "Just restart the service and see if it helps"
- "It's obviously the database, skip the cache layer"
- "The deploy at 14:00 must be it, ship the rollback"
- "One log line is enough — I can see the error right there"
- "No time for hypothesis-disproof, the page is loud"
- "The metric is back to baseline, declare resolved"
- "Stale alert — the customer probably just refreshed"
- "I've seen this before, I know what it is"
- Proposing remediation before confirming evidence at two independent boundaries
- **"Just one restart to stabilize, then we'll investigate"**

**ALL of these mean: STOP. Return to Phase 1.**
```

**Required shape (s18-c2 → ≥5 entries):**
- `## Red Flags - STOP and Follow Process` H2
- Lead-in `If you catch yourself thinking:`
- Bullet list of ≥5 quoted thoughts (each in `"..."`)
- Closing `**ALL of these mean: STOP. <action>.**`

**For bober.runbook — execution-context red flags (replace investigator thoughts with executor thoughts):**

Examples to write (≥5 required, aim for 7-9):
- `"The precondition check is obvious, just run the step"` — Iron Law violation
- `"The postcondition is just a sanity check, advance anyway"` — silent failure recipe
- `"It's a small scale-up, skip the checkpoint"` — risky-step hard-gate violation
- `"The rollback should be safe to skip, the change was tiny"` — cascade discipline collapse
- `"Autopilot mode said skip approval"` — fundamental safety-guarantee misunderstanding
- `"The step failed but the next one might fix it, try advancing"` — undefined state propagation
- `"No rollback declared, that means it's safe to skip the cascade"` — escalation-vs-skip confusion
- `"The runbook is in the playbook library so it must be safe"` — trust-but-no-verify
- `"Precondition timed out, retry without checking"` — masking partial states

Each MUST be in quoted-thought form (`"..."`) — present-participle clauses are allowed but bober.diagnose's mix is 9 thoughts + 1 participle + 1 bold. Mirror the proportion.

### Pattern F: Rationalization-Prevention table (bober.diagnose:209-219)

```markdown
## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "The dashboard looks green, we're resolved" | Resolution criteria require a NAMED metric meeting a NAMED threshold for a NAMED window. Eyeballing a dashboard is not verification. |
| "The deploy at 14:00 caused this — roll it back" | Correlation is not causation. Verify the deploy is the cause via independent telemetry before remediating. Rolling back the wrong thing extends the incident. |
| "Logs are unambiguous, one source is enough" | Iron Law: two independent boundaries. One source = continue gathering. Do not remediate on single-boundary evidence. |
| "No time to disprove the hypothesis, the page is loud" | Confirmation bias under pressure is the dominant incident-response failure mode. The disproof step exists EXACTLY for these moments. Skip it and you risk a second incident. |
| "Stale alert — the customer probably just refreshed" | Phase 1 requires CONFIRMING the symptom is current. "Probably refreshed" is not confirmation — query current state before proceeding. |
| "We'll set the resolution criteria after the fix lands" | Criteria set after the fix are retrofitted to the outcome. They MUST be pre-defined to be meaningful. Post-hoc criteria always pass. |
| "I've seen this before, skip to Phase 3" | Pattern memory is a hypothesis, not evidence. Phase 1 (confirm) and Phase 2 (boundaries) still produce the multi-source evidence required by the Iron Law. |
| "The MCP is slow, I'll just go from logs" | If a primary observability source is degraded, that is itself a diagnostic signal. Do NOT invent values for missing telemetry — low-confidence gaps are hypotheses, not evidence. |
```

**Required shape (s18-c2 → ≥5 rows):**
- `## Common Rationalizations` H2
- Markdown table with EXACTLY two columns: `Excuse | Reality`
- Header separator line: `|--------|---------|`
- ≥5 data rows; bober.diagnose has 8 — aim for 6-8

**For bober.runbook — execution-context rationalizations (≥5 required):**

Suggested rows (each row is `Excuse | Reality`):
- `"The precondition is just paperwork, the team always runs this step without checking"` | `Tribal-knowledge preconditions are precisely what the runbook formalizes. Run the check — if it's always true, it costs nothing; if it's not always true, you just averted an incident.`
- `"The postcondition can be verified later, we're behind schedule"` | `Postcondition deferred is postcondition skipped. The next step's precondition assumes this step's postcondition held. Defer the verification, defer the failure into a worse moment.`
- `"Autopilot mode is explicitly opt-in for trusted runbooks"` | `Autopilot mode trades human-in-the-loop for speed on SAFE steps. Risky-step approval is the safety floor — autopilot does NOT bypass it. Read the Iron Law again.`
- `"Rollback failed but the system looks fine, mark step complete"` | `If the rollback failed, you do not know the system state. "Looks fine" is not state knowledge. Escalate via checkpoint — the operator decides whether to mark complete or treat as undetermined.`
- `"No rollback declared because the step is reversible by retrying"` | `Retry-as-rollback is acceptable ONLY when declared as the rollback. An undeclared "we'll just retry" is implicit state, not a recoverable plan. Declare the rollback at runbook-write time.`
- `"The runbook came from the playbook library, trust the author"` | `Trust the discipline, not the author. The parse format and the four-stage loop apply to every runbook regardless of author. The library passed review for SHAPE, not for situation fit.`

### Pattern G: Quick Reference summary table (bober.diagnose:223-229)

```markdown
## Quick Reference

| Phase | Key Activities | Success Criteria |
|-------|---------------|------------------|
| **1. Reproduce + Confirm** | Confirm symptom current, confirm scope, confirm timing, write `observations.jsonl` | Symptom is real, scoped, and timed |
| **2. Gather at Boundaries** | Enumerate components; query `obs__<provider>__<tool>` at each boundary; correlate `changelog.jsonl` | Evidence at ≥2 independent boundaries |
| **3. Hypothesize + Disprove** | Rank hypotheses by evidence; pattern-match anti-catalog; actively seek contradicting evidence | Top hypothesis survived a recorded disproof attempt |
| **4. Verify Resolution** | Pre-define metric+threshold+window+baseline+source; remediate via bober-deployer; monitor; mark resolved | Criteria met for the full named window |
```

**For bober.runbook — adapt to four execution stages:**

```markdown
## Quick Reference

| Stage | Key Activities | Success Criteria |
|-------|---------------|------------------|
| **1. Parse** | Read frontmatter (name, classification, prerequisites); enumerate steps; verify each step has precondition-check + postcondition-check + blastRadius | Runbook is structurally valid |
| **2. Precondition** | Run precondition-check command (or read the condition); compare to expected state | Result matches expected; otherwise STOP |
| **3. Execute** | If step is risky → invoke Tier 2 checkpoint (regardless of pipeline.mode); on approval, run the step's command (or await human action) | Step ran without error |
| **4. Postcondition** | Run postcondition-check; if pass → advance; if fail → run rollback; if rollback also fails → escalate via checkpoint | Either step's postcondition holds OR rollback's postcondition holds OR escalation triggered |
```

### Pattern H: Related Skills cross-references (bober.diagnose:243-246)

```markdown
## Related Skills

- **`bober.debug`** (`skills/bober.debug/SKILL.md`) — Use when the incident root cause turns out to be code-level (a test reproduces it, single component, deterministic). `bober.diagnose` handles "is the system broken?"; `bober.debug` handles "is the code wrong?". They are siblings, not parent-child. Used by `agents/bober-diagnoser.md`.
- **`bober.runbook`** (`skills/bober.runbook/SKILL.md`, Sprint 18) — When the diagnoser's next action is "follow runbook X", use `bober.runbook` for execution discipline (precondition → execute → postcondition for every step).
- **`bober.deploy`** (`skills/bober.deploy/SKILL.md`, Sprint 20) — Remediation execution via `agents/bober-deployer.md`. Required for any `blastRadius: 'risky'` action. Never run state-mutating commands from the diagnoser — always route through bober-deployer.
- **`.bober/anti-patterns/`** — Pattern catalog. Phase 3 hypothesis formation must check **Symptom-Fix Instead of Root-Cause** (`root-cause-tracing.md`) and **Single-Layer Validation** (`defense-in-depth.md`) for matches.
```

**For bober.runbook — required cross-refs per s18-c8:**

```markdown
## Related Skills

- **`bober.diagnose`** (`skills/bober.diagnose/SKILL.md`, Sprint 17) — Upstream skill. The diagnoser identifies "follow runbook X" as a next-action; that next-action is then executed under this skill's discipline. Diagnose says WHAT to do; runbook says HOW to do each step safely.
- **`bober.deploy`** (`skills/bober.deploy/SKILL.md`, Sprint 20) — Downstream execution wiring. `bober.deploy` is the agent-level execution discipline (action classification, checkpoint gate enforcement, ChangeEntry recording with required inverse). `bober.runbook` is the operator-level discipline for executing a step-by-step procedure; `bober.deploy` is what actually runs the risky step. Risky steps in this skill DELEGATE to `agents/bober-deployer.md` for execution.
- **`.bober/playbooks/`** (Sprint 25) — Library of curated runbooks (`build-failure.md`, `migration-timeout.md`, `error-spike.md`, `latency-regression.md`). Each playbook MUST conform to the parse format documented in this skill. The diagnoser invokes `searchPlaybooks(symptom)` to find a matching playbook; matched playbooks are executed under this skill's discipline.
- **`.bober/anti-patterns/`** — Pattern catalog. Two anti-patterns are especially common in runbook execution: **Single-Layer Validation** (`defense-in-depth.md` — postcondition skipped because step "looked successful") and **Symptom-Fix Instead of Root-Cause** (`root-cause-tracing.md` — running a recovery runbook to mask an underlying defect).
```

---

## 3. Sprint-18-Specific Content (not in bober.diagnose)

### Section A: Runbook Parse Format (s18-c3)

This section documents the markdown shape a playbook file must follow. The Generator should paste the following as a SINGLE worked example showing both a "safe" step and a "risky" step (so the parse format is illustrated end-to-end, not abstractly).

**Required wording lead-in:**

```markdown
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

```markdown
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
```
```

**Source for this worked example:** `generatorNotes` of the contract — paste verbatim with minor reformatting for the skill body. Evaluator (per evaluatorNotes) requires **concrete kubectl/jq commands** in the worked example; abstract examples ("call the API") are rejected.

### Section B: Execution Discipline (s18-c4) — pseudocode block

The Generator MUST include the execution loop as either pseudocode (preferred — matches generatorNotes) OR a numbered prose list. Use the pseudocode FROM the contract's generatorNotes verbatim:

```markdown
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

**STOP conditions enumerated (s18-c4 requires explicit STOP conditions):**

- **Precondition fails** → STOP. Write `{status: 'precondition_failed'}` to runbook-execution.jsonl. Do NOT execute.
- **Risky-step checkpoint rejected** → STOP. Write `{status: 'checkpoint_rejected'}`. Do NOT execute.
- **Step execution errors** → STOP. Write `{status: 'execution_failed'}`. Trigger rollback if defined; otherwise escalate.
- **Postcondition fails AND rollback fails (or no rollback)** → STOP. Write `{status: 'rollback_failed'}` (or `{status: 'postcondition_failed_no_rollback'}`). Escalate via checkpoint.

ADVANCE happens ONLY when the postcondition-check explicitly passes. Default behavior on uncertainty is STOP, not ADVANCE.
```

### Section C: Hard Gate — Risky Steps (s18-c5)

This is the safety-guarantee section. Per evaluatorNotes: "Verify hard gate around risky steps is UNCONDITIONAL — the skill must explicitly say 'autopilot mode does NOT bypass risky-step approval'. Without this the production safety guarantee collapses."

**Required wording (the verbatim phrase is non-negotiable):**

```markdown
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
```

### Section D: Rollback Cascade (s18-c6) — three-tier failure handling

Per evaluatorNotes: "Verify rollback discipline includes the cascade: postcondition fails → rollback executes → if rollback fails, escalate. Three-tier failure handling. If the skill stops at 'rollback executes' the rollback-failure case is undefined."

**Required content:**

```markdown
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
```

### Section E: Observation Log (s18-c7) — runbook-execution.jsonl schema

Per evaluatorNotes: "Verify observation log shape (.bober/incidents/<id>/runbook-execution.jsonl) is documented with the same field names that Sprint 19 will write. Schema drift between sprints would break the incident timeline."

Sprint 19's contract confirms (cross-checked): `appendRunbookExecution` writes to `.bober/incidents/<id>/runbook-execution.jsonl`. The skill must document the SAME 7 field names.

**Required content:**

```markdown
## Observation Log

Every step execution writes one line to `.bober/incidents/<id>/runbook-execution.jsonl`. Sprint 19's `appendRunbookExecution` helper provides the write primitive; this skill documents the schema.

**Line shape:**

```json
{
  "timestamp": "<ISO-8601, when the step completed (or failed)>",
  "runbookName": "<frontmatter name from the runbook file>",
  "stepNumber": <integer, 1-indexed from the H2 ## Step N: ...>,
  "status": "'precondition_failed' | 'checkpoint_rejected' | 'execution_failed' | 'postcondition_failed_no_rollback' | 'rollback_failed' | 'recovered_via_rollback' | 'success'",
  "preconditionResult": "'pass' | 'fail' | 'not_run'",
  "postconditionResult": "'pass' | 'fail' | 'not_run'",
  "rollbackTriggered": <boolean — true if Tier 1 of the cascade ran, false or omitted otherwise>
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
```

### Section F: Worked Example (mandatory per evaluatorNotes)

Per evaluatorNotes: "Verify the worked example uses concrete commands (kubectl, jq) — abstract examples are less effective at communicating the discipline."

The Parse Format example (Section A) already shows kubectl/jq. Add a SECOND, more complete worked example at the end of the skill (just before Related Skills) that walks through one full execution:

```markdown
## Worked Example — Recovering from API Error Spike

A worked end-to-end execution of `high-error-rate-recovery` (the runbook in §Runbook Parse Format).

**Setup:** Datadog alert fires at 14:00 UTC. `api.error_rate` at 4.2%. Diagnoser (via `bober.diagnose` Phase 1-3) hypothesizes "replicas exhausted under load, scaling up will relieve pressure." `nextActions[0]` is `{action: "follow runbook high-error-rate-recovery", blastRadius: "risky", requiresApproval: true}`. Orchestrator invokes this skill.

**Step 1 — Confirm error rate exceeded threshold (`blastRadius: safe`):**

Precondition-check:
```bash
$ curl -s "https://datadog/api/v1/query?query=avg:api.error_rate{*}&from=now-5m" | jq .series[0].pointlist[-1][1]
0.042   # 4.2% > 1% threshold → PASS
```

Execute (description-only): "Open the runbook approver in the team channel" — agent awaits human action via checkpoint.

Postcondition-check:
```bash
$ grep -c "approved" /tmp/channel-acks.log
1   # at least one approver → PASS
```

Status: `success`. ADVANCE to Step 2.

**Step 2 — Scale up replicas (`blastRadius: risky`):**

Precondition-check:
```bash
$ kubectl get deployment api-service -o json | jq .spec.replicas
3   # matches expected → PASS
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
6   # 6 pods Ready → PASS
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
```

---

## 4. Existing Utilities — DO NOT Recreate

This sprint creates a single Markdown file. No TypeScript utilities are touched. However, the skill references several existing artifacts the Generator must NOT re-define:

| Reference | Location | What it is | How this skill uses it |
|-----------|----------|-----------|------------------------|
| `blastRadius: 'safe' \| 'risky'` enum | `agents/bober-diagnoser.md:123, 168` | The exact spelling for the next-action blast radius | This skill's steps use the same enum — copy spelling verbatim |
| Tier 2 checkpoint mechanism | Sprint 13 (`src/checkpoint/`) | The disk-backed approval gate | The hard-gate section references this — do NOT redefine the mechanism |
| `pipeline.mode` | Sprint 14 config schema | `'auto' \| 'careful' \| 'autopilot'` | Hard-gate language refers to `'autopilot'` — do NOT introduce new mode names |
| `pipeline.checkpointMechanism` | Sprint 14 config schema | `'disk' \| 'noop' \| ...` | Hard-gate explains that `'noop'` is overridden for risky steps |
| `pipeline.allowAutopilotRiskyActions` | Sprint 20 (planned) | Escape hatch — default `false` | Skill mentions this BY NAME but does NOT define its behavior in detail (that's Sprint 20's deploy skill) |
| `.bober/incidents/<id>/runbook-execution.jsonl` | Sprint 19 (planned, depends on this) | Append-only execution log | Schema documented in §Observation Log — fields MUST match what Sprint 19 will write |
| `.bober/incidents/<id>/timeline.jsonl` | Sprint 19 | Master chronological log | Mention only — every helper writes a timeline event |
| `.bober/incidents/<id>/changelog.jsonl` | Sprint 19, ChangeEntry shape | Records changes with required `inverse` | Reference in Hard-Gate section — operator modifications recorded here |
| `agents/bober-deployer.md` | Sprint 20 (planned) | The executor agent | Cross-reference only — risky steps DELEGATE to this agent |
| `.bober/playbooks/` | Sprint 25 (planned) | Curated playbook library | Cross-reference — confirm path is exactly `.bober/playbooks/` |
| `.bober/anti-patterns/` | Pre-existing | Pattern catalog | Cross-reference at end |
| obra/superpowers verification-before-completion | `/tmp/superpowers/` (machine-local upstream) | MIT-licensed structural source | Attribution blockquote (Pattern B) |

**Existing skill template — for structural reference only, NOT to copy content from:**

| File | Lines | Why useful |
|------|------|-----------|
| `skills/bober.diagnose/SKILL.md` | 254 | Closest sibling — mirror frontmatter, attribution, Iron Law, gate blocks, Red Flags, Rationalization, Quick Reference, Related Skills shapes |
| `skills/bober.debug/SKILL.md` | 300 | Original obra/superpowers verbatim port — confirms YAML/attribution shape if bober.diagnose has deviated |
| `agents/bober-diagnoser.md` | 256 | Source for the `blastRadius` enum spelling and the verbatim phrasing of `<EXTREMELY-IMPORTANT>` blocks |

---

## 5. Prior Sprint Output (the foundation this skill sits on)

### Sprint 17 (just shipped): `skills/bober.diagnose/SKILL.md`
- **Created:** A 254-line skill defining the 4-phase incident diagnosis discipline.
- **Connection to this sprint:** Sprint 17's Phase 3 (Hypothesize and Disprove) produces a leading hypothesis with a recommended `nextAction`. When the next-action is `{action: "follow runbook X", blastRadius: "risky"}`, the orchestrator invokes THIS skill. Sprint 17's line 244 already cross-references `bober.runbook` — that link becomes live when this skill ships. Sprint 17's cross-reference text:
  > `bober.runbook` (`skills/bober.runbook/SKILL.md`, Sprint 18) — When the diagnoser's next action is "follow runbook X", use `bober.runbook` for execution discipline (precondition → execute → postcondition for every step).
  This sprint MUST make that cross-reference accurate by creating the file at the named path.

### Sprint 15: `agents/bober-diagnoser.md`
- **Created:** The read-only diagnoser agent. Defines the `blastRadius: 'safe' | 'risky'` enum (lines 123, 168, 192) and the contradicting-evidence discipline.
- **Connection to this sprint:** This skill's step format uses the SAME `blastRadius` enum. Spelling must match exactly — `'safe'` and `'risky'` (lowercase, single quotes in prose, no other variants like `'safe' | 'dangerous'`).

### Sprint 14: Config schema (mode, checkpointMechanism, overrides)
- **Created:** `src/config/schema.ts` adds `pipeline.mode`, `pipeline.checkpointMechanism`, etc.
- **Connection to this sprint:** Hard-gate section refers to `pipeline.mode='autopilot'` and `pipeline.checkpointMechanism='noop'`. Use these names verbatim.

### Sprint 13: Disk-backed checkpoint mechanism
- **Created:** `src/checkpoint/` (mechanism abstraction + 'disk' implementation).
- **Connection to this sprint:** The hard-gate forced-floor uses `'disk'` as the default fallback when configured `'noop'` is overridden. Mention by name.

### Sprint 2: `skills/bober.debug/SKILL.md` (original template)
- **Created:** First obra/superpowers port — the structural ancestor of bober.diagnose and bober.runbook.
- **Connection to this sprint:** Structural reference (frontmatter shape, attribution blockquote shape, Iron Law fenced block, two-column rationalization table). Used only as a tiebreaker if bober.diagnose has deviated from the canonical shape.

---

## 6. Relevant Documentation

### Project Principles
**No `.bober/principles.md` found** at the project root or in `.bober/`. Generator should NOT cite a principles file. The implicit principles for this sprint come from:
- The Iron-Law pattern (bober.debug, bober.diagnose, bober-diagnoser.md all use the same verbatim-voice all-caps fenced block)
- The `<EXTREMELY-IMPORTANT>` block pattern (bober.diagnose, bober.using-bober, bober-diagnoser.md)
- The "Spirit over letter" rationalization-table entry (bober-diagnoser.md:242)

### Architecture Decisions
No ADRs found in `.bober/architecture/` (directory does not exist). The relevant architectural-decision-equivalents are the sprint contracts in `.bober/contracts/`:
- `sprint-spec-20260524-bober-vision-17.json` — established the 4-phase + Iron-Law pattern
- `sprint-spec-20260524-bober-vision-18.json` — THIS sprint, with the runbook-execution discipline
- `sprint-spec-20260524-bober-vision-19.json` — incident artifact layout, confirms `.bober/incidents/<id>/runbook-execution.jsonl` is the right path
- `sprint-spec-20260524-bober-vision-20.json` — bober.deploy, confirms the downstream executor wiring
- `sprint-spec-20260524-bober-vision-25.json` — playbook library, confirms `.bober/playbooks/` is the right path

### Anti-patterns catalog
`.bober/anti-patterns/` contains:
- `README.md`
- `condition-based-waiting.md`
- `defense-in-depth.md`
- `root-cause-tracing.md`
- `testing-anti-patterns.md`

Cross-reference TWO of these in the "Related Skills" section (matching bober.diagnose's choice):
- `defense-in-depth.md` → Single-Layer Validation (postcondition skipped because "step looked successful")
- `root-cause-tracing.md` → Symptom-Fix Instead of Root-Cause (running a recovery runbook to mask an underlying defect)

---

## 7. Testing Patterns

**This sprint creates a single static Markdown file. There is no unit test to write.**

Verification (s18-c9) is the existing eval suite: `npm run typecheck && npm run lint && npm run build && npm run test`. All four should pass trivially because no source files were modified.

**Manual verification the Generator should perform before declaring done:**

```bash
# 1. File exists at correct path
test -f skills/bober.runbook/SKILL.md && echo "OK: file exists"

# 2. YAML frontmatter parses (line 1-4)
head -4 skills/bober.runbook/SKILL.md

# 3. Required strings present
grep -F "name: bober-runbook" skills/bober.runbook/SKILL.md
grep -F "Use when executing a runbook or step-by-step recovery procedure" skills/bober.runbook/SKILL.md
grep -F "NO STEP EXECUTION WITHOUT VERIFIED PRECONDITION" skills/bober.runbook/SKILL.md
grep -F "autopilot mode does NOT bypass" skills/bober.runbook/SKILL.md
grep -F "runbook-execution.jsonl" skills/bober.runbook/SKILL.md

# 4. Cross-references resolve to real paths (bober.diagnose exists; bober.deploy and playbooks do not yet)
test -f skills/bober.diagnose/SKILL.md && echo "OK: diagnose link is live"

# 5. Line count target (~250-350)
wc -l skills/bober.runbook/SKILL.md

# 6. Red Flags count
grep -cE '^- "' skills/bober.runbook/SKILL.md  # expect ≥5

# 7. Rationalization rows count
awk '/^## Common Rationalizations/,/^## /' skills/bober.runbook/SKILL.md | grep -cE '^\|.*\|.*\|$'  # expect ≥6 (5 data rows + 1 separator)
```

**Eval suite invocation (s18-c9):**

```bash
npm run typecheck && npm run lint && npm run build && npm run test
```

All four should exit 0. If any fail, it indicates a pre-existing regression in another sprint, not in this one (this sprint adds zero TypeScript).

---

## 8. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
This sprint adds ONE file in a new directory (`skills/bober.runbook/SKILL.md`). It modifies NOTHING. Impact radius is therefore:

| File | Type of dependency | Risk | What to check |
|------|---------------------|------|---------------|
| `skills/bober.diagnose/SKILL.md` | References this skill at line 244 | low | The cross-reference is already there — this sprint makes it resolvable; nothing to update in diagnose |
| `agents/bober-diagnoser.md` | References `bober.runbook` in "Related Skills" line 216 | low | The text says "not yet created at the time of this agent's authoring" — that comment becomes stale once this sprint ships. Generator MAY note this for a future small-cleanup sprint (NOT in scope here) |
| `package.json` / `tsconfig.json` / build configs | None | none | No code touched |

### Existing Tests That Must Still Pass
No tests directly test SKILL.md files. The full eval suite (`npm run test`) covers other areas and should pass unchanged because no source was modified.

| Test file (representative) | What it covers | Why unaffected |
|----------------------------|-----------------|----------------|
| `tests/orchestrator/*.test.ts` | Orchestrator wiring | No orchestrator changes |
| `tests/config/*.test.ts` | Config schema | No config changes |
| `tests/audit/*.test.ts` | Audit log | No audit changes |
| `tests/checkpoint/*.test.ts` | Checkpoint mechanism | No checkpoint changes |

### Features That Could Be Affected
- **Sprint 19 (incident timeline tracking)** — depends on this sprint. The observation-log field names in §Section E MUST match what Sprint 19's `appendRunbookExecution` will write. If schema drifts, Sprint 19's tests will catch it — but the easier fix is to lock the field names HERE.
- **Sprint 20 (bober.deploy)** — depends on this sprint. The hard-gate language in §Section C and the rollback cascade in §Section D set the expectations Sprint 20's deployer agent must implement. If wording diverges, Sprint 20 may interpret the gate differently. Generator MUST use the exact phrase "autopilot mode does NOT bypass risky-step approval" so Sprint 20 can grep for it.
- **Sprint 25 (.bober/playbooks/)** — Each playbook must conform to the parse format documented HERE. If the parse format omits a field, every playbook in the starter library will be missing it. The format in §Section A is the contract.

### Recommended Regression Checks
After this sprint lands, the Generator MUST run:

```bash
# 1. Confirm SKILL.md file exists and parses (grep-based, doesn't need a parser)
grep -q "^name: bober-runbook$" skills/bober.runbook/SKILL.md
grep -q "^description: Use when executing a runbook" skills/bober.runbook/SKILL.md

# 2. Iron Law string match (s18-c2)
grep -F "NO STEP EXECUTION WITHOUT VERIFIED PRECONDITION; NO ADVANCE WITHOUT VERIFIED POSTCONDITION" skills/bober.runbook/SKILL.md

# 3. Hard-gate verbatim phrase (s18-c5; evaluatorNotes explicit)
grep -F "autopilot mode does NOT bypass risky-step approval" skills/bober.runbook/SKILL.md

# 4. Rollback cascade verbatim phrase (s18-c6; three-tier cascade required)
grep -E "rollback (ALSO|also) fails" skills/bober.runbook/SKILL.md  # must match the cascade phrasing
grep -F "escalate via the Tier 2 checkpoint" skills/bober.runbook/SKILL.md

# 5. Observation log schema (s18-c7; all 7 field names)
for field in timestamp runbookName stepNumber status preconditionResult postconditionResult rollbackTriggered; do
  grep -q "\"$field\"" skills/bober.runbook/SKILL.md || echo "MISSING field in observation log schema: $field"
done

# 6. Cross-references (s18-c8)
grep -F "bober.diagnose" skills/bober.runbook/SKILL.md
grep -F "bober.deploy" skills/bober.runbook/SKILL.md
grep -F ".bober/playbooks/" skills/bober.runbook/SKILL.md

# 7. Red Flags ≥5
test "$(grep -cE '^- ".+"' skills/bober.runbook/SKILL.md)" -ge 5

# 8. Worked example uses concrete commands (evaluatorNotes)
grep -F "kubectl scale" skills/bober.runbook/SKILL.md
grep -F "jq" skills/bober.runbook/SKILL.md

# 9. Full eval suite still green
npm run typecheck && npm run lint && npm run build && npm run test
```

All 9 should pass before the sprint is marked complete.

---

## 9. Implementation Sequence

1. **Create the directory.** `mkdir -p /Users/bober4ik/agent-bober/skills/bober.runbook/`
   - Verify: `ls skills/bober.runbook/` shows an empty directory.

2. **Write the YAML frontmatter + MIT attribution.** Lines 1-9 of the new file.
   - Frontmatter MUST have `name: bober-runbook` and description starting with `Use when executing a runbook or step-by-step recovery procedure`.
   - Attribution blockquote uses "Adapted from" (not "Verbatim port"), 3 lines.
   - Verify: `head -9 skills/bober.runbook/SKILL.md` shows the exact shape from Patterns A + B.

3. **Write H1 + Overview section.** ~10 lines.
   - H1: `# Runbook Execution Discipline`
   - Overview: 2-3 sentences explaining what a runbook is and why discipline matters, ending with `**Core principle:** ALWAYS verify the precondition before executing each step, and the postcondition before advancing.` and `**Violating the letter of this process is violating the spirit of incident recovery.**`
   - Verify: section parses as Markdown; both bold lines present.

4. **Write Iron Law block.** ~7 lines, mirror Pattern C.
   - Verify: `grep -F "NO STEP EXECUTION WITHOUT VERIFIED PRECONDITION; NO ADVANCE WITHOUT VERIFIED POSTCONDITION" skills/bober.runbook/SKILL.md` matches.

5. **Write "When to Use" section.** ~20 lines, mirror bober.diagnose:29-49.
   - Use this skill for: recovering from prod incident via runbook; following step-by-step disaster procedure; executing a curated playbook from `.bober/playbooks/`.
   - ESPECIALLY when: incident is active and seconds count; runbook author is not in the room; the procedure involves destructive operations.
   - Don't skip when: "everyone knows this runbook"; "we ran it last week and it was fine"; "the operator says skip the precondition."

6. **Write Runbook Parse Format section (§Section A).** ~50 lines.
   - Documents frontmatter shape.
   - Documents each step's 6 fields.
   - Includes the worked frontmatter + 2-step example (Step 1 safe, Step 2 risky with rollback).
   - End with Gate 1 `<EXTREMELY-IMPORTANT>` block.
   - Verify: grep for `blastRadius:`, `precondition-check:`, `postcondition-check:`, `rollback:`, `kubectl scale`, `jq` — all present.

7. **Write Execution Discipline section (§Section B).** ~30 lines.
   - The pseudocode FOR/IF block.
   - The enumerated STOP conditions (4 of them).
   - The "ADVANCE happens ONLY when …" closer.
   - Verify: grep for `FOR each step IN runbook`, `precondition_failed`, `checkpoint_rejected`, `rollback_failed`.

8. **Write Hard Gate — Risky Steps section (§Section C).** ~25 lines.
   - 3 bullet points: autopilot doesn't bypass; noop doesn't apply; multi-command bash doesn't slip.
   - Operator-action paragraph (approve/reject/modify).
   - Gate 2 `<EXTREMELY-IMPORTANT>` block.
   - Closing paragraph about `pipeline.allowAutopilotRiskyActions` escape hatch (mention; defer details to Sprint 20).
   - Verify: `grep -F "autopilot mode does NOT bypass risky-step approval"` matches.

9. **Write Rollback Cascade section (§Section D).** ~25 lines.
   - 3 tiers, one paragraph each.
   - Gate 3 `<EXTREMELY-IMPORTANT>` block.
   - Verify: `grep -F "Tier 1 — Run the declared rollback"` matches; `grep -F "Tier 2"` and `Tier 3` present.

10. **Write Observation Log section (§Section E).** ~30 lines.
    - JSON shape with all 7 field names.
    - 3-line worked jsonl example.
    - Field-name-lock paragraph.
    - Verify: all 7 field names present (`timestamp, runbookName, stepNumber, status, preconditionResult, postconditionResult, rollbackTriggered`).

11. **Write Worked Example section (§Section F).** ~50 lines.
    - Setup paragraph.
    - Step 1 walkthrough (curl + jq for datadog, grep for ack).
    - Step 2 walkthrough (kubectl get, hard-gate, kubectl scale, kubectl get|jq for postcondition).
    - 2-line jsonl log output.
    - Counter-example paragraph (rollback cascade).
    - Verify: kubectl + jq both present; cascade-counter-example paragraph reaches "STOP".

12. **Write Red Flags section.** ~12 lines.
    - H2 `## Red Flags - STOP and Follow Process`
    - Lead-in `If you catch yourself thinking:`
    - ≥5 quoted-thought bullets (target 7-9).
    - Closing `**ALL of these mean: STOP. <action>.**`
    - Verify: `grep -cE '^- "' skills/bober.runbook/SKILL.md` ≥ 5.

13. **Write Rationalization Prevention section.** ~10 lines.
    - H2 `## Common Rationalizations`
    - Two-column table.
    - ≥5 data rows.
    - Verify: row count via the awk command in §7.

14. **Write Quick Reference section.** ~8 lines.
    - H2 `## Quick Reference`
    - 4-stage summary table per Pattern G.
    - Verify: 4 rows for Parse/Precondition/Execute/Postcondition.

15. **Write Related Skills section.** ~10 lines.
    - Per Pattern H — cross-refs to bober.diagnose, bober.deploy, .bober/playbooks/, .bober/anti-patterns/.
    - Verify: all 4 cross-refs present; bober.diagnose path is `skills/bober.diagnose/SKILL.md` (exists today).

16. **Optional: Real-World Impact closer.** ~5 lines.
    - Mirror bober.diagnose:248-254 if length allows.

17. **Run all 9 regression checks from §8.**
    - Verify all 9 commands pass.

18. **Run the eval suite.** `npm run typecheck && npm run lint && npm run build && npm run test`
    - Verify all four exit 0.

---

## 10. Pitfalls & Warnings

- **Do NOT use `name: bober.runbook`** (dot). The frontmatter convention across all 20 existing skills is dash-separated (`bober-runbook`). Confirmed: `bober.diagnose` directory contains `SKILL.md` with `name: bober-diagnose`. Dot in directory → dash in frontmatter.

- **Do NOT write "autopilot may bypass risky-step approval"** or any softer variant. The evaluator greps for the exact phrase `autopilot mode does NOT bypass risky-step approval`. Per evaluatorNotes: "Without this the production safety guarantee collapses."

- **Do NOT stop at "rollback executes" in the cascade.** Per evaluatorNotes: "If the skill stops at 'rollback executes' the rollback-failure case is undefined." The cascade has THREE tiers — rollback runs → rollback fails OR not defined → escalate via checkpoint. Document all three.

- **Do NOT use abstract worked-example commands.** Per evaluatorNotes: "Verify the worked example uses concrete commands (kubectl, jq) — abstract examples are less effective at communicating the discipline." Use `kubectl scale deployment api-service --replicas=6`, `jq .spec.replicas`, etc. Not `call the API` or `run the scale command`.

- **Do NOT introduce field-name variants in the observation log.** The 7 fields are EXACTLY `timestamp, runbookName, stepNumber, status, preconditionResult, postconditionResult, rollbackTriggered`. Snake-case variants (`step_number`, `runbook_name`) break Sprint 19's schema. Camel-case throughout.

- **Do NOT skip Gate blocks.** Three `<EXTREMELY-IMPORTANT>` blocks are required (Pattern D): one at end of Parse Format, one inside Hard Gate, one inside Rollback Cascade. Plain "**BEFORE proceeding…**" sentences are NOT a substitute — bober.diagnose deliberately uses the angle-bracket tag form (vs bober.debug's plain-sentence form) because the evaluator's grep pattern looks for the tags.

- **Do NOT confuse `bober.runbook` with `bober.deploy`.** They are NOT the same skill. `bober.runbook` (this sprint) is the **operator-level discipline for executing a step-by-step procedure**. `bober.deploy` (Sprint 20) is the **agent-level execution mechanism** (action classification + checkpoint callback + ChangeEntry recording). They cross-reference each other, but they are distinct skills. The Generator must NOT write a "we'll cover this in deploy" placeholder where the runbook discipline itself should be documented.

- **Do NOT cite `.bober/principles.md` or `.bober/architecture/`** as sources. Neither exists. The implicit-principles citations are the prior skill files themselves (bober.debug, bober.diagnose, bober-diagnoser.md).

- **Do NOT add a "Bash Discipline" allowlist section.** That belongs in `agents/bober-diagnoser.md` and Sprint 20's `agents/bober-deployer.md`. The SKILL.md teaches the discipline; the AGENT.md enforces it via tool permissions. This skill discusses risky-vs-safe classification at the conceptual level — the actual command allowlist is in the agent file.

- **Do NOT introduce a new `classification` enum value.** Sprint 25's playbooks use `classification: 'standard' | 'emergency'` (confirmed by `sprint-spec-20260524-bober-vision-25.json`). Do not add `'recovery'`, `'maintenance'`, `'experimental'`, etc. — they would create schema drift before the playbook library ships.

- **Do NOT pre-implement Sprint 25 content.** This skill DOCUMENTS the parse format that playbooks will follow. It does NOT include actual playbook files — those are Sprint 25's deliverable at `.bober/playbooks/<name>.md`.

- **Length sanity check.** Target ~250-350 lines. `bober.diagnose` is 254 lines without an execution loop or worked example; this skill has BOTH, so a higher line count is expected. If you finish at <200 lines, you have likely omitted required content. If >400 lines, you have likely over-explained — trim the Worked Example or the Rationalization table.

- **Markdown nesting trap.** The Iron Law fenced block uses triple backticks with NO language tag (Pattern C). The parse-format example contains triple-backtick code blocks INSIDE the H2 section. If you nest naively, the outer code fence closes early. Use 4-backtick fences for the outer parse-format block, OR alternate triple-backtick + indented-code-block, OR escape inner fences via `~~~`. Mirror what bober.diagnose does at lines 22-26 + 162-169 for the multi-fence pattern.

