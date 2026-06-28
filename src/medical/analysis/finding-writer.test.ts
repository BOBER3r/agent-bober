import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFinding, writeDashboard } from "./finding-writer.js";
import { findingId } from "./finding.js";
import type { MedicalFinding } from "./finding.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

const NOW = "2026-06-28T12:00:00.000Z";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-finding-writer-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeFinding(overrides: Partial<MedicalFinding> = {}): MedicalFinding {
  return {
    id: findingId("medical", "ldl", "rule-a-high"),
    domain: "medical",
    title: "ldl: above reference range",
    kind: "watch",
    urgency: 3,
    severity: 3,
    evidence: ["ldl = 160 mg/dL (ref: ≤130 mg/dL)"],
    surfacedAt: NOW,
    tags: ["lab-trend", "ldl"],
    status: "open",
    ...overrides,
  };
}

// ── writeFinding ─────────────────────────────────────────────────────────

describe("writeFinding", () => {
  it("writes the finding file under <vaultDir>/findings/", async () => {
    const finding = makeFinding();
    const path = await writeFinding(tmpDir, finding);
    expect(path).toContain("findings");
    expect(path.endsWith(`${finding.id}.md`)).toBe(true);
  });

  it("written file starts with YAML frontmatter fence", async () => {
    const finding = makeFinding();
    const path = await writeFinding(tmpDir, finding);
    const raw = await readFile(path, "utf-8");
    expect(raw.startsWith("---\n")).toBe(true);
  });

  it("written file contains domain: medical", async () => {
    const finding = makeFinding();
    const path = await writeFinding(tmpDir, finding);
    const raw = await readFile(path, "utf-8");
    expect(raw).toContain("domain: medical");
  });

  it("surfacedAt in written file equals the injected now ISO string", async () => {
    const finding = makeFinding({ surfacedAt: NOW });
    const path = await writeFinding(tmpDir, finding);
    const raw = await readFile(path, "utf-8");
    expect(raw).toContain(`surfacedAt: ${NOW}`);
  });

  it("creates parent directories automatically for nested vaultDir", async () => {
    const nestedDir = join(tmpDir, "nested", "vault");
    const finding = makeFinding();
    const path = await writeFinding(nestedDir, finding);
    const raw = await readFile(path, "utf-8");
    expect(raw).toContain("domain: medical");
  });

  it("overwrites the same file on second call (idempotent write)", async () => {
    const finding = makeFinding();
    const path1 = await writeFinding(tmpDir, finding);
    const path2 = await writeFinding(tmpDir, finding);
    expect(path1).toBe(path2);
    const raw = await readFile(path2, "utf-8");
    expect(raw).toContain("domain: medical");
  });
});

// ── writeDashboard ────────────────────────────────────────────────────────

describe("writeDashboard (sc-1-5)", () => {
  it("writes dashboard.md under <vaultDir>/findings/", async () => {
    const path = await writeDashboard(tmpDir);
    expect(path).toContain("findings");
    expect(path.endsWith("dashboard.md")).toBe(true);
  });

  it("sc-1-5: dashboard contains a fenced dataview code block", async () => {
    const path = await writeDashboard(tmpDir);
    const raw = await readFile(path, "utf-8");
    expect(raw).toContain("```dataview");
  });

  it("sc-1-5: dashboard references frontmatter field urgency", async () => {
    const path = await writeDashboard(tmpDir);
    const raw = await readFile(path, "utf-8");
    expect(raw).toContain("urgency");
  });

  it("sc-1-5: dashboard references frontmatter field kind", async () => {
    const path = await writeDashboard(tmpDir);
    const raw = await readFile(path, "utf-8");
    expect(raw).toContain("kind");
  });

  it("dashboard creates parent directories automatically", async () => {
    const nestedDir = join(tmpDir, "nested", "vault");
    const path = await writeDashboard(nestedDir);
    const raw = await readFile(path, "utf-8");
    expect(raw).toContain("```dataview");
  });
});
