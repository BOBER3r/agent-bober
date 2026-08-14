import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlanSpec } from "../../contracts/spec.js";
import { saveSpec } from "../../state/plan-state.js";
import type { PgeRegistriesInput } from "../engine/pge-engine.js";
import type { CodingBindings } from "../registry/index.js";
import { goldenPlanSpec, wholeGraphBindings } from "../engine/__fixtures__/whole-graph.js";
import { GOLDEN_MIN_REPLAY_CASES, parseGoldenCase } from "./case-schema.js";
import type { GoldenCase } from "./case-schema.js";
import { captureGoldenCase, goldenCaseJson } from "./capture.js";

/**
 * The COMMITTED `replay` cases, and the capture that produced them.
 *
 * ── What this file is for ──
 *
 * A captured expectation is captured from the code under test, so the one thing that can
 * go wrong quietly is the capture itself rotting: a scenario nobody can reproduce, or a
 * committed file someone hand-edited into something no run would ever emit. So every
 * scenario below is RE-CAPTURED on every test run and compared with the committed bytes.
 *
 * `GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts` rewrites the committed
 * files instead of comparing them. That is the deliberate act: the resulting diff IS the
 * statement "the artifacts these runs produce have changed, and here is how". A recapture
 * pushed without reading the diff defeats the gate as surely as deleting it.
 *
 * ── Why these scenarios ──
 *
 * Each is a DIFFERENT traversal of the committed graph, driven only through the
 * collaborator seam the artifact already declares — no node is overridden and no topology
 * is edited. Between them they exercise the sprint region's pass and failure branches, the
 * research reflexion cycle going round once, the same cycle hitting the `maxIterations` its
 * topology declares and taking its `onExhausted` edge, and the plan region's clarification
 * gate. A dataset of five copies of one happy path would clear the same threshold while
 * enforcing far less.
 *
 * WHICH NODES these traversals actually reach is not left to inspection: `coverage.test.ts`
 * executes the committed cases and pins the executed set against the artifact, so a node
 * that stops being covered fails a test rather than going quietly unexercised.
 */

/**
 * The instant every capture runs at.
 *
 * ONLY `Date` is faked, and deliberately: the shipped `.bober/` writers stamp `createdAt`,
 * `updatedAt` and `timestamp` from the wall clock into the values they hand back, and a pin
 * is an INPUT the replay re-parses — so those keys cannot be stripped the way the artifact
 * comparison strips them (`PlanSpecSchema` requires `createdAt`). Freezing the clock is what
 * makes a capture reproducible. Timers are left real so nothing that awaits one can hang.
 */
const CAPTURE_INSTANT = new Date("2026-08-05T00:00:00.000Z");

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const GOLDEN_DIR = join(REPO_ROOT, ".bober", "golden");

/** Rewrites the committed cases instead of asserting on them. */
const CAPTURING = process.env.GOLDEN_CAPTURE === "1";

type BindingsFactory = (input: PgeRegistriesInput) => CodingBindings;

interface Scenario {
  readonly caseId: string;
  readonly title: string;
  readonly intent: string;
  readonly tags: readonly string[];
  readonly notes: string;
  readonly featureRequest: string;
  /** A FRESH factory per capture: the counting scenarios below are stateful. */
  readonly makeBindings: () => BindingsFactory;
}

/**
 * The planner asks a clarifying question for the first `rounds` drafts, then settles —
 * unless `rounds` is large enough that the run's own `planClarifyRounds` budget (3) is
 * spent first, in which case it never settles at all.
 *
 * Nothing answers the question — under the autopilot config every golden run executes
 * with, the `post-plan` checkpoint resolves to the `noop` mechanism and no resume message
 * carrying answers is ever produced — so `plan_clarify` folds nothing in and the planner
 * is simply asked again. With `rounds: 1` the second draft settles and the run completes,
 * which is what puts `plan_clarify` on an executed path. With `rounds: 99` the planner
 * never accepts, so `planClarifyRounds` runs out first — see
 * `replay-plan-clarify-rounds-exhausted` below.
 *
 * Until sprint 7 of spec-20260812-pge-real-workload-errors, a planner that never settled
 * could not be captured at all: exhausting `planClarifyRounds` reached `graceful_failure`
 * with `state.spec` still null, and `commit.finalize` threw `FinalizeWithoutSpecError`
 * rather than returning a failed `PipelineResult` — `captureGoldenCase` cannot record a
 * run that never produces a result. `commit.finalize` now falls back to `state.specDraft`
 * (`plan_draft`'s own channel, written on every round) and resolves instead, which is what
 * makes the `rounds: 99` scenario capturable. See docs/pge-graph.md's "A defect this
 * coverage work surfaced" section.
 *
 * The spec is DERIVED from `goldenPlanSpec()` rather than rebuilt, so every clarifying
 * case and the settled cases disagree about exactly one thing: the open question.
 */
