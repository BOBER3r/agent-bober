import { execa } from "execa";
import semver from "semver";
import type { PrereqResult } from "./types.js";

export const TOKENSAVE_VERSION_RANGE = ">=6.0.0-beta.1 <7.0.0";

export class TokensavePrereqCheck {
  constructor(private readonly binary: string = "tokensave") {}

  async check(): Promise<PrereqResult> {
    let result;
    try {
      result = await execa(this.binary, ["--version"], {
        reject: false,
        timeout: 5000,
      });
    } catch {
      return { ok: false, reason: "MISSING", hint: this.installHint() };
    }
    if (result.exitCode !== 0 || result.failed) {
      return { ok: false, reason: "MISSING", hint: this.installHint() };
    }
    const firstLine = (result.stdout ?? "").split("\n")[0] ?? "";
    // Accept "tokensave 6.0.0-beta.1" or "6.0.0-beta.1"
    const match = firstLine.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
    const version = match ? match[1] : null;
    if (!version || !semver.valid(version)) {
      return {
        ok: false,
        reason: "INCOMPATIBLE",
        hint: this.incompatibleHint(firstLine || "unknown"),
      };
    }
    if (
      !semver.satisfies(version, TOKENSAVE_VERSION_RANGE, {
        includePrerelease: true,
      })
    ) {
      return {
        ok: false,
        reason: "INCOMPATIBLE",
        hint: this.incompatibleHint(version),
      };
    }
    return { ok: true, version };
  }

  /** Platform-aware install hint. Strings are verbatim from s1-c2 — DO NOT paraphrase. */
  private installHint(): string {
    switch (process.platform) {
      case "darwin":
        return "brew install aovestdipaperino/tap/tokensave";
      case "win32":
        return "scoop bucket add tokensave https://github.com/aovestdipaperino/scoop-bucket && scoop install tokensave";
      default:
        return "cargo install tokensave";
    }
  }

  /** Must name both detected and required versions (s1-c2). */
  private incompatibleHint(detected: string): string {
    return `tokensave ${detected} is incompatible; required range: ${TOKENSAVE_VERSION_RANGE}`;
  }
}
