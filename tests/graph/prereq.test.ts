import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

import { execa } from "execa";

beforeEach(() => {
  (execa as unknown as Mock).mockReset();
});

describe("TokensavePrereqCheck", () => {
  it("returns ok=true on compatible version", async () => {
    (execa as unknown as Mock).mockResolvedValue({
      exitCode: 0,
      stdout: "tokensave 6.0.0-beta.1",
      failed: false,
    });
    const { TokensavePrereqCheck } = await import("../../src/graph/prereq.js");
    const r = await new TokensavePrereqCheck().check();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.version).toBe("6.0.0-beta.1");
  });

  it("returns ok=false MISSING when execa throws", async () => {
    (execa as unknown as Mock).mockRejectedValue(new Error("ENOENT"));
    const { TokensavePrereqCheck } = await import("../../src/graph/prereq.js");
    const r = await new TokensavePrereqCheck().check();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("MISSING");
  });

  it("returns ok=false MISSING when exit code is non-zero", async () => {
    (execa as unknown as Mock).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      failed: true,
    });
    const { TokensavePrereqCheck } = await import("../../src/graph/prereq.js");
    const r = await new TokensavePrereqCheck().check();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("MISSING");
  });

  it("INCOMPATIBLE hint names both detected and required range", async () => {
    (execa as unknown as Mock).mockResolvedValue({
      exitCode: 0,
      stdout: "tokensave 5.4.0",
      failed: false,
    });
    const { TokensavePrereqCheck } = await import("../../src/graph/prereq.js");
    const r = await new TokensavePrereqCheck().check();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("INCOMPATIBLE");
      expect(r.hint).toContain("5.4.0");
      expect(r.hint).toContain(">=6.0.0-beta.1 <7.0.0");
    }
  });

  it("returns INCOMPATIBLE when stdout is garbage (no semver)", async () => {
    (execa as unknown as Mock).mockResolvedValue({
      exitCode: 0,
      stdout: "not-a-version-string",
      failed: false,
    });
    const { TokensavePrereqCheck } = await import("../../src/graph/prereq.js");
    const r = await new TokensavePrereqCheck().check();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("INCOMPATIBLE");
  });
});

// Platform hints — stub process.platform
describe("install hints by platform", () => {
  let originalPlatform: PropertyDescriptor | undefined;
  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  });
  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  function setPlatform(p: NodeJS.Platform) {
    Object.defineProperty(process, "platform", { value: p, configurable: true });
  }

  it("macOS → brew", async () => {
    setPlatform("darwin");
    (execa as unknown as Mock).mockRejectedValue(new Error("ENOENT"));
    const { TokensavePrereqCheck } = await import("../../src/graph/prereq.js");
    const r = await new TokensavePrereqCheck().check();
    if (!r.ok) expect(r.hint).toBe("brew install aovestdipaperino/tap/tokensave");
  });

  it("Windows → scoop", async () => {
    setPlatform("win32");
    (execa as unknown as Mock).mockRejectedValue(new Error("ENOENT"));
    const { TokensavePrereqCheck } = await import("../../src/graph/prereq.js");
    const r = await new TokensavePrereqCheck().check();
    if (!r.ok)
      expect(r.hint).toBe(
        "scoop bucket add tokensave https://github.com/aovestdipaperino/scoop-bucket && scoop install tokensave",
      );
  });

  it("linux → cargo", async () => {
    setPlatform("linux");
    (execa as unknown as Mock).mockRejectedValue(new Error("ENOENT"));
    const { TokensavePrereqCheck } = await import("../../src/graph/prereq.js");
    const r = await new TokensavePrereqCheck().check();
    if (!r.ok) expect(r.hint).toBe("cargo install tokensave");
  });
});
