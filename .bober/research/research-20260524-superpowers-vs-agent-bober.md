# Research: obra/superpowers — what to port into agent-bober

**Research ID:** research-20260524-superpowers-vs-agent-bober
**Generated:** 2026-05-24T17:00:19Z
**Source:** https://github.com/obra/superpowers (cloned to `/tmp/superpowers`)
**Questions Explored:** 7
**Files Explored:** 18

> Note: This is a comparative research between an external repo and agent-bober. The standard two-phase isolation does not apply (the comparison itself is the premise). Findings are factual — every claim is grounded in a file path from either repo. No implementation recommendations are encoded as decisions; the "Opportunities" section enumerates candidate ideas, not approved work.

---

## Architecture Overview

### superpowers
A **plugin-shaped methodology** that ships as a single SessionStart hook plus a flat directory of behavior-shaping "skills". Zero runtime, zero dependencies — it is purely prompt-engineering at the harness level.

- Entry point: `/tmp/superpowers/hooks/session-start` (bash) registered via `/tmp/superpowers/hooks/hooks.json` on `SessionStart` matcher `startup|clear|compact`.
- The hook reads `skills/using-superpowers/SKILL.md`, JSON-escapes it, and injects it as `additionalContext` so the model sees it in the very first turn.
- All other skills live in `skills/<name>/SKILL.md` (flat namespace). Each is YAML-frontmatter + markdown. The runtime contract is that the agent invokes them via the `Skill` tool when triggered.
- No orchestrator process. No artifacts on disk. No JSON schemas between agents. The "pipeline" is enforced entirely by **language in skill files** — "Iron Laws", `<HARD-GATE>` tags, `<EXTREMELY-IMPORTANT>` blocks, rationalization-prevention tables.
- Distribution model: official Claude plugin marketplace (`/plugin install superpowers@claude-plugins-official`) + cross-harness adapters (Codex CLI, Gemini CLI, Cursor, Copilot CLI, OpenCode, Factory Droid) — all share the same SessionStart-hook trick.

### agent-bober
A **runtime multi-agent harness** with orchestrator code, contracts, JSON artifacts, and provider abstraction. Skills are project-management entry points (`bober.plan`, `bober.research`, `bober.sprint`) that spawn typed subagents (`bober-planner`, `bober-curator`, `bober-generator`, `bober-evaluator`) coordinating through files on disk.

- `src/orchestrator/`, `src/contracts/`, `src/evaluators/`, `src/state/`, `src/graph/` — actual TypeScript runtime.
- Agent definitions in `agents/*.md` with explicit tool lists and isolated context windows. Each subagent receives JSON it must parse (contract, briefing, eval result).
- SessionStart hook (`hooks/hooks.json`) currently only reports graph stats — does **not** inject behavior-shaping context.
- KPI gate, knowledge graph auto-update (`scripts/graph-hook.mjs`), Brownfield/Greenfield modes, sprint contracts (`.bober/contracts/*.json`), eval results (`.bober/eval-results/*.json`).

**Core architectural divergence:** superpowers shapes a single agent's behavior with prose; agent-bober coordinates many agents with code. They are largely **complementary**, not redundant. Most of what superpowers does well, agent-bober has *no equivalent for at all* — its agents currently lack the per-agent behavioral discipline that superpowers encodes.

---

## Existing Patterns

### Patterns in superpowers worth naming

