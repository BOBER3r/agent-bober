import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTraceWriter, readSpans, tracePath } from "./trace.js";
import type { Span } from "./trace.js";
import {
  DEFAULT_OTLP_SERVICE_NAME,
  OTLP_SCOPE_NAME,
  OtlpConfigError,
  OtlpConversionError,
  OtlpExportPayloadSchema,
  createOtlpExporter,
  otlpSpanId,
  otlpTraceId,
  toOtlpPayload,
} from "./otlp-exporter.js";
import type { OtlpExportPayload, OtlpTransport } from "./otlp-exporter.js";

/**
 * sc-13-9 — an OTLP view of the local trace that a local sink accepts, and that does
 * NOTHING when unconfigured.
 *
 * Two claims, and they are asymmetric in how they can fail. The first ("a sink accepts
 * it") is proved positively, against a real HTTP listener bound to 127.0.0.1 that parses
 * the body with the payload schema — an in-process stub would prove only that this file
 * agrees with itself about the wire format. The second ("zero network calls when
 * unconfigured") cannot be proved by observing an absence, so every route to the network
 * is booby-trapped: `globalThis.fetch` is a throwing spy, the injected transport throws
 * from every method, and the transport FACTORY throws when called. A disabled exporter
 * that so much as constructs a client fails.
 *
 * Nothing here reaches the network: the only listener is loopback, on an ephemeral port,
 * closed in `afterEach`.
 */

let root = "";
const RUN = "run-20260806-otlp";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-otlp-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A clock that advances one second per read, so startedAt < endedAt is observable. */
function tickingClock(startIso = "2026-08-06T00:00:00.000Z"): () => Date {
  let ms = Date.parse(startIso);
  return () => {
    const at = new Date(ms);
    ms += 1_000;
    return at;
  };
}

/**
 * Write a real trace file with the SHIPPED writer — not a hand-rolled JSONL fixture, so
 * the exporter is proved against the format the runtime actually produces.
 *
 * Three spans: a root `llm` with model/token/cost, a failed child `gate`, and a
 * `serialized` child that names what blocked it.
 */
async function seedTrace(): Promise<Span[]> {
  const ids = ["span-root", "span-gate", "span-held"];
  let next = 0;
  const writer = await createTraceWriter(root, RUN, {
    now: tickingClock(),
    newSpanId: () => ids[next++] ?? `span-${next}`,
  });

  writer
    .begin({ nodeId: "plan", kind: "llm", phase: "planning", branchKey: null, superstep: 0 })
    .end({
      status: "ok",
      outputHash: "b".repeat(64),
      tokens: { in: 1200, out: 340 },
      costUsd: 0.0184,
      cache: { status: "miss", key: "plan/v1" },
      privKeys: ["draftSpec"],
    });
  writer
    .begin({
      nodeId: "gate_syntax",
      kind: "gate",
      phase: "generating",
      branchKey: "sprint-1",
      superstep: 1,
      parentSpanId: "span-root",
    })
    .end({ status: "failed", errorClass: "TypeError", failClosed: true });
  writer
    .begin({
      nodeId: "sprint_impl",
      kind: "subgraph",
      phase: "generating",
      branchKey: "sprint-2",
      superstep: 1,
      parentSpanId: "span-root",
    })
    .end({ status: "serialized", serializedReason: "fileConflict", blockedBy: ["sprint-1"] });

  await writer.close();
  return readSpans(tracePath(root, RUN));
}

/** Every span in a payload, flattened out of the resource/scope envelope. */
function spansOf(payload: OtlpExportPayload): OtlpExportPayload["resourceSpans"][number]["scopeSpans"][number]["spans"] {
  return payload.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans));
}

function attr(
  span: OtlpExportPayload["resourceSpans"][number]["scopeSpans"][number]["spans"][number],
  key: string,
): unknown {
  return span.attributes.find((a) => a.key === key)?.value;
}

// ── A LOCAL sink: a real HTTP listener on 127.0.0.1, ephemeral port ──

interface LocalSink {
  url: string;
  requests: Array<{ headers: IncomingHttpHeaders; body: string }>;
  close(): Promise<void>;
}

