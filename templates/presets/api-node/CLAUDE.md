# Node.js API Project Guide

## Architecture

This is a Node.js API project using TypeScript.

```
src/
  index.ts            Application entry point
  routes/             Route handlers organized by domain
  middleware/          Express/Fastify middleware (auth, validation, error handling)
  services/           Business logic layer
  models/             Data models / database schemas
  utils/              Shared utility functions
  types/              TypeScript type definitions
tests/                Test files mirroring src/ structure
```

## Framework Patterns

### Express

```typescript
import express from "express";
const app = express();

app.use(express.json());
app.use("/api/users", userRouter);

app.use(errorHandler); // error middleware last
```

### NestJS

```typescript
@Controller("users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  findAll() {
    return this.usersService.findAll();
  }

  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto);
  }
}
```

### Fastify

```typescript
import Fastify from "fastify";
const app = Fastify({ logger: true });

app.register(userRoutes, { prefix: "/api/users" });
```

## Middleware

- **Authentication**: Verify JWTs or session tokens. Return 401 for missing/invalid auth.
- **Validation**: Validate request bodies and query parameters at the route level. Use Zod, Joi, or class-validator.
- **Error Handling**: Centralize error handling in a global error middleware. Map known errors to HTTP status codes.
- **Logging**: Use structured logging (pino, winston). Log request IDs for traceability.
- **Rate Limiting**: Apply rate limiting to public endpoints.
- **CORS**: Configure CORS for allowed origins.

## Validation

Use Zod for request validation:

```typescript
import { z } from "zod";

const CreateUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100),
  role: z.enum(["admin", "user"]).default("user"),
});

type CreateUserInput = z.infer<typeof CreateUserSchema>;
```

## Authentication

- Use JWT tokens for stateless auth or sessions for stateful auth.
- Store secrets in environment variables, never in code.
- Hash passwords with bcrypt (cost factor >= 12).
- Implement refresh token rotation for long-lived sessions.

## Database Access

- Use an ORM (Prisma, TypeORM, Drizzle) or query builder (Knex).
- Run migrations for schema changes. Never modify the database schema manually.
- Use connection pooling in production.
- Write repository or service functions for database queries. Do not put raw queries in route handlers.

## Error Handling

Define application-specific error classes:

```typescript
export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(404, `${resource} not found`, "NOT_FOUND");
  }
}
```

Return consistent error response shapes:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "User not found"
  }
}
```

## Testing

```bash
npm test                  # run all tests
npm run test:watch        # run tests in watch mode
npm run test:coverage     # run tests with coverage
```

- **Unit tests**: Test services and utilities in isolation. Mock database and external dependencies.
- **Integration tests**: Test routes with supertest. Use a test database or in-memory store.
- **Test structure**: Mirror the `src/` directory in `tests/`. Name test files `*.test.ts`.

## Coding Conventions

- **TypeScript strict mode** is enabled. No `any` unless absolutely necessary.
- **ESM only** (`"type": "module"` in package.json). Use `import`/`export`, never `require`.
- **Async/await** for all asynchronous operations. No raw callbacks.
- **Environment variables**: Load with `dotenv` or framework-native config. Validate at startup.
- **File naming**: `kebab-case.ts` for all source files.
- **Error handling**: Always catch async errors. Use `express-async-errors` or equivalent.
- **No business logic in route handlers**. Route handlers parse input, call services, and format output.
