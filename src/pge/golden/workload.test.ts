import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createDefaultConfig } from "../../config/schema.js";
import { PlanSpecSchema } from "../../contracts/spec.js";
import { SprintContractSchema } from "../../contracts/sprint-contract.js";
import type { TopologySpec } from "../../contracts/topology.js";
import { compile } from "../compile/compiler.js";
import { REAL_SPEC_ID, realPlanSpec } from "../engine/__fixtures__/real-workload.js";
import { byteSize, createCommitBoundary, createFixedClock } from "../runtime/commit.js";
import type { ChannelUpdate } from "../runtime/commit.js";
import {
  goldenContracts,
  goldenInitialState,
  goldenRegistries,
  goldenSpec,
} from "../runtime/__fixtures__/golden-graph.js";
import { buildWorkloadCorpus } from "./__fixtures__/workload-build.js";
import { WORKLOAD_DIR, capForCorpusMax, loadWorkloadCorpus, maxBytesPerChannel } from "./workload.js";
import type { WorkloadCorpus, WorkloadEntry } from "./workload.js";

/**
 * The COMMITTED workload corpus, checked against the COMMITTED topology and against the
 * REAL committed files it claims to be drawn from.
 *
 * Two rules, the same two `dataset.test.ts` states for the golden dataset. The entry set is
 * taken by reading `.bober/workload/` at test time, through {@link loadWorkloadCorpus} —
 * never a list written down here (sc-2-5). And every gate this file asserts is driven from
 * both sides: a positive assertion about the real corpus has a negative control that breaks
 * the same precondition on a TEMP COPY and proves the check fails (sc-2-4). The committed
 * corpus and the committed topology artifact are never mutated.
 *
 * Regenerate the corpus with:
 *   BUILD_WORKLOAD_CORPUS=1 npx vitest run src/pge/golden/workload.test.ts
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKLOAD_DIR_ABS = join(REPO_ROOT, WORKLOAD_DIR);
const TOPOLOGY_PATH = join(REPO_ROOT, ".bober", "topology", "coding.json");

const BUILDING = process.env.BUILD_WORKLOAD_CORPUS === "1";

interface DeclaredChannel {
  readonly id: string;
  readonly maxInlineBytes: number;
}

let declaredChannelIds: string[];
/** Every declared channel, cap included — sc-3-4 reads the SHIPPED cap off this, never a literal. */
let declaredChannels: DeclaredChannel[];
let corpus: WorkloadCorpus;

beforeAll(async () => {
  if (BUILDING) {
    await buildWorkloadCorpus();
  }

  const artifact = JSON.parse(await readFile(TOPOLOGY_PATH, "utf-8")) as {
    channels: DeclaredChannel[];
  };
  declaredChannels = artifact.channels;
  declaredChannelIds = artifact.channels.map((channel) => channel.id).sort();

  corpus = await loadWorkloadCorpus(WORKLOAD_DIR_ABS);
  expect(corpus.errors).toEqual([]);
}, 120_000);

const tempDirs: string[] = [];

/** A writable copy of the committed corpus. The committed one is never touched. */
async function copyCorpus(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "workload-corpus-"));
  tempDirs.push(dir);
  for (const file of corpus.files) await copyFile(join(WORKLOAD_DIR_ABS, file), join(dir, file));
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

// ── sc-2-5: committed, and read from disk at test time ──────────────

describe("the committed workload corpus (sc-2-5)", () => {
  it("is non-empty on disk, counted by reading the directory", () => {
    expect(corpus.files.length).toBeGreaterThan(0);
    expect(corpus.entries.length).toBe(corpus.files.length);
  });

  it("names every file for its own entryId, with no duplicate ids", () => {
    const ids = corpus.entries.map((entry) => entry.entryId);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(corpus.files.map((file) => file.slice(0, -".json".length)).sort());
  });
});

// ── sc-2-1: the entries are real ─────────────────────────────────────

