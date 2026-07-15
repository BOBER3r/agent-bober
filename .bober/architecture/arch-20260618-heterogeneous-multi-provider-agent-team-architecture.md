# Architecture: Heterogeneous Multi-Provider Agent-Team Worker Substrate

**Architecture ID:** arch-20260618-heterogeneous-multi-provider-agent-team
**Generated:** 2026-06-18T00:00:00Z
**Status:** draft

---

## Executive Summary

This system extends the existing bober fleet with a head-agnostic worker substrate that lets an external head (a Claude Code dynamic workflow on the Anthropic subscription, or a future bober-native head) route fleet children across four providers by per-task difficulty and synthesize their findings through a bounded shared blackboard. bober supplies only four irreducible seams — tier-to-provider config overlay, a Grok/xAI OpenAI-compat endpoint, a build-time tool-role guard, and a WAL-mode shared `facts.db` blackboard capped at three exchange rounds — while decomposition, difficulty triage, convergence, and resume remain the head's responsibility. The key tradeoff accepted: bober does NOT own orchestration intelligence (no objective difficulty primitive ships, so tier triage is unvalidated), in exchange for a stable manifest/CLI contract and a byte-identical no-flag single-provider path. The primary risk is the schema-strip channel: `BoberConfigSchema` (`src/config/schema.ts:405`) silently drops unknown keys, so the child-visible `fleet` block must be a declared schema section or the blackboard path never reaches the child. Every new code branch is gated on `undefined` (tier, blackboard, config.fleet) so the existing ~203 fleet tests remain green.

---

## Problem Statement

**Problem:** Fleet children are isolated single-provider (DeepSeek-default) execa OS processes that receive only a task string, so a head can neither route providers by task difficulty nor synthesize cross-agent findings.

**Constraints:**
- Latency: Not specified. Exchange is bounded by round cap, not wall-clock.
- Throughput: Bounded shared exchange — capped rounds, NOT free CrewAI-style discussion (prior research found free discussion fails to converge).
- Data volume: Bounded; blackboard exchange hard-capped at 3 rounds.
- Cost ceiling: Not specified as a number; difficulty-tiered provider routing exists to spend frontier providers only on hard tiers.
- Backward compatibility: No-flag single-provider path MUST stay byte-identical. Shallow-merge at `src/fleet/child-config.ts:43` (`const merged = { ...base, ...(child.config ?? {}) }`), `BoberConfigSchema` (`src/config/schema.ts:405`) strips unknown keys, EXPAND prompt forbids config/provider injection, `validateManifest` never throws, ~203 fleet tests must stay green.

**Consumers:** The head (Claude Code dynamic workflow, or future bober head) via the manifest + CLI contract; fleet children read the injected per-child config; the head reads back `{childResults, findings}`.

**Success Criteria:**
- Head emits a per-child difficulty tier; the tier maps to a provider block written into that child's `bober.config.json`.
- claude-code is NEVER assigned a tool role [curator, generator, evaluator, codeReview] — enforced at build/fail-fast time (`src/config/role-providers.ts:25`, runtime-enforced at `src/config/loader.ts:262-263`).
- Siblings publish and read findings through ONE shared FactStore namespace within a bounded round cap (<=3).
- Head synthesizes from the collected findings; the no-flag path is byte-identical.

**Locked Dependencies:**
- claude-code can drive only PROMPT_ROLES [planner, researcher, chat], never TOOL_ROLES (`src/config/role-providers.ts:25`); a Claude builder child must use the anthropic API-key provider.
- Children are isolated OS processes in separate cwds (`src/fleet/runner.ts:95`); the head receives only `{exitCode, stdout, stderr}` (`src/fleet/runner.ts:23-29`); shared state MUST be on-disk.
- FactStore is single-process better-sqlite3 opened WITHOUT WAL (`src/state/facts.ts:140`).

---

## System Overview

