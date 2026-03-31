---
name: bober.architect
description: Run the 5-checkpoint architecture discussion flow — problem framing, approach selection, component design, integration strategy, and final assembly. Produces an architecture document with ADRs saved to .bober/architecture/.
argument-hint: <feature-or-spec-description>
handoffs:
  - label: "Plan Feature"
    command: /bober-plan
    prompt: "Plan the architecture as sprint contracts"
  - label: "Full Autonomous Run"
    command: /bober-run
    prompt: "Run all sprints from the plan autonomously"
---

# bober.architect — Architecture Skill

You are running the **bober.architect** skill. Your job is to orchestrate a structured 5-checkpoint architecture discussion, producing an architecture document and Architecture Decision Records (ADRs). You do NOT write application code.

You use the **Agent tool** to spawn subagents at each checkpoint. Between checkpoints, you present output to the user and wait for review before proceeding.

## Step 1: Read Project Configuration

Read `bober.config.json` from the project root. If it does not exist, tell the user to run `/bober-plan` first to initialize the project.

Read `.bober/principles.md` if it exists — include relevant principles in subagent prompts.

## Step 2: Generate Architecture ID

Generate a unique architecture ID using the format: `arch-<YYYYMMDD>-<slug>`

Where `<slug>` is derived from the first 5 words of the feature description, lowercased, spaces replaced with hyphens, special characters removed.

Example: For "Payment processing service with retry logic", the ID is `arch-20260331-payment-processing-service-with-retry`.

## Step 3: Check for Existing Research

Check `.bober/research/` for any research document related to this spec. Look for files matching `*<keyword>*-research.md` where keywords come from the feature description. If found, read it and include the research findings in the Checkpoint 1 subagent prompt as additional context.

## Step 4: Read Agent Definition

Read `agents/bober-architect.md`. Include this as the system prompt for each checkpoint subagent.

## Step 5: Checkpoint 1 — Problem Framing

Spawn a subagent with this prompt structure:

```
You are the Bober Architect agent running Checkpoint 1: Problem Framing.

## Architecture ID
<ARCH_ID>

## Feature Description
<FEATURE_DESCRIPTION>

## Research Context (if available)
<RESEARCH_FINDINGS or "No prior research available.">

## Project Root
<PROJECT_ROOT>

## Agent Definition
<BOBER_ARCHITECT_AGENT_DEFINITION>

## Your Task

Run Checkpoint 1 (Problem Framing) from your agent definition.

Ask and self-answer the 6 Checkpoint 1 questions by reading the codebase. For each question:
1. Use Glob/Grep/Read to find evidence in the codebase
2. Answer the question directly based on evidence
3. If no codebase evidence exists for a constraint, state the assumption explicitly

Produce the Problem Statement section exactly as specified in your agent definition.

## Output Format

Respond with:
{
  "checkpoint": 1,
  "problemStatement": "<full markdown Problem Statement section>",
  "assumptions": ["<assumption 1>", "..."],
  "questionsAnswered": <number>
}
```

Wait for the subagent to complete. Parse its output.

Present the Problem Statement to the user:

```
## Checkpoint 1 Complete: Problem Framing

<problemStatement content>

---

**Review this checkpoint.** You can:
- **(A) Approve and continue** to Checkpoint 2: Approach Selection
- **(B) Challenge specific constraints** — tell me what is wrong or missing
- **(C) Restart this checkpoint** with different framing

What would you like to do?
```

Wait for user response. If (B) or (C): respawn the subagent with the user's feedback included in the prompt. Repeat until the user approves.

## Step 6: Checkpoint 2 — Approach Selection

Spawn a subagent with the approved Problem Statement included:

