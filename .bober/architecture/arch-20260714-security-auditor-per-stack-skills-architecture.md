# Architecture: Per-Stack Security Auditor with Skill-File Signatures + Adversarial Verifier

**Architecture ID:** arch-20260714-security-auditor-per-stack-skills
**Generated:** 2026-07-14
**Status:** draft

---

## Executive Summary

The bober-security-auditor has strong fail-closed orchestration but near-zero security knowledge, so it cannot find the money-loss, credential-theft, and supply-chain bugs that iGaming and DEX/crypto customers depend on it for. This architecture adds per-stack security knowledge as human-editable skill files (`skills/bober.security-<stack>/SKILL.md` for 7 stacks + generic) parsed into typed signatures behind a top-K retrieval index, a fresh-context adversarial verifier stage that downgrades false-positive criticals, deterministic supply-chain scanners + an offline diff inspector, a widened vulnerability taxonomy with structured `cwe`/`severity`/`taint` metadata, and an orchestrator-owned real-diff provider. Every addition is additive over the proven fail-closed gate, read-only auditor, and hub-emission bones, and is default-off so a config omitting `security` stays byte-identical. The accepted tradeoff is a second sequential LLM stage inside the existing 300s time-box (bounded by a shared `AbortController` and `verifier.maxTurns` 10); the primary risk is the verifier over-pruning a real critical, mitigated by downgrade-only + fail-closed `ran:false ⇒ keep` semantics that make the system eventually-stricter, never eventually-looser.

---

## Problem Statement

**Problem:** The auditor ships strong fail-closed orchestration but near-zero security knowledge — a one-sentence generic checklist (eval-lenses.ts:7-8), a 6-class taxonomy with no money/credential/supply-chain classes (security-audit-types.ts:9-15), zero supply-chain/secret coverage, a single-pass loop with no verifier (security-auditor-agent.ts:48), and a stack resolver where 2 of 3 mapped stacks inject non-security filler (stack-knowledge.ts:124-144).

**Constraints:**
- Latency: whole audit runs inside the gate `Promise.race` time-box (default `timeoutMs` 300s, schema.ts:214) or is excluded from it; hub emission is outside the box.
- Throughput: one audit per sprint, post-evaluation, when `config.security.enabled === true` (pipeline.ts:453).
- Data volume: whole-repo LLM context degrades past ~3000 chars and diff-only misses cross-file sinks — context-scoping is a correctness constraint.
- Cost ceiling: optional `budget.maxUsd` (schema.ts:221); model default opus, finder `maxTurns` 20.
- Backward compatibility: fail-closed parse `parsed:false ⇒ blocked` (security-auditor-agent.ts:146); gate never throws (security-gate.ts:83); read-only curator toolset — no Bash/Write/Edit (security-auditor-agent.ts:62-68); IRON-LAW file:line evidence; hub emission OUTSIDE the time-box (security-gate.ts:123); stable hub Finding id (security-hub.ts:75-108); `deriveVerdict` blocked iff `critical[] > 0` (security-audit-types.ts:52); `config.security` `.optional()`/no-top-level-default/additive so a config omitting it stays byte-identical (schema.ts:205-206); LOCKED `ReviewResult`/`ReviewFinding` — `SecurityFinding` only EXTENDS with optional fields (security-audit-types.ts:23); new network work behind the online-research egress axis, default-off.

