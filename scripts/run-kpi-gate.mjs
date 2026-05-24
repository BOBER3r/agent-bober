#!/usr/bin/env node
/**
 * KPI Gate (Sprint 7) — Go/No-Go for Sprints 8-10.
 *
 * Reads token-usage data (real or fixture), computes per-role percent
 * reduction (baseline vs graph-enabled), writes a structured report to
 * .bober/graph/kpi-gate-report.json, and exits:
 *   - 0  on pass (reduction.combined >= threshold)
 *   - 2  on fail
 *   - 1  on script error (cannot read fixtures, invalid env, etc.)
 *
 * Default threshold: 40. Override with env KPI_GATE_THRESHOLD.
 *
 * Modes:
 *   1. Fixture mode (auto when --use-fixtures, KPI_FIXTURE_FILE, or any
 *      KPI_*_TOKENS_* env var is set):
 *        - Reads token data from KPI_FIXTURE_FILE (default:
 *          .bober/graph/token-usage.jsonl), OR
 *        - Reads directly from env: KPI_BASELINE_TOKENS_RESEARCHER_PHASE2,
 *          KPI_BASELINE_TOKENS_CURATOR, KPI_BASELINE_TOKENS_ARCHITECT,
 *          KPI_GATED_TOKENS_RESEARCHER_PHASE2, KPI_GATED_TOKENS_CURATOR,
 *          KPI_GATED_TOKENS_ARCHITECT (and the matching *_TURNS_* counts).
 *   2. Real-pipeline mode (default when no fixture flags/env): TODO —
 *      run the benchmark contract twice via runPipeline(). Deferred to
 *      manual post-merge runs (per orchestrator autonomous-mode rule).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const ROLES = ["researcher-phase2", "curator", "architect"];
const DEFAULT_THRESHOLD = 40;
const DIVERGENCE_PCT = 10; // s7-c9: turn-count vs token-count divergence flag

function envInt(name, fallback) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function tokensEnvFor(prefix, role) {
  // KPI_BASELINE_TOKENS_RESEARCHER_PHASE2, KPI_GATED_TOKENS_CURATOR, etc.
  const upper = role.toUpperCase().replace(/-/g, "_");
  return envInt(`${prefix}_${upper}`, undefined);
}

function turnsEnvFor(prefix, role) {
  const upper = role.toUpperCase().replace(/-/g, "_");
  return envInt(`${prefix}_TURNS_${upper}`, undefined);
}

function shouldUseFixtures(argv) {
  if (argv.includes("--use-fixtures")) return true;
  if (process.env.KPI_FIXTURE_FILE) return true;
  for (const role of ROLES) {
    if (tokensEnvFor("KPI_BASELINE_TOKENS", role) !== undefined) return true;
    if (tokensEnvFor("KPI_GATED_TOKENS", role) !== undefined) return true;
  }
  return false;
}

async function loadFixtureRecords(filePath) {
  // Read JSONL — one record per line, same shape as src/graph/token-usage.ts.
  const raw = await readFile(filePath, "utf-8");
  const records = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      records.push(JSON.parse(t));
    } catch {
      // Skip malformed lines (incidents.jsonl style — never throw).
    }
  }
  return records;
}

function aggregateRecords(records) {
  // Returns: { baseline: {role: {tokens, turns}}, gated: {...} }
  // tokens = inputTokens + outputTokens, turns = count of records per role.
  const out = { baseline: {}, gated: {} };
  for (const role of ROLES) {
    out.baseline[role] = { tokens: 0, turns: 0 };
    out.gated[role] = { tokens: 0, turns: 0 };
  }
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    if (!ROLES.includes(r.agent)) continue;
    const bucket = r.graphEnabled === true ? out.gated : out.baseline;
    const slot = bucket[r.agent];
    slot.tokens += (r.inputTokens ?? 0) + (r.outputTokens ?? 0);
    slot.turns += 1;
  }
  return out;
}

function overrideWithEnv(agg) {
  // Env vars take precedence over JSONL fixture for explicit pass/fail cases.
  for (const role of ROLES) {
    const bTok = tokensEnvFor("KPI_BASELINE_TOKENS", role);
    if (bTok !== undefined) agg.baseline[role].tokens = bTok;
    const gTok = tokensEnvFor("KPI_GATED_TOKENS", role);
    if (gTok !== undefined) agg.gated[role].tokens = gTok;
    const bTurns = turnsEnvFor("KPI_BASELINE", role);
    if (bTurns !== undefined) agg.baseline[role].turns = bTurns;
    const gTurns = turnsEnvFor("KPI_GATED", role);
    if (gTurns !== undefined) agg.gated[role].turns = gTurns;
  }
  return agg;
}

function pct(baseline, gated) {
  if (!Number.isFinite(baseline) || baseline <= 0) return 0;
  return Number((((baseline - gated) / baseline) * 100).toFixed(2));
}

function computeReduction(agg) {
  const reduction = {};
  let totalBaseline = 0;
  let weightedSum = 0;
  for (const role of ROLES) {
    const b = agg.baseline[role].tokens;
    const g = agg.gated[role].tokens;
    reduction[role] = pct(b, g);
    totalBaseline += b;
    weightedSum += (b - g);
  }
  reduction.combined = totalBaseline > 0
    ? Number(((weightedSum / totalBaseline) * 100).toFixed(2))
    : 0;
  return reduction;
}

function computeTurnDelta(agg) {
  const delta = {};
  for (const role of ROLES) {
    delta[role] = pct(agg.baseline[role].turns, agg.gated[role].turns);
  }
  return delta;
}

function hasDivergence(reduction, turnDelta) {
  // s7-c9: if turn-delta and token-delta differ by >10 pp for any gated role,
  // flag for human review.
  for (const role of ROLES) {
    if (Math.abs(reduction[role] - turnDelta[role]) > DIVERGENCE_PCT) return true;
  }
  return false;
}

function buildRecommendations(report) {
  const lines = [];
  if (report.gatePass) return lines;
  const arch = ".bober/architecture/arch-20260524-port-code-review-graph-architecture.md";
  lines.push(`Combined reduction ${report.reduction.combined}% is below threshold ${report.threshold}%.`);
  lines.push(`Review per-role deltas: researcher-phase2=${report.reduction["researcher-phase2"]}%, curator=${report.reduction.curator}%, architect=${report.reduction.architect}%.`);
  lines.push(`Open questions on budget tuning: see ${arch} (preflight-budgets section).`);
  lines.push(`Consider: (a) raising per-role token budgets, (b) tightening QUERY_BATCHES, (c) adding graph_review_context calls in agent prompts.`);
  return lines;
}

async function main() {
  const argv = process.argv.slice(2);
  const threshold = envInt("KPI_GATE_THRESHOLD", DEFAULT_THRESHOLD);

  let agg;
  if (shouldUseFixtures(argv)) {
    const fixturePath = process.env.KPI_FIXTURE_FILE
      ?? resolve(ROOT, ".bober/graph/token-usage.jsonl");
    let records = [];
    try {
      records = await loadFixtureRecords(fixturePath);
    } catch (err) {
      // Missing fixture file is OK when env overrides will fill the values.
      if (err && err.code !== "ENOENT") throw err;
    }
    agg = aggregateRecords(records);
    agg = overrideWithEnv(agg);
  } else {
    console.error("Real-pipeline KPI mode not implemented in this script. Use --use-fixtures or env overrides.");
    console.error("TODO: invoke runPipeline twice (graphEnabled=false, then graphEnabled=true) against tests/benchmarks/curator-benchmark-contract.json.");
    process.exit(1);
  }

  const reduction = computeReduction(agg);
  const turnDelta = computeTurnDelta(agg);
  const divergenceFlag = hasDivergence(reduction, turnDelta);
  const gatePass = reduction.combined >= threshold;

  const report = {
    baseline: {
      "researcher-phase2": agg.baseline["researcher-phase2"].tokens,
      curator: agg.baseline.curator.tokens,
      architect: agg.baseline.architect.tokens,
    },
    gated: {
      "researcher-phase2": agg.gated["researcher-phase2"].tokens,
      curator: agg.gated.curator.tokens,
      architect: agg.gated.architect.tokens,
    },
    reduction, // includes researcher-phase2, curator, architect, combined
    turnCounts: {
      baseline: {
        "researcher-phase2": agg.baseline["researcher-phase2"].turns,
        curator: agg.baseline.curator.turns,
        architect: agg.baseline.architect.turns,
      },
      gated: {
        "researcher-phase2": agg.gated["researcher-phase2"].turns,
        curator: agg.gated.curator.turns,
        architect: agg.gated.architect.turns,
      },
    },
    turnCountDelta: turnDelta,
    divergenceFlag,
    gatePass,
    threshold,
    timestamp: new Date().toISOString(),
    recommendations: undefined, // filled below
  };
  report.recommendations = buildRecommendations(report);

  const outPath = resolve(ROOT, ".bober/graph/kpi-gate-report.json");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(report, null, 2) + "\n", "utf-8");

  console.log(`KPI gate: ${gatePass ? "PASS" : "FAIL"} (combined=${reduction.combined}%, threshold=${threshold}%)`);
  console.log(`Report: ${outPath}`);
  if (divergenceFlag) {
    console.warn("Warning: TURNCOUNT_DIVERGENCE — turn-count and token-count reductions diverge by >10pp on at least one role.");
  }

  process.exit(gatePass ? 0 : 2);
}

main().catch((err) => {
  console.error("KPI gate script error:", err);
  process.exit(1);
});
