import type { z } from "zod";

import type { EffectTag } from "../../contracts/topology.js";
import type { NodeContext } from "./nodes.js";

/**
 * The single channel through which a node performs a side effect.
 *
 * ── Why every effect goes through one door ──
 *
 * An effect declared on a node in the artifact (`effects: ["git"]`) is what makes
 * `CacheOnEffectfulNode`, `EffectfulNodeContainsHitl` and the git-behind-HITL rule
 * mechanically checkable from the artifact alone. That checkability is worth nothing if
 * a node body can reach the filesystem or a process directly, so the registry is the
 * only sanctioned route and it re-checks the declaration at call time: an effect whose
 * tags exceed the calling node's declared `effects` array is refused with
 * {@link EffectNotDeclaredError}, naming both the node and the offending tag.
 *
 * ── seal() ──
 *
 * `bober pge dump` calls {@link EffectRegistry.seal} before it does anything else. From
 * that moment `invoke` throws {@link EffectChannelClosed} BEFORE resolving the effect,
 * before validating the request and before running anything — so the topology-production
 * path cannot perform an effect even if the ESLint module-graph boundary is later
 * widened. The check is deliberately first: a seal that threw after the effect ran
 * would prove nothing.
 *
 * This module imports types only and has no runtime dependency at all, which is what
 * lets `src/cli/commands/pge.ts` import it without pulling a provider, a store or a
 * process spawner into the topology command path.
 */

// ── Errors ──────────────────────────────────────────────────────────

/**
 * The calling node did not declare the effect it is trying to perform.
 *
 * Carries the node id and the FIRST undeclared tag, so the remedy ("add `git` to
 * `nodes[].effects` for `commit`, or stop doing that") is readable from the message.
 */
export class EffectNotDeclaredError extends Error {
  readonly nodeId: string;
  readonly effect: EffectTag;
  readonly effectName: string;

  constructor(nodeId: string, effectName: string, effect: EffectTag) {
    super(
      `Node "${nodeId}" invoked effect "${effectName}", which requires the "${effect}" tag; the node declares no such effect in the topology artifact.`,
    );
    this.name = "EffectNotDeclaredError";
    this.nodeId = nodeId;
    this.effect = effect;
    this.effectName = effectName;
  }
}

/** The effect channel is closed: `seal()` has been called on this registry. */
export class EffectChannelClosed extends Error {
  readonly effectName: string | null;

  constructor(effectName: string | null) {
    super(
      effectName === null
        ? "The effect channel is sealed; no further effect may be registered."
        : `The effect channel is sealed; effect "${effectName}" was not performed.`,
    );
    this.name = "EffectChannelClosed";
    this.effectName = effectName;
  }
}

/** No effect is registered under that name. */
export class EffectNotRegisteredError extends Error {
  readonly effectName: string;

  constructor(effectName: string) {
    super(`No effect is registered under the name "${effectName}".`);
    this.name = "EffectNotRegisteredError";
    this.effectName = effectName;
  }
}

/** Two definitions claiming the same effect name. */
export class DuplicateEffectError extends Error {
  readonly effectName: string;

  constructor(effectName: string) {
    super(`Effect "${effectName}" is already registered.`);
    this.name = "DuplicateEffectError";
    this.effectName = effectName;
  }
}

// ── Definitions ─────────────────────────────────────────────────────

/**
 * One performable effect.
 *
 * `effects` is the tag set this effect REQUIRES. It is compared against the calling
 * node's declared tags, not against the effect's own name, so renaming an effect cannot
 * quietly widen what a node is allowed to do.
 */
export interface EffectDef<Req, Res> {
  readonly name: string;
  readonly requestSchema: z.ZodType<Req>;
  readonly responseSchema: z.ZodType<Res>;
  readonly effects: readonly EffectTag[];
  run(req: Req, ctx: NodeContext): Promise<Res>;
}

export interface EffectRegistry {
  register<Req, Res>(def: EffectDef<Req, Res>): void;
  invoke(name: string, req: unknown, ctx: NodeContext): Promise<unknown>;
  list(): Array<{ name: string; effects: readonly EffectTag[] }>;
  /** Close the channel. Idempotent. After this, `invoke` and `register` both throw. */
  seal(): void;
  sealed(): boolean;
}

// ── Registry ────────────────────────────────────────────────────────

/**
 * A fresh effect registry.
 *
 * Per-call, never module-level: a sealed process-wide singleton would make every later
 * run in the same process unable to perform an effect, and a shared unsealed one would
 * let a test's fixture effect leak into a real run.
 */
export function createEffectRegistry(): EffectRegistry {
  const defs = new Map<string, EffectDef<unknown, unknown>>();
  let isSealed = false;

  return {
    register<Req, Res>(def: EffectDef<Req, Res>): void {
      if (isSealed) throw new EffectChannelClosed(def.name);
      if (defs.has(def.name)) throw new DuplicateEffectError(def.name);
      defs.set(def.name, def as unknown as EffectDef<unknown, unknown>);
    },

    async invoke(name: string, req: unknown, ctx: NodeContext): Promise<unknown> {
      // FIRST, before resolution, validation or execution. The order is the guarantee.
      if (isSealed) throw new EffectChannelClosed(name);

      const def = defs.get(name);
      if (!def) throw new EffectNotRegisteredError(name);

      const declared = new Set<EffectTag>(ctx.declaredEffects);
      for (const tag of def.effects) {
        if (!declared.has(tag)) throw new EffectNotDeclaredError(ctx.nodeId, name, tag);
      }

      // Zod on the way in and on the way out: an effect is a boundary, and a boundary
      // that trusts its caller is not one.
      const request = def.requestSchema.parse(req);
      const response = await def.run(request, ctx);
      return def.responseSchema.parse(response);
    },

    list: () =>
      [...defs.keys()]
        .sort()
        .map((name) => ({ name, effects: (defs.get(name) as EffectDef<unknown, unknown>).effects })),

    seal: () => {
      isSealed = true;
    },

    sealed: () => isSealed,
  };
}
