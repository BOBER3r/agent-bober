# ADR-7: SecurityKnowledgeIndex Is a Per-Process Lazy Memoised Cache with No Runtime Invalidation

**Decision:** `SecurityKnowledgeIndex.load()` parses all skill files once, lazily, and memoises the `SecuritySignature[]` for the lifetime of the process; there is no mtime check, no watcher, and no runtime cache invalidation.

**Context:** An audit runs at most once per sprint, post-evaluation, when `config.security.enabled === true` (pipeline.ts:453), inside a short-lived per-sprint process. The skill files on disk are the canonical source of truth; the index is a derived read model. Re-parsing every skill file per stage inside the time-box wastes the bounded budget.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A. No cache, re-parse per call | Always fresh; trivial | Repeated file I/O inside the time-box; wasted budget every stage |
| B. mtime/hash-based invalidation | Fresh in long-lived processes | Complexity + stat I/O for a benefit the per-sprint process shape never realises |
| **C. Per-process lazy memoisation, no invalidation (chosen)** | One parse per process; fits the short-lived sprint lifecycle; simplest correct model | Stale if the process is long-lived and skill files change mid-life |

**Rationale:** The per-sprint process lifecycle (pipeline.ts:453 — one audit per sprint in a short-lived process) means files cannot change mid-process, so option B's invalidation machinery guards against a case that does not occur, and option A pays repeated I/O inside the bounded time-box for freshness that memoisation already provides. Per-process memoisation is the minimal model that honours the time/budget constraint.

**Consequences:** `SecurityKnowledgeIndex` exposes `load()` (idempotent, cached), `forStack(stackId)`, and `all()`; `skillsRoot` is injectable for tests; a missing skill file yields `[]`, never a throw. Staleness is bounded to at most one run.

**Risk:** A future long-lived daemon (e.g. a persistent audit server) would serve stale signatures after an author edits a skill file. Mitigation: the bounded ≤1-run staleness is acceptable for the per-sprint shape; if a long-lived shape arrives, add an `index.reload()` seam — the memoisation is behind the `load()` method precisely to make that a one-method change.
