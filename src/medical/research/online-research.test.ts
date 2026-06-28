/**
 * Tests for runResearchJob (online-research.ts).
 *
 * Covers:
 *   sc-5-2: axis OFF => {disabled:true}, no note written, MedlineSource never constructed/invoked
 *   sc-5-3: axis ON + grounded => note written under research/ with citation frontmatter
 *   sc-5-4: critic reject/abstain => no clinical note written, abstain recorded
 *   sc-5-5: cloud-inference OFF => factory called with local args (fail-closed)
 *   sc-5-6: summary counts { notesWritten, findingsWritten, disabled } match emissions
 *
 * All tests are fully offline: retriever is faked, synthesis uses ScriptedClient, no real network.
 * Temp vault dirs are created in beforeEach and removed in afterEach (keeps CI offline).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runResearchJob } from "./online-research.js";
import { MedlineSource } from "../retrieval/medline-source.js";
import { parseFrontmatter } from "../../vault/frontmatter.js";
import { createDefaultConfig } from "../../config/schema.js";
import type { LLMClient, ChatParams, ChatResponse } from "../../providers/types.js";
import type { RetrievalOutcome, Passage } from "../retrieval/medline-source.js";
import type { BoberConfig } from "../../config/schema.js";

// ── Fixtures / Fakes ──────────────────────────────────────────────────

const NOW = "2026-06-28T12:00:00.000Z";
const DATE = "2026-06-28";

const SAMPLE_PASSAGE: Passage = {
  title: "LDL Cholesterol — MedlinePlus",
  url: "https://medlineplus.gov/ldlcholesterol.html",
  text: "LDL cholesterol is the primary marker for cardiovascular risk.",
  source: "medlineplus",
};

const GROUNDED_OUTCOME: RetrievalOutcome = {
  kind: "grounded",
  passages: [SAMPLE_PASSAGE],
};

/** Approval JSON returned by the grounding critic. */
const APPROVE = '{"verdict":"approve","feedback":""}';
/** Rejection JSON returned by the grounding critic. */
const REJECT = '{"verdict":"reject","feedback":"Not sufficiently grounded in the passages."}';

/**
 * ScriptedClient — returns a queue of scripted responses in order.
 * Pattern from recommend.test.ts:28-38.
 * synthesizeGrounded makes: synth call, critic call (needs JSON).
 * Sequence for approve: ["<answer text>", APPROVE]
 * Sequence for double-reject (abstain): ["<answer text>", REJECT, "<answer2>", REJECT]
 */
class ScriptedClient implements LLMClient {
  readonly calls: ChatParams[] = [];
  private idx = 0;

  constructor(private readonly responses: string[]) {}

  async chat(p: ChatParams): Promise<ChatResponse> {
    this.calls.push(p);
    const text = this.responses[Math.min(this.idx, this.responses.length - 1)] ?? "";
    this.idx += 1;
    return { text, toolCalls: [], stopReason: "end", usage: { inputTokens: 3, outputTokens: 5 } };
  }
}

/** Build a config with literature-retrieval ON and cloud-inference OFF. */
function litOnCloudOff(): BoberConfig {
  const cfg = createDefaultConfig("test", "greenfield");
  cfg.medical = {
    egress: { cloudInference: false, literatureRetrieval: true, deviceConnection: false },
  };
  return cfg;
}

/** Build a config with both axes OFF (zero-egress). */
function allAxesOff(): BoberConfig {
  const cfg = createDefaultConfig("test", "greenfield");
  cfg.medical = {
    egress: { cloudInference: false, literatureRetrieval: false, deviceConnection: false },
  };
  return cfg;
}

/** Build a config with cloud-inference ON (allows cloud synthesis). */
function litOnCloudOn(): BoberConfig {
  const cfg = createDefaultConfig("test", "greenfield");
  cfg.medical = {
    egress: { cloudInference: true, literatureRetrieval: true, deviceConnection: false },
    inference: { provider: "anthropic", model: "claude-opus-4-8" },
  };
  return cfg;
}

/** Fake retriever returning grounded outcome. */
function groundedRetriever() {
  return { retrieve: vi.fn().mockResolvedValue(GROUNDED_OUTCOME) };
}

/** Fake writeFinding that records calls but does not touch the filesystem. */
function makeFakeWriteFinding() {
  return vi.fn().mockResolvedValue("/fake/findings/abc.md");
}

// ── Temp vault fixture ────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-research-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ── sc-5-2: axis OFF => zero-egress ───────────────────────────────────

