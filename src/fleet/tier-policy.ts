import type { ProviderName } from "../providers/factory.js";

// ── Types ────────────────────────────────────────────────────────────

export type DifficultyTier = "default" | "cheap" | "standard" | "hard" | "frontier";

export interface RoleProviderBlock {
  provider: ProviderName;
  model: string;
  endpoint?: string | null;
}

export interface TieredRoleBlock {
  planner: RoleProviderBlock;
  generator: RoleProviderBlock;
  evaluator: RoleProviderBlock;
}

export interface TierProviderPolicy {
  resolveTier(tier?: DifficultyTier): TieredRoleBlock | undefined;
  knownTiers(): DifficultyTier[];
}

// ── Tier policy table ────────────────────────────────────────────────

const DEEPSEEK_BLOCK: RoleProviderBlock = {
  provider: "openai-compat",
  model: "deepseek",
  endpoint: "https://api.deepseek.com",
};

const GROK_BLOCK: RoleProviderBlock = {
  provider: "openai-compat",
  model: "grok",
  endpoint: "https://api.x.ai/v1",
};

const SONNET_BLOCK: RoleProviderBlock = {
  provider: "anthropic",
  model: "sonnet",
  endpoint: null,
};

const OPUS_BLOCK: RoleProviderBlock = {
  provider: "anthropic",
  model: "opus",
  endpoint: null,
};

const TIER_POLICY: Record<Exclude<DifficultyTier, "default">, TieredRoleBlock> = {
  cheap: {
    planner: DEEPSEEK_BLOCK,
    generator: DEEPSEEK_BLOCK,
    evaluator: DEEPSEEK_BLOCK,
  },
  standard: {
    planner: GROK_BLOCK,
    generator: GROK_BLOCK,
    evaluator: GROK_BLOCK,
  },
  hard: {
    planner: SONNET_BLOCK,
    generator: SONNET_BLOCK,
    evaluator: SONNET_BLOCK,
  },
  frontier: {
    planner: OPUS_BLOCK,
    generator: OPUS_BLOCK,
    evaluator: OPUS_BLOCK,
  },
};

// ── Policy API ───────────────────────────────────────────────────────

export const tierPolicy: TierProviderPolicy = {
  resolveTier(tier?: DifficultyTier): TieredRoleBlock | undefined {
    return tier && tier !== "default" ? TIER_POLICY[tier] : undefined;
  },
  knownTiers(): DifficultyTier[] {
    return ["default", "cheap", "standard", "hard", "frontier"];
  },
};
