# Sprint Briefing: Complete the COMMANDS.md CLI reference (config, telemetry, worktree, memory, facts)

**Contract:** sprint-spec-20260714-docs-metadata-0-18-refresh-1
**Generated:** 2026-07-14T18:58:51Z
**Type:** DOCS-ONLY. The only file you may change is `COMMANDS.md`. Do **not** touch any `src/` or `*.test.ts` file. `git diff --name-only` must list `COMMANDS.md` and nothing else.

---

## 0. What "done" looks like (read first)

`COMMANDS.md:3` claims to be the "Complete reference for all `bober` CLI commands." Five registered, non-hidden top-level command groups have **no** section: `config`, `telemetry`, `worktree`, `memory`, `facts`. Add one documentation section per group, using **only** the real subcommands/flags cited below (Section 3 is copy-ready ground truth). Accuracy over completeness — document only what is registered.

**Verified facts (do not re-derive):**
- The five groups have **zero** headings today (`grep -cnE "^#{2,4} .*(bober|agent-bober) (config|telemetry|worktree|memory|facts)\b" COMMANDS.md` → `0`).
- They are the **only** missing top-level commands. Every other command registered in `src/cli/index.ts` and `src/fleet/index.ts` already has a `### ` heading (full cross-check in Section 5). There are **no stale/removed entries** to delete.
- None of the five source files contain `hidden` — all five groups are user-facing.
- COMMANDS.md has **no table-of-contents** to update (it opens with intro prose at `COMMANDS.md:1-14` then jumps straight to `## Core Pipeline Commands`). You only add sections.

---

## 1. Target File

### COMMANDS.md (modify) — insertion only

**Structure (2156 lines).** Intro (`:1-14`) → a series of `## <Group> Commands` H2 sections, each with an intro paragraph and one or more `### bober <cmd>` H3 subsections. Existing H2 groups in order: Core Pipeline (`:16`), Fleet (`:290`), Approval & Checkpoint (`:589`), Incident Response (`:642`), Rollback (`:717`), Postmortem (`:733`), Playbook (`:763`), Graph (`:801`), Utility (`:848`), Medical Team (`:871`), Vault (`:1141`), Hub (`:1170`), Task Inbox (`:1293`), Do-Bridge (`:1476`), Calendar (`:1564`), Research (`:1714`), Telegram (`:1910`), Security Audit (`:2055`), then Environment Variables (`:2135`) and Exit Codes (`:2149`).

**Recommended insertion point:** immediately after the **Utility Commands** section (ends at `COMMANDS.md:869`, the `---` before `## Medical Team Commands` at `:871`). Insert a single new H2 group `## Configuration & Introspection Commands` there, followed by the five H3 subsections. Sections are delimited by `---` between groups and by `---`-separated or blank-line-separated H3s within a group. Do **not** reorder or edit any existing section.

**Imported by / TOC:** none — `COMMANDS.md` is documentation, not imported. No TOC or index references the section list.

**Test file:** none (docs file).

---

## 2. Pattern to Follow (heading + format)

The contract points at the Graph/Utility sections as the format to mirror. Two established patterns exist; use the **multi-subcommand group** pattern.

### Pattern A — single command with a fenced usage block
**Source:** `COMMANDS.md:850-867` (`### bober impact` / `### bober onboard`)
```markdown
### `bober impact <target>`

Analyse the impact radius and test coverage of a symbol or file.

```bash
bober impact "UserService"
bober impact "src/auth/jwt.ts"
```
```
**Rule:** H3 backtick-wrapped heading → one-sentence purpose → fenced ```bash usage block with inline `#` comments.

### Pattern B — a group whose subcommands each get an H3 (used by incident, playbook, graph)
**Source:** `COMMANDS.md:763-797` (Playbook) and `COMMANDS.md:801-844` (Graph)
```markdown
## Graph Commands

Graph commands require `graph.enabled: true` ...

### `bober graph init`

Initialize the structural code graph index.

```bash
bober graph init
```

---

### `bober graph sync`

Re-index changed files.

```bash
bober graph sync           # Incremental sync
bober graph sync --force   # Full re-index
```
```
**Rule:** `## <Group> Commands` H2 + intro paragraph, then one `### bober <cmd> <subcmd>` H3 per subcommand, `---`-separated.

