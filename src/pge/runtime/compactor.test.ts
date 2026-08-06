import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChatParams, ChatResponse, LLMClient } from "../../providers/types.js";
import type { GraphMessage } from "../state/overall.js";
import {
  COMPACTION_TRIGGER_RATIO,
  ContextSummaryInvalidError,
  ContextSummarySchema,
  REINJECTION_RATIO,
  compactGraphContext,
  compactionMessageId,
  decideCompaction,
  parseContextSummary,
  renderContextSummary,
  renderTranscriptJsonl,
  selectTail,
  transcriptLogPath,
  writeTranscript,
} from "./compactor.js";
import type { ContextSummary } from "./compactor.js";
import { createCharsPerTokenEstimator } from "./token-estimator.js";

/**
 * Graph-scoped compaction: the threshold, the summary schema, the re-injection baseline
 * and the byte-recoverable transcript.
 *
 * Real temp directories and real writes. The only stand-in is the `LLMClient`, which is
 * the OUT-OF-PROCESS collaborator this module is defined against, not the thing under
 * test — every call it receives is recorded and asserted, so "one tool-free call" is a
 * measured fact rather than a shape the test assumes.
 *
 * ── Mutation-proven ──
 *
 * This suite was run against three deliberate breakages and failed on each:
 *  - writing the transcript AFTER the summarisation call (the recovered bytes then
 *    contained the summary message the transcript is supposed to predate);
 *  - `decideCompaction` summing `GraphMessage.tokens` instead of estimating over text
 *    (the estimator swap then changed nothing and the 84/86 pair collapsed);
 *  - `ContextSummarySchema.workspacePath` declared `.optional()` (the missing-path
 *    fixture then validated and the baseline was computed over a summary nobody could
 *    locate).
 */

const EST = createCharsPerTokenEstimator(4);
const CAP = 10_000;
const RUN = "run-compactor";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-compactor-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 400 chars = exactly 100 tokens under chars/4, so a count of messages is a percentage. */
function message(index: number): GraphMessage {
  const id = `m-pred-${String(index).padStart(3, "0")}`;
  const head = `${id}: `;
  const text = head + "x".repeat(400 - head.length);
  return { id, seq: index, role: "assistant", nodeId: "producer", text, tokens: text.length };
}

function window(count: number): GraphMessage[] {
  return Array.from({ length: count }, (_, i) => message(i));
}

function summaryFixture(): ContextSummary {
  return {
    activeGoals: ["Land the Engram context layer", "Keep the imperative compactor untouched"],
    completedTasks: ["Wrote the phase digest schema", "Wired the superstep threshold"],
    workspacePath: "/tmp/engram-workspace",
  };
}

interface RecordingClient extends LLMClient {
  readonly calls: ChatParams[];
}

