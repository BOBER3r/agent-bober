# LLM-grounded analyzer + strategist agent + deterministic citation gate

**Contract:** sprint-spec-20260715-ultimate-seo-suite-10  ·  **Spec:** spec-20260715-ultimate-seo-suite  ·  **Completed:** 2026-07-16

## What this sprint added

The **analysis layer** of the SEO suite — the first sprint that turns the gathered data + retrieved playbook context into `SeoFinding[]`, plus the deterministic evidence gate that decides which of those findings may ship. Three artefacts land: (1) `SeoAnalyzer` (`src/seo/analyzer.ts`) — LLM-grounded synthesis via a **constructor-injected, provider-agnostic `LLMClient`** (no SDK import; the Sprint 11 runner builds the real client, tests inject a scripted fake); (2) `SeoCitationGate` (`src/seo/citation-gate.ts`) — a **pure, offline, total** gate that partitions findings into `cited`/`dropped`/`blocked` by `citationUrl` well-formedness; and (3) the `bober-seo-strategist` agent (`agents/bober-seo-strategist.md`) — a read-only, human/agent-facing counterpart to `SeoAnalyzer` that mirrors `bober-security-auditor`'s structure and discipline. The load-bearing property is **evidence discipline enforced two ways**: the analyzer is **fail-closed** (unparseable model output ⇒ `{ findings: [], parsed: false }`, never a throw) and the citation gate structurally guarantees an uncited/malformed-URL finding **cannot reach `cited`**. The barrel `src/seo/index.ts` additively re-exports both classes and their types. No runner, CLI, hub, or verifier wiring (sprints 11-12); no `hub/finding.ts` import; no new dependencies.

## Public surface

