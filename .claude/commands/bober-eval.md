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

4. **If `overallResult` is `"pass"`:**
   - Update the contract: set `status` to `"completed"`, `completedAt` to current ISO-8601 timestamp. Save to `.bober/contracts/<contractId>.json`.
   - Update `.bober/progress.md` — change the sprint line to `[completed]`.
   - **Check if the plan is now fully complete.** Read the PlanSpec's `sprints` array to get the total count. Count how many of those contracts now have `status: "completed"`. If ALL sprints are completed (N/N):
     - Update the PlanSpec: set `status` to `"completed"` and `completedAt` to current ISO-8601 timestamp. Save to `.bober/specs/<specId>.json`. **The `status` field MUST remain in the first 10 lines of the JSON** so future runs can skip it with a partial read.
     - Update `.bober/progress.md` — change the plan's status line to `completed (N/N sprints)`.
     - Log event: `{"event":"plan-completed","specId":"...","sprintsCompleted":N,"timestamp":"..."}`

5. **If `overallResult` is `"fail"`:**
   - Update the contract: set `status` to `"needs-rework"`, `lastEvalId` to the eval ID. Save to `.bober/contracts/<contractId>.json`.
   - Update `.bober/progress.md` — change the sprint line to `[needs-rework]`.

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


---

<!-- Reference: eval-strategies.md -->

# Evaluation Strategies Reference

This document describes all built-in evaluation strategies available in the Bober evaluator system. Strategies are configured in `bober.config.json` under `evaluator.strategies`.

## Strategy Configuration Format

Each strategy in the config array follows this structure:
```json
{
  "type": "typecheck | lint | unit-test | playwright | api-check | build | custom",
  "required": true,
  "plugin": "string (optional, for custom strategies)",
  "config": {
    "key": "value (optional, strategy-specific configuration)"
  }
}
```

The `required` field determines whether a strategy failure blocks the sprint from passing:
- `required: true` — Sprint FAILS if this strategy fails
- `required: false` — Strategy result is recorded but does not block the sprint

---

## typecheck

**Purpose:** Verify that all TypeScript code compiles without type errors.

**Default command:** `npx tsc --noEmit`
**Config override:** `commands.typecheck` in `bober.config.json`

**What it checks:**
- All `.ts` and `.tsx` files compile under the project's `tsconfig.json`
- No type errors (TS2xxx codes)
- No missing imports or unresolved modules
- Strict mode violations (if `strict: true` in tsconfig)

**Pass criteria:** Zero type errors in output. Warnings do not cause failure.

**Common failures:**
- Missing type imports: `Cannot find module './types' or its corresponding type declarations`
- Type mismatch: `Type 'string' is not assignable to type 'number'`
- Missing properties: `Property 'name' is missing in type '{}' but required in type 'User'`
- Implicit any: `Parameter 'x' implicitly has an 'any' type` (when `noImplicitAny` is enabled)

**Configuration:**
```json
{
  "type": "typecheck",
  "required": true,
  "config": {
    "tsconfig": "tsconfig.json",
    "strict": true
  }
}
```

**Notes:**
- Runs against the full project, not just files changed in the sprint
- Catches regressions in existing code caused by the sprint's changes

---

## lint

**Purpose:** Verify code follows the project's linting rules.

**Default command:** `npm run lint`
**Config override:** `commands.lint` in `bober.config.json`

**Supported linters:**
- **ESLint** (most common): Detected by `eslint.config.js`, `.eslintrc.*`, or `eslint` in devDependencies
- **Biome**: Detected by `biome.json` or `@biomejs/biome` in devDependencies
- **Both:** Some projects use both. Run whatever `commands.lint` specifies.

**What it checks:**
- Code style violations
- Potential bugs (unused variables, unreachable code, implicit type coercion)
- Import order and organization
- Framework-specific rules (React hooks rules, etc.)

**Pass criteria:** Zero errors. Warnings are acceptable (but should be noted in the report).

**Common failures:**
- Unused variables: `'x' is defined but never used`
- Missing dependencies in hook deps: `React Hook useEffect has a missing dependency`
- Prefer const: `'x' is never reassigned. Use 'const' instead`
- Import order violations

