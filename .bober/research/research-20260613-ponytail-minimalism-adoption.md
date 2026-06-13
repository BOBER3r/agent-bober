# Research / Proposal: Adopting ponytail's minimalism discipline into agent-bober

**Date:** 2026-06-13
**Author:** agent-bober (research mode)
**Source:** https://github.com/DietrichGebert/ponytail (MIT, cloned to /tmp/ponytail @ commit 004256c)
**Status:** IMPLEMENTED 2026-06-13 — items 1-4 shipped (lens name `simplicity`). Item 5 (planner) deliberately excluded. See "Implementation outcome" at the bottom.
**Scope steer (user, 2026-06-13):** focus **evaluator + architect**; planner is questionable; proposal-doc before any prompt edits.

---

## TL;DR

ponytail is a single-discipline plugin: **anti-over-engineering / YAGNI minimalism**, voiced as a
"lazy senior dev" who climbs a ladder and stops at the first rung that holds. Its prompt craft is
genuinely sharp. agent-bober already owns most of the *boundaries* (don't skip validation/security/
tests) and some of the *YAGNI* checks (code-reviewer's DRY/YAGNI section). The **real gap** ponytail
fills is a dedicated **complexity-only review lens** plus an **auditable simplification convention**
(ceiling comments).

**Recommendation:** adopt two things, both native to existing infrastructure, neither always-on:

1. A **`simplicity` lens** added to the evaluator lens panel *and* the architect lens panel.
2. A **ceiling-comment convention** (`bober:` marker naming the shortcut + upgrade path) that the
   generator writes and the evaluator/code-reviewer audit instead of re-derive.

**Do NOT adopt:** ponytail's "YAGNI applies to tests too — one-liners need no test" stance. It
directly contradicts the evaluator's Iron Law. Minimalism governs *production code*, never the
verification discipline.

**Planner:** not recommended as a target (reasoning in §6.3).

---

## 1. Legitimacy verdict

| Signal | Finding |
|--------|---------|
| License | MIT |
| Real artifact | Yes — multi-framework plugin (Claude Code, Codex, Cursor, Windsurf, Cline, Copilot, Aider, Kiro, OpenCode, Pi), hooks, tests, benchmark harness |
| Benchmark honesty | High — `benchmarks/results/2026-06-12-v4-hardening-vs-caveman.md` admits n=1, parallel-scheduling noise, cross-model caveats, and lists residual weaknesses. Fabricated benchmarks don't volunteer their own holes. |
| Provenance ⚠️ | 1,076★ / 48 forks in ~24h (created 2026-06-12); **single squashed commit** — incremental authorship not auditable; star velocity reads like a viral launch, not organic accrual |

**Conclusion:** for harvesting *prompt ideas* (not vendoring code), provenance is irrelevant. The
content is worth mining. We import *principles*, re-expressed in agent-bober's own voice and schema —
no files copied.

---

## 2. What ponytail actually is

**The ladder** (stop at the first rung that holds) — `skills/ponytail/SKILL.md`:

1. Does this need to exist at all? (YAGNI) → 2. Stdlib does it? → 3. Native platform feature? →
4. Already-installed dependency? → 5. Can it be one line? → 6. Only then: minimum code that works.

**`ponytail-review`** — a complexity-*only* review (`skills/ponytail-review/SKILL.md`). One line per
finding, 5 tags, ends with the only metric it cares about:

- `delete:` dead code / speculative feature → replacement: nothing
- `stdlib:` hand-rolled thing the stdlib ships → name the function
- `native:` dep/code doing what the platform already does → name the feature
- `yagni:` abstraction with one implementation, config nobody sets, layer with one caller
- `shrink:` same logic, fewer lines → show the shorter form
- ends: `net: -<N> lines possible.` or `Lean already. Ship.`

**Ceiling comments** (the novel bit) — a deliberate simplification is marked with a comment naming
its ceiling *and* the upgrade path:
`// ponytail: global lock, per-account locks if throughput matters`. This makes a shortcut
**auditable as intent** rather than flagged as ignorance.

**"When NOT to be lazy"** — never simplify away input validation at trust boundaries, error handling
that prevents data loss, security, accessibility, or anything explicitly requested.

---

## 3. The one conflict we must NOT import

ponytail: *"Trivial one-liners need no test. YAGNI applies to tests too."*
agent-bober evaluator: *"Backend code without tests is a guaranteed FAIL"* (`agents/bober-evaluator.md:624`).

These are irreconcilable, and agent-bober's stance is correct for a generator-evaluator harness whose
entire value is independent verification. **Adoption rule:** minimalism applies to what the generator
*builds*, never to what the evaluator *demands*. The `simplicity` lens judges production code only and
must explicitly exclude tests/verification from its "delete" surface (ponytail-review already carves
this out: "A single smoke test or assert-based self-check is the ponytail minimum, not bloat, never
flag it for deletion").

---

## 4. What agent-bober already has (avoid duplication)

- **code-reviewer** — `agents/bober-code-reviewer.md:116-125` already has "DRY / YAGNI Violations"
  (duplicated utilities, abstractions for future use, config wired-but-never-read) and "Dead Code".
- **evaluator** — `agents/bober-evaluator.md:690-697` already flags oversized files/functions,
  `any` types, copy-paste, unused imports.
- **boundaries** — "when not to be lazy" already exists as agent-bober quality bars (validation,
  security, accessibility) across planner/evaluator.

So the additive value is **(a)** turning the scattered YAGNI checks into one focused, scored lens with
a tight taxonomy, and **(b)** the ceiling-comment convention, which agent-bober has *no* equivalent of.

---

## 5. Why the lens panel is the right home

agent-bober already has opt-in lens infrastructure with a parity gate:

- Evaluator: `MODE:lens:<name>`; `LENS_CATALOG` in `src/orchestrator/eval-lenses.ts` (correctness,
  security, regression, quality), mirrored byte-for-byte in `skills/shared/lens-panel.md`, enforced by
  `src/orchestrator/lens-panel-parity.test.ts`.
- Architect: `MODE:lens-score:<name>` / `MODE:lens-review:<name>`; `ARCH_LENS_CATALOG` in
  `src/orchestrator/arch-lenses.ts` (scalability, security, cost, operability, maintainability,
  reversibility), mirrored in `skills/shared/arch-lens-panel.md`.

Adding a `simplicity` lens to each is a **catalog-entry + doc-mirror + parity-test** change — no new
orchestration, no always-on prompt bloat, opt-in per run. This is the lowest-risk, most native path.

---

## 6. Proposal per agent

### 6.1 Evaluator — PRIMARY ✅ add `simplicity` eval lens

Add to `LENS_CATALOG` (`src/orchestrator/eval-lenses.ts`), mirror in `skills/shared/lens-panel.md`,
update the parity test. Proposed fragment (drop-in, agent-bober voice, test-safe):

```
simplicity:
  Focus exclusively on over-engineering in the production diff: code that reinvents the
  standard library, dependencies or hand-rolled code doing what a native platform feature
  already does, abstractions with a single implementation, config nobody reads, dead
  flexibility, and logic expressible in materially fewer lines. Report each as one line —
  location, what to cut, what replaces it. NEVER flag tests, smoke checks, validation at
  trust boundaries, error handling, security, or accessibility as deletable. End with the
  net line delta achievable.
```

Pairs with the existing `quality` lens (which covers smells/naming/duplication) without overlap:
`simplicity` is specifically *"what can be deleted/replaced"*, scored.

### 6.2 Architect — PRIMARY ✅ add `simplicity` arch lens (+ optional CP rung)

Add to `ARCH_LENS_CATALOG` (`src/orchestrator/arch-lenses.ts`) and mirror in
`skills/shared/arch-lens-panel.md`. Proposed fragment:

```
simplicity:
  Focus on whether the architecture is the simplest design that satisfies the Checkpoint 1
  constraints. Challenge whether each component needs to exist, whether a native platform
  feature or an already-present dependency removes a proposed custom layer, whether two
  components should collapse into one, and whether any abstraction is speculative (added for
  a use case not in the problem statement). Reward the smallest design that still honours the
  hard constraints; penalise layers introduced "for future flexibility".
```

**Optional, more invasive:** add a "rung 0" prompt to Checkpoint 2 — *"Before comparing approaches,
state whether the simplest viable approach is 'do less / reuse existing' and why it was or wasn't
selected."* This injects the ladder's top rung directly into the 5-checkpoint flow. Higher value, but
edits the core flow (and the lens already covers most of it on the review side). **Recommend deferring
the CP-rung until the lens proves useful.**

### 6.3 Planner — NOT recommended ✋

The planner's job is to *decompose what was asked* into verifiable vertical slices. ponytail's top
rung ("does this need to exist at all?") is a *product/scope* judgment that:

- risks the planner silently dropping requested scope (it already has a strict "don't fabricate
  features" rule; the inverse — don't *delete* requested features — matters just as much), and
- is better placed **upstream in the architect** ("does this component need to exist") where it's a
  design decision with ADR evidence, not a planning decision.

If we ever want scope-questioning, the right shape is a *clarifying question category*
("is feature X in scope or does existing Y cover it?") — not a YAGNI mandate. **Out of scope for now,
consistent with the user steer.**

### 6.4 Generator + code-reviewer — SECONDARY (the ceiling-comment convention) ◻️

The one genuinely new idea worth a shared convention:

- **Generator** (`agents/bober-generator.md`): when it makes a deliberate simplification with a known
  ceiling, leave a `bober:` comment naming the ceiling AND the upgrade path —
  `// bober: in-memory map, swap for Redis if this outgrows one process`. (Use `bober:`, not
  `ponytail:`, to keep it ours.)
- **Code-reviewer** (`agents/bober-code-reviewer.md`): a `bober:`-marked ceiling comment is *intent*,
  not a finding — do not flag the simplification it documents. Conversely, an *unmarked* shortcut with
  an obvious ceiling becomes a legitimate Important finding ("undocumented simplification ceiling").
- **Evaluator**: same rule — a `bober:` ceiling comment is not a code smell.

This turns simplifications into a reviewable contract instead of invisible debt. Low risk, high
clarity. Could ship alongside the lenses or in a follow-up.

---

## 7. Recommended adoption set (decision-ready)

| # | Change | Files touched | Risk | Recommend |
|---|--------|---------------|------|-----------|
| 1 | `simplicity` **eval lens** | `eval-lenses.ts`, `lens-panel.md`, parity test | low | **Yes** |
| 2 | `simplicity` **arch lens** | `arch-lenses.ts`, `arch-lens-panel.md` (+ its parity test if any) | low | **Yes** |
| 3 | **ceiling-comment** convention | generator + code-reviewer + evaluator prompts | low | Yes (can follow 1–2) |
| 4 | Architect CP2 "rung 0" prompt | `agents/bober-architect.md` | med | Defer |
| 5 | Planner YAGNI pass | `agents/bober-planner.md` | med-high | **No** |

All four agents the user checked still get *touched* under this set (evaluator + architect via lenses;
generator + code-reviewer via the ceiling convention) — only the planner is deliberately excluded,
matching the steer.

After any of 1–4, run `npm run build` + the parity tests, then `npm run update-all` to sync the
canonical `agents/` and `skills/` into the `.claude/` copies (per distribution memory — the copies are
inert otherwise).

---

## 8. Open decisions for the user

1. **Lens names** — `simplicity` for both? (alt: `minimalism`, `leanness`.)
2. **Ship set** — items 1+2 only, or 1+2+3 (add ceiling comments) in the same pass?
3. **Architect CP rung (item 4)** — defer as recommended, or include now?
4. **Default-on?** — lenses are opt-in via `MODE`/panel config. Do you want `simplicity` added to any
   default lens-panel set, or strictly opt-in per run? (Recommend strictly opt-in to start.)
5. **Wording** — accept the two proposed lens fragments in §6.1/§6.2 as-is, or revise before I wire
   them into the catalogs + parity docs?

Once these are answered I can implement the chosen set behind the bober.sprint discipline (catalog +
mirror doc + parity test + prompt edits), verify with build/tests, and sync via `update-all`.

---

## Implementation outcome (2026-06-13)

Shipped items 1-4 with lens name **`simplicity`**; planner (item 5) deliberately untouched.

**`simplicity` eval lens** — added to `LENS_CATALOG` (`src/orchestrator/eval-lenses.ts`); mirrored in
`skills/shared/lens-panel.md` + the 3 byte-identical reference copies (`bober.run`/`bober.sprint`/
`bober.eval`) + recomputed `.claude/commands/`; gate tests updated (`eval-lenses.test.ts` 4→5,
`lens-panel-parity.test.ts`).

**`simplicity` arch lens** — added to `ARCH_LENS_CATALOG` (`src/orchestrator/arch-lenses.ts`);
mirrored in `skills/shared/arch-lens-panel.md` + `bober.architect` reference copy + recomputed
command; gate tests updated (`arch-lenses.test.ts` 6→7, `arch-lens-panel-parity.test.ts`).

**Ceiling comments (`bober:` convention)** — generator writes them (names ceiling + upgrade path);
code-reviewer treats marked = intent / unmarked-with-ceiling = Important finding; evaluator treats
marked = not-a-smell, scoped strictly to code-quality (never softens criteria/strategies/test mandate).

**Architect CP2 "simplest rung"** — a do-less option must appear among the 2-3 approaches or be
eliminated by a named Checkpoint 1 constraint; never reduces the count below 2.

**Non-contradiction guards baked in:** the test/verification Iron Law is explicitly fenced off in
every touched prompt — minimalism governs production code, never tests, validation, error handling,
security, or accessibility. The arch lens is constraint-bounded (a simplification that breaks a
hard constraint "is not simpler, it is wrong").

**Verification:** `tsc` clean; `eslint` 0 errors; full suite 1831 passed / 3 skipped. The lone
failure (`skill-bundles.test.ts` version pin `0.15.0` vs actual `0.16.0`) is pre-existing and
unrelated (package bumped in commit c7fa1a9, test not updated).

**Follow-up:** run `npm run update-all` (full, not --skills-only) to propagate the new lens + agent
prompts into downstream consumer projects' `.claude/` copies. The agent-bober repo's own `.claude/`
is already synced. Note: `.claude/agents/bober-code-reviewer.md` is currently untracked (`git add`
it when committing).
