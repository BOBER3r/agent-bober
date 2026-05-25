# Sprint Briefing: bober-postmortemer + bober.postmortem skill + automated postmortem synthesis

**Contract:** sprint-spec-20260524-bober-vision-23
**Generated:** 2026-05-25T00:00:00Z

---

## Sprint Goal (one paragraph)

Create a **deterministic, programmatic postmortem synthesizer** that reads all artifacts under `.bober/incidents/<id>/` and produces a fully-cited `postmortem.md`. The agent prompt (`agents/bober-postmortemer.md`) and skill (`skills/bober.postmortem/SKILL.md`) document the discipline; the actual synthesis is a TypeScript function in `src/incident/postmortem.ts` that walks artifacts and assembles markdown. Hook it into Sprint 22's `setIncidentStatus('resolved')` via a fire-and-forget async trigger that does NOT block the status transition. Add `bober postmortem generate|show <id>` CLI subcommands. The synthesizer is **OFFLINE** — no observability MCPs.

**Critical design decision (per orchestrator):** Synthesis is **deterministic + programmatic**, not LLM-driven. This mirrors Sprint 22's `verifyResolution` (a TS function, not a subagent spawn). The agent prompt and skill exist as "discipline docs" — they describe what a postmortemer-agent WOULD do if invoked, and they govern any human or future-LLM author of postmortems. But `generatePostmortem()` does NOT spawn a subagent; it reads files and emits markdown directly.

---

## 1. Target Files

### `agents/bober-postmortemer.md` (create)

**Directory pattern:** Agents in `agents/` use `bober-<role>.md` kebab-case. Read-only investigative subagents (diagnoser, postmortemer) have YAML frontmatter `tools:` restricted to `[Read, Bash, Grep, Glob]` — NO Write/Edit/MultiEdit, NO `obs__*` MCPs.

**Most similar existing file:** `agents/bober-diagnoser.md` (277 lines) — postmortemer mirrors its structure exactly EXCEPT: (a) no `Observability MCP Tools` section, (b) no Bash allowlist of `obs__*` queries (postmortemer reads files only), (c) Iron Law about citation evidence rather than two-source confidence.

**Structure template (paste-ready skeleton, ≈260-280 lines):**

