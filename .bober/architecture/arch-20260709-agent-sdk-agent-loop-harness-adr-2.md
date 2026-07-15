# ADR-2: Declare Tool Read-Only Classification as a ToolDef Schema Annotation

**Decision:** Represent read-only-ness as an optional `readOnly?: boolean` field on each `ToolDef` in `schemas.ts`, consumed by `ReadOnlyToolExecutor`, rather than as a name allow-list hard-coded inside the loop.

**Context:** Parallelizing tool calls requires knowing which calls are side-effect-free. That knowledge can live either with the tool definition or inside the generic orchestration loop, and only one location keeps the loop catalog-agnostic.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| Annotation on ToolDef | Travels with the tool; self-declaring; loop stays catalog-agnostic; absent field → serial, byte-identical | Touches each tool schema; a flag must be threaded from schemas into the executor |
| Hard-coded Set in the loop | Zero schema change | Bakes the concrete tool catalog into a generic loop; future `graph_*` tools silently misclassified; violates single responsibility |

**Rationale:** The provider-agnosticism HARD LAW forbids coupling generic orchestration to a concrete tool catalog, and the additive-only constraint requires unmarked tools to stay serial (byte-identical when absent) — both point to the annotation.

**Consequences:** `read_file`, `glob`, and `grep` are marked `readOnly: true`; `bash`, `write_file`, and `edit_file` stay unmarked; the loop derives a `readOnlyTools` set from the annotations and passes it to `executeToolBatch`; any later tool opts in explicitly.

**Risk:** A mis-annotated mutating tool would allow concurrent interleaved writes; mitigated by annotating only the three genuinely side-effect-free tools and never annotating `bash`.
