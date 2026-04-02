---
name: bober.sprint
description: Execute the next pending sprint — spawn generator and evaluator subagents, orchestrate the retry loop until passing or exhausting retries.
argument-hint: "[sprint-number]"
handoffs:
  - label: "Evaluate Sprint"
    command: /bober-eval
    prompt: "Evaluate the current sprint output"
  - label: "Next Sprint"
    command: /bober-sprint
    prompt: "Execute the next sprint"
---

# bober.sprint — Sprint Execution Orchestrator

You are the **orchestrator** for a single sprint cycle. You do NOT implement code or evaluate it yourself. You spawn subagents using the **Agent tool** for both the generator (implementation) and evaluator (verification) roles, and you manage the retry loop between them.

Each subagent runs in its own isolated context window. It receives ONLY the information you explicitly pass in its prompt. After a subagent completes, you read the files it created on disk to get the full results.

## Prerequisites

Before starting, verify these exist:
- `bober.config.json` in the project root
- At least one PlanSpec in `.bober/specs/`
- At least one SprintContract in `.bober/contracts/`

If any are missing, tell the user to run `/bober-plan` first.

Also read `.bober/principles.md` if it exists. You will include the principles text in every subagent prompt.

## Step 1: Identify the Target Sprint

**If a sprint number was provided as an argument:**
- Load the most recent PlanSpec from `.bober/specs/` (sort by `createdAt` descending)
- Find the contract for that sprint number: `.bober/contracts/sprint-<specId>-<N>.json`
- Verify it exists and its status is `proposed`, `in-progress`, or `needs-rework`

**If no sprint number was provided:**
- Load the most recent PlanSpec
- Find the first sprint contract with status `proposed` or `needs-rework`
- If all sprints are `completed`, tell the user all sprints are done
- If a sprint is `in-progress`, resume it

**Validate dependencies:**
- Check that all sprints listed in `dependsOn` have status `completed`
- If any dependency is not complete, tell the user which sprints must be completed first

Read the identified contract and the parent PlanSpec.

## Step 2: Contract Negotiation (if status is "proposed")

When a contract status is `proposed`, it has not yet been reviewed for executability. Run a brief negotiation phase:

1. **Review the success criteria** in the contract. For each criterion, assess:
   - Is the `verificationMethod` actually executable given the current project setup?
   - Is the criterion specific enough that pass/fail is unambiguous?
   - Can the Evaluator actually verify this criterion independently?

2. **Review the evaluator strategies** in `bober.config.json`. For each strategy:
   - Is the required tooling installed? (e.g., if `playwright` is a strategy, is Playwright installed?)
   - Are the configured commands valid? (e.g., does `commands.test` actually run?)

3. **Adjust if needed:**
   - If a criterion is too vague, make it more specific
   - If a verification method requires tooling that is not set up, either:
     - Add a setup step to the sprint
     - Change the verification method to something available
     - Mark the criterion as `required: false` if it cannot be verified
   - If the sprint scope is too large for the configured sprint size, flag this to the user

4. **Update the contract** status to `in-progress` and save it back to `.bober/contracts/`

5. **Append to `.bober/history.jsonl`:**
   ```json
   {"event":"sprint-started","contractId":"...","specId":"...","timestamp":"..."}
   ```

## Step 3: Build the Context Handoff

Build a ContextHandoff document for the Generator. This document is the ONLY context the Generator subagent receives — it must be self-contained.

**ContextHandoff structure:**
```json
{
  "handoffId": "handoff-<contractId>-gen-<iteration>",
  "type": "to-generator",
  "contractId": "<contract ID>",
  "specId": "<spec ID>",
  "timestamp": "<ISO-8601>",
  "iteration": 1,
  "context": {
    "projectOverview": "<Brief project description from PlanSpec>",
    "completedSprints": [
      {
        "contractId": "<ID>",
        "title": "<title>",
        "summary": "<what was built>"
      }
    ],
    "currentBranch": "<git branch name>",
    "relevantFiles": [
      "<key files the generator should read>"
    ]
  },
  "contract": { "<full SprintContract object>" },
  "config": {
    "commands": { "<commands section from bober.config.json>" },
    "generator": { "<generator section from bober.config.json>" }
  },
  "principles": "<full text of .bober/principles.md or null>",
  "evaluatorFeedback": null
}
```

Save the handoff to `.bober/handoffs/<handoffId>.json`.

