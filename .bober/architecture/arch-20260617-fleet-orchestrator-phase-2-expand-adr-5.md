# ADR-5: Fleet Expand Spawn Safety Gate — Write-and-Stop Default, `--yes` Escape Hatch

**Decision:** `fleet expand` ALWAYS writes the generated manifest to `<root>/.bober/fleet-expand.json` (overridable via `--out`), prints it, and STOPS by default; only `--yes` chains into the locked `runFleet(outPath)`.

**Context:** CP1 set a HARD safety constraint: no real detached child may spawn on any path where the operator could not first inspect the manifest. `runFleet` (`src/fleet/index.ts:88`) is path-based and locked, so an in-memory manifest must be written to a path before it can be consumed. CP1 flagged a `--yes`/non-interactive escape hatch as a CP4 decision.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| (a) Two-step: write → print → STOP; operator runs `fleet <manifest>` separately | Spawn is structurally separate from generation; reuses locked path entirely; satisfies HARD constraint by construction | Two commands for the common automation case |
| (b) One-step `--yes` chaining only | Single command end-to-end | `--yes` flag becomes the sole guard for the HARD constraint; couples generation to spawn |

**Rationale:** CP1's HARD "no spawn without prior inspectability" constraint makes the write-and-stop default (a) the safe baseline: the manifest is on disk and inspectable before any spawn can occur. (b) is demoted to an explicit opt-in `--yes` escape hatch for CP1's flagged non-interactive automation case; even with `--yes`, the manifest is written to `outPath` FIRST, so inspectability survives.

**Consequences:** Generated manifest path is `<root>/.bober/fleet-expand.json` (or `--out`). Default invocation never spawns. `--yes` runs `runFleet(outPath)` against the same written file. `DEEPSEEK_API_KEY` is checked (via `createClient`→`validateApiKey`) before any disk write.

**Risk:** An operator scripting `--yes` against an unreviewed goal spawns children unreviewed; mitigated because the manifest is always persisted to `outPath` and remains auditable post-hoc, and `--yes` is documented as automation-only.
