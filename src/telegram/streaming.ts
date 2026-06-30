/** streaming.ts — Stream long-running progress as in-place edits to ONE Telegram message. */
import { sendSafeForEdit, sendSafeEdit } from "./outbound.js";
import type { EditTransport } from "./outbound.js";
import { renderFleetView } from "./fleet-view.js";
import type { SynthesisBundle } from "../fleet/synthesis.js"; // TYPE-ONLY — erased at compile

// ── streamProgress ────────────────────────────────────────────────────

/**
 * Send an initial status message, then edit THAT SAME message id for each update.
 * Contract: ONE send (the initial header) + N edits on the same message id.
 * Never posts a new message per progress tick (nonGoal: "no new message per tick").
 *
 * `updates` is an injected AsyncIterable<string> so:
 *  - Tests drive a fixed sequence without any network or run dependency.
 *  - The real caller supplies an iterable backed by existing run-progress signals
 *    (e.g. history.jsonl events) without adding run logic to this module.
 *  - The final update in `updates` becomes the final summary edit.
 *
 * Both sendSafeForEdit and sendSafeEdit are the ONLY funnel paths — this function
 * never calls transport.sendReturningId or transport.editMessage directly (sc-6-4).
 *
 * bober: in-memory iterable; swap the caller-side source for a CompletionTailer
 *        (src/chat/completion-tailer.ts) or roster state.json progress field
 *        once a live do-bridge wire is added in a follow-up sprint.
 */
export async function streamProgress(
  transport: EditTransport,
  chatId: number,
  updates: AsyncIterable<string>,
  opts?: { header?: string },
): Promise<void> {
  const header = opts?.header ?? "Working…";
  // ONE send: initial status message — captures the message id for all edits.
  const messageId = await sendSafeForEdit(transport, chatId, header);
  // N edits: every update replaces the same message in place (never a new message).
  for await (const text of updates) {
    await sendSafeEdit(transport, chatId, messageId, text);
  }
}

// ── streamFleetView ───────────────────────────────────────────────────

/**
 * Stream the per-agent fleet sections as in-place edits to ONE message.
 * Uses renderFleetView (the SHARED renderer) to produce sections, then feeds
 * them into streamProgress as an accumulating AsyncIterable<string>.
 *
 * The shared renderer enforces the same one-line truncation used by /fleet (sc-7-5),
 * so verbatim payloads never reach the transport via either surface.
 *
 * Accumulator pattern: each yield progressively appends the next section so the
 * message grows from the header to the full summary in place (no new messages).
 */
export async function streamFleetView(
  transport: EditTransport,
  chatId: number,
  bundle: SynthesisBundle,
): Promise<void> {
  const sections = renderFleetView(bundle); // header + one per agent
  async function* gen(): AsyncIterable<string> {
    let acc = "";
    for (const s of sections) {
      acc = acc ? `${acc}\n\n${s}` : s;
      yield acc;
    }
  }
  await streamProgress(transport, chatId, gen(), { header: sections[0] ?? "Fleet…" });
}
