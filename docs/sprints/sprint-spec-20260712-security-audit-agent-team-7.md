# Add the bober.security-audit skill, enable dogfooding, and write docs

**Contract:** sprint-spec-20260712-security-audit-agent-team-7  ·  **Spec:** spec-20260712-security-audit-agent-team  ·  **Completed:** 2026-07-12

## What this sprint added

**The operator surface — the final sprint that closes spec-20260712 (7/7).** Sprints 1–6 built the
schema, the callable `runSecurityAudit` core, the fail-closed pipeline gate, the standalone CLI, the
scanner pre-filter, and hub emission — all reachable only from code or the CLI. This sprint ships the
three human-facing pieces that make the feature usable and self-applied, and adds **no application
code**: (1) a `skills/bober.security-audit/SKILL.md` orchestrator (mirroring `bober.code-review`) that
spawns the `bober-security-auditor` subagent — or points at the CLI — for on-demand, **advisory**
audits; (2) **LLM-only dogfooding** — agent-bober's own `bober.config.json` now sets
`security: { enabled: true, scanners: [] }`, so every future sprint of *this* repository runs the
fail-closed gate on LLM judgment alone (no `slither`/`semgrep` binaries required); and (3)
`docs/security-audit.md`, a single consolidated operator reference for the whole feature. The lone test
change repairs the sprint-1 repo-config snapshot to reflect the newly materialized `security` block.

## Public surface

- `skills/bober.security-audit/SKILL.md` (skill `name: bober-security-audit`, `argument-hint: "[target]"`)
  — advisory orchestrator. Reads the `security` config section, scopes a target (a path argument, or the
  working tree by default), then **spawns** the `bober-security-auditor` subagent via the Agent tool **or**
  directs the operator to `bober security-audit [target]` for a scriptable/CI path. It presents findings
  ranked by severity (critical → important → minor) each with a `path:line` citation, persists the
  `ReviewResult` to `.bober/security/<contractId>-security-audit.md` (via `renderReviewMarkdown`, the
  exact artifact path the gate and CLI use), and reminds the operator the skill run is **advisory only** —
  it **never** blocks and **never** instructs writing a code fix. Every symbol it references
  (`bober-security-auditor`, the `security-audit` subcommand, the `.bober/security/` directory, the
  `security.*` config keys) was evaluator-verified to exist as named.
- `bober.config.json` → `security: { enabled: true, scanners: [] }` (2-key diff) — agent-bober's own
  dogfood opt-in. Under `SecuritySectionSchema` this materializes an 8-key block
  (`enabled: true`, `failClosed: true`, `timeoutMs: 300000`, `model: "opus"`, `maxTurns: 20`,
  `scanners: []`, `standaloneBlockOn: "critical"`, `hub: true`); the four optional fields
  (`provider`/`endpoint`/`providerConfig`/`budget`) stay **absent**.
- `docs/security-audit.md` — the consolidated feature reference (Overview, Quick Start for CLI + skill,
  Pipeline Gate flows, a field-by-field Configuration Reference for all 12 `SecuritySectionSchema` fields,
  Scanners with slither/semgrep examples, Hub Emission, Fail-Closed Guarantees, and an FAQ). Cross-checked
  field-by-field against `src/config/schema.ts` with zero drift.
- `src/config/schema.test.ts` (the sprint-1 "repo's own `bober.config.json` parses" snapshot test,
  `src/config/schema.test.ts:744`) — **repaired, not behavior-changing.** The assertion flips from
  `Object.hasOwn(parsed, "security") === false` to `=== true`, and the explicit deep-equal expected object
  gains the 8-key materialized `security` block. This is a snapshot correction, not new coverage
  (`testsAdded: []`).

## How to use / how it fits

Three surfaces now consume the one shared `runSecurityAudit` core, in ascending order of enforcement:

- **Skill (advisory):** invoke `bober.security-audit [target]` in Claude Code for a conversational audit.
  It produces information and points at the persisted artifact; it enforces nothing.
- **CLI (CI enforcement):** `bober security-audit [target]` exits `0` on a clean pass and `2` when blocked
  by `security.standaloneBlockOn` (`critical` default, or `important`) or when the audit fails closed —
  wire the exit code into CI.
- **Pipeline gate (sprint enforcement):** with `security.enabled === true`, the fail-closed gate runs on
  every passing sprint and can block completion on a critical finding, a timeout, or an unparseable audit.

The dogfood flip means agent-bober is now its own first customer of the third surface. Because
`security.scanners` is `[]`, the gate runs LLM-only — zero child processes — so no scanner binary need be
installed on a contributor's machine. The full operator walkthrough (config reference, gate semantics,
exit codes, scanners, hub emission, fail-closed guarantees, FAQ) lives in
[`docs/security-audit.md`](../security-audit.md).

## Notes for maintainers

- **The dogfood gate is live from here on.** Every future sprint of this repo that reaches a passing
  evaluation now triggers a real `bober-security-auditor` run before it is marked `passed`. A critical
  finding (or a timeout / unparseable audit) will **block** the sprint and route the findings into the
  next generator iteration — this is the intended, plan-approved cost/latency tradeoff (contract
  assumption 5), not a regression. To turn it off for a one-off, remove `security.enabled` from
  `bober.config.json`; there is no per-finding override.
- **Tests do not read the repo config for pipeline behavior.** Contract assumption/stop-condition:
  flipping the dogfood flag must not make any unit test spawn a real audit or touch the network. The full
  suite (4045 tests) stayed green with the flag committed and the evaluator confirmed no test newly spawns
  a subagent or hits the network — the only test that reads `bober.config.json` is the config-validity
  snapshot, which was updated deliberately.
- **`npm run update-all` was intentionally NOT run** (contract non-goal). The `skills/bober.security-audit/`
  directory has the same single-`SKILL.md` shape as `bober.code-review` (no hand-authored
  `.claude/commands` twin), so `update-all` will auto-discover it via `readdir` and generate the
  `/bober-security-audit` slash command + copy it into every registered `.claude/` target. Until that sync
  runs, the skill exists in-repo but the distributed slash command is not yet materialized in consumer
  projects — a documented post-merge follow-up.
- **The skill never persists via the subagent.** The `bober-security-auditor` agent has no
  `Write`/`Edit`/`Bash` tools; whichever orchestrator ran it (skill, gate, or CLI) owns saving the
  artifact. When extending the skill, keep persistence in the orchestrator, never delegate it to the
  subagent.

## Scope

Single iteration (`c2953e7`), four files: `skills/bober.security-audit/SKILL.md` (new),
`docs/security-audit.md` (new), `bober.config.json` (2-key security block), and `src/config/schema.test.ts`
(snapshot repair). All five required criteria (sc-7-1..7-5) passed at iteration 1 with zero reworks. Build,
typecheck, and ESLint clean; full suite **4045** green with the dogfood config committed. **This sprint
completes spec-20260712 — 7/7 sprints, every one an iteration-1 pass.**
