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

**If a sprint number was provided as an argument:**
- Load the most recent PlanSpec from `.bober/specs/` (sort by `createdAt` descending)
- Find the contract for that sprint number: `.bober/contracts/sprint-<specId>-<N>.json`
- Verify it exists and its status is `proposed`, `in-progress`, or `needs-rework`

**If no sprint number was provided:**
- Load the most recent PlanSpec
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

## Step 4: Spawn the Generator Subagent

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
  prompt: <the full prompt below>
```

**Generator prompt:**

```
You are the Bober Generator subagent. You have been spawned by the orchestrator to implement a sprint.

## Context Handoff
<paste the FULL handoff JSON>

## Instructions
1. Read the SprintContract at .bober/contracts/<contractId>.json
2. Read the PlanSpec at .bober/specs/<specId>.json for broader context
3. Read bober.config.json for commands configuration
4. Read .bober/principles.md if it exists — adhere to all principles strictly
5. Read the files listed in the contract's estimatedFiles
6. Implement the sprint according to the contract's success criteria
7. Self-verify: run build, typecheck, lint, and test commands
8. Commit your changes (format: "bober(<sprint-N>): <description>")
9. Work on the feature branch, never on main/master

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

## Step 5: Spawn the Evaluator Subagent

**Use the Agent tool to spawn the evaluator:**

```
Agent tool call:
  description: "Evaluate sprint <N>: <sprint title>"
  prompt: <the full prompt below>
```

**Evaluator prompt:**

```
You are the Bober Evaluator subagent. You have been spawned by the orchestrator to evaluate a sprint.

## Sprint Contract
<paste the full SprintContract JSON>

## Generator's Completion Report
<paste the generator's completion report JSON>

## Project Configuration
<paste relevant sections: commands, evaluator config>

## Project Principles
<paste full text of .bober/principles.md or "No principles file found.">

## Context
- Contract ID: <contractId>
- Spec ID: <specId>
- Sprint: <N> of <total>
- Iteration: <N>
- Branch: <current branch>

## Instructions
1. Read the SprintContract at .bober/contracts/<contractId>.json
2. Read bober.config.json for configured eval strategies and commands
3. Run each configured evaluation strategy using the commands from config
4. Verify EVERY success criterion one by one
5. Check for regressions
6. Check adherence to project principles
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

## Step 6: Process Evaluation Result

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

4. **Report success to the user:**
   ```
   === Sprint <N> PASSED on iteration <M> ===

   Completed: <sprint title>
   Key results:
   - <criterion 1>: PASS
   - <criterion 2>: PASS
   ...

   Next sprint: <next sprint title> (run /bober-sprint to continue)
   ```

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

## Step 7: Context Reset

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
