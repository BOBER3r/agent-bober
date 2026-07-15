# ADR-1: Head-Agnostic Multi-Provider Worker Substrate, Not a bober-Native Head

**Decision:** bober builds only the four irreducible worker seams (tier overlay, Grok/xAI endpoint, tool-role guard, shared blackboard) behind a stable manifest/CLI contract drivable by ANY head, and does NOT build a bober-native orchestration head.

**Context:** A head must triage task difficulty, route providers, and synthesize cross-agent findings. Fleet children are isolated single-provider processes receiving only a task string (`src/fleet/runner.ts:23-29`). The question is whether bober owns the orchestration intelligence or only the worker primitives.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: Do-less — reuse Claude Code dynamic workflow as head, bober adds nothing | No new code; ships today | claude-code cannot drive tool roles (`src/config/role-providers.ts:25`); no provider-by-tier, no shared findings — fails success criteria |
| B: Build a bober-native head (decompose/triage/converge in bober) | Full control in one repo | Rebuilds decompose/check/converge/resume the dynamic workflow already ships; large surface; couples substrate to one head |
| C (chosen): Head-agnostic substrate — four seams behind a contract | Reuses shipped workflow; any head drives it; additive | bober does not own difficulty triage (unvalidated, see ADR-2/Open Questions) |

**Rationale:** Constraint "claude-code can drive only PROMPT_ROLES, never TOOL_ROLES" (`src/config/role-providers.ts:25`) eliminates Option A: claude-code as head cannot itself build, so a tool-role child on the anthropic provider is required — that requires the substrate seams regardless. Constraint "ADDITIVE, no-flag path byte-identical" eliminates Option B's large coupled surface; the four seams gate every branch on `undefined`.

**Consequences:** A future bober head consumes the SAME manifest/CLI contract with zero substrate change. Decomposition, triage, convergence, and resume stay with the external head. bober ships four small additive seams across two phases (A mechanical, B novel).

**Risk:** If the contract is too narrow, a future head needs richer per-child feedback than `{exitCode, stdout, stderr}` + blackboard findings. Mitigation: the blackboard is the extensible channel; widening it is additive.
