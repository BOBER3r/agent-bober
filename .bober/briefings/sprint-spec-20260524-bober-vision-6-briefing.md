# Sprint Briefing: HARD-GATE in bober.plan + AGENTS.md at repo root + README cross-link

**Contract:** sprint-spec-20260524-bober-vision-6
**Generated:** 2026-05-25T00:00:00Z
**Sprint Mode:** Docs-only (no src/ changes). Three files touched.

---

## Sprint Summary

Sprint 6 closes Tier 1 (quality discipline) of the Bober Vision plan. Three documentation changes, no code:

1. **Insert** a `<HARD-GATE>...</HARD-GATE>` block into `skills/bober.plan/SKILL.md` between Step 5 (PlanSpec generation) and Step 6 (Sprint decomposition). The block names two protocols (INTERACTIVE / AUTONOMOUS) for design-approval gating and forbids writing `.bober/contracts/*.json` until approval is recorded as a `resolvedClarifications` entry with `questionId='gate-design-approval'`.
2. **Create** `AGENTS.md` at repo root (`/Users/bober4ik/agent-bober/AGENTS.md`) as a verbatim-voice port of `/tmp/superpowers/AGENTS.md`. Preserve `slop`, `your human partner`, `EXTREMELY-IMPORTANT` framing. Adapt only project-specific facts (name, repo URL, examples). Replace the 94%-rejection statistic with bober-context framing (the statistic is for superpowers and cannot be substantiated for agent-bober). File must be `>=120` and `<=600` lines.
3. **Modify** `README.md` Contributing section to cross-link to `./AGENTS.md`.

After this sprint, the Sprint 1 forward-reference in `skills/bober.using-bober/SKILL.md:36` ("AGENTS.md ... created in a later sprint; treat its absence as a forward reference") resolves.

---

## 1. Target Files

### `/Users/bober4ik/agent-bober/skills/bober.plan/SKILL.md` (modify — insert only)

**File length:** 298 lines.

**Insertion point:** Between line 153 (end of Step 5) and line 155 (start of Step 6). The new block goes at what is currently line 154 (blank line).

**Relevant sections — Step 5 ending (lines 137-153):**
```markdown
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
```

**Step 6 start (lines 155-159) — must remain unchanged after insertion:**
```markdown
## Step 6: Decompose into Sprint Contracts

Decompose the PlanSpec into ordered sprints. This is the most critical step.

**Read `sprint.sprintSize` from config to calibrate sprint size:**
```

**Existing Step 7.5 (lines 213-252) — the HARD-GATE must NOT contradict this:**
The skill already has Step 7.5 ("Decide — Ready or Needs Clarification?"). That is an **ambiguity-score-based clarification mechanism** running after Step 7 (Save Everything) — score 0-10, branches `draft` vs `needs-clarification`, populates `clarificationQuestions` / `resolvedClarifications` for open question resolution via `bober plan answer`.

**Relationship — these complement, do not duplicate:**
- HARD-GATE (new, between Step 5 and Step 6): **design approval** gate. Stops contract writing until assumptions+outOfScope are approved (by user OR by self-cited evidence).
- Step 7.5 (existing, after Step 7): **specification ambiguity** gate. Branches the spec status into `draft` vs `needs-clarification` based on ambiguity rubric.
- Both record into `resolvedClarifications` but with different `questionId` values: HARD-GATE writes `questionId='gate-design-approval'`; Step 7.5 writes the per-question IDs (Q1, Q2, ...) from `clarificationQuestions`.
- HARD-GATE runs first (before Step 6 decomposition). Step 7.5 runs after Step 7 (post-save).

**Forbidden-action overlap with Step 7:** Step 7 instructs the planner to write `.bober/contracts/<contractId>.json` files. The HARD-GATE forbids writing those files until approval is recorded. The text must make clear the gate runs BEFORE Step 6/7 — sprint decomposition AND contract files are blocked until gate passes.

**Imports / cross-references this file uses:**
- References `skills/bober.plan/references/spec-schema.md`
- References `skills/bober.plan/references/clarification-guide.md`
- References `skills/bober.sprint/references/contract-schema.md`
- Mentions `.bober/contracts/`, `.bober/specs/`, `.bober/progress.md`, `.bober/history.jsonl`

**Test file:** No unit test — this is a skill markdown file.

---

### `/Users/bober4ik/agent-bober/AGENTS.md` (create)

