# Sprint Briefing: SessionStart bootstrap + bober.using-bober skill

**Contract:** sprint-spec-20260524-bober-vision-1
**Generated:** 2026-05-24T18:15:00Z
**Spec:** spec-20260524-bober-vision (Tier 0, Sprint 1 of 28)

---

## 0. TL;DR for the Generator

Create three artifacts:

1. `hooks/session-start` — executable bash, structurally cloned from `/tmp/superpowers/hooks/session-start`. Use `escape_for_json` (bash parameter substitution, NO jq), env-var branching (CURSOR vs CLAUDE-CODE vs COPILOT-CLI), printf-based JSON emission (NO heredoc — bash 5.3+ hang). Reads `skills/bober.using-bober/SKILL.md` from `PROJECT_ROOT/skills/...`.
2. `hooks/hooks.json` — ADD a `SessionStart` matcher alongside the existing `PostToolUse` matchers. The existing entries (`echo 'Files modified...'`, `node scripts/graph-hook.mjs`) are LOAD-BEARING and MUST remain byte-identical.
3. `skills/bober.using-bober/SKILL.md` — verbatim-voice port of `/tmp/superpowers/skills/using-superpowers/SKILL.md`, adapted to the bober skill catalog (15 skills listed below). Keep `<EXTREMELY-IMPORTANT>` tags, the "even 1% chance" framing, Iron-Law-style emphatic caps. Add MIT attribution to `obra/superpowers`. Frontmatter < 1024 bytes.

The planner's note about "coexist with existing graph-stats SessionStart at hooks.json level" is a misreading — there is no SessionStart in this repo's `hooks/hooks.json` today. The graph-stats SessionStart payload comes from a different mechanism (Claude Code MCP infrastructure / `scripts/graph-hook.mjs` post-tool side effects). Just ADD the new SessionStart matcher; nothing collides at the file level.

---

## 1. Target Files

### `hooks/session-start` (CREATE — executable bash)

**Reference file (already on disk):** `/tmp/superpowers/hooks/session-start` — full 57-line source below. Clone the SHAPE; substitute "superpowers" branding for "bober" and load the bober skill.

**Full reference source (`/tmp/superpowers/hooks/session-start`):**
```bash
#!/usr/bin/env bash
# SessionStart hook for superpowers plugin

set -euo pipefail

# Determine plugin root directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Check if legacy skills directory exists and build warning
warning_message=""
legacy_skills_dir="${HOME}/.config/superpowers/skills"
if [ -d "$legacy_skills_dir" ]; then
    warning_message="\n\n<important-reminder>...</important-reminder>"
fi

# Read using-superpowers content
using_superpowers_content=$(cat "${PLUGIN_ROOT}/skills/using-superpowers/SKILL.md" 2>&1 || echo "Error reading using-superpowers skill")

# Escape string for JSON embedding using bash parameter substitution.
escape_for_json() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"
    s="${s//$'\r'/\\r}"
    s="${s//$'\t'/\\t}"
    printf '%s' "$s"
}

using_superpowers_escaped=$(escape_for_json "$using_superpowers_content")
warning_escaped=$(escape_for_json "$warning_message")
session_context="<EXTREMELY_IMPORTANT>\nYou have superpowers.\n\n**Below is the full content of your 'superpowers:using-superpowers' skill - your introduction to using skills. For all other skills, use the 'Skill' tool:**\n\n${using_superpowers_escaped}\n\n${warning_escaped}\n</EXTREMELY_IMPORTANT>"

# Output context injection as JSON.
# Uses printf instead of heredoc to work around bash 5.3+ heredoc hang.
# See: https://github.com/obra/superpowers/issues/571
if [ -n "${CURSOR_PLUGIN_ROOT:-}" ]; then
  printf '{\n  "additional_context": "%s"\n}\n' "$session_context"
elif [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -z "${COPILOT_CLI:-}" ]; then
  printf '{\n  "hookSpecificOutput": {\n    "hookEventName": "SessionStart",\n    "additionalContext": "%s"\n  }\n}\n' "$session_context"
else
  printf '{\n  "additionalContext": "%s"\n}\n' "$session_context"
fi

exit 0
```

