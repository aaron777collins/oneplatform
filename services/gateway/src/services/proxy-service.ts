import type { Context } from "hono";
import { ServiceUnavailableError } from "@oneplatform/core";
import type { AppVariables } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Service URL map (L2 §6.2)
// Each key is the route-prefix segment immediately after /api/v1/ in the
// request path. Values are overridable via environment variables so Docker
// Compose service names are not hardcoded in the binary.
// ---------------------------------------------------------------------------

const SERVICE_MAP: Record<string, string> = {
  auth: process.env["AUTH_SERVICE_URL"] ?? "http://auth-service:3000",
  connectors:
    process.env["INGESTION_SERVICE_URL"] ?? "http://ingestion-service:3000",
  "webhooks/inbound":
    process.env["INGESTION_SERVICE_URL"] ?? "http://ingestion-service:3000",
  uploads:
    process.env["INGESTION_SERVICE_URL"] ?? "http://ingestion-service:3000",
  ontology:
    process.env["ONTOLOGY_SERVICE_URL"] ?? "http://ontology-service:3000",
  pipelines:
    process.env["PIPELINE_SERVICE_URL"] ?? "http://pipeline-service:3000",
  "pipeline-runs":
    process.env["PIPELINE_SERVICE_URL"] ?? "http://pipeline-service:3000",
  schedules:
    process.env["PIPELINE_SERVICE_URL"] ?? "http://pipeline-service:3000",
  exec: process.env["EXECUTION_SERVICE_URL"] ?? "http://execution-service:3000",
  apps: process.env["APP_SERVICE_URL"] ?? "http://app-service:3000",
  logs: process.env["LOGGING_SERVICE_URL"] ?? "http://logging-service:3000",
  "audit-events":
    process.env["LOGGING_SERVICE_URL"] ?? "http://logging-service:3000",
  plugins: process.env["PLUGIN_SERVICE_URL"] ?? "http://plugin-service:3000",
  roles: process.env["AUTH_SERVICE_URL"] ?? "http://auth-service:3000",
  users: process.env["AUTH_SERVICE_URL"] ?? "http://auth-service:3000",
  "api-keys": process.env["AUTH_SERVICE_URL"] ?? "http://auth-service:3000",
  "tenants": process.env["AUTH_SERVICE_URL"] ?? "http://auth-service:3000",
  "bootstrap": process.env["AUTH_SERVICE_URL"] ?? "http://auth-service:3000",
  "marketplace": process.env["PLUGIN_SERVICE_URL"] ?? "http://plugin-service:3000",
};

// Per-service timeout defaults (L2 §6.4).
const SERVICE_TIMEOUT_MS: Record<string, number> = {
  auth: parseInt(process.env["OP_PROXY_TIMEOUT_AUTH_MS"] ?? "5000", 10),
  connectors: parseInt(
    process.env["OP_PROXY_TIMEOUT_INGESTION_MS"] ?? "30000",
    10
  ),
  "webhooks/inbound": parseInt(
    process.env["OP_PROXY_TIMEOUT_INGESTION_MS"] ?? "30000",
    10
  ),
  uploads: parseInt(
    process.env["OP_PROXY_TIMEOUT_INGESTION_MS"] ?? "30000",
    10
  ),
  exec: parseInt(
    process.env["OP_PROXY_TIMEOUT_EXECUTION_MS"] ?? "35000",
    10
  ),
};

const DEFAULT_TIMEOUT_MS = parseInt(
  process.env["OP_PROXY_TIMEOUT_DEFAULT_MS"] ?? "10000",
  10
);

