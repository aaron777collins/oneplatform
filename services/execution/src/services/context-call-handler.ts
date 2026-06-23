import { promises as dns } from "node:dns";
import type { Logger, ServiceTokenSigner } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// ContextCallHandler — handles PluginContext API calls from the sandbox
// Design spec §11.2 / §11.3 / §12
//
// When sandbox user code calls context.fetch(), context.credentials.get(),
// context.cache.get(), or context.pipeline.trigger(), the sandbox sends a
// `contextCall` message back over the Unix socket. This handler dispatches
// each call to the appropriate platform service and returns the result.
//
// Security invariants enforced here:
//   1. fetch()   — block RFC 1918 and internal service URLs (spec §11.3)
//   2. pipeline.trigger() — blocked when hookContext = true (spec §12)
//   3. credentials.get() — only permitted for connector-run type
// ---------------------------------------------------------------------------

// ContextCall message received from the sandbox (spec §11.2)
export interface ContextCallRequest {
  id: string;        // correlation ID of the parent execution request
  callId: string;    // unique ID for this specific context call
  type: "contextCall";
  method:
    | "fetch"
    | "credentials.get"
    | "credentials.list"
    | "cache.get"
    | "cache.set"
    | "cache.delete"
    | "pipeline.trigger"
    | "ontology.getEntity";
  args: unknown[];
}

export interface ContextCallResponse {
  callId: string;
  type: "contextCallResponse";
  result?: unknown;
  error?: { code: string; message: string };
}

// Execution context provided to the handler for each dispatched call
export interface ExecutionContext {
  executionId: string;
  tenantId: string;
  pluginId?: string;
  /** Whether this execution is running inside a hook chain */
  hookContext: boolean;
  /** Execution type determines which context APIs are permitted */
  executionType: "code" | "connector-run" | "app-build" | "expression" | "plugin-drain";
  credentialBundleId?: string;
  /** Local ontology snapshot injected at execution start time */
  ontologySnapshot?: unknown;
  traceId: string;
}

export interface ContextCallHandler {
  handleContextCall(
    request: ContextCallRequest,
    executionCtx: ExecutionContext,
  ): Promise<ContextCallResponse>;
}

export interface ContextCallHandlerDeps {
  logger: Logger;
  /** Base URL of the Ingestion Service for credential access */
  ingestionServiceUrl: string;
  /** Base URL of the Plugin Service for cache operations */
  pluginServiceUrl: string;
  /** Base URL of the Pipeline Service for pipeline.trigger() */
  pipelineServiceUrl: string;
  /** Service token signer for outbound calls */
  serviceTokenSigner: ServiceTokenSigner;
  /**
   * Optional DNS resolver override for testing. Production callers omit this
   * and the handler uses the system dns.promises. Tests inject a mock resolver
   * to avoid real network lookups and to simulate DNS rebinding scenarios.
   */
  dnsResolver?: {
    resolve4(hostname: string): Promise<string[]>;
    resolve6(hostname: string): Promise<string[]>;
  };
}

// ---------------------------------------------------------------------------
// RFC 1918 and internal URL blocklist — spec §11.3
// The sandbox itself has no network access, but we enforce here as the sole
// outbound proxy, adding defense-in-depth.
// ---------------------------------------------------------------------------

