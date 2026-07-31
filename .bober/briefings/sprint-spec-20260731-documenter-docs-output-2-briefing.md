# Sprint Briefing: Sync skill/agent surfaces and docs with the mode-aware documenter

**Contract:** sprint-spec-20260731-documenter-docs-output-2
**Generated:** 2026-07-31T00:00:00Z
**Branch:** `bober/documenter-docs-output` (HEAD `9dac508`, sprint-1 docs commit)

> This is a **markdown-surface sprint**. `src/` is frozen (nonGoals[0]). Everything you write must
> mirror semantics that already exist in `src/orchestrator/documenter-agent.ts` — do not invent new
> mode behavior, and do not "fix" the TS while you are here.

---

## 0. The authoritative mode semantics you must mirror

From `src/orchestrator/documenter-agent.ts:74-98` (`resolveSprintDocPath`) — path resolution:

```ts
export function resolveSprintDocPath(config, projectRoot, contractId): string {
  const docsMode = config.documenter?.docsMode ?? "committed";
  const docsDir = config.documenter?.docsDir;
  const fileName = `${contractId}.md`;

  if (docsDir) {                                  // docsDir wins in EVERY mode
    return join(resolveDocsDir(docsDir, projectRoot), fileName);   // -> absolute
  }
  if (docsMode === "external") {
    const projectName = config.project?.name ?? basename(projectRoot);
    return join(homedir(), ".bober", "docs", projectName, "sprints", fileName);
  }
  if (docsMode === "committed") {
    return `docs/sprints/${fileName}`;            // repo-RELATIVE literal (deliberate)
  }
  return join(projectRoot, "docs", "sprints", fileName);   // local default -> absolute
}
```

`resolveDocsDir` (`:47-50`): `~`-prefix expanded via `os.homedir()`, then relative paths joined onto
`projectRoot`; absolute paths honored as-is.

From `src/orchestrator/documenter-agent.ts:150-202` (`buildDocumenterUserMessage`) — the instruction
text per mode. **These are the exact behaviors the three md surfaces must reproduce in prose:**

| Mode | Record path (no `docsDir`) | Commit? | Related-stale-docs? | .gitignore |
|------|---------------------------|---------|---------------------|------------|
| `committed` (default) | `docs/sprints/<contractId>.md`, repo-relative | YES — `git add <doc files> && git commit -m "bober(<contractId>): docs for <short title>"` after verifying with `git status` that no source/test files are staged (`:159-160`) | Grep README.md, docs/**, CLAUDE.md, AGENTS.md, ADRs, module docs and **edit** what is genuinely stale (`:158`) | n/a |
| `local` | `<projectRoot>/docs/sprints/<contractId>.md` (absolute) | **NO** — "Do NOT stage or commit anything, and do NOT invoke any version-control command." (`:190`) | **NO edits** — "If the sprint made an existing doc stale, do NOT edit it — report it in `concerns` instead." (`:189`) | A deterministic TS pre-step (`ensureGitignoreEntry`, `documenter-agent.ts:288-296`) already gitignored the directory. The agent must NOT edit `.gitignore` (`:180`) |
| `external` | `~/.bober/docs/<project.name>/sprints/<contractId>.md` (`project.name` falls back to `basename(projectRoot)`) | **NO** — same prohibition; "This location is outside the project repository entirely — do not attempt any git operation." (`:181`) | **NO edits**, route into `concerns` (`:189`) | n/a (outside the repo) |

Two more facts worth one sentence each in the config reference (contract's CARRY-FORWARD CONCERNS):

- `local` + a `docsDir` **outside** the project root produces a `../…` gitignore entry that git
  cannot act on → **out-of-repo output belongs to `external`** (sprint-1 record, lines 87-89).
- Setting `docsDir` explicitly returns an **absolute** path, which is interpolated into the prompt
  *and* persisted into the git-tracked `.bober/history.jsonl` (`pipeline.ts:627`) — an opt-in
  trade-off (sprint-1 record, lines 84-86; `documenter-agent.ts:56-61`).

The `local`/`external` prompt text deliberately **avoids the literal substrings `git add` and
`git commit`** so tests can assert their absence (`documenter-agent.test.ts:444-460`). Prefer the
same discipline in the md surfaces' non-committed branches: describe "no version-control operation",
do not print an example git command inside the non-committed branch.

---

## 1. Target Files

### `agents/bober-documenter.md` (modify) — 129 lines, canonical agent definition

**Frontmatter (lines 1-12) — do not touch:**
```markdown
---
name: bober-documenter
description: Per-sprint documentation subagent spawned after a sprint's evaluator passes — ...
tools:
  - Read
  - Grep
  - Glob
  - Bash
  - Write
  - Edit
model: opus
---
```

**Section 1 to change — Step 2, lines 62-65 (the hardcoded record path):**
```markdown
## Step 2: Write the sprint documentation record

Write a focused record of this sprint to **`docs/sprints/<contractId>.md`** (create the `docs/sprints/` directory if it does not exist). Keep it tight — this is a durable record, not a transcript:
```
Lines 66-85 (the record template + "If the project already has an established place/format …") are
**record content guidance** — nonGoals[3] forbids rewriting them. Leave them alone.

**Section 2 to change — Step 3, lines 87-101 (related-docs hunt; must become mode-gated):**
```markdown
## Step 3: Find & update related existing docs

This is the higher-value half of your job. The change you just documented likely makes **existing** docs stale. Hunt for them and update them:

1. **Discover candidate docs.** Use Grep/Glob (or the graph tools if granted) to find docs that reference the area you touched:
   - `README.md` and any `docs/**/*.md`
   - `CLAUDE.md`, `AGENTS.md`, and any contributor guides
   - ADRs / architecture docs under `.bober/architecture/` or `docs/`
   - Module-level docs or doc-comments near the changed files
   ...
2. **Update only what is genuinely affected.** ...
```

