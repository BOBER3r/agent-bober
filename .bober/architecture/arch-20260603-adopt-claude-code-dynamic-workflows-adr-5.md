# ADR-5: Careful-Flow Stage-Splitting at Out-of-Band Gates

**Decision:** When `engine=workflow` in careful mode, split the pipeline into separate `invoke` stages at each checkpoint gate and run the `DiskCheckpointMechanism` approval in the HOST between stages, never inside the pure-JS script.

**Context:** Careful-flow blocks on disk approval markers (`disk.ts:63`) at checkpoints. The Dynamic Workflows script cannot block-poll inline because it has no fs and accepts no mid-run user input, so the gate must move out of the script body.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: Stage-split, host gate between same-session invokes | Approval out-of-band; durable `.bober/approvals/` protocol unchanged; crash-safe per stage | Multiple invokes per careful run |
| B: Poll inside script via synthetic async | Single invoke | Script has no fs; cannot read approval markers; violates no-mid-run-input |
| C: Pre-collect all approvals before run | One invoke | Defeats interactive review; approvals precede the work they gate |

**Rationale:** Checkpoint-1 "no mid-run user input" plus "pure-JS NO fs" plus "resume SAME-SESSION only" eliminate B and C; only A keeps approval out-of-band while preserving the durable `.bober/approvals/` protocol (`disk.ts`) that must not change.

**Consequences:** `WorkflowEngine` emits an `awaiting-gate` status and re-invokes after host approval. `RunResultFlusher.flush` runs at every stage boundary, making each gate a crash-safe commit point.

**Risk:** The session dies during the host gate wait, but the gate precedes the generator so no duplicate work occurs; a stale `.approved.json` could auto-pass on resume — mitigated by stale-marker cleanup (`disk.ts:81`).