**Source pattern:** `/tmp/superpowers/AGENTS.md` (106 lines).

**Required headings (verbatim from source, in order):**
1. `## If You Are an AI Agent` (source line 3)
2. `## Pull Request Requirements` (source line 21)
3. `## What We Will Not Accept` (source line 29)
4. `## Skill Changes Require Evaluation` (source line 88) → **adapt to `## Skill Changes Require Verification`** per contract success criterion s6-c4 wording. Contract wording wins (criterion s6-c4 specifies "Skill Changes Require Verification").
5. The contract additionally requires an `## Evidence Requirements` section that does NOT exist in the source. This is a bober-specific addition (must be invented from contract evaluatorNotes — file:line discipline, MIT attribution for ported anti-patterns, etc.).

**Source sections that may be dropped or replaced:**
- Source's `## New Harness Support` (lines 67-86) — superpowers-specific. Drop unless adapted to bober (e.g., "New Provider Support" with a session-transcript proof requirement).
- Source's `## Understand the Project Before Contributing` (lines 97-99) and `## General` (lines 101-106) — optional to port; keep if they fit naturally.

**Voice markers to PRESERVE (from contract s6-c6 + evaluatorNotes):**
| Marker | Source line | Preservation rule |
|--------|-------------|-------------------|
| `slop` | lines 7, 9 ("slop PRs", "AI slop"), 61 | Keep verbatim wherever it parses |
| `your human partner` | lines 9, 14, 16, 17, 19 (5 occurrences) | Keep verbatim; do NOT soften to "the user" |
| `EXTREMELY-IMPORTANT` | not in source AGENTS.md, but is the broader bober/superpowers tag style — see `skills/bober.using-bober/SKILL.md:10` for usage | Use at least one to reinforce gate-like statements |
| 94%-rejection framing | lines 7, 61 | REPLACE — contract evaluatorNotes explicitly say "the 94% statistic SHOULD be replaced with bober-specific framing if it cannot be substantiated for agent-bober." Suggested replacement: "this project rejects agent-authored PRs that lack human review evidence" |

