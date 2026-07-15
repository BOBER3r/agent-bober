# Sprint Briefing: Online-research egress axis (default off) + gated web retrieval

**Contract:** sprint-spec-20260628-research-scheduler-3
**Generated:** 2026-06-30T00:00:00.000Z

> Sprint 3 of 5. Add a NEW research-owned egress axis `'online-research'` that mirrors the
> medical `EgressGuard` EXACTLY (default false, fail-closed). Do NOT widen or reuse the
> medical axes. Gate the Sprint-2 runner's web-retrieval branch behind the new guard: axis
> OFF (default) => fully offline run, zero outbound requests, byte-identical to Sprint 2;
> axis ON => retrieval client invoked and the note cites the retrieved source URLs.

---

## 0. The One Thing To Get Right (mirror these EXACTLY)

- **Throw message format** from `src/medical/egress.ts:56`:
  ```ts
  throw new Error(`Egress axis '${axis}' not enabled`);
  ```
  For the new guard the literal message MUST be: `Egress axis 'online-research' not enabled`.
  (The evaluator asserts `assertAllowed` throws when off — sc-3-2.)

- **Schema insertion point**: add `research: ResearchSectionSchema.optional()` inside
  `BoberConfigSchema` (object spans `src/config/schema.ts:481-518`) immediately after the
  `calendar:` line at `src/config/schema.ts:517`, before the closing `});` at line 518.
  Declare `ResearchSectionSchema` as a top-level `export const` next to the other section
  schemas (e.g. right after `CalendarSectionSchema` at `src/config/schema.ts:464-477`).

- **There is NO existing `research` key** on `BoberConfigSchema` (grep of `src/config/schema.ts`
  matched only `researchPhase` L185/L585 and `researcherPhase2` L249/L250/L275 — unrelated).
  The section is genuinely additive; existing configs must parse unchanged.

---

## 1. Target Files

### src/config/schema.ts (modify)

**The `BoberConfigSchema` object (lines 481-518) — add ONE line after L517:**
```ts
  // ── Sprint 3: calendar planner cloud-calendar egress axis ──
  calendar: CalendarSectionSchema.optional(),        // <-- L517 (existing, last key today)
  // ── Sprint 3 (research-scheduler): online-research egress axis ──
  research: ResearchSectionSchema.optional(),        // <-- ADD HERE, before the L518 `});`
});
```

**Section-schema declaration pattern to copy — `CalendarSectionSchema`, lines 462-477** (the
closest single-axis sibling; this is the template for `ResearchSectionSchema`):
```ts
// ── Calendar Section (Sprint 3 — cloud-calendar egress axis default off) ──
export const CalendarSectionSchema = z.object({
  /** Egress opt-in axis (Sprint 3). Default false — zero cloud egress by default. */
  egress: z
    .object({
      /** When true, Google Calendar (cloud) egress is permitted. Default false (fail-closed). */
      cloudCalendar: z.boolean().default(false),
    })
    .optional(),
  connector: z.enum(["ics", "google"]).default("ics"),
  timezone: z.string().optional(),
});
export type CalendarSection = z.infer<typeof CalendarSectionSchema>;
```
Per the contract `generatorNotes`, the research section body is just the egress axis:
```ts
// ── Research Section (Sprint 3 — online-research egress axis default off) ──
export const ResearchSectionSchema = z.object({
  /** Egress opt-in axis. Default false — zero outbound bytes by default (fail-closed, ADR-6 lineage). */
  egress: z
    .object({
      /** When true, online/web research retrieval is permitted. Default false. */
      onlineResearch: z.boolean().default(false),
    })
    .optional(),
});
export type ResearchSection = z.infer<typeof ResearchSectionSchema>;
```

**Imported by:** `BoberConfig` (`z.infer`) at `src/config/schema.ts:519` flows EVERYWHERE.
The change is additive-optional, so `PartialBoberConfigSchema` (L525, `.deepPartial()`) and
`createDefaultConfig` (L542-605, never sets `research`) remain valid with no edits.

**Test file:** `src/config/schema.test.ts` exists — verify a config with NO `research` key
still `.parse()`s (the evaluator requires this; see Impact §7).

---

### src/research/egress.ts (create)

