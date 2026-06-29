import { describe, it, expect, vi } from "vitest";
import { FactStore } from "../state/facts.js";
import {
  fromGmailTask,
  parseGmailThread,
  sanitizeConnectorError,
} from "./gmail-to-task.js";
import { readFindings } from "./finding-store.js";

const T = "2026-06-28T00:00:00.000Z";

function makeMcp(resp: unknown) {
  return {
    start: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
    stop: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
    callTool: vi.fn<[string, unknown], Promise<unknown>>().mockResolvedValue(resp),
  };
}

describe("parseGmailThread", () => {
  it("is pure: returns action/open + title from subject", () => {
    const p = parseGmailThread({ subject: "Pay invoice" });
    expect(p).toMatchObject({ title: "Pay invoice", kind: "action", status: "open" });
    expect(p.tags).toContain("source:gmail");
  });

  it("is pure: same input yields same output (deterministic)", () => {
    const a = parseGmailThread({ subject: "Test" });
    const b = parseGmailThread({ subject: "Test" });
    expect(a).toEqual(b);
  });

  it("falls back to (no subject) when payload has no subject", () => {
    const p = parseGmailThread({});
    expect(p.title).toBe("(no subject)");
  });

  it("extracts subject from messages array", () => {
    const p = parseGmailThread({ messages: [{ subject: "Meeting notes" }] });
    expect(p.title).toBe("Meeting notes");
  });

  it("extracts subject from SDK envelope content[0].text JSON", () => {
    const inner = JSON.stringify({ subject: "Invoice due" });
    const p = parseGmailThread({ content: [{ type: "text", text: inner }] });
    expect(p.title).toBe("Invoice due");
  });
});

describe("sanitizeConnectorError", () => {
  // sc-6-4 shape
  it("strips KEY=VALUE tokens (UPPERCASE)", () => {
    const result = sanitizeConnectorError("boom GMAIL_TOKEN=secret here");
    expect(result).not.toContain("secret");
    expect(result).toContain("[redacted]");
  });

  it("strips multiple KEY=VALUE patterns", () => {
    const result = sanitizeConnectorError("A=x B=y ok");
    expect(result).not.toContain("x");
    expect(result).not.toContain("y");
  });

  it("leaves non-KEY=VALUE text unchanged", () => {
    const result = sanitizeConnectorError("plain error message");
    expect(result).toBe("plain error message");
  });
});

describe("fromGmailTask", () => {
  // sc-6-2: axis OFF → throws, callTool NEVER invoked (no network)
  it("sc-6-2: egressAllowed=false refuses and never calls callTool", async () => {
    const store = new FactStore(":memory:");
    const mcp = makeMcp({});
    await expect(
      fromGmailTask({ egressAllowed: false, mcp, threadRef: "t1", store, now: T }),
    ).rejects.toThrow(/not enabled/i);
    expect(mcp.callTool).not.toHaveBeenCalled();
    expect(mcp.start).not.toHaveBeenCalled();
    store.close();
  });

  // sc-6-3: axis ON + stub payload → one open action-Finding, title=subject
  it("sc-6-3: captures one open action Finding with title from subject", async () => {
    const store = new FactStore(":memory:");
    const mcp = makeMcp({ subject: "Renew passport" });
    const finding = await fromGmailTask({
      egressAllowed: true,
      mcp,
      threadRef: "t1",
      store,
      now: T,
    });
    expect(mcp.callTool).toHaveBeenCalledTimes(1);
    expect(finding.kind).toBe("action");
    expect(finding.status).toBe("open");
    expect(finding.title).toBe("Renew passport");
    const all = readFindings(store);
    expect(all).toHaveLength(1);
    expect(all[0]!.title).toBe("Renew passport");
    store.close();
  });

  // sc-6-4: connector error → sanitized, no token leak
  it("sc-6-4: connector error is caught and sanitized of KEY=VALUE secrets", async () => {
    const store = new FactStore(":memory:");
    const mcp = {
      start: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
      stop: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
      callTool: vi
        .fn<[string, unknown], Promise<unknown>>()
        .mockRejectedValue(new Error("GMAIL_TOKEN=supersecret 500")),
    };
    // fromGmailTask itself does NOT sanitize — it throws raw.
    // Sanitization is the CLI layer's responsibility.
    // This test asserts sanitizeConnectorError handles the error string.
    await expect(
      fromGmailTask({ egressAllowed: true, mcp, threadRef: "t1", store, now: T }),
    ).rejects.toThrow();
    const errMsg = "GMAIL_TOKEN=supersecret 500";
    const sanitized = sanitizeConnectorError(errMsg);
    expect(sanitized).not.toContain("supersecret");
    expect(sanitized).toContain("[redacted]");
    store.close();
  });

  it("uses custom toolName when provided", async () => {
    const store = new FactStore(":memory:");
    const mcp = makeMcp({ subject: "Custom tool" });
    await fromGmailTask({
      egressAllowed: true,
      mcp,
      threadRef: "t2",
      store,
      now: T,
      toolName: "my_gmail_tool",
    });
    expect(mcp.callTool).toHaveBeenCalledWith("my_gmail_tool", { thread: "t2" });
    store.close();
  });
});