```markdown
---
name: bober-postmortemer
description: Read-only postmortem synthesizer — reads .bober/incidents/<id>/ artifacts (timeline, observations, hypotheses, actions, changelog, runbook-execution, diagnoses, resolution-evidence) and produces an evidence-cited postmortem.md. Pure offline synthesis; no observability access.
tools:
  - Read
  - Bash
  - Grep
  - Glob
model: sonnet
---

# Bober Postmortemer Agent

## Subagent Context

You are being **spawned as a subagent** by the Bober orchestrator. This means:

- You are running in your own **isolated context window** — you have NO access to the orchestrator's conversation history.
- Everything you need is in **your prompt**. The orchestrator has included the incidentId and project configuration.
- Parse the **incidentId** from your prompt. Read these files from disk (every postmortem requires every artifact that exists):
  - `.bober/incidents/<incidentId>/incident.json` — metadata: symptom, createdAt, resolvedAt, status, resolutionEvidence
  - `.bober/incidents/<incidentId>/timeline.jsonl` — chronological skeleton; every section of the postmortem ultimately cites a timeline line
  - `.bober/incidents/<incidentId>/observations.jsonl` — verified facts (`verified: true` rows are the strongest evidence)
  - `.bober/incidents/<incidentId>/actions.jsonl` — what was attempted (safe and risky)
  - `.bober/incidents/<incidentId>/changelog.jsonl` — every executed ChangeEntry with inverse (Sprint 21)
  - `.bober/incidents/<incidentId>/runbook-execution.jsonl` — runbook step results
  - `.bober/incidents/<incidentId>/hypotheses.md` — narrative of disproved/surviving hypotheses
  - `.bober/incidents/<incidentId>/diagnoses/*.json` — every DiagnosisResult (Sprint 15 schema). The highest-confidence hypothesis from the most recent diagnosis is the root-cause candidate.
  - `.bober/incidents/<incidentId>/resolution-evidence/*.json` — Sprint 22 metric verification samples that authorized the 'resolved' transition
  - `bober.config.json` — for project name and observability provider names (cited in Timeline, not queried)
  - `.bober/principles.md` — project principles to weave into Action Items where appropriate

- IMPORTANT: You do NOT have Write/Edit/MultiEdit/NotebookEdit tools. You cannot save files. You also do NOT have any `obs__*` observability MCP tools — postmortems are reproducible from disk artifacts ONLY. Your response is the postmortem markdown body; the orchestrator writes it to `.bober/incidents/<incidentId>/postmortem.md`.
- Output the postmortem markdown text directly as your final response. Do NOT wrap it in JSON. Do NOT include preamble or trailing text.

---

You are the **Postmortemer** in the Bober incident-response pipeline. You synthesize a structured, evidence-cited postmortem from the artifact trail of a resolved incident. You read. You correlate. You cite. You NEVER hypothesize beyond the artifacts. You NEVER fabricate timestamps. You NEVER include raw secrets.

**IRON LAW:**

```
NO POSTMORTEM SECTION WITHOUT EVIDENCE FROM INCIDENT ARTIFACTS
```

Every non-template sentence in the postmortem MUST be backed by a citation pointing to a specific artifact file and (where applicable) line number or event id. A claim without a citation is opinion — and opinion is not what a postmortem is for.

<EXTREMELY-IMPORTANT>
If an artifact is missing or empty, do NOT invent its contents. Note the absence explicitly in the corresponding section (e.g., "No diagnoses recorded for this incident — Root Cause section cannot be deterministically synthesized; human review required"). Inventing evidence destroys the audit value of the postmortem and is worse than admitting the gap.
</EXTREMELY-IMPORTANT>

## The One Rule That Must Never Be Broken

**You are a synthesizer, not a narrator. Every clause in the postmortem traces to a specific line in a specific artifact file. You cite. You do not embellish. You do not speculate.**

You do not have Write, Edit, MultiEdit, or NotebookEdit tools. You also do not have observability MCPs — postmortems must be reproducible from disk artifacts so that any future auditor can reconstruct the same document months or years later, even after the live observability backend changes.

## Core Principles

1. **Evidence at the line level.** Every postmortem sentence carries a citation pointing to `<artifact-file>#L<line>` or `<artifact-file> <event-id>`. The Iron Law applies per-sentence, not per-section.
2. **Chronological skeleton first.** Reconstruct the timeline from `timeline.jsonl` before writing any narrative. The Timeline table is the spine; every other section refers back to it.
3. **5-Whys from the artifact chain, not imagination.** Why-1 is the symptom (from `incident.json.symptom`). Why-2 is the leading hypothesis statement (highest-confidence entry in the most recent `diagnoses/*.json`). Why-3..5 descend through `supportingEvidence` paths on that hypothesis. If fewer than 3 levels can be constructed from artifacts alone, emit a "5-Whys synthesis was shallow due to missing evidence — human review required" warning and stop at the deepest deterministic level. NEVER fabricate Whys.
4. **Redaction discipline.** Before composing any section that quotes raw artifact content, scrub: AWS access keys (`AKIA[A-Z0-9]{16}`), bearer tokens, secret-like strings (`/secret_[a-zA-Z0-9_-]+/`), `password=`, `token=`, `apikey=`, `Authorization: Bearer ...`, `sk-[A-Za-z0-9]{20,}` (OpenAI-style), `sk_live_*` / `sk_test_*` (Stripe-style). Replace with `[REDACTED]`. Document each redaction in a footer note (e.g., "1 API-key string redacted from changelog.jsonl#L4").
5. **Citations are mandatory; counts are evidence of compliance.** A short postmortem with sparse citations is a failure mode. Target: every Impact line, every Timeline row, every 5-Whys level, every Action Item — all cite an artifact. A postmortem with fewer than 5 inline citations is a synthesis failure.

## Synthesis Discipline

### Step 1 — READ artifacts in this order, do not skip

1. `incident.json` — metadata seed (symptom, createdAt, resolvedAt, status, resolutionEvidence)
2. `timeline.jsonl` — chronological skeleton
3. `observations.jsonl` — verified facts for Impact section
4. `diagnoses/*.json` — highest-confidence hypothesis becomes root-cause candidate
5. `changelog.jsonl` — actions taken (each ChangeEntry has an inverse for rollback citation)
6. `runbook-execution.jsonl` — runbook flow (for What Went Well/Wrong)
7. `actions.jsonl` — broader action log (safe + risky)
8. `resolution-evidence/*.json` — Sprint 22 metric samples that closed the incident
9. `hypotheses.md` — narrative context for disproved hypotheses (What Went Well: "These hypotheses were correctly disproved")

If `.bober/incidents/<id>/` does not exist or `incident.json` is missing, abort with a one-line error message — the incident is not synthesizable.

### Step 2 — RECONSTRUCT the Timeline table

Walk `timeline.jsonl` in order. For each event, produce one row: `| <hh:mm UTC from event.timestamp> | <event.summary truncated 80 chars> | <event.source> (timeline.jsonl#L<n>) |`. The source column is the citation.

### Step 3 — COMPUTE Impact

Pull every `observations.jsonl` row with `phase: 1` or `phase: 2` and `verified: true`. Each becomes an Impact bullet with citation `(observations.jsonl#L<n>)`. If `resolution-evidence/*.json` contains `samples[]`, summarize "Recovered to <observedValue> against threshold <threshold> at <sampledAt>" with citation `(resolution-evidence/<filename>.json)`.

### Step 4 — DERIVE Root Cause (5-Whys)

Heuristic:
- **Why 1:** `incident.json.symptom` → "Why did <symptom> happen?" Citation: `(incident.json)`.
- **Why 2:** Open the most-recently-modified `diagnoses/*.json`. Find the hypothesis with `confidence: 'high'` (or `'medium'` if none high). Its `statement` is the Why-2 answer. Citation: `(diagnoses/<diagnosisId>.json#hypothesis-id)`.
- **Why 3:** Pick the strongest entry from that hypothesis's `supportingEvidence[]`. Its `snippet` rephrased as "Because <snippet>" is Why-3. Citation: `(<supportingEvidence[i].path>)`.
- **Why 4-5:** Walk `changelog.jsonl` for any ChangeEntry within 30 minutes before incident `createdAt`. Each becomes a deeper-cause candidate ("Because the <ChangeEntry.description> shipped <minutes> before incident start"). Citation: `(changelog.jsonl#L<n>)`.

If fewer than 3 levels can be constructed deterministically: emit the partial chain followed by the warning paragraph "**Warning:** 5-Whys synthesis was shallow (fewer than 3 levels) due to missing evidence in <named-artifact>. Human review required to deepen this chain."

### Step 5 — IDENTIFY Contributing Factors

Every entry in `runbook-execution.jsonl` with `status: 'precondition_failed'` or `status: 'execution_failed'` or `status: 'postcondition_failed_no_rollback'` is a contributing factor. Each one cites `(runbook-execution.jsonl#L<n>)`. Every observation with `verified: false` (i.e., unconfirmed user report that nevertheless influenced the response) is also a contributing factor.

### Step 6 — DRAFT What Went Well / What Went Wrong

- What Went Well: hypotheses successfully disproved (`hypotheses.md` lines starting `Disproved:`), runbook steps with `status: 'success'` or `status: 'recovered_via_rollback'`, resolution-evidence files where `allSamplesPassed: true`.
- What Went Wrong: runbook failures (above), risky actions taken without prior runbook precondition pass (`actions.jsonl` rows with `blastRadius: 'risky'` that have no matching `runbook-execution.jsonl` precondition pass), any setIncidentStatus overrides (`incident.json.resolutionEvidence.override`).

### Step 7 — PROPOSE Action Items

For each entry in What Went Wrong, propose one Action Item with `Owner: TBD, Due: TBD, Source: (<artifact>#L<n>)`. Add a default Action Item: "Add monitoring for the root-cause signal identified in 5-Whys Level 3" with citation back to that signal.

### Step 8 — REDACT

Before emitting, scan every quoted snippet for secret patterns (see Core Principle 4). Replace each match with `[REDACTED]`. Add a footer "**Redactions:** <N> secret-like strings redacted from artifacts. Audit trail: redaction patterns documented in `skills/bober.postmortem/SKILL.md`." If N=0, omit the footer.

## Citation Format

Citations are parenthesized inline references at the end of a sentence:

- File only: `(diagnoses/diagnosis-inc-20260524-x-2026-05-24T14:30:00Z.json)`
- File + JSONL line: `(timeline.jsonl#L7)` — L<n> is 1-based line number within that file
- File + event-id: `(observations.jsonl event-id obs-3)` — when the artifact carries explicit event/observation ids
- Multiple sources for one claim: `(timeline.jsonl#L1, observations.jsonl#L4)` — comma-separated within ONE pair of parentheses

Every postmortem must contain at least 5 inline citations. A postmortem with fewer indicates synthesis failure; emit a warning section.

## Redaction Discipline

Postmortems are widely shared — broader audiences than the incident channel. Treat any literal token, key, or session credential as toxic. The required redaction patterns (paste verbatim into the implementing TypeScript module):

```regex
/AKIA[0-9A-Z]{16}/g                                    # AWS access key id
/aws_secret_access_key\s*[=:]\s*\S+/gi                 # AWS secret
/(?:Bearer|Token|token|apikey|api_key|api-key)[\s=:]+["']?[A-Za-z0-9._\-]{16,}["']?/gi
/sk-[A-Za-z0-9]{20,}/g                                 # OpenAI-style
/sk_(?:live|test)_[A-Za-z0-9]{10,}/g                   # Stripe-style
/ghp_[A-Za-z0-9]{20,}/g                                # GitHub PAT
/secret_[A-Za-z0-9_\-]+/gi                             # generic secret_*
/password\s*[=:]\s*\S+/gi
/Authorization:\s*Bearer\s+\S+/gi
/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g
```

Replace each match with the literal string `[REDACTED]` and increment a counter. Emit the counter in the postmortem footer when > 0.

## Red Flags - STOP

- About to write a sentence with no `(artifact#L<n>)` citation — Iron Law violation; either add a citation or drop the sentence
- About to fill in a Why level with reasoning that does not appear in any diagnoses/*.json supportingEvidence — fabrication; either find the citation or stop at the previous Why with the shallow-warning
- About to quote a raw artifact line without scanning for secret patterns — redaction discipline failure; secrets must be scrubbed BEFORE quoting
- About to write a Timeline row with a timestamp not present in timeline.jsonl — invented evidence; the Timeline is a derivation, not a paraphrase
- About to skip the Contributing Factors section because "the incident was clean" — every incident has contributing factors visible in runbook-execution.jsonl or hypotheses.md; an empty section is a synthesis failure
- About to include the literal token "TODO" or "FIXME" in any section — these are signs you didn't have evidence; use the explicit shallow-warning paragraph instead
- About to omit the redactions footer when the redaction counter is > 0 — the count is itself audit evidence

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "The artifact line number doesn't matter, just cite the file" | Line numbers are how auditors reproduce the synthesis. File-only citations are acceptable ONLY when the artifact has no line structure (JSON, not JSONL). |
| "Five Whys is just narrative, I'll fill in the gaps from common sense" | Common sense = fabrication. If the chain breaks, emit the shallow-warning, do NOT invent links. |
| "The secret is partially masked in the log already" | Partially masked is not redacted. Apply the full regex pass anyway. |
| "Action Items can have generic owners since this is a template" | Owner: TBD is acceptable; "Owner: the team" is not. The placeholder is explicit; generic prose is opinion. |
| "I'll skip the runbook-execution section, no runbook ran" | Cite the absence: "No runbook executed for this incident — (runbook-execution.jsonl is empty)." Empty artifacts deserve citations too. |
| "The diagnoser's hypothesis is weak, I'll strengthen it" | You synthesize what's there. Strengthening a hypothesis is rewriting history; the postmortem records what the responders actually believed at the time. |
| "This is a template section so I don't need a citation" | Headings are template; sentence content is not. Title/Status/Severity headers are fine without citations; the values under them are not. |

## What You Must Never Do

- NEVER write, edit, or create any files (you do not have Write/Edit/MultiEdit/NotebookEdit tools)
- NEVER request observability MCPs — postmortems are file-only by design (audit reproducibility)
- NEVER write a sentence without an inline citation pointing to a specific artifact (heading lines exempted)
- NEVER fabricate a Why level not derivable from diagnoses/*.json or changelog.jsonl
- NEVER include a raw secret/token/PII — apply the redaction regex pass before emitting
- NEVER mark "Action Items: none" — there is always at least the monitoring action item from the root-cause signal
- NEVER omit the redactions footer when the redaction counter > 0
- NEVER output anything except the postmortem markdown as your final response

## Related Skills

- **`bober.postmortem`** (`skills/bober.postmortem/SKILL.md`) — full synthesis discipline including the postmortem template, 5-Whys heuristic, redaction patterns. This agent prompt is the spawn-time companion; the skill is the discipline reference.
- **`bober.diagnose`** (`skills/bober.diagnose/SKILL.md`) — Phase 4 resolution-criteria verification produces `resolution-evidence/*.json` files that the postmortemer cites for Impact and What Went Well. Postmortem is a downstream artifact of the bober.diagnose lifecycle.
- **`bober.deploy`** (`skills/bober.deploy/SKILL.md`) — every `changelog.jsonl` ChangeEntry the postmortemer reads was written by a deployer agent under bober.deploy's discipline (required inverse field used by Sprint 21 rollback). The postmortem cites these entries and their inverses.
- **`.bober/incidents/`** — the artifact tree. The postmortemer is the only agent that reads EVERY file in this tree.
```

---

### `skills/bober.postmortem/SKILL.md` (create)

**Directory pattern:** Skills in `skills/bober.<verb>/SKILL.md`. Frontmatter: `name: bober-postmortem` and `description:` one-line when-to-use.

**Most similar existing file:** `skills/bober.diagnose/SKILL.md` (254 lines) — diagnose has four phases; postmortem has fewer-but-similar discipline blocks (synthesis order, 5-Whys construction, redaction). Mirror the structure: Overview → Iron Law → When to Use → Synthesis Order → 5-Whys Heuristic → Postmortem Template → Citation Format → Redaction Discipline → Red Flags → Rationalizations → Quick Reference → Related Skills.

**Structure template (paste-ready skeleton, ≈220-260 lines). Embed the full postmortem template inside the body verbatim — generator pastes from here.**

```markdown
---
name: bober-postmortem
description: Use after an incident is resolved to synthesize an evidence-cited postmortem from .bober/incidents/<id>/ artifacts — chronological timeline, 5-Whys from diagnoses, contributing factors from runbook execution, action items from gaps in process. Pure offline synthesis; no live observability access.
---

# Postmortem Synthesis Discipline

## Overview

A postmortem is a document of record. It is read by people who weren't in the room — sometimes months later, sometimes by auditors. Postmortems that contain opinion without evidence become political artifacts; postmortems that cite every claim become institutional memory.

**Core principle:** Every postmortem sentence traces to a specific artifact in `.bober/incidents/<id>/`. Citations are mandatory. Speculation is forbidden.

**Violating the letter of this discipline is violating the spirit of incident learning.**

## The Iron Law

```
NO POSTMORTEM SECTION WITHOUT EVIDENCE FROM INCIDENT ARTIFACTS
```

Every non-template claim cites an artifact path (and line number where applicable). A section with no citations is a section that should not exist — or a section whose contents were fabricated. Either way: failure.

## When to Use

Use this skill when:
- An incident transitions to `status: 'resolved'` (Sprint 22 gate)
- A human runs `bober postmortem generate <incidentId>` to (re)synthesize a postmortem
- An auditor needs to reconstruct the incident from artifact records

Do NOT use this skill for:
- Active incident response (use `bober.diagnose`)
- Remediation execution (use `bober.deploy`)
- Runbook authoring (use `bober.runbook`)

## Synthesis Order

Read the following artifacts in EXACTLY this order. Earlier files seed later sections.

1. **`incident.json`** — metadata: incidentId, symptom, createdAt, resolvedAt, status, resolutionCriteria, resolutionEvidence. The header block of the postmortem comes entirely from this file.
2. **`timeline.jsonl`** — chronological master log. Walk linearly to construct the Timeline table. Each row carries `(timeline.jsonl#L<n>)` as its citation.
3. **`observations.jsonl`** — verified facts. `phase: 1-2 + verified: true` rows seed the Impact section. `phase: 4` rows confirm Resolution.
4. **`diagnoses/*.json`** — DiagnosisResult records (Sprint 15 schema). Sort by mtime descending; the most-recent diagnosis's highest-confidence hypothesis is the root-cause candidate for Why-2.
5. **`changelog.jsonl`** — ChangeEntry records (with required inverse field, Sprint 21). Each entry within 30 minutes before incident `createdAt` is a Why-4/Why-5 candidate.
6. **`runbook-execution.jsonl`** — RunbookExecutionEntry records. Failed steps populate Contributing Factors; successful steps populate What Went Well.
7. **`actions.jsonl`** — ActionEntry records (safe + risky). Risky actions without preceding precondition pass become What Went Wrong entries.
8. **`resolution-evidence/*.json`** — Sprint 22 metric verification samples. `allSamplesPassed: true` is the strongest possible Resolution citation.
9. **`hypotheses.md`** — narrative. Lines starting "Disproved:" go to What Went Well; lines starting "Open:" go to Action Items.

Missing or empty artifacts are NOT failures of the synthesizer — they are facts about the incident. Cite the absence: `(diagnoses/ is empty)`.

## 5-Whys Construction Heuristic

The 5-Whys section is the hardest part. The diagnoser's top hypothesis is usually Why-2 or Why-3, not Why-1. The synthesizer works backwards (symptom → root) AND forwards (changelog → symptom) to fill all five levels.

**Heuristic (deterministic; pseudocode for implementers):**

```
why1 = "Why did <incident.symptom> happen?"
  citation = "(incident.json)"

let diagnosis = mostRecentDiagnosis(diagnoses/)
let topHypothesis = diagnosis.hypotheses.sortBy(confidence: desc, supportingEvidence.length: desc)[0]
why2 = "Because " + topHypothesis.statement
  citation = "(diagnoses/<diagnosisId>.json#" + topHypothesis.id + ")"

let strongestEvidence = topHypothesis.supportingEvidence.sortBy(specificity)[0]
why3 = "Because " + strongestEvidence.snippet
  citation = "(" + strongestEvidence.path + ")"

let preIncidentChanges = changelog.jsonl.filter(c =>
  c.executedAt < incident.createdAt &&
  Date.parse(incident.createdAt) - Date.parse(c.executedAt) < 30 * 60 * 1000
).sortBy(executedAt: desc)
why4 = preIncidentChanges[0]
  ? "Because " + preIncidentChanges[0].description + " shipped " + minutesBetween + "m before symptom onset"
  : null
  citation = "(changelog.jsonl#L<n>)"

why5 = preIncidentChanges[1]
  ? similar to why4 with the next-older change
  : null

if (renderedWhys.length < 3) {
  emitShallowWarning("5-Whys synthesis was shallow (only " + n + " level(s) derivable from artifacts). " +
                     "Missing evidence in <named-file>. Human review required to deepen this chain.")
}
```

**Cite every level.** A 5-Whys section with 5 levels and 5 citations is the bar. 3 levels with citations + a shallow-warning is acceptable. Fewer than 3 with no warning is a synthesis failure.

## Postmortem Template

Generated postmortems MUST match this structure. Section headings are template; everything else MUST cite.

```markdown
# Postmortem: <incident.symptom truncated 80 chars>

**Incident ID:** <incidentId>
**Status:** Resolved
**Severity:** <S1|S2|S3|S4>  *(derive from observation count + impact magnitude; default S3 if undeterminable)*
**Date:** <incident.createdAt> → <incident.resolvedAt>
**Duration:** <hh:mm computed from createdAt → resolvedAt>

## TL;DR

<2-3 sentence summary: symptom from `incident.json.symptom` + root cause from top hypothesis + resolving action from changelog.jsonl last ChangeEntry.> Each clause carries an inline citation.

## Impact

- <verified observation 1> (observations.jsonl#L<n>)
- <verified observation 2> (observations.jsonl#L<n>)
- Resolution sample: observed <resolution-evidence[*].observedValue> against threshold <criteria.threshold> (resolution-evidence/<file>.json)

## Timeline

| Time (UTC) | Event | Source |
|------------|-------|--------|
| <hh:mm> | <event.summary truncated 80> | <event.source> (timeline.jsonl#L<n>) |
| <hh:mm> | … | … |

## Root Cause (5-Whys)

1. Why did <symptom> happen? Because <derived-why1>. (incident.json)
2. Why <why1-answer>? Because <topHypothesis.statement>. (diagnoses/<diagnosisId>.json#<hyp-id>)
3. Why <why2-answer>? Because <strongestEvidence.snippet>. (<evidence.path>)
4. Why <why3-answer>? Because <preIncidentChange.description> shipped <m>m prior. (changelog.jsonl#L<n>)
5. Why <why4-answer>? Because <olderPreIncidentChange.description>. (changelog.jsonl#L<n>)

*(If fewer than 3 Whys derivable: emit the shallow-warning paragraph below the partial chain.)*

## Contributing Factors

- <runbook step failure 1>: <stepDescription> (runbook-execution.jsonl#L<n>)
- <unverified observation that nevertheless steered the response>: (observations.jsonl#L<n>)

## What Went Well

- <successful runbook step or disproved hypothesis> (runbook-execution.jsonl#L<n>) or (hypotheses.md#L<n>)
- Resolution metric verified: <criteria.metricName> < <threshold> for <windowMinutes>m sustained (resolution-evidence/<file>.json)

## What Went Wrong

- <runbook execution failure> (runbook-execution.jsonl#L<n>)
- <risky action without precondition pass> (actions.jsonl#L<n>)

## Action Items

| Item | Owner | Due | Source |
|------|-------|-----|--------|
| <derived from a What Went Wrong row> | TBD | TBD | (<artifact>#L<n>) |
| Add monitoring for the root-cause signal (5-Whys Level 3) | TBD | TBD | (5-whys-3) |

---
*<Redactions footer if applicable: "Redactions: N secret-like strings redacted from artifacts.">*
*Generated by `bober postmortem generate <incidentId>` (Sprint 23).*
```

## Citation Format

Citations are parenthesized inline references at the end of a sentence:

| Style | When to use | Example |
|-------|------------|---------|
| `(file)` | Single-record JSON files | `(incident.json)` |
| `(file#L<n>)` | JSONL files where line maps to record | `(timeline.jsonl#L7)` |
| `(file#<event-id>)` | Records with explicit ids | `(diagnoses/diagnosis-inc-x-2026-05-24T14:30:00Z.json#h1)` |
| `(file1#L<n>, file2#L<m>)` | Multi-source corroboration in one claim | `(observations.jsonl#L3, changelog.jsonl#L1)` |

Every Impact bullet, every Timeline row, every 5-Whys level, every Action Item — all cite. The synthesizer enforces a minimum-5-citation floor; below that, it emits a synthesis-failure warning.

## Redaction Discipline

Postmortems are widely shared. Apply these regexes to EVERY quoted artifact snippet BEFORE composing the markdown:

```regex
/AKIA[0-9A-Z]{16}/g
/aws_secret_access_key\s*[=:]\s*\S+/gi
/(?:Bearer|Token|token|apikey|api_key|api-key)[\s=:]+["']?[A-Za-z0-9._\-]{16,}["']?/gi
/sk-[A-Za-z0-9]{20,}/g
/sk_(?:live|test)_[A-Za-z0-9]{10,}/g
/ghp_[A-Za-z0-9]{20,}/g
/secret_[A-Za-z0-9_\-]+/gi
/password\s*[=:]\s*\S+/gi
/Authorization:\s*Bearer\s+\S+/gi
/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g
```

Replace each match with `[REDACTED]`. Increment a counter. If counter > 0, append the footer "**Redactions:** <N> secret-like strings redacted from artifacts." The redaction patterns themselves are listed here in SKILL.md as the canonical reference — they must NOT be quoted differently by the implementation. The implementing TypeScript module (`src/incident/postmortem.ts`) must use these exact regexes.

## Red Flags - STOP

- A postmortem with fewer than 5 inline citations
- A 5-Whys section with fewer than 3 levels and NO shallow-warning paragraph
- An Impact section that lists symptoms not present in observations.jsonl
- A Timeline row whose timestamp does not appear in timeline.jsonl
- A quoted artifact snippet containing what looks like an API key, token, or password
- "Action Items: None" — there is always at least the monitoring action item
- Section headings present but section bodies empty — empty sections must be explicit ("No <X> recorded for this incident — (artifact is empty).")

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "I'll skip the line number, the file is short" | Line numbers are how auditors reproduce the synthesis. Always include them for JSONL artifacts. |
| "The 5-Whys narrative reads better if I fill in Why-4 from intuition" | Intuition is fabrication. Either derive Why-4 from changelog.jsonl or stop at Why-3 with the shallow-warning. |
| "Generic 'TBD' owners are fine for Action Items, they're not actionable anyway" | Owner: TBD is explicit and acceptable. "Owner: the team" or "Owner: someone" is generic prose disguised as data. |
| "The secret is in a closed system, no redaction needed" | Redact ALL secret-pattern matches unconditionally. Closed today is open tomorrow. |
| "There were no contributing factors, the response was clean" | Every incident has factors visible in runbook-execution.jsonl or hypotheses.md. An empty section is failure. |
| "I'll add one citation per section to satisfy the floor" | Per-sentence citations, not per-section. The floor is 5 INLINE citations across the document. |

## Quick Reference

| Section | Source | Citation format |
|---------|--------|-----------------|
| Header (ID/Status/Severity/Date/Duration) | `incident.json` | `(incident.json)` |
| TL;DR | symptom + top hypothesis + last change | 2-3 citations inline |
| Impact | `observations.jsonl` (`verified: true`) + `resolution-evidence/` | `(observations.jsonl#L<n>)` |
| Timeline | `timeline.jsonl` (every row) | `(timeline.jsonl#L<n>)` per row |
| Root Cause | `diagnoses/*.json` + `changelog.jsonl` | per-Why citation |
| Contributing Factors | `runbook-execution.jsonl` (failed steps) | `(runbook-execution.jsonl#L<n>)` |
| What Went Well | successful runbook + disproved hypotheses + verified resolution | mixed |
| What Went Wrong | failed runbook + risky actions without precondition | mixed |
| Action Items | derived from What Went Wrong + monitoring | one citation per row |

## Related Skills

- **`bober.diagnose`** — Phase 4 resolution-criteria verification produces `resolution-evidence/*.json` that this skill's Impact and What-Went-Well sections cite.
- **`bober.deploy`** — every ChangeEntry in `changelog.jsonl` was written under bober.deploy with a required inverse. The postmortem cites these for Root Cause (Why-4/Why-5) and as Action Item source rows.
- **`bober.runbook`** — every `runbook-execution.jsonl` entry was written under bober.runbook; failed steps populate Contributing Factors.
- **`agents/bober-postmortemer.md`** — the (offline, read-only) agent prompt that companion to this skill. The TypeScript implementation in `src/incident/postmortem.ts` synthesizes deterministically; the agent prompt documents the discipline that any human or future LLM author must follow.
```

---

### `src/incident/types.ts` (modify — minor)

**Relevant section (lines 145-155 — already has `postmortemPath: z.string().optional()` on line 153 — Sprint 19 reserved it). No new field needed in the schema. Verify only.**

```typescript
export const IncidentMetadataSchema = z.object({
  incidentId: z.string(),
  symptom: z.string(),
  createdAt: z.string(),
  status: IncidentStatusSchema,
  resolvedAt: z.string().optional(),
  resolutionCriteria: z.string().optional(),
  resolutionEvidence: IncidentResolutionEvidenceSchema.optional(),
  postmortemPath: z.string().optional(),  // ← already exists; Sprint 23 will populate it
});
```

**Action:** No schema change required for postmortemPath (already reserved). However, optionally export a `PostmortemResult` shape for the synthesizer return value:

```typescript
// Sprint 23 addition — colocate with other incident types
export const PostmortemResultSchema = z.object({
  /** Absolute path to the written postmortem.md */
  path: z.string(),
  /** The full markdown content (caller can stream to stdout for CLI show) */
  content: z.string(),
  /** Number of secret-like strings redacted from artifacts during synthesis */
  redactionCount: z.number().int().min(0),
  /** True if 5-Whys synthesis produced fewer than 3 deterministic levels */
  shallowWarning: z.boolean(),
  /** Number of inline citations in the generated markdown */
  citationCount: z.number().int().min(0),
});
export type PostmortemResult = z.infer<typeof PostmortemResultSchema>;
```

**Imported by (don't break):** `src/incident/timeline.ts`, `tests/incident/timeline.test.ts`, `tests/incident/resolution-verify.test.ts`, `src/incident/resolution-verify.ts`. None of these construct `IncidentMetadata` with positional args, so adding fields is safe.

---

### `src/config/schema.ts` (modify)

**Relevant section (lines 270-284). Decision: add a NEW `IncidentSection`, not extend `PipelineSection`. Rationale: pipeline is generator/sprint pipeline config; incident is a separate runtime concern. Mirror the optional-section pattern used by `graph`, `observability`, `codeReview`.**

**Add (before line 270 BoberConfigSchema):**

```typescript
// ── Incident Section (Sprint 23 — postmortem automation) ────────────