async function startLocalSink(status = 200): Promise<LocalSink> {
  const requests: LocalSink["requests"] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(status, { "content-type": "application/json" });
      res.end("{}");
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/v1/traces`,
    requests,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ── The payload a local sink accepts ────────────────────────────────

describe("OTLP exporter — a local sink accepts the payload (sc-13-9)", () => {
  it("posts a trace file to a 127.0.0.1 listener that parses it as a valid OTLP request", async () => {
    const spans = await seedTrace();
    expect(spans).toHaveLength(3);

    const sink = await startLocalSink();
    try {
      const exporter = createOtlpExporter({ enabled: true, endpoint: sink.url });
      expect(exporter.enabled).toBe(true);
      expect(exporter.endpoint).toBe(sink.url);

      const result = await exporter.exportRun(root, RUN);
      expect(result).toEqual({ exported: true, spanCount: 3, status: 200 });
    } finally {
      await sink.close();
    }

    expect(sink.requests).toHaveLength(1);
    const request = sink.requests[0];
    if (request === undefined) throw new Error("sink recorded no request");
    expect(request.headers["content-type"]).toBe("application/json");

    // THE acceptance check: the sink parses the received bytes as an OTLP request.
    const accepted = OtlpExportPayloadSchema.parse(JSON.parse(request.body));
    const otlpSpans = spansOf(accepted);
    expect(otlpSpans.map((s) => s.name)).toEqual(["plan", "gate_syntax", "sprint_impl"]);

    const resource = accepted.resourceSpans[0]?.resource.attributes ?? [];
    expect(resource).toContainEqual({
      key: "service.name",
      value: { stringValue: DEFAULT_OTLP_SERVICE_NAME },
    });
    expect(accepted.resourceSpans[0]?.scopeSpans[0]?.scope.name).toBe(OTLP_SCOPE_NAME);
  });

  it("accepts an in-process sink through the injected transport seam", async () => {
    const spans = await seedTrace();
    const received: string[] = [];
    const sink: OtlpTransport = {
      async send(request) {
        // The in-process sink validates exactly as the HTTP one does.
        OtlpExportPayloadSchema.parse(JSON.parse(request.body));
        expect(request.headers["content-type"]).toBe("application/json");
        expect(request.headers.authorization).toBe("Bearer local");
        received.push(request.endpoint);
        return { status: 202 };
      },
    };

    const exporter = createOtlpExporter({
      enabled: true,
      endpoint: "http://127.0.0.1:4318/v1/traces",
      headers: { authorization: "Bearer local" },
      transport: sink,
      serviceName: "agent-bober-test",
    });

    const result = await exporter.export(spans);
    expect(result).toEqual({ exported: true, spanCount: 3, status: 202 });
    expect(received).toEqual(["http://127.0.0.1:4318/v1/traces"]);
  });

  it("reports a refusing sink as a disposition rather than throwing, leaving the run alone", async () => {
    const spans = await seedTrace();
    const sink = await startLocalSink(503);
    try {
      const exporter = createOtlpExporter({ enabled: true, endpoint: sink.url });
      const result = await exporter.export(spans);
      expect(result).toEqual({ exported: true, spanCount: 3, status: 503 });
    } finally {
      await sink.close();
    }

    const dead = createOtlpExporter({
      enabled: true,
      endpoint: "http://127.0.0.1:4318/v1/traces",
      transport: {
        send: () => Promise.reject(new Error("connect ECONNREFUSED")),
      },
    });
    const result = await dead.export(spans);
    expect(result).toMatchObject({ exported: false, reason: "transportError", spanCount: 3 });
    if (result.exported || result.reason !== "transportError") throw new Error("expected transportError");
    expect(result.error).toContain("ECONNREFUSED");
  });
});

// ── Off by default: zero network calls when unconfigured ────────────

describe("OTLP exporter — off by default, zero network calls (sc-13-9)", () => {
  /**
   * Every route out of the process is a trap. `fetch` throws, the transport throws from
   * every method, and the factory throws when called — so "no network happened" is proved
   * by the absence of an exception AND by three `not.toHaveBeenCalled()` assertions,
   * rather than by trusting the implementation to have checked a flag before dialling.
   */
  it("constructs no client, reads no trace file and touches no network when unconfigured", async () => {
    const spans = await seedTrace();
    expect(spans).toHaveLength(3);

    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(() => {
      throw new Error("network access from a disabled OTLP exporter");
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const throwingTransport: OtlpTransport = {
      send: vi.fn(() => {
        throw new Error("disabled OTLP exporter used its transport");
      }),
    };
    const transportFactory = vi.fn((): OtlpTransport => {
      throw new Error("disabled OTLP exporter constructed a client");
    });

    try {
      // 1. No options at all — the shipped default.
      const off = createOtlpExporter();
      expect(off.enabled).toBe(false);
      expect(off.endpoint).toBeNull();

      // 2. An endpoint present but `enabled` never set — still off.
      const unarmed = createOtlpExporter({
        endpoint: "http://127.0.0.1:4318/v1/traces",
        transport: throwingTransport,
        createTransport: transportFactory,
      });
      expect(unarmed.enabled).toBe(false);
      expect(unarmed.endpoint).toBeNull();

      // 3. Explicitly disabled with every trap wired in.
      const explicit = createOtlpExporter({
        enabled: false,
        endpoint: "http://127.0.0.1:4318/v1/traces",
        transport: throwingTransport,
        createTransport: transportFactory,
      });
      expect(explicit.enabled).toBe(false);

      for (const exporter of [off, unarmed, explicit]) {
        // `spanCount: 0` against a file holding THREE spans is the refuse-before-I/O
        // proof: the disabled path returned before it read anything.
        expect(await exporter.exportRun(root, RUN)).toEqual({
          exported: false,
          reason: "disabled",
          spanCount: 0,
        });
        expect(await exporter.export(spans)).toEqual({
          exported: false,
          reason: "disabled",
          spanCount: 0,
        });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(throwingTransport.send).not.toHaveBeenCalled();
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it("builds no transport until an ENABLED exporter actually has spans to send", async () => {
    const transportFactory = vi.fn(
      (): OtlpTransport => ({ send: () => Promise.resolve({ status: 200 }) }),
    );
    const exporter = createOtlpExporter({
      enabled: true,
      endpoint: "http://127.0.0.1:4318/v1/traces",
      createTransport: transportFactory,
    });

    // Enabled, but nothing to say: still no client.
    expect(await exporter.export([])).toEqual({ exported: false, reason: "empty", spanCount: 0 });
    expect(transportFactory).not.toHaveBeenCalled();

    const spans = await seedTrace();
    expect(await exporter.export(spans)).toEqual({ exported: true, spanCount: 3, status: 200 });
    expect(transportFactory).toHaveBeenCalledTimes(1);

    // Reused, not rebuilt.
    await exporter.export(spans);
    expect(transportFactory).toHaveBeenCalledTimes(1);
  });

  it("refuses an opt-in that cannot work, at construction", () => {
    expect(() => createOtlpExporter({ enabled: true })).toThrow(OtlpConfigError);
    expect(() => createOtlpExporter({ enabled: true, endpoint: "   " })).toThrow(OtlpConfigError);
    expect(() => createOtlpExporter({ enabled: true, endpoint: "not a url" })).toThrow(OtlpConfigError);
    expect(() =>
      createOtlpExporter({ enabled: true, endpoint: "file:///etc/passwd" }),
    ).toThrow(OtlpConfigError);
  });
});

// ── The conversion itself ───────────────────────────────────────────

describe("toOtlpPayload", () => {
  it("carries every span field across and links parents by derived id", async () => {
    const spans = await seedTrace();
    const payload = toOtlpPayload(spans);
    OtlpExportPayloadSchema.parse(payload);

    const [plan, gate, held] = spansOf(payload);
    if (plan === undefined || gate === undefined || held === undefined) {
      throw new Error("expected three OTLP spans");
    }

    // One trace id for the run; the root has no parent; children point at the root.
    expect(plan.traceId).toBe(otlpTraceId(RUN));
    expect(gate.traceId).toBe(plan.traceId);
    expect(plan.parentSpanId).toBe("");
    expect(gate.parentSpanId).toBe(otlpSpanId(RUN, "span-root"));
    expect(gate.parentSpanId).toBe(plan.spanId);
    expect(held.parentSpanId).toBe(plan.spanId);

    // ok → OK, failed → ERROR (carrying the error class), serialized → UNSET.
    expect(plan.status).toEqual({ code: 1 });
    expect(gate.status).toEqual({ code: 2, message: "TypeError" });
    expect(held.status).toEqual({ code: 0 });

    // Timestamps become nanoseconds, and the ticking clock is visible in the gap.
    expect(plan.startTimeUnixNano).toBe(String(BigInt(Date.parse("2026-08-06T00:00:00.000Z")) * 1_000_000n));
    expect(BigInt(plan.endTimeUnixNano) - BigInt(plan.startTimeUnixNano)).toBe(1_000_000_000n);

    expect(attr(plan, "bober.run_id")).toEqual({ stringValue: RUN });
    expect(attr(plan, "bober.node_kind")).toEqual({ stringValue: "llm" });
    expect(attr(plan, "bober.phase")).toEqual({ stringValue: "planning" });
    expect(attr(plan, "bober.span_status")).toEqual({ stringValue: "ok" });
    expect(attr(plan, "gen_ai.usage.input_tokens")).toEqual({ intValue: "1200" });
    expect(attr(plan, "gen_ai.usage.output_tokens")).toEqual({ intValue: "340" });
    expect(attr(plan, "bober.cost_usd")).toEqual({ doubleValue: 0.0184 });
    expect(attr(plan, "bober.cache_status")).toEqual({ stringValue: "miss" });
    expect(attr(plan, "bober.priv_keys")).toEqual({
      arrayValue: { values: [{ stringValue: "draftSpec" }] },
    });
    expect(attr(plan, "bober.branch_key")).toBeUndefined();

    expect(attr(gate, "bober.branch_key")).toEqual({ stringValue: "sprint-1" });
    expect(attr(gate, "bober.fail_closed")).toEqual({ boolValue: true });
    expect(attr(gate, "bober.error_class")).toEqual({ stringValue: "TypeError" });
    expect(attr(gate, "bober.superstep")).toEqual({ intValue: "1" });

    expect(attr(held, "bober.serialized_reason")).toEqual({ stringValue: "fileConflict" });
    expect(attr(held, "bober.blocked_by")).toEqual({
      arrayValue: { values: [{ stringValue: "sprint-1" }] },
    });
  });

  it("is deterministic, so re-exporting the same file is one trace and not two", async () => {
    const spans = await seedTrace();
    expect(JSON.stringify(toOtlpPayload(spans))).toBe(JSON.stringify(toOtlpPayload(spans)));
    // Different runs never share a span id even when the local span ids collide.
    expect(otlpSpanId("run-a", "span-root")).not.toBe(otlpSpanId("run-b", "span-root"));
  });

  it("emits nothing for an empty span list", () => {
    expect(toOtlpPayload([])).toEqual({ resourceSpans: [] });
  });

  it("adds the configured service name and resource attributes", async () => {
    const spans = await seedTrace();
    const payload = toOtlpPayload(spans, {
      serviceName: "bober-worktree",
      resourceAttributes: { "deployment.environment": "local" },
    });
    const attrs = payload.resourceSpans[0]?.resource.attributes ?? [];
    expect(attrs).toContainEqual({ key: "service.name", value: { stringValue: "bober-worktree" } });
    expect(attrs).toContainEqual({
      key: "deployment.environment",
      value: { stringValue: "local" },
    });
  });

  it("throws a typed conversion error rather than shipping a shorter trace than the file", () => {
    const broken: Span = {
      runId: RUN,
      spanId: "span-broken",
      parentSpanId: null,
      superstep: 0,
      nodeId: "plan",
      branchKey: null,
      kind: "llm",
      phase: "planning",
      startedAt: "whenever",
      endedAt: "2026-08-06T00:00:01.000Z",
      inputHash: "",
      outputHash: "",
      status: "ok",
    };
    expect(() => toOtlpPayload([broken])).toThrow(OtlpConversionError);
    expect(() => toOtlpPayload([broken])).toThrow(/startedAt is not a date/);
  });
});
