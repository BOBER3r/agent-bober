---
name: bober.plan
description: Transform a feature idea into a comprehensive plan with sprint contracts, clarifying questions, and acceptance criteria.
argument-hint: <feature-description>
handoffs:
  - label: "Start Building"
    command: /bober-sprint
    prompt: "Execute the first sprint from the plan"
  - label: "Full Autonomous Run"
    command: /bober-run
    prompt: "Run all sprints from the plan autonomously"
---

# bober.plan — Feature Planning Skill

You are running the **bober.plan** skill. Your job is to take a user's feature description and transform it into a structured, sprint-decomposed plan that the Bober Generator-Evaluator harness can execute autonomously.

## Step 1: Check Project Initialization

First, check if `bober.config.json` exists in the project root.

**If `bober.config.json` does NOT exist:**

Guide the user through initialization. Ask open-ended questions to understand what they want to build:

```
I don't see a bober.config.json in this project. Let me set one up.

**Is this a new project or an existing codebase?**
A) New project (greenfield) -- starting from scratch
B) Existing codebase (brownfield) -- adding to or modifying existing code

**What are you building?** (e.g., "a task management web app", "an ERC-20 token", "a REST API", "a CLI tool", "a Solana NFT marketplace")

**What is the project name?** (e.g., "my-todo-app")
```

Based on the user's answers, determine the appropriate `mode` and `preset`:
- `mode`: `"greenfield"` for new projects, `"brownfield"` for existing codebases
- `preset`: Match to a known preset if applicable (`"nextjs"`, `"react-vite"`, `"solidity"`, `"anchor"`, `"api-node"`, `"python-api"`), or omit if the project does not fit a preset
- `stack`: Infer stack details from the user's description (e.g., `{ "frontend": "react", "backend": "express", "database": "postgresql" }`)

The planner should be able to plan ANY type of project -- web apps, APIs, smart contracts, CLI tools, mobile apps, libraries, data pipelines, etc. Do not limit the user to predefined categories.

Create `bober.config.json` using the appropriate defaults from the mode and preset. Use the schema defined in `src/config/schema.ts` and defaults from `src/config/defaults.ts` as reference. Auto-detect commands by examining `package.json`, `Cargo.toml`, `Anchor.toml`, `hardhat.config.*`, `foundry.toml`, or other project manifests if available.

Then create the `.bober/` directory structure:
```bash
mkdir -p .bober/specs .bober/contracts .bober/handoffs .bober/eval-results
```

Create `.bober/progress.md` with initial content:
```markdown
# Bober Progress

Project: <project-name>
Mode: <greenfield|brownfield>
Preset: <preset or "custom">
Initialized: <date>

---
```

Create `.bober/history.jsonl` with the initialization event:
```json
{"event":"project-initialized","projectName":"...","mode":"...","preset":"...","timestamp":"..."}
```

**If `bober.config.json` EXISTS:** Read it and proceed to Step 2.

## Step 2: Gather Codebase Context

Read the following files if they exist (skip those that do not):

1. `bober.config.json` — project configuration
2. `CLAUDE.md` — project-level instructions and context
3. `package.json` — dependencies, scripts, project metadata
4. `tsconfig.json` — TypeScript configuration
5. Any files listed in `planner.contextFiles` from the config

Survey the project structure:
- Use Glob with patterns appropriate to the stack to understand the file layout (e.g., `src/**/*.ts`, `contracts/**/*.sol`, `programs/**/*.rs`, `app/**/*`, `pages/**/*`)
- Use Grep to find key patterns relevant to the project type: route definitions, database/ORM usage, state management, smart contract interfaces, program instructions, authentication patterns, etc.
- Read `.bober/specs/` to check for existing plans
- Read `.bober/progress.md` to understand current project state

Build a concise mental model of:
- Tech stack (language, framework, database, key libraries)
- Architecture pattern (monolith, microservices, monorepo, component-based)
- Existing features and their maturity
- Test coverage and testing patterns
- Build and deployment setup

## Step 3: Understand the Feature Request

