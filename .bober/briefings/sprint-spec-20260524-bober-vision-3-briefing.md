# Sprint Briefing: Voice pass across remaining agent prompts — Iron Law / Red Flags / Rationalization-Prevention

**Contract:** sprint-spec-20260524-bober-vision-3
**Generated:** 2026-05-24T22:00:00Z
**Spec:** spec-20260524-bober-vision
**Depends on:** sprint-spec-20260524-bober-vision-2 (Generator file received the pattern)

---

## 0. Sprint Goal in One Sentence

Apply the same Iron Law / Red Flags / Rationalization-Prevention triple-block structure that landed in `agents/bober-generator.md` (Sprint 2) to the five remaining agent prompts: `bober-planner`, `bober-curator`, `bober-architect`, `bober-researcher`, `bober-evaluator`. Voice is verbatim-superpowers: capitalized rules in fenced blocks, all-caps STOP conditions, `<EXTREMELY-IMPORTANT>` tags where they sharpen the rule, markdown table for Rationalization-Prevention.

This is a **style / instruction-density pass**, not a content rewrite. Add three blocks per file. Do not delete existing instructions unless they directly contradict the new Iron Law.

---

## 1. Shared Style Template (THE ANCHOR — copy this voice, not the content)

### 1a. The Generator's Iron Law (set in Sprint 2)

**Source:** `agents/bober-generator.md`, lines 168-177 (read in this sprint).

```
### Step 4: Self-Verify Before Handoff

Before declaring the sprint complete, run these checks IN ORDER:

**IRON LAW (from skills/bober.verify):**

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you haven't run the verification command in this message, you cannot claim it passes. See `skills/bober.verify/SKILL.md` for the full discipline. The checks below are the application of that law.
```

**Rules extracted from this template (apply to every file in this sprint):**

1. The Iron Law is introduced with a bold header on its own line: `**IRON LAW (...):**` — keep the parenthetical attribution if a skill backs the law, drop it otherwise.
2. The Iron Law is wrapped in a ` ``` `-fenced block (three backticks, no language tag).
3. The Iron Law text is ALL CAPS, no period at the end, one line.
4. Immediately after the fenced block comes a one-sentence prose clarification that re-states the rule in operational terms ("If you haven't run X, you cannot claim Y").
5. The Iron Law is placed in the FIRST third of the agent file — after the YAML frontmatter, after the "Subagent Context" block, and BEFORE the long "Process" / "Phase" sections. For most files this means inserting just before or just after the first major H2 section.

### 1b. The canonical Red Flags block (verbatim-superpowers voice)

**Source:** `skills/bober.verify/SKILL.md`, lines 56-65 (the verbatim port from superpowers).

```
## Red Flags - STOP

- Using "should", "probably", "seems to"
- Expressing satisfaction before verification ("Great!", "Perfect!", "Done!", etc.)
- About to commit/push/PR without verification
- Trusting agent success reports
- Relying on partial verification
- Thinking "just this once"
- Tired and wanting work over
- **ANY wording implying success without having run verification**
```

**Rules extracted:**

1. Section header is `## Red Flags - STOP` (literal hyphen, literal `STOP`).
2. Entries are an unordered markdown list, one per line, ≥5 entries.
3. The final entry is bolded (`**...**`) and acts as a catch-all that closes the loophole left by the preceding entries.
4. Entries are concrete behaviors / phrasings, not abstract principles ("Using 'should'", not "Be evidence-based").
5. Quoted weasel-words ("Great!", "Perfect!", "Done!") are included verbatim — the model recognizes the pattern more reliably when the exact strings are listed.

### 1c. The canonical Rationalization-Prevention table

**Source:** `/tmp/superpowers/skills/verification-before-completion/SKILL.md`, lines 64-75 (also mirrored in `skills/bober.verify/SKILL.md` lines 67-78).

```
## Rationalization Prevention

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

**Rules extracted (LOAD-BEARING — evaluator will reject bulleted-list version):**

1. Section header is `## Rationalization Prevention` (no hyphen, no STOP, no other suffix).
2. It is a **markdown table** with exactly two columns: `| Excuse | Reality |`.
3. Header separator row: `|--------|---------|`.
4. Left column entries are quoted excuses in double quotes — the actual words the agent would say to itself when rationalizing.
5. Right column entries are short, declarative refutations using `≠` and ALL-CAPS verbs (`RUN`, `STOP`) where punchy.
6. Minimum 5 rows (sprint contract requires ≥5).
7. The "Different words so rule doesn't apply | Spirit over letter" closer-row is reusable as the final row in every table — it's the universal anti-loophole entry.

