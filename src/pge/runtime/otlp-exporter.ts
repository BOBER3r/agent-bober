import { createHash } from "node:crypto";
import { z } from "zod";

import { readSpans, tracePath } from "./trace.js";
import type { Span, SpanStatus } from "./trace.js";

/**
 * OTLP/HTTP JSON view of a run's local span file. OFF unless explicitly configured.
 *
 * ── The local JSONL span file stays AUTHORITATIVE ──
 *
 * `.bober/traces/<runId>.jsonl` (written by {@link createTraceWriter} in `./trace.ts`) is
 * the source of truth for what a run did. THIS MODULE IS A DERIVED VIEW: it reads that
 * file and re-encodes it for a collector, and nothing downstream of it ever feeds back.
 * Every question about a run — what ran, in what order, at what cost — is answerable from
 * the JSONL alone with this exporter switched off, which is how it ships. A collector that
 * is unreachable, misconfigured or lossy therefore costs an operator nothing except the
 * remote view; the local record is unaffected. Do not invert this: do not make an export
 * result a precondition for anything, and do not stop writing a span because it was
 * exported.
 *
 * ── Off by default, and refuse BEFORE constructing a client ──
 *
 * {@link createOtlpExporter} with no argument is disabled. A disabled exporter performs
 * ZERO network calls, constructs NO transport (the injected `createTransport` factory is
 * never invoked and `globalThis.fetch` is never read), and does not even open the trace
 * file: {@link OtlpExporter.exportRun} returns `{exported:false, reason:"disabled"}` before
 * touching the filesystem. "Nothing happens when unconfigured" is a property of the
 * control flow rather than of a transport that politely declines, because a transport that
 * declines is one refactor away from a transport that does not.
 *
 * Turning it on takes BOTH `enabled: true` and an `http`/`https` `endpoint`; asking for one
 * without the other is a misconfiguration and throws {@link OtlpConfigError} at
 * construction, where it is visible, rather than silently exporting nowhere.
 *
 * ── No new dependency ──
 *
 * The payload is plain OTLP/HTTP JSON built here, validated by {@link OtlpExportPayloadSchema},
 * and posted with the platform `fetch`. The OpenTelemetry SDKs are not in `package.json`
 * and adding one to serialise a handful of fields would be a large supply-chain cost for a
 * default-off feature.
 */

// ── Errors ──────────────────────────────────────────────────────────

/** An explicit opt-in that cannot work: `enabled` without a usable `endpoint`. */
export class OtlpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OtlpConfigError";
  }
}

/**
 * A span in the authoritative file that cannot be encoded — an unparseable timestamp, say.
 *
 * Thrown rather than dropped: a span the exporter cannot represent is a defect in the
 * writer or in the file, and silently shipping a shorter trace than the one on disk would
 * make the remote view disagree with the local record for no visible reason.
 */
export class OtlpConversionError extends Error {
  readonly spanId: string;
  readonly field: string;

  constructor(spanId: string, field: string, detail: string) {
    super(`Span "${spanId}" cannot be converted to OTLP: ${field} ${detail}.`);
    this.name = "OtlpConversionError";
    this.spanId = spanId;
    this.field = field;
  }
}

// ── OTLP payload schema (the subset this exporter emits) ────────────

/**
 * OTLP/JSON `AnyValue`, narrowed to the kinds a span produces.
 *
 * The wire format is recursive; this is deliberately not, because nothing here nests an
 * array inside an array and a flat union stays checkable without `z.lazy`.
 */
export const OtlpPrimitiveValueSchema = z.union([
  z.object({ stringValue: z.string() }),
  z.object({ boolValue: z.boolean() }),
  /** int64 travels as a STRING in OTLP/JSON — a double would lose precision. */
  z.object({ intValue: z.string().regex(/^-?\d+$/) }),
  z.object({ doubleValue: z.number() }),
]);
export type OtlpPrimitiveValue = z.infer<typeof OtlpPrimitiveValueSchema>;

