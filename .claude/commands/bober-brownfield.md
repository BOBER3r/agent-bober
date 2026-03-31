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

### 1a. Research Phase (CRISPY Two-Phase Research)

Run the two-phase research process as the foundation for all subsequent analysis. The research agent explores the codebase systematically before you or the planner interpret what needs to change.

**Why research first in brownfield:** Brownfield codebases have patterns, constraints, and coupling that are easy to miss. The research agent's factual, opinion-free exploration surfaces these before any planning decisions are made.

Spawn a research subagent (Agent tool):

```
Agent tool call:
  description: "Research brownfield codebase for: <feature description>"
  prompt: <research prompt>
```

Build the research prompt:

```
You are the Bober Researcher subagent. You have been spawned to research an existing codebase.

## Feature Description (for question generation only — do NOT share with Phase 2)
<feature description>

## Project Root
<absolute path>

## Instructions
Run the two-phase research process focused on brownfield concerns:

Phase 1 — Generate 5–8 questions targeting:
  - What existing code paths will the new feature touch?
  - What patterns does this codebase enforce that must be followed?
  - Which files are high-coupling risk (imported widely)?
  - What test coverage exists in the affected areas?
  - What are the existing integration points and interfaces?
  - What database schema or state management patterns exist?
  - What build/deploy constraints exist?

Phase 2 — Explore codebase answering ONLY the questions (no feature knowledge).
  Document: architecture overview, existing patterns, key files, integration points,
  test coverage, risk areas.

Save the ResearchDoc to .bober/research/<researchId>.json

## Your Response
{
  "researchId": "<ID>",
  "questionsGenerated": N,
  "questionsAnswered": N,
  "filesExplored": N,
  "findingsSummary": "<2-3 sentence summary>"
}
```

After research completes:
1. Read `.bober/research/<researchId>.json` to verify the ResearchDoc was saved.
2. Use the research findings to guide Steps 1b–1d below (do not re-read files the research already covered).
3. Pass the research `findings` field to the planner in Step 4.
4. **Do NOT forward** the research doc to generator subagents — generators receive only their sprint contract and principles.

Log event:
```json
{"event":"brownfield-research-complete","researchId":"...","timestamp":"..."}
```

### 1b. Tech Stack Detection

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

### 1c. Architecture Mapping

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

### 1d. Pattern Extraction

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

### 1e. Risk Assessment

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

Run the planning workflow with these additional constraints. Pass the research findings (from Step 1a) to the planner as part of the prompt — the planner uses this to make informed sprint decomposition decisions based on factual codebase structure.

**Include in the planner prompt:**
```
## Research Findings
<paste the full `findings` field from the ResearchDoc saved at .bober/research/<researchId>.json>
```

**Note on context distillation:** The research findings go only to the planner. Generator subagents do NOT receive the research doc — they receive only their sprint contract, completed sprint summaries, and principles. This is intentional: by the time generators run, the research has already shaped the sprint decomposition.

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


---

<!-- Reference: codebase-analysis.md -->

# Codebase Analysis Methodology

This document describes how to perform a thorough analysis of an existing codebase before planning brownfield changes. A complete analysis prevents regressions, ensures pattern compliance, and correctly sizes sprint contracts.

## Analysis Phases

### Phase 1: Surface-Level Survey (5 minutes)

Get the big picture without reading any code.

**1. File structure survey:**
```
Use Glob with broad patterns to understand the layout:
  src/**/*
  app/**/*
  server/**/*
  lib/**/*
  tests/**/*
  e2e/**/*
```

Questions to answer:
- Is this a monorepo or single project?
- What is the top-level organization? (feature folders, layer folders, hybrid)
- How many source files are there? (rough scale: tens, hundreds, thousands)
- Where do tests live? (co-located, separate directory, both)

**2. Package/dependency analysis:**

Read `package.json` (or equivalent) and categorize dependencies:
- Framework (React, Vue, Angular, Express, Fastify, etc.)
- ORM/database (Prisma, Drizzle, TypeORM, Mongoose, etc.)
- State management (Redux, Zustand, MobX, Recoil, etc.)
- UI library (shadcn, Material UI, Chakra, Ant Design, etc.)
- Testing (vitest, jest, mocha, playwright, cypress, etc.)
- Build tools (vite, webpack, esbuild, turbopack, etc.)
- Utilities (lodash, date-fns, zod, etc.)

**3. Configuration file scan:**

