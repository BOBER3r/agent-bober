# Architecture: Security Audit Agent Team

**Architecture ID:** arch-20260712-security-audit-agent-team
**Generated:** 2026-07-12
**Status:** draft

---

## Executive Summary

Code produced by the agent-bober pipeline ships with no blocking security review — the only post-evaluation audit is advisory and never blocks — so a vulnerability in code that manages real customer funds can pass undetected. This architecture adds a single stack-aware `bober-security-auditor` role driving one `runSecurityAudit()` core, reused by two thin entry points: an in-pipeline fail-closed gate that vetoes `sprint-passed` on any critical finding, and a standalone `bober security-audit` command for on-demand deep audits. Stack expertise is injected via existing skills selected by `config.project.stack`, and findings reuse the locked `ReviewResult`/`ReviewFinding` shapes organised by the existing security-lens vulnerability taxonomy. The key tradeoff accepted is a single LLM judgment call per audit (mitigated by an opt-in deterministic scanner pre-filter) in exchange for a byte-identical-when-unconfigured, provider-agnostic design that adds new stack coverage by adding skills, not agents. The primary risk is a false negative from a stack skill missing a vulnerability class, mitigated by scanner `command` pre-filters and treating skill checklists as the versioned coverage contract.

---

## Problem Statement

**Problem:** Code produced by the agent-bober pipeline ships with no dedicated, blocking security review — the only post-evaluation audit (`src/orchestrator/code-reviewer-agent.ts:41-45`) is advisory and never blocks completion, so a vulnerability (reentrancy, injection, broken access control, leaked secret) in code that manages real customer funds can pass the pipeline undetected.

**Constraints:**
- Latency: no hard number. Precedent: post-evaluator stages must be time-boxed and never hang the pipeline — code-reviewer runs under `reviewTimeoutMs` default 300_000ms (`src/config/schema.ts:190`, `Promise.race` at `pipeline.ts:476-482`). The security stage inherits the ~300s time-box and must fail safe on timeout.
- Throughput: not specified; unit of work is a sprint diff or one codebase, not a request stream.
- Data volume: not applicable — bounded by project checkout size.
- Cost ceiling: none global. Precedent: optional per-run USD budget (`BudgetSectionSchema`, `src/config/schema.ts:48-51`); the security agent must accept optional `budget.maxUsd`.
- Backward compatibility: HARD CONSTRAINT — additive, opt-in, byte-identical when unconfigured (repo-wide invariant: evaluator panel `{enabled:false}`, medical egress axes default false, telemetry default false, `parallelReadOnlyTools` absent = byte-identical serial loop).
- False-negative cost: DOMINANT QUALITY CONSTRAINT — financial domain; a missed vulnerability means fund loss. Mirrors the medical module's fail-closed posture (`src/medical/consent.ts` fail-closed consent, `src/medical/guardrails.ts` red-flag short-circuit).

**Consumers:** (1) In-pipeline: the orchestrator at the post-sprint attachment point (`pipeline.ts:466` today for the advisory reviewer). (2) On-demand: a human operator running a standalone deep audit (`bober code-review` standalone-verb precedent). Downstream: run history (`appendHistory`), persisted artifacts, priority hub. Must run under any LLM provider (Claude/GPT/Gemini/Ollama/DeepSeek) including fleet children.

**Success Criteria:**
- Seeded stack-appropriate vulnerability detected (Solidity: reentrancy/front-running/access-control per `skills/bober.solidity/SKILL.md:401`; Node/TS/web: injection/authn-authz/secrets/input-validation/path-traversal/privilege-escalation per the `eval-lenses.ts` security fragment).
- As an in-pipeline GATE, a critical finding prevents `sprint-passed` (unlike the never-blocking code-reviewer).
- Zero behavior change when disabled/unconfigured (byte-identical test convention).
- Structured cited findings (path + line + snippet + severity) matching `ReviewResult`/`ReviewFinding` (`code-reviewer-agent.ts:15-37`).
- Completes within the time-box or fails safe (no pipeline hang).