**For retry iterations** (iteration > 1), include the evaluator's feedback:
```json
{
  "evaluatorFeedback": {
    "evalId": "<ID of the failed evaluation>",
    "failedCriteria": [
      {
        "criterionId": "sc-1-2",
        "description": "<what failed>",
        "feedback": "<evaluator's detailed feedback>",
        "file": "<file path if applicable>",
        "line": "<line number if applicable>"
      }
    ],
    "regressions": ["<any regressions found>"],
    "generatorFeedback": ["<structured feedback items>"]
  }
}
```

## Step 4: Spawn the Curator Subagent (once per sprint)

Check if `curator.enabled` is `true` in `bober.config.json` (default: true). If enabled, spawn a curator subagent ONCE before the first generator attempt to produce a Sprint Briefing.

**Skip the curator if:**
- `curator.enabled` is `false` in config
- A briefing already exists at `.bober/briefings/<contractId>-briefing.md` (from a previous run)

**Use the Agent tool to spawn the curator:**

```
Agent tool call:
  description: "Curate sprint <N>: <sprint title>"
  subagent_type: bober-curator
  mode: auto
  prompt: <the prompt below>
```

**Curator prompt:**

```
You are the Bober Curator subagent. You have been spawned by the orchestrator to produce a Sprint Briefing.

## Sprint Contract
Read from: .bober/contracts/<contractId>.json

## Project Overview
Plan: <spec title>
Description: <spec description>

## Completed Sprints
<list completed sprint titles and what they built, or "No prior sprints completed.">

## Project Root
<project root path>

## Instructions
1. Read the sprint contract at .bober/contracts/<contractId>.json
2. For each file in estimatedFiles: read it, extract relevant sections, trace imports
3. Find existing utilities the generator should reuse (search src/utils/, src/lib/, src/helpers/)
4. Find test files similar to what this sprint needs — extract patterns
5. Check .bober/principles.md, README.md, architecture docs
6. Identify files/tests that may be affected by the changes (grep for imports)
7. Determine implementation sequence based on dependencies
8. Save the Sprint Briefing to .bober/briefings/<contractId>-briefing.md

Your final response must contain ONLY a JSON object (no markdown fences):
{
  "contractId": "<contract ID>",
  "briefingPath": ".bober/briefings/<contractId>-briefing.md",
  "filesAnalyzed": ["<files you read>"],
  "patternsFound": <number>,
  "utilsIdentified": <number>,
  "summary": "<2-3 sentence summary>"
}
```

**After the curator subagent returns:**
1. Verify the briefing was saved: check `.bober/briefings/<contractId>-briefing.md` exists
2. Do NOT read the full briefing into orchestrator context — the generator reads it from disk

## Step 5: Spawn the Generator Subagent

**Before spawning:**
1. Ensure the correct git branch exists and is checked out:
   ```bash
   git checkout -b bober/<feature-slug> 2>/dev/null || git checkout bober/<feature-slug>
   ```
2. If this is a retry, the Generator should be on the same branch with the previous attempt's code still present.

**Use the Agent tool to spawn the generator:**

```
Agent tool call:
  description: "Sprint <N>: <sprint title>"
  subagent_type: bober-generator
  mode: auto
  prompt: <the full prompt below>
```

IMPORTANT: Use `mode: auto` or `mode: bypassPermissions` — the generator needs full write access to create/edit files, run bash commands, and commit.

**Generator prompt:**

IMPORTANT: Do NOT paste the full handoff JSON inline. The handoff has already been saved to disk. Reference the file path instead — this keeps the orchestrator's context lean.

```
You are the Bober Generator subagent. You have been spawned by the orchestrator to implement a sprint.

## Context Handoff
Read the full handoff from: .bober/handoffs/<handoffId>.json

## Sprint Briefing
Read the curated Sprint Briefing FIRST (if it exists): .bober/briefings/<contractId>-briefing.md
The briefing contains pre-analyzed code patterns, utilities to reuse, affected files, testing patterns, and implementation sequence. Start here before exploring the codebase.

## Instructions
1. Read the Sprint Briefing at .bober/briefings/<contractId>-briefing.md (if it exists)
2. Read the handoff at .bober/handoffs/<handoffId>.json
3. Read the SprintContract at .bober/contracts/<contractId>.json
4. Read the PlanSpec at .bober/specs/<specId>.json for broader context
5. Read bober.config.json for commands configuration
6. Read .bober/principles.md if it exists — adhere to all principles strictly
7. Read the files listed in the contract's estimatedFiles
8. Implement the sprint according to the contract's success criteria
9. Self-verify: run build, typecheck, lint, and test commands
10. Commit your changes (format: "bober(<sprint-N>): <description>")
11. Work on the feature branch, never on main/master

<IF iteration > 1>
## IMPORTANT — This is a RETRY (iteration <N>)
The previous attempt failed evaluation. Here is the evaluator's feedback:
<paste evaluator feedback JSON>

Focus on fixing the specific failures listed above.
</IF>

## Your Response
When done, respond with EXACTLY this JSON structure (no other text):
{
  "contractId": "<contract ID>",
  "status": "complete | partial | blocked",
  "criteriaResults": [
    {"criterionId": "sc-X-Y", "met": true/false, "evidence": "<evidence>"}
  ],
  "filesChanged": [
    {"path": "<path>", "action": "created | modified | deleted", "description": "<what>"}
  ],
  "testsAdded": ["<test files>"],
  "commits": ["<hash> - <message>"],
  "blockers": ["<issues>"],
  "notes": "<context for evaluator>"
}
```

