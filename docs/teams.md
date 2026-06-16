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
> path that fills that store exists too — `bober medical import <file>`
> stream-parses an Apple Health export into `HealthDataStore` (see "Ingestion"
> below and [`COMMANDS.md`](../COMMANDS.md)). As of Phase 6 Sprint 6 the **full
> ordered SOP is wired end-to-end** under a **code-enforced zero-egress default**:
> consent → red-flag → numerics → medications (from `FactStore`) → an `EgressGuard`
> literature gate → retrieval (`{disabled}` ⇒ abstain when off) → disclaimer footer →
> audit. Both egress axes default **false**, so a fresh-config medical turn produces
> **zero outbound bytes** (see "EgressGuard + full SOP wiring" below). Only the real
> MedlinePlus networking + cited synthesis (S7) remains. See
> [`docs/sprints/sprint-spec-20260616-medical-team-3.md`](sprints/sprint-spec-20260616-medical-team-3.md),
> [`docs/sprints/sprint-spec-20260616-medical-team-4.md`](sprints/sprint-spec-20260616-medical-team-4.md),
> [`docs/sprints/sprint-spec-20260616-medical-team-5.md`](sprints/sprint-spec-20260616-medical-team-5.md),
> and
> [`docs/sprints/sprint-spec-20260616-medical-team-6.md`](sprints/sprint-spec-20260616-medical-team-6.md).

---

## CLI Usage

### `bober run --team <id>`

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

### `bober chat [team]`

Select a team for an interactive chat session:

```bash
npx agent-bober chat example   # chat session routed to the example team
npx agent-bober chat           # programming team (default)
```

The session's `buildMemoryDistill` reads from the team's namespace so the LLM
sees only that team's lessons as context. Spawned `bober run` children inherit
the session's run-id but not yet the team id (see Deferred Features below).

---

## Built-in Programming Team

The programming team is always available and requires no config entry. It is
the fallback when:

- `--team` is omitted from `bober run`
- `[team]` positional arg is omitted from `bober chat`
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

`bober chat <team>` routes the chat session's `buildMemoryDistill` to the
team's namespace. Spawned `bober run` children (triggered by chat) do not yet
carry `--team <id>` in their argv — they run on the programming team by
default. A future sprint will thread `teamId` through `RunSpawnerOptions` so
spawned children inherit the active chat team.

### Guardrails (Phase 6 — Gate 2 Live)

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
  escalation (self-harm/overdose) on any match, otherwise `{ kind: "allow" }`.

The `refuse` branch (non-emergency code-enforced refusals) is a documented
placeholder deferred to Sprint 6. Detection is deliberately conservative per
ADR-2: novel/indirect phrasing may return `none` and fall through to the normal
(still-guardrailed) path — known advisory false-negative gaps are surfaced to a
future patternset revision / external counsel review. Every other team's
`guardrails` slot remains `undefined`, and only `MedicalSopEngine.run` reads and
enforces it (see Gate 2 below).

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
  "Guardrails (Phase 6 — Gate 2 Live)" above. The injectable
  `MedicalSopDeps.llmClient` / `MedicalSopDeps.numerics` spy slots make the
  "never called on short-circuit" guarantee enforceable by tests.
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

User-facing usage is in [`COMMANDS.md`](../COMMANDS.md) under `bober medical
import`. Full details:
[`docs/sprints/sprint-spec-20260616-medical-team-5.md`](sprints/sprint-spec-20260616-medical-team-5.md).

### EgressGuard + full SOP wiring (Phase 6 Sprint 6)

Sprint 6 is the integration linchpin: it wires the **full ordered SOP** inside
`MedicalSopEngine.run` under a **code-enforced zero-egress default**. With a fresh
config, a medical turn produces **zero outbound bytes**.

**`EgressGuard` (`src/medical/egress.ts`) — two independent opt-in axes.** Both
default **false**:

- `EgressAxis` = `"cloud-inference" | "literature-retrieval"`.
- `isAllowed(axis)` returns `true` **only** when that axis was explicitly opted in;
  the two axes are read **independently** (enabling one does not enable the other).
