# SEO benchmark corpus (`manifest.json`)

A small, **labelled** corpus of known-good/known-bad SEO analyzer scenarios
used by `../harness.ts` (`runBenchmark()`) and `../harness.test.ts` to make
finding quality **measured, not asserted**
(`spec-20260715-ultimate-seo-suite`, sprint 13). Mirrors
`src/orchestrator/security-knowledge/benchmark/fixtures/manifest.json`.

## Why inline JSON, not `.ts`/`.js` fixture files

`npm run build` (`tsc`) compiles everything under `src/**/*` and `npm run
lint` (`eslint src/**/*.ts`) lints it. Two of these fixtures are
*intentionally* adversarial: the recorded `analyzerResponse` for
`kb-never-encode-uncited` contains the exact "mass-generate thin pages" /
"purchase links" phrasing the citation gate and the never-encode guard exist
to catch, and `kb-parse-failure`'s `analyzerResponse` is deliberately
unparseable garbage. If those strings existed as real `.ts` source (rather
than a JSON string field), they would either fail lint/typecheck or — worse —
read as real code recommending the tactic. As inline strings in a JSON
`corpus/manifest.json`, they are **data**, never compiled, linted, or
executed as instructions.

## Label schema

Each entry in the top-level array is a `SeoBenchmarkCase`
(`../harness.ts`):

```ts
interface SeoBenchmarkCase {
  id: string;                    // stable, unique within the corpus
  label: "known-good" | "known-bad";
  workflow: SeoWorkflow;
  target: string;
  imports: Array<{ file: string; content: string }>; // written to a temp <projectRoot>/<id>/imports/ dir
  analyzerResponse: string;      // the exact raw text the ScriptedClient returns
  expected: {
    findings: Array<{ playbookRef: string; cited: boolean }>; // names the workflow's expected finding(s) + citation presence
    droppedUncited: number;
    verdict: "pass" | "blocked";
  };
}
```

Every expected finding names its `playbookRef` (which, combined with the
case's `workflow`, identifies the workflow it belongs to) and whether it is
expected to survive the citation gate (`cited: true`) or be dropped
(`cited: false`).

## Case coverage (3 known-good / 3 known-bad)

| Case id | Label | What it proves |
|---|---|---|
| `kg-technical-audit-cited` | known-good | A single well-cited finding survives the gate and reaches the sink; `verdict: pass`. |
| `kg-mixed-cited-and-uncited` | known-good | One cited + one non-critical uncited finding — only the cited one reaches the sink (`droppedUncited: 1`), non-critical severity keeps `verdict: pass`. |
| `kg-rank-track-auto-safe` | known-good | A second workflow (`rank-track`) behaves the same way — the harness is workflow-agnostic. |
| `kb-uncited-drop` | known-bad | A single critical-severity (5) uncited finding is dropped entirely — zero sink calls, `verdict: blocked`, `exitCode: 2`. |
| `kb-never-encode-uncited` | known-bad | Two findings using never-encode phrasing ("mass-generate ... thin pages", "purchase links from DR90 hosts") are BOTH authored uncited (`citationUrl: ""`), so the citation gate drops them before they ever reach a sink — proving `neverEncodeEmitted` stays 0 for this case without needing a runtime content filter. |
| `kb-parse-failure` | known-bad | An unparseable `analyzerResponse` — `SeoAnalyzer.analyze` returns `parsed: false`; the runner fail-closes to `exitCode: 2` with no report and zero sink calls. |

## Why the never-encode case is authored UNCITED

The pipeline has **no runtime never-encode content filter** — the only
runtime enforcement is the citation gate (uncited → dropped,
`SeoCitationGate`). A *cited* finding whose text happened to describe a
never-encode tactic would NOT be blocked by anything else and would
(correctly, per the current architecture) reach the sink. So the corpus's
never-encode case is deliberately authored **uncited**
(`citationUrl: ""`) — the same drop that satisfies "zero uncited findings
reach the hub" also satisfies "zero never-encode tactics emitted", because
neither ever reaches a sink. A cited never-encode case would (correctly) FAIL
the invariant and is intentionally not included.

## The offline (CI) path

`harness.test.ts`'s required tests drive `runBenchmark()` with the real
`SeoWorkflowRunner`, but every I/O boundary is injected: a fixed
`ScriptedClient` (no LLM call), a `LocalExportSource` pointed at a temp
directory (no network), and a capturing sink standing in for the hub (no
`FactStore`). `createClient` (`src/providers/factory.ts`) is mocked to throw
if ever invoked, and a `globalThis.fetch` spy asserts zero calls — this is
the "no network, no credentials" proof (sc-13-4). `npm test` / `npx vitest
run` exercises this path directly; no environment variable or provider key
is needed.
