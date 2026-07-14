# Teams: Adding a Team is Data, Not Code

This guide covers the agent-bober team abstraction introduced in Phase 4
(Sprint 1–4 of the domain-agnostic team platform plan). A "team" is a pure
data object in `bober.config.json` — no code change, no new pipeline engine.

See the research document at
`.bober/research/20260614-chattable-team-of-agents-platform.md` (Phase 4,
lines 290–330) for the full motivation and architecture.

---

## What Is a Team?

A team is a named configuration entry that declares three differentiation axes:

| Axis | Config Field | Effect |
|---|---|---|
| **Provider routing** | `providers` | Partial role-to-provider override (unset roles keep the resolved project defaults). |
| **Memory namespace** | `memoryNamespace` | Lessons land in `.bober/memory/<namespace>/` instead of the shared `.bober/memory/`. |
| **Pipeline shape** | `pipelineShape` | Which orchestration engine to use: `"ts"` (default), `"skill"`, or `"workflow"`. |

The built-in **programming** team is always available and uses the default
memory path, the project's default providers, and the `"ts"` engine. Omitting
`--team` or `[team]` selects it automatically.

---

## Config Shape

Declare teams under the top-level `teams` key in `bober.config.json`:

```jsonc
{
  "defaultTeam": "programming",   // Optional. Active team when --team / chat <team> omitted.
  "teams": {
    "example": {
      "displayName": "Example research team",  // Human-readable label (optional)
      "memoryNamespace": "example",            // Lessons land in .bober/memory/example/
      "pipelineShape": "ts",                   // "ts" | "skill" | "workflow"
      "providers": {                           // Partial override — unset roles keep defaults
        "chat": "openai"
      }
    }
  }
}
```

All fields under `teams.<id>` are optional. Unspecified fields inherit the
project defaults resolved by `loadTeam` (`src/teams/registry.ts`).

**`memoryNamespace` constraint:** must match `/^[a-z0-9_-]+$/i` (schema
validation). No slashes, spaces, or dots.

---

## The Three Differentiation Axes

### 1. Provider Routing

Each role (`planner`, `generator`, `evaluator`, `curator`, `chat`, etc.) can
be independently overridden. Roles not listed in `providers` keep the project
default from `resolveRoleProviders`.

```jsonc
"providers": {
  "chat": "openai",       // Chat role uses OpenAI
  "planner": "google"     // Planner role uses Google
  // generator, evaluator, etc. keep project defaults
}
```

### 2. Memory Namespace

Lessons distilled during a team's session land in
`.bober/memory/<memoryNamespace>/` — a sibling directory to the programming
team's `.bober/memory/`.

The programming team uses the sentinel value `""` (empty string), which maps
to the root `.bober/memory/` path. No `programming/` subdirectory is ever
created — this is intentional back-compat behavior.

### 3. Pipeline Shape

Selects the orchestration engine for sprints driven by this team:

| Value | Engine | Use case |
|---|---|---|
| `"ts"` (default) | TypeScript pipeline | Standard feature development |
| `"skill"` | Skill-based engine | Skill-driven sub-tasks |
| `"workflow"` | Workflow engine | Local-model dynamic workflow runtime |
| `"medical-sop"` | Medical SOP engine | Built-in `medical` team only (Phase 6) — see note below |

