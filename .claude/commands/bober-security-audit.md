---
name: bober-security-audit
description: Use when you want an on-demand, stack-aware security audit of a path or the working tree — spawns the bober-security-auditor subagent (or invokes the `bober security-audit` CLI) to find exploitable vulnerabilities, producing a severity-ranked ReviewResult written to .bober/security/<contractId>-security-audit.md.
argument-hint: "[target]"
---

# bober.security-audit — Stack-Aware Security Audit Orchestrator

You are the **orchestrator** for a standalone security audit run. You do NOT audit the
code yourself. You spawn the security auditor as a subagent using the **Agent tool**
(or, when the user prefers a scriptable/CI-friendly path, direct them to the CLI),
then process and present its results, pointing at the persisted artifact under
`.bober/security/`.

The security auditor subagent runs in its own isolated context window. It receives
ONLY the information you explicitly pass in its prompt. It has no `Write`/`Edit`/`Bash`
tools — it cannot fix anything and it cannot save its own output. You are the one who
persists it (mirroring `bober.code-review`'s pattern), OR — in the more common case for
this skill — the CLI already persisted it before you were invoked.

**Integration with bober pipeline:** In the automated pipeline, `evaluateSecurityGate`
(`src/orchestrator/security-gate.ts`) invokes the SAME underlying `runSecurityAudit`
core automatically after `runEvaluatorAgent` returns `passed: true`, but ONLY when
`config.security.enabled === true` — it is a **fail-closed gate** that can block a
sprint (see "Fail-Closed Gate vs. Advisory Skill" below). This skill is for
**standalone** runs — when you want a deep audit outside the normal pipeline flow, or
when `security.enabled` is `false`/absent and you still want the visibility.

**The full pipeline this skill orchestrates:**

- **Per-stack signature retrieval** — the `bober-security-auditor` subagent is fed a
  retrieved `# Stack Security Context` drawn from one of 8 authored
  `skills/bober.security-<stack>/SKILL.md` libraries (`solidity`, `anchor`, `react`,
  `node`, `payments`, `igaming`, `dex-backend`, plus a shared `generic` OWASP/CWE
  floor that is always included) — resolved from `project.stack` via
  `SecurityStackRegistry.resolve`, never a static excerpt. See
  [`docs/security-audit.md`](../../docs/security-audit.md#per-stack-signature-libraries-shipped)
  for the full registry and how to add/edit a signature.
- **Finder → verifier stage** — when `security.verifier.enabled` is set, a second
  read-only agent, `bober-security-verifier` (`agents/bober-security-verifier.md`),
  runs sequentially after the finder in a fresh, contract-free context and tries to
  *disprove* each critical/important finding. It is downgrade-only and fail-closed —
  see [Finder → verifier stage](../../docs/security-audit.md#finder--verifier-stage).
- **Supply-chain axis** — when `security.supplyChain.enabled` is set, an always-available
  offline diff inspector (plus optional `npm-audit`/`osv-scanner`/`gitleaks` scanners,
  network-gated behind `security.egress.onlineResearch`) folds dependency/lockfile/CI
  risk findings into the finder's priors alongside any `security.scanners` pre-filter.

## When to Request an Audit

**Automatic in pipeline (when opted in):** If `bober.config.json` has
`security.enabled: true`, every sprint that passes evaluation is already audited by
the fail-closed gate before it is marked `passed`. You do not need to invoke this
skill for those sprints — the gate already ran and (on a clean result) recorded a
`security-audit-clean` history event.

**Use this skill manually when:**
- You want a deep audit of a path (or the whole working tree) outside a pipeline run
- `security.enabled` is `false`/absent in this project's config and you still want a
  one-off audit before shipping
- You want to re-audit a specific file/directory the pipeline gate did not cover (the
  gate only scopes to a sprint's `estimatedFiles`)
- You are wiring `bober security-audit` into CI and want to understand its exit codes
  first

## What the Auditor Checks

**What to check — findings the auditor WILL surface**, ranked by severity:

- **Critical** — an exploitable vulnerability a realistic attacker/malicious
  input/untrusted caller could trigger to compromise funds, data, or system integrity.
  Injection (SQL/command/template), missing authn/authz on a privileged operation,
  hardcoded/logged secrets, unsanitized path construction from untrusted input,
  privilege escalation.
- **Important** — a security weakness that is not immediately exploitable in a
  realistic scenario: a missing defense-in-depth layer, weak-but-not-broken
  validation, a documented `bober:` ceiling comment with no upgrade path.
- **Minor** — security-adjacent style/hygiene with no realistic exploit path.

Every finding carries `path:line` evidence (the auditor's Iron Law: no finding
without file:line evidence). The auditor also names sound security handling in
`approvedAreas` — not everything it looks at is a problem.

**What NOT to flag — the auditor MUST drop these:**

- Style preferences, naming opinions, theoretical risks with no observed trigger
- Pre-existing code the audit's scope did not change (in standalone mode: code
  outside the requested target)
- A `bober:` ceiling comment naming both the ceiling and an upgrade path is a
  deliberate, auditable trade-off — never Critical for that reason alone

## Fail-Closed Gate vs. Advisory Skill

This is the one thing to get right before you present anything: **when you run this
skill directly, the audit is advisory.** Spawning `bober-security-auditor` (or running
the CLI) through this skill never blocks anything by itself — it produces information.
Enforcement lives in two other places, neither of which this skill controls:

- **The pipeline gate** (`evaluateSecurityGate`, `src/orchestrator/security-gate.ts`) —
  runs automatically when `security.enabled === true`, and can block a sprint on a
  critical finding, a timeout, or an unparseable audit (fail-closed).
- **The CLI's exit code** (`bober security-audit [target]`,
  `src/cli/commands/security-audit.ts`) — exits `2` when blocked by
  `security.standaloneBlockOn` (`critical` by default, or `important`) or on a
  fail-closed audit error; exits `0` on a clean pass. Wire this into CI, not this
  skill.

**Never instruct the user (or yourself) to write code fixes as part of this skill.**
The auditor itself never writes, edits, or blocks completion
(`agents/bober-security-auditor.md`) — it only finds and cites. If a finding needs a
fix, that is a follow-up task for a generator sprint, not something this skill does
inline.

## Process Flow

### Step 1: Identify the Target

**If a target path was provided as an argument:**
- Use it as the audit scope (a file or directory, relative to the project root).

**If no target was provided:**
- Default to the working tree (mirrors the CLI's `bober security-audit` with no
  `[target]` — the auditor scopes itself via the synthesized descriptor's
  `estimatedFiles`).

Ask the user to confirm the target if it is ambiguous (e.g. "the new module" without a
path).

### Step 2: Gather Context

Read `bober.config.json` for the `security` section:
- `security.enabled` — informs whether the pipeline gate is already covering this
  project automatically (see "When to Request" above); NOT required for this skill to
  run.
- `security.standaloneBlockOn` — the threshold the CLI path would use (`critical` or
  `important`); mention it when you point the user at the CLI.
- `security.scanners` — if non-empty, deterministic scanner priors (slither/semgrep)
  will ground the audit; if `[]`, the audit runs on LLM judgment alone.
- `security.hub` — whether critical/important findings will also be emitted into the
  priority hub (default `true`).
- `project.stack` — resolved via `SecurityStackRegistry.resolve` to one of 8
  per-stack skill libraries (or the `generic` floor for an unrecognised/absent stack);
  mention which stack's signatures grounded the audit when presenting results.
- `security.verifier.enabled` — if set, a fresh-context `bober-security-verifier`
  pass already re-checked the finder's critical/important findings before they
  reached you (downgrade-only, fail-closed — see `docs/security-audit.md`).
- `security.supplyChain.enabled` / `security.egress.onlineResearch` — whether the
  offline supply-chain diff inspector (and, only if `egress.onlineResearch` is
  `true`, network scanners) contributed priors to this audit.
- `security.diff.mode` — `"git-diff"` means the auditor was grounded in a real diff
  rather than `estimatedFiles`.

This repo's own `bober.config.json` opts into the full pipeline (verifier +
offline supply-chain, network egress off, `project.stack` resolving to `node`) —
see `docs/security-audit.md` for the exact config.

Read `.bober/principles.md` if it exists.

Check git status if the target is unclear:
```bash
git status --short
git log --oneline -5
```

### Step 3: Choose Agent-Spawn or CLI

**Spawn the subagent** when the user wants the result woven into this conversation
(e.g. discussing findings interactively, iterating on scope).

**Direct the user to the CLI** when they want a scriptable, CI-friendly, exit-code-driven
result:
```bash
bober security-audit [target]
# or: agent-bober security-audit [target]
```
Exit codes: `0` = pass, `2` = blocked-by-threshold (`security.standaloneBlockOn`) OR
fail-closed (the audit threw, or the auditor's output could not be parsed). `1` is
reserved for CLI usage errors, not audit outcomes.

**To spawn the subagent:**

```
Agent tool call:
  description: "Security Audit: <target or 'working tree'>"
  subagent_type: bober-security-auditor
  mode: auto
  prompt: <the full prompt below>
```

**Build the auditor prompt with ALL of these sections:**

```
You are the Bober Security Auditor subagent. You have been spawned for a standalone
audit — there is no in-pipeline evaluation context.

## Sprint Contract
<if auditing a real passed sprint contract, paste the full SprintContract JSON from
.bober/contracts/<contractId>.json; otherwise synthesize a minimal descriptor: a
contractId like "security-audit-<timestamp>", the target as estimatedFiles, and a
one-line description of the audit scope>

## Stack Security Context
<if bober.config.json declares project.stack, paste the resolved stack-specific
checklist (reentrancy/access-control/etc. for bober.solidity, PDA/CPI-safety for
bober.anchor); otherwise state "No stack-specific checklist — audit against the
generic taxonomy only.">

## Project Root
<absolute path to the project root>

## Context
- This is a STANDALONE audit — there is no evaluation-context section
- Target: <target path or "the working tree">
- Audit is ADVISORY in this mode — you never fix anything, never block anything

## Your Task
Audit the target for exploitable security vulnerabilities. Produce a ReviewResult
JSON. Output ONLY the JSON — no text outside it.
```

### Step 4: Process and Present the Result

When the subagent returns:

1. Parse the `ReviewResult` JSON from its response.
2. Persist it: render the markdown via the same shape the code-reviewer uses
   (`renderReviewMarkdown`) and save to
   `.bober/security/<contractId>-security-audit.md` (the exact artifact path the
   pipeline gate and CLI also use — `src/state/security-audit-state.ts`).
3. Present findings to the user **ranked by severity** — critical first, then
   important, then minor — each with its `path:line` citation:

```markdown
# Security Audit: <target>

## Summary

<paste summary field>

## Critical

<for each finding in critical array: description + evidence path:line>
<if empty: "No critical findings.">

## Important

<for each finding in important array>
<if empty: "No important findings.">

## Minor

<for each finding in minor array>
<if empty: "No minor findings.">

## Approved Areas

<for each item in approvedAreas: bullet>
<if empty: "No areas specifically called out.">
```

4. Remind the user: this run is advisory. To make audits enforce automatically on
   every future sprint, set `security.enabled: true` in `bober.config.json` (the
   fail-closed pipeline gate). To enforce in CI, wire `bober security-audit` and check
   its exit code.
5. Point to the persisted artifact path so the user can reference it later:
   `.bober/security/<contractId>-security-audit.md`.

## Red Flags - STOP

- About to instruct writing a code fix as part of this skill's output — describe the
  vulnerability, never the patch
- About to treat a critical finding from this skill as blocking anything — it is
  advisory here; only the pipeline gate and the CLI exit code enforce
- About to skip persisting the result because "the CLI already saved one" — if you
  ran the subagent yourself, you own saving its output
- About to reference the wrong agent name, CLI command, or artifact path (the agent is
  `bober-security-auditor`, the CLI subcommand is `security-audit`, the artifact
  directory is `.bober/security/` — never `.bober/reviews/`, that is the advisory code
  reviewer's separate directory)

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "I found a critical issue, let me just fix it while I'm here" | No. This skill is advisory-only. Describe the vulnerability; a fix is a separate task. |
| "The audit is clean, so `security.enabled` doesn't matter" | A clean one-off audit says nothing about future sprints. Recommend `security.enabled: true` for ongoing coverage. |
| "The user didn't specify a target, so I'll skip asking and guess" | Default to the working tree only when that is clearly what they want; ask when ambiguous. |
| "Different words so rule doesn't apply" | Spirit over letter. |
