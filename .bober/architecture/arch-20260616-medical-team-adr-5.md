# ADR-5: Medical SOP Plugs Into ChatSession Via the Existing Detached-Spawn Contract

**Decision:** The `"medical-sop"` pipeline runs inside the detached `agent-bober run` child process selected by `selectPipelineEngineForTeam`, not synchronously inside `ChatSession.handleTurn`; the chat turn returns the same immediate `SpawnAck` ack string as the programming team.

**Context:** A medical question routed by `TurnClassifier` to `action: "spawn"` must execute the red-flag-gate→retrieve→reason→answer SOP. The existing chat spawn path (`chat-session.ts:247-253`) launches a detached child and returns without awaiting (`run-spawner.ts:111` "do NOT await"). Running the SOP inline would change that contract and block the REPL.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A. SOP runs in detached child via `selectPipelineEngineForTeam`; chat returns `SpawnAck` | Zero change to spawn contract; back-compat preserved; consent/red-flag gates run in the child engine where `MedicalSopEngine.run` already lives | Red-flag short-circuit is not surfaced in the same turn; user sees `[run ... finished]` notice on a later poll |
| B. `ChatSession` calls `MedicalSopEngine.run` inline and awaits the answer | Synchronous answer + red-flag short-circuit visible same turn | Breaks the non-blocking `handleTurn` contract; long literature retrieval blocks the REPL; diverges programming vs medical turn behavior |

**Rationale:** CP1 backward-compat constraint — `ChatSession`/`TurnClassifier`/programming-team behavior must NOT break. `run-spawner.ts:111` is explicitly fire-and-forget; Option B would await inside `handleTurn` and block the loop, eliminating it. The emergency red-flag short-circuit's 0-LLM guarantee is enforced inside `MedicalSopEngine.run` regardless of process boundary, so Option A loses nothing on safety.

**Consequences:** `buildMedicalTeam` sets `pipelineShape: "medical-sop"`; the detached child resolves the engine via `selectPipelineEngineForTeam(team, config)`; chat surfaces the answer through the existing `CompletionTailer` poll/notice mechanism (`chat-session.ts:145,282-287`).

**Risk:** If a future maintainer adds a synchronous "answer medical questions in chat" fast-path that calls the LLM before delegating to `MedicalSopEngine.run`, the red-flag and consent gates are bypassed. Mitigated by the guardrail-bypass lint rule (Risk table row 1) and routing ALL medical turns through spawn.
