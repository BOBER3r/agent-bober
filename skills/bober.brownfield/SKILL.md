---
name: bober.brownfield
description: Safely add features to an existing codebase — deep analysis first, conservative sprints, regression-focused evaluation.
argument-hint: <feature-description>
handoffs:
  - label: "Plan Feature"
    command: /bober-plan
    prompt: "Plan a feature for this existing codebase"
---

# bober.brownfield — Existing Codebase Workflow

You are running the **bober.brownfield** skill. This is a specialized workflow for adding features to existing, established codebases. It prioritizes safety: deep analysis before any changes, conservative sprint sizing, mandatory regression testing, and rollback strategies.

## When to Use This Skill

Use `bober.brownfield` instead of `bober.run` when:
- The codebase is established with existing features, tests, and users
- You need to modify existing code, not just add new files
- Regression risk is a primary concern
- The codebase has patterns and conventions that must be followed exactly
- There is an existing test suite that must continue passing

## Key Differences from Standard Pipeline

| Aspect | Standard (`bober.run`) | Brownfield (`bober.brownfield`) |
|--------|----------------------|-------------------------------|
| Sprint size | Medium (1-3 hours) | Small (30-60 minutes) |
| Approval | Optional | Required by default |
| Regression testing | Basic | Comprehensive |
| Codebase analysis | Brief | Deep (full architecture map) |
| Rollback strategy | None | Per-sprint rollback plan |
| Test requirements | Write new tests | Write new tests AND verify existing tests |
| Pattern following | Suggested | Mandatory (strict adherence) |

## Step 1: Deep Codebase Analysis

Before planning anything, perform a thorough analysis of the existing codebase. This is the most important step in brownfield work -- skip it and you will break things.

### 1a. Tech Stack Detection

Read and analyze:
- `package.json` (or equivalent: `requirements.txt`, `Cargo.toml`, `go.mod`)
- All config files: `tsconfig.json`, `vite.config.ts`, `next.config.js`, `webpack.config.js`, `.babelrc`, etc.
- CI/CD configuration: `.github/workflows/`, `Jenkinsfile`, `.gitlab-ci.yml`
- Docker configuration: `Dockerfile`, `docker-compose.yml`
- Environment files: `.env.example`, `.env.local.example`

Produce a tech stack summary:
```
Language: TypeScript 5.x
Frontend: React 18, Vite, React Router v6
Backend: Express.js
Database: PostgreSQL via Prisma
Styling: Tailwind CSS + shadcn/ui
Testing: Vitest (unit), Playwright (E2E)
CI/CD: GitHub Actions
Deployment: Vercel (frontend), Railway (backend)
```

### 1b. Architecture Mapping

Use Glob and Grep to map the architecture. Reference `skills/bober.brownfield/references/codebase-analysis.md` for the full methodology.

**Directory structure analysis:**
- Use Glob to survey: `src/**/*`, `app/**/*`, `server/**/*`, `lib/**/*`
- Identify the organizational pattern: feature-based, layer-based, or hybrid
- Map the key directories and their purposes

**Route/endpoint mapping:**
- Use Grep to find all route definitions
- List every API endpoint with its HTTP method and handler location
- List every frontend route with its component

**Database schema mapping:**
- Read the ORM schema file (Prisma schema, Drizzle schema, etc.)
- List all models/tables and their relationships
- Note any recent migrations

**Component inventory (for React/frontend):**
- List all page-level components
- List shared/reusable components
- Identify the state management pattern
- Map data flow (how do components get data?)

**Test coverage mapping:**
- Count total test files and test cases
- Identify which modules have tests and which do not
- Note the test patterns used (unit, integration, E2E)
- Run the test suite and record the baseline results:
  ```bash
  npm test 2>&1 | tail -20
  ```

### 1c. Pattern Extraction

Identify the coding patterns used throughout the codebase. The Generator MUST follow these exactly.

**Patterns to extract:**
- **File naming:** kebab-case, camelCase, PascalCase? What convention for components, hooks, utils?
- **Export style:** Default exports or named exports? Barrel files (index.ts)?
- **Component pattern:** Function components with arrow functions or function declarations? Props destructured in params or separate?
- **State management:** How is state managed? Context, Zustand, Redux, TanStack Query?
- **API calls:** fetch, axios, custom wrapper? Where do API calls live (in components, hooks, services)?
- **Error handling:** How are errors handled? Try/catch, error boundaries, toast notifications?
- **Styling approach:** Tailwind classes inline, CSS modules, styled-components? Is there a design system?
- **Test pattern:** Arrange-Act-Assert? What test utilities are used? How are mocks set up?

Document these patterns explicitly in the Generator notes for each sprint contract.

### 1d. Risk Assessment

Identify areas of risk:
- **High-coupling areas:** Files imported by many other files -- changing these is high risk
- **No-test areas:** Code without tests -- changes here cannot be regression-tested
- **Recently changed areas:** Files with recent git activity might be in flux
- **Complex areas:** Files with high cyclomatic complexity