export const OtlpAnyValueSchema = z.union([
  OtlpPrimitiveValueSchema,
  z.object({ arrayValue: z.object({ values: z.array(OtlpPrimitiveValueSchema) }) }),
]);
export type OtlpAnyValue = z.infer<typeof OtlpAnyValueSchema>;

export const OtlpKeyValueSchema = z.object({ key: z.string().min(1), value: OtlpAnyValueSchema });
export type OtlpKeyValue = z.infer<typeof OtlpKeyValueSchema>;

const HEX_16 = /^[0-9a-f]{16}$/;
const HEX_32 = /^[0-9a-f]{32}$/;

export const OtlpSpanSchema = z.object({
  traceId: z.string().regex(HEX_32),
  spanId: z.string().regex(HEX_16),
  /** Empty string means "root", per the OTLP/JSON encoding. */
  parentSpanId: z.union([z.literal(""), z.string().regex(HEX_16)]),
  name: z.string().min(1),
  kind: z.number().int().min(0).max(5),
  startTimeUnixNano: z.string().regex(/^\d+$/),
  endTimeUnixNano: z.string().regex(/^\d+$/),
  attributes: z.array(OtlpKeyValueSchema),
  status: z.object({
    code: z.number().int().min(0).max(2),
    message: z.string().optional(),
  }),
});
export type OtlpSpan = z.infer<typeof OtlpSpanSchema>;

export const OtlpScopeSpansSchema = z.object({
  scope: z.object({ name: z.string().min(1), version: z.string().min(1) }),
  spans: z.array(OtlpSpanSchema),
});

export const OtlpResourceSpansSchema = z.object({
  resource: z.object({ attributes: z.array(OtlpKeyValueSchema) }),
  scopeSpans: z.array(OtlpScopeSpansSchema),
});

/** An OTLP `ExportTraceServiceRequest`, as a collector's `/v1/traces` endpoint accepts it. */
export const OtlpExportPayloadSchema = z.object({
  resourceSpans: z.array(OtlpResourceSpansSchema),
});
export type OtlpExportPayload = z.infer<typeof OtlpExportPayloadSchema>;

// ── Conversion ──────────────────────────────────────────────────────

export const OTLP_SCOPE_NAME = "agent-bober.pge";
export const OTLP_SCOPE_VERSION = "1";
export const DEFAULT_OTLP_SERVICE_NAME = "agent-bober";

/** `SPAN_KIND_INTERNAL`: every node span is work inside this process. */
const SPAN_KIND_INTERNAL = 1;

/** `STATUS_CODE_UNSET` / `_OK` / `_ERROR`. */
const STATUS_UNSET = 0;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

/**
 * Span status → OTLP status code.
 *
 * `interrupted`, `skipped` and `serialized` map to UNSET rather than to OK or ERROR: none
 * of them is a failure, and none of them is a completed unit of work either. The exact
 * local status is preserved verbatim in the `bober.span.status` attribute, so the coarser
 * OTLP code never has to carry a meaning it does not have.
 */
const OTLP_STATUS_BY_SPAN_STATUS: Readonly<Record<SpanStatus, number>> = Object.freeze({
  ok: STATUS_OK,
  failed: STATUS_ERROR,
  interrupted: STATUS_UNSET,
  skipped: STATUS_UNSET,
  serialized: STATUS_UNSET,
});

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * OTLP ids are fixed-width bytes; ours are a run id and a UUID. Hash, then truncate.
 *
 * Deterministic, so re-exporting the same file twice produces the same ids and a collector
 * sees one trace rather than two. An all-zero id is invalid on the wire, so the (practically
 * unreachable) all-zero digest prefix is nudged rather than emitted.
 */
function otlpId(seed: string, hexLength: number): string {
  const id = sha256Hex(seed).slice(0, hexLength);
  return /^0+$/.test(id) ? id.slice(0, -1) + "1" : id;
}

/** All spans of one run share a trace id. */
export function otlpTraceId(runId: string): string {
  return otlpId(`agent-bober/trace/${runId}`, 32);
}