### Combined-heading precedent (fewest headings, satisfies all success criteria)
**Source:** `COMMANDS.md:1346` — `### \`bober task start <id>\` · \`bober task done <id>\` · \`bober task drop <id>\``
**Rule:** One H3 can carry several sibling subcommands. This lets you satisfy sc-1-1/sc-1-2 with exactly **one H3 per top-level group** (`### bober config`, `### bober telemetry`, `### bober worktree`, `### bober memory`, `### bober facts`) while listing every subcommand token inside that group's fenced usage block (satisfying sc-1-3). **This is the recommended shape** — it is the cleanest, keeps the five new groups tidy, and each parent (`config`/`telemetry`/`worktree`/`memory`/`facts`) is a pure container with **no own `.action()`**, so `bober <group>` alone just prints help. Do not describe the bare parent as "doing" anything.

> sc-1-1 accepts `### \`bober config\`` **or** `### \`bober config migrate\``. Any of the three shapes above is compliant as long as (a) each of the 5 groups has at least one `### ` heading whose text contains that group name, and (b) every subcommand token from Section 3 appears under it.

---

## 3. Ground Truth — copy-ready content for the five sections

Every line below is transcribed from source. Do **not** add flags or behavior not listed here (sc-1-4).

### 3a. `config` — `src/cli/commands/config.ts`
- Parent group (`config.ts:22-24`): `.command("config")` — description: **"Inspect and migrate bober.config.json"**. No `.action()` (container).
- Subcommand `config migrate` (`config.ts:26-28`): description **"Add all new schema fields with default values to bober.config.json"**.
  - Option `--dry-run` (`config.ts:29`): **"Print the merged config without writing"**.
- Behavior (`config.ts:30-88`): reads `bober.config.json`, merges in default sections (`pipeline`, `observability`, `incident`, `telemetry`) preserving existing values, backs the file up to `bober.config.json.bak`, then writes the merged config. `--dry-run` prints the merged JSON to stdout and writes nothing. If no `bober.config.json` exists it prints a yellow "No bober.config.json found" message and exits non-zero.
- **Subcommand token to include:** `config migrate`.

### 3b. `telemetry` — `src/cli/commands/telemetry.ts`
- Parent group (`telemetry.ts:30-32`): `.command("telemetry")` — description: **"Inspect, export, or purge local telemetry events (opt-in, local-only)"**. No `.action()`.
- `telemetry status` (`telemetry.ts:35-37`): description **"Print whether telemetry is enabled and recent event counts by type"**. No options. Reads `config.telemetry.enabled` and tallies events across `.bober/telemetry/*.jsonl` by `eventType`.
- `telemetry purge` (`telemetry.ts:105-107`): description **"Delete all .bober/telemetry/ files (requires confirmation)"**. No flags — it shows an interactive confirm prompt and only deletes `.bober/telemetry/` on a Yes.
- `telemetry export` (`telemetry.ts:136-138`): description **"Print all telemetry events as JSONL to stdout for offline analysis"**. No options. Concatenates every `.bober/telemetry/*.jsonl` to stdout.
- **Subcommand tokens to include:** `telemetry status`, `telemetry purge`, `telemetry export`.

### 3c. `worktree` — `src/cli/commands/worktree.ts`
- Parent group (`worktree.ts:24-26`): `.command("worktree")` — description: **"Launch and manage worktree-isolated pipeline runs"**. No `.action()`.
- Subcommand `worktree run <task>` (`worktree.ts:29-32`): description **"Run the full Bober pipeline in an isolated git worktree on a new branch"**.
  - Option `--allow-dirty` (`worktree.ts:33-36`): **"Allow worktree creation even when the working tree has uncommitted changes"**.
  - Option `--keep-on-success` (`worktree.ts:37-40`): **"Retain the worktree after a successful pipeline run (default is to clean up)"**.
- Behavior (`worktree.ts:41-84`): requires `bober.config.json` (else red "No bober.config.json found. Run `bober init` first." + exit non-zero); runs the full pipeline in an isolated git worktree on a new branch and prints a JSON result.
- **Subcommand token to include:** `worktree run`.

