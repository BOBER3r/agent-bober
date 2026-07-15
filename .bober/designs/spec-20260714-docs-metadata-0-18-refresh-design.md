# Design Discussion: Documentation & Metadata Refresh (0.18.0)

**Spec ID:** spec-20260714-docs-metadata-0-18-refresh
**Date:** 2026-07-14
**Status:** reviewed

---

## Current State

Repo is at version 0.18.0 (`package.json:3`). Git tags v0.12.0–v0.18.0 all already exist
(`git tag`), so historical tagging is a no-op and out of scope. CHANGELOG.md already runs through
`[0.18.0] — 2026-06-23` with an `[Unreleased]` section, and recent features (security-audit,
medical/knowledge-platform, fleet, lens panels) already have per-sprint docs under `docs/`.

The drift is confined to the **command-reference docs and npm metadata**:

- **COMMANDS.md** opens by claiming "Complete reference for all `bober` CLI commands"
  (`COMMANDS.md:2`) but has no `### ` section for five registered, non-hidden top-level command
  groups: `config` (`src/cli/commands/config.ts`), `telemetry` (`telemetry.ts`), `worktree`
  (`worktree.ts`), `memory` (`memory.ts`), `facts` (`facts.ts`). Verified absent via
  `grep "bober config|bober telemetry|bober worktree|bober memory" COMMANDS.md` → 0 matches each.
- **README.md** CLI quick-reference (`README.md:507–633`) omits the `fleet` command family
  (`agent-bober fleet <manifest>`, `fleet expand`, `fleet expand-deep` — registered in
  `src/fleet/index.ts:571,525,477`) even though fleet is a first-class feature with its own
  `docs/fleet.md` and a full "Fleet Commands" section in COMMANDS.md. The README's only `fleet`
  mentions are the Telegram `/fleet` view and a docs link (`README.md:628,749,755`). The same five
  commands above are also absent from the README CLI block.
- **package.json** description (`package.json:4`) and keywords (`package.json:21–36`) describe the
  original build-a-feature harness + providers, but omit the security-auditor, fleet orchestrator,
  and knowledge-platform surfaces that ship in 0.18.0.

VISION.md and docs/providers.md were spot-checked and are **current** (VISION.md documents the
0.16.0 lens-panel config at `VISION.md:304,358`; providers.md already covers deepseek/grok/
claude-code/opus at `docs/providers.md:24,48,73`) — excluded from scope.

## Desired End State

- COMMANDS.md contains a `### ` section for `config`, `telemetry`, `worktree`, `memory`, and
  `facts`, each documenting its real subcommands in the same format as neighboring sections. A
  script iterating the registered top-level command list finds zero undocumented commands.
- README.md CLI quick-reference lists the `fleet` command family and one-line entries for the five
  commands, each pointing to COMMANDS.md for full detail (README stays a quick-reference).
- package.json description and keywords advertise the 0.18.0 surface (multi-provider, security
  auditing, fleet orchestration, knowledge platform) while keeping version/name/bin/deps/scripts
  untouched.
- No file under `src/` and no `*.test.ts` changes; `npm run build` still exits 0.

## Patterns to Follow

- `COMMANDS.md:594–642` (Approval & Incident sections) — the `### \`bober <cmd>\`` heading + prose +
  fenced usage + flags format every new COMMANDS.md section must mirror.
- `COMMANDS.md:801–871` (Graph & Utility Commands) — pattern for grouping a multi-subcommand
  command under one heading.
- `README.md:546–633` ("New Commands (Sprints 9–25)") — the `# comment` + `npx agent-bober <cmd>`
  one-line CLI-block pattern the README additions must match.
- `README.md:548` ("Full reference in COMMANDS.md") — the pattern for pointing README entries at the
  exhaustive COMMANDS.md rather than duplicating detail.
- Command sources to read for accurate descriptions (never invent flags): `src/cli/commands/`
  `config.ts`, `telemetry.ts`, `worktree.ts`, `memory.ts`, `facts.ts`, and `src/fleet/index.ts`.

## Resolved Design Decisions

### Q1: scope — Should VISION.md and docs/providers.md be part of this refresh?
**Decision:** No. Exclude both.
**Rationale:** Spot-check found them current — VISION.md documents the 0.16.0 lens-panel config
(`VISION.md:304,358,366`) and providers.md already covers deepseek/grok/claude-code/opus cost +
routing (`docs/providers.md:24,48,73,171`). Editing them would be churn, not correction.

### Q2: scope — Should CHANGELOG.md be edited?
**Decision:** No.
**Rationale:** CHANGELOG runs through `[0.18.0] — 2026-06-23` with an `[Unreleased]` section
(`CHANGELOG.md` header). The drift found is docs never *describing* commands that already shipped
and were changelogged — a reference-sync gap, not undocumented shipped work. No entry warranted.

### Q3: data-model — Are config/telemetry/worktree/memory/facts real user-facing commands?
**Decision:** Yes — all five must be documented.
**Rationale:** All are registered in `src/cli/index.ts:312–324` with `.description()` text, and
`grep -n "hidden" src/cli/commands/{config,telemetry,worktree,memory,facts}.ts` returns nothing —
none are hidden/internal.

### Q4: design-ux — Full per-subcommand README detail, or one-line entries pointing to COMMANDS.md?
**Decision:** One-line README entries that defer to COMMANDS.md.
**Rationale:** Mirrors the README's own established pattern ("Full reference in COMMANDS.md",
`README.md:548`), keeping README a quick-reference and COMMANDS.md the exhaustive source.

### Q5: pattern-conflict — Which package.json keywords are defensible additions?
**Decision:** `security-audit`, `fleet`, `incident-response`, `knowledge-platform`.
**Rationale:** Each is a first-class documented CLI surface — `security-audit` command +
`docs/security-audit.md`; `fleet` command (`src/fleet/index.ts`) + `docs/fleet.md`; `incident`
command (`src/cli/commands/incident.ts`); knowledge platform (`docs/knowledge-platform.md`).

### gate-design-approval: Autonomous self-approval
**Decision:** Proceed at status `draft`. Every assumption is backed by cited file evidence above;
no high-stakes or codebase-silent question remains, so no user clarification is required.

## Open Questions

None. All questions were self-answered from codebase evidence; overall ambiguityScore = 2.