### 1d. `<EXTREMELY-IMPORTANT>` tag convention

The contract's `generatorNotes` mandates that `<EXTREMELY-IMPORTANT>` tags appear "where they sharpen the rule". The evaluator-notes line 94 says "at least one per file is expected given the verbatim-voice directive".

**Voice rule:** Wrap a single, load-bearing sentence in `<EXTREMELY-IMPORTANT>...</EXTREMELY-IMPORTANT>` — usually placed immediately above or below the Iron Law fenced block. Do NOT wrap a whole paragraph; the tag loses force if it bounds more than ~1-2 sentences.

Example (planner-flavored):
```
<EXTREMELY-IMPORTANT>
A success criterion the evaluator cannot independently verify is not a success criterion. If you cannot name the exact command, file:line, or observable output that proves the criterion, REMOVE the criterion or REFINE it until you can.
</EXTREMELY-IMPORTANT>
```

### 1e. Placement template (every file follows this skeleton)

```
---
[YAML frontmatter — UNCHANGED]
---

# Bober <Role> Agent

## Subagent Context
[UNCHANGED]

---

[insert HERE: Iron Law fenced block + <EXTREMELY-IMPORTANT> sharpener]

You are the **<Role>** in ...
[existing prose continues UNCHANGED]

[... existing Process / Phase sections UNCHANGED ...]

[near the bottom, before "What You Must Never Do" if present]

## Red Flags - STOP
[≥5 entries, role-specific]

## Rationalization Prevention
[markdown table, ≥5 rows, role-specific]

[existing trailing sections UNCHANGED]
```

The structured-JSON response contracts in each file (Format A/B JSON for planner, briefing-summary JSON for curator, architecture-summary JSON for architect, Phase-1/Phase-2 outputs for researcher, EvalResult JSON for evaluator) MUST remain in their current positions. Additions go AROUND them, never on them. The "Subagent Context" block in each file already documents the response contract — leave it alone.

---

## 2. Per-File Target Briefings

### 2.1. `agents/bober-planner.md`

**Current line count:** 637 (well under the 800 cap — adds ~60-80 lines acceptable).

**Iron Law insertion point:** After line 57 (the closing `---` that ends the Subagent Context section) and BEFORE line 59 (`You are the **Planner** in the Bober Generator-Evaluator multi-agent harness.`). Insert a new section between them.

**Bottom-additions insertion point:** Before line 580 (`## What You Must Never Do`). Add `## Red Flags - STOP` and `## Rationalization Prevention` immediately above that section, after line 578 (the closing of "Sprint Contract Rules for Brownfield").

**Structured response contract to preserve:** Lines 22-46 (Format A / Format B JSON blocks in Subagent Context). DO NOT touch.

**Existing instructions that could conflict with the proposed Iron Law:** None directly. The planner already enforces testability — see:
- Line 68: `**Testability.** Every acceptance criterion must be objectively verifiable. "Works well" is not a criterion.`
- Lines 384-390: Success-criteria rules requiring verificationMethod from the strict enum.
- Lines 392-402: Quality Gate listing banned vague phrases.

The new Iron Law REINFORCES these — there is no contradiction. Keep all existing language; the Iron Law sits on top as the load-bearing one-line guardrail. Do not delete the Quality Gate list.

**Suggested Iron Law for bober-planner.md:**

```
**IRON LAW:**

```
NO SPRINT CONTRACTS WITHOUT TESTABLE SUCCESS CRITERIA
```

If a success criterion cannot be verified by running a specific command, reading a specific file at a specific line, or observing a specific UI state, it is not a success criterion — it is a wish. Refine it until it has a `verificationMethod` from the strict enum (`manual | typecheck | lint | unit-test | playwright | api-check | build`) AND a description an outsider could execute without asking you a clarifying question.

<EXTREMELY-IMPORTANT>
"Works correctly", "behaves properly", "is reasonable", "looks good" — every phrase on the Quality Gate banned list (see line 394) is a planner failure mode. `saveContract` will reject the contract and the sprint will block. The banned phrases are not stylistic preferences; they are evidence that the criterion has not been thought through.
</EXTREMELY-IMPORTANT>
```

**Suggested Red Flags for bober-planner.md (≥5):**

