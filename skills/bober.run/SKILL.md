---
name: bober.run
description: Full autonomous pipeline — plan a feature, execute all sprints, evaluate each one, and iterate until complete or stuck.
argument-hint: <task-description>
---

# bober.run — Full Pipeline Orchestrator

You are running the **bober.run** skill. This is the top-level orchestrator that runs the entire Generator-Evaluator pipeline from start to finish: planning, sprint execution, evaluation, and iteration. The user provides a task description and you deliver a working implementation.

## Autonomous Mode

This command is designed to run **fully autonomously** — do NOT stop to ask the user for confirmation between phases unless something is genuinely ambiguous or blocked. Specifically:

- **Do NOT ask** "should I continue to the next sprint?" — just continue.
- **Do NOT ask** "should I start building?" after planning — just start.
- **Do NOT ask** "should I rework?" after a failed evaluation — just rework (up to maxIterations).
- **Do NOT ask** for approval on file writes, commits, or evaluation runs — just do them.
- **DO stop** only if: you hit maxIterations on a sprint and cannot progress, or the task description is genuinely unclear and you cannot infer intent.

The user launched this command to walk away and come back to a finished product. Respect that intent.

## Overview

The pipeline follows this flow:

```
User Task Description
       |
       v
  [1. PLAN] -----> PlanSpec + Sprint Contracts
       |
       v
  [2. SPRINT LOOP]
       |
       +----> [2a. Generate] ---> Code changes
       |            |
       |            v
       |      [2b. Evaluate] ---> Pass/Fail
       |            |
       |       fail + retries left?
       |            |
       |       yes: feedback --> [2a. Generate]
       |       no:  escalate
       |
       |      pass: next sprint
       |
       v
  [3. COMPLETE] ---> All sprints done
```

## Step 1: Initialize and Plan

### 1a. Check Project State

Read `bober.config.json`. If it does not exist:
- Ask the user the minimal initialization questions: project name, mode (greenfield vs brownfield), and what they are building
- Determine the appropriate `mode` and `preset` (if any) from the user's description
- Create `bober.config.json` with appropriate defaults
- Create the `.bober/` directory structure

If `bober.config.json` exists, read the configuration.

### 1b. Check for Existing Plans

Read `.bober/specs/` and `.bober/progress.md`. If there is an existing plan with incomplete sprints:

- If the user provided a new task description that clearly differs from the existing plan → create a new plan (option B)
- If the user provided no task or a task that matches the existing plan → resume from the next incomplete sprint (option A)
- Log your decision but do NOT ask the user — autonomous mode means you decide and move forward

### 1c. Run the Planning Phase

If creating a new plan, execute the bober.plan workflow:

1. Gather codebase context (read key files, survey structure)
2. Ask 3-5 clarifying questions about the task
3. Wait for user responses
4. Generate the PlanSpec with sprint decomposition
5. Save everything to `.bober/`

**Configuration values that matter:**
- `planner.maxClarifications`: Max questions to ask
- `sprint.maxSprints`: Maximum number of sprints in the plan
- `sprint.sprintSize`: Size calibration for sprint decomposition

Report the plan summary to the user and proceed.

## Step 2: Sprint Execution Loop

Load the sprint contracts from `.bober/contracts/` in order. For each sprint with status `proposed` or `needs-rework`:

### 2a. Pre-Sprint Checks

1. **Verify dependencies:** All sprints in `dependsOn` must have status `completed`
2. **Verify build state:** The project must build before starting a new sprint
   ```bash
   # Run configured build/compile command (varies by stack)
   # e.g., npm run build, anchor build, forge build, cargo build
   ```
   If the build is broken BEFORE the sprint starts, stop and report this to the user. Do not start a sprint on a broken codebase.
3. **Verify git state:** Ensure we are on the correct feature branch
   ```bash
   git branch --show-current
   ```
4. **Check iteration budget:** Read `pipeline.maxIterations` from config. Track total iterations across all sprints. If the budget is exhausted, stop.

### 2b. Contract Negotiation

If the sprint status is `proposed`:
- Review success criteria for executability
- Verify evaluation strategies are available
- Adjust criteria if needed
- Update status to `in-progress`

### 2c. Generate

Create a ContextHandoff for the Generator:
- Include the contract, project context, config, and any evaluator feedback (for retries)
- Include summaries of completed sprints
- Include relevant file paths

Spawn the `bober-generator` subagent.

After generation:
- Read the Generator's completion report
- Verify commits were made
- Proceed to evaluation

### 2d. Evaluate

Create a ContextHandoff for the Evaluator:
- Include the contract, Generator's report, config

Spawn the `bober-evaluator` subagent.

After evaluation:
- Read the EvalResult
- Save it to `.bober/eval-results/`
- Determine pass/fail

### 2e. Process Result

**On PASS:**
1. Update contract status to `completed`
2. Update `.bober/progress.md`
3. Log to `.bober/history.jsonl`
4. Report milestone to user:
   ```
   Sprint <N>/<total> PASSED: <title>
   Progress: [=====>    ] <N>/<total> sprints complete
   Next: <next sprint title>
   ```