The user provided a feature description as the argument to this skill. If the description is:
- **Clear and specific** (e.g., "Add user authentication with email/password and Google OAuth"): Proceed to clarifying questions
- **Vague** (e.g., "make it better"): Ask the user to be more specific about what they want before proceeding
- **Very detailed** (e.g., a multi-paragraph spec): Still ask clarifying questions — focus on Integration Risk, Pattern Conflicts, and Regression Risk that even a detailed spec may not address

## Step 4: Ask Clarifying Questions (Always Required)

Ask **3 to 5** targeted clarifying questions. This step is mandatory regardless of how detailed the feature description is.

**Question format:**
```
I have a few questions to make sure I build the right plan:

**Q1: [Category] — [Question]**
A) [Option] — [Brief explanation]
B) [Option] — [Brief explanation]
C) [Option] — [Brief explanation]
D) Other (please specify)

> Based on your codebase, I'd suggest [X] because [reason from codebase analysis].

**Q2: [Category] — [Question]**
...
```

**Question selection guidelines:**

Draw from the reference file at `skills/bober.plan/references/clarification-guide.md` for question categories and templates. Prioritize questions that:

1. Resolve genuine ambiguity that would cause different implementations
2. Clarify scope boundaries (what is IN vs OUT)
3. Address technical constraints specific to this codebase
4. Establish user-facing behavior that affects acceptance criteria

**Do NOT ask questions about:**
- Things obvious from the codebase (framework choice, language, existing patterns)
- Implementation details the Generator should decide
- Things the user explicitly stated in their feature description

**Maximum questions:** Respect `planner.maxClarifications` from the config (default: 5).

## Step 5: Generate Design Discussion Document

After receiving the user's answers to the clarifying questions, generate a design discussion document BEFORE writing the PlanSpec. Save it to `.bober/designs/<specId>-design.md`.

The design document must include these sections (target ~200 lines total):

1. **Current State** — What exists today that is relevant. Reference specific files and line numbers.
2. **Desired End State** — What new files and behaviors will exist after implementation.
3. **Patterns to Follow** — Specific file paths in the codebase the Generator should use as models.
4. **Resolved Design Decisions** — Each clarifying Q&A pair with the decision and its rationale. Cite codebase evidence.
5. **Open Questions** — Any remaining unknowns with brief notes on what was assumed.

**Present the design document to the user with this prompt:**

```
I've drafted a design discussion document for this feature. Please review it before I generate the full plan:

[design document content]

---

Does this accurately capture the intent and approach? Any corrections or additions before I proceed to generate the PlanSpec and sprint contracts?

A) Looks good — proceed with the plan
B) Minor corrections: [your notes]
C) Major revision needed: [what to change]
```

Wait for the user's response before proceeding. Incorporate any corrections into the design document (re-save it) and then continue to Step 6.

## Step 6: Generate the PlanSpec

After the design document is reviewed and approved, generate a complete PlanSpec. Follow the schema documented in `skills/bober.plan/references/spec-schema.md`.

**PlanSpec generation rules:**

1. **Title:** Clear, concise feature title (not a sentence, not a paragraph)
2. **Description:** 2-3 sentences explaining what this feature does and the user value it provides
3. **Assumptions:** List every assumption you are making. These are things the user did not explicitly say but you inferred. The user should validate these.
4. **Out of scope:** Explicitly list what this plan does NOT cover. This prevents scope creep during implementation.
5. **Features:** Break the feature into sub-features. Each sub-feature should be independently valuable when possible. Assign priorities: `must-have` (core functionality), `should-have` (important but not blocking), `nice-to-have` (polish and extras).
6. **Acceptance criteria:** Each feature needs 2+ acceptance criteria. Each criterion must be:
   - Specific (not "works correctly")
   - Testable (an evaluator can verify it)
   - User-facing when possible (describes behavior, not implementation)
7. **Non-functional requirements:** Performance, security, accessibility, reliability considerations
8. **Tech notes:** Integration points, data model overview, security considerations

## Step 7: Decompose into Sprint Contracts

Decompose the PlanSpec into ordered sprints. This is the most critical step.

**Read `sprint.sprintSize` from config to calibrate sprint size:**
- `small`: 30-60 min, 1-2 files, single concern
- `medium`: 1-3 hours, 3-8 files, one cohesive feature slice
- `large`: 3-5 hours, 5-15 files, full feature vertical

