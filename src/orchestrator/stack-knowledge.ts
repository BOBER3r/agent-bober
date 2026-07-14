import type { VulnClass } from "./security-audit-types.js";

// ── Taxonomy ───────────────────────────────────────────────────────

/**
 * Every VulnClass value (security-audit-types.ts:9-25, widened sprint-1 of
 * spec-20260714-security-auditor-per-stack-skills). The taxonomy does not
 * vary by stack — it is the fixed classification backbone every audit is
 * organised against. Must stay in lockstep with the VulnClass union — see
 * security-audit-types.test.ts's lockstep assertion.
 *
 * The stack -> skill resolver that used to live in this file (detectStack,
 * extractSecurityExcerpt, readSkillSecurityExcerpt, resolveStackSecurityContext,
 * STACK_SKILL_MAP) has moved to src/orchestrator/security-knowledge/ (registry.ts,
 * index.ts, selector.ts, resolver.ts) — a retrieval pipeline over the 8 authored
 * skill files, replacing the old head-excerpt approach (G3). This constant is
 * kept here because several unrelated modules import it from this path.
 */
export const ALL_VULN_CLASSES: VulnClass[] = [
  "injection",
  "authn-authz",
  "secret-handling",
  "input-validation",
  "path-traversal",
  "privilege-escalation",
  "race-condition",
  "money-integrity",
  "ssrf",
  "xss",
  "insecure-randomness",
  "crypto-weakness",
  "deserialization",
  "supply-chain",
  "idor-bola",
  "denial-of-service",
  "audit-logging",
];