**Locked Dependencies:** generator→evaluator→code-reviewer→documenter flow and the code-reviewer's advisory semantics (security = NEW stage/gate, not a mutation); `SprintContract`/`EvalResult`/`ReviewResult` JSON contract shapes; provider-agnostic adapter boundary (`src/providers/types.ts`); Zod config schemas (`src/config/schema.ts`); filesystem state only; medical safety guarantees must not regress; existing `security` lens fragments (`arch-lenses.ts` + `eval-lenses.ts`) are the canonical vocabulary — no parallel taxonomy.

---

## System Overview

Security auditing is added as a single `bober-security-auditor` role — divided by ROLE like every other agent in `agents/*.md`, never by stack — driving one `runSecurityAudit()` core. Stack expertise is DATA: the `StackKnowledgeInjector` maps `config.project.stack` (`StackSchema`, `schema.ts:8-16`) to the matching skill (`bober.solidity`, `bober.anchor`, `bober.react`) and the per-vulnerability-class taxonomy from the `security` lens fragment, producing a prompt fragment for the auditor. The core emits the locked `ReviewResult` shape wrapped as `SecurityAuditResult`, so persistence and rendering reuse existing reviewer code unchanged.

The one core is reused by exactly two thin entry points, mirroring the code-reviewer's proven one-core-two-entry shape. The `SecurityAuditGate` wraps the core in a time-boxed, fail-closed veto attached between the `evaluation.passed` check and the `sprint-passed` commit (`pipeline.ts:434-437`); it blocks on any critical finding, timeout, audit error, or parse failure, and is byte-identical when `config.security` is absent. The `SecurityAuditCommand` exposes `bober security-audit [target]` for on-demand audits with a CI-friendly exit code. An opt-in `SecurityScannerPreFilter` runs configured deterministic scanner commands under the shared time-box as ground-truth priors; when no scanners are configured the audit is a pure LLM pass.

---

## Component Breakdown

### SecurityAuditGate

**Responsibility:** Wraps `runSecurityAudit` in a time-boxed, fail-closed veto that prevents the `sprint-passed` history event whenever a critical security finding is present or the audit times out.

**Interface:**
```typescript
interface SecurityAuditGate {
  evaluate(input: SecurityGateInput): Promise<SecurityGateVerdict>;
}
type SecurityGateInput = {
  contract: SprintContract;
  evaluation: EvaluationRunResult;
  projectRoot: string;
  config: BoberConfig;
};
type SecurityGateVerdict = {
  blocked: boolean;
  reason: 'critical-finding' | 'timeout' | 'audit-error' | 'clean' | 'disabled';
  result?: SecurityAuditResult;
};
```
**Dependencies:** [runSecurityAudit, SecuritySectionSchema, SecurityAuditResult]

---

### SecurityAuditCommand

**Responsibility:** Provides the standalone `bober security-audit` CLI entry point that runs `runSecurityAudit` on demand against any codebase and persists the result, independent of the pipeline.

**Interface:**
```typescript
interface SecurityAuditCommand {
  run(input: SecurityAuditCommandInput): Promise<SecurityAuditResult>;
}
type SecurityAuditCommandInput = {
  projectRoot: string;
  config: BoberConfig;
  target?: string;
};
```
**Dependencies:** [runSecurityAudit, SecurityAuditStore, SecuritySectionSchema]

---

### runSecurityAudit

**Responsibility:** Drives the provider-agnostic `bober-security-auditor` subagent to produce a stack-aware `SecurityAuditResult` organised by the security-lens vulnerability taxonomy, reused verbatim by both entry points.

**Interface:**
```typescript
function runSecurityAudit(
  contract: SprintContract,
  evaluation: EvaluationRunResult | null,
  projectRoot: string,
  config: BoberConfig,
): Promise<SecurityAuditResult>;
```
**Dependencies:** [StackKnowledgeInjector, SecurityScannerPreFilter, SecurityAuditStore, SecuritySectionSchema, SecurityAuditResult]

---

### SecurityAuditResult / SecurityFinding

**Responsibility:** Defines the audit output shape by wrapping the locked `ReviewResult`/`ReviewFinding` types with a derived verdict and stack tag, so persistence and rendering reuse the existing reviewer code unchanged.

