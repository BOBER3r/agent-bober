# Sprint Briefing: Verbatim port of verification-before-completion and systematic-debugging skills

**Contract:** sprint-spec-20260524-bober-vision-2
**Generated:** 2026-05-24T18:50:00Z

---

## 1. Target Files

### skills/bober.verify/SKILL.md (create)

**Directory pattern:** All skills live at `skills/bober.<name>/SKILL.md`. The directory name uses dot-namespacing (`bober.verify`, `bober.debug`), the filename is uppercase `SKILL.md` (not `Skill.md` or `skill.md`).

**Existing skills directory snapshot** (from `ls /Users/bober4ik/agent-bober/skills/`):
```
bober.anchor       bober.eval         bober.plan         bober.run
bober.architect    bober.graph        bober.playwright   bober.solidity
bober.brownfield   bober.impact       bober.principles   bober.sprint
                   bober.onboard      bober.react        bober.using-bober
                                      bober.research
```

**Most similar existing file:** `/Users/bober4ik/agent-bober/skills/bober.using-bober/SKILL.md` (Sprint 1 artifact, 133 lines) — same shape: YAML frontmatter, Iron Law block, `<EXTREMELY-IMPORTANT>` tags, Red Flags table, Attribution footer.

**Source file to port verbatim:** `/tmp/superpowers/skills/verification-before-completion/SKILL.md` (139 lines).

**Required frontmatter shape (light adaptation only):**
```yaml
---
name: bober-verify
description: Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - requires running verification commands and confirming output before making any success claims; evidence before assertions always
---
```
(The `name` field changes from `verification-before-completion` to `bober-verify`. `description` stays verbatim from source line 3.)

**Attribution block (per generatorNotes template — insert directly after frontmatter, before `# Verification Before Completion`):**
```markdown
> Verbatim port from [obra/superpowers](https://github.com/obra/superpowers) — MIT License.
> Original: skills/verification-before-completion/SKILL.md.
> Adaptations: skill name (bober.verify), tool name references where bober has equivalents.
```

**Imports / cross-references:** Source file has none. Body has no `superpowers:*` cross-references that need adaptation.

**Test file:** `does not exist` and not required — markdown skill files are not unit-tested. Verification is structural (grep for named elements per contract verificationMethod).

---

### skills/bober.debug/SKILL.md (create)

**Directory pattern:** Same as above (`skills/bober.debug/SKILL.md`).

**Source file to port verbatim:** `/tmp/superpowers/skills/systematic-debugging/SKILL.md` (296 lines).