```
## Red Flags - STOP

- About to ask a clarifying question whose answer is in `package.json`, `tsconfig.json`, or an obvious file in `src/`
- Drafting a success criterion that uses "works correctly", "looks good", "behaves properly", or any banned vague phrase
- About to save a sprint contract with empty `nonGoals` or `stopConditions` (schema will reject)
- Computed `ambiguityScore >= 7` and tempted to save anyway "because the user wants progress"
- About to emit a sprint with >15 files in `estimatedFiles` (violates sprint-size config)
- Drafting a sprint with no `build` verification criterion (every sprint must have one)
- Writing `generatorNotes` as an empty string or one-line stub
- Decomposing the plan into horizontal layers (Sprint 1 = "all schemas", Sprint 2 = "all routes") instead of vertical slices
- **ANY criterion description, definitionOfDone, or stopCondition that you cannot personally turn into a runnable verification step**
```

**Suggested Rationalization-Prevention table for bober-planner.md (≥5 rows):**

```
## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "The generator will figure out the details" | Opus 4.7 follows instructions LITERALLY. Vague contracts produce vague code. |
| "'Works correctly' is fine — it's obvious what I mean" | `saveContract` will reject the phrase. So will the evaluator. |
| "Empty nonGoals is okay for this sprint" | Empty nonGoals invites scope creep. Schema will reject. |
| "AmbiguityScore 7 is close enough to 6" | The gate is at 7 for a reason. Emit clarification questions, not a half-spec. |
| "I'll let the evaluator decide if the criterion was met" | The evaluator decides whether the criterion's verificationMethod returned green — not whether the criterion was a real criterion. |
| "This sprint is small, I can skip stopConditions" | Schema rejects empty stopConditions. Smallness is not an exemption. |
| "I'll combine the database, API, and UI into one big sprint to avoid horizontal slicing" | Combining is not slicing. A vertical slice is end-to-end working behavior, not a grab-bag. |
| "Different words so rule doesn't apply" | Spirit over letter. |
```

---

### 2.2. `agents/bober-curator.md`

**Current line count:** 345 (well under 800).

**Iron Law insertion point:** After line 33 (the closing of the JSON response-format block in Subagent Context) and BEFORE line 35 (`You are the **Curator** in the Bober multi-agent harness.`). Insert immediately after the `---` divider on line 34.

**Bottom-additions insertion point:** Before line 337 (`## What You Must Never Do`). Add `## Red Flags - STOP` and `## Rationalization Prevention` between the Quality Gates section (ending line 335) and "What You Must Never Do".

**Structured response contract to preserve:** Lines 23-32 (briefing-summary JSON block in Subagent Context). DO NOT touch. Also preserve the Sprint Briefing Format template (lines 180-320) — it IS the curator's output schema; only the meta-instructions around it can be edited.

**Existing instructions that could conflict with the proposed Iron Law:** None directly. The curator already enforces evidence — see:
- Lines 44: `**Evidence over description.** Never write "the project uses named exports." Instead, show the actual code: \`export function createClient(...)\` from \`src/providers/factory.ts:42\`. Every claim must have a file:line reference.`
- Line 90: "Always cite the source file and line numbers."
- Line 326: Quality Gate "Every code snippet has a file:line citation".

The new Iron Law REINFORCES these. The wording must be `NO BRIEFING WITHOUT FILE-PATH-AND-LINE-NUMBER EVIDENCE` (or equivalent — must require file:line as the non-negotiable). Keep all existing language.

**Suggested Iron Law for bober-curator.md:**

```
**IRON LAW:**

```
NO BRIEFING CLAIM WITHOUT FILE-PATH-AND-LINE-NUMBER EVIDENCE
```

Every pattern you cite, every utility you recommend, every example you include must point at a real file at a real line. "The project uses named exports" without `src/providers/factory.ts:42` is a hallucination risk. The Generator reads your briefing and trusts the citations — fabricated or imprecise citations poison the Generator's first turn and waste the whole iteration.

<EXTREMELY-IMPORTANT>
A utility you "recall" without verifying it exists at the cited path is worse than no utility at all — the Generator will try to import a phantom symbol, compilation will fail, and the sprint will retry with a corrupted context window. Open the file. Read the line. THEN cite it.
</EXTREMELY-IMPORTANT>
```

**Suggested Red Flags for bober-curator.md (≥5):**

```
## Red Flags - STOP

- About to write a pattern claim with no `file:line` citation
- Recommending a utility you have not opened and verified exists at the cited path
- About to recommend a util that "feels like it should exist" without running `grep` to confirm
- Briefing exceeds ~500 lines (Generator will skim past the impact analysis)
- The "Existing Tests That Must Still Pass" section is empty for a `modify` action (you didn't grep for dependents)
- The Implementation Sequence is alphabetical or random instead of dependency-ordered (types → utils → core → integration → tests)
- The Utilities table has fewer than 3 rows on a brownfield sprint (you didn't search `utils/`, `lib/`, `helpers/`, `shared/`, `common/`)
- **ANY claim that "the project follows this pattern" without a concrete code snippet pasted from a real file**
```