- `SeoAnalyzer` (`src/seo/analyzer.ts:269`) — LLM-grounded finding synthesizer. Constructor: `new SeoAnalyzer(llm, model)` where `llm: LLMClient` (`src/providers/types.ts`, provider-agnostic — mirrors `SeoPlaybookRetriever(index)` / `getGroundingVerdict`) and `model: string`.
- `SeoAnalyzer.analyze(input)` (`analyzer.ts:280`) — `async`; returns `Promise<SeoAnalysis>`. Builds the prompt from `input.context.promptFragment` + the serialized `DataOutcome` bundle + an explicit output contract, calls `llm.chat({ ..., jsonObjectMode: true })`, defensively parses, and stamps `input.workflow` onto each finding. **Never throws on a parse failure** (returns `parsed: false`); a transport error from `llm.chat` deliberately propagates.
- `SeoAnalyzeInput` (`analyzer.ts:53`) — `{ workflow, target, context: SeoRetrieveResult, data: SeoDataBundle, config: BoberConfig, now: string }`. `now` is an **injected** ISO-8601 wall-clock snapshot; `config` is accepted for interface parity but not consumed this sprint (`llm`/`model` are constructor-injected).
- `SeoAnalysis` (`analyzer.ts:70`) — `{ workflow, target, findings: SeoFinding[], parsed: boolean, dataProvenance: DataProvenance[] }`. `parsed: false` ⇒ empty `findings` (fail-closed).
- `SeoDataBundle` (`analyzer.ts:45`) — per-capability optional `DataOutcome<Row[]>` (searchAnalytics / urlInspection / serp / keywords / backlinks); a source may abstain or be disabled per capability.
- `SeoCitationGate` (`src/seo/citation-gate.ts:66`) — pure/offline citation gate. No LLM, egress, filesystem, or clock; imports only `./types.js`.
- `SeoCitationGate.apply(findings, threshold)` (`citation-gate.ts:72`) — partitions into `{ cited, dropped, blocked }`. `cited` = well-formed absolute `http(s)` `citationUrl` (validated via `new URL()`); `dropped` = empty/malformed URL; `blocked` derived from `threshold`.
- `SeoCitationGate.filter` (`citation-gate.ts:88`) — alias of `apply` (satisfies sc-10-3's literal `.filter(...)` wording).
- `SeoBlockThreshold` (`citation-gate.ts:18`) — `"never" | "any-uncited" | "critical-uncited"` (mirrors `SeoConfigSchema.blockThreshold`, `config/schema.ts:697`).
- `CitationGateResult` (`citation-gate.ts:20`) — `{ cited: SeoFinding[]; dropped: SeoFinding[]; blocked: boolean }`.
- `bober-seo-strategist` agent (`agents/bober-seo-strategist.md`) — read-only (`Read`/`Grep`/`Glob` only, no Write/Edit/Bash) strategist that emits the same structured-finding JSON shape and is fail-closed on unparseable output.
- Barrel `src/seo/index.ts` (`:50-54`) — additively re-exports `SeoAnalyzer` + `{ SeoAnalyzeInput, SeoAnalysis, SeoDataBundle }` and `SeoCitationGate` + `{ SeoBlockThreshold, CitationGateResult }`.

## The analyzer's fail-closed contract (the no-throw, clock-pure guarantee)

`SeoAnalyzer.analyze` distinguishes two failure modes, deliberately:

1. **A PARSE failure is fail-closed, never a throw.** The model response is run through a **3-tier defensive extraction** (`parseFindingsContainer`, `analyzer.ts:187`) — direct `JSON.parse`, then a fenced ```` ```json ```` block, then the first-`{`-to-last-`}` span — followed by a zod `safeParse` against `SeoFindingsContainerSchema`. Any failure (unparseable text, wrong shape, an out-of-range `severity` like `7` — the schema pins `severity` to a strict `1..5` literal union) returns `{ workflow, target, findings: [], parsed: false, dataProvenance }`. An empty-but-valid result (`{"findings": []}`) is `parsed: true` — a clean "nothing actionable", never confused with a fail-closed block.
2. **A TRANSPORT error from `llm.chat` propagates.** A rejected provider promise is a different failure mode and is left uncaught (mirrors `grounding-critic.test.ts`), so a network/provider outage is visibly distinct from "the model produced nothing parseable".

**Clock purity (a hard Sprint-10 nonGoal).** The analyzer never constructs a `Date` and never reads the wall clock — freshness reasoning uses the **injected `now`** only (grep for `new Date(`/`Date.now(` in the file is empty, evaluator-verified). This keeps `analyze` deterministic under a fixed `now`.

**Defense-in-depth on `humanApprovalRequired`.** `toSeoFinding` (`analyzer.ts:238`) OR's the model's `humanApprovalRequired` with a lookup: a finding grounded in a `playbookRef` whose matching `SeoSignature.policyClass === "human-approve"` is **always** flagged for approval, even if the model forgot to set the flag. The analyzer also stamps the caller-known `input.workflow` onto every finding rather than trusting the model to echo it back.

## The citation gate's evidence discipline (the load-bearing no-uncited-claim gate)

`SeoCitationGate` is the deterministic enforcement point for the suite's IRON LAW — **no SEO recommendation ships without a primary-source citation**:

- **Well-formedness is a real `new URL()` check.** `isWellFormedCitationUrl` (`citation-gate.ts:34`) rejects a non-string, an empty/whitespace string, and any URL whose parsed `protocol` is not `http:`/`https:` (a `try`/`catch` around `new URL()` — a parse failure is `false`, never a throw). This is a local, single-purpose check (no URL utility exists elsewhere in `src`).
- **A dropped finding structurally cannot reach `cited`.** `apply` has a **single if/else write site** per finding — a well-formed URL pushes to `cited`, everything else to `dropped`. There is no path by which an uncited or malformed-URL finding lands in `cited` (evaluator-checked).
- **`blocked` honors each threshold** (`isBlocked`, `citation-gate.ts:51`): `never` ⇒ always `false`; `any-uncited` ⇒ `dropped.length > 0`; `critical-uncited` ⇒ any dropped finding with `severity >= CRITICAL_SEVERITY_FLOOR` (4, of the 1..5 scale — a documented reading, `citation-gate.ts:49`). `blocked` is the fail-closed exit-2 signal a later sprint will act on.
- **Pure and total.** No mutation of the input array, no ordering surprise; identical input always yields identical output (determinism + no-mutation both unit-tested).

## How it fits

`SeoAnalyzer` and `SeoCitationGate` are the two halves of the analysis stage: the analyzer consumes the **complete data plane** (Sprints 6-9: `LocalExportSource` + `GscAdapter` + `DataForSeoAdapter`) and the **knowledge corpus** (Sprints 2-5, via `SeoRetrieveResult.promptFragment` + `.signatures`), synthesizes `SeoFinding[]`, and the citation gate then drops every uncited finding **before** it can reach a human or the hub. The `bober-seo-strategist` agent is the same discipline expressed as an agent prompt — it emits the structured finding JSON but explicitly does **not** decide pass/blocked; the deterministic gate does, by validating the agent's `citationUrl` values. Intended wiring (Sprint 11 runner):

```ts
import { SeoAnalyzer, SeoCitationGate } from "./seo/index.js";

const analyzer = new SeoAnalyzer(llm, model);            // llm/model built by the Sprint-11 runner via createClient
const analysis = await analyzer.analyze({ workflow, target, context, data, config, now });
// analysis.parsed === false  ⇒ fail-closed: findings is [] (unparseable model output), no throw

const gate = new SeoCitationGate();
const { cited, dropped, blocked } = gate.apply(analysis.findings, config.seo?.blockThreshold ?? "critical-uncited");
// only `cited` may ship downstream; `blocked` is the fail-closed exit-2 signal for a later sprint
```

## Notes for maintainers

- **The two failure modes are load-bearing and evaluator-checked — keep them distinct.** A parse failure MUST stay fail-closed (`parsed: false`, no throw); a `llm.chat` transport rejection MUST keep propagating. Do not wrap the `llm.chat` call in a catch that swallows transport errors into `parsed: false` — that would hide provider outages behind a "nothing actionable" result.
- **Do not let the analyzer read the clock.** Freshness uses the injected `now` only; introducing `new Date()`/`Date.now()` re-breaks the Sprint-10 nonGoal and the clock-purity grep test. Thread `now` through instead.
- **The gate's single if/else write site is the safety invariant.** Any refactor of `apply` must preserve the property that a finding reaches `cited` **only** through the `isWellFormedCitationUrl` true branch — do not add a second path that pushes to `cited`.
- **`CRITICAL_SEVERITY_FLOOR` (4) is a documented reading, not a contract-pinned constant.** The `critical-uncited` cutoff was not pinned by sc-10-3; bump the constant (`citation-gate.ts:49`) if the "critical" definition changes.
- **`config` on `SeoAnalyzeInput` is intentionally unconsumed this sprint.** It is accepted for interface parity with the architecture's `SeoAnalyzeInput` and the Sprint-11 runner contract; `llm`/`model` are constructor-injected. Do not treat its absence of use as dead code to remove.
- **`context` is a `SeoRetrieveResult`, not a `SeoPlaybookContext`.** The architecture prose names the parameter `SeoPlaybookContext`, but no such type exists — the concrete `SeoRetrieveResult` (`retriever.ts:22-25`) is the one that carries `promptFragment` + `signatures`.
- **All LLM calls in tests go through a `ScriptedClient`.** No real provider or network is touched (14 analyzer tests + 14 gate tests). The strategist agent has no Write/Edit/Bash tools by design and cannot persist a report — the citation gate is the only thing that decides which findings survive.
- **Not wired into the runner/CLI/hub/verifier yet.** Sprint 11 wires the runner (builds the real `LLMClient`), Sprint 12 adds the verifier. No `hub/finding.ts` import; adapters/governor/egress/data-source/parser/retriever/skills untouched; no new dependencies.

## Scope

One commit — `15bc826` — creating `src/seo/analyzer.ts` (302 lines: `SeoAnalyzer` + the model-facing zod schema + the 3-tier defensive parser + prompt construction + assembly), `src/seo/citation-gate.ts` (90 lines: `SeoCitationGate` + the `new URL()` well-formedness check + per-threshold blocking), `agents/bober-seo-strategist.md` (144 lines, modeled on `agents/bober-security-auditor.md`), `src/seo/analyzer.test.ts` (288 lines, 14 tests: scripted canned findings → typed, defense-in-depth approval, unparseable/out-of-range/empty → `parsed: false` no throw, 3-tier extraction, transport-error propagation, clock purity), `src/seo/citation-gate.test.ts` (102 lines, 14 tests: cited/dropped partition, 3 threshold behaviors, determinism, no-mutation, `filter`/`apply` alias), plus an additive barrel edit to `src/seo/index.ts` (+6 lines). No runner/CLI/report-store/hub/verifier; no `hub/finding.ts` import; adapters/governor/egress/data-source/parser/retriever/skills untouched; no new dependencies. All 5 required criteria (sc-10-1..10-5) passed on **iteration 1**; full suite **4430 passed | 1 skipped | 0 failed** (`src/seo` 140).
