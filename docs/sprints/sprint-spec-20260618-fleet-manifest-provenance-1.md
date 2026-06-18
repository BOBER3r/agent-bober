# Provenance sidecar + recoverable, informative overwrite

**Contract:** sprint-spec-20260618-fleet-manifest-provenance-1  ·  **Spec:** spec-20260618-fleet-manifest-provenance  ·  **Completed:** 2026-06-18

## What this sprint added

An **ADR-4-preserving mitigation** of the shared-default-path clobber risk that the
`research-20260618-fleet-branch-merge-readiness` study surfaced for `fleet expand` and
`fleet expand-deep`: both subcommands write the same default manifest path
(`<root>/.bober/fleet-expand.json`), so a second decompose silently overwrote the first.
This sprint makes that overwrite **recoverable and self-documenting** without changing the
path. A new shared helper `writeManifestWithProvenance` (`src/fleet/manifest-write.ts`)
routes both subcommands' Step-4 writes through one code path that (a) emits a provenance
sidecar `<outPath>.meta.json`, (b) on overwrite **moves the prior manifest to
`<outPath>.bak` before** writing the new one, and (c) prints an **informative,
non-blocking** notice. The on-disk manifest (`FleetManifestSchema`, children-only) is
**unchanged** — provenance lives only in the sidecar — and the shared default path is
**deliberately unchanged** (this is a recoverability mitigation, not a path change). This is
a single-sprint spec, now complete (1 of 1).

## Public surface

The change is contained to one new helper module plus two call-site rewrites; no public CLI
surface, flags, or schema changed.

- `writeManifestWithProvenance(args: WriteManifestArgs): Promise<void>` (`src/fleet/manifest-write.ts:68`) —
  shared Step-4 writer. Steps: `ensureDir(dirname(outPath))` → check existence → if it
  exists, tolerantly read+parse the prior `<outPath>.meta.json` (missing/corrupt → `null`,
  **never throws**), `rename` the existing manifest to `<outPath>.bak`, and log the notice →
  atomically write the new manifest (`randomBytes` tmp + `rename`) → write the new
  `<outPath>.meta.json`. `sidecarPath` and `bakPath` are **derived from `outPath`** (`${outPath}.meta.json`
  / `${outPath}.bak`), never from the default constant.
- `WriteManifestArgs` interface (`src/fleet/manifest-write.ts:24`) — `{ outPath, manifest,
  provenance: Omit<ManifestProvenance, "timestamp">, log?, now? }`. `log` defaults to
  `console.log`; `now` defaults to `Date.now` (injectable clock for deterministic timestamps
  and relative-age strings).
- `ManifestProvenance` interface (`src/fleet/manifest-write.ts:16`) — the sidecar shape:
  `{ command, goal, critique, childCount, timestamp }`. `timestamp` is `new Date(now()).toISOString()`.
- `formatRelativeAge(deltaMs)` (`src/fleet/manifest-write.ts:36`, module-private) — buckets
  the age of the prior manifest into `"just now"` / `"Nm ago"` / `"Nh ago"` / `"Nd ago"` for
  the overwrite notice.

Both Step-4 write blocks in `src/fleet/index.ts` (previously near-identical inline
`access`/`randomBytes`/`writeFile`/`rename` + `console.log("Overwritten existing manifest…")`)
were replaced by a single `writeManifestWithProvenance` call each:

- `runFleetExpand` — provenance `{ command: "fleet expand", goal, critique: false, childCount: manifest.children.length }`.
- `runFleetExpandDeep` — provenance `{ command: "fleet expand-deep", goal, critique: opts.critique === true, childCount: manifest.children.length }`.

Both pass the **raw `goal`** param (not the count-hinted `goalWithHint`). The default
`outPath = opts.out ?? join(root, ".bober", "fleet-expand.json")`, Step 5 (print manifest +
review hint), and the `--yes` spawn gate are untouched.

## How to use / how it fits

No new commands or flags. The behavior is now part of `fleet expand` and `fleet expand-deep`:

```text
# First decompose into the default path — writes manifest + sidecar, no .bak, no notice:
agent-bober fleet expand "Build a todo app …"
#   → .bober/fleet-expand.json
#   → .bober/fleet-expand.json.meta.json   { command, goal, critique, childCount, timestamp }

# Second decompose into the SAME default path — prior manifest is preserved as .bak,
# and an informative notice is printed (non-blocking; the write still proceeds):
agent-bober fleet expand-deep "Build a SaaS platform …"
#   [fleet expand-deep] Replacing manifest from `fleet expand` for goal "Build a todo app …"
#     (4 children, 12m ago) → kept as fleet-expand.json.bak
#   → .bober/fleet-expand.json       (the new manifest)
#   → .bober/fleet-expand.json.bak   (the previous manifest, recoverable)
#   → .bober/fleet-expand.json.meta.json  (updated sidecar)
```

If the prior sidecar is missing or corrupt, the helper still backs up the old manifest and
prints a generic notice (`[<command>] Overwriting existing manifest at <outPath> → kept as
<basename>.bak`) — it never throws. With `--out <custom>`, the sidecar and `.bak` derive
from the custom path (`<custom>.meta.json` / `<custom>.bak`) and the default
`.bober/fleet-expand.json` paths are not touched. User-facing notes are in
[`COMMANDS.md`](../../COMMANDS.md) under **Fleet Commands**.

## Notes for maintainers

- **The default path is unchanged by design (ADR-4 preserved).** The research's clobber risk
  was mitigated by *recoverability + provenance*, not by giving each command a distinct
  default path. `fleet expand` and `fleet expand-deep` still share
  `<root>/.bober/fleet-expand.json`; use `--out` to keep both distinct manifests. Do not
  "fix" the shared path here — that would re-open the ADR-4 decision.
- **Provenance is sidecar-only — never put it in the manifest object.** A test parses the
  written manifest and asserts it still passes `FleetManifestSchema.safeParse` with **no**
  provenance keys. The provenance struct goes only into `<outPath>.meta.json`.
- **`.bak` holds the *prior* bytes — the `rename` happens before the new atomic write.**
  A write-A-then-write-B test asserts `<outPath>.bak === A bytes` and `<outPath> === B`. Keep
  that ordering (back up → atomic tmp+rename → write sidecar) intact for recoverability.
- **The clock is injectable for determinism, but the tmp filename uses the real `Date.now`.**
  `now()` governs the sidecar `timestamp` and the relative-age string (so tests assert exact
  age strings with a fixed clock); the temp filename uses `process.pid` + real `Date.now` +
  `randomBytes` to stay collision-free across concurrent writes regardless of the injected
  clock.
- **Tolerant prior-sidecar read is load-bearing for safety.** A missing/corrupt
  `<outPath>.meta.json` must degrade to the generic notice, never abort the write — that is
  why the read is wrapped in a `try/catch → null`.
- **Scope.** This sprint touched only `src/fleet/manifest-write.ts` (new) and the two Step-4
  blocks in `src/fleet/index.ts`, plus tests (15 new helper tests; the overwrite-notice
  assertions in `expand.test.ts:376` and `expand-deep.test.ts:424` were relaxed to match the
  new message). `manifest.ts` (`FleetManifestSchema`), `decomposer*.ts`, `critic-deep.ts`, and
  `runFleet` are byte-unchanged. Full suite: 2354 passed; the 6 pre-existing cockpit E2E MCP
  failures are unrelated.
</content>
</invoke>
