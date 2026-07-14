import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, stat, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactStore, factsDbPath, ensureFactsDir } from "../../state/facts.js";
import { FactStoreFindingSource, HUB_SCOPE } from "../../hub/finding-source.js";
import type { LLMClient, ChatParams, ChatResponse } from "../../providers/types.js";
import type { Finding } from "../../hub/finding.js";
import { collectFindings } from "../../hub/collector.js";
import { parseScope } from "../../hub/scope.js";
import { runHubList, runHubPriority } from "./hub.js";

// ── ScriptedClient ────────────────────────────────────────────────────

/** Returns scripted responses in call order; repeats the last once exhausted. */
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

// ── Fixtures ──────────────────────────────────────────────────────────

const T = "2026-06-28T00:00:00.000Z";
const NOW = new Date(T);

const FINDING_A: Finding = {
  id: "fa-001",
  domain: "medical",
  title: "Schedule cardiology follow-up",
  kind: "action",
  urgency: 4,
  severity: 5,
  evidence: ["Elevated troponin"],
  surfacedAt: T,
  tags: ["cardiology"],
  status: "open",
};

const FINDING_B: Finding = {
  id: "fb-002",
  domain: "health",
  title: "Watch vitamin D levels",
  kind: "watch",
  urgency: 2,
  severity: 2,
  evidence: [],
  surfacedAt: T,
  tags: [],
  status: "open",
};

async function seedRepo(repoRoot: string, findings: Finding[]): Promise<void> {
  await ensureFactsDir(repoRoot);
  const store = new FactStore(factsDbPath(repoRoot));
  for (const f of findings) {
    store.insertFact({
      scope: HUB_SCOPE,
      subject: f.id,
      predicate: "finding",
      value: JSON.stringify(f),
      confidence: 1,
      sourceRunId: null,
      tValid: T,
      tCreated: T,
    });
  }
  store.close();
}

// ── Top-level lifecycle ───────────────────────────────────────────────

const originalExitCode = process.exitCode;

beforeEach(() => {
  process.exitCode = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode as number | undefined;
});

// ── Tests: sc-1-4 (runHubList) ────────────────────────────────────────

describe("runHubList", () => {
  it("prints two findings with title, kind, urgency, severity (sc-1-4)", () => {
    const store = new FactStore(":memory:");
    for (const f of [FINDING_A, FINDING_B]) {
      store.insertFact({
        scope: HUB_SCOPE,
        subject: f.id,
        predicate: "finding",
        value: JSON.stringify(f),
        confidence: 1,
        sourceRunId: null,
        tValid: T,
        tCreated: T,
      });
    }

    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((d: unknown) => {
      writes.push(String(d));
      return true;
    });

    runHubList(new FactStoreFindingSource(store, HUB_SCOPE));

    const out = writes.join("");

    // titles
    expect(out).toContain(FINDING_A.title);
    expect(out).toContain(FINDING_B.title);

    // kind
    expect(out).toContain(`[${FINDING_A.kind}]`);
    expect(out).toContain(`[${FINDING_B.kind}]`);

    // urgency
    expect(out).toContain(`urgency=${FINDING_A.urgency}`);
    expect(out).toContain(`urgency=${FINDING_B.urgency}`);

    // severity
    expect(out).toContain(`severity=${FINDING_A.severity}`);
    expect(out).toContain(`severity=${FINDING_B.severity}`);

    store.close();
  });

  it("prints 'No findings found.' when the store is empty", () => {
    const store = new FactStore(":memory:");

    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((d: unknown) => {
      writes.push(String(d));
      return true;
    });

    runHubList(new FactStoreFindingSource(store, HUB_SCOPE));

    const out = writes.join("");
    expect(out).toContain("No findings found.");

    store.close();
  });

  it("accepts an arbitrary FindingSource (DI interface is stable)", () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((d: unknown) => {
      writes.push(String(d));
      return true;
    });

    // Inline FindingSource implementation to verify the DI seam
    const inlineSource = {
      read: () => [FINDING_A],
    };

    runHubList(inlineSource);

    const out = writes.join("");
    expect(out).toContain(FINDING_A.title);
  });
});

// ── Tests: sc-4-2, sc-4-3, sc-4-4 (runHubPriority) ──────────────────