The head decomposes a goal and assigns each child a difficulty tier, then writes a fleet manifest. bober reads the manifest and, for each child, overlays a tier-mapped provider block (planner/generator/evaluator) onto the base config BEFORE the existing shallow-merge, scaffolds a `bober.config.json` that includes an absolute blackboard path, and spawns the child as an isolated execa process. Each child reaches the shared blackboard — one WAL-mode `facts.db` at a head-injected absolute path — to publish its findings and read its siblings' findings within a hard cap of three rounds. When all children exit, bober assembles `{childResults, findings}` as pure data (no LLM call) and returns it to the head, which performs synthesis and convergence using the dynamic workflow it already ships.

The selected approach (Approach C, ADR-1) is head-agnostic: bober builds only the four irreducible seams and exposes them behind a stable manifest/CLI contract, so any head — Claude Code dynamic workflow today, a bober head later — can drive the substrate without bober owning orchestration intelligence. Phase A (provider-by-tier overlay, Grok/xAI endpoint, tool-role guard) is mechanical mirroring of existing DeepSeek wiring; Phase B (shared WAL blackboard + synthesis collection) is the novel, higher-risk part.

---

## Component Breakdown

### TierProviderPolicy

**Responsibility:** Maps a difficulty tier to a per-role provider overlay block, returning `undefined` for the default/absent tier so no overlay is applied.

**Interface:**
```typescript
type ProviderName = "claude-code" | "openai-compat" | "anthropic";
type Tier = "default" | "cheap" | "standard" | "hard" | "frontier";

type RoleProviderBlock = {
  provider: ProviderName;
  model: string;
  endpoint?: string | null;
};

type TieredRoleBlock = {
  planner: RoleProviderBlock;
  generator: RoleProviderBlock;
  evaluator: RoleProviderBlock;
};

interface TierProviderPolicy {
  resolveTier(tier: Tier): TieredRoleBlock | undefined; // "default"/absent -> undefined
  knownTiers(): Tier[];
}
```

**Dependencies:** []

---

### BuildChildConfig (extended)

**Responsibility:** Overlays the tier provider block onto the base config before the existing shallow-merge, producing a byte-identical result when the tier is absent.

**Interface:**
```typescript
interface BuildChildConfig {
  applyTier(base: BoberConfig, tier: Tier | undefined, policy: TierProviderPolicy): BoberConfig;
  // applyTier overlays planner/generator/evaluator BEFORE
  // `merged = { ...base, ...(child.config ?? {}) }` at src/fleet/child-config.ts:43
}
```

**Dependencies:** [TierProviderPolicy]

---

### GrokProviderWiring

**Responsibility:** Adds Grok/xAI as an OpenAI-compat endpoint by mirroring the three DeepSeek touch-points, centralizing host detection in one predicate.

**Interface:**
```typescript
interface GrokProviderWiring {
  isXaiEndpoint(endpoint: string | null | undefined): boolean; // matches api.x.ai/v1
  // 1. SHORTHAND_MAP grok* -> { provider: "openai-compat", endpoint: "https://api.x.ai/v1" }
  //    (src/orchestrator/model-resolver.ts:22)
  // 2. validateApiKey api.x.ai arm -> XAI_API_KEY (factory.ts:86)
  // 3. createClient openai-compat key injection api.x.ai arm (factory.ts:251-255)
  // 4. validateManifestCredentials recognizes xAI keys (src/fleet/index.ts:46)
}
```

**Dependencies:** []

---

### ToolRoleGuard

**Responsibility:** Rejects any manifest that would place claude-code on a tool role, throwing in the fail-fast credential phase rather than inside the never-throw validateManifest.

**Interface:**
```typescript
type Role = "planner" | "researcher" | "chat" | "curator" | "generator" | "evaluator" | "codeReview";
type ToolRoleViolation = { childFolder: string; role: Role; provider: ProviderName };

interface ToolRoleGuard {
  isToolRole(role: Role): boolean; // curator|generator|evaluator|codeReview
  effectiveProvider(child: FleetChild, role: Role): ProviderName;
  check(child: FleetChild, resolved: BoberConfig): ToolRoleViolation | null;
  assertManifest(manifest: FleetManifest): void; // THROWS on violation
}
```

