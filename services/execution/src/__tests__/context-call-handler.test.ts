// Unit tests for services/context-call-handler.ts
//
// Tests: SSRF blocklist (RFC 1918, localhost, link-local, internal services),
// DNS rebinding defence, hookContext guard, credential access enforcement,
// ontology lookup, error propagation via ContextCallResponse.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Logger } from "@oneplatform/core";
import { createContextCallHandler } from "../services/context-call-handler.js";
import type {
  ContextCallRequest,
  ExecutionContext,
} from "../services/context-call-handler.js";

// ---------------------------------------------------------------------------
// DNS resolver mock — injected via ContextCallHandlerDeps.dnsResolver
// ---------------------------------------------------------------------------
// We inject a fake DNS resolver instead of mocking the node:dns module so
// that the mock is entirely self-contained in the test file and unaffected by
// the beforeEach/afterEach lifecycle. Each test that needs a specific DNS
// resolution outcome can call resolver.resolve4.mockResolvedValueOnce([...]).

function makeDnsResolver(defaultIpv4 = ["1.1.1.1"], defaultIpv6: string[] = []) {
  return {
    resolve4: vi.fn<[string], Promise<string[]>>().mockResolvedValue(defaultIpv4),
    resolve6: vi.fn<[string], Promise<string[]>>().mockResolvedValue(defaultIpv6),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function makeDeps(dnsResolver = makeDnsResolver()) {
  return {
    logger: makeLogger(),
    ingestionServiceUrl: "http://ingestion:3000",
    pluginServiceUrl: "http://plugin:3001",
    pipelineServiceUrl: "http://pipeline:3002",
    serviceToken: "secret-service-token",
    dnsResolver,
  };
}

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    executionId: "exec-001",
    tenantId: "tenant-001",
    hookContext: false,
    executionType: "code",
    traceId: "trace-abc",
    ...overrides,
  };
}