**Required adaptations for bober:**
- Shebang `#!/usr/bin/env bash` (NEVER `/bin/bash` — evaluator rejects hardcoded path)
- `set -euo pipefail`
- Add MIT attribution comment at the top: `# Structural pattern from obra/superpowers (MIT). See https://github.com/obra/superpowers`
- Use `PROJECT_ROOT` instead of `PLUGIN_ROOT` (this is a project repo, not a plugin install): `PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"`
- Read `${PROJECT_ROOT}/skills/bober.using-bober/SKILL.md` (note the period in the directory name — bober skills are `bober.<name>/SKILL.md`)
- DROP the legacy-skills-directory warning block (no analogue in bober)
- Keep the `escape_for_json` function VERBATIM
- Wrap `session_context` with `<EXTREMELY_IMPORTANT>` (underscore form matches superpowers source) and adapt branding: `"You are agent-bober."` instead of `"You have superpowers."`
- Keep the three-branch env-var dispatch (CURSOR_PLUGIN_ROOT / CLAUDE_PLUGIN_ROOT-without-COPILOT_CLI / fallback) — printf-based JSON, NOT heredoc
- After write: `chmod +x hooks/session-start`

**Required:** the file MUST be executable after creation. `test -x hooks/session-start` is a contract verification step (s1-c1).

**Imported by / called by:** `hooks/hooks.json` (new SessionStart matcher) — invoked by Claude Code at session start, /clear, /compact.

**Test file:** None expected; verification is via running the script and piping stdout through `jq .` to confirm valid JSON. (See s1-c1, s1-c4 verification methods.)

---

### `hooks/hooks.json` (MODIFY — add SessionStart sibling)

**Current full contents (`/Users/bober4ik/agent-bober/hooks/hooks.json`):**
```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "command": "echo 'Files modified — run /bober:eval to verify'"
      },
      {
        "matcher": "Edit|Write",
        "command": "node scripts/graph-hook.mjs"
      }
    ]
  }
}
```

**These two PostToolUse entries are LOAD-BEARING.** The second one (`node scripts/graph-hook.mjs`) keeps the code-review-graph in sync. Do NOT change their shape, matcher, or command strings.

**Target shape after this sprint (add a SessionStart sibling):**
```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT:-.}/hooks/session-start",
            "async": false
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "command": "echo 'Files modified — run /bober:eval to verify'"
      },
      {
        "matcher": "Edit|Write",
        "command": "node scripts/graph-hook.mjs"
      }
    ]
  }
}
```

