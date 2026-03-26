---
name: bober.sprint
description: Execute the next pending sprint — negotiate contracts, run the Generator, evaluate output, and iterate until passing or exhausting retries.
argument-hint: "[sprint-number]"
---

# bober.sprint — Sprint Execution Skill

You are running the **bober.sprint** skill. Your job is to execute a single sprint from an existing plan through the full Generator-Evaluator loop: negotiate the contract, generate the implementation, evaluate the output, and iterate until the sprint passes or retries are exhausted.

## Prerequisites

Before starting, verify these exist:
- `bober.config.json` in the project root
- At least one PlanSpec in `.bober/specs/`
- At least one SprintContract in `.bober/contracts/`

If any are missing, tell the user to run `/bober:plan` first.

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

## Step 3: Create Context Handoff

Create a ContextHandoff document for the Generator. This document is the ONLY context the Generator receives -- it must be self-contained.

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

## Step 4: Spawn the Generator

Invoke the `bober-generator` subagent with the handoff document.

**Before spawning:**
1. Ensure the correct git branch exists and is checked out:
   ```bash
   git checkout -b bober/<feature-slug> 2>/dev/null || git checkout bober/<feature-slug>
   ```
2. If this is a retry, the Generator should be on the same branch with the previous attempt's code still present.

**Spawn the Generator:**
Use the `bober-generator` agent definition. Pass it the handoff file path.

**After the Generator completes:**
1. Read the Generator's completion report
2. Verify the Generator committed its changes (check `git log`)
3. Proceed to evaluation

## Step 5: Spawn the Evaluator

Create an Evaluator handoff document:

```json
{
  "handoffId": "handoff-<contractId>-eval-<iteration>",
  "type": "to-evaluator",
  "contractId": "<contract ID>",
  "specId": "<spec ID>",
  "timestamp": "<ISO-8601>",
  "iteration": 1,
  "context": {
    "generatorReport": { "<Generator's completion report>" },
    "changedFiles": ["<files the generator reports changing>"],
    "branch": "<current branch>"
  },
  "contract": { "<full SprintContract object>" },
  "config": {
    "commands": { "<commands section from bober.config.json>" },
    "evaluator": { "<evaluator section from bober.config.json>" }
  }
}
```

Save the handoff to `.bober/handoffs/<handoffId>.json`.

**Spawn the Evaluator:**
Use the `bober-evaluator` agent definition. Pass it the handoff file path.

**After the Evaluator completes:**
1. Read the EvalResult
2. Save the EvalResult to `.bober/eval-results/` if the evaluator could not (it lacks Write tools)
3. Determine pass/fail

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
   Sprint <N> PASSED on iteration <M>.

   Completed: <sprint title>
   Key results:
   - <criterion 1>: PASS
   - <criterion 2>: PASS
   ...

   Next sprint: <next sprint title> (run /bober.sprint to continue)
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
   Sprint <N> iteration <M> FAILED. <X> of <Y> criteria not met.
   Retrying (iteration <M+1> of <maxIterations>)...

   Failed criteria:
   - <criterion>: <brief reason>
   ```

4. **Go to Step 4** (spawn Generator again with feedback)

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
   Sprint <N> FAILED after <maxIterations> iterations.

   Contract: <contract title>
   Failed criteria:
   - <criterion>: <detailed failure description>

   Last evaluator feedback:
   <structured feedback>

   Recommended actions:
   - Review the failed criteria and evaluator feedback
   - Consider simplifying the sprint scope
   - Run /bober.sprint <N> to retry from scratch
   - Run /bober.plan to revise the plan
   ```

## Step 7: Context Reset

After a sprint completes (pass or fail), manage context:

Read `pipeline.contextReset` from config:
- `always`: Context is fully reset between sprints. The next sprint starts fresh with only the handoff document.
- `on-threshold`: Context resets only if the conversation is getting long. Not applicable in single-sprint skill execution.
- `never`: Context carries forward. Not recommended.

## Error Handling

- **Generator fails to produce any output:** Mark sprint as `needs-rework` with note "Generator produced no output"
- **Evaluator cannot run strategies:** Report which strategies failed to execute and why. If a required strategy cannot run, mark sprint as `needs-rework` with a configuration issue note.
- **Git conflicts:** Report the conflict to the user. Do not auto-resolve.
- **Build broken before sprint started:** Verify the build passes BEFORE starting the Generator. If the build is already broken, report this and do not proceed.
- **Missing dependencies:** If `npm install` or equivalent has not been run, run it before starting.
