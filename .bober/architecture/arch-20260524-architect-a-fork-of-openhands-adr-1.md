# ADR-1: Sidecar Plane Over Upstream Agent Adapter

**Decision:** Integrate Claude Code and agent-bober as a parallel runtime plane mounted via an additive FastAPI sub-router under `/api/v1/bober/*` plus a dedicated WebSocket endpoint, rather than registering Claude Code as a new `openhands.sdk` agent type or as a new `ProviderType` enum value.

**Context:** The fork must absorb arbitrary upstream PRs from `All-Hands-AI/OpenHands` with zero conflicts in core files while delivering a zero-key first-run conversation backed by Claude Code's pre-authenticated CLI and exposing the agent-bober sprint pipeline from the UI. The OpenHands SDK (`openhands.sdk.*`) is an external package not present in this repo, ruling out in-tree agent-class registration.

**Options Considered:**

| Option | Pros | Cons |
|---|---|---|
| A: Upstream Agent Adapter | Reuses conversation UI/socket unchanged | Requires modifying/monkey-patching external SDK; doubles surface area; impedes zero-key |
| B: Sidecar Plane + Additive Sub-Router | Single-line upstream diff; frontend touches confined to two known insertions; CLI/MCP contract reused; `/settings/` untouched | Two parallel UX paths need clear default/fallback discoverability; FS-watch races require atomic-write discipline |
| C: Hybrid Provider Toggle | Single settings UI; reuses profile storage | Edits 3+ locked upstream files; shoehorns PTY subprocess into LiteLLM provider abstraction; breaks zero-key |

**Rationale:** Approach B is the only option that satisfies "Additive only — never mutate upstream files in place" from Checkpoint 1. It also preserves `/settings/llm` as an untouched fallback, satisfying both backward-compatibility and zero-key first-run success criteria.

**Consequences:** New `openhands_bober/` Python package and `frontend/src/bober/` feature tree. Three upstream insertions only: one `include_router` in `v1_router.py`, one `route()` in `routes.ts`, one tab in `conversation-tabs.tsx`. agent-bober Node.js CLI/MCP invoked as subprocess; `.bober/*.json` artifacts remain cross-runtime source of truth.

**Risk:** If upstream restructures `v1_router.py` or refactors `conversation-tabs.tsx` to a registry, the insertion points become merge surfaces; mitigation is documenting exact lines and considering an upstream tab-registry PR. If `.bober/` writes are non-atomic, the watcher may read partial JSON.
