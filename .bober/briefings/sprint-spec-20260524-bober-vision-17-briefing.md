# Sprint Briefing: bober.diagnose skill — 4-phase incident root-cause discipline

**Contract:** sprint-spec-20260524-bober-vision-17
**Generated:** 2026-05-25T08:55:00.000Z
**Target file:** `skills/bober.diagnose/SKILL.md` (create — single deliverable)

---

## Sprint Summary

Create ONE new markdown file — `skills/bober.diagnose/SKILL.md` — the **system-level twin** of `skills/bober.debug/SKILL.md` (Sprint 2). Both adapt obra/superpowers' `systematic-debugging/SKILL.md` four-phase structure, but `bober.debug` is code-level (test failure / bug / build break) while `bober.diagnose` is **incident-level** (production symptom, multi-component system, time pressure).

The four divergences from bober.debug — and the spine of this sprint:

| Phase | bober.debug (code-level) | bober.diagnose (incident-level) |
|-------|---------------------------|----------------------------------|
| 1 | **Reproduce** (re-run the failing test) | **Reproduce + CONFIRM** — confirm symptom is current (not stale), confirm scope (one user / many / all), confirm timing (when did it start, has severity changed); record initial state to `observations.jsonl` |
| 2 | **Pattern Analysis** (find similar working code) | **Gather Evidence AT Boundaries** — enumerate component boundaries (client → CDN → LB → service → DB → storage), query observability MCPs (`obs__<provider>__<tool>`), correlate timestamps with `changelog.jsonl` |
| 3 | Hypothesis + minimal test (one-variable change) | Hypothesize + **ACTIVELY DISPROVE** — confirmation-bias-under-pressure is the dominant failure mode for incidents; seek evidence that would NOT exist if the hypothesis were true |
| 4 | Failing test → fix → tests pass | **PRE-DEFINED resolution criteria** (metric + threshold + window + baseline + verification source) → remediation via bober-deployer (Sprint 20) checkpoint gates → verify via observability MCPs → mark resolved ONLY when criteria met for named window |

This is a **single static Markdown file**. No TypeScript, no tests, no orchestrator wiring. The only verification is: file exists, YAML frontmatter parses, Iron Law text matches, four phases in order, gate language between each, ≥6 Red Flags, ≥6 Rationalization rows, cross-references present, repo build still green.

Target length: **200–300 lines** (per `generatorNotes`). For calibration: `skills/bober.debug/SKILL.md` is 300 lines; `skills/bober.verify/SKILL.md` is 143 lines. Aim for ~250.

---

## 1. Target File

### `skills/bober.diagnose/SKILL.md` (create)

**Directory pattern:** Each skill lives at `skills/<dot-name>/SKILL.md`. The directory uses **dot-separated** (`bober.diagnose`), the frontmatter `name` field uses **dash-separated** (`bober-diagnose`). Confirmed by 19 existing skill dirs and 19 `name:` fields.

**Most similar existing file (THE structural template):** `skills/bober.debug/SKILL.md` (300 lines).

**Why bober.debug is the canonical template, not the upstream `/tmp/superpowers/skills/systematic-debugging/SKILL.md`:**
- Sprint 2 already ported the four-phase structure verbatim (line 6 attribution: `> Verbatim port from [obra/superpowers](https://github.com/obra/superpowers) — MIT License.`)
- Sprint 2 chose the in-repo conventions for frontmatter (`name: bober-debug`), section ordering, and Iron Law block format that the rest of the repo now follows
- This sprint must **diverge** from bober.debug at the phase content level (system not code), but **mirror** it at the structural level (section ordering, gate-block format, Red Flags shape, table column headers)

**Reference: `/tmp/superpowers/skills/systematic-debugging/SKILL.md` (297 lines, MIT)** is accessible at that path on this machine and was confirmed read during briefing. The upstream's "Gather Evidence in Multi-Component Systems" subsection (lines 72–110, currently embedded in bober.debug Phase 1 step 4 at lines 76–112) is the source pattern for THIS sprint's Phase 2 boundary enumeration — promoted from "step 4 within Phase 1" to its own Phase 2 because incidents are inherently multi-component.

**Skill file structure to copy from `skills/bober.debug/SKILL.md` (verbatim section order):**

```
1.  YAML frontmatter (name, description)
2.  MIT attribution blockquote (3 lines)
3.  # <Title> (H1)
4.  ## Overview (2-3 sentences + **Core principle:** bold line + spirit-of-process line)
5.  ## The Iron Law (fenced code block with single all-caps assertion)
6.  ## When to Use (bullet list + "ESPECIALLY when" + "Don't skip when")
7.  ## The Four Phases (intro sentence then four ### Phase N subsections)
8.  ## Red Flags - STOP and Follow Process (bullet list, all starting with quoted thought)
9.  ## your human partner's Signals You're Doing It Wrong (optional — bober.debug includes; can drop for length)
10. ## Common Rationalizations (markdown table, two columns: Excuse | Reality)
11. ## Quick Reference (markdown table summarizing the four phases)
12. ## When Process Reveals "No Root Cause" (short escape-hatch section)
13. ## Supporting Techniques (NOT applicable here — bober.debug links to .ts/.md helper files that don't exist for diagnose; drop or replace with cross-refs)
14. ## Related skills (cross-references — REQUIRED by s17-c8)
15. ## Real-World Impact (optional closer)
```

---

## 2. Patterns to Follow — extracted from `skills/bober.debug/SKILL.md` (verbatim)

### Pattern A: YAML frontmatter shape (bober.debug:1-4)

```yaml
---
name: bober-debug
description: Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes
---
```

**For bober.diagnose — required wording per s17-c1:**

```yaml
---
name: bober-diagnose
description: Use when investigating a production incident or system-level failure — gather evidence at component boundaries, hypothesize-and-disprove, verify resolution against pre-defined criteria
---
```

**Hard requirements (s17-c1):**
- `name:` MUST be exactly `bober-diagnose` (dash, not dot — matches dir-name → name-field convention)
- `description:` MUST start with the literal string `Use when investigating a production incident or system-level failure`
- Frontmatter is the ONLY part before the H1; no blank line at top, frontmatter on line 1

### Pattern B: MIT attribution blockquote (bober.debug:6-8)

```markdown
> Verbatim port from [obra/superpowers](https://github.com/obra/superpowers) — MIT License.
> Original: skills/systematic-debugging/SKILL.md.
> Adaptations: skill name (bober.debug), tool name references where bober has equivalents.
```

**For bober.diagnose — adapted (not verbatim; THIS file is a system-level adaptation, not a verbatim port):**