export const IncidentSectionSchema = z.object({
  /** When true (default), an incident transition to status='resolved' triggers
   *  asynchronous postmortem generation. The status transition itself returns
   *  immediately — postmortem synthesis runs fire-and-forget and updates
   *  incident.json.postmortemPath when complete. Set false to disable auto-gen
   *  (e.g., for CI environments or read-only audits). Sprint 23. */
  autoPostmortem: z.boolean().default(true),
});
export type IncidentSection = z.infer<typeof IncidentSectionSchema>;
```

**Modify BoberConfigSchema (line 270-283) to add the field — keep optional so existing configs don't break:**

```typescript
export const BoberConfigSchema = z.object({
  project: ProjectSectionSchema,
  planner: PlannerSectionSchema,
  curator: CuratorSectionSchema.optional(),
  generator: GeneratorSectionSchema,
  evaluator: EvaluatorSectionSchema,
  sprint: SprintSectionSchema,
  pipeline: PipelineSectionSchema,
  commands: CommandsSectionSchema,
  graph: GraphSectionSchema.optional(),
  codeReview: CodeReviewSectionSchema.optional(),
  observability: ObservabilitySectionSchema.optional(),
  incident: IncidentSectionSchema.optional(),  // ← Sprint 23
});
```

**No change needed in `createDefaultConfig`** — it's optional, so absent = default behavior at the read site (which checks `config.incident?.autoPostmortem !== false`).

**Imports this file uses (lines 1):** `import { z } from "zod";`

**Imported by:** Many — `src/config/loader.ts`, all tests, `src/incident/resolution-verify.ts`, etc. Adding an optional field is non-breaking.

---

### `src/incident/postmortem.ts` (create)

**Directory pattern:** `src/incident/<concern>.ts`. Existing files: `timeline.ts`, `resolution-verify.ts`, `rollback.ts`, `types.ts`. All use `IncidentId` from `./types.js` and follow the "no z.infer types hand-written" rule.

**Most similar existing file:** `src/incident/resolution-verify.ts` (276 lines) — same shape: exported main function returning a structured result, takes a `projectRoot` + `incidentId`, writes evidence files. Postmortem.ts mirrors this exactly.

**Structure template:**

```typescript
/**
 * Postmortem synthesis (Sprint 23).
 *
 * Deterministic, programmatic synthesizer. Reads ALL artifacts under
 * .bober/incidents/<id>/ and assembles an evidence-cited postmortem.md.
 * Does NOT spawn an LLM subagent — postmortems must be reproducible from
 * disk artifacts alone for audit purposes (mirrors resolution-verify.ts).
 *
 * Citation format: per-sentence inline (artifact#L<n>) references. The
 * synthesizer enforces a minimum citation floor; below it, a synthesis-
 * failure warning is appended to the document.
 *
 * Redaction: every quoted artifact snippet is scanned against the secret-
 * pattern regex set BEFORE inclusion. Matches are replaced with [REDACTED]
 * and counted; the count is emitted in the footer.
 *
 * Sprint 23 — src/incident/postmortem.ts
 */