### 3d. `memory` — `src/cli/commands/memory.ts`
- Parent group (`memory.ts:64-66`): `.command("memory")` — description: **"Inspect and distill self-improvement lessons (distill, list, show)"**. No `.action()`. (The registered description text lists only distill/list/show, but `prune` is also a real subcommand — document all four; do not invent that the description "omits" anything, just list the four registered subcommands.)
- `memory distill` (`memory.ts:69-71`): description **"Distill sprint history into deterministic lessons (idempotent)"**. No options. Prints `distilled N lessons (M new)`.
- `memory list` (`memory.ts:112-114`): description **"Print the bounded lesson index"**.
  - Option `--limit <n>` (`memory.ts:115`): **"Maximum number of lessons to show"**, default **`"50"`**.
- `memory show <lessonId>` (`memory.ts:161-163`): description **"Print one lesson with its sourceEntryRefs provenance"**. No options. (Argument is `<lessonId>`.)
- `memory prune` (`memory.ts:210-214`): description **"Quarantine stale and conflicting lessons from INDEX.md into QUARANTINE.md (never deletes per-lesson .md files)"**. No options.
- **Subcommand tokens to include:** `memory distill`, `memory list`, `memory show`, `memory prune`.

### 3e. `facts` — `src/cli/commands/facts.ts`
- Parent group (`facts.ts:55-59`): `.command("facts")` — description: **"Inspect and manage semantic bi-temporal facts (add, list, show, invalidate)"**. No `.action()`.
- `facts add` (`facts.ts:62-64`): description **"Insert a new semantic fact into the store"**. Options:
  - `--scope <scope>` (`facts.ts:65`, `requiredOption`): **"Fact scope (e.g. programming)"**, default **`"programming"`**.
  - `--subject <subject>` (`facts.ts:66`, `requiredOption`): **"Fact subject (e.g. project)"** — required, no default.
  - `--predicate <predicate>` (`facts.ts:67`, `requiredOption`): **"Fact predicate (e.g. testCommand)"** — required, no default.
  - `--value <value>` (`facts.ts:68`, `requiredOption`): **"Fact value (e.g. vitest)"** — required, no default.
  - `--confidence <n>` (`facts.ts:69`): **"Confidence score 0.0-1.0"**, default **`"1"`** (clamped to 0..1).
  - `--run-id <runId>` (`facts.ts:70`): **"Source run id"** (optional).
- `facts list` (`facts.ts:147-149`): description **"Print active (non-invalidated) facts"**. Options:
  - `--scope <scope>` (`facts.ts:150`): **"Filter by scope"**, default **`"programming"`**.
  - `--subject <subject>` (`facts.ts:151`): **"Filter by subject"** (optional).
  - `--predicate <predicate>` (`facts.ts:152`): **"Filter by predicate"** (optional).
- `facts show <id>` (`facts.ts:208-210`): description **"Print one fact with full provenance and temporal fields"**. No options. (Argument `<id>`.)
- `facts invalidate <id>` (`facts.ts:258-260`): description **"Soft-delete a fact (sets t_invalidated; row is kept)"**. No options. (Argument `<id>`.)
- **Subcommand tokens to include:** `facts add`, `facts list`, `facts show`, `facts invalidate`.

> NOTE (sc-1-4 guardrail): The ONLY flags that exist across all five groups are `config migrate --dry-run`; `memory list --limit`; and `facts add {--scope,--subject,--predicate,--value,--confidence,--run-id}` / `facts list {--scope,--subject,--predicate}` / `worktree run {--allow-dirty,--keep-on-success}`. `telemetry` (all 3 subcommands), `memory {distill,show,prune}`, and `facts {show,invalidate}` have **no** flags. Do not invent any others (e.g. there is no `--json`, no `--namespace`, no `--force` anywhere in these five files).

---

## 4. Prior Sprint Output

None. `dependsOn` is empty (`contract:8`). This is Sprint 1 of `spec-20260714-docs-metadata-0-18-refresh` and stands alone.

---

## 5. Impact Analysis — completeness cross-check & drift

**Files that may break:** none. `COMMANDS.md` is a leaf documentation file imported by nothing; a docs edit cannot break code. The only regression risk is doc-accuracy (documenting a flag that does not exist) and the docs-only invariant (accidentally editing a `src/` file).

**Completeness check for sc-1-2 (already run — every registered top-level command → heading):**

