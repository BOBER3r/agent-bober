/**
 * Tests for graph-preflight run-level telemetry.
 *
 * These prove the runtime-audit question — "is the graph actually being used?"
 * — is answerable from .bober/history.jsonl. Every agent spawn under an enabled
 * graph leaves a `graph-preflight` row recording injected-vs-skipped, the
 * approx tokens of context added, the outcome, and the elapsed time.
 *
 * The engine is never "ready" in a unit test (the pipeline-lifecycle singleton
 * is un-started), so inject() deterministically takes the
 * "skipped-engine-not-ready" branch — the simplest telemetry path to assert
 * without standing up a real tokensave engine.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PreflightContextInjector } from "./preflight-injector.js";
import { loadHistory } from "../state/history.js";
import type { GraphClient } from "./client.js";
import type { GraphSection } from "./types.js";
import type { SprintContract } from "../contracts/sprint-contract.js";

// Non-null client → passes the "no-client" guard. Its methods are never called
// because the engine-not-ready branch returns before runInject().
const fakeClient = {} as unknown as GraphClient;

function enabledConfig(): GraphSection {
  return { enabled: true } as unknown as GraphSection;
}

function contract(id: string): SprintContract {
  return { contractId: id } as unknown as SprintContract;
}

describe("PreflightContextInjector graph-preflight telemetry", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bober-preflight-tel-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("records a graph-preflight row (never blocking the spawn)", async () => {
    const injector = new PreflightContextInjector(
      fakeClient,
      enabledConfig(),
      undefined,
      root,
    );

    const out = await injector.inject("generator", contract("sprint-1"), "ORIGINAL");

    // Spawn is never blocked: the first message is returned unchanged.
    expect(out).toBe("ORIGINAL");

    const entries = await loadHistory(root);
    const row = entries.find((e) => e.event === "graph-preflight");
    expect(row).toBeDefined();
    expect(row!.phase).toBe("generating");
    expect(row!.sprintId).toBe("sprint-1");
    expect(row!.details.role).toBe("generator");
    expect(row!.details.outcome).toBe("skipped-engine-not-ready");
    expect(row!.details.injected).toBe(false);
    expect(row!.details.approxTokensAdded).toBe(0);
    expect(typeof row!.details.elapsedMs).toBe("number");
    expect(typeof row!.details.budgetTokens).toBe("number");
  });

  it("maps each role to the correct pipeline phase", async () => {
    const injector = new PreflightContextInjector(
      fakeClient,
      enabledConfig(),
      undefined,
      root,
    );
    await injector.inject("curator", contract("s-c"), "M");
    await injector.inject("evaluator", contract("s-e"), "M");

    const entries = await loadHistory(root);
    const phases = entries
      .filter((e) => e.event === "graph-preflight")
      .map((e) => `${String(e.details.role)}:${e.phase}`);
    expect(phases).toContain("curator:curating");
    expect(phases).toContain("evaluator:evaluating");
  });

  it("resolves the project root from the lifecycle singleton when not passed", async () => {
    // No projectRoot in the constructor — the common call-site shape. Telemetry
    // should still NOT throw (it silently no-ops when no root is resolvable).
    const injector = new PreflightContextInjector(fakeClient, enabledConfig());
    const out = await injector.inject("curator", contract("s-1"), "MSG");
    expect(out).toBe("MSG");
    // With an un-started singleton there is no resolvable root, so nothing is
    // written to OUR temp dir — and crucially, no error was thrown.
    const entries = await loadHistory(root);
    expect(entries.length).toBe(0);
  });

  it("writes NOTHING when the graph is disabled (zero-overhead opt-in)", async () => {
    const injector = new PreflightContextInjector(
      fakeClient,
      { enabled: false } as unknown as GraphSection,
      undefined,
      root,
    );

    const out = await injector.inject("generator", contract("sprint-x"), "ORIGINAL");
    expect(out).toBe("ORIGINAL");

    let raw = "";
    try {
      raw = await readFile(join(root, ".bober", "history.jsonl"), "utf-8");
    } catch {
      raw = "";
    }
    expect(raw).toBe("");
  });
});
