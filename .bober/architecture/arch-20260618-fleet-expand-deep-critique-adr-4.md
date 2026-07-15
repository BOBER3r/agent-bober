# ADR-4: Reuse runExpandStage as the re-expand seam instead of a new re-expand component

**Decision:** Fold critic feedback into a fresh runExpandStage call (decomposer-deep.ts:280-315) via a single optional `critiqueFeedback?` field, reusing the existing plan-derived Outline, rather than a dedicated re-expand component or a fresh PLAN call.

**Context:** Approach A specifies re-expand via fresh runExpandStage + accept-best; constraint 1 requires a closed-form budget; constraint 6 (LOCK) requires validateManifest and the children-only contract to stay unchanged.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: reuse runExpandStage + optional critiqueFeedback, reuse existing outline | Do-less; same validateManifest path; no extra PLAN call keeps budget closed-form; fresh expand context per round | A degenerate root-cause in the PLAN cannot be fixed by re-expansion |
| B: new runReExpandStage component | Isolates re-expand prompt | Duplicates runExpandStage validate-loop; invites drift |
| C: re-run full decomposeGoalDeep per round | Maximal freshness | Adds a PLAN call per round → budget not closed-form; wasteful |

**Rationale:** Constraint 1 eliminates C (an extra PLAN call per round breaks per-round accounting); constraint 6 is best honored by A, which routes every re-expand through the same validateManifest path with zero duplication, unlike B.

**Consequences:** runExpandStage gains one optional `critiqueFeedback?` appended to the first EXPAND user message only when present; the Outline from runPlanStage is captured once and reused across rounds; per-round re-expand cost is exactly `1+DEEP_EXPAND_MAX_RETRIES` calls.

**Risk:** Reusing the same outline means a degenerate root-cause in the PLAN (not expand) cannot be fixed by re-expansion — mitigated because critic feedback targets the manifest and a plan-level defect surfaces in human write-and-stop review; accepted per the accept-best design.
