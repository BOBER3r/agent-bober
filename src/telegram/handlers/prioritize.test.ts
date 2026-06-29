/**
 * prioritize.test.ts — Unit tests for the scoped hub-priority handler (sc-3-3, sc-3-4).
 * Uses injected fake HubQuery — no subprocess, no FactStore, no network.
 */
import { describe, it, expect } from "vitest";

import { handlePrioritize } from "./prioritize.js";
import type { HubQuery } from "./prioritize.js";
import type { Finding } from "../../hub/finding.js";

// ── Fixtures ──────────────────────────────────────────────────────────

/** Build a minimal valid Finding for injection into the fake hub. */
const fx = (id: string, title: string): Finding => ({
  id,
  domain: "coding",
  title,
  kind: "action",
  urgency: 3,
  severity: 3,
  evidence: [],
  surfacedAt: "2026-06-30T00:00:00.000Z",
  tags: [],
  status: "open",
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("handlePrioritize — hub-priority commands (sc-3-3, sc-3-4)", () => {
  it("sc-3-3: renders findings as a numbered list in the hub's returned order (no re-rank)", async () => {
    const captured: unknown[] = [];
    const fakeHub: HubQuery = async (scope) => {
      captured.push(scope);
      return [fx("a", "Alpha"), fx("b", "Bravo"), fx("c", "Charlie")];
    };

    const reply = await handlePrioritize("priority", "", fakeHub);

    // Reply is a numbered list in EXACTLY the order the fake hub returned.
    expect(reply).toBe("1. Alpha\n2. Bravo\n3. Charlie");
    // The scope passed to the query is the general scope from /priority.
    expect(captured).toEqual([{ mode: "general" }]);
  });

  it("sc-3-3: /today passes a filtered dueWithinDays:1 scope to the hub query", async () => {
    let seen: unknown;
    const fakeHub: HubQuery = async (scope) => {
      seen = scope;
      return [fx("x", "Urgent task")];
    };

    const reply = await handlePrioritize("today", "", fakeHub);

    expect(seen).toEqual({ mode: "filtered", dueWithinDays: 1 });
    expect(reply).toBe("1. Urgent task");
  });

  it("sc-3-2 / sc-3-3: /decide builds a decision scope with exactly the two trimmed options", async () => {
    let seen: unknown;
    const fakeHub: HubQuery = async (scope) => {
      seen = scope;
      return [];
    };

    await handlePrioritize("decide", "Buy a car vs Lease a car", fakeHub);

    expect(seen).toEqual({
      mode: "decision",
      optionA: "Buy a car",
      optionB: "Lease a car",
    });
  });

  it("sc-3-4: reply contains only titles — no raw domain or evidence payload", async () => {
    const fakeHub: HubQuery = async () => [fx("a", "Renew passport")];

    const reply = await handlePrioritize("priority", "", fakeHub);

    expect(reply).toContain("Renew passport");
    // Evidence, domain, and other raw fields must not appear in the reply.
    expect(reply).not.toContain("evidence");
    expect(reply).not.toContain("coding"); // domain value
    expect(reply).not.toContain("action"); // kind value
  });

  it("sc-3-4: reply goes through sendSafe as a plain string (no transport access in handler)", async () => {
    // handlePrioritize returns a string — callers pass it to sendSafe.
    // Verify the return type is a plain string (not undefined or an object).
    const fakeHub: HubQuery = async () => [fx("z", "Test finding")];
    const result = await handlePrioritize("priority", "", fakeHub);
    expect(typeof result).toBe("string");
  });

  it("returns 'No findings to prioritize.' when the hub returns an empty list", async () => {
    const fakeHub: HubQuery = async () => [];
    const reply = await handlePrioritize("priority", "", fakeHub);
    expect(reply).toBe("No findings to prioritize.");
  });

  it("returns Unknown-command stub for an unrecognized command name", async () => {
    const fakeHub: HubQuery = async () => [];
    const reply = await handlePrioritize("unknown", "", fakeHub);
    expect(reply).toBe("Unknown command: /unknown");
  });

  it("returns Unknown-command stub for /decide with no 'vs' separator", async () => {
    const fakeHub: HubQuery = async () => [];
    const reply = await handlePrioritize("decide", "only one thing", fakeHub);
    expect(reply).toBe("Unknown command: /decide");
  });
});