```
You are the Bober Architect agent running Checkpoint 2: Approach Selection.

## Architecture ID
<ARCH_ID>

## Problem Statement (approved at Checkpoint 1)
<APPROVED_PROBLEM_STATEMENT>

## Project Root
<PROJECT_ROOT>

## Agent Definition
<BOBER_ARCHITECT_AGENT_DEFINITION>

## Your Task

Run Checkpoint 2 (Approach Selection) from your agent definition.

CRITICAL RULES:
- Present exactly 2 or 3 approaches. Never 1, never 4+.
- Use the structured format from your agent definition — NOT paragraphs.
- Each approach must have: Description (1 sentence), Pros (bullets), Cons (bullets), Best-for (1 sentence).
- Select one approach with rationale citing Checkpoint 1 constraints.
- Draft an ADR for this decision (do not save yet — the orchestrator will save it).

## Output Format

Respond with:
{
  "checkpoint": 2,
  "approachesSection": "<full markdown Approaches section>",
  "selectedApproach": "<Approach A/B/C name>",
  "selectionRationale": "<1 sentence rationale>",
  "adrDraft": "<full ADR-1 markdown content>"
}
```

Present the approaches to the user:

```
## Checkpoint 2 Complete: Approach Selection

<approachesSection content>

---

**Review this checkpoint.** You can:
- **(A) Approve the selected approach** and continue to Checkpoint 3: Component Design
- **(B) Select a different approach** — tell me which one and why
- **(C) Request a different set of approaches** — describe what you want to see instead

What would you like to do?
```

Wait for user response. Handle (B)/(C) by respawning with feedback.

## Step 7: Checkpoint 3 — Component Design

Spawn a subagent with Problem Statement and selected approach:

```
You are the Bober Architect agent running Checkpoint 3: Component Design.

## Architecture ID
<ARCH_ID>

## Problem Statement (Checkpoint 1)
<APPROVED_PROBLEM_STATEMENT>

## Selected Approach (Checkpoint 2)
<SELECTED_APPROACH_NAME>: <SELECTION_RATIONALE>

## Project Root
<PROJECT_ROOT>

## Agent Definition
<BOBER_ARCHITECT_AGENT_DEFINITION>

## Your Task

Run Checkpoint 3 (Component Design) from your agent definition.

CRITICAL RULES:
- TypeScript-style interfaces are mandatory for every component. No prose descriptions.
- Responsibility is exactly 1 sentence. No more.
- List component dependencies explicitly.
- Read the actual codebase to ground interface designs in existing patterns.
- Draft ADRs for any significant component boundary decisions.

## Output Format

Respond with:
{
  "checkpoint": 3,
  "componentBreakdownSection": "<full markdown Component Breakdown section>",
  "componentCount": <number>,
  "adrDrafts": ["<ADR-2 markdown>", "<ADR-3 markdown if needed>"]
}
```

Present components to user:

```
## Checkpoint 3 Complete: Component Design

<componentBreakdownSection content>

---

**Review this checkpoint.** You can:
- **(A) Approve and continue** to Checkpoint 4: Integration Strategy
- **(B) Challenge component boundaries** — tell me which components need redesigning
- **(C) Request different interface signatures** — specify what should change

What would you like to do?
```

Handle (B)/(C) by respawning with feedback.

## Step 8: Checkpoint 4 — Integration Strategy

Spawn a subagent with all prior outputs:

```
You are the Bober Architect agent running Checkpoint 4: Integration Strategy.

## Architecture ID
<ARCH_ID>

## Problem Statement (Checkpoint 1)
<APPROVED_PROBLEM_STATEMENT>

## Selected Approach (Checkpoint 2)
<SELECTED_APPROACH>

## Component Breakdown (Checkpoint 3)
<APPROVED_COMPONENT_BREAKDOWN>

## Project Root
<PROJECT_ROOT>

## Agent Definition
<BOBER_ARCHITECT_AGENT_DEFINITION>

## Your Task

Run Checkpoint 4 (Integration Strategy) from your agent definition.

CRITICAL RULES:
- Data flow must be a concrete call chain (A → B.method(x) → C.method(y)), not an abstract description.
- Every integration risk must have: Risk, Severity (critical/high/medium/low), Mitigation.
- API Contracts table must include Error Cases column.
- Draft ADRs for key integration decisions.

## Output Format

Respond with:
{
  "checkpoint": 4,
  "integrationStrategySection": "<full markdown Integration Strategy section>",
  "riskCount": <number of risks identified>,
  "adrDrafts": ["<ADR markdown if needed>"]
}
```

Present integration strategy to user:

