import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FactStore } from "../../state/facts.js";
import type { BoberConfig } from "../../config/schema.js";
import { assembleRecommendationContext, contextToString } from "./context.js";

// -- Fixtures ------------------------------------------------------------

const NOW = "2026-06-28T10:00:00.000Z";

/** Minimal config with no medical section. */
const EMPTY_CONFIG = {} as BoberConfig;

// -- Helpers -------------------------------------------------------------

function seedMed(facts: FactStore, name: string): void {
  // Use insertFact directly so multiple meds with same subject+predicate are each stored
  // (writeFact reconciles and would update rather than add a second entry).
  facts.insertFact({
    scope: "medical",
    subject: "patient",
    predicate: "takes-medication",
    value: name,
    confidence: 1,
    sourceRunId: null,
    tValid: NOW,
    tCreated: `${NOW.slice(0, -1)}${name.length % 9}Z`, // unique tCreated for distinct id
  });
}

function seedSupplement(facts: FactStore, name: string, dose: string): void {
  facts.insertFact({
    scope: "medical",
    subject: name,
    predicate: "dose",
    value: dose,
    confidence: 1,
    sourceRunId: null,
    tValid: NOW,
    tCreated: NOW,
  });
}

// -- Tests ---------------------------------------------------------------

describe("assembleRecommendationContext", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "bober-ctx-"));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns empty context when FactStore is empty and no profile", async () => {
    const facts = new FactStore(":memory:");
    try {
      const ctx = await assembleRecommendationContext(
        tmpRoot,
        EMPTY_CONFIG,
        {},
        { facts },
      );
      expect(ctx.meds).toHaveLength(0);
      expect(ctx.supplements).toHaveLength(0);
      expect(ctx.conditions).toHaveLength(0);
      expect(ctx.allergies).toHaveLength(0);
      expect(ctx.goal).toBeUndefined();
    } finally {
      facts.close();
    }
  });

  it("returns seeded meds via injected FactStore", async () => {
    const facts = new FactStore(":memory:");
    seedMed(facts, "atorvastatin 20mg");
    seedMed(facts, "lisinopril 10mg");
    try {
      const ctx = await assembleRecommendationContext(
        tmpRoot,
        EMPTY_CONFIG,
        {},
        { facts },
      );
      expect(ctx.meds).toHaveLength(2);
      const values = ctx.meds.map((m) => m.value);
      expect(values).toContain("atorvastatin 20mg");
      expect(values).toContain("lisinopril 10mg");
    } finally {
      facts.close();
    }
  });

  it("reads supplements via 'dose' predicate (not takes-supplement)", async () => {
    const facts = new FactStore(":memory:");
    seedSupplement(facts, "Vitamin D", "1000 IU");
    seedSupplement(facts, "Magnesium", "200 mg");
    try {
      const ctx = await assembleRecommendationContext(
        tmpRoot,
        EMPTY_CONFIG,
        {},
        { facts },
      );
      expect(ctx.supplements).toHaveLength(2);
      const names = ctx.supplements.map((s) => s.name);
      expect(names).toContain("Vitamin D");
      expect(names).toContain("Magnesium");
      const vitD = ctx.supplements.find((s) => s.name === "Vitamin D");
      expect(vitD?.dose).toBe("1000 IU");
    } finally {
      facts.close();
    }
  });

  it("uses explicit goal from opts over profile goals", async () => {
    const facts = new FactStore(":memory:");
    try {
      const ctx = await assembleRecommendationContext(
        tmpRoot,
        EMPTY_CONFIG,
        { goal: "optimize energy" },
        { facts },
      );
      expect(ctx.goal).toBe("optimize energy");
    } finally {
      facts.close();
    }
  });

  it("does not throw when production store dir does not exist", async () => {
    // No injected store — non-existent projectRoot/namespace dir
    const ctx = await assembleRecommendationContext(
      join(tmpRoot, "nonexistent-project"),
      EMPTY_CONFIG,
      {},
    );
    expect(ctx.meds).toHaveLength(0);
    expect(ctx.supplements).toHaveLength(0);
    expect(ctx.conditions).toHaveLength(0);
    expect(ctx.allergies).toHaveLength(0);
  });

  it("returns goal undefined when not provided and no profile", async () => {
    const facts = new FactStore(":memory:");
    try {
      const ctx = await assembleRecommendationContext(tmpRoot, EMPTY_CONFIG, {}, { facts });
      expect(ctx.goal).toBeUndefined();
    } finally {
      facts.close();
    }
  });
});

describe("contextToString", () => {
  it("serializes empty context to 'none' lines", () => {
    const str = contextToString({ meds: [], supplements: [], conditions: [], allergies: [] });
    expect(str).toContain("Medications: none");
    expect(str).toContain("Supplements: none");
    expect(str).toContain("Conditions: none");
    expect(str).toContain("Allergies: none");
  });

  it("includes meds by value", () => {
    const str = contextToString({
      meds: [
        {
          id: "x",
          scope: "medical",
          subject: "patient",
          predicate: "takes-medication",
          value: "aspirin 81mg",
          confidence: 1,
          sourceRunId: null,
          tValid: "2026-01-01T00:00:00.000Z",
          tInvalid: null,
          tCreated: "2026-01-01T00:00:00.000Z",
          tInvalidated: null,
        },
      ],
      supplements: [{ name: "Vitamin D", dose: "1000 IU" }],
      conditions: ["hypertension"],
      allergies: ["penicillin"],
      goal: "lower LDL",
    });
    expect(str).toContain("aspirin 81mg");
    expect(str).toContain("Vitamin D (1000 IU)");
    expect(str).toContain("hypertension");
    expect(str).toContain("penicillin");
    expect(str).toContain("Goal: lower LDL");
  });
});