**After the Generator subagent returns:**
1. Parse the generator's response to extract the completion report.
2. Verify commits were made: `git log --oneline -5`
3. Save the generator report to `.bober/handoffs/gen-report-<contractId>-<iteration>.json`
4. If the generator subagent crashed or returned an error, mark the sprint as `needs-rework` with note "Generator subagent failed".

## Step 6: Spawn the Evaluator Subagent

**Use the Agent tool to spawn the evaluator:**

```
Agent tool call:
  description: "Evaluate sprint <N>: <sprint title>"
  subagent_type: bober-evaluator
  mode: auto
  prompt: <the full prompt below>
```

NOTE: The evaluator needs `mode: auto` for bash access (running tests, builds). It has no write/edit tools by agent definition.

**Evaluator prompt:**

IMPORTANT: Do NOT paste the full contract or config JSON inline. Reference file paths instead — this keeps the orchestrator's context lean. Only include the generator's completion report and minimal context identifiers.

```
You are the Bober Evaluator subagent. You have been spawned by the orchestrator to evaluate a sprint.

## Sprint Contract
Read from: .bober/contracts/<contractId>.json

## Generator's Completion Report
<paste the generator's completion report JSON — this is small and needed for context>

## Context
- Contract ID: <contractId>
- Spec ID: <specId>
- Sprint: <N> of <total>
- Iteration: <N>
- Branch: <current branch>
- Changed files (per generator): <list of files>

## Instructions
1. Read the SprintContract at .bober/contracts/<contractId>.json
2. Read bober.config.json for configured eval strategies and commands
3. Read .bober/principles.md if it exists — check adherence
4. Run each configured evaluation strategy using the commands from config
5. Verify EVERY success criterion one by one
6. Check for regressions
7. Produce a structured EvalResult

IMPORTANT: You do NOT have Write or Edit tools. Output the EvalResult JSON in your response.

## Your Response
Respond with EXACTLY this JSON structure (no other text):
{
  "evalId": "eval-<contractId>-<iteration>",
  "contractId": "<contract ID>",
  "specId": "<spec ID>",
  "timestamp": "<ISO-8601>",
  "iteration": <N>,
  "overallResult": "pass | fail",
  "score": { "criteriaTotal": N, "criteriaPassed": N, "criteriaFailed": N, "criteriaSkipped": N, "requiredPassed": N, "requiredFailed": N, "requiredTotal": N },
  "strategyResults": [ {"strategy": "<type>", "required": true/false, "result": "pass|fail|skipped", "output": "<output>", "details": "<details>"} ],
  "criteriaResults": [ {"criterionId": "sc-X-Y", "description": "<desc>", "required": true/false, "result": "pass|fail|skipped", "evidence": "<evidence>", "feedback": "<if failed>"} ],
  "regressions": [],
  "generatorFeedback": [],
  "summary": "<2-3 sentence summary>"
}
```

**After the Evaluator subagent returns:**
1. Parse the evaluator's response to extract the EvalResult.
2. Save the EvalResult to `.bober/eval-results/eval-<contractId>-<iteration>.json` (the evaluator cannot write files).
3. Determine pass/fail from the `overallResult` field.

## Step 7: Process Evaluation Result

### If the sprint PASSES:

1. **Update the contract status** to `completed`:
   ```json
   { "status": "completed", "completedAt": "<ISO-8601>" }
   ```
   Save to `.bober/contracts/<contractId>.json`

2. **Update `.bober/progress.md`:**
   Change the sprint's status from `[in-progress]` to `[completed]`