**Important shape note:** The reference `/tmp/superpowers/hooks/hooks.json` uses a nested form for SessionStart (`hooks: [{type, command, async}]`). The existing PostToolUse entries in this repo use a FLAT form (`{matcher, command}` directly). Both are valid Claude Code hook shapes; keep PostToolUse flat (don't refactor it), keep SessionStart nested (matches superpowers reference and gives access to `async: false`).

**Matcher value:** `"startup|clear|compact"` — the superpowers convention. Means the bootstrap reloads at session start AND on `/clear` AND on `/compact` (otherwise the model loses the bootstrap after compaction).

**Command resolution:** Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}` when running as a plugin. For repo-rooted execution (not a plugin), `${CLAUDE_PLUGIN_ROOT:-.}` falls back to `.` (cwd). Some teams use an absolute or relative path here; superpowers uses `${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd session-start` with a dispatcher. Since this repo has no `run-hook.cmd`, point directly at `hooks/session-start` and rely on the `chmod +x` from creation.

**Verification:** `jq . hooks/hooks.json` must parse (s1-c2).

---

### `skills/bober.using-bober/SKILL.md` (CREATE)

**Directory pattern:** All bober skills live in `skills/bober.<name>/SKILL.md`. Note the DOT separator (not hyphen) in the directory name; the `name:` field in frontmatter typically uses the same dotted form (e.g. `name: bober.plan`), but the contract specifies `name: bober-using-bober` (hyphen) for s1-c3 verification. **Use `name: bober-using-bober` exactly as written in the contract.** (The Skill tool's argument is the `name:` field; hyphenated names are conventional for Claude Code's Skill tool, even though the directory is dotted.)

**Most similar existing reference:** `/tmp/superpowers/skills/using-superpowers/SKILL.md` (full content was read; key blocks extracted in Section 2 below).

**Frontmatter shape (existing skill conventions in this repo):**
```yaml
---
name: bober.plan
description: Transform a feature idea into a comprehensive plan with sprint contracts, clarifying questions, and acceptance criteria.
argument-hint: <feature-description>
handoffs:
  - label: "Start Building"
    command: /bober-sprint
    prompt: "Execute the first sprint from the plan"
---
```

But the superpowers `using-superpowers/SKILL.md` uses a simpler frontmatter:
```yaml
---
name: using-superpowers
description: Use when starting any conversation - establishes how to find and use skills, requiring Skill tool invocation before ANY response including clarifying questions
---
```

**Recommended frontmatter for `skills/bober.using-bober/SKILL.md`** (matches superpowers shape; satisfies s1-c3):
```yaml
---
name: bober-using-bober
description: Use when starting any conversation - establishes how to find and use bober skills, requiring Skill tool invocation before ANY response including clarifying questions
---
```

**Frontmatter byte budget:** under 1024 bytes (s1-c3). The block above is ~190 bytes — plenty of headroom.

**Body required content (s1-c3 grep targets — every one of these strings MUST appear literally):**
- `<EXTREMELY-IMPORTANT>` (tag form with hyphens — matches superpowers source)
- Each bober.* skill name: `bober.principles`, `bober.plan`, `bober.research`, `bober.architect`, `bober.sprint`, `bober.run`, `bober.eval`, `bober.verify`, `bober.debug`, `bober.code-review`, `bober.diagnose`, `bober.runbook`, `bober.deploy`, `bober.postmortem`
- `Iron Law`
- `AGENTS.md`
- `obra/superpowers` (attribution — s1-c5)
- `MIT` (attribution — s1-c5)

**Important note about the skill catalog:** The contract's s1-c3 lists 14 skill names. The repo currently has 15 skills, and the contract list is the FORWARD-LOOKING catalog (includes skills like `bober.verify`, `bober.debug`, `bober.code-review`, `bober.diagnose`, `bober.runbook`, `bober.deploy`, `bober.postmortem` that are created in later sprints). Several skills currently in the repo (`bober.anchor`, `bober.brownfield`, `bober.graph`, `bober.impact`, `bober.onboard`, `bober.playwright`, `bober.react`, `bober.solidity`) are NOT in the contract's list. **Use the contract's list verbatim** — it's the forward-looking discipline catalog. Mark not-yet-built skills with a `(planned)` annotation so the model doesn't try to invoke them in Sprint 1.

---

## 2. Patterns to Follow

### Pattern 1: The `escape_for_json` bash function (VERBATIM)
**Source:** `/tmp/superpowers/hooks/session-start`, lines 22-31
```bash
# Escape string for JSON embedding using bash parameter substitution.
# Each ${s//old/new} is a single C-level pass - orders of magnitude
# faster than the character-by-character loop this replaces.
escape_for_json() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"
    s="${s//$'\r'/\\r}"
    s="${s//$'\t'/\\t}"
    printf '%s' "$s"
}
```
**Rule:** Port this function verbatim. It is hot (runs every session start) and the parameter-substitution form is orders of magnitude faster than a char-by-char loop. The contract explicitly requires this exact technique (NOT jq, NOT a loop).

### Pattern 2: Printf-based JSON emission (NOT heredoc)
**Source:** `/tmp/superpowers/hooks/session-start`, lines 46-55
```bash
if [ -n "${CURSOR_PLUGIN_ROOT:-}" ]; then
  printf '{\n  "additional_context": "%s"\n}\n' "$session_context"
elif [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -z "${COPILOT_CLI:-}" ]; then
  printf '{\n  "hookSpecificOutput": {\n    "hookEventName": "SessionStart",\n    "additionalContext": "%s"\n  }\n}\n' "$session_context"
else
  printf '{\n  "additionalContext": "%s"\n}\n' "$session_context"
fi
```
**Rule:** Use `printf`, NOT heredoc. Bash 5.3+ has a heredoc hang bug under specific subshell conditions (github.com/obra/superpowers/issues/571). The evaluator does not check the bash version directly, but `time bash hooks/session-start` must complete in <500ms (s1-c4); a heredoc hang would fail that.

### Pattern 3: Repo bash script conventions
**Source:** `/Users/bober4ik/agent-bober/scripts/check-prereqs.sh`, lines 1-21
```bash
#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# check-prereqs.sh — Validate prerequisites for a bober command
#
# Usage:
#   check-prereqs.sh <command> [project-root]
#
# Output: JSON with status and missing items
# ──────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
```
**Rule:** This repo's bash style uses:
- `#!/usr/bin/env bash` (NEVER `/bin/bash`)
- A box-drawing-character banner comment with name + one-line purpose
- `set -euo pipefail`
- `SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"` (note the `${BASH_SOURCE[0]}` form — works when sourced)