Check for and read:
- `tsconfig.json` / `jsconfig.json` — Compiler settings, path aliases, strict mode
- `vite.config.ts` / `next.config.js` / `webpack.config.js` — Build configuration
- `eslint.config.js` / `.eslintrc.*` / `biome.json` — Linting rules
- `tailwind.config.ts` — CSS configuration
- `prisma/schema.prisma` / `drizzle.config.ts` — Database configuration
- `.env.example` — Environment variables (reveals integrations and services)
- `Dockerfile` / `docker-compose.yml` — Container configuration
- `.github/workflows/*.yml` — CI/CD pipeline

### Phase 2: Architecture Mapping (10 minutes)

Understand how the system is organized and how data flows.

**1. Entry points:**

Identify the application's entry points:
- Frontend: `main.tsx`, `App.tsx`, `pages/_app.tsx`, `app/layout.tsx`
- Backend: `server/index.ts`, `src/app.ts`, `main.py`
- CLI: `bin/`, `cli/`

Read each entry point to understand the boot sequence: what middleware is loaded, what routes are registered, what providers wrap the app.

**2. Routing map:**

Frontend routes:
```
Use Grep to find route definitions:
  Pattern: "path.*:.*/" or "Route.*path" or "<Route" (React Router)
  Pattern: "app/" directory structure (Next.js App Router)
  Pattern: "pages/" directory structure (Next.js Pages Router)
```

Backend routes:
```
Use Grep to find API route definitions:
  Pattern: "app\.(get|post|put|delete|patch)" (Express)
  Pattern: "router\.(get|post|put|delete|patch)" (Express Router)
  Pattern: "@(Get|Post|Put|Delete|Patch)" (NestJS decorators)
  Pattern: "@app\.(get|post|put|delete|patch)" (FastAPI)
```

Produce a route table:
```
Frontend Routes:
  /              -> pages/Home.tsx
  /login         -> pages/Login.tsx
  /dashboard     -> pages/Dashboard.tsx (protected)
  /settings      -> pages/Settings.tsx (protected)

Backend Routes:
  GET    /api/users        -> routes/users.ts:getUsers
  POST   /api/users        -> routes/users.ts:createUser
  GET    /api/users/:id    -> routes/users.ts:getUser
  PUT    /api/users/:id    -> routes/users.ts:updateUser
  DELETE /api/users/:id    -> routes/users.ts:deleteUser
  POST   /api/auth/login   -> routes/auth.ts:login
  POST   /api/auth/logout  -> routes/auth.ts:logout
```

**3. Database schema map:**

Read the ORM schema and produce an entity relationship summary:
```
Models:
  User:        id, email, passwordHash, name, createdAt, updatedAt
  Post:        id, title, content, authorId -> User, createdAt, updatedAt
  Comment:     id, content, postId -> Post, authorId -> User, createdAt

Relationships:
  User 1:N Post   (author)
  User 1:N Comment (author)
  Post 1:N Comment
```

**4. Middleware/interceptor chain:**

For backend apps, trace the middleware chain:
```
Request -> cors -> helmet -> bodyParser -> authMiddleware -> routeHandler -> errorHandler -> Response
```

For frontend apps, trace the provider chain:
```
<StrictMode>
  <QueryClientProvider>
    <AuthProvider>
      <ThemeProvider>
        <RouterProvider>
          <App />
```

### Phase 3: Pattern Extraction (10 minutes)

Read 3-5 representative files of each type to extract patterns.

**1. Component patterns (frontend):**

Read several components and note:
- Function declaration style: `function Component()` or `const Component = () =>`
- Props typing: `interface Props {}` or `type Props = {}` or inline
- State management: useState, useReducer, store hook
- Data fetching: useEffect + fetch, React Query, SWR, server components
- Styling: className strings, CSS modules, styled-components, Tailwind
- File structure: imports, types, component, exports (in what order?)

**2. Route handler patterns (backend):**

Read several route handlers and note:
- Handler style: direct function, controller class, handler + service pattern
- Request validation: Zod, Joi, class-validator, manual
- Response format: JSON shape, status codes, error format
- Error handling: try/catch, error middleware, either pattern
- Database access: direct ORM calls or through a service layer?

**3. Test patterns:**

Read several test files and note:
- Test structure: describe/it, test(), or BDD-style
- Assertion library: expect (vitest/jest), assert, chai
- Mocking approach: vi.mock, jest.mock, manual mocks
- Test data: factories, fixtures, inline objects
- Setup/teardown: beforeEach/afterEach patterns

**4. Import conventions:**

Note:
- Absolute imports (`@/lib/utils`) vs relative (`../../lib/utils`)
- Barrel imports (`from '@/components'`) vs direct (`from '@/components/Button'`)
- Type imports: `import type { X }` vs `import { X }`
- Import ordering: external first, then internal? Alphabetical?

