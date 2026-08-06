import { Buffer } from "node:buffer";

import { z } from "zod";

import { ScratchRefSchema } from "../state/overall.js";
import type { GraphMessage, ScratchRef } from "../state/overall.js";
import type { NodeContext } from "../registry/nodes.js";

/**
 * The correction payload: what a gate, the evaluator or the router hands the corrector.
 *
 * ── Why the raw bytes are NOT in it ──
 *
 * Every channel in the coding artifact declares `maxInlineBytes: 4096`
 * (`coding.graph.ts:108…185`), and the commit boundary measures EVERY update value
 * individually against it (`runtime/commit.ts:358-369`). A compiler's diagnostics or a test
 * runner's stderr routinely exceed that, and an oversized update is not a loud failure: it
 * is rejected with a `StateBloatError`, recorded as a `TaskFailure`, and the producing span
 * closes `failed` — the run continues, minus the payload it was supposed to carry.
 *
 * So the verbatim bytes go to the SCRATCH STORE and the payload carries a
 * {@link ScratchRef} plus a byte-bounded inline excerpt. "Verbatim" is therefore a claim
 * about a file on disk (`await ctx.scratch.text(payload.stderrRef)`), and "bounded" is a
 * claim about what travels in state. Both are true at once, which is the point.
 *
 * ── Why the payload travels as a node OUTPUT rather than through a channel ──
 *
 * `gate_syntax` declares `writes: ["branchStatus"]` and no output ports at all
 * (`coding.graph.ts:553-566`); `branchStatus` is `{state, attempts, errorClass?}`
 * (`state/overall.ts:144`), which can hold a class name and nothing else. There is no
 * runtime enforcement of a node's declared `writes` — writing `refs` from the syntax gate
 * would WORK — but the artifact's channel writers are DERIVED from `nodes[].writes`
 * (`topology/audit.ts:12,73`), so a node that wrote an undeclared channel would silently
 * contradict the artifact that documents it. That is exactly the drift ADR-2 exists to
 * prevent.
 *
 * The interpreter forwards a node's `output` to its destination as that destination's INPUT
 * (`interpreter.ts:1462-1470`). So the payload reaches `sprint_correct` without any channel
 * write at all, and every producer stays inside the `writes` its artifact declaration lists.
 * `sprint_correct` — which DOES declare `messages` and `refs` — is what records it.
 *
 * ── Why `source` is closed ──
 *
 * Three different nodes route to the corrector (`gate_syntax` and `gate_anchor_regression`
 * through `gate.onFail`, `sprint_route` through the `retry` label) and the sandbox can
 * refuse or time out under any of them. The corrector's prompt differs by cause, and a
 * free-form string would make "which guard sent this" unassertable.
 */

// ── Payload ─────────────────────────────────────────────────────────

/** Namespaced, so a correction can never be mistaken for a domain payload. */
export const CORRECTION_KIND = "pge.sprint.correction";

/** Which guard produced the correction. */
export const CORRECTION_SOURCES = [
  "syntax",
  "anchor",
  "evaluator",
  "security",
  "sandbox-denied",
  "sandbox-timeout",
] as const;
export const CorrectionSourceSchema = z.enum(CORRECTION_SOURCES);
export type CorrectionSource = z.infer<typeof CorrectionSourceSchema>;

/**
 * The inline excerpt budget, in BYTES.
 *
 * Bytes rather than characters because {@link byteSize} in the commit boundary measures
 * the canonical JSON encoding, and a 4096-character excerpt of a diagnostic containing a
 * single multi-byte character is over 4096 bytes. 1 KiB leaves room for the critique, the
 * message envelope and the `seq`/`id` fields inside the same 4 KiB channel budget.
 */
export const CORRECTION_EXCERPT_MAX_BYTES = 1024;

/** The critique budget, in bytes. Same channel, same reason. */
export const CORRECTION_CRITIQUE_MAX_BYTES = 1024;

export const CorrectionPayloadSchema = z.object({
  kind: z.literal(CORRECTION_KIND),
  source: CorrectionSourceSchema,
  /** The node that refused. Read off `ctx.nodeId`, never spelled. */
  nodeId: z.string().min(1),
  superstep: z.number().int().min(0),
  contractId: z.string().min(1).nullable(),
  /** The verbatim bytes, on disk. `null` only when the guard produced no process output. */
  stderrRef: ScratchRefSchema.nullable(),
  /** A byte-bounded slice of those same bytes, safe to carry inline. */
  excerpt: z.string(),
  /** True when {@link excerpt} is shorter than what {@link stderrRef} holds. */
  excerptTruncated: z.boolean(),
  /** Never empty: a correction the generator cannot act on is not a correction. */
  critique: z.string().min(1),
});
export type CorrectionPayload = z.infer<typeof CorrectionPayloadSchema>;