// Headers injected by clients that must never reach an upstream service.
// Stripping them prevents callers from spoofing identity or service tokens.
// x-user-context must be stripped because the gateway rebuilds it from the
// verified JWT claims — allowing external injection would let any caller
// impersonate an arbitrary user even when X-Service-Token is also valid.
const HEADERS_TO_STRIP = new Set([
  "x-service-token",
  "x-oneplatform-tenant-id",
  "x-oneplatform-user-id",
  "x-oneplatform-user-roles",
  "x-oneplatform-key-id",
  "x-user-context",
  "x-user-context-signature",
  "x-real-ip",
  "x-forwarded-for",
  "x-forwarded-proto",
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ResolvedUpstream {
  serviceUrl: string;
  serviceName: string;
}

export interface ProxyRequestOptions {
  timeoutMs?: number;
  serviceName: string;
  tenantId?: string;
  userId?: string;
  roles?: string[];
  keyId?: string;
  requestId?: string;
  serviceToken?: string;
}

// ---------------------------------------------------------------------------
// ProxyService — object interface used by route handlers
// ---------------------------------------------------------------------------

export interface ProxyService {
  resolveUpstreamUrl(path: string): ResolvedUpstream | null;
  proxyRequest(
    c: Context<{ Variables: AppVariables }>,
    upstreamUrl: string,
    options: ProxyRequestOptions
  ): Promise<Response>;
  getServiceTimeout(serviceName: string): number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createProxyService(): ProxyService {
  // Sorted keys descending by length so multi-segment keys like
  // "webhooks/inbound" are matched before their shorter prefix "webhooks".
  const sortedServiceKeys = Object.keys(SERVICE_MAP).sort(
    (a, b) => b.length - a.length
  );

  function resolveUpstreamUrl(path: string): ResolvedUpstream | null {
    // Strip the leading /api/v1/ prefix to get the service segment.
    const stripped = path.startsWith("/api/v1/")
      ? path.slice("/api/v1/".length)
      : path.startsWith("api/v1/")
      ? path.slice("api/v1/".length)
      : null;

    if (stripped === null) {
      // /apps/:slug/* paths bypass the /api/v1/ prefix entirely
      if (path.startsWith("/apps/") || path.startsWith("apps/")) {
        const serviceUrl = SERVICE_MAP["apps"];
        if (serviceUrl !== undefined) {
          return { serviceUrl, serviceName: "apps" };
        }
      }
      return null;
    }

    for (const key of sortedServiceKeys) {
      if (stripped === key || stripped.startsWith(key + "/")) {
        const serviceUrl = SERVICE_MAP[key];
        if (serviceUrl !== undefined) {
          return { serviceUrl, serviceName: key };
        }
      }
    }

    return null;
  }

  function getServiceTimeout(serviceName: string): number {
    return SERVICE_TIMEOUT_MS[serviceName] ?? DEFAULT_TIMEOUT_MS;
  }

  async function proxyRequest(
    c: Context<{ Variables: AppVariables }>,
    upstreamUrl: string,
    options: ProxyRequestOptions
  ): Promise<Response> {
    const {
      serviceName,
      tenantId,
      userId,
      roles,
      keyId,
      requestId = "",
      serviceToken,
    } = options;

    const timeoutMs = options.timeoutMs ?? getServiceTimeout(serviceName);

    // Reconstruct the target URL: use the full upstreamUrl as-is when it
    // already contains the path (as passed by proxy.ts routes), otherwise
    // append the inbound path.
    const targetUrl = upstreamUrl.startsWith("http")
      ? upstreamUrl
      : new URL(
          new URL(c.req.url).pathname + new URL(c.req.url).search,
          upstreamUrl
        ).toString();

    // Clone inbound headers, stripping any that could be used for spoofing.
    const outboundHeaders = new Headers();
    c.req.raw.headers.forEach((value, name) => {
      if (!HEADERS_TO_STRIP.has(name.toLowerCase())) {
        outboundHeaders.set(name, value);
      }
    });

    // Set x-forwarded-for from the actual TCP connection, not from client-supplied headers.
    // Client-supplied x-forwarded-for is already stripped via HEADERS_TO_STRIP.
    const remoteAddress = (c.req.raw as unknown as { socket?: { remoteAddress?: string } })
      .socket?.remoteAddress ?? "unknown";
    outboundHeaders.set("x-forwarded-for", remoteAddress);

    // Detect actual protocol from the inbound request instead of hardcoding https
    const isHttps = c.req.url.startsWith("https://")
      || process.env["OP_FORCE_HTTPS"] === "true";
    outboundHeaders.set("x-forwarded-proto", isHttps ? "https" : "http");
    outboundHeaders.set("x-oneplatform-request-id", requestId);

    if (tenantId !== undefined) {
      outboundHeaders.set("x-oneplatform-tenant-id", tenantId);
    }
    if (userId !== undefined) {
      outboundHeaders.set("x-oneplatform-user-id", userId);
    }
    if (roles !== undefined && roles.length > 0) {
      outboundHeaders.set("x-oneplatform-user-roles", roles.join(","));
    }
    if (keyId !== undefined) {
      outboundHeaders.set("x-oneplatform-key-id", keyId);
    }
    if (serviceToken !== undefined) {
      outboundHeaders.set("x-service-token", serviceToken);
    }

    // Propagate W3C Trace Context
    const traceParent = c.req.header("traceparent");
    if (traceParent !== undefined) {
      outboundHeaders.set("traceparent", traceParent);
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    // GET and HEAD requests must not have a body per the Fetch API spec.
    const hasBody =
      c.req.method !== "GET" &&
      c.req.method !== "HEAD" &&
      c.req.raw.body !== null;

    try {
      const response = await fetch(targetUrl, {
        method: c.req.method,
        headers: outboundHeaders,
        // Spread body conditionally — exactOptionalPropertyTypes forbids
        // assigning undefined to RequestInit.body.
        ...(hasBody ? { body: c.req.raw.body } : {}),
        signal: controller.signal,
        // Pass redirect responses through verbatim; upstreams should not
        // redirect, but if they do the client should receive the 3xx.
        redirect: "manual",
      });

      return response;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new ServiceUnavailableError(
          `The ${serviceName} service did not respond in time. Please try again.`,
          { service: serviceName, timeoutMs }
        );
      }
      throw new ServiceUnavailableError(
        `The ${serviceName} service is unavailable. Please try again.`,
        {
          service: serviceName,
          cause: err instanceof Error ? err.message : String(err),
        }
      );
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  return { resolveUpstreamUrl, proxyRequest, getServiceTimeout };
}
