/**
 * SeoWorkflowRunner benchmark harness (spec-20260715-ultimate-seo-suite,
 * Sprint 13, sc-13-1..sc-13-4). Mirrors the shape of the security benchmark
 * (`src/orchestrator/security-knowledge/benchmark/harness.ts`'s pure
 * `measure()`), but is RICHER: this harness actually RUNS the real
 * `SeoWorkflowRunner.run` (async, fs) per labelled corpus case rather than
 * calling an injected pure finder/verifier function directly. Every case
 * injects `dataSource` + `analyzer` + `findingSink` (Pattern A, `runner.ts`)
 * so `selectSource`/`buildDefaultAnalyzer`/`createClient` and the real
 * `FactStore` are never touched — the whole run is offline and
 * credential-free (nonGoal: "offline fixtures only").
 *
 * Not wired into `SeoWorkflowRunner`, the CLI, or any evaluator gate
 * (nonGoal: "do not gate the pipeline on a precision/recall threshold this
 * sprint") — this is a leaf measurement module consumed only by
 * `harness.test.ts`.
 *
 * Clock discipline: `BENCHMARK_NOW` is a fixed constant threaded into every
 * case's `now` — this file never constructs a `Date` for wall-clock
 * purposes and never calls `Math.random`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createDefaultConfig } from "../../config/schema.js";
import type { Finding } from "../../hub/finding.js";
import type { LLMClient, ChatParams, ChatResponse } from "../../providers/types.js";
import { SeoAnalyzer } from "../analyzer.js";
import type { SeoFindingSink } from "../hub-emitter.js";
import { SeoWorkflowRunner } from "../runner.js";
import { LocalExportSource } from "../sources/local-export.js";
import type { SeoReport, SeoWorkflow } from "../types.js";

// -- ScriptedClient (recorded analyzer response; NO network) --------------
//
// Mirrors `src/seo/analyzer.test.ts:11-21` / `src/seo/runner.test.ts:46-56`.
// Records every `ChatParams` it receives and replays `case.analyzerResponse`
// verbatim — this is the deterministic "recorded LLM response" a benchmark
// needs: no network call, no provider key, reproducible across runs.
class ScriptedClient implements LLMClient {
  readonly calls: ChatParams[] = [];
  private idx = 0;
  constructor(private readonly responses: string[]) {}
  async chat(params: ChatParams): Promise<ChatResponse> {
    this.calls.push(params);
    const text = this.responses[Math.min(this.idx, this.responses.length - 1)] ?? "";
    this.idx += 1;
    return { text, toolCalls: [], stopReason: "end", usage: { inputTokens: 3, outputTokens: 5 } };
  }
}

// -- Corpus case shape ------------------------------------------------------

/** One labelled benchmark case (mirrors a `corpus/manifest.json` entry). */
export interface SeoBenchmarkCase {
  /** Stable id, unique in the corpus. */
  id: string;
  label: "known-good" | "known-bad";
  workflow: SeoWorkflow;
  target: string;
  /** Written to a temp `<projectRoot>/<id>/imports/<file>` dir before the run. */
  imports: Array<{ file: string; content: string }>;
  /** The recorded raw text the `ScriptedClient` returns (a `{"findings":[...]}` JSON string, or garbage to prove fail-closed parsing). */
  analyzerResponse: string;
  expected: {
    /** Each expected finding names its `playbookRef` and whether it should survive the citation gate. */
    findings: Array<{ playbookRef: string; cited: boolean }>;
    droppedUncited: number;
    verdict: "pass" | "blocked";
  };
}

// -- Emitted-text never-encode guard ---------------------------------------
//
// A documented mirror of the widened `FORBIDDEN_ACTION_PATTERNS`
// (`src/seo/skills-content.test.ts`) — scanned over EMITTED (sink-reached)
// findings rather than skill signatures. Deliberately test-local per the
// briefing (do not import a `.test.ts` const into this build file).
const NEVER_ENCODE_EMIT_PATTERNS: RegExp[] = [
  /\bplace\b[^.]*\b(parasite|high-?authority host|third-?party host)/i,
  /\b(?:buy(?:ing)?|purchas(?:e|ing))\b[^.]*\blinks?\b/i,
  /\bregister(ing)?\b[^.]*\bexpired domain/i,
  /\bgenerate\b[^.]*\bmass\b[^.]*\bpages\b/i,
  /\b(?:mass[-\s]?generat(?:e|ing)|generat(?:e|ing)[-\s]?mass)\b/i,
  /\bpoison/i,
];

export interface CorpusMetrics {
  /** ΣTP/(ΣTP+ΣFP) across every case, matched by the `playbook:<ref>` tag. */
  findingPrecision: number;
  /** ΣTP/(ΣTP+ΣFN) across every case. */
  findingRecall: number;
  /** Σ correctlyDropped / Σ expectedDropped — how well the uncited-drop count matches expectation. */
  uncitedDropRecall: number;
  /** INVARIANT: MUST be 0 — count of emitted findings lacking a well-formed `cite:` evidence entry. */
  uncitedReachedSink: number;
  /** INVARIANT: MUST be 0 — count of emitted findings whose text matches a never-encode tactic pattern. */
  neverEncodeEmitted: number;
  cases: Array<{ id: string; emitted: Finding[]; report?: SeoReport; exitCode: 0 | 2 }>;
}

