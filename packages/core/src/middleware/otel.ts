import { createMiddleware } from "hono/factory";
import type { MiddlewareHandler } from "hono";
import { randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

export interface OtelMiddlewareOptions {
  serviceName: string;
}

// W3C Trace Context traceparent header format:
//   00-{32-hex traceId}-{16-hex spanId}-{8-bit flags}
//
// https://www.w3.org/TR/trace-context/#traceparent-header
const TRACEPARENT_REGEX =
  /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

// OTEL status codes mirror the OpenTelemetry spec (UNSET=0, OK=1, ERROR=2).
// We use string labels here because this module intentionally avoids the
// @opentelemetry npm packages — span records are consumed by a collector agent.
type SpanStatus = "OK" | "ERROR";

function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * W3C Trace Context — parse an incoming `traceparent` header.
 *
 * Returns the upstream traceId and spanId when the header is well-formed,
 * or null when the header is absent or malformed. Malformed headers are
 * silently dropped and a new trace is started; this matches the behaviour of
 * the OTEL SDK's W3CTraceContextPropagator.
 */
function parseTraceparent(
  header: string | undefined
): { traceId: string; parentSpanId: string } | null {
  if (!header) return null;
  const match = TRACEPARENT_REGEX.exec(header);
  if (!match) return null;

  const traceId = match[1]!;
  const parentSpanId = match[2]!;

  // Reject all-zero IDs — they are invalid per the W3C spec.
  if (traceId === "0".repeat(32) || parentSpanId === "0".repeat(16))
    return null;

  return { traceId, parentSpanId };
}

/**
 * Convert a span record into the OTLP/HTTP JSON format (v1) and POST it to the
 * configured OTEL_EXPORTER_OTLP_ENDPOINT.  The request is fire-and-forget —
 * failures are silently swallowed so that tracing never breaks request handling.
 *
 * OTLP/HTTP JSON spec:
 *   https://opentelemetry.io/docs/specs/otlp/#otlphttp-request
 *
 * The endpoint receives ExportTraceServiceRequest at /v1/traces.
 */
function exportSpanToOtlp(
  span: Record<string, unknown>,
  endpoint: string
): void {
  // Convert ISO timestamps to OTLP nanosecond epoch format.
  const startNano = BigInt(new Date(span["startTime"] as string).getTime()) * 1_000_000n;
  const endNano = BigInt(new Date(span["endTime"] as string).getTime()) * 1_000_000n;

  // Map our status label to the OTLP StatusCode enum (OK=1, ERROR=2).
  const otlpStatusCode = span["status"] === "ERROR" ? 2 : 1;

  // Build OTLP attributes from our flat attributes object.
  const attrs = span["attributes"] as Record<string, unknown> | undefined;
  const otlpAttrs = attrs
    ? Object.entries(attrs).map(([key, value]) => ({
        key,
        value:
          typeof value === "number"
            ? { intValue: String(value) }
            : { stringValue: String(value) },
      }))
    : [];

  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: "service.name",
              value: { stringValue: span["service"] as string },
            },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "oneplatform.otel-middleware", version: "1.0.0" },
            spans: [
              {
                traceId: span["traceId"],
                spanId: span["spanId"],
                ...(span["parentSpanId"]
                  ? { parentSpanId: span["parentSpanId"] }
                  : {}),
                name: span["name"],
                kind: 2, // SPAN_KIND_SERVER
                startTimeUnixNano: startNano.toString(),
                endTimeUnixNano: endNano.toString(),
                attributes: otlpAttrs,
                status: { code: otlpStatusCode },
              },
            ],
          },
        ],
      },
    ],
  };

  const body = JSON.stringify(payload);

  // Build the full URL — OTLP/HTTP traces endpoint.
  const url = new URL("/v1/traces", endpoint);
  const isHttps = url.protocol === "https:";
  const doRequest = isHttps ? httpsRequest : httpRequest;

  const req = doRequest(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 5_000,
    },
    (res) => {
      // Drain the response body so the socket can be reused.
      res.resume();
    }
  );

  req.on("error", () => {
    // Silently ignore export failures — tracing must never break requests.
  });

  req.end(body);
}

