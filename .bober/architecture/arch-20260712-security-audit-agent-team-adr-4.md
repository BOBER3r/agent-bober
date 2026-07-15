# ADR-4: Deterministic scanner pre-filter as an opt-in component

**Decision:** `runSecurityAudit` includes a `SecurityScannerPreFilter` that runs configured deterministic scanner commands as an optional pre-filter feeding the LLM auditor, gated by `config.security.scanners` — absent config means the pre-filter is never invoked.

**Context:** Approach B is a single LLM judgment holding veto power; Checkpoint 2 accepted a deterministic scanner pre-filter as the mitigation for single-judgment risk. This decision fixes whether that scanner is excluded, mandatory, or optional.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: Exclude — LLM-only audit | Least code; no external tool dependency | Single-judgment risk unmitigated; no deterministic ground truth on scanner-rich stacks |
| B: Mandatory scanner on every audit | Deterministic floor always present | Forces slither/semgrep install on all users — impossible to stay byte-identical when unconfigured; breaks zero-config runs |
| C: Optional, config-gated pre-filter (selected) | Realizes the CP2 mitigation when configured; reuses the `command` EvalStrategy shape; unconfigured path is byte-identical LLM-only | Two code paths (with/without scanner) to test |

**Rationale:** The hard backward-compat constraint 'byte-identical when unconfigured / opt-in' eliminates Option B. The dominant false-negative-cost constraint plus the CP2-accepted single-judgment mitigation rule out Option A. Reusing the locked `command` field of `EvalStrategy` (`src/config/schema.ts:74-88`) avoids a new config mechanism.

**Consequences:** When `config.security.scanners` is non-empty, `runSecurityAudit` runs the scanner commands inside the same `Promise.race` time-box, parses output into `SecurityFinding` priors, and prepends them to the auditor prompt; when empty, the audit is a pure LLM pass.

**Risk:** A scanner that hangs or emits unbounded output could exhaust the time-box or budget — mitigated by running the pre-filter under the shared audit `AbortSignal`/time-box.