**Most similar existing file:** `src/calendar/calendar-egress.ts:1-42` (single-axis, research-
owned, `fromConfig(config)` reading one optional flag). BUT the contract demands the
**throw semantics + `isAllowed(axis)`/`assertAllowed(axis)` signatures of the MEDICAL guard**
(`src/medical/egress.ts`), not the calendar guard's bespoke method names. Combine: medical
method shape + calendar's single-axis fromConfig.

**Directory pattern:** `src/research/` files are kebab-free single-word or hyphenated lower-case
(`job-store.ts`, `model-diversity.ts`, `note-writer.ts`, `runner.ts`). New file = `egress.ts`.

**Structure template (mirrors `src/medical/egress.ts:1-59` line-for-line, single axis):**
```ts
/** ResearchEgressGuard — online-research egress axis, default false (Sprint 3, ADR-6 lineage). */
import type { BoberConfig } from "../config/schema.js";

/** The single research egress axis. Defaults FALSE (code-enforced zero-egress). */
export type EgressAxis = "online-research";

export class ResearchEgressGuard {
  constructor(private readonly onlineResearch: boolean) {}

  /** Build from BoberConfig research section; axis defaults false when absent. */
  static fromConfig(config: BoberConfig): ResearchEgressGuard {
    return new ResearchEgressGuard(config.research?.egress?.onlineResearch ?? false);
  }

  /** Returns true only when the axis has been explicitly opted in via config. */
  isAllowed(axis: EgressAxis): boolean {
    switch (axis) {
      case "online-research":
        return this.onlineResearch;
      default: {
        const _exhaustive: never = axis; // compile error if an EgressAxis value is unhandled
        return _exhaustive;
      }
    }
  }

  /** Throws an Error when the axis is not enabled; returns void when allowed. */
  assertAllowed(axis: EgressAxis): void {
    if (!this.isAllowed(axis)) {
      throw new Error(`Egress axis '${axis}' not enabled`);
    }
  }
}
```
> Keep the `EgressAxis` type + `switch`/`never` exhaustiveness even for one axis — it mirrors
> `src/medical/egress.ts:35-48` exactly and lets the evaluator assert identical throw semantics.

---

### src/research/online-retrieval.ts (create)

**Most similar existing files:** `src/medical/retrieval/literature.ts:16-43` (egress-gated
`retrieve(query)` orchestrator) + `src/medical/retrieval/medline-source.ts:30-39` (the
**injectable `FetchLike` transport** so tests stay offline). Mirror the *shape* under
`src/research/`; do NOT import or touch anything under `src/medical/retrieval/`.