/** Span ids are scoped by run, so two runs cannot collide inside one collector. */
export function otlpSpanId(runId: string, spanId: string): string {
  return otlpId(`agent-bober/span/${runId}\u0000${spanId}`, 16);
}

function unixNano(span: Span, field: "startedAt" | "endedAt"): string {
  const iso = span[field];
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new OtlpConversionError(span.spanId, field, `is not a date ("${iso}")`);
  return (BigInt(ms) * 1_000_000n).toString();
}

function str(key: string, value: string): OtlpKeyValue {
  return { key, value: { stringValue: value } };
}

function int(key: string, value: number): OtlpKeyValue {
  return { key, value: { intValue: String(Math.trunc(value)) } };
}

function dbl(key: string, value: number): OtlpKeyValue {
  return { key, value: { doubleValue: value } };
}

function bool(key: string, value: boolean): OtlpKeyValue {
  return { key, value: { boolValue: value } };
}

function strArray(key: string, values: readonly string[]): OtlpKeyValue {
  return { key, value: { arrayValue: { values: values.map((v) => ({ stringValue: v })) } } };
}

/**
 * One span → one OTLP span.
 *
 * Every field of the local record that a reader would look for at 3am is carried across
 * under a `bober.*` attribute, plus the conventional `gen_ai.*` names for model and token
 * usage so a collector's existing LLM dashboards light up without a mapping layer.
 */
function toOtlpSpan(span: Span): OtlpSpan {
  const attributes: OtlpKeyValue[] = [
    str("bober.run_id", span.runId),
    str("bober.span_id", span.spanId),
    str("bober.node_id", span.nodeId),
    str("bober.node_kind", span.kind),
    str("bober.phase", span.phase),
    str("bober.span_status", span.status),
    int("bober.superstep", span.superstep),
  ];
  if (span.branchKey !== null) attributes.push(str("bober.branch_key", span.branchKey));
  if (span.inputHash.length > 0) attributes.push(str("bober.input_hash", span.inputHash));
  if (span.outputHash.length > 0) attributes.push(str("bober.output_hash", span.outputHash));
  if (span.model !== undefined) {
    attributes.push(
      str("bober.model_tier", span.model.tier),
      str("gen_ai.system", span.model.provider),
      str("gen_ai.request.model", span.model.modelId),
    );
  }
  if (span.tokens !== undefined) {
    attributes.push(
      int("gen_ai.usage.input_tokens", span.tokens.in),
      int("gen_ai.usage.output_tokens", span.tokens.out),
    );
  }
  if (span.costUsd !== undefined) attributes.push(dbl("bober.cost_usd", span.costUsd));
  if (span.cache !== undefined) {
    attributes.push(str("bober.cache_status", span.cache.status), str("bober.cache_key", span.cache.key));
  }
  if (span.toolOutputRef !== undefined) {
    attributes.push(str("bober.tool_output_uri", span.toolOutputRef.uri));
  }
  if (span.archiveDir !== undefined) attributes.push(str("bober.archive_dir", span.archiveDir));
  if (span.route !== undefined) {
    attributes.push(str("bober.route_goto_kind", span.route.goto.kind));
    if (span.route.label !== undefined) attributes.push(str("bober.route_label", span.route.label));
    if (span.route.goto.node !== undefined) {
      attributes.push(str("bober.route_goto_node", span.route.goto.node));
    }
  }
  if (span.failClosed !== undefined) attributes.push(bool("bober.fail_closed", span.failClosed));
  if (span.errorClass !== undefined) attributes.push(str("bober.error_class", span.errorClass));
  if (span.serializedReason !== undefined) {
    attributes.push(str("bober.serialized_reason", span.serializedReason));
  }
  if (span.blockedBy !== undefined) attributes.push(strArray("bober.blocked_by", span.blockedBy));
  if (span.privKeys !== undefined) attributes.push(strArray("bober.priv_keys", span.privKeys));

  const code = OTLP_STATUS_BY_SPAN_STATUS[span.status];
  return {
    traceId: otlpTraceId(span.runId),
    spanId: otlpSpanId(span.runId, span.spanId),
    parentSpanId: span.parentSpanId === null ? "" : otlpSpanId(span.runId, span.parentSpanId),
    name: span.nodeId,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: unixNano(span, "startedAt"),
    endTimeUnixNano: unixNano(span, "endedAt"),
    attributes,
    ...(span.errorClass === undefined
      ? { status: { code } }
      : { status: { code, message: span.errorClass } }),
  };
}