**Interface:**
```typescript
interface SecurityFinding extends ReviewFinding {
  vulnClass?: VulnClass;
}
type VulnClass =
  | 'injection' | 'authn-authz' | 'secret-handling'
  | 'input-validation' | 'path-traversal' | 'privilege-escalation';
interface SecurityAuditResult {
  review: ReviewResult;        // LOCKED shape; critical[] = the blocking bucket
  stack: string;
  scannerRan: boolean;
  parsed: boolean;             // false => auditor output unparseable; gate blocks
  verdict: 'pass' | 'blocked'; // derived: blocked iff review.critical.length > 0
}
```
**Dependencies:** [] (reuses locked `ReviewResult`/`ReviewFinding` from `src/orchestrator/code-reviewer-agent.ts:17-37`)

---

### SecuritySectionSchema

**Responsibility:** Declares the opt-in, default-off Zod config section that gates the audit core, carrying timeout, fail-closed posture, budget ceiling, model routing, and deterministic scanner commands.

**Interface:**
```typescript
const SecuritySectionSchema = z.object({
  enabled: z.boolean().default(false),
  failClosed: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(300_000),
  model: ModelChoiceSchema.default('opus'),
  maxTurns: z.number().int().min(1).default(20),
  provider: z.string().optional(),
  endpoint: z.string().nullable().optional(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
  budget: BudgetSectionSchema.optional(),
  scanners: z.array(EvalStrategySchema).default([]),
});
// wired: BoberConfigSchema gains  security: SecuritySectionSchema.optional()
```
**Dependencies:** [] (extends `src/config/schema.ts`; reuses `BudgetSectionSchema`, `EvalStrategySchema`, `ModelChoiceSchema`)

---

### SecurityAuditStore

**Responsibility:** Persists each audit as human-readable markdown under `.bober/security/`, kept separate from the advisory reviewer's `.bober/reviews/` artifacts.

**Interface:**
```typescript
interface SecurityAuditStore {
  saveSecurityAudit(projectRoot: string, contractId: string, result: SecurityAuditResult): Promise<void>;
  readSecurityAudit(projectRoot: string, contractId: string): Promise<string | null>;
  listSecurityAudits(projectRoot: string): Promise<string[]>;
}
// writes .bober/security/<contractId>-security-audit.md via renderReviewMarkdown(result.review)
```
**Dependencies:** [SecurityAuditResult]

---

### StackKnowledgeInjector

**Responsibility:** Maps `config.project.stack` to the matching stack skill and security-lens taxonomy, producing the prompt fragment injected into the auditor so one role covers every stack.

**Interface:**
```typescript
interface StackKnowledgeInjector {
  resolve(stack: Stack | undefined): StackSecurityContext;
}
type StackSecurityContext = {
  stackLabel: string;
  skillName: 'bober.solidity' | 'bober.anchor' | 'bober.react' | null;
  taxonomy: VulnClass[];
  promptFragment: string;
};
```
**Dependencies:** [] (reads `config.project.stack` typed by `StackSchema`; taxonomy from the `security` fragment in `src/orchestrator/eval-lenses.ts:8`)

---

### SecurityScannerPreFilter

**Responsibility:** Runs the configured deterministic scanner commands within the audit time-box and returns their output as `SecurityFinding` priors, giving the LLM auditor a ground-truth pre-filter.

**Interface:**
```typescript
interface SecurityScannerPreFilter {
  run(input: ScannerPreFilterInput): Promise<SecurityFinding[]>;
}
type ScannerPreFilterInput = {
  scanners: EvalStrategy[];
  projectRoot: string;
  signal: AbortSignal;
};
```
**Dependencies:** [SecurityFinding] (reuses the `command` field of the locked `EvalStrategy`, `src/config/schema.ts:74-88`)

---

## Data Model

Filesystem state only. The audit result reuses the locked `ReviewResult`/`ReviewFinding` shapes; new types wrap them and add config plus two history event kinds.

