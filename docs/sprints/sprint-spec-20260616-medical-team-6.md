# EgressGuard + medications-in-FactStore + full SOP wiring (zero-egress end-to-end)

**Contract:** sprint-spec-20260616-medical-team-6  ·  **Spec:** spec-20260616-medical-team  ·  **Completed:** 2026-06-16

## What this sprint added

The medical team's **integration linchpin**: the full Standard-Operating-Procedure
(SOP) is now wired end-to-end inside `MedicalSopEngine.run` under a **code-enforced
zero-egress default**. A new `EgressGuard` exposes **two independently opt-in axes**
(`cloud-inference`, `literature-retrieval`), both defaulting **false**, so with a
fresh config a medical turn produces **zero outbound bytes**: a numeric question is
answered purely from deterministic local compute, and a literature question
**abstains** without any network module being reached. A scoped
`no-restricted-imports` ESLint boundary over `src/medical/**/*.ts` makes that
zero-egress posture enforceable at lint time — network imports and the `fetch`
global are forbidden everywhere in the medical tree **except** the one designated
retrieval file reserved for Sprint 7's live MedlinePlus call. Medications are read
from `FactStore` (the value-of-record, ADR-7), never `HealthDataStore`. This is
Sprint 6 of 7; only the real MedlinePlus networking + cited synthesis (S7) remains.

## Public surface

### `src/config/schema.ts` (additive)

- `MedicalSectionSchema` (`schema.ts:376`) — Zod schema for the new optional
  top-level `medical` config section. Its `egress` object carries two booleans,
  **both `.default(false)`**:
  - `medical.egress.cloudInference` — when true, cloud inference synthesis is
    permitted. Default **false**.
  - `medical.egress.literatureRetrieval` — when true, literature retrieval
    (MedlinePlus) is permitted. Default **false**.
- `MedicalSection` type + `medical: MedicalSectionSchema.optional()` added to
  `BoberConfigSchema` (`schema.ts:419`). Absent section ⇒ both axes off.

### `src/medical/egress.ts`

- `type EgressAxis` (`egress.ts:5`) — `"cloud-inference" | "literature-retrieval"`,
  the two independent axes.
