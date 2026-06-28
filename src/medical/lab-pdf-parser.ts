/** parseLabPdf — native-text lab PDF -> Zod-validated ParsedLabReport via injectable LLMClient. */
import { Buffer } from "node:buffer";

import type { LLMClient, JsonSchemaObject } from "../providers/types.js";
import { ParsedLabReportSchema, type ParsedLabReport } from "./lab-types.js";

// -- Deps seam --------------------------------------------------------

export interface ParseLabPdfDeps {
  /** Injectable LLMClient; tests inject a fake, production uses buildMedicalInferenceClient (Sprint 3). */
  client: LLMClient;
  /** Model identifier to pass to the client. */
  model: string;
}

// -- Response schema (hand-written JsonSchemaObject literal) ----------

const LAB_REPORT_JSON_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: {
    panel: { type: "string" },
    collectedAtIso: { type: "string" },
    markers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          value: { type: "number" },
          unit: { type: "string" },
          referenceLow: { type: "number" },
          referenceHigh: { type: "number" },
          critical: { type: "boolean" },
        },
        required: ["name", "value", "unit"],
      },
    },
  },
  required: ["panel", "collectedAtIso", "markers"],
};

// -- parseLabPdf ------------------------------------------------------

/**
 * Base64-encodes `pdfBytes`, sends it as an Anthropic document content block
 * via an injectable `LLMClient` with schema-constrained output, and returns a
 * Zod-validated `ParsedLabReport`. Throws a `ZodError` on malformed model output
 * — never returns an unvalidated object.
 *
 * @param pdfBytes  Raw bytes of a native-text PDF lab report.
 * @param deps      Injectable `{ client, model }` seam for testing and egress gating.
 */
export async function parseLabPdf(
  pdfBytes: Uint8Array,
  deps: ParseLabPdfDeps,
): Promise<ParsedLabReport> {
  const base64 = Buffer.from(pdfBytes).toString("base64");

  const response = await deps.client.chat({
    model: deps.model,
    system:
      "You are a medical data extraction assistant. Extract structured lab results from the provided PDF document. Return ONLY a JSON object matching the requested schema — no prose, no markdown.",
    messages: [
      {
        role: "user",
        content:
          "Extract all lab markers from the attached PDF. Return a JSON object with panel name, ISO collection date, and a markers array (name, numeric value, unit, optional referenceLow/referenceHigh/critical).",
      },
    ],
    documents: [{ base64, mediaType: "application/pdf" }],
    responseSchema: LAB_REPORT_JSON_SCHEMA,
  });

  // With responseSchema set, the adapter guarantees response.text holds the JSON document.
  const parsed: unknown = JSON.parse(response.text);
  // Throws ZodError on malformed output — never coerce (sc-1-4).
  return ParsedLabReportSchema.parse(parsed);
}
