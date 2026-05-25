/**
 * Unit tests for getCheckpointMechanismFor and resolveCheckpointMechanismName.
 *
 * Sprint 14 — mode-based default tier (s14-c2, s14-c3).
 *
 * These tests cover the 6-tier resolution order added in Sprint 14:
 *   1. cliOverrideAll + cliOverride → cliOverride
 *   2. config.pipeline.checkpointOverrides[id] → per-checkpoint config override
 *   3. cliOverride alone → deferred CLI override
 *   4. config.pipeline.checkpointMechanism → global config default
 *   5. mode='careful' → 'disk', mode='autopilot'/unset → 'noop'
 *   6. fallback param
 *
 * The 5 existing s10-c5 tests (in pr.test.ts:530-593) continue to cover
 * 2-arg and 3-arg back-compat forms. These tests cover new Sprint 14 paths.
 */

import { describe, it, expect } from "vitest";
import {
  resolveCheckpointMechanismName,
  getCheckpointMechanismFor,
} from "./registry.js";

// ---------------------------------------------------------------------------
// resolveCheckpointMechanismName — pure name resolution
// ---------------------------------------------------------------------------

describe("resolveCheckpointMechanismName — mode-based default tier (s14-c2)", () => {
  it("mode='autopilot' + no checkpointMechanism → resolves to 'noop'", () => {
    const config = { pipeline: { mode: "autopilot" as const } };
    expect(resolveCheckpointMechanismName("post-research", config)).toBe("noop");
  });

  it("mode='careful' + no checkpointMechanism → resolves to 'disk'", () => {
    const config = { pipeline: { mode: "careful" as const } };
    expect(resolveCheckpointMechanismName("post-research", config)).toBe("disk");
  });

  it("mode='careful' + explicit checkpointMechanism='pr' → resolves to 'pr' (explicit wins)", () => {
    const config = {
      pipeline: {
        mode: "careful" as const,
        checkpointMechanism: "pr",
      },
    };
    expect(resolveCheckpointMechanismName("post-research", config)).toBe("pr");
  });

  it("mode unset + no checkpointMechanism → falls through to fallback (default 'noop')", () => {
    const config = { pipeline: {} };
    expect(resolveCheckpointMechanismName("post-research", config)).toBe("noop");
  });

  it("undefined config → falls through to fallback param", () => {
    expect(resolveCheckpointMechanismName("post-research", undefined, undefined, undefined, "noop")).toBe("noop");
    expect(resolveCheckpointMechanismName("post-research", undefined, undefined, undefined, "disk")).toBe("disk");
  });
});

describe("resolveCheckpointMechanismName — per-checkpoint overrides (s14-c3)", () => {
  it("per-checkpoint override beats mode default: post-research='cli' with mode='careful'", () => {
    const config = {
      pipeline: {
        mode: "careful" as const,
        checkpointOverrides: { "post-research": "cli" },
      },
    };
    // post-research overridden to cli; other checkpoints use careful default (disk)
    expect(resolveCheckpointMechanismName("post-research", config)).toBe("cli");
    expect(resolveCheckpointMechanismName("post-plan", config)).toBe("disk");
  });

  it("per-checkpoint override beats global checkpointMechanism: overrides[post-research]='cli' global='disk'", () => {
    const config = {
      pipeline: {
        checkpointMechanism: "disk",
        checkpointOverrides: { "post-research": "cli" },
      },
    };
    expect(resolveCheckpointMechanismName("post-research", config)).toBe("cli");
    expect(resolveCheckpointMechanismName("post-plan", config)).toBe("disk");
  });
});

describe("resolveCheckpointMechanismName — CLI override tiers (s14-c4)", () => {
  it("cliOverride alone is deferred: per-checkpoint config override still wins", () => {
    const config = {
      pipeline: {
        checkpointOverrides: { "post-research": "cli" },
      },
    };
    // cliOverride='pr' but per-checkpoint config override wins for post-research
    expect(resolveCheckpointMechanismName("post-research", config, "pr")).toBe("cli");
    // Other checkpoints use cliOverride
    expect(resolveCheckpointMechanismName("post-plan", config, "pr")).toBe("pr");
  });

  it("cliOverrideAll + cliOverride overrides everything including per-checkpoint config", () => {
    const config = {
      pipeline: {
        checkpointMechanism: "disk",
        checkpointOverrides: { "post-research": "cli" },
      },
    };
    // cliOverrideAll forces cliOverride everywhere
    expect(resolveCheckpointMechanismName("post-research", config, "noop", true)).toBe("noop");
    expect(resolveCheckpointMechanismName("post-plan", config, "noop", true)).toBe("noop");
  });

  it("cliOverride without cliOverrideAll defers to per-checkpoint then falls to cliOverride", () => {
    const config = { pipeline: { mode: "careful" as const } };
    // No per-checkpoint override, no global → would fall to mode default (disk)
    // But cliOverride='pr' comes before mode default (tier 3 before tier 5)
    expect(resolveCheckpointMechanismName("post-research", config, "pr")).toBe("pr");
  });
});

// ---------------------------------------------------------------------------
// getCheckpointMechanismFor — back-compat with 2-arg and 3-arg forms
// ---------------------------------------------------------------------------

describe("getCheckpointMechanismFor — mode-based default integration", () => {
  it("mode='careful' → returns the registered 'disk' mechanism instance", () => {
    const config = { pipeline: { mode: "careful" as const } };
    const mech = getCheckpointMechanismFor("post-research", config);
    expect(mech).toBeDefined();
    expect(typeof mech.request).toBe("function");
  });

  it("mode='autopilot' → returns the registered 'noop' mechanism instance", () => {
    const config = { pipeline: { mode: "autopilot" as const } };
    const noopMech = getCheckpointMechanismFor("post-research", config);
    const carefulMech = getCheckpointMechanismFor("post-research", { pipeline: { mode: "careful" as const } });
    // noop and disk are different instances
    expect(noopMech).not.toBe(carefulMech);
  });

  it("3-arg fallback form still works when config has no mode/mechanism (back-compat)", () => {
    const config = { pipeline: {} };
    // Fallback='noop' via 3rd arg — should not throw
    const mech = getCheckpointMechanismFor("post-research", config, "noop");
    expect(mech).toBeDefined();
  });
});