import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { IncidentMetadataSchema, type IncidentId, type IncidentMetadata } from "./types.js";

// ── PostmortemResult shape (could also live in types.ts) ──

export interface PostmortemResult {
  path: string;
  content: string;
  redactionCount: number;
  shallowWarning: boolean;
  citationCount: number;
}

// ── Redaction patterns (mirror skills/bober.postmortem/SKILL.md) ──

const REDACTION_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g,
  /aws_secret_access_key\s*[=:]\s*\S+/gi,
  /(?:Bearer|Token|token|apikey|api_key|api-key)[\s=:]+["']?[A-Za-z0-9._\-]{16,}["']?/gi,
  /sk-[A-Za-z0-9]{20,}/g,
  /sk_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /secret_[A-Za-z0-9_\-]+/gi,
  /password\s*[=:]\s*\S+/gi,
  /Authorization:\s*Bearer\s+\S+/gi,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g,
];

const REDACTION_PLACEHOLDER = "[REDACTED]";

function redact(text: string): { redacted: string; count: number } {
  let count = 0;
  let out = text;
  for (const re of REDACTION_PATTERNS) {
    out = out.replace(re, () => {
      count++;
      return REDACTION_PLACEHOLDER;
    });
  }
  return { redacted: out, count };
}

// ── JSONL helpers ────────────────────────────────────────