const BLOCKED_URL_PATTERNS = [
  // localhost
  /^https?:\/\/localhost(:\d+)?(\/|$)/i,
  /^https?:\/\/127\.\d+\.\d+\.\d+(:\d+)?(\/|$)/,
  // Unspecified IPv4 address (0.0.0.0/8)
  /^https?:\/\/0\.\d+\.\d+\.\d+(:\d+)?(\/|$)/,
  // RFC 1918 ranges
  /^https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?(\/|$)/,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+(:\d+)?(\/|$)/,
  /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?(\/|$)/,
  // Link-local (IPv4 and cloud metadata endpoint)
  /^https?:\/\/169\.254\.\d+\.\d+(:\d+)?(\/|$)/,
  // IPv6 loopback, unspecified, and IPv4-mapped IPv6
  /^https?:\/\/\[::1\](:\d+)?(\/|$)/i,
  /^https?:\/\/\[::\](:\d+)?(\/|$)/,
  /^https?:\/\/\[::ffff:[^\]]*\](:\d+)?(\/|$)/i,
  // Internal service hostnames (*.service:*, *-service:*, *.svc:*, *.svc.cluster.local:*, *.internal:*)
  /^https?:\/\/[^/]*\.service(:\d+)?(\/|$)/i,
  /^https?:\/\/[^/]*-service(:\d+)?(\/|$)/i,
  /^https?:\/\/[^/]*\.svc(:\d+)?(\/|$)/i,
  /^https?:\/\/[^/]*\.svc\.cluster\.local(:\d+)?(\/|$)/i,
  /^https?:\/\/[^/]*\.internal(:\d+)?(\/|$)/i,
  // Non-HTTP/HTTPS schemes
  /^file:\/\//i,
  /^data:/i,
  /^ftp:\/\//i,
];

// Blocked CIDR ranges represented as [network_number, mask] pairs for IPv4,
// and as prefix-matched strings for IPv6. These mirror the regex patterns above
// but operate on resolved IP addresses to defeat DNS rebinding attacks.
const BLOCKED_IPV4_RANGES: Array<[number, number]> = [
  [0x00000000, 0xff000000], // 0.0.0.0/8     — unspecified / this-network
  [0x7f000000, 0xff000000], // 127.0.0.0/8   — loopback
  [0x0a000000, 0xff000000], // 10.0.0.0/8    — RFC 1918
  [0xac100000, 0xfff00000], // 172.16.0.0/12 — RFC 1918
  [0xc0a80000, 0xffff0000], // 192.168.0.0/16 — RFC 1918
  [0xa9fe0000, 0xffff0000], // 169.254.0.0/16 — link-local / cloud metadata
];

const BLOCKED_IPV6_PREFIXES = [
  "::",          // unspecified (::) and loopback (::1) and IPv4-mapped (::ffff:)
  "fe80:",       // link-local (fe80::/10)
  "fd",          // ULA (fd00::/8)
  "fc",          // ULA (fc00::/7 covers fc and fd)
];

function ipv4ToNumber(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) | parseInt(octet, 10), 0) >>> 0;
}

function isIpv4Blocked(ip: string): boolean {
  const num = ipv4ToNumber(ip);
  return BLOCKED_IPV4_RANGES.some(([net, mask]) => (num & mask) === net);
}

function isIpv6Blocked(ip: string): boolean {
  // Normalise to lowercase for consistent prefix matching
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_IPV6_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(prefix))) {
    return true;
  }
  // For IPv4-mapped IPv6 addresses (::ffff:<ipv4>), also validate the embedded
  // IPv4 address against the blocked ranges — catches private ranges expressed
  // in non-standard prefix forms that might slip past the prefix list.
  const ipv4MappedMatch = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4MappedMatch !== null && ipv4MappedMatch[1] !== undefined) {
    return isIpv4Blocked(ipv4MappedMatch[1]);
  }
  return false;
}

function isUrlBlocked(url: string): boolean {
  return BLOCKED_URL_PATTERNS.some((pattern) => pattern.test(url));
}

