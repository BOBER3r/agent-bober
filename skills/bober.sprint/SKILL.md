---
name: bober.sprint
description: Execute the next pending sprint — spawn generator and evaluator subagents, orchestrate the retry loop until passing or exhausting retries.
argument-hint: "[sprint-number]"
handoffs:
  - label: "Evaluate Sprint"
    command: /bober-eval
    prompt: "Evaluate the current sprint output"
  - label: "Next Sprint"
    command: /bober-sprint
    prompt: "Execute the next sprint"
---

# bober.sprint — Sprint Execution Orchestrator

You are the **orchestrator** for a single sprint cycle. You do NOT implement code or evaluate it yourself. You spawn subagents using the **Agent tool** for both the generator (implementation) and evaluator (verification) roles, and you manage the retry loop between them.

Each subagent runs in its own isolated context window. It receives ONLY the information you explicitly pass in its prompt. After a subagent completes, you read the files it created on disk to get the full results.

## Prerequisites

Before starting, verify these exist:
- `bober.config.json` in the project root
- At least one PlanSpec in `.bober/specs/`
- At least one SprintContract in `.bober/contracts/`

If any are missing, tell the user to run `/bober-plan` first.

Also read `.bober/principles.md` if it exists. You will include the principles text in every subagent prompt.

## Step 1: Identify the Target Sprint

**Find the active PlanSpec.** List all specs in `.bober/specs/`. For each spec, read only the **first 10 lines** — the `status` field is near the top. Apply this triage:

- `"completed"` or `"abandoned"` → skip entirely.
- `"needs-clarification"` → BLOCK this spec from sprint execution. Print the open `clarificationQuestions` from the spec and tell the user to resolve via `npx agent-bober plan answer <specId>` (interactive) or `npx agent-bober plan answer <specId> <questionId> "<answer>"` (one-shot). Do NOT spawn the generator. Do NOT pick this spec as the active one. If it's the only spec, exit.
- `"draft"`, `"ready"`, `"in-progress"` → eligible. From the eligible specs, pick the most recent one (sort by `createdAt` descending).

If all specs are `completed`/`abandoned` and no sprint number was provided, tell the user all plans are complete. If the only remaining spec is `needs-clarification`, exit with the clarification message.

**If a sprint number was provided as an argument:**
- Find the contract for that sprint number: `.bober/contracts/sprint-<specId>-<N>.json`
- Verify it exists and its status is `proposed`, `in-progress`, or `needs-rework`

**If no sprint number was provided:**
- Find the first sprint contract with status `proposed` or `needs-rework`
- If all sprints are `completed`, tell the user all sprints are done
- If a sprint is `in-progress`, resume it

**Validate dependencies:**
- Check that all sprints listed in `dependsOn` have status `completed`
- If any dependency is not complete, tell the user which sprints must be completed first

Read the identified contract and the parent PlanSpec.

## Step 2: Contract Negotiation (if status is "proposed")

When a contract status is `proposed`, it has not yet been reviewed for executability. Run a brief negotiation phase:

1. **Review the success criteria** in the contract. For each criterion, assess:
   - Is the `verificationMethod` actually executable given the current project setup?
   - Is the criterion specific enough that pass/fail is unambiguous?
   - Can the Evaluator actually verify this criterion independently?

2. **Review the evaluator strategies** in `bober.config.json`. For each strategy:
   - Is the required tooling installed? (e.g., if `playwright` is a strategy, is Playwright installed?)
   - Are the configured commands valid? (e.g., does `commands.test` actually run?)

3. **Adjust if needed:**
   - If a criterion is too vague, make it more specific
   - If a verification method requires tooling that is not set up, either:
     - Add a setup step to the sprint
     - Change the verification method to something available
     - Mark the criterion as `required: false` if it cannot be verified
   - If the sprint scope is too large for the configured sprint size, flag this to the user

4. **Update the contract** status to `in-progress` and save it back to `.bober/contracts/`

5. **Append to `.bober/history.jsonl`:**
   ```json
   {"event":"sprint-started","contractId":"...","specId":"...","timestamp":"..."}
   ```

## Step 3: Build the Context Handoff

Build a ContextHandoff document for the Generator. This document is the ONLY context the Generator subagent receives — it must be self-contained.

