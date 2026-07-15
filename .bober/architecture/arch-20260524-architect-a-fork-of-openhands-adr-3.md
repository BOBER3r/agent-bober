# ADR-3: Pydantic mirrors of the frozen Zod contract schemas

**Decision:** Define Pydantic models inside `openhands_bober/artifacts/models.py` that field-for-field mirror the Zod schemas at `/Users/bober4ik/agent-bober/src/contracts/index.ts:1-47`, and validate every `.bober/` file read through them.

**Context:** The Zod schemas are locked. The Python sidecar must read `PlanSpec`, `SprintContract`, `EvalResult` JSON, expose them through FastAPI as typed responses, and surface validation errors when CLI output drifts or files are partially written.

**Options Considered:**

| Option | Pros | Cons |
|---|---|---|
| Pydantic mirrors | Typed FastAPI + OpenAPI codegen free; catches drift at boundary; documents cross-language contract | Two schema definitions to keep in sync |
| Untyped dict passthrough | Zero duplication; resilient to additive changes | No validation — corrupt JSON reaches frontend; OpenAPI loses field info |
| Generate Pydantic from Zod at build | No hand duplication | Toolchain addition; non-trivial fidelity gaps; build-time coupling between repos |

**Rationale:** Schemas are frozen and small (~10 types) so duplication cost is bounded; validation-at-boundary serves the locked success criterion that the UI must never present malformed artifacts. Codegen is overkill given schema stability.

**Consequences:** CI drift-check parses `src/contracts/*.ts` field names against Pydantic class fields; mismatch fails build. ArtifactReader raises `ArtifactValidationError` mapped to 502 (surfacing version skew explicitly).

**Risk:** Schema change in agent-bober adding required field without Pydantic update breaks UI until mirror is updated. Mitigation: drift-check catches additions; semantic changes (e.g. enum rename) require manual review.
