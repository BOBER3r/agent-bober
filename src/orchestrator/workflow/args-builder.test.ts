/**
 * Unit tests for ArgsPayloadBuilder.
 *
 * ArgsPayloadBuilder.build is pure (no fs), so tests don't need temp dirs.
 * Uses createDefaultConfig for a valid base config.
 */

import { describe, it, expect } from "vitest";

import { ArgsPayloadBuilder } from "./args-builder.js";
import { MissingKnobError, AgentCapError, NonSerializableArgError } from "./errors.js";
import { createDefaultConfig } from "../../config/schema.js";
import type { BoberConfig } from "../../config/schema.js";
import type { ResumeCursor } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────

function makeDefaultCursor(overrides?: Partial<ResumeCursor>): ResumeCursor {
  return {
    specId: "spec-test",
    completedSprintNumbers: [],
    lastObservedSprintNumber: 0,
    ...overrides,
  };
}

function makeConfig(): BoberConfig {
  return createDefaultConfig("test-project", "brownfield");
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("ArgsPayloadBuilder", () => {
  describe("build (happy path)", () => {
    it("returns a fully JSON-serializable WorkflowArgs", () => {
      const builder = new ArgsPayloadBuilder();
      const config: BoberConfig = {
        ...makeConfig(),
        codeReview: { enabled: true, model: "sonnet", maxTurns: 15, timeoutMs: 300_000 },
      };
      const cursor = makeDefaultCursor();

      const args = builder.build("do something", config, cursor, "## Principles\n- No SDK imports.");

      // JSON round-trip equality
      const roundTripped = JSON.parse(JSON.stringify(args)) as unknown;
      expect(JSON.stringify(roundTripped)).toBe(JSON.stringify(args));
    });

    it("populates knobs from config fields", () => {
      const builder = new ArgsPayloadBuilder();
      const config: BoberConfig = {
        ...makeConfig(),
        codeReview: { enabled: true, model: "sonnet", maxTurns: 15, timeoutMs: 300_000 },
      };
      const cursor = makeDefaultCursor();

      const args = builder.build("prompt", config, cursor);

      expect(args.knobs.maxIterations).toBe(config.evaluator.maxIterations);
      expect(args.knobs.maxSprints).toBe(config.sprint.maxSprints);
      expect(args.knobs.researchPhase).toBe(config.pipeline.researchPhase);
      expect(args.knobs.architectPhase).toBe(config.pipeline.architectPhase);
      expect(args.knobs.curatorEnabled).toBe(config.curator!.enabled);
      expect(args.knobs.codeReviewEnabled).toBe(true);
    });

    it("populates models from config", () => {
      const builder = new ArgsPayloadBuilder();
      const config = makeConfig();
      const cursor = makeDefaultCursor();

      // codeReview section is absent in default config — that would throw MissingKnobError.
      // Add it so we can test a complete happy path.
      const fullConfig: BoberConfig = {
        ...config,
        codeReview: { enabled: true, model: "sonnet", maxTurns: 15, timeoutMs: 300_000 },
      };

      const args = builder.build("prompt", fullConfig, cursor);

      expect(args.models.planner).toBe("opus");
      expect(args.models.curator).toBe("opus");
      expect(args.models.generator).toBe("sonnet");
      expect(args.models.evaluator).toBe("sonnet");
    });

    it("derives evaluatorLenses from strategies using label ?? type", () => {
      const builder = new ArgsPayloadBuilder();
      const config: BoberConfig = {
        ...makeConfig(),
        codeReview: { enabled: true, model: "sonnet", maxTurns: 15, timeoutMs: 300_000 },
        evaluator: {
          ...makeConfig().evaluator,
          strategies: [
            { type: "typecheck", required: true, label: "TypeCheck" },
            { type: "lint", required: false },
            { type: "unit-test", required: true, label: "Tests" },
          ],
        },
      };
      const cursor = makeDefaultCursor();

      const args = builder.build("prompt", config, cursor);

      expect(args.evaluatorLenses).toEqual(["TypeCheck", "lint", "Tests"]);
    });

    it("falls back to ['default'] when strategies is empty", () => {
      const builder = new ArgsPayloadBuilder();
      const config: BoberConfig = {
        ...makeConfig(),
        codeReview: { enabled: true, model: "sonnet", maxTurns: 15, timeoutMs: 300_000 },
        evaluator: {
          ...makeConfig().evaluator,
          strategies: [],
        },
      };
      const cursor = makeDefaultCursor();

      const args = builder.build("prompt", config, cursor);

      expect(args.evaluatorLenses).toEqual(["default"]);
    });

    it("passes the resumeCursor through to WorkflowArgs", () => {
      const builder = new ArgsPayloadBuilder();
      const config: BoberConfig = {
        ...makeConfig(),
        codeReview: { enabled: true, model: "sonnet", maxTurns: 15, timeoutMs: 300_000 },
      };
      const cursor = makeDefaultCursor({ completedSprintNumbers: [1, 2], lastObservedSprintNumber: 3 });

      const args = builder.build("prompt", config, cursor);

      expect(args.resumeCursor).toEqual(cursor);
    });

    it("passes the principles string through", () => {
      const builder = new ArgsPayloadBuilder();
      const config: BoberConfig = {
        ...makeConfig(),
        codeReview: { enabled: true, model: "sonnet", maxTurns: 15, timeoutMs: 300_000 },
      };
      const cursor = makeDefaultCursor();
      const principles = "## Principles\n- No SDK imports.\n- ESM .js specifiers.";

      const args = builder.build("prompt", config, cursor, principles);

      expect(args.principles).toBe(principles);
    });

    it("defaults principles to empty string when not provided", () => {
      const builder = new ArgsPayloadBuilder();
      const config: BoberConfig = {
        ...makeConfig(),
        codeReview: { enabled: true, model: "sonnet", maxTurns: 15, timeoutMs: 300_000 },
      };
      const cursor = makeDefaultCursor();

      const args = builder.build("prompt", config, cursor);

      expect(args.principles).toBe("");
    });
  });

  describe("MissingKnobError", () => {
    it("throws MissingKnobError when curator section is absent", () => {
      const builder = new ArgsPayloadBuilder();
      const config: BoberConfig = {
        ...makeConfig(),
        curator: undefined,
        codeReview: { enabled: true, model: "sonnet", maxTurns: 15, timeoutMs: 300_000 },
      };
      const cursor = makeDefaultCursor();

      expect(() => builder.build("prompt", config, cursor)).toThrow(MissingKnobError);
      expect(() => builder.build("prompt", config, cursor)).toThrow("curator.enabled");
    });

    it("throws MissingKnobError when codeReview section is absent", () => {
      const builder = new ArgsPayloadBuilder();
      // default config has no codeReview section
      const config = makeConfig();
      const cursor = makeDefaultCursor();

      expect(() => builder.build("prompt", config, cursor)).toThrow(MissingKnobError);
      expect(() => builder.build("prompt", config, cursor)).toThrow("codeReview.enabled");
    });

    it("MissingKnobError has the correct name property", () => {
      const builder = new ArgsPayloadBuilder();
      const config = makeConfig();
      const cursor = makeDefaultCursor();

      let caught: unknown;
      try {
        builder.build("prompt", config, cursor);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(MissingKnobError);
      expect((caught as MissingKnobError).name).toBe("MissingKnobError");
    });
  });

  describe("AgentCapError", () => {
    function makeFullConfig(): BoberConfig {
      return {
        ...makeConfig(),
        codeReview: { enabled: true, model: "sonnet", maxTurns: 15, timeoutMs: 300_000 },
      };
    }

    it("throws AgentCapError when total (maxSprints × maxIterations × lenses) exceeds 1000", () => {
      const builder = new ArgsPayloadBuilder();
      const config: BoberConfig = {
        ...makeFullConfig(),
        sprint: { ...makeConfig().sprint, maxSprints: 100 },
        evaluator: {
          ...makeConfig().evaluator,
          maxIterations: 11,
          strategies: [{ type: "typecheck", required: true }],
        },
      };
      const cursor = makeDefaultCursor();

      // 100 * 11 * 1 = 1100 > 1000
      expect(() => builder.build("prompt", config, cursor)).toThrow(AgentCapError);
    });

    it("throws AgentCapError when lenses.length exceeds 16", () => {
      const builder = new ArgsPayloadBuilder();
      const strategies = Array.from({ length: 17 }, (_, i) => ({
        type: `strategy-${i}`,
        required: false,
      }));
      const config: BoberConfig = {
        ...makeFullConfig(),
        evaluator: {
          ...makeConfig().evaluator,
          maxIterations: 1,
          strategies,
        },
        sprint: { ...makeConfig().sprint, maxSprints: 1 },
      };
      const cursor = makeDefaultCursor();

      // 17 lenses > 16 cap
      expect(() => builder.build("prompt", config, cursor)).toThrow(AgentCapError);
    });

    it("AgentCapError has the correct name property", () => {
      const builder = new ArgsPayloadBuilder();
      const config: BoberConfig = {
        ...makeFullConfig(),
        sprint: { ...makeConfig().sprint, maxSprints: 100 },
        evaluator: {
          ...makeConfig().evaluator,
          maxIterations: 11,
          strategies: [{ type: "typecheck", required: true }],
        },
      };
      const cursor = makeDefaultCursor();

      let caught: unknown;
      try {
        builder.build("prompt", config, cursor);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AgentCapError);
      expect((caught as AgentCapError).name).toBe("AgentCapError");
    });
  });

  describe("NonSerializableArgError", () => {
    it("throws NonSerializableArgError when a model value is a function (silent drop)", () => {
      const builder = new ArgsPayloadBuilder();
      const baseConfig: BoberConfig = {
        ...makeConfig(),
        codeReview: { enabled: true, model: "sonnet", maxTurns: 15, timeoutMs: 300_000 },
      };

      // Inject a function as curator.model — JSON.stringify silently drops it,
      // causing round-trip inequality → NonSerializableArgError
      const badConfig = {
        ...baseConfig,
        curator: {
          ...baseConfig.curator!,
          model: (() => "opus") as unknown as string,
        },
      };
      const cursor = makeDefaultCursor();

      expect(() => builder.build("prompt", badConfig, cursor)).toThrow(NonSerializableArgError);
    });

    it("throws NonSerializableArgError when a model value is a BigInt (throws stringify)", () => {
      const builder = new ArgsPayloadBuilder();
      const baseConfig: BoberConfig = {
        ...makeConfig(),
        codeReview: { enabled: true, model: "sonnet", maxTurns: 15, timeoutMs: 300_000 },
      };

      const badConfig = {
        ...baseConfig,
        planner: {
          ...baseConfig.planner,
          model: BigInt(42) as unknown as string,
        },
      };
      const cursor = makeDefaultCursor();

      expect(() => builder.build("prompt", badConfig, cursor)).toThrow(NonSerializableArgError);
    });

    it("NonSerializableArgError has the correct name property", () => {
      const builder = new ArgsPayloadBuilder();
      const baseConfig: BoberConfig = {
        ...makeConfig(),
        codeReview: { enabled: true, model: "sonnet", maxTurns: 15, timeoutMs: 300_000 },
      };

      const badConfig = {
        ...baseConfig,
        curator: {
          ...baseConfig.curator!,
          model: (() => "opus") as unknown as string,
        },
      };
      const cursor = makeDefaultCursor();

      let caught: unknown;
      try {
        builder.build("prompt", badConfig, cursor);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(NonSerializableArgError);
      expect((caught as NonSerializableArgError).name).toBe("NonSerializableArgError");
    });
  });
});
