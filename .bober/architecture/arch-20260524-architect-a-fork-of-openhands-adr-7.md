# ADR-7: ID validation and path containment as defence-in-depth for filesystem reads

**Decision:** Every URL-param identifier (`conversationId`, `specId`, `sprintId`) is validated against regex `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$` at the FastAPI dependency layer AND every constructed `.bober/` path is realpath-checked via `Path.resolve().relative_to(bober_root)` before any IO. Both layers must pass.

**Context:** Three endpoints + the WebSocket accept identifiers flowing into filesystem path construction. A single-layer check is one bug from a full filesystem read primitive. Cost of a second layer is one stat call.

**Options Considered:**

| Option | Pros | Cons |
|---|---|---|
| Regex only at routing | Single point to audit; cheap | One missed endpoint = vuln; URL-encoding bypasses easy to regress |
| Realpath only | Catches every escape regardless of source | Extra syscall; relies on every codepath calling helper |
| Both layers (chosen) | One bug in either layer is not exploitable; fail-closed | Tiny perf cost; two places to maintain |

**Rationale:** Sidecar plane means future contributors add endpoints without remembering invariants. Defence-in-depth turns "forgot to validate" into "harmless 400". Risk #9 is critical; cheap mitigation mandatory.

**Consequences:** Shared FastAPI dep `validated_id` imported by every endpoint. ArtifactReader's `_resolve(rel)` always realpath-contains and raises `PathEscapeError` → 400. Direct `open()` of constructed paths forbidden by lint.

**Risk:** Realpath requires file to exist for `strict=True`; for not-yet-existent paths use `strict=False` and verify parent dir realpath instead. Mistakes here mean spurious 400s rather than security holes.
