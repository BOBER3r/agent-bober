/**
 * Unit tests for generator-agent's fail-closed refusal guard (sprint-1: sc-1-4, sc-1-5).
 *
 * `parseGeneratorResult` is exported specifically so this guard can be
 * unit-tested directly without mocking the whole agentic loop.
 */

import { describe, it, expect } from "vitest";
import { parseGeneratorResult } from "./generator-agent.js";

const loop = { turnsUsed: 1, toolsCalled: [], usage: { inputTokens: 0, outputTokens: 0 } };

describe("parseGeneratorResult — refusal fail-closed guard", () => {
  it("sc-1-4: refused overrides the filesWritten success shortcut", () => {
    const files = new Set(["src/a.ts"]); // non-empty → would be success:true without the guard
    const res = parseGeneratorResult("I refuse to do this.", files, { ...loop, refused: true });

    expect(res.success).toBe(false);
    expect(res.notes.toLowerCase()).toContain("refus");
    expect(res.filesChanged).toEqual(["src/a.ts"]);
  });

  it("sc-1-4: refused overrides even a well-formed success report", () => {
    const files = new Set<string>();
    const reportText = JSON.stringify({ success: true, notes: "all good", filesChanged: [] });
    const res = parseGeneratorResult(reportText, files, { ...loop, refused: true });

    expect(res.success).toBe(false);
    expect(res.notes.toLowerCase()).toContain("refus");
  });

  it("sc-1-5: without refused, filesWritten still yields success:true (byte-identical)", () => {
    const files = new Set(["src/a.ts"]);
    const res = parseGeneratorResult("not json", files, loop); // no refused key present
    expect(res.success).toBe(true);
  });

  it("sc-1-5: without refused, a well-formed report still parses as before", () => {
    const files = new Set<string>();
    const reportText = JSON.stringify({ success: true, notes: "done", filesChanged: ["src/b.ts"] });
    const res = parseGeneratorResult(reportText, files, loop);

    expect(res.success).toBe(true);
    expect(res.notes).toBe("done");
    expect(res.filesChanged).toEqual(["src/b.ts"]);
  });

  it("sc-1-5: refused explicitly false behaves the same as absent", () => {
    const files = new Set(["src/a.ts"]);
    const res = parseGeneratorResult("not json", files, { ...loop, refused: false });
    expect(res.success).toBe(true);
  });
});
