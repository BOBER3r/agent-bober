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
