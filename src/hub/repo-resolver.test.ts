import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactStore, factsDbPath, ensureFactsDir } from "../state/facts.js";
import { HUB_SCOPE } from "./finding-source.js";
import { resolveSiblingRepos } from "./repo-resolver.js";

// ── Fixtures ─────────────────────────────────────────────────────────

const T = "2026-06-28T00:00:00.000Z";

/** Seed a writable file-backed store so the repo has a facts.db, then close. */
async function seedRepo(repoRoot: string): Promise<void> {
  await ensureFactsDir(repoRoot);
  const store = new FactStore(factsDbPath(repoRoot));
  store.insertFact({
    scope: HUB_SCOPE,
    subject: "seed",
    predicate: "finding",
    value: JSON.stringify({
      id: "f-seed",
      domain: "medical",
      title: "seed",
      kind: "action",
      urgency: 1,
      severity: 1,
      evidence: [],
      surfacedAt: T,
      tags: [],
      status: "open",
    }),
    confidence: 1,
    sourceRunId: null,
    tValid: T,
    tCreated: T,
  });
  store.close();
}

// ── Tests: sc-2-5 ─────────────────────────────────────────────────────

describe("resolveSiblingRepos", () => {
  let parent: string;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "bober-parent-"));
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it("discovers existing kb-* siblings as absolute paths (sc-2-5)", async () => {
    const projectRoot = join(parent, "agent-bober");
    const kbA = join(parent, "kb-a");
    const kbB = join(parent, "kb-b");
    await seedRepo(kbA);
    await seedRepo(kbB);
    // create a non-kb dir that must be ignored
    await mkdir(join(parent, "not-kb-dir"), { recursive: true });

    const repos = await resolveSiblingRepos(projectRoot);
    expect(repos.sort()).toEqual([kbA, kbB].sort());
  });

  it("ignores directories that do not match kb-* prefix (sc-2-5)", async () => {
    const projectRoot = join(parent, "agent-bober");
    // no kb-* dirs created
    await mkdir(join(parent, "some-other-dir"), { recursive: true });

    const repos = await resolveSiblingRepos(projectRoot);
    expect(repos).toHaveLength(0);
  });

  it("skips a kb-* dir that lacks facts.db (sc-2-5)", async () => {
    const projectRoot = join(parent, "agent-bober");
    // kb-empty has no facts.db
    await mkdir(join(parent, "kb-empty"), { recursive: true });

    const repos = await resolveSiblingRepos(projectRoot);
    expect(repos).toHaveLength(0);
  });

  it("resolves configuredRepos to absolute paths (sc-2-5)", async () => {
    const projectRoot = join(parent, "agent-bober");
    const kbA = join(parent, "kb-a");
    await seedRepo(kbA);

    // Pass absolute path — resolve() is idempotent for absolute paths
    const repos = await resolveSiblingRepos(projectRoot, [kbA]);
    expect(repos).toEqual([kbA]);
  });

  it("skips a configured path that does not exist, no throw (sc-2-5)", async () => {
    const projectRoot = join(parent, "agent-bober");
    const kbA = join(parent, "kb-a");
    await seedRepo(kbA);
    const ghost = join(parent, "kb-ghost"); // does not exist

    const repos = await resolveSiblingRepos(projectRoot, [kbA, ghost]);
    expect(repos).toEqual([kbA]);
  });

  it("returns empty array when parent dir is missing (sc-2-5)", async () => {
    // projectRoot's parent does not exist
    const projectRoot = join(parent, "nested", "deep", "project");
    const repos = await resolveSiblingRepos(projectRoot);
    expect(repos).toHaveLength(0);
  });
});
