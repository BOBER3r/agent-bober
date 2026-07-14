/**
 * capture.test.ts — Unit tests for the zero-friction capture handler (sc-2-3, sc-2-4).
 * Uses an injected fake InboxCapture sink — no real FactStore, no filesystem access.
 */
import { describe, it, expect } from "vitest";

import { handleCapture } from "./capture.js";
import type { InboxCapture } from "./capture.js";

describe("handleCapture — zero-friction task inbox (sc-2-3, sc-2-4)", () => {
  it("sc-2-3: invokes the inbox sink exactly once with the raw text as title", async () => {
    const calls: string[] = [];
    const fakeSink: InboxCapture = async (text) => {
      calls.push(text);
      return { id: "abc123", title: text };
    };

    const reply = await handleCapture("renew passport", fakeSink);

    // Sink called exactly once with the verbatim text
    expect(calls).toEqual(["renew passport"]);
    // Confirmation must contain the captured title
    expect(reply).toContain("renew passport");
  });

  it("sc-2-4: capture succeeds with text alone — handler never prompts for additional fields", async () => {
    // The fake sink only receives the text argument — no due date, domain, or field prompt.
    let callCount = 0;
    let capturedArg: string | undefined;
    const fakeSink: InboxCapture = async (text) => {
      callCount++;
      capturedArg = text;
      // Returns only title — simulates a sink that asks for nothing else
      return { title: text };
    };

    const reply = await handleCapture("buy milk", fakeSink);

    expect(callCount).toBe(1);
    expect(capturedArg).toBe("buy milk");
    expect(reply).toContain("buy milk");
  });

  it("includes the task id in the confirmation when the sink returns one", async () => {
    const fakeSink: InboxCapture = async (text) => ({ id: "deadbeef01234567", title: text });
    const reply = await handleCapture("call dentist", fakeSink);
    expect(reply).toContain("call dentist");
    expect(reply).toContain("deadbeef01234567");
  });

  it("returns a confirmation without id suffix when the sink omits the id", async () => {
    const fakeSink: InboxCapture = async (text) => ({ title: text });
    const reply = await handleCapture("read book", fakeSink);
    expect(reply).toContain("read book");
    // No '#' id suffix when id is absent
    expect(reply).not.toContain("#");
  });
});