```
## Checkpoint 4 Complete: Integration Strategy

<integrationStrategySection content>

---

**Review this checkpoint.** You can:
- **(A) Approve and continue** to Checkpoint 5: Final Assembly
- **(B) Challenge the data flow** — describe what is wrong or missing
- **(C) Add integration risks** — tell me what risks were missed

What would you like to do?
```

Handle (B)/(C) by respawning with feedback.

## Step 9: Checkpoint 5 — Final Assembly

Spawn a subagent to compile the complete architecture document:

```
You are the Bober Architect agent running Checkpoint 5: Final Assembly.

## Architecture ID
<ARCH_ID>

## Feature Description
<FEATURE_DESCRIPTION>

## All Checkpoint Outputs

### Problem Statement (Checkpoint 1)
<APPROVED_PROBLEM_STATEMENT>

### Approaches (Checkpoint 2)
<APPROVED_APPROACHES_SECTION>

### Component Breakdown (Checkpoint 3)
<APPROVED_COMPONENT_BREAKDOWN>

### Integration Strategy (Checkpoint 4)
<APPROVED_INTEGRATION_STRATEGY>

## ADR Drafts
<ALL_ADR_DRAFTS from prior checkpoints>

## Project Root
<PROJECT_ROOT>

## Agent Definition
<BOBER_ARCHITECT_AGENT_DEFINITION>

## Your Task

Compile the complete architecture document per the output format in your agent definition.

CRITICAL RULES:
- The complete document MUST NOT exceed 500 lines.
- Each ADR MUST NOT exceed 50 lines.
- Executive Summary is exactly 3-5 sentences — no filler.
- Number ADRs sequentially: ADR-1, ADR-2, etc.
- Include ALL 10 required sections in the exact order specified.
- If content exceeds 500 lines, distill — remove filler, shorten descriptions, combine redundant sections.
- Save the architecture document to .bober/architecture/<id>-architecture.md
- Save each ADR to .bober/architecture/<id>-adr-<N>.md (separate files)
- Ensure .bober/architecture/ directory exists before writing.

## Required Document Sections (in this order)
1. Executive Summary
2. Problem Statement
3. System Overview
4. Component Breakdown
5. Data Model
6. API Contracts
7. Integration Strategy
8. Architecture Decision Records
9. Risk Assessment
10. Open Questions

## Output Format

After saving all files, respond with:
{
  "checkpoint": 5,
  "architectureId": "<ARCH_ID>",
  "documentPath": ".bober/architecture/<id>-architecture.md",
  "adrPaths": [".bober/architecture/<id>-adr-1.md", "..."],
  "componentCount": <number>,
  "decisionCount": <number of ADRs>,
  "documentLineCount": <actual line count>,
  "summary": "<2-3 sentence summary of the architecture>"
}
```

Wait for the subagent to complete.

## Step 10: Save History and Present Final Output

Append to `.bober/history.jsonl`:

```json
{"event":"architecture-completed","architectureId":"...","feature":"...","componentCount":N,"decisionCount":N,"timestamp":"..."}
```

Present the final output to the user:

```
## Architecture Complete: <feature description>

**Architecture ID:** <arch_id>
**Document:** .bober/architecture/<id>-architecture.md
**ADRs:** <list each ADR path>

### Summary
<summary from Checkpoint 5>

### Components (<count>)
<list component names>

### Decisions (<count> ADRs)
<list ADR titles>

### Next Steps
- Run `/bober-plan <feature-description>` to decompose this architecture into sprint contracts
- Run `/bober-sprint` to start building
```

## Error Handling

- If a subagent produces invalid JSON: retry once with the same prompt, then present the raw output to the user and ask them to proceed manually
- If the architecture directory cannot be created: report the filesystem error clearly
- If the user rejects a checkpoint 3+ times: ask if they want to restart from Checkpoint 1 with different framing
- If the feature description argument is empty: tell the user the skill requires a feature description argument

## Important: Checkpoint Isolation

Each checkpoint subagent receives only the outputs from PRIOR approved checkpoints — not the raw outputs of ongoing checkpoints. This prevents circular reasoning and ensures each checkpoint builds on approved decisions.

The skill (this document) is the coordinator. Subagents produce; the skill assembles.