**ContextHandoff structure:**
```json
{
  "handoffId": "handoff-<contractId>-gen-<iteration>",
  "type": "to-generator",
  "contractId": "<contract ID>",
  "specId": "<spec ID>",
  "timestamp": "<ISO-8601>",
  "iteration": 1,
  "context": {
    "projectOverview": "<Brief project description from PlanSpec>",
    "completedSprints": [
      {
        "contractId": "<ID>",
        "title": "<title>",
        "summary": "<what was built>"
      }
    ],
    "currentBranch": "<git branch name>",
    "relevantFiles": [
      "<key files the generator should read>"
    ]
  },
  "contract": { "<full SprintContract object>" },
  "config": {
    "commands": { "<commands section from bober.config.json>" },
    "generator": { "<generator section from bober.config.json>" }
  },
  "principles": "<full text of .bober/principles.md or null>",
  "evaluatorFeedback": null
}
```

Save the handoff to `.bober/handoffs/<handoffId>.json`.

**For retry iterations** (iteration > 1), include the evaluator's feedback:
```json
{
  "evaluatorFeedback": {
    "evalId": "<ID of the failed evaluation>",
    "failedCriteria": [
      {
        "criterionId": "sc-1-2",
        "description": "<what failed>",
        "feedback": "<evaluator's detailed feedback>",
        "file": "<file path if applicable>",
        "line": "<line number if applicable>"
      }
    ],
    "regressions": ["<any regressions found>"],
    "generatorFeedback": ["<structured feedback items>"]
  }
}
```

## Step 4: Spawn the Curator Subagent (once per sprint)

Check if `curator.enabled` is `true` in `bober.config.json` (default: true). If enabled, spawn a curator subagent ONCE before the first generator attempt to produce a Sprint Briefing.

**Skip the curator if:**
- `curator.enabled` is `false` in config
- A briefing already exists at `.bober/briefings/<contractId>-briefing.md` (from a previous run)

**Use the Agent tool to spawn the curator:**

```
Agent tool call:
  description: "Curate sprint <N>: <sprint title>"
  subagent_type: bober-curator
  mode: auto
  prompt: <the prompt below>
```

**Curator prompt:**

```
You are the Bober Curator subagent. You have been spawned by the orchestrator to produce a Sprint Briefing.

## Sprint Contract
Read from: .bober/contracts/<contractId>.json

## Project Overview
Plan: <spec title>
Description: <spec description>

## Completed Sprints
<list completed sprint titles and what they built, or "No prior sprints completed.">

## Project Root
<project root path>

## Instructions
1. Read the sprint contract at .bober/contracts/<contractId>.json
2. For each file in estimatedFiles: read it, extract relevant sections, trace imports
3. Find existing utilities the generator should reuse (search src/utils/, src/lib/, src/helpers/)
4. Find test files similar to what this sprint needs — extract patterns
5. Check .bober/principles.md, README.md, architecture docs
6. Identify files/tests that may be affected by the changes (grep for imports)
7. Determine implementation sequence based on dependencies
8. Save the Sprint Briefing to .bober/briefings/<contractId>-briefing.md

Your final response must contain ONLY a JSON object (no markdown fences):
{
  "contractId": "<contract ID>",
  "briefingPath": ".bober/briefings/<contractId>-briefing.md",
  "filesAnalyzed": ["<files you read>"],
  "patternsFound": <number>,
  "utilsIdentified": <number>,
  "summary": "<2-3 sentence summary>"
}
```

**After the curator subagent returns:**
1. Verify the briefing was saved: check `.bober/briefings/<contractId>-briefing.md` exists
2. Do NOT read the full briefing into orchestrator context — the generator reads it from disk

## Step 5: Spawn the Generator Subagent

**Before spawning:**
1. Ensure the correct git branch exists and is checked out:
   ```bash
   git checkout -b bober/<feature-slug> 2>/dev/null || git checkout bober/<feature-slug>
   ```
2. If this is a retry, the Generator should be on the same branch with the previous attempt's code still present.

**Use the Agent tool to spawn the generator:**

```
Agent tool call:
  description: "Sprint <N>: <sprint title>"
  subagent_type: bober-generator
  mode: auto
  prompt: <the full prompt below>
```

IMPORTANT: Use `mode: auto` or `mode: bypassPermissions` — the generator needs full write access to create/edit files, run bash commands, and commit.

**Generator prompt:**

IMPORTANT: Do NOT paste the full handoff JSON inline. The handoff has already been saved to disk. Reference the file path instead — this keeps the orchestrator's context lean.

