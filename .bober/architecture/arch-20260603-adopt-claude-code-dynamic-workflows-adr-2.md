# ADR-2: Engine-Selection Seam at the runPipeline Signature Boundary

**Decision:** Introduce a `PipelineEngine` interface whose single `run(userPrompt, projectRoot, config) => Promise<PipelineResult>` method is the existing `runPipeline` signature (`pipeline.ts:516`); a selector resolves `config.pipeline.engine` to one of three implementations behind it.

**Context:** The TS `runPipeline` must remain callable byte-for-byte as the CI/headless fallback. A seam is needed so the workflow engine can be swapped in without mutating the frozen fallback body.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| Seam at the runPipeline signature | TS path stays untouched and callable byte-for-byte; selector reuses `registry.ts:65` resolution | One new interface and selector to maintain |
| Branch inside the runPipeline body | No new interface | Mutates the frozen fallback; couples engines |
| Fork at CLI run.ts before config load | Early dispatch | Duplicates config/override logic; selection happens before config is validated |

**Rationale:** Checkpoint-1 "TS engine `runPipeline` stays fallback" requires the TS path callable byte-for-byte; a seam AT the signature keeps it untouched, whereas branching in the body mutates the frozen fallback. The selector reuses the `registry.ts:65` resolution pattern.

**Consequences:** `PipelineSectionSchema` (`schema.ts:147`) gains `engine: PipelineEngineName` defaulting to `"ts"`. `run.ts:146` calls `selector.select(...).run(...)`. A `run --engine` flag is added alongside `--mode`/`--checkpoint` (`run.ts:13`).

**Risk:** A `PipelineResult` field populated only by `runPipeline` and not by the workflow path makes conformance pass on shape but diverge on content — the harness must diff content, not only structure.
