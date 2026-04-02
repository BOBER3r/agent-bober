---
name: bober.react
description: React-based web application workflow — scaffold, plan, and build React apps with Vite or Next.js, optional backend, and database. This is one of several specialized workflows; use it specifically for React-based web applications.
argument-hint: <app-description>
handoffs:
  - label: "Plan Feature"
    command: /bober-plan
    prompt: "Plan the feature for this React project"
---

# bober.react — React Web Application Workflow

You are running the **bober.react** skill. This is a specialized workflow for building React-based web applications. It combines project scaffolding, planning, and execution optimized for the React ecosystem. For other project types (smart contracts, APIs, CLI tools, etc.), use the appropriate specialized skill or the generic `bober.run` pipeline.

## When to Use This Skill

Use `bober.react` when:
- Building a new React-based web application from scratch (greenfield)
- Adding a major feature to an existing React application
- The project involves: React frontend, optionally with an API backend and/or database

## Stack Assumptions

This skill is optimized for:
- **Frontend:** React 18+ with Vite (or Next.js), TypeScript
- **Backend:** Node.js with Express/Fastify/Hono, OR Python with FastAPI/Flask
- **Database:** SQLite (development) / PostgreSQL (production), with Prisma/Drizzle ORM
- **Styling:** Tailwind CSS (preferred), CSS Modules, or styled-components
- **Testing:** Vitest (unit), Playwright (E2E)
- **State Management:** React built-in (useState/useContext) for simple apps, Zustand/TanStack Query for complex apps

If the user's stack differs, adapt accordingly. These are defaults, not requirements.

## Step 1: Project Assessment

### Greenfield (New Project)

If there is no `package.json` or the project directory is empty:

1. Ask the user to describe their application
2. Ask clarifying questions specific to React apps:

```
**Q1: Frontend Framework**
A) Vite + React (recommended for SPAs and most apps)
B) Next.js (if you need SSR, static generation, or file-based routing)
C) Remix (if you want full-stack React with nested routing)

**Q2: Backend**
A) Express.js (Node.js, most common, largest ecosystem)
B) Fastify (Node.js, faster, schema-based validation)
C) Hono (lightweight, edge-ready)
D) FastAPI (Python, if you prefer Python backend)
E) No separate backend (use Next.js API routes or similar)

**Q3: Database**
A) SQLite with Prisma (simple, zero setup, great for prototyping)
B) PostgreSQL with Prisma (production-ready, recommended for real apps)
C) PostgreSQL with Drizzle (lighter ORM, SQL-like API)
D) No database (frontend only or external API)

**Q4: UI Approach**
A) Tailwind CSS + shadcn/ui (modern, utility-first, great component library)
B) Tailwind CSS only (utility-first, no component library)
C) CSS Modules (scoped styles, no utility classes)
D) I have a specific design system in mind (please describe)

**Q5: Authentication**
A) Email + password (built-in, using bcrypt + sessions)
B) OAuth (Google, GitHub, etc.) via a library like next-auth or lucia
C) No authentication needed for now
D) I'll specify my auth requirements
```

3. After answers, scaffold the project using the reference structure documented in `skills/bober.react/references/react-scaffold.md`

### Brownfield (Existing React Project)

If `package.json` exists with React:

1. Analyze the existing stack:
   - Read `package.json` for dependencies
   - Check for routing: `react-router-dom`, `next`, file-based routing
   - Check for state management: `zustand`, `redux`, `@tanstack/react-query`, `recoil`
   - Check for styling: `tailwindcss`, `styled-components`, `@emotion`, CSS Modules
   - Check for ORM/database: `prisma`, `drizzle-orm`, `mongoose`, `knex`
   - Check for testing: `vitest`, `jest`, `playwright`, `cypress`
   - Check for UI libraries: `@radix-ui`, `@shadcn`, `@mui`, `@chakra-ui`

2. Read key configuration files:
   - `vite.config.ts` or `next.config.js`
   - `tailwind.config.ts`
   - `prisma/schema.prisma` or `drizzle/schema.ts`
   - `playwright.config.ts`

3. Survey the project structure to understand conventions

4. Skip scaffolding -- proceed directly to planning

## Step 2: Initialize Configuration

Create or update `bober.config.json` with React-optimized defaults:

