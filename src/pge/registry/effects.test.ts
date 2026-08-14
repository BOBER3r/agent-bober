import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { EXIT_OK, runPgeDump } from "../../cli/commands/pge.js";
import type { PgeIo } from "../../cli/commands/pge.js";
import type { BoberConfig } from "../../config/schema.js";
import type { EffectTag } from "../../contracts/topology.js";
import {
  DuplicateEffectError,
  EffectChannelClosed,
  EffectNotDeclaredError,
  EffectNotRegisteredError,
  createEffectRegistry,
} from "./effects.js";
import type { EffectDef } from "./effects.js";
import type {
  ArchiveHandle,
  BudgetLedger,
  Clock,
  ModelBinder,
  NodeContext,
  PromptStore,
  ScratchStore,
  SemanticCache,
  TraceWriter,
} from "./nodes.js";

/**
 * sc-5-10 — the effect channel.
 *
 * Two guarantees are asserted here, and both are about what did NOT happen:
 *
 *  1. an effect whose tags exceed the calling node's declared `effects` is refused, and
 *  2. after `seal()` — which `bober pge dump` calls — an invocation throws BEFORE the
 *     effect runs.
 *
 * The fixture effect writes a real file into a temp directory, so "it threw" and "it
 * did not happen" are separate, separately-checked facts. A test that only asserted the
 * throw would pass for a registry that performed the effect and then complained.
 */

// ── A node context that is real enough to refuse things ─────────────

const unusable = (what: string): never => {
  throw new Error(`${what} must not be touched by an effect-registry test`);
};

function stubContext(overrides: Partial<NodeContext> = {}): NodeContext {
  const clock: Clock = {
    now: () => new Date("2026-08-05T00:00:00.000Z"),
    nowMs: () => Date.parse("2026-08-05T00:00:00.000Z"),
    nowIso: () => "2026-08-05T00:00:00.000Z",
  };
  const scratch: ScratchStore = {
    put: async () => unusable("ScratchStore.put"),
    get: async () => unusable("ScratchStore.get"),
    text: async () => unusable("ScratchStore.text"),
  };
  const archive: ArchiveHandle = {
    dir: "/dev/null",
    writeSnapshot: async () => unusable("ArchiveHandle.writeSnapshot"),
    appendStdout: async () => unusable("ArchiveHandle.appendStdout"),
    writeOutputs: async () => unusable("ArchiveHandle.writeOutputs"),
    seal: async () => unusable("ArchiveHandle.seal"),
  };
  const cache: SemanticCache = {
    key: () => unusable("SemanticCache.key"),
    get: async () => unusable("SemanticCache.get"),
    put: async () => unusable("SemanticCache.put"),
  };
  const trace: TraceWriter = {
    begin: () => unusable("TraceWriter.begin"),
    path: () => "/dev/null",
  };
  const ledger: BudgetLedger = {
    charge: () => unusable("BudgetLedger.charge"),
    totals: () => unusable("BudgetLedger.totals"),
    perNode: () => unusable("BudgetLedger.perNode"),
  };
  const prompts: PromptStore = {
    has: () => false,
    get: async () => unusable("PromptStore.get"),
  };
  const models: ModelBinder = {
    bind: (tier) => ({ tier, provider: "anthropic", modelId: "claude-haiku-4-5" }),
    profile: () => ({
      light: { provider: "anthropic", modelId: "claude-haiku-4-5" },
      frontier: { provider: "anthropic", modelId: "claude-opus-5" },
    }),
  };

  return {
    runId: "run-1",
    projectRoot: "/tmp/project",
    config: {} as BoberConfig,
    nodeId: "collect",
    branchKey: null,
    superstep: 0,
    spanId: "span-1",
    priv: new Map<string, unknown>(),
    declaredEffects: ["fs-write"] satisfies EffectTag[],
    clock,
    signal: new AbortController().signal,
    effects: createEffectRegistry(),
    scratch,
    archive,
    cache,
    trace,
    ledger,
    prompts,
    models,
    ...overrides,
  };
}

// ── A fixture effect that really writes a file ──────────────────────

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bober-pge-effects-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface WriteRequest {
  name: string;
  body: string;
}

function writeFileEffect(tags: readonly EffectTag[] = ["fs-write"]): EffectDef<
  WriteRequest,
  { bytes: number }
> {
  return {
    name: "fs.writeFile",
    requestSchema: z.object({ name: z.string().min(1), body: z.string() }),
    responseSchema: z.object({ bytes: z.number().int().min(0) }),
    effects: tags,
    run: async (req) => {
      await writeFile(join(dir, req.name), req.body, "utf8");
      return { bytes: req.body.length };
    },
  };
}

async function filesWritten(): Promise<string[]> {
  return (await readdir(dir)).sort();
}

// ── Registration and invocation ─────────────────────────────────────

