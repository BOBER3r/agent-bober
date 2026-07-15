# ADR-3: In-Process Whitelisted Numeric Primitives, Not Generated/Executed Code

**Decision:** Expose time-series computation through a fixed, closed `NumericPrimitive` whitelist (`mean|min|max|latest|delta|slope|percentile|zscore`) implemented as pure TypeScript, with no `eval`, no code generation, and no Python sandbox.

**Context:** The system must compute over health metrics deterministically while honoring no-LLM-arithmetic AND zero-egress simultaneously. A general code sandbox (Python or generated JS) would satisfy flexibility but reopen both risks.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| Whitelisted in-process primitives | Deterministic; in-process (no egress); auditable; strict-TS typed | Limited to predefined computations |
| LLM-generated code executed in a sandbox | Arbitrary computations | Needs a sandbox runtime; LLM authors arithmetic logic; harder to audit; injection surface |
| External Python sandbox | Rich numeric libs | New process/runtime; egress/IPC surface; breaks in-process + zero-egress |

**Rationale:** CP1 constraints "no-LLM-arithmetic on time-series (PHIA)", "local-first zero-egress DEFAULT enforced in code", and "in-process under strict-TS" jointly eliminate both code-generation and the Python sandbox; only a closed whitelist keeps the LLM out of arithmetic while staying in-process.

**Consequences:** `NumericsQueryLayer` exposes only `getMetric(window, primitive)` and `getLabTrend(biomarker)`; adding a computation requires extending the `NumericPrimitive` union (a code review event), not a model decision; `sampleCount: 0` signals upstream abstention.

**Risk:** A computation the whitelist lacks cannot be answered numerically and must abstain; mitigated by treating whitelist extension as a normal, reviewable code change rather than a runtime path.