5. Move to next sprint

**On FAIL with retries remaining:**
1. Check if iteration count < `evaluator.maxIterations` (default: 3)
2. Feed evaluator feedback back to Generator (go to 2c)
3. Report retry:
   ```
   Sprint <N> iteration <M> failed. Retrying with evaluator feedback...
   Failed: <brief failure summary>
   ```

**On FAIL with no retries:**
1. Update contract status to `needs-rework`
2. Decide whether to continue or stop based on severity:
   - If the failure is in a non-blocking sprint (nothing depends on it), skip and continue
   - If the failure blocks subsequent sprints, stop the pipeline
3. Report to user with full context

### 2f. Context Reset

After each sprint completes (pass or fail), check `pipeline.contextReset`:
- `always`: Fresh context for the next sprint. The next sprint's Generator receives only its handoff document.
- `on-threshold`: Continue with current context unless it is getting large. If context exceeds a reasonable threshold (use your judgment), reset.
- `never`: Carry all context forward (not recommended for long pipelines).

### 2g. Iteration Budget

Track total Generator-Evaluator iterations across all sprints:
- Each Generator+Evaluator cycle counts as 1 iteration
- When total iterations reach `pipeline.maxIterations` (default: 20), stop the pipeline regardless of sprint status
- Report the budget status:
  ```
  Iteration budget: <used>/<max>
  ```

## Step 3: Completion

When all sprints are complete (or the pipeline stops):

### All Sprints Passed

```
## Pipeline Complete

All <N> sprints passed successfully.

### Results
1. [PASS] Sprint 1: <title>
2. [PASS] Sprint 2: <title>
...

### Statistics
- Total iterations: <N>
- Sprints: <N>/<N> passed
- Time: <start> to <end>

### What Was Built
<Brief summary of the complete feature>

### Next Steps
- Review the code on branch: bober/<feature-slug>
- Run the test suite: npm test
- Merge to main when ready: git merge bober/<feature-slug>
```

### Pipeline Stopped (failures or budget exhausted)

```
## Pipeline Stopped

Completed <M> of <N> sprints. Stopped because: <reason>

### Results
1. [PASS] Sprint 1: <title>
2. [PASS] Sprint 2: <title>
3. [FAIL] Sprint 3: <title> -- <failure reason>
4. [PENDING] Sprint 4: <title>

### Failed Sprint Details
Sprint 3: <title>
- Failed criteria: <list>
- Last evaluator feedback: <summary>
- Iterations used: <N>/<max>

### Recommended Actions
- Review evaluator feedback for Sprint 3
- Consider simplifying the sprint scope
- Run /bober.sprint 3 to retry Sprint 3 individually
- Run /bober.plan to revise the plan
```

## Human Escalation Protocol

Escalate to the user (pause and ask) when:

1. **Approval required:** If `pipeline.requireApproval` is `true` in config, pause before each sprint and show the contract summary. Wait for user approval before proceeding.

2. **Sprint failed after max iterations:** Report the full failure context and ask the user how to proceed:
   - A) Retry the sprint with revised instructions
   - B) Skip this sprint and continue with the next
   - C) Revise the plan
   - D) Stop the pipeline

3. **Ambiguous situation:** If the codebase state is unclear, the build is broken from external causes, or there is a conflict with existing code, escalate rather than guessing.

4. **Halfway checkpoint:** For plans with 5+ sprints, pause after completing half the sprints to report progress and ask if the user wants to continue, adjust, or stop.

## Progress Tracking

Throughout the pipeline, keep `.bober/progress.md` updated:

```markdown
# Bober Progress

Project: <name>
Mode: <mode>
Preset: <preset or "custom">
Initialized: <date>
Last updated: <timestamp>

---

## Plan: <title>
- Spec: <specId>
- Created: <date>
- Status: in-progress

### Sprint Breakdown
1. [completed] Sprint 1: <title> -- Passed on iteration 1
2. [completed] Sprint 2: <title> -- Passed on iteration 2
3. [in-progress] Sprint 3: <title> -- Iteration 1 in progress
4. [proposed] Sprint 4: <title>
5. [proposed] Sprint 5: <title>

### Pipeline Statistics
- Total iterations used: 4 / 20
- Sprints completed: 2 / 5
```

And keep `.bober/history.jsonl` updated with events:
- `pipeline-started`
- `sprint-started`
- `sprint-iteration-started`
- `sprint-iteration-completed` (with pass/fail)
- `sprint-completed`
- `sprint-failed`
- `pipeline-completed`
- `pipeline-stopped`
- `human-escalation`

## Error Recovery

- **Git conflicts:** Pause and report to user. Do not auto-resolve.
- **npm install failures:** Try once. If it fails, report to user.
- **Dev server won't start:** Needed for API checks and Playwright. Report as a configuration issue.
- **Out of context window:** If the conversation is getting extremely long, proactively reset context by summarizing progress and starting a fresh handoff.
- **Previous sprint broke something:** If a completed sprint's code is causing issues in a later sprint, note this but do not go back and modify completed sprints. Instead, have the current sprint fix the issue within its scope.
