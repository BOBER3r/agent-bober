---
name: bober-code-review
description: Use when completing a sprint, after evaluator pass — spawns bober-code-reviewer subagent to audit the sprint diff against the contract and anti-pattern catalog, producing an advisory ReviewResult written to .bober/reviews/<contractId>-review.md.
argument-hint: "[contract-id]"
---

> Adapted from [obra/superpowers](https://github.com/obra/superpowers) — MIT License.
> Original: skills/requesting-code-review/.
> Adaptations: agent name (bober-code-reviewer), advisory-only contract, ReviewResult JSON schema, anti-pattern citations from .bober/anti-patterns/.

# bober.code-review — Advisory Code Review Orchestrator

You are the **orchestrator** for a standalone code review run. You do NOT review the code yourself. You spawn the code reviewer as a subagent using the **Agent tool**, then process and save its results to `.bober/reviews/<contractId>-review.md`.

The code reviewer subagent runs in its own isolated context window. It receives ONLY the information you explicitly pass in its prompt.

**Integration with bober pipeline:** In the automated pipeline, bober-code-reviewer is spawned automatically after `runEvaluatorAgent` returns `passed: true` in `src/orchestrator/pipeline.ts`. This skill is for standalone runs — when you want to trigger a review manually outside the normal pipeline flow.

## When to Request Review

**Mandatory in pipeline:** The orchestrator triggers code review automatically after each sprint evaluator pass. You do not need to invoke this skill for normal pipeline runs.

**Use this skill manually when:**
- You completed a sprint manually (outside the pipeline) and want advisory feedback
- You want to re-review a sprint with a different anti-pattern focus
- You want to review a specific file range that the pipeline did not cover

## What the Reviewer Checks

**What to check — findings the reviewer WILL surface:**

- **DRY violations**: New code that duplicates an existing utility verbatim. Cite the duplicate location with file:line evidence.
- **YAGNI violations**: Abstractions added for future use cases not in the contract. Config options wired but never read.
- **Dead code**: Functions defined but never called; exports with zero import sites in the diff.
- **Missing tests**: Changed behavior with no new test coverage; tests that only check the happy path.
- **Anti-pattern matches** from `.bober/anti-patterns/`:
  - Testing Mock Behavior, Test-Only Methods in Production → `.bober/anti-patterns/testing-anti-patterns.md`
  - Arbitrary-delay waiting (`setTimeout`/`sleep`) → `.bober/anti-patterns/condition-based-waiting.md`
  - Symptom-fix instead of root-cause → `.bober/anti-patterns/root-cause-tracing.md`
  - Single-layer validation (missing defense-in-depth) → `.bober/anti-patterns/defense-in-depth.md`
- **Silent error swallowing**: `catch {}` with no log or rethrow; errors absorbed without surfacing
- **TypeScript `any` types** without a comment explaining why

**What NOT to flag — the reviewer MUST drop these:**

- Style preferences (indentation, line length, trailing commas when file is internally consistent)
- Naming opinions when the name is consistent with the surrounding file
- Theoretical risks without an observed trigger (speculation without evidence)
- Decisions the planner already resolved — re-litigating settled choices is scope creep
- Pre-existing code that was NOT changed in this sprint

## Acting on Feedback

Because the review is advisory (it never blocks sprint completion), severity signals what to do NEXT:

- **Critical**: Warrants a dedicated fix sprint. The finding has file:line evidence and an observed trigger. Prioritize addressing this before the next feature sprint.
- **Important**: Address before shipping this feature broadly. Worth tracking in the backlog.
- **Minor**: Note for future housekeeping. Do not delay other work for these.

Even Critical findings do NOT trigger a generator retry. The sprint is complete. The review surfaces information for planning the next sprint.

## Process Flow

### Step 1: Identify the Target Contract

**If a contract ID was provided as an argument:**
- Load the contract from `.bober/contracts/<contractId>.json`
- Verify the contract status is `passed` — review runs after evaluator pass

**If no contract ID was provided:**
- Find the most recently passed contract from `.bober/contracts/`
- If no passed contracts exist, tell the user there is nothing to review

Read the contract and its parent PlanSpec.

### Step 2: Gather Context

Read `bober.config.json` for commands and evaluator config.
Read `.bober/principles.md` if it exists.

Check the git status:
```bash
git log --oneline -5
git diff HEAD~1 --stat
```

### Step 3: Spawn the Code Reviewer Subagent

Use the **Agent tool** to spawn a code reviewer subagent.

```
Agent tool call:
  description: "Code Review: <sprint title>"
  subagent_type: bober-code-reviewer
  mode: auto
  prompt: <the full prompt below>
```

**Build the reviewer prompt with ALL of these sections:**

```
You are the Bober Code Reviewer subagent. You have been spawned to advisory-review a sprint that already passed evaluation.

## Sprint Contract
<paste the full SprintContract JSON from .bober/contracts/<contractId>.json>

## Evaluation Result (Already Passed)
<paste the EvaluationRunResult JSON — key fields: passed: true, summary, score>

## Project Configuration
Commands:
<paste the commands section from bober.config.json>

## Project Root
<absolute path to the project root>

## Context
- Contract ID: <contractId>
- Spec ID: <specId>
- Review is ADVISORY ONLY — findings do not block completion or trigger retries

## Anti-Pattern Catalog
The catalog index is at .bober/anti-patterns/README.md. Consult it BEFORE classifying severity.
Catalogued anti-patterns:
- Testing anti-patterns → .bober/anti-patterns/testing-anti-patterns.md
- Condition-based waiting → .bober/anti-patterns/condition-based-waiting.md
- Root-cause tracing → .bober/anti-patterns/root-cause-tracing.md
- Defense in depth → .bober/anti-patterns/defense-in-depth.md

## Your Task
Review the sprint diff. Produce a ReviewResult JSON. Output ONLY the JSON — no text outside it.
```

### Step 4: Process and Save the Result

When the subagent returns:

1. Parse the ReviewResult JSON from its response
2. Render the markdown review document (6 required sections):

```markdown
# Code Review: <contractId>

## Summary

<paste summary field>

## Critical

<for each finding in critical array: description + evidence>
<if empty: "No critical findings.">

## Important

<for each finding in important array>
<if empty: "No important findings.">

## Minor

<for each finding in minor array>
<if empty: "No minor findings.">

## Approved Areas

<for each item in approvedAreas: bullet>
<if empty: "No areas specifically called out.">
```

3. Save to `.bober/reviews/<contractId>-review.md`
4. Report a summary to the user: counts of critical/important/minor findings

## Red Flags - STOP

- About to spawn the reviewer before checking that the sprint status is `passed`
- About to save a review for a contract that never passed evaluation
- About to treat Critical findings as blocking (they are advisory — the sprint is done)
- About to skip reading `.bober/anti-patterns/README.md` before the reviewer prompt

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "The sprint passed, so there is nothing to review" | Passing evaluation is a correctness bar, not a quality bar. Code review adds a separate signal. |
| "Critical findings mean I should trigger a rework" | No. Advisory means advisory. The sprint is complete. Plan a fix sprint if needed. |
| "The reviewer ran out of context — I will skip saving the file" | Save what you have. An empty review with just a Summary is better than no record. |
| "Different words so rule doesn't apply" | Spirit over letter. |