3. **Append to `.bober/history.jsonl`:**
   ```json
   {"event":"sprint-completed","contractId":"...","specId":"...","iteration":N,"timestamp":"..."}
   ```

4. **Report success to the user:**
   ```
   === Sprint <N> PASSED on iteration <M> ===

   Completed: <sprint title>
   Key results:
   - <criterion 1>: PASS
   - <criterion 2>: PASS
   ...

   Next sprint: <next sprint title> (run /bober-sprint to continue)
   ```

### If the sprint FAILS and retries remain:

Check `evaluator.maxIterations` from `bober.config.json` (default: 3). If the current iteration is less than `maxIterations`:

1. **Log the failure:**
   ```json
   {"event":"sprint-iteration-failed","contractId":"...","iteration":N,"failedCriteria":["sc-1-2"],"timestamp":"..."}
   ```

2. **Create a retry handoff** (go back to Step 3 with `iteration + 1` and include evaluator feedback)

3. **Report the retry to the user:**
   ```
   === Sprint <N> iteration <M> FAILED ===
   <X> of <Y> criteria not met.
   Retrying (iteration <M+1> of <maxIterations>)...

   Failed criteria:
   - <criterion>: <brief reason>
   ```

4. **Go to Step 4** (spawn a FRESH Generator subagent with feedback)

### If the sprint FAILS and no retries remain:

1. **Update the contract status** to `needs-rework`:
   ```json
   { "status": "needs-rework", "lastEvalId": "<eval ID>" }
   ```

2. **Update `.bober/progress.md`:**
   Change the sprint's status to `[needs-rework]`

3. **Append to `.bober/history.jsonl`:**
   ```json
   {"event":"sprint-failed","contractId":"...","specId":"...","totalIterations":N,"timestamp":"..."}
   ```

4. **Report failure to the user with full context:**
   ```
   === Sprint <N> FAILED after <maxIterations> iterations ===

   Contract: <contract title>
   Failed criteria:
   - <criterion>: <detailed failure description>

   Last evaluator feedback:
   <structured feedback>

   Recommended actions:
   - Review the failed criteria and evaluator feedback
   - Consider simplifying the sprint scope
   - Run /bober-sprint <N> to retry from scratch
   - Run /bober-plan to revise the plan
   ```

## Step 8: Context Reset

After a sprint completes (pass or fail), manage context:

Read `pipeline.contextReset` from config:
- `always`: Each subagent already gets a fresh context. This is the default behavior.
- `on-threshold`: Same as `always` with subagent architecture.
- `never`: Include richer context summaries in the handoff for the next sprint.

## Error Handling

- **Subagent crash/timeout:** If the Agent tool call fails, log the error. Do not let it crash the orchestration. Mark the sprint appropriately and report to the user.
- **Subagent returns malformed response:** Read files on disk as the source of truth. The subagent may have saved files correctly even if its text response was garbled.
- **Generator fails to produce any output:** Mark sprint as `needs-rework` with note "Generator produced no output"
- **Evaluator cannot run strategies:** Report which strategies failed to execute and why. If a required strategy cannot run, mark sprint as `needs-rework` with a configuration issue note.
- **Git conflicts:** Report the conflict to the user. Do not auto-resolve.
- **Build broken before sprint started:** Verify the build passes BEFORE spawning the Generator. If the build is already broken, report this and do not proceed.
- **Missing dependencies:** If `npm install` or equivalent has not been run, run it before starting.

## Next Steps

After completing this phase, suggest the following next steps to the user:
- `/bober-eval` — Evaluate the current sprint output independently
- `/bober-sprint` — Execute the next sprint in the plan


---

<!-- Reference: contract-schema.md -->

# SprintContract JSON Schema

This document defines the complete schema for SprintContract documents. Sprint contracts are the binding agreement between the Planner, Generator, and Evaluator for a single sprint.

## Location

SprintContract files are stored at: `.bober/contracts/<contractId>.json`

## Naming Convention

- `contractId` format: `sprint-<specId>-<sprint-number>`
- Example: `sprint-spec-20260326-user-auth-1`
- Sprint numbers are 1-indexed (first sprint is 1, not 0)

## Full Schema

