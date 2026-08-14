import { describe, expect, it } from "vitest";
import { z } from "zod";

import { PlanSpecSchema } from "./spec.js";
import {
  FeatureRequestSchema,
  ProblemReflectionSchema,
  ResearchDigestSchema,
  ResearchSectionsSchema,
  SchemaIssueSchema,
  parseProblemReflection,
  parseWithIssues,
  schemaIssuesOf,
  totalSchema,
} from "./problem-reflection.js";
import type { ProblemReflection, ResearchDigest } from "./problem-reflection.js";

/**
 * The port payload schemas the committed `coding` topology names, at the schema level.
 *
 * What these tests exist to catch:
 *
 *  - a `ProblemReflection` that accepts PROSE, which is the whole failure mode sc-11-1 is
 *    about: the shipped researcher emits a markdown blob, and a schema that shrugged at one
 *    would make "the researcher framed the problem" unfalsifiable;
 *  - a schema that accepts `rules: []` or `rules: [""]`. Both are "the rules were not
 *    stated" and a `.min(1)` on only one of the two levels catches only one of them;
 *  - a DIAGNOSTIC that does not name the failing field, or names it in a form nothing can
 *    assert on. The criterion is not "it was rejected", it is "rejected WITH the failing
 *    Zod path reported", so every rejection below asserts the exact path;
 *  - a diagnostic that ECHOES the value it refused, which would put the rejected payload
 *    back into whatever the diagnostic is written to — the propagation the fail-closed
 *    gates exist to prevent (sc-11-5), leaking in through the diagnostic instead;
 *  - `totalSchema` quietly becoming a validation bypass rather than a re-typing.
 *
 * Pure schema tests: no filesystem, no clock, no graph. The runtime half of sc-11-1 — a
 * prose emission refused by `research_reflect` mid-run with the path in the refusal — is in
 * `src/pge/nodes/research.test.ts`.
 */

// ── Fixtures ────────────────────────────────────────────────────────

function wellFormed(): ProblemReflection {
  return {
    goal: "wire the research region onto the graph",
    inputs: ["the feature request", "the committed topology artifact"],
    outputs: ["a research document under .bober/research/"],
    rules: ["the shipped agents are not modified"],
    constraints: ["the PGE layer stays unreachable from every shipped execution path"],
  };
}

/** What a researcher that emits prose instead of structure actually produces. */
const PROSE_ONLY = {
  text: "I looked at the repo and it seems fine. The architecture is reasonable.",
};

const ARRAY_FIELDS = ["inputs", "outputs", "rules", "constraints"] as const;

// ── sc-11-1: the reflection is structured, or it is refused ─────────

describe("ProblemReflectionSchema: structure is required and the failing path is named (sc-11-1)", () => {
  it("accepts a well-formed reflection unchanged", () => {
    const parsed = ProblemReflectionSchema.parse(wellFormed());
    expect(parsed).toEqual(wellFormed());
  });

  it("rejects an empty goal, naming `goal`", () => {
    const result = parseProblemReflection({ ...wellFormed(), goal: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toEqual(["goal"]);
    expect(result.issues[0].code).toBe("too_small");
  });

  it("rejects a missing goal, naming `goal`", () => {
    const { goal: _dropped, ...withoutGoal } = wellFormed();
    const result = parseProblemReflection(withoutGoal);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toEqual(["goal"]);
    expect(result.issues[0].code).toBe("invalid_type");
  });

  for (const field of ARRAY_FIELDS) {
    it(`rejects an EMPTY \`${field}\` array, naming \`${field}\``, () => {
      const result = parseProblemReflection({ ...wellFormed(), [field]: [] });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.map((issue) => issue.path)).toEqual([field]);
      expect(result.issues[0].code).toBe("too_small");
    });

    it(`rejects a BLANK member of \`${field}\`, naming \`${field}.0\``, () => {
      // The other half of the same defect: `["" ]` states the rules even less than `[]`
      // does, and a `.min(1)` on only the array would let it through.
      const result = parseProblemReflection({ ...wellFormed(), [field]: [""] });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.map((issue) => issue.path)).toEqual([`${field}.0`]);
      expect(result.issues[0].pathSegments).toEqual([field, 0]);
    });
  }

  it("rejects a PROSE-ONLY emission and names every missing field, `goal` among them", () => {
    const result = parseProblemReflection(PROSE_ONLY);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const paths = result.issues.map((issue) => issue.path).sort();
    expect(paths).toEqual(["constraints", "goal", "inputs", "outputs", "rules"]);
    expect(paths).toContain("goal");
    // Every one of them is "you did not send this field", not "this field is malformed".
    expect(result.issues.every((issue) => issue.code === "invalid_type")).toBe(true);
  });

  it("does not echo the refused payload anywhere in the diagnostic", () => {
    // A diagnostic that carried the value would re-introduce the rejected payload into
    // whatever it is written to. The refusal names the SHAPE, never the content.
    const secret = "prose-only-marker-should-never-be-quoted";
    const result = parseProblemReflection({ text: secret, goal: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.issues)).not.toContain(secret);
  });

  it("reports a nested path with both a dotted string and raw segments", () => {
    const result = parseProblemReflection({ ...wellFormed(), inputs: ["ok", 7] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0].path).toBe("inputs.1");
    expect(result.issues[0].pathSegments).toEqual(["inputs", 1]);
    // The two answer different questions and must not drift: a human reads the string, a
    // test that wants to know WHICH member failed reads the segments without re-parsing.
    expect(result.issues[0].pathSegments.join(".")).toBe(result.issues[0].path);
  });

  it("shapes every issue the way `SchemaIssueSchema` declares", () => {
    const result = parseProblemReflection(PROSE_ONLY);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const issue of result.issues) {
      expect(() => SchemaIssueSchema.parse(issue)).not.toThrow();
    }
  });
});

