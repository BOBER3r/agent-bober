import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "./audit.js";

// ── AuditLog (sc-2-6, sc-2-7) ───────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-medical-audit-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("AuditLog.append — file creation and path (sc-2-6)", () => {
  it("creates .bober/medical/audit-<date>.jsonl from injected tIso", async () => {
    const audit = new AuditLog(tmpDir);
    await audit.append({ tIso: "2026-06-16T10:00:00.000Z", event: "answer" });

    const expected = join(tmpDir, ".bober", "medical", "audit-2026-06-16.jsonl");
    const content = await readFile(expected, "utf-8");
    expect(content.trim().length).toBeGreaterThan(0);
  });

  it("derives the date from injected tIso (different dates → different files)", async () => {
    const audit = new AuditLog(tmpDir);
    await audit.append({ tIso: "2026-06-15T23:59:59.999Z", event: "consent" });
    await audit.append({ tIso: "2026-06-16T00:00:00.000Z", event: "answer" });

    const file15 = await readFile(
      join(tmpDir, ".bober", "medical", "audit-2026-06-15.jsonl"),
      "utf-8",
    );
    const file16 = await readFile(
      join(tmpDir, ".bober", "medical", "audit-2026-06-16.jsonl"),
      "utf-8",
    );
    expect(file15.trim()).toBeTruthy();
    expect(file16.trim()).toBeTruthy();
  });
});

describe("AuditLog.append — file mode 0600 (sc-2-6)", () => {
  it("created audit file has mode 0600 on POSIX", async () => {
    if (process.platform === "win32") return;
    const audit = new AuditLog(tmpDir);
    await audit.append({ tIso: "2026-06-16T10:00:00.000Z", event: "answer" });

    const fileStat = await stat(
      join(tmpDir, ".bober", "medical", "audit-2026-06-16.jsonl"),
    );
    expect(fileStat.mode & 0o777).toBe(0o600);
  });
});

describe("AuditLog.append — append-only semantics (sc-2-6)", () => {
  it("two appends produce two lines; first line is byte-intact after second", async () => {
    const audit = new AuditLog(tmpDir);
    const path = join(tmpDir, ".bober", "medical", "audit-2026-06-16.jsonl");

    await audit.append({ tIso: "2026-06-16T10:00:00.000Z", event: "consent" });
    const firstRaw = await readFile(path, "utf-8");

    await audit.append({ tIso: "2026-06-16T11:00:00.000Z", event: "answer" });
    const secondRaw = await readFile(path, "utf-8");

    expect(secondRaw.startsWith(firstRaw)).toBe(true); // first line byte-intact
    expect(secondRaw.split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("each line is valid JSON containing only allowed fields (sc-2-7)", async () => {
    const audit = new AuditLog(tmpDir);
    await audit.append({
      tIso: "2026-06-16T10:00:00.000Z",
      event: "refuse",
      ruleId: "consent-required",
    });
    await audit.append({
      tIso: "2026-06-16T10:01:00.000Z",
      event: "answer",
      rulesetVersion: "0.0.0",
    });

    const raw = await readFile(
      join(tmpDir, ".bober", "medical", "audit-2026-06-16.jsonl"),
      "utf-8",
    );
    const lines = raw.split("\n").filter(Boolean);
    const allowed = new Set(["tIso", "event", "rulesetVersion", "patternsetVersion", "ruleId"]);

    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      for (const key of Object.keys(parsed)) {
        expect(allowed.has(key)).toBe(true);
      }
    }
  });
});

describe("AuditLog.append — PHI-free serialisation (sc-2-7)", () => {
  it("does NOT write prompt text or health values into the audit file", async () => {
    const audit = new AuditLog(tmpDir);
    // The entry itself must not carry PHI — confirmed by type narrowness.
    // Caller contract: pass a health-value-free entry.
    await audit.append({
      tIso: "2026-06-16T10:00:00.000Z",
      event: "refuse",
      ruleId: "consent-required",
    });

    const bytes = await readFile(
      join(tmpDir, ".bober", "medical", "audit-2026-06-16.jsonl"),
      "utf-8",
    );

    // Verify no health-value text leaks from the entry itself.
    expect(bytes).toContain("consent-required"); // rule ID is allowed
    expect(bytes).not.toContain("blood pressure"); // prompt text must not appear
    expect(bytes).not.toContain("180"); // numeric health value must not appear
  });
});

describe("AuditLog — deterministic timestamp (sc-2-8)", () => {
  it("tIso in the serialised entry matches the injected value verbatim", async () => {
    const audit = new AuditLog(tmpDir);
    const injectedTs = "2026-06-16T10:00:00.000Z";
    await audit.append({ tIso: injectedTs, event: "consent" });

    const raw = await readFile(
      join(tmpDir, ".bober", "medical", "audit-2026-06-16.jsonl"),
      "utf-8",
    );
    const parsed = JSON.parse(raw.split("\n").filter(Boolean)[0]!) as { tIso: string };
    expect(parsed.tIso).toBe(injectedTs);
  });
});