**Dependencies:** [TierProviderPolicy]

---

### SharedBlackboard

**Responsibility:** Provides one WAL-mode `facts.db` as a bounded publish/read channel for siblings, capped at three exchange rounds.

**Interface:**
```typescript
type FactRecord = {
  scope: string;     // namespace
  subject: string;   // childFolder
  predicate: "finding";
  value: string;     // payload
  round: number;
};

interface SharedBlackboard {
  open(absDbPath: string): void; // sets PRAGMA journal_mode=WAL; busy_timeout=5000
  publish(finding: FactRecord, now: number): void; // throws if round > maxRounds
  readSiblings(selfFolder: string): FactRecord[];
  readAll(): FactRecord[];
  close(): void; // checkpoints WAL
}
// const BLACKBOARD_MAX_ROUNDS = 3; // hard cap
```

**Dependencies:** []

---

### ManifestContract

**Responsibility:** Declares the optional tier/blackboard/fleet schema fields that make tier and blackboard path a child-visible channel surviving schema-strip.

**Interface:**
```typescript
type FleetChild = {
  // ...existing fields...
  tier?: Tier;                 // optional; absent -> no overlay
  config?: Partial<BoberConfig>;
};

type FleetManifest = {
  children: FleetChild[];
  blackboard?: { namespace: string; maxRounds: number /* <= 3 */ };
};

// BoberConfigSchema gains a DECLARED optional section (else schema strips it):
type FleetConfigSection = {
  blackboardDbPath?: string;     // ABSOLUTE
  blackboardNamespace?: string;
  maxRounds?: number;            // <= 3
};
// CLI: `--blackboard <namespace>` flag, default off
```

**Dependencies:** [TierProviderPolicy, SharedBlackboard]

---

### SynthesisStep

**Responsibility:** Assembles child results and blackboard findings into one pure data structure for the head, returning empty findings when no blackboard is configured.

**Interface:**
```typescript
type ChildSpawnResult = { childFolder: string; exitCode: number | null; stdout: string; stderr: string };
type CollectedOutput = { childResults: ChildSpawnResult[]; findings: FactRecord[] };

interface SynthesisStep {
  collect(blackboard: SharedBlackboard | null, childResults: ChildSpawnResult[]): CollectedOutput;
  // blackboard null -> findings []  (byte-identical no-flag path)
}
```

**Dependencies:** [SharedBlackboard]

---

## Data Model

```typescript
type Tier = "default" | "cheap" | "standard" | "hard" | "frontier";
type ProviderName = "claude-code" | "openai-compat" | "anthropic";

type RoleProviderBlock = { provider: ProviderName; model: string; endpoint?: string | null };
type TieredRoleBlock = { planner: RoleProviderBlock; generator: RoleProviderBlock; evaluator: RoleProviderBlock };

// Persisted on the shared blackboard as a FactStore row (scope=namespace, subject=childFolder).
type FactRecord = {
  scope: string;
  subject: string;
  predicate: "finding";
  value: string;
  round: number; // 1..BLACKBOARD_MAX_ROUNDS (3)
};

// Written into each child's bober.config.json (declared schema section, survives strip).
type FleetConfigSection = {
  blackboardDbPath?: string;   // ABSOLUTE, head-injected
  blackboardNamespace?: string;
  maxRounds?: number;          // <= 3
};
```

Source of truth: child `bober.config.json` is strongly consistent (written once, read once). The blackboard is the eventually-consistent best-effort channel bounded by <=3 rounds. `childResults` are strongly consistent after all children exit.

---

## API Contracts

