import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "./audit.js";
import { ConsentGate } from "./consent.js";

// ── ConsentGate (sc-2-5) ─────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-medical-consent-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("ConsentGate.hasConsent / current — fail-closed (sc-2-4, sc-2-5)", () => {
  it("hasConsent() returns false when no consent.json exists", async () => {
    const audit = new AuditLog(tmpDir);
    const gate = new ConsentGate(tmpDir, audit);
    expect(await gate.hasConsent()).toBe(false);
  });

  it("current() returns undefined when no consent.json exists", async () => {
    const audit = new AuditLog(tmpDir);
    const gate = new ConsentGate(tmpDir, audit);
    expect(await gate.current()).toBeUndefined();
  });

  it("hasConsent() returns false on a corrupt consent.json", async () => {
    const dir = join(tmpDir, ".bober", "medical");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "consent.json"), "not valid json", "utf-8");

    const audit = new AuditLog(tmpDir);
    const gate = new ConsentGate(tmpDir, audit);
    expect(await gate.hasConsent()).toBe(false);
  });

  it("hasConsent() returns false on a partial consent.json (missing required fields)", async () => {
    const dir = join(tmpDir, ".bober", "medical");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "consent.json"),
      JSON.stringify({ consentVersion: "1.0.0" }),
      "utf-8",
    );

    const audit = new AuditLog(tmpDir);
    const gate = new ConsentGate(tmpDir, audit);
    expect(await gate.hasConsent()).toBe(false);
  });
});

describe("ConsentGate.recordConsent — round-trip (sc-2-5)", () => {
  it("recordConsent then current()/hasConsent() round-trips all fields", async () => {
    const audit = new AuditLog(tmpDir);
    const gate = new ConsentGate(tmpDir, audit);

    await gate.recordConsent(
      {
        consentVersion: "1.0.0",
        acceptedAtIso: "2026-06-16T10:00:00.000Z",
        rulesetVersion: "0.0.0",
        disclaimerVersion: "1.0.0",
      },
      "2026-06-16T10:00:00.000Z",
    );

    // Read via a FRESH instance to confirm persistence.
    const fresh = new ConsentGate(tmpDir, audit);
    expect(await fresh.hasConsent()).toBe(true);
    const record = await fresh.current();
    expect(record).toBeDefined();
    expect(record?.consentVersion).toBe("1.0.0");
    expect(record?.acceptedAtIso).toBe("2026-06-16T10:00:00.000Z");
    expect(record?.rulesetVersion).toBe("0.0.0");
    expect(record?.disclaimerVersion).toBe("1.0.0");
  });

  it("recordConsent persists consent.json with mode 0600 on POSIX", async () => {
    if (process.platform === "win32") return;
    const audit = new AuditLog(tmpDir);
    const gate = new ConsentGate(tmpDir, audit);

    await gate.recordConsent(
      {
        consentVersion: "1.0.0",
        acceptedAtIso: "2026-06-16T10:00:00.000Z",
        rulesetVersion: "0.0.0",
        disclaimerVersion: "1.0.0",
      },
      "2026-06-16T10:00:00.000Z",
    );

    const fileStat = await stat(join(tmpDir, ".bober", "medical", "consent.json"));
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it("recordConsent appends a 'consent' audit entry", async () => {
    const audit = new AuditLog(tmpDir);
    const gate = new ConsentGate(tmpDir, audit);

    const nowIso = "2026-06-16T10:00:00.000Z";
    await gate.recordConsent(
      {
        consentVersion: "1.0.0",
        acceptedAtIso: nowIso,
        rulesetVersion: "0.0.0",
        disclaimerVersion: "1.0.0",
      },
      nowIso,
    );

    const auditPath = join(tmpDir, ".bober", "medical", "audit-2026-06-16.jsonl");
    const raw = await readFile(auditPath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry.event).toBe("consent");
    expect(entry.tIso).toBe(nowIso);
    expect(entry.rulesetVersion).toBe("0.0.0");
  });
});

describe("ConsentGate — deterministic timestamp (sc-2-8)", () => {
  it("acceptedAtIso in the persisted file matches the injected value verbatim", async () => {
    const audit = new AuditLog(tmpDir);
    const gate = new ConsentGate(tmpDir, audit);

    const injectedTs = "2026-06-16T10:00:00.000Z";
    await gate.recordConsent(
      {
        consentVersion: "1.0.0",
        acceptedAtIso: injectedTs,
        rulesetVersion: "0.0.0",
        disclaimerVersion: "1.0.0",
      },
      injectedTs,
    );

    const raw = await readFile(join(tmpDir, ".bober", "medical", "consent.json"), "utf-8");
    const parsed = JSON.parse(raw) as { acceptedAtIso: string };
    expect(parsed.acceptedAtIso).toBe(injectedTs);
  });
});
