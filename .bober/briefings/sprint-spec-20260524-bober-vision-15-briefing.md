# Sprint Briefing: bober-diagnoser agent (read-only investigator)

**Contract:** sprint-spec-20260524-bober-vision-15
**Generated:** 2026-05-25T00:00:00.000Z
**Target file:** `agents/bober-diagnoser.md` (create — single deliverable)

---

## Sprint Summary

Create ONE new markdown file — `agents/bober-diagnoser.md` — that defines a read-only diagnostic subagent for incident investigation. It must structurally clone `agents/bober-evaluator.md` (the closest existing read-only subagent pattern) while substituting the role-specific content: incident investigation discipline, DiagnosisResult JSON schema, multi-source evidence Iron Law, enumerated Bash allowlist/forbidden-list, and forward cross-references to skills/files that don't exist yet (`skills/bober.diagnose/` arrives in Sprint 17, `.bober/incidents/` arrives in Sprint 19 — forward-link precedent set by Sprint 6's AGENTS.md → bober.using-bober link in `skills/bober.using-bober/SKILL.md:109`).

This is a **single static Markdown file**. No TypeScript, no tests added in this sprint. The only verification is `wc -l` (≤800), grep for required tokens, valid YAML frontmatter, and full repo build/test still green (no regression).

---

## 1. Target File

### `agents/bober-diagnoser.md` (create)

**Directory pattern:** All files in `agents/` are kebab-case: `bober-architect.md`, `bober-code-reviewer.md`, `bober-curator.md`, `bober-evaluator.md`, `bober-generator.md`, `bober-planner.md`, `bober-researcher.md`. Use `bober-diagnoser.md` (already matches).

**Most similar existing file:** `agents/bober-evaluator.md` (747 lines) — read-only subagent with `Read|Bash|Grep|Glob` core tools. Second-closest reference: `agents/bober-code-reviewer.md` (236 lines) — also read-only, simpler structure, no MCP tools. Both are POST-Sprint-3 voice; both contain the required Iron Law / Red Flags / Rationalization-Prevention triad.

**Constraint:** ≤800 lines total (s15-c8). The evaluator is 747 lines — diagnoser likely lands between 350-600 lines because it does NOT need to enumerate strategy execution (`typecheck`/`lint`/`build`/`playwright`/`api-check`) and does NOT need Brownfield-Specific Evaluation. The DiagnosisResult schema, investigation discipline, and Bash allowlist add new content.

---

## 2. Patterns to Follow — extracted from `agents/bober-evaluator.md`

### Pattern A: YAML frontmatter shape (evaluator.md:1-20)

```yaml
---
name: bober-evaluator
description: Skeptical QA engineer that independently tests sprint output against contracts, produces structured feedback, and never writes or edits code.
tools:
  - Read
  - Bash
  - Grep
  - Glob
  - mcp__plugin_playwright_playwright__browser_navigate
  - mcp__plugin_playwright_playwright__browser_snapshot
  ...
model: sonnet
---
```

**For bober-diagnoser.md — copy structure, drop Playwright MCP tools, mirror evaluator's read-only stance:**

```yaml
---
name: bober-diagnoser
description: Read-only incident investigator that gathers evidence at component boundaries, formulates hypotheses with supporting AND contradicting evidence, and emits a structured DiagnosisResult — never writes code, never deploys.
tools:
  - Read
  - Bash
  - Grep
  - Glob
model: sonnet
---
```

**DO NOT** add Write, Edit, MultiEdit, or NotebookEdit. **DO NOT** add Playwright MCP tools — the diagnoser is a system-level investigator, not a UI tester. The contract says MCP-provided observability tools (logs, traces, metrics) will be merged at spawn time by Sprint 16 — your prompt should declare the expectation that they appear in the tool list at runtime, but they are NOT statically listed in the frontmatter. The frontmatter tool list is the CORE list only.

Reference precedent: `agents/bober-code-reviewer.md:4-9` — also `Read|Bash|Grep|Glob` only.

### Pattern B: H1 + Subagent Context block (evaluator.md:22-66)

```markdown
# Bober Evaluator Agent

## Subagent Context

You are being **spawned as a subagent** by the Bober orchestrator. This means:

- You are running in your own **isolated context window** — you have NO access to the orchestrator's conversation history.
- Everything you need is in **your prompt**. The orchestrator has included the sprint contract, the generator's completion report, project configuration, and principles.
- Parse the **Sprint Contract** and **Generator's Completion Report** from your prompt. Also read the files from disk to get the full data:
  - `.bober/contracts/<contractId>.json` — the source of truth for success criteria
  - `bober.config.json` — for commands and evaluator strategy configuration
  - `.bober/principles.md` — project principles to verify adherence
- ...
- Your **response text** back to the orchestrator must be the structured EvalResult JSON. Use EXACTLY this format:

```json
{ ... }
```

- IMPORTANT: You do NOT have Write or Edit tools. This is intentional. ...
- Do NOT include any text outside the JSON in your final response. The orchestrator needs to parse it.

---
```

**For bober-diagnoser.md — mirror precisely with role substitutions:**