**Configuration:**
```json
{
  "type": "lint",
  "required": true,
  "config": {
    "fix": false,
    "maxWarnings": -1
  }
}
```

**Notes:**
- `fix: false` means the evaluator reports violations without auto-fixing them. The Generator must fix them.
- `maxWarnings: -1` means unlimited warnings are tolerated. Set a number to fail on too many warnings.

---

## unit-test

**Purpose:** Verify that unit tests pass, including both new tests and pre-existing tests.

**Default command:** `npm test`
**Config override:** `commands.test` in `bober.config.json`

**Supported frameworks:**
- **Vitest**: Detected by `vitest` in devDependencies or `vitest.config.*`
- **Jest**: Detected by `jest` in devDependencies or `jest.config.*`
- **Mocha**: Detected by `mocha` in devDependencies
- **Custom:** Whatever `commands.test` runs

**What it checks:**
- All tests pass (both new and existing)
- No test regressions (existing tests that previously passed should still pass)
- Test coverage (if configured)

**Pass criteria:** All tests pass with exit code 0.

**Common failures:**
- Assertion failures: `Expected 200 but received 500`
- Missing test dependencies: Module not found errors in test files
- Timeout: Tests that hang due to unresolved promises or server connections
- Snapshot mismatches (for snapshot testing)

**Configuration:**
```json
{
  "type": "unit-test",
  "required": true,
  "config": {
    "coverage": false,
    "coverageThreshold": 80,
    "testMatch": "**/*.test.{ts,tsx}",
    "timeout": 30000
  }
}
```

**Notes:**
- If `coverage: true`, the evaluator checks that coverage meets `coverageThreshold`
- The evaluator should count total tests, passed, failed, and skipped
- If no tests exist yet and this is the first sprint, the strategy passes vacuously but the evaluator should note "no tests found" in the report

---

## playwright

**Purpose:** Run end-to-end browser tests that verify the application works from a user's perspective.

**Default command:** `npx playwright test`
**Config override:** Strategy-specific config

**Prerequisites:**
- Playwright must be installed: `npx playwright install` (installs browsers)
- A dev server must be running or `webServer` must be configured in `playwright.config.ts`
- Test files must exist (usually in `tests/` or `e2e/` directory)

**What it checks:**
- Full user flows work end-to-end (login, navigation, form submission, etc.)
- UI renders correctly in a real browser
- Client-server interaction works
- No console errors or unhandled exceptions

**Pass criteria:** All Playwright tests pass.

**Common failures:**
- Element not found: `Timeout waiting for selector '#login-form'`
- Navigation error: `Page navigated to unexpected URL`
- Network error: API calls returning errors
- Visual regression: Screenshot comparison failures

**Configuration:**
```json
{
  "type": "playwright",
  "required": false,
  "config": {
    "project": "chromium",
    "retries": 1,
    "timeout": 60000,
    "webServer": {
      "command": "npm run dev",
      "port": 3000,
      "reuseExistingServer": true,
      "timeout": 30000
    }
  }
}
```

**Notes:**
- Default `required: false` because Playwright setup is non-trivial. Mark as `required: true` only when E2E tests are critical and known to be configured.
- If Playwright is not installed, the evaluator marks this as `skipped` (not failed), even if `required: true`. It should flag this as a configuration issue.
- The evaluator should try to start the dev server before running tests if `webServer` is configured.

---

## api-check

**Purpose:** Verify that HTTP API endpoints respond correctly.

**Default command:** Uses `curl` or the configured HTTP client
**Config override:** Strategy-specific config

**What it checks:**
- Endpoints exist and respond
- Correct HTTP status codes
- Response body structure matches expectations
- Error responses are properly formatted
- Content-Type headers are correct

**Pass criteria:** All configured endpoint checks return expected status codes and response shapes.

**Configuration:**
```json
{
  "type": "api-check",
  "required": true,
  "config": {
    "baseUrl": "http://localhost:3000",
    "startServer": true,
    "serverCommand": "npm run dev",
    "serverReadyPattern": "listening on port",
    "serverTimeout": 15000,
    "endpoints": [
      {
        "method": "POST",
        "path": "/api/auth/register",
        "body": { "email": "test@example.com", "password": "testpassword123" },
        "expectedStatus": 201,
        "expectedBodyKeys": ["id", "email"]
      },
      {
        "method": "POST",
        "path": "/api/auth/register",
        "body": { "email": "test@example.com", "password": "testpassword123" },
        "expectedStatus": 400,
        "description": "Duplicate registration should fail"
      }
    ]
  }
}
```