```typescript
type VulnClass =
  | 'injection' | 'authn-authz' | 'secret-handling'
  | 'input-validation' | 'path-traversal' | 'privilege-escalation';

interface SecurityFinding extends ReviewFinding {  // ReviewFinding: { path, line, snippet, severity, description }
  vulnClass?: VulnClass;
}

interface SecurityAuditResult {
  review: ReviewResult;         // { critical: ReviewFinding[]; important: ReviewFinding[]; ... } — LOCKED
  stack: string;
  scannerRan: boolean;
  parsed: boolean;
  verdict: 'pass' | 'blocked';  // derived: review.critical.length > 0
}

type SecuritySection = {         // z.infer<typeof SecuritySectionSchema>, config.security (optional)
  enabled: boolean; failClosed: boolean; timeoutMs: number;
  model: ModelChoice; maxTurns: number;
  provider?: string; endpoint?: string | null;
  providerConfig?: Record<string, unknown>;
  budget?: BudgetSection; scanners: EvalStrategy[];
};

// New append-only history event kinds (src/state/history):
type SecurityHistoryEvent =
  | { kind: 'security-audit-clean'; contractId: string; stack: string; scannerRan: boolean }
  | { kind: 'security-audit-blocked'; contractId: string;
      reason: 'critical-finding' | 'timeout' | 'audit-error';
      critical: number; findings: Array<{ path: string; line: number; vulnClass?: VulnClass }> };
```

---

## API Contracts

| Method | Input | Output | Error Cases |
|--------|-------|--------|-------------|
| SecurityAuditGate.evaluate | SecurityGateInput | SecurityGateVerdict | Never throws. runSecurityAudit rejects → `{blocked:true, reason:'audit-error'}`; race timeout → `{blocked:true, reason:'timeout'}`; `result.parsed===false` → `{blocked:true, reason:'audit-error'}`; config absent / `enabled!=true` → `{blocked:false, reason:'disabled'}` |
| runSecurityAudit | (contract, evaluation \| null, projectRoot, config) | SecurityAuditResult | Provider/network/budget error → throws (gate converts to fail-closed block); unparseable output → fallback result with `parsed:false` (gate blocks); scanner throw isolated by pre-filter |
| SecurityScannerPreFilter.run | {scanners, projectRoot, signal} | SecurityFinding[] | Never throws. Missing binary / nonzero exit → that scanner yields `[]`; AbortSignal fired → SIGKILL child, partial findings |
| StackKnowledgeInjector.resolve | Stack \| undefined | StackSecurityContext | Never throws. Unknown/absent stack → `{skillName:null, generic taxonomy, stack-agnostic fragment}` |
| SecurityAuditStore.saveSecurityAudit | (projectRoot, contractId, result) | Promise<void> | fs/permission error → throws to caller; gate wraps in try/catch + logs — store failure MUST NOT change the computed verdict |
| SecurityAuditCommand.run | {projectRoot, config, target?} | SecurityAuditResult | audit-error to stderr; exit 2 on blocked, 0 on pass |

---

## Integration Strategy

### Data Flow 1a — In-pipeline gate, CLEAN

```
[pipeline.ts:434] if (evaluation.passed)
  → SecurityAuditGate.evaluate({contract, evaluation, projectRoot, config})
      → (config.security?.enabled === true)
      → Promise.race([ runSecurityAudit(...), timeout(config.security.timeoutMs) ])
           → StackKnowledgeInjector.resolve(config.project.stack) → StackSecurityContext
           → SecurityScannerPreFilter.run({scanners, projectRoot, signal})   // only if scanners configured (ADR-4)
           → createClient(security.provider/endpoint) + runAgenticLoop(bober-security-auditor, read-only tools)
           → parse → SecurityAuditResult { review, stack, scannerRan, parsed:true, verdict }
           → SecurityAuditStore.saveSecurityAudit(...)   // try/catch, never alters verdict
      → SecurityGateVerdict { blocked:false, reason:'clean', result }
  → appendHistory(security-audit-clean, {stack, scannerRan})
  → [resume pipeline.ts:437] status='passed' → sprint-passed (:444) → code-review (:465) → documenter (:513) → return
```

