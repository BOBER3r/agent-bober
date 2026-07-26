import { execa } from "execa";
import semver from "semver";
import type { PrereqResult } from "./types.js";
import type { PrereqSpec } from "./backends/types.js";
import { TokensaveBackend } from "./backends/tokensave-backend.js";

// ── GenericPrereqCheck ───────────────────────────────────────────────

/**
 * Backend-agnostic version-gate check: runs `<binary> <spec.versionArgs>`,
 * extracts a semver, and asks the backend's PrereqSpec whether it is
 * compatible. Every engine-specific string (version range, install hints)
 * lives inside the injected PrereqSpec — this class has none.
 */
export class GenericPrereqCheck {
  constructor(
    private readonly binary: string,
    private readonly spec: PrereqSpec,
  ) {}

  async check(): Promise<PrereqResult> {
    let result;
    try {
      result = await execa(this.binary, this.spec.versionArgs, {
        reject: false,
        timeout: 5000,
      });
    } catch {
      return { ok: false, reason: "MISSING", hint: this.spec.installHint(process.platform) };
    }
    if (result.exitCode !== 0 || result.failed) {
      return { ok: false, reason: "MISSING", hint: this.spec.installHint(process.platform) };
    }
    const firstLine = (result.stdout ?? "").split("\n")[0] ?? "";
    // Accept "tokensave 6.0.0-beta.1" or "6.0.0-beta.1"
    const match = firstLine.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
    const version = match ? match[1] : null;
    if (!version || !semver.valid(version)) {
      return {
        ok: false,
        reason: "INCOMPATIBLE",
        hint: this.spec.incompatibleHint(firstLine || "unknown"),
      };
    }
    if (!this.spec.isCompatible(version)) {
      return {
        ok: false,
        reason: "INCOMPATIBLE",
        hint: this.spec.incompatibleHint(version),
      };
    }
    return { ok: true, version };
  }
}

// ── TokensavePrereqCheck ─────────────────────────────────────────────

/**
 * Thin tokensave-defaulted wrapper over GenericPrereqCheck, kept so existing
 * callers (`new TokensavePrereqCheck(binary?)` + `.check()`) are unchanged.
 */
export class TokensavePrereqCheck {
  private readonly inner: GenericPrereqCheck;

  constructor(binary: string = new TokensaveBackend().processSpec().binary) {
    this.inner = new GenericPrereqCheck(binary, new TokensaveBackend().prereqSpec());
  }

  async check(): Promise<PrereqResult> {
    return this.inner.check();
  }
}