function clarifyingBindings(rounds: number): BindingsFactory {
  let asked = 0;
  return (input) => {
    const base = wholeGraphBindings(input);
    return {
      ...base,
      planner: async (...args) => {
        asked += 1;
        if (asked > rounds) return base.planner(...args);
        const spec: PlanSpec = {
          ...goldenPlanSpec(),
          status: "needs-clarification",
          clarificationQuestions: [
            {
              questionId: "q-retry-scope",
              category: "scope",
              question: "Should the retry block apply to every provider or only the default one?",
              ambiguityWeight: 5,
            },
          ],
          resolvedClarifications: [],
        };
        // The shipped planner persists whatever draft it produced, clarifying or not, and
        // `.bober/specs/` is a compared artifact — so a fake that skipped this would report
        // a divergence created by the fixture.
        await saveSpec(input.projectRoot, spec);
        return { kind: "needs-clarification" as const, spec };
      },
    };
  };
}

/** `critique` answers with a finding for the first `rounds` calls, then accepts. */
function critiquingBindings(rounds: number): BindingsFactory {
  let seen = 0;
  return (input) => {
    const base = wholeGraphBindings(input);
    return {
      ...base,
      critique: async (_request, _ctx) => {
        seen += 1;
        return Promise.resolve({
          critique: seen <= rounds ? `Round ${String(seen)}: the digest is still too thin.` : null,
        });
      },
    };
  };
}

const SCENARIOS: readonly Scenario[] = [
  {
    caseId: "replay-full-run-evaluation-passes",
    title: "a whole run whose sprint evaluation passes",
    intent:
      "Pin the artifacts a complete run leaves behind when every gate is satisfied: the plan spec, the sprint contract, the terminal history line and the completion marker.",
    tags: ["replay", "full-run", "region:research", "region:plan", "region:sprint", "region:terminal"],
    notes:
      "Captured from a real PgeEngine run of the committed artifact and replayed. The `audits` collection carries the fail-closed refusal of the git-effect `commit` node under an autopilot `noop` gate — the sprint-13 divergence, pinned here so a change to it cannot land unnoticed.",
    featureRequest: "Accept an optional retry block in the pipeline config and validate it.",
    makeBindings: () => (input) => wholeGraphBindings(input),
  },
  {
    caseId: "replay-full-run-evaluation-fails",
    title: "a whole run whose sprint evaluation fails",
    intent:
      "Pin the rework branch: a failing evaluation must change which nodes run and what the run finally reports, not merely add a line somewhere.",
    tags: ["replay", "full-run", "region:sprint", "rework"],
    notes:
      "The only difference from the passing case is the evaluator's verdict, so any artifact that differs between the two is attributable to the rework path and nothing else.",
    featureRequest: "Accept an optional retry block in the pipeline config and validate it.",
    makeBindings: () => (input) => wholeGraphBindings(input, { evaluationPasses: false }),
  },
  {
    caseId: "replay-research-second-reflexion",
    title: "a critique sends the research region round a second time",
    intent:
      "Pin the reflexion cycle going round exactly once more: one non-null critique must produce a second explore/critique pair and then settle.",
    tags: ["replay", "region:research", "loop:researchReflexions"],
    notes:
      "The pinned response sequence IS the assertion here: a second `research.explore` and a second `research.critique` appear because the first critique was non-null. A runtime that stopped honouring the critique would replay with a call the recording does not hold and fail.",
    featureRequest: "Document the reflexion loop and its bound.",
    makeBindings: () => critiquingBindings(1),
  },
  {
    caseId: "replay-research-reflexions-exhausted",
    title: "the research reflexion cycle hits its declared bound",
    intent:
      "Pin the loop bound itself: a critique that never accepts must stop at the topology's maxIterations and take the cycle's onExhausted edge rather than spinning.",
    tags: ["replay", "region:research", "loop:researchReflexions", "bounded-exit"],
    notes:
      "The count of `research.explore` calls in the pins is the bound the committed artifact declares for the researchReflexions counter. Raising or lowering that bound changes this case, which is exactly the drift a committed dataset exists to catch.",
    featureRequest: "Document the reflexion loop and its bound.",
    makeBindings: () => critiquingBindings(99),
  },
  {
    caseId: "replay-plan-clarification-round",
    title: "a plan that needs clarification goes round the clarify gate once",
    intent:
      "Pin the clarification cycle: a first draft carrying an open question must reach plan_clarify, re-draft, and then settle — so the gate is on the executed path rather than merely declared in the artifact.",
    tags: ["replay", "region:plan", "loop:planClarifyRounds", "hitl"],
    notes:
      "The case that distinguishes the two ways a HITL gate behaves under an autopilot noop mechanism: plan_clarify declares NO gated effect, so noop lets it proceed, whereas the commit node declares a git effect and is refused outright (the sprint-13 divergence). A change that made noop grant gated effects would turn the commit refusal green and leave this case untouched, which is why both are pinned. NOTE the bound is NOT driven here: a planner that settles on its second draft never spends the planClarifyRounds budget. See replay-plan-clarify-rounds-exhausted below for the planner that never settles at all.",
    featureRequest: "Accept an optional retry block in the pipeline config and validate it.",
    makeBindings: () => clarifyingBindings(1),
  },
  {
    caseId: "replay-plan-clarify-rounds-exhausted",
    title: "a plan that never settles exhausts planClarifyRounds and reports failure",
    intent:
      "Pin the previously-uncapturable defect fixed by sprint 7 of spec-20260812-pge-real-workload-errors: a planner that never accepts an answer exhausts plan_clarify_check's planClarifyRounds bound of 3 and reaches graceful_failure with state.spec still null. commit.finalize now falls back to state.specDraft and resolves with success false, needsClarification true and a populated errors array, instead of throwing FinalizeWithoutSpecError.",
    tags: ["replay", "region:plan", "loop:planClarifyRounds", "bounded-exit", "needsClarification"],
    notes:
      "Before sprint 7 this scenario could not be captured at all — captureGoldenCase cannot record a run that never produces a result, and this run used to throw. The pinned call count on plan_draft IS the assertion: exactly three planner calls, matching plan_clarify_check's declared bound; a fourth would mean the bound did not bite. See docs/pge-graph.md's 'A defect this coverage work surfaced' section for the full history.",
    featureRequest: "Accept an optional retry block in the pipeline config and validate it.",
    makeBindings: () => clarifyingBindings(99),
  },
];