1. **SessionStart prompt injection of a bootstrap skill** — `hooks/session-start:46-65` reads `skills/using-superpowers/SKILL.md` and emits it via `additionalContext` / `hookSpecificOutput.additionalContext` / `additional_context` depending on harness. This is the *only* mechanism that auto-enrolls the agent in the methodology.
2. **Iron Law framing** — `skills/test-driven-development/SKILL.md:25-30` ("NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST"), `skills/verification-before-completion/SKILL.md:15-19` ("NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE"), `skills/systematic-debugging/SKILL.md:14-18` ("NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST"). Each skill has a single, capitalized, fenced "iron law" that anchors the rule.
3. **Rationalization-prevention tables** — `skills/verification-before-completion/SKILL.md:64-75` maps every excuse ("Should work now", "I'm confident", "Just this once") to a refutation. Inoculation against motivated reasoning.
4. **Red Flags lists** — STOP-conditions the agent should self-detect (`skills/verification-before-completion/SKILL.md:52-62`, `skills/using-superpowers/SKILL.md:81+`).
5. **`<HARD-GATE>` blocking tags** — `skills/brainstorming/SKILL.md:10-14`: "Do NOT invoke any implementation skill, write any code, scaffold any project, or take any implementation action until you have presented a design and the user has approved it."
6. **Subagent two-stage review per task** — `skills/subagent-driven-development/SKILL.md`: fresh implementer subagent → spec-compliance reviewer subagent → code-quality reviewer subagent → next task. Three separate subagent prompts (`implementer-prompt.md`, `spec-reviewer-prompt.md`, `code-quality-reviewer-prompt.md`).
7. **Parallel dispatch for independent failures** — `skills/dispatching-parallel-agents/SKILL.md`: one agent per independent problem domain, run concurrently.
8. **Worktree isolation with native-tool detection** — `skills/using-git-worktrees/SKILL.md`: Step 0 detects whether the harness already provides a worktree (`EnterWorktree`, `WorktreeCreate`), falls back to `git worktree add` only when no native tool exists. Submodule guard included.
9. **Finishing-a-development-branch standardization** — `skills/finishing-a-development-branch/SKILL.md`: verify tests → detect environment (worktree vs normal repo, named branch vs detached HEAD) → present menu (merge / PR / cleanup) → execute → clean up.
10. **Skill TDD (writing-skills is itself a skill)** — `skills/writing-skills/SKILL.md`: skills are "code that shapes agent behavior". Each new skill goes through RED (run baseline pressure scenario, watch agent fail) → GREEN (write skill, watch agent comply) → REFACTOR (close loopholes). `skills/writing-skills/testing-skills-with-subagents.md` documents the adversarial test harness.
11. **Graphviz `dot` flowcharts in skill bodies** — most skills include a `dot` block (e.g., `skills/using-superpowers/SKILL.md:46-77`) rendering the decision flow. Renderer in `skills/writing-skills/render-graphs.js`.
12. **Anti-pattern reference docs split out** — `skills/test-driven-development/testing-anti-patterns.md`, `skills/systematic-debugging/condition-based-waiting.md`, `defense-in-depth.md`, `root-cause-tracing.md`. Loaded on demand, keeping the SKILL.md itself short.
13. **AGENTS.md as adversarial PR-quality contract** — `/tmp/superpowers/AGENTS.md:1-30` opens with "94% PR rejection rate" and lists what NOT to submit. Treats the AI as a partner that must protect its human partner from embarrassment.
14. **"Your human partner" terminology** — deliberate, tested phrasing (called out in AGENTS.md as not interchangeable with "the user"). Reframes the relationship.

### Patterns already in agent-bober

- Two-phase researcher isolation (`agents/bober-researcher.md`, `src/orchestrator/research.ts` if present, the `bober.research` skill).
- Five-checkpoint architect flow (`agents/bober-architect.md` + `COMMANDS.md:78-103`).
- Sprint contracts with success-criteria, generator notes, evaluator notes (`.bober/contracts/*.json`).
- Curator briefing pattern (`agents/bober-curator.md`) — fills the same niche as superpowers's "writing-plans" but produced by a separate agent.
- Evaluator independence — `agents/bober-evaluator.md:1-30` lists tools that exclude `Write`/`Edit`. Cannot write code, matches superpowers's spec/quality reviewer separation conceptually.
- KPI gate script + CI workflow (sprints 7 visible in `git log`).
- Graph-update hook on `PostToolUse` (`hooks/hooks.json:5-12`).

---

## Key Files