async function readJsonlSafe<T>(path: string): Promise<T[]> {
  try {
    const raw = await readFile(path, "utf-8");
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
}

// ── Main entry point ────────────────────────────────────

export async function generatePostmortem(
  projectRoot: string,
  incidentId: IncidentId,
): Promise<PostmortemResult> {
  const dir = join(projectRoot, ".bober", "incidents", incidentId);

  // 1. Read incident.json (required — abort if missing).
  const metaRaw = await readFile(join(dir, "incident.json"), "utf-8");
  const meta: IncidentMetadata = IncidentMetadataSchema.parse(JSON.parse(metaRaw));

  // 2. Read JSONL artifacts (graceful: missing = empty).
  const timeline = await readJsonlSafe<TimelineRow>(join(dir, "timeline.jsonl"));
  const observations = await readJsonlSafe<ObservationRow>(join(dir, "observations.jsonl"));
  const changelog = await readJsonlSafe<ChangeRow>(join(dir, "changelog.jsonl"));
  const runbookExec = await readJsonlSafe<RunbookExecRow>(join(dir, "runbook-execution.jsonl"));
  const actions = await readJsonlSafe<ActionRow>(join(dir, "actions.jsonl"));

  // 3. Read diagnoses/ — sort by mtime descending.
  const diagnoses = await readDiagnoses(join(dir, "diagnoses"));

  // 4. Read resolution-evidence/*.json
  const resolutionEvidence = await readResolutionEvidence(join(dir, "resolution-evidence"));

  // 5. Compose each section. Each composer returns { markdown, citations }.
  let totalRedactions = 0;
  const tally = (s: string): string => {
    const { redacted, count } = redact(s);
    totalRedactions += count;
    return redacted;
  };

  const header = composeHeader(meta);
  const tldr = composeTldr(meta, diagnoses, changelog, tally);
  const impact = composeImpact(observations, resolutionEvidence, tally);
  const timelineTable = composeTimelineTable(timeline, tally);
  const { markdown: rootCause, shallowWarning } = composeRootCause(meta, diagnoses, changelog, tally);
  const contribFactors = composeContributingFactors(runbookExec, observations, tally);
  const wentWell = composeWentWell(runbookExec, resolutionEvidence, tally);
  const wentWrong = composeWentWrong(runbookExec, actions, meta, tally);
  const actionItems = composeActionItems(runbookExec, actions);

  // 6. Assemble.
  const parts = [
    header,
    "",
    "## TL;DR", "", tldr,
    "", "## Impact", "", impact,
    "", "## Timeline", "", timelineTable,
    "", "## Root Cause (5-Whys)", "", rootCause,
    "", "## Contributing Factors", "", contribFactors,
    "", "## What Went Well", "", wentWell,
    "", "## What Went Wrong", "", wentWrong,
    "", "## Action Items", "", actionItems,
    "",
  ];

  if (totalRedactions > 0) {
    parts.push(
      "---",
      "",
      `**Redactions:** ${totalRedactions} secret-like string(s) redacted from artifacts.`,
      ""
    );
  }
  parts.push(`*Generated by \`bober postmortem generate ${incidentId}\` (Sprint 23).*`, "");

  const content = parts.join("\n");

  // 7. Citation floor check.
  const citationCount = (content.match(/\(([a-z0-9_\-./]+(?:#L?\d+| event-id [a-z0-9-]+)?)\)/gi) ?? []).length;

  // 8. Write postmortem.md.
  const path = join(dir, "postmortem.md");
  await mkdir(dir, { recursive: true });
  await writeFile(path, content, { encoding: "utf-8", mode: 0o600 });

  return { path, content, redactionCount: totalRedactions, shallowWarning, citationCount };
}

// ── Section composers (sketch — implementer fills in detail) ──

function composeHeader(meta: IncidentMetadata): string { /* ... */ }
function composeTldr(meta, diagnoses, changelog, tally): string { /* ... */ }
// ... etc.

// ── 5-Whys heuristic (the hardest part) ──

function composeRootCause(
  meta: IncidentMetadata,
  diagnoses: DiagnosisRow[],
  changelog: ChangeRow[],
  tally: (s: string) => string,
): { markdown: string; shallowWarning: boolean } {
  const whys: string[] = [];

  // Why 1: from symptom.
  whys.push(`1. Why did ${tally(meta.symptom)} happen? *(see incident.json)*`);

  // Why 2: from highest-confidence hypothesis in most-recent diagnosis.
  if (diagnoses.length > 0) {
    const d = diagnoses[0]; // already sorted by mtime desc
    const order = { high: 3, medium: 2, low: 1 } as const;
    const top = [...d.hypotheses].sort((a, b) =>
      (order[b.confidence] - order[a.confidence]) ||
      (b.supportingEvidence.length - a.supportingEvidence.length)
    )[0];
    if (top) {
      whys.push(`2. Because ${tally(top.statement)}. (diagnoses/${d.diagnosisId}.json#${top.id})`);

      // Why 3: strongest supporting evidence on that hypothesis.
      if (top.supportingEvidence.length > 0) {
        const ev = top.supportingEvidence[0];
        whys.push(`3. Because ${tally(ev.snippet)}. (${ev.path})`);
      }
    }
  }

  // Why 4 + 5: changes within 30 min before incident.createdAt, sorted by executedAt desc.
  const created = Date.parse(meta.createdAt);
  const preChanges = changelog
    .filter((c) => {
      const t = Date.parse(c.executedAt);
      return Number.isFinite(t) && created - t > 0 && created - t < 30 * 60 * 1000;
    })
    .sort((a, b) => (a.executedAt < b.executedAt ? 1 : -1));
  if (preChanges[0] && whys.length >= 3) {
    const minutes = Math.round((created - Date.parse(preChanges[0].executedAt)) / 60000);
    whys.push(`4. Because ${tally(preChanges[0].description)} shipped ${minutes}m before symptom onset. (changelog.jsonl#L${preChanges[0]._lineNo ?? "?"})`);
  }
  if (preChanges[1] && whys.length >= 4) {
    const minutes = Math.round((created - Date.parse(preChanges[1].executedAt)) / 60000);
    whys.push(`5. Because ${tally(preChanges[1].description)} (preceding change ${minutes}m before symptom onset). (changelog.jsonl#L${preChanges[1]._lineNo ?? "?"})`);
  }

  const shallowWarning = whys.length < 3;
  let markdown = whys.join("\n");
  if (shallowWarning) {
    markdown +=
      "\n\n**Warning:** 5-Whys synthesis was shallow due to missing evidence (fewer than 3 levels derivable). " +
      "Human review required to deepen this chain.";
  }
  return { markdown, shallowWarning };
}
```

**Note for implementer:** carry `_lineNo` through the JSONL reader (1-based) so citations can include `#L<n>`. Implement as a one-line `readJsonlWithLineNo()` helper.

**Imports this file uses:**
- `readFile, writeFile, readdir, mkdir, stat` from `node:fs/promises`
- `join` from `node:path`
- `IncidentMetadataSchema, type IncidentMetadata, type IncidentId` from `./types.js`

**Imported by (after this sprint):** `src/incident/timeline.ts` (for auto-trigger), `src/cli/commands/postmortem.ts`, `tests/incident/postmortem.test.ts`.

---

### `src/incident/timeline.ts` (modify — wire auto-postmortem)

**Relevant section (lines 399-475 — `setIncidentStatus` function). The auto-postmortem trigger lives AFTER `atomicWriteJson` (line 470) and the `appendTimeline` call (line 473), BEFORE the function returns.**

**Modified setIncidentStatus signature — add `config?` to the existing opts:**

```typescript
// New opts shape (extends SetStatusOpts):
export interface SetStatusOpts {
  verifyResult?: VerifyResult;
  overrideToken?: string;
  /** When true (and status === 'resolved'), trigger async postmortem generation
   *  after the status write. Default determined by config.incident?.autoPostmortem
   *  at the call site; this field allows per-call override (e.g., tests set false
   *  to avoid filesystem churn). */
  autoPostmortem?: boolean;
}
```

**Add at the end of setIncidentStatus, after `appendTimeline(...)` on line 473:**

```typescript
  // ── Sprint 23: async postmortem trigger (fire-and-forget) ──
  // Default ON when status='resolved' — explicit autoPostmortem=false disables.
  // Do NOT await: status transition returns immediately. Postmortem completion
  // updates incident.json.postmortemPath in a follow-up atomic write.
  if (status === "resolved" && opts?.autoPostmortem !== false) {
    // Dynamic import to avoid a load-order cycle (postmortem.ts has no deps
    // on timeline.ts, but keep the boundary clean).
    void (async () => {
      try {
        const { generatePostmortem } = await import("./postmortem.js");
        const result = await generatePostmortem(projectRoot, incidentId);
        // After synthesis: update incident.json.postmortemPath in a NEW
        // atomic write. Re-read fresh to avoid stomping concurrent changes.
        const freshRaw = await readFile(metaPath, "utf-8");
        const fresh = IncidentMetadataSchema.parse(JSON.parse(freshRaw));
        await atomicWriteJson(metaPath, { ...fresh, postmortemPath: result.path });
      } catch (err) {
        logger.warn(
          `[setIncidentStatus] Auto-postmortem failed for ${incidentId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    })();
  }
}
```

**The trigger pattern** (CRITICAL — read carefully):

- `void (async () => { ... })()` — IIFE returning a floated promise. Equivalent to "fire-and-forget" used in `src/graph/hook-handler.ts:83-90` (`this.incidents.append(...).catch(...)`).
- NO `await` — the outer `setIncidentStatus` returns BEFORE this completes.
- Errors are swallowed by `logger.warn` — postmortem failure is non-fatal.
- Tests need a way to await completion → expose `__postmortemTrigger` or accept a `Promise<void>` via opts. **Recommended for testability:**

```typescript
// Test-only seam — orchestrator does not use this.
export interface SetStatusOpts {
  // ... existing fields ...
  autoPostmortem?: boolean;
  /** Test seam: if provided, the function calls back with the promise that
   *  resolves when postmortem synthesis completes. Production callers leave
   *  this undefined and rely on fire-and-forget behavior. */
  onPostmortemPromise?: (p: Promise<void>) => void;
}
```

Then in the IIFE:
```typescript
const p = (async () => { /* the IIFE body above */ })();
if (opts?.onPostmortemPromise) opts.onPostmortemPromise(p);
void p;
```

This lets tests `await` the promise and assert ordering: status was written FIRST, then postmortem appeared.

**Config integration:** the CLI (and any orchestrator caller) reads `config.incident?.autoPostmortem` and passes it through:

```typescript
await setIncidentStatus(projectRoot, incidentId, "resolved", undefined, {
  verifyResult: vr,
  autoPostmortem: config.incident?.autoPostmortem !== false, // default true
});
```

**Imports this file uses (add `logger` is already imported on line 48; nothing new needed at the top).** The dynamic `import("./postmortem.js")` lives inside the IIFE.

**Imported by:** `src/cli/commands/rollback.ts`, `tests/incident/*.test.ts`, `tests/incident/resolution-verify.test.ts`, any future deployer/diagnoser wiring. Adding the fire-and-forget block is backward-compatible — existing callers without `opts.autoPostmortem` get the default behavior.

**Test file:** `tests/incident/timeline.test.ts` exists (will need new "auto-postmortem trigger on resolved" tests added — co-locate in the new `postmortem.test.ts` to keep concerns separate).

---

### `src/cli/commands/postmortem.ts` (create)

**Directory pattern:** `src/cli/commands/<verb>.ts` with `registerXxxCommand(program: Command): void`. Existing files: `rollback.ts`, `audit-show.ts`, `approve.ts`, etc.

**Most similar existing file:** `src/cli/commands/audit-show.ts` (108 lines) — it's the nested-subcommand precedent: `audit show <runId>` and `audit` is the parent. Postmortem uses the same idiom: `postmortem generate <id>` and `postmortem show <id>`.

**Structure template:**

```typescript
/**
 * `bober postmortem generate <incidentId>` — synthesize (or re-synthesize)
 *   the postmortem.md for an incident, even after auto-generation.
 * `bober postmortem show <incidentId>` — print the postmortem.md to stdout.
 *
 * Nested subcommand pattern mirrors src/cli/commands/audit-show.ts.
 *
 * Sprint 23 — src/cli/commands/postmortem.ts
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { generatePostmortem } from "../../incident/postmortem.js";

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

export function registerPostmortemCommand(program: Command): void {
  const pmCmd = program
    .command("postmortem")
    .description("Inspect or (re)generate incident postmortems");

  // ── postmortem generate <incidentId> ──
  pmCmd
    .command("generate <incidentId>")
    .description("(Re)synthesize postmortem.md for an incident from its artifacts")
    .action(async (incidentId: string) => {
      const projectRoot = await resolveRoot();
      try {
        const result = await generatePostmortem(projectRoot, incidentId);
        process.stdout.write(
          chalk.green(`Postmortem written: ${result.path}\n`) +
          chalk.gray(`  citations: ${result.citationCount}, redactions: ${result.redactionCount}` +
            (result.shallowWarning ? ", 5-Whys: SHALLOW (review required)" : "") + "\n"),
        );
      } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") {
          process.stderr.write(chalk.yellow(`No incident found at .bober/incidents/${incidentId}/.\n`));
          process.exitCode = 1;
          return;
        }
        process.stderr.write(
          chalk.red(`Failed to generate postmortem: ${err instanceof Error ? err.message : String(err)}\n`),
        );
        process.exitCode = 1;
      }
    });

  // ── postmortem show <incidentId> ──
  pmCmd
    .command("show <incidentId>")
    .description("Print the postmortem.md for an incident to stdout")
    .action(async (incidentId: string) => {
      const projectRoot = await resolveRoot();
      const path = join(projectRoot, ".bober", "incidents", incidentId, "postmortem.md");
      try {
        const content = await readFile(path, "utf-8");
        process.stdout.write(content);
      } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") {
          process.stderr.write(
            chalk.yellow(`No postmortem found at ${path}. Generate it first with: bober postmortem generate ${incidentId}\n`),
          );
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });
}
```

---

### `src/cli/index.ts` (modify — register postmortem command)

**Relevant section (lines 28 and 256-258 — registration pattern). Add the import line at line ~29 and the registration call at the bottom of `main()` before parseAsync (around line 259).**

**Add (after line 28):**
```typescript
import { registerPostmortemCommand } from "./commands/postmortem.js";
```

**Add (after line 258, before parseAsync line 260):**
```typescript
  // ── postmortem ───────────────────────────────────────────────────
  registerPostmortemCommand(program);
```

**Imported by:** `package.json` bin entry. Adding a new command is non-breaking.

---

### `tests/incident/postmortem.test.ts` (create)

**Directory pattern:** `tests/incident/*.test.ts` — vitest, mkdtemp per test, fixtures built inline.

**Most similar existing file:** `tests/incident/resolution-verify.test.ts` (mkdtemp fixture, helper factories, describe-it nested blocks). Mirror the structure.

**Test fixture incident structure (paste-ready):**

```typescript
async function makeFixtureIncident(tmpDir: string): Promise<string> {
  // Create the incident with the standard helper (creates all empty files).
  const incidentId = await createIncident("500 errors on /api/checkout", tmpDir);
  const dir = join(tmpDir, ".bober", "incidents", incidentId);

  // Seed timeline with 5+ events.
  await appendTimeline(tmpDir, incidentId, {
    timestamp: "2026-05-24T14:00:00Z",
    eventKind: "alert_fired",
    source: "observability",
    summary: "Datadog alert: api.checkout.error_rate > 5%",
  });
  // ... append 4 more events spanning 14:00 → 14:38

  // Seed observations (verified=true for Impact).
  await appendObservation(tmpDir, incidentId, {
    timestamp: "2026-05-24T14:06:00Z", phase: 1,
    observation: "Confirmed current via fresh metric query — error rate 11.8% at 14:06",
    source: "obs__datadog__query_metric", verified: true,
  });

  // Seed changelog (with required inverse).
  await appendChange(tmpDir, incidentId, {
    id: "chg-1", type: "k8s_scale",
    executedAt: "2026-05-24T14:25:00Z",
    description: "scale db replicas 3 -> 6",
    inverse: { description: "scale db replicas 6 -> 3", command: "kubectl scale --replicas=3" },
    status: "executed",
  });

  // Seed runbook execution.
  await appendRunbookExecution(tmpDir, incidentId, {
    timestamp: "2026-05-24T14:20:00Z",
    runbookName: "scale-db-tier", stepNumber: 1,
    status: "success", preconditionResult: "pass", postconditionResult: "pass",
  });

  // Seed actions.jsonl.
  await appendAction(tmpDir, incidentId, {
    timestamp: "2026-05-24T14:22:00Z",
    action: "Run: kubectl scale deployment db-pool --replicas=6",
    blastRadius: "risky", requiresApproval: true,
  });

  // Seed diagnoses/ — write a DiagnosisResult JSON directly.
  const diagnosisId = `diagnosis-${incidentId}-2026-05-24T14:12:00Z`;
  await mkdir(join(dir, "diagnoses"), { recursive: true });
  await writeFile(join(dir, "diagnoses", `${diagnosisId}.json`), JSON.stringify({
    diagnosisId, incidentId,
    timestamp: "2026-05-24T14:12:00Z",
    summary: "Leading hypothesis: db connection pool exhaustion under new checkout flow",
    hypotheses: [
      {
        id: "h1",
        statement: "Database connection pool is exhausted, causing checkout queries to timeout",
        confidence: "high",
        supportingEvidence: [
          { source: "infra-metrics", path: "obs__datadog__query_metric#pool_saturation",
            snippet: "Connection pool saturation 98% sustained from 14:01" },
          { source: "app-logs", path: "obs__loki__query_logs",
            snippet: "Timeout: connection acquisition failed after 30s (200+ occurrences)" },
        ],
        contradictingEvidence: [],
      },
    ],
    nextActions: [],
  }, null, 2));

  // Seed hypotheses.md.
  await writeFile(join(dir, "hypotheses.md"),
    "Disproved: Network partition (no evidence of inter-region latency)\n" +
    "Open: Why did the connection pool grow? Migration 042?\n");

  // Seed resolution-evidence/.
  const evDir = join(dir, "resolution-evidence");
  await mkdir(evDir, { recursive: true });
  await writeFile(join(evDir, "2026-05-24T14-38-00-000Z.json"), JSON.stringify({
    incidentId, verifiedAt: "2026-05-24T14:38:00Z",
    criteria: { metricName: "api.checkout.error_rate", threshold: 0.001, comparison: "lt",
                 windowMinutes: 10, provider: "datadog", baselineComparison: "absolute" },
    samples: [{ timestamp: "2026-05-24T14:38:00Z", value: 0.0008 }],
    allSamplesPassed: true,
  }, null, 2));

  // Mark resolved (need a fake VerifyResult).
  await setIncidentStatus(tmpDir, incidentId, "resolved", undefined, {
    verifyResult: {
      verified: true, observedValue: 0.0008, sampledAt: "2026-05-24T14:38:00Z",
      evidencePath: join(evDir, "2026-05-24T14-38-00-000Z.json"), reason: "OK",
    },
    autoPostmortem: false,  // suppress auto-gen so tests can call generatePostmortem directly
  });

  return incidentId;
}
```

**Tests (sketch — each is one `it()` block):**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePostmortem } from "../../src/incident/postmortem.js";
import {
  createIncident, appendTimeline, appendObservation, appendAction,
  appendChange, appendRunbookExecution, setIncidentStatus,
} from "../../src/incident/timeline.js";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-postmortem-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

describe("generatePostmortem — happy path", () => {
  it("produces a postmortem.md with all required sections", async () => {
    const id = await makeFixtureIncident(tmpDir);
    const r = await generatePostmortem(tmpDir, id);
    expect(r.path).toMatch(/postmortem\.md$/);
    const content = await readFile(r.path, "utf-8");
    for (const section of ["# Postmortem:", "## TL;DR", "## Impact", "## Timeline",
                            "## Root Cause", "## Contributing Factors",
                            "## What Went Well", "## What Went Wrong", "## Action Items"]) {
      expect(content).toContain(section);
    }
  });

  it("produces more than 5 inline citations", async () => {
    const id = await makeFixtureIncident(tmpDir);
    const r = await generatePostmortem(tmpDir, id);
    expect(r.citationCount).toBeGreaterThan(5);
    // Spot-check artifact citation markers.
    expect(r.content).toMatch(/\(timeline\.jsonl#L\d+\)/);
    expect(r.content).toMatch(/\(diagnoses\/diagnosis-/);
  });
});

describe("generatePostmortem — 5-Whys depth", () => {
  it("renders 3+ Why levels when diagnosis + supporting evidence + pre-incident changes exist", async () => {
    const id = await makeFixtureIncident(tmpDir);
    const r = await generatePostmortem(tmpDir, id);
    expect(r.shallowWarning).toBe(false);
    expect(r.content).toMatch(/^1\. Why did/m);
    expect(r.content).toMatch(/^2\. Because/m);
    expect(r.content).toMatch(/^3\. Because/m);
  });

  it("emits shallow warning when no diagnoses exist", async () => {
    // Fixture WITHOUT diagnoses/.
    const id = await createIncident("shallow case", tmpDir);
    await setIncidentStatus(tmpDir, id, "resolved", undefined, {
      verifyResult: { verified: true, reason: "OK" },
      autoPostmortem: false,
    });
    const r = await generatePostmortem(tmpDir, id);
    expect(r.shallowWarning).toBe(true);
    expect(r.content).toContain("5-Whys synthesis was shallow");
  });
});

describe("generatePostmortem — redaction", () => {
  it("redacts AKIA-style AWS keys from observation snippets", async () => {
    const id = await makeFixtureIncident(tmpDir);
    // Inject a fake secret into observations.jsonl.
    await appendObservation(tmpDir, id, {
      timestamp: "2026-05-24T14:07:00Z", phase: 1,
      observation: "Found leaked credential in logs: AKIAIOSFODNN7EXAMPLE",
      source: "secrets-scanner", verified: true,
    });
    // Re-resolve (autoPostmortem already false from fixture).
    const r = await generatePostmortem(tmpDir, id);
    expect(r.content).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(r.content).toContain("[REDACTED]");
    expect(r.redactionCount).toBeGreaterThan(0);
    expect(r.content).toMatch(/\*\*Redactions:\*\*\s+\d+\s+secret-like/);
  });
});

describe("setIncidentStatus — async postmortem trigger", () => {
  it("auto-generates postmortem AFTER status transition (does not block)", async () => {
    // Build fixture but DO NOT mark resolved yet.
    const id = await createIncident("auto-trigger test", tmpDir);
    // ... seed minimal artifacts ...
    let pmPromise: Promise<void> | undefined;
    const start = Date.now();
    await setIncidentStatus(tmpDir, id, "resolved", undefined, {
      verifyResult: { verified: true, reason: "OK" },
      autoPostmortem: true,
      onPostmortemPromise: (p) => { pmPromise = p; },
    });
    const elapsed = Date.now() - start;
    // The status transition itself was fast — postmortem still pending.
    expect(elapsed).toBeLessThan(500);
    expect(pmPromise).toBeDefined();
    // Now await the promise and assert the file exists + incident.json was updated.
    await pmPromise;
    const meta = JSON.parse(await readFile(join(tmpDir, ".bober", "incidents", id, "incident.json"), "utf-8"));
    expect(meta.status).toBe("resolved");
    expect(meta.postmortemPath).toMatch(/postmortem\.md$/);
    await stat(meta.postmortemPath); // file exists
  });

  it("autoPostmortem=false suppresses automatic generation", async () => {
    const id = await createIncident("no-auto", tmpDir);
    let triggered = false;
    await setIncidentStatus(tmpDir, id, "resolved", undefined, {
      verifyResult: { verified: true, reason: "OK" },
      autoPostmortem: false,
      onPostmortemPromise: () => { triggered = true; },
    });
    expect(triggered).toBe(false);
    await expect(stat(join(tmpDir, ".bober", "incidents", id, "postmortem.md"))).rejects.toThrow();
  });
});

describe("CLI: postmortem generate / show", () => {
  it("generate writes file and prints path", async () => {
    // Use execa or run registerPostmortemCommand against a stub Command + capture process.stdout.
    // Pattern: mirror tests/cli/commands/audit-show.test.ts (if it exists).
  });
  it("show prints file content", async () => { /* ... */ });
});
```

**Imports this file uses:** vitest, node:fs/promises, node:os, node:path, src/incident/postmortem.js, src/incident/timeline.js.

**Imported by:** none (test file).

---

## 2. Patterns to Follow

### Pattern A — Read-only subagent prompt structure (`agents/bober-diagnoser.md`)

**Source:** `agents/bober-diagnoser.md`, lines 1-43 (frontmatter + Subagent Context)

```markdown
---
name: bober-diagnoser
description: Read-only incident investigator that gathers evidence at component boundaries, ...
tools:
  - Read
  - Bash
  - Grep
  - Glob
