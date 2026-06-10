/**
 * Unit tests for formatEnvironmentContext — the markdown block injected into
 * agent system prompts. Focus on the project-root + relative-path guidance
 * added to stop non-Claude models inventing absolute paths.
 */

import { describe, it, expect } from "vitest";

import { formatEnvironmentContext, type HostEnvironment } from "./environment.js";

const ENV: HostEnvironment = {
  platform: "darwin",
  osName: "macOS",
  osRelease: "25.2.0",
  arch: "arm64",
  shell: "/bin/zsh",
  nodeVersion: "v22.14.0",
  packageManager: "npm",
  installedTools: ["git", "node", "npm"],
};

const ROOT = "/Users/bober4ik/agent-bober-workspace/agent-bober-ide";

describe("formatEnvironmentContext", () => {
  it("surfaces the absolute project root when provided", () => {
    const out = formatEnvironmentContext(ENV, ["read_file", "glob"], ROOT);
    expect(out).toContain(`- Project root (absolute): ${ROOT}`);
  });

  it("omits the project-root line when not provided", () => {
    const out = formatEnvironmentContext(ENV, ["read_file", "glob"]);
    expect(out).not.toContain("Project root (absolute)");
  });

  it("adds relative-path guidance when a path-bearing tool is present", () => {
    const out = formatEnvironmentContext(ENV, ["glob", "grep"], ROOT);
    expect(out).toContain("pass paths RELATIVE to the project root");
    expect(out).toContain("Do NOT construct absolute");
  });

  it("omits relative-path guidance when no path tool is available", () => {
    const out = formatEnvironmentContext(ENV, ["report"], ROOT);
    expect(out).not.toContain("pass paths RELATIVE to the project root");
  });

  it("still lists the exact tools and host OS", () => {
    const out = formatEnvironmentContext(ENV, ["read_file", "glob"], ROOT);
    expect(out).toContain("# Host Environment");
    expect(out).toContain("- OS: macOS (darwin 25.2.0, arm64)");
    expect(out).toContain("# Your Tools");
    expect(out).toContain("You have EXACTLY these tools: read_file, glob.");
  });
});
