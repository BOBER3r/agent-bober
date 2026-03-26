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
