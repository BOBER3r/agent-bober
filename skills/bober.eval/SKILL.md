---
name: bober.eval
description: Run an independent evaluation of the current sprint state against its contract, producing structured pass/fail feedback.
argument-hint: "[contract-id]"
---

# bober.eval — Standalone Evaluation Skill

You are running the **bober.eval** skill. Your job is to independently evaluate the current state of a sprint implementation against its contract and produce structured feedback. This skill can be run at any time, independently of the sprint execution loop.

## When to Use This Skill

- **During development:** To check your progress against criteria before running the full sprint loop
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

## Step 2: Load Configuration

Read `bober.config.json` and extract:
- `evaluator.strategies`: The configured evaluation strategies
- `evaluator.model`: The model to use (informational)
- `commands`: The project commands for build, test, lint, typecheck

## Step 3: Pre-Flight Checks

Before running evaluation strategies, verify the environment:

1. **Check if dependencies are installed:**
   ```bash
   # Check if node_modules exists (for Node.js projects)
   ls node_modules/.package-lock.json 2>/dev/null
   ```
   If dependencies are not installed, run the configured install command first.

2. **Check the current git branch:**
   ```bash
   git branch --show-current
   ```
   Note the branch for the evaluation report.

3. **Check for uncommitted changes:**
   ```bash
   git status --porcelain
   ```
   Note any uncommitted changes in the report. The evaluation should still proceed, but this is important context.

## Step 4: Execute Evaluation Strategies

Run each strategy configured in `evaluator.strategies` from the config. Execute them in this order for fastest feedback on failures:

### Priority 1: Build Verification
```bash
# Use commands.build from config
npm run build 2>&1
```
- Record the full output
- If the build fails, most other checks are unreliable -- still run them but note this

### Priority 2: Type Checking
```bash
# Use commands.typecheck from config
npx tsc --noEmit 2>&1
```
- Record every type error with file path and line number
- Count total errors

### Priority 3: Linting
```bash
# Use commands.lint from config
npm run lint 2>&1
```
- Record every lint error (ignore warnings unless they indicate real problems)
- Count total errors

### Priority 4: Unit Tests
```bash
# Use commands.test from config
npm test 2>&1
```
- Record which tests passed and which failed
- For failures, record the test name, expected vs actual output, and file location
- Check if any pre-existing tests broke (regression)

### Priority 5: E2E Tests (Playwright)
```bash
# Only run if configured and installed
npx playwright test 2>&1
```
- If Playwright is not installed, mark as `skipped` (not `failed`)
- Record which tests passed and failed
- Note if screenshots are available

### Priority 6: API Checks
- If the contract has API-related success criteria, start the dev server and test endpoints:
  ```bash
  # Start dev server in background
  # Test endpoints with curl
  curl -s -w "\n%{http_code}" http://localhost:<port>/api/<endpoint>
  ```
- Record response status codes and body shapes

### Priority 7: Custom Strategies
- For each strategy with `type: "custom"`, execute the command from the strategy's `config` field
- Record the output and exit code

**For each strategy, record:**
```json
{
  "strategy": "<type>",
  "required": true,
  "result": "pass | fail | skipped",
  "exitCode": 0,
  "output": "<relevant output>",
  "errorCount": 0,
  "details": "<explanation>"
}
```

## Step 5: Verify Success Criteria

Go through EVERY success criterion in the contract, one by one.

For each criterion:

1. **Read the criterion and its verification method**
2. **Gather evidence:**
   - For `build`/`typecheck`/`lint`/`unit-test`/`playwright`: Use the strategy results from Step 4
   - For `manual`: Read the relevant source files. Trace the code path. Verify the described behavior exists in the code.
   - For `api-check`: Test the specific endpoint described in the criterion
   - For `custom`: Run the custom command
3. **Make a judgment: pass, fail, or skipped**
4. **Record evidence supporting the judgment**

**Judgment rules:**
- `pass`: You have concrete evidence the criterion is met
- `fail`: You have concrete evidence the criterion is NOT met, or you cannot find evidence that it IS met
- `skipped`: The verification method cannot be executed (e.g., Playwright not installed)

**A criterion marked `required: true` MUST have a definitive pass or fail. It cannot be skipped.**

## Step 6: Check for Regressions

Beyond the contract criteria, check for broader regressions:

1. **Pre-existing test count:** If you can determine how many tests existed before the sprint, compare to the current count. Fewer passing tests = regression.
2. **Build stability:** Does the full project build, not just the new code?
3. **Unexpected file changes:** Use `git diff --stat` to see all changed files. Flag any files changed that are NOT in the contract's `estimatedFiles`.

## Step 7: Produce the EvalResult

Generate the structured evaluation result following the schema in `skills/bober.eval/references/feedback-format.md`.

**Overall result determination:**
- **PASS:** ALL required strategies passed AND ALL required criteria passed AND no critical regressions
- **FAIL:** ANY required strategy failed OR ANY required criterion failed OR critical regression found

Save the EvalResult to `.bober/eval-results/eval-<contractId>-<iteration>.json`.

If this is the first evaluation for this contract, iteration = 1. Otherwise, read the contract's `iterationHistory` to determine the next iteration number.

Append to `.bober/history.jsonl`:
```json
{"event":"eval-completed","contractId":"...","evalId":"...","result":"pass|fail","timestamp":"..."}
```

## Step 8: Output Report

Present results in a clear, human-readable format:

```
## Evaluation Report: <sprint title>

**Contract:** <contractId>
**Iteration:** <N>
**Result:** PASS / FAIL
**Branch:** <current branch>
**Uncommitted changes:** yes/no

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
- Evidence: `curl -X POST http://localhost:3000/api/auth/register -H "Content-Type: application/json" -d '{"email":"test@test.com","password":"password123"}' returned 500 with error "relation users does not exist"`
- Expected: 201 with `{ id, email }` response body
- Root cause: The database migration has not been run. The users table does not exist.

### Regressions (if any)
- <description>

### Summary
<2-3 sentence summary>
```

## Anti-Leniency Reminders

- If a criterion says "the form displays an error message" and you can only verify the validation logic exists in code but cannot confirm the message renders, mark it as **fail** with a note about what you could not verify.
- If the build has warnings that look like potential runtime errors (e.g., unused imports of things that should be used), flag them even if the build technically passes.
- If a test passes but the test itself is trivial (e.g., `expect(true).toBe(true)`), note this in the report. A passing trivial test does not satisfy a functional criterion.
- If the Generator's self-report says something works but you find evidence it does not, trust your evidence over the report.
