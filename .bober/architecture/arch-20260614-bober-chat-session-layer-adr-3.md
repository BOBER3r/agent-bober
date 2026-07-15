# ADR-3: Detached-Child Fire-and-Forget with Session-Generated runId

**Decision:** Spawn workers as a detached, unref'd child process (`agent-bober run <task> --run-id <id>`); the session generates the runId, writes the roster `state.json` itself at spawn, then launches the child. A new additive `--run-id` flag wires the caller-supplied id through to the pipeline.

**Context:** A spawn turn must ack immediately without blocking the REPL, the run must survive REPL exit, and the worker completion must later be correlated back to the run. The `pipeline-complete` history line carries no runId (pipeline.ts:923-932) and the child otherwise self-generates `run-${Date.now()}` (pipeline.ts:583).

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A. Detached child + session-generated runId via additive `--run-id` | Non-blocking ack; survives REPL exit; deterministic correlation key for `.completed.json` | Requires one additive CLI flag |
| B. `await runPipeline(...)` in-process | Direct correlation | Blocks the REPL turn — violates immediate-ack constraint |
| C. Un-awaited in-process promise | Non-blocking | Parks live run state in REPL memory; dies on REPL exit — violates filesystem-state-only |

**Rationale:** Checkpoint-1 "spawn turn must ack immediately (non-blocking)" eliminates B; "filesystem state only (NO in-memory global as source of truth)" eliminates C. The additive `--run-id` flag is additive and does NOT break the run command's public contract (backward-compatibility constraint preserved). Session-owned runId makes the run visible in the roster the same turn and keys `.bober/runs/<id>.completed.json` for correlation.

**Consequences:** Spawn = generate runId → `writeRunState` state.json → `execa(process.execPath,[cliEntry,"run",task,"--run-id",id],{cwd:projectRoot,detached:true,stdio:"ignore"}).unref()`. The run command gains an additive optional flag honoured by the pipeline. Run survives REPL exit.

**Risk:** If the additive flag is not honoured by the pipeline, the child self-generates a different id and correlation breaks (no completion woven). Mitigated by a unit test asserting the child run adopts the supplied `--run-id`.