```json
{
  "contractId": "string (required)",
  "specId": "string (required, references parent PlanSpec)",
  "sprintNumber": "number (required, 1-indexed)",
  "title": "string (required, concise sprint title)",
  "description": "string (required, what this sprint delivers)",
  "status": "string (required, one of: proposed, in-progress, completed, needs-rework)",
  "createdAt": "string (required, ISO-8601)",
  "updatedAt": "string (required, ISO-8601)",
  "completedAt": "string (optional, ISO-8601, set when status becomes completed)",

  "dependsOn": [
    "string — contractId references for sprints that must complete before this one"
  ],

  "features": [
    "string — featureId references from the parent PlanSpec"
  ],

  "successCriteria": [
    {
      "criterionId": "string (required, format: sc-<sprint>-<index>)",
      "description": "string (required, specific testable criterion)",
      "verificationMethod": "string (required, one of: manual, typecheck, lint, unit-test, playwright, api-check, build, custom)",
      "required": "boolean (required, true = must pass for sprint to pass)",
      "customCommand": "string (optional, command to run for custom verification)"
    }
  ],

  "generatorNotes": "string (required, guidance for the Generator agent)",
  "evaluatorNotes": "string (required, guidance for the Evaluator agent)",

  "estimatedFiles": [
    "string — file paths expected to be created or modified"
  ],

  "estimatedDuration": "string (required, one of: small, medium, large)",

  "iterationHistory": [
    {
      "iteration": "number",
      "evalId": "string — reference to EvalResult",
      "result": "string (pass | fail)",
      "timestamp": "string (ISO-8601)"
    }
  ],

  "lastEvalId": "string (optional, reference to most recent EvalResult)"
}
```

## Field Descriptions

### Core Fields

| Field | Description |
|-------|-------------|
| `contractId` | Unique identifier. Generated by the Planner. Never changes. |
| `specId` | Reference to the parent PlanSpec. Used to load broader context. |
| `sprintNumber` | Position in the sprint sequence. 1-indexed. |
| `title` | Concise description of what this sprint delivers. Should start with a verb: "Implement...", "Add...", "Create...". |
| `description` | 2-4 sentences describing the sprint's deliverables and scope. |
| `status` | Lifecycle state. See Status Transitions below. |

### Status Transitions

```
proposed → in-progress → completed
                ↓
          needs-rework → in-progress → completed
```

- `proposed`: Created by the Planner. Not yet started or reviewed.
- `in-progress`: Contract negotiated and Generator is working on it.
- `completed`: All required success criteria passed evaluation.
- `needs-rework`: Failed evaluation after maximum iterations. Requires human intervention or plan revision.

### Dependencies

| Field | Description |
|-------|-------------|
| `dependsOn` | Array of `contractId` values that must have status `completed` before this sprint can start. Empty array for the first sprint. |
| `features` | Array of `featureId` values from the parent PlanSpec that this sprint implements (partially or fully). |

### Success Criteria

Each success criterion is a single testable statement that the Evaluator checks independently.

| Field | Description |
|-------|-------------|
| `criterionId` | Unique within the contract. Format: `sc-<sprintNumber>-<index>` (1-indexed). |
| `description` | Specific, testable criterion. Must describe observable behavior or measurable outcome. |
| `verificationMethod` | How the Evaluator should verify this criterion. |
| `required` | If `true`, this criterion MUST pass for the sprint to pass. If `false`, it is advisory. |
| `customCommand` | Only for `verificationMethod: "custom"`. The command the Evaluator should run. |

### Verification Methods

| Method | What the Evaluator Does |
|--------|------------------------|
| `manual` | Reads source code and assesses whether the criterion is met based on code inspection and logic tracing. |
| `typecheck` | Runs the configured typecheck command. Criterion passes if zero type errors. |
| `lint` | Runs the configured lint command. Criterion passes if zero lint errors (warnings OK). |
| `unit-test` | Runs the configured test command. Criterion passes if all tests pass. |
| `playwright` | Runs Playwright E2E tests. Criterion passes if all relevant E2E tests pass. |
| `api-check` | Tests specific API endpoints using curl or similar. Criterion passes if responses match expectations. |
| `build` | Runs the configured build command. Criterion passes if build succeeds with exit code 0. |
| `custom` | Runs `customCommand` and interprets the result. Exit code 0 = pass. |

### Agent Notes

| Field | Description |
|-------|-------------|
| `generatorNotes` | Free-form guidance for the Generator. Should include: key files to examine for patterns, known gotchas, suggested implementation order, references to similar existing code. |
| `evaluatorNotes` | Free-form guidance for the Evaluator. Should include: specific things to test, edge cases to check, how to verify UI criteria, expected API response shapes. |

### Estimates