model: sonnet
---

# Bober Diagnoser Agent

## Subagent Context

You are being **spawned as a subagent** by the Bober orchestrator. This means:

- You are running in your own **isolated context window** — you have NO access to the orchestrator's conversation history.
- Everything you need is in **your prompt**. The orchestrator has included the IncidentSpec, prior diagnoses (if any), project configuration, and principles.
- Parse the **IncidentSpec** from your prompt. Also read these files from disk: …
- IMPORTANT: You do NOT have Write, Edit, MultiEdit, or NotebookEdit tools.
- Do NOT include any text outside the JSON in your final response.
```

**Rule:** Postmortemer's frontmatter `tools:` MUST list `[Read, Bash, Grep, Glob]` — no `Write`, no `Edit`, no MCP entries. The `Subagent Context` section MUST enumerate every artifact file the agent reads.

### Pattern B — Iron Law block (`agents/bober-diagnoser.md`)

**Source:** lines 49-59

```markdown
**IRON LAW:**

```
NO HYPOTHESIS WITHOUT EVIDENCE FROM TWO INDEPENDENT SOURCES
```

This is the bar for promoting a hypothesis to `confidence: 'medium'` or `'high'` …

<EXTREMELY-IMPORTANT>
If the only available evidence is from a single component …
</EXTREMELY-IMPORTANT>
```

**Rule:** Iron Law is a fenced code block with the literal rule in ALL CAPS, followed by a one-paragraph explanation. The `<EXTREMELY-IMPORTANT>` XML-like tag underneath emphasizes the operational consequence. Postmortemer's Iron Law: `NO POSTMORTEM SECTION WITHOUT EVIDENCE FROM INCIDENT ARTIFACTS`.

### Pattern C — Red Flags + Rationalization Prevention (`agents/bober-diagnoser.md`)

**Source:** lines 241-263

```markdown
## Red Flags - STOP