```markdown
> Adapted from [obra/superpowers](https://github.com/obra/superpowers) — MIT License.
> Structural source: skills/systematic-debugging/SKILL.md (four-phase discipline).
> Adaptations: system-level (incident) context vs code-level (bug); boundary enumeration promoted to Phase 2; resolution-verification criteria added to Phase 4.
```

**Rule:** Attribution must be present (s17-c1) and must name obra/superpowers + MIT. Use "Adapted from" (not "Verbatim port from") because this sprint diverges substantively from the source — bober.debug is verbatim, bober.diagnose is adapted.

### Pattern C: Iron Law block format (bober.debug:20-26)

```markdown
## The Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

If you haven't completed Phase 1, you cannot propose fixes.
```

**Required shape:**
- `## The Iron Law` H2 header
- Blank line
- Triple-backtick fenced block (no language tag) containing a **single line, all-caps, no period** assertion
- Blank line
- One-sentence consequence statement

**For bober.diagnose — required wording per s17-c2:**

```markdown
## The Iron Law

```
NO REMEDIATION WITHOUT VERIFIED ROOT CAUSE AT TWO INDEPENDENT BOUNDARIES
```

If your evidence comes from a single component, you have a candidate hypothesis — not a verified root cause. Continue gathering at independent boundaries before proposing any remediation.
```

**Why "two independent boundaries":** This aligns with `agents/bober-diagnoser.md:51-55` which uses `NO HYPOTHESIS WITHOUT EVIDENCE FROM TWO INDEPENDENT SOURCES`. The skill phrases it as "two independent boundaries" to match the Phase 2 boundary-enumeration vocabulary; "boundary" and "source" are interchangeable in this context (a boundary IS an independent telemetry source).

### Pattern D: `<EXTREMELY-IMPORTANT>` gate-block tag (bober-diagnoser.md:57-59, contract generatorNotes verbatim)

The bober.debug file does NOT use `<EXTREMELY-IMPORTANT>` tags between phases — its phase transitions use plain "**BEFORE proceeding to the next**" wording (bober.debug:52: `You MUST complete each phase before proceeding to the next.`).

For bober.diagnose, the **contract `evaluatorNotes` explicitly requires** stronger gate language. The pattern, lifted **verbatim from `generatorNotes`** in the contract:

```markdown
<EXTREMELY-IMPORTANT>
BEFORE proceeding to Phase 2, you MUST have completed Phase 1 in writing — symptom confirmed current, scope confirmed, timing confirmed, observations.jsonl appended. If any of these is incomplete, return to Phase 1. Skipping Phase 1 makes Phase 2 evidence-gathering ungrounded.
</EXTREMELY-IMPORTANT>
```

**Rule (s17-c3):** Place ONE such `<EXTREMELY-IMPORTANT>` block at the END of Phase 1, Phase 2, and Phase 3 (three gates total — gates between Phase N and Phase N+1). Each gate MUST start with the literal phrase `BEFORE proceeding to Phase N+1, you MUST` and MUST enumerate the specific deliverables of the just-completed phase. **Evaluator-reject language to avoid:** "consider doing X before Y", "it is recommended that", "should be" — these are NOT gates, they are suggestions, and the evaluator will reject them (`evaluatorNotes` first paragraph).

**Reference for `<EXTREMELY-IMPORTANT>` placement and tone:** `skills/bober.using-bober/SKILL.md:10-16` (top-of-file overview gate) and `agents/bober-diagnoser.md:57-59` (escalation block inside the Iron Law).

### Pattern E: Red Flags list shape (bober.debug:219-234)

```markdown
## Red Flags - STOP and Follow Process

If you catch yourself thinking:
- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "Add multiple changes, run tests"
- "Skip the test, I'll manually verify"
- "It's probably X, let me fix that"
- "I don't fully understand but this might work"
- "Pattern says X but I'll adapt it differently"
- "Here are the main problems: [lists fixes without investigation]"
- Proposing solutions before tracing data flow
- **"One more fix attempt" (when already tried 2+)**
- **Each fix reveals new problem in different place**

**ALL of these mean: STOP. Return to Phase 1.**
```

**Required shape:**
- `## Red Flags` (variations like `Red Flags - STOP` or `Red Flags - STOP and Follow Process` are both used — pick one)
- Lead-in sentence (`If you catch yourself thinking:` or `About to ...` form)
- Bullet list of ≥6 entries (s17-c2)
- Each entry is either a quoted thought ("...") OR a present-participle clause ("Proposing solutions before tracing data flow")
- Closing "ALL of these mean: STOP." line

**For bober.diagnose, ≥6 incident-specific red flags (replace code-level thoughts with system-level pressure thoughts):**

Examples to write (incident-level, NOT code-level):
- `"The dashboard looks better, mark it resolved"` — the very anti-pattern this skill exists to prevent
- `"Just restart the service, see if it helps"` — symptom-fix without root cause
- `"It's obviously the database, skip the cache layer"` — confirmation bias under pressure
- `"The deploy at 14:00 must be it, ship the rollback"` — correlation ≠ causation
- `"Single log line is enough, I see the error right there"` — Iron Law violation
- `"No time for hypothesis-disproof, the page is loud"` — time-pressure rationalization
- `"The metric is back to baseline, declare resolved"` — without checking the named WINDOW
- `"Stale alert, ignore"` — without confirming symptom is current (Phase 1 sub-requirement)

### Pattern F: Rationalization-Prevention table shape (bober.debug:251-260)

```markdown
## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Issue is simple, don't need process" | Simple issues have root causes too. Process is fast for simple bugs. |
| "Emergency, no time for process" | Systematic debugging is FASTER than guess-and-check thrashing. |
| "Just try this first, then investigate" | First fix sets the pattern. Do it right from the start. |
| ... 8 rows total ... |
```

**Required shape:**
- `## Common Rationalizations` H2 header (variations: `## Rationalization Prevention` per bober-diagnoser.md:232 — pick `## Common Rationalizations` to match bober.debug)
- Markdown table with EXACTLY two columns: `Excuse | Reality`
- Header separator row `|--------|---------|`
- ≥6 rows (s17-c2)
- Each `Excuse` cell is a quoted thought
- Each `Reality` cell is a direct rebuttal (1-2 sentences, NOT just "wrong" — must explain the counter-truth)

**For bober.diagnose, ≥6 incident-specific rationalizations:**