function makeRequest(
  method: ContextCallRequest["method"],
  args: unknown[] = [],
  overrides: Partial<ContextCallRequest> = {},
): ContextCallRequest {
  return {
    id: "req-001",
    callId: "call-001",
    type: "contextCall",
    method,
    args,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SSRF blocklist — isUrlBlocked
// ---------------------------------------------------------------------------

describe("contextCallHandler — fetch SSRF protection", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const blockedUrls = [
    // localhost variants
    "http://localhost/api",
    "https://localhost:8080/hook",
    "http://127.0.0.1/secret",
    "http://127.0.0.2:3000/data",
    // RFC 1918 — 10.x.x.x
    "http://10.0.0.1/api",
    "http://10.255.255.255/endpoint",
    // RFC 1918 — 172.16.x.x – 172.31.x.x
    "http://172.16.0.1/internal",
    "http://172.31.255.255/secret",
    // RFC 1918 — 192.168.x.x
    "http://192.168.1.1/router",
    "http://192.168.0.100/api",
    // Link-local
    "http://169.254.169.254/latest/meta-data",
    // Internal service hostnames
    "http://ingestion.service:3000/api",
    "http://plugin.service/bundle",
    "https://internal.service:8080/api",
    // Non-HTTP/HTTPS schemes
    "file:///etc/passwd",
    "data:text/plain,hello",
    "ftp://example.com/file",
  ] as const;

  for (const url of blockedUrls) {
    it(`blocks ${url}`, async () => {
      const handler = createContextCallHandler(makeDeps());
      const response = await handler.handleContextCall(
        makeRequest("fetch", [url]),
        makeCtx(),
      );
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe("EXECUTION_FETCH_BLOCKED");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it("blocks 172.16 through 172.31 but not 172.15 (boundary check)", async () => {
    const handler = createContextCallHandler(makeDeps());

    // 172.15.x.x is NOT RFC 1918 — should be allowed (fetch will be called)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      redirected: false,
      url: "http://172.15.0.1/api",
      text: vi.fn().mockResolvedValue("{}"),
      headers: { get: vi.fn().mockReturnValue(null), entries: vi.fn().mockReturnValue([]) },
    });

    const response = await handler.handleContextCall(
      makeRequest("fetch", ["http://172.15.0.1/api"]),
      makeCtx(),
    );
    // 172.15 is not in RFC 1918 range — should not be blocked
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(response.error).toBeUndefined();
  });

  it("blocks 172.16.x.x (first RFC 1918 range boundary)", async () => {
    const handler = createContextCallHandler(makeDeps());
    const response = await handler.handleContextCall(
      makeRequest("fetch", ["http://172.16.0.1/api"]),
      makeCtx(),
    );
    expect(response.error?.code).toBe("EXECUTION_FETCH_BLOCKED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks 172.31.x.x (last RFC 1918 range boundary)", async () => {
    const handler = createContextCallHandler(makeDeps());
    const response = await handler.handleContextCall(
      makeRequest("fetch", ["http://172.31.0.1/api"]),
      makeCtx(),
    );
    expect(response.error?.code).toBe("EXECUTION_FETCH_BLOCKED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows publicly-routable HTTPS URLs", async () => {
    const handler = createContextCallHandler(makeDeps());
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      redirected: false,
      url: "https://api.github.com/repos",
      text: vi.fn().mockResolvedValue("{}"),
      headers: { get: vi.fn().mockReturnValue(null), entries: vi.fn().mockReturnValue([]) },
    });

    const response = await handler.handleContextCall(
      makeRequest("fetch", ["https://api.github.com/repos"]),
      makeCtx(),
    );
    expect(response.error).toBeUndefined();
    expect(response.result).toBeDefined();
  });

  it("allows publicly-routable HTTP URLs", async () => {
    const handler = createContextCallHandler(makeDeps());
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      redirected: false,
      url: "http://example.com/api",
      text: vi.fn().mockResolvedValue("data"),
      headers: { get: vi.fn().mockReturnValue(null), entries: vi.fn().mockReturnValue([]) },
    });

    const response = await handler.handleContextCall(
      makeRequest("fetch", ["http://example.com/api"]),
      makeCtx(),
    );
    expect(response.error).toBeUndefined();
  });

  it("blocks malformed URL with error code EXECUTION_FETCH_BLOCKED", async () => {
    const handler = createContextCallHandler(makeDeps());
    const response = await handler.handleContextCall(
      makeRequest("fetch", ["not-a-url"]),
      makeCtx(),
    );
    expect(response.error?.code).toBe("EXECUTION_FETCH_BLOCKED");
  });

  it("blocks when fetch URL arg is not a string", async () => {
    const handler = createContextCallHandler(makeDeps());
    const response = await handler.handleContextCall(
      makeRequest("fetch", [null]),
      makeCtx(),
    );
    expect(response.error?.code).toBe("EXECUTION_FETCH_BLOCKED");
  });

  it("returns response body, status, and headers on successful fetch", async () => {
    const handler = createContextCallHandler(makeDeps());
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      redirected: false,
      url: "https://api.example.com/data",
      text: vi.fn().mockResolvedValue('{"result":"ok"}'),
      headers: { get: vi.fn().mockReturnValue(null), entries: vi.fn().mockReturnValue([["content-type", "application/json"]]) },
    });

    const response = await handler.handleContextCall(
      makeRequest("fetch", ["https://api.example.com/data"]),
      makeCtx(),
    );
    const result = response.result as { ok: boolean; status: number; body: string };
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toBe('{"result":"ok"}');
  });

  it("blocks redirect to internal URL (3xx response from manual redirect mode)", async () => {
    // With redirect:'manual', a redirect returns a 3xx status. We check the
    // Location header and block it if it points to an internal address.
    const handler = createContextCallHandler(makeDeps());
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 302,
      statusText: "Found",
      redirected: false,
      url: "https://example.com/redirect",
      headers: {
        get: vi.fn().mockReturnValue("http://192.168.1.1/admin"),
        entries: vi.fn().mockReturnValue([["location", "http://192.168.1.1/admin"]]),
      },
    });

    const response = await handler.handleContextCall(
      makeRequest("fetch", ["https://example.com/redirect"]),
      makeCtx(),
    );
    expect(response.error?.code).toBe("EXECUTION_FETCH_BLOCKED");
  });

  it("blocks redirect via response.redirected + url (belt-and-suspenders)", async () => {
    // Some runtimes may expose response.url even in manual redirect mode.
    // The belt-and-suspenders check still catches this case.
    const handler = createContextCallHandler(makeDeps());
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      redirected: true,
      url: "http://192.168.1.1/admin", // redirect destination is internal
      text: vi.fn().mockResolvedValue(""),
      headers: { get: vi.fn().mockReturnValue(null), entries: vi.fn().mockReturnValue([]) },
    });

    const response = await handler.handleContextCall(
      makeRequest("fetch", ["https://example.com/redirect"]),
      makeCtx(),
    );
    expect(response.error?.code).toBe("EXECUTION_FETCH_BLOCKED");
  });
});