describe("every entry is drawn from a real, currently-readable source (sc-2-1)", () => {
  it("holds this repository's own real PGE spec, byte-identical to the committed file", async () => {
    const entry = corpus.entries.find((candidate) => candidate.entryId === `spec-${REAL_SPEC_ID}`);
    expect(entry, `no corpus entry for ${REAL_SPEC_ID}`).toBeDefined();
    const real = await realPlanSpec();
    expect(entry?.value).toEqual(real);
  });

  it("every 'file' provenance entry for spec/sprintContracts equals its source file's parsed value", async () => {
    for (const entry of corpus.entries) {
      if (entry.provenance.kind !== "file") continue;
      const sourcePath = join(REPO_ROOT, entry.provenance.path);
      const raw: unknown = JSON.parse(await readFile(sourcePath, "utf-8"));
      if (entry.channel === "spec") {
        expect(entry.value, entry.entryId).toEqual(PlanSpecSchema.parse(raw));
      }
    }
  });

  it("every 'file-group' sprintContracts entry equals the array its own paths parse to", async () => {
    const groups = corpus.entries.filter(
      (entry): entry is WorkloadEntry & { provenance: { kind: "file-group"; paths: readonly string[] } } =>
        entry.provenance.kind === "file-group",
    );
    expect(groups.length).toBeGreaterThan(0);
    for (const entry of groups) {
      const parsed = await Promise.all(
        entry.provenance.paths.map(async (path) =>
          SprintContractSchema.parse(JSON.parse(await readFile(join(REPO_ROOT, path), "utf-8"))),
        ),
      );
      expect(entry.value, entry.entryId).toEqual(parsed);
    }
  });

  it("every 'observed' provenance entry names the node and channel it was captured from", () => {
    const observed = corpus.entries.filter((entry) => entry.provenance.kind === "observed");
    // sc-2-4's hardest four channels have no committed file anywhere in the repository —
    // see the workload-build.ts module header — so this is the only route to a real payload
    // for them, and this corpus must actually use it.
    expect(observed.length).toBeGreaterThan(0);
    for (const entry of observed) {
      if (entry.provenance.kind !== "observed") continue;
      expect(entry.provenance.source).toContain(entry.channel);
    }
  });
});

// ── sc-2-2: the SAME byteSize the commit boundary uses ───────────────

