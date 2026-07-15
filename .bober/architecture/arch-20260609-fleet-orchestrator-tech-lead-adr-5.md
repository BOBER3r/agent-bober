# ADR-5: Enforce a Default Per-Child Timeout via execa, Manifest-Overridable

**Decision:** `ChildRunner` applies a default per-child timeout (~10 minutes) through execa's `timeout` option, overridable per manifest, so a hung child cannot hold a semaphore slot indefinitely.

**Context:** Fan-out is bounded by a single shared `Semaphore` (scheduler.ts:54-85) inside `mapBounded`; each in-flight child occupies one of the `cap` slots. A child that hangs (network stall, runaway pipeline) never releases its slot, starving the rest of the batch.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: Default execa timeout, manifest-overridable | Preserves liveness; a hang releases its slot; tunable per portfolio | A slow-but-valid child may be killed if the default is too tight |
| B: No timeout (wait indefinitely) | Never kills a slow-but-valid child | One hang wedges a semaphore slot forever, throttling throughput below the cap |

**Rationale:** The CP1 HARD throughput constraint (peak in-flight === cap via the shared `Semaphore`) is violated by B, because a wedged slot permanently reduces effective concurrency below the configured cap; a default timeout with a manifest override preserves liveness while remaining tunable.

**Consequences:** Children carry a default ~10-minute execa timeout; `ChildSpawnResult` records `timedOut`; the manifest can raise the timeout for known-slow portfolios; throughput stays at the configured cap.

**Risk:** If the default is too aggressive, a legitimately slow child is killed and reported `failed`; mitigated by the manifest-level override and recording `timedOut` so the cause is visible in the report.