**Sprint decomposition rules:**

1. **Vertical slices.** Each sprint delivers a working end-to-end feature slice. Do not create horizontal sprints like "Sprint 1: Database schema" followed by "Sprint 2: API endpoints" followed by "Sprint 3: UI." Instead: "Sprint 1: Basic user registration (form + endpoint + DB)."

2. **Working increment after every sprint.** The app must build and run after each sprint. Each sprint demonstrates new visible functionality.

3. **Forward dependencies only.** Sprint N+1 may depend on Sprint N. Sprint N must never depend on Sprint N+1. No circular dependencies.

4. **Clear boundaries.** The contract must make it unambiguous what is included and excluded.

5. **Risk-first ordering.** Architecture decisions, complex integrations, and unknowns come early. Polish, edge cases, and optimizations come later.

6. **Success criteria per sprint.** Each sprint gets 3-8 success criteria that are independently testable. At least one must be a `build` verification. At least one must verify actual functionality.

Follow the contract schema documented in `skills/bober.sprint/references/contract-schema.md`.

**For each sprint contract, include:**
- `generatorNotes`: Specific guidance for the Generator -- what patterns to follow, what files to look at, known gotchas
- `evaluatorNotes`: Specific guidance for the Evaluator -- what to test, how to verify each criterion, what edge cases to check

## Step 8: Save Everything

Save all artifacts to the `.bober/` directory:

1. **Design Discussion Document:** `.bober/designs/<specId>-design.md` (already saved in Step 5)

2. **PlanSpec:** `.bober/specs/<specId>.json`
   - `specId` format: `spec-<YYYYMMDD>-<slug>` where slug is a kebab-case version of the title (max 30 chars)

3. **Sprint Contracts:** `.bober/contracts/<contractId>.json` for each sprint
   - `contractId` format: `sprint-<specId>-<sprint-number>`

4. **Update `.bober/progress.md`:**
   ```markdown
   ## Plan: <title>
   - Spec: <specId>
   - Created: <date>
   - Sprints: <count>
   - Status: planned

   ### Sprint Breakdown
   1. [proposed] <Sprint 1 title> -- <1-line description>
   2. [proposed] <Sprint 2 title> -- <1-line description>
   ...
   ```

5. **Append to `.bober/history.jsonl`:**
   ```json
   {"event":"plan-created","specId":"...","title":"...","sprintCount":N,"timestamp":"..."}
   ```

## Step 9: Output Summary

Present a clean, readable summary to the user:

```
## Plan Created: <title>

<description>

### Assumptions
- <assumption 1>
- <assumption 2>

### Out of Scope
- <excluded item 1>
- <excluded item 2>

### Sprint Breakdown

**Sprint 1: <title>** (estimated: <size>)
<1-2 sentence description>
Key criteria: <list 2-3 most important success criteria>

**Sprint 2: <title>** (estimated: <size>)
<1-2 sentence description>
Key criteria: <list 2-3 most important success criteria>

...

### Next Steps
Run `/bober.sprint` to begin executing Sprint 1, or `/bober.run` to execute the full pipeline.
```

## Next Steps

After completing this phase, suggest the following next steps to the user:
- `/bober-sprint` — Start building by executing the first sprint from the plan
- `/bober-run` — Run all sprints from the plan autonomously

## Error Handling

- If the project has no manifest file (`package.json`, `Cargo.toml`, `pyproject.toml`, etc.) and no obvious project structure, ask the user if this is a new project and what they want to build
- If existing specs conflict with the new feature request, flag the conflict and ask the user how to proceed
- If the feature is too large for `sprint.maxSprints` sprints, suggest breaking it into multiple PlanSpecs or increasing the sprint size
- If the user's answers to clarifying questions contradict each other, point out the contradiction and ask for resolution


---

<!-- Reference: clarification-guide.md -->

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

### 8. Integration Risk Assessment

Identify whether the feature could break existing integrations or violate interface contracts.