/** Every committed replay case, keyed by file name. */
async function committedCase(caseId: string): Promise<string | null> {
  try {
    return await readFile(join(GOLDEN_DIR, `${caseId}.json`), "utf-8");
  } catch {
    return null;
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: CAPTURE_INSTANT });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the committed replay cases", () => {
  it("are enough of the dataset to satisfy the floor", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(GOLDEN_MIN_REPLAY_CASES);
  });

  it("have distinct ids and distinct scenarios", () => {
    expect(new Set(SCENARIOS.map((s) => s.caseId)).size).toBe(SCENARIOS.length);
  });

  for (const scenario of SCENARIOS) {
    it(
      `${scenario.caseId} is exactly what a fresh capture produces`,
      async () => {
        const captured = await captureGoldenCase({
          projectRoot: REPO_ROOT,
          caseId: scenario.caseId,
          title: scenario.title,
          intent: scenario.intent,
          tags: scenario.tags,
          notes: scenario.notes,
          featureRequest: scenario.featureRequest,
          bindings: scenario.makeBindings(),
        });

        // Parsed BEFORE it is written or compared: a capture that produced something the
        // dataset would reject must fail here, not at the next CI run.
        const parsed = parseGoldenCase(
          JSON.parse(goldenCaseJson(captured.goldenCase)),
          scenario.caseId,
        );
        expect(parsed.ok ? [] : parsed.errors).toEqual([]);
        expect(captured.goldenCase.enforcement).toBe("replay");
        expect(captured.calls.length).toBeGreaterThan(0);

        const bytes = goldenCaseJson(captured.goldenCase);
        if (CAPTURING) {
          await writeFile(join(GOLDEN_DIR, `${scenario.caseId}.json`), bytes, "utf-8");
          return;
        }

        const committed = await committedCase(scenario.caseId);
        expect(
          committed,
          `${scenario.caseId}.json is not committed; run GOLDEN_CAPTURE=1 vitest run src/pge/golden/capture.test.ts`,
        ).not.toBeNull();
        expect(bytes).toBe(committed);
      },
      120_000,
    );
  }

  it("are the only cases in the dataset that declare enforcement replay", async () => {
    const files = (await readdir(GOLDEN_DIR)).sort();
    const declared: string[] = [];
    for (const file of files) {
      const raw = JSON.parse(await readFile(join(GOLDEN_DIR, file), "utf-8")) as GoldenCase;
      if (raw.enforcement === "replay") declared.push(raw.caseId);
    }
    expect(declared.sort()).toEqual([...SCENARIOS.map((s) => s.caseId)].sort());
  });
});
