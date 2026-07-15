# ADR-4: Default Output Path for `fleet expand-deep` — shared `fleet-expand.json`

**Decision:** `fleet expand-deep` defaults its written manifest to the SAME path as `fleet expand` — `<root>/.bober/fleet-expand.json` — rather than a distinct `fleet-expand-deep.json`, relying on atomic write + overwrite notice + `--out`.

**Context:** Both `expand` and `expand-deep` produce a children-only `FleetManifestSchema`-valid manifest consumed identically by `runFleet`. We must choose whether the deep flavor writes to the shared default path (last-write-wins) or its own filename.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| Shared default `fleet-expand.json` (chosen) | one hand-off contract; `runFleet` + "Review then run" hint identical for both flavors; byte-reuses the write block (`index.ts:207,216-219`); matches the single-shot path | `expand` then `expand-deep` on defaults silently overwrites (last-write-wins); side-by-side needs `--out` |
| Distinct default `fleet-expand-deep.json` | no accidental cross-flavor overwrite; both visible at once | splits one interchangeable hand-off into two for no format difference; diverges from the byte-reused write block; two hints/run paths to document; adds a path constant with no semantic justification |

**Rationale:** CP1 locks "interim plan stays in-memory; the written file stays a `FleetManifestSchema`-valid children-only manifest" AND "additive" with the single-shot write block reused byte-for-byte. Because the two flavors' outputs are format-identical and interchangeable for `runFleet`, a distinct filename would fork a single hand-off contract for zero semantic gain and force the deep path to diverge from the reused atomic-write block — that divergence violates the additive/reuse constraint, so the distinct-filename option is eliminated. The collision is bounded to last-write-wins, made safe by the atomic write, surfaced by the overwrite notice, and escapable via `--out`.

**Consequences:** `runFleetExpandDeep` reuses the exact `outPath` default and atomic write of `runFleetExpand`; documentation states both flavors target `fleet-expand.json` by default and running both requires `--out`. The overwrite notice already present (`index.ts:221-223`) covers the cross-flavor case with no new code.

**Risk:** If an operator runs `expand` then `expand-deep` on defaults expecting both to persist, the first is silently overwritten (notice prints but is easy to miss). Mitigation — document `--out` prominently; a future change could add a distinct default only if a real coexistence need emerges.
