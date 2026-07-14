/**
 * Tests for `bober security-audit [target]` (spec-20260712-security-audit-agent-team,
 * sprint 4).
 *
 * Two layers, per the sprint briefing:
 * 1. DI-core tests call `runStandaloneSecurityAudit(deps)` directly with a
 *    fake `runAudit`, asserting the returned `exitCode` for the full
 *    standaloneBlockOn x outcome threshold matrix (sc-4-2), the
 *    config-absent defaults path (sc-4-3), and the descriptor id (sc-4-1).
 *    This avoids Commander entirely.
 * 2. A couple of `parseAsync`-level tests prove the command is wired end to
 *    end and sets `process.exitCode` (sc-4-1 / sc-4-5 registration).
 */

import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

import {
  registerSecurityAuditCommand,
  runStandaloneSecurityAudit,
  thresholdVerdict,
  buildAuditDescriptor,
} from "./security-audit.js";
import { createDefaultConfig } from "../../config/schema.js";
import type { BoberConfig, SecuritySection } from "../../config/schema.js";
import type { ReviewResult } from "../../orchestrator/code-reviewer-agent.js";
import type { SecurityAuditResult } from "../../orchestrator/security-audit-types.js";
import type { runSecurityAudit } from "../../orchestrator/security-auditor-agent.js";
import type { SecurityFindingSink } from "../../orchestrator/security-hub.js";
import { FactStore } from "../../state/facts.js";
import { readFindings } from "../../hub/finding-store.js";
import { logger } from "../../utils/logger.js";

// ── Lifecycle ─────────────────────────────────────────────────────────

let tmpRoot: string;
const originalExitCode = process.exitCode;

vi.mock("../../utils/fs.js", () => ({
  findProjectRoot: vi.fn(),
}));

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-security-audit-cli-"));
  process.exitCode = 0;

  const { findProjectRoot } = await import("../../utils/fs.js");
  vi.mocked(findProjectRoot).mockResolvedValue(tmpRoot);
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.clearAllMocks();
  process.exitCode = originalExitCode as number | undefined;
});

// ── Fixtures ──────────────────────────────────────────────────────────

function makeReview(overrides?: Partial<ReviewResult>): ReviewResult {
  return {
    reviewId: "security-audit-test-review",
    contractId: "security-audit-test",
    specId: "security-audit-standalone",
    timestamp: "2026-07-12T12:00:00.000Z",
    summary: "Fixture review.",
    critical: [],
    important: [],
    minor: [],
    approvedAreas: [],
    ...overrides,
  };
}

function makeAuditResult(overrides?: Partial<SecurityAuditResult>): SecurityAuditResult {
  const review = overrides?.review ?? makeReview();
  return {
    review,
    stack: "node",
    scannerRan: false,
    parsed: true,
    verdict: review.critical.length > 0 ? "blocked" : "pass",
    ...overrides,
  };
}

const cleanResult = makeAuditResult();

const criticalResult = makeAuditResult({
  review: makeReview({
    critical: [
      {
        description: "Hardcoded API key committed to source.",
        evidence: [{ path: "src/foo.ts", line: 12, snippet: "const key = 'sk-live-...'" }],
      },
    ],
  }),
});

const importantOnlyResult = makeAuditResult({
  review: makeReview({
    important: [
      {
        description: "Missing input validation on user-supplied path.",
        evidence: [{ path: "src/bar.ts", line: 34, snippet: "readFile(userPath)" }],
      },
    ],
  }),
});

const parsedFalseResult = makeAuditResult({
  parsed: false,
  review: makeReview({ summary: "Security auditor output could not be parsed." }),
});

function fakeRunAuditResolving(
  result: SecurityAuditResult,
): typeof runSecurityAudit {
  return (async () => result) as unknown as typeof runSecurityAudit;
}

function fakeRunAuditThrowing(message: string): typeof runSecurityAudit {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof runSecurityAudit;
}

