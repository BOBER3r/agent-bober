import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PgeRegistriesInput } from "../engine/pge-engine.js";
import type { CodingBindings } from "../registry/index.js";
import { wholeGraphBindings } from "../engine/__fixtures__/whole-graph.js";
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
 * ── Why these four scenarios ──
 *
 * Each is a DIFFERENT traversal of the committed graph, driven only through the
 * collaborator seam the artifact already declares — no node is overridden and no topology
 * is edited. Between them they exercise the sprint region's pass and rework branches, the
 * research reflexion cycle going round once, and the same cycle hitting the `maxIterations`
 * its topology declares and taking its `onExhausted` edge. A dataset of four copies of one
 * happy path would clear the same threshold while enforcing far less.
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
