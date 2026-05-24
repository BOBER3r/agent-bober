import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT = resolve(REPO_ROOT, "scripts/run-kpi-gate.mjs");

function runScript(
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveP) => {
    const child = spawn("node", [SCRIPT, "--use-fixtures"], {
      env: { ...process.env, ...env, NO_COLOR: "1" },
      cwd: REPO_ROOT,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code: number | null) => resolveP({ code: code ?? 1, stdout, stderr }));
  });
}

describe("scripts/run-kpi-gate.mjs (fixture mode)", () => {
  let originalReport: string | null = null;
  const reportPath = resolve(REPO_ROOT, ".bober/graph/kpi-gate-report.json");

  beforeEach(async () => {
    try {
      originalReport = await readFile(reportPath, "utf-8");
    } catch {
      originalReport = null;
    }
  });

  afterEach(async () => {
    if (originalReport !== null) {
      await writeFile(reportPath, originalReport, "utf-8");
    }
  });

  it("PASS case: baseline=10000, gated=4000 → reduction 60% → exit 0", async () => {
    const env: Record<string, string> = {
      KPI_BASELINE_TOKENS_RESEARCHER_PHASE2: "10000",
      KPI_BASELINE_TOKENS_CURATOR: "10000",
      KPI_BASELINE_TOKENS_ARCHITECT: "10000",
      KPI_GATED_TOKENS_RESEARCHER_PHASE2: "4000",
      KPI_GATED_TOKENS_CURATOR: "4000",
      KPI_GATED_TOKENS_ARCHITECT: "4000",
    };
    const { code } = await runScript(env);
    expect(code).toBe(0);
    const report = JSON.parse(await readFile(reportPath, "utf-8")) as Record<string, unknown>;
    expect(report.gatePass).toBe(true);
    expect(report.threshold).toBe(40);
    expect(report.reduction).toMatchObject({ combined: 60 });
  }, 15000);

  it("FAIL case: baseline=10000, gated=7000 → reduction 30% → exit 2", async () => {
    const env: Record<string, string> = {
      KPI_BASELINE_TOKENS_RESEARCHER_PHASE2: "10000",
      KPI_BASELINE_TOKENS_CURATOR: "10000",
      KPI_BASELINE_TOKENS_ARCHITECT: "10000",
      KPI_GATED_TOKENS_RESEARCHER_PHASE2: "7000",
      KPI_GATED_TOKENS_CURATOR: "7000",
      KPI_GATED_TOKENS_ARCHITECT: "7000",
    };
    const { code } = await runScript(env);
    expect(code).toBe(2);
    const report = JSON.parse(await readFile(reportPath, "utf-8")) as Record<string, unknown>;
    expect(report.gatePass).toBe(false);
    expect(report.reduction).toMatchObject({ combined: 30 });
    expect(Array.isArray(report.recommendations)).toBe(true);
    expect((report.recommendations as unknown[]).length).toBeGreaterThan(0);
  }, 15000);

  it("threshold env override: KPI_GATE_THRESHOLD=25 flips FAIL→PASS", async () => {
    const env: Record<string, string> = {
      KPI_BASELINE_TOKENS_RESEARCHER_PHASE2: "10000",
      KPI_BASELINE_TOKENS_CURATOR: "10000",
      KPI_BASELINE_TOKENS_ARCHITECT: "10000",
      KPI_GATED_TOKENS_RESEARCHER_PHASE2: "7000",
      KPI_GATED_TOKENS_CURATOR: "7000",
      KPI_GATED_TOKENS_ARCHITECT: "7000",
      KPI_GATE_THRESHOLD: "25",
    };
    const { code } = await runScript(env);
    expect(code).toBe(0);
  }, 15000);

  it("divergence flag fires when turn delta and token delta diverge >10pp", async () => {
    const env: Record<string, string> = {
      KPI_BASELINE_TOKENS_RESEARCHER_PHASE2: "10000",
      KPI_BASELINE_TOKENS_CURATOR: "10000",
      KPI_BASELINE_TOKENS_ARCHITECT: "10000",
      KPI_GATED_TOKENS_RESEARCHER_PHASE2: "4000",
      KPI_GATED_TOKENS_CURATOR: "4000",
      KPI_GATED_TOKENS_ARCHITECT: "4000",
      KPI_BASELINE_TURNS_RESEARCHER_PHASE2: "25",
      KPI_GATED_TURNS_RESEARCHER_PHASE2: "24", // ~4% turn delta vs 60% token delta → divergence
      KPI_BASELINE_TURNS_CURATOR: "25",
      KPI_GATED_TURNS_CURATOR: "5",
      KPI_BASELINE_TURNS_ARCHITECT: "10",
      KPI_GATED_TURNS_ARCHITECT: "4",
    };
    const { code } = await runScript(env);
    expect(code).toBe(0);
    const report = JSON.parse(await readFile(reportPath, "utf-8")) as Record<string, unknown>;
    expect(report.divergenceFlag).toBe(true);
  }, 15000);
});