**Notes:**
- The evaluator typically derives endpoint checks from the sprint contract's success criteria rather than relying solely on pre-configured endpoints
- If `startServer: true`, the evaluator starts the dev server, waits for `serverReadyPattern` in stdout, runs checks, then stops the server
- API checks are often used in combination with `manual` verification for the same criterion

---

## build

**Purpose:** Verify that the project compiles/builds without errors.

**Default command:** `npm run build`
**Config override:** `commands.build` in `bober.config.json`

**What it checks:**
- The full build pipeline completes successfully
- No compilation errors
- All assets are generated correctly
- Build output exists in the expected directory

**Pass criteria:** Build command exits with code 0 and no errors in output.

**Common failures:**
- Import errors: Missing modules or circular dependencies
- Syntax errors in new code
- Environment variable issues
- Asset processing failures (CSS, images)
- Bundle size exceeded (if configured)

**Configuration:**
```json
{
  "type": "build",
  "required": true,
  "config": {
    "outputDir": "dist",
    "verifyOutput": true
  }
}
```

**Notes:**
- This should almost always be `required: true`. If the project does not build, nothing else matters.
- `verifyOutput: true` means the evaluator checks that the output directory exists and is non-empty after the build
- This is different from `typecheck` -- `build` runs the full build pipeline (bundling, optimization, etc.), while `typecheck` only verifies types

---

## custom

**Purpose:** Run a user-defined evaluation command for project-specific checks.

**Default command:** None (must be configured)
**Config override:** Strategy-specific config

**What it checks:** Whatever the custom command checks. The evaluator interprets results based on exit code and output.

**Pass criteria:** Command exits with code 0.

**Configuration:**
```json
{
  "type": "custom",
  "required": false,
  "plugin": "check-bundle-size",
  "config": {
    "command": "node scripts/check-bundle-size.js",
    "maxSizeKb": 500,
    "parseOutput": "json",
    "passCondition": "output.passed === true"
  }
}
```

**How to write a custom evaluator plugin:**

A custom evaluator is a script or command that:
1. Runs a specific check
2. Outputs results to stdout (optionally as JSON for structured parsing)
3. Exits with code 0 for pass, non-zero for fail

**Example custom evaluator script:**
```javascript
// scripts/check-bundle-size.js
import { statSync } from 'fs';
import { glob } from 'glob';

const MAX_SIZE_KB = 500;
const files = glob.sync('dist/**/*.js');
const totalSize = files.reduce((sum, f) => sum + statSync(f).size, 0);
const sizeKb = totalSize / 1024;

if (sizeKb > MAX_SIZE_KB) {
  console.error(`Bundle size ${sizeKb.toFixed(1)}KB exceeds limit of ${MAX_SIZE_KB}KB`);
  process.exit(1);
} else {
  console.log(`Bundle size OK: ${sizeKb.toFixed(1)}KB / ${MAX_SIZE_KB}KB`);
  process.exit(0);
}
```

**Plugin naming:** The `plugin` field is a human-readable name for the check. It appears in evaluation reports.

**Advanced custom evaluators:**
- Output JSON with `parseOutput: "json"` for structured results
- Use `passCondition` to evaluate a JavaScript expression against the parsed output
- Chain multiple commands with `&&` in the command string

---

## Strategy Execution Order

The evaluator runs strategies in this recommended order for fastest feedback:

1. **build** — If the build fails, everything else is likely unreliable
2. **typecheck** — Type errors indicate fundamental code issues
3. **lint** — Style and potential bug detection
4. **unit-test** — Functional correctness of individual units
5. **api-check** — API endpoint verification (requires running server)
6. **playwright** — Full E2E testing (most expensive, most comprehensive)
7. **custom** — Project-specific checks

The evaluator should continue running all strategies even if an early one fails, so the Generator gets complete feedback in one pass.

---

## Default Strategy Sets by Preset

