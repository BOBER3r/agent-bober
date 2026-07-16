# Workflow runner + `bober seo` CLI + report store + hub emitter

**Contract:** sprint-spec-20260715-ultimate-seo-suite-11  ·  **Spec:** spec-20260715-ultimate-seo-suite  ·  **Completed:** 2026-07-16

## What this sprint added

The **wiring sprint** — the one that turns the ten prior sprints' parts into a single runnable pipeline. Four artefacts land: (1) `SeoWorkflowRunner` (`src/seo/runner.ts`) — the end-to-end orchestrator that resolves playbook context → selects a data source → gathers data → analyzes → runs the citation gate → persists a report → best-effort emits cited findings to the hub → returns an exit code, and **never throws**; (2) the `bober seo <workflow> [target]` CLI (`src/seo/command.ts`) that stamps `now` once, dispatches on the 8 `SeoWorkflow`s, and sets `process.exitCode` (`0` pass / `2` blocked-or-fail-closed); (3) `SeoReportStore` (`src/seo/report-store.ts`) — atomic temp-file+rename persistence of a `SeoReport` under `.bober/seo/reports/`, with a pure write-once id and null-on-missing reads; and (4) `SeoHubEmitter` (`src/seo/hub-emitter.ts`) — the **first** consumer of the import-only hub `Finding` from `src/seo/`, mapping cited `SeoFinding`s onto `Finding` (`domain: "seo"`) via a best-effort sink that never throws. With this sprint the suite is **end-to-end runnable** for the first time: an offline run (both egress axes off) reads local exports, analyzes, persists a report, and exits `0` with zero network. The only two later-sprint gaps are the adversarial verifier (Sprint 12, a documented code seam) and the benchmark harness (Sprint 13).

## Public surface

- `bober seo <workflow> [target]` (`src/seo/command.ts:47`) — the user-facing CLI. `<workflow>` is one of the 8 `SeoWorkflow`s (unknown ⇒ stderr + `exitCode 2`); `[target]` defaults to `config.seo.defaultTarget`, then `"unspecified-target"`. Offline by default; opt-in live via the two egress axes. Registered in `src/cli/index.ts:364` beside `registerSecurityAuditCommand`.
- `registerSeoCommand(program, overrides?)` (`command.ts:47`) — Commander registrar. `overrides.runWorkflow` is a test seam to bypass the real runner (no LLM/network/fs).
- `SeoWorkflowRunner` (`src/seo/runner.ts:245`) — the pipeline. `run(input: SeoRunInput): Promise<SeoRunOutcome>`; **never throws** — every failure resolves to `{ exitCode: 2 }`.
- `SeoRunInput` (`runner.ts:60`) — `{ projectRoot, config, workflow, target?, now, dataSource?, findingSink?, analyzer? }`. `now` is stamped once by the CLI; `dataSource`/`findingSink`/`analyzer` are test-injection seams (defaults: `selectSource(...)`, a real `FactStore`-bound `ingestFinding`, a real `SeoAnalyzer` via `createClient`).
- `SeoRunOutcome` (`runner.ts:81`) — `{ report?: SeoReport; exitCode: 0 | 2 }`. `report` is absent on a fail-closed (`parsed: false`, or a thrown step); present on a clean or a `blocked` run.
- `selectSource(config, projectRoot)` (`runner.ts:147`) — resolves the two egress axes to a `SeoDataSource`: both off ⇒ `LocalExportSource` (zero egress, no governor/ledger/credentials constructed); `search-console` only ⇒ `GscAdapter`; `serp-provider` only ⇒ `DataForSeoAdapter`; both ⇒ `CompositeSeoSource` (GSC serves search-analytics/url-inspection, DataForSEO serves serp/keywords/backlinks). The governor+ledger are loaded **only** on an opted-in branch.
- `SeoReportStore` (`src/seo/report-store.ts:57`) — `save(projectRoot, report)` (atomic temp+`rename` under `.bober/seo/reports/`), `read(projectRoot, id)` (⇒ `null` on a missing file, never throws), `list(projectRoot)` (⇒ `[]` on a missing dir).
- `deriveReportId(now, workflow, target)` (`report-store.ts:49`) — PURE write-once id `seo-<workflow>-<now-slug>-<sha256(target).slice(0,8)>`; never reads the clock. Report file: `.bober/seo/reports/<fs-safe-id>-seo-report.json`.
- `SeoHubEmitter` (`src/seo/hub-emitter.ts:41`) — `mapToFindings(analysis, now): Finding[]` (PURE, clock-injected) and `emit(analysis, sink, log, now)` (best-effort, never throws — swallows+warns on a sink failure).
- `SeoFindingSink` (`hub-emitter.ts:25`) — `(finding: Finding) => Promise<void>`; the runner binds the default to `ingestFinding` against a lazily-opened `FactStore`.
- Barrel `src/seo/index.ts` — additive re-exports of the runner/command/report-store/hub-emitter symbols.

## The 8 SEO workflows (`bober seo <workflow>`)

