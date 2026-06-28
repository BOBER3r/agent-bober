# Supplements markdown-frontmatter list -> FactStore + supplements CLI

**Contract:** sprint-spec-20260628-medical-ingest-4  ·  **Spec:** spec-20260628-medical-ingest  ·  **Completed:** 2026-06-28

## What this sprint added

The **supplements leg** of the medical-ingest plan: a deterministic, no-LLM path that
records supplements (a name + optional dose) as **FactStore facts under the `medical`
scope**, plus a markdown-frontmatter supplements list and the two `bober medical
supplements add|list` subcommands. New module `src/medical/supplements.ts` holds a
**hand-rolled markdown-frontmatter list parser** (`parseSupplementsFile`), a `FactInput`
builder (`supplementToFact`), and the testable command cores `runSupplementAdd` /
`runSupplementList`. Each `{ name, dose }` entry flattens into a `FactInput`
(`scope: "medical"`, `subject: <name>`, `predicate: "dose"`, `value: <dose>` or
`"unspecified"`) and is reconciled into `FactStore` via the existing `writeFact` with
**no judge** — a deterministic ADD/UPDATE/NOOP path. Re-adding an identical name+dose is
an **idempotent NOOP** (`reconcileFact` exact-match returns `"noop"`), so the active-fact
count never grows.

## Public surface

- `bober medical supplements add <name> [--dose <d>]` (`src/cli/commands/medical.ts:298`) — reconciles one supplement into FactStore (scope `medical`); creates the fact, updates the dose, or noops on an identical re-add. Nested subcommand under the `medical` command tree, not a top-level command.
- `bober medical supplements list [--file <path>]` (`src/cli/commands/medical.ts:309`) — parses the supplements markdown-frontmatter file and prints each `name: dose` entry. `--file` defaults to `.bober/medical/supplements.md`.
- `runSupplementAdd(projectRoot, name, opts, deps?): Promise<void>` (`src/medical/supplements.ts:145`) — the testable `add` core. `SupplementAddDeps { store?: FactStore; now?: string }` injects an in-memory/temp store and a fixed clock in tests; production callers pass nothing. Never throws — on error it writes stderr and sets `process.exitCode = 1`; closes only the store it owns in `finally`.
- `runSupplementList(projectRoot, opts): Promise<void>` (`src/medical/supplements.ts:199`) — the testable `list` core. Reads the markdown file, prints entries (or `No supplements found.`), never throws.
- `parseSupplementsFile(raw): SupplementEntry[]` (`src/medical/supplements.ts:42`) — PURE markdown-frontmatter list parser; throws on a missing opening/closing `---` fence. Each list item is `Name | dose` (the dose after the `|` is optional).
- `supplementToFact(name, dose, now)` (`src/medical/supplements.ts:106`) — builds the `FactInput` (`scope`/`subject`/`predicate`/`value`/`confidence: 1`/`sourceRunId: null`/`tValid`/`tCreated`). `now` is injected; it never reads the clock.
- `SupplementEntry { name: string; dose: string | undefined }` (`src/medical/supplements.ts:16`) and `DEFAULT_DOSE = "unspecified"` (`src/medical/supplements.ts:22`) — the placeholder dose used when `--dose` is omitted (FactSchema requires `value.min(1)`).

## How to use / how it fits

```bash
# Record a supplement (creates a FactStore fact under scope "medical"):
bober medical supplements add "Vitamin D" --dose "1000 IU"
#   Added supplement: Vitamin D (1000 IU)

# Re-adding the identical name + dose is an idempotent NOOP (active count stays 1):
bober medical supplements add "Vitamin D" --dose "1000 IU"
#   Supplement unchanged: Vitamin D

# Changing the dose updates the existing fact:
bober medical supplements add "Vitamin D" --dose "2000 IU"
#   Updated supplement: Vitamin D -> 2000 IU

# Dose is optional (defaults to the "unspecified" marker):
bober medical supplements add Magnesium
#   Added supplement: Magnesium (unspecified)

# List entries from the markdown-frontmatter file (default .bober/medical/supplements.md):
bober medical supplements list
bober medical supplements list --file ~/health-vault/supplements.md
```

The supplements markdown file is a YAML-frontmatter list, one `Name | dose` item per line:

```
---
supplements:
  - Vitamin D | 1000 IU
  - Magnesium | 200 mg
---
```

`add` stamps the wall-clock `now` **once** at the CLI boundary and runs the pure
`writeFact` reconcile (no `FactJudge`, no LLM, no network). Facts land in the same
`facts.db` that `bober facts` reads (resolved via `factsDbPath(projectRoot, "medical")`,
after `ensureFactsDir`). This is intentionally **not** the lab-ingest path: supplements
are `FactStore` rows under the medical scope, not `HealthDataStore` `lab_results` rows.

## Notes for maintainers

- **Supplements diverge from medications in FactStore shape (ADR-7).** A supplement uses
  `subject: <name>`, `predicate: "dose"`, so each supplement is its **own** subject row.
  Medications use `subject: "patient"`, `predicate: "takes-medication"` (the bi-temporal
  value-of-record read by the SOP via `getActiveFacts("medical","patient","takes-medication")`).
  The two surfaces are deliberately distinct — do not collapse them.
- **NOOP is genuine, not a re-insert.** `writeFact` -> `reconcileFact` exact-match returns
  `"noop"` on a second identical add, so `getActiveFacts("medical")` length stays exactly 1
  (`sc-4-3`). `"delete"` only occurs with a judge, which this path never passes.
- **No judge, no clock, no egress.** `runSupplementAdd` passes no judge to `writeFact`, so
  reconcile is deterministic. `now` is injected at the CLI boundary; the pure reconcile path
  never reads the clock. Guardrail grep confirmed zero `createClient`/`fetch`/`Date.now()`/
  `FactJudge`/`src/vault` imports in executable code.
- **Frontmatter parser is hand-rolled, mirroring `lab-note.ts`.** Like Sprint 2's lab note
  writer, `parseSupplementsFile` does **not** import `src/vault/frontmatter.ts` (keeps the
  build independent of the sibling vault spec's timing) and does **not** reuse `parseLabNote`
  (which returns the lab flat-scalar shape and is list-unaware).
- **`.action()` never throws.** Both cores catch errors, write stderr, and set
  `process.exitCode = 1` — mirroring `runImportLabs`. `runSupplementAdd` closes only the
  store it constructed (injected stores are left open for the caller/test).
- **Scope.** Commit `90842ec`: new `src/medical/supplements.ts` + `src/medical/supplements.test.ts`
  (15 tests) and a +29-line nested `supplements add|list` subtree in
  `src/cli/commands/medical.ts`. No new deps. Full suite **2962** green (+15), all four
  criteria (sc-4-1..sc-4-4) passed iteration 1.
