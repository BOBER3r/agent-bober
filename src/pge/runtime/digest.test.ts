import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createArchiveWriter, restoreWritableTree } from "./archive.js";
import {
  DEFAULT_SELECTION_MIN_SCORE,
  DIGEST_SECTION_HEADINGS,
  DIGEST_TOKEN_CEILING,
  DiagnosisSchema,
  DigestInvalidError,
  DigestMissingError,
  DigestTooLargeError,
  DigestUnreadableError,
  DigestUnrenderableError,
  PhaseDigestSchema,
  digestPath,
  digestRoot,
  distillFromArchive,
  hasEvidencedDiagnosis,
  listArchivedNodes,
  parseDigest,
  readArchivedNode,
  readDigest,
  renderDigest,
  selectSurvivors,
  writeDigest,
} from "./digest.js";
import type { PhaseDigest, RunCandidate } from "./digest.js";
import { createCharsPerTokenEstimator } from "./token-estimator.js";

/**
 * The phase digest: four required non-empty sections, evidence-backed diagnoses, a pinned
 * token ceiling, a selection rule that spares a regressing run that can say why, and a
 * reader that fails closed three ways.
 *
 * Real temp directories and real writes throughout; nothing here mocks the filesystem,
 * because a filesystem mock would make the "digest is on disk and byte-recoverable"
 * assertions statements about the mock.
 *
 * ── Mutation-proven ──
 *
 * This suite was run against four deliberate breakages and failed on each:
 *  - `PhaseDigestSchema` using `z.array(z.string())` without `.min(1)` on the array
 *    (the section-missing and section-empty fixtures then validated);
 *  - `.min(1)` on the arrays but not on the elements (the `[""]` fixture then validated);
 *  - `selectSurvivors` returning `candidates` unchanged (the pruning control then failed);
 *  - `readDigest` returning `null` on absent instead of throwing (the fail-closed case
 *    then silently produced a successor with no context).
 */

const EST = createCharsPerTokenEstimator(4);
const RUN = "run-digest";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-digest-"));
});

afterEach(async () => {
  await restoreWritableTree(root);
  await rm(root, { recursive: true, force: true });
});

function digestFixture(): PhaseDigest {
  return {
    phase: "generating",
    runId: RUN,
    createdAt: "2026-08-05T00:00:00.000Z",
    insights: [
      "The barrier, not the scheduler, is what makes the fan-in deterministic.",
      "Reducers must be called once with the whole batch or order dependence returns.",
      "Offloading bulk payloads to scratch keeps every channel inside its inline cap.",
    ],
    modellingChoices: [
      {
        timestamp: "2026-08-05T00:00:01.000Z",
        description: "Model the fan-in join as a semilattice",
        rationale: "Order invariance is the only property a concurrent barrier can rely on",
        madeBy: "generator",
      },
      {
        timestamp: "2026-08-05T00:00:02.000Z",
        description: "Scope the loop counter by branch key",
        rationale: "Otherwise the bound becomes a function of the concurrency cap",
        madeBy: "planner",
      },
    ],
    nextSteps: [
      "Re-run the exactly-once suite at concurrency 8 and compare artifacts.",
      "Pin the counter reducer so a replayed superstep cannot over-count.",
    ],
    diagnoses: [
      {
        hypothesis: "The branch committed twice because the task key ignored the branch key.",
        evidence: "Two spans share an inputHash and differ only in branchKey.",
      },
      {
        hypothesis: "The regression is in the estimator, not in the compaction trigger.",
        evidence: "The 84% fixture crossed the threshold only after chars/4 became chars/2.",
        score: 0.41,
      },
    ],
  };
}

// ── sc-10-1 ─────────────────────────────────────────────────────────