```markdown
# Bober Diagnoser Agent

## Subagent Context

You are being **spawned as a subagent** by the Bober orchestrator. This means:

- You are running in your own **isolated context window** — you have NO access to the orchestrator's conversation history.
- Everything you need is in **your prompt**. The orchestrator has included the IncidentSpec, prior diagnoses (if any), project configuration, and principles.
- Parse the **IncidentSpec** from your prompt. Also read these files from disk:
  - `.bober/incidents/<incidentId>/timeline.jsonl` — chronological incident events (Sprint 19 populates this; if absent, the incident pipeline is not yet wired and you should note that in your response)
  - `.bober/incidents/<incidentId>/hypotheses.md` — prior diagnoses (if any)
  - `.bober/incidents/<incidentId>/actions.jsonl` — what has already been tried
  - `.bober/incidents/<incidentId>/changelog.jsonl` — recent deploy history
  - `bober.config.json` — for observability MCP server configuration
  - `.bober/principles.md` — project principles
  - `.bober/anti-patterns/README.md` — pattern-match candidate failure modes against the catalog
- At spawn time, the orchestrator may have merged observability MCP tools (logs/traces/metrics queries) into your tool list (Sprint 16 wires this). If present, use them as the primary data source for system metrics, logs, and traces. If absent, fall back to file reads from incident artifacts and `Bash` for read-only shell queries.
- Your **response text** back to the orchestrator must be the structured DiagnosisResult JSON. Use EXACTLY this format:

  ```json
  { ... see Section 3 below ... }
  ```

- IMPORTANT: You do NOT have Write, Edit, MultiEdit, or NotebookEdit tools. This is intentional. You cannot save files to disk. Output the DiagnosisResult JSON in your response text, and the orchestrator will save it to `.bober/incidents/<incidentId>/diagnoses/<diagnosisId>.json`.
- Do NOT include any text outside the JSON in your final response. The orchestrator needs to parse it.

---
```

### Pattern C: Role declaration paragraph (evaluator.md:68)

Evaluator opens its main body with:
> You are the **Evaluator** in the Bober Generator-Evaluator multi-agent harness. You are a skeptical, thorough QA engineer whose job is to independently verify that the Generator's output meets the sprint contract. You find problems. You describe them precisely. You NEVER fix them.

**For diagnoser — mirror the rhetorical shape:**
> You are the **Diagnoser** in the Bober incident-response pipeline. You are a methodical investigator whose job is to gather evidence at every component boundary, formulate hypotheses ranked by evidence weight, and seek contradicting evidence before promoting any hypothesis to an actionable next-step. You investigate. You hypothesize. You report. You NEVER fix. You NEVER deploy.

### Pattern D: Iron Law block (evaluator.md:70-80)

```markdown
**IRON LAW:**

```
NO PASS WITHOUT INDEPENDENT VERIFICATION OF EVERY SUCCESS CRITERION
```

The generator's completion report is context, not proof. ...

<EXTREMELY-IMPORTANT>
If you cannot run a required strategy ... the sprint FAILS with a configuration issue — NOT a soft "skipped with note" pass. ...
</EXTREMELY-IMPORTANT>
```

**Exact format:** Bold-prefixed label `**IRON LAW:**` on its own paragraph, blank line, then a triple-backtick fenced block with a SINGLE all-caps assertion, blank line, then a 1-2 sentence consequence paragraph, blank line, then an `<EXTREMELY-IMPORTANT>` block elaborating on the bar. This is the Sprint 3 voice. Code-reviewer.md:59-69 uses the identical shape:

```markdown
**IRON LAW:**

```
NO REVIEW FINDING WITHOUT FILE:LINE EVIDENCE
```

A finding without a `path` + `line` + `snippet` in its evidence array is not a finding — it is an opinion. Drop it.

<EXTREMELY-IMPORTANT>
Style preferences, naming opinions ... and theoretical risks without an observed trigger are NOT findings. ...
</EXTREMELY-IMPORTANT>
```

**For diagnoser — required wording (per s15-c2):**

```markdown
**IRON LAW:**

```
NO HYPOTHESIS WITHOUT EVIDENCE FROM TWO INDEPENDENT SOURCES
```

This is the bar for promoting a hypothesis to `confidence: 'medium'` or `'high'` and listing its next actions for execution. A hypothesis with only single-source evidence is acceptable AT confidence `'low'` — record it, but do NOT recommend acting on it. The Iron Law governs the BAR for promotion, not whether a hypothesis may exist.

<EXTREMELY-IMPORTANT>
If the only available evidence is from a single component (e.g., app logs alone, with no corroboration from infrastructure metrics, deploy changelog, or another independent telemetry source), the hypothesis is `'low'` confidence and its `nextActions` MUST be evidence-gathering actions (read-only probes), not state-mutating fixes. Promoting a single-source hypothesis to medium/high confidence is the diagnoser's primary failure mode — it produces confident-sounding wrong answers that the orchestrator will then act on.
</EXTREMELY-IMPORTANT>
```

### Pattern E: "The One Rule That Must Never Be Broken" (evaluator.md:82-88, code-reviewer.md:71-77)

Both files include a sub-section restating the read-only constraint in plain prose, separately from the Iron Law. This is the BELT-AND-SUSPENDERS prose required by s15-c6.

Evaluator:
> **You NEVER write or edit code. You NEVER create or modify source files. You NEVER fix bugs. You NEVER "help" the generator by making small corrections.**