function makeConfigWithSecurity(overrides?: Partial<SecuritySection>): BoberConfig {
  const base = createDefaultConfig("test-project", "brownfield");
  return {
    ...base,
    security: { ...SecurityDefaults, ...overrides },
  };
}

// Full SecuritySection defaults (mirrors security-auditor-agent.test.ts fixture).
const SecurityDefaults: SecuritySection = {
  enabled: true,
  failClosed: true,
  timeoutMs: 300_000,
  model: "opus",
  maxTurns: 5,
  scanners: [],
  standaloneBlockOn: "critical",
  hub: true,
};

// ── thresholdVerdict (pure) ─────────────────────────────────────────────

describe("thresholdVerdict", () => {
  it("blocks on any critical finding regardless of threshold", () => {
    const review = criticalResult.review;
    expect(thresholdVerdict(review, "critical")).toBe(true);
    expect(thresholdVerdict(review, "important")).toBe(true);
  });

  it("blocks on important-only findings ONLY when threshold is 'important'", () => {
    const review = importantOnlyResult.review;
    expect(thresholdVerdict(review, "critical")).toBe(false);
    expect(thresholdVerdict(review, "important")).toBe(true);
  });

  it("never blocks a clean review", () => {
    const review = cleanResult.review;
    expect(thresholdVerdict(review, "critical")).toBe(false);
    expect(thresholdVerdict(review, "important")).toBe(false);
  });
});

// ── buildAuditDescriptor (sc-4-1) ───────────────────────────────────────

describe("buildAuditDescriptor", () => {
  it("produces a timestamped contractId that never collides with pipeline sprint-* ids", () => {
    const descriptor = buildAuditDescriptor(undefined, "2026-07-12T12:00:00.000Z");
    expect(descriptor.contractId).toMatch(/^security-audit-/);
    expect(descriptor.contractId).not.toMatch(/^sprint-/);
    // fs-safe: only [A-Za-z0-9_-] so security-audit-state.ts sanitization is a no-op.
    expect(descriptor.contractId).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("scopes the descriptor to the target path when provided", () => {
    const descriptor = buildAuditDescriptor("src/foo.ts", "2026-07-12T12:00:00.000Z");
    expect(descriptor.estimatedFiles).toEqual(["src/foo.ts"]);
    expect(descriptor.title).toContain("src/foo.ts");
  });

  it("falls back to 'working tree' scope when target is omitted", () => {
    const descriptor = buildAuditDescriptor(undefined, "2026-07-12T12:00:00.000Z");
    expect(descriptor.estimatedFiles).toEqual([]);
    expect(descriptor.title).toContain("working tree");
  });
});

// ── sc-4-2: the full 10-cell threshold x outcome exit-code matrix ──────

describe("runStandaloneSecurityAudit: exit-code threshold matrix (sc-4-2)", () => {
  const cells: Array<{
    label: string;
    runAudit: typeof runSecurityAudit;
    exitCritical: 0 | 2;
    exitImportant: 0 | 2;
  }> = [
    { label: "critical findings", runAudit: fakeRunAuditResolving(criticalResult), exitCritical: 2, exitImportant: 2 },
    { label: "important-only findings", runAudit: fakeRunAuditResolving(importantOnlyResult), exitCritical: 0, exitImportant: 2 },
    { label: "clean", runAudit: fakeRunAuditResolving(cleanResult), exitCritical: 0, exitImportant: 0 },
    { label: "parsed:false", runAudit: fakeRunAuditResolving(parsedFalseResult), exitCritical: 2, exitImportant: 2 },
    { label: "core throws", runAudit: fakeRunAuditThrowing("provider unreachable"), exitCritical: 2, exitImportant: 2 },
  ];

  for (const cell of cells) {
    it(`blockOn=critical, ${cell.label} -> exit ${cell.exitCritical}`, async () => {
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const config = makeConfigWithSecurity({ standaloneBlockOn: "critical" });
      const outcome = await runStandaloneSecurityAudit({
        projectRoot: tmpRoot,
        config,
        now: "2026-07-12T12:00:00.000Z",
        runAudit: cell.runAudit,
      });

      expect(outcome.exitCode).toBe(cell.exitCritical);
    });

    it(`blockOn=important, ${cell.label} -> exit ${cell.exitImportant}`, async () => {
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const config = makeConfigWithSecurity({ standaloneBlockOn: "important" });
      const outcome = await runStandaloneSecurityAudit({
        projectRoot: tmpRoot,
        config,
        now: "2026-07-12T12:00:00.000Z",
        runAudit: cell.runAudit,
      });

      expect(outcome.exitCode).toBe(cell.exitImportant);
    });
  }

  it("writes the error to stderr (fail-closed) when the core throws", async () => {
    const errWrites: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errWrites.push(String(chunk));
      return true;
    });

    const config = makeConfigWithSecurity();
    await runStandaloneSecurityAudit({
      projectRoot: tmpRoot,
      config,
      now: "2026-07-12T12:00:00.000Z",
      runAudit: fakeRunAuditThrowing("provider unreachable"),
    });

    expect(errWrites.join("")).toMatch(/security-audit failed.*provider unreachable/);
  });

  it("writes a fail-closed message to stderr when parsed:false", async () => {
    const errWrites: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errWrites.push(String(chunk));
      return true;
    });

    const config = makeConfigWithSecurity();
    await runStandaloneSecurityAudit({
      projectRoot: tmpRoot,
      config,
      now: "2026-07-12T12:00:00.000Z",
      runAudit: fakeRunAuditResolving(parsedFalseResult),
    });

    expect(errWrites.join("")).toMatch(/could not be parsed/);
  });
});