describe("sc-10-1: the digest is written to .bober/handoff/<phase>-digest.md with four sections", () => {
  it("writes the phase-named markdown file under the SINGULAR handoff directory", async () => {
    const written = await writeDigest(root, digestFixture(), EST);

    expect(written.path).toBe(join(root, ".bober", "handoff", "generating-digest.md"));
    expect(digestRoot(root)).toBe(join(root, ".bober", "handoff"));
    expect(digestPath(root, "evaluating")).toBe(
      join(root, ".bober", "handoff", "evaluating-digest.md"),
    );
    expect(await readdir(join(root, ".bober", "handoff"))).toEqual(["generating-digest.md"]);
  });

  it("the written file carries all four `##` section headings and their content", async () => {
    const written = await writeDigest(root, digestFixture(), EST);
    const onDisk = await readFile(written.path, "utf8");

    expect(onDisk).toBe(written.markdown);
    for (const heading of DIGEST_SECTION_HEADINGS) {
      expect(onDisk, `missing section ${heading}`).toContain(`\n${heading}\n`);
    }
    expect(DIGEST_SECTION_HEADINGS).toEqual([
      "## Insights",
      "## Modelling choices",
      "## Next steps",
      "## Diagnoses",
    ]);
    expect(onDisk).toContain("The barrier, not the scheduler");
    expect(onDisk).toContain("Model the fan-in join as a semilattice");
    expect(onDisk).toContain("Re-run the exactly-once suite");
    expect(onDisk).toContain("The branch committed twice");
  });

  it("round-trips: parseDigest(renderDigest(d)) deep-equals d", () => {
    const digest = digestFixture();
    expect(parseDigest(renderDigest(digest))).toEqual(digest);
  });

  it("round-trips a diagnosis carrying an evidenceRef, so bulk evidence stays out of line", () => {
    const digest = digestFixture();
    digest.diagnoses[0].evidenceRef = {
      uri: `scratch://${RUN}/${"c".repeat(64)}.txt`,
      sha256: "c".repeat(64),
      bytes: 1_048_576,
      kind: "stdout",
    };
    expect(parseDigest(renderDigest(digest))).toEqual(digest);
  });

  it.each([
    ["a section is absent", "nextSteps", undefined],
    ["a section is an empty array", "nextSteps", []],
    ["a section holds only blanks", "nextSteps", [""]],
  ])("the validator fails the run when %s", (_label, key, value) => {
    const payload: Record<string, unknown> = { ...digestFixture() };
    if (value === undefined) delete payload[key];
    else payload[key] = value;

    const result = PhaseDigestSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((i) => i.path.join("."))).toContainEqual(
      expect.stringContaining("nextSteps"),
    );
  });

  it("a draft with an empty section never reaches the disk", async () => {
    const draft = { ...digestFixture(), insights: [] };
    await expect(writeDigest(root, draft, EST)).rejects.toThrow(DigestInvalidError);
    await expect(readdir(join(root, ".bober", "handoff"))).rejects.toThrow(/ENOENT/);
  });

  it("refuses a prose field the line grammar would mangle, at render time", () => {
    const digest = digestFixture();
    digest.insights[0] = "two\nlines";
    expect(() => renderDigest(digest)).toThrow(DigestUnrenderableError);

    const separated = digestFixture();
    separated.modellingChoices[0].description = "a :: b";
    expect(() => renderDigest(separated)).toThrow(/reserved separator/);
  });
});

// ── sc-10-2 ─────────────────────────────────────────────────────────

describe("sc-10-2: the digest sits under the pinned token ceiling, measured by the injected estimator", () => {
  it("estimates to well under a quarter of the 2000-token ceiling, so estimator precision cannot flip it", async () => {
    const written = await writeDigest(root, digestFixture(), EST);

    expect(written.tokens).toBe(EST.estimate(written.markdown));
    expect(written.tokens).toBeLessThan(DIGEST_TOKEN_CEILING / 4);
    // Stated out loud: the margin is more than 1500 tokens, so an estimator that were
    // wrong by a factor of three would still not reach the ceiling.
    expect(DIGEST_TOKEN_CEILING - written.tokens).toBeGreaterThan(1500);
  });

  it("refuses a digest that HAS crossed the ceiling rather than writing it", async () => {
    const fat = digestFixture();
    fat.insights.push("y".repeat(DIGEST_TOKEN_CEILING * 4 + 4000));
    await expect(writeDigest(root, fat, EST)).rejects.toThrow(DigestTooLargeError);
    await expect(readdir(join(root, ".bober", "handoff"))).rejects.toThrow(/ENOENT/);
  });
});