describe("runHubPriority", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "bober-hub-cmd-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("writes priority.md to kb-hub and prints ranked summary (sc-4-2)", async () => {
    // Seed two sibling repos
    const kbA = join(tmp, "kb-a");
    const kbB = join(tmp, "kb-b");
    await seedRepo(kbA, [FINDING_A]);
    await seedRepo(kbB, [FINDING_B]);

    // Create the kb-hub output vault
    const kbHub = join(tmp, "kb-hub");
    await mkdir(kbHub, { recursive: true });

    const findings = collectFindings([kbA, kbB], HUB_SCOPE);
    // Filtered scope with no constraints → zero LLM calls
    const scope = parseScope({ mode: "filtered" });

    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((d: unknown) => {
      writes.push(String(d));
      return true;
    });

    await runHubPriority(findings, scope, new ScriptedClient([]), kbHub, NOW);

    // priority.md must be written at the absolute kb-hub path
    const mdPath = join(kbHub, "priority.md");
    const mdContent = await readFile(mdPath, "utf-8");
    expect(mdContent).toContain("generatedAt:");
    expect(mdContent).toContain("count: 2");
    expect(mdContent).toContain(FINDING_A.title);
    expect(mdContent).toContain(FINDING_B.title);

    // stdout must list ranks and titles
    const out = writes.join("");
    expect(out).toContain("1.");
    expect(out).toContain("2.");
    expect(out).toContain(FINDING_A.title);
    expect(out).toContain(FINDING_B.title);
  });

  it("sibling source store files are unchanged after priority run (sc-4-2)", async () => {
    const kbA = join(tmp, "kb-a");
    await seedRepo(kbA, [FINDING_A]);

    const dbFile = factsDbPath(kbA);
    const before = await stat(dbFile);

    const kbHub = join(tmp, "kb-hub");
    await mkdir(kbHub, { recursive: true });

    const findings = collectFindings([kbA], HUB_SCOPE);
    const scope = parseScope({ mode: "filtered" });

    await runHubPriority(findings, scope, new ScriptedClient([]), kbHub, NOW);

    const after = await stat(dbFile);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("decide scope keeps only X/Y-relevant findings (sc-4-3)", async () => {
    const fExercise: Finding = {
      id: "f-exercise",
      domain: "health",
      title: "Exercise regularly",
      kind: "action",
      urgency: 4,
      severity: 3,
      evidence: ["improves cardio"],
      surfacedAt: T,
      tags: [],
      status: "open",
    };
    const fDiet: Finding = {
      id: "f-diet",
      domain: "health",
      title: "Diet overhaul",
      kind: "action",
      urgency: 3,
      severity: 3,
      evidence: ["weight management"],
      surfacedAt: T,
      tags: [],
      status: "open",
    };
    const fSleep: Finding = {
      id: "f-sleep",
      domain: "health",
      title: "Sleep schedule optimisation",
      kind: "watch",
      urgency: 2,
      severity: 2,
      evidence: [],
      surfacedAt: T,
      tags: [],
      status: "open",
    };

    const kbHub = join(tmp, "kb-hub");
    await mkdir(kbHub, { recursive: true });

    const scope = parseScope({ mode: "decision", optionA: "exercise", optionB: "diet" });

    // Decision scope:
    //   3 relevance calls (one per finding) + 2 survivors × 4 lens calls = 11 total
    const RELEVANT_A = '{"relevant":true,"relevantTo":"optionA","reason":"about exercise"}';
    const RELEVANT_B = '{"relevant":true,"relevantTo":"optionB","reason":"about diet"}';
    const NEITHER = '{"relevant":false,"relevantTo":"neither","reason":"unrelated"}';
    const INCLUDE_HIGH = '{"include":true,"score":8}';
    const INCLUDE_MED = '{"include":true,"score":5}';

    const responses = [
      RELEVANT_A,   // f-exercise relevance → passes (optionA)
      RELEVANT_B,   // f-diet relevance → passes (optionB)
      NEITHER,      // f-sleep relevance → dropped (relevant:false)
      INCLUDE_HIGH, INCLUDE_HIGH, INCLUDE_HIGH, INCLUDE_HIGH, // f-exercise lens × 4
      INCLUDE_MED,  INCLUDE_MED,  INCLUDE_MED,  INCLUDE_MED, // f-diet lens × 4
    ];

    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((d: unknown) => {
      writes.push(String(d));
      return true;
    });

    await runHubPriority(
      [fExercise, fDiet, fSleep],
      scope,
      new ScriptedClient(responses),
      kbHub,
      NOW,
    );

    // priority.md must have count: 2 (only relevant findings)
    const mdContent = await readFile(join(kbHub, "priority.md"), "utf-8");
    expect(mdContent).toContain("count: 2");
    expect(mdContent).toContain(fExercise.title);
    expect(mdContent).toContain(fDiet.title);
    // Dropped finding must not appear
    expect(mdContent).not.toContain(fSleep.title);

    // stdout lists exactly two ranks
    const out = writes.join("");
    expect(out).toContain("1.");
    expect(out).toContain("2.");
    expect(out).not.toContain(fSleep.title);
  });

  it("missing kb-hub dir → clear error on stderr, exitCode=1, no throw (sc-4-4)", async () => {
    const missingHub = join(tmp, "kb-hub"); // intentionally NOT created

    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((d: unknown) => {
      stderrWrites.push(String(d));
      return true;
    });

    // Must resolve (no throw) even when the vault is missing
    await expect(
      runHubPriority(
        [],
        parseScope({ mode: "general" }),
        new ScriptedClient([]),
        missingHub,
        NOW,
      ),
    ).resolves.toBeUndefined();

    // Non-zero exit code
    expect(process.exitCode).toBe(1);

    // Clear, actionable error message referencing the missing path
    const errOut = stderrWrites.join("");
    expect(errOut).toContain("kb-hub vault not found");
    expect(errOut).toContain(missingHub);
  });
});
