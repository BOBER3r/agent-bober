/**
 * Unit tests for the adversarial finder->verifier stage (spec-20260714
 * sprint 8): src/orchestrator/security-verifier-agent.ts.
 *
 * Mocks the loop/client per the security-auditor-agent.test.ts convention
 * (loopSpy, clientSpy, resolveModel, assembleSystemPrompt, tools/index).
 * Uses the REAL resolveRoleTools/ROLE_TOOLS (only graph state stubbed) so
 * the read-only-toolset assertions exercise the genuine role->tool mapping,
 * not a fixture that could silently drift out of sync with tools/index.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDefaultConfig } from "../config/schema.js";
import type { BoberConfig, SecuritySection } from "../config/schema.js";
import type * as ToolsIndexModule from "./tools/index.js";
import type { SecurityFinding } from "./security-audit-types.js";
import type { AuditDiff } from "./security-knowledge/diff-provider.js";

// ── Mock heavy dependencies ────────────────────────────────────────

const loopSpy = vi.fn();
const clientSpy = vi.fn(() => ({}) as never);

vi.mock("./agentic-loop.js", () => ({ runAgenticLoop: loopSpy }));
vi.mock("../providers/factory.js", () => ({ createClient: clientSpy }));
vi.mock("./model-resolver.js", () => ({ resolveModel: (choice: string) => choice }));
vi.mock("./agent-loader.js", () => ({ assembleSystemPrompt: vi.fn().mockResolvedValue("SYS") }));
vi.mock("./tools/index.js", async () => {
  const actual = await vi.importActual<typeof ToolsIndexModule>("./tools/index.js");
  return {
    ...actual,
    getGraphState: () => ({ graphEnabled: false, engineHealth: "disabled" }),
    getGraphDeps: () => undefined,
  };
});

const { runSecurityVerifier, parseVerifierResult } = await import("./security-verifier-agent.js");

// ── Fixtures ────────────────────────────────────────────────────────

const fullSecurityDefaults: SecuritySection = {
  enabled: true,
  failClosed: true,
  timeoutMs: 300_000,
  model: "opus",
  maxTurns: 20,
  scanners: [],
  standaloneBlockOn: "critical",
  hub: true,
  verifier: { enabled: true, model: "opus", maxTurns: 10 },
};

function makeConfig(overrides?: { security?: Partial<SecuritySection> }): BoberConfig {
  const base = createDefaultConfig("test-project", "brownfield");
  return {
    ...base,
    security: { ...fullSecurityDefaults, ...overrides?.security },
  };
}

function loopResult(finalText: string, extra?: Record<string, unknown>) {
  return {
    finalText,
    turnsUsed: 1,
    toolsCalled: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: "end_turn" as const,
    ...extra,
  };
}

const criticalFinding: SecurityFinding = {
  description: "Reentrancy in withdraw()",
  evidence: [{ path: "contracts/Vault.sol", line: 42, snippet: 'call{value: amount}("")' }],
  vulnClass: "privilege-escalation",
};

const importantFinding: SecurityFinding = {
  description: "Weak input validation on amount",
  evidence: [{ path: "contracts/Vault.sol", line: 20, snippet: "uint256 amount" }],
};

const testDiff: AuditDiff = {
  changedFiles: [
    {
      path: "contracts/Vault.sol",
      status: "modified",
      hunks: [
        {
          startLine: 40,
          lineCount: 5,
          content:
            '@@ -40,3 +40,5 @@\n function withdraw() external {\n+    call{value: amount}("");\n }',
        },
      ],
    },
  ],
  neighborhoodFiles: [],
  truncated: false,
};

beforeEach(() => {
  loopSpy.mockReset();
  clientSpy.mockClear();
});

// ── sc-8-1/sc-8-2: verify() runs its own loop, read-only, contract-free ──

describe("runSecurityVerifier.verify — sc-8-1/sc-8-2 read-only, contract-free loop", () => {
  it("resolves VerifierResult{ran:true} bucketing confirmed/downgraded/disproved verdicts", async () => {
    loopSpy.mockResolvedValueOnce(
      loopResult(
        JSON.stringify([
          { index: 0, verdict: "confirmed", confidence: "high", reason: "re-checked, holds" },
          { index: 1, verdict: "disproved", confidence: "high", reason: "input is validated upstream" },
        ]),
      ),
    );

    const config = makeConfig();
    const result = await runSecurityVerifier.verify({
      findings: [criticalFinding, importantFinding],
      diff: testDiff,
      projectRoot: "/tmp/project",
      config,
      signal: new AbortController().signal,
    });

    expect(result.ran).toBe(true);
    expect(result.verified).toEqual([criticalFinding]);
    expect(result.dropped).toEqual([importantFinding]);
    expect(result.downgraded).toEqual([]);
  });

  it("runs its own runAgenticLoop call with the curator read-only toolset (no bash/write/edit)", async () => {
    loopSpy.mockResolvedValueOnce(loopResult("[]"));

    const config = makeConfig();
    await runSecurityVerifier.verify({
      findings: [criticalFinding],
      diff: undefined,
      projectRoot: "/tmp/project",
      config,
      signal: new AbortController().signal,
    });

    expect(loopSpy).toHaveBeenCalledTimes(1);
    const toolNames = (loopSpy.mock.calls[0][0].tools as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).toEqual(expect.arrayContaining(["read_file", "glob", "grep"]));
    expect(toolNames).not.toContain("bash");
    expect(toolNames).not.toContain("write_file");
    expect(toolNames).not.toContain("edit_file");

    const toolHandlers = loopSpy.mock.calls[0][0].toolHandlers as Map<string, unknown>;
    expect(toolHandlers.has("bash")).toBe(false);
    expect(toolHandlers.has("write_file")).toBe(false);
    expect(toolHandlers.has("edit_file")).toBe(false);
    expect(toolHandlers.has("read_file")).toBe(true);
  });

  it("passes config.security.verifier.model/maxTurns (not the finder's) to createClient/runAgenticLoop", async () => {
    loopSpy.mockResolvedValueOnce(loopResult("[]"));

    const config = makeConfig({
      security: { model: "opus", maxTurns: 20, verifier: { enabled: true, model: "sonnet", maxTurns: 3 } },
    });
    await runSecurityVerifier.verify({
      findings: [criticalFinding],
      diff: undefined,
      projectRoot: "/tmp/project",
      config,
      signal: new AbortController().signal,
    });

    expect(clientSpy).toHaveBeenCalledWith(null, null, undefined, "sonnet", "SecurityVerifier");
    expect(loopSpy.mock.calls[0][0].maxTurns).toBe(3);
  });

  it("the sprint contract text is provably ABSENT from the verifier user message", async () => {
    loopSpy.mockResolvedValueOnce(loopResult("[]"));

    const config = makeConfig();
    await runSecurityVerifier.verify({
      findings: [criticalFinding],
      diff: testDiff,
      projectRoot: "/tmp/project",
      config,
      signal: new AbortController().signal,
    });

    const userMessage = loopSpy.mock.calls[0][0].userMessage as string;
    expect(userMessage).not.toContain("Sprint Contract");
    expect(userMessage).not.toContain("Already Passed");
    expect(userMessage).not.toContain("Evaluation Result");
    expect(userMessage).not.toContain("estimatedFiles");
    expect(userMessage).not.toContain("successCriteria");
    // The findings + diff evidence ARE present — this is what the verifier re-checks:
    expect(userMessage).toContain("Reentrancy in withdraw()");
    expect(userMessage).toContain("contracts/Vault.sol");
    expect(userMessage).toContain("# Changed files (real diff)");
  });

  it("passes the caller's abortSignal through to runAgenticLoop", async () => {
    loopSpy.mockResolvedValueOnce(loopResult("[]"));

    const config = makeConfig();
    const controller = new AbortController();
    await runSecurityVerifier.verify({
      findings: [criticalFinding],
      diff: undefined,
      projectRoot: "/tmp/project",
      config,
      signal: controller.signal,
    });

    expect(loopSpy.mock.calls[0][0].abortSignal).toBe(controller.signal);
  });
});

// ── empty findings input ─────────────────────────────────────────────

describe("runSecurityVerifier.verify — empty findings input", () => {
  it("returns ran:true with all empty buckets and never calls runAgenticLoop or createClient", async () => {
    const config = makeConfig();
    const result = await runSecurityVerifier.verify({
      findings: [],
      diff: undefined,
      projectRoot: "/tmp/project",
      config,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ verified: [], downgraded: [], dropped: [], ran: true });
    expect(loopSpy).not.toHaveBeenCalled();
    expect(clientSpy).not.toHaveBeenCalled();
  });
});

// ── sc-8-3: fail-closed ─────────────────────────────────────────────

describe("runSecurityVerifier.verify — sc-8-3 fail-closed", () => {
  it("garbage/unparseable prose response => ran:false, empty buckets", async () => {
    loopSpy.mockResolvedValueOnce(loopResult("sorry, I cannot help with that."));

    const config = makeConfig();
    const result = await runSecurityVerifier.verify({
      findings: [criticalFinding],
      diff: undefined,
      projectRoot: "/tmp/project",
      config,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ verified: [], downgraded: [], dropped: [], ran: false });
  });

  it("a JSON object instead of an array => ran:false (mirror image of the auditor's array rejection)", async () => {
    loopSpy.mockResolvedValueOnce(loopResult(JSON.stringify({ index: 0, verdict: "confirmed" })));

    const config = makeConfig();
    const result = await runSecurityVerifier.verify({
      findings: [criticalFinding],
      diff: undefined,
      projectRoot: "/tmp/project",
      config,
      signal: new AbortController().signal,
    });

    expect(result.ran).toBe(false);
  });

  it("truncated JSON => ran:false", async () => {
    loopSpy.mockResolvedValueOnce(loopResult('[{"index":0,"verdict":"confirmed"'));

    const config = makeConfig();
    const result = await runSecurityVerifier.verify({
      findings: [criticalFinding],
      diff: undefined,
      projectRoot: "/tmp/project",
      config,
      signal: new AbortController().signal,
    });

    expect(result.ran).toBe(false);
  });

  it("stopReason:'aborted' => ran:false, criticals implicitly kept (empty buckets)", async () => {
    loopSpy.mockResolvedValueOnce(loopResult("[]", { stopReason: "aborted" }));

    const config = makeConfig();
    const result = await runSecurityVerifier.verify({
      findings: [criticalFinding],
      diff: undefined,
      projectRoot: "/tmp/project",
      config,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ verified: [], downgraded: [], dropped: [], ran: false });
  });

  it("stopReason:'error' => ran:false", async () => {
    loopSpy.mockResolvedValueOnce(loopResult("[]", { stopReason: "error" }));

    const config = makeConfig();
    const result = await runSecurityVerifier.verify({
      findings: [criticalFinding],
      diff: undefined,
      projectRoot: "/tmp/project",
      config,
      signal: new AbortController().signal,
    });

    expect(result.ran).toBe(false);
  });

  it("refused:true => ran:false", async () => {
    loopSpy.mockResolvedValueOnce(loopResult("[]", { refused: true }));

    const config = makeConfig();
    const result = await runSecurityVerifier.verify({
      findings: [criticalFinding],
      diff: undefined,
      projectRoot: "/tmp/project",
      config,
      signal: new AbortController().signal,
    });

    expect(result.ran).toBe(false);
  });

  it("a provider/network error thrown by runAgenticLoop => ran:false (never propagates a crash out of the opt-in stage)", async () => {
    loopSpy.mockRejectedValueOnce(new Error("provider down"));

    const config = makeConfig();
    const result = await runSecurityVerifier.verify({
      findings: [criticalFinding],
      diff: undefined,
      projectRoot: "/tmp/project",
      config,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ verified: [], downgraded: [], dropped: [], ran: false });
  });
});

// ── parseVerifierResult — direct unit coverage ─────────────────────

describe("parseVerifierResult", () => {
  const findings: SecurityFinding[] = [criticalFinding, importantFinding];

  it("buckets findings by 0-based index", () => {
    const text = JSON.stringify([
      { index: 0, verdict: "downgraded" },
      { index: 1, verdict: "confirmed" },
    ]);
    const result = parseVerifierResult(text, findings);

    expect(result.ran).toBe(true);
    expect(result.downgraded).toEqual([criticalFinding]);
    expect(result.verified).toEqual([importantFinding]);
    expect(result.dropped).toEqual([]);
  });

  it("matches by signatureId when index is absent", () => {
    const withSig: SecurityFinding = { ...criticalFinding, signatureId: "sig-1" };
    const text = JSON.stringify([{ signatureId: "sig-1", verdict: "disproved" }]);
    const result = parseVerifierResult(text, [withSig]);

    expect(result.dropped).toEqual([withSig]);
  });

  it("matches by path+line when index/signatureId are absent", () => {
    const text = JSON.stringify([{ path: "contracts/Vault.sol", line: 42, verdict: "disproved" }]);
    const result = parseVerifierResult(text, [criticalFinding]);

    expect(result.dropped).toEqual([criticalFinding]);
  });

  it("a finding never addressed by the response defaults to verified (fail-closed, never silently dropped)", () => {
    const text = JSON.stringify([{ index: 0, verdict: "disproved" }]); // findings[1] unaddressed
    const result = parseVerifierResult(text, findings);

    expect(result.dropped).toEqual([criticalFinding]);
    expect(result.verified).toEqual([importantFinding]);
  });

  it("an unrecognized verdict string leaves the finding unaddressed (defaults to verified)", () => {
    const text = JSON.stringify([{ index: 0, verdict: "maybe" }]);
    const result = parseVerifierResult(text, [criticalFinding]);

    expect(result.verified).toEqual([criticalFinding]);
    expect(result.dropped).toEqual([]);
    expect(result.downgraded).toEqual([]);
  });

  it("extracts a JSON array from a markdown-fenced response", () => {
    const fenced = "Here you go:\n```json\n" + JSON.stringify([{ index: 0, verdict: "confirmed" }]) + "\n```";
    const result = parseVerifierResult(fenced, [criticalFinding]);

    expect(result.ran).toBe(true);
    expect(result.verified).toEqual([criticalFinding]);
  });

  it("returns ran:false with empty buckets on non-JSON prose", () => {
    const result = parseVerifierResult("I cannot comply.", findings);
    expect(result).toEqual({ verified: [], downgraded: [], dropped: [], ran: false });
  });

  it("returns ran:false on truncated JSON", () => {
    const result = parseVerifierResult('[{"index":0,"verdict":"confirmed"', findings);
    expect(result.ran).toBe(false);
  });

  it("returns ran:false when the JSON parses but is an object, not an array (mirror of the auditor's inverse rule)", () => {
    const result = parseVerifierResult(JSON.stringify({ index: 0, verdict: "confirmed" }), findings);
    expect(result.ran).toBe(false);
  });
});
