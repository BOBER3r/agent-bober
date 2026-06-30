import { Buffer } from "node:buffer";

import { describe, it, expect } from "vitest";

import { buildApprovalKeyboard, decodeCallback, encodeCallback } from "./keyboard.js";
import type { CallbackAction } from "./keyboard.js";

describe("keyboard codec", () => {
  it("round-trips approve action for a calendar checkpointId", () => {
    const encoded = encodeCallback("approve", "calendar-mon-plan");
    const decoded = decodeCallback(encoded);
    expect(decoded).toEqual({ action: "approve", checkpointId: "calendar-mon-plan" });
  });

  it("round-trips adjust action", () => {
    const encoded = encodeCallback("adjust", "calendar-x");
    expect(decodeCallback(encoded)).toEqual({ action: "adjust", checkpointId: "calendar-x" });
  });

  it("round-trips reject action", () => {
    const encoded = encodeCallback("reject", "promote-abc123");
    expect(decodeCallback(encoded)).toEqual({ action: "reject", checkpointId: "promote-abc123" });
  });

  it("encoded byte length is within 64-byte Telegram limit for all realistic ids", () => {
    const ids = [
      "calendar-mon-plan",
      "promote-0123456789abcdef",
      "pre-curator",
      "post-research",
      "end-of-pipeline",
    ];
    const actions: CallbackAction[] = ["approve", "adjust", "reject"];
    for (const id of ids) {
      for (const action of actions) {
        const encoded = encodeCallback(action, id);
        expect(Buffer.byteLength(encoded, "utf-8")).toBeLessThanOrEqual(64);
      }
    }
  });

  it("decodeCallback returns null for an unknown action code", () => {
    expect(decodeCallback("x:calendar-x")).toBeNull();
  });

  it("decodeCallback returns null when there is no colon separator", () => {
    expect(decodeCallback("approve")).toBeNull();
  });

  it("decodeCallback returns null for a leading colon (empty code)", () => {
    expect(decodeCallback(":calendar-x")).toBeNull();
  });

  it("decodeCallback returns null for an empty string", () => {
    expect(decodeCallback("")).toBeNull();
  });

  it("buildApprovalKeyboard returns one row with three buttons labelled Approve/Adjust/Reject", () => {
    const spec = buildApprovalKeyboard("calendar-x");
    expect(spec).toHaveLength(1);
    expect(spec[0]).toHaveLength(3);
    expect(spec[0]![0]!.text).toBe("Approve");
    expect(spec[0]![1]!.text).toBe("Adjust");
    expect(spec[0]![2]!.text).toBe("Reject");
  });

  it("buildApprovalKeyboard encodes checkpointId into each button's data", () => {
    const id = "calendar-test";
    const spec = buildApprovalKeyboard(id);
    expect(spec[0]![0]!.data).toBe(encodeCallback("approve", id));
    expect(spec[0]![1]!.data).toBe(encodeCallback("adjust", id));
    expect(spec[0]![2]!.data).toBe(encodeCallback("reject", id));
  });
});