### Phase 4: Health Assessment (5 minutes)

Assess the current health of the codebase.

**1. Test coverage:**
```bash
# Count test files
find src -name "*.test.*" | wc -l
find tests -name "*.test.*" 2>/dev/null | wc -l

# Count source files (to calculate ratio)
find src -name "*.ts" -not -name "*.test.*" -not -name "*.d.ts" | wc -l

# Run tests to get current status
npm test 2>&1 | tail -20
```

**2. Type safety:**
```bash
# Check for any existing type errors
npx tsc --noEmit 2>&1 | tail -20

# Check for `any` usage (indicates weak typing)
grep -r ": any" src/ --include="*.ts" --include="*.tsx" | wc -l
```

**3. Code quality indicators:**
```bash
# Check for TODO/FIXME/HACK comments
grep -r "TODO\|FIXME\|HACK\|XXX" src/ --include="*.ts" --include="*.tsx" | wc -l

# Check for console.log statements
grep -r "console\.log" src/ --include="*.ts" --include="*.tsx" | wc -l

# Check linting status
npm run lint 2>&1 | tail -10
```

**4. Git health:**
```bash
# Recent activity (who's working on what)
git log --oneline --since="2 weeks ago" | head -20

# Files with most recent changes (hot spots)
git log --name-only --since="1 month ago" --pretty=format: | sort | uniq -c | sort -rn | head -20

# Check for uncommitted changes
git status --porcelain
```

### Phase 5: Risk Map

Combine the analysis into a risk assessment:

**High-risk areas** (modify with extreme caution):
- Files imported by >10 other files (high coupling)
- Files with no test coverage
- Files with recent high churn (many recent commits)
- Shared utilities and middleware
- Database schema (migrations affect everything)
- Authentication/authorization code

**Medium-risk areas** (modify carefully with tests):
- Components used on multiple pages
- API route handlers with complex business logic
- Configuration files
- Shared types/interfaces

**Low-risk areas** (safe to modify):
- Isolated page components
- New files that don't modify existing code
- Test files
- Documentation

## Output Format

The codebase analysis should produce a structured summary that is saved to `.bober/codebase-analysis.json` (or included in the PlanSpec's `techNotes.existingPatterns`) and referenced by all sprint contracts:

```json
{
  "timestamp": "<ISO-8601>",
  "commit": "<git commit hash>",
  "techStack": {
    "language": "TypeScript 5.x",
    "frontend": "React 18, Vite, React Router v6",
    "backend": "Express.js",
    "database": "PostgreSQL via Prisma",
    "styling": "Tailwind CSS + shadcn/ui",
    "testing": "Vitest (unit), Playwright (E2E)",
    "cicd": "GitHub Actions"
  },
  "architecture": {
    "pattern": "feature-based with shared lib/",
    "frontendRoutes": 8,
    "backendEndpoints": 15,
    "dbModels": 5
  },
  "health": {
    "testFiles": 23,
    "sourceFiles": 67,
    "testCoverageRatio": 0.34,
    "typeErrors": 0,
    "lintErrors": 3,
    "todoComments": 12,
    "anyUsage": 4
  },
  "patterns": {
    "componentStyle": "Arrow function components with Props interface",
    "stateManagement": "Zustand for global state, useState for local",
    "dataFetching": "TanStack Query with custom hooks in src/hooks/",
    "apiCalls": "Fetch wrapper in src/lib/api.ts",
    "errorHandling": "Error boundaries + toast notifications",
    "testStyle": "describe/it blocks with @testing-library/react",
    "importStyle": "Absolute imports with @/ prefix, type imports separated"
  },
  "highRiskFiles": [
    "src/lib/api.ts (imported by 23 files)",
    "src/middleware/auth.ts (all protected routes depend on this)",
    "prisma/schema.prisma (database schema)"
  ]
}
```

## Tips for Effective Analysis

1. **Read the README first.** It often explains the architecture and setup process.
2. **Check CLAUDE.md or CONTRIBUTING.md.** These may have explicit instructions about code patterns.
3. **Look at recent PRs** (if accessible) to understand the team's expectations.
4. **Do not analyze every file.** Sample 3-5 representative files per category. If the first 3 components all use the same pattern, you can assume the rest do too.
5. **Pay attention to the `.gitignore`.** It tells you what's generated vs. authored.
6. **Check for a monorepo tool.** `turbo.json`, `nx.json`, `pnpm-workspace.yaml`, `lerna.json` indicate monorepo structure.
7. **Look for a design system.** Check `src/components/ui/` or similar. If a design system exists, all new UI must use it.
