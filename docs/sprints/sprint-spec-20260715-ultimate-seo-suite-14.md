# Orchestration skill (/bober-seo) + docs + update-all sync

**Contract:** sprint-spec-20260715-ultimate-seo-suite-14  ·  **Spec:** spec-20260715-ultimate-seo-suite  ·  **Completed:** 2026-07-16

## What this sprint added

The **discoverability and distribution layer** that turns the runnable SEO/GEO engine (Sprints 1–13) into a suite a user can actually find and run. This is a docs-and-skill sprint by construction — **no runtime code, tests, or config were touched** (the commit is 3 files: one skill, one doc page, four README lines). It ships (1) the `/bober-seo` orchestration skill that routes an intake to the right one of the 8 workflows — via the `bober seo <workflow> [target]` CLI or by spawning the `bober-seo-strategist` (optionally `bober-seo-verifier`) subagents; (2) `docs/seo.md`, the full capability reference (CLI + exit codes, the two default-false egress axes and their env vars, the `.bober/seo/imports/` file format, the config schema, and the guardrails); (3) a `/bober-seo` catalog row plus a `bober seo` CLI block in the README; and (4) the `npm run update-all` sync that copies the new `bober.seo*` skills and the two agents into the distributed target projects' `.claude/` copies. With this sprint the plan is **14 of 14 complete** and the suite is usable end-to-end.

## Public surface

This sprint adds **no code symbols** — its surface is the orchestration skill, the docs, and the README entries:

- `skills/bober.seo/SKILL.md` — the `/bober-seo` orchestration skill (frontmatter `name: bober.seo`, `argument-hint: "<workflow> [target]"`). It is a *router*, not an analyzer: it names the 8 workflows verbatim (kept in lockstep with `SEO_WORKFLOWS`, `src/seo/command.ts:27-36`), documents the CLI invocation and exit codes, states when to spawn `bober-seo-strategist` vs. `bober-seo-verifier` vs. use the CLI, lays out the offline-vs-live egress model and env vars, the config knobs, the guardrails, and how to report a run. Discoverable in the skills catalog and distributed as the `/bober-seo` slash command.
- `docs/seo.md` — the capability reference (templated on `docs/security-audit.md`): Quick Start (CLI + skill), the 8 workflows with their source of truth, the two egress axes, the offline import format, an annotated `seo` config example, the guardrails, and an FAQ.
- `README.md` — a `/bober-seo` row in the skills catalog table (after line 490) and a `bober seo <workflow> [target]` block in the CLI reference (after line 631); **4 insertions only**, no unrelated perturbation. Both are stamped `spec-20260715 COMPLETE` and point at `docs/seo.md` as the full reference.

## How to use

```bash
bober seo <workflow> [target]
# or: agent-bober seo <workflow> [target]
# workflows: technical-audit rank-track content-decay topical-map
#            ai-visibility parasite-watch internal-linking schema-audit
```

Offline by default — the runner reads `.bober/seo/imports/<capability>.csv|json` and needs no key. For a conversational run inside Claude Code, invoke `/bober-seo [workflow] [target]`, which routes to the CLI or spawns the strategist (and, when `seo.verifier.enabled`, the verifier). Live data is opt-in per axis (`seo.egress.search-console` → GSC via `GSC_OAUTH_TOKEN`; `seo.egress.serp-provider` → DataForSEO via `DATAFORSEO_LOGIN`/`DATAFORSEO_PASSWORD`), both `false` by default. See `docs/seo.md` for the full reference.

## The update-all sync

`npm run update-all` (`scripts/update-all.mjs`) rebuilds and copies the source-of-truth skills (`skills/`) and agents (`agents/`) into each registered target project's `.claude/` directory (targets in `scripts/sync-targets.json`; it never creates `.claude` from scratch — that is `init`'s job). This sprint ran it after `update-all:check` reported drift: **106 files synced across 4 targets**, after which the demo target `solex-integration-demo` carries the **11 `bober-seo*` command files** (the 10 `bober.seo-*` signature libraries + the `/bober-seo` orchestrator) and the **`bober-seo-strategist` + `bober-seo-verifier` agents**, with **0 drift** on re-check. The sync targets are separate repositories, so no synced copy is staged in this repo's commit — `update-all` is the distribution mechanism, and re-running it is how a target picks up future SEO changes.

## Notes for maintainers

- **Byte-identical-when-off was re-asserted end-to-end.** The Sprint-1 golden-snapshot test (`src/config/schema.test.ts`, 108 tests incl. the deep-equal snapshot at `:1058-1102`) still proves that a config omitting the `seo` key parses identically to a project with no SEO suite. Suite green at **4506 passed | 1 skipped | 0 failed**.
- **Keep the 8-workflow list in three places in sync.** The canonical list is `SEO_WORKFLOWS` (`src/seo/command.ts:27-36`); `skills/bober.seo/SKILL.md`, `docs/seo.md`, and the README CLI block all restate it. If a workflow is ever added/renamed (a deliberate architecture change, not a docs edit), update all four together.
- **This sprint intentionally added no runtime feature** (nonGoal) and enabled **no egress axis by default** (nonGoal). `src/cli/index.ts`/`init.ts` were not edited — the `bober seo` command was already registered in Sprint 11.
- **`docs/seo.md` is the single reference; the skill and README defer to it.** When the config schema, import format, or exit-code contract changes, edit `docs/seo.md` first and trim the skill/README to point at it rather than duplicating detail.

## Scope

One commit — `8adb3a9` — creating `skills/bober.seo/SKILL.md` (132 lines) and `docs/seo.md` (191 lines), and adding 4 lines to `README.md` (a catalog row + a CLI block). No `src/`, no test, no config, and no new dependency. `init.ts` untouched; the external `update-all` sync targets are separate repos (not staged here). All 4 required criteria (sc-14-1..14-4) passed on **iteration 1**; full suite **4506 passed | 1 skipped | 0 failed**; byte-identical-when-off re-asserted. **This is the final sprint — the Ultimate SEO Agent + Skill Suite is 14 of 14 complete.**
