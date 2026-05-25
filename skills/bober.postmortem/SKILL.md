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

**Incident ID:** <incidentId> (incident.json)
**Status:** Resolved
**Severity:** <S1|S2|S3|S4>  *(derive from observation count + impact magnitude; default S3 if undeterminable)*
**Date:** <incident.createdAt> → <incident.resolvedAt> (incident.json)
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

1. Why did <symptom> happen? (incident.json)
2. Because <topHypothesis.statement>. (diagnoses/<diagnosisId>.json#<hyp-id>)
3. Because <strongestEvidence.snippet>. (<evidence.path>)
4. Because <preIncidentChange.description> shipped <m>m prior. (changelog.jsonl#L<n>)
5. Because <olderPreIncidentChange.description>. (changelog.jsonl#L<n>)

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
*<Redactions footer if applicable: "**Redactions:** N secret-like strings redacted from artifacts.">*
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
- **`agents/bober-postmortemer.md`** — the (offline, read-only) agent prompt companion to this skill. The TypeScript implementation in `src/incident/postmortem.ts` synthesizes deterministically; the agent prompt documents the discipline that any human or future LLM author must follow.