describe("sc-5-2: literature-retrieval axis OFF", () => {
  it("returns { disabled: true, notesWritten: 0, findingsWritten: 0 }", async () => {
    const retrieveSpy = vi.fn();
    const summary = await runResearchJob(
      tmpRoot,
      allAxesOff(),
      { markers: ["ldl"], now: NOW },
      { retriever: { retrieve: retrieveSpy } },
    );

    expect(summary).toEqual({ disabled: true, notesWritten: 0, findingsWritten: 0 });
  });

  it("NEVER invokes the injected retriever when axis is OFF", async () => {
    const retrieveSpy = vi.fn();
    await runResearchJob(
      tmpRoot,
      allAxesOff(),
      { markers: ["ldl"], now: NOW },
      { retriever: { retrieve: retrieveSpy } },
    );

    expect(retrieveSpy).not.toHaveBeenCalled();
  });

  it("NEVER invokes MedlineSource.fetchPassages when axis is OFF", async () => {
    const mlSpy = vi.spyOn(MedlineSource.prototype, "fetchPassages");

    await runResearchJob(
      tmpRoot,
      allAxesOff(),
      { markers: ["ldl"], now: NOW },
    );

    expect(mlSpy).not.toHaveBeenCalled();
    mlSpy.mockRestore();
  });

  it("writes NO files to the research directory when axis is OFF", async () => {
    await runResearchJob(
      tmpRoot,
      allAxesOff(),
      { markers: ["ldl"], now: NOW },
    );

    const vaultResearch = join(tmpRoot, ".bober", "medical", "vault", "research");
    const files = await readdir(vaultResearch).catch(() => []);
    expect(files).toEqual([]);
  });
});

// ── sc-5-3: axis ON + grounded => note with citation frontmatter ───────

describe("sc-5-3: grounded outcome => research note with citation frontmatter", () => {
  it("writes a research note under <vault>/research/<date>-<marker>.md", async () => {
    const scripted = new ScriptedClient([
      "LDL is a key cardiovascular risk marker.",
      APPROVE,
    ]);
    const fakeWriteFinding = makeFakeWriteFinding();

    const summary = await runResearchJob(
      tmpRoot,
      litOnCloudOff(),
      { markers: ["ldl"], now: NOW },
      {
        retriever: groundedRetriever(),
        llmClient: scripted,
        writeFindingFn: fakeWriteFinding,
      },
    );

    expect(summary.disabled).toBe(false);
    expect(summary.notesWritten).toBeGreaterThanOrEqual(1);

    const notePath = join(
      tmpRoot,
      ".bober",
      "medical",
      "vault",
      "research",
      `${DATE}-ldl.md`,
    );
    const raw = await readFile(notePath, "utf-8");
    expect(raw.length).toBeGreaterThan(0);
  });

  it("research note frontmatter contains source: medlineplus", async () => {
    const scripted = new ScriptedClient([
      "LDL is a key cardiovascular risk marker.",
      APPROVE,
    ]);
    const fakeWriteFinding = makeFakeWriteFinding();

    await runResearchJob(
      tmpRoot,
      litOnCloudOff(),
      { markers: ["ldl"], now: NOW },
      {
        retriever: groundedRetriever(),
        llmClient: scripted,
        writeFindingFn: fakeWriteFinding,
      },
    );

    const notePath = join(
      tmpRoot,
      ".bober",
      "medical",
      "vault",
      "research",
      `${DATE}-ldl.md`,
    );
    const raw = await readFile(notePath, "utf-8");
    const { frontmatter } = parseFrontmatter(raw);

    expect(frontmatter["source"]).toBe("medlineplus");
  });

  it("research note frontmatter contains citationUrls with passage url", async () => {
    const scripted = new ScriptedClient([
      "LDL is a key cardiovascular risk marker.",
      APPROVE,
    ]);
    const fakeWriteFinding = makeFakeWriteFinding();

    await runResearchJob(
      tmpRoot,
      litOnCloudOff(),
      { markers: ["ldl"], now: NOW },
      {
        retriever: groundedRetriever(),
        llmClient: scripted,
        writeFindingFn: fakeWriteFinding,
      },
    );

    const notePath = join(
      tmpRoot,
      ".bober",
      "medical",
      "vault",
      "research",
      `${DATE}-ldl.md`,
    );
    const raw = await readFile(notePath, "utf-8");
    const { frontmatter } = parseFrontmatter(raw);

    const urls = frontmatter["citationUrls"] as string[];
    expect(Array.isArray(urls)).toBe(true);
    expect(urls).toContain(SAMPLE_PASSAGE.url);
  });

  it("research note frontmatter contains citationTitles with passage title", async () => {
    const scripted = new ScriptedClient([
      "LDL is a key cardiovascular risk marker.",
      APPROVE,
    ]);
    const fakeWriteFinding = makeFakeWriteFinding();

    await runResearchJob(
      tmpRoot,
      litOnCloudOff(),
      { markers: ["ldl"], now: NOW },
      {
        retriever: groundedRetriever(),
        llmClient: scripted,
        writeFindingFn: fakeWriteFinding,
      },
    );

    const notePath = join(
      tmpRoot,
      ".bober",
      "medical",
      "vault",
      "research",
      `${DATE}-ldl.md`,
    );
    const raw = await readFile(notePath, "utf-8");
    const { frontmatter } = parseFrontmatter(raw);

    const titles = frontmatter["citationTitles"] as string[];
    expect(Array.isArray(titles)).toBe(true);
    expect(titles).toContain(SAMPLE_PASSAGE.title);
  });

  it("note does NOT contain [object Object] (citation flattening pitfall)", async () => {
    const scripted = new ScriptedClient([
      "LDL is a key cardiovascular risk marker.",
      APPROVE,
    ]);
    const fakeWriteFinding = makeFakeWriteFinding();

    await runResearchJob(
      tmpRoot,
      litOnCloudOff(),
      { markers: ["ldl"], now: NOW },
      {
        retriever: groundedRetriever(),
        llmClient: scripted,
        writeFindingFn: fakeWriteFinding,
      },
    );

    const notePath = join(
      tmpRoot,
      ".bober",
      "medical",
      "vault",
      "research",
      `${DATE}-ldl.md`,
    );
    const raw = await readFile(notePath, "utf-8");
    expect(raw).not.toContain("[object Object]");
  });
});

