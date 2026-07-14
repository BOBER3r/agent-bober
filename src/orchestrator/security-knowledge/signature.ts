import type { VulnClass, FindingSeverity } from "../security-audit-types.js";

// ── Stack identifiers ──────────────────────────────────────────────

/**
 * The eight security-stack identifiers a signature can belong to
 * (arch-20260712-security-audit-agent-team-architecture.md). "generic" is
 * the shared OWASP/CWE library every other stack skill supplements.
 */
export type SecurityStackId =
  | "solidity"
  | "anchor"
  | "react"
  | "node"
  | "payments"
  | "igaming"
  | "dex-backend"
  | "generic";

// ── Signature shape ────────────────────────────────────────────────

/**
 * One parsed vulnerable/safe signature from a security skill file.
 * Shape is quoted verbatim from the architecture (sc-2-1) — SecuritySignatureParser
 * (./parser.ts) is the only producer of these records.
 */
export interface SecuritySignature {
  /** The security stack this signature was authored for. */
  stackId: SecurityStackId;
  /** Stable id — the "### <signatureId>" heading text in the source skill file. */
  signatureId: string;
  /** Human-readable title. */
  title: string;
  /** CWE identifier, e.g. "CWE-89"; null when the source block omits it. */
  cwe: string | null;
  /** Severity rating for a finding matching this signature. */
  severity: FindingSeverity;
  /** MUST be a member of the widened VulnClass union (stack-knowledge.ts ALL_VULN_CLASSES). */
  vulnClass: VulnClass;
  /** The safety invariant this signature protects (the "why" behind the safe example). */
  invariant: string;
  /** A short vulnerable-code example. */
  unsafeExample: string;
  /** The corresponding fixed/safe-code example. */
  safeExample: string;
  /** Free-text keywords for future retrieval (sprint 5 index/selector). */
  keywords: string[];
  /** The skillRelPath passed to SecuritySignatureParser.parse() — provenance. */
  skillRef: string;
}