- `class EgressGuard` (`egress.ts:17`) — the egress decision object. Holds the two
  axis booleans; **no network import** (it is itself subject to the medical lint
  boundary).
  - `EgressGuard.fromConfig(config)` (`egress.ts:24`) — builds from
    `config.medical.egress`; each axis falls back to **false** when the section or
    field is absent (`?? false`).
  - `isAllowed(axis)` (`egress.ts:33`) — returns `true` **only** when that axis was
    explicitly opted in. The two axes are read independently — enabling one does not
    enable the other.
  - `assertAllowed(axis)` (`egress.ts:41`) — **throws** `Error("Egress axis '<axis>'
    not enabled")` when the axis is off; returns `void` when allowed. The hard
    code-enforced barrier (Sprint 7's network call will sit behind this).

### `src/medical/retrieval/literature.ts`

- `class LiteratureRetriever` (`literature.ts:13`) — orchestrates retrieval behind
  the `literature-retrieval` gate.
  - `retrieve(query)` (`literature.ts:28`) — **checks `egress.isAllowed(...)`
    BEFORE touching the source.** When the axis is **off** it returns
    `{ kind: "disabled" }` **synchronously** — no `MedlineSource` method is called,
    no network attempt is made (this is the zero-egress proof). When the axis is
    **on** it delegates to `MedlineSource.fetchPassages` (a stub this sprint).

### `src/medical/retrieval/medline-source.ts`

- `type RetrievalOutcome` (`medline-source.ts:10`) — discriminated union:
  `{ kind: "disabled" }` (axis off, no attempt) | `{ kind: "abstain"; reason }`
  (axis on, no passages) | `{ kind: "grounded"; passages }` (**S7 only**).
- `class MedlineSource` (`medline-source.ts:26`) — `fetchPassages(query)` is a
  **stub** returning `{ kind: "abstain", reason: "literature source not implemented
  (Sprint 7)" }`. **No network import yet.** This is the single file the ESLint
  exception sanctions for the live MedlinePlus call in S7.

### `src/medical/engine.ts` (the full SOP)

- `MedicalSopDeps` (`engine.ts:46`) gained `egress?`, `literature?`, `facts?`,
  and `healthStore?` injection slots (tests pass these; production constructs real
  instances). The zero-arg constructor is preserved (`selector.ts` is untouched).
- `MedicalSopEngine.run` now consumes its `config` argument (was `_config`) and runs
  the **full ordered SOP** (see below).

## How to use / how it fits

```jsonc
// bober.config.json — both axes default off; you opt in explicitly per axis.
{
  "medical": {
    "egress": {
      "cloudInference": false,        // default — no cloud synthesis
      "literatureRetrieval": false    // default — no MedlinePlus retrieval
    }
  }
}
```

With the `medical` section omitted entirely, both axes are off and a medical turn
makes **zero outbound calls**. The medical team (`loadTeam(config, "medical")`,
`pipelineShape "medical-sop"`) builds its `EgressGuard` via
`EgressGuard.fromConfig(config)` inside `MedicalSopEngine.run`.

### The full ordered SOP (the safety guarantee)

`MedicalSopEngine.run` executes the SOP in this **fixed order**, and the ordering
**is** the safety contract — both gates run *before* any numerics, medications,
egress, retrieval, or LLM work, so a refuse/short-circuit reaches **zero**
downstream calls:

1. **Gate 1 — consent (fail-closed, S2).** No valid `ConsentRecord` ⇒ refuse
   `MedicalAnswer` (`shortCircuit: true`) + `refuse` audit entry, returned
   immediately. Nothing below runs.
2. **Gate 2 — red-flag short-circuit (0-LLM, S3).** `guardrails.evaluate(prompt, {})`;
   a `short-circuit` verdict returns the canned 911/988 escalation + a
   `short-circuit` audit entry. Nothing below runs.
3. **Numerics (deterministic compute, NO LLM, S4).** For a numeric question, a
   minimal `MetricWindow` + `NumericPrimitive` are derived locally and
   `NumericsQueryLayer.getMetric` computes the answer. No LLM is ever consulted.
4. **Medications via `FactStore` (ADR-7).** Read with
   `FactStore.getActiveFacts("medical", "patient", "takes-medication")` — the
   bi-temporal value-of-record. **`HealthDataStore` is never used for medications.**
5. **Gate 3 + retrieval — `EgressGuard.isAllowed("literature-retrieval")`.**
   `LiteratureRetriever.retrieve` short-circuits to `{ disabled }` synchronously when
   the axis is off ⇒ the answer **abstains**; with no grounded passages the turn is an
   abstain.
6. **Disclaimer footer (S2).** `DisclaimerComposer.footer()` is attached to every
   answer.
7. **Audit (S2).** A PHI-free `answer` or `abstain` entry is appended.
8. **Return `PipelineResult & { medicalAnswer }`.**

A numeric question with data answers from local compute (an `answer` audit event); a
literature question with the axis off yields `retrieve() === { disabled }` and an
**abstained** answer (an `abstain` audit event). Tested with a spy `LLMClient` and a
network spy that both record **zero** calls on the default path.

## Notes for maintainers

- **Zero-egress is now code-enforced, two ways.** (1) The `EgressGuard` axes default
  false and `assertAllowed` throws when off; (2) a scoped ESLint boundary makes a
  network import in the medical tree a **lint error**. Defence in depth — a future
  contributor cannot accidentally add `fetch`/`undici`/`axios` to `src/medical/`
  without the lint failing.
- **The ESLint boundary + single exception.** `eslint.config.js` gained two flat-config
  blocks (mirroring the existing telemetry block):
  - `files: ["src/medical/**/*.ts"]` — `no-restricted-imports` forbids the packages
    `undici` / `got` / `axios` / `node-fetch` and the patterns
    `http` / `https` / `net` / `tls` / `dgram` (and their `node:` forms), plus
    `no-restricted-globals` forbids the `fetch` global.
  - `files: ["src/medical/retrieval/medline-source.ts"]` — turns both rules **off**.
    This is the **single sanctioned exception** (flat-config last-match-wins) where
    Sprint 7 will add the real MedlinePlus call. `medline-source.ts` currently holds
    **no** network import. A deliberately-added forbidden import in any other medical
    file would fail `npm run lint`.
- **Medications live in `FactStore`, never `HealthDataStore` (ADR-7).** The engine
  reads them via `getActiveFacts("medical", "patient", "takes-medication")`. The
  `HealthDataStore` schema is untouched by this sprint — observations/labs/baselines
  remain its only concern. Writing/superseding medication facts uses the existing
  `FactStore` reconcile/invalidate path (S6 reads; it does not add a write path).
- **`assertAllowed` is unused on the default path — by design.** This sprint exercises
  only `isAllowed` (the synchronous gate). `assertAllowed` is the hard barrier that
  S7's `MedlineSource` network call will sit behind; it exists now so S7 is a pure
  additive change to one excepted file.
- **NL → metric parsing is intentionally minimal.** `isNumericQuestion`,
  `deriveWindow`, and `derivePrimitive` (`engine.ts`) are small deterministic
  keyword matchers — full natural-language query parsing is out of scope (S4 already
  proved the numeric correctness). Production gracefully abstains (no throw) when the
  health DB directory does not yet exist.
- **Both carry-forward test cleanups folded in.** (A) the S2 `sc-2-4` engine test now
  injects real `llmSpy`/`numericsSpy` into the constructor so the never-called
  assertions are genuine; (B) `numerics.test.ts` switched `readFileSync` →
  `await readFile` (`node:fs/promises`), honoring the no-sync-fs principle.
- **Lint exit-code note.** The generator captured `npm run lint` exitCode 1 despite
  0 errors / 2 pre-existing warnings; the evaluator independently confirmed the true
  exit code is **0** (a capture artifact), consistent with prior sprints. No action
  needed.
- **Remaining work (S7).** The real MedlinePlus networking + cited synthesis lands in
  Sprint 7 inside `medline-source.ts`, gated by
  `EgressGuard.assertAllowed("literature-retrieval")`. The `cloud-inference` axis
  exists and defaults off; no cloud synthesis path is exercised yet.
