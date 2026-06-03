import { describe, it, expect } from "vitest";
import { reconcile as tsReconcile } from "./reconciler.js";
import { reconcile as jsReconcile } from "../../../.claude/workflows/lib/reconcile.js";
import { EvalResultSchema } from "../../contracts/eval-result.js";
import type { EvalResult } from "../../contracts/eval-result.js";
import vectors from "./__fixtures__/lens-vectors.json" with { type: "json" };

const TS = "2026-01-01T00:00:00.000Z"; // sentinel timestamp (matches reconciler.test.ts:6)

interface LensVector {
  name: string;
  lensVerdicts: EvalResult[];
}

describe("reconcile twin/port conformance (ADR-4 drift gate)", () => {
  for (const vector of vectors as LensVector[]) {
    it(`twin and port agree for "${vector.name}"`, () => {
      const tsOut = tsReconcile("s", 1, vector.lensVerdicts, TS);
      const jsOut = jsReconcile("s", 1, vector.lensVerdicts, TS);
      expect(jsOut).toEqual(tsOut); // C3 byte-identity
      expect(EvalResultSchema.safeParse(jsOut).success).toBe(true); // C4 schema-valid port
    });
  }
});
