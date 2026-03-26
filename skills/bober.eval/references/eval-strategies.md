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

## Default Strategy Sets by Project Type

### react-fullstack
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
