/**
 * Unit tests for `AiVisibilityScorer` (in-house-ai-visibility, Sprint 5;
 * sc-5-1, sc-5-2).
 *
 * Pure/synchronous — no fakes needed beyond plain `AiVisibilityRow` object
 * literals (mirrors mention-citation-extractor.test.ts:8-17).
 */
import { describe, it, expect } from "vitest";

import { AiVisibilityScorer } from "./ai-visibility-scorer.js";
import type { AiVisibilityRow } from "./data-source.js";

const scorer = new AiVisibilityScorer();

function row(over: Partial<AiVisibilityRow> = {}): AiVisibilityRow {
  return {
    prompt: "p1",
    provider: "perplexity",
    mentioned: false,
    citationPresent: false,
    sourceUrls: [],
    ...over,
  };
}

// ── sc-5-1: grouping, empty input, degenerate single-sample CI ─────────

describe("AiVisibilityScorer.aggregate — grouping (sc-5-1)", () => {
  it("empty input yields []", () => {
    expect(scorer.aggregate([])).toEqual([]);
  });

  it("groups strictly by prompt+provider — two providers for the same prompt yield TWO metrics, never merged", () => {
    const rows: AiVisibilityRow[] = [
      row({ prompt: "best crypto casino", provider: "perplexity", mentioned: true }),
      row({ prompt: "best crypto casino", provider: "chatgpt", mentioned: false }),
    ];

    const metrics = scorer.aggregate(rows);

    expect(metrics).toHaveLength(2);
    const providers = metrics.map((m) => m.provider).sort();
    expect(providers).toEqual(["chatgpt", "perplexity"]);
    for (const m of metrics) {
      expect(m.prompt).toBe("best crypto casino");
      expect(m.samples).toBe(1);
    }
  });

  it("groups multiple rows for the SAME prompt+provider into one metric with samples = row count", () => {
    const rows: AiVisibilityRow[] = [
      row({ prompt: "p1", provider: "perplexity", mentioned: true }),
      row({ prompt: "p1", provider: "perplexity", mentioned: false }),
      row({ prompt: "p1", provider: "perplexity", mentioned: true }),
    ];

    const metrics = scorer.aggregate(rows);

    expect(metrics).toHaveLength(1);
    expect(metrics[0].samples).toBe(3);
    expect(metrics[0].mentionRate).toBeCloseTo(2 / 3, 10);
  });

  it("a different prompt with the same provider yields a separate metric (prompt is also part of the key)", () => {
    const rows: AiVisibilityRow[] = [
      row({ prompt: "p1", provider: "perplexity", mentioned: true }),
      row({ prompt: "p2", provider: "perplexity", mentioned: false }),
    ];

    const metrics = scorer.aggregate(rows);

    expect(metrics).toHaveLength(2);
    const prompts = metrics.map((m) => m.prompt).sort();
    expect(prompts).toEqual(["p1", "p2"]);
  });

  it("single sample yields a degenerate CI [rate, rate] (mentioned:true -> [1,1])", () => {
    const metrics = scorer.aggregate([row({ mentioned: true })]);
    expect(metrics).toHaveLength(1);
    expect(metrics[0].samples).toBe(1);
    expect(metrics[0].mentionRate).toBe(1);
    expect(metrics[0].mentionRateCi95).toEqual([1, 1]);
  });

  it("single sample yields a degenerate CI [rate, rate] (mentioned:false -> [0,0])", () => {
    const metrics = scorer.aggregate([row({ mentioned: false })]);
    expect(metrics[0].mentionRate).toBe(0);
    expect(metrics[0].mentionRateCi95).toEqual([0, 0]);
  });

  it("computes mentionRate and citationRate independently", () => {
    const rows: AiVisibilityRow[] = [
      row({ mentioned: true, citationPresent: false }),
      row({ mentioned: true, citationPresent: true }),
      row({ mentioned: false, citationPresent: true }),
      row({ mentioned: false, citationPresent: false }),
    ];
    const [metric] = scorer.aggregate(rows);
    expect(metric.mentionRate).toBeCloseTo(0.5, 10);
    expect(metric.citationRate).toBeCloseTo(0.5, 10);
  });

  it("omits meanRank entirely when no row in the group has a rank (Pattern B — never sets undefined)", () => {
    const [metric] = scorer.aggregate([row(), row()]);
    expect("meanRank" in metric).toBe(false);
  });

  it("includes meanRank as the mean of only the rows that carry one", () => {
    const rows: AiVisibilityRow[] = [
      row({ rank: 2 }),
      row({ rank: 4 }),
      row(), // no rank — excluded from the mean, not treated as 0
    ];
    const [metric] = scorer.aggregate(rows);
    expect(metric.meanRank).toBe(3);
  });

  it("deduplicates sourceUrls across the group's rows, preserving first-seen order", () => {
    const rows: AiVisibilityRow[] = [
      row({ sourceUrls: ["https://a.example/1", "https://b.example/2"] }),
      row({ sourceUrls: ["https://b.example/2", "https://c.example/3"] }),
    ];
    const [metric] = scorer.aggregate(rows);
    expect(metric.sourceUrls).toEqual(["https://a.example/1", "https://b.example/2", "https://c.example/3"]);
  });
});

