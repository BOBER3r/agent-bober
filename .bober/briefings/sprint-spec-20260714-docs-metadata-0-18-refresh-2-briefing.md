# Sprint Briefing: Sync README CLI quick-reference (fleet + 5 commands) and refresh package.json metadata

**Contract:** sprint-spec-20260714-docs-metadata-0-18-refresh-2
**Generated:** 2026-07-14T22:40:00Z
**Type:** DOCS/METADATA-ONLY (no `src/`, no `*.test.ts`, no version/name/bin/deps/scripts, no git tags)

---

## 1. Target Files

### `README.md` (modify — CLI quick-reference section only)

The CLI quick-reference spans two code blocks separated by the Chat Steer table:

**Block A — original commands (`README.md:507-523`)**, a fenced ```bash``` block. Style = one `npx agent-bober <cmd>  # inline description` line per command, padded so the `#` comments line up:
```bash
npx agent-bober init [preset]                            # Initialize project (with provider selection)
npx agent-bober plan "feature"                           # Run the planner (also materializes sprint contracts)
npx agent-bober run "feature"                            # Full autonomous loop
npx agent-bober chat                                     # Interactive chat REPL (roster + memory aware)
npx agent-bober mcp                                      # Start MCP server (Cursor/Windsurf)
```

**Block B — "New Commands (Sprints 9-25)" (`README.md:546-633`)**, the block to EXTEND. It opens with a deferral line the Generator should mirror:
> `The following commands were added after the initial release. Full reference in [COMMANDS.md](./COMMANDS.md).` (`README.md:548`)

Inside the fenced ```bash``` block (starts `README.md:550`, closes `README.md:633`), commands are grouped under `# comment` headers, each command a `npx agent-bober <cmd>  # description` line. Existing groups: Checkpoint approval (551), Incident response (558), Rollback (565), Postmortem (569), Playbooks (573), Medical team (578), Vault (590), Priority hub (593), Task inbox (598), Do-bridge (608), Calendar planner (614), Research scheduler (620), Security audit (631).

**What is MISSING from Block B** (cross-checked against `src/cli/index.ts:119-360` registrations + `src/fleet/index.ts`):
- The whole **fleet** family: `fleet <manifest>`, `fleet expand`, `fleet expand-deep` (registered via `registerFleetCommand` at `src/cli/index.ts:342`, defined in `src/fleet/index.ts`).
- **config** (`registerConfigCommand`, `src/cli/index.ts:312`)
- **telemetry** (`registerTelemetryCommand`, `src/cli/index.ts:315`)
- **worktree** (`registerWorktreeCommand`, `src/cli/index.ts:318`)
- **memory** (`registerMemoryCommand`, `src/cli/index.ts:321`)
- **facts** (`registerFactsCommand`, `src/cli/index.ts:324`)

**Stale entries?** None. Every command shown in Block A/B still has a live registration in `src/cli/index.ts:119-360`. The Generator must ONLY ADD lines — non-goal #4 forbids removing/reordering existing entries.

**Imported by / test file:** README.md is docs; no test snapshots it. Add the new lines; do not reflow existing ones.

---

### `package.json` (modify — `description` and `keywords` fields ONLY)

**Current `description` (`package.json:4`), verbatim:**
```
Multi-agent harness for building applications autonomously with any LLM. Researcher, Planner, Curator, Generator, Evaluator, Documenter pipeline. Supports Claude, GPT, Gemini, DeepSeek, Ollama, and Claude Code subscriptions. MCP server for Cursor/Windsurf.
```

**Current `keywords` (`package.json:21-36`), verbatim:**
```json
["agent","harness","multi-agent","autonomous","generator-evaluator","claude-code","cursor","mcp","claude","openai","gemini","deepseek","ollama","plugin"]
```