function scriptedClient(reply: unknown, options: { throws?: Error } = {}): RecordingClient {
  const calls: ChatParams[] = [];
  return {
    calls,
    async chat(params: ChatParams): Promise<ChatResponse> {
      calls.push(params);
      if (options.throws) throw options.throws;
      return {
        text: typeof reply === "string" ? reply : JSON.stringify(reply),
        toolCalls: [],
        stopReason: "end",
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    },
  };
}

// ── Threshold ───────────────────────────────────────────────────────

describe("decideCompaction: the trigger is a fraction of the cap, computed by the estimator", () => {
  it("fires strictly above floor(cap * 0.85) and not at or below it", () => {
    expect(COMPACTION_TRIGGER_RATIO).toBe(0.85);

    const under = decideCompaction(window(84), CAP, EST);
    const over = decideCompaction(window(86), CAP, EST);

    expect(under.threshold).toBe(8500);
    expect(over.threshold).toBe(8500);
    expect(under.tokens).toBe(8400);
    expect(over.tokens).toBe(8600);
    expect(under.shouldCompact).toBe(false);
    expect(over.shouldCompact).toBe(true);
  });

  it("a window sitting exactly on the threshold does not compact", () => {
    expect(decideCompaction(window(85), CAP, EST).tokens).toBe(8500);
    expect(decideCompaction(window(85), CAP, EST).shouldCompact).toBe(false);
  });

  it("the trigger ratio is configurable and moves the threshold", () => {
    expect(decideCompaction(window(84), CAP, EST, 0.8).shouldCompact).toBe(true);
    expect(decideCompaction(window(86), CAP, EST, 0.9).shouldCompact).toBe(false);
  });

  it("refuses a cap that is not a positive finite number", () => {
    expect(() => decideCompaction(window(1), 0, EST)).toThrow(/greater than zero/);
    expect(() => decideCompaction(window(1), Number.NaN, EST)).toThrow(/greater than zero/);
  });
});

// ── sc-10-7 ─────────────────────────────────────────────────────────

describe("sc-10-7: the summary schema requires activeGoals, completedTasks and workspacePath", () => {
  it("a fixture summary missing workspacePath fails validation, naming the path", () => {
    const { workspacePath: _dropped, ...missing } = summaryFixture();

    const result = ContextSummarySchema.safeParse(missing);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((i) => i.path.join("."))).toContain("workspacePath");
  });

  it("positive control: a complete summary validates", () => {
    expect(ContextSummarySchema.safeParse(summaryFixture()).success).toBe(true);
    expect(parseContextSummary(summaryFixture())).toEqual(summaryFixture());
  });

  it.each([
    ["activeGoals is absent", { activeGoals: undefined }],
    ["activeGoals is empty", { activeGoals: [] }],
    ["activeGoals holds only blanks", { activeGoals: [""] }],
    ["completedTasks is empty", { completedTasks: [] }],
    ["workspacePath is blank", { workspacePath: "" }],
  ])("refuses a summary where %s", (_label, patch) => {
    const payload: Record<string, unknown> = { ...summaryFixture(), ...patch };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete payload[key];
    }
    expect(ContextSummarySchema.safeParse(payload).success).toBe(false);
  });

  it("parseContextSummary throws with the failing Zod paths rather than swallowing them", () => {
    let caught: unknown;
    try {
      parseContextSummary({ activeGoals: ["g"], completedTasks: ["t"] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ContextSummaryInvalidError);
    expect((caught as ContextSummaryInvalidError).paths).toContain("workspacePath");
  });

  it("a malformed summary from the model is a THROW, not a fail-open skip", async () => {
    const client = scriptedClient({ activeGoals: ["g"], completedTasks: ["t"] });
    await expect(
      compactGraphContext({
        client,
        model: "stub",
        messages: window(86),
        cap: CAP,
        estimator: EST,
        projectRoot: root,
        runId: RUN,
        index: 0,
      }),
    ).rejects.toThrow(ContextSummaryInvalidError);
  });
});

// ── sc-10-8 ─────────────────────────────────────────────────────────

describe("sc-10-8: the post-compression baseline and the byte-recoverable transcript", () => {
  async function compact(): Promise<{
    client: RecordingClient;
    outcome: Awaited<ReturnType<typeof compactGraphContext>>;
  }> {
    const client = scriptedClient(summaryFixture());
    const outcome = await compactGraphContext({
      client,
      model: "stub-frontier",
      messages: window(86),
      cap: CAP,
      estimator: EST,
      projectRoot: root,
      runId: RUN,
      index: 0,
    });
    return { client, outcome };
  }

  it("the baseline is the summary plus roughly one tenth of the cap", async () => {
    const { outcome } = await compact();
    expect(outcome.kind).toBe("compacted");
    if (outcome.kind !== "compacted") return;

    expect(REINJECTION_RATIO).toBe(0.1);
    const reinjection = Math.floor(CAP * REINJECTION_RATIO);
    expect(outcome.reinjectionBudget).toBe(reinjection);

    const centre = outcome.summaryTokens + reinjection;
    // Tolerance band: +/- 15% of the re-injection budget (150 tokens either side). Wide
    // rather than tight, per the stop condition — a criterion that needed a real
    // tokenizer to separate pass from fail would have to widen the band, never add a
    // dependency. The observed value sits at the centre under chars/4.
    const slack = Math.ceil(reinjection * 0.15);
    expect(outcome.baselineTokens).toBeGreaterThanOrEqual(centre - slack);
    expect(outcome.baselineTokens).toBeLessThanOrEqual(centre + slack);

    // And the baseline is measured on the WINDOW, not on the channel: it is a small
    // fraction of the 8600 tokens that went in.
    expect(outcome.baselineTokens).toBeLessThan(outcome.decision.tokens / 4);
  });

  it("the tail is the most RECENT messages, whole, inside the re-injection budget", async () => {
    const { outcome } = await compact();
    if (outcome.kind !== "compacted") throw new Error("expected a compaction");

    expect(outcome.tail).toHaveLength(10);
    expect(outcome.tail.map((m) => m.id)).toEqual(
      window(86)
        .slice(-10)
        .map((m) => m.id),
    );
    expect(outcome.tailTokens).toBeLessThanOrEqual(outcome.reinjectionBudget);
  });

  it("the transcript on disk equals BYTE FOR BYTE what was written, no JSON round-trip", async () => {
    const { outcome } = await compact();
    if (outcome.kind !== "compacted") throw new Error("expected a compaction");

    expect(outcome.transcriptPath).toBe(join(root, ".bober", "logs", RUN, "messages-0.jsonl"));
    expect(outcome.transcriptPath).toBe(transcriptLogPath(root, RUN, 0));

    // The comparison is on the exact string, not on `JSON.parse` deep-equality: a parse
    // would pass against a file whose key order, whitespace or line endings had drifted.
    const onDisk = await readFile(outcome.transcriptPath, "utf8");
    expect(onDisk).toBe(outcome.transcriptBytes);
    expect(onDisk).toBe(renderTranscriptJsonl(window(86)));
    expect(onDisk.split("\n").filter((l) => l.length > 0)).toHaveLength(86);
  });

  it("the transcript predates the summary: none of the summary's bytes are in it", async () => {
    const { outcome } = await compact();
    if (outcome.kind !== "compacted") throw new Error("expected a compaction");

    const onDisk = await readFile(outcome.transcriptPath, "utf8");
    // Written BEFORE the model was called, so nothing the model produced can be in it.
    expect(onDisk).not.toContain(outcome.summaryMessage.id);
    expect(onDisk).not.toContain(outcome.summary.workspacePath);
    expect(onDisk).not.toContain("[Context summary]");
    // Positive control: it DOES contain every pre-compression message.
    for (const m of window(86)) expect(onDisk).toContain(m.id);
  });

  it("the transcript is fully recoverable: every message parses back to what went in", async () => {
    const { outcome } = await compact();
    if (outcome.kind !== "compacted") throw new Error("expected a compaction");

    const recovered = (await readFile(outcome.transcriptPath, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as GraphMessage);
    expect(recovered).toEqual(window(86));
  });

  it("exactly one tool-free, bounded summarisation call is made", async () => {
    const { client, outcome } = await compact();
    if (outcome.kind !== "compacted") throw new Error("expected a compaction");

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].tools).toBeUndefined();
    expect(client.calls[0].maxTokens).toBe(4096);
    expect(client.calls[0].model).toBe("stub-frontier");
  });

  it("the summary comes back as a NEW message with a deterministic id", async () => {
    const { outcome } = await compact();
    if (outcome.kind !== "compacted") throw new Error("expected a compaction");

    expect(outcome.summaryMessage.id).toBe(compactionMessageId(0));
    expect(outcome.summaryMessage.seq).toBe(85 + 1);
    expect(outcome.summaryMessage.text).toBe(renderContextSummary(outcome.summary));
    expect(outcome.summaryMessage.tokens).toBe(outcome.summaryTokens);
  });
});