// ── sc-4-3: config.security absent -> schema defaults, prints summary ──

describe("runStandaloneSecurityAudit: config.security absent (sc-4-3)", () => {
  it("still runs the audit and passes a synthesized default section to the injected core", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    // createDefaultConfig does NOT set `security` at all (verified: no key).
    const config = createDefaultConfig("test-project", "brownfield");
    expect(config.security).toBeUndefined();

    let receivedConfig: BoberConfig | undefined;
    const spyRunAudit: typeof runSecurityAudit = (async (
      _contract,
      _evaluation,
      _projectRoot,
      cfg,
    ) => {
      receivedConfig = cfg;
      return cleanResult;
    }) as unknown as typeof runSecurityAudit;

    const outcome = await runStandaloneSecurityAudit({
      projectRoot: tmpRoot,
      config,
      now: "2026-07-12T12:00:00.000Z",
      runAudit: spyRunAudit,
    });

    expect(outcome.exitCode).toBe(0);
    expect(receivedConfig?.security).toBeDefined();
    expect(receivedConfig?.security?.standaloneBlockOn).toBe("critical");
    // config.security absent does NOT require enabled:true for standalone —
    // the CLI invocation itself is the opt-in (nonGoals[0]).
    expect(receivedConfig?.security?.enabled).toBe(false);
  });

  it("prints a human-readable summary: verdict, per-bucket counts, top findings, artifact path", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    const config = createDefaultConfig("test-project", "brownfield");
    await runStandaloneSecurityAudit({
      projectRoot: tmpRoot,
      config,
      now: "2026-07-12T12:00:00.000Z",
      runAudit: fakeRunAuditResolving(criticalResult),
    });

    const output = writes.join("");
    expect(output).toMatch(/BLOCKED/);
    expect(output).toMatch(/critical: 1/);
    expect(output).toMatch(/important: 0/);
    expect(output).toMatch(/minor: 0/);
    expect(output).toMatch(/src\/foo\.ts:12/);
    expect(output).toMatch(/\.bober\/security\/.*-security-audit\.md/);
  });
});

// ── sc-4-1: descriptor id + persistence delegation ─────────────────────