### superpowers (reference)
- `/tmp/superpowers/hooks/hooks.json` — single SessionStart hook registration.
- `/tmp/superpowers/hooks/session-start` — the bash that injects `using-superpowers` content into `additionalContext`. Handles Cursor (`CURSOR_PLUGIN_ROOT`), Claude Code (`CLAUDE_PLUGIN_ROOT`), Copilot CLI (`COPILOT_CLI`) via the same script.
- `/tmp/superpowers/skills/using-superpowers/SKILL.md` — bootstrap skill loaded on every session. Establishes the "even 1% chance → invoke the Skill" rule.
- `/tmp/superpowers/skills/brainstorming/SKILL.md` — design-before-code gate.
- `/tmp/superpowers/skills/writing-plans/SKILL.md` — plan format (file-by-file decomposition, bite-sized 2–5min tasks, mandatory header pointing to subagent-driven-development).
- `/tmp/superpowers/skills/subagent-driven-development/SKILL.md` + the three prompt files — the closest analog to bober's generator-evaluator loop.
- `/tmp/superpowers/skills/test-driven-development/SKILL.md` — Red-Green-Refactor with deletion rule (`Write code before the test? Delete it. Start over.`).
- `/tmp/superpowers/skills/systematic-debugging/SKILL.md` — 4-phase root-cause-first investigation.
- `/tmp/superpowers/skills/verification-before-completion/SKILL.md` — Iron Law: no claim without fresh verification output.
- `/tmp/superpowers/skills/requesting-code-review/SKILL.md` + `code-reviewer.md` template — fresh-eyes review subagent dispatch.
- `/tmp/superpowers/skills/receiving-code-review/SKILL.md` — discipline when receiving feedback (no "You're absolutely right!", verify before implementing).
- `/tmp/superpowers/skills/using-git-worktrees/SKILL.md` — native-tool-first worktree pattern.
- `/tmp/superpowers/skills/dispatching-parallel-agents/SKILL.md` — fan-out for independent problems.
- `/tmp/superpowers/skills/finishing-a-development-branch/SKILL.md` — merge/PR/cleanup options menu.
- `/tmp/superpowers/skills/writing-skills/SKILL.md` + `testing-skills-with-subagents.md` — meta-skill for the methodology.
- `/tmp/superpowers/AGENTS.md` / `CLAUDE.md` — AI-contributor contract.

### agent-bober (target)
- `/Users/bober4ik/agent-bober/hooks/hooks.json` — current PostToolUse hooks; **no SessionStart bootstrap**.
- `/Users/bober4ik/agent-bober/hooks/` — directory exists but only contains `hooks.json`. No bash hook scripts.
- `/Users/bober4ik/agent-bober/skills/` — 12 skill folders (`bober.plan`, `bober.research`, `bober.architect`, `bober.run`, `bober.sprint`, `bober.eval`, `bober.principles`, `bober.brownfield`, `bober.react`, `bober.anchor`, `bober.solidity`, `bober.playwright`). No `bober.using-bober` bootstrap. No TDD/debugging/verification/code-review/worktree/parallel skills.
- `/Users/bober4ik/agent-bober/agents/*.md` — 6 subagent definitions (`bober-architect`, `bober-curator`, `bober-evaluator`, `bober-generator`, `bober-planner`, `bober-researcher`). No `bober-code-reviewer`, no `bober-debugger`.
- `/Users/bober4ik/agent-bober/COMMANDS.md` — current command reference (pipeline diagram + per-command docs).
- `/Users/bober4ik/agent-bober/src/orchestrator/` — pipeline coordinator.
- `/Users/bober4ik/agent-bober/.bober/contracts/`, `.bober/briefings/`, `.bober/eval-results/` — runtime artifact directories.

---

## Integration Points

### Where porting fits cleanly into the existing harness