### Data Flow 1b — BLOCKED (critical finding / timeout / audit-error)

```
SecurityAuditGate.evaluate(...) → { blocked:true, reason:'critical-finding'|'timeout'|'audit-error', result? }
  → appendHistory(security-audit-blocked, {reason, critical:N, findings:[{path,line,vulnClass}]})
  → currentContract.evaluatorFeedback = renderSecurityFeedback(verdict)   // ADR-5
  → updateContract(projectRoot, currentContract)
  → sprint-passed NOT appended; status NOT 'passed'
  → defer to the existing eval-failed tail (mirror pipeline.ts:588-597):
       iteration >= maxIterations ? status='needs-rework' → return : emit(sprint-fail-retry) → continue
       // findings appear in evalFeedbackParts next round (pipeline.ts:250-274)
  → documenter NEVER runs (ADR-6)
```

### Data Flow 1c — DISABLED (byte-identical no-op)

`config.security?.enabled` is `undefined` → the `if` guard is false → not a single new statement executes.

### Data Flow 2 — Standalone CLI

```
$ bober security-audit [target]
  → src/cli/index.ts .command("security-audit [target]")   // Commander pattern, cf. .command("eval")
  → SecurityAuditCommand.run({ projectRoot, config, target })
      → synthesize lightweight SprintContract descriptor from target (or working tree)
      → runSecurityAudit(descriptor, null, projectRoot, config)   // evaluation=null
      → SecurityAuditStore.saveSecurityAudit(projectRoot, descriptor.contractId, result)
  → print summary; exit code = verdict === 'blocked' ? 2 : 0   // CI-gate friendly
```

### Consistency Model

Strong within a sprint round — the verdict is computed synchronously on the single pipeline process, gating `sprint-passed` in the same control flow. Contract mutation and history append are sequential, append-only filesystem writes. The persisted markdown is a human-readable snapshot only, never read back to recompute the verdict. **Source of truth:** the in-memory `SecurityAuditResult.verdict` (derived `review.critical.length > 0`), with the gate elevating timeout/audit-error/parse-failure to blocked; the durable record of the DECISION is the `security-audit-blocked`/`security-audit-clean` history event, not the markdown file.

### External Dependencies

| Service | Used By | Failure Mode | Fallback |
|---------|---------|--------------|----------|
| LLM provider (Anthropic / OpenAI-compat / claude-code via createClient) | runSecurityAudit | outage/auth/budget → runAgenticLoop throws | Fail-closed: gate blocks (audit-error); standalone exits 2; never falls back to 'clean' |
| Optional scanner binaries (slither/semgrep via config.security.scanners) | SecurityScannerPreFilter | missing / nonzero exit / hang | Per-scanner isolation: missing→`[]`, hang→SIGKILL; LLM auditor still runs — scanner absence never yields a false 'pass' |
| Stack skills (bober.solidity/anchor/react) | StackKnowledgeInjector | skill file absent | `{skillName:null, generic taxonomy}`; audit runs stack-agnostically |
| Filesystem (.bober/security/) | SecurityAuditStore | write/permission error | Caught + logged; verdict unaffected |

---

## Architecture Decision Records

- [ADR-1: Security auditing as one stack-aware role with a fail-closed gate, not per-stack agents](.bober/architecture/arch-20260712-security-audit-agent-team-adr-1.md)
- [ADR-2: Fail-closed security gate — veto on critical findings and timeouts](.bober/architecture/arch-20260712-security-audit-agent-team-adr-2.md)
- [ADR-3: Persist security audits to a separate `.bober/security/` store](.bober/architecture/arch-20260712-security-audit-agent-team-adr-3.md)
- [ADR-4: Deterministic scanner pre-filter as an opt-in component](.bober/architecture/arch-20260712-security-audit-agent-team-adr-4.md)
- [ADR-5: Blocked security gate feeds findings to the generator as retry feedback](.bober/architecture/arch-20260712-security-audit-agent-team-adr-5.md)
- [ADR-6: A security-blocked sprint skips the documenter](.bober/architecture/arch-20260712-security-audit-agent-team-adr-6.md)

---

## Risk Assessment

