import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock execa before any import that would pull it in
vi.mock("execa", () => ({
  execa: vi.fn(),
}));

import { execa } from "execa";

// ── Helpers ────────────────────────────────────────────────────────

function mockExeca(value: Record<string, unknown>): void {
  (execa as unknown as Mock).mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
    failed: false,
    timedOut: false,
    all: "",
    ...value,
  });
}

function mockExecaReject(err: Error): void {
  (execa as unknown as Mock).mockRejectedValue(err);
}

let tmp: string;

beforeEach(async () => {
  (execa as unknown as Mock).mockReset();
  tmp = await mkdtemp(join(tmpdir(), "bober-cli-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// ── init() ─────────────────────────────────────────────────────────

describe("TokensaveCli.init()", () => {
  it("resolves on exit code 0", async () => {
    mockExeca({ exitCode: 0 });
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp);
    await expect(cli.init({ languageTier: "core" })).resolves.toBeUndefined();

    // Verify correct args passed
    expect(execa).toHaveBeenCalledWith(
      "tokensave",
      ["init", "--tier", "core"],
      expect.objectContaining({ cwd: tmp, reject: false }),
    );
  });

  it("throws on non-zero exit code", async () => {
    mockExeca({ exitCode: 1, all: "init failed: no config", stderr: "init failed: no config" });
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp);
    await expect(cli.init({ languageTier: "core" })).rejects.toThrow(
      /tokensave init failed.*exit 1/,
    );
  });

  it("uses cwd from opts when provided", async () => {
    mockExeca({ exitCode: 0 });
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp);
    const customCwd = "/custom/cwd";
    await cli.init({ cwd: customCwd, languageTier: "extended" });
    expect(execa).toHaveBeenCalledWith(
      "tokensave",
      ["init", "--tier", "extended"],
      expect.objectContaining({ cwd: customCwd }),
    );
  });

  it("uses custom binary name from constructor", async () => {
    mockExeca({ exitCode: 0 });
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp, null, "/usr/local/bin/tokensave");
    await cli.init({ languageTier: "all" });
    expect(execa).toHaveBeenCalledWith(
      "/usr/local/bin/tokensave",
      expect.any(Array),
      expect.any(Object),
    );
  });
});

// ── sync() ─────────────────────────────────────────────────────────

describe("TokensaveCli.sync()", () => {
  it("returns {indexed} parsed from JSON stdout", async () => {
    mockExeca({ exitCode: 0, stdout: '{"indexed": 42}' });
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp);
    const r = await cli.sync(["src/"], 5_000);
    expect(r).toEqual({ indexed: 42 });
  });

  it("returns {indexed: 0} when stdout is empty", async () => {
    mockExeca({ exitCode: 0, stdout: "" });
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp);
    const r = await cli.sync(["src/"], 5_000);
    expect(r).toEqual({ indexed: 0 });
  });

  it("throws on non-zero exit", async () => {
    mockExeca({ exitCode: 2, all: "sync error: path not found" });
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp);
    await expect(cli.sync(["src/"], 5_000)).rejects.toThrow(
      /tokensave sync failed.*exit 2/,
    );
  });

  it("throws on timeout (timedOut flag)", async () => {
    mockExeca({ exitCode: null, timedOut: true, failed: true });
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp);
    await expect(cli.sync(["src/"], 1_000)).rejects.toThrow(
      /tokensave sync timed out/,
    );
  });

  it("passes timeout to execa options", async () => {
    mockExeca({ exitCode: 0, stdout: '{"indexed":1}' });
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp);
    await cli.sync(["src/", "tests/"], 3_000);
    expect(execa).toHaveBeenCalledWith(
      "tokensave",
      ["sync", "src/", "tests/"],
      expect.objectContaining({ timeout: 3_000 }),
    );
  });

  it("passes multiple paths as argv entries", async () => {
    mockExeca({ exitCode: 0, stdout: '{"indexed":5}' });
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp);
    await cli.sync(["a/", "b/", "c/"], 5_000);
    expect(execa).toHaveBeenCalledWith(
      "tokensave",
      ["sync", "a/", "b/", "c/"],
      expect.any(Object),
    );
  });
});

// ── status() ───────────────────────────────────────────────────────

describe("TokensaveCli.status()", () => {
  it("returns {ready: false, ...} when stdout is empty (not initialised)", async () => {
    mockExeca({ exitCode: 1, stdout: "", failed: true });
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp);
    const r = await cli.status();
    expect(r.ready).toBe(false);
    expect(r.indexedFileCount).toBe(0);
    // Must NOT throw
  });

  it("returns parsed status when tokensave is initialised", async () => {
    const statusJson = JSON.stringify({
      ready: true,
      indexedFileCount: 123,
      tokensaveVersion: "6.0.0-beta.1",
    });
    mockExeca({ exitCode: 0, stdout: statusJson });
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp);
    const r = await cli.status();
    expect(r.ready).toBe(true);
    expect(r.indexedFileCount).toBe(123);
    expect(r.tokensaveVersion).toBe("6.0.0-beta.1");
  });

  it("does NOT throw when exit code is non-zero (not initialised case)", async () => {
    mockExeca({ exitCode: 1, stdout: '{"ready":false,"indexedFileCount":0,"tokensaveVersion":""}' });
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp);
    await expect(cli.status()).resolves.toBeDefined();
  });

  it("returns {ready: false} when stdout is non-JSON garbage", async () => {
    mockExeca({ exitCode: 0, stdout: "error: not initialized\n" });
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp);
    const r = await cli.status();
    expect(r.ready).toBe(false);
  });

  it("calls tokensave status --json", async () => {
    mockExeca({ exitCode: 0, stdout: '{"ready":false,"indexedFileCount":0,"tokensaveVersion":""}' });
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp);
    await cli.status();
    expect(execa).toHaveBeenCalledWith(
      "tokensave",
      ["status", "--json"],
      expect.any(Object),
    );
  });

  it("throws when the binary cannot be executed at all (exitCode=null)", async () => {
    mockExeca({ exitCode: null, failed: true, stderr: "ENOENT: binary not found" });
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp);
    await expect(cli.status()).rejects.toThrow();
  });
});