`technical-audit` · `rank-track` · `content-decay` · `topical-map` · `ai-visibility` · `parasite-watch` · `internal-linking` · `schema-audit` (the `SeoWorkflow` union, `types.ts:17`; the CLI's `SEO_WORKFLOWS` allow-list, `command.ts:27`). Each dispatches the same pipeline; the workflow selects which `bober.seo-*` playbook library the retriever ranks into the analyzer prompt.

## The end-to-end data flow

`SeoWorkflowRunner.run` (mirrors `runStandaloneSecurityAudit`) is a single top-level `try`/`catch` around these steps, in order:

1. **Target** — `input.target ?? config.seo?.defaultTarget ?? "unspecified-target"`.
2. **Context** — `new SeoPlaybookRetriever(new SeoPlaybookIndex()).retrieve({ workflow, target })` (Sprints 2-5) — a never-empty `promptFragment` + ranked `signatures`.
3. **Source** — `input.dataSource ?? await selectSource(config, projectRoot)` (Sprint 6/8/9).
4. **Gather** — `gatherDataBundle(source, target, now)` fans out all five capability calls in parallel (each degrades to `disabled`/`abstain` when irrelevant).
5. **Analyze** — `(input.analyzer ?? buildDefaultAnalyzer()).analyze({...})` (Sprint 10) — LLM-grounded `SeoAnalysis`.
6. **Fail-closed on `parsed: false`** — an unparseable model result short-circuits to `{ exitCode: 2 }` **before** the gate: no report persisted, zero hub emits (sc-11-5).
7. **Citation gate** — `new SeoCitationGate().apply(analysis.findings, threshold)` (Sprint 10), `threshold = config.seo?.blockThreshold ?? "critical-uncited"` → `{ cited, dropped, blocked }`.
8. **[verifier seam — Sprint 12]** — a documented comment (`runner.ts:282`) marks where the adversarial downgrade-only verifier will slot, between the gate and persistence. Not implemented this sprint.
9. **Persist** — build the `SeoReport` (`reportId`, `verdict = blocked ? "blocked" : "pass"`, `droppedUncited = gate.dropped.length`, `findings = gate.cited`) and `SeoReportStore.save` it atomically.
10. **Hub emit** — `emitFindingsToHub(citedAnalysis, ...)` best-effort emits **only `gate.cited`** findings, strictly **after** persistence; a hub failure never changes the exit code.
11. **Exit code** — `gate.blocked ? 2 : 0`.

The `SeoHubEmitter` maps each cited `SeoFinding` to a hub `Finding`: `domain: "seo"`, `kind = humanApprovalRequired ? "action" : "risk"` (`"watch"`/`"question"` reserved for a later refinement), `urgency`/`severity = finding.severity` (1..5), a stable `id = sha256("seo|title|kind").slice(0,16)`, `evidence` carrying the recommendation + formatted metrics + a `cite:<url>` line, `tags` (`seo`, `workflow:*`, `playbook:*`, `confidence:*`), `surfacedAt: now`, `status: "open"`. Emitted objects validate against the imported `FindingSchema` (evaluator-verified).

## The uncited-never-reaches-hub invariant (two independent layers)

A finding without a primary-source citation **cannot** reach the priority hub, enforced twice:

1. **The citation gate** (`SeoCitationGate.apply`) partitions on `citationUrl` well-formedness; only `gate.cited` is ever handed to the emitter (`runner.ts:303-304`). Uncited findings live in `gate.dropped` and are counted into `report.droppedUncited`, never emitted.
2. **`SeoHubEmitter.mapToFindings`** independently skips any finding whose `citationUrl` is missing/empty (`hub-emitter.ts:61`) — a belt-and-suspenders guard that holds even if a caller ever passed unfiltered findings.

Additionally, a `parsed: false` analysis fail-closes to `exitCode 2` with **zero** persistence and **zero** emits, so an unparseable model response can never surface an unsupported claim.

## The offline zero-network guarantee

With **both** egress axes off (the default — a config that omits `seo` entirely), `selectSource` returns `LocalExportSource` and constructs **no** `SeoQuotaGovernor`, **no** ledger, and touches **no** credentials. `LocalExportSource` reads per-capability exports from `.bober/seo/imports/` (`<capability>.csv`|`.json`, Sprint 6) at zero egress. The runner tests prove this two ways: a `fetch` spy records zero calls, and a `createClient`-throws mock is never invoked (tests inject a scripted analyzer so a real provider is never even attempted). An offline run persists a report and exits `0` with no network.

## How to run it

```bash
# Offline (default) — reads local exports under .bober/seo/imports/, zero network:
bober seo technical-audit https://example.com
bober seo rank-track                 # target falls back to config.seo.defaultTarget

# Exit codes: 0 = pass, 2 = blocked (citation gate) OR fail-closed (parse/step error).
# (1 is reserved by Commander.) On success it prints the report id, verdict,
# finding count, and droppedUncited to stdout; the full report JSON is written to
# .bober/seo/reports/<id>-seo-report.json.
```

**Offline inputs.** Drop one file per capability under `.bober/seo/imports/` — `search-analytics`, `url-inspection`, `serp`, `keywords`, `backlinks` (`.csv` or `.json`). A missing file for a capability degrades to `disabled` (never an error).

**Opt-in live data.** Each axis is independent and defaults `false`. Enable in `.bober/config.*` under the `seo` section:

```jsonc
{
  "seo": {
    "egress": {
      "search-console": true,   // ⇒ GscAdapter (needs GSC_OAUTH_TOKEN)
      "serp-provider":  true     // ⇒ DataForSeoAdapter (needs DATAFORSEO_LOGIN/PASSWORD)
    },
    "budget":        { "maxUsd": 5 },      // per-run USD ceiling for PAYG DataForSEO (null/absent = uncapped)
    "defaultTarget": "https://example.com",
    "blockThreshold": "critical-uncited"    // never | any-uncited | critical-uncited (default)
  }
}
```

Enabling `search-console` alone routes through `GscAdapter`; `serp-provider` alone through `DataForSeoAdapter`; both through `CompositeSeoSource`. Credentials are read from env by the adapters (Sprints 8-9), never from config. Live calls are gated by the `SeoQuotaGovernor` (Sprint 7) and booked against the ledger; a 402/429/5xx abstains (never throws), so a quota/budget/HTTP failure degrades gracefully rather than crashing the run.

## How it fits

This sprint is the top of the `src/seo/` stack, consuming every prior layer: the knowledge corpus (Sprints 2-5, via the retriever), the data plane (Sprints 6/8/9, via `selectSource`), the quota/cost gate (Sprint 7, loaded only when live), and the analysis stage (Sprint 10, the analyzer + citation gate). It mirrors the security-audit pipeline throughout — `runStandaloneSecurityAudit` (runner), `registerSecurityAuditCommand` (CLI), `saveSecurityAudit`/`readSecurityAudit` (store), and `security-hub.ts` (emitter) — so a maintainer familiar with `bober security-audit` will recognize every seam. It is the **user-facing CLI reference** the Sprint-14 docs refresh will build on.

## Notes for maintainers

- **`now` is stamped exactly once, at the CLI `.action()` boundary** (`command.ts:67`) and threaded everywhere downstream. The runner never constructs a wall-clock `Date`; the `.tmp` suffix inside `SeoReportStore.save` is a uniqueness token, not a report timestamp. Keep it that way — clock purity is a load-bearing property inherited from Sprint 10.
- **The runner never throws — that is the contract.** Every step is inside one top-level `try`/`catch` → `exitCode: 2`. Do not add a throw path that escapes `run`; the CLI's own `try`/`catch` is a second belt, but the runner's no-throw is the tested guarantee (sc-11-1).
- **Exit codes are `0`/`2` only** — `1` is Commander-reserved. `2` covers both a `blocked` citation gate and any fail-closed error; they are intentionally the same signal for CI.
- **The verifier is a comment, not code** (`runner.ts:282`). Sprint 12 slots the adversarial downgrade-only verifier between the citation gate and persistence, consuming `gate.cited`. Do not treat the empty seam as a bug.
- **`DEFAULT_SEO_MODEL = "sonnet"`** (`runner.ts:92`) is the sole model the runner defaults the analyzer client to — `config.seo` has no `model` field. Add one if per-project model choice is ever needed.
- **Hub emission is lazy and empty-safe** — the default sink only opens a `FactStore` when there is ≥1 Finding to emit (`runner.ts:224`), so a clean/all-uncited run never touches the hub filesystem.

## Follow-ups

- **`gatherDataBundle` fetches all five capabilities regardless of workflow** (`runner.ts:176`, flagged by a `bober:` comment). Every `SeoDataSource` method degrades safely (`disabled`/`abstain`) when irrelevant, so this is always correct — just not capability-minimal. A `workflow → capability-subset` map is the candidate optimization if live-adapter **QPM / USD** usage ever needs trimming per workflow. Non-blocking; deferred to a later hardening sprint.
- **Trivial test-title nit** — `src/seo/runner.test.ts:303` has a misleading title referencing `exitCode 2` while the body correctly asserts `0`. Cosmetic only (the assertion is right); fix opportunistically in the Sprint-14 docs/cleanup pass. (Flagged by the evaluator as a trivial follow-up — not a defect.)

## Scope

One commit — `dcadde2` — creating `src/seo/runner.ts` (312 lines), `src/seo/command.ts` (89), `src/seo/report-store.ts` (104), `src/seo/hub-emitter.ts` (112), and four test files (`runner.test.ts` 326, `report-store.test.ts` 139, `hub-emitter.test.ts` 167, `command.test.ts` 148), plus additive edits to `src/cli/index.ts` (+4, register the command) and `src/seo/index.ts` (+11, barrel re-exports). No adapters/governor/egress/analyzer/citation-gate/retriever/skills touched; the hub `Finding` is imported, never redefined; no new dependencies. All 6 required criteria (sc-11-1..11-6) passed on **iteration 1**; full suite **4471 passed | 1 skipped | 0 failed** (`src/seo` 181).