**Project-name and URL adaptations (factual only, not framing):**
- `superpowers` → `agent-bober` (project name)
- `https://github.com/obra/superpowers` references → `https://github.com/BOBER3r/agent-bober`
- Path: `.github/PULL_REQUEST_TEMPLATE.md` → keep if bober has it; otherwise adapt to `AGENTS.md` self-reference or remove the requirement
- `using-superpowers` bootstrap → `using-bober` bootstrap (note: bober's skill is `bober.using-bober`)
- `superpowers:writing-skills` → bober has no equivalent; replace with the in-repo discipline (cite `skills/bober.verify/`, `agents/bober-evaluator.md`, Iron Law from Sprint 3)

**Source examples that reference superpowers-only concepts (must drop or adapt):**
- "Let's make a react todo list" acceptance test for harness integration (source lines 73-77) — this is superpowers-specific. Replace with bober equivalent OR drop the entire `## New Harness Support` section.
- "Red Flags tables, rationalization lists" reference (source line 95) — bober DOES have these (introduced Sprint 3 across 5 agent prompts; commit e5233ed). Adapt to cite `agents/bober-*.md` Iron Law / Red Flags / Rationalization structure.

**Line-count gap:**
- Source: 106 lines
- Required: `>=120` and `<=600`
- Gap: at least 14 net lines must be ADDED (after dropping superpowers-specific content). Realistically, adding the new `## Evidence Requirements` section + 5+ "What We Will Not Accept" bober-specific categories + 4+ pre-PR checks will push the file to ~150-250 lines. Stay well below 600.

**Most similar existing file:** No prior AGENTS.md in repo. The structural template is `/tmp/superpowers/AGENTS.md`.

---

### `/Users/bober4ik/agent-bober/README.md` (modify — extend existing section)

**File length:** 842 lines.

**Existing Contributing section at lines 779-790:**
```markdown
## Contributing

Contributions are welcome. To set up the development environment:

```bash
git clone https://github.com/BOBER3r/agent-bober.git
cd agent-bober
npm install
npm run build
npm run typecheck
npm test
```
```

**Insertion point (recommended):** Insert a 1-line lead-in at line 781 (immediately under the `## Contributing` heading, BEFORE "Contributions are welcome"). This makes the AGENTS.md link the first thing a contributor sees.

**Suggested patch (from contract generatorNotes — verbatim):**
> "See [AGENTS.md](./AGENTS.md) for contributor discipline including the anti-slop pre-PR checklist."

**README structure (key section line ranges for orientation):**
| Section | Line range |
|---------|-----------|
| Title / badges / intro | 1-13 |
| ASCII pipeline diagram | 14-49 |
| Installation | 51-66 |
| Quick Start | 68-114 |
| Graph (Tokensave) Integration | 117-145 |
| Multi-Provider Support | 148-196 |
| MCP Server | 199-253 |
| Brownfield Auto-Discovery | 255-300 |
| Commands | 302-332 |
| Clarification gating | 334-336 |
| Fully Autonomous Mode | 338-373 |
| Configuration | 376-485 |
| Evaluator Strategies | 487-569 |
| Presets | 571-644 |
| E2E Testing with Playwright | 646-673 |
| Architecture | 676-753 |
| Shell Scripts | 756-775 |
| **Contributing** | **779-790** |
| Project Structure (subsection of Contributing) | 792-815 |
| Guidelines (subsection) | 817-823 |
| Acknowledgments | 827-829 |
| Links | 833-838 |
| License | 840-842 |

**Test file:** None (README).

---

## 2. Patterns to Follow

### Pattern 1: `<HARD-GATE>` tag syntax (uppercase, hyphenated)
**Source:** `/tmp/superpowers/skills/brainstorming/SKILL.md:12-14`
```markdown
<HARD-GATE>
Do NOT invoke any implementation skill, write any code, scaffold any project, or take any implementation action until you have presented a design and the user has approved it. This applies to EVERY project regardless of perceived simplicity.
</HARD-GATE>
```
**Rule:** Exact tag = `<HARD-GATE>` and `</HARD-GATE>` — uppercase, hyphenated, no spaces, no attributes. Empirical tuning is around the exact tag (per contract evaluatorNotes). Single occurrence per file expected.

### Pattern 2: `<EXTREMELY-IMPORTANT>` tag (uppercase, hyphenated, multi-line)
**Source:** `/Users/bober4ik/agent-bober/skills/bober.using-bober/SKILL.md:10-16`
```markdown
<EXTREMELY-IMPORTANT>
If you think there is even a 1% chance a skill might apply to what you are doing, you ABSOLUTELY MUST invoke the skill.

IF A SKILL APPLIES TO YOUR TASK, YOU DO NOT HAVE A CHOICE. YOU MUST USE IT.

This is not negotiable. This is not optional. You cannot rationalize your way out of this.
</EXTREMELY-IMPORTANT>
```
**Rule:** Same tag style as HARD-GATE. Reuse this in AGENTS.md to mark non-negotiable contributor rules without introducing a new tag dialect.

### Pattern 3: Verbatim voice port with MIT attribution
**Source:** `/Users/bober4ik/agent-bober/skills/bober.using-bober/SKILL.md:131-133`
```markdown
## Attribution

Structural pattern and voice ported from [obra/superpowers](https://github.com/obra/superpowers) (MIT licensed). Adapted for the agent-bober skill catalog.
```
**Rule:** AGENTS.md must include an attribution footer in the same style. The MIT-attribution requirement also surfaces as a "What We Will Not Accept" category (ported anti-patterns without MIT attribution — see s6-c5 and the bober-specific category list below).

### Pattern 4: Iron Law / Red Flags / Rationalization structure
**Source:** `/Users/bober4ik/agent-bober/skills/bober.using-bober/SKILL.md:20-69` (introduced in Sprint 3 commit e5233ed across 5 agent prompts)
**Rule:** AGENTS.md `## Skill Changes Require Verification` section should reference the Iron Law structure as the protected, behavior-shaping content that cannot be reworded without eval evidence.

---

## 3. Existing Utilities / Tags — DO NOT Recreate

| Pattern | Location | Signature / Form | Purpose |
|---------|----------|------------------|---------|
| `<HARD-GATE>` tag | `/tmp/superpowers/skills/brainstorming/SKILL.md:12-14` | `<HARD-GATE>...</HARD-GATE>` | Block-action-until-condition-met gate. Reuse exact spelling. |
| `<EXTREMELY-IMPORTANT>` tag | `skills/bober.using-bober/SKILL.md:10-16` | `<EXTREMELY-IMPORTANT>...</EXTREMELY-IMPORTANT>` | Mark non-negotiable rules. |
| `<SUBAGENT-STOP>` tag | `skills/bober.using-bober/SKILL.md:6-8` | `<SUBAGENT-STOP>...</SUBAGENT-STOP>` | Subagents skip rule. Mentioned for completeness only; don't add to AGENTS.md. |
| `resolvedClarifications` entry shape | `.bober/specs/spec-20260524-bober-vision.json:resolvedClarifications` | `{questionId, answer, resolvedAt, resolvedBy}` | Standard recording shape (see Section 4 below). |
| `metadata` field on spec | `.bober/specs/spec-20260524-bober-vision.json:238` (and 3 other specs) | `metadata: { ... }` (free-form object on spec root) | Existing spec-level metadata container. The HARD-GATE's `metadata.approvalEvidence` is an **entry-level** metadata field (on the resolvedClarifications entry), not on the spec root — this is a NEW shape. Document it accordingly. |
| MIT attribution footer | `skills/bober.using-bober/SKILL.md:131-133` | `## Attribution\n\nStructural pattern and voice ported from [obra/superpowers](...) (MIT licensed). Adapted for...` | Use the SAME wording style in AGENTS.md. |

---

## 4. resolvedClarifications Shape — Real Examples

**Source (verbatim):** `/Users/bober4ik/agent-bober/.bober/specs/spec-20260524-bober-vision.json`
```json
"resolvedClarifications": [
  {
    "questionId": "Q1",
    "answer": "Prod context: Generic / BYO observability. Design careful-flow mode and diagnose-agent shape with observability access expressed as MCP plugin slots declared in bober.config.json. Do not hard-code Datadog/Sentry/Grafana integrations into core; ship reference adapter docs only. Lets agent-bober work across stacks without becoming a specific stack's tool.",
    "resolvedAt": "2026-05-24T17:30:00Z",
    "resolvedBy": "user"
  },
  ...
]
```

**Second example (planner self-answer):** `/Users/bober4ik/agent-bober/.bober/specs/spec-20260524-superpowers-port.json`
```json
"resolvedClarifications": [
  {
    "questionId": "Q1",
    "answer": "Scope is the prose/skill/agent-prompt tier from the research doc (items #1-5, #9, #10, #12, #13, #15 in the Opportunities table). Defer to future specs: ...",
    "resolvedAt": "2026-05-24T17:05:00Z",
    "resolvedBy": "planner"
  }
]
```

**Existing fields used across all specs:** `questionId`, `answer`, `resolvedAt`, `resolvedBy`.
**HARD-GATE will introduce a NEW field:** `metadata.approvalEvidence` — an array of cited file paths (or `file:line`), only populated when `resolvedBy='planner'` for AUTONOMOUS protocol. This is a new shape the HARD-GATE block defines; the spec schema may need a corresponding documentation update (out of scope for this sprint — generator should just document it in the gate text).

**Specs to grep for confirmation:** all 8 spec files contain `resolvedClarifications` arrays (most are empty `[]`, three are populated: `spec-20260524-bober-vision.json`, `spec-20260524-superpowers-port.json`, `spec-20260416-auto-filter-commands.json`).

---

## 5. README.md Insertion Point — 5-Line Context

**Lines 777-790 (existing Contributing section, verbatim):**
```markdown
---

## Contributing

Contributions are welcome. To set up the development environment:

```bash
git clone https://github.com/BOBER3r/agent-bober.git
cd agent-bober
npm install
npm run build
npm run typecheck
npm test
```
```

**Recommended patch (insert at line 781, between heading and "Contributions are welcome"):**
```markdown
## Contributing

See [AGENTS.md](./AGENTS.md) for contributor discipline including the anti-slop pre-PR checklist.

Contributions are welcome. To set up the development environment:
```

Alternative location: at the very end of the Contributing section's Guidelines subsection (line 823), as a closing reminder. The opening placement is preferred because contributors read top-down.

---

## 6. skills/bober.using-bober/SKILL.md — Existing AGENTS.md References

**Three mentions exist; lines 30, 34, 36.**

**Line 30 (priority list):**
```markdown
1. **User's explicit instructions** (CLAUDE.md, AGENTS.md, direct requests) — highest priority
```

**Line 34 (instruction-priority example):**
```markdown
If CLAUDE.md or AGENTS.md says "don't use TDD" and a skill says "always use TDD," follow the user's instructions. The user is in control.
```

**Line 36 (Sprint 1 forward reference — the placeholder that this sprint resolves):**
```markdown
See AGENTS.md at the repo root for the contributor discipline — this file defines non-negotiable project conventions (it is created in a later sprint; treat its absence as a forward reference).
```

**Required action per contract s6-c8:**
- Once AGENTS.md is created, the forward-reference text "(it is created in a later sprint; treat its absence as a forward reference)" becomes stale and CAN be removed. Recommended refined wording:
  > "See [AGENTS.md](../../AGENTS.md) at the repo root for the contributor discipline — this file defines non-negotiable project conventions."
- The other two mentions (lines 30, 34) are generic priority statements and do NOT need editing.
- Contract evaluator verification: `grep skills/bober.using-bober/SKILL.md for 'AGENTS.md'` + verify `AGENTS.md` exists at repo root. Minimum bar: target file resolves. Preferred bar: stale "later sprint" hedge removed.

---

## 7. Bober-Specific "What We Will Not Accept" Categories (5-6 required)

Derived from contract evaluatorNotes and the agent-bober project surface:

1. **Invented file paths in contracts.** Sprint contracts (`.bober/contracts/*.json`) that list `expectedChanges.path` values pointing to nonexistent files or files outside the actual project layout. Every path must resolve or be a legitimate `create` action.
2. **Success criteria contradicting contracts.** PR descriptions or commit messages that claim success-criteria pass while the actual change diverges from the contract's `expectedChanges` or `successCriteria`. The Iron Law (Sprint 3, commit e5233ed) is non-negotiable.
3. **Sprint output touching files outside `expectedChanges`.** Generators that modify files not listed in the contract. Scope creep is a contract violation, not a feature.
4. **Evaluator pass-claims without strategy output.** Eval results (`.bober/eval-results/*.json`) that report `passed: true` without the corresponding strategy command output (typecheck, lint, build, test). Pass-claims must include the runnable verification log.
5. **Code-reviewer findings without `file:line`.** Sprint 5 introduced `agents/bober-code-reviewer.md`. Review findings must cite `file:line` — the advisory orchestrator wiring (commits ac29dda, 2cd7b9d, b5568ba, 40af59a) is the discipline; PRs that cite vague "in the auth module" don't pass.
6. **Ported anti-patterns without MIT attribution.** Sprint 4 introduced `.bober/anti-patterns/` ported from superpowers (MIT licensed). Any addition to this catalog or to skill prose ported from superpowers must include the MIT-attribution footer (pattern in Section 2 above).

Optional 7th (only if line budget permits): **Voice-softening edits to behavior-shaping content.** The Sprint 3 voice pass (Iron Law / Red Flags / Rationalization) is empirically tuned. PRs that soften `EXTREMELY-IMPORTANT`, replace `slop` with "low-quality", or substitute "the user" for "your human partner" require eval evidence.

---

## 8. HARD-GATE Block — Verbatim Template (COPY-PASTE)

This is the template from the contract `generatorNotes`. The generator should copy it as-is into `skills/bober.plan/SKILL.md` immediately after line 153 (and before line 155). Do not paraphrase.

```markdown
<HARD-GATE>
Do NOT write any .bober/contracts/*.json file until one of the following has happened:

1. INTERACTIVE protocol — the user has explicitly approved the assumptions and outOfScope sections above. Record approval as a resolvedClarifications entry with questionId='gate-design-approval' and the user's verbatim approval in the answer field.

2. AUTONOMOUS protocol — every assumption in the spec is backed by cited evidence (minimum: a file path; preferred: file:line). Record self-approval as resolvedClarifications entry with questionId='gate-design-approval', answer='Autonomous self-approval', resolvedBy='planner', and metadata.approvalEvidence field listing the cited file paths.

Violating this gate produces orphan contracts that diverge from the spec. Discovered violations result in contracts being deleted and spec status reverted to 'needs-clarification'.
</HARD-GATE>
```

**Placement rule:** This block goes between the existing `## Step 5` block (ends line 153) and the existing `## Step 6` heading (line 155). Surrounding text MUST remain unchanged. The diff should show ONLY an insertion at line 154.

**Verbatim discipline:** The contract evaluator will diff against this template. Do NOT reword, reformat tables, or "clean up" the prose.

---

## 9. Implementation Sequence

1. **Modify `skills/bober.plan/SKILL.md`** — insert the HARD-GATE block from Section 8 at line 154 (between Step 5 ending at line 153 and Step 6 starting at line 155).
   - Verify: `grep -c '<HARD-GATE>' skills/bober.plan/SKILL.md` returns `1`.
   - Verify: `grep -n '<HARD-GATE>\|## Step 5\|## Step 6' skills/bober.plan/SKILL.md` shows Step 5 → HARD-GATE → Step 6 in that order.
   - Verify: `grep -n 'Step 7.5' skills/bober.plan/SKILL.md` still returns line ~213 with the ambiguity-score rubric intact.
   - Verify: `git diff skills/bober.plan/SKILL.md` shows ONLY additions (no lines removed from Step 5 or Step 6 prose).

2. **Create `AGENTS.md` at repo root** (`/Users/bober4ik/agent-bober/AGENTS.md`) — verbatim port from `/tmp/superpowers/AGENTS.md` with the 5 required sections in order:
   - `## If You Are an AI Agent` (>=4 numbered pre-PR checks)
   - `## Pull Request Requirements`
   - `## What We Will Not Accept` (>=5 bober-specific categories from Section 7)
   - `## Evidence Requirements` (NEW section — file:line discipline, eval logs, MIT attribution)
   - `## Skill Changes Require Verification` (reference Iron Law structure from Sprint 3 + the verbatim-voice directive)
   - Preserve `slop` / `your human partner` / `EXTREMELY-IMPORTANT` somewhere (at least one).
   - Replace 94%-rejection statistic with bober-context framing.
   - Drop superpowers-specific examples (`Let's make a react todo list` acceptance test, `using-superpowers` bootstrap reference, `superpowers:writing-skills` tool).
   - Add MIT-attribution footer matching the pattern in `skills/bober.using-bober/SKILL.md:131-133`.
   - Verify: `wc -l AGENTS.md` between 120 and 600.
   - Verify: `grep -c '## If You Are an AI Agent\|## Pull Request Requirements\|## What We Will Not Accept\|## Evidence Requirements\|## Skill Changes Require Verification' AGENTS.md` returns 5.
   - Verify: `grep -E 'slop|your human partner|EXTREMELY-IMPORTANT' AGENTS.md` returns at least one match.

3. **Modify `README.md`** — add the AGENTS.md cross-link at line 781 (right under the `## Contributing` heading, before "Contributions are welcome").
   - Verify: `grep -n 'AGENTS.md' README.md` returns at least one line in the Contributing section.

4. **Refine `skills/bober.using-bober/SKILL.md` line 36** — remove the stale "(it is created in a later sprint; treat its absence as a forward reference)" hedge. Update to a clean cross-reference to the now-existing file.
   - Verify: `test -f AGENTS.md && grep AGENTS.md skills/bober.using-bober/SKILL.md` resolves.
   - Verify: the forward-reference parenthetical is gone (or re-worded to past tense).

5. **Run full verification** — per contract s6-c9:
   - `npm run typecheck` (exit 0)
   - `npm run lint` (exit 0)
   - `npm run build` (exit 0)
   - `npm test` (exit 0)
   - These should all still pass — this sprint touches no src/ code.

---

## 10. Verification Checklist (per contract success criterion)

| Criterion | Self-check command / inspection |
|-----------|--------------------------------|
| **s6-c1** — exactly one `<HARD-GATE>` block between Step 5 and Step 6 | `grep -c '<HARD-GATE>' skills/bober.plan/SKILL.md` returns `1`; `grep -n '<HARD-GATE>\|## Step 5\|## Step 6' skills/bober.plan/SKILL.md` shows order Step 5 → HARD-GATE → Step 6 |
| **s6-c2** — gate names both protocols + forbidden action | Read gate block; confirm strings `INTERACTIVE`, `AUTONOMOUS`, `.bober/contracts/*.json` all present |
| **s6-c3** — recording protocols documented | Confirm `questionId='gate-design-approval'` appears twice; `metadata.approvalEvidence` appears once for AUTONOMOUS |
| **s6-c4** — AGENTS.md exists at repo root, >=120 lines, 5 sections in order | `test -f AGENTS.md && wc -l AGENTS.md`; `grep -n '^## ' AGENTS.md` to verify section order |
| **s6-c5** — >=4 numbered pre-PR checks; >=5 "Won't Accept" categories | Count numbered items under `## If You Are an AI Agent`; count `###` subsections or list items under `## What We Will Not Accept` |
| **s6-c6** — verbatim voice preserved | `grep -E 'slop\|your human partner\|EXTREMELY-IMPORTANT' AGENTS.md` returns >=1 match; 94% statistic absent or replaced with bober framing |
| **s6-c7** — README links to AGENTS.md | `grep -n 'AGENTS.md' README.md` returns line in Contributing section |
| **s6-c8** — bober.using-bober AGENTS.md reference resolves | `test -f AGENTS.md && grep 'AGENTS.md' skills/bober.using-bober/SKILL.md` |
| **s6-c9** — all existing eval strategies pass | `npm run typecheck && npm run lint && npm run build && npm test` all exit 0 |

**Additional evaluator checks (from evaluatorNotes):**
- HARD-GATE block is an INSERT, not a REPLACE — `git diff skills/bober.plan/SKILL.md` shows only additions, no removed lines from Step 5/Step 6 content.
- Tag syntax is exact: `<HARD-GATE>` / `</HARD-GATE>` (uppercase, hyphenated, no attributes).
- AGENTS.md `## What We Will Not Accept` categories are bober-relevant (not copy-pasted superpowers items like "compliance with Anthropic skills docs").
- AGENTS.md file <=600 lines (source body is ~400, contract caps at 600).
- HARD-GATE does NOT contradict Step 7.5 ambiguity-score logic — the gate text should make clear it runs BEFORE Step 6, and Step 7.5 still runs after Step 7.

---

## 11. Pitfalls & Warnings

- **HARD-GATE must be exactly `<HARD-GATE>` — case-sensitive, hyphenated.** Variants like `<hard-gate>`, `<HARDGATE>`, `<HARD_GATE>` will fail the evaluator's grep check. Empirical tuning is around this exact spelling (per evaluatorNotes).
- **Do NOT modify Step 5 or Step 6 prose.** The gate is purely INSERTED at line 154. The contract evaluator does textual diff to confirm.
- **Do NOT introduce a second `<HARD-GATE>` block elsewhere.** Criterion s6-c1 requires "exactly one occurrence."
- **Do NOT remove or reword Step 7.5** (lines 213-252). The HARD-GATE is design approval; Step 7.5 is ambiguity scoring. Both coexist. EvaluatorNotes explicitly check: "Confirm gate does NOT contradict existing Step 7.5."
- **Do NOT soften voice in AGENTS.md.** This contract's voice constraint is the REVERSE of the abandoned earlier spec — `slop`, `your human partner`, `EXTREMELY-IMPORTANT` are PRESERVED, not removed. The contract calls this out explicitly in s6-c6 and the evaluatorNotes.
- **DO replace the 94%-rejection statistic.** The 94% number is superpowers-specific; fabricating an agent-bober equivalent is a "What We Will Not Accept" violation in spirit. Use framing like "this project rejects agent-authored PRs that lack human review evidence."
- **AGENTS.md MUST be at repo root** (`/Users/bober4ik/agent-bober/AGENTS.md`) — NOT in `docs/`, NOT in `.github/`, NOT in `skills/`. EvaluatorNotes: "verify file is at REPO ROOT (not docs/)."
- **Stay under 600 lines.** Source is ~106 lines + bober additions should land in the 150-300 range. 600 is the absolute ceiling.
- **`## Skill Changes Require Verification`** — note the contract heading wording (`Verification`) differs from the source's `## Skill Changes Require Evaluation`. Use the contract wording. This subsection should reference Sprint 3's Iron Law / Red Flags / Rationalization structure and Sprint 4's anti-pattern catalog as the protected behavior-shaping content.
- **MIT attribution is mandatory** for AGENTS.md (since it ports voice from superpowers). Match the wording at `skills/bober.using-bober/SKILL.md:131-133`.
- **No src/ changes.** This is a docs-only sprint. Any change under `src/` indicates scope creep — recheck the contract `expectedChanges` list.
- **Refining `skills/bober.using-bober/SKILL.md:36`** is not in the contract's `expectedChanges` list literally, but criterion s6-c8 says "The Sprint 1 placeholder reference is preserved or refined here." "Refined" means editing the line is permitted and recommended. The strict-scope reading is "preserved" — i.e., do nothing — but that leaves a stale hedge in the file. Recommend the refinement; if the evaluator flags it as scope creep, fall back to preserving verbatim.
