// ── chat-session.test.ts ──────────────────────────────────────────────
//
// Tests for hub-scoped /priority and /decide slash commands in ChatSession.
// Uses temp dirs + ScriptedClient to avoid any network calls.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChatSession } from "./chat-session.js";
import type { LLMClient, ChatParams, ChatResponse } from "../providers/types.js";
import { FactStore, factsDbPath, ensureFactsDir } from "../state/facts.js";
import { HUB_SCOPE } from "../hub/finding-source.js";

// ── Throwing LLMClient (must NOT be called for gated no-op) ──────────

class ThrowingClient implements LLMClient {
  async chat(_p: ChatParams): Promise<ChatResponse> {
    throw new Error("LLMClient must NOT be called");
  }
}

// ── ScriptedClient ────────────────────────────────────────────────────

/**
 * Returns scripted responses in order; repeats the last entry once exhausted.
 * Mirrors the pattern in src/hub/judge.test.ts.
 */
class ScriptedClient implements LLMClient {
  private idx = 0;
  constructor(private readonly responses: string[]) {}
  async chat(_p: ChatParams): Promise<ChatResponse> {
    const text = this.responses[Math.min(this.idx, this.responses.length - 1)] ?? "";
    this.idx += 1;
    return { text, toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────

const T = "2026-06-28T00:00:00.000Z";

function findingJson(id: string, title: string): string {
  return JSON.stringify({
    id,
    domain: "medical",
    title,
    kind: "action",
    urgency: 3,
    severity: 4,
    evidence: ["e"],
    surfacedAt: T,
    tags: ["x"],
    status: "open",
  });
}

/**
 * Seed a FactStore under <repoRoot>/.bober/memory/facts.db with hub findings.
 */
async function seedRepo(repoRoot: string, entries: [string, string][]): Promise<void> {
  await ensureFactsDir(repoRoot);
  const store = new FactStore(factsDbPath(repoRoot));
  for (const [id, title] of entries) {
    store.insertFact({
      scope: HUB_SCOPE,
      subject: id,
      predicate: "finding",
      value: findingJson(id, title),
      confidence: 1,
      sourceRunId: null,
      tValid: T,
      tCreated: T,
    });
  }
  store.close();
}

// ── Test setup ────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-hub-chat-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── sc-5-1: hub team namespace resolution ────────────────────────────

describe("sc-5-1: hub team namespace resolution via ChatSession", () => {
  it("ChatSession with memoryNamespace 'hub' is constructed (namespace threads correctly)", () => {
    const session = new ChatSession({
      llm: new ThrowingClient(),
      projectRoot: join(tmpDir, "hub-root"),
      sessionId: "t",
      memoryNamespace: "hub",
    });
    expect(session).toBeDefined();
  });

  it("loadTeam hub returns memoryNamespace 'hub' — wired by chat command", async () => {
    const { loadTeam } = await import("../teams/registry.js");
    const { createDefaultConfig } = await import("../config/schema.js");
    const config = createDefaultConfig("test", "greenfield");
    const team = loadTeam(config, "hub");
    expect(team.memoryNamespace).toBe("hub");
    expect(team.id).toBe("hub");
    // Confirm ChatSession accepts it
    const session = new ChatSession({
      llm: new ThrowingClient(),
      projectRoot: join(tmpDir, "root"),
      sessionId: "t",
      memoryNamespace: team.memoryNamespace || undefined,
    });
    expect(session).toBeDefined();
  });
});

// ── sc-5-2: /priority in a hub session ───────────────────────────────

describe("sc-5-2: /priority returns ranked summary in hub session", () => {
  it("returns ranked 'rank. title' lines for seeded findings", async () => {
    // projectRoot is a SUBDIR so resolveSiblingRepos scans its parent for kb-* siblings.
    const projectRoot = join(tmpDir, "hub-root");
    await mkdir(join(projectRoot, ".bober"), { recursive: true });

    // Seed sibling store with two findings (Alpha = higher scores, Beta = lower).
    await seedRepo(join(tmpDir, "kb-a"), [
      ["f-1", "Alpha"],
      ["f-2", "Beta"],
    ]);
    // Create kb-hub vault so priority.md write doesn't throw.
    await mkdir(join(tmpDir, "kb-hub"), { recursive: true });

    // ScriptedClient: general scope = 1 relevance call + 4 lens calls per finding.
    // f-1 (Alpha): relevant + 4 lens passes with high scores (9).
    // f-2 (Beta): relevant + 4 lens passes with low scores (3).
    const llm = new ScriptedClient([
      '{"relevant":true}', // f-1 relevance
      '{"relevant":true}', // f-2 relevance
      '{"include":true,"score":9}', // f-1 lens 1
      '{"include":true,"score":9}', // f-1 lens 2
      '{"include":true,"score":9}', // f-1 lens 3
      '{"include":true,"score":9}', // f-1 lens 4
      '{"include":true,"score":3}', // f-2 lens 1
      '{"include":true,"score":3}', // f-2 lens 2
      '{"include":true,"score":3}', // f-2 lens 3
      '{"include":true,"score":3}', // f-2 lens 4
    ]);

    const session = new ChatSession({ llm, projectRoot, sessionId: "t", memoryNamespace: "hub" });
    const reply = await session.handleTurn("/priority");

    expect(reply).toBeTruthy();
    expect(reply).toContain("1. Alpha");
    expect(reply).toContain("2. Beta");
  });

  it("returns 'No findings to prioritize.' when siblings have no findings", async () => {
    const projectRoot = join(tmpDir, "hub-root");
    await mkdir(join(projectRoot, ".bober"), { recursive: true });
    // No sibling repos seeded — resolveSiblingRepos returns [].

    // ScriptedClient: no LLM calls expected (no findings to rank).
    const llm = new ScriptedClient([]);

    const session = new ChatSession({ llm, projectRoot, sessionId: "t", memoryNamespace: "hub" });
    const reply = await session.handleTurn("/priority");

    expect(reply).toContain("No findings to prioritize.");
  });
});

// ── sc-5-3: /decide X vs Y in a hub session ──────────────────────────

describe("sc-5-3: /decide X vs Y returns decision-scoped ranking", () => {
  it("returns ranked summary for decision scope with 'X vs Y' expr", async () => {
    const projectRoot = join(tmpDir, "hub-root");
    await mkdir(join(projectRoot, ".bober"), { recursive: true });

    await seedRepo(join(tmpDir, "kb-b"), [["d-1", "Gamma"]]);
    await mkdir(join(tmpDir, "kb-hub"), { recursive: true });

    // Decision scope: 1 relevance call per finding (returns relevant + relevantTo optionA).
    // Then 4 lens calls.
    const llm = new ScriptedClient([
      '{"relevant":true,"relevantTo":"optionA"}', // d-1 relevance
      '{"include":true,"score":7}', // d-1 lens 1
      '{"include":true,"score":7}', // d-1 lens 2
      '{"include":true,"score":7}', // d-1 lens 3
      '{"include":true,"score":7}', // d-1 lens 4
    ]);

    const session = new ChatSession({ llm, projectRoot, sessionId: "t", memoryNamespace: "hub" });
    const reply = await session.handleTurn("/decide optionA vs optionB");

    expect(reply).toBeTruthy();
    expect(reply).toContain("1. Gamma");
  });

  it("returns usage hint when no 'vs' separator is provided", async () => {
    const projectRoot = join(tmpDir, "hub-root");
    await mkdir(join(projectRoot, ".bober"), { recursive: true });

    const session = new ChatSession({
      llm: new ThrowingClient(),
      projectRoot,
      sessionId: "t",
      memoryNamespace: "hub",
    });
    const reply = await session.handleTurn("/decide just-one-option");

    // The handler returns the "Expected 'X vs Y', got: ..." message (no LLM call).
    expect(reply).toContain("Expected 'X vs Y'");
  });

  it("returns 'No findings to prioritize.' when all findings are irrelevant to both options", async () => {
    const projectRoot = join(tmpDir, "hub-root");
    await mkdir(join(projectRoot, ".bober"), { recursive: true });
    await seedRepo(join(tmpDir, "kb-c"), [["d-2", "Delta"]]);

    // All findings dropped by relevance filter (neither).
    const llm = new ScriptedClient([
      '{"relevant":false,"relevantTo":"neither"}', // d-2 dropped
    ]);

    const session = new ChatSession({ llm, projectRoot, sessionId: "t", memoryNamespace: "hub" });
    const reply = await session.handleTurn("/decide A vs B");

    expect(reply).toContain("No findings to prioritize.");
  });
});

// ── sc-5-4: non-hub gate (ThrowingClient proves no LLM call) ─────────

describe("sc-5-4: /priority and /decide are no-ops for non-hub teams", () => {
  it("/priority returns informative no-op for a session with no memoryNamespace", async () => {
    const projectRoot = join(tmpDir, "hub-root");
    await mkdir(join(projectRoot, ".bober"), { recursive: true });

    // ThrowingClient: if LLM were called, this test would fail.
    const session = new ChatSession({
      llm: new ThrowingClient(),
      projectRoot,
      sessionId: "t",
      // no memoryNamespace → default programming team
    });
    const reply = await session.handleTurn("/priority");

    expect(reply).toContain("only available in the hub team");
  });

  it("/decide returns informative no-op for a session with no memoryNamespace", async () => {
    const projectRoot = join(tmpDir, "hub-root");
    await mkdir(join(projectRoot, ".bober"), { recursive: true });

    const session = new ChatSession({
      llm: new ThrowingClient(),
      projectRoot,
      sessionId: "t",
      // no memoryNamespace → default programming team
    });
    const reply = await session.handleTurn("/decide A vs B");

    expect(reply).toContain("only available in the hub team");
  });

  it("/priority no-op works for a named non-hub memoryNamespace", async () => {
    const projectRoot = join(tmpDir, "hub-root");
    await mkdir(join(projectRoot, ".bober"), { recursive: true });

    const session = new ChatSession({
      llm: new ThrowingClient(),
      projectRoot,
      sessionId: "t",
      memoryNamespace: "medical", // explicitly non-hub
    });
    const reply = await session.handleTurn("/priority");

    expect(reply).toContain("only available in the hub team");
  });
});

// ── sc-5-4 regression: existing commands still work ──────────────────

describe("sc-5-4 regression: existing slash commands byte-identical after hub additions", () => {
  it("/help returns the same output (contains all pre-existing commands)", async () => {
    const projectRoot = join(tmpDir, "root");
    await mkdir(join(projectRoot, ".bober"), { recursive: true });

    const session = new ChatSession({
      llm: new ThrowingClient(),
      projectRoot,
      sessionId: "t",
    });
    const reply = await session.handleTurn("/help");

    expect(reply).toContain("/runs");
    expect(reply).toContain("/stop");
    expect(reply).toContain("/careful");
    expect(reply).toContain("/approve");
    expect(reply).toContain("/reject");
    expect(reply).toContain("/tell");
    expect(reply).toContain("/pause");
    expect(reply).toContain("/resume");
    expect(reply).toContain("/help");
    expect(reply).toContain("/exit");
    // New hub commands intentionally NOT in /help
    expect(reply).not.toContain("/priority");
    expect(reply).not.toContain("/decide");
  });

  it("/exit still returns null (exit sentinel)", async () => {
    const projectRoot = join(tmpDir, "root");
    await mkdir(join(projectRoot, ".bober"), { recursive: true });

    const session = new ChatSession({
      llm: new ThrowingClient(),
      projectRoot,
      sessionId: "t",
    });
    const reply = await session.handleTurn("/exit");

    expect(reply).toBeNull();
  });
});