- About to promote a hypothesis to `'medium'` or `'high'` confidence with evidence from only one component — this violates the Iron Law
- About to skip the `contradictingEvidence` field on a hypothesis because "I couldn't find any" — the field is REQUIRED; an empty array with a note in `summary` is the correct response
…(≥5 bullets)

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "The logs are clear — one source is enough" | Iron Law: two independent sources for medium/high confidence. One source = low confidence + evidence-gathering next actions only. |
…(≥5 rows)
```

**Rule:** Red Flags is a bulleted list of "About to <X> — <consequence>" entries (minimum 5). Rationalization Prevention is a 2-column table "Excuse | Reality" (minimum 5 rows). Both sections are MANDATORY in the postmortemer agent.

### Pattern D — Nested commander subcommand (`src/cli/commands/audit-show.ts`)

**Source:** lines 45-52

```typescript
export function registerAuditCommand(program: Command): void {
  const auditCmd = program.command("audit").description("Inspect checkpoint audit logs");

  auditCmd
    .command("show <runId>")
    .description("Print the approval audit log for a run")
    .option("--json", "Emit machine-readable JSON instead of a table")
    .action(async (runId: string, opts: { json?: boolean }) => {
      // ...
    });
}
```

**Rule:** Create the parent command via `program.command("<name>").description(...)`, capture the returned `Command` instance, then chain `.command("<sub> <arg>")` on the parent. For `postmortem`, both `generate <id>` and `show <id>` are chained off the same `pmCmd` parent.

### Pattern E — Atomic JSON write + temp+rename (`src/incident/timeline.ts`)

**Source:** lines 84-91

```typescript
async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  await rename(tmp, filePath);
}
```

**Rule:** All updates to `incident.json` (including the new postmortemPath update) MUST go through `atomicWriteJson` to avoid torn writes if the process crashes mid-update. The postmortem.md file itself is OK with plain `writeFile` (it's an append-only artifact, not concurrent).

### Pattern F — Fire-and-forget async with logger.warn (`src/graph/hook-handler.ts`)

**Source:** lines 65-105

```typescript
/**
 * Synchronous fire-and-forget entry point.
 * Adds paths to queue; resets debounce timer; on cap-overflow drops oldest.
 * Returns immediately — NO awaits.
 */
onPostToolUse(payload: { paths: string[] }): void {
  // ...
  this.incidents
    .append({ /* ... */ })
    .catch(() => {});  // swallow errors — fire-and-forget
}
```

**Rule:** For background work that must not block the caller, use `void (async () => { ... })()` or `.catch(logger.warn)`. Never `await` from a hot path. The pattern in `src/mcp/run-manager.ts:4` also documents this: "bober_run starts a fire-and-forget pipeline."

### Pattern G — Optional config section (`src/config/schema.ts`)

**Source:** lines 263-266 + 282

```typescript
export const ObservabilitySectionSchema = z.object({
  providers: z.array(ObservabilityProviderSchema).default([]),
});
export type ObservabilitySection = z.infer<typeof ObservabilitySectionSchema>;