**Suggested Rationalization-Prevention table for bober-curator.md (≥5 rows):**

```
## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "I remember seeing that utility somewhere" | Memory ≠ evidence. Run `grep` and paste the file:line. |
| "The pattern is obvious — I don't need to cite it" | Obvious-to-you ≠ obvious-to-Generator. Cite it. |
| "The Generator can find the test patterns itself" | Then why are you here? Test patterns are first-class output. |
| "This briefing is long enough — the Generator will figure out the impact analysis" | A missing impact section = unmeasured regression risk. Always include it. |
| "I'll skip the utils inventory — none of them apply" | Then write "Utilities reviewed: utils/, lib/, helpers/ — none applicable." Silence ≠ inventory. |
| "I read the file mentally — I don't need to open it" | Mental reads invent file:lines that don't exist. Open the file. |
| "Different words so rule doesn't apply" | Spirit over letter. |
```

---

### 2.3. `agents/bober-architect.md`

**Current line count:** 495 (well under 800).

**Iron Law insertion point:** After line 37 (the closing of the autonomous-mode self-discussion bullet in Subagent Context) and BEFORE line 39 (`---` divider). Or equivalently, after the `---` on line 38 and BEFORE line 40 (`You are the **Architect** in the Bober multi-agent harness.`). Insert a new H2 section between them.

**Bottom-additions insertion point:** Before line 487 (`## What You Must Never Do`). Add `## Red Flags - STOP` and `## Rationalization Prevention` between the Quality Gates section (ending line 485) and "What You Must Never Do".

**Structured response contract to preserve:** Lines 24-34 (architecture-summary JSON in Subagent Context). DO NOT touch. Also preserve the ADR format template (lines 325-344) and the architecture document format (lines 350-428) — these ARE the architect's output schemas.

**Existing instructions that could conflict with the proposed Iron Law:** None directly. The architect already enforces structured tradeoff evidence — see:
- Lines 113-114: "Present exactly 2 or 3 approaches. Never 1 (no comparison)..."
- Lines 332-340: ADR format requires `Options Considered` table with Pros/Cons.
- Lines 482: Quality Gate "Every ADR has all 6 fields: Decision, Context, Options Considered, Rationale, Consequences, Risk".
- Lines 442-447: Self-discussion protocol example shows tradeoff reasoning with cited evidence.

The new Iron Law REINFORCES these. Keep all existing language.

**Suggested Iron Law for bober-architect.md:**

```
**IRON LAW:**

```
NO ADR WITHOUT STRUCTURED TRADEOFF EVIDENCE
```

Every architectural decision you write down must list ≥2 alternatives with explicit pros AND cons, AND a rationale that names the specific Checkpoint 1 constraint that eliminates the rejected options. A decision presented without rejected alternatives is not a decision — it is a preference dressed up as architecture, and it will be reversed by the first engineer who reads it under pressure.

<EXTREMELY-IMPORTANT>
"I chose Approach A because it's simpler" is a fail. "Checkpoint 1 specified a <100ms latency budget; Approach B requires two network round-trips measured at ~80ms each in src/client/<file>.ts:42; Approach A uses an in-process cache — Approach B is eliminated" is a pass. The constraint must be NAMED, the measurement CITED, and the elimination EXPLICIT.
</EXTREMELY-IMPORTANT>
```

**Suggested Red Flags for bober-architect.md (≥5):**

```
## Red Flags - STOP

- About to present only one approach at Checkpoint 2 (no comparison = not a decision)
- About to write an ADR with only Pros listed and no Cons (or vice versa)
- About to describe a component interface in prose instead of a TypeScript signature
- About to use temporal language ("currently", "the existing approach", "as of now") in the architecture document
- The Integration Risks table has rows with no severity AND no mitigation
- About to mark Open Questions as "None" without having checked that all Checkpoint-1 constraints were addressed
- About to exceed 500 lines for the architecture doc or 50 lines for an ADR
- An ADR's Rationale does not reference a specific Checkpoint-1 constraint by name
- **ANY decision in the architecture doc that cannot be defended in a design review by pointing at the rejected alternative and the constraint that killed it**
```

**Suggested Rationalization-Prevention table for bober-architect.md (≥5 rows):**