/** True when `value` is a correction rather than a contract, a verdict or a refusal. */
export function isCorrectionPayload(value: unknown): value is CorrectionPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === CORRECTION_KIND
  );
}

// ── Byte-bounded excerpt ────────────────────────────────────────────

export interface BoundedExcerpt {
  readonly excerpt: string;
  readonly truncated: boolean;
}

/**
 * The first `maxBytes` bytes of `text`, never splitting a UTF-8 sequence.
 *
 * `Buffer.slice` then `toString("utf8")` would emit a replacement character where it cut a
 * multi-byte sequence in half, which would make the excerpt differ from the file it claims
 * to quote. Walking back to a code-point boundary keeps the excerpt a genuine PREFIX of the
 * verbatim bytes — that is what lets a test assert `stderr.startsWith(payload.excerpt)`.
 */
export function boundedExcerpt(
  text: string,
  maxBytes: number = CORRECTION_EXCERPT_MAX_BYTES,
): BoundedExcerpt {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) return { excerpt: text, truncated: false };

  let end = maxBytes;
  // 0b10xxxxxx is a UTF-8 continuation byte; back up until the cut lands on a lead byte.
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return { excerpt: buffer.subarray(0, end).toString("utf8"), truncated: true };
}

// ── Construction ────────────────────────────────────────────────────

export interface CorrectionInput {
  source: CorrectionSource;
  /** The verbatim process output. Offloaded here when `stderrRef` is not already known. */
  stderr?: string;
  /** An already-offloaded ref — the sandbox's own `stderrRef` on an `ok` outcome. */
  stderrRef?: ScratchRef;
  critique: string;
  contractId?: string | null;
}

/**
 * Build a correction, offloading the verbatim output on the way.
 *
 * `stderrRef` is preferred over `stderr` when both are supplied, because the sandbox has
 * ALREADY written the child's stderr to the scratch store (`SandboxOutcome.stderrRef`) and
 * re-offloading the same bytes under a second ref would make "the verbatim bytes" two files
 * that a later change could let drift.
 */
export async function buildCorrection(
  ctx: NodeContext,
  input: CorrectionInput,
): Promise<CorrectionPayload> {
  const ref =
    input.stderrRef ??
    (input.stderr === undefined || input.stderr.length === 0
      ? null
      : await ctx.scratch.put(ctx.runId, "stderr", input.stderr));

  const raw = input.stderr ?? (ref === null ? "" : await ctx.scratch.text(ref));
  const bounded = boundedExcerpt(raw);
  const critique = boundedExcerpt(input.critique, CORRECTION_CRITIQUE_MAX_BYTES).excerpt;

  return CorrectionPayloadSchema.parse({
    kind: CORRECTION_KIND,
    source: input.source,
    nodeId: ctx.nodeId,
    superstep: ctx.superstep,
    contractId: input.contractId ?? null,
    stderrRef: ref,
    excerpt: bounded.excerpt,
    excerptTruncated: bounded.truncated,
    critique: critique.length === 0 ? `${input.source} guard refused the iteration` : critique,
  });
}

// ── Prompt folding ──────────────────────────────────────────────────

/**
 * The correction, as the text the generator's next prompt carries.
 *
 * The excerpt is included INLINE and labelled with the ref it came from, so the generator
 * sees the actual diagnostic rather than a pointer it cannot dereference, and a reader of
 * the transcript can still find the complete bytes.
 */
export function correctionInstructions(payload: CorrectionPayload): string {
  const lines = [
    `The previous iteration was refused by "${payload.nodeId}" (${payload.source}).`,
    `Critique: ${payload.critique}`,
  ];
  if (payload.excerpt.length > 0) {
    lines.push(
      payload.stderrRef === null
        ? "Captured output:"
        : `Captured output (${payload.excerptTruncated ? "first " : ""}${String(payload.stderrRef.bytes)} bytes at ${payload.stderrRef.uri}):`,
      payload.excerpt,
    );
  }
  return lines.join("\n");
}

/** The correction as ONE `messages` entry, sized to fit the channel's inline budget. */
export function correctionMessage(ctx: NodeContext, payload: CorrectionPayload): GraphMessage {
  const text = correctionInstructions(payload);
  return {
    id: `correction:${payload.source}:${payload.nodeId}:${String(payload.superstep)}`,
    seq: ctx.superstep,
    role: "user",
    nodeId: ctx.nodeId,
    text,
    tokens: text.length,
  };
}

/** The most recent correction recorded in `messages`, or `null`. */
export function latestCorrectionText(messages: readonly GraphMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.id.startsWith("correction:") && message.text !== undefined) return message.text;
  }
  return null;
}