// ── sc-5-2: Wilson 95% CI hand-checked + purity/never-throws ───────────

describe("AiVisibilityScorer.aggregate — Wilson 95% CI (sc-5-2)", () => {
  it("hand-checked value: k=7, n=10 -> CI ~= [0.396772, 0.892206]", () => {
    const rows: AiVisibilityRow[] = [
      ...Array.from({ length: 7 }, () => row({ mentioned: true })),
      ...Array.from({ length: 3 }, () => row({ mentioned: false })),
    ];

    const [metric] = scorer.aggregate(rows);

    expect(metric.samples).toBe(10);
    expect(metric.mentionRate).toBeCloseTo(0.7, 10);
    expect(metric.mentionRateCi95[0]).toBeCloseTo(0.3968, 4);
    expect(metric.mentionRateCi95[1]).toBeCloseTo(0.8922, 4);
  });

  it("all-mentioned rows (k=n) yield a CI bounded within [0,1]", () => {
    const rows: AiVisibilityRow[] = Array.from({ length: 5 }, () => row({ mentioned: true }));
    const [metric] = scorer.aggregate(rows);
    expect(metric.mentionRateCi95[0]).toBeGreaterThanOrEqual(0);
    expect(metric.mentionRateCi95[1]).toBeLessThanOrEqual(1);
    expect(metric.mentionRateCi95[0]).toBeLessThanOrEqual(metric.mentionRateCi95[1]);
  });

  it("all-false rows (k=0) yield a CI bounded within [0,1] with lower bound 0", () => {
    const rows: AiVisibilityRow[] = Array.from({ length: 5 }, () => row({ mentioned: false }));
    const [metric] = scorer.aggregate(rows);
    expect(metric.mentionRate).toBe(0);
    expect(metric.mentionRateCi95[0]).toBeGreaterThanOrEqual(0);
    expect(metric.mentionRateCi95[1]).toBeLessThanOrEqual(1);
  });

  it("is deterministic across repeated calls on the same input (no RNG, no Date)", () => {
    const rows: AiVisibilityRow[] = [
      row({ mentioned: true, provider: "perplexity" }),
      row({ mentioned: false, provider: "perplexity" }),
      row({ mentioned: true, provider: "chatgpt" }),
    ];

    const first = scorer.aggregate(rows);
    const second = scorer.aggregate(rows);

    expect(first).toEqual(second);
  });

  it("never throws over garbage-ish inputs: empty prompt/provider strings", () => {
    expect(() => scorer.aggregate([row({ prompt: "", provider: "" })])).not.toThrow();
    const [metric] = scorer.aggregate([row({ prompt: "", provider: "" })]);
    expect(metric.prompt).toBe("");
    expect(metric.provider).toBe("");
  });

  it("never throws over a large, mixed batch of rows across many prompts/providers", () => {
    const prompts = ["prompt-0", "prompt-1", "prompt-2", "prompt-3"];
    const providers = ["perplexity", "chatgpt"];
    const rows: AiVisibilityRow[] = [];
    let i = 0;
    for (const prompt of prompts) {
      for (const provider of providers) {
        // Multiple rows per (prompt,provider) arm — each arm still folds to ONE metric.
        for (let sample = 0; sample < 3; sample += 1) {
          rows.push(
            row({
              prompt,
              provider,
              mentioned: i % 3 === 0,
              citationPresent: i % 5 === 0,
              rank: i % 2 === 0 ? i : undefined,
            }),
          );
          i += 1;
        }
      }
    }
    expect(() => scorer.aggregate(rows)).not.toThrow();
    const metrics = scorer.aggregate(rows);
    // 4 prompts x 2 providers = 8 arms, never merged.
    expect(metrics).toHaveLength(8);
  });
});