// ── sc-10-3 ─────────────────────────────────────────────────────────

describe("sc-10-3: a diagnosis needs a hypothesis AND its evidence; a bare score is refused", () => {
  it("a score-only diagnosis fails validation, naming BOTH missing paths", () => {
    const payload = { ...digestFixture(), diagnoses: [{ score: 0.42 }] };

    const result = PhaseDigestSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (result.success) return;

    const paths = result.error.issues.map((issue) => issue.path.join("."));
    expect(paths).toContain("diagnoses.0.hypothesis");
    expect(paths).toContain("diagnoses.0.evidence");
  });

  it("writeDigest surfaces those same Zod paths on the error it throws", async () => {
    const payload = { ...digestFixture(), diagnoses: [{ score: 0.42 }] };
    let caught: unknown;
    try {
      await writeDigest(root, payload as unknown as PhaseDigest, EST);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DigestInvalidError);
    const error = caught as DigestInvalidError;
    expect(error.paths).toContain("diagnoses.0.hypothesis");
    expect(error.paths).toContain("diagnoses.0.evidence");
    expect(error.message).toContain("diagnoses.0.hypothesis");
  });

  it("an empty hypothesis or an empty evidence is refused just as a missing one is", () => {
    expect(DiagnosisSchema.safeParse({ hypothesis: "", evidence: "e" }).success).toBe(false);
    expect(DiagnosisSchema.safeParse({ hypothesis: "h", evidence: "" }).success).toBe(false);
    expect(DiagnosisSchema.safeParse({ hypothesis: "h", evidence: "e" }).success).toBe(true);
  });

  it("positive control: score is ACCEPTED alongside a hypothesis and evidence", () => {
    expect(
      DiagnosisSchema.safeParse({ hypothesis: "h", evidence: "e", score: 0.42 }).success,
    ).toBe(true);
  });
});

// ── sc-10-4 ─────────────────────────────────────────────────────────

describe("sc-10-4: a regressed run that records a rationale is not auto-pruned", () => {
  function pair(): RunCandidate[] {
    return [
      { id: "lower", score: 0.4, digest: digestFixture() },
      { id: "higher", score: 0.9, digest: null },
    ];
  }

  it("the LOWER-scoring run with a diagnosis survives, and so does the higher-scoring one", () => {
    const survivors = selectSurvivors(pair());
    expect(survivors.map((c) => c.id)).toEqual(["lower", "higher"]);
    // Explicitly: `lower` is below the default cut and survives on its diagnosis alone.
    expect(pair()[0].score).toBeLessThan(DEFAULT_SELECTION_MIN_SCORE);
  });

  it("control: a low score with NOTHING to say about it IS pruned", () => {
    const survivors = selectSurvivors([
      ...pair(),
      { id: "bare", score: 0.1, digest: null },
    ]);
    expect(survivors.map((c) => c.id)).toEqual(["lower", "higher"]);
    expect(survivors.map((c) => c.id)).not.toContain("bare");
  });

  it("control: a low score with a digest whose diagnoses are all unevidenced is pruned too", () => {
    // The digest exists; it just has nothing that qualifies. `hasEvidencedDiagnosis`
    // demands a NON-BLANK hypothesis and a NON-BLANK evidence, not merely an array.
    const blank: PhaseDigest = {
      ...digestFixture(),
      diagnoses: [{ hypothesis: "   ", evidence: "   " }],
    };
    expect(hasEvidencedDiagnosis(blank)).toBe(false);
    expect(hasEvidencedDiagnosis(null)).toBe(false);
    expect(hasEvidencedDiagnosis(digestFixture())).toBe(true);

    const survivors = selectSurvivors([{ id: "blank", score: 0.1, digest: blank }]);
    expect(survivors).toEqual([]);
  });

  it("the cut is configurable and moves the boundary", () => {
    const candidates: RunCandidate[] = [{ id: "mid", score: 0.6, digest: null }];
    expect(selectSurvivors(candidates).map((c) => c.id)).toEqual(["mid"]);
    expect(selectSurvivors(candidates, { minScore: 0.7 })).toEqual([]);
  });
});