### nextjs / react-vite
```json
[
  { "type": "typecheck", "required": true },
  { "type": "lint", "required": true },
  { "type": "build", "required": true },
  { "type": "playwright", "required": false }
]
```

### brownfield
```json
[
  { "type": "typecheck", "required": true },
  { "type": "lint", "required": true },
  { "type": "unit-test", "required": true }
]
```

### generic
```json
[
  { "type": "build", "required": true },
  { "type": "lint", "required": false }
]
```


---

<!-- Reference: feedback-format.md -->

# Evaluation Feedback Format

This document defines how evaluation feedback should be structured for maximum effectiveness when consumed by the Generator agent during retry iterations.

## Principles

1. **Actionable over descriptive.** Every piece of feedback should give the Generator enough information to fix the issue without guessing.
2. **Precise location.** Always include file paths and line numbers when applicable. "There's a bug in the auth code" is useless. "src/routes/auth.ts:42 — the bcrypt.hash call is missing the salt rounds argument" is actionable.
3. **One issue per feedback item.** Do not combine multiple issues into one feedback entry. The Generator processes each item independently.
4. **Prioritized.** Critical issues (build failures, type errors) come before minor issues (style, optimization).

## EvalResult JSON Schema

```json
{
  "evalId": "string (required, format: eval-<contractId>-<iteration>)",
  "contractId": "string (required)",
  "specId": "string (required)",
  "timestamp": "string (required, ISO-8601)",
  "iteration": "number (required, 1-indexed)",
  "overallResult": "string (required, one of: pass, fail)",

  "score": {
    "criteriaTotal": "number",
    "criteriaPassed": "number",
    "criteriaFailed": "number",
    "criteriaSkipped": "number",
    "requiredPassed": "number",
    "requiredFailed": "number",
    "requiredTotal": "number"
  },

  "strategyResults": [
    {
      "strategy": "string (strategy type)",
      "required": "boolean",
      "result": "string (pass | fail | skipped)",
      "exitCode": "number (optional)",
      "output": "string (relevant output excerpt, not full dump)",
      "errorCount": "number (optional)",
      "details": "string (explanation, especially for failures)"
    }
  ],

  "criteriaResults": [
    {
      "criterionId": "string (from contract)",
      "description": "string (from contract)",
      "required": "boolean",
      "result": "string (pass | fail | skipped)",
      "evidence": "string (specific evidence supporting judgment)",
      "feedback": "string (if failed: what went wrong and what should happen instead)"
    }
  ],

  "regressions": [
    {
      "description": "string (what regressed)",
      "evidence": "string (how detected)",
      "severity": "string (critical | major | minor)",
      "affectedFiles": ["string (file paths)"]
    }
  ],

  "generatorFeedback": [
    {
      "priority": "string (critical | high | medium | low)",
      "category": "string (bug | missing-feature | regression | quality | performance)",
      "file": "string (file path, if applicable)",
      "line": "number (line number, if applicable)",
      "description": "string (precise description of the issue)",
      "expected": "string (what should happen instead)",
      "reproduction": "string (steps to reproduce, if applicable)"
    }
  ],

  "summary": "string (2-3 sentence summary)"
}
```

## Priority Levels

| Priority | Meaning | Examples |
|----------|---------|---------|
| `critical` | Sprint cannot pass until this is fixed. Typically build/type errors or complete feature absence. | Build fails, type error in new code, required feature completely missing |
| `high` | Required criterion failed. Must be fixed for the sprint to pass. | API returns wrong status code, form validation not working, test assertion failing |
| `medium` | Non-required criterion failed or quality issue. Should be fixed but won't block the sprint. | Lint errors, missing error handling for edge case, incomplete accessibility |
| `low` | Minor quality issue or suggestion. Can be deferred. | Code style inconsistency, opportunity for optimization, extra console.log |

## Category Definitions

| Category | Description |
|----------|-------------|
| `bug` | Code that does not behave as specified. Incorrect logic, wrong return values, unhandled errors. |
| `missing-feature` | A required behavior described in the contract that was not implemented at all. |
| `regression` | Something that worked before the sprint that no longer works. |
| `quality` | Code quality issue: poor naming, missing error handling, no input validation, accessibility gaps. |
| `performance` | Performance issue: unnecessary re-renders, N+1 queries, missing pagination, large bundle size. |

