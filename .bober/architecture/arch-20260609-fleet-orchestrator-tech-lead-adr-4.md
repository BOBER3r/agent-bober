# ADR-4: Child CLI Entry Resolved to Parent's Own dist/cli/index.js, Not PATH Lookup

**Decision:** `ChildRunner` resolves the child CLI entry to the parent process's own `dist/cli/index.js` via `fileURLToPath(import.meta.url)` and spawns it with `process.execPath`, plus a pre-flight `--version` probe, rather than relying on an `agent-bober` PATH lookup.

**Context:** Each child is a spawned `agent-bober run` process. If the binary is resolved off `PATH` and is missing or stale, every child fails identically and silently, defeating the entire fleet run.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: Resolve own `dist/cli/index.js` + `process.execPath` + `--version` probe | Always runs the same code as the parent; fails fast at setup, not per child | Couples to the dist layout; needs the build present |
| B: PATH lookup of installed `agent-bober` binary | Simple; uses the globally installed binary | Silent fleet-wide failure if binary missing/stale; version skew between parent and children |

**Rationale:** The CP1 critical risk "child binary not found → fleet-wide silent failure" and the constraint that the orchestrator spawns the published `agent-bober` binary are best satisfied by resolving the parent's own entry, so a missing binary surfaces once at setup rather than N times silently; B's PATH lookup is eliminated.

**Consequences:** A single pre-flight `--version` probe gates the batch; children run byte-identical code to the parent; a missing build fails fast before any child spawns.

**Risk:** If the dist layout changes or the build is absent, resolution breaks; mitigated by the pre-flight `--version` probe failing the batch with a clear setup error.