describe("runStandaloneSecurityAudit: descriptor + core delegation (sc-4-1)", () => {
  it("calls runAudit with a synthetic descriptor (timestamped id, evaluation=null, projectRoot, config)", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    let capturedArgs: unknown[] = [];
    const spyRunAudit: typeof runSecurityAudit = (async (...args: unknown[]) => {
      capturedArgs = args;
      return cleanResult;
    }) as unknown as typeof runSecurityAudit;

    const config = makeConfigWithSecurity();
    await runStandaloneSecurityAudit({
      projectRoot: tmpRoot,
      config,
      target: "src/target.ts",
      now: "2026-07-12T12:00:00.000Z",
      runAudit: spyRunAudit,
    });

    const [descriptor, evaluation, projectRoot] = capturedArgs;
    expect((descriptor as { contractId: string }).contractId).toMatch(/^security-audit-/);
    expect(evaluation).toBeNull();
    expect(projectRoot).toBe(tmpRoot);
  });
});

// ── Commander wiring (parseAsync-level) ─────────────────────────────────

function makeProgram(overrides?: { runAudit?: typeof runSecurityAudit }): Command {
  const program = new Command();
  program.exitOverride();
  registerSecurityAuditCommand(program, overrides);
  return program;
}

async function parse(program: Command, args: string[]): Promise<void> {
  await program.parseAsync(["node", "bober", ...args], { from: "node" });
}

describe("registerSecurityAuditCommand: Commander wiring", () => {
  it("registers `security-audit [target]` and sets process.exitCode=0 on a clean pass", async () => {
    await writeFile(
      join(tmpRoot, "bober.config.json"),
      JSON.stringify(createDefaultConfig("test-project", "brownfield")),
      "utf-8",
    );

    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    const program = makeProgram({ runAudit: fakeRunAuditResolving(cleanResult) });
    await parse(program, ["security-audit"]);

    expect(process.exitCode).toBe(0);
    expect(writes.join("")).toMatch(/PASS/);
  });

  it("sets process.exitCode=2 when the injected core reports critical findings", async () => {
    await writeFile(
      join(tmpRoot, "bober.config.json"),
      JSON.stringify(createDefaultConfig("test-project", "brownfield")),
      "utf-8",
    );

    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const program = makeProgram({ runAudit: fakeRunAuditResolving(criticalResult) });
    await parse(program, ["security-audit", "src/target.ts"]);

    expect(process.exitCode).toBe(2);
  });

  it("sets process.exitCode=2 (fail-closed) when loadConfig throws (no config file present)", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    // No bober.config.json written in tmpRoot for this test -> loadConfig throws.
    const program = makeProgram({ runAudit: fakeRunAuditResolving(cleanResult) });
    await parse(program, ["security-audit"]);

    expect(process.exitCode).toBe(2);
  });
});

// ── sc-6-2 / sc-6-3: hub emission gating (standalone CLI) ───────────────

