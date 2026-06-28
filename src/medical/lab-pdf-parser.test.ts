import { Buffer } from "node:buffer";

import { describe, it, expect } from "vitest";
import type { LLMClient, ChatParams, ChatResponse } from "../providers/types.js";
import { parseLabPdf } from "./lab-pdf-parser.js";

// -- Fake LLMClient ---------------------------------------------------

/**
 * ScriptedClient: injectable fake that returns canned JSON responses.
 * Records all ChatParams passed to it for assertion.
 */
class ScriptedClient implements LLMClient {
  readonly calls: ChatParams[] = [];
  private idx = 0;
  constructor(private readonly responses: string[]) {}
  async chat(params: ChatParams): Promise<ChatResponse> {
    this.calls.push(params);
    const text =
      this.responses[Math.min(this.idx, this.responses.length - 1)] ?? "";
    this.idx += 1;
    return {
      text,
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 3, outputTokens: 5 },
    };
  }
}

// -- Tests ------------------------------------------------------------

describe("parseLabPdf", () => {
  // sc-1-3: happy path — returns a ParsedLabReport from canned JSON
  it("returns a ParsedLabReport from canned JSON with correct markers, value, unit, and collectedAtIso", async () => {
    const canned = JSON.stringify({
      panel: "CBC",
      collectedAtIso: "2026-06-01T08:00:00Z",
      markers: [
        { name: "Hgb", value: 14.2, unit: "g/dL" },
        { name: "WBC", value: 7.1, unit: "10^3/uL", referenceLow: 4.0, referenceHigh: 11.0 },
      ],
    });

    const client = new ScriptedClient([canned]);
    const report = await parseLabPdf(new Uint8Array([1, 2, 3]), {
      client,
      model: "test-model",
    });

    expect(report.markers).toHaveLength(2);
    expect(report.markers[0].value).toBe(14.2);
    expect(report.markers[0].unit).toBe("g/dL");
    expect(report.collectedAtIso).toBe("2026-06-01T08:00:00Z");
    expect(report.panel).toBe("CBC");
  });

  // sc-1-3: verifies full first marker shape
  it("maps the first marker name correctly", async () => {
    const canned = JSON.stringify({
      panel: "BMP",
      collectedAtIso: "2026-06-15",
      markers: [{ name: "Glucose", value: 95, unit: "mg/dL" }],
    });

    const client = new ScriptedClient([canned]);
    const report = await parseLabPdf(new Uint8Array([0]), {
      client,
      model: "m",
    });

    expect(report.markers[0].name).toBe("Glucose");
    expect(report.markers[0].value).toBe(95);
    expect(report.markers[0].unit).toBe("mg/dL");
  });

  // sc-1-3: verifies the documents field is passed to the client
  it("sends a documents field with base64-encoded PDF bytes to the client", async () => {
    const canned = JSON.stringify({
      panel: "CBC",
      collectedAtIso: "2026-06-01",
      markers: [{ name: "Hgb", value: 14.2, unit: "g/dL" }],
    });

    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    const client = new ScriptedClient([canned]);
    await parseLabPdf(pdfBytes, { client, model: "m" });

    expect(client.calls).toHaveLength(1);
    const sentDocs = client.calls[0].documents;
    expect(sentDocs).toBeDefined();
    expect(sentDocs).toHaveLength(1);
    expect(sentDocs![0].mediaType).toBe("application/pdf");
    // Verify base64 encoding
    expect(sentDocs![0].base64).toBe(Buffer.from(pdfBytes).toString("base64"));
  });

  // sc-1-4: malformed output — Zod throws
  it("throws a ZodError when the fake client returns JSON missing required marker fields (no value)", async () => {
    const bad = JSON.stringify({
      panel: "CBC",
      collectedAtIso: "2026-06-01",
      markers: [{ name: "Hgb", unit: "g/dL" }], // value is missing
    });

    const client = new ScriptedClient([bad]);
    await expect(
      parseLabPdf(new Uint8Array([1]), { client, model: "m" }),
    ).rejects.toThrow();
  });

  // sc-1-4: missing required top-level field
  it("throws a ZodError when the fake client returns JSON missing collectedAtIso", async () => {
    const bad = JSON.stringify({
      panel: "CBC",
      // collectedAtIso is missing
      markers: [{ name: "Hgb", value: 14.2, unit: "g/dL" }],
    });

    const client = new ScriptedClient([bad]);
    await expect(
      parseLabPdf(new Uint8Array([1]), { client, model: "m" }),
    ).rejects.toThrow();
  });

  // sc-1-4: entirely malformed output
  it("throws when the model returns non-JSON text", async () => {
    const client = new ScriptedClient(["not json at all"]);
    await expect(
      parseLabPdf(new Uint8Array([1]), { client, model: "m" }),
    ).rejects.toThrow();
  });
});