describe("EffectRegistry", () => {
  it("performs a declared effect and validates both directions with Zod", async () => {
    const registry = createEffectRegistry();
    registry.register(writeFileEffect());

    const result = await registry.invoke(
      "fs.writeFile",
      { name: "note.txt", body: "hello" },
      stubContext(),
    );

    expect(result).toEqual({ bytes: 5 });
    expect(await filesWritten()).toEqual(["note.txt"]);
  });

  it("lists registered effects with their required tags, sorted by name", () => {
    const registry = createEffectRegistry();
    registry.register(writeFileEffect());
    registry.register({ ...writeFileEffect(["git"]), name: "git.commit" });
    expect(registry.list()).toEqual([
      { name: "fs.writeFile", effects: ["fs-write"] },
      { name: "git.commit", effects: ["git"] },
    ]);
  });

  it("rejects a request that does not match the effect's schema, naming the field", async () => {
    const registry = createEffectRegistry();
    registry.register(writeFileEffect());

    await expect(
      registry.invoke("fs.writeFile", { name: "", body: "hello" }, stubContext()),
    ).rejects.toBeInstanceOf(z.ZodError);
    expect(await filesWritten()).toEqual([]);

    try {
      await registry.invoke("fs.writeFile", { body: 7 }, stubContext());
      throw new Error("unreachable");
    } catch (error) {
      expect(error).toBeInstanceOf(z.ZodError);
      const paths = (error as z.ZodError).issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("name");
      expect(paths).toContain("body");
    }
  });

  it("rejects a response that does not match the effect's schema", async () => {
    const registry = createEffectRegistry();
    registry.register({
      ...writeFileEffect(),
      run: async () => ({ bytes: "lots" }) as unknown as { bytes: number },
    });
    await expect(
      registry.invoke("fs.writeFile", { name: "a.txt", body: "x" }, stubContext()),
    ).rejects.toBeInstanceOf(z.ZodError);
  });

  it("throws EffectNotRegisteredError for an unknown name", async () => {
    const registry = createEffectRegistry();
    await expect(registry.invoke("fs.writeFile", {}, stubContext())).rejects.toBeInstanceOf(
      EffectNotRegisteredError,
    );
  });

  it("misses on inherited Object.prototype members rather than resolving them", async () => {
    const registry = createEffectRegistry();
    registry.register(writeFileEffect());
    for (const inherited of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      await expect(
        registry.invoke(inherited, {}, stubContext()),
        inherited,
      ).rejects.toBeInstanceOf(EffectNotRegisteredError);
    }
  });

  it("refuses a duplicate effect name", () => {
    const registry = createEffectRegistry();
    registry.register(writeFileEffect());
    expect(() => registry.register(writeFileEffect())).toThrow(DuplicateEffectError);
  });
});

// ── Declared-effect enforcement ─────────────────────────────────────

describe("EffectNotDeclaredError", () => {
  it("refuses an effect whose tags exceed the calling node's declared effects", async () => {
    const registry = createEffectRegistry();
    registry.register(writeFileEffect(["git"]));

    const ctx = stubContext({ nodeId: "research_collect", declaredEffects: ["fs-write"] });

    try {
      await registry.invoke("fs.writeFile", { name: "a.txt", body: "x" }, ctx);
      throw new Error("unreachable");
    } catch (error) {
      expect(error).toBeInstanceOf(EffectNotDeclaredError);
      const notDeclared = error as EffectNotDeclaredError;
      expect(notDeclared.nodeId).toBe("research_collect");
      expect(notDeclared.effect).toBe("git");
      expect(notDeclared.effectName).toBe("fs.writeFile");
      expect(notDeclared.message).toContain("research_collect");
      expect(notDeclared.message).toContain("git");
    }

    // The refusal happens BEFORE the effect body runs.
    expect(await filesWritten()).toEqual([]);
  });

  it("refuses when only ONE of several required tags is undeclared", async () => {
    const registry = createEffectRegistry();
    registry.register(writeFileEffect(["fs-write", "process-exec"]));
    const ctx = stubContext({ declaredEffects: ["fs-write"] });

    await expect(
      registry.invoke("fs.writeFile", { name: "a.txt", body: "x" }, ctx),
    ).rejects.toBeInstanceOf(EffectNotDeclaredError);
    expect(await filesWritten()).toEqual([]);
  });

  it("allows an effect whose tags are a subset of the node's declared effects", async () => {
    const registry = createEffectRegistry();
    registry.register(writeFileEffect(["fs-write"]));
    const ctx = stubContext({ declaredEffects: ["fs-write", "git"] });
    await expect(
      registry.invoke("fs.writeFile", { name: "a.txt", body: "x" }, ctx),
    ).resolves.toEqual({ bytes: 1 });
    expect(await filesWritten()).toEqual(["a.txt"]);
  });

  it("refuses every effect for a node that declares none", async () => {
    const registry = createEffectRegistry();
    registry.register(writeFileEffect(["fs-write"]));
    await expect(
      registry.invoke("fs.writeFile", { name: "a.txt", body: "x" }, stubContext({ declaredEffects: [] })),
    ).rejects.toBeInstanceOf(EffectNotDeclaredError);
    expect(await filesWritten()).toEqual([]);
  });
});