For `hooks/session-start`, the superpowers reference uses the simpler `$(dirname "$0")` form. Either form works; the contract's reference is the superpowers one. **Match superpowers' shape (`$(dirname "$0")`) since the script is invoked directly, never sourced.**

### Pattern 4: Existing skill frontmatter (bober convention)
**Source:** `/Users/bober4ik/agent-bober/skills/bober.plan/SKILL.md`, lines 1-12
```yaml
---
name: bober.plan
description: Transform a feature idea into a comprehensive plan with sprint contracts, clarifying questions, and acceptance criteria.
argument-hint: <feature-description>
handoffs:
  - label: "Start Building"
    command: /bober-sprint
    prompt: "Execute the first sprint from the plan"
---
```
**Rule:** Bober skills typically include `argument-hint` and `handoffs`. For `bober-using-bober`, those fields are NOT useful (the skill is auto-injected, not user-invoked), so OMIT them. Follow the simpler superpowers shape.

### Pattern 5: Verbatim voice — `<EXTREMELY-IMPORTANT>` block (DO NOT SOFTEN)
**Source:** `/tmp/superpowers/skills/using-superpowers/SKILL.md`, lines 10-16
```markdown
<EXTREMELY-IMPORTANT>
If you think there is even a 1% chance a skill might apply to what you are doing, you ABSOLUTELY MUST invoke the skill.

IF A SKILL APPLIES TO YOUR TASK, YOU DO NOT HAVE A CHOICE. YOU MUST USE IT.

This is not negotiable. This is not optional. You cannot rationalize your way out of this.
</EXTREMELY-IMPORTANT>
```
**Rule:** Port this block VERBATIM. The all-caps, the "1% chance," the "not negotiable" framing — all empirically tuned. The contract evaluator notes (s1-c3 + evaluatorNotes) explicitly reject softening. Adapt only `superpowers/skills` → `bober skills` if you reference skills by name.

### Pattern 6: Red Flags table (rationalization-prevention)
**Source:** `/tmp/superpowers/skills/using-superpowers/SKILL.md`, lines 78-95
```markdown
## Red Flags

These thoughts mean STOP—you're rationalizing:

| Thought | Reality |
|---------|---------|
| "This is just a simple question" | Questions are tasks. Check for skills. |
| "I need more context first" | Skill check comes BEFORE clarifying questions. |
| "Let me explore the codebase first" | Skills tell you HOW to explore. Check first. |
| "I can check git/files quickly" | Files lack conversation context. Check for skills. |
| ... | ... |
```
**Rule:** Port the table verbatim. Up-to-date prose for the "Reality" column may reference bober-specific paths (e.g., `.bober/` artifacts) but the row count and structure must match the source. The contract for THIS sprint (s1-c3) does not explicitly require all rows, but the spec's feat-0 AC3 (downstream sprint criteria) says "Red Flags list >=5 items" — port at minimum 8-10 rows to be safe.

### Pattern 7: Iron Law convention declaration
**Source:** Inferred from spec feat-0 AC3 + verbatim voice mandate. The bootstrap should DECLARE that "Iron Laws" are how bober skills express non-negotiable rules. Example phrasing (adapt verbatim from superpowers idiom):
```markdown
## The Iron Law

When a bober skill states an "Iron Law," it is non-negotiable. Iron Laws are always capitalized, marked with **IRON LAW:** or wrapped in `<EXTREMELY-IMPORTANT>` tags. You do not work around an Iron Law. You do not rationalize an exception. You follow it exactly.
```
**Rule:** The grep target for s1-c3 is the literal string `Iron Law`. Include it explicitly. The body should also DEFINE what Iron Law means so downstream skills (created in later sprints) can reference "Iron Law" expecting the model to know what that means.

