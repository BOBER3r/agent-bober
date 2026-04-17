#!/usr/bin/env node
// One-off migration: convert legacy PlanSpec JSON files in .bober/specs/
// to the schema introduced in src/contracts/spec.ts.
//
// Idempotent: running again on already-migrated specs is a no-op.
//
// Usage:  node scripts/migrate-specs.mjs

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SPECS_DIR = ".bober/specs";

// Legacy → new priority enum
const PRIORITY_MAP = {
  must: "must-have",
  should: "should-have",
  could: "nice-to-have",
};

// Legacy estimatedSprints → estimatedComplexity (rough heuristic)
function complexityFromSprints(n) {
  if (typeof n !== "number") return undefined;
  if (n <= 1) return "low";
  if (n <= 3) return "medium";
  return "high";
}

function migrateFeature(f) {
  const featureId = f.featureId ?? f.id;
  if (!featureId) {
    throw new Error(
      `Feature missing both featureId and id: ${JSON.stringify(f).slice(0, 100)}`,
    );
  }

  const priority = PRIORITY_MAP[f.priority] ?? f.priority;

  const out = {
    featureId,
    title: f.title,
    description: f.description,
    priority,
    acceptanceCriteria: f.acceptanceCriteria ?? [],
    dependencies: f.dependencies ?? [],
  };

  if (f.estimatedComplexity) {
    out.estimatedComplexity = f.estimatedComplexity;
  } else if (f.estimatedSprints !== undefined) {
    const c = complexityFromSprints(f.estimatedSprints);
    if (c) out.estimatedComplexity = c;
    out.estimatedSprints = f.estimatedSprints;
  }

  return out;
}

function migrateSpec(spec) {
  const mode = spec.mode ?? spec.projectType ?? "greenfield";
  if (mode !== "greenfield" && mode !== "brownfield") {
    throw new Error(
      `Spec ${spec.specId}: mode must be greenfield|brownfield (got ${mode})`,
    );
  }

  return {
    specId: spec.specId,
    version: spec.version ?? 1,
    title: spec.title,
    description: spec.description,
    status: spec.status ?? "completed",
    mode,
    features: (spec.features ?? []).map(migrateFeature),
    assumptions: spec.assumptions ?? [],
    outOfScope: spec.outOfScope ?? [],
    ambiguityScore: spec.ambiguityScore,
    clarificationQuestions: spec.clarificationQuestions ?? [],
    resolvedClarifications: spec.resolvedClarifications ?? [],
    techStack: spec.techStack ?? [],
    techNotes: spec.techNotes,
    nonFunctionalRequirements:
      spec.nonFunctionalRequirements ??
      // legacy: convert nonFunctional string[] to richer objects
      (spec.nonFunctional ?? []).map((req) => ({ requirement: req })),
    constraints: spec.constraints ?? [],
    sprints: spec.sprints,
    metadata: spec.metadata,
    createdAt: spec.createdAt,
    updatedAt: new Date().toISOString(),
    completedAt: spec.completedAt,
  };
}

async function main() {
  const entries = await readdir(SPECS_DIR);
  const jsonFiles = entries.filter((f) => f.endsWith(".json")).sort();

  console.log(`Migrating ${jsonFiles.length} specs...`);

  for (const file of jsonFiles) {
    const path = join(SPECS_DIR, file);
    const content = await readFile(path, "utf-8");
    const parsed = JSON.parse(content);

    let migrated;
    try {
      migrated = migrateSpec(parsed);
    } catch (err) {
      console.error(`✗ ${file}: ${err.message}`);
      process.exitCode = 1;
      continue;
    }

    // Strip undefineds before serializing for cleaner JSON
    const cleaned = JSON.parse(JSON.stringify(migrated));
    await writeFile(path, JSON.stringify(cleaned, null, 2) + "\n", "utf-8");
    console.log(`✓ ${file}`);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
