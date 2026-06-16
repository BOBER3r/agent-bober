/** AppleHealthAdapter — SAX streaming import of Apple Health export.xml (Phase 6, Sprint 5). */
import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import * as sax from "sax";
import type {
  HealthObservation,
  IngestionAdapter,
  IngestionResult,
  ObservationSink,
} from "../types.js";

/** Maximum observations to buffer before awaiting a sink write (backpressure cap). */
const BATCH_CAP = 1000;

/**
 * Streams Apple Health export XML via SAX with bounded (~1000-row) batches.
 *
 * Backpressure mechanism:
 *   The stream is opened in paused (non-flowing) mode.
 *   We drive it as an async iterator, reading one chunk at a time.
 *   When the observation buffer reaches BATCH_CAP, we await sink.writeBatch
 *   before continuing to iterate — preventing unbounded accumulation.
 *
 * NEVER calls readFile/readFileSync on the whole file — createReadStream only.
 *
 * bober: single .xml extension check; extend canHandle to sniff "HealthData"
 *        root if the registry ever needs to distinguish multiple XML formats.
 */
export class AppleHealthAdapter implements IngestionAdapter {
  readonly kind = "apple-health";

  /**
   * Returns true for .xml files (cheap extension check — no full read).
   */
  canHandle(filePath: string): boolean {
    return filePath.toLowerCase().endsWith(".xml");
  }

  /**
   * Stream-parse the Apple Health export XML file.
   *
   * Uses createReadStream as an async iterable to pull one chunk at a time.
   * Feeds chunks to a strict SAX parser (synchronous per chunk).
   * Flushes the observation buffer to the sink when it reaches BATCH_CAP,
   * awaiting the write before pulling the next chunk (backpressure).
   */
  async ingest(filePath: string, sink: ObservationSink): Promise<IngestionResult> {
    let recordsParsed = 0;
    let buffer: HealthObservation[] = [];

    const parser = sax.parser(true, { trim: true });

    parser.onopentag = (node: sax.Tag | sax.QualifiedTag) => {
      if (node.name !== "Record") return;
      const a = node.attributes as Record<string, string>;
      const value = parseFloat(a["value"] ?? "");
      if (Number.isNaN(value)) return; // skip non-numeric records

      recordsParsed++;
      buffer.push({
        metric: a["type"] ?? "",
        value,
        unit: a["unit"] ?? "",
        tStart: a["startDate"] ?? "",
        tEnd: (a["endDate"] as string | undefined) || undefined,
        source: "apple-health",
      });
    };

    // Collect any SAX parse errors so we can rethrow after the chunk.
    let parseError: Error | null = null;
    parser.onerror = (err: Error) => {
      parseError = err;
      // Clear so the parser does not get permanently stuck on the error state.
      parser.error = null as unknown as Error;
    };

    // createReadStream is an async iterable in Node.js >= 10 (streams2+).
    // Using for-await-of pulls one chunk at a time — the stream stays paused
    // between iterations, giving us natural backpressure control.
    const stream = createReadStream(filePath, {
      encoding: "utf8",
    }) as Readable & AsyncIterable<string>;

    for await (const chunk of stream) {
      // Feed chunk to the SAX parser synchronously (all opentag events fire here).
      parser.write(chunk);

      if (parseError) {
        throw parseError;
      }

      // Flush in BATCH_CAP-sized slices whenever the buffer overflows.
      // Awaiting writeBatch here IS the backpressure: the for-await loop
      // does not pull the next chunk from the stream until this resolves.
      while (buffer.length >= BATCH_CAP) {
        const batch = buffer.splice(0, BATCH_CAP);
        await sink.writeBatch(batch, []);
      }
    }

    // Finalize the SAX parser.
    try {
      parser.close();
    } catch {
      // ignore: tolerate malformed XML tails
    }

    // Flush remaining buffered observations (< BATCH_CAP) after stream ends.
    if (buffer.length > 0) {
      await sink.writeBatch(buffer, []);
      buffer = [];
    }

    const newRows =
      "newRows" in sink ? (sink as { newRows: number }).newRows : 0;
    return { recordsParsed, newRows };
  }
}