// ── seal() ──────────────────────────────────────────────────────────

describe("EffectRegistry.seal", () => {
  it("closes the channel: invoke throws and the effect does not happen", async () => {
    const registry = createEffectRegistry();
    registry.register(writeFileEffect());
    expect(registry.sealed()).toBe(false);

    registry.seal();
    expect(registry.sealed()).toBe(true);

    try {
      await registry.invoke("fs.writeFile", { name: "a.txt", body: "x" }, stubContext());
      throw new Error("unreachable");
    } catch (error) {
      expect(error).toBeInstanceOf(EffectChannelClosed);
      expect((error as EffectChannelClosed).effectName).toBe("fs.writeFile");
    }

    expect(await filesWritten()).toEqual([]);
  });

  it("throws before request validation, so a sealed channel refuses even a valid request", async () => {
    const registry = createEffectRegistry();
    registry.register(writeFileEffect());
    registry.seal();
    // An INVALID request would throw ZodError on an open channel. On a sealed one the
    // closure is reported first, which is how we know nothing downstream of the seal ran.
    await expect(registry.invoke("fs.writeFile", { name: "" }, stubContext())).rejects.toBeInstanceOf(
      EffectChannelClosed,
    );
  });

  it("refuses registration after sealing", () => {
    const registry = createEffectRegistry();
    registry.seal();
    expect(() => registry.register(writeFileEffect())).toThrow(EffectChannelClosed);
    expect(registry.list()).toEqual([]);
  });

  it("is idempotent", async () => {
    const registry = createEffectRegistry();
    registry.register(writeFileEffect());
    registry.seal();
    registry.seal();
    expect(registry.sealed()).toBe(true);
    await expect(
      registry.invoke("fs.writeFile", { name: "a.txt", body: "x" }, stubContext()),
    ).rejects.toBeInstanceOf(EffectChannelClosed);
  });

  it("seals one registry without sealing another", async () => {
    const sealed = createEffectRegistry();
    const open = createEffectRegistry();
    sealed.register(writeFileEffect());
    open.register(writeFileEffect());
    sealed.seal();

    await expect(
      sealed.invoke("fs.writeFile", { name: "a.txt", body: "x" }, stubContext()),
    ).rejects.toBeInstanceOf(EffectChannelClosed);
    await expect(
      open.invoke("fs.writeFile", { name: "b.txt", body: "x" }, stubContext()),
    ).resolves.toEqual({ bytes: 1 });
    expect(await filesWritten()).toEqual(["b.txt"]);
  });
});

// ── sc-5-10: `bober pge dump` seals the channel ─────────────────────

describe("bober pge dump seals the effect channel", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bober-pge-dump-seal-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("refuses an effect attempted DURING the dump, and the effect does not happen", async () => {
    const registry = createEffectRegistry();
    registry.register(writeFileEffect());

    const attempts: unknown[] = [];
    const duringDump: Array<Promise<void>> = [];

    // The IO seam runs INSIDE `runPgeDump`, so an effect attempted from here is an
    // effect attempted during topology production — the case `seal()` exists for.
    const io: PgeIo = {
      out: () => {
        duringDump.push(
          registry
            .invoke("fs.writeFile", { name: "during-dump.txt", body: "boom" }, stubContext())
            .then(
              (value) => {
                attempts.push({ ok: value });
              },
              (error: unknown) => {
                attempts.push(error);
              },
            ),
        );
      },
      err: () => {},
    };

    const exit = await runPgeDump(root, {}, io, registry);
    await Promise.all(duringDump);

    expect(exit).toBe(EXIT_OK);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toBeInstanceOf(EffectChannelClosed);
    expect(registry.sealed()).toBe(true);
    // The point of the whole test: the effect did not merely fail late, it never ran.
    expect(await filesWritten()).toEqual([]);
  });

  it("leaves the channel sealed after the dump returns", async () => {
    const registry = createEffectRegistry();
    registry.register(writeFileEffect());
    const io: PgeIo = { out: () => {}, err: () => {} };

    await runPgeDump(root, {}, io, registry);

    await expect(
      registry.invoke("fs.writeFile", { name: "after.txt", body: "x" }, stubContext()),
    ).rejects.toBeInstanceOf(EffectChannelClosed);
    expect(await filesWritten()).toEqual([]);
  });

  it("still writes the topology artifact — sealing effects does not disable the verb", async () => {
    const io: PgeIo = { out: () => {}, err: () => {} };
    const exit = await runPgeDump(root, {}, io);
    expect(exit).toBe(EXIT_OK);
    expect(await readdir(join(root, ".bober", "topology"))).toContain("coding.json");
  });
});