// ── Fail-closed reading ─────────────────────────────────────────────

describe("readDigest fails closed, three ways, with no transcript fallback", () => {
  it("an absent digest raises DigestMissingError naming the path it looked at", async () => {
    let caught: unknown;
    try {
      await readDigest(root, "generating");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DigestMissingError);
    expect((caught as DigestMissingError).path).toBe(digestPath(root, "generating"));
    expect((caught as Error).message).toContain("no fallback");
  });

  it("an unreadable digest is a DIFFERENT error from an absent one", async () => {
    const path = digestPath(root, "generating");
    await writeDigest(root, digestFixture(), EST);
    await chmod(path, 0o000);
    try {
      const caught = await readDigest(root, "generating").catch((e: unknown) => e);
      // Running as root defeats a mode bit, so the outcome is one of exactly two things:
      // the distinct unreadable error, or the digest itself. What it is NEVER allowed to
      // be is `DigestMissingError` — "there but unreadable" and "not there" are different
      // facts with different remedies, and collapsing them is the bug `FileRead` exists
      // to prevent.
      expect(caught).not.toBeInstanceOf(DigestMissingError);
      if (caught instanceof DigestUnreadableError) {
        expect(caught.code).toBe("EACCES");
        expect(caught.path).toBe(path);
      } else {
        expect(caught).toEqual(digestFixture());
      }
    } finally {
      await chmod(path, 0o644);
    }
  });

  it("a present-but-corrupt digest raises DigestInvalidError with the failing paths", async () => {
    await writeDigest(root, digestFixture(), EST);
    const path = digestPath(root, "generating");
    const good = await readFile(path, "utf8");
    // Delete every bullet under `## Diagnoses`, leaving the heading in place.
    const corrupt = good.slice(0, good.indexOf("## Diagnoses") + "## Diagnoses\n\n".length);
    await writeFile(path, corrupt, "utf8");

    let caught: unknown;
    try {
      await readDigest(root, "generating");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DigestInvalidError);
    expect((caught as DigestInvalidError).paths).toContain("diagnoses");
  });

  it("a digest whose header comment is gone fails on the identity fields, not silently", async () => {
    await writeDigest(root, digestFixture(), EST);
    const path = digestPath(root, "generating");
    const stripped = (await readFile(path, "utf8"))
      .split("\n")
      .filter((line) => !line.startsWith("<!-- engram:v1"))
      .join("\n");
    await writeFile(path, stripped, "utf8");

    const caught = await readDigest(root, "generating").catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(DigestInvalidError);
    expect((caught as DigestInvalidError).paths).toEqual(
      expect.arrayContaining(["phase", "runId", "createdAt"]),
    );
  });
});

// ── Distillation from sealed archives ───────────────────────────────

/** Every path under `dir`, relative and sorted. The isolation suite's walk, reused. */
async function walk(dir: string, prefix = ""): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir, { withFileTypes: true }).then((entries) =>
      entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)),
    );
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of names.sort()) {
    const rel = prefix + name;
    found.push(rel);
    if (name.endsWith("/")) found.push(...(await walk(join(dir, name.slice(0, -1)), rel)));
  }
  return found;
}

