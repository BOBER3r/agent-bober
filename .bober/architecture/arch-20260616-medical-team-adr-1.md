# ADR-1: Medical Team as New `medical-sop` pipelineShape with Code-Enforced Guardrails and an In-Process Numerics Layer

**Decision:** Build the medical team as a new `"medical-sop"` `PipelineEngineName` with a dedicated engine, a concrete `GuardrailSet` type filling the `Team.guardrails` slot, a JS/TS-native deterministic numerics/query layer (not a Python sandbox), and an opt-in egress axis for literature retrieval — all composed through the existing `Team`/`loadTeam` contract.

**Context:** agent-bober has no health domain team and its `Team` abstraction (`src/teams/types.ts:21`) is unvalidated on a second high-stakes domain. The medical SOP (intake→red-flag-gate→retrieve→reason-in-sandbox→answer-with-abstention) needs a pre-LLM refusal path, in-code regulatory guardrails, and code-only numerics that none of the existing `ts|skill|workflow` engines provide.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: Pure-config team on existing engines | Zero new machinery; fastest; byte-zero impact on programming team | Refusals prompt-only (not enforceable); no sandbox step; emergency path routes through an LLM |
| B: New `medical-sop` shape + code-enforced guardrail/numerics/retrieval components (selected) | Pre-LLM red-flag gate + code-enforced refusals; in-process numerics keep arithmetic out of the LLM with zero added egress; additive enum/switch extension leaves existing teams byte-identical | Largest new component surface; JS/TS numerics less expressive than Pandas; needs `team-abstraction` merged first |
| C: Standalone medical subsystem with Python+`execa` sandbox | Maximum freedom; full Pandas expressiveness | Never validates the `Team` abstraction; Python sandbox is the unsolved-security open question and a large egress/RCE surface; duplicates provider/memory/FactStore wiring |

**Rationale:** The 0-LLM-round-trip emergency short-circuit and the FFDCA §201(h) code-enforced-refusal HARD constraints eliminate Approach A (prompt refusals an LLM can be jailbroken past are not an enforcement boundary, and the `workflow` engine `selector.ts:103-118` has no pre-LLM gate). The success criterion that medical add NO change to `Team`/`loadTeam`, plus the zero-egress/privacy HARD constraints against the unsolved Python-sandbox security question, eliminate Approach C.

**Consequences:** `PipelineEngineName` (`engine.ts:7`), the `pipelineShape` Zod enum (`schema.ts:366`), and the `selectPipelineEngineForTeam` switch (`selector.ts:103-118`) each gain one additive `medical-sop` branch; the `guardrails` slot gains a concrete `GuardrailSet` type; a new egress opt-in axis is introduced distinct from the cloud-inference opt-in. Existing `ts|skill|workflow` branches and the programming team remain byte-identical.

**Risk:** If the JS/TS-native numerics layer cannot express a needed statistical operation on Apple Health time-series, that operation must be added as a new in-process primitive rather than via arbitrary user code; if `bober/team-abstraction` is not merged first, the new shape cannot land.
