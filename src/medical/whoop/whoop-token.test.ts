/**
 * WhoopTokenStore tests — env credential reads, 0600 sidecar write, absent/present reads.
 * All I/O uses a temp directory; env vars are saved/deleted/restored around each test.
 * No network access in this file (ESLint ban applies).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WhoopTokenStore } from "./whoop-token.js";

// ── Temp dir lifecycle ───────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-whoop-token-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── sc-2-6: clientCredentials — env stub throw ───────────────────────

describe("WhoopTokenStore.clientCredentials — env vars (sc-2-6)", () => {
  it("throws when both WHOOP env vars are unset", () => {
    const savedId = process.env["WHOOP_CLIENT_ID"];
    const savedSecret = process.env["WHOOP_CLIENT_SECRET"];
    delete process.env["WHOOP_CLIENT_ID"];
    delete process.env["WHOOP_CLIENT_SECRET"];
    try {
      expect(() => new WhoopTokenStore("/tmp").clientCredentials()).toThrow(
        /WHOOP_CLIENT_ID/,
      );
    } finally {
      if (savedId !== undefined) process.env["WHOOP_CLIENT_ID"] = savedId;
      if (savedSecret !== undefined) process.env["WHOOP_CLIENT_SECRET"] = savedSecret;
    }
  });

  it("throws when WHOOP_CLIENT_SECRET is unset but WHOOP_CLIENT_ID is set", () => {
    const savedId = process.env["WHOOP_CLIENT_ID"];
    const savedSecret = process.env["WHOOP_CLIENT_SECRET"];
    process.env["WHOOP_CLIENT_ID"] = "test-id";
    delete process.env["WHOOP_CLIENT_SECRET"];
    try {
      expect(() => new WhoopTokenStore("/tmp").clientCredentials()).toThrow(
        /WHOOP_CLIENT_SECRET/,
      );
    } finally {
      if (savedId !== undefined) process.env["WHOOP_CLIENT_ID"] = savedId;
      else delete process.env["WHOOP_CLIENT_ID"];
      if (savedSecret !== undefined) process.env["WHOOP_CLIENT_SECRET"] = savedSecret;
    }
  });

  it("throws when WHOOP_CLIENT_ID is unset but WHOOP_CLIENT_SECRET is set", () => {
    const savedId = process.env["WHOOP_CLIENT_ID"];
    const savedSecret = process.env["WHOOP_CLIENT_SECRET"];
    delete process.env["WHOOP_CLIENT_ID"];
    process.env["WHOOP_CLIENT_SECRET"] = "test-secret";
    try {
      expect(() => new WhoopTokenStore("/tmp").clientCredentials()).toThrow(
        /WHOOP_CLIENT_ID/,
      );
    } finally {
      if (savedId !== undefined) process.env["WHOOP_CLIENT_ID"] = savedId;
      if (savedSecret !== undefined) process.env["WHOOP_CLIENT_SECRET"] = savedSecret;
      else delete process.env["WHOOP_CLIENT_SECRET"];
    }
  });

  it("returns credentials when both env vars are set", () => {
    const savedId = process.env["WHOOP_CLIENT_ID"];
    const savedSecret = process.env["WHOOP_CLIENT_SECRET"];
    process.env["WHOOP_CLIENT_ID"] = "my-client-id";
    process.env["WHOOP_CLIENT_SECRET"] = "my-client-secret";
    try {
      const store = new WhoopTokenStore("/tmp");
      const creds = store.clientCredentials();
      expect(creds.clientId).toBe("my-client-id");
      expect(creds.clientSecret).toBe("my-client-secret");
    } finally {
      if (savedId !== undefined) process.env["WHOOP_CLIENT_ID"] = savedId;
      else delete process.env["WHOOP_CLIENT_ID"];
      if (savedSecret !== undefined) process.env["WHOOP_CLIENT_SECRET"] = savedSecret;
      else delete process.env["WHOOP_CLIENT_SECRET"];
    }
  });
});

// ── sc-2-6: writeTokens — 0600 mode ─────────────────────────────────

describe("WhoopTokenStore.writeTokens — file mode 0600 (sc-2-6)", () => {
  it("writes token file with mode 0600 on POSIX", async () => {
    if (process.platform === "win32") return;
    const store = new WhoopTokenStore(tmpDir);
    await store.writeTokens({
      accessToken: "access-abc",
      refreshToken: "refresh-xyz",
      expiresAtIso: "2026-06-17T00:00:00.000Z",
    });
    const s = await stat(join(tmpDir, ".bober", "medical", "whoop-token.json"));
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("written file contains the correct token data", async () => {
    const store = new WhoopTokenStore(tmpDir);
    await store.writeTokens({
      accessToken: "access-abc",
      refreshToken: "refresh-xyz",
      expiresAtIso: "2026-06-17T00:00:00.000Z",
    });
    const raw = await readFile(
      join(tmpDir, ".bober", "medical", "whoop-token.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as { accessToken: string; refreshToken: string; expiresAtIso: string };
    expect(parsed.accessToken).toBe("access-abc");
    expect(parsed.refreshToken).toBe("refresh-xyz");
    expect(parsed.expiresAtIso).toBe("2026-06-17T00:00:00.000Z");
  });

  it("creates parent directories automatically", async () => {
    const store = new WhoopTokenStore(tmpDir);
    await store.writeTokens({
      accessToken: "a",
      refreshToken: "r",
      expiresAtIso: "2026-06-17T00:00:00.000Z",
    });
    const s = await stat(join(tmpDir, ".bober", "medical", "whoop-token.json"));
    expect(s.isFile()).toBe(true);
  });
});

// ── sc-2-6: readRefreshToken — absent / present ───────────────────────

describe("WhoopTokenStore.readRefreshToken — absent/present (sc-2-6)", () => {
  it("returns undefined when sidecar is absent", async () => {
    const store = new WhoopTokenStore(tmpDir);
    const result = await store.readRefreshToken();
    expect(result).toBeUndefined();
  });

  it("returns the refresh token when sidecar is present", async () => {
    const store = new WhoopTokenStore(tmpDir);
    await store.writeTokens({
      accessToken: "access-abc",
      refreshToken: "refresh-xyz",
      expiresAtIso: "2026-06-17T00:00:00.000Z",
    });
    const result = await store.readRefreshToken();
    expect(result).toBe("refresh-xyz");
  });

  it("returns undefined when sidecar is corrupt JSON", async () => {
    const store = new WhoopTokenStore(tmpDir);
    // Write the sidecar manually with corrupt content
    await store.writeTokens({ accessToken: "a", refreshToken: "r", expiresAtIso: "2026-06-17T00:00:00.000Z" });
    // Overwrite with garbage
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(tmpDir, ".bober", "medical", "whoop-token.json"), "NOT JSON", "utf-8");

    const result = await store.readRefreshToken();
    expect(result).toBeUndefined();
  });

  it("returns undefined when refreshToken field is missing from sidecar", async () => {
    const store = new WhoopTokenStore(tmpDir);
    // Write manually with no refreshToken field
    const { writeFile: wf, mkdir: mk } = await import("node:fs/promises");
    await mk(join(tmpDir, ".bober", "medical"), { recursive: true });
    await wf(
      join(tmpDir, ".bober", "medical", "whoop-token.json"),
      JSON.stringify({ accessToken: "a" }),
      "utf-8",
    );

    const result = await store.readRefreshToken();
    expect(result).toBeUndefined();
  });
});