```json
{
  "project": {
    "name": "<project-name>",
    "mode": "greenfield",
    "preset": "react-vite",
    "description": "<user's app description>"
  },
  "planner": {
    "maxClarifications": 5,
    "model": "opus",
    "contextFiles": [
      "package.json",
      "tsconfig.json",
      "vite.config.ts",
      "prisma/schema.prisma",
      "src/App.tsx"
    ]
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
      { "type": "build", "required": true },
      { "type": "typecheck", "required": true },
      { "type": "lint", "required": true },
      { "type": "unit-test", "required": true },
      { "type": "playwright", "required": false }
    ],
    "maxIterations": 3
  },
  "sprint": {
    "maxSprints": 10,
    "requireContracts": true,
    "sprintSize": "medium"
  },
  "pipeline": {
    "maxIterations": 20,
    "requireApproval": false,
    "contextReset": "always"
  },
  "commands": {
    "install": "npm install",
    "build": "npm run build",
    "test": "npx vitest run",
    "lint": "npm run lint",
    "typecheck": "npx tsc --noEmit",
    "dev": "npm run dev"
  }
}
```

Adjust commands based on what actually exists in `package.json` scripts. If using Next.js, set `"preset": "nextjs"` instead of `"react-vite"` and adjust context files and commands accordingly (e.g., `next.config.js` instead of `vite.config.ts`).

## Step 3: Scaffold (Greenfield Only)

For new projects, create the initial project structure. Reference `skills/bober.react/references/react-scaffold.md` for the full scaffold specification.

**Scaffolding steps:**

1. **Initialize the project:**
   ```bash
   npm create vite@latest . -- --template react-ts
   ```
   Or if using Next.js:
   ```bash
   npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir
   ```

2. **Install core dependencies based on user choices:**
   - ORM: `prisma` + `@prisma/client` or `drizzle-orm` + `drizzle-kit`
   - Styling: `tailwindcss` + `postcss` + `autoprefixer` (if Tailwind)
   - UI components: `@shadcn/ui` dependencies if chosen
   - Auth: `bcrypt` + `express-session` or `lucia` or `next-auth`
   - Backend: `express` + `cors` + `helmet` or `fastify`

3. **Create the project structure:**
   - See the full scaffold reference for directory layout
   - Create placeholder files for the core architecture

4. **Configure TypeScript, ESLint, and Tailwind**

5. **Set up the database:**
   ```bash
   npx prisma init --datasource-provider sqlite
   ```
   Or equivalent for the chosen ORM

6. **Set up testing:**
   ```bash
   npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom
   npm install -D playwright @playwright/test
   npx playwright install chromium
   ```

7. **Create initial git commit:**
   ```bash
   git init
   git add -A
   git commit -m "chore: initial scaffold from bober.react"
   ```

8. **Verify the scaffold builds:**
   ```bash
   npm run build
   ```

## Step 4: Plan the Feature

Run the full planning workflow (same as `bober.plan`) with React-specific enhancements:

### React-Specific Planning Guidance

When decomposing into sprints, follow these React-specific patterns:

**Sprint ordering for a typical React feature:**
1. **Data layer first:** Database schema, API endpoints, data validation
2. **Core UI components:** The main components that render data
3. **Interactivity:** Forms, mutations, optimistic updates
4. **Navigation and routing:** New routes, navigation links, breadcrumbs
5. **Polish:** Loading states, error boundaries, empty states, responsive design

**React-specific success criteria to include:**
- "The component renders without React console errors or warnings"
- "The page is accessible: all interactive elements have ARIA labels, forms have proper labels, focus management works"
- "Client-side routing works: navigating to /<route> renders the component without a full page reload"
- "Form submission handles loading state (submit button disabled during request) and error state (error message displayed on failure)"
- "The component correctly handles empty data state (no items to display)"
- "API errors are caught and displayed to the user, not as unhandled exceptions"

**React-specific evaluator notes:**
- For component rendering criteria, the evaluator should check for the component file, verify it exports a React component, and check that it handles the key states (loading, error, empty, populated)
- For routing criteria, check `App.tsx` or the router configuration for the new route
- For state management criteria, verify the state management approach matches the existing pattern in the codebase
- For API integration criteria, verify the API call uses the project's HTTP client (fetch, axios, etc.) and handles errors

## Step 5: Execute the Pipeline

Run the full sprint execution loop (same as `bober.run`) with React-specific evaluation:

### React-Specific Evaluation Enhancements

When evaluating React sprints, the evaluator should additionally check:

1. **Component structure:**
   - Components are in the correct directory
   - Components follow the project's naming convention (PascalCase for components)
   - Components are properly typed (props interface/type defined)