| Registered command | Source | Heading present? |
|---|---|---|
| init, update, plan, sprint, eval, run, mcp | index.ts:104-276 | yes (`:18,38,58,87,109,121,157`) |
| graph, onboard, impact | index.ts:279-285 | yes (`:806+,861,850`) |
| approve, reject, list-approvals, audit | index.ts:288-297 | yes (`:607,621,594,631`) |
| rollback, postmortem, incident, playbook | index.ts:300-309 | yes (`:719,738+,647+,769+`) |
| **config, telemetry, worktree, memory, facts** | index.ts:312-324 | **NO — add these** |
| task, medical, research, calendar, vault | index.ts:327-339 | yes (`:1301+,876+,1729+,1572+,1147`) |
| chat, blackboard, hub, do, telegram, security-audit | index.ts:345-360 | yes (`:167,561+,1178+,1482,1937,2070`) |
| fleet (+ expand / expand-deep) | fleet/index.ts:477,525,571 | yes (`:299,372,427`) |

After adding the five, iterating every registered command name finds zero without a heading.

**Stale/removed entries:** none found. Every H3 heading in COMMANDS.md maps to a live registration.

**Existing tests that must still pass:** No test asserts COMMANDS.md content (it is prose). The only automated gate is `npm run build` (tsc) — which a docs-only change cannot affect but the contract requires you to run to prove exit 0 (sc-1-5). The five `*.test.ts` files (`config.test.ts`, `telemetry.test.ts`, `worktree.test.ts`, `memory.test.ts`, `facts.test.ts`) exist and cover the commands' behavior — do **not** edit them; they must keep passing untouched.

---

## 6. Implementation Sequence

1. **Open `COMMANDS.md`**; locate the end of the Utility Commands section (the `---` at `COMMANDS.md:869`, just before `## Medical Team Commands` at `:871`).
2. **Insert one new H2 block** `## Configuration & Introspection Commands` with a one-line intro (e.g. "Inspect and manage bober's local configuration, telemetry, worktree runs, self-improvement lessons, and semantic facts."), followed by five H3 subsections in this order: `### bober config`, `### bober telemetry`, `### bober worktree`, `### bober memory`, `### bober facts`. Each H3: one-sentence purpose (reuse the parent `.description()` text from Section 3), then a fenced ```bash usage block enumerating that group's subcommands and their real flags with brief inline `#` comments. Use Section 3 verbatim for descriptions/flags.
   - Verify: `grep -cnE "^### .*\`bober (config|telemetry|worktree|memory|facts)" COMMANDS.md` returns ≥ 5 (sc-1-1).
3. **Confirm subcommand tokens** appear under their headings (sc-1-3): `config migrate`; `telemetry status`/`purge`/`export`; `worktree run`; `memory distill`/`list`/`show`/`prune`; `facts add`/`list`/`show`/`invalidate`.
4. **Spot-check flags** against Section 3 — no invented flags (sc-1-4).
5. **Run verification:** `npm run build` (tsc, must exit 0) and `git diff --name-only` (must list only `COMMANDS.md`) — sc-1-5.

---

## 7. Pitfalls & Warnings

- **Docs-only tripwire.** Editing/adding anything under `src/` (including "fixing" a description you think reads awkwardly) breaks sc-1-5. Change **only** `COMMANDS.md`. Descriptions in the doc must match the source `.description()` strings; if source wording is awkward, keep the doc faithful rather than "improving" the source.
- **The parents are containers, not actions.** `bober config` / `telemetry` / `worktree` / `memory` / `facts` have **no** `.action()` — running the bare group prints help. Don't write "`bober config` inspects your config"; write that `config` is a group and `config migrate` does the work.
- **No invented flags.** Only the flags in Section 3 exist. Common temptations that do **not** exist here: `--json`, `--namespace`, `--yes`, `--force`, `--all` on these five. `telemetry`, `memory show/distill/prune`, and `facts show/invalidate` take **no** flags at all.
- **`facts add` required options.** `--subject`, `--predicate`, `--value` are `requiredOption` (must be passed); `--scope` is also `requiredOption` but ships a default (`"programming"`), so in practice only subject/predicate/value must be supplied. Document them as required.
- **`memory` parent description** literally reads "(distill, list, show)" but a fourth subcommand `prune` is registered (`memory.ts:210`). Document all four subcommands; do not copy the parenthetical as if it were the complete list.
- **Group placement only.** Insert the new block cleanly between Utility Commands and Medical Team Commands; do not merge into or reorder existing sections (nonGoal in `contract:48`). Keep the `---` separators consistent with neighbors.
- **No TOC to update** and **no tags/version/README changes** (README + package.json are Sprint 2; VISION/CHANGELOG are out of scope — `contract:61-65`).