| Method | Input | Output | Error Cases |
|--------|-------|--------|-------------|
| `TierProviderPolicy.resolveTier` | `Tier` | `TieredRoleBlock \| undefined` | none; unknown tier -> undefined (no overlay) |
| `BuildChildConfig.applyTier` | `(BoberConfig, Tier?, TierProviderPolicy)` | `BoberConfig` | none; tier undefined -> base unchanged |
| `ToolRoleGuard.assertManifest` | `FleetManifest` | `void` | THROWS `ToolRoleViolation` if claude-code on a tool role |
| `SharedBlackboard.open` | `absDbPath: string` | `void` | throws if path not absolute / db unopenable |
| `SharedBlackboard.publish` | `(FactRecord, now)` | `void` | throws if `round > maxRounds` |
| `SharedBlackboard.readSiblings` | `selfFolder: string` | `FactRecord[]` | empty array if none |
| `SynthesisStep.collect` | `(SharedBlackboard\|null, ChildSpawnResult[])` | `CollectedOutput` | none; null blackboard -> findings [] |

---

## Integration Strategy

### Data Flow

```
Head writes manifest (per-child tier; optional blackboard {namespace, maxRounds<=3})
 -> runFleet
   -> resolveBlackboardPath: ONE absolute path computed once in head
        join(resolve(rootDir), ".bober/memory/<ns>/facts.db")
   -> ToolRoleGuard.assertManifest(manifest)            [THROWS on claude-code tool role]
   -> validateManifestCredentials(manifest)             [applyTier in buildChildConfig + xAI key check]
   -> coordinator.execute
     -> mapBounded(children, concurrency, runChild)
       -> scaffolder writes bober.config.json incl. fleet.blackboardDbPath (ABSOLUTE)
       -> ChildRunner.run -> execa (src/fleet/runner.ts:95, separate cwd)
         -> [child] reads config.fleet
         -> SharedBlackboard.open(absPath) [PRAGMA WAL]
         -> publish / readSiblings within <= maxRounds
         -> exits -> {exitCode, stdout, stderr}
     -> coordinator collects ChildSpawnResult[]
   -> SynthesisStep.collect(blackboard, childResults) -> {childResults, findings}
 -> head reads {childResults, findings} and synthesizes
```

No-flag path: every new branch is gated on `undefined` (`child.tier`, `manifest.blackboard`, `config.fleet`) -> byte-identical.

### Consistency Model

Mixed. Child config: strongly consistent (written once, parsed once). Shared blackboard: eventually-consistent best-effort, bounded by <=3 rounds — siblings may not observe the latest finding, which is acceptable because convergence is the head's job. `childResults`: strongly consistent after all children exit.

### External Dependencies

| Service | Used By | Failure Mode | Fallback |
|---------|---------|--------------|----------|
| api.x.ai/v1 (Grok/xAI) | tool-role children on hard/frontier tier | 401 / network error | child fails -> per-child failure is data in report, not a fleet throw |
| api.deepseek.com (DeepSeek) | default/cheap/standard children | 401 / network error | per-child failure is data |
| Anthropic API key provider | Claude builder children (tool roles) | 401 / network error | per-child failure is data |
| Claude Code subscription (head) | external head only | out-of-repo; not a buildable component here | n/a — head is the consumer |

---

## Architecture Decision Records

- [ADR-1: Head-agnostic multi-provider worker substrate, not a bober-native head](.bober/architecture/arch-20260618-heterogeneous-multi-provider-agent-team-adr-1.md)
- [ADR-2: Tier-to-provider as a post-EXPAND manifest mapping, not a decomposer-prompt change](.bober/architecture/arch-20260618-heterogeneous-multi-provider-agent-team-adr-2.md)
- [ADR-3: Shared blackboard via one WAL-mode facts.db, bounded to <=3 rounds](.bober/architecture/arch-20260618-heterogeneous-multi-provider-agent-team-adr-3.md)
- [ADR-4: Grok/xAI as an OpenAI-compat endpoint, not a new provider adapter](.bober/architecture/arch-20260618-heterogeneous-multi-provider-agent-team-adr-4.md)
- [ADR-5: Shared db reached via head-injected ABSOLUTE path, not child-derived](.bober/architecture/arch-20260618-heterogeneous-multi-provider-agent-team-adr-5.md)

