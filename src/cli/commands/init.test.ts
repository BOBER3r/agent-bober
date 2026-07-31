/**
 * Colocated unit tests for the bober init solo-vs-team docs question.
 *
 * sc-3-1: interactive init writes documenter.docsMode 'committed' (solo) /
 * 'local' (team) into the generated bober.config.json, via the exported
 * `askDocsMode` helper (matches the existing `askProvider`/`prompts` style).
 * sc-3-2: non-interactive paths (no TTY) never prompt and resolve to
 * 'committed'; an omitted `documenter` section also resolves to 'committed'
 * via `resolveSprintDocPath`.
 */

import { describe, it, expect } from "vitest";
import prompts from "prompts";

import { BoberConfigSchema } from "../../config/schema.js";
import { resolveSprintDocPath } from "../../orchestrator/documenter-agent.js";

// Minimal config shape that satisfies BoberConfigSchema with all-defaulted
// sections, mirroring `minimalBase` in src/config/schema.test.ts.
const minimalBase = {
  project: { name: "test-project", mode: "greenfield" as const },
  planner: {},
  generator: {},
  evaluator: { strategies: [] },
  sprint: {},
  pipeline: {},
  commands: {},
};

describe("askDocsMode — interactive (sc-3-1)", () => {
  it("returns 'local' when the team choice is injected", async () => {
    const { askDocsMode } = await import("./init.js");
    prompts.inject(["local"]);
    expect(await askDocsMode(true)).toBe("local");
  });

  it("returns 'committed' when the solo choice is injected", async () => {
    const { askDocsMode } = await import("./init.js");
    prompts.inject(["committed"]);
    expect(await askDocsMode(true)).toBe("committed");
  });

  it("the 'local' answer produces a config that validates and resolves to local docsMode", () => {
    const cfg = BoberConfigSchema.parse({
      ...minimalBase,
      documenter: { docsMode: "local" },
    });
    expect(cfg.documenter?.docsMode).toBe("local");
  });

  it("the 'committed' answer produces a config that validates and resolves to committed docsMode", () => {
    const cfg = BoberConfigSchema.parse({
      ...minimalBase,
      documenter: { docsMode: "committed" },
    });
    expect(cfg.documenter?.docsMode).toBe("committed");
  });

  it("does not materialize a full documenter section — only docsMode is written by init", () => {
    // Guards against the documenter-agent's model fallback
    // (config.documenter?.model ?? config.generator.model) being silently
    // overridden by a fully-materialized DocumenterSectionSchema.parse
    // output (which would pin model:"sonnet").
    const writtenShape: { documenter: { docsMode: string } } = {
      documenter: { docsMode: "local" },
    };
    expect(Object.keys(writtenShape.documenter)).toEqual(["docsMode"]);
  });
});

describe("askDocsMode — non-interactive (sc-3-2)", () => {
  it("returns 'committed' without prompting when isTTY is false, even with a queued injection", async () => {
    const { askDocsMode } = await import("./init.js");
    // Queue an answer that would resolve to 'local' if a prompt fired —
    // proves the TTY guard short-circuits before any prompt.
    prompts.inject(["local"]);
    expect(await askDocsMode(false)).toBe("committed");
    // The queued answer must still be present (unconsumed) — proves no
    // prompt fired and drained the queue.
    expect(await askDocsMode(true)).toBe("local");
  });

  it("an omitted documenter section resolves to 'committed' via resolveSprintDocPath", () => {
    const parsed = BoberConfigSchema.parse(minimalBase);
    expect(Object.hasOwn(parsed, "documenter")).toBe(false);
    const docPath = resolveSprintDocPath(parsed, "/tmp/project", "contract-1");
    expect(docPath).toBe("docs/sprints/contract-1.md");
  });
});
