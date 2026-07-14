# Implement bober-security-auditor agent, runSecurityAudit core, and stack knowledge injection

**Contract:** sprint-spec-20260712-security-audit-agent-team-2  ·  **Spec:** spec-20260712-security-audit-agent-team  ·  **Completed:** 2026-07-12

## What this sprint added

The **audit engine** on top of sprint 1's typed foundation: a callable, provider-agnostic
`runSecurityAudit` core, a **fail-closed** JSON parser, a `StackKnowledgeInjector`
(`resolveStackSecurityContext`) that makes the auditor prompt stack-aware **without a per-stack
agent**, and the `agents/bober-security-auditor.md` read-only subagent definition. The core mirrors
`runCodeReviewer`'s shape (build prompt → `runAgenticLoop` with read-only tools → parse → persist via
`saveSecurityAudit`) but **inverts** the reviewer's benign parse fallback: unparseable auditor output
yields `parsed:false` and a forced `verdict:'blocked'`, never a silent empty-critical pass. It is a
**callable core only** — no pipeline gate, CLI, scanner execution, or hub emission yet (sprints 3-6).
The auditor is deliberately **bash-less** (read-only `curator` tool set), so `runCodeReviewer` and its
fallback stay untouched.

## Public surface

- `runSecurityAudit(contract, evaluation, projectRoot, config, priors?)` (`src/orchestrator/security-auditor-agent.ts:44`)
  — `async (SprintContract, EvaluationRunResult | null, string, BoberConfig, SecurityFinding[] = []) →
  Promise<SecurityAuditResult>`. Resolves the stack context, builds the prompt, drives `runAgenticLoop`
  with **read-only** tools, parses fail-closed, and **persists** via `saveSecurityAudit` before
  returning. Two distinct failure modes: a provider/network/budget error **throws** (propagates); an
  **unparseable** response **resolves** `parsed:false`, `verdict:'blocked'` (and `saveSecurityAudit`
  is never called on a throw).
- `parseSecurityAuditResult(text, contractId, specId)` (`src/orchestrator/security-auditor-agent.ts:228`)
  — `→ { review: ReviewResult; parsed: boolean }`. Same resilient extraction ladder as
  `code-reviewer-agent.ts:parseReviewResult` (direct parse → markdown-fence → first-`{`-to-last-`}`
  slice) but **fail-closed**: garbage text, truncated JSON, or a non-object shape returns
  `parsed:false` with an empty review. A JSON **array** is also rejected (`!Array.isArray`) — stricter
  than the code reviewer — since an array is valid JSON but not a `ReviewResult`.
- `resolveStackSecurityContext(stack, skillsRoot?)` (`src/orchestrator/stack-knowledge.ts:185`)
  — `async (Stack | string | undefined, string?) → Promise<StackSecurityContext>`. Maps the
  declared/detected stack to the matching skill's security checklist plus the generic taxonomy.
  **Never throws** — any fs error degrades to the generic fragment. `skillsRoot` is a test-injection
  override; production reads the bundled package `skills/` directory.
- `StackSecurityContext` (`src/orchestrator/stack-knowledge.ts:20`) — `{ stackLabel: string; skillName:
  SecuritySkillName | null; taxonomy: VulnClass[]; promptFragment: string }`. `promptFragment` is
  injected **verbatim** into the auditor prompt and is never empty.
- `SecuritySkillName` (`src/orchestrator/stack-knowledge.ts:12`) — `'bober.solidity' | 'bober.anchor' |
  'bober.react'`, the stack skills that ship a security checklist.
- `ALL_VULN_CLASSES` (`src/orchestrator/stack-knowledge.ts:38`) — the fixed `VulnClass[]` taxonomy
  backbone (`injection`, `authn-authz`, `secret-handling`, `input-validation`, `path-traversal`,
  `privilege-escalation`); does not vary by stack. Also used by the parser to validate a finding's
  optional `vulnClass` tag.
- `agents/bober-security-auditor.md` — the read-only auditor subagent definition. Frontmatter tools are
  **`Read` / `Grep` / `Glob` only** (no `Write`/`Edit`/`Bash`), model `opus`. Body specifies the exact
  `ReviewResult` JSON output contract (findings organised by `VulnClass`, each cited with
  `path`+`line`+`snippet`), the severity bucket definitions, and a **Fail-Closed Parsing** section
  explaining why a malformed/truncated response is treated as **blocked**, never a pass.

## How to use / how it fits

`runSecurityAudit` is the single core the later sprints consume — the fail-closed pipeline gate
(sprint 3) and the standalone `bober security-audit` CLI (sprint 4) both call it and act on the
returned `{ parsed, verdict }`:

```ts
import { runSecurityAudit } from "agent-bober/dist/orchestrator/security-auditor-agent.js";

// In-pipeline (post-evaluation) audit:
const audit = await runSecurityAudit(contract, evaluation, projectRoot, config);
// audit.verdict === "blocked"  → parse failure OR a critical finding
// audit.parsed  === false      → auditor output was unusable (gate treats this as an audit error)

// Standalone audit (no prior evaluation context):
const audit2 = await runSecurityAudit(contract, null, projectRoot, config);
```