describe("distillFromArchive reads sealed archives and never rewrites them", () => {
  async function seedArchive(): Promise<void> {
    const writer = createArchiveWriter(root);
    const ok = await writer.open(RUN, "producer", null);
    await ok.writeSnapshot({ input: 1 });
    await ok.appendStdout("producer emitted 3 messages\n");
    await ok.writeOutputs({ produced: 3, mode: "fast" });
    await ok.seal();

    const bad = await writer.open(RUN, "verify", "b-1");
    await bad.writeSnapshot({ input: 2 });
    await bad.appendStdout("running checks\nERROR: reducer contract violated\ndone\n");
    await bad.writeOutputs({ passed: false });
    await bad.seal();
  }

  it("enumerates (nodeId, branchKey) from the leaf names, splitting on the @ separator", async () => {
    await seedArchive();
    expect(await listArchivedNodes(root, RUN)).toEqual([
      { nodeId: "producer", branchKey: null },
      { nodeId: "verify", branchKey: "b-1" },
    ]);
  });

  it("derives insights, choices and evidence-backed diagnoses from what the archive holds", async () => {
    await seedArchive();
    const draft = await distillFromArchive(root, {
      phase: "generating",
      runId: RUN,
      now: () => new Date("2026-08-05T00:00:00.000Z"),
      nextSteps: ["Fix the reducer contract and re-run."],
    });

    expect(draft.insights).toEqual([
      "producer produced outputs: mode, produced.",
      "verify@b-1 produced outputs: passed.",
    ]);
    expect(draft.modellingChoices).toHaveLength(2);
    expect(draft.modellingChoices[0].madeBy).toBe("generator");
    expect(draft.diagnoses).toEqual([
      {
        hypothesis: "verify@b-1 did not complete cleanly.",
        evidence: "ERROR: reducer contract violated",
      },
    ]);

    // And it is a legal digest: four non-empty sections, so it writes.
    const written = await writeDigest(root, draft, EST);
    expect(written.tokens).toBeLessThan(DIGEST_TOKEN_CEILING);
  });

  it("leaves the archive tree byte-identical — no open(), no write, seal untouched", async () => {
    await seedArchive();
    const before = await walk(join(root, ".bober", "archive"));
    const beforeBytes = await Promise.all(
      before
        .filter((p) => !p.endsWith("/"))
        .map((p) => readFile(join(root, ".bober", "archive", p), "utf8")),
    );

    await distillFromArchive(root, {
      phase: "generating",
      runId: RUN,
      now: () => new Date("2026-08-05T00:00:00.000Z"),
      nextSteps: ["Fix the reducer contract and re-run."],
    });

    expect(await walk(join(root, ".bober", "archive"))).toEqual(before);
    const afterBytes = await Promise.all(
      before
        .filter((p) => !p.endsWith("/"))
        .map((p) => readFile(join(root, ".bober", "archive", p), "utf8")),
    );
    expect(afterBytes).toEqual(beforeBytes);
    expect((await readArchivedNode(root, RUN, "producer", null)).sealed).toBe(true);
  });

  it("distilling a run with NO archive fabricates nothing and creates no directory", async () => {
    const draft = await distillFromArchive(root, {
      phase: "generating",
      runId: "run-never-ran",
      now: () => new Date("2026-08-05T00:00:00.000Z"),
      nextSteps: ["Start over."],
    });
    expect(draft.insights).toEqual([]);
    expect(draft.diagnoses).toEqual([]);
    expect(await walk(join(root, ".bober", "archive"))).toEqual([]);

    // And an empty draft is REFUSED rather than written as an empty digest.
    await expect(writeDigest(root, draft, EST)).rejects.toThrow(DigestInvalidError);
  });

  it("an archive with no failure evidence yields no diagnoses, and the schema says so", async () => {
    const writer = createArchiveWriter(root);
    const clean = await writer.open("run-clean", "producer", null);
    await clean.writeSnapshot({});
    await clean.appendStdout("all good\n");
    await clean.writeOutputs({ ok: true });
    await clean.seal();

    const draft = await distillFromArchive(root, {
      phase: "generating",
      runId: "run-clean",
      now: () => new Date("2026-08-05T00:00:00.000Z"),
      nextSteps: ["Ship it."],
    });
    expect(draft.diagnoses).toEqual([]);

    const caught = await writeDigest(root, draft, EST).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(DigestInvalidError);
    expect((caught as DigestInvalidError).paths).toContain("diagnoses");
  });
});