```bash
# Find the most imported files (high coupling)
grep -r "from './" src/ --include="*.ts" --include="*.tsx" | sed "s/.*from '//;s/'.*//" | sort | uniq -c | sort -rn | head -20

# Find files without corresponding test files
find src -name "*.ts" -not -name "*.test.ts" -not -name "*.d.ts" | while read f; do
  test_file="${f%.ts}.test.ts"
  [ ! -f "$test_file" ] && echo "NO TEST: $f"
done

# Find recently modified files
git log --name-only --since="2 weeks ago" --pretty=format: | sort | uniq -c | sort -rn | head -20
```

## Step 2: Initialize Configuration

Create `bober.config.json` with brownfield-specific defaults:

```json
{
  "project": {
    "name": "<detected from package.json>",
    "mode": "brownfield",
    "description": "<inferred from README or package.json>"
  },
  "planner": {
    "maxClarifications": 5,
    "model": "opus",
    "contextFiles": ["<detected key files>"]
  },
  "generator": {
    "model": "sonnet",
    "maxTurnsPerSprint": 50,
    "autoCommit": true,
    "branchPattern": "bober/{feature-name}"
  },
  "evaluator": {
    "model": "sonnet",
    "strategies": [
      { "type": "typecheck", "required": true },
      { "type": "lint", "required": true },
      { "type": "unit-test", "required": true },
      { "type": "build", "required": true }
    ],
    "maxIterations": 3
  },
  "sprint": {
    "maxSprints": 10,
    "requireContracts": true,
    "sprintSize": "small"
  },
  "pipeline": {
    "maxIterations": 20,
    "requireApproval": true,
    "contextReset": "always"
  },
  "commands": {
    "install": "<detected>",
    "build": "<detected>",
    "test": "<detected>",
    "lint": "<detected>",
    "typecheck": "<detected>",
    "dev": "<detected>"
  }
}
```

**Key brownfield defaults:**
- `sprint.sprintSize: "small"` — Smaller sprints mean less risk per change
- `pipeline.requireApproval: true` — Human reviews each sprint before proceeding
- `unit-test` strategy is `required: true` — Existing tests must keep passing

## Step 3: Establish Baselines

Before any changes, record baselines that the evaluator will check against:

1. **Test baseline:**
   ```bash
   npm test 2>&1 > .bober/baseline-test-output.txt
   ```
   Count total tests, passed, failed, skipped.

2. **Type check baseline:**
   ```bash
   npx tsc --noEmit 2>&1 > .bober/baseline-typecheck-output.txt
   ```
   Record number of existing type errors (if any).

3. **Lint baseline:**
   ```bash
   npm run lint 2>&1 > .bober/baseline-lint-output.txt
   ```
   Record number of existing lint errors/warnings.

4. **Build baseline:**
   ```bash
   npm run build 2>&1 > .bober/baseline-build-output.txt
   ```
   Verify the build passes.

5. **Save baseline summary to `.bober/baseline.json`:**
   ```json
   {
     "timestamp": "<ISO-8601>",
     "commit": "<current git commit hash>",
     "tests": {
       "total": 47,
       "passed": 45,
       "failed": 2,
       "skipped": 0
     },
     "typeErrors": 0,
     "lintErrors": 3,
     "lintWarnings": 12,
     "buildPasses": true
   }
   ```

The evaluator will compare post-sprint results against these baselines to detect regressions.

## Step 4: Plan with Brownfield Constraints

Run the planning workflow with these additional constraints:

### Brownfield-Specific Clarifying Questions

Add these to the standard clarifying questions:

```
**Q: Modification Scope**
A) Only add new files -- do not modify existing code
B) Modify existing files minimally (add new routes, extend schemas)
C) Refactor existing code to accommodate the new feature
D) Full integration requiring significant changes to existing code

> Based on the codebase analysis, I recommend [X] because [reason].

**Q: Regression Tolerance**
A) Zero tolerance -- all existing tests must pass, no new warnings
B) Moderate -- existing tests must pass, minor warnings acceptable
C) Flexible -- focus on the new feature working correctly

**Q: Rollback Requirements**
A) Each sprint should be independently revertable (atomic changes)
B) The full feature should be revertable as a unit
C) No specific rollback requirements
```

### Brownfield Sprint Decomposition Rules

1. **Smaller sprints.** Default to `small` size (30-60 minutes, 1-3 files). Larger sprints in brownfield codebases have exponentially higher regression risk.

2. **Interface-first sprints.** When adding a new feature that touches existing code, the first sprint should define the interfaces (types, API contracts, database schema changes) without changing existing behavior. This is the one exception to the "no setup-only sprints" rule.

3. **One existing file per sprint.** If multiple existing files need modification, split into separate sprints. Each sprint should modify at most one critical existing file.

