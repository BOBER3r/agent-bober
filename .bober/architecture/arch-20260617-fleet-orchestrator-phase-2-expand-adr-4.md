# ADR-4: Fleet Expand CLI Surface — Distinct `fleet expand <goal>` Subcommand

**Decision:** Expose decomposition as a NEW `fleet expand <goal>` subcommand, leaving `fleet <manifest>` (`src/fleet/index.ts:135`) literally byte-unchanged.

**Context:** Phase 2 turns a goal string into a manifest. CP1 LOCKED the existing `fleet <manifest>` command as byte-unchanged and made Phase 2 purely additive. The CLI must offer the expand surface without touching the locked command's signature or handler.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| (a) `--expand` on `fleet`, positional → `[manifest]` | Single command; one help entry | Changing `<manifest>` to `[manifest]` IS a signature change to the locked command; needs exactly-one-of validation; edits the locked `.action` handler |
| (b) `fleet expand <goal>` subcommand | `fleet <manifest>` stays byte-identical at line 135; mirrors existing `registerWorktreeCommand` parent+child pattern (`worktree.ts:24-29`); discoverable in `fleet --help` | Two code paths to maintain; slightly more registration code |

**Rationale:** CP1's LOCKED "existing `fleet <manifest>` byte-unchanged" constraint eliminates (a): turning the required positional `<manifest>` into optional `[manifest]` is a signature change to the locked command, regardless of being additive. (b) adds a sibling subcommand and never edits line 135.

**Consequences:** New `registerFleetExpandSubcommand` attaches a child command to the existing `fleet` parent. `--count`/`--provider`/`--model`/`--root`/`--concurrency`/`--out`/`--yes` live ONLY on the expand subcommand. `fleet <manifest>` and `runFleet` are reused, not modified.

**Risk:** If commander's parent/child registration alters `fleet <manifest>` arg parsing, the locked command could break — mitigated by following the proven `worktree.ts:24-29` pattern and registration tests.
