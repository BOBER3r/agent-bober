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