**Templates:**
- "This feature modifies [module/API]. Are there other parts of the codebase that consume this interface? A) Yes, and they need updating, B) Yes, but they are backward-compatible, C) No known consumers"
- "Does [feature] introduce new external service dependencies? A) Yes — [service] (credentials needed), B) Yes — mock/stub is fine for now, C) No external dependencies"
- "Could changes to [shared module] affect [downstream feature]? A) Yes, regression tests cover this, B) Yes, but no tests exist — we should add them, C) No impact expected"

**When to ask:** Always ask at least one integration risk question for brownfield projects. Skip only when the change is provably isolated (a new file with no shared dependencies).

### 9. Existing Pattern Conflicts

Detect whether the proposed approach would conflict with established codebase patterns.

**Templates:**
- "The existing codebase uses [pattern A] for [concern]. Should this feature follow the same pattern, or is there a reason to deviate? A) Follow existing pattern, B) Deviate — here's why: [reason], C) Hybrid approach"
- "Your project's [naming/folder/export] convention is [X]. Should new code for this feature follow the same convention? A) Yes, B) No — this is a new domain that warrants a different convention"
- "I see [pattern] used in [file]. Should [feature] reuse this, or introduce a parallel implementation? A) Reuse existing, B) New implementation — the use case is different enough"

**When to ask:** Whenever the feature touches code near existing patterns that could conflict. Always ask at least one question in this category for brownfield projects.

**When to skip:** Greenfield projects with no established patterns yet.

### 10. Regression Risk Areas

Surface which existing features may be affected by this change.

**Templates:**
- "The feature touches [shared code/module]. Which existing features depend on it? A) [List features] — we should add regression tests, B) None that I know of, C) I'm not sure"
- "Are there end-to-end tests for the flows that [feature] touches? A) Yes, they cover this, B) Partial coverage — we should add more, C) No E2E tests exist"
- "What is the risk profile of this change? A) High — touches core shared logic used everywhere, B) Medium — touches a well-defined module with some consumers, C) Low — isolated change with no shared state"

**When to ask:** For any change that touches shared modules, exported functions, database schemas, or API contracts. Always include at least one regression question in brownfield projects.

**When to skip:** When the change only adds new, isolated files with no modifications to existing ones.

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


---

<!-- Reference: spec-schema.md -->

# PlanSpec JSON Schema

This document defines the complete schema for PlanSpec documents generated by the Planner agent. PlanSpecs are the authoritative source-of-truth for what will be built.

## Location

PlanSpec files are stored at: `.bober/specs/<specId>.json`

## Naming Convention

- `specId` format: `spec-<YYYYMMDD>-<slug>`
- The slug is derived from the title: lowercase, spaces replaced with hyphens, max 30 characters, no special characters
- Example: `spec-20260326-user-authentication`

## Full Schema

```json
{
  "specId": "string (required)",
  "version": "number (required, starts at 1, incremented on updates)",
  "createdAt": "string (required, ISO-8601 datetime)",
  "updatedAt": "string (required, ISO-8601 datetime)",
  "title": "string (required, 3-80 characters)",
  "description": "string (required, 2-3 sentences)",
  "mode": "string (required, one of: greenfield, brownfield)",
  "preset": "string (optional, e.g.: nextjs, react-vite, solidity, anchor, api-node, python-api)",
  "status": "string (required, one of: planned, in-progress, completed, archived)",

  "assumptions": [
    "string — each assumption the planner is making"
  ],

  "outOfScope": [
    "string — each item explicitly excluded from this plan"
  ],

  "features": [
    {
      "featureId": "string (required, format: feat-<index>)",
      "title": "string (required)",
      "description": "string (required)",
      "priority": "string (required, one of: must-have, should-have, nice-to-have)",
      "acceptanceCriteria": [
        "string — each criterion prefixed with AC<N>:"
      ],
      "dependencies": ["string — featureId references"],
      "estimatedComplexity": "string (required, one of: low, medium, high)"
    }
  ],

  "nonFunctionalRequirements": [
    {
      "category": "string (required, one of: performance, security, accessibility, reliability, maintainability)",
      "requirement": "string (required)",
      "verificationMethod": "string (required, how the evaluator verifies this)"
    }
  ],

  "techNotes": {
    "suggestedStack": "string (optional, only for greenfield projects)",
    "integrationPoints": ["string — external APIs or services"],
    "dataModel": "string (brief description of key entities and relationships)",
    "securityConsiderations": ["string — auth, validation, encryption, etc."],
    "existingPatterns": "string (optional, patterns from the codebase to follow)"
  },

  "sprints": [
    "string — contractId references, ordered by execution sequence"
  ],

  "metadata": {
    "estimatedTotalDuration": "string (e.g., '4-6 hours')",
    "riskLevel": "string (one of: low, medium, high)",
    "riskNotes": "string (optional, explanation of risk assessment)"
  }
}
```

