# ADR-6: Workflow Eligibility Probe with Fallback-to-TS Policy

**Decision:** `PipelineEngineSelector.select` probes Workflow eligibility (research-preview enabled, paid account, Claude Code ≥ 2.1.154) and silently downgrades `engine=workflow` to `engine=ts` (the frozen `runPipeline` body) when ineligible, logging the downgrade once.

**Context:** Dynamic Workflows is a research preview limited to paid plans and Claude Code v2.1.154+, so a requested workflow run may be impossible in the current environment. The selector must resolve a runnable engine without aborting.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: Probe + silent downgrade to TS | Run always proceeds; frozen signature intact; auditable via one log line | Chosen engine may differ from requested |
| B: Hard-fail when workflow requested but ineligible | Explicit | Strands consumers when preview unavailable; violates "cannot be sole path" |
| C: Always prefer workflow, no TS fallback | Simplest selection | No fallback at all; impossible under preview limits |

**Rationale:** Checkpoint-1 "Workflows research-preview / v2.1.154+ / paid-only → cannot be sole path (TS `runPipeline` stays fallback)" eliminates B and C; only A satisfies it while keeping the frozen signature intact. The selector mirrors the `registry.ts:24` lookup plus a probe.

**Consequences:** CI pins `engine=ts`. A one-line downgrade notice is logged at run start so the chosen engine is auditable. The selector resolves to a runnable engine in every environment.

**Risk:** A probe false-positive (reports eligible, then `invoke` fails mid-run) aborts the run rather than transparently downgrading — mitigated by `WorkflowEngine.run` catching `WorkflowUnavailableError` on the first invoke and re-dispatching through the TS engine before any sprint is flushed.