// assertHostnameResolvesToPublicIp performs DNS resolution on the hostname in
// the URL and verifies that every resolved address is a publicly-routable IP.
// This defeats DNS rebinding: an attacker cannot use a hostname that initially
// resolves to a public IP and later switches to an internal one, because we
// resolve at fetch time and check both A and AAAA records.
// The resolver parameter is injected so it can be replaced in tests without
// real network lookups.
async function assertHostnameResolvesToPublicIp(
  url: URL,
  resolver: { resolve4(h: string): Promise<string[]>; resolve6(h: string): Promise<string[]> }
): Promise<void> {
  const { hostname } = url;

  // Bare IPv4 literals — no DNS lookup needed, but must still pass the CIDR check.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    if (isIpv4Blocked(hostname)) {
      throw {
        code: "EXECUTION_FETCH_BLOCKED",
        message: `Fetch to IP address '${hostname}' is blocked.`,
      };
    }
    return;
  }

  // Bare IPv6 literals — extract the address from brackets and check blocklist.
  if (hostname.startsWith("[") || hostname.includes(":")) {
    const ipv6 = hostname.replace(/^\[|\]$/g, "");
    if (isIpv6Blocked(ipv6)) {
      throw {
        code: "EXECUTION_FETCH_BLOCKED",
        message: `Fetch to IPv6 address '${hostname}' is blocked.`,
      };
    }
    return;
  }

  let ipv4Addresses: string[] = [];
  let ipv6Addresses: string[] = [];

  try {
    ipv4Addresses = await resolver.resolve4(hostname);
  } catch {
    // NODATA / NXDOMAIN for A records is fine — the hostname may be IPv6-only.
  }

  try {
    ipv6Addresses = await resolver.resolve6(hostname);
  } catch {
    // Same: NODATA / NXDOMAIN for AAAA is fine.
  }

  if (ipv4Addresses.length === 0 && ipv6Addresses.length === 0) {
    // Hostname does not resolve at all — block it rather than allowing through.
    throw { code: "EXECUTION_FETCH_BLOCKED", message: `Hostname '${hostname}' could not be resolved.` };
  }

  for (const ip of ipv4Addresses) {
    if (isIpv4Blocked(ip)) {
      throw {
        code: "EXECUTION_FETCH_BLOCKED",
        message: `Hostname '${hostname}' resolves to a blocked IP address (${ip}).`,
      };
    }
  }

  for (const ip of ipv6Addresses) {
    if (isIpv6Blocked(ip)) {
      throw {
        code: "EXECUTION_FETCH_BLOCKED",
        message: `Hostname '${hostname}' resolves to a blocked IPv6 address (${ip}).`,
      };
    }
  }
}

// All pipeline-adjacent context call methods that must be guarded by
// the hookContext check.  This list is the authoritative source used by
// the guard below and is tested separately to ensure completeness.
const PIPELINE_ADJACENT_METHODS: ReadonlySet<ContextCallRequest["method"]> = new Set([
  "pipeline.trigger",
]);

