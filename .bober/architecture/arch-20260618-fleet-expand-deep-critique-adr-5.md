# ADR-5: Critic call placed after validateManifest, before atomic write

**Decision:** The fresh-critic semantic gate runs strictly AFTER the structural validateManifest (decomposer-deep.ts:303, inside runExpandStage) and strictly BEFORE the atomic write (`rename(tmp,outPath)`, index.ts:349), inside decomposeGoalDeep whose return reaches index.ts:325 ahead of the Step-4 write.

**Context:** A shape-valid-but-degenerate manifest passes validateManifest and is written, with human write-and-stop the only defense. The critique gate must catch degeneracy the structural gate cannot, never write an un-reviewed manifest, and never run before structure is confirmed.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: critic AFTER validateManifest, BEFORE write | Structural precedes semantic; no un-reviewed manifest on disk; reuses already-validated manifest | Gate sits in decomposeGoalDeep, must stay above the write on any refactor |
| B: critic AFTER the atomic write | Result visible immediately | Violates never-write-unreviewed; needs a 2nd write + partial-state window |
| C: critic BEFORE validateManifest | One fewer shape assumption | Critic must re-implement JSON parsing; can approve structurally-invalid output; inverts gate order |

**Rationale:** Constraint 6 (validateManifest unchanged, structural floor) eliminates C; the add-only-a-gate constraint (never relax write-and-stop) eliminates B; A places the semantic gate exactly between the structural gate and the durable write.

**Consequences:** runCritiqueLoop always receives a validateManifest-passing FleetManifest (never raw text), so callCritic needs no JSON-shape defense of its input; the write is reached only with a critic-reviewed (approved or accept-best) manifest; CLI steps 4,5,6 are untouched.

**Risk:** If a future change moves the loop out of decomposeGoalDeep into runFleetExpandDeep, ordering holds only if it stays before index.ts:348; placing it after the write silently reintroduces the un-reviewed-manifest window — asserted by a test that fails if a write occurs before a critic call on the `--critique` path.