describe("the corpus maximum agrees with the real commit boundary (sc-2-2)", () => {
  it("maxBytesPerChannel is computed with the boundary's own byteSize, not a reimplementation", () => {
    const max = maxBytesPerChannel(corpus);
    for (const entry of corpus.entries) {
      expect(max[entry.channel]).toBeGreaterThanOrEqual(byteSize(entry.value));
    }
  });

  it(
    "a corpus-max messages payload is rejected by a real CommitBoundary at exactly the corpus's own number",
    async () => {
      const channel = "messages";
      const max = maxBytesPerChannel(corpus);
      const maxBytesForChannel = max[channel];
      expect(maxBytesForChannel, `no corpus entry for channel "${channel}"`).toBeDefined();

      const maxEntry = corpus.entries
        .filter((entry) => entry.channel === channel)
        .reduce((best, entry) => (byteSize(entry.value) > byteSize(best.value) ? entry : best));
      expect(byteSize(maxEntry.value)).toBe(maxBytesForChannel);

      // A graph whose OWN channel set matches the shipped one (this fixture's header notes
      // it shares every channel id with the committed artifact) but whose `messages` cap is
      // mutated to `corpusMax - 1` — a COPY, never the committed topology — so the real
      // boundary is guaranteed to reject the corpus's own heaviest payload.
      const base = goldenSpec();
      const mutated: TopologySpec = {
        ...base,
        channels: base.channels.map((decl) =>
          decl.id === channel ? { ...decl, maxInlineBytes: (maxBytesForChannel as number) - 1 } : decl,
        ),
      };
      const graph = compile(mutated, goldenRegistries({ contracts: goldenContracts(1) }));

      const root = await mkdtemp(join(tmpdir(), "workload-equivalence-"));
      try {
        const boundary = createCommitBoundary({ clock: createFixedClock("2026-08-05T00:00:00.000Z") });
        const update: ChannelUpdate = {
          channel,
          nodeId: "workload-corpus-probe",
          branchKey: null,
          value: maxEntry.value,
        };
        const result = await boundary.commit(graph, goldenInitialState("run-workload-equivalence", root), [update], {
          runId: "run-workload-equivalence",
          projectRoot: root,
          config: createDefaultConfig("workload-equivalence", "brownfield"),
          superstep: 0,
          startedAtMs: 0,
        });

        expect(result.rejected).toHaveLength(1);
        // `StateBloatError.bytes` is the boundary's OWN number — equality here is the proof
        // that `maxBytesPerChannel` did not re-derive it.
        expect(result.rejected[0].bytes).toBe(maxBytesForChannel);
        expect(result.rejected[0].channel).toBe(channel);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

// ── sc-2-4: no channel can silently escape measurement ───────────────

describe("the corpus covers every channel the artifact declares (sc-2-4)", () => {
  it("holds at least one entry for every channel .bober/topology/coding.json declares", () => {
    const present = new Set(corpus.entries.map((entry) => entry.channel));
    for (const channelId of declaredChannelIds) {
      expect(present.has(channelId), `channel "${channelId}" has no workload corpus entry`).toBe(true);
    }
  });

  it("names no channel the artifact does not declare", () => {
    const declared = new Set(declaredChannelIds);
    for (const entry of corpus.entries) {
      expect(declared.has(entry.channel), `${entry.entryId} names undeclared channel "${entry.channel}"`).toBe(true);
    }
  });

  it("fails the completeness check when a channel's entries are deleted from a TEMP COPY", async () => {
    const dir = await copyCorpus();
    const target = declaredChannelIds[0];
    expect(target).toBeDefined();

    for (const file of await readdir(dir)) {
      const raw = JSON.parse(await readFile(join(dir, file), "utf-8")) as { channel?: string };
      if (raw.channel === target) await rm(join(dir, file));
    }

    const mutated = await loadWorkloadCorpus(dir);
    const present = new Set(mutated.entries.map((entry) => entry.channel));
    expect(present.has(target as string)).toBe(false);

    // The exact assertion `sc-2-4`'s production test above makes, replayed against the
    // mutated copy — proof this is the check that would have failed had the real corpus
    // been missing that channel.
    const missing = declaredChannelIds.filter((channelId) => !present.has(channelId));
    expect(missing).toContain(target);
  });
});

// ── sc-3-4: each declared cap is pinned two-directionally against the corpus ──────

/**
 * Every channel whose declared cap is not exactly what the corpus says it must be —
 * `capForCorpusMax(corpusMax[channel.id])`. A channel absent from `corpusMax` is skipped
 * here rather than treated as a violation: sc-2-4 already owns "every declared channel has
 * a corpus entry," and conflating the two checks would make a coverage gap read as a cap
 * violation instead of what it actually is.
 *
 * EQUALITY, not `>=`: an inequality would only ever catch shrinkage, and sc-3-4 requires a
 * pin that also catches an unjustified raise.
 */
function capViolations(channels: readonly DeclaredChannel[], corpusMax: Record<string, number>): string[] {
  const violations: string[] = [];
  for (const channel of channels) {
    const max = corpusMax[channel.id];
    if (max === undefined) continue;
    if (channel.maxInlineBytes !== capForCorpusMax(max)) violations.push(channel.id);
  }
  return violations;
}

describe("each declared cap equals capForCorpusMax of its own corpus maximum, two-directionally (sc-3-4)", () => {
  it("the real committed artifact has zero cap violations", () => {
    const max = maxBytesPerChannel(corpus);
    expect(capViolations(declaredChannels, max)).toEqual([]);
  });

  it("FAILS when `spec`'s cap is LOWERED below its corpus maximum, on a CLONED channel array", () => {
    const max = maxBytesPerChannel(corpus);
    const specMax = max.spec;
    expect(specMax, "no corpus entry for channel \"spec\"").toBeDefined();

    const lowered = declaredChannels.map((channel) =>
      channel.id === "spec" ? { ...channel, maxInlineBytes: (specMax as number) - 1 } : channel,
    );
    expect(capViolations(lowered, max)).toContain("spec");
  });

  it("FAILS when `spec`'s cap is RAISED with no corpus payload justifying it, on a CLONED channel array", () => {
    const max = maxBytesPerChannel(corpus);
    // capForCorpusMax(spec's corpus max) is 131_072 today (see docs/pge-graph.md's
    // changelog); one bucket further up is 262_144. Nothing in the committed corpus grew
    // to justify that, so the equality pin must reject it regardless of the exact numbers.
    const inflated = declaredChannels.map((channel) =>
      channel.id === "spec" ? { ...channel, maxInlineBytes: capForCorpusMax(max.spec as number) * 2 } : channel,
    );
    expect(capViolations(inflated, max)).toContain("spec");
  });

  it("FAILS when `sprintContracts`'s cap is LOWERED below its corpus maximum, on a CLONED channel array", () => {
    const max = maxBytesPerChannel(corpus);
    const contractsMax = max.sprintContracts;
    expect(contractsMax, "no corpus entry for channel \"sprintContracts\"").toBeDefined();

    const lowered = declaredChannels.map((channel) =>
      channel.id === "sprintContracts" ? { ...channel, maxInlineBytes: (contractsMax as number) - 1 } : channel,
    );
    expect(capViolations(lowered, max)).toContain("sprintContracts");
  });

  it("FAILS when `sprintContracts`'s cap is RAISED with no corpus payload justifying it, on a CLONED channel array", () => {
    const max = maxBytesPerChannel(corpus);
    const inflated = declaredChannels.map((channel) =>
      channel.id === "sprintContracts"
        ? { ...channel, maxInlineBytes: capForCorpusMax(max.sprintContracts as number) * 2 }
        : channel,
    );
    expect(capViolations(inflated, max)).toContain("sprintContracts");
  });
});

// ── sc-3-5: StateBloatError still bites, re-sized rather than removed ─────────────

describe("StateBloatError still bites at the new, corpus-derived cap (sc-3-5)", () => {
  it(
    "rejects a write above the SHIPPED spec cap (read off the committed artifact, never a literal) and drops it",
    async () => {
      const channel = "spec";
      const shippedCap = declaredChannels.find((decl) => decl.id === channel)?.maxInlineBytes;
      expect(shippedCap, `no declared cap for channel "${channel}" in the committed artifact`).toBeDefined();

      // A fixture graph (its own channel set matches the shipped one) with its `spec` cap
      // overridden to the SHIPPED cap — a COPY, the committed topology is never mutated —
      // exactly the shape sc-2-2's negative control above uses for `messages`.
      const base = goldenSpec();
      const mutated: TopologySpec = {
        ...base,
        channels: base.channels.map((decl) =>
          decl.id === channel ? { ...decl, maxInlineBytes: shippedCap as number } : decl,
        ),
      };
      const graph = compile(mutated, goldenRegistries({ contracts: goldenContracts(1) }));

      // A payload sized well above the shipped cap, derived from the cap itself rather than
      // a hardcoded byte count — this control survives any future corpus-driven cap change.
      const over = { probe: "x".repeat((shippedCap as number) + 1024) };
      expect(byteSize(over)).toBeGreaterThan(shippedCap as number);

      const root = await mkdtemp(join(tmpdir(), "workload-statebloat-"));
      try {
        const boundary = createCommitBoundary({ clock: createFixedClock("2026-08-12T00:00:00.000Z") });
        const update: ChannelUpdate = { channel, nodeId: "workload-cap-probe", branchKey: null, value: over };
        const result = await boundary.commit(graph, goldenInitialState("run-workload-statebloat", root), [update], {
          runId: "run-workload-statebloat",
          projectRoot: root,
          config: createDefaultConfig("workload-statebloat", "brownfield"),
          superstep: 0,
          startedAtMs: 0,
        });

        expect(result.rejected).toHaveLength(1);
        expect(result.rejected[0].channel).toBe(channel);
        // The check re-sized to the new cap, not to a stale one and not removed.
        expect(result.rejected[0].limit).toBe(shippedCap);
        expect(result.rejected[0].bytes).toBeGreaterThan(shippedCap as number);
        // The write was NOT applied: a rejected update does not reach the reducer.
        expect(result.writesPerChannel[channel]).toBeUndefined();
        expect(result.state.spec).toBeNull();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
