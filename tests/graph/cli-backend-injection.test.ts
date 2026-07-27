/**
 * Regression tests for sc-3-6 (sprint-3 iteration 2 retry).
 *
 * TokensaveCli must accept the RESOLVED GraphBackend via its constructor
 * instead of hardcoding `new TokensaveBackend().cliMap()`. The backend's
 * `cliMap()` must be resolved LAZILY inside init()/sync()/status() — not in
 * the constructor — so constructing the CLI for a stub backend (e.g.
 * CodeReviewGraphBackend) never throws at construction time; only an actual
 * init/sync/status call surfaces the stub's NOT_IMPL error.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock execa before any import that would pull it in
vi.mock("execa", () => ({
  execa: vi.fn(),
}));

import { execa } from "execa";
import type { CliMap, GraphBackend, PrereqSpec, ProcessSpec } from "../../src/graph/backends/types.js";
import { CodeReviewGraphBackend } from "../../src/graph/backends/code-review-graph-backend.js";
import { TokensaveBackend } from "../../src/graph/backends/tokensave-backend.js";

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

let tmp: string;

beforeEach(async () => {
  (execa as unknown as Mock).mockReset();
  tmp = await mkdtemp(join(tmpdir(), "bober-cli-backend-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// ── Construction never throws, even for a stub backend ───────────────

describe("TokensaveCli — backend injection (sc-3-6)", () => {
  it("constructing the CLI with a CodeReviewGraphBackend does NOT throw", async () => {
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    expect(
      () => new TokensaveCli(tmp, null, undefined, new CodeReviewGraphBackend()),
    ).not.toThrow();
  });

  it("init() surfaces the cr-graph stub's NOT_IMPL error, never calling execa", async () => {
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp, null, undefined, new CodeReviewGraphBackend());
    await expect(cli.init({ languageTier: "core" })).rejects.toThrow(
      /code-review-graph adapter not implemented until Sprints 4-6/,
    );
    expect(execa).not.toHaveBeenCalled();
  });

  it("sync() surfaces the cr-graph stub's NOT_IMPL error, never calling execa", async () => {
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp, null, undefined, new CodeReviewGraphBackend());
    await expect(cli.sync(["."], 2_000)).rejects.toThrow(
      /code-review-graph adapter not implemented until Sprints 4-6/,
    );
    expect(execa).not.toHaveBeenCalled();
  });

  it("status() surfaces the cr-graph stub's NOT_IMPL error, never calling execa", async () => {
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp, null, undefined, new CodeReviewGraphBackend());
    await expect(cli.status()).rejects.toThrow(
      /code-review-graph adapter not implemented until Sprints 4-6/,
    );
    expect(execa).not.toHaveBeenCalled();
  });

  // ── Byte-identical for tokensave (default / unset backend) ──────────

  it("defaults to TokensaveBackend when no backend is injected (byte-identical argv)", async () => {
    mockExeca({ exitCode: 0 });
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp);
    await cli.init({ languageTier: "core" });
    expect(execa).toHaveBeenCalledWith(
      "tokensave",
      ["init"],
      expect.objectContaining({ cwd: tmp, reject: false }),
    );
  });

  it("explicitly injecting a TokensaveBackend behaves identically to the default", async () => {
    mockExeca({ exitCode: 0, stdout: "", stderr: "", all: "" });
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp, null, undefined, new TokensaveBackend());
    await cli.status();
    expect(execa).toHaveBeenCalledWith(
      "tokensave",
      ["status", "--json"],
      expect.any(Object),
    );
  });

  // ── Binary resolution honors the injected backend ────────────────────

  it("uses the injected backend's own default binary when no binaryOverride is given", async () => {
    mockExeca({ exitCode: 0 });
    const fakeCliMap: CliMap = {
      initArgs: () => ["init"],
      syncArgs: (paths) => ["sync", ...paths],
      statusArgs: ["status", "--json"],
      parseSync: () => 0,
      parseStatus: () => ({ ready: false, indexedFileCount: 0, tokensaveVersion: "" }),
    };
    const fakeBackend: GraphBackend = {
      id: "fake-engine",
      searchPlan: () => {
        throw new Error("n/a");
      },
      queryPlan: () => {
        throw new Error("n/a");
      },
      impactPlan: () => {
        throw new Error("n/a");
      },
      reviewContextPlan: () => {
        throw new Error("n/a");
      },
      overviewPlan: () => {
        throw new Error("n/a");
      },
      changesPlan: () => {
        throw new Error("n/a");
      },
      processSpec: (): ProcessSpec => ({ binary: "fake-engine-binary", serveArgs: ["serve"] }),
      prereqSpec: (): PrereqSpec => ({
        versionArgs: ["--version"],
        isCompatible: () => true,
        installHint: () => "install fake-engine",
        incompatibleHint: () => "",
      }),
      cliMap: () => fakeCliMap,
    };
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp, null, undefined, fakeBackend);
    await cli.init({ languageTier: "core" });
    expect(execa).toHaveBeenCalledWith("fake-engine-binary", ["init"], expect.any(Object));
  });

  it("an explicit binaryOverride still wins over the backend's default binary", async () => {
    mockExeca({ exitCode: 0 });
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp, null, "/custom/tokensave", new TokensaveBackend());
    await cli.init({ languageTier: "core" });
    expect(execa).toHaveBeenCalledWith("/custom/tokensave", ["init"], expect.any(Object));
  });
});