// ── sc-5-4: critic reject => abstain, no note ─────────────────────────

describe("sc-5-4: critic reject => no clinical note, abstain recorded", () => {
  it("writes NO research note when the grounding critic rejects twice", async () => {
    // ScriptedClient sequence: synth1, reject1, synth2, reject2 -> abstain
    const scripted = new ScriptedClient([
      "Some answer about ldl.",
      REJECT,
      "A revised answer about ldl.",
      REJECT,
    ]);
    const fakeWriteFinding = makeFakeWriteFinding();

    const summary = await runResearchJob(
      tmpRoot,
      litOnCloudOff(),
      { markers: ["ldl"], now: NOW },
      {
        retriever: groundedRetriever(),
        llmClient: scripted,
        writeFindingFn: fakeWriteFinding,
      },
    );

    expect(summary.notesWritten).toBe(0);

    const vaultResearch = join(tmpRoot, ".bober", "medical", "vault", "research");
    const files = await readdir(vaultResearch).catch(() => []);
    expect(files).toEqual([]);
  });

  it("does NOT call writeFinding when abstained (no uncited synthesis persisted)", async () => {
    const scripted = new ScriptedClient([
      "Some answer.",
      REJECT,
      "Revised answer.",
      REJECT,
    ]);
    const fakeWriteFinding = makeFakeWriteFinding();

    await runResearchJob(
      tmpRoot,
      litOnCloudOff(),
      { markers: ["ldl"], now: NOW },
      {
        retriever: groundedRetriever(),
        llmClient: scripted,
        writeFindingFn: fakeWriteFinding,
      },
    );

    expect(fakeWriteFinding).not.toHaveBeenCalled();
  });

  it("summary.findingsWritten is 0 when all markers abstain", async () => {
    const scripted = new ScriptedClient([
      "Some answer.",
      REJECT,
      "Revised answer.",
      REJECT,
    ]);
    const fakeWriteFinding = makeFakeWriteFinding();

    const summary = await runResearchJob(
      tmpRoot,
      litOnCloudOff(),
      { markers: ["ldl"], now: NOW },
      {
        retriever: groundedRetriever(),
        llmClient: scripted,
        writeFindingFn: fakeWriteFinding,
      },
    );

    expect(summary.findingsWritten).toBe(0);
    expect(summary.disabled).toBe(false);
  });
});

// ── sc-5-5: cloud-inference OFF => local synthesis client ─────────────

