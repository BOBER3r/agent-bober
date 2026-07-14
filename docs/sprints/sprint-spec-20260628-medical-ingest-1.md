# Lab-PDF → structured JSON parser (Claude document block, egress-gated)

**Contract:** sprint-spec-20260628-medical-ingest-1  ·  **Spec:** spec-20260628-medical-ingest  ·  **Completed:** 2026-06-28

## What this sprint added

The **first sprint of the 5-sprint medical-ingest leg** (`spec-20260628-medical-ingest`: lab-PDF → vault
notes + profile + supplements). It delivers the lowest layer only: a pure parse function plus the provider
plumbing it needs. `parseLabPdf(pdfBytes, deps)` base64-encodes a **native-text** lab-report PDF, sends it
to Claude as a `document` content block through an **injectable** `LLMClient` with schema-constrained
output, and returns a **Zod-validated** `ParsedLabReport` (panel name, ISO collection date, and a markers
array — each marker has name / numeric value / unit and optional reference low+high+critical). Model output
that fails the schema throws a `ZodError` and is **never returned unvalidated**. To carry the PDF to the
model, `ChatParams` gains an **additive, optional** `documents` field that **only the Anthropic adapter**
renders as a base64 `application/pdf` document block; every other adapter ignores it and calls without
`documents` are **byte-identical** to prior behaviour. No CLI command, no vault-note writing, and no store
reindex ship here — those are Sprints 2–3.

## Public surface

- `parseLabPdf(pdfBytes: Uint8Array, deps: ParseLabPdfDeps): Promise<ParsedLabReport>` (`src/medical/lab-pdf-parser.ts:53`) — base64-encodes the PDF, sends it via `deps.client.chat({ documents, responseSchema })`, `JSON.parse`s `response.text`, and returns `ParsedLabReportSchema.parse(...)`. Throws `ZodError` on malformed model output (never coerces).
- `ParseLabPdfDeps { client: LLMClient; model: string }` (`src/medical/lab-pdf-parser.ts:9`) — the dependency seam: tests inject a fake client, production (Sprint 3) will pass `buildMedicalInferenceClient`.
- `ParsedLabReportSchema` / `ParsedLabReport` (`src/medical/lab-types.ts:15`, `:24`) — `{ panel: string; collectedAtIso: string; markers: ParsedLabMarker[] }`.
- `ParsedLabMarkerSchema` / `ParsedLabMarker` (`src/medical/lab-types.ts:6`, `:23`) — `{ name: string; value: number; unit: string; referenceLow?: number; referenceHigh?: number; critical?: boolean }`.
- `ChatParams.documents?: { base64: string; mediaType: string }[]` (`src/providers/types.ts:190`) — additive, optional. Only the Anthropic adapter renders it; all other adapters ignore it.
- Anthropic adapter **document-block renderer** (`src/providers/anthropic.ts:228`) — when `params.documents` is non-empty, prepends one `{ type: "document", source: { type: "base64", media_type, data } }` block per entry to the **first user message**, injected **before** the cache-breakpoint pass so the breakpoint still lands on the trailing text block.

## How to use / how it fits

```ts
import { parseLabPdf } from "./medical/lab-pdf-parser.js";

const report = await parseLabPdf(pdfBytes, { client, model: "sonnet" });
// report.panel, report.collectedAtIso, report.markers[i].{ name, value, unit, referenceLow?, referenceHigh? }
```

The `ParsedLabReport` markers map cleanly onto the existing `LabResult` shape
(`src/medical/types.ts:118` — `biomarker` / `value` / `unit` / `collectedAtIso` / `referenceLow` /
`referenceHigh`), which is how Sprint 2 will turn parsed reports into vault notes and reindex them into the
`HealthDataStore`. The internal `LAB_REPORT_JSON_SCHEMA` literal (`src/medical/lab-pdf-parser.ts:18`) is the
hand-written `JsonSchemaObject` passed as `responseSchema`; with `responseSchema` set, the Anthropic adapter
guarantees `response.text` holds the JSON document.

## Notes for maintainers

- **`documents` is Anthropic-only and additive.** Non-Anthropic adapters (`openai.ts`, `google.ts`, `openai-compat.ts`, `claude-code.ts`) were intentionally **not** modified — they ignore the field. A request without `documents` renders byte-identically to before (evaluator-verified via a no-documents snapshot guard, sc-1-5). The Anthropic media type is forwarded as-is and cast to `Base64PDFSource["media_type"]`, so today it is effectively the PDF document path.
- **No network in tests.** Every parser test injects a fake/scripted `LLMClient`; no `fetch` or Anthropic SDK call escapes. The malformed-output path is exercised by tests that assert `.rejects.toThrow()` on the Zod `.parse()` (sc-1-4).
- **No production wiring yet.** `parseLabPdf` is reachable only by passing a `client` explicitly. Egress gating (the `cloud-inference` axis), fail-closed CLI behaviour, vault-note writing, and store reindex are **out of scope** for this sprint — Sprints 2 (`Lab-note vault writer + reindex`) and 3 (`bober medical import-labs <pdf>`).
- **Native-text PDFs only.** No OCR / scanned-image handling — assumes the PDF carries an extractable text layer.
- **Scope.** Commit `be98982`: new `src/medical/lab-types.ts`, `src/medical/lab-pdf-parser.ts`, `src/medical/lab-pdf-parser.test.ts`; modified `src/providers/types.ts` (+`documents`) and `src/providers/anthropic.ts` (document-block renderer); `src/providers/anthropic.test.ts` (+4 sc-1-5 tests). No new deps. Full suite **2921** green (+10), all five criteria (sc-1-1..sc-1-5) passed iteration 1.
