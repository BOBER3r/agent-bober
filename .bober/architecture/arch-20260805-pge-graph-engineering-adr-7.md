# ADR-7: Rejecting the YAML-output and Redis prescriptions

**Decision:** JSON remains canonical both on disk and as the structured-output wire format; the escape problem the YAML mandate targets is removed structurally by never placing generated source code inside a JSON string. Redis is replaced by filesystem stores: `.bober/scratch/<runId>/<sha256>` for offload and `.bober/cache/<sha256>.json` for the semantic cache, keyed exactly as the source documents mandate.

**Context:** The source documents state "YAML must be mandated for structured outputs in this coding graph" and prescribe "a local Redis instance" for offloading plus "a caching layer (using Redis)". Both prescriptions target real problems — quote escaping in multiline code, and keeping bulk payloads out of state — but their stated mechanisms collide with locked dependencies.

**Options Considered — structured output:**

| Option | Pros | Cons |
|--------|------|------|
| **A. Mandate YAML block scalars** | Multiline code needs no quote escaping, which is the documents' stated motivation; block scalars are readable | No YAML parser is a dependency, so this adds a runtime dependency or a hand-rolled parser; providers' native structured-output modes accept JSON Schema and emit JSON, so `zod-to-json-schema` + `responseSchema` + the coerce/validate/repair loop in `src/providers/structured.ts` would all be bypassed; `.bober/` contracts are JSON on disk, so a second on-disk format appears |
| **B. JSON wire format + code written to disk by tools, payload carries `{path, sha256, scratchRef}` (selected)** | Removes escape collisions *entirely* rather than mitigating them — no model is ever asked to emit source inside a string; preserves native structured output, Zod parse and the existing repair loop; strictly better token economy than either JSON-escaped or YAML-embedded code; a vendored block-scalar normaliser behind the existing `Validator<T>` seam absorbs residual YAML-ish output with no new dependency | Declines a literal instruction in the source documents; a node that genuinely needs inline code in a payload must offload instead |

**Options Considered — offload and cache:**

| Option | Pros | Cons |
|--------|------|------|
| **C. Local Redis** | Fast keyed lookup; TTL is native; the documents' prescription | Requires a network daemon the user must run, for a CLI symlinked into arbitrary projects; adds an operational dependency to every consumer for a default-off feature |
| **D. Embedded `better-sqlite3` index** | Already a repo dependency, with precedent in `src/state/facts.ts` and `src/fleet/shared-blackboard.ts`; indexed lookup; no daemon | Opaque to inspection; native module build risk at install; unnecessary while lookups are single files by known content hash |
| **E. Content-addressed filesystem stores (selected)** | Satisfies "no database, no service the user must run" literally; identical payloads dedupe by hash; `expiresAt` in each cache file implements TTL against an injectable clock; every entry is inspectable | Directory growth requires retention pruning; lookup is a filesystem stat rather than an index |

**Rationale:** Option A is eliminated by the **Locked Dependency "Zod as the only validation layer"** read with the **Backward-compatibility constraint that `.bober/` artifact shapes are frozen**: mandating YAML either introduces a second parser and a second on-disk format, or forces a hand-rolled parser in a codebase whose principles state "No hand-rolled validation". Option B satisfies the mandate's *intent* — R22's acceptance test passes because the failure mode it measures cannot occur when code never enters a string. Option C is eliminated by the **Distribution constraint "no service the user must run"**; note that `redis-cli` at `src/orchestrator/environment.ts:38` is a PATH probe entry in `CANDIDATE_TOOLS`, not a blocklist, so the elimination rests on the constraint rather than on an existing guard. Option D is the sanctioned escalation if measured lookup cost ever dominates, and is deliberately not taken first.

**Consequences:** `SemanticCache.key` hashes exactly the six mandated components (systemPrompt, userPrompt, contextFilesHash, model, temperature, toolsMask). Only nodes whose `effects` array is empty may declare a cache policy (`CacheOnEffectfulNode`). `CommitBoundary`'s state-size guard rejects any channel value above `maxInlineBytes`, so offload is enforced rather than advised.

**Risk:** If a provider's structured-output mode degrades and returns fenced code inside a JSON string despite the offload discipline, the vendored block-scalar normaliser is the only recovery path; its ~120 lines are hand-rolled parsing and must carry the same pinned recovery-rate fixture suite as `src/providers/structured.ts`.
