# Phase 2 — ApprovedFinding structural boundary + hub adapter + SeoDraft types — Phase 2 opens

**Contract:** sprint-spec-20260717-seo-improver-builder-11  ·  **Spec:** spec-20260717-seo-improver-builder  ·  **Completed:** 2026-07-17

## What this sprint added

The opening sprint of **Phase 2 (builder)**. It lays the structural safety boundary the
Sprint-12 `SeoBuilder` will sit behind, before any drafting logic exists. Three new
production files (plus one test) introduce `ApprovedFinding` — a branded, nominally-typed
class that can *only* be minted from a human-approved hub Finding — the `readApprovedSeoFindings`
hub adapter that produces them, and the `SeoDraft` artifact types the builder will emit.
Nothing is wired into the analyze path: these are new types + an adapter, and
`src/hub/finding.ts`, `src/seo/runner.ts`, and `src/seo/hub-emitter.ts` are byte-identical
to before. The core guarantee is that a raw, gate-dropped, never-encode-dropped, uncited, or
verifier-downgraded `SeoFinding` **can never become** an `ApprovedFinding` — resurrection is
made structurally impossible at compile time and runtime, so Phase-2 builder code cannot be
tricked into acting on a finding the Phase-1 advisory pipeline already rejected.

## Public surface

- `ApprovedFinding` (class, `src/seo/builder/approved-finding.ts:99`) — a nominally-typed
  wrapper around an approved hub Finding, exposing read-only provenance fields
  (`sourceFindingId`, `title`, `sourceCitationUrl`, `severity`, `playbookRef`, `workflow`).
  Has a **private constructor** and a **private `__brand` field**, so it cannot be `new`'d
  or duck-typed from outside the module.
- `ApprovedFinding.from(finding)` (static, `src/seo/builder/approved-finding.ts:132`) — the
  **only** construction path. Returns `ApprovedFinding | null`; returns `null` (never throws)
  when `finding.status !== "approved"` or the `cite:` evidence entry is missing/malformed.
- `ApprovedHubFindingSchema` / `ApprovedHubFinding` (`src/seo/builder/approved-finding.ts:39`,
  `:43`) — a builder-local `FindingSchema.extend()` that widens the status union to add
  `"approved"` without mutating the canonical hub schema.
- `readApprovedSeoFindings(store)` (`src/seo/builder/hub-approved-source.ts:30`) — the
  hub→`ApprovedFinding` adapter. Reads raw FactStore rows via `getActiveFacts` and
  `safeParse`-skips anything malformed / non-`"seo"`-domain / non-`"approved"` /
  uncited; returns `ApprovedFinding[]`, never throws.
- `SeoDraft` / `SeoDraftKind` (`src/seo/builder/draft-types.ts:27`, `:17`) — pure `type`
  declarations for the artifact the Sprint-12 builder will produce. `kind` is a union of
  `schema-jsonld | internal-link | title-meta | content-refresh`; `humanApprovalRequired`
  is pinned to the **literal `true`** (not `boolean`); `sourceCitationUrl` and
  `sourceFindingId` carry provenance copied from the originating `ApprovedFinding`.

## How it fits

`ApprovedFinding` is the one-way valve between the Phase-1 hub and the Phase-2 builder. A
finding only reaches the hub with `status: "approved"` after a human approves it; a finding
that the Phase-1 pipeline dropped (gate, `NeverEncodeFilter`, uncited) or downgraded never
lands there as an approved action, so no `ApprovedFinding` can be constructed for it. The
Sprint-12 `SeoBuilder.build` will consume `ApprovedFinding` instances (typically via
`readApprovedSeoFindings`) and emit `SeoDraft` proposals whose `sourceCitationUrl` is copied
verbatim from the approved finding — never invented. As of this sprint no caller invokes the
adapter and no CLI or hub emission exists (Sprint 12/13).

Minimal shape:

```ts
import { readApprovedSeoFindings } from "./builder/hub-approved-source.js";
// store: FactStore backing the priority hub
const approved = readApprovedSeoFindings(store); // ApprovedFinding[] — safe, never throws
// Sprint 12: approved.map(a => builder.build(a)) -> SeoDraft[]
```

## Design note — resurrection is structurally impossible

The safety property (sc-11-1 / sc-11-2) is enforced by nominal typing, not by a runtime
convention a caller could bypass:

- The **private `__brand` instance field** makes `ApprovedFinding` nominal: a
  structurally-similar plain object (e.g. a raw `SeoFinding` literal) is never assignable to
  the type, because it cannot satisfy the private member.