describe("below the threshold, nothing at all is written", () => {
  it("returns below-threshold and leaves no .bober/logs tree and no chat call", async () => {
    const client = scriptedClient(summaryFixture());
    const outcome = await compactGraphContext({
      client,
      model: "stub",
      messages: window(84),
      cap: CAP,
      estimator: EST,
      projectRoot: root,
      runId: RUN,
      index: 0,
    });

    expect(outcome.kind).toBe("below-threshold");
    expect(client.calls).toEqual([]);
    await expect(readdir(join(root, ".bober", "logs"))).rejects.toThrow(/ENOENT/);
  });
});

describe("fail-open is scoped to the summarisation CALL", () => {
  it("a throwing client degrades the run and still leaves the transcript on disk", async () => {
    const client = scriptedClient(summaryFixture(), { throws: new Error("provider unreachable") });
    const outcome = await compactGraphContext({
      client,
      model: "stub",
      messages: window(86),
      cap: CAP,
      estimator: EST,
      projectRoot: root,
      runId: RUN,
      index: 3,
    });

    expect(outcome.kind).toBe("summariser-unavailable");
    if (outcome.kind !== "summariser-unavailable") return;
    expect(outcome.reason).toBe("provider unreachable");
    // The transcript was written BEFORE the call, so the case where compaction failed is
    // exactly the case where the full history is still recoverable.
    expect(await readFile(outcome.transcriptPath, "utf8")).toBe(renderTranscriptJsonl(window(86)));
    expect(outcome.transcriptPath).toBe(transcriptLogPath(root, RUN, 3));
  });
});