const BENCHMARK_NOW = "2026-07-16T00:00:00.000Z"; // FIXED — never new Date()

// -- Matching + invariant helpers (pure) -----------------------------------

function extractPlaybookRef(finding: Finding): string | undefined {
  const tag = finding.tags.find((t) => t.startsWith("playbook:"));
  return tag?.slice("playbook:".length);
}

/** True when `finding` lacks a well-formed absolute http(s) `cite:` evidence entry (uncited-drop invariant scan). */
function lacksWellFormedCitation(finding: Finding): boolean {
  const citeEntry = finding.evidence.find((e) => e.startsWith("cite:"));
  if (!citeEntry) return true;
  try {
    const parsed = new URL(citeEntry.slice("cite:".length));
    return parsed.protocol !== "http:" && parsed.protocol !== "https:";
  } catch {
    return true;
  }
}

/** True when `finding`'s title+evidence text matches a never-encode tactic pattern. */
function matchesNeverEncode(finding: Finding): boolean {
  const text = `${finding.title} ${finding.evidence.join(" ")}`;
  return NEVER_ENCODE_EMIT_PATTERNS.some((p) => p.test(text));
}

/**
 * Score one case's emitted findings against its `expected.findings` by
 * `playbookRef`, matching a multiset (each expected-cited entry consumes at
 * most one emitted finding with the same ref). Pure and total.
 */
function scoreCase(
  caseDef: SeoBenchmarkCase,
  emitted: Finding[],
): { tp: number; fp: number; fn: number } {
  const remainingRefs = emitted.map((f) => extractPlaybookRef(f));
  const expectedCitedRefs = caseDef.expected.findings.filter((f) => f.cited).map((f) => f.playbookRef);

  let tp = 0;
  for (const ref of expectedCitedRefs) {
    const idx = remainingRefs.indexOf(ref);
    if (idx !== -1) {
      tp += 1;
      remainingRefs.splice(idx, 1);
    }
  }

  return { tp, fp: remainingRefs.length, fn: expectedCitedRefs.length - tp };
}

const rate = (numerator: number, denominator: number): number => (denominator === 0 ? 0 : numerator / denominator);

// -- runBenchmark -------------------------------------------------------

/**
 * Run the real `SeoWorkflowRunner` over `corpus`, offline and deterministic
 * (both egress axes off, an injected `ScriptedClient`-backed analyzer, and a
 * capturing sink standing in for the hub). Writes each case's inline
 * `imports[]` under `<projectRoot>/<id>/imports/` before running so
 * `LocalExportSource` reads real files (no fs mocks, principle L44).
 *
 * NEVER throws: `SeoWorkflowRunner.run` itself never throws (runner.ts:256),
 * and every step here is either that call or pure aggregation.
 */
export async function runBenchmark(corpus: SeoBenchmarkCase[], projectRoot: string): Promise<CorpusMetrics> {
  let tpSum = 0;
  let fpSum = 0;
  let fnSum = 0;
  let correctlyDroppedSum = 0;
  let expectedDroppedSum = 0;
  let uncitedReachedSink = 0;
  let neverEncodeEmitted = 0;
  const cases: CorpusMetrics["cases"] = [];

  for (const caseDef of corpus) {
    const caseRoot = join(projectRoot, caseDef.id);
    const importsDir = join(caseRoot, "imports");
    await mkdir(importsDir, { recursive: true });
    for (const file of caseDef.imports) {
      await writeFile(join(importsDir, file.file), file.content, "utf-8");
    }

    const dataSource = new LocalExportSource(importsDir);
    const analyzer = new SeoAnalyzer(new ScriptedClient([caseDef.analyzerResponse]), "benchmark-model");
    const emitted: Finding[] = [];
    const findingSink: SeoFindingSink = async (finding) => {
      emitted.push(finding);
    };

    const outcome = await new SeoWorkflowRunner().run({
      projectRoot: caseRoot,
      config: createDefaultConfig("seo-benchmark", "brownfield"),
      workflow: caseDef.workflow,
      target: caseDef.target,
      now: BENCHMARK_NOW,
      dataSource,
      analyzer,
      findingSink,
    });

    const { tp, fp, fn } = scoreCase(caseDef, emitted);
    tpSum += tp;
    fpSum += fp;
    fnSum += fn;

    const actualDropped = outcome.report?.droppedUncited ?? 0;
    correctlyDroppedSum += Math.min(actualDropped, caseDef.expected.droppedUncited);
    expectedDroppedSum += caseDef.expected.droppedUncited;

    for (const finding of emitted) {
      if (lacksWellFormedCitation(finding)) uncitedReachedSink += 1;
      if (matchesNeverEncode(finding)) neverEncodeEmitted += 1;
    }

    cases.push({ id: caseDef.id, emitted, report: outcome.report, exitCode: outcome.exitCode });
  }

  return {
    findingPrecision: rate(tpSum, tpSum + fpSum),
    findingRecall: rate(tpSum, tpSum + fnSum),
    uncitedDropRecall: rate(correctlyDroppedSum, expectedDroppedSum),
    uncitedReachedSink,
    neverEncodeEmitted,
    cases,
  };
}
