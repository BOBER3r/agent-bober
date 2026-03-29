---
name: bober.eval
description: Spawn an evaluator subagent to independently assess the current sprint state against its contract, producing structured pass/fail feedback.
argument-hint: "[contract-id]"
handoffs:
  - label: "Rework Sprint"
    command: /bober-sprint
    prompt: "Rework the failed sprint with evaluator feedback"
  - label: "Next Sprint"
    command: /bober-sprint
    prompt: "Move to the next sprint"
---

# bober.eval — Standalone Evaluation Orchestrator

You are the **orchestrator** for a standalone evaluation run. You do NOT evaluate the code yourself. You spawn the evaluator as a subagent using the **Agent tool**, then process and save its results.

The evaluator subagent runs in its own isolated context window. It receives ONLY the information you explicitly pass in its prompt.

## When to Use This Skill

- **During development:** To check progress against criteria before running the full sprint loop
- **After manual changes:** When you have fixed something the Generator produced and want to re-evaluate
- **For debugging:** To understand exactly what is passing and failing in a sprint
- **As a standalone QA check:** To evaluate any codebase state against a sprint contract

## Step 1: Identify the Target Contract

**If a contract ID was provided as an argument:**
- Load the contract from `.bober/contracts/<contractId>.json`
- Verify it exists

**If no contract ID was provided:**
- Load the most recent PlanSpec from `.bober/specs/`
- Find the most recent sprint contract with status `in-progress` or `needs-rework`
- If none are in-progress, find the first `proposed` contract
- If all are `completed`, tell the user there is nothing to evaluate

Read the contract and its parent PlanSpec.

## Step 2: Gather Context

Read `bober.config.json` and extract:
- `evaluator.strategies`: The configured evaluation strategies
- `evaluator.model`: The model to use (informational)
- `commands`: The project commands for build, test, lint, typecheck

Read `.bober/principles.md` if it exists.

Check the current git branch:
```bash
git branch --show-current
```

Check for uncommitted changes:
```bash
git status --porcelain
```

Determine the iteration number: if prior eval results exist for this contract in `.bober/eval-results/`, use the next iteration number. Otherwise, use 1.

## Step 3: Spawn the Evaluator Subagent

Use the **Agent tool** to spawn an evaluator subagent.

```
Agent tool call:
  description: "Evaluate: <sprint title>"
  subagent_type: bober-evaluator
  mode: auto
  prompt: <the full prompt below>
```

IMPORTANT: Use `mode: auto` — the evaluator needs bash access to run tests, builds, and verification commands.

**Build the evaluator prompt with ALL of these sections:**