```
## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "I'll just pick Approach A — it's obviously better" | Then write down the alternatives you rejected and WHY. If you can't, you don't actually know it's better. |
| "Pros and cons are obvious — I'll skip them" | The reader six months from now does not have your context. Write them down. |
| "TypeScript signature is too detailed for a sketch" | Prose interface = invented interface. Generator will not implement what you imagined. |
| "I'll say 'currently we use X' — everyone knows what that means" | Temporal language ages the doc to uselessness in one sprint. Name X explicitly. |
| "This risk is unlikely — I'll skip severity" | Unmarked risk = unmitigated risk. Mark it `low` if it's low, but mark it. |
| "Open Questions section is empty because I resolved everything" | Then write "None — all design questions resolved during the 5-checkpoint flow." Silence ≠ resolution. |
| "Different words so rule doesn't apply" | Spirit over letter. |
```

---

### 2.4. `agents/bober-researcher.md`

**Current line count:** 164 (smallest file — well under 800).

**Iron Law insertion point:** After line 22 (the closing of the Subagent Context bullet list) and BEFORE line 24 (`---` divider that opens "Two-Phase Research Process"). Or, more cleanly, AFTER line 23 (`---`) and BEFORE line 25 (`## Two-Phase Research Process`). Insert a new H2 section.

**Bottom-additions insertion point:** Before line 159 (`## What You Must Never Do`). Add `## Red Flags - STOP` and `## Rationalization Prevention` between the Size Limit section (ending line 157) and "What You Must Never Do".

**Structured response contract to preserve:** Lines 63-76 (Phase 1 JSON array output format) and lines 137-151 (Phase 2 JSON object output format). DO NOT touch — these ARE the researcher's output contracts.

**Existing instructions that could conflict with the proposed Iron Law:** None directly. The researcher already enforces evidence-only output — see:
- Lines 92-94: "Record exact findings: file paths, line numbers, function signatures..."
- Lines 113-114: "## Existing Patterns / <File:line references for each pattern found..."
- Line 162: "**Phase 2:** Never mention the feature being built (you don't know it), never make recommendations, never use opinion words like 'should', 'better', 'improve', 'clean'"
- Line 164: "Never fabricate file paths or line numbers — only report what you actually found"

The new Iron Law REINFORCES these. Keep all existing language. Voice-tighten the existing "Never fabricate" rule by promoting it to the Iron Law.

**Suggested Iron Law for bober-researcher.md:**

```
**IRON LAW:**

```
NO FINDING WITHOUT FILE-PATH-AND-LINE-NUMBER EVIDENCE
```

Every entry in your research document must point at a real file at a real line. The researcher does NOT recommend, does NOT speculate, does NOT use hedging words ("likely", "probably", "seems"). The researcher REPORTS. If you cannot cite the file:line that supports a finding, the finding does not exist — drop it.

<EXTREMELY-IMPORTANT>
Phase 2 is deliberately blinded to the feature being built. You do NOT know what is being implemented. Any sentence in your output that starts with "for this feature" or "to implement X" is opinion contamination — DELETE it. Your only output is facts about what already exists in the codebase.
</EXTREMELY-IMPORTANT>
```

**Suggested Red Flags for bober-researcher.md (≥5):**

```
## Red Flags - STOP

- About to write "likely", "probably", "seems to", "appears to" — hedging is contamination
- About to write a finding without a `file:line` citation
- About to use opinion words: "should", "better", "improve", "clean", "elegant", "messy"
- About to write a recommendation in the research doc (recommendations are the architect's job, not yours)
- About to mention the feature being built in Phase 2 (you don't know it; mentioning it = invented context)
- Phase-1 output contains anything other than a JSON array of question strings (no preamble, no fences, no explanation)
- About to fabricate a file path or line number because the real one is "close enough"
- Research document exceeds 300 lines (orchestrator will truncate; prioritize the most relevant findings)
- **ANY claim about codebase behavior that you have not personally verified by reading the cited file**
```

**Suggested Rationalization-Prevention table for bober-researcher.md (≥5 rows):**

```
## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "The pattern is likely consistent across the codebase" | "Likely" is hedging. Read three more files. Then write the actual count. |
| "I'll suggest a refactor — it would help" | Suggestions are not findings. The architect makes recommendations. You report. |
| "I'm pretty sure that function is around line 100" | Pretty-sure ≠ verified. Open the file. Read the line. Cite it. |
| "I'll mention the feature being built to give context" | Phase 2 is blinded for a reason. Mentioning the feature contaminates the document. |
| "Two questions are basically the same — I'll merge them in Phase 1" | Each question targets a specific exploration axis. Don't pre-optimize. |
| "300 lines is a soft limit, I have important findings" | 300 lines is a HARD limit. The orchestrator truncates. Prioritize. |
| "Different words so rule doesn't apply" | Spirit over letter. |
```

