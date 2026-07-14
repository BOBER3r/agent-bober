/**
 * Structural/compile-time tests for the sprint-5 loop event + hook types
 * (`loop-events.ts`). This module is types-only at runtime — these tests
 * exist to prove the discriminated union narrows correctly and that
 * `HookDecision`/`LoopHooks` literals are assignable, which is the only
 * meaningful "behavior" a pure-type module has.
 */

import { describe, it, expect } from "vitest";
import type { LoopEvent, HookDecision, LoopHooks } from "./loop-events.js";

describe("LoopEvent", () => {
  it("narrows by `type` and exposes the documented payload for each variant", () => {
    const events: LoopEvent[] = [
      { type: "init", model: "m", maxTurns: 5 },
      { type: "turn-start", turn: 1 },
      { type: "tool-start", turn: 1, name: "read_file", input: { path: "a" }, toolUseId: "t1" },
      { type: "tool-end", turn: 1, name: "read_file", toolUseId: "t1", isError: false },
      { type: "turn-end", turn: 1, toolsCalled: ["read_file"] },
      {
        type: "compact-boundary",
        turn: 1,
        messagesBefore: 10,
        messagesAfter: 5,
        inputTokensAtTrigger: 60000,
      },
      { type: "result", stopReason: "end", turnsUsed: 1 },
    ];

    for (const event of events) {
      switch (event.type) {
        case "init":
          expect(event.model).toBe("m");
          expect(event.maxTurns).toBe(5);
          break;
        case "turn-start":
          expect(event.turn).toBe(1);
          break;
        case "tool-start":
          expect(event.name).toBe("read_file");
          expect(event.toolUseId).toBe("t1");
          break;
        case "tool-end":
          expect(event.isError).toBe(false);
          break;
        case "turn-end":
          expect(event.toolsCalled).toEqual(["read_file"]);
          break;
        case "compact-boundary":
          expect(event.messagesBefore).toBe(10);
          expect(event.messagesAfter).toBe(5);
          expect(event.inputTokensAtTrigger).toBe(60000);
          break;
        case "result":
          expect(event.stopReason).toBe("end");
          expect(event.turnsUsed).toBe(1);
          break;
      }
    }
  });
});

describe("HookDecision / LoopHooks", () => {
  it("a deny decision is assignable with a reason; an allow decision may omit it", () => {
    const deny: HookDecision = { allow: false, reason: "blocked by policy" };
    const allow: HookDecision = { allow: true };

    expect(deny.allow).toBe(false);
    expect(deny.reason).toBe("blocked by policy");
    expect(allow.allow).toBe(true);
    expect(Object.hasOwn(allow, "reason")).toBe(false);
  });

  it("all LoopHooks members are optional and callable when provided", async () => {
    const calls: string[] = [];
    const hooks: LoopHooks = {
      preToolUse: (call) => {
        calls.push(`pre:${call.name}`);
        return { allow: true };
      },
      postToolUse: (call, result) => {
        calls.push(`post:${call.name}:${result.isError}`);
      },
      onStop: (result) => {
        calls.push(`stop:${result.stopReason}`);
      },
    };

    const decision = await hooks.preToolUse?.({ name: "noop", input: {}, toolUseId: "t1" });
    await hooks.postToolUse?.(
      { name: "noop", input: {}, toolUseId: "t1" },
      { toolUseId: "t1", content: "ok", isError: false },
    );
    await hooks.onStop?.({
      finalText: "done",
      turnsUsed: 1,
      toolsCalled: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end",
    });

    expect(decision).toEqual({ allow: true });
    expect(calls).toEqual(["pre:noop", "post:noop:false", "stop:end"]);
  });

  it("an empty LoopHooks object is valid (all hooks absent)", () => {
    const hooks: LoopHooks = {};
    expect(hooks.preToolUse).toBeUndefined();
    expect(hooks.postToolUse).toBeUndefined();
    expect(hooks.onStop).toBeUndefined();
  });
});
