// ── history-redaction.test.ts ────────────────────────────────────────
//
// `appendHistory` is the ONE programmatic writer of `.bober/history.jsonl`
// (history-rotation.ts only MOVES lines it never authors), and both engines
// reach it — the graph engine via `emitPhaseEvent` -> `appendHistory`. These
// tests pin what it is allowed to persist.
//
// The repo-level invariant (the file is untracked and ignored) lives in
// repo-invariants.test.ts. This file pins the behaviour that protects the
// DOWNSTREAM projects the published CLI runs in, where the same log may be
// committed to a remote we do not control.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CREDENTIAL_PLACEHOLDER,
  HOME_PLACEHOLDER,
  MAX_HISTORY_STRING_LENGTH,
  appendHistory,
  redactHistoryEntry,
  redactHistoryString,
  scrubSensitive,
  updateProgress,
} from "./history.js";
import type { HistoryEntry } from "./history.js";
import type { PlanSpec } from "../contracts/spec.js";
import type { SprintContract } from "../contracts/sprint-contract.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-history-redaction-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function entry(details: Record<string, unknown>): HistoryEntry {
  return {
    timestamp: "2026-08-14T00:00:00.000Z",
    event: "pipeline-started",
    phase: "init",
    details,
  };
}

// ── Bounding ─────────────────────────────────────────────────────────

describe("redactHistoryString — bounding", () => {
  it("leaves a string within the cap byte-identical", () => {
    const short = "Implement sprint 4: close the history channel";
    expect(redactHistoryString(short)).toBe(short);
  });

  it("caps an over-long string and records the dropped length and a digest", () => {
    const long = "a".repeat(500);
    const out = redactHistoryString(long);

    expect(out.startsWith("a".repeat(MAX_HISTORY_STRING_LENGTH))).toBe(true);
    expect(out).not.toContain("a".repeat(MAX_HISTORY_STRING_LENGTH + 1));
    expect(out).toMatch(/\[\+300 chars, sha256:[0-9a-f]{12}\]$/);
  });

  it("is deterministic — the same input always yields the same digest", () => {
    const long = "prompt body ".repeat(60);
    expect(redactHistoryString(long)).toBe(redactHistoryString(long));
  });

  it("gives different payloads different digests", () => {
    const a = redactHistoryString("x".repeat(400));
    const b = redactHistoryString("y".repeat(400));
    expect(a).not.toBe(b);
  });
});

// ── Scrubbing ────────────────────────────────────────────────────────

