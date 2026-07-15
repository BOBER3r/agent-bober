# ADR-6: Two Distinct Egress Axes Gated By EgressGuard + Scoped ESLint Boundary

**Decision:** `EgressGuard` exposes two independently opt-in boolean axes — `"cloud-inference"` and `"literature-retrieval"` — both defaulting to `false`; ALL network I/O in the medical tree is reachable only after `EgressGuard.assertAllowed(axis)` passes, and a `no-restricted-imports` rule scoped to `src/medical/**/*.ts` forbids network module imports outside the one sanctioned retrieval file.

**Context:** CP1 mandates local-first zero-egress as the code-enforced DEFAULT, with cloud inference and literature retrieval as two SEPARATE explicit opt-ins. The repo already enforces a local-only invariant via `no-restricted-imports` scoped by `files:` glob (`eslint.config.js:42-69`, telemetry module). Prompt-only enforcement is forbidden.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A. Two-axis `EgressGuard` + medical-scoped ESLint glob (mirrors telemetry pattern) | Reuses proven lint pattern; runtime `assertAllowed` throws on un-opted egress; two axes independently auditable | Transitive import of a network module via a non-medical file escapes the glob (mitigated by runtime guard) |
| B. Single `egressEnabled` boolean covering both cloud + literature | Simpler config | Collapses two distinct consent decisions into one — a user wanting local-model + literature would be forced to also enable cloud inference; violates the "two distinct axes" constraint |
| C. Runtime guard only, no ESLint rule | No build-time coupling | A `fetch`/`undici` call added without calling `assertAllowed` ships silently; defeats "code-enforced not prompt-only" |

**Rationale:** CP1 "two distinct explicit opt-in egress axes" eliminates Option B (one boolean cannot represent two independent decisions). CP1 "local-first zero-egress enforced in code (reuse no-restricted-imports)" eliminates Option C (no static boundary). Option A reuses the exact `eslint.config.js:47-62` pattern.

**Consequences:** A new `files: ["src/medical/**/*.ts"]` block is added to `eslint.config.js` forbidding `undici`/`got`/`axios`/`node-fetch`/`node:http(s)`/`node:net`/`node:tls` and the `fetch` global, EXCEPT in `LiteratureRetriever`'s designated network file; `LiteratureRetriever.retrieve` returns `{disabled}` synchronously when the axis is off (no network attempt).

**Risk:** If a contributor places network code in a medical file not covered by the glob, or imports through a shared util outside `src/medical/`, the static guard is bypassed. Mitigated by `EgressGuard.assertAllowed` at every call site (defense in depth) and a CI lint gate; surfaced as Integration Risk row 2.
