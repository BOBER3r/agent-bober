/**
 * Unit tests for the security-audit-agent-team sprint 2 core:
 * runSecurityAudit + parseSecurityAuditResult (src/orchestrator/security-auditor-agent.ts).
 *
 * Mocks the loop/client per the evaluator-agent.test.ts convention (loopSpy,
 * clientSpy, resolveModel, assembleSystemPrompt, tools/index). Uses the REAL
 * stack-knowledge resolver (no mock) so the sc-2-3 prompt-fragment assertion
 * exercises the actual skill-file resolution against this repository's
 * skills/bober.solidity/SKILL.md, giving genuine field-name-drift coverage.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SprintContract } from "../contracts/sprint-contract.js";
import type { EvaluationRunResult } from "../evaluators/registry.js";
import { createDefaultConfig } from "../config/schema.js";
import type { BoberConfig, SecuritySection } from "../config/schema.js";
import type * as ToolsIndexModule from "./tools/index.js";

// ── Mock heavy dependencies ────────────────────────────────────────

const loopSpy = vi.fn();
const clientSpy = vi.fn(() => ({}) as never);
const saveSecurityAuditSpy = vi.fn().mockResolvedValue(undefined);

vi.mock("./agentic-loop.js", () => ({ runAgenticLoop: loopSpy }));
vi.mock("../providers/factory.js", () => ({ createClient: clientSpy }));
vi.mock("./model-resolver.js", () => ({ resolveModel: () => "model-test" }));
vi.mock("./agent-loader.js", () => ({ assembleSystemPrompt: vi.fn().mockResolvedValue("SYS") }));
// Uses the REAL resolveRoleTools/ROLE_TOOLS (only getGraphState/getGraphDeps are
// stubbed, forcing the ungated/static tool set) so the nonGoal regression test
// below exercises the genuine role -> tool-name mapping instead of a fixture
// that could silently drift out of sync with tools/index.ts.
vi.mock("./tools/index.js", async () => {
  const actual = await vi.importActual<typeof ToolsIndexModule>("./tools/index.js");
  return {
    ...actual,
    getGraphState: () => ({ graphEnabled: false, engineHealth: "disabled" }),
    getGraphDeps: () => undefined,
  };
});
vi.mock("../state/security-audit-state.js", () => ({
  saveSecurityAudit: saveSecurityAuditSpy,
}));

const { runSecurityAudit, parseSecurityAuditResult } = await import("./security-auditor-agent.js");

// ── Fixtures ────────────────────────────────────────────────────────

const testContract: SprintContract = {
  contractId: "security-audit-test",
  specId: "test-spec",
  sprintNumber: 2,
  title: "Security audit fixture contract",
  description: "Contract used as a fixture for security-auditor-agent unit tests.",
  status: "in-progress",
  dependsOn: [],
  features: ["feat-2"],
  successCriteria: [
    {
      criterionId: "sc-2-1",
      description: "Fixture criterion — not exercised directly by these unit tests.",
      verificationMethod: "unit-test",
      required: true,
    },
  ],
  nonGoals: ["Not a real sprint"],
  stopConditions: ["All assertions pass"],
  definitionOfDone: "Fixture contract for the security auditor unit tests.",
  assumptions: [],
  outOfScope: [],
  estimatedFiles: [],
  iterationHistory: [],
  lastEvalId: null,
};

const testEvaluation: EvaluationRunResult = {
  passed: true,
  score: 95,
  results: [],
  summary: "All required strategies passed.",
  timestamp: new Date().toISOString(),
};

const fullSecurityDefaults: SecuritySection = {
  enabled: true,
  failClosed: true,
  timeoutMs: 300_000,
  model: "opus",
  maxTurns: 5,
  scanners: [],
  standaloneBlockOn: "critical",
  hub: true,
};

function makeConfig(overrides?: {
  stack?: BoberConfig["project"]["stack"];
  security?: Partial<SecuritySection>;
}): BoberConfig {
  const base = createDefaultConfig("test-project", "brownfield");
  return {
    ...base,
    project: { ...base.project, stack: overrides?.stack },
    security: { ...fullSecurityDefaults, ...overrides?.security },
  };
}

function loopResult(finalText: string) {
  return {
    finalText,
    turnsUsed: 1,
    toolsCalled: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: "end_turn" as const,
  };
}

const wellFormedCriticalText = JSON.stringify({
  reviewId: "r",
  contractId: "security-audit-test",
  specId: "test-spec",
  timestamp: "2026-01-01T00:00:00.000Z",
  summary: "one critical reentrancy finding",
  critical: [
    {
      description: "Reentrancy in withdraw()",
      evidence: [{ path: "contracts/Vault.sol", line: 42, snippet: "call{value: amount}(\"\")" }],
      vulnClass: "privilege-escalation",
    },
  ],
  important: [],
  minor: [],
  approvedAreas: [],
});

const cleanAuditText = JSON.stringify({
  reviewId: "r-clean",
  contractId: "security-audit-test",
  specId: "test-spec",
  timestamp: "2026-01-01T00:00:00.000Z",
  summary: "no exploitable vulnerabilities found",
  critical: [],
  important: [],
  minor: [],
  approvedAreas: ["contracts/Vault.sol"],
});

beforeEach(() => {
  loopSpy.mockReset();
  clientSpy.mockClear();
  saveSecurityAuditSpy.mockClear();
});

// ── sc-2-1: well-formed critical finding ───────────────────────────

describe("runSecurityAudit — sc-2-1 well-formed critical finding", () => {
  it("resolves parsed:true, verdict:'blocked', the finding preserved, stack label set, and persists via saveSecurityAudit", async () => {
    loopSpy.mockResolvedValueOnce(loopResult(wellFormedCriticalText));

    const config = makeConfig({ stack: { blockchain: "solidity" } });
    const result = await runSecurityAudit(testContract, testEvaluation, "/tmp/project", config);

    expect(result.parsed).toBe(true);
    expect(result.verdict).toBe("blocked");
    expect(result.review.critical).toHaveLength(1);
    expect(result.review.critical[0].description).toBe("Reentrancy in withdraw()");
    expect(result.review.critical[0].evidence[0]).toEqual({
      path: "contracts/Vault.sol",
      line: 42,
      snippet: 'call{value: amount}("")',
    });
    expect(result.stack).toBe("solidity");

    expect(saveSecurityAuditSpy).toHaveBeenCalledTimes(1);
    expect(saveSecurityAuditSpy).toHaveBeenCalledWith("/tmp/project", "security-audit-test", result);
  });
});

// ── sc-2-2: fail-closed parse (the DOMINANT criterion) ─────────────

describe("runSecurityAudit — sc-2-2 fail-closed parse on unparseable output", () => {
  it("resolves parsed:false and verdict:'blocked' (NOT a silent 'pass') on garbage prose output", async () => {
    loopSpy.mockResolvedValueOnce(loopResult("sorry, I am not able to help with that request."));

    const config = makeConfig();
    const result = await runSecurityAudit(testContract, testEvaluation, "/tmp/project", config);

    expect(result.parsed).toBe(false);
    expect(result.verdict).toBe("blocked");
    expect(result.review.critical).toEqual([]);
  });

  it("resolves parsed:false and verdict:'blocked' on truncated JSON", async () => {
    loopSpy.mockResolvedValueOnce(loopResult('{"critical":[{"desc'));

    const config = makeConfig();
    const result = await runSecurityAudit(testContract, testEvaluation, "/tmp/project", config);

    expect(result.parsed).toBe(false);
    expect(result.verdict).toBe("blocked");
  });

  it("distinguishes a genuinely clean well-formed audit (parsed:true, verdict:'pass') from the malformed case", async () => {
    loopSpy.mockResolvedValueOnce(loopResult(cleanAuditText));

    const config = makeConfig();
    const result = await runSecurityAudit(testContract, testEvaluation, "/tmp/project", config);

    expect(result.parsed).toBe(true);
    expect(result.verdict).toBe("pass");
    expect(result.review.critical).toEqual([]);

    // The clean result must be distinguishable from the parsed:false case:
    // both have empty critical[], but only one is parsed:true.
    loopSpy.mockResolvedValueOnce(loopResult("garbage, not json at all"));
    const malformed = await runSecurityAudit(testContract, testEvaluation, "/tmp/project", config);

    expect(malformed.review.critical).toEqual(result.review.critical); // both empty
    expect(malformed.parsed).not.toBe(result.parsed); // but NOT the same parsed state
    expect(malformed.verdict).toBe("blocked");
    expect(result.verdict).toBe("pass");
  });
});

// ── parseSecurityAuditResult — direct unit coverage ────────────────

describe("parseSecurityAuditResult", () => {
  it("parses a well-formed JSON object into a ReviewResult with parsed:true", () => {
    const { review, parsed } = parseSecurityAuditResult(cleanAuditText, "c-1", "s-1");
    expect(parsed).toBe(true);
    expect(review.contractId).toBe("security-audit-test");
    expect(review.critical).toEqual([]);
  });

  it("extracts JSON from a markdown-fenced response", () => {
    const fenced = "Here is my audit:\n```json\n" + cleanAuditText + "\n```";
    const { parsed, review } = parseSecurityAuditResult(fenced, "c-1", "s-1");
    expect(parsed).toBe(true);
    expect(review.summary).toContain("no exploitable vulnerabilities");
  });

  it("returns parsed:false with an empty review on non-JSON prose", () => {
    const { review, parsed } = parseSecurityAuditResult("I cannot comply.", "c-1", "s-1");
    expect(parsed).toBe(false);
    expect(review.critical).toEqual([]);
    expect(review.summary).toBe("Security auditor output could not be parsed.");
  });

  it("returns parsed:false on truncated JSON", () => {
    const { parsed } = parseSecurityAuditResult('{"critical": [{"description": "x"', "c-1", "s-1");
    expect(parsed).toBe(false);
  });

  it("returns parsed:false when the JSON parses but is not an object (e.g. an array)", () => {
    const { parsed } = parseSecurityAuditResult("[1,2,3]", "c-1", "s-1");
    expect(parsed).toBe(false);
  });

  it("drops an invalid vulnClass value rather than propagating it", () => {
    const text = JSON.stringify({
      reviewId: "r",
      contractId: "c-1",
      specId: "s-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      summary: "s",
      critical: [{ description: "d", evidence: [], vulnClass: "not-a-real-class" }],
      important: [],
      minor: [],
      approvedAreas: [],
    });
    const { review } = parseSecurityAuditResult(text, "c-1", "s-1");
    expect(review.critical[0].vulnClass).toBeUndefined();
  });
});

// ── sc-2-3: stack-aware prompt fragment reaches the outgoing prompt ─

describe("runSecurityAudit — sc-2-3 stack knowledge injected into the prompt", () => {
  it("includes the resolved promptFragment verbatim in the userMessage for a solidity stack", async () => {
    loopSpy.mockResolvedValueOnce(loopResult(cleanAuditText));

    const config = makeConfig({ stack: { blockchain: "solidity" } });
    await runSecurityAudit(testContract, testEvaluation, "/tmp/project", config);

    expect(loopSpy).toHaveBeenCalledTimes(1);
    const userMessage = loopSpy.mock.calls[0][0].userMessage as string;
    expect(userMessage).toContain("Security Checklist");
    expect(userMessage).toContain("Stack: solidity");
    expect(userMessage).toContain("Skill: bober.solidity");
  });

  it("falls back to the generic taxonomy fragment for an unknown stack", async () => {
    loopSpy.mockResolvedValueOnce(loopResult(cleanAuditText));

    const config = makeConfig({ stack: { frontend: "vue" } });
    await runSecurityAudit(testContract, testEvaluation, "/tmp/project", config);

    const userMessage = loopSpy.mock.calls[0][0].userMessage as string;
    expect(userMessage).toContain("Skill: none (generic taxonomy only)");
    expect(userMessage).toContain(
      "Focus on injection vulnerabilities, authentication and authorisation gaps",
    );
  });

  it("renders a 'Deterministic scanner findings' section when priors are non-empty", async () => {
    loopSpy.mockResolvedValueOnce(loopResult(cleanAuditText));

    const config = makeConfig();
    const priors = [{ description: "scanner-flagged reentrancy", evidence: [], vulnClass: "privilege-escalation" as const }];
    const result = await runSecurityAudit(testContract, testEvaluation, "/tmp/project", config, priors);

    const userMessage = loopSpy.mock.calls[0][0].userMessage as string;
    expect(userMessage).toContain("Deterministic scanner findings (ground truth priors)");
    expect(userMessage).toContain("scanner-flagged reentrancy");
    expect(result.scannerRan).toBe(true);
  });

  it("omits the priors section when priors default to empty", async () => {
    loopSpy.mockResolvedValueOnce(loopResult(cleanAuditText));

    const config = makeConfig();
    const result = await runSecurityAudit(testContract, testEvaluation, "/tmp/project", config);

    const userMessage = loopSpy.mock.calls[0][0].userMessage as string;
    expect(userMessage).not.toContain("Deterministic scanner findings");
    expect(result.scannerRan).toBe(false);
  });
});

// ── sc-2-5: standalone mode + client-throw propagation ─────────────

describe("runSecurityAudit — sc-2-5 standalone mode and error propagation", () => {
  it("omits the evaluation-context section of the prompt when evaluation is null", async () => {
    loopSpy.mockResolvedValueOnce(loopResult(cleanAuditText));

    const config = makeConfig();
    await runSecurityAudit(testContract, null, "/tmp/project", config);

    const userMessage = loopSpy.mock.calls[0][0].userMessage as string;
    expect(userMessage).not.toContain("Evaluation Result (Already Passed)");
    expect(userMessage).toContain("standalone (no prior evaluation context)");
  });

  it("includes the evaluation-context section when evaluation is provided", async () => {
    loopSpy.mockResolvedValueOnce(loopResult(cleanAuditText));

    const config = makeConfig();
    await runSecurityAudit(testContract, testEvaluation, "/tmp/project", config);

    const userMessage = loopSpy.mock.calls[0][0].userMessage as string;
    expect(userMessage).toContain("Evaluation Result (Already Passed)");
    expect(userMessage).toContain("in-pipeline (post-evaluation)");
  });

  it("rejects (does NOT resolve to a clean result) when the loop rejects with a provider error", async () => {
    loopSpy.mockRejectedValueOnce(new Error("provider down"));

    const config = makeConfig();
    await expect(
      runSecurityAudit(testContract, testEvaluation, "/tmp/project", config),
    ).rejects.toThrow("provider down");

    // A rejected audit must never be persisted as if it succeeded.
    expect(saveSecurityAuditSpy).not.toHaveBeenCalled();
  });
});

// ── sc-2-6: provider-agnostic client wiring ─────────────────────────

describe("runSecurityAudit — sc-2-6 config.security wiring through createClient", () => {
  it("passes config.security.provider/endpoint/providerConfig/model to createClient", async () => {
    loopSpy.mockResolvedValueOnce(loopResult(cleanAuditText));

    const config = makeConfig({
      security: {
        provider: "openai-compat",
        endpoint: "https://example.test/v1",
        providerConfig: { apiKey: "test-key" },
        model: "custom-model",
        maxTurns: 7,
      },
    });

    await runSecurityAudit(testContract, testEvaluation, "/tmp/project", config);

    expect(clientSpy).toHaveBeenCalledWith(
      "openai-compat",
      "https://example.test/v1",
      { apiKey: "test-key" },
      "custom-model",
      "SecurityAuditor",
    );
    expect(loopSpy.mock.calls[0][0].maxTurns).toBe(7);
  });

  it("passes a Budget to runAgenticLoop when config.security.budget.maxUsd is set", async () => {
    loopSpy.mockResolvedValueOnce(loopResult(cleanAuditText));

    const config = makeConfig({ security: { budget: { maxUsd: 2.5 } } });
    await runSecurityAudit(testContract, testEvaluation, "/tmp/project", config);

    expect(loopSpy.mock.calls[0][0].budget).toBeDefined();
  });

  it("omits budget from runAgenticLoop params when no maxUsd is configured", async () => {
    loopSpy.mockResolvedValueOnce(loopResult(cleanAuditText));

    const config = makeConfig();
    await runSecurityAudit(testContract, testEvaluation, "/tmp/project", config);

    expect(loopSpy.mock.calls[0][0].budget).toBeUndefined();
  });
});

// ── nonGoal regression: auditor must never get bash/write/edit tools ──

describe("runSecurityAudit — nonGoal: no bash/write/edit tools", () => {
  it("passes a tools array to runAgenticLoop that contains read_file/glob/grep and NO bash, write_file, or edit_file", async () => {
    loopSpy.mockResolvedValueOnce(loopResult(cleanAuditText));

    const config = makeConfig();
    await runSecurityAudit(testContract, testEvaluation, "/tmp/project", config);

    expect(loopSpy).toHaveBeenCalledTimes(1);
    const toolNames = (loopSpy.mock.calls[0][0].tools as Array<{ name: string }>).map((t) => t.name);

    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("glob");
    expect(toolNames).toContain("grep");
    expect(toolNames).not.toContain("bash");
    expect(toolNames).not.toContain("write_file");
    expect(toolNames).not.toContain("edit_file");
  });

  it("has no 'bash' handler registered in the toolHandlers map passed to runAgenticLoop", async () => {
    loopSpy.mockResolvedValueOnce(loopResult(cleanAuditText));

    const config = makeConfig();
    await runSecurityAudit(testContract, testEvaluation, "/tmp/project", config);

    const toolHandlers = loopSpy.mock.calls[0][0].toolHandlers as Map<string, unknown>;
    expect(toolHandlers.has("bash")).toBe(false);
    expect(toolHandlers.has("write_file")).toBe(false);
    expect(toolHandlers.has("edit_file")).toBe(false);
    expect(toolHandlers.has("read_file")).toBe(true);
  });
});