- **Stack awareness, one resolver.** `resolveStackSecurityContext` detects the stack from
  `config.project.stack` (a `StackSchema` object, or a plain string in tests) — checking
  `blockchain`/`language` **before** frontend/backend, since blockchain values are more determinative —
  maps `solidity→bober.solidity`, `anchor→bober.anchor`, `react→bober.react`, and reads a **bounded**
  excerpt of the skill's security section (never the whole ~400-line file: `MAX_EXCERPT_CHARS = 2500`).
  When no security-titled heading exists it falls back to a bounded head excerpt; an unknown/absent
  stack or an unreadable skill file degrades to `{ skillName: null }` with the generic taxonomy alone.
  The generic fragment is sourced from `resolveLensFocus('security')` in `eval-lenses.ts`.
- **Provider-agnostic.** All LLM interaction goes through `createClient(config.security?.provider,
  endpoint, providerConfig, model, "SecurityAuditor")` + `runAgenticLoop` — honoring
  `config.security.{model (default `opus`), provider, endpoint, providerConfig, maxTurns (default 20),
  budget.maxUsd}`. No provider SDK is imported outside `src/providers/`.
- **Sprint-5 seam.** The optional `priors: SecurityFinding[]` parameter (default `[]`) is rendered into
  a `# Deterministic scanner findings (ground truth priors)` prompt section only when non-empty; it
  also sets `SecurityAuditResult.scannerRan`. The signature is in place now so sprint 5 plugs in the
  deterministic scanner without churn.
- **Verdict source.** The verdict is `deriveVerdict(review)` (sprint 1) **only when** `parsed` is true;
  `parsed:false` short-circuits to `'blocked'`. A genuinely clean audit (empty `critical`, well-formed
  JSON) is `parsed:true` / `verdict:'pass'` and is distinguishable from the parse-failure case.

## Notes for maintainers

- **The auditor is deliberately bash-less (iteration-2 fix).** It resolves the **`curator`** role's
  tool set — `read_file`, `glob`, `grep`, exactly — for both `resolveRoleTools` and
  `assembleSystemPrompt`, so it can never run a shell command (contract `nonGoals[3]`). Iteration 1 had
  granted the `evaluator` role's tools, which include `bash`; the evaluator flagged this as a nonGoal
  violation. Two **mutation-sensitive** regression tests assert `bash`/`write_file`/`edit_file` never
  appear in the tools array **nor** the `toolHandlers` map, exercising the **real** `resolveRoleTools`
  (via `vi.importActual`, not a mock) — so a future re-drift to a bash-bearing role fails the suite.
- **No bash means no `git diff`.** Because the auditor cannot shell out, it audits the **current
  content** of the contract's `estimatedFiles` (enumerated with Glob, Read in full), not a diff — in
  both in-pipeline and standalone mode. The prompt builder and the `.md` body were reworked
  accordingly. This is a deliberate consequence of the read-only mandate, not a limitation to "fix".
- **`curator` was reused, not a new role.** Adding a new `AgentRole` would have forced updates to closed
  `Record` maps in `src/graph/preflight-injector.ts` and `src/graph/prompts.ts`; `curator` was already
  exactly `['read_file','glob','grep']` and registered in `gatedRemovalRoles`. `tools/index.ts` is
  untouched.
- **The fail-closed inversion is new code for the security path only.** `code-reviewer-agent.ts` and
  its benign fallback are **untouched** (verified via `git diff --stat`). Do not "unify" the two
  parsers — the divergence (fail-closed vs fail-open, array rejection) is the point.
- **`bober.anchor` falls back to a head excerpt.** Its security content lives under a
  non-"security"-titled heading, so the keyword heading match misses it and it degrades to a bounded
  head excerpt. This is a documented `bober:` ceiling in `stack-knowledge.ts` naming a per-skill
  heading-registry as the upgrade path — out of scope for a single generic resolver.
- **Not yet wired.** This sprint exports a callable core only. The fail-closed pipeline gate (sprint 3),
  the standalone `bober security-audit` CLI (sprint 4), scanner execution (sprint 5), and hub emission
  (sprint 6) consume it later. Exports for those sprints: `runSecurityAudit`,
  `parseSecurityAuditResult`, `resolveStackSecurityContext`.

## Scope

Iteration 1 (three commits) — `0990156` (StackKnowledgeInjector), `ddf27bc` (agent definition),
`e5cf267` (`runSecurityAudit` core + fail-closed parse) — created exactly the estimated files: new
`src/orchestrator/stack-knowledge.ts` (+ test), `src/orchestrator/security-auditor-agent.ts` (+ test),
and `agents/bober-security-auditor.md`. Iteration 2 (`40c1488`) applied the nonGoal fix — removed the
`Bash` tool by switching the auditor from the `evaluator` role to the read-only `curator` role and
adding the two regression tests — with all seven success criteria already passing from iteration 1. The
cumulative diff touches only the five expected files; `code-reviewer-agent.ts`, `bober.config.json`, and
`tools/index.ts` are untouched. Full suite **3929 → 3960** green; all 7 required criteria (sc-2-1..2-7)
passed at iteration 2.