> **`"medical-sop"` is not a user config knob.** It is accepted by the
> `pipelineShape` schema (so the Zod enum stays in lockstep with the
> `PipelineEngineName` TS union), but the medical team is a **code-registered
> built-in** reached via `loadTeam(config, "medical")`, not by hand-setting
> `pipelineShape: "medical-sop"` on a config team. As of Phase 6 Sprint 3 the
> `MedicalSopEngine` enforces two code-enforced gates: **Gate 1 (consent)** —
> absent a valid `ConsentRecord` it refuses with zero downstream calls — and
> **Gate 2 (red-flag emergency short-circuit)** — a deterministic, zero-LLM
> `RedFlagDetector` that returns a canned 911/988 escalation on any emergency
> match, again with zero downstream calls. As of Phase 6 Sprint 4 the
> **deterministic data + numerics layer** (`HealthDataStore` +
> `NumericsQueryLayer`) also exists — it keeps all arithmetic out of the LLM (see
> "Numerics + data store" below). As of Phase 6 Sprint 5 the **streaming ingestion**
> path that fills that store exists too — `agent-bober medical import <file>`
> stream-parses an Apple Health export into `HealthDataStore` (see "Ingestion"
> below and [`COMMANDS.md`](../COMMANDS.md)). As of `spec-20260628-medical-ingest`
> Sprint 3 a second ingestion entry point exists — `agent-bober medical import-labs <pdf>`
> parses a lab-report PDF (Sprint 1's `parseLabPdf`) into vault notes and reindexes
> them into the same `HealthDataStore` (Sprint 2). It is **fail-closed behind the
> `cloud-inference` egress axis (default off)**: with the axis off it prints a clear
> message naming `medical.egress.cloudInference`, exits 1, and reads **no PDF bytes** —
> it **ships nothing to cloud by default** (see "Ingestion" below and
> [`COMMANDS.md`](../COMMANDS.md)). As of `spec-20260628-medical-ingest` Sprint 4 a
> deterministic, no-LLM **supplements** path exists — `agent-bober medical supplements add|list`
> records a `{ name, dose }` entry as a **FactStore fact** under the `medical` scope
> (`subject=name`, `predicate="dose"`), with re-adding an identical entry an **idempotent
> NOOP** (see "Supplements" below and [`COMMANDS.md`](../COMMANDS.md)). As of
> `spec-20260628-medical-ingest` Sprint 5 (the finale, completing that spec **5 of 5**) a
> **SOPS-encrypted personalization profile** exists — `agent-bober medical profile show|set`
> reads/writes a Zod-validated `profile.yaml` (age / sex / conditions / medications /
> supplements / allergies / goals) behind an injectable cipher seam (default sops, age
> backend, local — **no egress**); read and write **fail closed** (refuse, no plaintext
> PHI on disk) when sops is unavailable (see "Personalization profile" below and
> [`COMMANDS.md`](../COMMANDS.md)). As of Phase 6 Sprint 6 the **full
> ordered SOP is wired end-to-end** under a **code-enforced zero-egress default**:
> consent → red-flag → numerics → medications (from `FactStore`) → an `EgressGuard`
> literature gate → retrieval → disclaimer footer → audit. Both egress axes default
> **false**, so a fresh-config medical turn produces **zero outbound bytes** (see
> "EgressGuard + full SOP wiring" below). As of Phase 6 Sprint 7 the
> `literature-retrieval` axis, when **opted in**, runs a **real MedlinePlus / NIH
> (no-auth) grounded retrieval + cited LLM synthesis** that **abstains unless a
> retrieved passage supports the claim** and otherwise cites ≥ 1 passage — retrieval is
> now real behind the axis, not a stub (see "MedlinePlus grounded retrieval + cited
> synthesis" below). As of `spec-20260618-medical-grounding-critic` Sprint 2 that cited
> synthesis runs behind a **fail-closed grounding gate** (`synthesizeGrounded`): an
> independent critic judges the answer against its cited passages and, on reject, drives
> **one** re-synthesis before **abstaining** — so a poorly-grounded answer is caught
> before it reaches the user (see the grounding-gate note in that same section). As of
> `spec-20260617-medical-whoop-guardrails` Sprint 1 the
> guardrail set also emits a **code-enforced non-emergency `refuse` verdict** for
> prescription / dosing / treatment-plan requests, deterministically and before any LLM
> call, slotting in as **Gate 2b** between the red-flag short-circuit and `allow` (see
> "Guardrails (Phase 6 — Gates 2 + 2b Live)" below). As of
> `spec-20260617-medical-whoop-guardrails` Sprint 2 the `EgressGuard` gained a **third
> independent axis** (`device-connection`, default false) and the **authenticated WHOOP
> transport** behind it (`WhoopTokenStore` + `WhoopClient`, the second sanctioned network
> file) — egress-gated and offline-by-default, no data persistence yet. As of
> `spec-20260617-medical-whoop-guardrails` Sprint 3 (the final sprint of that spec) the
> **WHOOP path persists end-to-end**: a `WhoopSyncAdapter` maps paged WHOOP records into
> `source:"whoop"` observations and `agent-bober medical whoop sync [--since <iso>]` writes them
> into the same `HealthDataStore` — on-demand (no webhooks), idempotent on re-run, and
> fail-closed on partial failure, all still behind the off-by-default `device-connection`
> axis (see "WHOOP device-connection axis + authenticated transport" below and
> [`COMMANDS.md`](../COMMANDS.md)). **The base medical team is engineering-complete (7 of
> 7) and the whoop-guardrails spec is complete (3 of 3); shipping is gated on an external
> regulatory review (S6.5).** See
> [`docs/sprints/sprint-spec-20260616-medical-team-3.md`](sprints/sprint-spec-20260616-medical-team-3.md),
> [`docs/sprints/sprint-spec-20260616-medical-team-4.md`](sprints/sprint-spec-20260616-medical-team-4.md),
> [`docs/sprints/sprint-spec-20260616-medical-team-5.md`](sprints/sprint-spec-20260616-medical-team-5.md),
> [`docs/sprints/sprint-spec-20260616-medical-team-6.md`](sprints/sprint-spec-20260616-medical-team-6.md),
> [`docs/sprints/sprint-spec-20260616-medical-team-7.md`](sprints/sprint-spec-20260616-medical-team-7.md),
> [`docs/sprints/sprint-spec-20260617-medical-whoop-guardrails-1.md`](sprints/sprint-spec-20260617-medical-whoop-guardrails-1.md),
> [`docs/sprints/sprint-spec-20260617-medical-whoop-guardrails-2.md`](sprints/sprint-spec-20260617-medical-whoop-guardrails-2.md),
> and
> [`docs/sprints/sprint-spec-20260617-medical-whoop-guardrails-3.md`](sprints/sprint-spec-20260617-medical-whoop-guardrails-3.md).

---

## CLI Usage

### `agent-bober run --team <id>`

Select a team for the full autonomous pipeline run:

```bash
npx agent-bober run "add research summary" --team example
```

The `--team` flag is additive. Omitting it runs the programming team unchanged:

```bash
npx agent-bober run "implement feature X"   # programming team (default)
```

The team id is threaded to `runPipeline` as `opts.teamId`, which calls
`loadTeam(config, teamId)` to resolve the full team object and select the
appropriate pipeline engine.

### `agent-bober chat [team]`

Select a team for an interactive chat session:

```bash
npx agent-bober chat example   # chat session routed to the example team
npx agent-bober chat           # programming team (default)
```

The session's `buildMemoryDistill` reads from the team's namespace so the LLM
sees only that team's lessons as context. Spawned `agent-bober run` children inherit
the session's run-id but not yet the team id (see Deferred Features below).

---

## Built-in Programming Team

The programming team is always available and requires no config entry. It is
the fallback when:

- `--team` is omitted from `agent-bober run`
- `[team]` positional arg is omitted from `agent-bober chat`
- `config.defaultTeam` is unset

Its properties:

- `id`: `"programming"`
- `memoryNamespace`: `""` (maps to `.bober/memory/`, the root memory path)
- `pipelineShape`: derived from `config.pipeline.engine`
- `providers`: the full resolved project defaults from `resolveRoleProviders`

---

## Deferred Features

The following are documented here for awareness but are NOT yet implemented:

### `.bober/teams/*.json` File Registry (Option A — Deferred)

A future sprint will support defining teams in individual JSON files under
`.bober/teams/<id>.json` instead of embedding them in `bober.config.json`.
This allows version-controlling team definitions separately and loading them
without modifying the main config. Reference: research doc Phase 4, line 295.

### Spawned-Run Team Propagation (Deferred)

`agent-bober chat <team>` routes the chat session's `buildMemoryDistill` to the
team's namespace. Spawned `agent-bober run` children (triggered by chat) do not yet
carry `--team <id>` in their argv — they run on the programming team by
default. A future sprint will thread `teamId` through `RunSpawnerOptions` so
spawned children inherit the active chat team.

### Guardrails (Phase 6 — Gates 2 + 2b Live)

The `guardrails` field on a resolved `Team` (`src/teams/types.ts`) holds a
`GuardrailSet` — a rule set that guards medical prompts before the LLM call.
The type surface lives in `src/medical/types.ts` (`GuardrailSet` /
`GuardrailVerdict` / `GuardrailContext`). As of Phase 6 Sprint 3 the built-in
`medical` team fills this slot with the **real** `MedicalGuardrails`
(`src/medical/guardrails.ts`, `rulesetVersion "guardrail-2026.06.16"`), which
replaces the Sprint 1–2 allow-all stub. Its `evaluate(prompt, ctx)`:

- **throws** on an empty/whitespace prompt;
- runs a pure/synchronous `RedFlagDetector` (`src/medical/red-flag.ts`,
  `PATTERNSET_VERSION "redflag-2026.06.16"`, zero imports / no I/O / no model)
  that classifies the prompt into `cardiac` / `stroke` / `anaphylaxis` /
  `self-harm` / `overdose` / `none` via conservative case-insensitive phrase
  matching — self-harm/overdose are checked first so the 988 hotline wins over
  911;
- returns `{ kind: "short-circuit", rule, cannedResponse }` with a **fixed,
  never-model-generated** 911 escalation (cardiac/stroke/anaphylaxis) or 988
  escalation (self-harm/overdose) on any match;
- then — **emergency precedence preserved** — runs a pure/synchronous
  `RefusalDetector` (`src/medical/refusal.ts`,
  `REFUSAL_PATTERNSET_VERSION "refusal-2026.06.17"`, zero imports / no I/O / no
  model) that classifies the prompt into `prescription` / `specific-dosing` /
  `individualized-treatment-plan` / `none`, and returns
  `{ kind: "refuse", rule, reason }` with a **fixed, never-model-generated**
  decline-and-see-a-licensed-clinician message (from the exported
  `REFUSAL_REASONS` record, byte-asserted in tests) on any match;
- otherwise returns `{ kind: "allow" }`.

As of `spec-20260617-medical-whoop-guardrails` Sprint 1 the `refuse` branch is
**live and code-enforced** (previously a documented placeholder). It runs only
**after** the red-flag check's early return, so an emergency prompt that also
matches a refuse phrase still short-circuits to the 911/988 escalation rather
than refusing. `refusalPatternsetVersion` is exposed on `MedicalGuardrails` for
the engine's refuse audit entry; `GuardrailContext` stays empty (ADR-3).
Detection is deliberately conservative: novel/indirect phrasing may return
`none` and fall through to the normal (still-guardrailed) path — known advisory
false-negative gaps are surfaced to a future patternset revision / external
counsel review, never widened into an LLM filter. Every other team's
`guardrails` slot remains `undefined`, and only `MedicalSopEngine.run` reads and
enforces it (see Gates 2 / 2b below).

### Safety gates + audit substrate (Phase 6 Sprints 2–3)

**Code-enforced** safety gates run in fixed order inside
`MedicalSopEngine.run` (`src/medical/engine.ts`). The first two are described here;
**Gate 3 (the `EgressGuard` literature gate)** and the full SOP order they front were
wired in Sprint 6 — see "EgressGuard + full SOP wiring" below.

- **Gate 1 — consent (fail-closed, Sprint 2).** `ConsentGate`
  (`src/medical/consent.ts`) reads `.bober/medical/consent.json`. A missing or
  corrupt record means **no consent**, and the engine returns a refuse
  `MedicalAnswer` (`shortCircuit: true`) with **zero** downstream calls — no
  numerics, no LLM, no retrieval. `recordConsent(record, nowIso)` persists the
  record mode-0600 and audits a `consent` event.
- **Gate 2 — red-flag emergency short-circuit (Sprint 3).** Immediately after
  consent and **before any numerics or LLM call**, the engine runs
  `guardrails.evaluate(userPrompt, {})`. On a `short-circuit` verdict it returns
  a `MedicalAnswer` whose `body` is the canned 911/988 escalation
  (`shortCircuit: true`, with the disclaimer footer) and reaches **zero**
  downstream work, plus a `short-circuit` audit entry carrying `ruleId` +
  `rulesetVersion` + `patternsetVersion` (IDs/enums only). On `allow` it falls
  through to the normal path. The detector/guardrail are pure and need no
  network or `LLMClient` — detection is deterministic and local only. See
  "Guardrails (Phase 6 — Gates 2 + 2b Live)" above. The injectable
  `MedicalSopDeps.llmClient` / `MedicalSopDeps.numerics` spy slots make the
  "never called on short-circuit" guarantee enforceable by tests.
- **Gate 2b — non-emergency content-policy refuse (whoop-guardrails Sprint 1).**
  Immediately after Gate 2 (and reached **only** when the red-flag verdict was
  not a short-circuit, so emergency precedence holds), `evaluate` runs the
  `RefusalDetector`. On a `refuse` verdict the engine returns a `MedicalAnswer`
  whose `body` is the **fixed canned decline** (`shortCircuit: true`,
  `abstained: false`, `citations: []`, with the disclaimer footer) and reaches
  **zero** downstream work — no numerics, FactStore, retrieval, or LLM — plus a
  `refuse` audit entry carrying `ruleId` + `rulesetVersion` +
  `patternsetVersion` (IDs/enums only, no prompt text). It mirrors the
  consent-refuse path. The same `llmClient` / `numerics` spy slots prove the
  "never called on refuse" guarantee.
- **Audit log (PHI-free, append-only).** `AuditLog` (`src/medical/audit.ts`)
  appends one JSON line per event to `.bober/medical/audit-<date>.jsonl`,
  opened `O_WRONLY|O_APPEND|O_CREAT` with file mode `0600`. Entries
  (`AuditEntry`) carry **IDs/enums only** — `tIso`, `event`, optional
  `rulesetVersion` / `patternsetVersion` / `ruleId`. Prompt text and health
  values are never written.
- **Disclaimer footer.** `DisclaimerComposer` (`src/medical/disclaimer.ts`)
  produces a versioned, non-diagnostic general-wellness footer attached to
  **every** `MedicalAnswer` (refuse, short-circuit, and answer paths alike).

All timestamps are injected via `MedicalSopEngine.run`'s `opts.now`, never read
from the wall clock on any tested path. Full details:
[`docs/sprints/sprint-spec-20260616-medical-team-2.md`](sprints/sprint-spec-20260616-medical-team-2.md)
and
[`docs/sprints/sprint-spec-20260616-medical-team-3.md`](sprints/sprint-spec-20260616-medical-team-3.md).

### Numerics + data store (Phase 6 Sprint 4)

The medical team **never lets the LLM perform arithmetic** (ADR-3). Two pure,
synchronous building blocks provide the deterministic numeric substrate. They exist
as of Sprint 4 and are **wired into `MedicalSopEngine.run` as of Sprint 6** (the
numerics step of the full SOP — see "EgressGuard + full SOP wiring" below).

- **`HealthDataStore` (`src/medical/health-store.ts`).** A `better-sqlite3`
  **synchronous** store mirroring `FactStore` (`src/state/facts.ts`). It uses
  **three** tables: `health_observations` (the generic metric time-series),
  `lab_results` (biomarkers with `ref_low`/`ref_high` reference ranges), and
  `kv_store` (backing baselines + preferences). Rows are deduped via
  `INSERT OR IGNORE` on a deterministic SHA-256 id
  (`observationId(metric|tStart|source|value)`, mirroring `factId`), and
  `upsertObservations` returns the count of **NEW rows only**. Accessors:
  `getObservations(metric, fromIso, toIso)` (ordered `t_start` ASC),
  `getLabSeries(biomarker)`, `upsertLabResult`, `getBaseline`/`putBaseline`,
  `getPreference`, `close`. The store **never reads the clock** — every timestamp
  is an injected ISO-8601 parameter. Medications are **not** stored here; they are
  FactStore value-of-record (S6 / ADR-7).
- **`NumericsQueryLayer` (`src/medical/numerics.ts`).** Computes a **closed
  whitelist of 8 numeric primitives** — `mean | min | max | latest | delta |
  slope | percentile | zscore` — over a metric window via
  `getMetric(window, primitive, percentile = 50)`, plus `getLabTrend(biomarker)`.
  Dispatch is an exhaustive `switch` with a `never` guard, so adding a primitive
  is a compile-time **code-review event**, not a model decision. There is **no
  `eval`, no `Function`, no `vm`, no `child_process`/`execa`** anywhere in the
  layer (asserted by a source-grep guard test).

`getMetric` **never throws**. It distinguishes a true **abstain** from a
code-enforced **refusal** via `sampleCount`:

| Situation | Result | Meaning |
|---|---|---|
| Empty window | `{ value: null, sampleCount: 0 }` | Abstain — no data. |
| Mixed units for the metric | `{ value: null, sampleCount: N>0 }` | Cross-unit refusal — refuses to blend e.g. `kg` + `lb`. |
| `zscore` with n<2 | `{ value: null, sampleCount: 1 }` | Partial abstain — stddev undefined. |
| `slope` all at one timestamp | `{ value: null, sampleCount: N }` | Partial abstain — degenerate denominator. |

So `value === null && sampleCount === 0` means "nothing to compute," whereas
`value === null && sampleCount > 0` means "data found but unsafe to aggregate
as-is." Full details:
[`docs/sprints/sprint-spec-20260616-medical-team-4.md`](sprints/sprint-spec-20260616-medical-team-4.md).

**`lab_results` is a derived, rebuildable index.** Besides the Apple Health
ingestion path below, the **medical-ingest leg** (a separate spec) populates
`lab_results` from **canonical vault lab notes**: `writeLabNote`
(`src/medical/lab-note.ts`) serializes each parsed marker to a
markdown-with-frontmatter note under `<vaultDir>/labs/<panel-slug>/`, and
`reindexLabNotes(vaultDir, store)` (`src/medical/lab-reindex.ts`) globs those
notes back and `upsertLabResult`s each one. The **vault markdown is canonical**;
the SQLite `lab_results` table holds no information the notes do not and can be
dropped and fully rebuilt by re-running `reindexLabNotes`. Reindex is
**idempotent** — dedup is the same deterministic `labResultId(biomarker,
collectedAtIso, value)` under `INSERT OR IGNORE`, so a second pass over unchanged
notes inserts 0 rows. That module is **pure file + SQLite** and deliberately does
**not import `src/vault`** (it hand-rolls a flat-scalar frontmatter subset), so its
build stays independent of the vault-store spec's timing. Full details:
[`docs/sprints/sprint-spec-20260628-medical-ingest-2.md`](sprints/sprint-spec-20260628-medical-ingest-2.md).

### Ingestion (Phase 6 Sprint 5)

The store above is filled by a **bounded, streaming ingestion** path —
`src/medical/ingestion.ts` + `src/medical/adapters/`. It is **registry-driven**
so new sources are additive (ADR-4): an adapter is a `new class` only.

- **`IngestionNormalizer` (`src/medical/ingestion.ts`).** Holds an
  `IngestionAdapter` registry. `register(adapter)` adds an adapter;
  `importFile(filePath)` dispatches to the **first** adapter whose
  `canHandle(filePath)` is true, runs `adapter.ingest(filePath, sink)`, and
  returns its `IngestionResult` (`{ recordsParsed, newRows }`). When no adapter
  matches it throws `Error("No ingestion adapter can handle '<path>'")` — the
  path is named in the message.
- **`StoreObservationSink` (`src/medical/ingestion.ts`).** The async
  `ObservationSink` an adapter writes into. `writeBatch(obs, labs)` calls
  `HealthDataStore.upsertObservations` / `upsertLabResult` (synchronous
  `better-sqlite3`) and accumulates the public `newRows` counter across **all**
  batches. Its **async signature is the backpressure seam** — the adapter awaits
  it before pulling more data.
- **`AppleHealthAdapter` (`src/medical/adapters/apple-health.ts`).** The first
  adapter (`kind = "apple-health"`, `canHandle` = `.xml`). It stream-parses an
  Apple Health `export.xml` via **SAX** without ever loading the
  (potentially multi-GB) document into memory:
  - The file is opened with `fs.createReadStream(..., { encoding: "utf8" })` and
    consumed as an **async iterable** (`for await (const chunk of stream)`) —
    **never** `readFile`/`readFileSync` of the whole file. Each chunk is fed to a
    strict `sax.parser`.
  - Each `<Record>` open tag maps to a `HealthObservation`: `type → metric`,
    `value → value` (`parseFloat`; **non-numeric records are skipped**),
    `unit → unit`, `startDate → tStart`, `endDate → tEnd` (optional), and a
    constant `source: "apple-health"` (the file's `sourceName` is not propagated).
  - Observations buffer until `BATCH_CAP` (1000); the adapter then `await`s
    `sink.writeBatch(batch, [])` **before** the `for await` loop pulls the next
    chunk. That `await` **is** the backpressure — rows cannot accumulate unbounded
    behind a slow sink. A final flush drains the `< BATCH_CAP` tail after the
    stream ends.
- **Idempotent re-import.** The adapter does no dedup itself — re-import safety is
  entirely the Sprint 4 `HealthDataStore` `INSERT OR IGNORE` on the deterministic
  `observationId`. Importing the same file twice reports `newRows: 0` on the
  second run with an unchanged row count.
- **`sax@1.6.0` dependency.** A tiny, pure-JS SAX parser with **no native build
  and no network surface**, **isolated to `apple-health.ts`** (no other file
  imports it). Whoop / CSV adapters are an explicit non-goal of Sprint 5 — they
  are additive later via the same registry.

User-facing usage is in [`COMMANDS.md`](../COMMANDS.md) under `agent-bober medical
import`. Full details:
[`docs/sprints/sprint-spec-20260616-medical-team-5.md`](sprints/sprint-spec-20260616-medical-team-5.md).

**Lab-PDF ingestion — `agent-bober medical import-labs <pdf>` (`spec-20260628-medical-ingest`
Sprint 3).** A second ingestion entry point, for a different source: a lab-report PDF
rather than a streamed device export. The exported, testable
`runImportLabs(projectRoot, pdfPath, deps?, opts?)` (`src/cli/commands/medical.ts:153`,
a `medical` **subcommand**, not a top-level command) runs a **load-bearing fail-closed
order**:

- It resolves an `EgressGuard` from config and checks the `cloud-inference` axis
  **first**. With the axis **off (the default)** it writes a clear message naming
  `medical.egress.cloudInference`, sets `process.exitCode = 1`, and **returns before
  reading the PDF or constructing any inference client** — so a default-config run reads
  **zero PDF bytes** and **ships nothing to cloud**.
- Only when `medical.egress.cloudInference: true` does it build the parse client
  (`buildMedicalInferenceClient`), read the PDF, call Sprint 1's `parseLabPdf`, write a
  Sprint 2 vault note per marker, `reindexLabNotes` into the same `HealthDataStore`
  (`.bober/medical/health.db`), and report `records parsed` / `new rows`.
- Re-importing the same report is **idempotent** — the Sprint 2 reindex dedups on the
  deterministic `labResultId` (`INSERT OR IGNORE`), so the second run reports `new
  rows: 0`.
- It appends an **IDs/enums-only** audit entry (`{ tIso, event: "ingest" }`) — no marker
  name, value, panel, or count reaches the audit log — and always `store.close()`s in
  `finally`; the `.action()` never throws.

User-facing usage is in [`COMMANDS.md`](../COMMANDS.md) under `agent-bober medical import-labs`.
Full details:
[`docs/sprints/sprint-spec-20260628-medical-ingest-3.md`](sprints/sprint-spec-20260628-medical-ingest-3.md).

**Supplements — `agent-bober medical supplements add|list` (`spec-20260628-medical-ingest`
Sprint 4).** A deterministic, no-LLM capture path for supplements. Unlike the lab-PDF and
device-export ingestion above, supplements are **FactStore facts under the `medical`
scope**, not `HealthDataStore` rows. The testable cores `runSupplementAdd` /
`runSupplementList` (`src/medical/supplements.ts`, nested `medical` **subcommands**, not
top-level commands):

- `add <name> [--dose <d>]` flattens the entry into a `FactInput`
  (`scope: "medical"`, `subject: <name>`, `predicate: "dose"`, `value: <dose>` or the
  `"unspecified"` placeholder) and reconciles it into the FactStore via the existing
  `writeFact` with **no judge** — a deterministic ADD/UPDATE/NOOP path (no LLM, no network).
  Re-adding an **identical name+dose** is an **idempotent NOOP** (`reconcileFact`
  exact-match), so the active-fact count never grows; a changed dose UPDATEs the fact.
- `list [--file <path>]` parses a markdown-frontmatter supplements list (default
  `.bober/medical/supplements.md`, one `Name | dose` item per line) and prints each entry.

Supplements deliberately use a **different FactStore shape from medications** (ADR-7):
`subject=<name>` / `predicate="dose"` (each supplement is its own subject row), whereas
medications are `subject="patient"` / `predicate="takes-medication"` (the bi-temporal
value-of-record the SOP reads via
`getActiveFacts("medical","patient","takes-medication")`).

User-facing usage is in [`COMMANDS.md`](../COMMANDS.md) under `agent-bober medical supplements`.
Full details:
[`docs/sprints/sprint-spec-20260628-medical-ingest-4.md`](sprints/sprint-spec-20260628-medical-ingest-4.md).

**Personalization profile — `agent-bober medical profile show|set` (`spec-20260628-medical-ingest`
Sprint 5, the finale).** A small, Zod-validated personalization snapshot (age / sex /
conditions / medications / supplements / allergies / goals) persisted as a
**SOPS-encrypted `<vaultDir>/profile.yaml`** (default `.bober/medical/profile.yaml`). The
module `src/medical/profile.ts` keeps encryption behind an **injectable cipher seam**
(`ProfileCipher { available(); encrypt(); decrypt() }`) whose default shells out to `sops`
(age backend) via `execa`; tests inject a reversible fake cipher, so no real binary runs in
the suite.

- `writeProfile` / `readProfile` are **fail-closed**: `cipher.available()` is checked
  **before** any serialization, encryption, or disk IO. When `sops` is unavailable both
  paths reject with a clear message and **plaintext PHI never reaches disk** — the only
  bytes ever written to `profile.yaml` are ciphertext. The encryption is **local, age
  backend, no egress**.
- `set <key> <value>` is read-modify-write: it reads the existing profile (or a safe
  default if none exists), updates one field, re-validates the whole object via
  `ProfileSchema` (negative age / unknown sex rejected), and re-encrypts. Array keys take a
  comma-separated value.
- The profile is a **denormalized personalization snapshot** — `FactStore` remains
  canonical for structured medication/supplement facts, and only this structured
  `profile.yaml` is encrypted (free-text markdown bodies stay plaintext-in-private-repo by
  design). Goals are captured here for a downstream analysis pass (a sibling spec).

`src/medical/profile.ts` hand-rolls its flat-YAML emit/parse and does **not import
`src/vault`** — like the Sprint 2 / Sprint 4 frontmatter readers, it stays independent of
the sibling vault spec's timing. User-facing usage is in
[`COMMANDS.md`](../COMMANDS.md) under `agent-bober medical profile`. Full details:
[`docs/sprints/sprint-spec-20260628-medical-ingest-5.md`](sprints/sprint-spec-20260628-medical-ingest-5.md).
**`spec-20260628-medical-ingest` is engineering-complete (5 of 5).**

### EgressGuard + full SOP wiring (Phase 6 Sprint 6)

Sprint 6 is the integration linchpin: it wires the **full ordered SOP** inside
`MedicalSopEngine.run` under a **code-enforced zero-egress default**. With a fresh
config, a medical turn produces **zero outbound bytes**.

**`EgressGuard` (`src/medical/egress.ts`) — three independent opt-in axes.** All
default **false** (as of `spec-20260617-medical-whoop-guardrails` Sprint 2 a third
`device-connection` axis joined the original two):

- `EgressAxis` = `"cloud-inference" | "literature-retrieval" | "device-connection"`.
- `isAllowed(axis)` returns `true` **only** when that axis was explicitly opted in;
  the three axes are read **independently** (enabling one does not enable the others).
  As of Sprint 2 `isAllowed` is an exhaustive `switch` with a compile-time `never`
  guard, so an unhandled future axis is a build error.
- `assertAllowed(axis)` **throws** `Error("Egress axis '<axis>' not enabled")` when
  off, returns `void` when on — the hard barrier the literature (`medline-source.ts`)
  and device (`whoop-client.ts`) network calls sit behind.
- `EgressGuard.fromConfig(config)` reads `config.medical.egress`, defaulting each axis
  to `false` when the section/field is absent. (The third constructor parameter is
  **optional** and defaults `false`, so existing 2-arg call sites stay byte-identical.)

**Config keys (all three default false).** A new optional top-level `medical` section
(`MedicalSectionSchema`, `src/config/schema.ts`):

```jsonc
{
  "medical": {
    "egress": {
      "cloudInference": false,        // permit cloud inference synthesis (default false)
      "literatureRetrieval": false,   // permit MedlinePlus literature retrieval (default false)
      "deviceConnection": false       // permit WHOOP device-connection egress (default false)
    }
  }
}
```

Omitting the `medical` section leaves all three axes off. (Also surfaced in the README
"Full Configuration Reference".)

**Scoped ESLint network boundary + single exception.** `eslint.config.js` gained a
flat-config block over `files: ["src/medical/**/*.ts"]` that makes egress a **lint
error**: `no-restricted-imports` forbids `undici` / `got` / `axios` / `node-fetch` and
the patterns `http` / `https` / `net` / `tls` / `dgram` (and their `node:` forms), and
`no-restricted-globals` forbids the `fetch` global. A follow-up override (flat-config
last-match-wins) turns both rules **off** for exactly **two** sanctioned network files —
`src/medical/retrieval/medline-source.ts` (the real MedlinePlus call, Sprint 7) and, as
of whoop-guardrails Sprint 2, `src/medical/whoop/whoop-client.ts` (the WHOOP OAuth grant
+ v2 fetch). Those are the **only** two files under `src/medical` that may touch the
network; a forbidden import added to any other medical file (including the network-free
`whoop-token.ts`) would fail `npm run lint`. This is defence in depth alongside the
runtime `EgressGuard`.

**`LiteratureRetriever` (`src/medical/retrieval/literature.ts`).** `retrieve(query)`
checks `egress.isAllowed("literature-retrieval")` **before** touching the source: when
off it returns `{ kind: "disabled" }` **synchronously** (no `MedlineSource` method
called, no network attempt — the zero-egress proof); when on it delegates to
`MedlineSource.fetchPassages`. `MedlineSource` (`retrieval/medline-source.ts`) was a stub
in Sprint 6 and became the **real MedlinePlus fetch in Sprint 7** (see below); its
`RetrievalOutcome` union is `{disabled} | {abstain,reason} | {grounded,passages}`.

**Medications come from `FactStore`, not `HealthDataStore` (ADR-7).** The engine reads
active medications via
`FactStore.getActiveFacts("medical", "patient", "takes-medication")` — the bi-temporal
value-of-record. The `HealthDataStore` schema is untouched; it never stores medication
state.

**The full ordered SOP — the ordering *is* the safety guarantee.**
`MedicalSopEngine.run` runs, in fixed order:

1. **Gate 1 — consent** (fail-closed; refuse + zero downstream on no consent).
2. **Gate 2 — red-flag short-circuit** (0-LLM canned 911/988 escalation on match).
3. **Gate 2b — non-emergency refuse** (whoop-guardrails S1; 0-LLM canned decline
   on a `prescription` / `specific-dosing` / `individualized-treatment-plan`
   match; reached only when Gate 2 did not short-circuit, so emergency wins).
4. **Numerics** — deterministic `NumericsQueryLayer.getMetric`, **no LLM**.
5. **Medications** — `FactStore.getActiveFacts(...)` (ADR-7).
6. **Gate 3 + retrieval** — `EgressGuard.isAllowed("literature-retrieval")`;
   `LiteratureRetriever.retrieve` ⇒ `{disabled}` (abstain) when off, or
   `{grounded,passages}` → `synthesizeGrounded` (cited synthesis behind the
   **fail-closed grounding gate**, **S7** + grounding-critic S2) when on.
7. **Disclaimer footer**, then **audit** (`answer` / `abstain`, PHI-free), then
   return `PipelineResult & { medicalAnswer }`.

The consent / red-flag / refuse gates run **before** any numerics, medications, egress,
retrieval, or LLM work, so a refuse/short-circuit reaches **zero** downstream calls. With both axes off, a numeric
question answers from deterministic compute (a spy `LLMClient` is never called) and a
literature question abstains (`MedlineSource.fetchPassages` is never called) — verified
by a network spy recording **zero** calls. `MedicalSopDeps` gained `egress?` /
`literature?` / `facts?` / `healthStore?` injection slots (the zero-arg constructor is
preserved). Full details:
[`docs/sprints/sprint-spec-20260616-medical-team-6.md`](sprints/sprint-spec-20260616-medical-team-6.md).

---

### MedlinePlus grounded retrieval + cited synthesis (Phase 6 Sprint 7)

Sprint 7 is the **opt-in networked slice** and the **plan finale**: with the
`literature-retrieval` axis turned **on**, the medical team performs a **real
MedlinePlus / NIH (no-auth) grounded retrieval** and a **cited LLM synthesis** that
**abstains unless a retrieved passage supports the claim**. Retrieval is now real
behind the axis — **not a stub**. With the axis **off**, behavior is byte-identical to
Sprint 6 (synchronous `{disabled}` ⇒ abstain, zero outbound bytes).

**Opt in.** The axis is off by default; enable it explicitly (cloud inference stays off):

```jsonc
{
  "medical": {
    "egress": {
      "cloudInference": false,        // independent axis — stays off
      "literatureRetrieval": true     // permit the MedlinePlus fetch + grounded synthesis
    }
  }
}
```

**The single network file (`src/medical/retrieval/medline-source.ts`).** The live
`fetch` lives **only** here — the one file the S6 ESLint exception sanctions, still the
**only** medical file touching `fetch`/`Response`. `MedlineSource.fetchPassages(query)`
calls `EgressGuard.assertAllowed("literature-retrieval")` as its **first** statement
(runtime defense-in-depth over the static lint boundary), queries the MedlinePlus Web
Service (`wsearch.nlm.nih.gov/ws/query`, `db=healthTopics`, no auth), and parses the
`nlmSearchResult` JSON into `Passage[]` (`{ title; url; text; source: "medlineplus" }`).
It returns `grounded{passages}` | `abstain{no-passages}` (empty result) |
`abstain{source-error}` (`!res.ok`, network throw, parse error, or the axis-off
`assertAllowed` throw — all caught). It **never throws out and never fabricates
content**.

**Injectable transport ⇒ offline CI.** The constructor takes a `FetchLike` transport
(`(url) => Promise<{ ok; status; json() }>`) defaulting to the global `fetch` (allowed
**only** in this file). Tests inject a duck-typed fake returning the committed fixture
`src/medical/retrieval/__fixtures__/medlineplus-sample.json`, so **no live network runs
in CI**.

**Cited synthesis (`synthesize`, `src/medical/retrieval/literature.ts`).** A **single**
provider-agnostic `LLMClient.chat` call pins the model to the retrieved passages and
instructs it to reply with the single word `ABSTAIN` if they do not support a specific
answer. The default model is **local Ollama `llama3`** — resolved (as of
grounding-critic Sprint 3) by `buildMedicalInferenceClient` (see "Configurable model +
cloud-inference gating" below), and still injectable via `deps.llmClient`. Rules (enforced
in code):

- An empty response **or** `ABSTAIN` (case-insensitive) ⇒ an **abstained**
  `MedicalAnswer` with `citations: []` and **no clinical assertion**.
- A non-abstained answer attaches citations derived from the passages, so
  `citations.length >= 1` is guaranteed. **No code path emits a non-abstained answer
  with zero citations.**

**Grounding gate (`synthesizeGrounded`, grounding-critic Sprint 2).** As of
`spec-20260618-medical-grounding-critic` Sprint 2 the engine's grounded branch no longer
calls `synthesize` directly — it calls **`synthesizeGrounded`** (also in
`src/medical/retrieval/literature.ts`), a **fail-closed gate** that wraps `synthesize` with
the independent grounding critic (`src/medical/retrieval/grounding-critic.ts`): synthesize →
critique → on `reject`, **one** re-synthesis with the critic's feedback appended to the
synthesis system prompt → re-critique → **abstain** on a second `reject` **or on any thrown**
transport/model error at any step (every `synthesize` / critic call is try/catch-wrapped to a
canned abstain — an exception never escapes and an ungrounded answer is never returned). On a
first approve the original cited answer passes through unchanged. The gate is bounded by the
exported `GROUNDED_GATE_MAX_LLM_CALLS` (= 6 today, **computed** from the critic's
`GROUNDING_MAX_LLM_CALLS` as `1 synth + critic + 1 re-synth + re-critic`). This is the **only**
place in the SOP that makes more than one LLM call — every upstream gate stays zero-LLM. As of
grounding-critic Sprint 3 the critic outcome **is** now recorded in the audit as the
IDs/enums-only `AuditEntry.criticVerdict` (see "Critic verdict in the audit" below).

**Fail-closed at three independent layers (never fail-open, never an uncited claim):**

1. **Axis off** — `assertAllowed` throws ⇒ `abstain{source-error}`; `synthesize` on a
   `disabled`/`abstain` outcome returns an abstained answer **without calling the LLM**.
2. **Source error** — `!res.ok` (e.g. 503), network throw, empty `document[]`, or
   malformed response ⇒ `abstain` ⇒ LLM never called ⇒ abstained answer.
3. **Model unavailable** — `llm.chat` throws (e.g. Ollama down) ⇒ caught ⇒ abstained
   answer (*"model unavailable"*). **No cloud fallback.**

**Cloud inference stays independently off by default — and fails closed.** With a default
config the grounded path constructs **only** the local/Ollama `LLMClient` (or the injected
one) — **never** a cloud provider — and never auto-falls-back to cloud. `EgressGuard(false, true)`
keeps `isAllowed("cloud-inference") === false`: enabling literature retrieval does **not**
enable cloud inference. As of grounding-critic Sprint 3 the synthesis/critic model is
*configurable* via `config.medical.inference`, but a **cloud** provider there is honoured
**only** when the `cloud-inference` axis is opted in; otherwise the resolver **fails closed to
the local default** (see "Configurable model + cloud-inference gating" below).

**Wiring (`MedicalSopEngine.run`).** The grounded branch resolves the `LLMClient` + model
**lazily, on that path only**, so numeric / disabled / red-flag / abstain turns
construct **zero** LLM clients (preserving the S2/S3 never-called guarantees and
sc-7-8). As of grounding-critic Sprint 2 that branch calls
`synthesizeGrounded` (the fail-closed grounding gate above) instead of the bare
`synthesize`; as of Sprint 3 it obtains its client + model from
`buildMedicalInferenceClient(config, egress)` (an injected `deps.llmClient` still wins for
tests) and threads the resolved model into `synthesizeGrounded`. Every non-grounded path
(consent / red-flag / refuse / numeric-only / literature-disabled) remains zero-LLM. The
audit event is still `answer` for a non-abstained synthesis, `abstain` otherwise — now
joined on the grounded path by the IDs/enums-only `criticVerdict` (see below). Full
details:
[`docs/sprints/sprint-spec-20260616-medical-team-7.md`](sprints/sprint-spec-20260616-medical-team-7.md),
[`docs/sprints/sprint-spec-20260618-medical-grounding-critic-2.md`](sprints/sprint-spec-20260618-medical-grounding-critic-2.md),
and
[`docs/sprints/sprint-spec-20260618-medical-grounding-critic-3.md`](sprints/sprint-spec-20260618-medical-grounding-critic-3.md).

**Configurable model + cloud-inference gating (grounding-critic Sprint 3).** The
synthesis/critic model + provider are configurable via an optional `config.medical.inference`
block; a **cloud** model is reachable **only** behind the existing `cloud-inference` egress
axis (no new axis was added). `buildMedicalInferenceClient(config, egress)`
(`src/medical/inference.ts`) returns `{ client, model }` and is the **single** place that
decides local-vs-cloud — `createClient` (the providers factory) is the only
client-construction seam, with an injectable `factory` param so tests spy without real
network. "Local" = `provider: "openai-compat"` **and** an endpoint containing `localhost`;
anything else is treated as cloud and gated:

- **No `inference` block** ⇒ the exact local default (`openai-compat`,
  `http://localhost:11434/v1`, `llama3`) — byte-identical to grounding-critic Sprint 2.
- **`inference` points at a local provider/endpoint** ⇒ used as-is (non-egressing).
- **`inference` names a cloud provider while `medical.egress.cloudInference` is `false`
  (the default)** ⇒ **FAIL CLOSED**: the cloud config is ignored and the local default is
  returned — **no cloud client is ever constructed** (a factory spy asserts it is never
  called with a cloud provider when the axis is off).
- **Cloud provider AND `medical.egress.cloudInference: true`** ⇒ the configured cloud client
  + model is built, and that same model threads into the grounding critic.

```jsonc
// Cloud synthesis is reachable ONLY behind the cloud-inference opt-in (default false):
{
  "medical": {
    "egress": { "cloudInference": true },          // required — default false fails closed to local
    "inference": { "provider": "anthropic", "model": "claude-sonnet-4-5" }
  }
}
```

(Also surfaced in the README "Full Configuration Reference".)

**Critic verdict in the audit (grounding-critic Sprint 3).** `synthesizeGrounded`'s return
widened from `MedicalAnswer` to `{ answer, verdict }` (the new `GroundedResult` type) so the
engine can classify the gate outcome. On the grounded path only, the engine appends an
optional IDs/enums-only `AuditEntry.criticVerdict` (type `CriticVerdict`):

- `approve` — the gate returned an approved answer,
- `reject-abstained` — the gate abstained after a critic reject,
- `error-abstained` — the gate abstained due to a thrown transport/model error.

`criticVerdict` is one of those three literals — **never** the critic's feedback string or
any prompt / answer / health value — and is spread into the audit line **only** when the
grounded branch produced a verdict, so non-grounded entries are byte-identical. The audit
file stays mode `0600` after appending, and the line carries no substring of the prompt or
answer. Full details:
[`docs/sprints/sprint-spec-20260618-medical-grounding-critic-3.md`](sprints/sprint-spec-20260618-medical-grounding-critic-3.md).

---

### WHOOP device-connection axis + authenticated transport (whoop-guardrails Sprint 2)

`spec-20260617-medical-whoop-guardrails` Sprint 2 adds a **third** egress axis,
`device-connection` (default **false**, independent of the other two), and the
**authenticated WHOOP transport** behind it; Sprint 3 adds the **sync adapter, record
mapping, and the `agent-bober medical whoop sync` CLI** that persist WHOOP data end-to-end (see
"WHOOP sync adapter + CLI" below). With the axis off (the default), the WHOOP path makes
**zero outbound bytes**, exactly like the other two axes.

**Opt in.** Enable the axis explicitly; the other two axes stay independently off:

```jsonc
{
  "medical": {
    "egress": {
      "cloudInference": false,        // independent axis — stays off
      "literatureRetrieval": false,   // independent axis — stays off
      "deviceConnection": true        // permit the WHOOP OAuth grant + v2 fetch
    }
  }
}
```

**Credentials: env vars + a `0600` sidecar (no keychain).**
`WhoopTokenStore` (`src/medical/whoop/whoop-token.ts`) — a deliberately
**network-free** file — reads `WHOOP_CLIENT_ID` / `WHOOP_CLIENT_SECRET` from
`process.env` (throwing a clear "set …" error when unset) and keeps the rotating refresh
token in a JSON sidecar at `.bober/medical/whoop-token.json` written with file mode
**`0600`**. OS-keychain storage is an explicit non-goal (ADR-2); credentials are env-only.
`readRefreshToken()` is fail-closed — an absent **or corrupt** sidecar ⇒ `undefined`
(treated as "not yet authorised").

**The second sanctioned network file (`src/medical/whoop/whoop-client.ts`).** All WHOOP
HTTP lives **only** here — it is the second (and last) entry on the `eslint.config.js`
medical network-exception list, sibling to `medline-source.ts`. `WhoopClient`:

- `ensureAccessToken()` and `fetchPage(collection, window, cursor?)` both call
  `EgressGuard.assertAllowed("device-connection")` as their **first** statement (runtime
  defence-in-depth over the static lint boundary) — with the axis off, both **throw**
  before any HTTP and the injected transport is never called.
- `ensureAccessToken()` performs the OAuth2 `refresh_token` grant (scope `offline`),
  caches the access token in memory, and persists the rotated tokens via
  `WhoopTokenStore.writeTokens`.
- `fetchPage` GETs the WHOOP **v2** endpoint for the collection (`recovery` →
  `/v2/recovery`, `sleep` → `/v2/activity/sleep`, `cycle` → `/v2/cycle`, `workout` →
  `/v2/activity/workout`), follows the `nextToken` cursor for pagination, retries **once**
  on a `401` (refresh + retry; a second `401` throws — no loop), and on a `429` reads the
  `X-RateLimit-Reset` header (seconds) and awaits an **injected** waiter before retrying.

**Injectable transport / waiter / clock ⇒ offline, sleepless CI.** The constructor takes
a `FetchLike` (defaulting to global `fetch`, allowed **only** in this file), a `waiter`
(429 backoff; defaults to `setTimeout`), and a `nowIso` (token-expiry comparison;
defaults to `new Date().toISOString()` — **no** `Date.now()` in the impl). Tests inject a
fixture `FetchLike`, a recording no-wait waiter, and a fixed `nowIso`, so pagination,
401-refresh-retry-once, and 429-Reset handling are all asserted without sleeping or
touching the real network. Full details:
[`docs/sprints/sprint-spec-20260617-medical-whoop-guardrails-2.md`](sprints/sprint-spec-20260617-medical-whoop-guardrails-2.md).

---

### WHOOP sync adapter + CLI (whoop-guardrails Sprint 3 — final sprint)

`spec-20260617-medical-whoop-guardrails` Sprint 3 (the spec's **final** sprint) turns the
Sprint 2 transport into a working ingestion path and exposes it as a CLI command. It adds
no schema, `ObservationSink`, or `IngestionAdapter` changes, and **no webhooks** — sync is
**on-demand only**.

**`agent-bober medical whoop sync [--since <iso>]`** — pulls WHOOP `recovery` / `sleep` /
`cycle` / `workout` over a window (default the last 7 days; `--since` overrides the start)
and writes the records into the same `.bober/medical/health.db` the offline
`agent-bober medical import` path uses. WHOOP sync is the **on-demand networked** device path;
`agent-bober medical import <file>` remains the **offline** Apple Health SAX file-import path.
The two are complementary — both write `source`-tagged observations into the same store
and both are idempotent on re-run. User-facing usage is in
[`COMMANDS.md`](../COMMANDS.md).

- **Egress-gated before any HTTP.** The command checks the `device-connection` axis
  **before** constructing any `WhoopClient`, so with the axis off (the default) it prints a
  clear `"device-connection egress not enabled"` message, exits `1`, and makes **zero**
  outbound bytes — never building a network client at all.
- **Credentials and authorisation.** With the axis on but `WHOOP_CLIENT_ID` /
  `WHOOP_CLIENT_SECRET` unset, or no stored refresh token in
  `.bober/medical/whoop-token.json`, it prints a clear "set WHOOP_CLIENT_ID/SECRET" or
  "authorise first" message and exits `1`. It **never throws** out of the action; the store
  is always closed in `finally`.
- **`WhoopSyncAdapter` (`src/medical/whoop/whoop-sync.ts`, no network import).** Pages
  `WhoopClient.fetchPage` across the four collections following the `nextCursor`, maps each
  record to `source:"whoop"` `HealthObservation`s via a fixed, reviewable
  `WHOOP_FIELD_MAP` (unmapped fields are **skipped, never guessed**), and writes via the
  **existing** `StoreObservationSink.writeBatch` in bounded per-batch transactions. It
  returns `IngestionResult { recordsParsed, newRows }`. All HTTP stays inside the injected
  `WhoopClient`.
- **Idempotent + fail-closed.** The observation `id` is left unset so `HealthDataStore`
  derives the content-derived SHA-256 dedup key (`INSERT OR IGNORE`) — **not** the WHOOP
  UUID — so a repeat sync over an overlapping window reports `newRows: 0`. There is **no**
  persisted sync cursor (ADR-4); re-run is the resume mechanism. A mid-pagination throw
  **propagates** (no catch-and-continue): committed batches survive, and a clean re-run
  reaches the same end-state. The `ingest` audit entry is **IDs/enums only** (no record
  counts or values). Full details:
  [`docs/sprints/sprint-spec-20260617-medical-whoop-guardrails-3.md`](sprints/sprint-spec-20260617-medical-whoop-guardrails-3.md).

> **Shipping is gated on external regulatory review.** The medical team is
> *engineering*-complete (7 of 7 sprints, 2393 tests, five code-enforced safety
> guarantees). Both egress axes default `false` and consent is fail-closed, so it ships
> nothing to cloud by default. **Enabling it in production remains gated on the external
> S6.5 FFDCA §201(h) counsel + regulatory review** — not a buildable sprint. Red-flag
> detection uses ADR-2 conservative matching with known false-negatives surfaced to that
> review (not patched by widening matching here).

---

## How `loadTeam` Works

`src/teams/registry.ts` exports `loadTeam(config, teamId?)`:

1. If `teamId` is `undefined` or `"programming"` — return the built-in
   programming team.
2. If `teamId` is `"medical"` — return the built-in medical team
   (`buildMedicalTeam(config)`, `pipelineShape "medical-sop"`, Phase 6). Like
   `programming`, this is a code-registered built-in, not a config entry.
3. If `teamId` is a key in `config.teams` — build a `Team` object from the
   config entry, merging partial `providers` over the resolved project defaults.
4. Otherwise — throw `Unknown team '<id>'` (fast-fail at call site).

The two built-in teams (`programming`, `medical`) are the only id-specific
branches. Any team you declare in `config.teams` flows through the config path
the same way the example team does — that is the "adding a *config* team is
data, not code" invariant. A built-in like `medical` carries code (its own
engine + guardrails) because it ships a new pipeline shape, not just a
data overlay.

---

## Adding a New Team (Step by Step)

1. Add an entry to `bober.config.json` under `"teams"`:

   ```jsonc
   "teams": {
     "my-team": {
       "displayName": "My new team",
       "memoryNamespace": "my-team",
       "pipelineShape": "ts",
       "providers": { "chat": "openai" }
     }
   }
   ```

2. Optionally set it as the default:

   ```jsonc
   "defaultTeam": "my-team"
   ```

3. Use it:

   ```bash
   npx agent-bober run "build feature" --team my-team
   npx agent-bober chat my-team
   ```

4. Lessons will accumulate in `.bober/memory/my-team/` — fully isolated from
   the programming team's lessons.

No code changes required. No deployment step. The team is available
immediately after editing `bober.config.json`.