describe("runStandaloneSecurityAudit: hub emission (sc-6-2, sc-6-3)", () => {
  it("hub:true (default) invokes the injected findingSink once per finding; exitCode unaffected", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const config = makeConfigWithSecurity({ hub: true });
    const calls: unknown[] = [];
    const spySink: SecurityFindingSink = async (f) => {
      calls.push(f);
    };

    const outcome = await runStandaloneSecurityAudit({
      projectRoot: tmpRoot,
      config,
      now: "2026-07-12T12:00:00.000Z",
      runAudit: fakeRunAuditResolving(criticalResult),
      findingSink: spySink,
    });

    expect(calls).toHaveLength(1);
    expect(outcome.exitCode).toBe(2);
  });

  it("hub:false emits zero findings even though the audit produced a critical finding; exitCode unaffected", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const config = makeConfigWithSecurity({ hub: false });
    const calls: unknown[] = [];
    const spySink: SecurityFindingSink = async (f) => {
      calls.push(f);
    };

    const outcome = await runStandaloneSecurityAudit({
      projectRoot: tmpRoot,
      config,
      now: "2026-07-12T12:00:00.000Z",
      runAudit: fakeRunAuditResolving(criticalResult),
      findingSink: spySink,
    });

    expect(calls).toHaveLength(0);
    expect(outcome.exitCode).toBe(2);
  });

  it("a throwing findingSink never alters the exit code (best-effort emission)", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const config = makeConfigWithSecurity({ hub: true });
    const throwingSink: SecurityFindingSink = async () => {
      throw new Error("hub ingest exploded");
    };

    const outcome = await runStandaloneSecurityAudit({
      projectRoot: tmpRoot,
      config,
      now: "2026-07-12T12:00:00.000Z",
      runAudit: fakeRunAuditResolving(criticalResult),
      findingSink: throwingSink,
    });

    expect(outcome.exitCode).toBe(2);
  });

  it("clean audits emit zero findings (no sink calls) even with hub:true", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const config = makeConfigWithSecurity({ hub: true });
    const calls: unknown[] = [];
    const spySink: SecurityFindingSink = async (f) => {
      calls.push(f);
    };

    const outcome = await runStandaloneSecurityAudit({
      projectRoot: tmpRoot,
      config,
      now: "2026-07-12T12:00:00.000Z",
      runAudit: fakeRunAuditResolving(cleanResult),
      findingSink: spySink,
    });

    expect(calls).toHaveLength(0);
    expect(outcome.exitCode).toBe(0);
  });

  it("default sink (no findingSink injected): emitting the same critical finding twice leaves one active hub row (sc-6-3)", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const config = makeConfigWithSecurity({ hub: true });

    await runStandaloneSecurityAudit({
      projectRoot: tmpRoot,
      config,
      now: "2026-07-12T12:00:00.000Z",
      runAudit: fakeRunAuditResolving(criticalResult),
    });
    await runStandaloneSecurityAudit({
      projectRoot: tmpRoot,
      config,
      now: "2026-07-12T12:05:00.000Z",
      runAudit: fakeRunAuditResolving(criticalResult),
    });

    const store = new FactStore(join(tmpRoot, ".bober", "memory", "facts.db"));
    expect(readFindings(store)).toHaveLength(1);
    store.close();
  });

  it("hub:false with no findingSink injected never touches the filesystem", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const config = makeConfigWithSecurity({ hub: false });

    await runStandaloneSecurityAudit({
      projectRoot: tmpRoot,
      config,
      now: "2026-07-12T12:00:00.000Z",
      runAudit: fakeRunAuditResolving(criticalResult),
    });

    await expect(stat(join(tmpRoot, ".bober"))).rejects.toThrow();
  });

  it("a mkdir failure in the default-sink setup (a FILE occupies .bober/memory) never rejects — resolves exitCode:0 for a non-blocking (important-only, standaloneBlockOn:'critical') audit (sc-6-2 regression, iteration 2 — reproduces the evaluator's exact repro)", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const config = makeConfigWithSecurity({ hub: true, standaloneBlockOn: "critical" });
    // Reproduces the evaluator's exact repro: a plain file occupies the path
    // ensureFactsDir must mkdir as a directory, so `mkdir(..., {recursive:true})`
    // rejects with EEXIST before a FactStore is ever constructed.
    await mkdir(join(tmpRoot, ".bober"), { recursive: true });
    await writeFile(join(tmpRoot, ".bober", "memory"), "");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const outcome = await runStandaloneSecurityAudit({
      projectRoot: tmpRoot,
      config,
      now: "2026-07-12T12:00:00.000Z",
      runAudit: fakeRunAuditResolving(importantOnlyResult),
    });

    expect(outcome.exitCode).toBe(0);
    const warnCalls = warnSpy.mock.calls.map((args) => args[0] as string);
    expect(warnCalls.some((m) => m.includes("Security hub emission failed"))).toBe(true);
    warnSpy.mockRestore();
  });
});
