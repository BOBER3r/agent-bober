# ADR-1: Adopt Dynamic Workflows as a Config-Selected Interchangeable Engine

**Decision:** Add a third orchestration engine, selected by `pipeline.engine: "workflow"`, that drives the existing `bober-*` subagents via `agentType` behind the unchanged contracts protocol; the TS `runPipeline` (`pipeline.ts:516`) and the skill orchestrator are retained as config-selectable fallbacks.

**Context:** The skill-driven orchestrator makes Claude-in-session the orchestrator, which degrades over long pipelines through context pollution and cannot run in the background or resume. Dynamic Workflows offer a deterministic background surface, but as a research preview it cannot be the sole orchestration path.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: Interchangeable engine (config-selected complement) | Reuses config-driven selection precedent (`registry.ts:60`); TS/skill fallback preserved; contracts untouched | Three engines to keep in conformance |
| B: Replace skill orchestrator with Workflows | One orchestration path; less surface | Strands interactive consumer when Workflows unavailable; violates "cannot be sole path" |
| C: Generate a workflow per PlanSpec | Per-plan tailoring | Emits per-plan scripts that drift from the one frozen contract; still needs TS fallback |

**Rationale:** Checkpoint-1 constraint "workflow surface CANNOT be sole orchestration path; TS engine must remain for CI/headless, MCP, non-Anthropic consumers" eliminates B. Checkpoint-1 "MUST NOT change contracts protocol / no new application artifact per plan" eliminates C. Approach A reuses the config-driven selection precedent at `checkpoints/registry.ts:60`.

**Consequences:** A new `pipeline.engine` field joins `pipeline.mode` and `checkpointMechanism` (`defaults.ts:97`). A thin command bootstraps config plus principles via fs and launches the workflow with a typed args payload. Careful-flow preserves out-of-band gates (`mode=careful` → disk). Fan-out stays sequential under the 16/1000 caps. A conformance suite asserts all three engines satisfy the same contract.

**Risk:** Same-session resume loses the session before a `.bober/` flush, forcing a re-run — mitigated by writing contract status before each spawn. Single-engine contract drift is gated in CI by the conformance suite.