| Field | Description |
|-------|-------------|
| `estimatedFiles` | Array of file paths the Generator is expected to create or modify. This is advisory -- the Generator may touch additional files if needed. The Evaluator uses this to check for unexpected changes. |
| `estimatedDuration` | Relative size estimate: `small` (30-60 min), `medium` (1-3 hours), `large` (3-5 hours). |

### Iteration History

| Field | Description |
|-------|-------------|
| `iterationHistory` | Array of past evaluation attempts. Appended after each evaluation. |
| `lastEvalId` | Reference to the most recent EvalResult. Updated after each evaluation. |

## Complete Example

```json
{
  "contractId": "sprint-spec-20260326-user-auth-1",
  "specId": "spec-20260326-user-auth",
  "sprintNumber": 1,
  "title": "Implement user registration with form and API",
  "description": "Create the user registration flow end-to-end: a React registration form with email, password, and confirm-password fields; an Express API endpoint that validates input and creates a user record in PostgreSQL with a bcrypt-hashed password; and basic form validation on both client and server.",
  "status": "proposed",
  "createdAt": "2026-03-26T10:00:00Z",
  "updatedAt": "2026-03-26T10:00:00Z",
  "completedAt": null,

  "dependsOn": [],

  "features": ["feat-1"],

  "successCriteria": [
    {
      "criterionId": "sc-1-1",
      "description": "The project builds successfully with zero errors.",
      "verificationMethod": "build",
      "required": true
    },
    {
      "criterionId": "sc-1-2",
      "description": "TypeScript compilation produces zero type errors.",
      "verificationMethod": "typecheck",
      "required": true
    },
    {
      "criterionId": "sc-1-3",
      "description": "A registration form component exists at the /register route with email, password, and confirm-password input fields, each with an associated label.",
      "verificationMethod": "manual",
      "required": true
    },
    {
      "criterionId": "sc-1-4",
      "description": "POST /api/auth/register accepts { email, password } and returns 201 with { id, email } on success.",
      "verificationMethod": "api-check",
      "required": true
    },
    {
      "criterionId": "sc-1-5",
      "description": "POST /api/auth/register returns 400 with an error message when email is already registered.",
      "verificationMethod": "api-check",
      "required": true
    },
    {
      "criterionId": "sc-1-6",
      "description": "The password is stored as a bcrypt hash in the database, never in plain text.",
      "verificationMethod": "manual",
      "required": true
    },
    {
      "criterionId": "sc-1-7",
      "description": "Client-side validation shows an error when password is shorter than 8 characters before form submission.",
      "verificationMethod": "manual",
      "required": true
    },
    {
      "criterionId": "sc-1-8",
      "description": "ESLint reports zero errors on all new and modified files.",
      "verificationMethod": "lint",
      "required": false
    }
  ],

  "generatorNotes": "Look at existing route definitions in src/routes/ for the Express routing pattern. The project uses Prisma -- check prisma/schema.prisma for the existing schema and add a User model. Use bcrypt (already in package.json) for password hashing. For the React form, follow the pattern in src/components/ -- the project uses controlled components with useState. The registration form should be at src/pages/Register.tsx and the route added to src/App.tsx.",

  "evaluatorNotes": "For sc-1-3: Read the Register component source and verify it renders three labeled input fields. For sc-1-4 and sc-1-5: Start the dev server and use curl to test the endpoint. For sc-1-6: Read the route handler code and verify bcrypt.hash is called before database insertion. For sc-1-7: Read the form component code and verify client-side validation logic exists for password length.",

  "estimatedFiles": [
    "prisma/schema.prisma",
    "src/routes/auth.ts",
    "src/pages/Register.tsx",
    "src/App.tsx"
  ],

  "estimatedDuration": "medium",

  "iterationHistory": [],
  "lastEvalId": null
}
```

## Writing Good Success Criteria

### Do

- Start with an observable action or state: "The form displays...", "The API returns...", "The database contains..."
- Include specific values: "returns 201", "displays 'Invalid email'", "at least 8 characters"
- Map each criterion to exactly one verification method
- Include at least one `build` criterion and one functional criterion per sprint
- Write criteria the Evaluator can verify without guessing

### Do Not

- Use subjective language: "looks good", "works well", "clean code"
- Combine multiple checks in one criterion (split them)
- Reference internal implementation details unless checking them IS the criterion
- Write criteria that require human visual judgment (unless verification method is `manual` and the check is code-inspectable)
- Assume the Evaluator has context beyond the contract and handoff documents
