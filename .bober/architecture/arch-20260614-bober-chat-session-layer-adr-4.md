# ADR-4: Rotation-Safe History Tail with Cursor-Reset and Dedupe

**Decision:** Tail `.bober/history.jsonl` by byte cursor for `pipeline-complete` lines; detect rotation by comparing file size against the stored cursor, reset the cursor to 0 (or to the rotated file's start) on shrink, and dedupe surfaced completions by runId to avoid double-weaving.

**Context:** `.bober/history.jsonl` rotates via `rotateIfNeeded(...,2000)` on every append (history.ts:99 + history-rotation.ts:89-100). A naive byte cursor becomes invalid when the file shrinks, silently dropping completions that landed in the rotated-away segment.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A. Byte cursor + size-shrink detection + reset + runId dedupe | Catches rotation; no missed completions; idempotent weaving | Re-reads file from start after rotation (cheap — file capped at 2000 lines) |
| B. Naive byte cursor only | Simplest | Drops every completion in a rotated-away segment — fails "worker completion surfaced in a subsequent turn" |
| C. Watch rotated archive files too | No data loss even across many rotations | Multi-file bookkeeping; archive naming coupling; complexity unjustified for single-terminal cadence |

**Rationale:** Checkpoint-1 success criterion "a worker completion surfaced in a subsequent turn" eliminates B (silently drops completions on rotation). Option C's multi-file tracking is unjustified given throughput is "single human, single terminal" and the rotation cap is 2000 lines, so a full re-read on shrink is cheap. RunId dedupe (keyed on the ADR-3 session-generated id) guarantees idempotent weaving across resets.

**Consequences:** `CompletionTailer.poll(cursor)` returns `{events, cursor}`; on `currentSize < cursor` it resets to 0, re-scans, and emits only completions whose runId has not already been surfaced (tracked in a session-local seen-set persisted alongside the cursor).

**Risk:** If a run completes AND its `pipeline-complete` line is rotated away before any poll occurs, that single line is gone; the `.bober/runs/<id>.completed.json` marker (ADR-3) remains as a fallback correlation source. Dedupe set growth is bounded by run count per session — negligible.
