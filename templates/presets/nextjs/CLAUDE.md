# Next.js Project Guide

## Architecture

This is a Next.js application using the App Router.

```
app/                  App Router pages and layouts
  layout.tsx          Root layout
  page.tsx            Home page
  api/                API routes (Route Handlers)
components/           Shared React components
lib/                  Utility functions, database clients, helpers
prisma/               Prisma schema and migrations (if using Prisma)
public/               Static assets
```

## App Router Conventions

- **Layouts** (`layout.tsx`): Shared UI that wraps child routes. The root layout is required and must render `<html>` and `<body>`.
- **Pages** (`page.tsx`): Unique UI for a route. This is what gets rendered at that URL.
- **Loading** (`loading.tsx`): Loading UI shown while a route segment loads.
- **Error** (`error.tsx`): Error boundary for a route segment. Must be a Client Component.
- **Route Handlers** (`route.ts` in `app/api/`): Server-side API endpoints using `GET`, `POST`, etc. exports.

## Server vs Client Components

- Components are **Server Components** by default. They run on the server, can fetch data directly, and cannot use hooks or browser APIs.
- Add `"use client"` at the top of a file to make it a **Client Component**. Use Client Components only when you need interactivity (hooks, event handlers, browser APIs).
- Keep Client Components as leaf nodes in the component tree. Push interactive parts to the smallest possible component.

## Server Actions

- Use `"use server"` at the top of a file or inside a function to define Server Actions.
- Server Actions run on the server and can be called from Client Components via form actions or direct invocation.
- Use Server Actions for data mutations (create, update, delete). Revalidate data with `revalidatePath` or `revalidateTag` after mutations.

## Data Fetching

- Fetch data in Server Components using `async/await` directly. No need for `useEffect` or client-side fetching for initial data.
- Use `fetch()` with Next.js caching options: `{ cache: "force-cache" }` (default), `{ cache: "no-store" }`, or `{ next: { revalidate: 60 } }`.
- For database access, call Prisma or your ORM directly in Server Components.

## Middleware

- `middleware.ts` at the project root intercepts requests before they reach routes.
- Use middleware for authentication checks, redirects, request rewriting, and header manipulation.

## Testing

- **Unit tests**: Use Vitest with `@testing-library/react` for component tests.
- **Integration tests**: Test API routes by importing the handler and calling it with mock `Request` objects.
- **E2E tests**: Use Playwright for full end-to-end testing against the running application.

```bash
npm test                  # run unit tests
npm run test:e2e          # run Playwright E2E tests
```

## Database (Prisma)

If using Prisma:

```bash
npx prisma generate       # generate client after schema changes
npx prisma db push        # push schema to database (development)
npx prisma migrate dev    # create a migration (development)
```

- Define models in `prisma/schema.prisma`.
- Import `PrismaClient` from a singleton in `lib/db.ts`.
- Never import Prisma in Client Components.

## Coding Conventions

- **TypeScript strict mode** is enabled. No `any` unless absolutely necessary.
- **ESM only**. Use `import`/`export`, never `require`.
- **Functional components** with hooks. No class components.
- **Server Components by default**. Only add `"use client"` when interactivity is needed.
- **File naming**: `kebab-case.ts` for utilities, `PascalCase.tsx` for components.
- **Error handling**: API routes must return appropriate HTTP status codes. Use `NextResponse.json()` for responses.
- **Environment variables**: Access server-side env vars directly. Prefix with `NEXT_PUBLIC_` for client-side access.