## Writing Effective Feedback

### For Build/Type Errors

```json
{
  "priority": "critical",
  "category": "bug",
  "file": "src/routes/auth.ts",
  "line": 42,
  "description": "TypeScript error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'. The bcrypt.hash function expects a number for salt rounds but receives a string from process.env.SALT_ROUNDS.",
  "expected": "Parse the environment variable to a number: parseInt(process.env.SALT_ROUNDS || '10', 10)",
  "reproduction": "Run: npx tsc --noEmit"
}
```

### For Functional Failures

```json
{
  "priority": "high",
  "category": "bug",
  "file": "src/routes/auth.ts",
  "line": 55,
  "description": "POST /api/auth/register returns 500 with error 'relation \"users\" does not exist' instead of creating a user. The Prisma migration has not been run, so the users table does not exist in the database.",
  "expected": "The endpoint should return 201 with { id, email } after successfully creating a user record. Ensure the Prisma migration is included in the sprint setup or generatorNotes.",
  "reproduction": "1. Start the dev server: npm run dev\n2. Run: curl -X POST http://localhost:3000/api/auth/register -H 'Content-Type: application/json' -d '{\"email\":\"test@test.com\",\"password\":\"password123\"}'\n3. Observe: 500 response with database error"
}
```

### For Missing Features

```json
{
  "priority": "high",
  "category": "missing-feature",
  "file": "src/pages/Register.tsx",
  "line": null,
  "description": "The registration form exists but does not implement client-side password length validation. Contract criterion sc-1-7 requires that submitting a password shorter than 8 characters shows an error message before the form is submitted to the server.",
  "expected": "When the user types a password shorter than 8 characters and attempts to submit (or on blur), the form should display 'Password must be at least 8 characters' below the password input without making an API call.",
  "reproduction": "1. Navigate to /register\n2. Enter 'test@test.com' as email\n3. Enter '123' as password\n4. Click Submit\n5. Observe: form submits to server instead of showing client-side error"
}
```

### For Regressions

```json
{
  "priority": "critical",
  "category": "regression",
  "file": "src/components/Navbar.tsx",
  "line": 23,
  "description": "The Navbar component import was changed from 'react-router-dom' Link to 'next/link' but the project uses React Router, not Next.js. This causes a build failure in an existing component that was working before this sprint.",
  "expected": "The Navbar should continue using Link from 'react-router-dom' as it did before this sprint's changes.",
  "reproduction": "Run: npm run build -- the error appears at src/components/Navbar.tsx:23"
}
```

## Evidence Standards

Evidence must be concrete and reproducible. Here is what counts as evidence for different verification methods:

| Method | Good Evidence | Bad Evidence |
|--------|--------------|-------------|
| `build` | "Build command exited with code 1. Error: Module not found: src/utils/auth.ts" | "Build seems broken" |
| `typecheck` | "TS2304: Cannot find name 'UserType' at src/routes/auth.ts:15:22" | "There are type errors" |
| `lint` | "ESLint: 'password' is defined but never used (no-unused-vars) at src/routes/auth.ts:30" | "Lint has warnings" |
| `unit-test` | "Test 'should hash password' failed: Expected bcrypt hash (starting with $2b$) but received plain text 'password123'" | "Tests failed" |
| `manual` | "Reading src/pages/Register.tsx: The component renders two input fields (email, password) but the contract requires three (email, password, confirm-password). No input with name='confirmPassword' or similar exists." | "The form looks incomplete" |
| `api-check` | "curl -s -o /dev/null -w '%{http_code}' -X POST localhost:3000/api/auth/register returned 404. The route is not defined in src/routes/index.ts." | "API doesn't work" |

## Summary Writing

The summary should be 2-3 sentences that:
1. State the overall result (pass/fail) and score
2. Highlight the most critical issue (if failed)
3. Indicate what the Generator should focus on for the retry (if failed)

**Good summary:**
"Sprint 1 FAILED: 5 of 7 required criteria passed. The two critical failures are: (1) the database migration was not run, causing all API endpoints to return 500 errors, and (2) the registration form is missing the confirm-password field. The Generator should focus on adding the Prisma migration step and the missing form field."

**Bad summary:**
"Some things passed and some things failed. There are a few issues to fix."