**CRITICAL — DO NOT port these sibling files from the source directory** (they are Sprint 4's job, becoming `.bober/anti-patterns/`):
- `/tmp/superpowers/skills/systematic-debugging/root-cause-tracing.md`
- `/tmp/superpowers/skills/systematic-debugging/condition-based-waiting.md`
- `/tmp/superpowers/skills/systematic-debugging/defense-in-depth.md`
- `/tmp/superpowers/skills/systematic-debugging/condition-based-waiting-example.ts`
- `/tmp/superpowers/skills/systematic-debugging/testing-anti-patterns.md` (not present in source dir; mentioned in contract for awareness)

The source SKILL.md references these files (e.g., line 114: `See root-cause-tracing.md in this directory`). Preserve those references verbatim — they remain valid forward-references for Sprint 4.

**Required frontmatter:**
```yaml
---
name: bober-debug
description: Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes
---
```

**Attribution block:**
```markdown
> Verbatim port from [obra/superpowers](https://github.com/obra/superpowers) — MIT License.
> Original: skills/systematic-debugging/SKILL.md.
> Adaptations: skill name (bober.debug), tool name references where bober has equivalents.
```

**Cross-reference adaptation inside body (line 179, Phase 4 Step 1):**
- Source: `Use the superpowers:test-driven-development skill for writing proper failing tests`
- Bober: leave verbatim. There is no bober TDD skill yet. Per generatorNotes, "skill cross-references inside the body that point to superpowers-specific files… get replaced with bober equivalents where they exist or stripped where they don't" — keep as-is since stripping mid-sentence would damage the empirical voice. Alternative acceptable: drop the entire sub-clause `Use the superpowers:test-driven-development skill for writing proper failing tests`. Pick one; do not paraphrase to "use some TDD skill."
- Same for line 287: `superpowers:test-driven-development` and line 288: `superpowers:verification-before-completion` in the Related Skills list. The second one MUST be adapted to `bober.verify` because that skill exists in this sprint.

**Test file:** does not exist; not required.

---

### agents/bober-generator.md (modify)

**Current shape:**
- Total lines: **459** (verified via `wc -l`)
- Frontmatter: lines 1-12 (`name: bober-generator`, `tools:`, `model: sonnet`)
- Sections (top-level headers as anchors):
  - `## Subagent Context` (line 16)
  - `## Core Identity` (line 56)
  - `## Process` (line 66)
    - `### Step 0: Contract Precision Preflight (BLOCKING)` (line 67)
    - `### Step 1: Read and Understand the Handoff` (line 107)
    - `### Step 2: Plan Your Approach` (line 126)
    - `### Step 3: Implement Incrementally` (line 136)
    - **`### Step 4: Self-Verify Before Handoff`** (line 164) ← INSERT IRON LAW HERE
    - `### Step 5: Git Discipline` (line 214)
    - **`### Step 6: Report Completion`** (line 231) ← MODIFY completion-report schema here
  - `## Handling Evaluator Feedback (Retry Iterations)` (line 272) ← EXISTS but needs expansion
  - `## What You Must Never Do` (line 287)
  - `## Code Quality Standards` (line 301)
  - `## E2E Test Generation (when Playwright is configured)` (line 311)
  - `## Self-Evaluation Bias Protocol` (line 376)
  - `## Quality Over Speed` (line 390)
  - `## Brownfield-Specific Rules` (line 402)
  - `## Design Quality Standards (For UI Work)` (line 443)

**EXACT current Step 4 opening (lines 164-167) — IRON LAW inserts here:**
```markdown
### Step 4: Self-Verify Before Handoff

Before declaring the sprint complete, run these checks IN ORDER:

1. **Build check:**
```

**Recommended insertion (after "Before declaring the sprint complete, run these checks IN ORDER:" on line 166, before `1. **Build check:**` on line 168):**
```markdown
**IRON LAW (from skills/bober.verify):**

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you haven't run the verification command in this message, you cannot claim it passes. See `skills/bober.verify/SKILL.md` for the full discipline. The checks below are the application of that law.
```

**EXACT current completion-report schema (lines 235-270) — REPLACE with extended schema:**
```json
{
  "contractId": "<contract ID>",
  "status": "complete | partial | blocked",
  "criteriaResults": [
    {
      "criterionId": "sc-1-1",
      "met": true,
      "evidence": "<How you verified this>"
    },
    {
      "criterionId": "sc-1-2",
      "met": false,
      "reason": "<What went wrong>",
      "attemptedFix": "<What you tried>"
    }
  ],
  "filesChanged": [
    {
      "path": "src/components/Login.tsx",
      "action": "created | modified | deleted",
      "description": "New login form component with email/password fields"
    }
  ],
  "testsAdded": [
    "src/components/__tests__/Login.test.tsx"
  ],
  "commits": [
    "<commit hash> - <commit message>"
  ],
  "blockers": [
    "<Description of any unresolved issue>"
  ],
  "notes": "<Any additional context for the evaluator or next sprint>"
}
```

**There is ALSO a second (shorter) completion-report schema at lines 32-47** in the Subagent Context section. The Generator should extend BOTH to add `verificationOutput`, OR add it only to the canonical one at line 235 and update line 32-47 with a back-reference. The cleaner choice: add `verificationOutput` as REQUIRED to the canonical schema (line 235), and tighten the short schema at line 32-47 to note "see Step 6 for the full schema including verificationOutput (required)".

**Required addition to the canonical schema — add as a sibling field (REQUIRED, not optional):**
```json
"verificationOutput": [
  {
    "command": "npm run build",
    "exitCode": 0,
    "stdoutTail": "<last ~500 chars of stdout/stderr proving the command ran>"
  },
  {
    "command": "npx tsc --noEmit",
    "exitCode": 0,
    "stdoutTail": "<...>"
  }
]
```

Per contract criterion s2-c3: shape is `Array<{command: string, exitCode: number, stdoutTail: string}>`. Per evaluatorNotes: "Verify verificationOutput field in completion-report is marked REQUIRED (optional defeats the Iron Law)."

**EXISTING `## Handling Evaluator Feedback (Retry Iterations)` section (lines 272-286):** This section ALREADY EXISTS. The new requirement is to either:
- (a) Rename/restructure it to add Forbidden Responses + DISPUTE protocol as subsections, OR
- (b) Add a new section `## Handling Evaluator Feedback` adjacent to it.

Recommended (a): expand the existing section in place — the contract says "section titled 'Handling Evaluator Feedback' (or equivalent)" and one already exists. Keep its current bullet list (lines 274-285) as the "Implementation Protocol" subsection, then add two new subsections: **Forbidden Responses** and **DISPUTE Protocol**.

**Test file:** `does not exist` and not required.

**File size constraint (criterion s2-c6):** Must stay ≤800 lines. Current: 459. Headroom: 341 lines for additions. Estimated additions: ~50-80 lines (Iron Law block + Forbidden Responses + DISPUTE protocol + worked example + schema field). Well within budget.

---

## 2. Patterns to Follow

### Pattern A: Frontmatter shape for skills
**Source:** `/Users/bober4ik/agent-bober/skills/bober.using-bober/SKILL.md`, lines 1-4
```yaml
---
name: bober-using-bober
description: Use when starting any conversation - establishes how to find and use bober skills, requiring Skill tool invocation before ANY response including clarifying questions
---
```
**Rule:** `name` uses kebab-case with `bober-` prefix; `description` starts with "Use when ..." in present tense. Both ported skills follow this — `name: bober-verify` and `name: bober-debug`. The `description` field is copied verbatim from the source SKILL.md frontmatter.

### Pattern B: Attribution footer (already established by Sprint 1)
**Source:** `/Users/bober4ik/agent-bober/skills/bober.using-bober/SKILL.md`, lines 132-133
```markdown
## Attribution

Structural pattern and voice ported from [obra/superpowers](https://github.com/obra/superpowers) (MIT licensed). Adapted for the agent-bober skill catalog.
```
**Rule:** Sprint 1 placed attribution at the BOTTOM as a `## Attribution` section. Sprint 2 contract specifies attribution at the TOP as a blockquote (per generatorNotes template). **Follow the contract — top-of-file blockquote.** This is intentional: Sprint 1's skill was structurally inspired but not a verbatim port; Sprint 2's skills are verbatim and require visible top-of-file attribution per MIT spirit.

### Pattern C: `<EXTREMELY-IMPORTANT>` tags
**Source:** `/Users/bober4ik/agent-bober/skills/bober.using-bober/SKILL.md`, lines 10-16
```markdown
<EXTREMELY-IMPORTANT>
If you think there is even a 1% chance a skill might apply to what you are doing, you ABSOLUTELY MUST invoke the skill.

IF A SKILL APPLIES TO YOUR TASK, YOU DO NOT HAVE A CHOICE. YOU MUST USE IT.

This is not negotiable. This is not optional. You cannot rationalize your way out of this.
</EXTREMELY-IMPORTANT>
```
**Rule:** Preserve these tags verbatim where they appear in the source. The source SKILL.md files for verification-before-completion and systematic-debugging do NOT use `<EXTREMELY-IMPORTANT>` (they use Iron Law blocks instead), so this tag does not appear in the ports — but if generator considers softening any STOP language, do not. Empirically tuned per source AGENTS.md.

### Pattern D: Iron Law presentation
**Source:** `/tmp/superpowers/skills/verification-before-completion/SKILL.md`, lines 16-21
```markdown
## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you haven't run the verification command in this message, you cannot claim it passes.
```
**Rule:** Iron Law appears in a `## The Iron Law` section as a fenced code block (no language tag), single capitalized sentence, followed by a one-line clarification. Replicate this exact pattern in agents/bober-generator.md.

### Pattern E: Voice and capitalized rule words
**Source:** `/tmp/superpowers/skills/systematic-debugging/SKILL.md`, lines 14, 22, 48, 230
- Line 14: "Violating the letter of this process is violating the spirit of debugging."
- Line 22: "If you haven't completed Phase 1, you cannot propose fixes."
- Line 48: "You MUST complete each phase before proceeding to the next."
- Line 230: "**ALL of these mean: STOP. Return to Phase 1.**"

**Rule:** Capitalized MUST/STOP/ALL words, "letter vs. spirit" framing, second-person ("you cannot…"). Preserve verbatim.

---

## 3. Existing Utilities — DO NOT Recreate

This is a markdown-only sprint. No code utilities apply. The relevant "utilities" are existing skill files and conventions:

| Resource | Location | Purpose |
|----------|----------|---------|
| `bober.using-bober` skill | `skills/bober.using-bober/SKILL.md` | Defines the Iron Law of skill invocation. References `bober.verify` and `bober.debug` as "(planned)" in its catalog (lines 103-104). This sprint fulfills that promise. |
| Attribution blockquote template | `generatorNotes` of contract | Exact text to copy at top of each ported SKILL.md. Do not paraphrase. |
| Existing `## Handling Evaluator Feedback (Retry Iterations)` section | `agents/bober-generator.md` lines 272-286 | Already present. EXPAND in place rather than creating a duplicate section. |
| Existing Step 4 self-verify section | `agents/bober-generator.md` lines 164-212 | Already present. INSERT Iron Law block right after the section's lead sentence, before the numbered checklist. |
| Existing completion-report schema (canonical) | `agents/bober-generator.md` lines 235-270 | Extend with `verificationOutput` REQUIRED field. Do not restructure the surrounding section. |
| Existing completion-report schema (subagent context summary) | `agents/bober-generator.md` lines 32-47 | Shorter mirror of the canonical schema. Update to reference canonical or also add `verificationOutput`. |

---

## 4. Prior Sprint Output

### Sprint 1: SessionStart bootstrap + bober.using-bober skill (commit 03cf904)
**Created:**
- `skills/bober.using-bober/SKILL.md` (133 lines) — establishes the Iron Law convention, lists `bober.verify` and `bober.debug` as "(planned)" in its catalog at lines 103-104
- `hooks/session-start` (42 lines)
- `hooks/hooks.json` (12 lines)

**Connection to this sprint:**
1. The catalog entries at `skills/bober.using-bober/SKILL.md` lines 103-104 — `bober.verify (planned)` and `bober.debug (planned)` — should remain as written. **DO NOT edit the "(planned)" labels in this sprint.** The Sprint 1 contract froze that file; updating it would be scope creep. (The evaluator may flag this as a documentation gap, but per evaluatorNotes the recommendation is: "Cross-check Sprint 1's bober.using-bober SKILL.md mentions bober.verify and bober.debug in its skill catalog (it should from Sprint 1; if not, flag it as a Sprint 1 regression to fix here or in Sprint 3)." — the labels DO mention them, so the gate is met. Leave them alone.)
2. The verbatim-voice convention was set: capitalized Iron Laws, `<EXTREMELY-IMPORTANT>` tags preserved, attribution to obra/superpowers. This sprint continues that convention but with TOP-OF-FILE attribution (because Sprint 2's skills are verbatim ports, not adaptations).
3. The frontmatter pattern (`name: bober-<name>`, `description: Use when ...`) is established and must match.

---

## 5. Relevant Documentation

### Project Principles
**No `.bober/principles.md` file found** at the project root (confirmed via filesystem check). The principles file is a planned artifact of the `bober.principles` skill, not in scope for this sprint. The closest active discipline document is `skills/bober.using-bober/SKILL.md` (Sprint 1).

### Architecture Decisions
**No ADRs in `.bober/architecture/` directly relevant to this sprint.** The git status shows `.bober/architecture/` is an untracked directory — these are forward artifacts from later sprints.

### Other Docs
- **Source AGENTS.md guidance** (referenced by contract criterion s2-c5): "the source uses [your human partner] phrase deliberately per /tmp/superpowers/AGENTS.md". Verified: the source phrase appears in `/tmp/superpowers/skills/systematic-debugging/SKILL.md` at lines 211, 234, 241 (and is a section heading: `## your human partner's Signals You're Doing It Wrong` at line 234). It does NOT appear in `/tmp/superpowers/skills/verification-before-completion/SKILL.md` source — that file does NOT contain "your human partner" (verified). EXCEPTION: line 113 of verification-before-completion DOES contain it: `- your human partner said "I don't believe you" - trust broken`. So the phrase appears in BOTH source files and must be preserved.
- **MIT License** at `/tmp/superpowers/LICENSE` — "Copyright (c) 2025 Jesse Vincent". Attribution to obra/superpowers is the obligation under MIT.

---

## 6. Testing Patterns

### Unit Test Pattern
This sprint is **markdown-only — no unit tests apply.** Verification per the contract is structural:
- `wc -l <file>` for size constraints (criterion s2-c6: agents/bober-generator.md ≤800 lines)
- `grep -F` for verbatim string presence (Iron Law strings, phase titles, table headers)
- `diff` against source by structural element (per evaluatorNotes)

### E2E Test Pattern
Not applicable to this sprint.

### Verification commands the generator should run before claiming completion (per the Iron Law it is creating):
```bash
# Existence + frontmatter + attribution
test -f /Users/bober4ik/agent-bober/skills/bober.verify/SKILL.md && echo "verify-skill: present"
test -f /Users/bober4ik/agent-bober/skills/bober.debug/SKILL.md && echo "debug-skill: present"
grep -F "obra/superpowers" /Users/bober4ik/agent-bober/skills/bober.verify/SKILL.md
grep -F "obra/superpowers" /Users/bober4ik/agent-bober/skills/bober.debug/SKILL.md

# Iron Law strings (criteria s2-c1, s2-c2)
grep -F "NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE" /Users/bober4ik/agent-bober/skills/bober.verify/SKILL.md
grep -F "NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST" /Users/bober4ik/agent-bober/skills/bober.debug/SKILL.md

# Four phases in order (criterion s2-c2)
grep -nE "^### Phase [1-4]:" /Users/bober4ik/agent-bober/skills/bober.debug/SKILL.md

# Generator file Iron Law inlined + verificationOutput required (criterion s2-c3)
grep -F "NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE" /Users/bober4ik/agent-bober/agents/bober-generator.md
grep -F "verificationOutput" /Users/bober4ik/agent-bober/agents/bober-generator.md
grep -F "bober.verify" /Users/bober4ik/agent-bober/agents/bober-generator.md

# Handling Evaluator Feedback + Forbidden Responses + DISPUTE (criterion s2-c4)
grep -F "Handling Evaluator Feedback" /Users/bober4ik/agent-bober/agents/bober-generator.md
grep -F "You're absolutely right" /Users/bober4ik/agent-bober/agents/bober-generator.md
grep -F "DISPUTE" /Users/bober4ik/agent-bober/agents/bober-generator.md

# Voice port (criterion s2-c5)
grep -F "your human partner" /Users/bober4ik/agent-bober/skills/bober.verify/SKILL.md
grep -F "your human partner" /Users/bober4ik/agent-bober/skills/bober.debug/SKILL.md

# Line cap (criterion s2-c6)
wc -l /Users/bober4ik/agent-bober/agents/bober-generator.md
```

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `agents/bober-generator.md` | (self) | medium | Adding `verificationOutput` as REQUIRED changes the completion-report contract. Downstream consumer is the bober-evaluator agent — it must be aware the field will be present. Check whether `agents/bober-evaluator.md` currently parses the completion report and would reject unknown fields. |
| `skills/bober.using-bober/SKILL.md` | references `bober.verify (planned)` and `bober.debug (planned)` at lines 103-104 | low | The "(planned)" labels become technically out-of-date once the skills land. Do NOT edit them in this sprint (out of scope per Sprint 1's contract). Sprint 3 may update them. |
| `agents/bober-evaluator.md` | reads completion-report shape | medium | If evaluator does shape validation on completion-report and rejects unknown fields, adding `verificationOutput` will fail evaluation. Generator should grep `agents/bober-evaluator.md` for "verificationOutput" or "completion-report" parsing. |
| `agents/bober-curator.md` / `agents/bober-planner.md` / `agents/bober-architect.md` / `agents/bober-researcher.md` | none on this change | low | These agents don't consume the generator's completion-report shape. |

### Existing Tests That Must Still Pass
- **KPI gate report**: `.bober/graph/kpi-gate-report.json` is marked modified in `git status`. Confirm any KPI check that scans for skill files or agent prompts still passes. The graph hook may auto-update on file changes; allow that.
- **Markdown lint**: `.markdownlint.json` exists at the repo root. Run markdown lint over the new SKILL.md files. Source files at `/tmp/superpowers/skills/.../SKILL.md` may not satisfy the bober markdownlint config — if a verbatim port produces lint warnings, the contract's verbatim-voice directive WINS over markdownlint per evaluatorNotes ("Anything else differing from source is a port-quality regression — flag it"). Do not paraphrase to satisfy markdownlint.
- **No code-level tests apply** — this is a documentation/prompt-engineering sprint.

### Features That Could Be Affected
- **`bober.sprint` execution loop** — invokes the generator, parses its completion-report. Adding `verificationOutput` as required means a generator that forgets to emit it would be flagged complete-but-unverified. This is the INTENT (Iron Law). Confirm the bober.sprint skill's handling of malformed completion reports is graceful (not a hard crash).
- **Forward dependency: Sprint 3** will likely build on this — the `bober.handle-evaluator-feedback` discipline may be extracted into its own skill or layered into `bober.code-review`. Do not pre-build for Sprint 3.

### Recommended Regression Checks
After implementation, the Generator MUST verify (and emit in `verificationOutput`):
1. `wc -l /Users/bober4ik/agent-bober/agents/bober-generator.md` → expect ≤ 800
2. `wc -l /Users/bober4ik/agent-bober/skills/bober.verify/SKILL.md` → expect within ±20% of 139 (range 111-167)
3. `wc -l /Users/bober4ik/agent-bober/skills/bober.debug/SKILL.md` → expect within ±20% of 296 (range 237-355)
4. All grep checks from Section 6 return matches
5. `diff <(grep -c "^### Phase" /tmp/superpowers/skills/systematic-debugging/SKILL.md) <(grep -c "^### Phase" /Users/bober4ik/agent-bober/skills/bober.debug/SKILL.md)` → expect 0 (same phase count)
6. The four phase titles appear in order in bober.debug/SKILL.md
7. `<EXTREMELY-IMPORTANT>` tags from source (if any) are present in port — for these two source files, none exist, so this check is a no-op
8. The exact Rationalization Prevention table rows from source (see Section 9 below) are present byte-for-byte in bober.verify/SKILL.md (allowing only whitespace normalization)

---

## 8. Implementation Sequence

1. **Create `skills/bober.verify/` directory + `SKILL.md`** — verbatim copy of source (139 lines) with frontmatter `name` adapted to `bober-verify`, attribution blockquote inserted between frontmatter and `# Verification Before Completion` heading.
   - Verify: `diff` against source, expect only the frontmatter `name` line and the inserted attribution block to differ.

2. **Create `skills/bober.debug/` directory + `SKILL.md`** — verbatim copy of source (296 lines) with frontmatter `name` adapted to `bober-debug`, attribution blockquote inserted after frontmatter. Adapt the `superpowers:verification-before-completion` cross-reference at line 288 to `bober.verify`. Leave `superpowers:test-driven-development` references intact (no bober equivalent yet).
   - Verify: `diff` against source — expected diffs limited to frontmatter `name`, attribution block, `superpowers:verification-before-completion` → `bober.verify`. Phase titles must match. Tables must match.

3. **Modify `agents/bober-generator.md` — Step 4 Iron Law inline** — Insert the Iron Law block + cross-reference immediately after line 166 (the sentence "Before declaring the sprint complete, run these checks IN ORDER:") and before line 168 (the `1. **Build check:**` numbered item).
   - Verify: `grep -F "NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE" agents/bober-generator.md` returns a match; `grep -F "bober.verify" agents/bober-generator.md` returns a match.

4. **Modify `agents/bober-generator.md` — completion-report schema** — Add `verificationOutput: Array<{command: string, exitCode: number, stdoutTail: string}>` as a REQUIRED field in the canonical schema at lines 235-270. Update the schema example to include a populated `verificationOutput` array. Update the shorter schema mirror at lines 32-47 with the same field OR a pointer to the canonical schema.
   - Verify: `grep -c "verificationOutput" agents/bober-generator.md` returns ≥2 (in canonical schema + in shorter mirror or cross-reference).

5. **Modify `agents/bober-generator.md` — expand "Handling Evaluator Feedback" section** — Currently at lines 272-286. Add subsections:
   - `### Invoke bober.debug Before Code Changes` — short paragraph instructing to load the bober.debug skill before fixing anything the evaluator flagged.
   - `### Forbidden Responses` — list at least 4 anti-sycophancy phrases (drawn from `/tmp/superpowers/skills/receiving-code-review/SKILL.md` lines 28-39 and 132-144):
     - "You're absolutely right!" (explicit CLAUDE.md violation)
     - "Great catch!" / "Great point!" (performative)
     - "Let me fix that now" (before verification)
     - "I see what you mean" (acknowledgment of unverified claim)
     - "Thanks for catching that!" (any gratitude expression)
   - `### DISPUTE Protocol` — documents the structured response shape with worked example:
     ```json
     {
       "dispute": true,
       "criterionId": "s2-c3",
       "reason": "Evaluator claims verificationOutput is missing, but it is present at line 247 of agents/bober-generator.md.",
       "evidence": [
         {"path": "agents/bober-generator.md", "line": 247, "snippet": "  \"verificationOutput\": [...]"}
       ]
     }
     ```
   - Verify: `grep -c "Forbidden Responses" agents/bober-generator.md` ≥ 1; phrase count by grepping each forbidden phrase ≥ 4 matches total; `grep -F "DISPUTE" agents/bober-generator.md` returns a match; `grep -F "dispute\": true" agents/bober-generator.md` returns a match (worked example).

6. **Run all verification commands from Section 6** — emit each as a `verificationOutput` entry in the completion-report (the Generator must dogfood the new field it just added).
   - Verify: `wc -l agents/bober-generator.md` ≤ 800; all greps pass.

7. **Markdown lint sweep** — run `npx markdownlint` (or whatever `commands.lint` is for markdown) over the three changed files. Suppress only with file-local pragmas if the source produces a lint error; never paraphrase source text.
   - Verify: lint exit code 0 or only justified warnings.

8. **Run full verification chain** — `commands.build`, `commands.typecheck`, `commands.lint`, `commands.test` per `bober.config.json`. This sprint touches no code, but the gate must still pass to satisfy criterion s2-c7.
   - Verify: exit 0 on each.

9. **Commit atomically** — single commit `bober(sprint-2): port bober.verify + bober.debug skills + inline Iron Law in generator` with contract ID and criteria addressed in footer.

---

## 9. Pitfalls & Warnings

### Verbatim verification — the exact strings to preserve

**Iron Law strings (criteria s2-c1, s2-c2):**
- `NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE` — note the contract `description` field for s2-c1 uses `NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION COMMAND OUTPUT`. **The source SKILL.md says `EVIDENCE`, not `COMMAND OUTPUT`**. PORT THE SOURCE STRING (`EVIDENCE`). The contract description is paraphrased; the verbatim-voice directive wins. The evaluator's `verificationMethod` says "Grep for each named element" — grep for `NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION` (a prefix match covers both).
- `NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST` — exact source string. No discrepancy.

**The four phase titles in order (criterion s2-c2) — must appear as `### Phase N: Title`:**
1. `### Phase 1: Root Cause Investigation` (source line 50)
2. `### Phase 2: Pattern Analysis` (source line 123)
3. `### Phase 3: Hypothesis and Testing` (source line 146) — note: contract description says "Fix Hypothesis" but source says "Hypothesis and Testing". **Port source verbatim.**
4. `### Phase 4: Implementation` (source line 170) — note: contract description says "Fix Verification" but source says "Implementation". **Port source verbatim.**

The contract paraphrased the phase titles in its description; the actual source titles must be preserved.

### Common Failures table (criterion s2-c1) — copy these column headers exactly
```markdown
| Claim | Requires | Not Sufficient |
|-------|----------|----------------|
```
Source: `/tmp/superpowers/skills/verification-before-completion/SKILL.md` line 42. Seven rows follow (lines 43-50). Preserve all seven.

### Red Flags - STOP list (criterion s2-c1, s2-c2) — bullet list, preserve all bullets

For bober.verify (source lines 52-61):
```
- Using "should", "probably", "seems to"
- Expressing satisfaction before verification ("Great!", "Perfect!", "Done!", etc.)
- About to commit/push/PR without verification
- Trusting agent success reports
- Relying on partial verification
- Thinking "just this once"
- Tired and wanting work over
- **ANY wording implying success without having run verification**
```

For bober.debug (source lines 215-232) — preserve the full thinking-trap list with bold lines and both follow-up sentences.

### Rationalization Prevention table — bober.verify (verbatim, source lines 63-74)

```markdown
| Excuse | Reality |
|--------|---------|
| "Should work now" | RUN the verification |
| "I'm confident" | Confidence ≠ evidence |
| "Just this once" | No exceptions |
| "Linter passed" | Linter ≠ compiler |
| "Agent said success" | Verify independently |
| "I'm tired" | Exhaustion ≠ excuse |
| "Partial check is enough" | Partial proves nothing |
| "Different words so rule doesn't apply" | Spirit over letter |
```

### Common Rationalizations table — bober.debug (verbatim, source lines 246-256)

```markdown
| Excuse | Reality |
|--------|---------|
| "Issue is simple, don't need process" | Simple issues have root causes too. Process is fast for simple bugs. |
| "Emergency, no time for process" | Systematic debugging is FASTER than guess-and-check thrashing. |
| "Just try this first, then investigate" | First fix sets the pattern. Do it right from the start. |
| "I'll write test after confirming fix works" | Untested fixes don't stick. Test first proves it. |
| "Multiple fixes at once saves time" | Can't isolate what worked. Causes new bugs. |
| "Reference too long, I'll adapt the pattern" | Partial understanding guarantees bugs. Read it completely. |
| "I see the problem, let me fix it" | Seeing symptoms ≠ understanding root cause. |
| "One more fix attempt" (after 2+ failures) | 3+ failures = architectural problem. Question pattern, don't fix again. |
```

### Gate Function block (criterion s2-c1) — bober.verify source lines 26-38, preserve as a fenced code block with no language tag
```
BEFORE claiming any status or expressing satisfaction:

1. IDENTIFY: What command proves this claim?
2. RUN: Execute the FULL command (fresh, complete)
3. READ: Full output, check exit code, count failures
4. VERIFY: Does output confirm the claim?
   - If NO: State actual status with evidence
   - If YES: State claim WITH evidence
5. ONLY THEN: Make the claim

Skip any step = lying, not verifying
```

### "Read Error Messages Carefully" subsection (criterion s2-c2)
**Source:** bober.debug SKILL.md lines 54-58. Must be present verbatim under `### Phase 1: Root Cause Investigation`.

### "Gather Evidence in Multi-Component Systems" subsection (criterion s2-c2)
**Source:** bober.debug SKILL.md lines 72-108. This is a long subsection containing two fenced code blocks (the procedure and a multi-layer bash example). Preserve both code blocks verbatim including the trailing comment `# This reveals: Which layer fails (secrets → workflow ✓, workflow → build ✗)`.

### `## your human partner's Signals You're Doing It Wrong` section heading
**Source:** bober.debug SKILL.md line 234. The literal phrase "your human partner" appears INSIDE a section heading. Preserve. Do NOT capitalize, do NOT change to "the orchestrator" in the skill body. Per evaluatorNotes: "the source uses this phrase deliberately per /tmp/superpowers/AGENTS.md".

### Conflict resolution — Does agents/bober-generator.md currently contradict the new Iron Law?

**Audit performed (grep for "self-verify | verify | Step 4"):**

| Line | Current text | Conflict? | Reconciliation |
|------|--------------|-----------|----------------|
| 62 | "Self-verify before declaring a sprint complete" | No — aligns with Iron Law | Keep as-is. |
| 142 | "Make a cohesive change, verify it works" | No — aligns | Keep. |
| 164-212 | Step 4 with build/typecheck/lint/test checks | No, complementary | Insert Iron Law block at top of section. |
| 207 | "If any check fails and you cannot fix it: Do NOT ship broken code" | No, aligns | Keep. |
| 388 | "Distinguish between 'done' and 'working'" | No, aligns | Keep. |
| 393 | "Run the full eval chain yourself (build, typecheck, lint, test) BEFORE reporting done" | No, aligns | Keep. |

**No phrases like "self-verify if convenient" or "skip verification when …" exist.** The Iron Law inlay reinforces rather than contradicts existing prose. There is no conflict to reconcile.

### Other pitfalls

1. **Don't capitalize "your human partner".** Source uses lowercase even at sentence-start in one heading. Preserve case exactly.

2. **Don't strip the empty backtick fences.** Source uses ``` ` ``` ` ``` (triple-backtick) blocks with no language tag for the Iron Law strings. Preserve the no-language-tag form — it is empirically tuned.

3. **Don't add bober-isms to the skill bodies.** The skills are reference material for ANY agent that loads them. Do not insert "as Bober, you should…" — preserve the source voice.

4. **The shorter completion-report schema at lines 32-47 of agents/bober-generator.md is in the SUBAGENT CONTEXT section** — that's the schema the agent sees FIRST when it boots. If `verificationOutput` is added only to the canonical schema at line 235, an agent that stops reading early may emit a report without it. Recommended: add `verificationOutput` to BOTH schemas (or add a prominent cross-reference at line 32-47 saying "see Step 6 for the full required schema").

5. **Do not modify `skills/bober.using-bober/SKILL.md` in this sprint.** Lines 103-104 still say `bober.verify (planned)` and `bober.debug (planned)` — leaving those labels is technically wrong-after-this-sprint, but updating them is Sprint 1's contract, not Sprint 2's. Note in completion-report `notes` field that Sprint 3 should update them.

6. **The `superpowers:test-driven-development` cross-reference in bober.debug source has no bober equivalent yet.** Choices: (a) leave verbatim, (b) strip the clause. Either is acceptable per generatorNotes; (a) is safer for verbatim spirit, (b) is cleaner. Recommendation: (a) — leave verbatim. A forward-reference to a not-yet-existent file is acceptable in the bober convention (see `skills/bober.using-bober/SKILL.md` line 36 which forward-references AGENTS.md).

7. **Attribution blockquote vs. footer.** Sprint 1 used a footer; Sprint 2 contract says top-of-file blockquote. **Follow the contract.** Do not "harmonize" with Sprint 1 — the two cases are intentionally different (Sprint 1 was an adaptation; Sprint 2 is a verbatim port and MIT attribution must be visible at the top).

8. **DISPUTE protocol shape** — the contract specifies `{dispute: true, criterionId, reason, evidence: Array<{path, line, snippet}>}`. Preserve key names exactly. `dispute` (lowercase bool), `criterionId` (camelCase), `evidence` array with `path`/`line`/`snippet` keys.

9. **`verificationOutput` field name** — exactly that camelCase string per criterion s2-c3. Do not rename to `verifications`, `verificationCommands`, or anything else.

10. **DO NOT port supplementary files from `/tmp/superpowers/skills/systematic-debugging/`** (root-cause-tracing.md, condition-based-waiting.md, defense-in-depth.md, etc.). The generator notes are explicit: "supplementary files become .bober/anti-patterns/ in Sprint 4". Including them in Sprint 2 is scope creep and will fail the nonGoals check.