| Excuse | Reality |
|--------|---------|
| "The dashboard looks green, we're resolved" | Resolution criteria require a NAMED metric meeting a NAMED threshold for a NAMED window. Eyeballing a dashboard is not verification. |
| "The deploy at 14:00 caused this — roll it back" | Correlation is not causation. Verify the deploy is the cause via independent telemetry before remediating. |
| "Logs are unambiguous, single source is enough" | Iron Law: two independent boundaries. One source = continue gathering, do not remediate. |
| "No time to disprove the hypothesis, the page is loud" | Confirmation bias under pressure is the dominant incident-response failure mode. The disproof step exists EXACTLY for these moments. |
| "Stale alert, the customer probably refreshed" | Phase 1 requires CONFIRMING the symptom is current. "Probably refreshed" is not confirmation — query the current state. |
| "We'll set the resolution criteria after the fix lands" | Criteria set AFTER the fix are retrofitted to the outcome. They MUST be pre-defined to be meaningful. |
| "I've seen this before, skip to Phase 3" | Pattern memory is a hypothesis, not evidence. Phase 1 (confirm) and Phase 2 (boundaries) still produce the multi-source evidence required for remediation. |
| "The MCP is slow, I'll just go from logs" | If a primary data source is degraded, that itself is a hypothesis ("monitoring stack degraded") and a low-confidence note — do NOT invent values for missing telemetry. |

(7-8 rows recommended; minimum 6.)

### Pattern G: Quick Reference table (bober.debug:262-269)

```markdown
## Quick Reference

| Phase | Key Activities | Success Criteria |
|-------|---------------|------------------|
| **1. Root Cause** | Read errors, reproduce, check changes, gather evidence | Understand WHAT and WHY |
| **2. Pattern** | Find working examples, compare | Identify differences |
| **3. Hypothesis** | Form theory, test minimally | Confirmed or new hypothesis |
| **4. Implementation** | Create test, fix, verify | Bug resolved, tests pass |
```

**For bober.diagnose:**

| Phase | Key Activities | Success Criteria |
|-------|---------------|------------------|
| **1. Reproduce + Confirm** | Confirm symptom current, scope, timing; write `observations.jsonl` | Symptom is real, scoped, timed |
| **2. Gather at Boundaries** | Enumerate components; query obs MCPs at each boundary; correlate `changelog.jsonl` | Evidence at ≥2 independent boundaries |
| **3. Hypothesize + Disprove** | Rank hypotheses by evidence; actively seek contradicting evidence | Top hypothesis survived disproof attempt |
| **4. Verify Resolution** | Pre-define metric+threshold+window; remediate via bober-deployer; monitor; mark resolved | Criteria met for named window |

---

## 3. Existing Utilities — DO NOT recreate / contradict

This sprint creates a Markdown skill — there are no code utilities to reuse. But there ARE **established schemas, cross-references, and vocabularies** from prior sprints that this skill MUST match (mismatch breaks the agent ↔ skill ↔ artifact contract).

| Convention | Source | Detail |
|------------|--------|--------|
| `obs__<provider>__<tool>` namespace | `docs/observability-mcps/README.md:46-48` | Phase 2's "query at each boundary" examples MUST use this exact namespace (e.g., `obs__datadog__query_metric`, `obs__loki__query_logs`). Do not invent `mcp__obs_*` or `observability/*`. |
| `observability.providers` config key | `docs/observability-mcps/README.md:11-31` | Phase 2 reference must say `bober.config.json` → `observability.providers`. |
| Provider kinds | `docs/observability-mcps/README.md:40` | Exactly `logs \| metrics \| traces \| errors \| custom`. |
| `.bober/incidents/<id>/observations.jsonl` | Sprint 19 contract s19-c2 + generatorNotes | Field shape from THIS contract's `generatorNotes`: `{timestamp, phase, observation, source, verified}`. |
| `.bober/incidents/<id>/changelog.jsonl` | Sprint 19 contract s19-c2 + bober-diagnoser.md:25 | Append-only deploy / change history; ChangeEntry has REQUIRED `inverse` field (s19-c5). |
| `.bober/incidents/<id>/timeline.jsonl` | Sprint 19 contract s19-c4 | Master event log; appendObservation also appends here. (The skill MAY reference timeline.jsonl as "the master log" but the Phase 1/2 deliverables are observations.jsonl + changelog.jsonl specifically.) |
| `.bober/incidents/<id>/hypotheses.md` | bober-diagnoser.md:23 | Top hypotheses + confidence. Phase 3 deliverable. |
| `.bober/incidents/<id>/actions.jsonl` | bober-diagnoser.md:24 | Actions tried / proposed. Phase 4 deliverable for bober-deployer to consume. |
| DiagnosisResult JSON schema | bober-diagnoser.md:80-117 | The skill's Phase 3/4 output vocabulary MUST be compatible: `confidence: 'low' \| 'medium' \| 'high'`, `blastRadius: 'safe' \| 'risky'`, `requiresApproval: true` on every risky. |
| Anti-pattern catalog citations | `.bober/anti-patterns/README.md` | Two specific anti-patterns are the spiritual ancestors of this skill: **Symptom-Fix Instead of Root-Cause** (`root-cause-tracing.md`) and **Single-Layer Validation** (`defense-in-depth.md`). Cite both in Phase 3 hypothesis-formation. |
| Incident ID format | Sprint 19 s19-c3 | `inc-<YYYYMMDD>-<short-slug>` e.g. `inc-20260524-500-errors-on`. Use this format in the worked example. |

**Schema-mismatch check (THIS BRIEFING IS THE DESIGNATED VERIFIER):** I read `sprint-spec-20260524-bober-vision-19.json` end-to-end and confirm:
- Sprint 19 WILL create `.bober/incidents/<id>/observations.jsonl` — name matches (s19-c2 line 16: `observations.jsonl`)
- Sprint 19 WILL create `.bober/incidents/<id>/changelog.jsonl` — name matches (s19-c2 line 16: `changelog.jsonl`)
- Sprint 19 WILL create `.bober/incidents/<id>/actions.jsonl` — name matches
- Sprint 19 WILL create `.bober/incidents/<id>/hypotheses.md` — name matches

