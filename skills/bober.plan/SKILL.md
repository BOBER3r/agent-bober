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
- **Very detailed** (e.g., a multi-paragraph spec): You may skip some clarifying questions if the user has already answered them

## Step 4: Ask Clarifying Questions

Ask **3 to 5** targeted clarifying questions. The number depends on the complexity of the feature and how much context the codebase already provides.

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

## Step 5: Generate the PlanSpec

After receiving the user's answers, generate a complete PlanSpec. Follow the schema documented in `skills/bober.plan/references/spec-schema.md`.

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

## Step 6: Decompose into Sprint Contracts

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

## Step 7: Save Everything

Save all artifacts to the `.bober/` directory:

1. **PlanSpec:** `.bober/specs/<specId>.json`
   - `specId` format: `spec-<YYYYMMDD>-<slug>` where slug is a kebab-case version of the title (max 30 chars)

2. **Sprint Contracts:** `.bober/contracts/<contractId>.json` for each sprint
   - `contractId` format: `sprint-<specId>-<sprint-number>`

3. **Update `.bober/progress.md`:**
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

4. **Append to `.bober/history.jsonl`:**
   ```json
   {"event":"plan-created","specId":"...","title":"...","sprintCount":N,"timestamp":"..."}
   ```

## Step 7.5: Decide — Ready or Needs Clarification?

After self-answering the clarifying questions in Step 4, score the remaining ambiguity 0-10 using this rubric:

| Score | Meaning |
|-------|---------|
| 0-2   | Fully specified. Every behavior, edge case, error path is concrete. |
| 3-4   | Mostly specified. Small judgment calls remain (library choice, exact wording). |
| 5-6   | Some load-bearing decisions deferred to the generator, but codebase has clear patterns. |
| 7-8   | Significant ambiguity. The generator would have to make architectural guesses. |
| 9-10  | Fundamental specification gaps. Sprint cannot be reliably implemented. |

**Decision:**

- If score < 7 AND no questions are unresolved → set `status: "draft"` and proceed to Step 8 (sprint contracts get saved).
- If score >= 7 OR any question remains unresolved → set `status: "needs-clarification"`, populate `clarificationQuestions`, populate `resolvedClarifications` for any you self-answered, and STOP. Do not write sprint contracts. Save the spec, surface the open questions to the user, and exit.

**When clarification is needed, surface it like this:**

```
⚠ Plan needs clarification before sprints can run.
Spec: <title>
Ambiguity score: <N>/10

Open questions:

  Q1 [scope]: <question>
    A) <option>
    B) <option>
    💡 Suggested: <recommendation if available>

  Q2 [data-model]: <question>

Resolve via either:
  /bober-plan answer <specId> Q1 "<your answer>"     (one-shot per question)
  npx agent-bober plan answer <specId>               (interactive walkthrough)
  Or edit .bober/specs/<specId>.json directly and flip status to "ready".
```

The user resolves the questions via the `bober plan answer` CLI command (or by editing the spec file directly). Once all questions are answered, the runtime flips status to `ready` and the next `/bober-sprint` or `/bober-run` invocation can proceed.

## Step 8: Output Summary

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
