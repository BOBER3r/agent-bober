# Consent gate, append-only audit log, and disclaimer footer (Gate 1 + audit substrate)

**Contract:** sprint-spec-20260616-medical-team-2  ·  **Spec:** spec-20260616-medical-team  ·  **Completed:** 2026-06-16

## What this sprint added

The first **code-enforced** safety gate and the compliance/audit substrate for the
medical team. Three small modules land in `src/medical/`: `ConsentGate`
(fail-closed first-run consent), `AuditLog` (append-only, IDs/enums-only, mode-0600
JSONL), and `DisclaimerComposer` (versioned wellness footer). `MedicalSopEngine.run`
now enforces consent as **Gate 1**: when no valid `ConsentRecord` is present it
returns a refuse `MedicalAnswer` and makes **zero** downstream calls (no numerics,
no LLM, no retrieval). Every answer it produces — refuse or placeholder — carries
the disclaimer footer. All timestamps are injected via `opts.now`; nothing reads the
wall clock except a documented fallback for ad-hoc manual runs. The S1 allow-all
guardrail, the zero-arg engine constructor, and every non-medical pipeline remain
unchanged.

## Public surface

- `MedicalSopDeps` (`src/medical/engine.ts:27`) — optional DI seam (`auditLog?`,
  `consentGate?`, `disclaimer?`); production leaves it undefined and `run()`
  constructs real instances. Preserves the zero-arg `new MedicalSopEngine()`
  contract that `selector.ts` depends on.
- `MedicalSopEngine.run(prompt, projectRoot, config, opts?)` (`src/medical/engine.ts:55`)
  — now takes `opts?: { runId?: string; now?: string }`; runs Gate 1 (consent) first.
  Absent consent ⇒ `success: false`, `medicalAnswer.shortCircuit: true`, body is the
  canned `CONSENT_REQUIRED_MSG`, plus a `refuse`/`consent-required` audit entry and
  **no** downstream work. Present consent ⇒ allow-only guardrail stub + placeholder
  answer + an `answer` audit entry. Both paths attach the disclaimer footer.
- `ConsentGate` (`src/medical/consent.ts:21`) — manages `.bober/medical/consent.json`.
  - `hasConsent(): Promise<boolean>` (`consent.ts:39`) — fail-closed; missing/corrupt ⇒ false, never throws.
  - `current(): Promise<ConsentRecord | undefined>` (`consent.ts:47`) — parses + validates all four required fields; partial/corrupt ⇒ undefined.
  - `recordConsent(record, nowIso)` (`consent.ts:75`) — persists the record mode-0600 and appends a `consent` audit entry. `nowIso` is an injected ISO timestamp.
- `AuditLog` (`src/medical/audit.ts:21`) — append-only audit writer.
  - `append(entry: AuditEntry)` (`audit.ts:44`) — writes one newline-terminated JSON line to `.bober/medical/audit-<date>.jsonl` (`<date>` = `YYYY-MM-DD` sliced from the injected `entry.tIso`). Opens `O_WRONLY|O_APPEND|O_CREAT` with mode `0600` and an explicit `fh.chmod(0o600)`; never uses `appendFile`. Directory created with `mkdir(..., { recursive: true, mode: 0o700 })`.
- `DisclaimerComposer` (`src/medical/disclaimer.ts:19`) — pure, no I/O.
  - `readonly disclaimerVersion` (`"1.0.0"`) and `footer(): string` (`disclaimer.ts:23`) — a non-empty general-wellness (non-diagnostic) footer carrying `[disclaimer v<version>]`.
- `ConsentRecord` (`src/medical/types.ts:51`) — `{ consentVersion, acceptedAtIso, rulesetVersion, disclaimerVersion }`; `acceptedAtIso` is an injected ISO string.
- `AuditEvent` (`src/medical/types.ts:65`) — discriminated union `"consent" | "short-circuit" | "refuse" | "answer" | "abstain" | "ingest"`.
- `AuditEntry` (`src/medical/types.ts:75`) — `{ tIso, event, rulesetVersion?, patternsetVersion?, ruleId? }`. IDs/enums only — no prompt text, no health values. `patternsetVersion` is reserved for the S3 red-flag detector.

## How to use / how it fits

`ConsentGate` is wired as the first gate inside `MedicalSopEngine.run`. The ordering
this sprint is: (1) compose footer → (2) `consentGate.hasConsent()`; if false, audit a
`refuse` entry and return the refuse answer before touching anything else; (3) else
read `current()`, audit an `answer` entry, and return the placeholder answer with the
footer. To grant consent out of band:

```ts
const audit = new AuditLog(projectRoot);
const gate = new ConsentGate(projectRoot, audit);
await gate.recordConsent(
  { consentVersion: "1.0.0", acceptedAtIso: nowIso, rulesetVersion: "0.0.0", disclaimerVersion: "1.0.0" },
  nowIso, // injected ISO timestamp — never Date.now()
);
// subsequent MedicalSopEngine.run(..., { now: nowIso }) proceeds past Gate 1
```

Tests inject fakes through the `MedicalSopDeps` constructor argument; production code
passes nothing and the engine builds real instances rooted at `projectRoot`.

The persisted state lives under `.bober/medical/`: `consent.json` (mode 0600) and
`audit-<date>.jsonl` (mode 0600), in a directory created mode 0700. This is the
project's first deliberately PHI-conscious on-disk surface — audit entries are
structurally incapable of holding prompt text or health values because `AuditEntry`
exposes only ID/enum fields.

## Notes for maintainers

- **Carry-forward (S3) — downstream spies are currently structurally hollow.**
  The sc-2-4 "zero downstream calls" assertion in `engine.test.ts` (lines 121–149)
  spies on an LLM client and numerics fake that are **not** injectable —
  `MedicalSopDeps` has no `llmClient`/`numerics` slot, so the `not.toHaveBeenCalled`
  assertions pass by code structure, not by interception. When LLM/numerics wire in,
  add real slots to `MedicalSopDeps` and inject fakes so the test would actually
  catch a regression where they run before the consent check. The evaluator flagged
  this as the obligation of **Sprint 3** (its AC1 requires a real
  spy-LLMClient-never-invoked proof on the red-flag short-circuit). (Non-blocking;
  eval verdict was PASS.)
- **Carry-forward (S6) — wall-clock fallback.** `engine.ts:63` uses
  `opts?.now ?? new Date().toISOString()`. The fallback is reachable only on ad-hoc
  manual invocations (every test injects `opts.now`). When the real SOP wires into
  `runPipeline` in Sprint 6, always pass `opts.now` (e.g. the run start timestamp) or
  make it required and update callers, so no live path ever reads the wall clock.
- **MedicalAnswer is attached to `PipelineResult` via a type cast.** `run()` returns
  `... as PipelineResult & { medicalAnswer: MedicalAnswer }` because `PipelineResult`
  has no `medicalAnswer` field yet; a typed extension is deferred to S6.
- **Persistence is a JSON/JSONL sidecar, single-process.** `ConsentGate` notes a
  migration path to the SQLite `FactStore` (`src/state/facts.ts`) and `AuditLog` notes
  a SQLite-WAL / locking-writer path if multi-process concurrent writes are ever
  needed.
- **The guardrail is still allow-only.** Real red-flag detection (and the
  `patternsetVersion`/`short-circuit` audit events that already exist in the enum)
  land in Sprint 3.