4. **Test-first sprints.** For complex changes, consider a sprint that writes tests for the EXPECTED new behavior before implementing it. This gives the evaluator a concrete check.

5. **Rollback plan per sprint.** Each contract must include a `rollbackPlan` field:
   ```json
   {
     "rollbackPlan": "Revert commits on branch bober/feature. No database migration to reverse. No configuration changes to undo."
   }
   ```

### Brownfield-Specific Success Criteria

Every brownfield sprint MUST include these baseline criteria:

```json
[
  {
    "criterionId": "sc-N-baseline-build",
    "description": "The project builds without any new errors compared to baseline.",
    "verificationMethod": "build",
    "required": true
  },
  {
    "criterionId": "sc-N-baseline-types",
    "description": "TypeScript compilation has no new type errors compared to baseline.",
    "verificationMethod": "typecheck",
    "required": true
  },
  {
    "criterionId": "sc-N-baseline-tests",
    "description": "All pre-existing tests that passed at baseline still pass.",
    "verificationMethod": "unit-test",
    "required": true
  }
]
```

These are IN ADDITION to the sprint-specific criteria.

### Generator Notes Enhancement

Every brownfield contract's `generatorNotes` must include:
1. Specific files to read before making changes (the "pattern files")
2. Explicit naming conventions to follow
3. Import patterns used in the codebase
4. Warning about files NOT to modify
5. The exact git diff of any existing file modifications expected

## Step 5: Execute with Caution

Run the sprint loop with brownfield-specific enhancements:

### Pre-Sprint Verification

Before EVERY sprint:
1. Verify the baseline still holds (tests pass, build works)
2. If baseline is broken, STOP and report to the user -- do not start a sprint on a broken codebase
3. Create a git checkpoint:
   ```bash
   git stash  # if there are uncommitted changes
   git tag bober-checkpoint-sprint-<N>
   ```

### Approval Gate

After each sprint passes evaluation, BEFORE moving to the next sprint:

```
Sprint <N> PASSED evaluation.

### Changes Made:
<file list with brief descriptions>

### Test Results:
- Existing tests: <X>/<Y> still passing (baseline: <Y>/<Y>)
- New tests added: <Z>

### Review Request:
Please review the changes and confirm:
A) Approve -- continue to next sprint
B) Review code first -- I'll wait
C) Rollback -- revert this sprint's changes
D) Stop -- halt the pipeline
```

Wait for user confirmation before proceeding.

### Evaluator Enhancement

The brownfield evaluator additionally checks:
1. **Baseline comparison:** Compare test count, type errors, lint errors against `.bober/baseline.json`. Any regression is a failure.
2. **Changed file audit:** Every file modified must be justified by the contract's `estimatedFiles`. Unexpected modifications are flagged as warnings.
3. **Pattern compliance:** Spot-check that new code follows the patterns documented in the generator notes.
4. **Import impact:** Check if any changes affect widely-imported modules. Flag as high-risk if so.

## Step 6: Post-Pipeline Verification

After all sprints complete:

1. **Full regression suite:**
   ```bash
   npm test
   npm run build
   npx tsc --noEmit
   npm run lint
   ```

2. **Baseline comparison:**
   Compare every metric against `.bober/baseline.json`. Report any regressions.

3. **Git diff review:**
   ```bash
   git diff main...HEAD --stat
   ```
   Show the user the complete set of changes.

4. **Report:**
   ```
   ## Brownfield Integration Complete

   ### Baseline Comparison
   | Metric | Before | After | Status |
   |--------|--------|-------|--------|
   | Tests passing | 45/47 | 52/54 | OK (+7 new) |
   | Type errors | 0 | 0 | OK |
   | Lint errors | 3 | 3 | OK (no new) |
   | Build | pass | pass | OK |

   ### Changes Summary
   - Files created: <N>
   - Files modified: <M>
   - Total lines added: <A>
   - Total lines removed: <R>

   ### Modified Existing Files
   <list with brief description of changes to each>

   ### Rollback Instructions
   To revert all changes:
   git checkout main
   git branch -D bober/<feature-slug>

   To revert individual sprints:
   git revert <commit-hash>  # Sprint N
   ```

## Next Steps

After completing this phase, suggest the following next steps to the user:
- `/bober-plan` — Plan a feature for this existing codebase

## Error Handling

- **Baseline broken before start:** Do NOT proceed. Tell the user the codebase has pre-existing failures and they should fix them first.
- **Regression detected during sprint:** Immediately fail the sprint. The evaluator should clearly identify which existing behavior broke.
- **Pattern violation by Generator:** Fail the sprint with specific feedback about which pattern was violated and what the correct pattern is. Include a code example from the existing codebase.
- **Merge conflicts:** If the feature branch has conflicts with main, report to the user. Never auto-resolve in brownfield.
- **Database migration conflicts:** If a schema change conflicts with existing migrations, report the conflict. The user may need to resolve this manually.