describe("redactHistoryString — scrubbing", () => {
  const secrets: ReadonlyArray<readonly [string, string]> = [
    ["anthropic/openai key", "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA"],
    ["github token", "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
    ["slack token", "xoxb-1234567890-abcdefghij"],
    ["aws access key id", "AKIAIOSFODNN7EXAMPLE"],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r"],
    ["bearer header", "Bearer abcdefghijklmnopqrstuvwxyz012345"],
  ];

  for (const [label, secret] of secrets) {
    it(`removes a ${label}`, () => {
      const out = redactHistoryString(`failed calling the API with ${secret} at boot`);
      expect(out).not.toContain(secret);
      expect(out).toContain(CREDENTIAL_PLACEHOLDER);
    });
  }

  it("removes an email address", () => {
    const out = redactHistoryString("escalated to oleksiiatanasov@gmail.com for review");
    expect(out).not.toContain("@gmail.com");
    expect(out).toContain(CREDENTIAL_PLACEHOLDER);
  });

  it("removes the username from a POSIX home path", () => {
    const out = redactHistoryString("wrote /Users/bober4ik/agent-bober/docs/x.md");
    expect(out).not.toContain("bober4ik");
    expect(out).toBe(`wrote ${HOME_PLACEHOLDER}/agent-bober/docs/x.md`);
  });

  it("removes the username from a Windows home path", () => {
    const out = redactHistoryString("wrote C:\\Users\\someone\\repo\\x.md");
    expect(out).not.toContain("someone");
    expect(out).toContain(HOME_PLACEHOLDER);
  });

  it("scrubs BEFORE truncating, so a secret straddling the cap cannot survive as a prefix", () => {
    // Place the secret so that a truncate-first implementation would keep its head.
    const secret = "ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const out = redactHistoryString("p".repeat(MAX_HISTORY_STRING_LENGTH - 10) + secret + "tail");
    expect(out).not.toContain("ghp_");
    expect(out).toContain(CREDENTIAL_PLACEHOLDER);
  });

  it("leaves ordinary engineering prose untouched", () => {
    // The log exists to be read; an over-eager pattern would gut the audit notes.
    const prose = "Clean. No absolute paths, prompt bodies or credentials in the artifact.";
    expect(redactHistoryString(prose)).toBe(prose);
  });

  it("does not mistake a hyphenated word containing 'sk-' for a key", () => {
    // Regression guard for the bare-`sk-` rule: without its lookbehind this
    // scrubs to "ri[redacted]", gutting exactly the prose this log is for.
    const prose = "risk-mitigation-strategy-alpha was chosen over disk-backed-checkpointing";
    expect(redactHistoryString(prose)).toBe(prose);
  });

  it("matches a vendor key flush against a preceding word character", () => {
    // The `\b`-anchored first draft missed this: no word boundary exists between
    // a word char and the prefix, so the token survived into the persisted line.
    const out = redactHistoryString(`token${"ghp_" + "D".repeat(36)}`);
    expect(out).not.toContain("ghp_");
  });

  it("documents the accepted residual: a BARE sk- key flush against a word char", () => {
    // Kept deliberately — closing it means dropping the lookbehind that protects
    // "risk-mitigation-strategy". The compound-prefix rule covers the real vendor
    // formats, so this pins the gap rather than pretending it is closed.
    const bare = `x${"sk-" + "E".repeat(20)}`;
    expect(redactHistoryString(bare)).toContain("sk-");

    // ...while the compound vendor form IS caught in the same position.
    const compound = `x${"sk-ant-api03-" + "E".repeat(20)}`;
    expect(redactHistoryString(compound)).not.toContain("sk-ant-");
  });
});

// ── Entry-level walk ─────────────────────────────────────────────────

describe("redactHistoryEntry", () => {
  it("reaches strings nested in objects and arrays", () => {
    const out = redactHistoryEntry(
      entry({ nested: { deep: ["/Users/bober4ik/x", "ok"] }, flat: "/home/someone/y" }),
    );
    const nested = (out.details.nested as { deep: string[] }).deep;
    expect(nested[0]).toBe(`${HOME_PLACEHOLDER}/x`);
    expect(nested[1]).toBe("ok");
    expect(out.details.flat).toBe(`${HOME_PLACEHOLDER}/y`);
  });

  it("leaves non-string values alone", () => {
    const out = redactHistoryEntry(entry({ count: 42, ok: true, missing: null }));
    expect(out.details).toEqual({ count: 42, ok: true, missing: null });
  });

  it("leaves the identity fields untouched", () => {
    // conformance.ts keys history divergences off `event`; rewriting it would
    // move a comparison channel rather than protect anything.
    const original: HistoryEntry = {
      timestamp: "2026-08-14T00:00:00.000Z",
      event: "sprint-completed",
      phase: "complete",
      sprintId: "sprint-4",
      details: {},
    };
    const out = redactHistoryEntry(original);
    expect(out.event).toBe("sprint-completed");
    expect(out.phase).toBe("complete");
    expect(out.sprintId).toBe("sprint-4");
    expect(out.timestamp).toBe(original.timestamp);
  });
});

// ── The persisted line ───────────────────────────────────────────────

describe("appendHistory persists only redacted content", () => {
  async function persistedLine(): Promise<string> {
    return await readFile(join(root, ".bober", "history.jsonl"), "utf-8");
  }

  it("never writes an unbounded prompt body to disk", async () => {
    const prompt = "Build me a thing that ".repeat(40); // ~880 chars
    await appendHistory(root, entry({ userPrompt: prompt }));

    const line = await persistedLine();
    expect(line).not.toContain(prompt);
    expect(line).toContain("sha256:");
    expect(JSON.parse(line).details.userPrompt.length).toBeLessThan(prompt.length);
  });

  it("never writes a credential to disk", async () => {
    await appendHistory(root, entry({ feedback: "used ghp_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" }));
    const line = await persistedLine();
    expect(line).not.toContain("ghp_");
    expect(line).toContain(CREDENTIAL_PLACEHOLDER);
  });

  it("still writes a valid, re-readable JSONL line", async () => {
    await appendHistory(root, entry({ userPrompt: "z".repeat(400) }));
    const parsed: unknown = JSON.parse((await persistedLine()).trim());
    expect((parsed as HistoryEntry).event).toBe("pipeline-started");
  });
});

// ── progress.md ──────────────────────────────────────────────────────
//
// `updateProgress` is the other persisted free-text artifact, and it embeds
// three caller-supplied strings: `spec.title`, `spec.description` and every
// `contract.title`. `spec.description` is planner prose derived from the
// operator's feature request — the same provenance as the log's `userPrompt`.
//
// It takes the SCRUB half of the treatment and deliberately not the CAP: the
// file is a human-readable status document, and a 200-char plan summary would
// destroy the artifact in order to protect it.

const NOW = "2026-08-14T00:00:00.000Z";

function specWith(description: string, title = "A Plan"): PlanSpec {
  return {
    specId: "spec-1",
    version: 1,
    title,
    description,
    status: "in-progress",
    mode: "brownfield",
    features: [],
    assumptions: [],
    outOfScope: [],
    clarificationQuestions: [],
    resolvedClarifications: [],
    techStack: ["TypeScript"],
    nonFunctionalRequirements: [],
    constraints: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function contractWith(title: string): SprintContract {
  return {
    contractId: "sprint-1",
    specId: "spec-1",
    sprintNumber: 1,
    title,
    description: "d",
    status: "completed",
    dependsOn: [],
    features: [],
    successCriteria: [],
    nonGoals: [],
    stopConditions: [],
    definitionOfDone: "done",
    assumptions: [],
    outOfScope: [],
    ambiguityScore: 1,
    estimatedFiles: [],
    estimatedDuration: "small",
    iterationHistory: [],
    lastEvalId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("scrubSensitive", () => {
  it("removes secrets without changing anything else", () => {
    expect(scrubSensitive("ran as /Users/bober4ik/repo")).toBe(`ran as ${HOME_PLACEHOLDER}/repo`);
  });

  it("leaves a long string at its original length", () => {
    // The property that distinguishes it from redactHistoryString.
    const long = "plan prose ".repeat(80);
    expect(scrubSensitive(long)).toBe(long);
    expect(scrubSensitive(long).length).toBeGreaterThan(MAX_HISTORY_STRING_LENGTH);
  });
});

describe("updateProgress scrubs the strings it embeds", () => {
  async function progress(): Promise<string> {
    return await readFile(join(root, ".bober", "progress.md"), "utf-8");
  }

  it("removes a home-path username from the plan description", async () => {
    await updateProgress(root, [], specWith("built under /Users/bober4ik/agent-bober today"));
    const text = await progress();
    expect(text).not.toContain("bober4ik");
    expect(text).toContain(HOME_PLACEHOLDER);
  });

  it("removes a credential from the plan description", async () => {
    await updateProgress(root, [], specWith(`deploy key ghp_${"A".repeat(36)} rotated`));
    const text = await progress();
    expect(text).not.toContain("ghp_");
    expect(text).toContain(CREDENTIAL_PLACEHOLDER);
  });

  it("removes a credential from the plan title", async () => {
    await updateProgress(root, [], specWith("body", `Plan ghp_${"B".repeat(36)}`));
    expect(await progress()).not.toContain("ghp_");
  });

  it("removes a home-path username from a sprint title", async () => {
    await updateProgress(root, [contractWith("fix /Users/bober4ik/x.ts")], specWith("body"));
    const text = await progress();
    expect(text).not.toContain("bober4ik");
    expect(text).toContain(HOME_PLACEHOLDER);
  });

  it("does NOT truncate the plan description — the document exists to be read", async () => {
    // Guards the deliberate asymmetry with the history log. If someone "unifies"
    // the two by routing progress.md through redactHistoryString, the plan
    // summary silently becomes a 200-char stub and this fails.
    const long = "This plan covers a great deal of ground. ".repeat(12); // ~480 chars
    await updateProgress(root, [], specWith(long));
    expect(await progress()).toContain(long);
  });
});
