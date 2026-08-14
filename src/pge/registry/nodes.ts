import type { z } from "zod";

import type { BoberConfig } from "../../config/schema.js";
import type { EffectTag, ModelTier, NodeKind } from "../../contracts/topology.js";
import type { Phase } from "../../state/history.js";
import type { OverallState, ScratchRef } from "../state/overall.js";
import type { EffectRegistry } from "./effects.js";

/**
 * The node registry and the context a node body runs in.
 *
 * ── What this module is allowed to depend on ──
 *
 * Types only. Every collaborator a node reaches for — scratch, archive, cache, trace,
 * ledger, prompts, models — is declared here as an INTERFACE and implemented in a later
 * sprint. That keeps the node-facing surface loadable without dragging a filesystem
 * store, a provider adapter or a process spawner into the import graph of anything that
 * merely wants to know what a node looks like (the `bober pge` command path, for one).
 *
 * ── The three-scope rule, restated where it is enforced ──
 *
 * {@link NodeContext.priv} is PRIVATE state: a fresh `Map` per task, dropped when the
 * handler returns. It is not a channel, it is not part of {@link OverallState}, and no
 * commit path can read it — a node that stashes a 5 MB diff there is inconvenient to
 * itself and invisible to everyone else, which is the intended asymmetry. Anything a
 * node wants to survive the superstep goes through `Command.update` into a declared
 * channel, or into the scratch store with a {@link ScratchRef} in `refs`.
 */

// ── Ambient collaborators ───────────────────────────────────────────

/**
 * The single time source a node may consult.
 *
 * Nodes do not call `new Date()`: the commit boundary is the only clock in the runtime,
 * so a replayed superstep can be given the recorded clock and produce the recorded
 * artifact.
 */
export interface Clock {
  now(): Date;
  nowMs(): number;
  nowIso(): string;
}

/** Content-addressed store for payloads too large to sit in a channel. */
export interface ScratchStore {
  put(runId: string, kind: ScratchRef["kind"], data: string | Uint8Array): Promise<ScratchRef>;
  get(ref: ScratchRef): Promise<Uint8Array>;
  text(ref: ScratchRef): Promise<string>;
}

/** A per-node archive directory that becomes immutable once sealed. */
export interface ArchiveHandle {
  readonly dir: string;
  writeSnapshot(value: unknown): Promise<void>;
  appendStdout(chunk: string): Promise<void>;
  writeOutputs(value: unknown): Promise<void>;
  seal(): Promise<void>;
}

export interface CacheKeyParts {
  systemPrompt: string;
  userPrompt: string;
  contextFilesHash: string;
  model: string;
  temperature: number;
  toolsMask: string;
}

export interface CacheEntry {
  value: unknown;
  storedAt: number;
  expiresAt: number;
}

/** Cache for EFFECT-FREE inference only — `CacheOnEffectfulNode` rejects the rest. */
export interface SemanticCache {
  key(parts: CacheKeyParts): string;
  get(key: string, now: number): Promise<CacheEntry | undefined>;
  put(key: string, value: unknown, ttlSeconds: number, now: number, parts: CacheKeyParts): Promise<void>;
}

/** One open span. Closing it writes a line to the run's JSONL trace. */
export interface SpanHandle {
  readonly spanId: string;
  end(outcome: { status: "ok" | "failed" | "interrupted" | "skipped"; errorClass?: string }): void;
}

export interface TraceWriter {
  begin(span: { nodeId: string; kind: NodeKind; phase: Phase; branchKey: string | null }): SpanHandle;
  path(): string;
}