// ── The flattening itself ───────────────────────────────────────────

describe("schemaIssuesOf / parseWithIssues: one flattening for every refusal", () => {
  it("reports a ROOT-level failure as the empty path", () => {
    const result = parseWithIssues(ProblemReflectionSchema, "not an object at all");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toEqual([""]);
    expect(result.issues[0].pathSegments).toEqual([]);
  });

  it("preserves Zod's own issue ORDER, so a diagnostic is stable across runs", () => {
    const schema = z.object({ a: z.string(), b: z.string(), c: z.string() });
    const first = parseWithIssues(schema, {});
    const second = parseWithIssues(schema, {});
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (first.ok || second.ok) return;
    expect(first.issues.map((issue) => issue.path)).toEqual(["a", "b", "c"]);
    expect(first.issues).toEqual(second.issues);
  });

  it("returns the PARSED value on success, not the input object", () => {
    const raw = { featureRequest: "ship it", projectRoot: "/tmp/x", extra: "dropped" };
    const result = parseWithIssues(FeatureRequestSchema, raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ featureRequest: "ship it", projectRoot: "/tmp/x" });
  });

  it("flattens a raw ZodError the same way `parseWithIssues` does", () => {
    const parsed = ProblemReflectionSchema.safeParse(PROSE_ONLY);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(schemaIssuesOf(parsed.error)).toEqual(
      (parseProblemReflection(PROSE_ONLY) as { ok: false; issues: unknown[] }).issues,
    );
  });
});

// ── totalSchema ─────────────────────────────────────────────────────

describe("totalSchema: a re-typing, never a validation bypass", () => {
  it("still refuses what the underlying schema refuses", () => {
    // `PlanSpecSchema` is the reason this function exists: `.default([])` members make its
    // input type differ from its output type, so it is not assignable to `z.ZodType<T>`.
    const retyped = totalSchema(PlanSpecSchema);
    expect(() => retyped.parse({ nonsense: true })).toThrow();
    expect(retyped.safeParse({ nonsense: true }).success).toBe(false);
  });

  it("returns the same schema object, so nothing is re-implemented", () => {
    expect(totalSchema(ProblemReflectionSchema)).toBe(ProblemReflectionSchema);
  });
});

// ── FeatureRequest ──────────────────────────────────────────────────