**Section 3 to change — Step 4, lines 103-112 (unconditional commit):**
```markdown
## Step 4: Commit the docs

Commit only the documentation files you created/edited, separately from the implementation:

```bash
git add <only the doc files you changed>
git commit -m "bober(<sprint-N>): docs for <short sprint title>"
```

Never commit source/test/config changes — you should not have made any. Verify with `git status` before committing that only docs are staged.
```

**Section 4 to change — response JSON example, lines 114-129 (`:121` hardcodes the path):**
```markdown
## Your Response

When done, respond to the orchestrator with EXACTLY this JSON structure (no other text):

```json
{
  "contractId": "<contract ID>",
  "sprintDocPath": "docs/sprints/<contractId>.md",
  "relatedDocsUpdated": [
    {"path": "<path>", "reason": "<why it was stale / what you changed>"}
  ],
  "docsCommit": "<hash> - <message>",
  "concerns": ["<any code/doc issues you noticed but did NOT fix, or empty>"],
  "summary": "<2-3 sentence summary of what you documented and updated>"
}
```
```
Note the TS `local`/`external` JSON template **omits `docsCommit` entirely** and hardcodes
`"relatedDocsUpdated": []` (`documenter-agent.ts:194-201`) — mirror that (e.g. "omit `docsCommit`
and leave `relatedDocsUpdated` empty in non-committed modes").

**PRESERVE VERBATIM (AGENTS.md:122-131 protected content):** the IRON LAW block (lines 27-33) and
the `<EXTREMELY-IMPORTANT>` block (lines 35-37). You may *add* mode-conditional prohibitions in the
same register (the TS uses "Do NOT modify ANY repo file other than …"), never soften existing text.

**Inputs section (lines 43-51)** is where the agent is told what the orchestrator hands it. The
orchestrator now passes a **mode + resolved record path**; the natural place to say "the
orchestrator's prompt tells you the resolved record path and the docs mode; if it does not, assume
`committed` + `docs/sprints/<contractId>.md`" is here or at the top of Step 2.

**Imported by / consumed by:**
- `src/orchestrator/agent-loader.ts` via `assembleSystemPrompt("generator", "bober-documenter", …)`
  (`src/orchestrator/documenter-agent.ts:256`) — the TS pipeline loads this file as the system
  prompt, so contradicting the TS user message here creates a real conflict inside one context.
- `src/cli/commands/init.ts:1091` (`agentFiles` list) and `scripts/update-all.mjs:137-145` copy it
  **verbatim** into `.claude/agents/bober-documenter.md`.

**Test file:** none for this md file's content. Only existence is asserted
(`src/cli/commands/update.test.ts:46`).

---

### `skills/bober.sprint/SKILL.md` (modify) — 511 lines

**Relevant section (lines 380-411, the documenter spawn step; `:402` is the offending line):**
```markdown
4. **Spawn the Documenter subagent — write docs now, while the change is fresh.** The sprint is committed and marked complete; document it per-sprint instead of batching all docs into a final sprint (which goes stale and error-prone). Use the Agent tool:

   ```
   Agent tool call:
     description: "Docs for sprint <N>: <sprint title>"
     subagent_type: bober-documenter
     mode: auto
     prompt: <the prompt below>
   ```

   IMPORTANT: Use `mode: auto` or `mode: bypassPermissions` — the documenter needs write access to create/edit docs and commit them.

   **Documenter prompt:**
   ```
   You are the Bober Documenter subagent. Sprint <N> just PASSED evaluation and was marked complete. Write its documentation and update related docs while the change is fresh.

   Read these from disk:
   - SprintContract: .bober/contracts/<contractId>.json
   - Generator report: .bober/handoffs/gen-report-<contractId>-<iteration>.json
   - Eval result: .bober/eval-results/eval-<contractId>-<iteration>.json
   - .bober/principles.md if it exists

   Then follow your agent instructions: determine what was built from the committed diff, write the sprint record to docs/sprints/<contractId>.md, find & update related existing docs (README, ADRs, CLAUDE.md, module docs) that the change made stale, and commit ONLY the doc files separately. Do NOT modify application code or tests.

   Respond with the JSON structure defined in your agent spec.
   ```

   **After the Documenter returns:**
   - Parse its JSON response. Note `sprintDocPath`, `relatedDocsUpdated`, and any `concerns`.
   - If the documenter crashed or returned an error, do NOT fail the sprint — it already passed. Log `{"event":"sprint-docs-failed","contractId":"...","timestamp":"..."}` and continue. Docs can be regenerated later.
   - If `concerns` is non-empty, surface them in the success report so the user can decide whether to act.
```

**Must keep intact:** the advisory-failure bullet (`:409`) and the `concerns` bullet (`:410`)
(generatorNotes: "Keep the advisory-failure semantics text intact"). Also keep `mode: auto`
(write access is still needed to *write the record*), but the justification "…and commit them" at
`:390` needs mode-aware wording.

**Reporting line that mentions docs (line 427):** `Docs: <sprintDocPath> (+ <count> related docs updated)`
— still correct in all modes (the count is 0 in non-committed modes); no change required.

**Copied to:** `.claude/commands/bober-sprint.md` by `scripts/update-all.mjs` (SKILL.md verbatim +
`references/contract-schema.md` and `references/lens-panel.md` appended). Because references are
**appended**, line numbers 1-511 map 1:1 between the two files (verified: `docs/sprints` appears at
`:402` in both).

**Test file:** none asserting content.

---

### `skills/bober.run/SKILL.md` (modify) — 762 lines

**Relevant section (lines 562-570, same pattern, denser; `:568` is the offending line):**
```markdown
4. **Spawn the Documenter subagent — write docs now, per-sprint, while the change is fresh.** Do NOT defer documentation to a final sprint. Use the Agent tool with `subagent_type: bober-documenter` and `mode: auto`:
   ```
   You are the Bober Documenter subagent. Sprint <N> just PASSED evaluation and was marked complete. Write its documentation and update related docs while the change is fresh.

   Read from disk: .bober/contracts/<contractId>.json, .bober/handoffs/gen-report-<contractId>-<iteration>.json, .bober/eval-results/eval-<contractId>-<iteration>.json, and .bober/principles.md if it exists.

   Follow your agent instructions: determine what was built from the committed diff, write the sprint record to docs/sprints/<contractId>.md, find & update related existing docs (README, ADRs, CLAUDE.md, module docs) made stale by the change, and commit ONLY the doc files separately. Do NOT modify application code or tests. Respond with the JSON structure defined in your agent spec.
   ```
   After it returns: parse the JSON. If it crashed, do NOT fail the sprint (it already passed) — log `{"event":"sprint-docs-failed","contractId":"...","timestamp":"..."}` and continue. Carry any non-empty `concerns` into the milestone print.
```

Other documenter touch-points in this file (leave as-is unless trivially clarifying):
- `:55` flow diagram — `4e. If PASSED: update contract status, log, spawn documenter (per-sprint docs), next sprint`
- `:581` milestone print `Docs: <sprintDocPath> (+ <count> related docs updated)`
- `:74-81` config bootstrap: "Read `bober.config.json` … every later step reads it." — the config is
  already in the orchestrator's context by the time step 3g runs, so the documenter step can simply
  read `documenter.docsMode` / `documenter.docsDir` from it.

**Copied to:** `.claude/commands/bober-run.md` (SKILL.md + `references/lens-panel.md`). Line numbers
1-762 map 1:1 (`docs/sprints` at `:568` in both).

---

### `.claude/agents/bober-documenter.md`, `.claude/commands/bober-sprint.md`, `.claude/commands/bober-run.md` (regenerate — NEVER hand-edit)

**Generation rules (must be byte-identical to `init`):**
- Agents: verbatim copy of `agents/<name>.md` → `.claude/agents/<name>.md`
  (`scripts/update-all.mjs:137-145`; `src/cli/commands/init.ts:1099-1106`).
- Commands: `skills/bober.<x>/SKILL.md` content **plus**, for each `.md` in
  `skills/bober.<x>/references/` in **sorted** order, the separator block
  (`scripts/update-all.mjs:55-71`, mirroring `src/cli/commands/init.ts:1060-1075`):

```js
content += `\n\n---\n\n<!-- Reference: ${refFile} -->\n\n${refContent}`;
```
  Skill dir → command file mapping is derived at runtime: `bober.sprint` → `bober-sprint.md`
  (`scripts/update-all.mjs:41-52`).

**How to regenerate exactly these three, and nothing else (see §9 pitfall 1):**
```bash
# 1. the agent copy (verbatim)
cp agents/bober-documenter.md .claude/agents/bober-documenter.md

# 2. the two command copies (SKILL.md + sorted references, byte-identical to init)
node -e '
const {readFile,writeFile,readdir}=require("fs/promises");const {join}=require("path");
(async()=>{for(const s of ["bober.sprint","bober.run"]){
 let c=await readFile(join("skills",s,"SKILL.md"),"utf-8");
 try{const r=await readdir(join("skills",s,"references"));
  for(const f of r.sort()){if(!f.endsWith(".md"))continue;
   c+=`\n\n---\n\n<!-- Reference: ${f} -->\n\n`+await readFile(join("skills",s,"references",f),"utf-8");}}catch{}
 await writeFile(join(".claude","commands",s.replace(/\./g,"-")+".md"),c,"utf-8");}})()'

# 3. prove zero drift for the three (and no accidental extra writes)
git status --short .claude/
node scripts/update-all.mjs --check .   # see §9 pitfall 1 for how to read this output
npm run update-all:check                # sc-2-3's declared command
```

---

### `README.md` (modify) — the primary config reference

**Annotated jsonc config block, lines 850-858 — extend this block:**
```jsonc
  // -- Documenter (per-sprint docs, on by default) -----
  "documenter": {
    "enabled": true,                      // Spawn a doc subagent after each sprint passes; set false to skip
    "model": "sonnet",                    // Model for the documentation pass
    "maxTurns": 20,                       // Max tool-use turns for the doc pass
    "timeoutMs": 300000,                  // Advisory: a documenter timeout never downgrades the passed sprint
    "provider": "anthropic",              // Optional provider override
    "endpoint": null                      // Custom base URL (for openai-compat)
  },
```
Style rules visible in this block: `// -- Section -----` banner comment; two-space indent inside the
object; trailing `//` comment on nearly every key, **aligned at column 43** (see the `security`
block at `:869-879` for long comments that break the alignment — acceptable when the comment is long).

**Role bullet, line 1318 (one sentence to extend):**
```markdown
- **Documenter** (default: Claude Sonnet): Spawned after a sprint's evaluator returns PASS, while the change is fresh. Writes a concise record ... On by default; configurable via the `documenter` section (set `enabled: false` to skip).
```

**Where the solo-vs-team recipe fits:** README has no prose section dedicated to the documenter. The
lowest-risk, in-style option is a short fenced-jsonc recipe immediately after the documenter block
in the config reference (the `observability` example in VISION.md:315-332 shows the accepted
"table/list + example block" shape). Reuse the three recipes from the sprint-1 record
(`docs/sprints/sprint-spec-20260731-documenter-docs-output-1.md:54-63`):
```jsonc
"documenter": { "docsMode": "committed" }                                  // solo repo (default)
"documenter": { "docsMode": "local", "docsDir": ".bober-docs/sprints" }    // team: on-disk, gitignored
"documenter": { "docsMode": "external" }                                   // team: outside the repo
```

**Test file:** none. (README is asserted only indirectly — no test reads it.)

---

### `VISION.md` (modify — verify first) — 456 lines

`grep -n "documenter\|Documenter" VISION.md` returns **nothing**. VISION.md's
`## Configuration Reference` (lines 290-368) has **no `documenter` section**; it documents only
`pipeline`, `observability`, `incident`, `telemetry`, `evaluator`, `architect`. Its stated contract
(`:292-294`): "Fields are listed below by section, **alphabetically within each section**, with
default values and **the sprint that introduced each field**."

**Exact table format to copy (`VISION.md:354-360`, the `evaluator` section):**
```markdown
### `evaluator` section

| Field | Type | Default | Since | Description |
|-------|------|---------|-------|-------------|
| `evaluator.panel.enabled` | `boolean` | `false` | 0.16.0 | Opt-in multi-lens evaluation. When `true`, ... When `false` (default), behavior is byte-identical to the single-pass evaluator. |
```
So a new `### \`documenter\` section` with rows `documenter.docsDir` then `documenter.docsMode`
(alphabetical) fits cleanly — insert after the `architect` section (`:362-368`) and before the
`---` at `:370`. `Since` values in the newest rows use release numbers (`0.16.0`) or `Sprint N`;
use `0.20.0` only if you also bump it elsewhere — otherwise prefer `Unreleased` and keep CHANGELOG
as the single source of the version. Escape `|` inside the enum cell as `\|` (see `:302`).

---

### `CHANGELOG.md` (modify)

**Insertion point — line 8, the empty `## [Unreleased]` section:**
```markdown
## [Unreleased]

## [0.19.0] — 2026-07-26

### Fixed
...
```

**Entry format (the closest precedent is the 0.17.0 documenter entry, `CHANGELOG.md:50`):**
```markdown
### Added

- **Per-sprint documenter** ([#41](https://github.com/BOBER3r/agent-bober/pull/41)): a new `documenter` agent spawned after a sprint's evaluator returns PASS — ... On by default; configure via the `documenter` config section (`enabled`, `model`, `maxTurns`, `timeoutMs`).
```
Rules: `### Added` / `### Changed` / `### Fixed` H3 under the version; one bullet per feature; bold
lead-in phrase; optional PR link `([#N](https://github.com/BOBER3r/agent-bober/pull/N))` — **omit
the link if you do not know the PR number** rather than guessing; backticked config keys; em-dash
prose; a closing sentence naming the config keys and the default.

---

## 2. Patterns to Follow

### Pattern A — how a SKILL.md gates a step on config (use this shape for the documenter step)
**Source:** `skills/bober.sprint/SKILL.md:145`
```markdown
Check if `curator.enabled` is `true` in `bober.config.json` (default: true). If enabled, spawn a curator subagent ONCE before the first generator attempt to produce a Sprint Briefing.
```
**Source:** `skills/bober.sprint/SKILL.md:286` (multi-value gate with an explicit default)
```markdown
**Panel mode (gated, off by default):** Read `config.evaluator.panel`. If `panel.enabled` is `true` AND `panel.lenses.length >= 2`, run the PANEL flow described in the inlined Lens Panel reference below (`<!-- Reference: lens-panel.md -->`):
```
**Rule:** name the exact config path, state the default in parentheses, then branch — e.g. "Read
`documenter.docsMode` from `bober.config.json` (default `committed`) and `documenter.docsDir`
(optional). Resolve the record path as follows … Only in `committed` mode instruct the documenter to
commit."

### Pattern B — resolved values are computed by the orchestrator and interpolated into the subagent prompt
**Source:** `skills/bober.sprint/SKILL.md:113-114` (handoff assembly)
```markdown
    "commands": { "<commands section from bober.config.json>" },
    "generator": { "<generator section from bober.config.json>" }
```
**Rule:** the skill's orchestrator does the resolution and passes a **concrete** path + policy into
the subagent prompt (`write the sprint record to <resolved record path>`), exactly as the TS does at
`documenter-agent.ts:298-306`. Do not make the documenter subagent read `bober.config.json` itself —
neither the TS prompt nor the agent's Inputs list does that.

### Pattern C — agent-md step structure
**Source:** `agents/bober-documenter.md:53,62,87,103,114` — H2 steps in imperative voice
(`## Step 1: Determine what was built`, `## Step 2: Write the sprint documentation record`, …,
`## Your Response`), fenced templates for output, bold `**path**` for files. Keep the step numbering
stable; if commit becomes conditional, keep it as `## Step 4` with a mode-gated body rather than
deleting the heading (external references to "Step 4" exist in the file's own prose).

### Pattern D — mode-conditional prose register already used in the runtime prompt
**Source:** `src/orchestrator/documenter-agent.ts:178-190`
```ts
const locationNote =
  docsMode === "local"
    ? "This directory is intentionally NOT committed — a deterministic pre-step already ensured it is gitignored. Do NOT edit .gitignore yourself."
    : "This location is outside the project repository entirely — do not attempt any git operation.";
```
**Rule:** reuse these sentences (or near-verbatim variants) in the md surfaces so a reader of either
surface sees the same policy wording. This is also the cheapest way to satisfy sc-2-2's
"forbids editing any repo file except the sprint record".

### Pattern E — generated-copy fidelity
**Source:** `scripts/update-all.mjs:12-16`
```
//   2. Skills/agents     → COPIED into each project's .claude/ by `init`
//      (skills are inlined: SKILL.md + sorted references concatenated into a
//      single .claude/commands/<name>.md).
```
**Rule:** `.claude/**` is a build artifact. Edit canonical `agents/` + `skills/`, then regenerate.
A hand-edit will be detected as drift by `node scripts/update-all.mjs --check <path>`.

### Pattern F — docs prose that already describes the three modes correctly (reuse the wording)
**Source:** `docs/storage.md:155` (written by the sprint-1 documenter — already accurate)
```markdown
| **Sprint doc record** | `docs/sprints/<contractId>.md` (default) | ... **Location and git behavior are configurable** ... via `documenter.docsMode` (`committed` \| `local` \| `external`, default `committed`) and the optional `documenter.docsDir` override, resolved by `resolveSprintDocPath`: `committed` keeps the repo-relative `docs/sprints/<contractId>.md` and the agent commits it; `local` writes inside the repo but **never commits** ...; `external` writes to `~/.bober/docs/<project.name>/sprints/<contractId>.md` — **outside the repo**, with no git operation at all. ... |
```
**Rule:** `docs/storage.md` is already updated — do **not** rewrite it; borrow its phrasing so
README/VISION stay consistent with it.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature / invocation | Purpose |
|---------|----------|------------------------|---------|
| `resolveSprintDocPath` | `src/orchestrator/documenter-agent.ts:74` | `(config, projectRoot, contractId) => string` | The authoritative path resolver — your md prose must describe **this** algorithm, not a new one. |
| `buildDocumenterUserMessage` | `src/orchestrator/documenter-agent.ts:122` | `(DocumenterUserMessageOptions) => string` | The authoritative per-mode prompt text; source of the sentences to mirror. |
| `ensureGitignoreEntry` | `src/utils/git.ts:163` | `(projectRoot, entry) => Promise<boolean>` | Idempotent `.gitignore` append; run by TS in `local` mode. The md surfaces must say the **orchestrator/pre-step** does this, never the agent. |
| `DocumenterDocsModeSchema` / `DocumenterDocsMode` | `src/config/schema.ts:304-305` | `z.enum(["committed","local","external"])` | Canonical enum + spelling of the three mode names. |
| `documenter.docsMode` | `src/config/schema.ts:331` | `DocumenterDocsModeSchema.default("committed")` | Default for the config reference: `committed`. |
| `documenter.docsDir` | `src/config/schema.ts:341` | `z.string().optional()` | Optional; **no default** — say "unset" not "empty string". |
| `npm run update-all` | `package.json:18` → `node scripts/update-all.mjs` | build + re-inline skills/agents into registry targets | The only sanctioned way to refresh `.claude/` copies. |
| `npm run update-all:check` | `package.json:19` → `node scripts/update-all.mjs --check` | dry-run drift report, `process.exitCode = 1` on drift (`update-all.mjs:249`) | sc-2-3's declared verification command. |
| `node scripts/update-all.mjs --check <path>` | `scripts/update-all.mjs:215-219` | explicit-path mode (ignores the registry) | The only way to drift-check **this repo's own** `.claude/` (see §9). |
| `inlineSkill(skillDir)` | `scripts/update-all.mjs:55-71` | SKILL.md + sorted `references/*.md` | The exact inlining format; replicate it if you regenerate by hand. |
| `buildSkillMap()` | `scripts/update-all.mjs:41-52` | `bober.sprint` → `bober-sprint.md` | Skill-dir → command-file naming rule. |
| `installClaudeCommands` | `src/cli/commands/init.ts:994`, refs at `:1060-1075`, agents at `:1084-1106` | — | The init-side copy of the same rule; `update-all` is kept byte-identical to it. |
| Existing accurate mode prose | `docs/storage.md:155`, `docs/sprints/README.md:2449-2465`, `docs/sprints/sprint-spec-20260731-documenter-docs-output-1.md` | — | Already-written descriptions to borrow instead of re-deriving. |

There is **no** utils/ helper to write here — this sprint adds zero code.

---

## 4. Prior Sprint Output

### Sprint 1: Add docsMode/docsDir config keys and mode-aware runDocumenter behavior
**Commits:** `c0d97c5` (implementation) + `4155e53` (committed-default relative-literal fix);
docs commit `9dac508`.
**Created/changed:**
- `src/config/schema.ts` — `DocumenterDocsModeSchema` (`:304`), `documenter.docsMode` (`:331`),
  `documenter.docsDir` (`:341`).
- `src/orchestrator/documenter-agent.ts` — `resolveSprintDocPath` (`:74`),
  `DocumenterUserMessageOptions` (`:103`), `buildDocumenterUserMessage` (`:122`), gitignore pre-step
  in `runDocumenter` (`:281-306`).
- `src/utils/git.ts` — `ensureGitignoreEntry` (`:163`).
- Tests: `src/config/schema.test.ts` (+9), `src/orchestrator/documenter-agent.test.ts` (+14),
  `src/utils/git.test.ts` (+8).
- `docs/storage.md:155` + `docs/sprints/README.md:2449-2465` (written by the sprint-1 documenter).

**Connection to this sprint:** sprint 1 explicitly deferred the prompt surfaces. Its own
"Notes for maintainers" (`docs/sprints/sprint-spec-20260731-documenter-docs-output-1.md:95-99`)
states the exact scope you are closing:
```markdown
- **Prompt surfaces still hardcode the old policy.** `agents/bober-documenter.md`,
  `.claude/agents/bober-documenter.md`, `skills/bober.sprint/SKILL.md` and `skills/bober.run/SKILL.md`
  still say `docs/sprints/<contractId>.md` and commit unconditionally, so the **skill-engine** path
  ignores `docsMode` until sprint 2 syncs them. The user-facing config reference (README / VISION)
  and CHANGELOG are sprint 2 as well; the `bober init` solo-vs-team question is sprint 3.
```
**Do not** implement the `bober init` question — that is sprint 3 (contract `outOfScope`).

---

## 5. Relevant Documentation

### Project Principles
`.bober/principles.md` — **does not exist** in this repo. The governing document is `AGENTS.md`.

### Architecture Decisions
`.bober/architecture/` contains ADRs for other specs; **no ADR exists for
spec-20260731-documenter-docs-output** (the design lives in the contract + sprint-1 record). Nothing
to reconcile.

### AGENTS.md — binding constraints for this sprint
- **Voice discipline (`AGENTS.md:67-69`):** "PRs that soften `EXTREMELY-IMPORTANT` to a weaker tag,
  replace `slop` with 'low-quality,' or substitute 'the user' for 'your human partner' require eval
  evidence… The bar for modifying behavior-shaping content is very high."
- **Protected content (`AGENTS.md:122-131`):** Iron Law blocks in all `agents/bober-*.md`, Red Flags
  tables, Rationalization lists, `EXTREMELY-IMPORTANT` tags.
- **Evidence standard (`AGENTS.md:75`):** every claim cites `file:line`.
- **Verification logs (`AGENTS.md:84-91`):** PRs touching `src/` **or `agents/`** must include the
  output of `npm run typecheck`, `npm run lint`, `npm run build`, `npm test` — this sprint touches
  `agents/`, so paste real output.
- **Skill changes (`AGENTS.md:114-120`):** "Skills are not prose — they are code that shapes agent
  behavior." Justify each edit as *parity with the shipped TS behavior* (that is the evidence), not
  as a style preference.

### Other docs
- `docs/PR-graph-telemetry-and-update-all.md:24` — `update-all` flags reference:
  "`--check` (dry-run drift, nonzero on drift), `--skills-only`, `--discover`, or explicit paths."
- `docs/storage.md:155` — already-correct three-mode description (reuse; do not rewrite).
- `VISION.md:290-294` — the Configuration Reference's own formatting contract.

---

## 6. Testing Patterns

No test asserts markdown-surface content, so this sprint adds **no tests**. The relevant existing
patterns (for regression awareness and for how the shipped semantics are pinned):

### Unit Test Pattern (prompt-content assertions)
**Source:** `src/orchestrator/documenter-agent.test.ts:427-460`
```ts
describe("buildDocumenterUserMessage", () => {
  const baseOptions = { contract: testContract, contractJson: "{}", evalSummary: "{}",
    filesChanged: "- src/a.ts", projectRoot: "/repo/root",
    sprintDocPath: "/repo/root/docs/sprints/test-contract.md" };

  it("committed mode contains the git add AND git commit instruction", async () => {
    const { buildDocumenterUserMessage } = await import("./documenter-agent.js");
    const message = buildDocumenterUserMessage({ ...baseOptions, docsMode: "committed" });
    expect(message).toContain("git add");
    expect(message).toContain("git commit");
  });

  it("local mode contains NEITHER git add nor git commit, and forbids editing other repo files", async () => {
    const { buildDocumenterUserMessage } = await import("./documenter-agent.js");
    const message = buildDocumenterUserMessage({ ...baseOptions, docsMode: "local" });
    expect(message).not.toContain("git add");
    expect(message).not.toContain("git commit");
    expect(message).toMatch(/Do NOT modify ANY repo file/i);
    expect(message).toMatch(/concerns/i);
  });
});
```
**Runner:** vitest 3 (`package.json:115`). **Assertion style:** `expect(...)`.
**Mock approach:** `vi.mock` + dynamic `await import("./x.js")` inside each `it`.
**File naming:** co-located `<module>.test.ts`. **Location:** co-located under `src/`.
**Run command:** `npm test` is `vitest` (**watch mode**) — use `npx vitest run` for a
one-shot suite, and `npx vitest run src/orchestrator/documenter-agent.test.ts` for a targeted run.

### Copy-existence test (the only test that touches `.claude/` layout)
**Source:** `src/cli/commands/update.test.ts:46`
```ts
expect(await exists(join(dir, ".claude/agents/bober-documenter.md"))).toBe(
```
It asserts **existence**, not content — content edits cannot break it, but deleting a canonical
`agents/*.md` would.

### E2E Test Pattern
Not applicable — no Playwright config exercises markdown surfaces.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends on | Risk | What to check |
|------|-----------|------|---------------|
| `.claude/agents/bober-documenter.md` | `agents/bober-documenter.md` (verbatim copy) | **high** | Must be regenerated byte-identically or the drift check fails / plugin users get stale instructions. |
| `.claude/commands/bober-sprint.md` | `skills/bober.sprint/SKILL.md` + `references/{contract-schema,lens-panel}.md` | **high** | Same; regenerate with sorted-reference concatenation. |
| `.claude/commands/bober-run.md` | `skills/bober.run/SKILL.md` + `references/lens-panel.md` | **high** | Same. |
| `src/orchestrator/agent-loader.ts` (`assembleSystemPrompt`) | reads `agents/bober-documenter.md` at runtime (`documenter-agent.ts:256`) | **medium** | The TS pipeline concatenates this file as the system prompt with `buildDocumenterUserMessage`'s user message. If your md text says "always commit" while the user message says "never commit", the agent gets contradictory instructions. Your md must be **mode-conditional**, i.e. compatible with both branches. |
| `src/cli/commands/init.ts:1084-1096` | `agentFiles` list | **low** | Only relevant if a file is renamed/added — you are renaming nothing. |
| `docs/storage.md:155`, `docs/sprints/README.md:2449-2465` | describe the same feature | **low** | Keep new README/VISION wording consistent with them; do not contradict. |

### Existing Tests That Must Still Pass
- `src/orchestrator/documenter-agent.test.ts` — pins `resolveSprintDocPath` branches and the
  per-mode prompt strings. Untouched by md edits, but re-run it: it is the definition of the
  semantics you are describing (if a test disagrees with your prose, the prose is wrong).
- `src/config/schema.test.ts` — `docsMode`/`docsDir` parsing + defaults. Confirms the defaults you
  document (`committed`, `docsDir` unset).
- `src/utils/git.test.ts` — `ensureGitignoreEntry` behavior you describe as the `local` pre-step.
- `src/cli/commands/update.test.ts` — asserts `.claude/agents/bober-documenter.md` is installed.
- `src/orchestrator/pipeline.test.ts:110` — uses `sprintDocPath: "docs/sprints/test-contract.md"`;
  proves the `committed` default literal is load-bearing.
- `src/orchestrator/{lens-panel,arch-lens-panel}-parity.test.ts` and
  `src/orchestrator/security-knowledge/skill-files.test.ts`, `src/seo/skills-content.test.ts` — these
  DO read files under `skills/`. They cover `skills/shared/*` and seo/security skills, **not**
  `bober.sprint`/`bober.run`, so they should be unaffected — but they are the reason to run the full
  suite rather than a targeted subset.

### Features That Could Be Affected
- **Sprint 3 (init solo/team question)** — shares `documenter.docsMode`. Do not pre-implement it;
  do make sure the README/VISION wording you write does not promise an init prompt that does not
  exist yet.
- **TS pipeline documenter (sprint 1)** — shares `agents/bober-documenter.md` as its system prompt.
  Verify by reading both together that a `committed` run and a `local` run each read coherently.
- **Plugin/marketplace surface** — `.claude/**` ships to users (`package.json:55-66` does not include
  `.claude/`, but the plugin manifest and `init`/`update` reproduce it). Stale copies are the exact
  bug CHANGELOG 0.17.0 (`:56`) had to fix; do not repeat it.

### Recommended Regression Checks
1. `npm run typecheck` — expect clean (no `src/` change).
2. `npm run lint` — expect 0 errors (2 pre-existing warnings per the sprint-1 record).
3. `npm run build` — expect clean.
4. `npx vitest run` — expect ~`4988 passed | 1 skipped`; the only known flake is
   `src/medical/recommend/recommend.test.ts` (load-dependent, 8/8 in isolation — re-run it alone
   before reporting a failure).
5. `npm run update-all:check` — sc-2-3's declared command; paste its output verbatim.
6. `node scripts/update-all.mjs --check .` — the real drift check for **this** repo's `.claude/`;
   confirm the three sprint files are **not** listed (see §9 pitfall 1 for the pre-existing noise).
7. `git status --short .claude/` — exactly three modified files, nothing added.
8. `grep -rn "docs/sprints" agents/ skills/ .claude/` — every survivor must be describing the
   **default** (`committed`) location, never an unconditional instruction.
9. `grep -rn "commit ONLY the doc" skills/ agents/ .claude/` — must return nothing ungated.

---

## 8. Implementation Sequence

1. **Read the semantics first** — `src/orchestrator/documenter-agent.ts:74-98` and `:150-202`, plus
   `docs/sprints/sprint-spec-20260731-documenter-docs-output-1.md`. Copy the mode sentences into
   your working notes so the md prose matches the runtime prompt.
   - Verify: you can state, without re-reading, what each mode does to (a) the path, (b) git,
     (c) related stale docs, (d) `.gitignore`.
2. **`agents/bober-documenter.md`** — mode-gate Step 2 (`:64`), Step 3 (`:87-101`), Step 4
   (`:103-112`), and the response JSON (`:121`). Add one line to the Inputs section (`:43-51`)
   saying the orchestrator supplies the resolved record path + docs mode, defaulting to
   `committed` + `docs/sprints/<contractId>.md` when absent. Preserve the Iron Law (`:27-33`) and
   `<EXTREMELY-IMPORTANT>` (`:35-37`) verbatim.
   - Verify: `grep -n "docs/sprints\|git add\|git commit" agents/bober-documenter.md` — each hit is
     inside an explicitly `committed`-mode branch or labelled as the default.
3. **`skills/bober.sprint/SKILL.md:380-411`** — insert the config read + resolution before the Agent
   tool call (Pattern A), interpolate the resolved path + commit policy into the documenter prompt
   (Pattern B), and keep the advisory-failure/`concerns` bullets (`:409-410`) untouched. Adjust the
   `mode: auto` rationale at `:390` so it no longer says "and commit them" unconditionally.
   - Verify: the step now names `documenter.docsMode` and `documenter.docsDir`, states the
     `committed` default, and describes all three modes.
4. **`skills/bober.run/SKILL.md:562-570`** — the same change in this file's denser, single-paragraph
   style. Keep it terser than bober.sprint (that is this file's voice) but semantically identical.
   - Verify: `diff`-read the two documenter steps side by side; no contradiction between them.
5. **Regenerate the three `.claude/` copies** using the recipe in §1 (`cp` for the agent, the
   inline-with-sorted-references node one-liner for the two commands).
   - Verify: `node scripts/update-all.mjs --check .` no longer lists `bober-documenter.md`,
     `bober-sprint.md`, or `bober-run.md`; `git status --short .claude/` shows exactly 3 `M` lines.
6. **`README.md`** — extend the `documenter` jsonc block (`:850-858`) with `docsMode` + `docsDir`
   (aligned trailing comments), add the solo-vs-team recipe block right after it, and extend the
   Documenter role bullet (`:1318`) with one clause naming `docsMode`.
   - Verify: `grep -n "docsMode" README.md` returns the config block, the recipe, and the role bullet.
7. **`VISION.md`** — add `### \`documenter\` section` after the `architect` table (`:368`) with rows
   for `documenter.docsDir` and `documenter.docsMode` (alphabetical), `Default` column
   (`unset` / `` `'committed'` ``), a `Since` value, and `\|`-escaped enum values. Include the
   two carry-forward sentences (out-of-repo output belongs to `external`; explicit `docsDir` puts an
   absolute path into `history.jsonl`).
   - Verify: table renders with 5 columns; `grep -c "^|" VISION.md` increases by exactly the rows added.
8. **`CHANGELOG.md`** — add `### Added` under `## [Unreleased]` (`:8`) with one bullet in the 0.17.0
   documenter-entry style, naming `documenter.docsMode` (`committed`|`local`|`external`, default
   `committed`) and `documenter.docsDir`, and noting the default is unchanged.
   - Verify: `## [Unreleased]` is no longer empty; no version number invented, no fake PR link.
9. **Full verification** — `npm run typecheck && npm run lint && npm run build && npx vitest run`,
   then `npm run update-all:check` and `node scripts/update-all.mjs --check .`, then the greps from
   §7 items 8-9. Paste real output (AGENTS.md:84-93).

---

## 9. Pitfalls & Warnings

1. **`npm run update-all:check` passes trivially on this machine — it is NOT a real drift check
   here.** `scripts/sync-targets.json:7-12` lists four `/Users/bober4ik/...` paths that do not exist
   on this box, so every target is `skipped` and the script reports
   `Drift check complete: 0 file(s) out of date across 4 project(s)` with exit 0 (verified). The
   contract still declares this as sc-2-3's command — run it and paste it — **but also** run
   `node scripts/update-all.mjs --check .` to actually verify this repo's own `.claude/`.
   Do **not** edit `scripts/sync-targets.json`; it is another maintainer's machine registry.
2. **This repo's `.claude/` already has PRE-EXISTING drift. Do not "fix" it.** Verified baseline of
   `node scripts/update-all.mjs --check .`: `bober-plan.md` drifts, and 11 command copies
   (`bober-seo*.md`) + 2 agent copies (`bober-seo-strategist.md`, `bober-seo-verifier.md`) are
   **missing** entirely. Running the write mode (`node scripts/update-all.mjs [--skills-only] .`)
   would create/rewrite **14 files** far outside `estimatedFiles` — scope creep the evaluator will
   flag. Regenerate only the three files this sprint owns (recipe in §1), and mention the
   pre-existing drift in your report/concerns instead of touching it.
3. **`.claude/**` is generated. Never hand-edit it.** Also never edit only the copy and forget the
   canonical file — the canonical `agents/` + `skills/` files are what ship on npm
   (`package.json:55-66` includes `skills/` and `agents/`, not `.claude/`).
4. **Command copies are `SKILL.md` + `references/*.md` appended in SORTED order.** `update-all.mjs:62`
   sorts (`refFiles.sort()`); `init.ts:1065` does not. For `bober.sprint`
   (`contract-schema.md`, `lens-panel.md`) and `bober.run` (`lens-panel.md`) alphabetical order is
   the natural readdir order, so both produce the same bytes today — but replicate the **sorted**
   form so `--check` agrees.
5. **Do not soften protected voice.** Iron Law / `<EXTREMELY-IMPORTANT>` / Red Flags /
   Rationalization content is protected by `AGENTS.md:122-131`. Add mode-conditional prohibitions in
   the same imperative register (`Do NOT ...`); never downgrade an existing directive to make room
   for a conditional.
6. **`src/` is frozen (nonGoals[0]).** No behavior change, no "while I'm here" refactor. The only
   tolerable `src/` touch would be an unavoidable doc-comment correction — and you almost certainly
   do not need one: `documenter-agent.ts:216-220`'s JSDoc still narrates the `committed` flow as if
   it were unconditional, which is a legitimate **concern to report**, not a fix to make.
7. **Do not rewrite record-content guidance.** nonGoals[3]: only *where the record goes* and
   *whether it is committed* changes. `agents/bober-documenter.md:66-85` (the record template) and
   Step 1 (`:53-60`) stay as they are.
8. **Keep the advisory-failure semantics.** `skills/bober.sprint/SKILL.md:409` and
   `skills/bober.run/SKILL.md:570` — a documenter crash never fails an already-passed sprint. Do not
   reword these while restructuring the surrounding step.
9. **`committed` mode's default path is a repo-RELATIVE literal on purpose.** Never document it as
   absolute. Sprint-1 iteration 1 was rejected for making it absolute because it lands in the
   git-tracked `.bober/history.jsonl` (`documenter-agent.ts:56-61`; sprint-1 record `:78-83`).
10. **In non-committed modes, avoid printing example `git add` / `git commit` lines** even as
    "forbidden" examples — the runtime prompt deliberately omits both substrings so tests can assert
    their absence (`documenter-agent.test.ts:444-460`). Mirror that discipline in the md branches.
11. **`npm test` is `vitest` in WATCH mode** (`package.json:17`). Use `npx vitest run` in a
    non-interactive session or you will hang.
12. **VISION.md has no `documenter` section today** (grep confirms zero hits). You are creating one —
    honor the section's own contract (`VISION.md:292-294`): alphabetical fields, defaults, and a
    `Since` value; escape `|` inside cells as `\|`.
13. **No invented PR numbers or version bumps.** CHANGELOG entries link PRs only when known; the
    version stays `0.19.0` in `package.json` unless a separate release sprint bumps it — put this
    work under `## [Unreleased]`.
14. **Existing `docs/sprints` mentions that must survive untouched:** `docs/storage.md:155`,
    `docs/sprints/README.md`, `README.md:982/1032/1044/1055`, `COMMANDS.md:2224-2227`,
    `docs/teams.md`, `docs/providers.md` — these are links to actual sprint records or accurate
    default-location prose, not policy instructions.