- `assertAllowed(axis)` **throws** `Error("Egress axis '<axis>' not enabled")` when
  off, returns `void` when on — the hard barrier S7's network call will sit behind.
- `EgressGuard.fromConfig(config)` reads `config.medical.egress`, defaulting each axis
  to `false` when the section/field is absent.

**Config keys (both default false).** A new optional top-level `medical` section
(`MedicalSectionSchema`, `src/config/schema.ts`):

```jsonc
{
  "medical": {
    "egress": {
      "cloudInference": false,        // permit cloud inference synthesis (default false)
      "literatureRetrieval": false    // permit MedlinePlus literature retrieval (default false)
    }
  }
}
```

Omitting the `medical` section leaves both axes off. (Also surfaced in the README
"Full Configuration Reference".)

**Scoped ESLint network boundary + single exception.** `eslint.config.js` gained a
flat-config block over `files: ["src/medical/**/*.ts"]` that makes egress a **lint
error**: `no-restricted-imports` forbids `undici` / `got` / `axios` / `node-fetch` and
the patterns `http` / `https` / `net` / `tls` / `dgram` (and their `node:` forms), and
`no-restricted-globals` forbids the `fetch` global. A **single** follow-up override on
`files: ["src/medical/retrieval/medline-source.ts"]` turns both rules **off**
(flat-config last-match-wins) — that one file is the sanctioned home for Sprint 7's
real MedlinePlus call. It holds **no** network import today; a forbidden import added to
any other medical file would fail `npm run lint`. This is defence in depth alongside the
runtime `EgressGuard`.

**`LiteratureRetriever` (`src/medical/retrieval/literature.ts`).** `retrieve(query)`
checks `egress.isAllowed("literature-retrieval")` **before** touching the source: when
off it returns `{ kind: "disabled" }` **synchronously** (no `MedlineSource` method
called, no network attempt — the zero-egress proof); when on it delegates to
`MedlineSource.fetchPassages`. `MedlineSource` (`retrieval/medline-source.ts`) is a stub
returning `{ kind: "abstain", reason }` this sprint; its `RetrievalOutcome` union is
`{disabled} | {abstain,reason} | {grounded,passages}` (the `grounded` arm is S7 only).

**Medications come from `FactStore`, not `HealthDataStore` (ADR-7).** The engine reads
active medications via
`FactStore.getActiveFacts("medical", "patient", "takes-medication")` — the bi-temporal
value-of-record. The `HealthDataStore` schema is untouched; it never stores medication
state.

**The full ordered SOP — the ordering *is* the safety guarantee.**
`MedicalSopEngine.run` runs, in fixed order:

1. **Gate 1 — consent** (fail-closed; refuse + zero downstream on no consent).
2. **Gate 2 — red-flag short-circuit** (0-LLM canned 911/988 escalation on match).
3. **Numerics** — deterministic `NumericsQueryLayer.getMetric`, **no LLM**.
4. **Medications** — `FactStore.getActiveFacts(...)` (ADR-7).
5. **Gate 3 + retrieval** — `EgressGuard.isAllowed("literature-retrieval")`;
   `LiteratureRetriever.retrieve` ⇒ `{disabled}` (abstain) when off.
6. **Disclaimer footer**, then **audit** (`answer` / `abstain`, PHI-free), then
   return `PipelineResult & { medicalAnswer }`.

Both gates run **before** any numerics, medications, egress, retrieval, or LLM work, so
a refuse/short-circuit reaches **zero** downstream calls. With both axes off, a numeric
question answers from deterministic compute (a spy `LLMClient` is never called) and a
literature question abstains (`MedlineSource.fetchPassages` is never called) — verified
by a network spy recording **zero** calls. `MedicalSopDeps` gained `egress?` /
`literature?` / `facts?` / `healthStore?` injection slots (the zero-arg constructor is
preserved). Full details:
[`docs/sprints/sprint-spec-20260616-medical-team-6.md`](sprints/sprint-spec-20260616-medical-team-6.md).

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