// ... in BoberConfigSchema:
observability: ObservabilitySectionSchema.optional(),
```

**Rule:** New config sections follow this pattern — define the schema, export the inferred type, add as `.optional()` in `BoberConfigSchema`. The CALLER reads with `config.incident?.autoPostmortem !== false` (default true).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `createIncident` | `src/incident/timeline.ts:150` | `(symptom: string, projectRoot: string) => Promise<IncidentId>` | Build the standard incident artifact tree — use in test fixtures, NEVER re-implement. |
| `appendTimeline` | `src/incident/timeline.ts:212` | `(projectRoot, incidentId, event: TimelineEvent) => Promise<void>` | Append to timeline.jsonl. |
| `appendObservation` | `src/incident/timeline.ts:235` | `(projectRoot, incidentId, entry: ObservationEntry) => Promise<void>` | Append to observations.jsonl + timeline. |
| `appendAction` | `src/incident/timeline.ts:268` | `(projectRoot, incidentId, entry: ActionEntry) => Promise<void>` | Append to actions.jsonl + timeline. |
| `appendChange` | `src/incident/timeline.ts:308` | `(projectRoot, incidentId, entry: ChangeEntry) => Promise<void>` | Append to changelog.jsonl (REQUIRES `entry.inverse`). |
| `appendRunbookExecution` | `src/incident/timeline.ts:343` | `(projectRoot, incidentId, entry: RunbookExecutionEntry) => Promise<void>` | Append to runbook-execution.jsonl. |
| `setIncidentStatus` | `src/incident/timeline.ts:399` | `(projectRoot, incidentId, status, extras?, opts?: SetStatusOpts) => Promise<void>` | Atomic update of incident.json. **This is the function Sprint 23 modifies.** |
| `listIncidents` | `src/incident/timeline.ts:489` | `(projectRoot: string) => Promise<IncidentSummary[]>` | List all incidents. |
| `findProjectRoot` | `src/utils/fs.ts:58` | `(startDir?: string) => Promise<string \| null>` | Walk up looking for bober.config.json / package.json. Used in every CLI command. |
| `fileExists` | `src/utils/fs.ts:10` | `(path: string) => Promise<boolean>` | Check readable. |
| `readJson` | `src/utils/fs.ts:24` | `<T>(path: string) => Promise<T>` | Read + parse JSON. |
| `writeJson` | `src/utils/fs.ts:34` | `(path: string, data: unknown) => Promise<void>` | Pretty-printed JSON write (creates parent dirs). NOT atomic — for atomic, use `atomicWriteJson` inline pattern. |
| `ensureDir` | `src/utils/fs.ts:45` | `(path: string) => Promise<void>` | `mkdir(path, { recursive: true })` — use instead of inline mkdir. |
| `logger.warn / .info / .error` | `src/utils/logger.ts` | standard | Use for the fire-and-forget swallow-and-log pattern. |
| `IncidentMetadataSchema` | `src/incident/types.ts:145` | zod | Parse incident.json with this schema. |
| `IncidentMetadataSchema.parse(...)` | n/a | zod runtime | Validate parsed JSON before consumption. |
| Atomic write idiom | `src/incident/timeline.ts:84` (`atomicWriteJson`) | local fn | Copy this idiom verbatim into `postmortem.ts` if updating incident.json from the postmortem trigger path. |

**Critical:** Do NOT add a new "read JSONL with line numbers" utility to `src/utils/fs.ts` unless absolutely needed — keep the helper local to `src/incident/postmortem.ts` (it's the only consumer).

---

## 4. Prior Sprint Output

### Sprint 15: `agents/bober-diagnoser.md`
**Created:** the read-only subagent prompt that the postmortemer mirrors structurally.
**Connection:** Postmortemer uses the same frontmatter `tools:` list (Read/Bash/Grep/Glob), the same Subagent Context block, the same Iron Law / Red Flags / Rationalization-Prevention table format. **Key difference:** postmortemer has NO Observability MCP Tools section (postmortems are offline).

### Sprint 19: `src/incident/timeline.ts` + `src/incident/types.ts`
**Created:** the entire incident artifact tree — `createIncident`, `appendTimeline`, `appendObservation`, `appendAction`, `appendChange`, `appendRunbookExecution`, `setIncidentStatus`, `listIncidents`. Defined `IncidentMetadataSchema`, `TimelineEventSchema`, `ObservationEntrySchema`, etc.
**Connection:** Sprint 23 READS every artifact file Sprint 19 created. Sprint 23 MODIFIES `setIncidentStatus` to add the fire-and-forget postmortem trigger. The `postmortemPath` field was reserved on `IncidentMetadataSchema:153` — Sprint 23 populates it.

### Sprint 21: `src/cli/commands/rollback.ts`
**Created:** the `bober rollback <incidentId>` command — single-level subcommand registration via `registerRollbackCommand(program)`. Reads from `changelog.jsonl` (Sprint 19's artifact, every entry has the required `inverse` field).
**Connection:** Sprint 23 follows the same `registerXxxCommand(program: Command)` pattern but uses the NESTED idiom from `audit-show.ts` (two-level: `postmortem generate <id>` and `postmortem show <id>`).

### Sprint 22: `src/incident/resolution-verify.ts` + `setIncidentStatus` opts pattern
**Created:** `verifyResolution(incidentId, criteria, deps)` — a DETERMINISTIC TypeScript function (not an LLM spawn) that queries observability MCPs, writes `resolution-evidence/<ts>.json`, and returns `VerifyResult`. Defined `SetStatusOpts` with `verifyResult?` and `overrideToken?` fields. The `'resolved'` transition now requires one of these or it throws.
**Connection:** Sprint 23 EXTENDS `SetStatusOpts` with `autoPostmortem?: boolean` (and optionally `onPostmortemPromise?` for tests). Sprint 23 ALSO mirrors the "deterministic TypeScript function, not LLM spawn" approach — `generatePostmortem` is a TypeScript function exactly like `verifyResolution`. The agent prompt and skill exist as discipline docs, not as live spawn targets.

---

## 5. Relevant Documentation

### Project Principles
`.bober/principles.md` — **does not exist** at this path in the working tree. Checked: `find /Users/bober4ik/agent-bober/.bober -name 'principles*'` returned nothing. The diagnoser agent's `Subagent Context` references it as a file the diagnoser may read; the postmortemer agent should mention it the same way ("read `.bober/principles.md` if present"). Do NOT fabricate principles.

### Architecture Decisions
`.bober/architecture/` — directory does not exist either. Sprint 23 introduces no new architectural concerns that require an ADR; the postmortem synthesizer is a leaf feature.

### Other Docs
- `skills/bober.diagnose/SKILL.md` (254 lines) — the discipline doc the postmortem skill mirrors structurally. Phase 4 of bober.diagnose produces `resolution-evidence/*.json`; the postmortemer cites these for Impact and What-Went-Well.
- `skills/bober.deploy/SKILL.md` (262 lines) — references `bober.postmortem` in its "Do NOT use this skill for" block (line 35: "Postmortem writing (see `bober.postmortem`)"). The forward reference is satisfied by this sprint.
- `skills/bober.runbook/SKILL.md` — every `runbook-execution.jsonl` entry the postmortemer reads was written under this skill's discipline.
- No `CLAUDE.md` or `CONTRIBUTING.md` in the repo root governs the postmortem feature.

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `tests/incident/resolution-verify.test.ts:1-150` and `tests/incident/timeline.test.ts:1-120`

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePostmortem } from "../../src/incident/postmortem.js";
import { createIncident } from "../../src/incident/timeline.js";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-postmortem-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

describe("generatePostmortem — happy path", () => {
  it("writes postmortem.md with all template sections", async () => {
    const id = await createIncident("checkout 500s", tmpDir);
    // ... seed artifacts ...
    const r = await generatePostmortem(tmpDir, id);
    expect(r.path).toMatch(/postmortem\.md$/);
    // ... assertions on r.content ...
  });
});
```

**Runner:** vitest
**Assertion style:** `expect(...).toBe(...)`, `expect(...).toMatch(/regex/)`, `expect(...).toContain(...)`, `expect(...).toBeGreaterThan(...)`, `await expect(promise).rejects.toThrow()`
**Mock approach:** Dependency injection via `deps:` argument (see `resolution-verify.ts:88` for `VerifyResolutionDeps` with `client?:` seam). Sprint 23 does NOT need mocks because it reads files from a `mkdtemp` dir — no external systems.
**File naming:** `<module>.test.ts` co-located under `tests/<concern>/` (project uses non-colocated tests).
**Location:** `tests/incident/postmortem.test.ts` (per contract `expectedChanges`).

### E2E Test Pattern
Not applicable — Sprint 23 has no Playwright tests. CLI tests can be added as smoke tests via process.argv stubbing (see if `tests/cli/` has an existing CLI pattern; otherwise keep tests purely at the `generatePostmortem` level + assert CLI registration via a snapshot test).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break

| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `tests/incident/timeline.test.ts` | `src/incident/timeline.ts` (`setIncidentStatus`) | medium | Adding `opts.autoPostmortem` and `opts.onPostmortemPromise` to `SetStatusOpts` is backward-compatible (both optional). Verify existing tests that call `setIncidentStatus(..., 'resolved', ...)` still pass — they may now trigger fire-and-forget postmortem generation that writes files in the temp dir. If a test resolves an incident WITHOUT calling `autoPostmortem: false`, the fire-and-forget IIFE may race against `afterEach` cleanup. **Mitigation:** existing resolve-status tests should pass `autoPostmortem: false` (or the fire-and-forget should be safe under rm-recursive). |
| `tests/incident/resolution-verify.test.ts` | `src/incident/timeline.ts` (`setIncidentStatus`) | medium | Several tests call `setIncidentStatus(..., 'resolved', ..., { verifyResult: ... })`. After Sprint 23, these will (silently) trigger postmortem generation. Verify tests still pass and the temp dir cleanup handles the late-arriving postmortem.md. |
| `src/incident/resolution-verify.ts` | `src/incident/types.ts` | low | Adds an optional schema field; no breaking imports. |
| `src/cli/index.ts` | new `postmortem.ts` import | low | One added import + one added register call. |

### Existing Tests That Must Still Pass

- `tests/incident/timeline.test.ts` — covers `setIncidentStatus` resolution gate (Sprint 22 behavior). Sprint 23 adds a new code path AFTER the gate; the gate's reject behavior is unchanged.
- `tests/incident/resolution-verify.test.ts` — covers `verifyResolution`. Sprint 23 does not touch this file. Verify the tests' temp-dir cleanup still works when an asynchronous postmortem write happens.
- `tests/incident/rollback.test.ts` — covers `planRollback` / `executeRollback`. Sprint 23 does not touch these. No expected regression.
- Any CLI tests under `tests/cli/commands/` — adding the new `registerPostmortemCommand` does not affect existing commands.
- Typecheck: adding fields to `SetStatusOpts` is backward-compatible.

### Features That Could Be Affected

- **Sprint 22 resolution gate** — shares `setIncidentStatus`. Verify: resolving an incident still throws if no verifyResult AND no overrideToken (the gate from line 453-459 must remain). Postmortem trigger lives AFTER the gate.
- **Sprint 21 rollback** — shares `changelog.jsonl`. The postmortemer READS this file but does not modify it. No effect on rollback behavior.
- **Sprint 19 incident artifact creation** — `createIncident` is used by test fixtures; no changes to its semantics.

### Recommended Regression Checks

After implementation, the Generator MUST verify:

1. `npm run typecheck` — exit 0, no new type errors.
2. `npm run lint` — exit 0, no new lint errors.
3. `npm run build` — exit 0.
4. `npm test -- tests/incident/` — all existing incident tests pass + new postmortem tests pass.
5. `npm test -- tests/incident/timeline.test.ts` specifically — verify Sprint 22 resolution gate still throws on missing verifyResult/overrideToken.
6. `node dist/cli/index.js postmortem --help` — verify the nested subcommand registered (`generate` and `show` listed).
7. Manual smoke: create a fixture incident, mark resolved, assert postmortem.md appears within ~1s.

---

## 8. Implementation Sequence

Build in this order — each step's verification gates the next.

1. **`src/config/schema.ts`** — add `IncidentSectionSchema` and add the optional `incident` field to `BoberConfigSchema`.
   - Verify: `npm run typecheck` passes.

2. **`src/incident/types.ts`** — optionally add `PostmortemResultSchema` (or keep the interface inline in `postmortem.ts` — implementer's choice). `postmortemPath` already exists on line 153.
   - Verify: `npm run typecheck` passes.

3. **`src/incident/postmortem.ts`** — implement the synthesizer. Start with the readers (incident.json, JSONL helpers, diagnoses/, resolution-evidence/). Then the section composers. Then 5-Whys. Then redaction. Then the assembler.
   - Verify: write a one-off harness or jump to step 8 to run the test file.

4. **`src/incident/timeline.ts`** — add `autoPostmortem?: boolean` and `onPostmortemPromise?: (p: Promise<void>) => void` to `SetStatusOpts`. Inside `setIncidentStatus`, after `appendTimeline(...)`, add the fire-and-forget IIFE.
   - Verify: `npm run typecheck` passes. Existing timeline tests still pass.

5. **`agents/bober-postmortemer.md`** — write the full agent prompt (~260-280 lines) following the diagnoser structural template.
   - Verify: grep for `tools:`, confirm `[Read, Bash, Grep, Glob]` only — NO `obs__*`, no `Write`. Grep for the Iron Law literal text. Grep for ≥5 Red Flag bullets and ≥5 Rationalization rows.

6. **`skills/bober.postmortem/SKILL.md`** — write the skill (~220-260 lines) with embedded postmortem template, 5-Whys heuristic pseudocode, citation format table, redaction regex block.
   - Verify: contains all section headings; postmortem template includes all 9 required sections.

7. **`src/cli/commands/postmortem.ts`** — implement `registerPostmortemCommand(program)` with `generate` and `show` nested under `postmortem`.
   - Verify: `npm run build` succeeds. Manual: `node dist/cli/index.js postmortem --help`.

8. **`src/cli/index.ts`** — add the import and the `registerPostmortemCommand(program)` call.
   - Verify: `bober postmortem` appears in `bober --help`.

9. **`tests/incident/postmortem.test.ts`** — write the tests (happy-path, 5-Whys depth, shallow warning, redaction, auto-trigger async, autoPostmortem=false suppression, CLI smoke).
   - Verify: `npm test -- tests/incident/postmortem.test.ts` exits 0.

10. **Run full verification** — `npm run typecheck && npm run lint && npm run build && npm test`. All must exit 0.

---

## 9. Pitfalls & Warnings

- **Do NOT spawn an LLM subagent from `generatePostmortem`.** The orchestrator's contract evaluator notes call out evidence-traceability — postmortems must be reproducible from disk artifacts. Mirror Sprint 22's deterministic `verifyResolution` approach. The agent prompt and skill exist as discipline docs that describe what a human or future LLM author would do — not as live spawn targets.

- **Do NOT make the fire-and-forget IIFE `async` at the top level of `setIncidentStatus`.** The whole point is that the status transition returns BEFORE postmortem generation completes. Wrap the inner work in `void (async () => { ... })()` or use `.catch(logger.warn)` on a returned promise.

- **Do NOT add new public utilities to `src/utils/`.** The "read JSONL with line numbers" helper belongs INSIDE `src/incident/postmortem.ts` — it has one caller. Adding to `src/utils/fs.ts` widens the API surface unnecessarily.

- **Do NOT forget to redact BEFORE composing the markdown.** If you compose first and redact second, you might miss secrets that span multiple artifact reads. Redact every artifact snippet at extraction time via the `tally(s)` wrapper.

- **Citation format consistency.** Use parentheses `( ... )` not square brackets `[ ... ]`. The test grep for citations uses the regex `/\(([a-z0-9_\-./]+(?:#L?\d+| event-id [a-z0-9-]+)?)\)/gi` — square brackets won't match.

- **Async ordering in tests.** When testing the auto-postmortem trigger, the test MUST await the `onPostmortemPromise`-exposed promise BEFORE asserting that `incident.json.postmortemPath` is populated. Without this, you're racing the fire-and-forget IIFE.

- **`appendChange` requires `inverse`.** Test fixtures that build a changelog.jsonl MUST supply the `inverse` field on every entry, or `ChangeEntrySchema.parse(entry)` (line 314 of timeline.ts) throws ZodError before any file is touched.

- **`setIncidentStatus(..., 'resolved')` throws without verifyResult/overrideToken** (Sprint 22 gate, lines 453-459 of timeline.ts). Test fixtures that mark an incident resolved MUST supply `opts.verifyResult` or `opts.overrideToken`.

- **The `postmortemPath` field is already on `IncidentMetadataSchema:153` (Sprint 19 reserved it).** Don't add it again; just populate it.

- **`config.incident?.autoPostmortem` is OPTIONAL — default is true.** The read pattern is `config.incident?.autoPostmortem !== false`. Equivalently: only the explicit literal `false` disables auto-gen.

- **Dynamic import inside the fire-and-forget IIFE avoids a load-order cycle** between `timeline.ts` and `postmortem.ts`. Even though there is no actual cycle today (postmortem.ts only imports from types.ts), the dynamic import keeps the boundary clean and avoids a static import that would couple the two modules at module-load time.

- **Citation floor is 5.** Below that, the test `expect(r.citationCount).toBeGreaterThan(5)` fails. Make sure the fixture incident has enough artifacts to comfortably exceed the floor — Timeline alone with 5 events yields 5 citations.

- **5-Whys shallow warning** emits when the heuristic produces FEWER than 3 deterministic levels. The fixture with `diagnoses + supportingEvidence + pre-incident changes` should produce ≥3 levels. The "no diagnoses" fixture should produce 1 level → warning.

- **Do NOT call `setIncidentStatus(..., 'resolved', ..., { autoPostmortem: true })` from inside the postmortem trigger** — that would recurse. The trigger fires after `atomicWriteJson(metaPath, updated)`, and the subsequent `atomicWriteJson(metaPath, { ...fresh, postmortemPath: ... })` writes the path directly without going through `setIncidentStatus`. Status stays at 'resolved', no re-trigger.

- **Test cleanup race.** `afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); })` can race against a still-running fire-and-forget postmortem write. **Mitigation:** every test that triggers `setIncidentStatus(..., 'resolved', ...)` should EITHER (a) pass `autoPostmortem: false`, OR (b) await `onPostmortemPromise` before the `afterEach` runs. The default for the test helper `makeFixtureIncident` is `autoPostmortem: false` for exactly this reason.