| Risk | Severity | Owner | Mitigation |
|------|----------|-------|------------|
| Unparseable auditor output → `parseReviewResult` fallback (`code-reviewer-agent.ts:325-337`) returns empty critical → false 'pass' | critical | runSecurityAudit / SecurityAuditGate | `parsed:boolean` on SecurityAuditResult; gate treats `parsed===false` as audit-error → blocked (inverts code-review's benign fallback) |
| Vulnerable commit already landed (auto-commit at `pipeline.ts:365` precedes the gate) | high | SecurityAuditGate | Retry regenerates + commits a fix (symmetric with evaluation-failed); intermediate commit squashed on merge; do NOT auto-revert |
| Budget exhaustion mid-audit | high | runSecurityAudit | Fail-closed: audit-error → blocked (ADR-2); operator raises `maxUsd`/`timeoutMs`; incomplete audit never 'clean' |
| Provider outage | high | runSecurityAudit | Fail-closed block (audit-error); no fallback-to-clean; standalone exits 2 |
| Timeout leaves background LLM/scanner running (`Promise.race`, cf. `pipeline.ts:478`) | medium | SecurityAuditGate / SecurityScannerPreFilter | AbortSignal SIGKILLs scanner children; LLM call finishes in background (already blocked; cost bounded by `security.budget.maxUsd`) |
| Store write failure flips the verdict | medium | SecurityAuditStore | Verdict computed in-memory BEFORE persistence; save failure caught + logged |
| Retry with no actionable information → same vuln re-introduced → burns maxIterations | medium | runSecurityAudit (renderSecurityFeedback) | ADR-5: SecurityFinding evidence injected into `evalFeedbackParts` |
| Scanner hang with AbortSignal not wired | medium | SecurityScannerPreFilter | Pre-filter executes UNDER the shared time-box with injected AbortSignal, SIGKILL on abort |
| Store clobber (concurrent standalone + pipeline audit, same contractId) | low | SecurityAuditStore | contractId-keyed filenames; file advisory-only (verdict in history); ad-hoc targets use timestamped descriptor ids |
| Fleet children racing the store | low | SecurityAuditGate | Each child owns a distinct contractId; per-child gate; never touches the blackboard |

---

## Open Questions

- **Scanner binary choices and output parsers per stack:** Which deterministic scanners (slither for Solidity, semgrep for Node/TS, etc.) become the recommended `config.security.scanners` defaults, and who owns the per-scanner output-to-`SecurityFinding` parser. Assumed deferred to implementation because the `command` EvalStrategy shape accepts any binary; if a stack's canonical scanner emits a non-standard format, its parser is extra implementation work not scoped here.
- **Standalone severity threshold config:** Whether `bober security-audit` needs its own severity threshold (e.g. exit 2 on important-bucket findings, not only critical) distinct from the pipeline gate's critical-only veto. Assumed no separate threshold for the first cut (both use `review.critical.length > 0`); if CI operators want stricter standalone gating, a `security.standaloneBlockOn` field is the extension point.
- **Important-bucket surfacing:** Whether important (non-blocking) findings should warn in Telegram/hub surfaces rather than only landing in the `.bober/security/` markdown. Assumed markdown-only for now; wiring important findings into the priority hub as low-severity Findings is a follow-up that must respect the hub's canonical `FindingSchema`.
- **Stack→skill map completeness:** For stacks in `StackSchema` with no dedicated security skill, `StackKnowledgeInjector.resolve` returns `{skillName:null, generic taxonomy}`. Whether every shipped stack should get a dedicated skill checklist before enabling the gate on that stack is open; if a stack runs gated with only the generic taxonomy, coverage is weaker and a stack-specific vuln class may be missed (the ADR-1 residual risk).
- **`bober-security-auditor` tool surface:** The auditor is specified to run with read-only tools; whether it may also invoke the scanner binaries directly (versus receiving pre-filter output as priors) is assumed read-only-plus-priors, keeping deterministic execution in `SecurityScannerPreFilter` under the shared AbortSignal. If direct tool invocation is later allowed, the time-box/abort wiring must extend to those calls.