```
You are the Bober Evaluator subagent. You have been spawned to independently evaluate a sprint.

## Sprint Contract
<paste the full SprintContract JSON from .bober/contracts/<contractId>.json>

## Project Configuration
Commands:
<paste the commands section from bober.config.json>

Evaluator config:
<paste the evaluator section from bober.config.json>

## Project Principles
<paste full text of .bober/principles.md or "No principles file found.">

## Context
- Contract ID: <contractId>
- Spec ID: <specId>
- Iteration: <N>
- Branch: <current git branch>
- Uncommitted changes: <yes/no, with list if yes>

## Generator's Completion Report (if available)
<paste the most recent generator report from .bober/handoffs/gen-report-<contractId>-*.json, or "No generator report available — evaluate based on current codebase state.">

## Instructions
1. Read the SprintContract at .bober/contracts/<contractId>.json
2. Read bober.config.json for configured eval strategies and commands
3. Run each configured evaluation strategy:
   - Build/compile verification (commands.build)
   - Type checking (commands.typecheck)
   - Linting (commands.lint)
   - Unit tests (commands.test)
   - Playwright E2E (if configured)
   - API checks (if configured)
   - Custom strategies (if configured)
4. Verify EVERY success criterion in the contract one by one
5. Check for regressions (pre-existing tests, build stability, unexpected file changes)
6. Check adherence to project principles
7. Produce a structured EvalResult

IMPORTANT: You do NOT have Write or Edit tools. Output the EvalResult JSON in your response, and the orchestrator will save it to disk.

## Your Response
Respond with EXACTLY this JSON structure (no other text):
{
  "evalId": "eval-<contractId>-<iteration>",
  "contractId": "<contract ID>",
  "specId": "<spec ID>",
  "timestamp": "<ISO-8601>",
  "iteration": <N>,
  "overallResult": "pass | fail",
  "score": {
    "criteriaTotal": <N>,
    "criteriaPassed": <N>,
    "criteriaFailed": <N>,
    "criteriaSkipped": <N>,
    "requiredPassed": <N>,
    "requiredFailed": <N>,
    "requiredTotal": <N>
  },
  "strategyResults": [
    {
      "strategy": "<type>",
      "required": true/false,
      "result": "pass | fail | skipped",
      "output": "<relevant output excerpt>",
      "details": "<explanation if failed>"
    }
  ],
  "criteriaResults": [
    {
      "criterionId": "sc-X-Y",
      "description": "<criterion description>",
      "required": true/false,
      "result": "pass | fail | skipped",
      "evidence": "<specific evidence>",
      "feedback": "<failure details if failed>"
    }
  ],
  "regressions": [
    {
      "description": "<what regressed>",
      "evidence": "<how detected>",
      "severity": "critical | major | minor"
    }
  ],
  "generatorFeedback": [
    {
      "priority": "critical | high | medium | low",
      "category": "bug | missing-feature | regression | quality | performance",
      "file": "<file path>",
      "line": "<line number>",
      "description": "<precise description>",
      "expected": "<what should happen>",
      "reproduction": "<steps to reproduce>"
    }
  ],
  "summary": "<2-3 sentence summary>"
}
```

## Step 4: Process the Evaluator's Response

**After the evaluator subagent returns:**

1. Parse the evaluator's response to extract the EvalResult JSON.
2. Save the EvalResult to `.bober/eval-results/eval-<contractId>-<iteration>.json` (the evaluator cannot write files itself).
3. Append to `.bober/history.jsonl`:
   ```json
   {"event":"eval-completed","contractId":"...","evalId":"...","result":"pass|fail","timestamp":"..."}
   ```

If the subagent crashed or returned a malformed response, report the error clearly and suggest the user retry.

## Step 5: Output Report

Present results in a clear, human-readable format:

```
=== Evaluation Report: <sprint title> ===

Contract: <contractId>
Iteration: <N>
Result: PASS / FAIL
Branch: <current branch>
Uncommitted changes: yes/no

### Strategy Results
| Strategy | Required | Result |
|----------|----------|--------|
| build    | yes      | PASS   |
| typecheck| yes      | PASS   |
| lint     | yes      | FAIL (3 errors) |
| unit-test| yes      | PASS (12/12 tests) |

### Success Criteria
| ID | Description | Required | Result |
|----|-------------|----------|--------|
| sc-1-1 | Project builds successfully | yes | PASS |
| sc-1-2 | Registration form exists at /register | yes | PASS |
| sc-1-3 | API returns 201 on valid registration | yes | FAIL |
...

### Failures (if any)

**sc-1-3: API returns 201 on valid registration**
- What failed: POST /api/auth/register returns 500 instead of 201
- Where: src/routes/auth.ts:42
- Evidence: <command output>
- Expected: 201 with { id, email } response body

### Regressions (if any)
- <description>

### Summary
<2-3 sentence summary from the evaluator>
```

## Next Steps

After completing this phase, suggest the following next steps to the user:
- `/bober-sprint` — Rework the failed sprint with evaluator feedback, or move to the next sprint
- `/bober-sprint` — Execute the next sprint if evaluation passed

## Error Handling

- **Subagent crash/timeout:** If the Agent tool call fails, report the error. Do not attempt to evaluate inline — the whole point is subagent isolation.
- **Subagent returns malformed response:** Try to extract any useful information from the response text. Report what you can and suggest retrying.
- **Missing contract:** Tell the user to run `/bober-plan` first.
- **Build broken:** The evaluator will detect and report this. You just relay the results.