describe("FeatureRequestSchema: what crosses the research entry gate", () => {
  it("round-trips a well-formed request", () => {
    const request = { featureRequest: "wire the research region", projectRoot: "/tmp/root" };
    expect(FeatureRequestSchema.parse(request)).toEqual(request);
  });

  it("refuses an EMPTY feature request, naming `featureRequest`", () => {
    // This is the exact payload `research_body` emits for a run started with no request,
    // and the reason `gate_research_in` declares `check: "feature-request-present"`.
    const result = parseWithIssues(FeatureRequestSchema, {
      featureRequest: "",
      projectRoot: "/tmp/root",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toEqual(["featureRequest"]);
  });

  it("refuses an empty projectRoot, naming `projectRoot`", () => {
    const result = parseWithIssues(FeatureRequestSchema, {
      featureRequest: "ship it",
      projectRoot: "",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toEqual(["projectRoot"]);
  });
});

// ── ResearchDigest ──────────────────────────────────────────────────

describe("ResearchDigestSchema: what travels the research region's `digest` port", () => {
  function digest(): ResearchDigest {
    return {
      researchId: "research-20260805-region",
      timestamp: "2026-08-05T00:00:00.000Z",
      reflection: wellFormed(),
      questions: ["what does the interpreter forward to a successor?"],
      findings: "round 1 findings",
      sections: {
        architectureOverview: "superstep interpreter",
        existingPatterns: "commit boundary",
        keyFiles: "src/pge/runtime/interpreter.ts",
        integrationPoints: "src/pge/registry/index.ts",
        testCoverage: "src/pge/nodes/",
        riskAreas: "artifact drift",
      },
      filesExplored: ["src/pge/runtime/interpreter.ts"],
      questionsAnswered: 1,
      critique: null,
      reflexionRound: 0,
      documentId: null,
    };
  }

  it("round-trips a first-round digest, with `critique` and `documentId` null", () => {
    expect(ResearchDigestSchema.parse(digest())).toEqual(digest());
  });

  it("carries a critique as a REQUIRED nullable field, not an optional one", () => {
    // The reflexion loop's whole claim is that a re-entry is informed by the prior
    // critique, and the explorer's declared input is this one port. An OPTIONAL field
    // would let a digest omit the critique entirely and still parse, which is exactly
    // the silent break sc-11-2 is written to catch.
    const { critique: _dropped, ...withoutCritique } = digest();
    const result = parseWithIssues(ResearchDigestSchema, withoutCritique);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toEqual(["critique"]);

    const carried = ResearchDigestSchema.parse({ ...digest(), critique: "address the risk areas" });
    expect(carried.critique).toBe("address the risk areas");
  });

  it("embeds the REFLECTION schema, so an unstructured reflection cannot ride inside a digest", () => {
    const result = parseWithIssues(ResearchDigestSchema, { ...digest(), reflection: PROSE_ONLY });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path).sort()).toEqual([
      "reflection.constraints",
      "reflection.goal",
      "reflection.inputs",
      "reflection.outputs",
      "reflection.rules",
    ]);
  });

  it("refuses a negative reflexion round", () => {
    const result = parseWithIssues(ResearchDigestSchema, { ...digest(), reflexionRound: -1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toEqual(["reflexionRound"]);
  });

  it("keeps `documentId` nullable, because a digest reaches the exit gate before it is written", () => {
    expect(ResearchDigestSchema.parse({ ...digest(), documentId: null }).documentId).toBeNull();
    expect(ResearchDigestSchema.parse({ ...digest(), documentId: "research-x" }).documentId).toBe(
      "research-x",
    );
    const missing = parseWithIssues(ResearchDigestSchema, (() => {
      const { documentId: _dropped, ...rest } = digest();
      return rest;
    })());
    expect(missing.ok).toBe(false);
  });

  it("requires every one of the six shipped research sections", () => {
    const result = parseWithIssues(ResearchSectionsSchema, { architectureOverview: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path).sort()).toEqual([
      "existingPatterns",
      "integrationPoints",
      "keyFiles",
      "riskAreas",
      "testCoverage",
    ]);
  });
});

// ── nonGoal #3: no parallel vocabulary ──────────────────────────────

describe("no parallel contract vocabulary is introduced here (nonGoal #3)", () => {
  it("declares none of the source documents' errata FIELDS on any exported schema", () => {
    // `sprint_id`, `goals`, `files_to_edit`, `verification_commands` and `trip_goal` are
    // errata from the source documents. A schema that declared one would be a second
    // contract vocabulary growing beside `SprintContractSchema` and
    // `ClarificationQuestionSchema`. Read off the SCHEMAS rather than the source text: the
    // module's own header names the errata in order to disown them, and a grep would
    // therefore fail on the very sentence that documents the rule.
    const ERRATA = ["sprint_id", "goals", "files_to_edit", "verification_commands", "trip_goal"];

    const seen = new Set<string>();
    const walk = (schema: z.ZodTypeAny, depth = 0): void => {
      if (depth > 6) return;
      if (schema instanceof z.ZodObject) {
        for (const [key, value] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
          seen.add(key);
          walk(value, depth + 1);
        }
        return;
      }
      if (schema instanceof z.ZodArray) walk(schema.element as z.ZodTypeAny, depth + 1);
      else if (schema instanceof z.ZodNullable || schema instanceof z.ZodOptional) {
        walk(schema.unwrap() as z.ZodTypeAny, depth + 1);
      }
    };

    for (const schema of [
      ProblemReflectionSchema,
      FeatureRequestSchema,
      ResearchSectionsSchema,
      ResearchDigestSchema,
      SchemaIssueSchema,
    ]) {
      walk(schema);
    }

    // Positive control: the walk really did visit the fields it claims to have visited.
    expect(seen.has("goal")).toBe(true);
    expect(seen.has("reflection")).toBe(true);
    expect(seen.has("architectureOverview")).toBe(true);
    expect([...seen].filter((key) => ERRATA.includes(key))).toEqual([]);
  });

  it("takes no dependency on the graph, orchestrator or provider layers", async () => {
    // This module sits in the layer whose whole value is that it loads without dragging an
    // executor in. An import of `src/pge/**` here would make `src/contracts/` unloadable
    // from the topology layer, which the ESLint module boundary forbids.
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./problem-reflection.ts", import.meta.url), "utf8"),
    );
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    expect(imports).toEqual(["zod"]);
  });
});
