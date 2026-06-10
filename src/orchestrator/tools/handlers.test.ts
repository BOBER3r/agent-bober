/**
 * Unit tests for sandboxPath — the path-sandboxing guard shared by the
 * read_file / write_file / edit_file / glob / grep tool handlers.
 *
 * Focus: the re-anchoring recovery for absolute paths invented with the wrong
 * home directory (the DeepSeek `/Users/boberik/...` failure mode), without
 * widening the sandbox for genuinely-foreign paths.
 */

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";

import { sandboxPath } from "./handlers.js";

const ROOT = "/Users/bober4ik/agent-bober-workspace/agent-bober-ide";

describe("sandboxPath", () => {
  it("accepts a relative path and resolves it under the root", () => {
    expect(sandboxPath(ROOT, "src")).toBe(resolve(ROOT, "src"));
    expect(sandboxPath(ROOT, "src/index.ts")).toBe(
      resolve(ROOT, "src/index.ts"),
    );
  });

  it("accepts the root itself (empty relative path)", () => {
    expect(sandboxPath(ROOT, ".")).toBe(resolve(ROOT));
    expect(sandboxPath(ROOT, ROOT)).toBe(resolve(ROOT));
  });

  it("accepts a correct absolute path inside the root", () => {
    const abs = `${ROOT}/src/app.ts`;
    expect(sandboxPath(ROOT, abs)).toBe(resolve(abs));
  });

  it("re-anchors an absolute path invented with the wrong home dir", () => {
    // DeepSeek hallucinated `boberik` instead of the real `bober4ik`.
    const bogus =
      "/Users/boberik/agent-bober-workspace/agent-bober-ide/src";
    expect(sandboxPath(ROOT, bogus)).toBe(resolve(ROOT, "src"));
  });

  it("re-anchors a deep wrong-home absolute path to the right suffix", () => {
    const bogus =
      "/home/ci/agent-bober-ide/src/components/Button.tsx";
    expect(sandboxPath(ROOT, bogus)).toBe(
      resolve(ROOT, "src/components/Button.tsx"),
    );
  });

  it("re-anchors a wrong-home path that points at the root itself", () => {
    const bogus = "/Users/boberik/agent-bober-workspace/agent-bober-ide";
    expect(sandboxPath(ROOT, bogus)).toBe(resolve(ROOT));
  });

  it("still blocks a relative traversal escaping the root", () => {
    expect(() => sandboxPath(ROOT, "../../etc/passwd")).toThrow(
      /outside the project root/,
    );
  });

  it("still blocks a genuinely-foreign absolute path (no root basename)", () => {
    expect(() => sandboxPath(ROOT, "/etc/passwd")).toThrow(
      /outside the project root/,
    );
  });

  it("re-anchoring never widens the sandbox: suffix stays inside root", () => {
    // Even a malicious suffix after the root name cannot escape, because the
    // re-anchored path is re-validated against the root.
    const sneaky =
      "/Users/attacker/agent-bober-ide/../../../../etc/passwd";
    expect(() => sandboxPath(ROOT, sneaky)).toThrow(
      /outside the project root/,
    );
  });
});
