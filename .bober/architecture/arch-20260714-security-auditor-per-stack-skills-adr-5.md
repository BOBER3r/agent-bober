# ADR-5: The Diff Provider Is Owned by the Orchestrator, Not Given to the Auditor as a Git/Bash Tool

**Decision:** Compute the audit diff once in orchestrator Node code (`SecurityDiffProvider.compute` — git plus optional tokensave `GraphClient` neighborhood expansion) and pass the resulting `AuditDiff` read-only into the selector, inspector, finder, and verifier — never granting the auditor agent a git or Bash tool.

**Context:** The auditor's context degrades on whole-repo input and misses cross-file sinks on diff-only, so context-scoping is a correctness constraint. Today the auditor gets no real diff (gap G4) and estimates changed files. The read-only-by-construction invariant forbids the auditor any execution tool (security-auditor-agent.ts:62-68).

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A. Give the auditor a git/Bash tool to self-diff | Agent controls its own scoping | Breaks read-only-curator invariant (security-auditor-agent.ts:62-68); introduces shell into a security-critical read-only role |
| B. Keep estimated-files only (status quo) | No new code | Misses cross-file sinks; G4 unfixed; no real hunks for the finder |
| **C. Orchestrator-owned diff provider (chosen)** | Real git + optional graph neighborhood; auditor stays tool-read-only; computed once, shared | New Node component; must never throw into the gate |

**Rationale:** The read-only-curator invariant (security-auditor-agent.ts:62-68) — auditor gets no Bash/Write/Edit — eliminates A outright. The context-scoping correctness constraint (whole-repo degrades, diff-only misses cross-file sinks) eliminates B's estimate-only path. Computing the diff once in the orchestrator and sharing it read-only satisfies both: real hunks + graph neighborhood without any auditor execution tool (fixes G4).

**Consequences:** `SecurityDiffProvider.compute` runs git and, when `diff.expandWithGraph` and the graph engine is `ready`, tokensave neighborhood expansion; one `AuditDiff` is shared by all downstream stages, guaranteeing zero diff drift between selector/inspector/finder/verifier.

**Risk:** git or the graph engine is unavailable and the finder loses its scoping. Mitigation: the provider never throws — git failure/nonzero/abort yields an empty diff and the finder degrades to the existing `estimated-files` mode (the fail-safe default `diff.mode`), and a `GraphResult ok:false` simply skips neighborhood expansion.
