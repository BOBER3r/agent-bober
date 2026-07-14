# Add the standalone `bober security-audit` CLI with configurable blocking threshold

**Contract:** sprint-spec-20260712-security-audit-agent-team-4  ·  **Spec:** spec-20260712-security-audit-agent-team  ·  **Completed:** 2026-07-12

## What this sprint added

**The first user-facing entry point of the security feature.** Sprints 1–3 built the schema, the
callable `runSecurityAudit` core, and a fail-closed pipeline gate — all reachable only from *inside*
`runSprintCycle`. This sprint adds a Commander command, **`bober security-audit [target]`**, that runs
that **same** core on demand against any local path (or the working tree when `target` is omitted),
persists the `.bober/security/` artifact, prints a cited findings summary, and exits with a CI-friendly
code driven by a configurable severity threshold (`security.standaloneBlockOn`). It runs **without**
`config.security` present and **without** `enabled: true` — the explicit CLI invocation **is** the opt-in.
The pipeline gate's critical-only veto (ADR-2) is structurally untouched: the threshold logic lives in
the CLI module and is never imported by `security-gate.ts` or `pipeline.ts`.

## Public surface

- **`bober security-audit [target]`** (`src/cli/index.ts:360`, registered via
  `registerSecurityAuditCommand`) — on-demand stack-aware audit of a local path or the working tree.
  Sets `process.exitCode` (never calls `process.exit()`); the handler never throws.
- `registerSecurityAuditCommand(program, overrides?)` (`src/cli/commands/security-audit.ts:215`) —
  Commander registration following the `research.ts` per-command module pattern. `overrides.runAudit`
  lets tests inject a fake core. Stamps `new Date().toISOString()` **only** at the `.action` boundary,
  loads config, calls the DI core, and mirrors the outcome into `process.exitCode`.
- `runStandaloneSecurityAudit(deps)` (`src/cli/commands/security-audit.ts:132`) — injectable
  `async (StandaloneAuditDeps) → Promise<StandaloneAuditOutcome>` core. Synthesizes the descriptor,
  synthesizes `security` defaults when absent (`SecuritySectionSchema.parse({})`), calls
  `runSecurityAudit(descriptor, null, projectRoot, runConfig)` with **`evaluation = null`** (standalone
  mode), prints the summary, and returns `{ result?, exitCode }`.
- `buildAuditDescriptor(target, now)` (`src/cli/commands/security-audit.ts:70`) — pure. Returns a
  synthetic `SprintContract`-shaped descriptor whose `contractId` is `security-audit-<slug>` (slug =
  ISO timestamp with non-alphanumerics `→ -`). The `security-audit-` prefix guarantees it can **never**
  collide with a pipeline `sprint-*` contractId and yields a stable, fs-safe artifact filename.
- `thresholdVerdict(review, standaloneBlockOn)` (`src/cli/commands/security-audit.ts:52`) — pure,
  CLI-local `(ReviewResult, 'critical'|'important') → boolean`. `critical` findings always block;
  `important` findings block **only** when `standaloneBlockOn === 'important'`; `minor` never blocks.
  A deliberate *superset* of the gate's critical-only veto — kept out of `security-gate.ts` so sc-4-4
  is verified structurally.
- `StandaloneAuditDeps` / `StandaloneAuditOutcome` / `SecurityAuditOverrides`
  (`src/cli/commands/security-audit.ts:104`, `:114`, `:211`) — the DI surface;
  `exitCode` is typed `0 | 2`.

## How to use / how it fits

```bash
# Audit the whole working tree, block CI only on critical findings (default)
npx agent-bober security-audit

# Audit a specific path
npx agent-bober security-audit src/payments

# Also fail CI on important-bucket findings — set once in bober.config.json:
#   "security": { "standaloneBlockOn": "important" }
```

The command prints a verdict line (`PASS` / `BLOCKED (threshold: …)`), the detected `stack`, per-bucket
counts (critical / important / minor), the audit summary, up to 20 top findings as
`<description> at <path>:<line>`, and the persisted artifact path
(`.bober/security/<contractId>-security-audit.md`, written by the core's `saveSecurityAudit`).

**Exit codes:** `0` = pass; `2` = blocked-by-threshold **or** fail-closed (the audit threw, or the
auditor's output could not be parsed, i.e. `result.parsed === false`). `1` is reserved for Commander's
own usage errors. The fail-closed checks run **before** the threshold, so an empty fallback review from a
parse failure can never be read as "clean".

**Where it plugs in:** the command is one of two callers of the shared `runSecurityAudit` core — the
other being the in-pipeline `evaluateSecurityGate`. Standalone mode differs only in passing
`evaluation = null` and in reading `standaloneBlockOn` (critical **or** important) for its exit code,
whereas the gate is critical-only and never reads that key.

## Notes for maintainers

- **`config.security.enabled` is intentionally never read by the CLI.** The explicit invocation is the
  consent (nonGoals[0]); this looseness is confined to the CLI module and must **not** leak into the gate.
  When the whole `security` section is absent, the CLI runs the audit with `SecuritySectionSchema.parse({})`
  defaults.
- **Threshold logic stays out of the gate.** `thresholdVerdict` lives in `security-audit.ts` only.
  sc-4-4 is enforced structurally: `standaloneBlockOn` appears solely in the CLI module, the schema, and
  tests — never in `security-gate.ts` or `pipeline.ts` (verified: those two files have zero diff this
  sprint).
- **Local paths only.** `target` is a local filesystem path; remote URLs are out of scope. No git-diff
  scoping — the auditor's read-only tools explore `projectRoot` (or the target subpath).
- **Not yet wired (later sprints).** The deterministic scanner pre-filter (sprint 5, flows in
  automatically once the core gains priors — `priors` defaults to `[]` via the unchanged core signature)
  and hub Finding emission (sprint 6) remain out of scope; a skill wrapper lands in sprint 7. The
  `security.scanners` / `security.hub` keys stay declared-but-unconsumed until then.

## Scope

Iteration 1 (single commit) — `61e055a` — exactly the estimated files: new
`src/cli/commands/security-audit.ts` (+248) and `src/cli/commands/security-audit.test.ts` (+427, 24
tests: the full 10-cell exit-code matrix `{critical|important} × {critical, important-only, clean,
parsed:false, throws}` plus stderr assertions on the two fail-closed paths and 3 Commander `parseAsync`
wiring tests), and a 4-line additive wiring change to `src/cli/index.ts`. `package.json`,
`security-gate.ts`, and `pipeline.ts` are untouched. Built-dist smoke green
(`node dist/cli/index.js security-audit --help`). Full suite **3980 → 4004** (+24). All five required
criteria (sc-4-1..4-5) passed iteration 1.