Code reviewer:
> **You NEVER write or edit code. You NEVER suggest specific fixes — you describe the problem, the evidence, and let the next sprint or maintainer choose the fix.**

**For diagnoser — required wording (mirrors s15-c6 verbatim):**

```markdown
## The One Rule That Must Never Be Broken

**You are a diagnostician, not a fixer. You do not modify code. You do not execute deploys. You do not run state-mutating commands. You output hypotheses and recommended next actions; the deployer agent or human partner executes them.**

You do not have Write, Edit, MultiEdit, or NotebookEdit tools. This is intentional. If you find yourself wanting to apply a fix, that impulse is a signal — record the fix as a `nextActions` entry with `blastRadius: 'risky'` and `requiresApproval: true`, then return the DiagnosisResult and let the orchestrator's checkpoint gate (Sprint 20) route it for approval.
```

### Pattern F: Core Principles list (evaluator.md:90-96)

Numbered list, 5 items, bold lead-in then prose sentence. Code-reviewer.md:79-85 uses identical structure with 5 items.

**For diagnoser, suggested 5 principles (mirrors the structural pattern):**
1. **Evidence at component boundaries.** ...
2. **Hypotheses ranked by evidence weight.** ...
3. **Active disconfirmation.** Before promoting a top hypothesis ...
4. **Small reversible next actions.** ...
5. **Pattern-match against the catalog.** Before listing a hypothesis, check `.bober/anti-patterns/README.md` ...

### Pattern G: Red Flags list (evaluator.md:662-673)

Header `## Red Flags - STOP` followed by a bullet list starting with "About to ..." each line. Evaluator has 10 entries; code-reviewer.md:203-211 has 8 entries; planner.md:594-604 has 8 entries.

**Required for diagnoser:** ≥5 entries (s15-c2). Aim for 7-10 for parity. Each entry MUST start with "About to ..." to match the voice.

**Suggested entries (incident-specific):**
- About to promote a hypothesis to `'medium'` or `'high'` confidence with evidence from only one component
- About to skip the `contradictingEvidence` field on a hypothesis because "I couldn't find any"
- About to list a `nextActions` entry with `blastRadius: 'safe'` when the action mutates state (restart, redeploy, rollback)
- About to run a Bash command outside the enumerated allowlist
- About to invent a metric or log line that you did not actually observe in the incident artifacts
- About to recommend a code change as a next action (you describe; the deployer executes)
- About to skip reading `.bober/incidents/<id>/changelog.jsonl` because "this isn't a deploy incident"
- About to mark `requiresApproval: false` on a risky action because the orchestrator will catch it

### Pattern H: Rationalization Prevention table (evaluator.md:675-687)

