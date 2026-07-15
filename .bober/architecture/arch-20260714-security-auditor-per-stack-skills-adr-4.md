# ADR-4: Supply-Chain Coverage as Scanner-Kinds + an Offline Diff Inspector, Not a Second LLM Auditor

**Decision:** Add supply-chain coverage via two deterministic paths — new `ScannerKind`s (`npm-audit`, `osv-scanner`, `gitleaks`) with pure parsers plus a per-kind `scannerExitPolicy`, and an always-available offline `SupplyChainDiffInspector` (lifecycle-script / lockfile-host / `.npmrc` / CI-workflow checks) — never a dedicated supply-chain LLM auditor role.

**Context:** The auditor has zero supply-chain/secret coverage, and the existing scanner runner treats every nonzero exit as "no findings" (security-scanners.ts:355) — gap G9 — so tools whose convention is "nonzero means findings present" are silently dropped. The whole audit runs inside the gate's single `Promise.race` time-box (schema.ts:214).

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A. Dedicated supply-chain LLM sub-auditor | Flexible reasoning over manifests | A third LLM stage contends for the shared time-box + budget; nondeterministic on deterministic facts |
| B. Blanket "nonzero exit = findings" flip | One-line change | Over-reports on unrelated tool crashes; loses per-tool semantics |
| **C. Scanner-kinds + per-kind exit policy + offline inspector (chosen)** | Deterministic, total parsers; per-kind exit semantics fix G9; offline path needs zero network | Requires modelling exit conventions per tool |

**Rationale:** The time-box × budget constraint (finder + verifier already share one 300s box, schema.ts:214) eliminates A's third LLM contender. G9's requirement — nonzero-exit scanners must report findings — is met precisely by a per-kind `scannerExitPolicy` (`zero-clean` vs `nonzero-means-findings`) driving the branch at security-scanners.ts:355, not by option B's blanket flip which over-reports.

**Consequences:** `SupplyChainScanners` extends security-scanners.ts with three parsers and the exit policy; network scanners run only when `egress.onlineResearch` is set; the offline `SupplyChainDiffInspector` always contributes `vulnClass: supply-chain` findings into the finder's priors.

**Risk:** A scanner crash (ENOENT/nonzero-on-error) is misread as findings or as clean. Mitigation: ENOENT/throw/abort always yield `[]` for that scanner, exit policy is applied per-kind, and the offline inspector still contributes so supply-chain coverage never fully disappears.