- The **private constructor** makes `new ApprovedFinding(...)` unreachable outside the
  module, so `from()` is the sole mint point.
- `from()` is the **single enforcement gate**: both the `status === "approved"` check and the
  well-formed-`cite:` check happen in one place (ADR-4's Risk section: "if the adapter itself
  trusts an un-approved Finding, the guarantee leaks").

Both impossibility claims are backed by genuine `@ts-expect-error` compile-proofs in
`approved-finding.test.ts` (assigning a raw `SeoFinding` to `ApprovedFinding`, and calling
the private constructor externally); the evaluator confirmed both are real TS errors via an
isolated TS2578 experiment, so the proofs would break the build — not silently pass — if the
boundary ever weakened. The `SeoDraft.humanApprovalRequired: true` literal is likewise
compile-proofed against a forged `false`.

## Design note — contract-vs-schema reconciliation

The contract's literal wording (`Finding.status === "approved"` and a top-level
`citationUrl`) does not match the canonical hub schema, and the sprint deliberately did
**not** change the schema to make it fit:

- `FindingSchema.status` (`src/hub/finding.ts:23`) is
  `z.enum(["open","in-progress","snoozed","done","dropped"])` — there is no `"approved"`
  value, so `finding.status === "approved"` against a raw `Finding` is a TS2367 compile
  error. The builder introduces a **port-local widened view**, `ApprovedHubFindingSchema`
  (`FindingSchema.extend`, adds `"approved"`), mirroring the existing
  `src/do-bridge/finding-port.ts` precedent. `src/hub/finding.ts` stays byte-identical.
- `Finding` has no top-level `citationUrl`. The SEO citation round-trips inside `evidence[]`
  as a `cite:<url>` string (encoded by `src/seo/hub-emitter.ts`); `extractCitationUrl`
  decodes exactly that entry (decode precedent: `src/seo/benchmark/harness.ts:112-121`) and
  returns `null` rather than inventing a URL.
- The adapter reads raw rows via `getActiveFacts(HUB_SCOPE, undefined, "finding")` and
  `safeParse` — **not** `readFindings()`, which calls `FindingSchema.parse` and would *throw*
  on an `"approved"` status row. This keeps the adapter's never-throw contract intact while
  reading rows the canonical parser would reject.

## Notes for maintainers

- **`from()` is the only place the guarantee is enforced.** If you add a second construction
  path (a public constructor, a cast helper, a second factory that skips a check), the
  resurrection-impossible property is gone. Keep the constructor and `__brand` private and
  route everything through `from()`.
- **`playbookRef` / `workflow` are enrichment, not gates.** They default to `""` when the
  `playbook:` / `workflow:` tag is absent; only `status === "approved"` + a well-formed
  citation gate construction. Do not tighten `from()` to reject on missing tags without
  revisiting ADR-4.
- **The widened schema must stay a *superset* of the hub schema.** `ApprovedHubFindingSchema`
  only adds `"approved"` to the status union; if the canonical `FindingSchema` gains or
  changes fields, re-derive the widened view via `.extend()` rather than hand-copying, so the
  two never drift.
- **Not wired in yet.** No caller invokes `readApprovedSeoFindings`; no CLI, no hub emission.
  Phase-2 wiring and the `SeoBuilder.build` implementation are Sprint 12; CLI + hub emission
  are Sprint 13. Phase-2 builder docs land in `docs/seo.md` in Sprint 14 — this sprint
  deliberately does not touch `docs/seo.md`.

## Scope

One commit on `bober/medical-team`:

- **`95e02e1`** — `bober(sprint-11): ApprovedFinding structural boundary + hub adapter + SeoDraft types`.
  Four new files (+524): `src/seo/builder/approved-finding.ts` (+154),
  `src/seo/builder/approved-finding.test.ts` (+278),
  `src/seo/builder/draft-types.ts` (+41), `src/seo/builder/hub-approved-source.ts` (+51).
  Passed **iteration 1**; all five criteria (sc-11-1..sc-11-5) verified; build/typecheck
  clean (both `@ts-expect-error` proofs confirmed genuine), lint 0 errors; suite
  **4674 passed | 1 skipped** (builder 20/20); zero regressions. `src/hub/finding.ts`,
  `src/seo/runner.ts`, and `src/seo/hub-emitter.ts` byte-identical — Phase-1 analyze path
  untouched.