### Pattern 8: MIT attribution block
**Source:** spec assumptions: "obra/superpowers is MIT-licensed; verbatim prose port is permitted with inline attribution on every ported file"
```markdown
## Attribution

Structural pattern and voice ported from [obra/superpowers](https://github.com/obra/superpowers) (MIT licensed). Adapted for the agent-bober skill catalog.
```
**Rule:** s1-c5 grep targets are `obra/superpowers` AND `MIT`. Both must appear in the file. A single block at the bottom of the SKILL.md is sufficient. Also add a top-of-file comment to `hooks/session-start`: `# Structural pattern from obra/superpowers (MIT). https://github.com/obra/superpowers`

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `json_output` | `scripts/common.sh:7-11` | `json_output <status> <message>` | Emits `{"status":...,"message":...}` — too primitive for the JSON shape we need here; don't try to reuse |
| `find_project_root` | `scripts/common.sh:14-25` | `find_project_root [dir]` | Walks up for `bober.config.json` — the hook should use the simpler `$(cd "$(dirname "$0")/.." && pwd)` pattern from superpowers instead, since the hook lives at a known path relative to the script |
| `check_file` | `scripts/common.sh:28-36` | `check_file <name> <path>` | Not relevant — different output shape |
| `escape_for_json` | NEW (to be created in this sprint) | `escape_for_json <string>` | Bash parameter-substitution JSON escaper — port verbatim from superpowers |

**Critical guardrail:** Do NOT `source scripts/common.sh` from `hooks/session-start`. The hook should be standalone (works even if the repo is checked out shallow or if common.sh is missing). The superpowers reference has zero dependencies; preserve that property.

**Critical guardrail:** Do NOT use `jq` in the hook. The evaluator (evaluatorNotes) will reject the sprint if `jq` is invoked. JSON emission is via printf only.

---

## 4. Prior Sprint Output

This is Sprint 1 of 28. **dependsOn: []** — no prior sprint output to integrate.