```
You are the Bober Generator subagent. You have been spawned by the orchestrator to implement a sprint.

## Context Handoff
Read the full handoff from: .bober/handoffs/<handoffId>.json

## Sprint Briefing
Read the curated Sprint Briefing FIRST (if it exists): .bober/briefings/<contractId>-briefing.md
The briefing contains pre-analyzed code patterns, utilities to reuse, affected files, testing patterns, and implementation sequence. Start here before exploring the codebase.

## Instructions
1. Read the Sprint Briefing at .bober/briefings/<contractId>-briefing.md (if it exists)
2. Read the handoff at .bober/handoffs/<handoffId>.json
3. Read the SprintContract at .bober/contracts/<contractId>.json
4. Read the PlanSpec at .bober/specs/<specId>.json for broader context
5. Read bober.config.json for commands configuration
6. Read .bober/principles.md if it exists — adhere to all principles strictly
7. Read the files listed in the contract's estimatedFiles
8. Implement the sprint according to the contract's success criteria
9. Self-verify: run build, typecheck, lint, and test commands
10. Commit your changes (format: "bober(<sprint-N>): <description>")
11. Work on the feature branch, never on main/master

<IF iteration > 1>
## IMPORTANT — This is a RETRY (iteration <N>)
The previous attempt failed evaluation. Here is the evaluator's feedback:
<paste evaluator feedback JSON>

Focus on fixing the specific failures listed above.
</IF>

## Your Response
When done, respond with EXACTLY this JSON structure (no other text):
{
  "contractId": "<contract ID>",
  "status": "complete | partial | blocked",
  "criteriaResults": [
    {"criterionId": "sc-X-Y", "met": true/false, "evidence": "<evidence>"}
  ],
  "filesChanged": [
    {"path": "<path>", "action": "created | modified | deleted", "description": "<what>"}
  ],
  "testsAdded": ["<test files>"],
  "commits": ["<hash> - <message>"],
  "blockers": ["<issues>"],
  "notes": "<context for evaluator>"
}
```

**After the Generator subagent returns:**
1. Parse the generator's response to extract the completion report.
2. Verify commits were made: `git log --oneline -5`
3. Save the generator report to `.bober/handoffs/gen-report-<contractId>-<iteration>.json`
4. If the generator subagent crashed or returned an error, mark the sprint as `needs-rework` with note "Generator subagent failed".

## Step 6: Spawn the Evaluator Subagent

**Use the Agent tool to spawn the evaluator:**

```
Agent tool call:
  description: "Evaluate sprint <N>: <sprint title>"
  subagent_type: bober-evaluator
  mode: auto
  prompt: <the full prompt below>
```

NOTE: The evaluator needs `mode: auto` for bash access (running tests, builds). It has no write/edit tools by agent definition.

**Evaluator prompt:**

IMPORTANT: Do NOT paste the full contract or config JSON inline. Reference file paths instead — this keeps the orchestrator's context lean. Only include the generator's completion report and minimal context identifiers.

```
You are the Bober Evaluator subagent. You have been spawned by the orchestrator to evaluate a sprint.

## Sprint Contract
Read from: .bober/contracts/<contractId>.json

## Generator's Completion Report
<paste the generator's completion report JSON — this is small and needed for context>

## Context
- Contract ID: <contractId>
- Spec ID: <specId>
- Sprint: <N> of <total>
- Iteration: <N>
- Branch: <current branch>
- Changed files (per generator): <list of files>

## Instructions
1. Read the SprintContract at .bober/contracts/<contractId>.json
2. Read bober.config.json for configured eval strategies and commands
3. Read .bober/principles.md if it exists — check adherence
4. Run each configured evaluation strategy using the commands from config
5. Verify EVERY success criterion one by one
6. Check for regressions
7. Produce a structured EvalResult

IMPORTANT: You do NOT have Write or Edit tools. Output the EvalResult JSON in your response.

## Your Response
Respond with EXACTLY this JSON structure (no other text):
{
  "evalId": "eval-<contractId>-<iteration>",
  "contractId": "<contract ID>",
  "specId": "<spec ID>",
  "timestamp": "<ISO-8601>",
  "iteration": <N>,
  "overallResult": "pass | fail",
  "score": { "criteriaTotal": N, "criteriaPassed": N, "criteriaFailed": N, "criteriaSkipped": N, "requiredPassed": N, "requiredFailed": N, "requiredTotal": N },
  "strategyResults": [ {"strategy": "<type>", "required": true/false, "result": "pass|fail|skipped", "output": "<output>", "details": "<details>"} ],
  "criteriaResults": [ {"criterionId": "sc-X-Y", "description": "<desc>", "required": true/false, "result": "pass|fail|skipped", "evidence": "<evidence>", "feedback": "<if failed>"} ],
  "regressions": [],
  "generatorFeedback": [],
  "summary": "<2-3 sentence summary>"
}
```

**After the Evaluator subagent returns:**
1. Parse the evaluator's response to extract the EvalResult.
2. Save the EvalResult to `.bober/eval-results/eval-<contractId>-<iteration>.json` (the evaluator cannot write files).
3. Determine pass/fail from the `overallResult` field.

## Step 7: Process Evaluation Result

### If the sprint PASSES:

