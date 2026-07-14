# Online-research egress axis (default off) + gated web retrieval

**Contract:** sprint-spec-20260628-research-scheduler-3  ·  **Spec:** spec-20260628-research-scheduler  ·  **Completed:** 2026-06-29

## What this sprint added

Sprint 3 — the **egress layer** of the **research-scheduler** plan (3 of 5) — adds a new
**research-owned** opt-in egress axis, `online-research`, that mirrors the medical `EgressGuard`
pattern: it defaults to **false** and is **fail-closed**. A new `ResearchEgressGuard`
(`src/research/egress.ts`) and an injectable retrieval client (`src/research/online-retrieval.ts`)
let Sprint 2's runner optionally fetch web sources **only when the axis is explicitly opted in via
config**. With the axis off (the default) — or when the new optional `RunDeps` are simply absent — a
`runResearchJob` run issues **zero outbound requests** and is byte-identical to Sprint 2's offline
path; with the axis on, the runner retrieves sources and threads their URLs into the note's
frontmatter as a `string[]`. The axis is **separate** from the medical egress axes — the two domains
stay independent.

## Public surface

- `ResearchSectionSchema` / `ResearchSection` (`src/config/schema.ts:481`/`:490`) — a new **optional**
  config section. Shape: `egress?: { onlineResearch: boolean (default false) }`. Registered on
  `BoberConfigSchema` as `research: ResearchSectionSchema.optional()` (`src/config/schema.ts:532`),
  next to `medical` / `calendar`. **Additive** — a config with no `research` section parses unchanged.
- `ResearchEgressGuard` (`src/research/egress.ts:17`) — guards the single `online-research` axis,
  modeled line-for-line on `src/medical/egress.ts`:
  - `static fromConfig(config)` (`:21`) — reads `config.research?.egress?.onlineResearch ?? false`
    (axis defaults **false** when the section is absent — fail-closed).
  - `isAllowed(axis)` (`:26`) — returns `true` **only** when the axis was explicitly opted in;
    exhaustive `switch` with a compile-time `never` guard.
  - `assertAllowed(axis)` (`:41`) — **throws** `Error("Egress axis 'online-research' not enabled")`
    when off, returns void when on. The throw literal matches `src/medical/egress.ts` exactly.
- `EgressAxis` (`src/research/egress.ts:5`) — the single-value union type `"online-research"`.
- `RetrievalClient` / `RetrievalSource` (`src/research/online-retrieval.ts:16`/`:6`) — the injectable,
  duck-typed retrieval contract. `RetrievalClient.search(query) => Promise<RetrievalSource[]>`;
  `RetrievalSource = { title, url }`. Tests pass a spy returning fixtures; production binds a real
  web-search client. (Mirrors `FetchLike` in `src/medical/retrieval/medline-source.ts`.)
- `retrieve(query, client)` (`src/research/online-retrieval.ts:33`) — calls the injected client and
  returns its sources, or `[]` on any client error (**fail-closed; never throws out**). It does **not**
  itself check egress — the runner gates the call before invoking it.
- `RunDeps.egress?` / `RunDeps.retrievalClient?` (`src/research/runner.ts:58`/`:60`) — two new
  **optional** injection slots on Sprint 2's `RunDeps`. Omitting either keeps a run fully offline.
- `serializeResearchNote(job, labels, contributions, now, sources?)` (`src/research/note-writer.ts:51`)
  — gained an optional 5th param `sources: string[] = []`. Default `[]` ⇒ frontmatter is
  **byte-identical** to Sprint 2; a non-empty list spreads a `sources` key (a `string[]` of URLs —
  never objects, sidestepping the `[object Object]` frontmatter pitfall).

## How to use / how it fits

The axis is **off by default**, so `bober research run <jobId>` stays fully offline out of the box.
To permit web retrieval, opt in via config:

```jsonc
// bober.config.json
{
  "research": {
    "egress": {
      "onlineResearch": true   // default false — permit online/web research retrieval
    }
  }
}
```

The gate in `runResearchJob` sits **between** the multi-model loop and note serialization
(`src/research/runner.ts:176`):

```ts
let sourceUrls: string[] = [];
if (deps.egress?.isAllowed("online-research") === true && deps.retrievalClient !== undefined) {
  const sources = await retrieve(job.question, deps.retrievalClient);
  sourceUrls = sources.map((s) => s.url);
}
```

So retrieval runs **only** when the axis is allowed **and** a retrieval client was injected. When the
axis is off or the deps are absent, `sourceUrls` stays `[]`, `retrieve` is never invoked, and **no
client is constructed** — the zero-outbound-bytes proof. The resolved URLs are threaded into the note
via the new `serializeResearchNote` `sources` param.

This sits between Sprint 2's on-demand runner and the later scheduler sprints: Sprint 4 will add the
cadence/tick runner that drives `runResearchJob` on a schedule, and Sprint 5 the digest.

## Notes for maintainers

- **Fail-closed at the default and at the gate.** Both `egress` absence and an off axis converge on
  the same zero-egress path; the gate's `=== true` and `!== undefined` checks mean a missing guard or
  a missing client both skip retrieval. The CLI does **not** wire a real retrieval client yet — the
  axis-on production path is enabled but no live search provider is bound in `research.ts` (the slot is
  injectable for tests today; a real provider is a follow-up).
- **Separate from medical egress.** This is a research-owned axis, deliberately **not** a reuse or
  widening of the medical `EgressGuard` axes (`cloud-inference` / `literature-retrieval` /
  `device-connection`). The two domains' egress postures stay independent — enabling one never enables
  the other.
- **`onlineResearch` config vs. the per-job `onlineResearch` flag.** Sprint 1's `ResearchJob` carries
  its own `onlineResearch` boolean (stored on the job, still inert). Sprint 3's gate keys off the
  **config** axis `config.research.egress.onlineResearch` + the injected deps — not the per-job flag.
  Reconciling the two (e.g. requiring both) is a candidate for the cadence sprint.
- **`retrieve` is fail-closed, not fail-loud.** It swallows client errors and returns `[]` so a flaky
  search provider degrades to an offline-shaped note rather than aborting the run.
- **Deferred to later sprints:** cadence due-date + the tick runner (Sprint 4), digest aggregation
  (Sprint 5), and binding a real web-search `RetrievalClient` in the CLI.

Commit: `0150737` — *bober(sprint-3): online-research egress axis (default off) + gated web retrieval*
(7 files, +265/−1; full suite **3553** green, +13; all 4 required criteria — sc-3-1..sc-3-4 — passed
iteration 1; typecheck/build/lint clean, zero regressions).
