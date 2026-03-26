# Clarification Question Guide

This reference helps the Planner agent ask effective, targeted clarifying questions that resolve genuine ambiguity in a feature request.

## Principles

1. **Never ask what you can infer.** If `package.json` shows React 18, do not ask "What framework are you using?"
2. **Always provide options.** Open-ended questions slow down the process. Offer concrete choices with a recommended default.
3. **Include your reasoning.** When you recommend an option, explain WHY based on evidence from the codebase.
4. **Fewer questions is better.** Every question is a round trip with the user. Only ask what genuinely changes the plan.

## Question Categories

### 1. Scope Boundaries

Resolve what is IN scope vs. explicitly OUT.

**Templates:**
- "Should [feature] include [extended capability], or keep it to [minimal version] for now?"
- "When you say [user's term], do you mean: A) [interpretation 1], B) [interpretation 2], C) [interpretation 3]?"
- "Should this feature handle [edge case], or should we defer that to a later sprint?"

**When to ask:** When the user's description is ambiguous about boundaries. "Add a chat feature" could mean real-time WebSocket chat, async messaging, or a simple comment thread.

**When to skip:** When the user's description is specific enough (e.g., "Add a login page with email and password").

### 2. User Personas and Permissions

Clarify who uses the feature and what access control is needed.

**Templates:**
- "Who will use [feature]? A) All users, B) Authenticated users only, C) Admin users only, D) Multiple roles with different permissions"
- "Does [feature] need role-based access control, or is it accessible to all authenticated users?"
- "Should [feature] be accessible to anonymous/unauthenticated users?"

**When to ask:** When the feature involves data creation, modification, or viewing that might need access control. When the existing codebase already has auth/roles.

**When to skip:** When the feature is clearly public-facing (e.g., a landing page) or when the codebase has no auth system and the feature doesn't need one.

### 3. Data Model and Persistence

Clarify what data is involved and how it is stored.

**Templates:**
- "What key information should a [entity] include? A) Minimal: [list fields], B) Standard: [list fields], C) Comprehensive: [list fields]"
- "Should [entity] data be: A) Stored in the database (persistent), B) Stored in session/memory (ephemeral), C) Fetched from an external API (external)"
- "How should [entity A] relate to [entity B]? A) One-to-one, B) One-to-many, C) Many-to-many"

**When to ask:** When the feature involves new data entities or modifies existing ones. When the relationship between entities is ambiguous.

**When to skip:** When the data model is straightforward or dictated by an existing schema.

### 4. Technical Constraints

Clarify must-use or must-avoid technical choices.

**Templates:**
- "Your project uses [database/ORM]. Should this feature use the same, or is there a reason to use something different?"
- "I see your project uses [state management]. Should [feature] follow the same pattern?"
- "Are there any API rate limits, data size constraints, or performance requirements I should know about?"
- "Does this need to work offline or with poor connectivity?"

**When to ask:** When the feature might conflict with existing technical choices, or when performance/scale requirements are unclear.

**When to skip:** When the feature clearly fits within existing patterns and the tech stack is obvious.

### 5. Design and UX Preferences

Clarify visual and interaction expectations.

**Templates:**
- "For the UI, should this: A) Match your existing design system/components, B) Use a specific design reference (provide link/screenshot), C) Be functional-first (agent decides the layout)"
- "What should happen after [action]? A) Redirect to [page], B) Show inline confirmation, C) Show a modal/toast notification"
- "Should [feature] include: A) A simple form/list, B) An interactive dashboard with filtering/sorting, C) A minimal CLI-style interface"

**When to ask:** For user-facing features where the interaction model is ambiguous. When the project does not have an established design system.

**When to skip:** When the project has a consistent design system and the new feature clearly fits an existing pattern. When the feature is backend-only.

### 6. Integrations and External Dependencies

Clarify connections to external services.

**Templates:**
- "Does [feature] need to integrate with any external services? (e.g., payment processor, email service, OAuth provider)"
- "For [external integration], do you already have API keys/credentials, or should the plan include mock/stub implementations?"
- "Should [feature] send notifications? A) No, B) Email only, C) In-app notifications, D) Push notifications, E) Multiple channels"

**When to ask:** When the feature implies external service usage (payments, email, auth providers, file storage, etc.).

**When to skip:** When the feature is entirely self-contained.

### 7. Error Handling and Edge Cases

Clarify expected behavior in failure scenarios.

**Templates:**
- "What should happen when [failure scenario]? A) Show error message and retry, B) Graceful degradation, C) Hard failure with redirect to error page"
- "How should [feature] handle concurrent modifications? A) Last write wins, B) Optimistic locking with conflict resolution, C) Not a concern for this feature"
- "What is the expected data volume? A) Tens of records, B) Hundreds, C) Thousands+, D) Not sure yet"

**When to ask:** When the feature has obvious failure modes that the user might not have considered.

**When to skip:** For simple features where error handling is straightforward.

## Inferring Answers from Codebase Analysis

Before asking, check if the codebase already answers the question:

| Question | Where to Look |
|----------|--------------|
| Auth/permissions | Grep for `auth`, `jwt`, `session`, `middleware`, `guard`, `protect` |
| Database/ORM | Check `package.json` deps for `prisma`, `drizzle`, `knex`, `mongoose`, `typeorm` |
| State management | Grep for `redux`, `zustand`, `recoil`, `useState`, `useReducer`, `context` |
| UI framework | Check `package.json` for `react`, `vue`, `svelte`, `angular` |
| CSS approach | Check for `tailwind`, `styled-components`, `css-modules`, `.scss` files |
| Testing framework | Check `package.json` for `vitest`, `jest`, `mocha`, `playwright`, `cypress` |
| API pattern | Grep for `express`, `fastify`, `hono`, `trpc`, `graphql` |
| Routing | Grep for file-based routing (Next.js `pages/`, `app/`), or `react-router`, `wouter` |
| Design system | Check for component libraries: `shadcn`, `radix`, `chakra`, `mui`, `antd` |
| Deployment | Check for `Dockerfile`, `vercel.json`, `fly.toml`, `railway.json`, `netlify.toml` |

If the codebase clearly answers a question, do not ask it. Instead, state your observation:
> "I see your project uses Prisma with PostgreSQL and has an existing User model. I'll plan the new feature to extend this schema."