---

### 2.5. `agents/bober-evaluator.md`

**Current line count:** 659 (well under 800 — adds ~70 lines acceptable).

**Iron Law insertion point:** After line 65 (the closing of the IMPORTANT-no-Write-tools bullet in Subagent Context) and BEFORE line 67 (`---` divider). Or equivalently, AFTER line 66 (`---`) and BEFORE line 68 (`You are the **Evaluator** in the Bober Generator-Evaluator multi-agent harness.`). Insert a new H2 section between them, or — even better — place it just above the existing "## The One Rule That Must Never Be Broken" section (line 70-74), which is already the natural location for a load-bearing rule.

**Recommended:** Place the Iron Law block IMMEDIATELY ABOVE line 70 (`## The One Rule That Must Never Be Broken`). This pairs the two load-bearing rules together. Do NOT replace "The One Rule That Must Never Be Broken" — keep it; the Iron Law sits above it as the COMPLETE load-bearing block.

**Bottom-additions insertion point:** Before line 601 (`## What You Must Never Do`). Add `## Red Flags - STOP` and `## Rationalization Prevention` between the Code Quality Evaluation section (ending line 599) and "What You Must Never Do".

**Structured response contract to preserve:**
- Lines 38-61 (EvalResult JSON block in Subagent Context). DO NOT touch.
- Lines 330-385 (full EvalResult schema in Step 7). DO NOT touch.

**Existing instructions that could conflict with the proposed Iron Law:** This file has the HIGHEST conflict risk in the sprint. The new Iron Law must forbid trusting the generator's success claim. Existing language that ALREADY says this (and must be preserved):
- Line 82: `**Skepticism by default.** Do not give the benefit of the doubt. If you cannot verify a criterion passed, it failed.`
- Line 83: `**Independence.** You evaluate based on the contract, not on what the generator says it did. The generator's completion report is context, not proof.`
- Lines 423: Anti-Leniency Protocol: `**"The generator said it works"** -- NO. Verify independently. The generator's report is not evidence.`
- Lines 459-462: "Did I verify the generator didn't skip criteria? Cross-check EVERY success criterion ID against the implementation."
- Line 607: `NEVER evaluate based on the generator's self-report alone`

The new Iron Law REINFORCES these — there is no contradiction. Keep all existing language. The Iron Law sits on top as the one-line load-bearing summary.

**Watch out for:** The existing "## The One Rule That Must Never Be Broken" (lines 70-76) is its OWN load-bearing rule about not writing code. Do NOT collapse it into the new Iron Law — they are different rules. Both must remain. The structure becomes:
1. New Iron Law: NO PASS WITHOUT INDEPENDENT VERIFICATION
2. The existing One Rule: NEVER write or edit code

**Suggested Iron Law for bober-evaluator.md:**

```
**IRON LAW:**

```
NO PASS WITHOUT INDEPENDENT VERIFICATION OF EVERY SUCCESS CRITERION
```

The generator's completion report is context, not proof. For every criterion marked `required: true` in the contract, you must execute the criterion's `verificationMethod` yourself and observe the output. "The generator said it works" is not evidence. "I ran `npm run build` in this message, exit code 0, output tail `done in 2.3s`" IS evidence.

<EXTREMELY-IMPORTANT>
If you cannot run a required strategy (Playwright not installed, dev server port blocked, test framework missing), the sprint FAILS with a configuration issue — NOT a soft "skipped with note" pass. The harness depends on you refusing to wave criteria through. A criterion you could not verify is a criterion that failed.
</EXTREMELY-IMPORTANT>
```

**Suggested Red Flags for bober-evaluator.md (≥5):**

```
## Red Flags - STOP

- About to mark a criterion `pass` based on the generator's `criteriaResults` claim without re-running the verification command
- About to mark the sprint `pass` because "most criteria passed" (any required failure = sprint fails)
- About to skip a configured evaluation strategy because "it would take too long"
- About to mark a criterion `pass` because the code "looks correct" (reading ≠ running)
- About to skip the nonGoals diff scan because "the generator probably respected it"
- About to skip regression check on pre-existing tests ("they were passing before, they're probably still passing")
- About to mark `overallResult: "pass"` on iteration 1 of a non-trivial sprint without re-checking the Thorough Verification Protocol
- About to write feedback that says "looks good overall" or "nice work" (you are not here to encourage)
- About to accept "it compiles" as evidence that the feature works
- **ANY criterion marked `pass` for which you cannot quote the exact command output or file:line evidence that confirmed it**
```

