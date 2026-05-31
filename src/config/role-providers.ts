import { resolveProviderModel } from "../orchestrator/model-resolver.js";
import { logger } from "../utils/logger.js";
import type { BoberConfig } from "./schema.js";

/**
 * All six logical roles the orchestrator routes to.
 * Tool roles require a non-claude-code provider (claude-code cannot drive tools).
 * Prompt roles (planner, researcher) are allowed on claude-code unconditionally.
 */
export type RoleName =
  | "planner"
  | "researcher"
  | "curator"
  | "generator"
  | "evaluator"
  | "codeReview";

export type RoleProviderMap = Record<RoleName, string>;

/**
 * Roles that drive tool use — cannot use the claude-code provider.
 * Order determines which role's provider is chosen as the fallback target.
 */
const TOOL_ROLES: RoleName[] = ["curator", "generator", "evaluator", "codeReview"];

/**
 * Roles that are prompt-only — claude-code is always allowed.
 * Researcher has no dedicated config section; it shares planner's config.
 */
const PROMPT_ROLES: RoleName[] = ["planner", "researcher"];

/**
 * Stable iteration order over ALL roles (prompt first, then tool).
 * This order determines which non-claude-code provider is chosen as the
 * fallback when a tool role would otherwise land on claude-code.
 */
const ALL_ROLES: RoleName[] = [...PROMPT_ROLES, ...TOOL_ROLES];

/**
 * Compute the raw effective provider for a single role from the config.
 *
 * Resolution:
 * - researcher → use planner's section (no dedicated researcher section)
 * - codeReview absent → mirror code-reviewer-agent.ts:63/75: fall back to evaluator
 * - For the resolved section: resolveProviderModel(model, provider).provider
 *   (explicitProvider wins; otherwise model shorthand → provider)
 */
function effectiveProvider(role: RoleName, config: BoberConfig): string {
  let model: string | undefined;
  let provider: string | undefined;

  if (role === "researcher") {
    // No dedicated researcher section — shares planner config
    model = config.planner?.model;
    provider = config.planner?.provider;
  } else if (role === "codeReview") {
    // codeReview is optional — mirror code-reviewer-agent.ts:63/75 fallback to evaluator
    model = config.codeReview?.model ?? config.evaluator?.model;
    provider = config.codeReview?.provider ?? config.evaluator?.provider;
  } else {
    const section = config[role];
    model = section?.model;
    provider = section?.provider;
  }

  // model is always defined for planner/generator/evaluator post-schema-parse due to .default()
  // For curator and codeReview (optional sections), model may be undefined when section is absent.
  // Fall back to "sonnet" so the resolver has something to work with.
  const resolvedModel = model ?? "sonnet";
  return resolveProviderModel(resolvedModel, provider).provider;
}

/**
 * Resolve the finally-effective provider for every role in the config.
 *
 * Rules (PRD US-006):
 * 1. Compute raw effective provider per role via resolveProviderModel.
 * 2. Determine the fallback target: the first non-claude-code provider found
 *    across ALL roles in stable iteration order (prompt roles first, then tool roles).
 * 3. For each role:
 *    - PROMPT_ROLES: use raw provider (claude-code is allowed).
 *    - TOOL_ROLES:
 *      - If raw provider !== "claude-code": use it directly.
 *      - Else if a fallback exists: redirect to fallback.
 *      - Else: THROW — naming the role — because claude-code cannot drive tools
 *        and no alternative provider is configured.
 * 4. Log one line per role (role name + finally-resolved provider) for auditability.
 *
 * @throws Error naming the first offending tool role when claude-code is the sole
 *         provider option for that role and no alternative exists.
 */
export function resolveRoleProviders(config: BoberConfig): RoleProviderMap {
  // Step 1: compute raw effective provider for every role
  const raw: Record<RoleName, string> = {} as Record<RoleName, string>;
  for (const role of ALL_ROLES) {
    raw[role] = effectiveProvider(role, config);
  }

  // Step 2: find the fallback target — first non-claude-code provider in stable order
  let fallback: string | undefined;
  for (const role of ALL_ROLES) {
    if (raw[role] !== "claude-code") {
      fallback = raw[role];
      break;
    }
  }

  // Step 3: resolve each role, applying claude-code redirect/throw for tool roles
  const resolved: Record<RoleName, string> = {} as Record<RoleName, string>;

  for (const role of ALL_ROLES) {
    const p = raw[role];

    if ((PROMPT_ROLES as RoleName[]).includes(role)) {
      // Prompt roles: claude-code is always allowed
      resolved[role] = p;
    } else {
      // Tool roles: redirect or throw if stuck on claude-code
      if (p !== "claude-code") {
        resolved[role] = p;
      } else if (fallback !== undefined) {
        // Redirect to the first non-claude-code provider among all roles
        resolved[role] = fallback;
      } else {
        throw new Error(
          `Role "${role}" resolves to the claude-code provider, which cannot drive tools, ` +
          `and no alternative provider is configured. Set a per-role provider for "${role}" ` +
          `or change the default provider away from claude-code.`,
        );
      }
    }
  }

  // Step 4: log the finally-resolved provider for every role (sc-5-4)
  for (const role of ALL_ROLES) {
    logger.info(`role ${role} resolved to provider ${resolved[role]}`);
  }

  return resolved;
}
