# ADR-3: Config Reaches the Script via a Typed args Payload, Not a Bootstrap Agent

**Decision:** The TS host (`WorkflowEngine`) reads config, principles, spec, and contracts via fs, marshals them into one JSON-serializable `WorkflowArgs`, and passes it as the workflow args; the script receives no other inputs.

**Context:** The Dynamic Workflows script is pure-JS with no fs, shell, `Date.now`, or `Math.random`, so it cannot read `bober.config.json` or principles itself. Some channel must carry curated config into the script deterministically.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| Typed args payload built host-side | Deterministic; no script fs; honors provider-config isolation | `WorkflowArgs` becomes a maintained contract |
| In-script bootstrap agent reading files | No host marshaling | Script cannot do fs; burns an agent vs 1000 cap; non-deterministic |
| Pass full BoberConfig into the script | Simple to assemble | Leaks raw provider config; violates `providers/types.ts` isolation |

**Rationale:** Checkpoint-1 "pure-JS script NO fs/shell/Date.now" forbids the script reading config or principles, eliminating the bootstrap agent (which also burns an agent against the 1000 cap and is non-deterministic). A curated payload also honors "MUST NOT change `providers/types.ts`" by never shipping raw provider config into the script.

**Consequences:** `WorkflowArgs` is a maintained contract. Adding a script-visible knob extends `ArgsPayloadBuilder.build` plus `WorkflowArgs.knobs`. The host owns the only clock and fs for workflow runs.

**Risk:** A knob omitted from `WorkflowArgs.knobs` has no script-side fs fallback and yields a silent wrong default — mitigated by deriving knobs from the same config fields `runPipeline` reads and asserting this in the conformance harness.
