/**
 * whitelist.test.ts — Unit tests for parseAllowedUsers, isAllowed, denialReply.
 * Pure functions only: no network, no filesystem, no SDK.
 * sc-1-3: deny/allow by id. sc-1-4: denial echoes exact numeric id.
 */
import { describe, it, expect } from "vitest";
import { parseAllowedUsers, isAllowed, denialReply } from "./whitelist.js";

// ── parseAllowedUsers ────────────────────────────────────────────────

describe("parseAllowedUsers (sc-1-3)", () => {
  it("returns an empty set when TELEGRAM_ALLOWED_USERS is absent", () => {
    const allowed = parseAllowedUsers({});
    expect(allowed.size).toBe(0);
  });

  it("returns an empty set when TELEGRAM_ALLOWED_USERS is an empty string", () => {
    const allowed = parseAllowedUsers({ TELEGRAM_ALLOWED_USERS: "" });
    expect(allowed.size).toBe(0);
  });

  it("parses a single id", () => {
    const allowed = parseAllowedUsers({ TELEGRAM_ALLOWED_USERS: "12345" });
    expect(allowed.has(12345)).toBe(true);
    expect(allowed.size).toBe(1);
  });

  it("parses a comma-separated list of ids", () => {
    const allowed = parseAllowedUsers({ TELEGRAM_ALLOWED_USERS: "111,222,333" });
    expect(allowed.has(111)).toBe(true);
    expect(allowed.has(222)).toBe(true);
    expect(allowed.has(333)).toBe(true);
    expect(allowed.size).toBe(3);
  });

  it("trims whitespace around ids", () => {
    const allowed = parseAllowedUsers({ TELEGRAM_ALLOWED_USERS: " 111 , 222 , 333 " });
    expect(allowed.has(111)).toBe(true);
    expect(allowed.has(222)).toBe(true);
    expect(allowed.has(333)).toBe(true);
  });

  it("silently ignores non-numeric tokens", () => {
    const allowed = parseAllowedUsers({ TELEGRAM_ALLOWED_USERS: "111,abc,222" });
    expect(allowed.has(111)).toBe(true);
    expect(allowed.has(222)).toBe(true);
    expect(allowed.size).toBe(2);
  });

  it("reads from the real process.env when called with process.env", () => {
    const saved = process.env["TELEGRAM_ALLOWED_USERS"];
    process.env["TELEGRAM_ALLOWED_USERS"] = "99001";
    try {
      const allowed = parseAllowedUsers(process.env);
      expect(allowed.has(99001)).toBe(true);
    } finally {
      if (saved !== undefined) process.env["TELEGRAM_ALLOWED_USERS"] = saved;
      else delete process.env["TELEGRAM_ALLOWED_USERS"];
    }
  });
});

// ── isAllowed ─────────────────────────────────────────────────────────

describe("isAllowed (sc-1-3)", () => {
  it("denies a sender id absent from the allowed set", () => {
    const allowed = new Set([111, 222]);
    expect(isAllowed(999, allowed)).toBe(false);
  });

  it("admits a sender id present in the allowed set", () => {
    const allowed = new Set([111, 222]);
    expect(isAllowed(111, allowed)).toBe(true);
    expect(isAllowed(222, allowed)).toBe(true);
  });

  it("denies any id when the allowed set is empty", () => {
    const allowed = new Set<number>();
    expect(isAllowed(12345, allowed)).toBe(false);
  });
});

// ── denialReply ───────────────────────────────────────────────────────

describe("denialReply (sc-1-4)", () => {
  it("contains the exact numeric id as a substring", () => {
    const reply = denialReply(99999);
    expect(reply).toContain("99999");
  });

  it("contains the id for various id values", () => {
    expect(denialReply(1)).toContain("1");
    expect(denialReply(123456789)).toContain("123456789");
    expect(denialReply(42)).toContain("42");
  });

  it("returns a non-empty string that communicates denial", () => {
    const reply = denialReply(55555);
    expect(reply.length).toBeGreaterThan(0);
    expect(reply.toLowerCase()).toMatch(/denied|not.*allow|access/);
  });
});
