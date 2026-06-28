/**
 * Recommendation context assembler — reads meds/supplements from FactStore
 * and conditions/allergies/goals from the medical profile reader.
 *
 * NO network / NO LLM. All fs uses node:fs/promises (principles).
 *
 * FactStore lifecycle: injected store (tests) — caller owns; else open and close in finally.
 * Profile: wrapped in try/catch — degraded but functional when SOPS is unavailable or file absent.
 *
 * Most similar: src/medical/analysis/review-pass.ts (open-store / try / finally-close / inject-store).
 * supplement predicate is "dose" (not "takes-supplement") — see supplements.ts:106-121.
 */

import { join } from "node:path";

import type { BoberConfig } from "../../config/schema.js";
import { FactStore, factsDbPath } from "../../state/facts.js";
import type { FactRecord } from "../../state/facts.js";
import { readProfile } from "../profile.js";
import type { ProfileCipher } from "../profile.js";

// -- Types ---------------------------------------------------------------

export interface RecommendationContext {
  meds: FactRecord[];
  supplements: Array<{ name: string; dose: string }>;
  conditions: string[];
  allergies: string[];
  goal?: string;
}

export interface ContextDeps {
  /** Injected FactStore (tests pass :memory:); caller owns lifecycle. */
  facts?: FactStore;
  /** Injected ProfileCipher for tests (avoids real SOPS binary). */
  profileCipher?: ProfileCipher;
}

// -- Public API ----------------------------------------------------------

/**
 * Assemble the recommendation context from FactStore and the medical profile.
 *
 * Meds: scope="medical", subject="patient", predicate="takes-medication".
 * Supplements: scope="medical", predicate="dose" (subject = supplement name).
 * Profile: conditions/allergies/goals from profile.yaml; defaults to [] on any error.
 */
export async function assembleRecommendationContext(
  projectRoot: string,
  _config: BoberConfig,
  opts: { goal?: string },
  deps: ContextDeps = {},
): Promise<RecommendationContext> {
  // -- Meds + supplements from FactStore --------------------------------
  let meds: FactRecord[] = [];
  let supplements: Array<{ name: string; dose: string }> = [];

  if (deps.facts !== undefined) {
    // Injected store (tests) — caller owns lifecycle; do NOT close
    meds = deps.facts.getActiveFacts("medical", "patient", "takes-medication");
    // PITFALL: supplements use predicate="dose" with subject=supplement name (supplements.ts:106-121)
    const supplementFacts = deps.facts.getActiveFacts("medical", undefined, "dose");
    supplements = supplementFacts.map((r) => ({ name: r.subject, dose: r.value }));
  } else {
    // Production: open our own store; close in finally
    const dbPath = factsDbPath(projectRoot, "medical");
    let facts: FactStore | undefined;
    try {
      facts = new FactStore(dbPath);
      meds = facts.getActiveFacts("medical", "patient", "takes-medication");
      const supplementFacts = facts.getActiveFacts("medical", undefined, "dose");
      supplements = supplementFacts.map((r) => ({ name: r.subject, dose: r.value }));
    } catch {
      // Dir not created yet → graceful empty (mirrors engine.ts:365-381)
      // meds and supplements are already [] from initialization — nothing to reassign
    } finally {
      facts?.close();
    }
  }

  // -- Profile: conditions / allergies / goals --------------------------
  let conditions: string[] = [];
  let allergies: string[] = [];
  let profileGoals: string[] = [];

  // profile.yaml lives at <projectRoot>/.bober/medical (not in vaultDir)
  const profileDir = join(projectRoot, ".bober", "medical");
  try {
    const profile = await readProfile(profileDir, { cipher: deps.profileCipher });
    conditions = profile.conditions;
    allergies = profile.allergies;
    profileGoals = profile.goals;
  } catch {
    // SOPS unavailable or profile file absent — degraded but functional (contract assumption 1)
    // conditions, allergies, profileGoals are already [] from initialization — nothing to reassign
  }

  // Explicit goal wins; fall back to first profile goal
  const goal = opts.goal ?? (profileGoals.length > 0 ? profileGoals[0] : undefined);

  return { meds, supplements, conditions, allergies, goal };
}

// -- Context serializer --------------------------------------------------

/**
 * Serialize a RecommendationContext to a plain string for runJudgeLoop.
 * runJudgeLoop.context must be a STRING — this bridges the object to that contract.
 */
export function contextToString(ctx: RecommendationContext): string {
  const parts: string[] = [];

  if (ctx.meds.length > 0) {
    parts.push(`Medications: ${ctx.meds.map((m) => m.value).join(", ")}`);
  } else {
    parts.push("Medications: none");
  }

  if (ctx.supplements.length > 0) {
    parts.push(
      `Supplements: ${ctx.supplements.map((s) => `${s.name} (${s.dose})`).join(", ")}`,
    );
  } else {
    parts.push("Supplements: none");
  }

  if (ctx.conditions.length > 0) {
    parts.push(`Conditions: ${ctx.conditions.join(", ")}`);
  } else {
    parts.push("Conditions: none");
  }

  if (ctx.allergies.length > 0) {
    parts.push(`Allergies: ${ctx.allergies.join(", ")}`);
  } else {
    parts.push("Allergies: none");
  }

  if (ctx.goal !== undefined) {
    parts.push(`Goal: ${ctx.goal}`);
  }

  return parts.join("\n");
}