## Field Descriptions

### Top-Level Fields

| Field | Description |
|-------|-------------|
| `specId` | Unique identifier for this spec. Generated once, never changes. |
| `version` | Integer version number. Incremented if the spec is revised after creation. |
| `createdAt` | ISO-8601 timestamp of initial creation. |
| `updatedAt` | ISO-8601 timestamp of last modification. |
| `title` | Human-readable feature title. Should be concise and descriptive. |
| `description` | 2-3 sentence summary of the feature and its user value. |
| `mode` | Must match the `project.mode` in `bober.config.json` (`greenfield` or `brownfield`). |
| `preset` | Must match the `project.preset` in `bober.config.json`, if set (e.g., `nextjs`, `solidity`, `anchor`). |
| `status` | Lifecycle state: `planned` (not started), `in-progress` (sprints running), `completed` (all sprints done), `archived` (abandoned or superseded). |

### Features Array

Each feature represents a distinct, potentially independently valuable unit of functionality within the plan.

| Field | Description |
|-------|-------------|
| `featureId` | Unique within this spec. Format: `feat-1`, `feat-2`, etc. |
| `title` | Short feature name. |
| `description` | What this feature does and why it matters. |
| `priority` | `must-have`: Core functionality, plan fails without it. `should-have`: Important, but plan could ship without it. `nice-to-have`: Polish, optimization, extras. |
| `acceptanceCriteria` | Array of testable criteria. Each MUST be verifiable by the evaluator. Format: `"AC1: When [action], then [expected result]"`. |
| `dependencies` | Array of `featureId` values that must be implemented before this feature. Empty array if no dependencies. |
| `estimatedComplexity` | Rough complexity estimate to inform sprint sizing. `low`: straightforward, known patterns. `medium`: some unknowns or moderate logic. `high`: complex logic, integrations, or architectural decisions. |

### Acceptance Criteria Rules

Good criteria follow the Given-When-Then pattern:
- "AC1: When a user submits the registration form with a valid email and password, a new user account is created and the user is redirected to the dashboard."
- "AC2: When a user submits the form with an email that already exists, an error message 'This email is already registered' is displayed."

Bad criteria:
- "The feature works correctly" (not testable)
- "The code is clean" (subjective)
- "Performance is good" (not measurable)

### Non-Functional Requirements

| Field | Description |
|-------|-------------|
| `category` | One of: `performance`, `security`, `accessibility`, `reliability`, `maintainability`. |
| `requirement` | Specific, measurable requirement. E.g., "Page loads in under 2 seconds on 3G connection." |
| `verificationMethod` | How the evaluator can verify this. E.g., "Run Lighthouse audit and check Performance score > 80." |

### Tech Notes

| Field | Description |
|-------|-------------|
| `suggestedStack` | Only for greenfield projects. Describes the recommended tech stack. |
| `integrationPoints` | External services the feature depends on (APIs, OAuth providers, payment processors, etc.). |
| `dataModel` | Brief description of entities, their key fields, and relationships. Not a full schema -- just enough for the Generator to understand the domain. |
| `securityConsiderations` | Auth requirements, input validation needs, encryption, rate limiting, etc. |
| `existingPatterns` | For brownfield projects: patterns from the existing codebase that the Generator should follow. |

### Metadata

| Field | Description |
|-------|-------------|
| `estimatedTotalDuration` | Rough estimate of total implementation time across all sprints. |
| `riskLevel` | Overall risk assessment. `high` if the feature involves new integrations, architectural changes, or significant unknowns. |
| `riskNotes` | Explanation of risk factors. |

## Complete Example

