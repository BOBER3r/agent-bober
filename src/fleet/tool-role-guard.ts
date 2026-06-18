// ── fleet/tool-role-guard.ts ──────────────────────────────────────────
//
// Build-time guard: reject any fleet child whose RESOLVED BoberConfig would
// place the claude-code provider on a TOOL_ROLE (curator/generator/evaluator/
// codeReview). Front-loads the runtime invariant from config/loader.ts:264 to
// manifest-build time so no child is spawned on a violation.

import { isToolRole, effectiveProvider } from "../config/role-providers.js";
import type { RoleName } from "../config/role-providers.js";
import { buildChildConfig } from "./child-config.js";
import type { FleetChild, FleetManifest } from "./manifest.js";
import type { BoberConfig } from "../config/schema.js";

// ── Types ─────────────────────────────────────────────────────────────

export type ToolRoleViolation = {
  childFolder: string;
  role: RoleName;
  provider: "claude-code";
};

// All RoleName values to iterate; gate on isToolRole (derives from TOOL_ROLES).
const ALL_ROLES: RoleName[] = [
  "planner",
  "researcher",
  "curator",
  "generator",
  "evaluator",
  "codeReview",
  "chat",
];

// ── check (pure, never throws) ────────────────────────────────────────

/**
 * Inspect a single fleet child's RESOLVED config for a tool-role violation.
 * Returns the first ToolRoleViolation found, or null when the child is clean.
 * NEVER throws — callers can safely call this in any context.
 */
export function check(child: FleetChild, resolved: BoberConfig): ToolRoleViolation | null {
  for (const role of ALL_ROLES) {
    if (!isToolRole(role)) continue;
    if (effectiveProvider(role, resolved) === "claude-code") {
      return { childFolder: child.folder, role, provider: "claude-code" };
    }
  }
  return null;
}

// ── assertManifest (throws on first violation) ────────────────────────

/**
 * Validate every child in the manifest for tool-role violations.
 * Throws a named Error identifying the offending child.folder and role on the
 * first violation. Passes silently when all children are clean.
 *
 * @throws Error naming child.folder + role when any child places claude-code
 *         on a tool role.
 */
export function assertManifest(manifest: FleetManifest): void {
  for (const child of manifest.children) {
    const resolved = buildChildConfig(child);
    const v = check(child, resolved);
    if (v) {
      throw new Error(
        `Fleet child "${v.childFolder}" places claude-code on tool role "${v.role}" — ` +
          `claude-code cannot drive tools. Use an api-key provider (anthropic/openai-compat) ` +
          `for builder roles.`,
      );
    }
  }
}
