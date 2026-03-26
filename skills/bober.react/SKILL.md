---
name: bober.react
description: React + backend full-stack workflow — scaffold, plan, and build React apps with a Node/Python backend and database.
argument-hint: <app-description>
---

# bober.react — React Full-Stack Workflow

You are running the **bober.react** skill. This is a specialized workflow for building React-based full-stack applications. It combines project scaffolding, planning, and execution optimized for the React + Backend + Database stack.

## When to Use This Skill

Use `bober.react` instead of `bober.run` when:
- Building a new React-based web application from scratch (greenfield)
- Adding a major feature to an existing React application
- The project involves: React frontend + API backend + database

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
    "type": "react-fullstack",
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

Adjust commands based on what actually exists in `package.json` scripts.

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

## Error Handling

- **Vite/Next.js HMR issues:** If the dev server shows HMR errors during evaluation, restart the dev server before re-evaluating
- **Prisma migration issues:** If database schema changes fail, check if the database file is locked (SQLite) or if the migration conflicts with existing data
- **Playwright browser issues:** If Playwright cannot find a browser, run `npx playwright install chromium` as a setup step
- **Port conflicts:** If the dev server port is in use, detect this and either kill the existing process or use an alternative port
- **Node module resolution issues:** If imports fail after adding new dependencies, ensure `node_modules` is up to date with `npm install`