// ---------------------------------------------------------------------------
// hookContext guard — pipeline.trigger() blocked in hook chain
// ---------------------------------------------------------------------------

describe("contextCallHandler — hookContext guard", () => {
  it("blocks pipeline.trigger() when hookContext is true (dispatch boundary)", async () => {
    const handler = createContextCallHandler(makeDeps());
    const ctx = makeCtx({ hookContext: true });
    const response = await handler.handleContextCall(
      makeRequest("pipeline.trigger", ["pipeline-id-123"]),
      ctx,
    );
    expect(response.error).toBeDefined();
    expect(response.error?.code).toBe("EXECUTION_HOOK_RECURSION");
  });

  it("allows pipeline.trigger() when hookContext is false", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const handler = createContextCallHandler(makeDeps());
    const ctx = makeCtx({ hookContext: false });

    const response = await handler.handleContextCall(
      makeRequest("pipeline.trigger", ["pipeline-id-123"]),
      ctx,
    );

    expect(response.error).toBeUndefined();
    vi.restoreAllMocks();
  });

  it("returns EXECUTION_HOOK_RECURSION from the handlePipelineTrigger guard too", async () => {
    const handler = createContextCallHandler(makeDeps());
    const ctx = makeCtx({ hookContext: true });

    // Even if dispatch guard is bypassed, internal guard also blocks
    const response = await handler.handleContextCall(
      makeRequest("pipeline.trigger", ["pipe-x"]),
      ctx,
    );
    expect(response.error?.code).toBe("EXECUTION_HOOK_RECURSION");
  });

  it("returns error when pipelineId arg is missing (null)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const handler = createContextCallHandler(makeDeps());
    const ctx = makeCtx({ hookContext: false });

    const response = await handler.handleContextCall(
      makeRequest("pipeline.trigger", [null]), // null pipelineId
      ctx,
    );
    expect(response.error?.code).toBe("VALIDATION_ERROR");
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// credentials.get — access control
// ---------------------------------------------------------------------------

describe("contextCallHandler — credentials.get", () => {
  it("blocks credentials.get() for non-connector-run execution types", async () => {
    const handler = createContextCallHandler(makeDeps());
    const nonConnectorTypes = ["code", "app-build", "expression", "plugin-drain"] as const;

    for (const executionType of nonConnectorTypes) {
      const ctx = makeCtx({ executionType });
      const response = await handler.handleContextCall(
        makeRequest("credentials.get", ["api_key"]),
        ctx,
      );
      expect(response.error?.code).toBe("EXECUTION_CREDENTIALS_DENIED");
    }
  });

  it("blocks credentials.get() when no credentialBundleId in context", async () => {
    const handler = createContextCallHandler(makeDeps());
    const ctx = makeCtx({
      executionType: "connector-run",
    });

    const response = await handler.handleContextCall(
      makeRequest("credentials.get", ["api_key"]),
      ctx,
    );
    expect(response.error?.code).toBe("EXECUTION_CREDENTIALS_DENIED");
  });

  it("blocks credentials.get() when key arg is not a string", async () => {
    const handler = createContextCallHandler(makeDeps());
    const ctx = makeCtx({
      executionType: "connector-run",
      credentialBundleId: "bundle-001",
    });

    const response = await handler.handleContextCall(
      makeRequest("credentials.get", [null]), // null key
      ctx,
    );
    expect(response.error?.code).toBe("EXECUTION_CREDENTIALS_DENIED");
  });

  it("returns credential value for connector-run with valid context", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: { value: "secret-api-key" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const handler = createContextCallHandler(makeDeps());
    const ctx = makeCtx({
      executionType: "connector-run",
      credentialBundleId: "bundle-001",
    });

    const response = await handler.handleContextCall(
      makeRequest("credentials.get", ["api_key"]),
      ctx,
    );
    expect(response.error).toBeUndefined();
    expect(response.result).toBe("secret-api-key");

    vi.restoreAllMocks();
  });

  it("returns error when credential service returns non-200", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 404 });
    vi.stubGlobal("fetch", fetchMock);

    const handler = createContextCallHandler(makeDeps());
    const ctx = makeCtx({
      executionType: "connector-run",
      credentialBundleId: "bundle-001",
    });

    const response = await handler.handleContextCall(
      makeRequest("credentials.get", ["api_key"]),
      ctx,
    );
    expect(response.error?.code).toBe("EXECUTION_CREDENTIALS_DENIED");

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// credentials.list — access control
// ---------------------------------------------------------------------------

describe("contextCallHandler — credentials.list", () => {
  it("blocks credentials.list() for non-connector-run types", async () => {
    const handler = createContextCallHandler(makeDeps());
    const ctx = makeCtx({ executionType: "code" });

    const response = await handler.handleContextCall(
      makeRequest("credentials.list"),
      ctx,
    );
    expect(response.error?.code).toBe("EXECUTION_CREDENTIALS_DENIED");
  });

  it("returns keys list for valid connector-run context", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: { keys: ["api_key", "secret"] } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const handler = createContextCallHandler(makeDeps());
    const ctx = makeCtx({
      executionType: "connector-run",
      credentialBundleId: "bundle-001",
    });

    const response = await handler.handleContextCall(
      makeRequest("credentials.list"),
      ctx,
    );
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual(["api_key", "secret"]);

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// cache.get / cache.set / cache.delete
// ---------------------------------------------------------------------------

describe("contextCallHandler — cache operations", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("cache.get returns null when key is not a string", async () => {
    const handler = createContextCallHandler(makeDeps());
    const ctx = makeCtx({ pluginId: "plugin-001" });

    const response = await handler.handleContextCall(
      makeRequest("cache.get", [null]),
      ctx,
    );
    expect(response.error).toBeUndefined();
    expect(response.result).toBeNull();
  });

  it("cache.get returns error when no pluginId in context", async () => {
    const handler = createContextCallHandler(makeDeps());
    const ctx = makeCtx({});

    const response = await handler.handleContextCall(
      makeRequest("cache.get", ["my-key"]),
      ctx,
    );
    expect(response.error).toBeDefined();
    expect(response.error?.message).toContain("pluginId");
  });

  it("cache.get fetches from plugin service when key and pluginId are present", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: { value: "cached-value" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const handler = createContextCallHandler(makeDeps());
    const ctx = makeCtx({ pluginId: "plugin-001" });

    const response = await handler.handleContextCall(
      makeRequest("cache.get", ["my-key"]),
      ctx,
    );
    expect(response.result).toBe("cached-value");
  });

  it("cache.set sends PUT request to plugin service", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const handler = createContextCallHandler(makeDeps());
    const ctx = makeCtx({ pluginId: "plugin-001" });

    const response = await handler.handleContextCall(
      makeRequest("cache.set", ["my-key", { data: "value" }, 3600]),
      ctx,
    );
    expect(response.error).toBeUndefined();
    expect(response.result).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(callArgs[1].method).toBe("PUT");
  });

  it("cache.delete sends DELETE request to plugin service", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const handler = createContextCallHandler(makeDeps());
    const ctx = makeCtx({ pluginId: "plugin-001" });

    const response = await handler.handleContextCall(
      makeRequest("cache.delete", ["my-key"]),
      ctx,
    );
    expect(response.error).toBeUndefined();
    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(callArgs[1].method).toBe("DELETE");
  });
});

// ---------------------------------------------------------------------------
// ontology.getEntity — served from local snapshot
// ---------------------------------------------------------------------------

describe("contextCallHandler — ontology.getEntity", () => {
  it("returns entity from local snapshot when found", async () => {
    const handler = createContextCallHandler(makeDeps());
    const ctx = makeCtx({
      ontologySnapshot: {
        entities: [
          { name: "Product", fields: ["id", "name"] },
          { name: "Order", fields: ["id", "total"] },
        ],
      },
    });

    const response = await handler.handleContextCall(
      makeRequest("ontology.getEntity", ["Product"]),
      ctx,
    );
    expect(response.error).toBeUndefined();
    const entity = response.result as { name: string };
    expect(entity.name).toBe("Product");
  });

  it("returns null when entity name not found in snapshot", async () => {
    const handler = createContextCallHandler(makeDeps());
    const ctx = makeCtx({
      ontologySnapshot: { entities: [{ name: "Product" }] },
    });

    const response = await handler.handleContextCall(
      makeRequest("ontology.getEntity", ["NonExistent"]),
      ctx,
    );
    expect(response.result).toBeNull();
  });

  it("returns null when no snapshot in context", async () => {
    const handler = createContextCallHandler(makeDeps());
    const ctx = makeCtx({ ontologySnapshot: undefined });

    const response = await handler.handleContextCall(
      makeRequest("ontology.getEntity", ["Product"]),
      ctx,
    );
    expect(response.result).toBeNull();
  });

  it("returns null when entity name arg is not a string", async () => {
    const handler = createContextCallHandler(makeDeps());
    const ctx = makeCtx({ ontologySnapshot: { entities: [{ name: "Product" }] } });

    const response = await handler.handleContextCall(
      makeRequest("ontology.getEntity", [null]),
      ctx,
    );
    expect(response.result).toBeNull();
  });

  it("makes no network call for ontology.getEntity", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const handler = createContextCallHandler(makeDeps());
    const ctx = makeCtx({ ontologySnapshot: { entities: [] } });

    await handler.handleContextCall(
      makeRequest("ontology.getEntity", ["Product"]),
      ctx,
    );
    expect(fetchMock).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// Response envelope shape
// ---------------------------------------------------------------------------

describe("contextCallHandler — response envelope", () => {
  it("response has correct callId and type on success", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      redirected: false,
      url: "https://example.com/api",
      text: vi.fn().mockResolvedValue("ok"),
      headers: { get: vi.fn().mockReturnValue(null), entries: vi.fn().mockReturnValue([]) },
    });
    vi.stubGlobal("fetch", fetchMock);

    const handler = createContextCallHandler(makeDeps());
    const response = await handler.handleContextCall(
      makeRequest("fetch", ["https://example.com/api"], { callId: "call-xyz" }),
      makeCtx(),
    );
    expect(response.callId).toBe("call-xyz");
    expect(response.type).toBe("contextCallResponse");
    expect(response.error).toBeUndefined();

    vi.restoreAllMocks();
  });

  it("response has correct callId and type on error", async () => {
    const handler = createContextCallHandler(makeDeps());
    const response = await handler.handleContextCall(
      makeRequest("fetch", ["http://192.168.0.1/api"], { callId: "call-err" }),
      makeCtx(),
    );
    expect(response.callId).toBe("call-err");
    expect(response.type).toBe("contextCallResponse");
    expect(response.error).toBeDefined();
  });
});
