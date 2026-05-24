import { describe, it, expect } from "vitest";
import { GraphFallback } from "../../src/graph/fallback.js";

describe("GraphFallback.hint — gated mode", () => {
  const fb = new GraphFallback("gated");

  it("GRAPH_DISABLED", () => {
    const h = fb.hint("GRAPH_DISABLED");
    expect(h.suggestedTools).toEqual(["grep", "glob", "read_file"]);
    expect(h.retryable).toBe(false);
    expect(h.message).toContain("disabled");
  });

  it("GRAPH_UNAVAILABLE in gated mode suggests only read_file", () => {
    const h = fb.hint("GRAPH_UNAVAILABLE");
    expect(h.suggestedTools).toEqual(["read_file"]);
    expect(h.retryable).toBe(false);
  });

  it("GRAPH_STALE in gated mode suggests only graph_search", () => {
    const h = fb.hint("GRAPH_STALE");
    expect(h.suggestedTools).toEqual(["graph_search"]);
    expect(h.retryable).toBe(true);
    expect(h.message).toContain("agent-bober graph sync");
  });

  it("GRAPH_TIMEOUT is retryable", () => {
    const h = fb.hint("GRAPH_TIMEOUT");
    expect(h.retryable).toBe(true);
    expect(h.suggestedTools).toEqual(["read_file"]);
  });

  it("GRAPH_ERROR is not retryable", () => {
    const h = fb.hint("GRAPH_ERROR");
    expect(h.retryable).toBe(false);
    expect(h.suggestedTools).toEqual(["read_file"]);
  });

  it("detail appended to message when provided", () => {
    const h = fb.hint("GRAPH_DISABLED", "some detail");
    expect(h.message).toContain("some detail");
  });
});

describe("GraphFallback.hint — dual mode", () => {
  const fb = new GraphFallback("dual");

  it("GRAPH_DISABLED in dual mode suggests grep/glob/read_file", () => {
    const h = fb.hint("GRAPH_DISABLED");
    expect(h.suggestedTools).toEqual(["grep", "glob", "read_file"]);
    expect(h.retryable).toBe(false);
  });

  it("GRAPH_UNAVAILABLE in dual mode suggests grep/glob/read_file", () => {
    expect(fb.hint("GRAPH_UNAVAILABLE").suggestedTools).toEqual([
      "grep",
      "glob",
      "read_file",
    ]);
  });

  it("GRAPH_STALE in dual mode suggests graph_search + grep", () => {
    expect(fb.hint("GRAPH_STALE").suggestedTools).toEqual(["graph_search", "grep"]);
  });

  it("GRAPH_TIMEOUT in dual mode suggests grep/read_file", () => {
    const h = fb.hint("GRAPH_TIMEOUT");
    expect(h.suggestedTools).toEqual(["grep", "read_file"]);
    expect(h.retryable).toBe(true);
  });

  it("GRAPH_ERROR in dual mode suggests grep/glob/read_file", () => {
    const h = fb.hint("GRAPH_ERROR");
    expect(h.suggestedTools).toEqual(["grep", "glob", "read_file"]);
    expect(h.retryable).toBe(false);
  });
});

describe("GraphFallback — default mode is dual", () => {
  it("instantiates with dual mode by default", () => {
    const fb = new GraphFallback();
    expect(fb.hint("GRAPH_UNAVAILABLE").suggestedTools).toEqual([
      "grep",
      "glob",
      "read_file",
    ]);
  });
});