**No mismatch detected.** The skill can reference these filenames freely; Sprint 19 will create them. Forward-reference precedent: bober-diagnoser.md:21-27 already forward-references all four files (Sprint 15 was written before Sprint 19's contract was final — pattern is established).

---

## 4. Prior Sprint Output Connections

### Sprint 2: `skills/bober.debug/SKILL.md` (300 lines, verbatim port of obra/superpowers systematic-debugging)
**Connection:** THE primary structural template. This sprint mirrors its section order, Iron Law format, Red Flags shape, Common Rationalizations table headers, Quick Reference table. The CONTENT diverges (system not code); the SHAPE matches.

**Cross-reference required from bober.diagnose → bober.debug (s17-c8):**
> Use `bober.debug` (`skills/bober.debug/SKILL.md`) when the incident root cause turns out to be code-level (test reproduces, single component, deterministic). `bober.diagnose` and `bober.debug` are complementary: diagnose handles "is the system broken?", debug handles "is the code wrong?". They are siblings, not parent-child.

### Sprint 15: `agents/bober-diagnoser.md` (256 lines, read-only investigator agent)
**Connection:** The agent that **consumes** this skill. The skill prescribes the discipline; the agent executes it within the DiagnosisResult schema.

**Consistency points to NOT contradict (cross-checked during briefing):**
- `agents/bober-diagnoser.md:51-55` defines the agent's Iron Law as `NO HYPOTHESIS WITHOUT EVIDENCE FROM TWO INDEPENDENT SOURCES`. THIS skill's Iron Law (`NO REMEDIATION WITHOUT VERIFIED ROOT CAUSE AT TWO INDEPENDENT BOUNDARIES`) is the **remediation-side** corollary of the same principle — the agent gates HYPOTHESIS promotion; the skill gates REMEDIATION. Both = two-independent-source bar.
- `agents/bober-diagnoser.md:128-165` documents the 6-step Investigation Discipline (READ → GATHER → CORRELATE → FORMULATE → SEEK CONTRADICTING → RECOMMEND). The skill's four phases MUST be compatible with this 6-step:
  - Skill Phase 1 (Reproduce+Confirm) ≈ Agent Step 1 (READ artifacts)
  - Skill Phase 2 (Gather at Boundaries) ≈ Agent Steps 2+3 (GATHER + CORRELATE)
  - Skill Phase 3 (Hypothesize+Disprove) ≈ Agent Steps 4+5 (FORMULATE + SEEK CONTRADICTING)
  - Skill Phase 4 (Verify Resolution) ≈ Agent Step 6 (RECOMMEND next actions) + downstream verification
- `agents/bober-diagnoser.md:215-218` already declares a **forward link** to this skill:
  > **`bober.diagnose`** (Sprint 17 — not yet created at the time of this agent's authoring) — incident response playbook ... When the skill exists, follow its phases in addition to the 6-step Investigation Discipline above.

  THIS sprint fulfills that promise. The skill's forward link BACK to the agent should say: "Used by `agents/bober-diagnoser.md` for incident investigation. The skill provides the discipline; the agent provides the structured output schema."

- `agents/bober-diagnoser.md:71-73`'s third principle (`Active disconfirmation`) is the spiritual source for Phase 3's DISPROVE step in this skill. Use compatible language ("actively seek contradicting evidence").

### Sprint 16: Observability MCP Plugin Slots
**Connection:** Phase 2 of THIS skill is where observability MCPs are queried. Reference the namespace and config exactly.

**From `docs/observability-mcps/README.md`:**
- Tools surface as `obs__<provider>__<tool>` (line 47)
- Config lives at `bober.config.json` → `observability.providers` (line 11)
- Provider kinds: `logs | metrics | traces | errors | custom` (line 40)

**Phase 2 must use these exact names** when illustrating boundary queries. Example wording:
> Query observability MCPs at each boundary: `obs__loki__query_logs` for app logs, `obs__datadog__query_metric` for infra metrics, `obs__tempo__query_traces` for distributed traces. Provider names are configured in `bober.config.json` → `observability.providers`.

### Forward references (skills not yet created — precedent set by bober-diagnoser.md forward-linking THIS sprint)

- **Sprint 18: `skills/bober.runbook/SKILL.md`** — "When the diagnoser's next action is 'follow runbook X', invoke `bober.runbook` for execution discipline (precondition → execute → postcondition for every step)." (Cross-checked Sprint 18 contract: it forward-references bober.diagnose at s18-c8 — symmetric link.)
- **Sprint 20: `skills/bober.deploy/SKILL.md` + `agents/bober-deployer.md`** — "Remediation actions classified `risky` MUST be executed via `bober-deployer` with checkpoint approval (Tier 2 careful-flow gate). Never run state-mutating commands from the diagnoser." (Cross-checked Sprint 20 contract: deployer's Iron Law `NO RISKY ACTION WITHOUT CHECKPOINT APPROVAL; NO ACTION WITHOUT RECORDED INVERSE` — Phase 4 wording should be compatible.)
- **Sprint 19: incident artifact append helpers** — the skill references `.bober/incidents/<id>/observations.jsonl` and `.bober/incidents/<id>/changelog.jsonl`; Sprint 19 creates the directory skeleton and write helpers. **Forward-reference precedent** confirmed at bober-diagnoser.md:21-27. No additional warning needed.

### `.bober/anti-patterns/README.md` (existing catalog)
**Connection:** Phase 3 hypothesis formation should pattern-match against the catalog (mirrors bober-diagnoser.md:73's fifth principle).

**Two anti-patterns most relevant to incident investigation:**
- **Symptom-Fix Instead of Root-Cause** — file: `root-cause-tracing.md`
- **Single-Layer Validation** — file: `defense-in-depth.md`

Cross-reference text required (s17-c8):
> Before listing a hypothesis, check `.bober/anti-patterns/README.md` for pattern matches. Two anti-patterns are especially common in incidents: **Symptom-Fix Instead of Root-Cause** and **Single-Layer Validation**. If your hypothesis matches one, cite it by name.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` is required reading for this sprint. (The skill is a discipline document, not a code module; it does not import project principles.) **Confirmed absent from contract** — `dependsOn` is just Sprint 16. The skill IS a principle.

### Architecture / Spec References
- `.bober/specs/spec-20260524-bober-vision.json` — Tier 3 AC1-AC5 (lines 119-123 in the spec) describe the full incident flow this skill participates in.
- `.bober/specs/spec-20260524-bober-vision.json:152` — explicit MIT attribution requirement: every new file under `skills/bober.{verify,debug,using-bober,code-review,diagnose,runbook,deploy,postmortem}/` is grep'd for `obra/superpowers` and `MIT`. **Both tokens MUST appear in the file.**

### Voice / Tone Directive (from contract `generatorNotes`)
Verbatim voice — **capitalized rules**, **all-caps STOP at gate conditions**, **`<EXTREMELY-IMPORTANT>` tags at phase transitions**, **Iron Law in capitalized fenced block**. The same voice as `skills/bober.debug/SKILL.md` and `skills/bober.using-bober/SKILL.md`.

---

## 6. Testing Patterns

This sprint produces a Markdown file with no executable code. There are no unit tests, no integration tests, no E2E tests for the SKILL.md itself.

**Verification (s17-c9 + the eight content criteria) is done by the evaluator via Read + Grep:**

1. **YAML frontmatter** — first line is `---`, second line `name: bober-diagnose`, third line starts with `description: Use when investigating a production incident or system-level failure`
2. **MIT attribution** — `grep -E "obra/superpowers" skills/bober.diagnose/SKILL.md` AND `grep -E "MIT" skills/bober.diagnose/SKILL.md` both return ≥1 hit
3. **Iron Law** — `grep -F "NO REMEDIATION WITHOUT VERIFIED ROOT CAUSE AT TWO INDEPENDENT BOUNDARIES" skills/bober.diagnose/SKILL.md` (or evaluator allows an equivalent two-independent-source assertion)
4. **Red Flags ≥6** — locate `## Red Flags` section, count bullet items, ≥6
5. **Rationalization-Prevention ≥6** — locate `## Common Rationalizations` table, count data rows (excluding header + separator), ≥6
6. **Four phases in order** — locate `### Phase 1`, `### Phase 2`, `### Phase 3`, `### Phase 4` headers, verify order
7. **Gate language between phases** — between Phase 1 and Phase 2: `grep -E "BEFORE proceeding to Phase 2, you MUST"`. Same for 2→3 and 3→4. THREE gates total.
8. **Phase 1 deliverables** — Phase 1 body contains all four: "symptom is current" (or "not stale"), "scope" (one user / many / all), "timing" (when started), "observations.jsonl"
9. **Phase 2 deliverables** — Phase 2 body contains: "boundary" enumeration list, "observability MCP" reference using `obs__<provider>__<tool>` namespace, "changelog.jsonl" correlation
10. **Phase 3 deliverables** — Phase 3 body contains: ranked hypotheses, "DISPROVE" or "contradicting evidence" requirement framed as a STEP not advisory
11. **Phase 4 deliverables** — Phase 4 body contains: pre-defined criteria (metric + threshold + window), `bober-deployer` reference, observability MCP verification, named-window check
12. **Cross-references (s17-c8)** — `grep -E "bober.debug|bober\\.debug" SKILL.md` AND `grep -E "bober.runbook" SKILL.md` AND `grep -E "bober.deploy" SKILL.md` AND `grep -E "anti-patterns" SKILL.md` all return ≥1
13. **Build/lint/test pass** — `npm run typecheck`, `npm run lint`, `npm run build`, `npm test` all exit 0 (no source changes, so trivially passes)

**There is no test file to write. The evaluator does the verification by reading the markdown.**

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
**None.** This sprint creates ONE new file in a new directory. No existing imports, no existing code references the new file (only forward-references in `agents/bober-diagnoser.md:215-218` and `skills/bober.using-bober/SKILL.md:109`, which already expect the file to be planned/forthcoming).

| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `agents/bober-diagnoser.md:215-218` | `skills/bober.diagnose/SKILL.md` (forward link) | LOW | After this sprint, the link is no longer forward — confirm path is correct. (Path is `skills/bober.diagnose/SKILL.md` — matches the agent's reference.) |
| `skills/bober.using-bober/SKILL.md:109` | catalog mention of `bober.diagnose (planned)` | LOW | Now exists; the "(planned)" marker can stay or be removed in a later sprint. Not in scope for this sprint. |

### Existing Tests That Must Still Pass
- All unit tests under `tests/` — none touch skill markdown, all should pass unchanged.
- All evaluator strategies (`typecheck`, `lint`, `build`, `unit-test`, any agent-evaluation) — should pass unchanged.

### Features That Could Be Affected
- **Tier 3 incident agent shape (current Tier)** — Sprints 15, 16, 17, 18, 19, 20 form a tight family. Verify Sprint 18's `bober.runbook` cross-reference target (`bober.diagnose`) is valid after this sprint lands.
- **No other features** share code with this sprint (it's a standalone markdown file).

### Recommended Regression Checks
After implementation, the Generator MUST verify:
1. `cat skills/bober.diagnose/SKILL.md | head -4` shows valid frontmatter starting with `---` and `name: bober-diagnose`
2. `grep -c "^### Phase " skills/bober.diagnose/SKILL.md` returns `4`
3. `grep -c "BEFORE proceeding to Phase" skills/bober.diagnose/SKILL.md` returns `3` (three gates: 1→2, 2→3, 3→4)
4. `grep -F "NO REMEDIATION WITHOUT VERIFIED ROOT CAUSE AT TWO INDEPENDENT BOUNDARIES" skills/bober.diagnose/SKILL.md` returns the Iron Law line
5. `grep -cE "^\| .* \|" skills/bober.diagnose/SKILL.md` returns ≥10 (Common Rationalizations + Quick Reference table rows combined; sanity check that tables are formatted as markdown tables, not as code blocks)
6. `grep -E "obra/superpowers|MIT" skills/bober.diagnose/SKILL.md` returns ≥2 hits (attribution intact)
7. `grep -E "bober\\.debug|bober\\.runbook|bober\\.deploy|anti-patterns" skills/bober.diagnose/SKILL.md` returns ≥4 hits (all four required cross-references present)
8. `wc -l skills/bober.diagnose/SKILL.md` returns 200-300
9. `npm run typecheck && npm run lint && npm run build && npm test` all exit 0

---

## 8. Implementation Sequence

Build the file top-to-bottom. Each step is verifiable independently.

1. **YAML frontmatter (lines 1-4)**
   - Write `---` / `name: bober-diagnose` / `description: Use when investigating a production incident or system-level failure — gather evidence at component boundaries, hypothesize-and-disprove, verify resolution against pre-defined criteria` / `---`
   - **Verify:** `head -4 skills/bober.diagnose/SKILL.md` matches the four lines

2. **MIT attribution blockquote (lines 6-8)**
   - Write the 3-line `> Adapted from [obra/superpowers]...` block (see Pattern B above)
   - **Verify:** `grep "obra/superpowers" skills/bober.diagnose/SKILL.md && grep "MIT" skills/bober.diagnose/SKILL.md`

3. **H1 + Overview (lines 10-20)**
   - `# Systematic Incident Diagnosis` (or `# Incident Root-Cause Discipline`)
   - 2-3 sentence overview: random restarts mask root causes; symptom-fixes destroy verification; the four-phase discipline is faster than thrashing
   - `**Core principle:** ALWAYS verify root cause at two independent boundaries before remediation.`
   - `**Violating the letter of this process is violating the spirit of incident response.**`
   - **Verify:** `grep -c "^# " skills/bober.diagnose/SKILL.md` returns `1`

4. **The Iron Law fenced block (lines 22-28)**
   - `## The Iron Law` + blank + ```\nNO REMEDIATION WITHOUT VERIFIED ROOT CAUSE AT TWO INDEPENDENT BOUNDARIES\n``` + blank + 1-sentence consequence
   - **Verify:** `grep -F "NO REMEDIATION WITHOUT VERIFIED ROOT CAUSE AT TWO INDEPENDENT BOUNDARIES" skills/bober.diagnose/SKILL.md`

5. **When to Use (lines 30-50)**
   - Bullet list of incident kinds (latency regression, error spike, capacity event, partial outage, security alert, etc.)
   - `**Use this ESPECIALLY when:**` — time pressure, page just fired, dashboard looks bad, you've already tried one restart
   - `**Don't skip when:**` — "obvious" incident (deploy at 14:00 = the cause), simple symptom (one endpoint), executive watching

6. **Phase 1: Reproduce + Confirm (lines 52-95)**
   - `### Phase 1: Reproduce and Confirm`
   - `**BEFORE moving to evidence gathering:**` lead-in
   - Numbered subsections:
     1. **Confirm Symptom is Current (not stale)** — query observability MCP NOW; "the user reported this 20 min ago" is not confirmation
     2. **Confirm Scope** — one user? one customer? one region? one endpoint? all of them? (this determines the BOUNDARY enumeration in Phase 2)
     3. **Confirm Timing** — when did it start? has severity changed (increasing, plateau, decreasing)? was there a deploy / config change in the window?
     4. **Record Initial State** — append observation to `.bober/incidents/<id>/observations.jsonl` with shape `{timestamp, phase, observation, source, verified}` (see worked example below)
   - **Worked example block** (use the shape from contract `generatorNotes`):
     ```jsonl
     {"timestamp": "2026-05-24T14:05:00Z", "phase": 1, "observation": "500 errors on /api/checkout from 14:00 UTC; rate ~12%/req; all regions", "source": "obs__datadog__query_metric", "verified": true}
     {"timestamp": "2026-05-24T14:06:00Z", "phase": 1, "observation": "Confirmed current via fresh metric query — error rate still 11.8% at 14:06", "source": "obs__datadog__query_metric", "verified": true}
     ```
   - **End with gate (verbatim from contract generatorNotes):**
     ```markdown
     <EXTREMELY-IMPORTANT>
     BEFORE proceeding to Phase 2, you MUST have completed Phase 1 in writing — symptom confirmed current, scope confirmed, timing confirmed, observations.jsonl appended. If any of these is incomplete, return to Phase 1. Skipping Phase 1 makes Phase 2 evidence-gathering ungrounded.
     </EXTREMELY-IMPORTANT>
     ```
   - **Verify:** `grep -c "BEFORE proceeding to Phase 2, you MUST" skills/bober.diagnose/SKILL.md` returns `1`

7. **Phase 2: Gather Evidence at Boundaries (lines 97-145)**
   - `### Phase 2: Gather Evidence at Boundaries`
   - `**BEFORE forming hypotheses, gather at every boundary:**`
   - Numbered subsections:
     1. **Enumerate Component Boundaries** — concrete example list: `client → CDN → load balancer → API gateway → service → cache → database → storage`. Each arrow is a boundary; each component is an evidence source. (This is the upstream "Gather Evidence in Multi-Component Systems" pattern promoted from a step to its own Phase.)
     2. **Query at Each Boundary via Observability MCPs** — show 3-4 example queries using actual namespace:
        - `obs__loki__query_logs` — app-layer logs
        - `obs__datadog__query_metric` — infra metrics
        - `obs__tempo__query_traces` — distributed traces
        - `obs__sentry__query_events` — error tracking
     3. **Correlate Timestamps with changelog.jsonl** — read `.bober/incidents/<id>/changelog.jsonl` for recent deploys / config changes; cross-reference incident-start timestamp with deploy timestamps; **note: correlation is not causation** (record as hypothesis, not conclusion)
     4. **Multi-Boundary Iron-Law Check** — before listing a hypothesis as remediation-eligible, you MUST have evidence from at least TWO independent boundaries (not two log entries from the same service — two layers)
   - **End with gate:**
     ```markdown
     <EXTREMELY-IMPORTANT>
     BEFORE proceeding to Phase 3, you MUST have queried at least two independent boundaries and recorded their findings as observations. If only one boundary has data, return to Phase 2 — Phase 3 hypothesis formation on single-boundary evidence violates the Iron Law.
     </EXTREMELY-IMPORTANT>
     ```
   - **Verify:** `grep -F "obs__" skills/bober.diagnose/SKILL.md` returns ≥4 hits; `grep -F "changelog.jsonl" skills/bober.diagnose/SKILL.md` returns ≥2 hits

8. **Phase 3: Hypothesize and Disprove (lines 147-190)**
   - `### Phase 3: Hypothesize and Disprove`
   - `**Scientific method under pressure:**` (contrast with bober.debug's "Scientific method:" — same voice, time-pressure framing for incidents)
   - Numbered subsections:
     1. **Formulate Falsifiable Hypotheses** — each hypothesis is a one-sentence falsifiable claim; rank by count of supporting evidence (independent boundaries); drop hypotheses with zero evidence
     2. **Pattern-Match Against the Anti-Pattern Catalog** — check `.bober/anti-patterns/README.md`; if your hypothesis matches **Symptom-Fix Instead of Root-Cause** or **Single-Layer Validation**, cite the anti-pattern by name
     3. **ACTIVELY DISPROVE the Top Hypothesis** — REQUIRED, not advisory. The literal sentence from the contract `evaluatorNotes`:
        > Try to find evidence that DISPROVES your top hypothesis. A hypothesis you cannot disprove is not strongly tested.

        Example: if your top hypothesis is "the 14:00 deploy caused the error spike," look for evidence that contradicts it — was the error rate elevated BEFORE 14:00? Is the same endpoint failing in a region that did NOT receive the 14:00 deploy?
     4. **Promote or Demote Confidence** — only promote a hypothesis to medium/high confidence if (a) evidence from ≥2 independent boundaries AND (b) survived an active disproof attempt. Otherwise: low confidence + evidence-gathering next actions only (no remediation yet).
   - **End with gate:**
     ```markdown
     <EXTREMELY-IMPORTANT>
     BEFORE proceeding to Phase 4, you MUST have actively attempted to disprove your top hypothesis and recorded the attempt. A hypothesis that has NOT survived a disproof attempt is NOT remediation-eligible. If you have not yet tried to disprove it, return to Phase 3.
     </EXTREMELY-IMPORTANT>
     ```
   - **Verify:** `grep -E "DISPROVE|disprove|contradicting" skills/bober.diagnose/SKILL.md` returns ≥3 hits

9. **Phase 4: Verify Resolution (lines 192-240)**
   - `### Phase 4: Verify Resolution Against Pre-Defined Criteria`
   - `**Resolution criteria MUST be defined BEFORE remediation — retrofitted criteria are meaningless.**`
   - Numbered subsections:
     1. **Pre-Define Resolution-Verification Criteria** — before ANY remediation, write the criteria. Worked example block (verbatim from contract `generatorNotes`):
        ```
        Resolution criteria for INC-2026-0524-001:
          - Metric: api.checkout.error_rate
          - Threshold: < 0.1%
          - Window: 10 minutes sustained
          - Comparison baseline: 7-day rolling average
          - Verification source: obs__datadog__query_metric
        ```
        All five fields are REQUIRED: metric, threshold, window, baseline, verification source. Without all five, the criterion is not actionable.
     2. **Apply Remediation via bober-deployer** — never run state-mutating commands from the diagnoser. The diagnoser emits a `nextActions` entry; the orchestrator routes it to `agents/bober-deployer.md` (Sprint 20); the deployer requests a checkpoint approval for `blastRadius: 'risky'` actions and records the action with required `inverse` field in `changelog.jsonl`. (See `skills/bober.deploy/SKILL.md` once Sprint 20 lands.)
     3. **Monitor Against Criteria via Observability MCPs** — query the named metric at the named cadence; mark resolved ONLY when threshold met for the FULL named window. "The dashboard looks better" is not resolution.
     4. **Mark Resolved Only When Criteria Met** — append the resolution to `actions.jsonl`; update `incident.json` `status: 'resolved'` and `resolvedAt`. If criteria are not met within a reasonable window (or symptom returns), return to Phase 1 — the remediation was symptomatic, not root cause.

10. **Red Flags ≥6 (lines 242-258)**
    - `## Red Flags - STOP and Follow Process`
    - Bullet list of incident-specific thoughts (see Pattern E for examples)
    - Closing `**ALL of these mean: STOP. Return to Phase 1.**` line

11. **Common Rationalizations table ≥6 rows (lines 260-275)**
    - `## Common Rationalizations`
    - Markdown table with `Excuse | Reality` headers (see Pattern F for content)

12. **Quick Reference table (lines 277-285)**
    - `## Quick Reference`
    - 4-row markdown table summarizing the four phases (see Pattern G)

13. **Related skills / cross-references (lines 287-300)**
    - `## Related Skills`
    - Bulleted list with REQUIRED entries (s17-c8):
      - `bober.debug` — code-level systematic debugging; sibling skill; use when the incident root cause turns out to be code-level
      - `bober.runbook` (Sprint 18) — runbook execution discipline; use when the diagnoser's next action is "follow runbook X"
      - `bober.deploy` (Sprint 20) — remediation execution via `bober-deployer`; required for any `risky` action
      - `.bober/anti-patterns/` — pattern catalog; cite **Symptom-Fix Instead of Root-Cause** and **Single-Layer Validation** in Phase 3
    - Plus: `agents/bober-diagnoser.md` — the agent that runs this skill

14. **Final length check**
    - `wc -l skills/bober.diagnose/SKILL.md` → expect 200-300 (target ~250)
    - **Verify:** all regression checks from §7 pass

15. **Run full eval suite (s17-c9)**
    - `npm run typecheck` → exit 0
    - `npm run lint` → exit 0
    - `npm run build` → exit 0
    - `npm test` → exit 0
    - (These trivially pass — no source files changed.)

---

## 9. Pitfalls & Warnings

### A. Gate language must be GATING, not advisory (evaluatorNotes §1)
The evaluator will reject phrases like:
- "It is recommended that you complete Phase 1 first"
- "Consider verifying the symptom is current"
- "You should probably gather evidence before hypothesizing"

These are **suggestions**, not gates. The REQUIRED form is:
- "BEFORE proceeding to Phase N+1, you MUST have done X."
- The literal string `BEFORE proceeding to Phase` MUST appear exactly THREE times (one per phase transition).

### B. Phase 4's pre-defined criteria must be PRE-DEFINED, not retrofitted (evaluatorNotes §2)
The skill MUST explicitly forbid: "mark resolved because the dashboard looks better." Use the EXACT phrasing or equivalent strong rejection. The very anti-pattern this skill exists to prevent is post-hoc-rationalization of resolution. Include a Red Flag entry AND a Common Rationalizations row covering this.

### C. Phase 3 disprove discipline must be REQUIRED, not advisory (evaluatorNotes §3)
"You might want to try disproving it" → REJECT.
"Try to find evidence that DISPROVES your top hypothesis. A hypothesis you cannot disprove is not strongly tested." → ACCEPT.

The disproof step is a numbered substep of Phase 3 — not an "additionally consider" footnote. The evaluator will grep for `DISPROVE` (all-caps) OR strong-imperative language like `MUST seek contradicting evidence`.

### D. The skill must DIVERGE from bober.debug enough to justify both (evaluatorNotes §4)
- bober.debug = code-level, sprint-evaluator-feedback-driven, single component, deterministic reproduction
- bober.diagnose = system-level, incident-driven, multi-component, transient/stale symptoms, time-pressure
- **Mirror the SHAPE** (section order, table headers, fenced Iron Law, Red Flags format)
- **Diverge the CONTENT** (incident vocabulary, boundary enumeration, observability MCPs, pre-defined resolution criteria, named-window verification, bober-deployer routing)
- If two paragraphs are word-for-word identical to bober.debug, you've under-adapted — rewrite for incident context.

### E. Verbatim voice directive (generatorNotes last line)
- Capitalized rules in fenced Iron Law
- All-caps STOP at gate conditions (Red Flags closing line)
- `<EXTREMELY-IMPORTANT>` tags at each phase transition (3 total)
- Strong imperatives: `you MUST`, `you DO NOT`, `NEVER`, `ALWAYS`

Reference voice: `skills/bober.debug/SKILL.md`, `skills/bober.using-bober/SKILL.md:10-16`, `agents/bober-diagnoser.md:57-59`.

### F. Schema vocabulary consistency (do not invent variants)
- `confidence` enum: `'low' | 'medium' | 'high'` (NOT `'unknown'`, `'high+'`, `'medium-high'`)
- `blastRadius` enum: `'safe' | 'risky'` (NOT `'caution'`, `'dangerous'`, `'high-risk'`)
- Observability namespace: `obs__<provider>__<tool>` (NOT `mcp__obs_*`, `observability__*`, `obs_*`)
- File names: `observations.jsonl`, `changelog.jsonl`, `actions.jsonl`, `hypotheses.md`, `timeline.jsonl` — EXACTLY (matches Sprint 19 contract)
- Incident ID format: `inc-<YYYYMMDD>-<short-slug>` (matches Sprint 19 s19-c3)

### G. Forward references — precedent already set
You will reference `agents/bober-deployer.md`, `skills/bober.runbook/SKILL.md`, `skills/bober.deploy/SKILL.md`, `src/incident/timeline.ts` — none of which exist yet. **This is fine.** Precedent at `agents/bober-diagnoser.md:215-218` forward-references THIS skill before it existed:
> **`bober.diagnose`** (Sprint 17 — not yet created at the time of this agent's authoring)

Use the same convention: mention the path, parenthetically note the Sprint that creates it (e.g., "Sprint 18", "Sprint 20"), and proceed. Don't try to write defensive "if this file exists" wording.

### H. The attribution test is greppy and exact
`spec-20260524-bober-vision.json:152` says the evaluator greps every new skill file for BOTH `obra/superpowers` AND `MIT`. Both tokens MUST appear, ideally in the attribution blockquote at the top. Do not paraphrase. Do not just say "ported from superpowers" — say `obra/superpowers` literally, and say `MIT License` literally.

### I. Length boundary
- Under 200 lines → may indicate missing content (incomplete worked examples, missing Common Rationalizations rows)
- Over 300 lines → may indicate over-adaptation (rewriting bober.debug content that should be incident-specific OR padding with prose)
- Target: **~250 lines** with all 8 success criteria met.

### J. Markdown table data-row counting
The evaluator counts **data rows** in Common Rationalizations — that is, rows that have `|` separator AND are not the header AND are not the `|--------|` separator row. A markdown formatter that converts the table to HTML or breaks it across blank lines may cause the count to fail. Keep tables compact and within a single contiguous block.

### K. Iron Law fenced block — no language tag
```
NO REMEDIATION WITHOUT VERIFIED ROOT CAUSE AT TWO INDEPENDENT BOUNDARIES
```
Note: no `text`, no `bash`, no `markdown` after the opening backticks. The fence is intentionally bare to render as a plain block (matches bober.debug:22-24 and code-reviewer.md:61-63 voice).

---

## 10. Concrete extracts the Generator can paste-as-skeleton

### Frontmatter (paste exactly)

```yaml
---
name: bober-diagnose
description: Use when investigating a production incident or system-level failure — gather evidence at component boundaries, hypothesize-and-disprove, verify resolution against pre-defined criteria
---
```

### MIT attribution (paste, adapt the third line if needed)

```markdown
> Adapted from [obra/superpowers](https://github.com/obra/superpowers) — MIT License.
> Structural source: skills/systematic-debugging/SKILL.md (four-phase discipline).
> Adaptations: system-level (incident) context; boundary enumeration as Phase 2; pre-defined resolution-verification criteria as Phase 4.
```

### Iron Law block (paste exactly — required wording)

```markdown
## The Iron Law

```
NO REMEDIATION WITHOUT VERIFIED ROOT CAUSE AT TWO INDEPENDENT BOUNDARIES
```

If your evidence comes from a single component, you have a candidate hypothesis — not a verified root cause. Continue gathering at independent boundaries before proposing any remediation.
```

### Phase 1 closing gate (verbatim from contract generatorNotes — paste exactly)

```markdown
<EXTREMELY-IMPORTANT>
BEFORE proceeding to Phase 2, you MUST have completed Phase 1 in writing — symptom confirmed current, scope confirmed, timing confirmed, observations.jsonl appended. If any of these is incomplete, return to Phase 1. Skipping Phase 1 makes Phase 2 evidence-gathering ungrounded.
</EXTREMELY-IMPORTANT>
```

### Phase 2 closing gate (adapt for boundary-evidence)

```markdown
<EXTREMELY-IMPORTANT>
BEFORE proceeding to Phase 3, you MUST have queried at least two independent boundaries and recorded their findings as observations. If only one boundary has data, return to Phase 2 — Phase 3 hypothesis formation on single-boundary evidence violates the Iron Law.
</EXTREMELY-IMPORTANT>
```

### Phase 3 closing gate (adapt for disproof)

```markdown
<EXTREMELY-IMPORTANT>
BEFORE proceeding to Phase 4, you MUST have actively attempted to disprove your top hypothesis and recorded the attempt. A hypothesis that has NOT survived a disproof attempt is NOT remediation-eligible. If you have not yet tried to disprove it, return to Phase 3.
</EXTREMELY-IMPORTANT>
```

### observations.jsonl worked example (paste in Phase 1)

```jsonl
{"timestamp": "2026-05-24T14:05:00Z", "phase": 1, "observation": "Symptom: 500 errors on /api/checkout from 14:00 UTC; ~12% error rate; all regions", "source": "user-report", "verified": true}
{"timestamp": "2026-05-24T14:06:00Z", "phase": 1, "observation": "Confirmed current via fresh metric query — error rate still 11.8% at 14:06", "source": "obs__datadog__query_metric", "verified": true}
{"timestamp": "2026-05-24T14:07:00Z", "phase": 1, "observation": "Scope: all regions, all customers — global incident, not tenant-isolated", "source": "obs__datadog__query_metric", "verified": true}
```

### Resolution-verification criteria worked example (paste in Phase 4 — verbatim from contract generatorNotes)

```
Resolution criteria for INC-2026-0524-001:
  - Metric: api.checkout.error_rate
  - Threshold: < 0.1%
  - Window: 10 minutes sustained
  - Comparison baseline: 7-day rolling average
  - Verification source: obs__datadog__query_metric
```

---

## Final Checklist (for the Generator before declaring done)

- [ ] File exists at `skills/bober.diagnose/SKILL.md`
- [ ] YAML frontmatter: `name: bober-diagnose`; description starts with `Use when investigating a production incident or system-level failure`
- [ ] MIT attribution blockquote mentions `obra/superpowers` AND `MIT`
- [ ] Iron Law fenced block contains `NO REMEDIATION WITHOUT VERIFIED ROOT CAUSE AT TWO INDEPENDENT BOUNDARIES`
- [ ] Four phases present, in order, with `### Phase N` headers
- [ ] Three `BEFORE proceeding to Phase` gates (one each between Phase 1→2, 2→3, 3→4), each wrapped in `<EXTREMELY-IMPORTANT>` tags
- [ ] Phase 1 documents: confirm symptom current, confirm scope, confirm timing, record to `observations.jsonl`
- [ ] Phase 2 documents: enumerate boundaries, query `obs__<provider>__<tool>`, correlate `changelog.jsonl`
- [ ] Phase 3 documents: ranked hypotheses, anti-pattern catalog citation, REQUIRED disprove step
- [ ] Phase 4 documents: pre-defined criteria (metric+threshold+window+baseline+source), `bober-deployer` routing, MCP verification, named-window check
- [ ] Red Flags section has ≥6 bullets
- [ ] Common Rationalizations table has ≥6 data rows
- [ ] Cross-references to: `bober.debug`, `bober.runbook` (Sprint 18), `bober.deploy` (Sprint 20), `.bober/anti-patterns/`
- [ ] Length is 200-300 lines
- [ ] `npm run typecheck && npm run lint && npm run build && npm test` all exit 0