**Structure template** — define an injectable client interface + a `retrieve(query, client)`
that returns sources/URLs (the contract `generatorNotes` name `retrieve(query, client)`):
```ts
/** Online research retrieval — injectable client so tests never hit the network. */

/** One retrieved web source. title + url form the citation. */
export interface RetrievalSource {
  title: string;
  url: string;
}

/**
 * Injectable retrieval client — duck-typed, offline-testable.
 * Tests pass a spy returning fixture data; production binds to a real search client.
 * (Mirrors FetchLike in src/medical/retrieval/medline-source.ts:37-39.)
 */
export interface RetrievalClient {
  search(query: string): Promise<RetrievalSource[]>;
}

/**
 * Retrieve sources for a query via the injected client.
 * NOTE: this fn does NOT itself check egress — the runner gates the call (see runner template).
 * Returns [] on any client error (fail-closed; never throws out).
 */
export async function retrieve(query: string, client: RetrievalClient): Promise<RetrievalSource[]> {
  try {
    return await client.search(query);
  } catch {
    return [];
  }
}
```
> Design note (not cited code): the egress check lives in the RUNNER per the contract
> `generatorNotes` ("guard the retrieval branch ... before invoking the retrieval client; when
> off, skip retrieval entirely so no client is constructed"). This satisfies sc-3-3 "spy called
> 0 times" because the runner never reaches `retrieve()` when the axis is off. The medical
> `LiteratureRetriever.retrieve` (`literature.ts:32-42`) instead checks `isAllowed` *inside* and
> returns `{disabled}` — that is the defense-in-depth alternative; the runner-level guard is the
> primary requirement here.

---

### src/research/runner.ts (modify)

**Current deps interface (lines 44-54) — extend additively with TWO optional fields:**
```ts
export interface RunDeps {
  queryModel: QueryModel;
  findingSink: FindingSink;
  now: string;
  vaultRoot: string;
  // ── Sprint 3 (additive, optional — omit => byte-identical offline run) ──
  egress?: ResearchEgressGuard;       // import from "./egress.js"
  retrievalClient?: RetrievalClient;  // import type from "./online-retrieval.js"
}
```
> Both MUST be OPTIONAL: Sprint-2's `runner.test.ts` and `src/cli/commands/research.ts:254-259`
> construct `RunDeps` WITHOUT them and must keep compiling/passing (sc-3-4 + regression).

**Current note-build + write block (lines 157-174) — insert the gated branch between the model
loop (ends L163) and the note serialization (L166-167):**
```ts
  // 2. Query each block ... (existing L157-163, UNCHANGED)
  for (const block of blocks) {
    const text = await queryModel(block, prompt);
    contributions.push({ label: modelLabel(block), text });
  }

  // ── Sprint 3: gated online-research retrieval (axis OFF default => skipped entirely) ──
  let sourceUrls: string[] = [];
  if (deps.egress?.isAllowed("online-research") && deps.retrievalClient !== undefined) {
    const sources = await retrieve(job.question, deps.retrievalClient); // online-retrieval.js
    sourceUrls = sources.map((s) => s.url);
  }

  // 3. Build the note content (existing L165-167) — thread sourceUrls in (see note-writer)
  const labels = contributions.map((c) => c.label);
  const noteContent = serializeResearchNote(job, labels, contributions, now, sourceUrls);
  //                                                                        ^^^^^^^^^^ NEW arg
```
> When the axis is off OR no client is injected, `sourceUrls` stays `[]` and the retrieval
> client is never touched => zero outbound requests, spy called 0 times (sc-3-3 off-path).

**Imports to add at the top of runner.ts (after L29-34):**
```ts
import { retrieve, type RetrievalClient } from "./online-retrieval.js";
import type { ResearchEgressGuard } from "./egress.js";
```

**Imported by:** `src/cli/commands/research.ts:43-44` (`runResearchJob`, `QueryModel`,
`FindingSink`) and `src/research/runner.test.ts:18`. See Impact §7.

**Test file:** `src/research/runner.test.ts` exists (Sprint 2) — you MODIFY it (add sc-3-3 cases).

---

### src/research/note-writer.ts (LIKELY-MODIFY — not in estimatedFiles; see Pitfalls)

To thread URLs into the note, the cleanest additive change is a 5th optional param on
`serializeResearchNote` (current signature `src/research/note-writer.ts:51-56`). Default
`undefined`/`[]` keeps Sprint-2 output **byte-identical**:
```ts
export function serializeResearchNote(
  job: ResearchJob,
  labels: string[],
  contributions: ModelContribution[],
  now: string,
  sources: string[] = [],            // <-- NEW optional, default [] (byte-identical when empty)
): string {
  const frontmatter: Record<string, unknown> = {
    title: `Research — ${job.question}`,
    jobId: job.id,
    question: job.question,
    models: labels,
    generatedAt: now,
    domain: job.domain ?? "research",
    type: "research",
    status: "open",
    ...(sources.length > 0 ? { sources } : {}),   // string[] ONLY — never objects (see pitfall)
  };
  // ...existing body, optionally append a "## Sources" section listing the URLs...
}
```
> CRITICAL: `sources` must be `string[]` (URLs). `serializeFrontmatter`
> (`src/vault/frontmatter.ts:145-164`) renders arrays as YAML list items via `String(item)`;
> passing objects yields `[object Object]` (the exact pitfall warned at `note-writer.ts:48-49`).
> Spreading `sources` only when non-empty keeps the off-path frontmatter byte-identical.

---

## 2. Patterns to Follow

### Medical EgressGuard — exact throw + exhaustive switch
**Source:** `src/medical/egress.ts:34-58`
```ts
  isAllowed(axis: EgressAxis): boolean {
    switch (axis) {
      case "cloud-inference":
        return this.cloudInference;
      // ...
      default: {
        const _exhaustive: never = axis;
        return _exhaustive;
      }
    }
  }
  assertAllowed(axis: EgressAxis): void {
    if (!this.isAllowed(axis)) {
      throw new Error(`Egress axis '${axis}' not enabled`);
    }
  }
```
**Rule:** Copy this method shape verbatim for `'online-research'`; the throw literal must be
``Egress axis 'online-research' not enabled``.

### fromConfig reads one optional flag, defaults false
**Source:** `src/calendar/calendar-egress.ts:20-24`
```ts
  static fromConfig(config: BoberConfig): CalendarEgressGuard {
    return new CalendarEgressGuard(config.calendar?.egress?.cloudCalendar ?? false);
  }
```
**Rule:** `ResearchEgressGuard.fromConfig` reads `config.research?.egress?.onlineResearch ?? false`.

### Egress-gated retrieval with injectable transport
**Source:** `src/medical/retrieval/medline-source.ts:30-39, 123-129`
```ts
export type FetchLike = (
  url: string,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
// ...
  constructor(
    private readonly egress: EgressGuard,
    private readonly fetchImpl: FetchLike = fetch as FetchLike, // tests inject a fake
  ) {}
```
**Rule:** Define an injectable `RetrievalClient` so tests pass a spy and CI stays offline (no
real network). The contract `nonGoals` forbid real network calls in tests.

### Additive-optional config section
**Source:** `src/config/schema.ts:462-477` (Calendar) + registration `src/config/schema.ts:516-517`
**Rule:** New section = `export const XSectionSchema` with `.optional()` sub-objects, registered
as `research: ResearchSectionSchema.optional()` on `BoberConfigSchema`. Zero changes to
`createDefaultConfig` (L542) — absence => default false.

### Section comment headers (house style)
**Source:** `src/config/schema.ts:383, 462`, `src/research/runner.ts:36,66,94,132`
**Rule:** Use `// ── Title ──` box-drawing headers (principles.md:32).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `EgressGuard` | `src/medical/egress.ts:17` | `class; static fromConfig(config); isAllowed(axis); assertAllowed(axis)` | MEDICAL guard — the pattern to MIRROR. Do NOT import/extend/widen it. |
| `CalendarEgressGuard` | `src/calendar/calendar-egress.ts:16` | `class; static fromConfig(config)` | Single-axis research-owned precedent (different method names). |
| `serializeResearchNote` | `src/research/note-writer.ts:51` | `(job, labels, contributions, now, sources?) => string` | Builds the vault note; extend with optional `sources` (do NOT rewrite). |
| `researchNotePath` | `src/research/note-writer.ts:23` | `(vaultRoot, marker, now) => string` | Canonical note path. Reuse as-is. |
| `serializeFrontmatter` | `src/vault/frontmatter.ts:145` | `(frontmatter, body) => string` | YAML frontmatter writer; string-arrays OK, objects render `[object Object]`. |
| `parseFrontmatter` | `src/vault/frontmatter.ts:53` | `(raw) => { frontmatter, body }` | Used by tests to read back the note. |
| `diverseBlocks` | `src/research/model-diversity.ts` | `(tier?) => RoleProviderBlock[]` | >=2 distinct model blocks. Reuse unchanged. |
| `modelLabel` | `src/research/model-diversity.ts` | `(block) => string` | Canonical model label. Reuse unchanged. |
| `loadConfig` | `src/config/loader.ts:142` | `(projectRoot) => Promise<BoberConfig>` | For optional CLI wiring of the real guard (not gated). |
| `createClient` | `src/providers/factory.ts` | `(provider, endpoint, ..., role)` | Provider-agnostic LLM client (used in research.ts:219). |

Directories reviewed for reuse: `src/research/`, `src/medical/`, `src/medical/retrieval/`,
`src/calendar/`, `src/vault/`, `src/config/`, `src/utils/`. No existing online/web retrieval
util exists under `src/research/` — `online-retrieval.ts` is genuinely new.

---

## 4. Prior Sprint Output

### Sprint 1 (0336e47): research scaffolding
**Created:** `src/research/types.ts` — exports `ResearchJobSchema` / `ResearchJob` (note
`onlineResearch: z.boolean().default(false)` already stored on the JOB at `types.ts:51`; this is
a per-job flag, SEPARATE from the new config egress axis), `CadenceSchema`. Also `job-store.ts`,
`cli/commands/research.ts`.
**Connection:** The runner reads `job.question`; the new egress axis is a CONFIG-level gate
(`config.research.egress.onlineResearch`), independent of the per-job `onlineResearch` field.

### Sprint 2 (20d42cb): the runner you extend
**Created:** `src/research/runner.ts` — `runResearchJob(job, deps): Promise<RunResult>`,
`RunDeps`, `QueryModel`, `FindingSink`, `registerAnalyzer`. `model-diversity.ts`, `note-writer.ts`,
and `research run <jobId>` CLI (`src/cli/commands/research.ts:191-272`).
**Connection:** Sprint 3 inserts the gated retrieval branch between the model loop
(`runner.ts:160-163`) and note serialization (`runner.ts:166-167`), extends `RunDeps`
(`runner.ts:44-54`) with optional `egress`/`retrievalClient`, and threads URLs into the note.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **Zod for ALL config validation** (L29) — no hand-rolled validation. The new section is a Zod
  schema in `config/schema.ts`.
- **Additive optional sections** — `src/index.ts` exports public API only (L43); internal modules
  import directly. New section is `.optional()` so existing configs parse unchanged.
- **Fail-closed default** — egress axes default `false` (ADR-6 lineage; see medical/calendar).
- **No synchronous fs** (L42) — runner already uses `node:fs/promises`.
- **No test mocks for filesystem** (L44) — `runner.test.ts:45-51` uses `mkdtemp`/`rm` temp dirs.
- **Clock injection** (L31 of runner.ts) — `now` is injected; never call `new Date()` in the
  module. The runner already obeys this; keep it that way.
- **`import type` for type-only imports** (consistent-type-imports) — use it for
  `ResearchEgressGuard`/`RetrievalClient` where imported only as types.
- **`.js` extensions on all relative imports** (ESM/NodeNext).

### Architecture Decisions
ADR-6 (referenced throughout `src/medical/egress.ts:1,4` and `calendar-egress.ts:1`) =
code-enforced zero-egress, all axes default false. The new axis is a NEW, research-owned axis
under that lineage — do NOT reuse or widen the medical axes (contract `nonGoals`).

### Other Docs
README/CLAUDE.md not re-read for this sprint; conventions captured in §2 + principles above.

---

## 6. Testing Patterns

### Unit Test Pattern — egress (`src/research/egress.test.ts`, create)
**Source:** `src/medical/egress.test.ts:1-67` + `src/calendar/calendar-egress.test.ts:1-93`
```ts
import { describe, it, expect } from "vitest";
import { ResearchEgressGuard } from "./egress.js";
import type { BoberConfig } from "../config/schema.js";

describe("ResearchEgressGuard — online-research axis default false", () => {
  it("isAllowed false when research section absent (sc-3-1)", () => {
    const g = ResearchEgressGuard.fromConfig({} as BoberConfig);
    expect(g.isAllowed("online-research")).toBe(false);
  });
  it("assertAllowed throws exact message when off (sc-3-2)", () => {
    const g = ResearchEgressGuard.fromConfig({} as BoberConfig);
    expect(() => g.assertAllowed("online-research"))
      .toThrow("Egress axis 'online-research' not enabled");
  });
  it("isAllowed true + assertAllowed silent when on", () => {
    const g = ResearchEgressGuard.fromConfig(
      { research: { egress: { onlineResearch: true } } } as unknown as BoberConfig);
    expect(g.isAllowed("online-research")).toBe(true);
    expect(() => g.assertAllowed("online-research")).not.toThrow();
  });
});
```
**Runner:** vitest. **Assertion:** `expect(...).toThrow("...")` with the EXACT literal.
**File naming:** `*.test.ts` collocated next to source. **Location:** `src/research/`.

### Unit Test Pattern — runner gating (`src/research/runner.test.ts`, modify)
**Source / existing harness to extend:** `src/research/runner.test.ts:22-86` (temp-dir lifecycle,
fake `queryModel`, recording `findingSink`). Add sc-3-3 cases with a **spy retrieval client**:
```ts
import { ResearchEgressGuard } from "./egress.js";
import type { RetrievalClient } from "./online-retrieval.js";

const sources = [{ title: "ESM RFC", url: "https://example.com/esm" }];

it("axis OFF (default config): retrieval client called 0 times (sc-3-3)", async () => {
  let calls = 0;
  const retrievalClient: RetrievalClient = { search: async () => { calls++; return sources; } };
  const egress = ResearchEgressGuard.fromConfig({} as BoberConfig); // off
  await runResearchJob(JOB, { queryModel, findingSink: async () => {}, now: NOW,
    vaultRoot: tmpRoot, egress, retrievalClient });
  expect(calls).toBe(0);
});

it("axis ON: client invoked and note lists the source URLs (sc-3-3)", async () => {
  let calls = 0;
  const retrievalClient: RetrievalClient = { search: async () => { calls++; return sources; } };
  const egress = ResearchEgressGuard.fromConfig(
    { research: { egress: { onlineResearch: true } } } as unknown as BoberConfig);
  const res = await runResearchJob(JOB, { queryModel, findingSink: async () => {}, now: NOW,
    vaultRoot: tmpRoot, egress, retrievalClient });
  expect(calls).toBe(1);
  const raw = await readFile(res.notePath, "utf-8");
  expect(raw).toContain("https://example.com/esm");
});
```
**Mock approach:** plain injected spy object (no `vi.mock`); fs via real `mkdtemp` temp dir
(`runner.test.ts:45-51`) — principles.md:44 forbids fs mocks.

### E2E Test Pattern
Not applicable — no Playwright in this CLI/library project. The CLI path is exercised by
`src/cli/commands/research.test.ts` (whole-module `vi.mock` of `utils/fs.js`, per research.ts:21).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/research/runner.test.ts` | `runner.ts` `RunDeps` | low | New deps are OPTIONAL — existing `RunDeps` constructions at L66/83/94/108/117/130/139/154/164/173/182 stay valid. |
| `src/cli/commands/research.ts:254-259` | `runner.ts` `RunDeps` | low | Builds `RunDeps` without `egress`/`retrievalClient`; must still compile. Keep both optional. |
| `src/research/note-writer.test.ts:10` | `serializeResearchNote` | medium | If you add the 5th `sources` param, it MUST default `[]` so existing 4-arg calls + byte-identical output hold. |
| Everything importing `BoberConfig` | `schema.ts` `BoberConfigSchema` | low | Additive `.optional()` key — type widens only; no existing field changes. |
| `src/config/schema.test.ts` | `BoberConfigSchema` | low | Confirm a config with NO `research` key still parses. |

### Existing Tests That Must Still Pass
- `src/research/runner.test.ts` (Sprint 2, 12 cases) — must pass unchanged for the off-path; the
  no-`egress` deps path MUST stay byte-identical (contract stopCondition L44).
- `src/research/note-writer.test.ts` — verifies frontmatter has `jobId/question/models/generatedAt`
  and no `[object Object]`; ensure `sources` default `[]` preserves this.
- `src/medical/egress.test.ts` — must be UNCHANGED and green (you did NOT touch medical egress;
  proves the medical axes were not widened — contract nonGoal).
- `src/calendar/calendar-egress.test.ts` — unchanged/green.
- `src/config/schema.test.ts` — additive section must not break existing parse tests.

### Features That Could Be Affected
- **Medical literature retrieval** — shares the egress *pattern* only. `src/medical/retrieval/`
  and `src/medical/egress.ts` MUST stay byte-identical. Verify the medical suite is untouched.
- **`bober research run` CLI** — shares `runner.ts`. The default `research run` (no config opt-in)
  must remain a fully-offline run issuing zero outbound requests (DoD).
- **Name-collision watch:** `src/medical/research/online-research.ts` ALSO exports a
  `runResearchJob` (imported by `src/cli/commands/medical.ts:32`). It is a DIFFERENT module — do
  NOT touch it, and do NOT confuse it with `src/research/runner.ts`. Your new file is
  `src/research/online-retrieval.ts` (retrieval, not "online-research").

### Recommended Regression Checks
1. `npm run build` (tsc strict — sc-3-4 gate).
2. `npx vitest run src/research/` — egress + runner (new sc-3-1/2/3) + note-writer + job-store.
3. `npx vitest run src/medical/egress.test.ts src/calendar/calendar-egress.test.ts` — prove the
   other egress domains are byte-identical/green (no widening).
4. `npx vitest run src/config/` — config schema still parses configs with no `research` key.
5. `npm run lint` — consistent-type-imports + `.js` extensions + unused-var rules.

---

## 8. Implementation Sequence (dependency-ordered)

1. **src/config/schema.ts** — add `ResearchSectionSchema` (after L477) + register
   `research: ResearchSectionSchema.optional()` after L517.
   - Verify: `BoberConfig` type now has optional `research`; `npm run build` still green;
     `createDefaultConfig` untouched.
2. **src/research/egress.ts** — `ResearchEgressGuard` (mirror medical, single `'online-research'`
   axis), depends only on `BoberConfig` type from step 1.
   - Verify: `fromConfig({})` → `isAllowed('online-research') === false`; `assertAllowed` throws
     the exact literal.
3. **src/research/online-retrieval.ts** — `RetrievalSource`, `RetrievalClient`,
   `retrieve(query, client)`. No deps on the guard.
   - Verify: `retrieve` returns the client's sources; returns `[]` on client throw.
4. **src/research/note-writer.ts** — add optional `sources: string[] = []` 5th param + `sources`
   frontmatter (only when non-empty) and/or a body section.
   - Verify: 4-arg calls byte-identical; `note-writer.test.ts` green.
5. **src/research/runner.ts** — extend `RunDeps` with optional `egress`/`retrievalClient`; insert
   the gated branch (between L163 and L166); thread `sourceUrls` into `serializeResearchNote`.
   - Verify: off-path (no egress dep) byte-identical; on-path threads URLs.
6. **src/research/egress.test.ts** + **src/research/runner.test.ts** — sc-3-1/2/3 cases.
   - Verify: spy called 0 times when off, 1 time when on; note contains the URL.
7. **Run full verification** — `npm run build` + `npx vitest run src/research src/medical/egress.test.ts src/calendar/calendar-egress.test.ts src/config` + `npm run lint`.

---

## 9. Pitfalls & Warnings

- **note-writer.ts is NOT in `estimatedFiles`** but is the cleanest place to add `sources`.
  Adding it is fine (additive optional param), but the new param MUST default `[]` so Sprint-2's
  byte-identical output and `note-writer.test.ts` hold. Alternative: append a `## Sources` block to
  the note string inside the runner — avoids touching note-writer.ts but is less clean.
- **`sources` frontmatter must be `string[]` (URLs), never objects.** `serializeFrontmatter`
  (`src/vault/frontmatter.ts:151-159`) `String(item)`s array entries → objects become
  `[object Object]` (the exact bug warned at `note-writer.ts:48-49`). Map `RetrievalSource[]` →
  `s.url` before passing.
- **Do NOT widen or import the medical `EgressGuard`/axes.** Create a SEPARATE
  `ResearchEgressGuard` with its own `'online-research'` axis (contract nonGoal). Medical and
  calendar egress files must stay byte-identical.
- **Keep `RunDeps.egress`/`retrievalClient` OPTIONAL.** Sprint-2 `runner.test.ts` and
  `research.ts` construct `RunDeps` without them; making them required breaks compilation (sc-3-4)
  and the byte-identical off-path (stopCondition).
- **Off-path must construct NO client and issue ZERO requests.** Gate with
  `deps.egress?.isAllowed("online-research") && deps.retrievalClient !== undefined` BEFORE calling
  `retrieve`. The contract's hard proof is "spy called 0 times" when off.
- **Name collision:** `src/medical/research/online-research.ts` exists and also exports
  `runResearchJob`. Your new file is `src/research/online-retrieval.ts`. Do not edit the medical one.
- **`per-job onlineResearch` (types.ts:51) ≠ the config egress axis.** The gate is the CONFIG
  `research.egress.onlineResearch` via `ResearchEgressGuard`, not the per-job boolean. Do not
  conflate them (the job flag is forward-compat storage from Sprint 1).
- **CLI real-wiring is OPTIONAL / not gated.** sc-3-3 is satisfied by `runner.test.ts` with
  injected deps. If you wire the real guard into `research.ts`, follow the precedent
  `src/cli/commands/medical.ts:168-169` (`loadConfig` → `EgressGuard.fromConfig`) but keep
  `research.ts` compiling whether or not you add it (it is not in `estimatedFiles`).
- **`import type`** for `ResearchEgressGuard`/`RetrievalClient` when used only as types; `.js`
  extensions on every relative import (ESM/NodeNext, principles.md:27).
