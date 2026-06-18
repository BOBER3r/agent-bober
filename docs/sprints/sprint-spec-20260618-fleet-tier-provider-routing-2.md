# TierProviderPolicy + buildChildConfig tier overlay

**Contract:** sprint-spec-20260618-fleet-tier-provider-routing-2  ·  **Spec:** spec-20260618-fleet-tier-provider-routing  ·  **Completed:** 2026-06-18

## What this sprint added

Lets a fleet **route a child to a difficulty tier** that maps the child's three
roles (planner / generator / evaluator) onto a provider block — DeepSeek, Grok,
Anthropic Sonnet, or Anthropic Opus — without touching the child's `task` or
`folder`. A new closed `DifficultyTier` enum (`default | cheap | standard | hard
| frontier`) and a `TierProviderPolicy` table live in `src/fleet/tier-policy.ts`;
`FleetChild` gains an optional `tier` field; and `buildChildConfig` overlays the
resolved tier block onto the base config **before** the existing shallow-merge.
The overlay is a pure additive layer: when `tier` is **absent or `default`**,
`resolveTier` returns `undefined`, the overlay is skipped, and the produced
`BoberConfig` is **byte-identical to today's DeepSeek default** (proven by a
deep-equal test). `claude-code` is **never** placed in any tier block — fleet
children build with the tool roles and tiers only ever name LLM providers. This
is **Sprint 2 of 3** in `spec-20260618-fleet-tier-provider-routing` (Phase A of
`arch-20260618-heterogeneous-multi-provider-agent-team`).

## Public surface

- `type DifficultyTier` (`src/fleet/tier-policy.ts:5`) — closed union
  `"default" | "cheap" | "standard" | "hard" | "frontier"`.
- `interface RoleProviderBlock` (`src/fleet/tier-policy.ts:7`) —
  `{ provider: ProviderName; model: string; endpoint?: string | null }`; matches the
  per-role section shape `buildChildConfig` already writes.
- `interface TieredRoleBlock` (`src/fleet/tier-policy.ts:13`) — one
  `RoleProviderBlock` each for `planner` / `generator` / `evaluator`.
- `interface TierProviderPolicy` (`src/fleet/tier-policy.ts:19`) —
  `resolveTier(tier?)` + `knownTiers()`.
- `const tierPolicy: TierProviderPolicy` (`src/fleet/tier-policy.ts:75`) — the singleton.
  `resolveTier(tier)` returns the `TieredRoleBlock` for a named tier and
  **`undefined` for `'default'` or `undefined`** (no overlay). `knownTiers()`
  returns all five enum values.
- `FleetChild.tier?` (`src/fleet/manifest.ts:10`) — optional manifest field,
  `z.enum(["default","cheap","standard","hard","frontier"]).optional()`. A value
  outside the enum is a `ZodError`; absent leaves the parsed child shape unchanged.
- `buildChildConfig(child)` tier overlay (`src/fleet/child-config.ts:44`) — after the
  three DeepSeek hard-sets and **before** the unchanged
  `const merged = { ...base, ...(child.config ?? {}) }` at `child-config.ts:51`,
  applies `tierPolicy.resolveTier(child.tier)` over `base.planner/generator/evaluator`
  when a block is returned.

### Tier → provider table

| Tier | Provider | Model | Endpoint |
|---|---|---|---|
| `default` / absent | (no overlay) | — | — → DeepSeek default unchanged |
| `cheap` | `openai-compat` | `deepseek` | `https://api.deepseek.com` |
| `standard` | `openai-compat` | `grok` | `https://api.x.ai/v1` |
| `hard` | `anthropic` | `sonnet` | `null` |
| `frontier` | `anthropic` | `opus` | `null` |

All three roles of a tiered child get the **same** block. The `cheap` block is the
DeepSeek default expressed explicitly; `default`/absent skips the overlay entirely.
No tier block names `claude-code`.

## How to use / how it fits

Add an optional `tier` to a manifest child to route its roles to a provider tier.
A child with **no** `tier` runs exactly as before (DeepSeek default):

```jsonc
{
  "rootDir": ".",
  "concurrency": 3,
  "children": [
    { "folder": "api-server", "task": "Build a REST API with auth" },                  // no tier → DeepSeek default
    { "folder": "web-frontend", "task": "Build the React frontend", "tier": "standard" }, // Grok (api.x.ai/v1)
    { "folder": "billing", "task": "Implement Stripe billing", "tier": "frontier" }      // Anthropic Opus
  ]
}
```

Precedence is preserved: a child's explicit `config` still **wins** over the tier
block, because the overlay is applied to `base` *before* the
`merged = { ...base, ...(child.config ?? {}) }` shallow-merge. So a child with
`tier: "standard"` and `config.generator = { provider: "anthropic", model: "sonnet" }`
gets a generator on `anthropic` (the `config` value), planner/evaluator on Grok.

## Notes for maintainers

- **`default`/absent is the byte-identical guarantee.** `resolveTier` returns
  `undefined` for both, the overlay is skipped, and `buildChildConfig` output is
  deep-equal to the pre-change DeepSeek default. A test builds the expected config
  through `BoberConfigSchema.parse` and asserts `deepEqual` — keep this guarantee
  intact when editing the builder.
- **Overlay order is load-bearing.** It must stay **before** the unchanged
  `const merged = ...` line (`child-config.ts:51`) so `child.config` keeps winning.
  Do not fold the tier block into the merge.
- **Tier model ids are shorthands, config-overridable.** `deepseek` / `grok` /
  `sonnet` / `opus` resolve via the model resolver (Grok routing landed in Sprint 1);
  a child can override any role's model via `config`.
- **`claude-code` is head-only.** It is never in `TIER_POLICY`; children build with
  the tool roles. The `ToolRoleGuard` that *enforces* this is **Sprint 3** — not part
  of this sprint, though the tier blocks already never emit a `claude-code` role.
- **Scope.** Touched `src/fleet/tier-policy.ts` (new), `src/fleet/manifest.ts`,
  `src/fleet/child-config.ts`, and their collocated tests only. `ProviderName` and
  `BoberConfigSchema` are unchanged; no new SDK/network imports. +37 fleet tests; full
  suite 2714 passed — only the 6 pre-existing cockpit-integration MCP failures remain
  (unrelated). All 8 criteria passed iteration 1.
