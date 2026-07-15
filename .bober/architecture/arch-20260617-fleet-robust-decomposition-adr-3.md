# ADR-3: `Outline` kept in-memory-only vs persisted as an intermediate artifact

**Decision:** The PLAN-stage `Outline` is a transient in-memory value passed directly from PlanStage to ExpandStage within one `decomposeGoalDeep` call; it is never written to disk, and the ONLY file produced is the existing `FleetManifestSchema`-valid children-only manifest.

**Context:** A two-call engine produces an intermediate planning artifact (the outline). We must decide whether that artifact becomes an on-disk entity or stays a function-local value.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| In-memory only | no new on-disk entity; written file stays a valid children-only manifest; nothing for `fleet <manifest>`/`load` to misread | outline not inspectable after the run |
| Persist outline (e.g. `.bober/fleet-outline.json`) | debuggable intermediate; resumable | introduces a new on-disk entity; a non-`FleetManifestSchema` file could be fed to `fleet <manifest>` and fail `load` (`manifest.ts:22-43`) |

**Rationale:** The CP1 constraint "interim plan stays in-memory (no new on-disk entity, written file stays a `FleetManifestSchema`-valid children-only manifest)" explicitly eliminates the persist option — persisting both creates a new on-disk entity and risks a non-manifest file reaching the locked `load`/`fleet <manifest>` path.

**Consequences:** `Outline` is a module-local type with no loader, no schema file, and no CLI surface. `runFleetExpandDeep` reuses the identical atomic-write block (`index.ts:216-219`) to emit only the children-only manifest. Determinism preserved: the injected `ScriptedClient` scripts both PLAN and EXPAND responses in order, fully unit-testable without disk.

**Risk:** If a future feature needs outline inspection, it has no persisted record; mitigation — surface via a debug log line or an in-memory return without violating the on-disk constraint.