1. **SessionStart hook → behavior bootstrap.** Current `hooks/hooks.json` only registers a `PostToolUse` matcher. Adding a `SessionStart` matcher that runs a `hooks/session-start` script (modeled on superpowers's bash, ~70 lines) would inject a "using-bober" skill at every session start. The graph-stats payload that currently fires on SessionStart (visible in this turn's reminder) could become a *second* hook block, not be replaced.
2. **Per-agent skill bundles.** Each subagent prompt (`agents/bober-generator.md`, `agents/bober-evaluator.md`) is a markdown file the orchestrator already injects into a spawned subagent's context. Behavior-shaping content (Iron Laws, verification gate, TDD discipline) can be inlined into these prompts *or* referenced as sub-skills loaded into the subagent's working context — same delivery channel, no orchestrator-code changes.
3. **Generator → evaluator handoff = "requesting code review".** Current flow: generator commits → orchestrator spawns evaluator with contract. Superpowers's two-stage pattern (spec reviewer then quality reviewer) maps to either (a) splitting evaluator into two passes, or (b) running an extra fresh-context "quality" subagent between generator self-verify and evaluator. The orchestrator already supports spawning more than two subagent types — `agents/` is just a directory.
4. **Curator briefing ↔ writing-plans.** `agents/bober-curator.md` produces `.bober/briefings/<contractId>-briefing.md` per sprint. The "bite-sized 2–5min steps" granularity from `skills/writing-plans/SKILL.md` could be a curator output convention without changing the contract schema.
5. **Worktrees per sprint.** Generator currently checks out a branch named `bober/<feature-name>` (per `bober.config.json:21`). Replacing this with `git worktree add` per sprint would give true isolation matching the `using-git-worktrees` pattern. The orchestrator owns branch creation, so it's a single code path to change.
6. **Parallel independent sprints.** Sprints in a single PlanSpec are currently sequential (`COMMANDS.md` pipeline diagram). When sprint contracts have no file-overlap (graph-derivable from the knowledge graph at `.bober/graph/`), they could fan-out via `dispatching-parallel-agents`. The graph already exists.
7. **Anti-pattern docs loaded by evaluator.** Evaluator currently runs strategies from `bober.config.json:25-46` (typecheck/lint/build/test). Adding `.bober/anti-patterns/*.md` references loaded into evaluator context (testing-anti-patterns.md, condition-based-waiting.md from superpowers as starting set) would give it judgment criteria beyond rubric.
8. **`finishing-a-development-branch` at end of pipeline.** Currently the pipeline ends when all sprints pass evaluation. There's no explicit "now merge / now open PR / now keep worktree" step. This skill is a clean drop-in as a final phase.

### Where porting does NOT fit

- **Replacing the JSON contract pipeline with skill-prose-only flow.** Bober's value proposition is *reproducible artifacts on disk*. Removing them to mimic superpowers's prompt-only flow would be a regression.
- **Removing the runtime orchestrator.** Superpowers has zero runtime; bober has CLI/MCP/state machines. These solve different problems.
- **Replacing the two-phase researcher with `brainstorming` alone.** The two-phase isolation in `bober.research` is more rigorous than `brainstorming` because it actively prevents the explorer from seeing the feature description. Keep both; brainstorming can sit *above* research as an additional gate.

---

## Test Coverage