describe("renderTranscriptJsonl / writeTranscript", () => {
  it("emits fixed key order, one object per line, trailing newline", () => {
    const rendered = renderTranscriptJsonl([message(0), message(1)]);
    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered.split("\n").filter((l) => l.length > 0)).toHaveLength(2);
    expect(rendered.startsWith('{"id":"m-pred-000","seq":0,"role":"assistant","nodeId":"producer","tokens":400,"text":')).toBe(
      true,
    );
  });

  it("omits absent optional keys rather than emitting nulls", () => {
    const bare: GraphMessage = { id: "a", seq: 0, role: "user", nodeId: "n", tokens: 0 };
    expect(renderTranscriptJsonl([bare])).toBe(
      '{"id":"a","seq":0,"role":"user","nodeId":"n","tokens":0}\n',
    );
  });

  it("an empty message list renders to an empty file, not to a blank line", async () => {
    const written = await writeTranscript(root, RUN, 7, []);
    expect(written.bytes).toBe("");
    expect(await readFile(written.path, "utf8")).toBe("");
  });

  it("refuses a negative or fractional compaction index", () => {
    expect(() => transcriptLogPath(root, RUN, -1)).toThrow(RangeError);
    expect(() => transcriptLogPath(root, RUN, 1.5)).toThrow(RangeError);
  });

  it("refuses a runId that is not a safe path segment", () => {
    expect(() => transcriptLogPath(root, "../escape", 0)).toThrow();
  });
});

describe("selectTail admits only whole messages", () => {
  it("stops before a message that would overflow the budget", () => {
    // Budget 1000 tokens; each message is 100. The eleventh would take it to 1100.
    const selected = selectTail(window(86), CAP, EST);
    expect(selected.budget).toBe(1000);
    expect(selected.tokens).toBe(1000);
    expect(selected.tail).toHaveLength(10);
  });

  it("returns an empty tail rather than half a message when nothing fits", () => {
    const selected = selectTail(window(5), 100, EST);
    expect(selected.budget).toBe(10);
    expect(selected.tail).toEqual([]);
    expect(selected.tokens).toBe(0);
  });
});