/**
 * Lightweight OTEL-compatible tracing middleware.
 *
 * Because we cannot install @opentelemetry npm packages in this environment,
 * this middleware implements the W3C Trace Context propagation protocol
 * manually and emits structured span records to stdout. Those records can be
 * ingested by any OTEL collector agent (Vector, Fluentd, otelcol) that reads
 * Docker container stdout/stderr.
 *
 * The middleware:
 *   1. Extracts or generates a W3C traceparent trace ID and span ID.
 *   2. Stores the traceId on the Hono context for downstream correlation.
 *   3. Wraps the handler and measures wall-clock duration.
 *   4. Emits a JSON span record to stdout.
 *   5. Sets `traceparent` and `server-timing` response headers.
 *
 * When OTEL_EXPORTER_OTLP_ENDPOINT is not set the middleware still runs —
 * trace IDs are still generated and correlated. The span records appear only
 * in stdout regardless; the env var controls whether a collector picks them up.
 */
export function otelMiddleware(
  options: OtelMiddlewareOptions
): MiddlewareHandler {
  const { serviceName } = options;

  return createMiddleware(async (c, next) => {
    const upstream = parseTraceparent(c.req.header("traceparent"));

    // Start a new span. parentSpanId is the upstream span; spanId is ours.
    const traceId = upstream?.traceId ?? newTraceId();
    const parentSpanId = upstream?.parentSpanId ?? undefined;
    const spanId = newSpanId();

    // Expose the traceId so other middleware and route handlers can include it
    // in log records and error responses for end-to-end correlation.
    c.set("traceId" as never, traceId);

    const startTime = new Date();
    const startHrMs = performance.now();

    await next();

    const durationMs = Math.round(performance.now() - startHrMs);
    const endTime = new Date();

    const statusCode = c.res.status;
    // HTTP 5xx is an error span; everything else (including 4xx client errors)
    // is treated as OK at the span level — the status code attribute carries the
    // detail. This matches the OTEL semantic conventions for HTTP servers.
    const spanStatus: SpanStatus = statusCode >= 500 ? "ERROR" : "OK";

    const method = c.req.method;
    const path = new URL(c.req.url).pathname;
    const spanName = `HTTP ${method} ${path}`;

    // Emit span as structured JSON to stdout. Collector agents (Vector, otelcol)
    // identify these records via the `"type":"span"` field and forward them to
    // the configured OTLP backend (Jaeger in docker-compose).
    const span: Record<string, unknown> = {
      type: "span",
      traceId,
      spanId,
      name: spanName,
      service: serviceName,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      durationMs,
      status: spanStatus,
      attributes: {
        "http.method": method,
        "http.url": path,
        "http.status_code": statusCode,
      },
    };

    // Only include parentSpanId when there actually is an upstream parent —
    // omitting the field (rather than setting it to null) matches the OTLP wire
    // format where root spans have no parentSpanId.
    if (parentSpanId !== undefined) {
      span["parentSpanId"] = parentSpanId;
    }

    process.stdout.write(JSON.stringify(span) + "\n");

    // When OTEL_EXPORTER_OTLP_ENDPOINT is set, also POST the span to the
    // collector's OTLP/HTTP endpoint.  This is fire-and-forget; failures are
    // silently swallowed so tracing never degrades request handling.
    const otlpEndpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
    if (otlpEndpoint) {
      exportSpanToOtlp(span, otlpEndpoint);
    }

    // W3C Trace Context response header — downstream services and browsers use
    // this to continue the trace without needing to contact the collector.
    c.res.headers.set("traceparent", `00-${traceId}-${spanId}-01`);

    // Server-Timing lets browser DevTools display backend latency in the
    // Network panel without exposing internal details.
    c.res.headers.set("server-timing", `total;dur=${durationMs}`);
  });
}
