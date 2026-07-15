# ADR-5: Shared db Reached via Head-Injected ABSOLUTE Path, Not Child-Derived

**Decision:** The head computes ONE absolute blackboard path once and injects it into each child's `bober.config.json` via a DECLARED `fleet` schema section; children NEVER derive the path from their own cwd.

**Context:** Children run as isolated execa processes in separate cwds (`src/fleet/runner.ts:95`). A relative or child-derived path would resolve to a different file per child, producing disjoint dbs and no sharing. `BoberConfigSchema` strips unknown keys (`src/config/schema.ts:405`), so an undeclared field would be silently dropped before the child ever sees it.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: Child derives path from its cwd / a relative path | No head plumbing | Separate cwds (`src/fleet/runner.ts:95`) -> N disjoint dbs; sharing fails entirely |
| B: Pass path as a CLI arg / env var to each child | Avoids schema | Bypasses config; not visible to the in-process FactStore wiring; another channel to maintain |
| C (chosen): Head injects ABSOLUTE path into a declared config.fleet section | Single shared file; survives schema-strip; in-band with config | Requires a schema change to BoberConfigSchema (declared optional section) |

**Rationale:** Constraint "children isolated in separate cwds" (`src/fleet/runner.ts:95`) eliminates Option A — child-derived paths cannot converge. Constraint "BoberConfigSchema STRIPS unknown keys" (`src/config/schema.ts:405`) forces the field to be a DECLARED section, not an ad-hoc key; this also rules out relying on shallow-merge passthrough. Option B is rejected because the FactStore is wired from config, so an out-of-band env var would need separate plumbing. The path is `join(resolve(rootDir), ".bober/memory/<ns>/facts.db")`, computed once in the head.

**Consequences:** `BoberConfigSchema` gains an optional `fleet` section `{blackboardDbPath, blackboardNamespace, maxRounds<=3}`. `SharedBlackboard.open` rejects non-absolute paths. Tier-absent / blackboard-absent path is byte-identical.

**Risk:** If `rootDir` differs between the head and a child (e.g. a relocated workspace), the absolute path points at a nonexistent file. Mitigation: the head resolves the path ONCE against the canonical rootDir and writes it verbatim into every child; children never recompute it.