- **superpowers tests:** `/tmp/superpowers/tests/` contains `brainstorm-server`, `claude-code`, `codex-plugin-sync`, `explicit-skill-requests`, `opencode`, `skill-triggering`, `subagent-driven-dev`. These are end-to-end behavioral tests of the skill-triggering mechanism per harness — not unit tests of skill content. The skill-content "tests" are the adversarial pressure scenarios documented in `skills/writing-skills/testing-skills-with-subagents.md` (rendered as scenario `.md` files like `skills/systematic-debugging/test-pressure-1.md`, `test-pressure-2.md`, `test-pressure-3.md`, `test-academic.md`).
- **agent-bober tests:** Runtime test coverage exists for the orchestrator (`tests/` directory referenced in `bober.config.json`'s `npm run test` command). There is **no equivalent of skill-pressure tests** — no adversarial scenarios checking whether subagent prompts withstand rationalization, sycophancy, or premature-completion pressure.
- **Implication:** Porting skill content without porting the adversarial-pressure testing methodology would mean importing prose without the rigor that produced it. The `writing-skills` discipline is itself one of the most valuable transferable artifacts.

---

## Risk Areas

1. **Voice clash.** Superpowers uses "your human partner", capitalized fenced blocks, all-caps emphasis ("ABSOLUTELY MUST"), and adversarial framing ("rationalization", "lying"). Agent-bober's current voice is procedural and structured. Direct copy-paste would create stylistic incoherence. Porting requires translation, not transplant.
2. **Skill-trigger reliability across harnesses.** Superpowers's auto-triggering depends on the `using-superpowers` bootstrap being loaded at SessionStart. Agent-bober is invoked across multiple surfaces (Claude Code slash commands, MCP tools, CLI). Each surface needs its own bootstrap path or some skills will be dead weight.
3. **Behavioral-rule overhead vs orchestrator-enforced rule.** Some superpowers rules (verification-before-completion, TDD red-green) are things bober's evaluator already verifies *mechanically* via strategy commands. Importing them as prose rules on the generator adds belt-and-suspenders — useful but potentially redundant. The question per-rule: does the evaluator already catch this, and if so, is the prose adding value (faster fail, better fix) or noise (longer prompts, token waste)?
4. **Plugin-distribution model is not a fit.** Superpowers ships via Claude plugin marketplace. Agent-bober is a project-local toolkit. Skills here are loaded by being in `skills/` of the cwd. Distribution machinery from superpowers (scripts/sync-to-codex-plugin.sh, marketplace registration) does not apply.
5. **`<HARD-GATE>` enforcement in a multi-agent system.** A hard gate in superpowers stops *the single agent*. In bober, the orchestrator can route around an unwilling subagent by spawning another. Hard gates need to be enforced at the orchestrator level (contract phase), not just in subagent prose, or they leak.
6. **License.** `/tmp/superpowers/LICENSE` is MIT per the repo metadata. Porting skill text verbatim should retain attribution per the license — even for prose, not just code.
7. **94%-rejection upstream culture.** Per `/tmp/superpowers/AGENTS.md`, the maintainers are hostile to AI-authored PRs. Do not submit changes upstream. This is one-way porting only.

---

## Opportunities (candidate extractions, in rough priority order)

Listed as factual candidates with locations and integration points, not as decisions.

| # | Item from superpowers | Source | Integration target in agent-bober | Why it would change behavior |
|---|---|---|---|---|
| 1 | SessionStart bootstrap injecting a "using-bober" skill | `hooks/session-start`, `skills/using-superpowers/SKILL.md` | New `hooks/session-start` + `skills/bober.using-bober/` | The harness currently has no behavioral on-ramp at session start. Every conversation starts cold. |
| 2 | `verification-before-completion` Iron Law | `skills/verification-before-completion/SKILL.md` | Inline into `agents/bober-generator.md` self-verify section; new `skills/bober.verify/` | Generator currently can self-report success without running the eval strategies first. The evaluator catches this *after* a commit cycle. |
| 3 | `systematic-debugging` 4-phase rule | `skills/systematic-debugging/SKILL.md` | Inline into generator's "when evaluator returns failures" path; new `skills/bober.debug/` | When evaluator rejects, generator currently has no enforced root-cause discipline. It tends to fix symptoms. |
| 4 | `test-driven-development` Red-Green-Refactor | `skills/test-driven-development/SKILL.md` | Inline into `agents/bober-generator.md`; cross-reference from sprint contract generator-notes | Generator writes implementation then tests, which produces tests-that-pass-too-easily. |
| 5 | Two-stage review (spec then quality) per task | `skills/subagent-driven-development/SKILL.md` + three prompt files | Split evaluator into `bober-spec-evaluator` + `bober-quality-reviewer`; or add quality-review subagent after eval-pass | Evaluator currently bundles spec compliance and code quality. They reward different judgment. |
| 6 | `using-git-worktrees` with native-tool detection | `skills/using-git-worktrees/SKILL.md` | Orchestrator branch-creation code path | Replaces shared-branch sprint isolation with real filesystem isolation. Big win for parallel sprints. |
| 7 | `dispatching-parallel-agents` | `skills/dispatching-parallel-agents/SKILL.md` | Orchestrator + use the existing knowledge graph (`.bober/graph/`) to detect file-disjoint sprints | Sprints with no file overlap could fan-out instead of running serially. Graph already knows file overlap. |
| 8 | `finishing-a-development-branch` standardized menu | `skills/finishing-a-development-branch/SKILL.md` | New final phase in `bober.run` pipeline, after last sprint passes | Pipeline currently has no explicit "now what" step after all sprints pass. |
| 9 | `requesting-code-review` + `receiving-code-review` discipline | `skills/requesting-code-review/SKILL.md`, `skills/receiving-code-review/SKILL.md`, `code-reviewer.md` | New `bober-code-reviewer` agent; receiving-discipline inlined into generator's "evaluator feedback" handler | Generator currently has no "verify before implementing feedback" discipline. Sycophancy and partial-understanding bugs go through. |
| 10 | `brainstorming` HARD-GATE before plan | `skills/brainstorming/SKILL.md` | Optional pre-phase before `bober.plan`; or a stricter gate inside `bober.plan` clarifying-questions step | Even after clarifications, plan currently proceeds without explicit design-approval gate. |
| 11 | `writing-skills` adversarial-pressure test methodology | `skills/writing-skills/SKILL.md` + `testing-skills-with-subagents.md` | New `tests/skill-pressure/` test suite + `skills/bober.writing-skills/` | Bober's own skills (`bober.plan`, etc.) have never been pressure-tested. |
| 12 | Anti-pattern reference docs | `skills/test-driven-development/testing-anti-patterns.md`, `skills/systematic-debugging/condition-based-waiting.md`, `defense-in-depth.md`, `root-cause-tracing.md` | New `.bober/anti-patterns/` directory loaded into evaluator + generator context on demand | Evaluator currently has no library of named anti-patterns to cite when failing a sprint. |
| 13 | Iron Law / Red Flags / Rationalization-prevention table prose style | every superpowers SKILL.md | Style-pass across `agents/*.md` and `skills/bober.*/SKILL.md` | Current bober prose is descriptive. The capitalized-rule + objection-table style is empirically tuned to actually constrain agent behavior. |
| 14 | Graphviz `dot` decision-flow diagrams in skill bodies | every superpowers SKILL.md, `skills/writing-skills/render-graphs.js` | Add to existing bober skills where the decision flow is non-trivial | Visual decision flows materially help model navigation through multi-step procedures. |
| 15 | AGENTS.md / CLAUDE.md adversarial PR-quality contract | `/tmp/superpowers/AGENTS.md` | New `AGENTS.md` at agent-bober root governing agent-authored PRs | Currently no contract telling agents what slop looks like in the agent-bober-generated PR context. |

### What NOT to port

- The plugin marketplace machinery (`scripts/sync-to-codex-plugin.sh`, `scripts/bump-version.sh`) — distribution model mismatch.
- "Your human partner" terminology — context-dependent voice choice, not a tested-in-bober convention.
- The 94%-rejection adversarial framing toward upstream — that's about superpowers's own contributor policy, not transferable.
- Replacing two-phase researcher with brainstorming — would lose rigor.

---

## What is already covered (do not duplicate)

| superpowers concept | agent-bober equivalent already exists |
|---|---|
| `brainstorming` → spec doc | `bober.plan` clarifying questions + design discussion doc |
| `writing-plans` → plan doc | `bober.plan` PlanSpec + sprint contracts |
| `subagent-driven-development` orchestration | The whole `src/orchestrator/` runtime |
| Implementer subagent | `bober-generator` |
| Spec-reviewer subagent | `bober-evaluator` (covers spec compliance) |
| `executing-plans` parallel-session mode | `bober.run` autonomous pipeline |
| `using-superpowers` flat-namespace skill discovery | `bober.*` skills exist; missing only the bootstrap |

---

*Generated by bober.research — factual findings only, no implementation recommendations. The Opportunities table enumerates candidates; selection and sequencing belong to planning, not research.*