```json
{
  "specId": "spec-20260326-user-auth",
  "version": 1,
  "createdAt": "2026-03-26T10:00:00Z",
  "updatedAt": "2026-03-26T10:00:00Z",
  "title": "User Authentication System",
  "description": "A complete user authentication system supporting email/password registration and login, with session management and protected routes. This enables the application to identify users and restrict access to authorized content.",
  "mode": "greenfield",
  "preset": "react-vite",
  "status": "planned",
  "assumptions": [
    "The application does not currently have any authentication system",
    "PostgreSQL is the database, as configured in the project",
    "Sessions will use HTTP-only cookies rather than localStorage for security",
    "Email verification is not required for initial registration (deferred to later)"
  ],
  "outOfScope": [
    "OAuth/social login (Google, GitHub, etc.)",
    "Two-factor authentication",
    "Password reset via email",
    "User profile management beyond basic info",
    "Admin user management dashboard"
  ],
  "features": [
    {
      "featureId": "feat-1",
      "title": "User Registration",
      "description": "Allow new users to create an account with email and password.",
      "priority": "must-have",
      "acceptanceCriteria": [
        "AC1: When a user navigates to /register, a registration form with email, password, and confirm-password fields is displayed.",
        "AC2: When a user submits valid registration data, a new user record is created in the database with a hashed password.",
        "AC3: When a user submits a registration with an already-used email, the form displays 'This email is already registered.'",
        "AC4: When a user submits a password shorter than 8 characters, the form displays 'Password must be at least 8 characters.'"
      ],
      "dependencies": [],
      "estimatedComplexity": "medium"
    },
    {
      "featureId": "feat-2",
      "title": "User Login",
      "description": "Allow existing users to authenticate with email and password.",
      "priority": "must-have",
      "acceptanceCriteria": [
        "AC1: When a user navigates to /login, a login form with email and password fields is displayed.",
        "AC2: When a user submits valid credentials, they are redirected to the dashboard and a session cookie is set.",
        "AC3: When a user submits invalid credentials, the form displays 'Invalid email or password.'"
      ],
      "dependencies": ["feat-1"],
      "estimatedComplexity": "medium"
    },
    {
      "featureId": "feat-3",
      "title": "Protected Routes",
      "description": "Restrict access to certain pages to authenticated users only.",
      "priority": "must-have",
      "acceptanceCriteria": [
        "AC1: When an unauthenticated user navigates to a protected route, they are redirected to /login.",
        "AC2: When an authenticated user navigates to a protected route, the page renders normally.",
        "AC3: A logout button is visible on all protected pages that destroys the session and redirects to /login."
      ],
      "dependencies": ["feat-2"],
      "estimatedComplexity": "low"
    }
  ],
  "nonFunctionalRequirements": [
    {
      "category": "security",
      "requirement": "Passwords must be hashed using bcrypt with a cost factor of at least 10.",
      "verificationMethod": "Inspect the registration code to verify bcrypt usage with appropriate cost factor."
    },
    {
      "category": "security",
      "requirement": "Session cookies must be HTTP-only, Secure, and SameSite=Strict.",
      "verificationMethod": "Inspect Set-Cookie headers in login response."
    },
    {
      "category": "accessibility",
      "requirement": "All form inputs must have associated labels and the forms must be keyboard-navigable.",
      "verificationMethod": "Verify label-input associations in HTML and test Tab navigation."
    }
  ],
  "techNotes": {
    "integrationPoints": [],
    "dataModel": "Single 'users' table with id (UUID), email (unique), password_hash, created_at, updated_at. Sessions stored server-side with express-session.",
    "securityConsiderations": [
      "Hash passwords with bcrypt before storage",
      "Rate-limit login attempts to prevent brute force",
      "Validate email format on both client and server",
      "Use CSRF protection for state-changing requests"
    ],
    "existingPatterns": "The project uses Express.js with middleware pattern. Follow existing route definition style in src/routes/."
  },
  "sprints": [
    "sprint-spec-20260326-user-auth-1",
    "sprint-spec-20260326-user-auth-2",
    "sprint-spec-20260326-user-auth-3"
  ],
  "metadata": {
    "estimatedTotalDuration": "3-5 hours",
    "riskLevel": "low",
    "riskNotes": "Standard auth implementation with well-known patterns. No external service dependencies."
  }
}
```