describe("sc-5-5: cloud-inference OFF => fail-closed to local model", () => {
  it("factory called with local openai-compat/localhost/llama3 when cloud-inference is OFF", async () => {
    // Config: cloud inference provider set to anthropic, but cloud-inference axis is OFF
    const cfg = createDefaultConfig("test", "greenfield");
    cfg.medical = {
      egress: { cloudInference: false, literatureRetrieval: true, deviceConnection: false },
      inference: { provider: "anthropic", model: "claude-opus-4-8" },
    };

    const scripted = new ScriptedClient(["LDL answer.", APPROVE]);
    const fakeWriteFinding = makeFakeWriteFinding();

    const factorySpy = vi.fn(() => scripted);

    await runResearchJob(
      tmpRoot,
      cfg,
      { markers: ["ldl"], now: NOW },
      {
        retriever: groundedRetriever(),
        clientFactory: factorySpy,
        writeFindingFn: fakeWriteFinding,
      },
    );

    // Must have been called with local defaults (fail-closed)
    expect(factorySpy).toHaveBeenCalledWith(
      "openai-compat",
      "http://localhost:11434/v1",
      undefined,
      "llama3",
    );
    // Must NOT have been called with anthropic (cloud provider)
    expect(factorySpy).not.toHaveBeenCalledWith(
      "anthropic",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("factory called with cloud provider when cloud-inference is ON", async () => {
    const scripted = new ScriptedClient(["LDL answer.", APPROVE]);
    const fakeWriteFinding = makeFakeWriteFinding();
    const factorySpy = vi.fn(() => scripted);

    await runResearchJob(
      tmpRoot,
      litOnCloudOn(),
      { markers: ["ldl"], now: NOW },
      {
        retriever: groundedRetriever(),
        clientFactory: factorySpy,
        writeFindingFn: fakeWriteFinding,
      },
    );

    // When cloud-inference is ON and provider=anthropic, factory must be called with "anthropic"
    expect(factorySpy).toHaveBeenCalledTimes(1);
    expect(factorySpy.mock.calls[0]?.[0]).toBe("anthropic");
    // Must NOT have been called with the local openai-compat/localhost fallback
    expect(factorySpy).not.toHaveBeenCalledWith(
      "openai-compat",
      "http://localhost:11434/v1",
      undefined,
      "llama3",
    );
  });
});

// ── sc-5-6: summary counts ────────────────────────────────────────────

describe("sc-5-6: summary counts { notesWritten, findingsWritten, disabled }", () => {
  it("returns { disabled: true, notesWritten: 0, findingsWritten: 0 } when axis is OFF", async () => {
    const summary = await runResearchJob(
      tmpRoot,
      allAxesOff(),
      { markers: ["ldl"], now: NOW },
    );

    expect(summary).toEqual({ disabled: true, notesWritten: 0, findingsWritten: 0 });
  });

  it("returns { disabled: false, notesWritten: 1, findingsWritten: 1 } for one approved marker", async () => {
    const scripted = new ScriptedClient(["LDL answer.", APPROVE]);
    const fakeWriteFinding = makeFakeWriteFinding();

    const summary = await runResearchJob(
      tmpRoot,
      litOnCloudOff(),
      { markers: ["ldl"], now: NOW },
      {
        retriever: groundedRetriever(),
        llmClient: scripted,
        writeFindingFn: fakeWriteFinding,
      },
    );

    expect(summary).toEqual({ disabled: false, notesWritten: 1, findingsWritten: 1 });
  });

  it("counts correctly across multiple markers (2 approved, 1 abstained)", async () => {
    // 3 markers, each needs: synth + approve
    // ldl: approved, hdl: approved, a1c: double-rejected -> abstained
    const scripted = new ScriptedClient([
      "LDL answer.", APPROVE,
      "HDL answer.", APPROVE,
      "A1C answer.", REJECT, "A1C revised.", REJECT,
    ]);
    const fakeWriteFinding = makeFakeWriteFinding();

    const summary = await runResearchJob(
      tmpRoot,
      litOnCloudOff(),
      { markers: ["ldl", "hdl", "a1c"], now: NOW },
      {
        retriever: groundedRetriever(),
        llmClient: scripted,
        writeFindingFn: fakeWriteFinding,
      },
    );

    expect(summary.disabled).toBe(false);
    expect(summary.notesWritten).toBe(2);
    expect(summary.findingsWritten).toBe(2);
  });

  it("returns notesWritten: 0 when all markers abstain due to disabled outcome", async () => {
    const disabledRetriever = {
      retrieve: vi.fn().mockResolvedValue({ kind: "disabled" } as RetrievalOutcome),
    };
    const scripted = new ScriptedClient([]);
    const fakeWriteFinding = makeFakeWriteFinding();

    const summary = await runResearchJob(
      tmpRoot,
      litOnCloudOff(),
      { markers: ["ldl"], now: NOW },
      {
        retriever: disabledRetriever,
        llmClient: scripted,
        writeFindingFn: fakeWriteFinding,
      },
    );

    expect(summary.disabled).toBe(false);
    expect(summary.notesWritten).toBe(0);
    expect(summary.findingsWritten).toBe(0);
  });
});