export interface OtlpPayloadOptions {
  /** `service.name` resource attribute. Default {@link DEFAULT_OTLP_SERVICE_NAME}. */
  serviceName?: string;
  /** Extra string resource attributes (deployment environment, host, …). */
  resourceAttributes?: Readonly<Record<string, string>>;
}

/**
 * Pure `Span[] → ExportTraceServiceRequest`. No I/O, no clock, no network.
 *
 * Zero spans yield zero `resourceSpans`, so an empty run posts nothing rather than an
 * empty envelope a collector has to reason about.
 */
export function toOtlpPayload(
  spans: readonly Span[],
  options: OtlpPayloadOptions = {},
): OtlpExportPayload {
  if (spans.length === 0) return { resourceSpans: [] };

  const resourceAttributes: OtlpKeyValue[] = [
    str("service.name", options.serviceName ?? DEFAULT_OTLP_SERVICE_NAME),
    str("telemetry.sdk.name", OTLP_SCOPE_NAME),
    str("telemetry.sdk.language", "nodejs"),
  ];
  for (const [key, value] of Object.entries(options.resourceAttributes ?? {})) {
    resourceAttributes.push(str(key, value));
  }

  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes },
        scopeSpans: [
          {
            scope: { name: OTLP_SCOPE_NAME, version: OTLP_SCOPE_VERSION },
            spans: spans.map(toOtlpSpan),
          },
        ],
      },
    ],
  };
}

// ── Transport ───────────────────────────────────────────────────────

