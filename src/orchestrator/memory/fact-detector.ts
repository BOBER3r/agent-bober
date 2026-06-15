/**
 * PURE deterministic project-fact detector.
 *
 * PURE — no fs reads, no Date.now(), no createClient, no network access, no side effects.
 * Takes already-parsed manifests/config as inputs and returns FactDraft[] deterministically.
 * The thin IO caller (seedProjectFacts) handles all fs reads and clock-stamping.
 *
 * Mirror of distill.ts: the pure fn is separate from the IO boundary.
 */

import { readFile, access } from "node:fs/promises";
import { join } from "node:path";

import type { FactInput } from "../../state/facts.js";
import {
  FactStore,
  factsDbPath,
  ensureFactsDir,
  writeFact,
} from "../../state/facts.js";

// ── Types ─────────────────────────────────────────────────────────────

/** Already-parsed manifests/config passed in by the thin IO caller. */
export interface ProjectInputs {
  /** Parsed package.json content (or null if absent). */
  packageJson: Record<string, unknown> | null;
  /** Parsed bober.config.json content (optional). */
  boberConfig?: Record<string, unknown> | null;
  /**
   * Lockfile presence flags, computed by the caller (no fs in the pure fn).
   * First truthy flag in order npm → yarn → pnpm determines packageManager.
   */
  lockfiles?: { npm?: boolean; yarn?: boolean; pnpm?: boolean };
}

/**
 * A fact draft — everything EXCEPT the injected timestamps, which the caller stamps.
 * Mirrors the FactInput shape but without tValid and tCreated.
 */
export type FactDraft = Omit<FactInput, "tValid" | "tCreated">;

// ── Pure detector ─────────────────────────────────────────────────────

/**
 * PURE: map parsed manifests/config into project-fact drafts.
 * NO fs read, NO Date.now(), NO LLM. Returns [] when nothing is detectable.
 *
 * Detection rules:
 *   project/testCommand   ← packageJson.scripts.test (if truthy)
 *   project/buildCommand  ← packageJson.scripts.build (if truthy)
 *   project/packageManager ← first lockfile present: npm > yarn > pnpm
 *   project/framework     ← first dep/devDep found: next > react > vue
 *
 * Scope convention: scope="" (default/programming team) per memoryDir mapping
 * in src/state/memory.ts:27-32. Namespace is a SEPARATE axis (DB file location).
 */
export function detectProjectFacts(inputs: ProjectInputs, scope = ""): FactDraft[] {
  const drafts: FactDraft[] = [];
  const pkg = inputs.packageJson;

  // ── Scripts → testCommand / buildCommand ─────────────────────────
  const scripts =
    pkg !== null && typeof pkg === "object" && pkg !== undefined
      ? (pkg.scripts as Record<string, unknown> | undefined)
      : undefined;

  if (scripts !== undefined && scripts !== null) {
    const testCmd = typeof scripts.test === "string" ? scripts.test : undefined;
    if (testCmd) {
      drafts.push(makeDraft(scope, "project", "project/testCommand", testCmd));
    }

    const buildCmd = typeof scripts.build === "string" ? scripts.build : undefined;
    if (buildCmd) {
      drafts.push(makeDraft(scope, "project", "project/buildCommand", buildCmd));
    }
  }

  // ── Lockfile presence → packageManager ───────────────────────────
  // bober: deterministic order: npm first, then yarn, then pnpm; first match wins
  const lockfiles = inputs.lockfiles ?? {};
  if (lockfiles.npm) {
    drafts.push(makeDraft(scope, "project", "project/packageManager", "npm"));
  } else if (lockfiles.yarn) {
    drafts.push(makeDraft(scope, "project", "project/packageManager", "yarn"));
  } else if (lockfiles.pnpm) {
    drafts.push(makeDraft(scope, "project", "project/packageManager", "pnpm"));
  }

  // ── Dependencies → framework ──────────────────────────────────────
  // Check deps + devDeps in fixed order: next before react (next implies react)
  if (pkg !== null && pkg !== undefined) {
    const deps = (pkg.dependencies as Record<string, unknown> | undefined) ?? {};
    const devDeps = (pkg.devDependencies as Record<string, unknown> | undefined) ?? {};
    const allDeps = { ...deps, ...devDeps };

    if ("next" in allDeps) {
      drafts.push(makeDraft(scope, "project", "project/framework", "next"));
    } else if ("react" in allDeps) {
      drafts.push(makeDraft(scope, "project", "project/framework", "react"));
    } else if ("vue" in allDeps) {
      drafts.push(makeDraft(scope, "project", "project/framework", "vue"));
    }
  }

  return drafts;
}

// ── Helper ────────────────────────────────────────────────────────────

function makeDraft(
  scope: string,
  subject: string,
  predicate: string,
  value: string,
): FactDraft {
  return {
    scope,
    subject,
    predicate,
    value,
    confidence: 1,
    sourceRunId: null,
  };
}

// ── IO seed (thin caller) ─────────────────────────────────────────────

/**
 * Thin IO wrapper: reads manifests from disk, calls the PURE detectProjectFacts,
 * then stamps wall-clock time and writes each draft through writeFact (idempotent).
 *
 * This is the ONLY function in this module that touches the filesystem or the clock.
 * It is extracted here so both pipeline.ts and chat-session.ts can reuse one helper
 * without duplicating the IO pattern.
 *
 * A missing package.json or bober.config.json is NORMAL — the detector returns a
 * partial set of drafts. Never throws for missing files.
 *
 * @param projectRoot - Absolute path to the project root
 * @param namespace   - Memory namespace (undefined → default .bober/memory/)
 */
export async function seedProjectFacts(
  projectRoot: string,
  namespace?: string,
): Promise<void> {
  // ── Read manifests (best-effort; missing files → null/false) ─────
  let packageJson: Record<string, unknown> | null = null;
  try {
    const raw = await readFile(join(projectRoot, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    packageJson = typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // Missing or unparseable package.json → leave null
  }

  let boberConfig: Record<string, unknown> | null = null;
  try {
    const raw = await readFile(join(projectRoot, "bober.config.json"), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    boberConfig = typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // Missing or unparseable bober.config.json → leave null
  }

  // ── Detect lockfile presence (fs.access is synchronous-ish, but async) ──
  const [npmExists, yarnExists, pnpmExists] = await Promise.all([
    access(join(projectRoot, "package-lock.json")).then(() => true).catch(() => false),
    access(join(projectRoot, "yarn.lock")).then(() => true).catch(() => false),
    access(join(projectRoot, "pnpm-lock.yaml")).then(() => true).catch(() => false),
  ]);

  const inputs: ProjectInputs = {
    packageJson,
    boberConfig,
    lockfiles: { npm: npmExists, yarn: yarnExists, pnpm: pnpmExists },
  };

  // ── Detect (PURE) ─────────────────────────────────────────────────
  const drafts = detectProjectFacts(inputs);
  if (drafts.length === 0) return;

  // ── Write through reconcile (idempotent — NOOP on unchanged) ─────
  // Stamp wall-clock once at the IO boundary (NEVER inside the pure fn).
  const now = new Date().toISOString();

  await ensureFactsDir(projectRoot, namespace);
  const store = new FactStore(factsDbPath(projectRoot, namespace));
  try {
    for (const draft of drafts) {
      await writeFact(store, { ...draft, tValid: now, tCreated: now }, { now });
    }
  } finally {
    store.close();
  }
}