2. **React patterns:**
   - Hooks are used correctly (no conditional hooks, proper dependency arrays)
   - Side effects are in `useEffect` with proper cleanup
   - Expensive computations use `useMemo`/`useCallback` where appropriate
   - State is at the correct level (not too high, not too low)

3. **Accessibility:**
   - Interactive elements are keyboard accessible
   - Form inputs have labels
   - Images have alt text
   - Color contrast is sufficient (if Tailwind, check class choices)
   - Focus management on route changes

4. **Performance basics:**
   - No unnecessary re-renders from unstable references
   - Lists use proper `key` props (not array index for dynamic lists)
   - Large data sets use pagination or virtualization
   - Images are optimized (lazy loading, proper sizing)

5. **Error handling:**
   - Error boundaries exist for route-level components
   - API errors are caught and displayed
   - Loading states are implemented (not just blank screens)
   - Form validation provides clear feedback

## Step 6: Post-Pipeline Verification

After all sprints pass, run a final comprehensive check:

1. **Full build:**
   ```bash
   npm run build
   ```

2. **Full test suite:**
   ```bash
   npm test
   npx playwright test  # if configured
   ```

3. **Dev server smoke test:**
   - Start the dev server
   - Verify the app loads at the root URL
   - Navigate to the new routes
   - Verify no console errors

4. **Report to user:**
   ```
   ## React App Complete

   Your app is ready for review.

   ### How to Run
   npm run dev        # Start development server
   npm run build      # Build for production
   npm test           # Run unit tests
   npx playwright test  # Run E2E tests (if configured)

   ### What Was Built
   <Summary of features implemented>

   ### Project Structure
   <Key new files and directories>

   ### Next Steps
   - Review the code on branch: bober/<feature-slug>
   - Test the app locally: npm run dev
   - When satisfied, merge to main
   ```

## Next Steps

After completing this phase, suggest the following next steps to the user:
- `/bober-plan` — Plan the feature for this React project

## Error Handling

- **Vite/Next.js HMR issues:** If the dev server shows HMR errors during evaluation, restart the dev server before re-evaluating
- **Prisma migration issues:** If database schema changes fail, check if the database file is locked (SQLite) or if the migration conflicts with existing data
- **Playwright browser issues:** If Playwright cannot find a browser, run `npx playwright install chromium` as a setup step
- **Port conflicts:** If the dev server port is in use, detect this and either kill the existing process or use an alternative port
- **Node module resolution issues:** If imports fail after adding new dependencies, ensure `node_modules` is up to date with `npm install`


---

<!-- Reference: react-scaffold.md -->

# React + Backend Scaffold Reference

This document defines the standard project structure and configuration for React full-stack projects scaffolded by `bober.react`.

## Standard Directory Layout

### Vite + Express (Monorepo-Style)

```
project-root/
  bober.config.json
  package.json
  tsconfig.json
  vite.config.ts
  tailwind.config.ts
  postcss.config.js
  .env.example
  .gitignore
  prisma/
    schema.prisma
    migrations/
  src/
    main.tsx                  # React entry point
    App.tsx                   # Root component with router
    index.css                 # Global styles (Tailwind directives)
    vite-env.d.ts            # Vite type declarations
    components/
      ui/                    # Reusable UI primitives (Button, Input, Card, etc.)
      layout/                # Layout components (Header, Sidebar, Footer)
    pages/                   # Route-level page components
      Home.tsx
      NotFound.tsx
    hooks/                   # Custom React hooks
    lib/                     # Shared utilities and helpers
      api.ts                 # API client (fetch wrapper)
      utils.ts               # General utilities
      cn.ts                  # classnames utility (if Tailwind)
    types/                   # Shared TypeScript types
      index.ts
    contexts/                # React contexts (if used)
  server/
    index.ts                 # Express app entry point
    routes/                  # API route handlers
      index.ts               # Route aggregator
    middleware/               # Express middleware
      errorHandler.ts
      auth.ts                # Auth middleware (if applicable)
    services/                # Business logic layer
    db/
      client.ts              # Prisma client instance
  tests/
    setup.ts                 # Test setup (vitest)
    unit/                    # Unit tests
    e2e/                     # Playwright E2E tests
      example.spec.ts
  public/
    favicon.svg
```

### Next.js (App Router)