export interface OtlpSendRequest {
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface OtlpSendResult {
  readonly status: number;
}

/** The one seam the exporter talks to. Tests inject a local sink; nothing else is mocked. */
export interface OtlpTransport {
  send(request: OtlpSendRequest): Promise<OtlpSendResult>;
}

/**
 * The default transport: `POST` the JSON body with the platform `fetch`.
 *
 * Constructed LAZILY by an ENABLED exporter only — see {@link createOtlpExporter}. Reading
 * `globalThis.fetch` at call time rather than at module load keeps the disabled path free
 * of any reference to a network primitive.
 */
export function createFetchTransport(): OtlpTransport {
  return {
    async send(request): Promise<OtlpSendResult> {
      const fetchImpl = globalThis.fetch;
      if (typeof fetchImpl !== "function") {
        throw new Error("Global fetch is unavailable; OTLP export needs Node 18 or newer.");
      }
      const response = await fetchImpl(request.endpoint, {
        method: "POST",
        headers: { ...request.headers },
        body: request.body,
      });
      return { status: response.status };
    },
  };
}

// ── Exporter ────────────────────────────────────────────────────────

export type OtlpExportResult =
  /** Off, or nothing to send. No transport was constructed and no file was read. */
  | { readonly exported: false; readonly reason: "disabled" | "empty"; readonly spanCount: number }
  | { readonly exported: true; readonly spanCount: number; readonly status: number }
  /** The collector refused or was unreachable. The local trace is unaffected. */
  | {
      readonly exported: false;
      readonly reason: "transportError";
      readonly spanCount: number;
      readonly error: string;
    };

export interface OtlpExporterOptions extends OtlpPayloadOptions {
  /**
   * The master switch. Default FALSE.
   *
   * `true` with no `endpoint` throws {@link OtlpConfigError}: an opt-in that exports
   * nowhere is a mistake worth surfacing, not a quiet no-op.
   */
  enabled?: boolean;
  /** Collector traces endpoint, e.g. `http://127.0.0.1:4318/v1/traces`. */
  endpoint?: string;
  /** Extra request headers (auth). Merged over `content-type: application/json`. */
  headers?: Readonly<Record<string, string>>;
  /** An already-constructed transport — a local sink in tests. Never touched when off. */
  transport?: OtlpTransport;
  /** Lazy transport factory. NEVER invoked when off. Default {@link createFetchTransport}. */
  createTransport?: () => OtlpTransport;
}

export interface OtlpExporter {
  readonly enabled: boolean;
  readonly endpoint: string | null;
  /** Convert and send an in-memory span list. */
  export(spans: readonly Span[]): Promise<OtlpExportResult>;
  /**
   * Export one run's local trace file.
   *
   * `projectRoot` first and required, like every other store function in this package: a
   * worktree run exports its own trace, never the parent checkout's.
   */
  exportRun(projectRoot: string, runId: string): Promise<OtlpExportResult>;
}

function assertUsableEndpoint(endpoint: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new OtlpConfigError(`OTLP endpoint "${endpoint}" is not a URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new OtlpConfigError(
      `OTLP endpoint "${endpoint}" must be http or https, not "${parsed.protocol}".`,
    );
  }
}

/**
 * Build an exporter. With no argument, or without `enabled: true`, it is OFF.
 *
 * A disabled exporter is inert by construction: no transport is built, `globalThis.fetch`
 * is never read, no trace file is opened, and both `export` and `exportRun` return
 * `{exported:false, reason:"disabled", spanCount:0}` — `spanCount` is zero because nothing
 * was counted, not because the trace was empty.
 *
 * Per-run, never module-level: nothing here is a singleton, so two runs in one process
 * cannot share an endpoint or a transport by accident.
 */
export function createOtlpExporter(options: OtlpExporterOptions = {}): OtlpExporter {
  const endpoint = options.endpoint?.trim() ?? "";
  const wantsExport = options.enabled === true;

  if (wantsExport && endpoint.length === 0) {
    throw new OtlpConfigError("OTLP export is enabled but no endpoint is configured.");
  }
  if (endpoint.length > 0) assertUsableEndpoint(endpoint);

  const enabled = wantsExport && endpoint.length > 0;
  const headers: Record<string, string> = { "content-type": "application/json", ...options.headers };

  // Built on first use by an ENABLED exporter. `null` here is the whole
  // refuse-before-client guarantee: the disabled path returns before this is read.
  let transport: OtlpTransport | null = null;
  function resolveTransport(): OtlpTransport {
    if (transport === null) {
      transport = options.transport ?? (options.createTransport ?? createFetchTransport)();
    }
    return transport;
  }

  const disabled: OtlpExportResult = { exported: false, reason: "disabled", spanCount: 0 };

  async function exportSpans(spans: readonly Span[]): Promise<OtlpExportResult> {
    if (!enabled) return disabled;
    if (spans.length === 0) return { exported: false, reason: "empty", spanCount: 0 };

    // Conversion errors propagate: they mean the authoritative file holds a span this
    // encoder cannot represent, which is a defect rather than a delivery problem.
    const body = JSON.stringify(
      toOtlpPayload(spans, {
        ...(options.serviceName === undefined ? {} : { serviceName: options.serviceName }),
        ...(options.resourceAttributes === undefined
          ? {}
          : { resourceAttributes: options.resourceAttributes }),
      }),
    );

    try {
      const result = await resolveTransport().send({ endpoint, headers, body });
      return { exported: true, spanCount: spans.length, status: result.status };
    } catch (err) {
      // Telemetry never brings a run down. The local JSONL already has every span.
      return {
        exported: false,
        reason: "transportError",
        spanCount: spans.length,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    enabled,
    endpoint: enabled ? endpoint : null,
    export: exportSpans,
    async exportRun(projectRoot, runId): Promise<OtlpExportResult> {
      // Refuse before I/O, not after: a disabled exporter does not open the trace file.
      if (!enabled) return disabled;
      return exportSpans(await readSpans(tracePath(projectRoot, runId)));
    },
  };
}