**Suggested Rationalization-Prevention table for bober-evaluator.md (≥5 rows):**

```
## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "The generator's report says it passes" | The generator's report is context, not proof. RUN the verification. |
| "It compiles, so it works" | Compiling is necessary, not sufficient. Test the behavior. |
| "Most criteria pass — close enough" | One required failure = sprint fails. No partial pass. |
| "I'll skip the playwright strategy — it's slow" | If `playwright` is in `evaluator.strategies`, you MUST run it. Skipping = config failure. |
| "The code looks correct, no need to run it" | Reading ≠ testing. Run the command. |
| "Iteration 1 passing is fine — the work was simple" | First-iteration passes are RARE for non-trivial work. Re-check the Thorough Verification Protocol. |
| "I'll give it a pass since they'll fix it next sprint" | Each sprint is evaluated independently. Future sprints are irrelevant. |
| "I feel bad failing a sprint that's 95% there" | Feelings are not evaluation criteria. The contract is. |
| "Different words so rule doesn't apply" | Spirit over letter. |
```

---

## 3. Cross-File Consistency Checklist

Before declaring the sprint complete, verify:

- [ ] All five files have an `**IRON LAW:**` bold-header line on its own line
- [ ] All five Iron Laws are wrapped in triple-backtick fenced blocks (no language tag)
- [ ] All five Iron Laws are ALL CAPS, no period at end, one line
- [ ] All five Iron Laws are placed in the FIRST third of the file (after Subagent Context, before the long Process sections)
- [ ] All five Iron Laws have DIFFERENT wording (no copy-paste from generator's `NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE`)
- [ ] At least one `<EXTREMELY-IMPORTANT>...</EXTREMELY-IMPORTANT>` tag in each file (close to the Iron Law)
- [ ] All five files have a `## Red Flags - STOP` section with ≥5 entries, final entry bolded
- [ ] All five files have a `## Rationalization Prevention` section in **markdown table format** with header `| Excuse | Reality |`
- [ ] Every Rationalization-Prevention table has ≥5 rows
- [ ] No file exceeds 800 lines after additions (run `wc -l agents/bober-*.md`)
- [ ] No existing structured-JSON response contracts were modified (planner Format A/B, curator briefing JSON, architect arch-summary JSON, researcher Phase-1/Phase-2 JSON, evaluator EvalResult)
- [ ] No existing "What You Must Never Do" section was deleted (additions go ABOVE it)

---

## 4. Verification Commands (Generator must run before completing)

```bash
# Line-count check (sprint criterion s3-c8: <=800)
wc -l agents/bober-planner.md agents/bober-curator.md agents/bober-architect.md agents/bober-researcher.md agents/bober-evaluator.md

# Exactly-one-Iron-Law-per-file check (sprint criteria s3-c1 through s3-c5)
for f in agents/bober-planner.md agents/bober-curator.md agents/bober-architect.md agents/bober-researcher.md agents/bober-evaluator.md; do
  echo "=== $f ==="
  grep -c '^\*\*IRON LAW' "$f"
done

# Red-Flags ≥5 entries check (sprint criterion s3-c6)
for f in agents/bober-*.md; do
  echo "=== $f ==="
  awk '/^## Red Flags - STOP/,/^## /' "$f" | grep -c '^- '
done

# Rationalization-Prevention table check (sprint criterion s3-c7) — must contain header row
for f in agents/bober-*.md; do
  echo "=== $f ==="
  grep -c '^| Excuse | Reality |' "$f"
done

# <EXTREMELY-IMPORTANT> presence
for f in agents/bober-planner.md agents/bober-curator.md agents/bober-architect.md agents/bober-researcher.md agents/bober-evaluator.md; do
  echo "=== $f ==="
  grep -c 'EXTREMELY-IMPORTANT' "$f"
done

# Eval strategies (sprint criterion s3-c9)
npm run build && npx tsc --noEmit && npm run lint && npm test
```

---

## 5. Pitfalls & Warnings

- **Iron Law placement matters.** Empirically, instructions in the first third of an agent file have higher follow-through than those in the last third. The generator-file Iron Law was placed mid-file (line 171) which is acceptable because it sits at the head of "Step 4: Self-Verify". For the other five files, prefer the top placement (just after Subagent Context).
- **Do NOT collapse the evaluator's existing "## The One Rule That Must Never Be Broken" into the new Iron Law.** They are different rules. Both must remain.
- **Do NOT modify any structured-JSON response contract.** Each file has at least one JSON block (response format) and most have additional schema blocks (briefing template, ADR template, EvalResult schema). These are output contracts the harness depends on. Voice changes go AROUND them.
- **Avoid generic Iron Laws.** The contract `generatorNotes` warns: "Each Iron Law must be ROLE-SPECIFIC and LOAD-BEARING — generic phrasing is a fail." The suggested wording above is intentionally distinct per role.
- **Markdown table format is LOAD-BEARING for Rationalization-Prevention.** The contract `evaluatorNotes` says "superpowers tested this difference" — a bulleted list will fail evaluation. Stick to `| Excuse | Reality |` two-column tables.
- **Backtick-fenced Iron Law must use plain ``` (no language tag).** Adding a language tag (e.g., ```` ```text ````) changes the visual signature; the verbatim-superpowers style uses bare fences.
- **`<EXTREMELY-IMPORTANT>` tag should wrap one sentence (or two short ones), not a whole paragraph.** The tag loses force if it bounds too much text.
- **All five files use H2 headers (`## Red Flags - STOP`, `## Rationalization Prevention`).** Do not use H3 — the canonical superpowers skill uses H2.
- **The voice constraint from the abandoned spec ("preserve bober's procedural voice") is EXPLICITLY REVERSED.** The verbatim-superpowers style is the goal. Do not soften capitalized rules or all-caps STOP into "polite" prose.