The closest precedent is the abandoned spec `spec-20260524-superpowers-port` (status='abandoned' per the new spec's resolved clarifications). Its 8 contracts are kept on disk for reference; this sprint absorbs its goals into Tier 0. **Do not read or import from that spec's contracts** — they are superseded.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` found at `/Users/bober4ik/agent-bober/.bober/`. (The `principles/` directory inside `.bober/` does not exist; the repo has a `skills/bober.principles/` skill instead.) No project-wide principles file blocks or guides this sprint.

### Architecture Decisions
`.bober/architecture/` exists in the gitStatus as untracked. Not relevant to this sprint (no ADRs about hooks or bootstrap mechanics).

### Other Docs
- `README.md` exists at repo root. Not required reading for this sprint; nothing in it specifies hook conventions.
- **CRITICAL:** `AGENTS.md` does NOT yet exist at the repo root. The bootstrap SKILL.md must reference it (s1-c3 grep target: `AGENTS.md`) but with the phrasing "See AGENTS.md at the repo root for the contributor discipline" — the file is created in a later sprint (the contract notes "placeholder OK — Sprint 6 creates the file" but the spec's actual feat-1 AC3 says AGENTS.md is created in Tier 1). The reference in this skill is forward-looking.

### Spec-level context
- `spec-20260524-bober-vision.json` confirms verbatim-voice port is the explicit choice (Q4 resolution). Do NOT bober-ify the voice ("your human partner" → "the orchestrator" only inside subagent contexts, but this skill is not a subagent context — keep "your human partner" or omit that phrase entirely).
- Q1-Q5 resolutions confirm: MIT attribution required, the structural-pattern source is `obra/superpowers`, the bash conventions follow superpowers env-var detection.

---

## 6. Testing Patterns

### Unit Test Pattern
**Not applicable for this sprint.** No `.test.ts` or `.test.sh` files cover hooks or skill markdown. The contract's verification (s1-c1 through s1-c5) is via shell commands, not test files:

```bash
# s1-c1 verification
bash hooks/session-start | jq .  # must produce valid JSON
test -x hooks/session-start

# s1-c2 verification
jq . hooks/hooks.json

# s1-c3 verification (frontmatter + grep targets)
head -10 skills/bober.using-bober/SKILL.md
grep '<EXTREMELY-IMPORTANT>' skills/bober.using-bober/SKILL.md
grep 'Iron Law' skills/bober.using-bober/SKILL.md
grep 'AGENTS.md' skills/bober.using-bober/SKILL.md
for s in bober.principles bober.plan bober.research bober.architect bober.sprint bober.run bober.eval bober.verify bober.debug bober.code-review bober.diagnose bober.runbook bober.deploy bober.postmortem; do
  grep "$s" skills/bober.using-bober/SKILL.md || echo "MISSING: $s"
done

# s1-c4 verification (warm cache <500ms)
time bash hooks/session-start >/dev/null
time bash hooks/session-start >/dev/null

# s1-c5 verification
grep -E 'obra/superpowers' skills/bober.using-bober/SKILL.md
grep -E 'MIT' skills/bober.using-bober/SKILL.md
```

### Eval Strategy (s1-c6)
The repo's `bober.config.json` defines four required strategies:
```json
{
  "evaluator": {
    "strategies": [
      { "type": "typecheck", "required": true, "command": "npm run typecheck" },
      { "type": "lint",      "required": true, "command": "npm run lint" },
      { "type": "build",     "required": true, "command": "npm run build" },
      { "type": "unit-test", "required": true, "command": "npm run test" }
    ]
  }
}
```
**Run after implementation:** `npm run typecheck && npm run lint && npm run build && npm run test` — all four must exit 0. (Adding three new files — a bash script, a JSON edit, a markdown skill — should not affect TypeScript builds, lint of TS source, or unit tests. If lint covers shell scripts or markdown, check for `.shellcheckrc` or markdownlint config; this repo currently has neither at the top level.)

### E2E Test Pattern
Not applicable.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `hooks/hooks.json` | (the file being modified) | LOW | `jq . hooks/hooks.json` must parse. The two PostToolUse entries must remain byte-identical. |
| `scripts/graph-hook.mjs` | invoked by `hooks/hooks.json` PostToolUse Edit\|Write matcher | LOW (preserve verbatim) | If the matcher entry changes shape, the knowledge-graph stops updating on Edit/Write. Keep flat `{matcher, command}` form for both PostToolUse entries. |
| Claude Code session bootstrap | invokes `hooks/session-start` once registered | MEDIUM | New hook runs on every SessionStart, /clear, /compact. If it errors (exit non-zero), the session-start completes but no `additionalContext` injection happens. `set -euo pipefail` means a missing skill file would fail fast — handle the missing-skill case gracefully (the superpowers reference uses `cat "..." 2>&1 \|\| echo "Error reading"` to swallow failures). |

### Existing Tests That Must Still Pass
- `npm run test` — current vitest suite (paths in `src/**/*.test.ts`). None of these test hooks or skill markdown. Adding new top-level files shouldn't break the test runner. Verify still passes.
- The KPI gate (`scripts/run-kpi-gate.mjs`) — recent commit `371c041 bober(sprint-7): KPI gate script, tests, CI workflow` — runs independently and shouldn't be affected.

### Features That Could Be Affected
- **PostToolUse graph-update hook** (`scripts/graph-hook.mjs` — sprint 8 work, commit `2077a3a`): shares `hooks/hooks.json` with this sprint. If we accidentally reformat or restructure the PostToolUse block, the graph stops updating. Mitigation: edit `hooks.json` by ADDITION, not rewrite. Read it, add the SessionStart sibling, write it back with the PostToolUse block byte-identical.
- **OnboardingComposer** (sprint 9, commit `1a648ae`): unrelated; doesn't touch hooks or skills.
- **AgentGraphPrompts** (sprint 7, commit `7418317`): system-prompt fragments per role. NOT loaded via SessionStart hook — loaded by orchestrator into agent prompts. No collision; bootstrap content is additive context, not a replacement.

### Recommended Regression Checks
After implementation, the Generator MUST verify:
1. `jq . hooks/hooks.json` — parses cleanly
2. `jq '.hooks.PostToolUse' hooks/hooks.json` — returns the two existing entries unchanged
3. `jq '.hooks.SessionStart' hooks/hooks.json` — returns the new entry
4. `test -x hooks/session-start` — script is executable
5. `bash hooks/session-start | jq .` — produces valid JSON; the embedded `additionalContext` (or `additional_context` / `hookSpecificOutput.additionalContext`) contains the skill body
6. `CURSOR_PLUGIN_ROOT=1 bash hooks/session-start | jq -r '.additional_context'` — confirms cursor branch
7. `CLAUDE_PLUGIN_ROOT=1 bash hooks/session-start | jq -r '.hookSpecificOutput.additionalContext'` — confirms claude-code branch
8. `bash hooks/session-start | jq -r '.additionalContext'` — confirms fallback branch
9. `time bash hooks/session-start >/dev/null` (twice) — second run <500ms
10. Frontmatter byte count: `head -10 skills/bober.using-bober/SKILL.md | awk '/^---$/{c++; if(c==2) exit} {print}' | wc -c` — must be <1024
11. All grep targets pass (see Section 6 above)
12. `npm run typecheck && npm run lint && npm run build && npm run test` — all exit 0

---

## 8. Implementation Sequence

1. **Create `skills/bober.using-bober/SKILL.md` first**
   - Frontmatter: `name: bober-using-bober`, description starting with `Use when starting any conversation`
   - Body: `<EXTREMELY-IMPORTANT>` block (verbatim), Iron Law section, full bober.* skill catalog (14 names from the contract), `AGENTS.md` reference, MIT attribution to obra/superpowers, Red Flags table (>=8 rows)
   - **Verify:** `head -n $(awk '/^---$/{c++; if(c==2) {print NR; exit}}' skills/bober.using-bober/SKILL.md) skills/bober.using-bober/SKILL.md | wc -c` → frontmatter under 1024; all 14 skill name grep targets pass; `<EXTREMELY-IMPORTANT>`, `Iron Law`, `AGENTS.md`, `obra/superpowers`, `MIT` all present

2. **Create `hooks/session-start`**
   - Shebang `#!/usr/bin/env bash`, `set -euo pipefail`
   - MIT attribution comment at top
   - `PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"`
   - Read `${PROJECT_ROOT}/skills/bober.using-bober/SKILL.md` with `cat ... 2>&1 || echo "Error reading"`
   - Define `escape_for_json` verbatim (Section 2 Pattern 1)
   - Build `session_context` with `<EXTREMELY_IMPORTANT>` wrap (underscore form, matches superpowers source)
   - Three-branch printf: CURSOR_PLUGIN_ROOT → `additional_context`; CLAUDE_PLUGIN_ROOT && !COPILOT_CLI → `hookSpecificOutput.additionalContext`; else → `additionalContext`
   - `exit 0`
   - `chmod +x hooks/session-start`
   - **Verify:** `test -x hooks/session-start`; `bash hooks/session-start | jq .` parses; `time bash hooks/session-start >/dev/null` (second run) <0.5s

3. **Modify `hooks/hooks.json`**
   - Read current contents, parse, ADD a `SessionStart` key with the nested matcher form, PRESERVE the existing PostToolUse array byte-identical
   - **Verify:** `jq . hooks/hooks.json` parses; `jq '.hooks.PostToolUse' hooks/hooks.json` returns the two original entries unchanged

4. **Run full eval suite**
   - `npm run typecheck && npm run lint && npm run build && npm run test`
   - **Verify:** all four exit 0

5. **Manual cross-platform smoke** (per evaluatorNotes, optional but recommended):
   - `CLAUDE_PLUGIN_ROOT=/Users/bober4ik/agent-bober bash hooks/session-start | jq -r '.hookSpecificOutput.additionalContext' | head -20` — confirms the skill body lands in the right field

---

## 9. Pitfalls & Warnings

- **DO NOT** use `/bin/bash` as the shebang — evaluator (s1-c1, evaluatorNotes) explicitly rejects it. Use `/usr/bin/env bash`.
- **DO NOT** introduce `jq` as a runtime dependency in the hook (only in verification commands). Evaluator explicitly rejects it.
- **DO NOT** use heredoc for JSON output — bash 5.3+ hang bug. Use `printf` (Section 2 Pattern 2).
- **DO NOT** soften the `<EXTREMELY-IMPORTANT>` block, the "1% chance" framing, or the all-caps emphasis in the SKILL.md. Verbatim-voice port is the explicit spec resolution (Q4) and the evaluator (evaluatorNotes) will reject the sprint if softened.
- **DO NOT** change or reorder the two existing PostToolUse Edit|Write entries in `hooks/hooks.json`. They are load-bearing for `scripts/graph-hook.mjs` (the knowledge-graph hook).
- **DO NOT** invent skill names. The catalog in s1-c3 has exactly 14 names; some don't exist as directories yet (they're built in later sprints — annotate `(planned)` so users/models don't try to invoke them in Sprint 1).
- **DO NOT** use `source scripts/common.sh` from the hook. Keep `hooks/session-start` standalone, zero internal deps.
- **DO NOT** name the skill file with the dotted form internally. Directory is `skills/bober.using-bober/`, file is `SKILL.md`, and the frontmatter `name:` field is `bober-using-bober` (hyphenated) per contract s1-c3.
- **DO NOT** forget `chmod +x hooks/session-start`. `test -x` is part of s1-c1 verification.
- **DO NOT** include the legacy-skills-directory warning block from the superpowers reference (lines 11-15 of `/tmp/superpowers/hooks/session-start`). It checks `~/.config/superpowers/skills`, which has no bober analogue. Omit cleanly.
- **DO NOT** assume `AGENTS.md` exists. It doesn't. Reference it forward-looking ("See AGENTS.md at the repo root for the contributor discipline") and trust later sprints to create it.
- **DO** trim frontmatter to keep it under 1024 bytes. The contract verification (s1-c3 verificationMethod) explicitly byte-counts the YAML block. Description should be one line, focused on "when to use" (the convention for Skill tool discoverability).
- **DO** add MIT attribution to BOTH files: a top-of-file comment in `hooks/session-start` and an attribution section in `skills/bober.using-bober/SKILL.md`. s1-c5 only checks the SKILL.md, but the spec's assumptions section says "verbatim prose port is permitted with inline attribution on every ported file."
- **DO** include the bober.* skills currently in the repo that AREN'T in the contract's 14-name catalog (anchor, brownfield, graph, impact, onboard, playwright, react, solidity) as "Existing domain skills" in a separate section if you want — but DO NOT swap them for the contract's catalog. The grep targets in s1-c3 are exhaustive.

---

## 10. Concrete Skeleton — Bober-using-bober SKILL.md (TEMPLATE, NOT VERBATIM)

The Generator should adapt this skeleton, NOT copy-paste it. The voice should match `/tmp/superpowers/skills/using-superpowers/SKILL.md` verbatim where it makes sense:

```markdown
---
name: bober-using-bober
description: Use when starting any conversation - establishes how to find and use bober skills, requiring Skill tool invocation before ANY response including clarifying questions
---

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific task, skip this skill.
</SUBAGENT-STOP>

<EXTREMELY-IMPORTANT>
If you think there is even a 1% chance a skill might apply to what you are doing, you ABSOLUTELY MUST invoke the skill.

IF A SKILL APPLIES TO YOUR TASK, YOU DO NOT HAVE A CHOICE. YOU MUST USE IT.

This is not negotiable. This is not optional. You cannot rationalize your way out of this.
</EXTREMELY-IMPORTANT>

## You Are agent-bober

You are agent-bober, a multi-mode software-engineering teammate. Your behavior is shaped by a catalog of skills, each enforcing a specific discipline. The Iron Law of agent-bober is: **if a skill applies, invoke it. No exceptions.**

## The Iron Law

When a bober skill states an "Iron Law," it is non-negotiable. ...

## Instruction Priority

1. **User instructions** (CLAUDE.md, AGENTS.md, direct requests) — highest priority
2. **Bober skills** — override default system behavior where they conflict
3. **Default system prompt** — lowest priority

See AGENTS.md at the repo root for the contributor discipline ...

## The Bober Skill Catalog

Process and discipline skills:
- `bober.principles` — define and maintain project principles
- `bober.plan` — transform feature ideas into sprint contracts
- `bober.research` — two-phase researcher isolation
- `bober.architect` — 5-checkpoint architecture flow
- `bober.sprint` — execute a single sprint with contract verification
- `bober.run` — full autonomous pipeline
- `bober.eval` — run evaluation strategies
- `bober.verify` (planned) — verification-before-completion discipline
- `bober.debug` (planned) — systematic debugging
- `bober.code-review` (planned) — advisory code review
- `bober.diagnose` (planned) — incident response
- `bober.runbook` (planned) — playbook execution
- `bober.deploy` (planned) — change-management gates
- `bober.postmortem` (planned) — incident timeline synthesis

## Red Flags

| Thought | Reality |
|---------|---------|
| "This is just a simple question" | Questions are tasks. Check for skills. |
| ... (at least 8 rows, ported verbatim) | ... |

## Attribution

Structural pattern and voice ported from [obra/superpowers](https://github.com/obra/superpowers) (MIT licensed). Adapted for the agent-bober skill catalog.
```

The Generator should expand each section to match the depth/voice of the superpowers reference. The skeleton above shows STRUCTURE; the source SKILL.md has the actual prose to port.

---

**End of briefing.**