**What is stale/missing vs the 0.18.0 surface:** the description/keywords predate the security-audit gate+CLI, the fleet orchestrator, and the knowledge-platform (medical/vault/hub) surfaces — none are advertised. Edit ONLY these two fields; everything else in the file (`version:"0.18.0"` line 3, `name` line 2, `bin` 8-10, `scripts` 11-20, `dependencies` 62-77, `peerDependencies` 78-81) stays byte-identical (non-goal #3, sc-2-4).

---

## 2. Patterns to Follow

### README quick-reference line style
**Source:** `README.md:551-556`
```bash
# Checkpoint approval (careful-flow mode)
npx agent-bober list-approvals                        # List pending checkpoints
npx agent-bober approve <checkpointId>                # Approve a checkpoint
npx agent-bober reject <checkpointId>                 # Reject a checkpoint
```
**Rule:** Add each new group as a `# GroupName` comment header followed by `npx agent-bober <cmd> [<args>]  # one-line description`, with the `#` comments roughly aligned. Keep descriptions terse and end the group with a pointer to COMMANDS.md (the block already carries the global "Full reference in COMMANDS.md" at `README.md:548`, so a short "full reference in COMMANDS.md" note per group, or relying on the block-level pointer, both satisfy sc-2-2's "defers to COMMANDS.md").

### package.json field edit style
**Source:** `package.json:21-36` — keywords is a flat JSON string array, one element per line, 2-space indent. Append new strings AFTER `"plugin"` (keep every existing keyword — sc-2-3 requires the four new ones be *added*, not replace). Maintain valid JSON (trailing comma discipline, closing `]`).

---

## 3. Exact copy for the missing README entries (transcribed from source `.description()` strings)

Use these verbatim descriptions (do NOT invent flags — sc-2-5). Full option lists belong in COMMANDS.md, not the README.

**Fleet family** — model wording on `src/fleet/index.ts` and COMMANDS.md `## Fleet Commands` (`COMMANDS.md:290`):
| Command | Source `.description()` | Cite |
|---|---|---|
| `fleet <manifest>` | Run a fleet of agent-bober children from a manifest | `src/fleet/index.ts:571-572` |
| `fleet expand <goal>` | Decompose a goal into a fleet manifest and optionally run it | `src/fleet/index.ts:525-526` |
| `fleet expand-deep <goal>` | Robustly decompose a large/ambiguous goal (two-stage plan-then-expand) into a fleet manifest and optionally run it | `src/fleet/index.ts:477-480` |

Suggested README lines (fleet group):
```bash
# Fleet orchestrator (spawn N isolated agent-bober children in bulk)
npx agent-bober fleet <manifest>                   # Run a fleet of agent-bober children from a manifest
npx agent-bober fleet expand <goal>                # Decompose a goal into a fleet manifest and optionally run it
npx agent-bober fleet expand-deep <goal>           # Two-stage decompose a large/ambiguous goal into a manifest, optionally run it
# Full reference in COMMANDS.md (Fleet Commands)
```

**Config / telemetry / worktree / memory / facts** — parent `.description()` strings:
| Command | Source `.description()` | Cite |
|---|---|---|
| `config` (+ `config migrate`) | Inspect and migrate bober.config.json | `src/cli/commands/config.ts:23-24` (migrate: `:27-28`) |
| `telemetry` (status/purge/export) | Inspect, export, or purge local telemetry events (opt-in, local-only) | `src/cli/commands/telemetry.ts:31-32` |
| `worktree` (worktree run) | Launch and manage worktree-isolated pipeline runs | `src/cli/commands/worktree.ts:25-26` (run: `:29-32` "Run the full Bober pipeline in an isolated git worktree on a new branch") |
| `memory` (distill/list/show/prune) | Inspect and distill self-improvement lessons (distill, list, show) | `src/cli/commands/memory.ts:65-66` |
| `facts` (add/list/show/invalidate) | Inspect and manage semantic bi-temporal facts (add, list, show, invalidate) | `src/cli/commands/facts.ts:56-58` |

Suggested README lines (introspection group):
```bash
# Config, telemetry & introspection
npx agent-bober config [migrate]                   # Inspect and migrate bober.config.json (full reference in COMMANDS.md)
npx agent-bober telemetry <status|purge|export>    # Inspect, export, or purge local telemetry events (opt-in, local-only)
npx agent-bober worktree run <task>                # Run the full Bober pipeline in an isolated git worktree on a new branch
npx agent-bober memory <distill|list|show|prune>   # Inspect and distill self-improvement lessons (full reference in COMMANDS.md)
npx agent-bober facts <add|list|show|invalidate>   # Inspect and manage semantic bi-temporal facts (full reference in COMMANDS.md)
```
Subcommand descriptions if the Generator wants finer lines (all verbatim from source): config migrate = "Add all new schema fields with default values to bober.config.json" (`config.ts:28`); telemetry status/purge/export = `telemetry.ts:37/107/138`; memory distill/list/show/prune = `memory.ts:71/114/163/212`; facts add/list/show/invalidate = `facts.ts:64/149/210/260`.

---

## 4. Recommended package.json edits

**Description (recommended, concise, names the new surfaces — mentions security auditing + fleet orchestration per sc-2-3, plus knowledge platform):**
```
Multi-agent, multi-provider harness for building software autonomously with any LLM. Researcher, Planner, Curator, Generator, Evaluator, Documenter pipeline with a fail-closed security-audit gate, a fleet orchestrator for bulk multi-agent runs, and a cross-domain knowledge platform (medical, vault, priority hub). Supports Claude, GPT, Gemini, DeepSeek, Ollama, and Claude Code subscriptions. MCP server for Cursor/Windsurf.
```
This satisfies sc-2-3's regex checks: contains `security` and `audit` (`security-audit`), and `fleet`.

**Keywords — append the four required strings AFTER the existing 14 (keep all existing):**
```json
["agent","harness","multi-agent","autonomous","generator-evaluator","claude-code","cursor","mcp","claude","openai","gemini","deepseek","ollama","plugin","security-audit","fleet","incident-response","knowledge-platform"]
```
Each new keyword maps to a real shipped surface: `security-audit` → `src/cli/commands/security-audit.ts` + `docs/security-audit.md`; `fleet` → `src/fleet/index.ts` + `docs/fleet.md`; `incident-response` → `src/cli/commands/incident.ts`; `knowledge-platform` → `docs/knowledge-platform.md` (hub/vault/medical modules). Non-goal #5: do NOT add other keywords.

---

## 5. Relevant Documentation

- **`.bober/principles.md`** — not read for this docs sprint; the operative constraints are the contract's non-goals (docs/metadata only).
- **`COMMANDS.md`** (Sprint 1 output, verified present): `## Fleet Commands` at `COMMANDS.md:290` (`### agent-bober fleet <manifest>` :299, `fleet expand` :372, `fleet expand-deep` :427) and `## Configuration & Introspection Commands` at `COMMANDS.md:892` (`### bober config` :897, `telemetry` :909, `worktree` :922, `memory` :935, `facts` :950). The README "see COMMANDS.md" pointers reference REAL sections — safe to defer.
- **README convention:** quick-reference lists commands tersely and defers full option detail to COMMANDS.md (`README.md:548`). Do NOT duplicate COMMANDS.md's full option tables into the README.

---

## 6. Testing Patterns

No unit tests apply — this is a docs/metadata sprint touching only `README.md` and `package.json`.

**Verification is via build + grep + node one-liners** (from the contract):
- `npm run build` (tsc) must exit 0 (sc-2-6) — it will, since no `src/` change.
- `grep -cE "agent-bober fleet (<manifest>|expand)" README.md` returns ≥ 2 (sc-2-1).
- Each of `config`, `telemetry`, `worktree`, `memory`, `facts` appears in an `agent-bober` usage line in the CLI block (sc-2-2).
- `node -e "const p=require('./package.json'); ['security-audit','fleet','incident-response','knowledge-platform'].forEach(k=>{if(!p.keywords.includes(k))process.exit(1)}); if(!/security|audit/i.test(p.description)||!/fleet/i.test(p.description))process.exit(1)"` exits 0 (sc-2-3).
- `node -e "const p=require('./package.json'); if(p.version!=='0.18.0'||p.name!=='agent-bober'||!p.bin['agent-bober'])process.exit(1)"` exits 0 (sc-2-4).
- `git diff --name-only` lists ONLY `README.md` and `package.json` (sc-2-6).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| any `*.test.ts` reading `package.json` | package.json | **low** | `src/discovery/scanner.test.ts:77-131` reads the real package.json but asserts ONLY on `scripts`/`packageManager`/`categorized` (build/test/lint/typecheck/dev) and `allScripts` — NOT on `description` or `keywords`. Editing those two fields does not affect it. Verified: `grep -rn "Multi-agent harness for building" src/` returns nothing; no test snapshots the description or keywords strings. |
| README consumers | README.md | **none** | README is not imported or snapshotted by any test. |

### Existing Tests That Must Still Pass
- `src/discovery/scanner.test.ts` — reads the repo `package.json`; asserts only on scripts. Adding keywords/description keeps it green (do NOT touch `scripts`).
- No test references the `keywords` array of the real package.json (the `keywords` hits in `src/graph/preflight-injector.ts` are an unrelated `CuratorContext.keywords` field, not npm keywords).

### Config paired-parse consideration — N/A
`package.json` is NOT the Zod-validated `bober.config.json`; there is no paired schema/example to keep in sync here (that concern applies to `config migrate`/config schema sprints, not this one).

### Recommended Regression Checks
1. `npm run build` exits 0.
2. `git diff package.json` shows ONLY the `description` line and the `keywords` array changed (no version/name/bin/scripts/deps lines in the diff).
3. `git diff --name-only` == exactly `README.md` and `package.json`.
4. Run the node -e keyword/version checks above.

---

## 8. Implementation Sequence

1. **README.md** — Inside Block B (the "New Commands" ```bash``` block, before its closing ``` at `README.md:633`), add a `# Fleet orchestrator` group (3 lines) and a `# Config, telemetry & introspection` group (5 lines: config, telemetry, worktree, memory, facts). Use the verbatim descriptions from §3. Do not remove or reorder any existing line.
   - Verify: `grep -cE "agent-bober fleet (<manifest>|expand)" README.md` ≥ 2; all five tokens present in `agent-bober` usage lines.
2. **package.json** — Replace the `description` string (`:4`) with the §4 text; append the four keywords after `"plugin"` (`:35`). Nothing else changes.
   - Verify: `node -e` keyword/description check exits 0; `node -e` version/name/bin check exits 0; JSON still parses (`node -e "require('./package.json')"`).
3. **Full verification** — `npm run build` (exit 0) and `git diff --name-only` (only README.md + package.json).

---

## 9. Pitfalls & Warnings

- **Two README code blocks.** The CLI reference is split: original commands (`README.md:507-523`) and "New Commands" (`README.md:550-633`). Add the new groups to the SECOND block (Sprints 9-25 region) per the generatorNotes — that is where deferral-to-COMMANDS.md lives.
- **`bober` vs `agent-bober`.** COMMANDS.md headers say `bober config`, but the README quick-reference uses the full `npx agent-bober <cmd>` form. sc-2-2 requires an `agent-bober` usage line — use `npx agent-bober config ...`, not `bober config`.
- **No fabricated flags (sc-2-5).** Only real subcommands exist: config → `migrate`; telemetry → `status|purge|export`; worktree → `run`; memory → `distill|list|show|prune`; facts → `add|list|show|invalidate`; fleet → `<manifest>|expand|expand-deep`. Do not invent options in the README (full option lists live in COMMANDS.md).
- **package.json: edit ONLY two fields.** The evaluator runs `git diff package.json` and expects only `description` + `keywords` to change. Do not reformat the file, re-sort keys, or touch whitespace elsewhere. Keep 2-space indentation and valid JSON.
- **Keep all 14 existing keywords.** sc-2-3 requires the four new ones be present; non-goal #4-style intent is additive. Appending (not replacing) keeps existing npm discoverability.
- **Do not bump version or create tags** (non-goals #1, #3). `version` stays `0.18.0`.
- **Additive only in README** — the evaluator's git diff should be pure additions (plus the two package.json field edits). Removing/reordering an existing README entry fails the intent of non-goal "Do not remove or reorder existing README CLI entries."
