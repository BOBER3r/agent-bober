---
name: bober.principles
description: "Define and maintain project principles that guide all planning, generation, and evaluation. Establishes the non-negotiable standards for your project."
argument-hint: "[optional principles to add]"
handoffs:
  - label: "Plan Feature"
    command: /bober-plan
    prompt: "Plan a feature guided by these principles"
---

# bober.principles — Project Principles Skill

You are running the **bober.principles** skill. Your job is to help the user define or update the project principles that guide all planning, generation, and evaluation in the Bober pipeline.

## Step 1: Check for Existing Principles

Check if `.bober/principles.md` exists in the project root.

**If `.bober/principles.md` EXISTS:**

Read and display the current principles to the user:

```
Here are your current project principles:

<contents of .bober/principles.md>

Would you like to:
A) Keep these as-is
B) Update specific sections
C) Start over with new principles
```

If the user wants to update, proceed to Step 3 with the existing content as a starting point.

**If `.bober/principles.md` does NOT exist:**

Proceed to Step 2.

## Step 2: Interview the User

Ask the user 3-5 targeted questions to understand their project principles. Adapt the questions based on whether `bober.config.json` exists and what it reveals about the project type.

```
I'll help you define your project principles. These will guide every plan, sprint, and evaluation.

**Q1: Mission — What is the primary goal of this project?**
What problem are you solving, and for whom? (e.g., "A task manager that helps remote teams stay organized" or "An NFT marketplace for digital artists")

**Q2: Users — Who are the primary users?**
A) Developers / technical users
B) Non-technical end users
C) Both technical and non-technical users
D) Internal team / enterprise users
E) Other (please describe)

**Q3: Quality Standards — What quality bars matter most?**
Pick your top 2-3 priorities:
A) Performance (fast load times, low latency, efficient gas usage)
B) Accessibility (WCAG compliance, screen reader support)
C) Security (audit-ready code, input validation, access control)
D) Reliability (error handling, graceful degradation, uptime)
E) Developer experience (clean APIs, good docs, easy onboarding)
F) Test coverage (comprehensive tests, CI/CD gates)

**Q4: Technical Principles — What patterns or technologies should be followed or avoided?**
Examples:
- "Always use TypeScript strict mode"
- "Prefer composition over inheritance"
- "No external dependencies unless absolutely necessary"
- "Follow the existing codebase conventions exactly"
- "Use OpenZeppelin contracts for all standard functionality"

**Q5: Design Principles — What is the visual/UX style?** (if applicable)
A) Minimalist — clean, lots of whitespace, essential elements only
B) Data-dense — dashboards, tables, power-user focused
C) Playful — colorful, animated, engaging
D) Professional — corporate, trustworthy, conservative
E) Not applicable (no UI in this project)
F) Other (please describe)
```

## Step 2a: Expand Raw Input (if user provides a prompt/argument)

If the user provides text with this command — whether a short note like `"performance-first, minimal dependencies"` or a long paste of requirements, a PRD, or rough notes — your job is to **intelligently expand and elevate** that input into a polished principles document:

1. **Extract** all implicit and explicit principles from the user's input
2. **Expand** vague statements into specific, actionable standards. Example: "make it fast" → "**Performance:** Target < 3s initial page load. Use code splitting and lazy loading. Optimize images with next/image or equivalent. No blocking API calls on initial render."
3. **Infer** principles the user didn't state but clearly imply. If they describe a medical SaaS product, infer security and compliance principles. If they describe a DeFi protocol, infer audit-readiness and gas optimization.
4. **Organize** everything into the principles document structure (Mission, Users, Quality Standards, Technical Principles, Design Principles)
5. **Fill gaps** by asking 1-2 targeted follow-up questions ONLY for things you truly cannot infer. Don't ask obvious questions.

The goal: the user pastes rough notes, you produce a comprehensive, opinionated principles document that makes them say "yes, exactly — and I didn't even think of those."

Skip the interview (Step 2) entirely when the user provides substantive input. Go straight to generating the document.

## Step 3: Generate Principles Document

Based on the user's answers, generate `.bober/principles.md` with the following structure:

```markdown
# Project Principles

> These principles guide all planning, generation, and evaluation in the Bober pipeline.
> Updated: <date>

## Mission

<One-line project purpose derived from user's answer>

## Users

<Who this project is for, their technical level, their primary needs>

## Quality Standards

<Non-negotiable quality bars, ordered by priority>

- **<Standard 1>:** <Description of what this means in practice>
- **<Standard 2>:** <Description of what this means in practice>
- **<Standard 3>:** <Description of what this means in practice>

## Technical Principles

<Patterns to follow and patterns to avoid>

### Follow
- <Pattern to follow with brief rationale>
- <Pattern to follow with brief rationale>

### Avoid
- <Pattern to avoid with brief rationale>
- <Pattern to avoid with brief rationale>

## Design Principles

<Visual/UX standards if applicable, or "N/A — no user interface" for backend/library projects>

- <Design principle with brief description>
- <Design principle with brief description>
```

Save the file to `.bober/principles.md`.

## Step 4: Confirm and Report

Present the generated principles to the user for confirmation:

```
## Project Principles Created

<summary of each section>

These principles are saved at `.bober/principles.md` and will be used by:
- The **Planner** when creating specs and sprint contracts
- The **Generator** when implementing code
- The **Evaluator** when checking sprint output

You can update these at any time by running `/bober-principles` again.
```

Append to `.bober/history.jsonl`:
```json
{"event":"principles-created","timestamp":"..."}
```

Or if updating:
```json
{"event":"principles-updated","timestamp":"..."}
```

## Next Steps

After completing this phase, suggest the following next steps to the user:
- `/bober-plan` — Plan a feature guided by these principles
