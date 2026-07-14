/**
 * CalendarTokenStore unit tests — 0600 sidecar read/write, absent/corrupt fail-closed.
 * All I/O uses a temp directory. No network access.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CalendarTokenStore } from "./calendar-token.js";

// ── Temp dir lifecycle ───────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-cal-token-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── readToken — absent / corrupt ─────────────────────────────────────

describe("CalendarTokenStore.readToken — fail-closed", () => {
  it("returns undefined when sidecar is absent", async () => {
    const store = new CalendarTokenStore(tmpDir);
    const result = await store.readToken();
    expect(result).toBeUndefined();
  });

  it("returns undefined when sidecar contains corrupt JSON", async () => {
    const store = new CalendarTokenStore(tmpDir);
    await store.writeToken("valid-token");
    // Overwrite with garbage
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(tmpDir, ".bober", "calendar", "google-token.json"), "NOT JSON", "utf-8");
    const result = await store.readToken();
    expect(result).toBeUndefined();
  });

  it("returns undefined when token field is missing from sidecar", async () => {
    const { writeFile: wf, mkdir: mk } = await import("node:fs/promises");
    await mk(join(tmpDir, ".bober", "calendar"), { recursive: true });
    await wf(
      join(tmpDir, ".bober", "calendar", "google-token.json"),
      JSON.stringify({ other: "field" }),
      "utf-8",
    );
    const store = new CalendarTokenStore(tmpDir);
    const result = await store.readToken();
    expect(result).toBeUndefined();
  });
});

// ── readToken — present ──────────────────────────────────────────────

describe("CalendarTokenStore.readToken — present", () => {
  it("returns the token when sidecar is present", async () => {
    const store = new CalendarTokenStore(tmpDir);
    await store.writeToken("my-oauth-token-value");
    const result = await store.readToken();
    expect(result).toBe("my-oauth-token-value");
  });
});

// ── writeToken — 0600 mode ────────────────────────────────────────────

describe("CalendarTokenStore.writeToken — file mode 0600", () => {
  it("writes token file with mode 0600 on POSIX", async () => {
    if (process.platform === "win32") return;
    const store = new CalendarTokenStore(tmpDir);
    await store.writeToken("test-token");
    const s = await stat(join(tmpDir, ".bober", "calendar", "google-token.json"));
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("written file contains the correct token data", async () => {
    const store = new CalendarTokenStore(tmpDir);
    await store.writeToken("test-token-abc");
    const raw = await readFile(
      join(tmpDir, ".bober", "calendar", "google-token.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as { token: string };
    expect(parsed.token).toBe("test-token-abc");
  });

  it("creates parent directories automatically", async () => {
    const store = new CalendarTokenStore(tmpDir);
    await store.writeToken("test-token");
    const s = await stat(join(tmpDir, ".bober", "calendar", "google-token.json"));
    expect(s.isFile()).toBe(true);
  });
});