export interface NodeUsage {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

/**
 * Per-call cost accounting.
 *
 * `charge` REPLACES the entry under `(nodeId, attempt, callIndex)` — see `mergeLedger`
 * — so a resumed run cannot bill the same call twice.
 */
export interface BudgetLedger {
  charge(key: { nodeId: string; attempt: number; callIndex: number }, usage: NodeUsage): void;
  totals(): NodeUsage;
  perNode(): Record<string, NodeUsage>;
}

/** Resolves a node's `promptRef` to prompt text. */
export interface PromptStore {
  has(ref: string): boolean;
  get(ref: string): Promise<string>;
}

// ── ModelBinder ─────────────────────────────────────────────────────

/** A concrete provider and model id, bound from a declared tier. */
export interface ModelBinding {
  readonly tier: ModelTier;
  readonly provider: string;
  readonly modelId: string;
  readonly endpoint?: string;
}

/** The two bindings a graph needs: one per declared tier. */
export interface ModelProfile {
  readonly light: Omit<ModelBinding, "tier">;
  readonly frontier: Omit<ModelBinding, "tier">;
}

/**
 * Resolves the `modelTier` a node declares to a concrete provider and model id.
 *
 * The indirection is the point: a topology names a TIER, never a model, so swapping
 * model profiles is a binder concern and cannot move the topology checksum. The binder
 * is handed a resolved {@link ModelProfile} rather than reaching into config itself, so
 * this module stays free of the provider layer.
 */
export interface ModelBinder {
  bind(tier: ModelTier): ModelBinding;
  profile(): ModelProfile;
}

/** A pure binder over an already-resolved profile. */
export function createModelBinder(profile: ModelProfile): ModelBinder {
  const frozen: ModelProfile = {
    light: { ...profile.light },
    frontier: { ...profile.frontier },
  };
  return {
    bind: (tier) => ({ tier, ...frozen[tier] }),
    profile: () => frozen,
  };
}

// ── NodeContext ─────────────────────────────────────────────────────

/**
 * Everything a node body is given, and nothing more.
 *
 * `declaredEffects` is the node's `effects` array copied off the topology artifact. The
 * effect registry compares an effect's own tags against it, so a node that did not
 * declare `git` cannot perform a git effect however it obtains the registry — the
 * declaration in the committed artifact is what authorises the call.
 */
export interface NodeContext {
  readonly runId: string;
  readonly projectRoot: string;
  readonly config: BoberConfig;
  readonly nodeId: string;
  readonly branchKey: string | null;
  readonly superstep: number;
  readonly spanId: string;
  /** Node-local scratch. Never a channel; dropped when the handler returns. */
  readonly priv: Map<string, unknown>;
  readonly declaredEffects: readonly EffectTag[];
  readonly clock: Clock;
  readonly signal: AbortSignal;
  readonly effects: EffectRegistry;
  readonly scratch: ScratchStore;
  readonly archive: ArchiveHandle;
  readonly cache: SemanticCache;
  readonly trace: TraceWriter;
  readonly ledger: BudgetLedger;
  readonly prompts: PromptStore;
  readonly models: ModelBinder;
}

// ── Node implementations ────────────────────────────────────────────

/**
 * Where control goes next.
 *
 * `label` is a ROUTER OUTCOME LABEL, not a node id (ADR-3): a router body selects a
 * label and the artifact says where that label leads, which is what makes a structural
 * diff of routing meaningful.
 */
export interface Goto {
  kind: "label" | "node" | "fanout" | "parent";
  label?: string;
  node?: string;
  sends?: Array<{ branchKey: string; input: unknown }>;
}

/** A node's return value: channel updates, where to go, and an optional phase change. */
export interface Command<U> {
  update?: U;
  goto: Goto;
  phase?: Phase;
}

export type NodeHandler<I, O> = (
  input: I,
  state: Readonly<OverallState>,
  ctx: NodeContext,
) => Promise<Command<Partial<OverallState>> & { output: O }>;

/**
 * A port this implementation binds, named by the key the node declares in the artifact.
 *
 * Both halves are needed. The KEY is what `compile()` looks up in `inputPorts[]` /
 * `outputPorts[]`, and the `schemaRef` is what it compares against the declared one —
 * a binding that names the right key with the wrong schema is exactly the drift the
 * stringly-typed registry indirection risks, and it fails compilation.
 */
export interface PortBinding {
  readonly key: string;
  readonly schemaRef: string;
}

/**
 * An executable node body plus the declarations that let the compiler prove it matches
 * the artifact.
 *
 * `inputPort`/`outputPort` are `null` for a node that declares no port on that side
 * (a router with no outputs, the entry call site with no inputs). `compile()` treats
 * `null`-against-declared and bound-against-undeclared as the same class of error, so
 * neither direction can drift silently.
 *
 * AT MOST ONE PORT PER SIDE, deliberately: {@link NodeHandler} takes exactly one input
 * value and returns exactly one output value, so a second bound port would have nowhere
 * to go. The artifact schema is wider (`inputPorts`/`outputPorts` are arrays), and
 * `compile()` REFUSES a node that declares more than one port on a side rather than
 * leaving the extra declaration unchecked — see `checkPortSide`.
 *
 * `inputSchema`/`outputSchema` are the schemas the handler's own payloads are parsed
 * with, and they are not free-standing: when `Registries.schemaModules` is supplied,
 * `compile()` asserts that `inputSchema` IS the schema `inputPort.schemaRef` resolves to
 * (reference identity), and likewise for the output side. Without that assertion the
 * `schemaRef` on a {@link PortBinding} is only a string the implementation writes about
 * itself.
 */
export interface NodeImpl<I = unknown, O = unknown> {
  readonly id: string;
  readonly kind: NodeKind;
  readonly inputPort: PortBinding | null;
  readonly outputPort: PortBinding | null;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly handler: NodeHandler<I, O>;
}

export interface NodeRegistry {
  register<I, O>(impl: NodeImpl<I, O>): void;
  get(id: string): NodeImpl | undefined;
  ids(): string[];
}

/** Two implementations claiming the same node id. Always a wiring bug, never intended. */
export class DuplicateNodeImplError extends Error {
  readonly nodeId: string;

  constructor(nodeId: string) {
    super(`Node implementation "${nodeId}" is already registered.`);
    this.name = "DuplicateNodeImplError";
    this.nodeId = nodeId;
  }
}

/**
 * A fresh registry.
 *
 * Per-call rather than module-level: a worktree run substitutes `projectRoot`, and a
 * shared mutable registry is how one run's fixtures leak into another's.
 *
 * The backing store is a `Map`, so `get("constructor")` misses instead of resolving
 * through `Object.prototype` to a truthy value that is not a node implementation.
 */
export function createNodeRegistry(): NodeRegistry {
  const impls = new Map<string, NodeImpl>();
  return {
    register<I, O>(impl: NodeImpl<I, O>): void {
      if (impls.has(impl.id)) throw new DuplicateNodeImplError(impl.id);
      // One cast, at the single point where a heterogeneous table is built: the
      // registry is keyed by id and cannot know each entry's I/O statically. Every
      // read path re-establishes the types through the declared port schemas.
      impls.set(impl.id, impl as unknown as NodeImpl);
    },
    get: (id) => impls.get(id),
    ids: () => [...impls.keys()].sort(),
  };
}