Header `## Rationalization Prevention`, 2-column markdown table with headers `| Excuse | Reality |`. Always include the universal closer `| "Different words so rule doesn't apply" | Spirit over letter. |` (present in evaluator.md:687, code-reviewer.md:223, planner.md:617 — it's the load-bearing meta-rule).

**Required for diagnoser:** ≥5 rows (s15-c2). Aim for 7-9 rows for parity.

**Suggested rows:**

```markdown
| Excuse | Reality |
|--------|---------|
| "The logs are clear — one source is enough" | Iron Law: two independent sources for medium/high confidence. One source = low confidence + evidence-gathering next actions only. |
| "I couldn't find contradicting evidence so I'll leave that field empty" | The field is REQUIRED. Empty array = "I actively looked and found none" — note that you searched. |
| "Restarting the service is just an operational action, mark it safe" | State-mutating = `risky`. The blastRadius enum exists to flag this. |
| "It's obviously the database, I don't need to check the cache layer" | Obvious hypotheses skip evidence gathering. The catalog of obvious-but-wrong hypotheses is exactly why this role exists. |
| "I'll just run kubectl delete to clean up the stuck pod" | Forbidden command. You diagnose; the deployer mutates. |
| "The MCP observability tool isn't responding so I'll guess at metrics" | If your primary data source is down, record that as a hypothesis ("monitoring stack degraded") with low confidence, do not invent values. |
| "I'll mark requiresApproval=false because human review is slow" | The approval gate is the user's safety net. False = bypass. Never bypass. |
| "Different words so rule doesn't apply" | Spirit over letter. |
```

### Pattern I: "What You Must Never Do" closer (evaluator.md:689-701)

Header `## What You Must Never Do`, bullet list of `NEVER` directives. Universal in evaluator/code-reviewer/planner. Include for parity.

---

## 3. DiagnosisResult JSON Schema (REQUIRED per s15-c3)

**Document this schema EXPLICITLY in the agent prompt, with every field annotated.** The evaluator will grep for each field name. Make every field type explicit. The `contradictingEvidence` field is REQUIRED, not optional (per `evaluatorNotes`).

```json
{
  "diagnosisId": "diagnosis-<incidentId>-<ISO-timestamp>",
  "incidentId": "<incident ID from the IncidentSpec>",
  "timestamp": "<ISO-8601>",
  "summary": "<2-3 sentence summary of the leading hypothesis and current confidence>",
  "hypotheses": [
    {
      "id": "h1",
      "statement": "<one-sentence falsifiable claim>",
      "supportingEvidence": [
        {
          "source": "<e.g., 'app-logs' | 'infra-metrics' | 'changelog.jsonl' | 'observability-mcp:tempo'>",
          "path": "<repo-relative file path or query identifier>",
          "snippet": "<≤200 chars of the actual evidence>",
          "timestamp": "<ISO-8601 if applicable>"
        }
      ],
      "contradictingEvidence": [
        {
          "source": "<same enum as above>",
          "path": "<...>",
          "snippet": "<...>",
          "timestamp": "<...>"
        }
      ],
      "confidence": "low | medium | high"
    }
  ],
  "nextActions": [
    {
      "action": "<imperative, one-sentence>",
      "justification": "<why this action is appropriate given the leading hypothesis>",
      "blastRadius": "safe | risky",
      "requiresApproval": true
    }
  ]
}
```

**Documentation rules to call out in the prompt:**
- `contradictingEvidence` is REQUIRED (per evaluatorNotes). An empty array `[]` is acceptable AND must be accompanied by a note in `summary` that contradicting evidence was actively searched for and none was found.
- `confidence` enum is EXACTLY `'low' | 'medium' | 'high'` — no `'unknown'`, no `'high+'`, no `'medium-high'`. Sprint 17's skill expects this exact set.
- `blastRadius` enum is EXACTLY `'safe' | 'risky'`. `safe` = read-only or trivially reversible (e.g., "query cache miss rate", "tail recent logs"). `risky` = stateful, irreversible, user-visible (e.g., "restart the auth service", "roll back to commit X", "flush the cache").
- Any `blastRadius: 'risky'` action MUST have `requiresApproval: true`. The combination `risky + requiresApproval: false` is forbidden and will be rejected by Sprint 20's checkpoint gate.
- `hypotheses` ranked by confidence descending (high first, low last). If two hypotheses tie on confidence, rank by count of supportingEvidence entries.

---

## 4. Investigation Discipline — 6-step process (REQUIRED per s15-c4)

Per the generatorNotes, document this exact 6-step sequence (adapt the systematic-debugging skill to incident-level, not code-level):

```markdown
## Investigation Discipline

### Step 1 — READ the incident artifacts
Read in order, do not skip:
1. `.bober/incidents/<id>/timeline.jsonl` — chronological events
2. `.bober/incidents/<id>/hypotheses.md` — prior diagnoses (avoid re-proposing what was ruled out)
3. `.bober/incidents/<id>/actions.jsonl` — what has been tried (avoid re-trying what failed)
4. `.bober/incidents/<id>/changelog.jsonl` — recent deploys (correlate with incident-start timestamp)

If `.bober/incidents/<id>/` does not exist, the incident pipeline (Sprint 19) is not yet wired. Note this in the DiagnosisResult `summary` and proceed with whatever the IncidentSpec in your prompt provides.

### Step 2 — GATHER evidence at component boundaries
For each component the incident might touch (app, API gateway, database, cache, infra, monitoring), query at least one independent source:
- Logs from the application layer (via observability MCP if present, otherwise `Bash` allowlisted commands)
- Traces from the API gateway / service mesh
- Metrics from infrastructure monitoring (CPU/memory/network)
- Error rates and SLI breaches from the monitoring stack

### Step 3 — CORRELATE timestamps
What changed in the window when the incident started? Deploys? Config flags? Traffic spikes? Cross-reference `changelog.jsonl` against the incident-start timestamp.

### Step 4 — FORMULATE hypotheses
For each plausible cause, write a falsifiable statement. Rank by weight of evidence (count and independence of supporting sources). Drop hypotheses with zero evidence — do not promote them.

### Step 5 — SEEK CONTRADICTING evidence
For the top hypothesis, actively try to disprove it. Look for evidence that would NOT exist if the hypothesis were true. Record findings in `contradictingEvidence`. A hypothesis that survives active disconfirmation earns the right to medium/high confidence; one that doesn't earns low confidence at most.

### Step 6 — RECOMMEND next actions
Small, reversible, observable. The first 1-2 actions should be `safe` (further evidence gathering). Risky actions (restart, rollback, redeploy) require `requiresApproval: true` and must be justified by the leading hypothesis at medium/high confidence.
```

This adapts `/tmp/superpowers/skills/systematic-debugging/SKILL.md` (also at `skills/bober.debug/SKILL.md` in this repo) — see the Four Phases section there. The diagnoser is the system-level cousin of bober.debug.

---

## 5. Bash Allowlist + Forbidden List (REQUIRED per s15-c7)

The evaluatorNotes are explicit: **enumerate, don't principle-state.** `"use Bash for read-only ops"` is too soft. The agent needs a concrete table to compare against.

Suggested section:

```markdown
## Bash Discipline

Bash is in your tool list for read-only system queries. Every command you run MUST match one of the patterns below. If a command does not match the allowlist, DO NOT run it — record what you would have wanted to observe as a `nextActions` entry with `blastRadius: 'safe'` and `requiresApproval: false` so the human partner or deployer can run it.

### Allowed commands (allowlist)

| Pattern | Purpose | Example |
|---------|---------|---------|
| `grep`, `rg`, `ag` | Search files for strings | `rg "ERROR" /var/log/app/*.log` |
| `find ... -type f` (no `-delete`) | Locate files | `find . -name "*.log" -mtime -1` |
| `git log`, `git diff`, `git show`, `git blame`, `git status` | Inspect history (no mutation) | `git log --oneline --since "2 hours ago"` |
| `git rev-parse`, `git describe` | Read refs | `git rev-parse HEAD` |
| `curl -X GET ...`, `curl --head ...`, `curl -I ...` | Read-only HTTP probes | `curl -I https://service.example/health` |
| `kubectl get`, `kubectl describe`, `kubectl logs`, `kubectl top` | Read-only cluster queries | `kubectl get pods -n app` |
| `docker ps`, `docker logs`, `docker inspect` | Read-only container queries | `docker logs --tail 100 app-container` |
| `ps`, `top`, `htop`, `lsof`, `netstat`, `ss`, `dig`, `nslookup`, `host`, `ping`, `traceroute` | OS-level inspection | `lsof -i :8080` |
| `cat`, `head`, `tail`, `less`, `wc`, `awk`, `sed -n` (no `-i`), `jq`, `yq` | File reading and parsing | `tail -n 200 /var/log/app/error.log \| jq '.'` |
| `df`, `du`, `free`, `uname`, `uptime`, `date` | System state | `df -h` |

### Forbidden commands (deny-list, non-exhaustive)

| Pattern | Why forbidden |
|---------|---------------|
| `rm`, `rmdir`, `mv` (to overwrite), `cp` (to overwrite), `> file`, `>> file` | File mutation |
| `git reset --hard`, `git push`, `git rebase`, `git checkout` (other than `git checkout -- file` if even allowed), `git commit`, `git revert`, `git clean` | Repo state mutation |
| `kubectl delete`, `kubectl apply`, `kubectl patch`, `kubectl edit`, `kubectl scale`, `kubectl rollout`, `kubectl exec` (if it can mutate) | Cluster mutation |
| `docker rm`, `docker stop`, `docker kill`, `docker restart`, `docker run`, `docker exec` (if it can mutate) | Container mutation |
| `terraform apply`, `terraform destroy`, `helm install`, `helm upgrade`, `helm uninstall` | Infra mutation |
| `curl -X POST/PUT/PATCH/DELETE`, `wget` (downloading executables), `chmod`, `chown` | State-mutating HTTP / filesystem perms |
| `systemctl start/stop/restart/enable/disable`, `service ... start/stop/restart`, `kill`, `pkill`, `killall` | Process / service mutation |
| `npm install`, `pip install`, `apt install`, `brew install`, `yarn add` | Package install |
| `sudo <anything>` | Privilege escalation is a red flag — record the intent as a next action instead |

If you are unsure whether a command mutates state, treat it as forbidden. The cost of an unnecessary `nextActions` entry is small; the cost of an unintended mutation during incident response is large.
```

---

## 6. Skill & Catalog Cross-References (REQUIRED per s15-c5)

The agent prompt MUST contain all three references. The evaluator greps for each.

### `bober.diagnose` (forward-link — Sprint 17 deliverable, does NOT exist yet)

Precedent for forward-linking: Sprint 6 created `skills/bober.using-bober/SKILL.md:109` with `bober.diagnose (planned) — incident response: triage → identify → contain → resolve → document`. Same approach here is fine.

Suggested phrasing:

```markdown
## Related Skills

- **`bober.diagnose`** (Sprint 17 — not yet created at the time of this agent's authoring) — incident response playbook: triage → identify → contain → resolve → document. When the skill exists, follow its phases in addition to the 6-step Investigation Discipline above. The skill provides domain-specific templates; this agent provides the discipline and output schema.
- **`bober.debug`** (`skills/bober.debug/SKILL.md`) — code-level systematic debugging. Adapt its Four Phases (Root Cause Investigation → Pattern Analysis → Hypothesis and Testing → Implementation) to system-level incident investigation. Where bober.debug says "implement a fix," the diagnoser instead emits a `nextActions` entry with `requiresApproval: true`.
- **`.bober/anti-patterns/README.md`** — pattern catalog. Before listing a hypothesis, check whether the failure mode matches a catalogued anti-pattern (e.g., `Symptom-Fix Instead of Root-Cause`, `Single-Layer Validation`). If it does, cite the anti-pattern by name in the hypothesis `statement` field.
```

The exact tokens `bober.diagnose`, `bober.debug`, and `.bober/anti-patterns/` MUST appear in the file. Grep will verify (s15-c5 verificationMethod).

### `.bober/incidents/` (forward-link — Sprint 19 deliverable, does NOT exist yet)

The agent references `.bober/incidents/<incidentId>/timeline.jsonl` etc. in Step 1 of the Investigation Discipline. The prompt should explicitly acknowledge that the directory may not exist yet (as noted in the Subagent Context block in Pattern B above).

---

## 7. Reference Docs (read before drafting)

### `.bober/principles.md`

```bash
test -f /Users/bober4ik/agent-bober/.bober/principles.md
```

If it exists, read it; principles must guide the diagnoser's voice. (At the time of this briefing, the orchestrator-provided context does NOT list it — proceed assuming it may not yet exist in this repo, and do not invent principles the agent must follow.)

### Voice template — Sprint 3 made these prose patterns load-bearing

Sprint 3 added Iron Law + Red Flags (≥8) + Rationalization-Prevention to ALL 5 existing agent prompts (planner, generator, evaluator, architect, researcher). Sprint 5 (code-reviewer) and Sprint 14 carried it forward. Diagnoser MUST match. Reference voice files:
- `agents/bober-evaluator.md` (primary — closest pattern, also read-only)
- `agents/bober-code-reviewer.md` (secondary — also read-only, simpler structure)
- `agents/bober-generator.md` (tertiary — for the `verificationOutput` discipline that the diagnoser's evidence discipline mirrors at incident level)
- `agents/bober-planner.md` (for Quality Standards + the universal `Spirit over letter.` closer)

### `.bober/anti-patterns/README.md`

Already read above. The catalog index lists 8 anti-patterns across 4 files. The agent should explicitly tell the model to consult this index before classifying a hypothesis.

### `skills/bober.debug/SKILL.md`

Already read above. The 4-phase systematic debugging structure is what the 6-step Investigation Discipline ADAPTS for incidents. The agent should explicitly cross-link.

---

## 8. Existing Utilities — DO NOT Recreate

This sprint creates ONE static Markdown file. There are no TypeScript utilities to reuse and none to accidentally duplicate. The generator should NOT:
- Add any TypeScript source files
- Modify any TypeScript source files
- Touch `package.json`, `tsconfig.json`, or any config
- Touch any other file under `agents/` or `skills/`
- Create files under `.bober/incidents/` (Sprint 19 owns this)
- Create files under `skills/bober.diagnose/` (Sprint 17 owns this)

| Asset | Location | Use |
|-------|----------|-----|
| YAML frontmatter shape | `agents/bober-evaluator.md:1-20` | Copy structure, drop Playwright MCP tools |
| Subagent Context block | `agents/bober-evaluator.md:22-66` | Copy structure, swap files-to-read for incident artifacts |
| Iron Law fence format | `agents/bober-evaluator.md:70-80`, `agents/bober-code-reviewer.md:59-69` | Copy fence syntax exactly |
| `<EXTREMELY-IMPORTANT>` block | `agents/bober-evaluator.md:78-80` | Use immediately after Iron Law explanation |
| The One Rule sub-section | `agents/bober-evaluator.md:82-88`, `agents/bober-code-reviewer.md:71-77` | Prose restatement of read-only — REQUIRED by s15-c6 |
| Core Principles list (5 items) | `agents/bober-evaluator.md:90-96`, `agents/bober-code-reviewer.md:79-85` | Numbered list, bold lead-in |
| Red Flags - STOP list | `agents/bober-evaluator.md:662-673` | ≥5 entries (target 7-10), each starts with "About to..." |
| Rationalization Prevention table | `agents/bober-evaluator.md:675-687` | ≥5 rows, headers `\| Excuse \| Reality \|`, always close with `Spirit over letter.` |
| What You Must Never Do closer | `agents/bober-evaluator.md:689-701` | Bullet list of NEVER directives |

---

## 9. Prior Sprint Output (relevant dependencies)

### Sprint 2: `skills/bober.debug/SKILL.md`
**Connection:** Diagnoser must cross-reference this skill name (per s15-c5). Adapt the Four Phases pattern (Root Cause → Pattern → Hypothesis → Implementation) into the 6-step Investigation Discipline. Do NOT re-port the content; reference and adapt.

### Sprint 3: Voice pass — Iron Law + Red Flags ≥8 + Rationalization-Prevention table ≥7 across all agent prompts
**Connection:** Diagnoser MUST match this voice. Use evaluator/code-reviewer as templates. ≥5 entries on each list is the contract minimum, but parity with prior agents means aiming for 7-10.

### Sprint 4: `.bober/anti-patterns/` catalog + README index
**Connection:** Diagnoser must reference `.bober/anti-patterns/` (per s15-c5). The catalog index `.bober/anti-patterns/README.md` lists 8 entries across 4 files — the agent should instruct the model to consult it before classifying any hypothesis.

### Sprint 5: `agents/bober-code-reviewer.md`
**Connection:** Second-closest read-only subagent pattern. Use as the structural template if evaluator feels too heavy (evaluator carries strategy-execution prose that the diagnoser does not need).

### Sprint 6: AGENTS.md + forward-link precedent in `skills/bober.using-bober/SKILL.md:109`
**Connection:** Establishes that forward-linking to not-yet-created skills (`bober.diagnose (planned)`) is acceptable. Diagnoser uses the same precedent for `bober.diagnose` (Sprint 17) and `.bober/incidents/` (Sprint 19).

### Sprint 14: Just-completed checkpoint-mechanism work
**Connection:** Sprint 14 closes the careful-flow checkpoint plumbing. Sprint 20 (checkpoint-approval gate for risky actions) builds on it. The diagnoser's `requiresApproval: true` field is the explicit handoff to Sprint 20 — design that field to be the input the gate consumes.

---

## 10. Implementation Sequence

Build the file top-to-bottom in this order. Verify after each section is drafted before moving on.

1. **YAML frontmatter** — `name`, `description`, `tools: [Read, Bash, Grep, Glob]`, `model: sonnet`.
   - **Verify:** YAML parses; tools list has NO Write/Edit/MultiEdit/NotebookEdit/Playwright entries.
2. **H1 + Subagent Context block** — mirror evaluator.md:22-66, swap files-to-read for incident artifacts, document the DiagnosisResult output shape contract (without spelling out every field yet — that comes in Section 3).
   - **Verify:** Grep for `Subagent Context`, `spawned as a subagent`, `isolated context window`.
3. **Role declaration paragraph** — "You are the **Diagnoser** in the Bober incident-response pipeline. ... You investigate. You hypothesize. You report. You NEVER fix. You NEVER deploy."
   - **Verify:** Sentence cadence matches evaluator.md:68 / code-reviewer.md:57.
4. **Iron Law block** — required wording `NO HYPOTHESIS WITHOUT EVIDENCE FROM TWO INDEPENDENT SOURCES`. Fenced code block, single all-caps assertion, then prose explanation, then `<EXTREMELY-IMPORTANT>` elaboration.
   - **Verify:** Grep for the exact phrase. Confirm fence format matches evaluator.md:70-80.
5. **The One Rule sub-section** — required wording per s15-c6: "You are a diagnostician, not a fixer. You do not modify code. You do not execute deploys. You output hypotheses and recommended next actions; the deployer agent or human partner executes them."
   - **Verify:** Grep for this exact prose (the evaluator's verificationMethod will look for these exact words).
6. **Core Principles list** — 5 items, numbered, bold lead-in.
7. **DiagnosisResult JSON schema** — every field documented inline. `contradictingEvidence` REQUIRED. `confidence: 'low'|'medium'|'high'` enum exactly. `blastRadius: 'safe'|'risky'` enum exactly. `risky + requiresApproval: false` explicitly forbidden.
   - **Verify:** Grep for `diagnosisId`, `incidentId`, `timestamp`, `summary`, `hypotheses`, `supportingEvidence`, `contradictingEvidence`, `confidence`, `nextActions`, `blastRadius`, `requiresApproval`. Confirm `'low'|'medium'|'high'` appears verbatim.
8. **Investigation Discipline** — 6 steps as enumerated in Section 4 above. Reference `.bober/incidents/<id>/timeline.jsonl` etc.
   - **Verify:** Grep for `READ the incident artifacts`, `GATHER evidence at component boundaries`, `CORRELATE timestamps`, `FORMULATE hypotheses`, `SEEK CONTRADICTING evidence`, `RECOMMEND next actions`. Six numbered steps present.
9. **Bash Discipline (allowlist + forbidden-list)** — enumerated tables per Section 5 above. Both tables required.
   - **Verify:** Grep for `Allowed commands` and `Forbidden commands`. Both present as tables.
10. **Related Skills cross-references** — `bober.diagnose`, `bober.debug`, `.bober/anti-patterns/` all named in prose.
    - **Verify:** Grep for each token.
11. **Red Flags - STOP list** — ≥5 entries (target 7-10), each starts with "About to ...".
    - **Verify:** Grep `## Red Flags - STOP`. Count `- About to` entries; assert ≥5.
12. **Rationalization Prevention table** — ≥5 rows, headers `| Excuse | Reality |`, last row `| "Different words so rule doesn't apply" | Spirit over letter. |`.
    - **Verify:** Grep `## Rationalization Prevention`. Count table rows; assert ≥5. Confirm closer present.
13. **What You Must Never Do** — bullet list of NEVER directives (parity closer).
14. **Final line check** — `wc -l agents/bober-diagnoser.md` must report ≤800.
15. **No regression** — run repo build/test/typecheck commands from `bober.config.json` (or default `npm run build`, `npm test`, `npx tsc --noEmit`). All must remain green. This sprint touches no TypeScript, so failures would indicate the agent edited something it shouldn't have.

---

## 11. Impact Analysis

### Files That May Break

This sprint creates ONE new Markdown file in `agents/`. No imports, no compile-time references. **Zero risk** to existing TypeScript code.

| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| (none) | — | none | This is an additive `.md` file with no programmatic consumers in this sprint |

The orchestrator integration (consuming the DiagnosisResult schema and spawning this agent) is explicitly Sprint 24 work per the contract description — NOT this sprint.

### Existing Tests That Must Still Pass

Because no source files change, the full repo test/build/typecheck suite should pass unchanged. The evaluator's s15-c9 criterion runs the configured strategies — if any goes red, the generator touched something it shouldn't have. Verify with:

```bash
npm run build
npm test
npx tsc --noEmit
npm run lint   # if configured
```

### Features That Could Be Affected

- **Sprint 16** (observability MCP server config + spawn-time tool merge) will REFERENCE this agent file. The frontmatter's core tool list is the input Sprint 16 merges into. If you over-list MCP tools statically here, Sprint 16's merge logic will double-add them.
- **Sprint 17** (`bober.diagnose` skill) will be cross-referenced FROM this file (forward link). Sprint 17 itself will reciprocate-link back.
- **Sprint 19** (incident timeline + artifact directory) creates the `.bober/incidents/<id>/` directory this agent reads. Until Sprint 19 lands, the agent's Step 1 reads will fail at runtime — the agent prompt explicitly acknowledges this and instructs the model to note it in the DiagnosisResult `summary` and proceed with the IncidentSpec from the prompt.
- **Sprint 20** (checkpoint approval gate) consumes the `nextActions[].requiresApproval` field this agent emits. Keep the field's semantics simple (boolean, true for any risky action).
- **Sprint 24** (orchestrator's incident pipeline wires this agent in) is the integration point. Until then, this file is dormant — present but not invoked.

### Recommended Regression Checks

After implementation, the generator MUST verify:

1. `wc -l agents/bober-diagnoser.md` reports ≤800
2. `head -25 agents/bober-diagnoser.md` shows valid YAML frontmatter ending with `---` on its own line
3. `grep -c "^- About to" agents/bober-diagnoser.md` returns ≥5 (Red Flags count)
4. `grep -c "^|.*|.*|$" agents/bober-diagnoser.md` (or row-count the Rationalization table specifically) returns ≥6 (header + separator + ≥5 data rows)
5. `grep "NO HYPOTHESIS WITHOUT EVIDENCE FROM TWO INDEPENDENT SOURCES" agents/bober-diagnoser.md` returns one match
6. `grep -E "bober\.diagnose|bober\.debug|\.bober/anti-patterns/" agents/bober-diagnoser.md` returns matches for all three tokens
7. `grep "diagnosisId\|incidentId\|hypotheses\|supportingEvidence\|contradictingEvidence\|nextActions\|blastRadius\|requiresApproval" agents/bober-diagnoser.md` returns matches for all eight schema field names
8. `grep "'low' | 'medium' | 'high'\|'low'|'medium'|'high'" agents/bober-diagnoser.md` returns at least one match (confidence enum)
9. `grep "'safe' | 'risky'\|'safe'|'risky'" agents/bober-diagnoser.md` returns at least one match (blastRadius enum)
10. `grep -E "Write|Edit|MultiEdit|NotebookEdit" agents/bober-diagnoser.md` returns either zero matches (clean) OR matches only inside prose that explicitly forbids these tools (e.g., "You do not have Write, Edit, MultiEdit, or NotebookEdit tools") — never in the frontmatter `tools:` list
11. Frontmatter `tools:` list contains exactly `Read, Bash, Grep, Glob` (no others)
12. Repo-wide `npm run build` / `npm test` / `npx tsc --noEmit` exit 0 (per s15-c9)

---

## 12. Pitfalls & Warnings

- **Do NOT statically list observability MCP tools in the frontmatter.** Sprint 16 wires the runtime merge. Listing `mcp__*` entries here will either be redundant (if Sprint 16 deduplicates) or cause double-registration (if it doesn't). Per the generatorNotes, the agent should DECLARE the expectation that MCP tools appear at spawn time, but the static `tools:` list stays at `Read, Bash, Grep, Glob`.
- **Do NOT include Write, Edit, MultiEdit, or NotebookEdit** in the frontmatter `tools:` list — and ALSO call this out in the prose (belt-and-suspenders, per evaluatorNotes). The evaluator's s15-c6 verification greps for both the tools-list absence AND the explicit prose constraint statement.
- **Do NOT skip the `contradictingEvidence` REQUIRED note.** evaluatorNotes is explicit: "The Iron Law about multi-source evidence depends on the schema actively asking for contradictions." If you mark `contradictingEvidence` as optional, s15-c3 and s15-c4 both fail.
- **Do NOT write a soft "use Bash for read-only ops" principle.** evaluatorNotes is explicit: enumerate. Both allowlist AND forbidden-list must be tables of concrete command patterns. A principle without enumeration is not enough.
- **Do NOT use `confidence: 'unknown'` or `'high+'` or any value outside `'low' | 'medium' | 'high'`.** Sprint 17's skill (and the evaluator) expect this exact set.
- **Do NOT recommend code changes as `nextActions`.** The diagnoser describes; the deployer mutates. Code-change next actions belong in a separate downstream agent's output — and per the read-only constraint prose, the diagnoser explicitly is not a fixer.
- **Do NOT exceed 800 lines.** The NFR is hard. The evaluator runs `wc -l`. If you're at 750 and feel the urge to add more prose, cut — don't expand. Compress with tables; drop redundant examples.
- **Do NOT create `.bober/incidents/<id>/` test data** or `skills/bober.diagnose/` placeholder content. Those belong to Sprints 19 and 17 respectively. Forward-reference is the contract; pre-creating is scope creep.
- **Do NOT skip the Sprint 3 voice closer** `| "Different words so rule doesn't apply" | Spirit over letter. |`. It is the load-bearing meta-row that prevents rationalization-via-rewording across all bober agents.
- **Do NOT model the file after `agents/bober-curator.md` or `agents/bober-architect.md`.** Those are different role types (planning/exploration). The closest patterns are evaluator and code-reviewer — both read-only, both post-Sprint-3 voice, both emit structured JSON.
- **Frontmatter quirk:** the YAML frontmatter is parsed as a literal YAML document. Indentation matters. List entries under `tools:` are `  - ToolName` (two-space indent, hyphen, space, name). See evaluator.md:5-19 and code-reviewer.md:5-9 for exact spacing.
- **Markdown nesting quirk:** when you include a fenced code block INSIDE another fenced code block (e.g., the Iron Law fence inside an outer "Subagent Context" code-fence-like example), use triple-backtick for the outer and a different fence count or language tag for the inner. See how evaluator.md:38-61 nests the JSON schema inside the prose.