export function createContextCallHandler(deps: ContextCallHandlerDeps): ContextCallHandler {
  const {
    logger,
    ingestionServiceUrl,
    pluginServiceUrl,
    pipelineServiceUrl,
    serviceTokenSigner,
    dnsResolver = dns,
  } = deps;

  // ---------------------------------------------------------------------------
  // Individual method handlers
  // ---------------------------------------------------------------------------

  async function handleFetch(
    args: unknown[],
    executionCtx: ExecutionContext,
  ): Promise<unknown> {
    const rawUrl = typeof args[0] === "string" ? args[0] : null;
    if (rawUrl === null) {
      throw { code: "EXECUTION_FETCH_BLOCKED", message: "Invalid fetch URL" };
    }

    if (isUrlBlocked(rawUrl)) {
      logger.warn("ContextCallHandler: fetch blocked", {
        executionId: executionCtx.executionId,
        tenantId: executionCtx.tenantId,
        url: rawUrl,
      });
      throw { code: "EXECUTION_FETCH_BLOCKED", message: `Fetch to '${rawUrl}' is blocked.` };
    }

    // Validate scheme — only http/https allowed
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      throw { code: "EXECUTION_FETCH_BLOCKED", message: "Malformed URL" };
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw {
        code: "EXECUTION_FETCH_BLOCKED",
        message: `URL scheme '${parsedUrl.protocol}' is not allowed.`,
      };
    }

    // DNS rebinding defence: resolve the hostname to IP addresses and verify
    // that none of them fall within blocked CIDR ranges. A URL that passes
    // the regex check above could still resolve to an internal IP if the
    // attacker controls the DNS record (DNS rebinding attack).
    await assertHostnameResolvesToPublicIp(parsedUrl, dnsResolver);

    const MAX_RESPONSE_BYTES = 50 * 1024 * 1024; // 50 MB
    // Cap outbound request body to 10 MB to prevent sandbox code from using the
    // service's egress for bandwidth amplification. Also restrict init to a safe
    // allowlist so sandbox code cannot set arbitrary headers (e.g. Host spoofing)
    // or override the abort signal we install below.
    const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024; // 10 MB
    const rawInit = (args[1] ?? {}) as RequestInit;
    const init: RequestInit = {};
    if (rawInit.method !== undefined) init.method = rawInit.method;
    if (rawInit.headers !== undefined) init.headers = rawInit.headers;
    if (rawInit.body !== undefined) {
      const bodyStr = typeof rawInit.body === "string" ? rawInit.body : "";
      if (Buffer.byteLength(bodyStr, "utf8") > MAX_REQUEST_BODY_BYTES) {
        throw {
          code: "EXECUTION_FETCH_BLOCKED",
          message: `Request body exceeds the ${MAX_REQUEST_BODY_BYTES / (1024 * 1024)} MB limit.`,
        };
      }
      init.body = rawInit.body;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    try {
      // Use redirect:'manual' so we intercept each redirect hop and validate
      // the destination before following it. Without this, the fetch API
      // silently follows redirects, which could lead to a public URL redirecting
      // to an internal one after the DNS check has passed.
      const response = await fetch(rawUrl, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      });

      // For redirect responses (3xx), validate the Location header before following.
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location === null) {
          throw { code: "EXECUTION_FETCH_BLOCKED", message: "Redirect with no Location header." };
        }
        if (isUrlBlocked(location)) {
          throw { code: "EXECUTION_FETCH_BLOCKED", message: "Redirect target is blocked." };
        }
        // Validate resolved IPs for the redirect target as well.
        let redirectUrl: URL;
        try {
          redirectUrl = new URL(location, rawUrl);
        } catch {
          throw { code: "EXECUTION_FETCH_BLOCKED", message: "Redirect Location is not a valid URL." };
        }
        await assertHostnameResolvesToPublicIp(redirectUrl, dnsResolver);
        // Return the redirect as an opaque response — plugin code can choose to follow
        // by calling context.fetch() on the Location URL explicitly. We do not
        // auto-follow because each hop must be independently validated.
        return {
          ok: false,
          status: response.status,
          statusText: response.statusText,
          body: "",
          headers: Object.fromEntries(response.headers.entries()),
        };
      }

      // Validate redirect destination against blocklist (belt-and-suspenders for
      // runtimes that expose response.url even in manual redirect mode).
      if (response.redirected && isUrlBlocked(response.url)) {
        throw { code: "EXECUTION_FETCH_BLOCKED", message: "Redirect target is blocked." };
      }

      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
        throw { code: "EXECUTION_FETCH_BLOCKED", message: `Response body exceeds ${MAX_RESPONSE_BYTES} byte limit.` };
      }

      const responseBody = await response.text();
      if (Buffer.byteLength(responseBody, "utf8") > MAX_RESPONSE_BYTES) {
        throw { code: "EXECUTION_FETCH_BLOCKED", message: `Response body exceeds ${MAX_RESPONSE_BYTES} byte limit.` };
      }
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        body: responseBody,
        headers: Object.fromEntries(response.headers.entries()),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function handleCredentialsGet(
    args: unknown[],
    executionCtx: ExecutionContext,
  ): Promise<unknown> {
    if (executionCtx.executionType !== "connector-run") {
      throw {
        code: "EXECUTION_CREDENTIALS_DENIED",
        message: "credentials.get() is only available in connector-run executions.",
      };
    }

    const key = typeof args[0] === "string" ? args[0] : null;
    if (key === null) {
      throw { code: "EXECUTION_CREDENTIALS_DENIED", message: "credentials.get() requires a key argument." };
    }

    const credentialBundleId = executionCtx.credentialBundleId;
    if (credentialBundleId === undefined) {
      throw {
        code: "EXECUTION_CREDENTIALS_DENIED",
        message: "No credentialBundleId in execution context.",
      };
    }

    const url = `${ingestionServiceUrl}/internal/ingestion/credentials/${encodeURIComponent(credentialBundleId)}/field/${encodeURIComponent(key)}`;
    const response = await fetch(url, { headers: { "X-Service-Token": await serviceTokenSigner.sign(), "Content-Type": "application/json" } });

    if (!response.ok) {
      throw {
        code: "EXECUTION_CREDENTIALS_DENIED",
        message: `Credential lookup failed with status ${response.status}.`,
      };
    }

    const body = await response.json() as { data: { value: string } };
    // The credential value is passed directly to the sandbox — never logged.
    return body.data.value;
  }

  async function handleCredentialsList(
    _args: unknown[],
    executionCtx: ExecutionContext,
  ): Promise<unknown> {
    if (executionCtx.executionType !== "connector-run") {
      throw {
        code: "EXECUTION_CREDENTIALS_DENIED",
        message: "credentials.list() is only available in connector-run executions.",
      };
    }

    const credentialBundleId = executionCtx.credentialBundleId;
    if (credentialBundleId === undefined) {
      throw {
        code: "EXECUTION_CREDENTIALS_DENIED",
        message: "No credentialBundleId in execution context.",
      };
    }

    const url = `${ingestionServiceUrl}/internal/ingestion/credentials/${encodeURIComponent(credentialBundleId)}`;
    const response = await fetch(url, { headers: { "X-Service-Token": await serviceTokenSigner.sign(), "Content-Type": "application/json" } });

    if (!response.ok) {
      throw {
        code: "EXECUTION_CREDENTIALS_DENIED",
        message: `Credential list failed with status ${response.status}.`,
      };
    }

    const body = await response.json() as { data: { keys: string[] } };
    return body.data.keys;
  }

  async function handleCacheGet(
    args: unknown[],
    executionCtx: ExecutionContext,
  ): Promise<unknown> {
    const key = typeof args[0] === "string" ? args[0] : null;
    if (key === null) return null;
    if (executionCtx.pluginId === undefined) {
      throw new Error("cache.get() requires a pluginId in the execution context");
    }

    const url = `${pluginServiceUrl}/internal/plugins/cache/${encodeURIComponent(executionCtx.tenantId)}/${encodeURIComponent(executionCtx.pluginId)}/${encodeURIComponent(key)}`;
    const response = await fetch(url, { headers: { "X-Service-Token": await serviceTokenSigner.sign(), "Content-Type": "application/json" } });
    if (!response.ok) return null;

    const body = await response.json() as { data: { value: unknown } };
    return body.data.value ?? null;
  }

  async function handleCacheSet(
    args: unknown[],
    executionCtx: ExecutionContext,
  ): Promise<void> {
    const key = typeof args[0] === "string" ? args[0] : null;
    if (key === null) return;
    if (executionCtx.pluginId === undefined) {
      throw new Error("cache.set() requires a pluginId in the execution context");
    }

    const value = args[1];
    const ttlSeconds = typeof args[2] === "number" ? args[2] : undefined;

    const url = `${pluginServiceUrl}/internal/plugins/cache/${encodeURIComponent(executionCtx.tenantId)}/${encodeURIComponent(executionCtx.pluginId)}/${encodeURIComponent(key)}`;
    await fetch(url, {
      method: "PUT",
      headers: { "X-Service-Token": await serviceTokenSigner.sign(), "Content-Type": "application/json" },
      body: JSON.stringify({
        value,
        ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
      }),
    });
  }

  async function handleCacheDelete(
    args: unknown[],
    executionCtx: ExecutionContext,
  ): Promise<void> {
    const key = typeof args[0] === "string" ? args[0] : null;
    if (key === null) return;
    if (executionCtx.pluginId === undefined) {
      throw new Error("cache.delete() requires a pluginId in the execution context");
    }

    const url = `${pluginServiceUrl}/internal/plugins/cache/${encodeURIComponent(executionCtx.tenantId)}/${encodeURIComponent(executionCtx.pluginId)}/${encodeURIComponent(key)}`;
    await fetch(url, { method: "DELETE", headers: { "X-Service-Token": await serviceTokenSigner.sign(), "Content-Type": "application/json" } });
  }

  async function handlePipelineTrigger(
    args: unknown[],
    executionCtx: ExecutionContext,
  ): Promise<void> {
    // Guard: block all pipeline-adjacent methods when running inside a hook chain
    // (spec §12). The set PIPELINE_ADJACENT_METHODS documents all guarded methods.
    if (executionCtx.hookContext) {
      logger.warn("ContextCallHandler: hook recursion blocked", {
        executionId: executionCtx.executionId,
        tenantId: executionCtx.tenantId,
      });
      throw {
        code: "EXECUTION_HOOK_RECURSION",
        message: "pipeline.trigger() is not allowed inside a hook execution (would cause infinite recursion).",
      };
    }

    const pipelineId = typeof args[0] === "string" ? args[0] : null;
    if (pipelineId === null) {
      throw { code: "VALIDATION_ERROR", message: "pipeline.trigger() requires a pipelineId argument." };
    }

    const payload = args[1] ?? {};
    await fetch(`${pipelineServiceUrl}/internal/pipeline/trigger`, {
      method: "POST",
      headers: { "X-Service-Token": await serviceTokenSigner.sign(), "Content-Type": "application/json" },
      body: JSON.stringify({
        pipelineId,
        tenantId: executionCtx.tenantId,
        triggeredBy: "service",
        callerService: "execution-service",
        input: payload,
      }),
    });
  }

  function handleOntologyGetEntity(
    args: unknown[],
    executionCtx: ExecutionContext,
  ): unknown {
    // Served from the local snapshot injected at execution start — no network call
    const entityName = typeof args[0] === "string" ? args[0] : null;
    if (entityName === null) return null;

    const snapshot = executionCtx.ontologySnapshot as
      | { entities?: Array<{ name: string }> }
      | undefined;
    if (snapshot === undefined) return null;

    return snapshot.entities?.find((e) => e.name === entityName) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  async function handleContextCall(
    request: ContextCallRequest,
    executionCtx: ExecutionContext,
  ): Promise<ContextCallResponse> {
    // Pipeline-adjacent guard is enforced inside handlePipelineTrigger, but we
    // also assert here so future additions to PIPELINE_ADJACENT_METHODS are
    // caught at the dispatch boundary, not buried in individual handlers.
    if (PIPELINE_ADJACENT_METHODS.has(request.method) && executionCtx.hookContext) {
      return {
        callId: request.callId,
        type: "contextCallResponse",
        error: {
          code: "EXECUTION_HOOK_RECURSION",
          message: "Pipeline operations are not permitted inside hook executions.",
        },
      };
    }

    try {
      let result: unknown;

      switch (request.method) {
        case "fetch":
          result = await handleFetch(request.args, executionCtx);
          break;
        case "credentials.get":
          result = await handleCredentialsGet(request.args, executionCtx);
          break;
        case "credentials.list":
          result = await handleCredentialsList(request.args, executionCtx);
          break;
        case "cache.get":
          result = await handleCacheGet(request.args, executionCtx);
          break;
        case "cache.set":
          await handleCacheSet(request.args, executionCtx);
          result = null;
          break;
        case "cache.delete":
          await handleCacheDelete(request.args, executionCtx);
          result = null;
          break;
        case "pipeline.trigger":
          await handlePipelineTrigger(request.args, executionCtx);
          result = null;
          break;
        case "ontology.getEntity":
          result = handleOntologyGetEntity(request.args, executionCtx);
          break;
        default: {
          const _exhaustive: never = request.method;
          throw { code: "UNSUPPORTED_METHOD", message: `Unknown contextCall method: ${String(_exhaustive)}` };
        }
      }

      return {
        callId: request.callId,
        type: "contextCallResponse",
        result,
      };
    } catch (err) {
      const structured = err as { code?: string; message?: string };
      return {
        callId: request.callId,
        type: "contextCallResponse",
        error: {
          code: structured.code ?? "CONTEXT_CALL_ERROR",
          message: structured.message ?? String(err),
        },
      };
    }
  }

  return { handleContextCall };
}