**Consumers:** the sprint pipeline gate (a blocked verdict feeds `renderSecurityFeedback` into the generator's next retry — every FP is a hard forced retry, pipeline.ts:466); the standalone CLI `bober security-audit [target]` (exit 0/2); the priority hub; the money-handling customer.

**Success Criteria:**
- Each of 7 stacks (solidity, anchor, react, node, payments, igaming, dex-backend) resolves to a REAL security-skill fragment, not the head-excerpt fallback, verified per-stack by test (closes G3).
- Supply-chain scanner kinds report findings on NONZERO exit, verified by an injected-runner test (fixes G9).
- The finder→verifier stage measurably reduces false-positive BLOCKS on a labelled vulnerable/safe corpus while retaining detection — verified, not asserted.
- Widened taxonomy classifies reentrancy/money-logic/supply-chain/IDOR-BOLA to a dedicated `VulnClass`, verified by `inferVulnClass` tests.
- Zero regression — 77 existing security tests green + a config omitting `security` byte-identical.

**Locked Dependencies:** `ReviewResult`/`ReviewFinding` (code-reviewer-agent); the pipeline gate contract (post-eval, `enabled === true`, never-throwing fail-closed gate); the `deriveVerdict` rule; the read-only curator toolset; `config.security` additive/default-off; the stable hub Finding-id scheme.

---

## System Overview

The Hybrid manifests as three layered additions over the existing gate. **Authoring layer:** security knowledge lives on disk as human-editable `skills/bober.security-<stack>/SKILL.md`, each file a list of discrete labelled signature blocks. **Retrieval layer:** at run start `SecurityKnowledgeIndex.load()` parses those blocks (via a total `SecuritySignatureParser`) into typed `SecuritySignature[]` carrying `cwe`/`severity`/`vulnClass`/`invariant`, and `SecuritySignatureSelector.select` picks a top-K set for the changed stack plus a generic floor — replacing the head-excerpt fallback at stack-knowledge.ts:124-144. **Audit layer:** the orchestrator computes one real `AuditDiff`, runs deterministic supply-chain scanners + an offline inspector as priors, runs the finder (read-only curator agent) on the scoped context, then runs a fresh contract-free verifier that downgrades false-positive criticals, and finally applies the untouched `deriveVerdict` to the VERIFIED review. Every new stage is default-off; with all new config keys absent the flow collapses to today's single-pass audit byte-for-byte.

---

## Component Breakdown

### SecuritySignature

**Responsibility:** Carry one typed, retrievable per-stack vulnerability signature parsed from an authored skill block.

**Interface:**
```typescript
type SecurityStackId =
  | "solidity" | "anchor" | "react" | "node"
  | "payments" | "igaming" | "dex-backend" | "generic";

interface SecuritySignature {
  stackId: SecurityStackId;
  signatureId: string;
  title: string;
  cwe: string | null;
  severity: FindingSeverity;
  vulnClass: VulnClass;
  invariant: string;
  unsafeExample: string;
  safeExample: string;
  keywords: string[];
  skillRef: string; // relative path into skills/bober.security-<stack>/SKILL.md
}
```

**Dependencies:** [SecurityAuditTypes]

---

### SecurityAuditTypes

**Responsibility:** Define the widened taxonomy and the optional-field extension of `ReviewFinding` without touching the locked review shapes.

**Interface:**
```typescript
type VulnClass =
  | "reentrancy" | "access-control" | "injection" | "race-condition"
  | "money-integrity" | "ssrf" | "xss" | "insecure-randomness"
  | "crypto-weakness" | "deserialization" | "supply-chain"
  | "idor-bola" | "denial-of-service" | "audit-logging" | "other";
type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";
type FindingConfidence = "confirmed" | "firm" | "tentative";
type TaintPath = { source: string; sink: string; sanitizerPresent: boolean };

interface SecurityFinding extends ReviewFinding {
  cwe?: string;
  severity?: FindingSeverity;
  confidence?: FindingConfidence;
  taint?: TaintPath;
  signatureId?: string;
}
// deriveVerdict(review: ReviewResult): "pass" | "blocked"  — UNCHANGED
```

**Dependencies:** []

---

### SecuritySignatureParser

**Responsibility:** Parse a stack's skill markdown into typed signatures, dropping any malformed block.

**Interface:**
```typescript
interface SecuritySignatureParser {
  parse(
    stackId: SecurityStackId,
    skillMarkdown: string,
    skillRelPath: string,
  ): SecuritySignature[]; // pure, total; malformed blocks dropped, never throws
}
```

**Dependencies:** [SecuritySignature]

---

### SecurityStackRegistry

**Responsibility:** Map a caller-supplied stack string to a canonical `SecurityStackId`, label, and skill name (unknown ⇒ generic).

**Interface:**
```typescript
interface SecurityStackRegistry {
  resolve(stack: string | undefined): {
    stackId: SecurityStackId;
    stackLabel: string;
    skillName: string;
  };
}
// SECURITY_STACK_MAP extends STACK_SKILL_MAP from 3 -> 7 stacks + generic (fixes G3)
```

**Dependencies:** [SecuritySignature]

---

### SecurityKnowledgeIndex

**Responsibility:** Lazily load and memoise all parsed signatures per process and serve them by stack (see ADR-7).

**Interface:**
```typescript
type SecurityKnowledgeIndexOptions = { skillsRoot?: string };

interface SecurityKnowledgeIndex {
  load(): Promise<void>;               // idempotent, cached
  forStack(stackId: SecurityStackId): SecuritySignature[]; // missing skill ⇒ []
  all(): SecuritySignature[];
}
```

**Dependencies:** [SecuritySignatureParser, SecurityStackRegistry]

---

### SecuritySignatureSelector

**Responsibility:** Rank and select the top-K signatures for a change, always including the generic floor.

**Interface:**
```typescript
interface SecuritySignatureSelector {
  select(input: {
    stackId: SecurityStackId;
    changedPaths: string[];
    diffKeywords: string[];
    topK: number;
  }): SecuritySignature[]; // pure ranking; always includes generic-floor signatures
}
```

**Dependencies:** [SecurityKnowledgeIndex]

---

### StackSecurityContextResolver

**Responsibility:** Assemble the never-empty per-stack security prompt fragment from registry, index, and selector (replaces stack-knowledge.ts:185).

**Interface:**
```typescript
interface StackSecurityContext {
  stackId: SecurityStackId;
  stackLabel: string;
  skillName: string;
  taxonomy: VulnClass[];
  signatures: SecuritySignature[];
  promptFragment: string; // NEVER empty
}

function resolveStackSecurityContext(input: {
  stack: string | undefined;
  diff: AuditDiff;
  index: SecurityKnowledgeIndex;
  registry: SecurityStackRegistry;
  selector: SecuritySignatureSelector;
  threatModelText?: string;
}): Promise<StackSecurityContext>;
```

**Dependencies:** [SecurityStackRegistry, SecurityKnowledgeIndex, SecuritySignatureSelector]

---

### SecurityDiffProvider

**Responsibility:** Compute one real audit diff (git + optional graph neighborhood) in orchestrator Node, never throwing (see ADR-5).

**Interface:**
```typescript
type ChangedFile = {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  hunks: DiffHunk[];
};
type DiffHunk = { startLine: number; lineCount: number; content: string };
type AuditDiff = {
  changedFiles: ChangedFile[];
  neighborhoodFiles: string[];
  truncated: boolean;
};
interface SecurityDiffProvider {
  compute(input: {
    projectRoot: string;
    baseRef?: string;
    expandWithGraph: boolean;
    signal: AbortSignal;
  }): Promise<AuditDiff>; // git/graph fail ⇒ empty diff ⇒ finder degrades to estimated-files (fixes G4)
}
```

**Dependencies:** [] // external: git, tokensave GraphClient

---

### SupplyChainScanners

**Responsibility:** Run and parse external supply-chain/secret scanners with per-kind exit semantics (fixes G9).

**Interface:**
```typescript
type ScannerKind =
  | "semgrep" | "npm-audit" | "osv-scanner" | "gitleaks"; // extends existing kinds

function parseNpmAuditOutput(raw: string): SecurityFinding[]; // pure, total
function parseOsvOutput(raw: string): SecurityFinding[];      // pure, total
function parseGitleaksOutput(raw: string): SecurityFinding[]; // pure, total

function scannerExitPolicy(kind: ScannerKind): "zero-clean" | "nonzero-means-findings";
// drives the branch at security-scanners.ts:355; network scanners only when egress.onlineResearch
```

**Dependencies:** [SecurityAuditTypes]

---

### SupplyChainDiffInspector

**Responsibility:** Perform offline, always-available supply-chain checks over the diff (lifecycle scripts, lockfile hosts, `.npmrc`, CI workflows).

**Interface:**
```typescript
interface SupplyChainDiffInspector {
  inspect(input: {
    projectRoot: string;
    diff: AuditDiff;
    signal: AbortSignal;
  }): Promise<SecurityFinding[]>; // vulnClass: "supply-chain"; zero network; never throws
}
```

**Dependencies:** [SecurityAuditTypes, SecurityDiffProvider]

---

### SecurityFinderStage

**Responsibility:** Orchestrate diff → context → priors → finder loop → verifier → verdict while preserving the positional gate call and all fail-closed invariants.

**Interface:**
```typescript
type SecurityAuditDeps = {
  diffProvider?: SecurityDiffProvider;
  index?: SecurityKnowledgeIndex;
  registry?: SecurityStackRegistry;
  selector?: SecuritySignatureSelector;
  supplyChainInspector?: SupplyChainDiffInspector;
  verifier?: SecurityVerifierStage;
};

function runSecurityAudit(
  contract: SprintContract,
  evaluation: EvaluationResult,
  projectRoot: string,
  config: BoberConfig,
  priors?: SecurityFinding[],   // defaults []
  deps?: SecurityAuditDeps,     // positional signature preserved; gate call byte-identical
): Promise<SecurityAuditResult>; // fail-closed parse + read-only curator toolset retained
```

**Dependencies:** [SecurityDiffProvider, StackSecurityContextResolver, SupplyChainScanners, SupplyChainDiffInspector, SecurityVerifierStage, SecurityAuditTypes]

---

### SecurityVerifierStage

**Responsibility:** Re-check the finder's critical+important findings in a fresh contract-free context and downgrade-only (see ADR-2).

**Interface:**
```typescript
type VerifierResult = {
  verified: SecurityFinding[];
  downgraded: SecurityFinding[];
  dropped: SecurityFinding[];
  ran: boolean;
};

interface SecurityVerifierStage {
  verify(input: {
    findings: SecurityFinding[]; // finder critical+important ONLY; never the contract
    diff: AuditDiff;
    projectRoot: string;
    config: BoberConfig;
    signal: AbortSignal;
  }): Promise<VerifierResult>; // own read-only curator loop; ran:false ⇒ criticals KEPT
}
```

**Dependencies:** [SecurityAuditTypes]

---

### SecurityHubMapper

**Responsibility:** Map a verified audit result to stable hub `Finding` rows with signature/cwe-aware titles and tags (fixes G10).

**Interface:**
```typescript
function mapAuditToFindings(
  result: SecurityAuditResult,
  now: Date,
): Finding[];
// title: `[security] <vulnClass>#<signatureId ?? cwe ?? line-hash> at <path>:<line>`
// tags gain cwe:/severity:/confidence:/sig: ; hub finding.ts:10-25 schema UNCHANGED
```

**Dependencies:** [SecurityAuditTypes]

---

### SecuritySectionSchema

**Responsibility:** Extend the optional `config.security` section with new default-off keys, keeping a config omitting them byte-identical.

**Interface:**
```typescript
type SecuritySectionExtension = {
  verifier?: { enabled: boolean; model: string; maxTurns: number }; // {false, "opus", 10}
  supplyChain?: { enabled: boolean; scanners: ScannerKind[] };       // {false, []}
  diff?: { mode: "estimated-files" | "git-diff"; baseRef?: string; expandWithGraph: boolean };
  egress?: { onlineResearch: boolean }; // false
  threatModelPath?: string;
}; // diff.mode default "estimated-files" = today's fail-safe behaviour
```

**Dependencies:** [SupplyChainScanners]

---

## Data Model

**Persistent (on disk):** `skills/bober.security-<stack>/SKILL.md` — canonical human-authored signature source, 7 stacks + generic; `.bober/security/<contractId>-security-audit.md` — the `SecurityAuditResult` (existing). **Persistent (FactStore):** hub `Finding` rows (existing schema, unchanged, finding.ts:10-25). **In-memory/derived:** `SecurityKnowledgeIndex` (parsed `SecuritySignature[]` per-process cache); `AuditDiff` (per run). Full TypeScript for each entity is defined inline in Component Breakdown above; the store/lifecycle mapping:

| Entity | Store | Lifecycle | Source of truth |
|--------|-------|-----------|-----------------|
| `SecuritySignature` | skill files | authored, parsed per process | on-disk skill file (canonical) |
| `SecurityKnowledgeIndex` | in-memory | memoised per process (ADR-7) | derived from skill files |
| `AuditDiff` | in-memory | computed once per run, shared read-only | git + graph |
| `SecurityFinding` (extends `ReviewFinding`, optional fields only) | audit result file | per run | finder → verifier fold |
| `VerifierResult` / `StackSecurityContext` | in-memory | per run | verifier / resolver output |
| hub `Finding` | FactStore | per emitted finding | `mapAuditToFindings` (schema unchanged) |

---

## API Contracts

| Method | Input | Output | Error Cases |
|--------|-------|--------|-------------|
| SecurityDiffProvider.compute | {projectRoot, baseRef?, expandWithGraph, signal} | AuditDiff | git missing/nonzero/abort ⇒ empty diff (never throws) |
| SecurityKnowledgeIndex.load | () | Promise<void> | missing skills ⇒ empty per stack (never throws) |
| SecurityKnowledgeIndex.forStack | stackId | SecuritySignature[] | unknown/missing ⇒ [] |
| SecuritySignatureSelector.select | {stackId, changedPaths, diffKeywords, topK} | SecuritySignature[] | empty index ⇒ generic-floor only (never throws) |
| resolveStackSecurityContext | {stack, diff, index, registry, selector, threatModelText?} | Promise<StackSecurityContext> | any gap ⇒ generic context, promptFragment non-empty (never throws) |
| SupplyChainDiffInspector.inspect | {projectRoot, diff, signal} | Promise<SecurityFinding[]> | I/O error/abort ⇒ [] (never throws) |
| runScannerPreFilter + scannerExitPolicy | {kind, projectRoot, signal} | SecurityFinding[] | ENOENT/nonzero-on-error/abort ⇒ [] per scanner (never throws) |
| runSecurityAudit | (contract, evaluation, projectRoot, config, priors?, deps?) | Promise<SecurityAuditResult> | provider/network/budget ⇒ THROWS → gate audit-error; unparseable ⇒ parsed:false blocked |
| runSecurityVerifier.verify | {findings, diff, projectRoot, config, signal} | Promise<VerifierResult> | provider error/abort ⇒ ran:false, finder criticals kept (never throws) |
| mapAuditToFindings | (result, now) | Finding[] | malformed finding ⇒ skipped row (never throws) |
| evaluateSecurityGate | (contract, evaluation, projectRoot, config) | GateVerdict | disabled ⇒ clean short-circuit; audit throw ⇒ audit-error blocked (never throws) |

---

## Integration Strategy

### Data Flow

```
pipeline.ts → evaluateSecurityGate(contract, evaluation, projectRoot, config)
  disabled? → clean verdict (byte-identical short-circuit)
  else → Promise.race([ runSecurityAudit(...), timeout(timeoutMs) ])
    runSecurityAudit:
      controller = new AbortController()  // keyed to timeoutMs, threaded everywhere
      diff        = SecurityDiffProvider.compute({projectRoot, baseRef?, expandWithGraph, signal})
      index.load()
      ctx         = resolveStackSecurityContext(registry.resolve → index.forStack → selector.select)
      priors'     = [...priors,
                     ...runScannerPreFilter(scannerExitPolicy)   // G9 fix
                     ...SupplyChainDiffInspector.inspect(diff)]  // offline, always-on
      review      = runAgenticLoop(read-only curator, ctx, priors', diff)  // FINDER
                    → parseSecurityAuditResult  // FAIL-CLOSED: parsed:false ⇒ blocked
      vres        = runSecurityVerifier.verify(review.critical+important only, diff)  // contract withheld
                    ran:false ⇒ keep finder criticals
      verified    = fold(vres.verified/downgraded/dropped) + minor + approvedAreas passthrough
      verdict     = parsed ? deriveVerdict(verified) : "blocked"
      saveSecurityAudit(result)
  gate: parsed === false ⇒ audit-error blocked
  emitFindingsToHub(mapAuditToFindings)  // OUTSIDE the time-box, best-effort
  return blocked ? critical-finding : clean
```

### Consistency Model

Mixed, with three sources of truth. (1) **Skill files are canonical**; the index is a derived per-process memoised cache with ≤1-run staleness (ADR-7). (2) **The VERIFIED review is authoritative** — the verifier is downgrade-only and fail-closed, so the system is eventually-stricter, never eventually-looser. (3) **The diff is computed once** by the orchestrator and shared read-only by selector, inspector, finder, and verifier, giving zero drift and keeping the auditor read-only. The finder→verifier ordering is sequential by DATA DEPENDENCY (verifier input = finder output), not for performance; both share one time-box.

### External Dependencies

| Service | Used By | Failure Mode | Fallback |
|---------|---------|--------------|----------|
| git | SecurityDiffProvider | missing/nonzero/abort | empty diff → estimated-files mode |
| tokensave GraphClient | SecurityDiffProvider (neighborhood) | not-ready / ok:false | skip neighborhood; git changedFiles still returned |
| npm-audit / osv-scanner / gitleaks | SupplyChainScanners | ENOENT/nonzero-on-error/abort | per-scanner []; offline inspector still contributes |
| LLM provider | finder + verifier | error/timeout | finder THROWS → gate audit-error; verifier ran:false → keep criticals |
| hub FactStore | emitFindingsToHub | disk/lock error | caught; outside time-box; verdict never flips |

### Integration Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Two sequential LLM stages in one 300s box under a slow provider ⇒ fail-closed block | high | One `AbortController` threaded through both; `verifier.maxTurns` 10 (< 20) + sub-budget; verifier default-off ⇒ single-stage byte-identical |
| Large diff blows the prompt/time-box | high | Provider caps `changedFiles`/hunk bytes + `truncated` flag; selector `topK` cap; `diff.mode` default `estimated-files` (opt-in to git-diff) |
| Verifier over-prunes a real critical | critical | Downgrade-only; `ran:false ⇒ keep`; receives critical+important only, never `approvedAreas` |
| Scanner nonzero-exit findings dropped (G9) | medium | Per-kind `scannerExitPolicy`; ENOENT/throw/abort still ⇒ [] |
| Network scanner leaks by default | high | Network scanners only when `egress.onlineResearch`; offline inspector always-available, zero network |
| Skill/index drift | medium | Per-process cache, ≤1-run staleness; `skillsRoot` injectable; malformed blocks dropped |
| tokensave graph unavailable | low | Gate on `engineHealth === ready`; `GraphResult ok:false` ⇒ skip neighborhood; git changedFiles still returned |
| Double `saveSecurityAudit` clobber | low | Idempotent by `contractId`; value-equivalent write |

---

## Architecture Decision Records

- [ADR-1: Hybrid per-stack knowledge — skill files + typed index + staged verifier](.bober/architecture/arch-20260714-security-auditor-per-stack-skills-adr-1.md)
- [ADR-2: Finder→verifier adversarial stage in a fresh contract-free context](.bober/architecture/arch-20260714-security-auditor-per-stack-skills-adr-2.md)
- [ADR-3: Human-authored signature skill files with a typed retrieval index](.bober/architecture/arch-20260714-security-auditor-per-stack-skills-adr-3.md)
- [ADR-4: Supply-chain as scanner-kinds + offline inspector, not a second LLM auditor](.bober/architecture/arch-20260714-security-auditor-per-stack-skills-adr-4.md)
- [ADR-5: Orchestrator-owned diff provider, not a git/Bash tool for the auditor](.bober/architecture/arch-20260714-security-auditor-per-stack-skills-adr-5.md)
- [ADR-6: Verifier runs inside the gate's single time-box, sequentially after the finder](.bober/architecture/arch-20260714-security-auditor-per-stack-skills-adr-6.md)
- [ADR-7: SecurityKnowledgeIndex is a per-process lazy memoised cache, no runtime invalidation](.bober/architecture/arch-20260714-security-auditor-per-stack-skills-adr-7.md)

---

## Risk Assessment

| Risk | Severity | Owner | Mitigation |
|------|----------|-------|------------|
| Verifier drops a genuine money-loss critical | critical | SecurityVerifierStage | Downgrade-only; `ran:false ⇒ keep`; critical+important input only |
| Slow provider makes finder+verifier exceed 300s | high | SecurityFinderStage | Shared `AbortController`; `verifier.maxTurns` 10 + sub-budget; default-off |
| Large diff exceeds LLM context, degrading detection | high | SecurityDiffProvider | Caps + `truncated` flag; `topK` selection; `estimated-files` default |
| Network scanner egress by default | high | SecuritySectionSchema | Network scanners gated on `egress.onlineResearch`; offline inspector default |
| Nonzero-exit scanner findings silently dropped (G9) | medium | SupplyChainScanners | Per-kind `scannerExitPolicy` drives security-scanners.ts:355 |
| Authored skill block malformed ⇒ stack under-covered | medium | SecuritySignatureParser | Total parser drops malformed; generic-floor signatures always present |
| Index serves stale signatures in a long-lived process | low | SecurityKnowledgeIndex | ≤1-run staleness acceptable per-sprint; `index.reload()` seam if daemon shape arrives |
| Graph neighborhood unavailable ⇒ narrower context | low | SecurityDiffProvider | Gate on `engineHealth`; git changedFiles still returned |

---

## Open Questions

- **Top-K value and ranking weights for `SecuritySignatureSelector`:** assumed a small K (order ~5-8) with keyword+path match ranking plus a fixed generic floor, to stay within the ~3000-char context degradation constraint. If real corpora show cross-file sinks need more signatures, K and the prompt-byte budget must be re-tuned; under-selection would reduce detection recall.
- **Verifier sub-budget split of `budget.maxUsd`:** assumed the verifier gets a minority slice (finder-first) since the finder must run to produce input. If verifier judgement proves budget-starved and returns `ran:false` too often, the split needs rebalancing — the failure is safe (criticals kept) but wastes the FP-reduction benefit.
- **Real scanner tool availability on customer machines:** assumed `npm-audit`/`osv-scanner`/`gitleaks` may be absent; the offline inspector covers the always-on floor. If a customer expects a specific scanner and it is silently ENOENT-skipped, coverage is narrower than assumed — surfacing scanner-not-found as an info finding is a candidate follow-up.
- **Skill-file authoring format precision:** assumed discrete labelled signature blocks with a fixed field set parse cleanly; the exact block delimiter/schema is a Generator-stage decision. If the format is ambiguous, malformed blocks drop and stacks under-cover — a lint/validate command over skill files would de-risk this.