```
project-root/
  bober.config.json
  package.json
  tsconfig.json
  next.config.ts
  tailwind.config.ts
  postcss.config.js
  .env.example
  .gitignore
  prisma/
    schema.prisma
    migrations/
  src/
    app/
      layout.tsx             # Root layout
      page.tsx               # Home page
      globals.css            # Global styles
      not-found.tsx          # 404 page
      api/                   # API routes
        route.ts
    components/
      ui/                    # Reusable UI primitives
      layout/                # Layout components
    hooks/                   # Custom React hooks
    lib/                     # Shared utilities
      api.ts
      utils.ts
      db.ts                  # Prisma client
    types/                   # Shared types
  tests/
    unit/
    e2e/
  public/
    favicon.svg
```

## Key Configuration Files

### package.json (Vite + Express)

```json
{
  "name": "<project-name>",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "concurrently \"vite\" \"tsx watch server/index.ts\"",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "server": "tsx server/index.ts",
    "lint": "eslint . --ext .ts,.tsx",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "db:push": "prisma db push",
    "db:migrate": "prisma migrate dev",
    "db:studio": "prisma studio"
  }
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "react-jsx",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"],
      "@server/*": ["./server/*"]
    }
  },
  "include": ["src", "server"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

### vite.config.ts

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
```

### tailwind.config.ts

```typescript
import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
```

### prisma/schema.prisma (SQLite default)

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
```

### .env.example

```
DATABASE_URL="file:./dev.db"
SESSION_SECRET="change-me-in-production"
PORT=3001
```

### vitest setup (tests/setup.ts)

```typescript
import '@testing-library/jest-dom/vitest';
```

### vitest.config.ts

```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'server/**/*.test.ts', 'tests/unit/**/*.test.{ts,tsx}'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
```

### playwright.config.ts

```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
```

## Key Dependencies by Category

### Core (always installed)
- `react`, `react-dom` — React framework
- `typescript` — Type safety
- `vite`, `@vitejs/plugin-react` — Build tool and React plugin

### Styling
- `tailwindcss`, `postcss`, `autoprefixer` — Utility-first CSS
- `clsx` or `tailwind-merge` — Conditional class utilities
- `@radix-ui/react-*` — Headless UI primitives (if using shadcn/ui)

### Routing
- `react-router-dom` — Client-side routing (Vite projects)
- Built-in file routing (Next.js/Remix projects)

### Backend
- `express` — Web framework
- `cors` — CORS middleware
- `helmet` — Security headers
- `tsx` — TypeScript execution for Node.js
- `concurrently` — Run frontend and backend in parallel

### Database
- `prisma`, `@prisma/client` — ORM and database client
- Or: `drizzle-orm`, `drizzle-kit`, `better-sqlite3`

### Auth
- `bcrypt` or `bcryptjs` — Password hashing
- `express-session` — Session management
- `connect-sqlite3` or `connect-pg-simple` — Session storage

### Testing
- `vitest` — Unit test runner
- `@testing-library/react` — React component testing
- `@testing-library/jest-dom` — DOM assertions
- `jsdom` — DOM environment for tests
- `@playwright/test` — E2E testing

### Dev Tools
- `eslint` — Linting
- `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin` — TypeScript ESLint
- `eslint-plugin-react-hooks` — React hooks linting
- `eslint-plugin-react-refresh` — Fast refresh linting

## Scaffold Verification

After scaffolding, verify:
1. `npm run build` succeeds
2. `npm run typecheck` reports zero errors
3. `npm run lint` reports zero errors
4. `npm test` passes (even if there are no tests yet -- it should not error)
5. `npm run dev` starts both frontend and backend
6. Visiting `http://localhost:5173` shows the default page

## Adapting to User Choices

| User Choice | Scaffold Adjustment |
|-------------|-------------------|
| Next.js instead of Vite | Use `create-next-app` scaffold, `app/` directory, API routes instead of Express |
| FastAPI backend | Create `backend/` dir with Python files, `requirements.txt`, `main.py` |
| PostgreSQL instead of SQLite | Update `prisma/schema.prisma` datasource, add connection string to `.env.example` |
| No Tailwind | Skip Tailwind config, use CSS Modules pattern, add `*.module.css` examples |
| Zustand for state | Create `src/stores/` directory, add example store |
| Redux | Create `src/store/` with slices pattern, configure provider |
| No database | Skip Prisma setup, remove `server/db/` directory |
| shadcn/ui | Run `npx shadcn@latest init`, configure `components.json` |