---

## Risk Assessment

| Risk | Severity | Owner | Mitigation |
|------|----------|-------|------------|
| `BoberConfigSchema` strips unknown keys (`src/config/schema.ts:405`) so the child never sees `fleet.blackboardDbPath` | critical | ManifestContract | Declare `fleet` as an explicit optional schema section so it survives parse (ADR-3, ADR-5) |
| claude-code lands on a tool role via runtime fallback, not caught at build (`src/config/loader.ts:262-263`) | critical | ToolRoleGuard | `assertManifest` THROWS in the fail-fast credential phase, outside never-throw validateManifest (ADR-1) |
| Relative or child-derived db path yields disjoint dbs per cwd (`src/fleet/runner.ts:95`) | critical | SharedBlackboard | Head injects ONE absolute path computed once; `open` rejects non-absolute paths (ADR-5) |
| FactStore opened without WAL (`src/state/facts.ts:140`) -> concurrent sibling writes block/corrupt | high | SharedBlackboard | `open` sets `PRAGMA journal_mode=WAL; busy_timeout=5000`; `close` checkpoints (ADR-3) |
| Free unbounded exchange fails to converge (prior research) | high | SharedBlackboard | Hard cap `BLACKBOARD_MAX_ROUNDS=3`; `publish` throws past cap (ADR-3) |
| Tier triage is unvalidated — no objective difficulty primitive exists | high | Head (external) | Recommend a tier-critic; document as Open Question; default tier -> no overlay (safe) |
| xAI key/endpoint misconfig surfaces only at child runtime | medium | GrokProviderWiring | `validateManifestCredentials` recognizes xAI keys up front (`src/fleet/index.ts:46`) |
| applyTier overlay accidentally mutates base config | medium | BuildChildConfig | Overlay produces a new object before shallow-merge at `src/fleet/child-config.ts:43`; tier-absent path returns base unchanged |
| EXPAND prompt could be tempted to inject provider/config | low | ManifestContract | Tier mapping is a POST-EXPAND step; decomposer prompt remains unchanged (ADR-2) |

---

## Open Questions

- **Phase split (build sequencing):** Phase A — provider-by-tier overlay (TierProviderPolicy + BuildChildConfig), Grok/xAI wiring, and ToolRoleGuard — is mechanical mirroring of existing DeepSeek wiring and the lower-risk first build. Phase B — SharedBlackboard (WAL `facts.db`, bounded rounds) plus SynthesisStep collection — is the novel part and carries the three critical risks; build it second behind the same `undefined`-gated flags. Assumption: shipping Phase A first lets the head route providers before any blackboard exists; if Phase B slips, Phase A still delivers tiered routing with byte-identical fallback.
- **No objective difficulty primitive (external, non-build):** Tier triage is unvalidated — bober has no measure of task difficulty, so the head's tier assignment is a heuristic. Assumption: a future tier-critic validates assignments. If wrong, frontier providers may be spent on easy tasks (cost) or hard tasks under-provisioned (quality). Default/absent tier applies no overlay, so the failure mode is safe (single-provider behavior). Recommend a tier-critic as the validation layer. See `research-20260618-heterogeneous-multi-provider-agent-team-research.md`.
- **The head is out-of-repo (external, non-build):** The head itself (a Claude Code dynamic workflow on the Anthropic subscription) is not a buildable component in this repo; bober builds only the four seams behind the manifest/CLI contract. Assumption: the dynamic workflow already ships decompose/check/converge/resume (per ADR-1). If a future bober-native head is desired, it consumes the SAME contract — no substrate change. See `research-20260618-heterogeneous-multi-provider-agent-team-research.md`.
