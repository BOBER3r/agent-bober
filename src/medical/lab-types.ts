/** Zod schemas for parsed lab reports (medical-ingest Sprint 1). */
import { z } from "zod";

// -- Schemas ----------------------------------------------------------

export const ParsedLabMarkerSchema = z.object({
  name: z.string(),
  value: z.number(),
  unit: z.string(),
  referenceLow: z.number().optional(),
  referenceHigh: z.number().optional(),
  critical: z.boolean().optional(),
});

export const ParsedLabReportSchema = z.object({
  panel: z.string(),
  collectedAtIso: z.string(),
  markers: z.array(ParsedLabMarkerSchema),
});

// -- Types ------------------------------------------------------------

export type ParsedLabMarker = z.infer<typeof ParsedLabMarkerSchema>;
export type ParsedLabReport = z.infer<typeof ParsedLabReportSchema>;
