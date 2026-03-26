# Project Guide

## Architecture

This is a React + Express full-stack TypeScript application.

```
src/              React frontend (Vite)
  App.tsx         Root component
  main.tsx        Entry point
  index.html      HTML template
server/           Express backend
  index.ts        Server entry point with API routes
```

**Frontend:** React 19, TypeScript, Vite 6, bundled with `@vitejs/plugin-react`.
**Backend:** Express 5, TypeScript, running on Node with `tsx` in development.

The Vite dev server proxies `/api/*` requests to the Express server at `localhost:3001`.

## Running the Project

```bash
npm install               # install all dependencies
npm run dev               # start both frontend (5173) and backend (3001)
npm run dev:client        # start only the Vite dev server
npm run dev:server        # start only the Express server
```

## Building

```bash
npm run build             # builds both client and server
npm run build:client      # vite build -> dist/client/
npm run build:server      # tsc -> dist/server/
```

## Testing

```bash
npm test                  # run unit tests with Vitest
npm run test:watch        # run Vitest in watch mode
npm run test:e2e          # run Playwright end-to-end tests
```

Unit tests live alongside source files as `*.test.ts` or `*.test.tsx`. Use `@testing-library/react` for component tests. Use `vitest` globals (`describe`, `it`, `expect`).

## Linting and Type Checking

```bash
npm run lint              # ESLint across all .ts/.tsx files
npm run typecheck         # tsc --noEmit for both client and server
```

## Coding Conventions

- **TypeScript strict mode** is enabled everywhere. No `any` unless absolutely necessary.
- **ESM only** (`"type": "module"` in package.json). Use `import`/`export`, never `require`.
- **Functional React components** with hooks. No class components.
- **Path aliases:** Use `@/` to import from `src/` in frontend code.
- **API routes** are prefixed with `/api/`. All API responses are JSON.
- **Error handling:** API endpoints must return appropriate HTTP status codes and structured error objects (`{ error: string, details?: unknown }`).
- **No default exports** except for React page/route components and the Express app.
- **File naming:** `kebab-case.ts` for utilities, `PascalCase.tsx` for React components.

## Key Decisions

- Vite is used instead of Next.js for simplicity and separation of concerns.
- The backend is a standalone Express server, not a serverless function layer.
- Vitest is used for unit tests (Vite-native, fast, compatible API).
- Playwright handles E2E testing against the running application.
