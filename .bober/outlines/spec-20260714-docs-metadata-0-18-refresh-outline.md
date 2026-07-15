# Structure Outline: Documentation & Metadata Refresh (0.18.0)

**Spec ID:** spec-20260714-docs-metadata-0-18-refresh
**Constraint:** docs + metadata only — no `src/` or `*.test.ts` changes; no git tags.

## Phase 1: Complete the COMMANDS.md CLI reference
**Key Changes:** Add five new `### \`bober <cmd>\`` sections to COMMANDS.md — `config`
(config, config migrate), `telemetry` (status, purge, export), `worktree` (worktree run),
`memory` (distill, list, show, prune), `facts` (add, list, show, invalidate). Descriptions
sourced verbatim-in-intent from each command's `.description()` in `src/cli/commands/*.ts`.
**Files:** COMMANDS.md (only).
**Test Checkpoint:** A completeness check iterating every top-level command registered in
`src/cli/index.ts` + `src/fleet/index.ts` finds a matching `### ` heading in COMMANDS.md
(zero missing). `grep -cE "^### .*\`bober (config|telemetry|worktree|memory|facts)" COMMANDS.md`
returns 5. `npm run build` exits 0. `git diff --name-only` shows only COMMANDS.md.
**Depends On:** nothing.

## Phase 2: Sync README CLI quick-reference + refresh package.json metadata
**Key Changes:** (a) Add the `fleet` family (`agent-bober fleet <manifest>`, `fleet expand`,
`fleet expand-deep`) and one-line entries for config/telemetry/worktree/memory/facts to the
README CLI block, each deferring to COMMANDS.md. (b) Refresh package.json `description` to name
security auditing + fleet + knowledge platform, and add keywords `security-audit`, `fleet`,
`incident-response`, `knowledge-platform`. Version/name/bin/deps/scripts unchanged.
**Files:** README.md, package.json.
**Test Checkpoint:** `grep -E "agent-bober fleet (<manifest>|expand)" README.md` >= 2;
README has `agent-bober` usage lines for config/telemetry/worktree/memory/facts (>= 5);
`node -e "const p=require('./package.json'); if(p.version!=='0.18.0')process.exit(1);
['security-audit','fleet','incident-response','knowledge-platform'].forEach(k=>{if(!p.keywords.includes(k))process.exit(1)})"`
exits 0. `npm run build` exits 0. `git diff --name-only` shows only README.md + package.json.
**Depends On:** Phase 1 (README entries point to the COMMANDS.md sections added in Phase 1).

## Vertical-slice note

Each phase is an end-to-end, independently demonstrable correction of one doc/metadata surface
(COMMANDS.md; then README + npm metadata), verifiable by grep/JSON checks against the real CLI —
not a horizontal "all headings" vs "all prose" split. Phase 2 depends on Phase 1 only so its
"see COMMANDS.md" pointers reference real sections.