1. **Update the contract status** to `completed`:
   ```json
   { "status": "completed", "completedAt": "<ISO-8601>" }
   ```
   Save to `.bober/contracts/<contractId>.json`

2. **Update `.bober/progress.md`:**
   Change the sprint's status from `[in-progress]` to `[completed]`

3. **Append to `.bober/history.jsonl`:**
   ```json
   {"event":"sprint-completed","contractId":"...","specId":"...","iteration":N,"timestamp":"..."}
   ```

4. **Check if the plan is now fully complete.** Read the PlanSpec's `sprints` array to get the total count. Count how many of those contracts now have `status: "completed"`. If ALL sprints are completed (N/N):
   - Update the PlanSpec: set `status` to `"completed"` and `completedAt` to current ISO-8601 timestamp. Save to `.bober/specs/<specId>.json`. **The `status` field MUST remain in the first 10 lines of the JSON** so future runs can skip it with a partial read.
   - Update `.bober/progress.md` — change the plan's status line to `completed (N/N sprints)`.
   - Log event: `{"event":"plan-completed","specId":"...","sprintsCompleted":N,"timestamp":"..."}`

5. **Report success to the user:**
   ```
   === Sprint <N> PASSED on iteration <M> ===

   Completed: <sprint title>
   Key results:
   - <criterion 1>: PASS
   - <criterion 2>: PASS
   ...

   Next sprint: <next sprint title> (run /bober-sprint to continue)
   ```
   If all sprints are done, report `=== PLAN COMPLETE (N/N sprints) ===` instead of "Next sprint".

### If the sprint FAILS and retries remain:

Check `evaluator.maxIterations` from `bober.config.json` (default: 3). If the current iteration is less than `maxIterations`:

1. **Log the failure:**
   ```json
   {"event":"sprint-iteration-failed","contractId":"...","iteration":N,"failedCriteria":["sc-1-2"],"timestamp":"..."}
   ```

2. **Create a retry handoff** (go back to Step 3 with `iteration + 1` and include evaluator feedback)

3. **Report the retry to the user:**
   ```
   === Sprint <N> iteration <M> FAILED ===
   <X> of <Y> criteria not met.
   Retrying (iteration <M+1> of <maxIterations>)...

   Failed criteria:
   - <criterion>: <brief reason>
   ```

4. **Go to Step 4** (spawn a FRESH Generator subagent with feedback)

### If the sprint FAILS and no retries remain:

1. **Update the contract status** to `needs-rework`:
   ```json
   { "status": "needs-rework", "lastEvalId": "<eval ID>" }
   ```

2. **Update `.bober/progress.md`:**
   Change the sprint's status to `[needs-rework]`

3. **Append to `.bober/history.jsonl`:**
   ```json
   {"event":"sprint-failed","contractId":"...","specId":"...","totalIterations":N,"timestamp":"..."}
   ```

4. **Report failure to the user with full context:**
   ```
   === Sprint <N> FAILED after <maxIterations> iterations ===

   Contract: <contract title>
   Failed criteria:
   - <criterion>: <detailed failure description>

   Last evaluator feedback:
   <structured feedback>

   Recommended actions:
   - Review the failed criteria and evaluator feedback
   - Consider simplifying the sprint scope
   - Run /bober-sprint <N> to retry from scratch
   - Run /bober-plan to revise the plan
   ```

## Step 8: Context Reset

After a sprint completes (pass or fail), manage context:

Read `pipeline.contextReset` from config:
- `always`: Each subagent already gets a fresh context. This is the default behavior.
- `on-threshold`: Same as `always` with subagent architecture.
- `never`: Include richer context summaries in the handoff for the next sprint.

## Error Handling

- **Subagent crash/timeout:** If the Agent tool call fails, log the error. Do not let it crash the orchestration. Mark the sprint appropriately and report to the user.
- **Subagent returns malformed response:** Read files on disk as the source of truth. The subagent may have saved files correctly even if its text response was garbled.
- **Generator fails to produce any output:** Mark sprint as `needs-rework` with note "Generator produced no output"
- **Evaluator cannot run strategies:** Report which strategies failed to execute and why. If a required strategy cannot run, mark sprint as `needs-rework` with a configuration issue note.
- **Git conflicts:** Report the conflict to the user. Do not auto-resolve.
- **Build broken before sprint started:** Verify the build passes BEFORE spawning the Generator. If the build is already broken, report this and do not proceed.
- **Missing dependencies:** If `npm install` or equivalent has not been run, run it before starting.

## Next Steps

After completing this phase, suggest the following next steps to the user:
- `/bober-eval` — Evaluate the current sprint output independently
- `/bober-sprint` — Execute the next sprint in the plan