---

## 6. Implementation Sequence (recommended order)

1. **`agents/bober-researcher.md`** — smallest file (164 lines), simplest insertion. Get the muscle-memory pattern right here first.
   - Verify: `wc -l` ≤ 800; `grep -c '^\*\*IRON LAW' agents/bober-researcher.md` returns 1; Red Flags has ≥5 entries; Rationalization Prevention has `| Excuse | Reality |` table with ≥5 rows.
2. **`agents/bober-curator.md`** — 345 lines, next-simplest. Same pattern.
   - Verify: same checks.
3. **`agents/bober-architect.md`** — 495 lines, has Component Design TypeScript blocks to be careful around (don't accidentally edit a code fence).
   - Verify: same checks; additionally `grep -c 'EXTREMELY-IMPORTANT' agents/bober-architect.md` ≥ 1.
4. **`agents/bober-planner.md`** — 637 lines, large but additive only. Insertion points are clear.
   - Verify: same checks; additionally the existing Quality Gate banned-phrase list (line 394) is still intact.
5. **`agents/bober-evaluator.md`** — 659 lines, the trickiest because of the existing "One Rule That Must Never Be Broken". Place new Iron Law ABOVE it; keep both.
   - Verify: same checks; additionally the existing One Rule block (lines 70-76 today) is unchanged in content, only relocated by ~10 lines downward.
6. **Run the full verification suite:** `wc -l agents/bober-*.md` (all ≤ 800), the four grep checks above (Iron Law count, Red Flags count, Rationalization-Prevention header presence, EXTREMELY-IMPORTANT presence), and `npm run build && npx tsc --noEmit && npm run lint && npm test` (sprint criterion s3-c9).

---

## 7. What to NOT Touch

- YAML frontmatter in any file (lines 1-11/12 typically).
- The Subagent Context section in any file (response-format JSON blocks live here).
- Any existing fenced code block that documents a JSON schema or TypeScript interface (these are output contracts).
- Sprint Briefing Format template in curator (lines 180-320).
- ADR format / architecture document format in architect (lines 325-428).
- EvalResult schema in evaluator (lines 330-385).
- Phase 1 / Phase 2 output formats in researcher (lines 63-76, 137-151).
- Existing "What You Must Never Do" sections — additions go ABOVE them.
- Any existing language about evidence, testability, skepticism — the new Iron Laws REINFORCE these, do not replace them.

---

## 8. Voice Reference (re-anchor before each file)

When you find yourself softening a rule, re-read these three sources to re-anchor:

1. **`skills/bober.verify/SKILL.md`** lines 20-26 (the Iron Law block) and 52-65 (Red Flags - STOP).
2. **`skills/bober.debug/SKILL.md`** lines 20-26 (the Iron Law block).
3. **`agents/bober-generator.md`** lines 171-177 (the in-agent Iron Law inline).

The voice is: capitalized rules, fenced blocks, all-caps STOP conditions, `<EXTREMELY-IMPORTANT>` tags where they sharpen the rule, quoted weasel-words listed verbatim, markdown table for rationalization, final-row catch-all ("Different words so rule doesn't apply | Spirit over letter").

No softening. No "please consider". No "it may be helpful to". This is the verbatim-superpowers voice — the goal, not the failure mode.
