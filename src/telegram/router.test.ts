/**
 * router.test.ts — Unit tests for the pure classify() router (sc-2-2).
 * No network access; no side effects — the router is entirely pure.
 */
import { describe, it, expect } from "vitest";

import { classify } from "./router.js";

describe("classify — message router (sc-2-2)", () => {
  it("classifies '/start' as a command with name 'start' and empty args", () => {
    const r = classify("/start");
    expect(r.kind).toBe("command");
    if (r.kind === "command") {
      expect(r.name).toBe("start");
      expect(r.args).toBe("");
    }
  });

  it("classifies a command with trailing args, splitting name and args correctly", () => {
    const r = classify("/todo renew passport now");
    expect(r.kind).toBe("command");
    if (r.kind === "command") {
      expect(r.name).toBe("todo");
      expect(r.args).toBe("renew passport now");
    }
  });

  it("classifies plain text as capture text (sc-2-2)", () => {
    const r = classify("renew passport");
    expect(r).toEqual({ kind: "text", text: "renew passport" });
  });

  it("preserves the message verbatim (no trimming) for plain text", () => {
    const r = classify("  buy milk  ");
    expect(r.kind).toBe("text");
    if (r.kind === "text") {
      expect(r.text).toBe("  buy milk  ");
    }
  });

  it("trims leading whitespace before checking for '/' (slash after spaces is still a command)", () => {
    const r = classify("  /help me");
    expect(r.kind).toBe("command");
    if (r.kind === "command") {
      expect(r.name).toBe("help");
      expect(r.args).toBe("me");
    }
  });

  it("classifies a single slash as a command with empty name and empty args", () => {
    const r = classify("/");
    expect(r.kind).toBe("command");
    if (r.kind === "command") {
      expect(r.name).toBe("");
      expect(r.args).toBe("");
    }
  });
});
