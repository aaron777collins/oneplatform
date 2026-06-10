// Unit tests for services/proxy-service.ts — resolveUpstreamUrl logic.
//
// Only pure logic (resolveUpstreamUrl, getServiceTimeout) is covered here.
// proxyRequest requires a real Hono Context and a live network, so that path
// is not unit-tested in this file.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createProxyService } from "../services/proxy-service.js";

// ---------------------------------------------------------------------------
// We test with default service URLs (no env overrides).
// ---------------------------------------------------------------------------

const proxy = createProxyService();

// ---------------------------------------------------------------------------
// resolveUpstreamUrl — /api/v1/ prefix handling
// ---------------------------------------------------------------------------

describe("resolveUpstreamUrl — /api/v1/ prefix", () => {
  it("resolves /api/v1/auth to the auth service", () => {
    const r = proxy.resolveUpstreamUrl("/api/v1/auth");
    expect(r).not.toBeNull();
    expect(r!.serviceName).toBe("auth");
    expect(r!.serviceUrl).toContain("auth");
  });

  it("resolves /api/v1/auth/login (sub-path) to the auth service", () => {
    const r = proxy.resolveUpstreamUrl("/api/v1/auth/login");
    expect(r!.serviceName).toBe("auth");
  });

  it("resolves /api/v1/ontology to the ontology service", () => {
    const r = proxy.resolveUpstreamUrl("/api/v1/ontology");
    expect(r!.serviceName).toBe("ontology");
  });

  it("resolves /api/v1/ontology/entities/product to ontology", () => {
    const r = proxy.resolveUpstreamUrl("/api/v1/ontology/entities/product");
    expect(r!.serviceName).toBe("ontology");
  });

  it("resolves /api/v1/pipelines to the pipeline service", () => {
    const r = proxy.resolveUpstreamUrl("/api/v1/pipelines");
    expect(r!.serviceName).toBe("pipelines");
  });

  it("resolves /api/v1/pipeline-runs to the pipeline service", () => {
    const r = proxy.resolveUpstreamUrl("/api/v1/pipeline-runs");
    expect(r!.serviceName).toBe("pipeline-runs");
  });

  it("resolves /api/v1/schedules to the pipeline service", () => {
    const r = proxy.resolveUpstreamUrl("/api/v1/schedules");
    expect(r!.serviceName).toBe("schedules");
  });

  it("resolves /api/v1/exec to the execution service", () => {
    const r = proxy.resolveUpstreamUrl("/api/v1/exec");
    expect(r!.serviceName).toBe("exec");
  });

  it("resolves /api/v1/logs to the logging service", () => {
    const r = proxy.resolveUpstreamUrl("/api/v1/logs");
    expect(r!.serviceName).toBe("logs");
  });

  it("resolves /api/v1/audit-events to the logging service", () => {
    const r = proxy.resolveUpstreamUrl("/api/v1/audit-events");
    expect(r!.serviceName).toBe("audit-events");
  });

  it("resolves /api/v1/plugins to the plugin service", () => {
    const r = proxy.resolveUpstreamUrl("/api/v1/plugins");
    expect(r!.serviceName).toBe("plugins");
  });

  it("resolves /api/v1/roles to the auth service", () => {
    const r = proxy.resolveUpstreamUrl("/api/v1/roles");
    expect(r!.serviceName).toBe("roles");
  });

  it("resolves /api/v1/connectors to the ingestion service", () => {
    const r = proxy.resolveUpstreamUrl("/api/v1/connectors");
    expect(r!.serviceName).toBe("connectors");
  });

  it("resolves /api/v1/uploads to the ingestion service", () => {
    const r = proxy.resolveUpstreamUrl("/api/v1/uploads");
    expect(r!.serviceName).toBe("uploads");
  });
});

// ---------------------------------------------------------------------------
// resolveUpstreamUrl — longest-prefix matching (webhooks/inbound vs webhooks)
// ---------------------------------------------------------------------------

describe("resolveUpstreamUrl — longest-prefix matching", () => {
  it("resolves /api/v1/webhooks/inbound to ingestion (longer prefix wins)", () => {
    const r = proxy.resolveUpstreamUrl("/api/v1/webhooks/inbound");
    expect(r!.serviceName).toBe("webhooks/inbound");
  });

  it("resolves /api/v1/webhooks/inbound/payload to ingestion (longer prefix wins)", () => {
    const r = proxy.resolveUpstreamUrl("/api/v1/webhooks/inbound/payload");
    expect(r!.serviceName).toBe("webhooks/inbound");
  });

  it("resolves /api/v1/pipelines (not pipeline-runs) correctly", () => {
    const r = proxy.resolveUpstreamUrl("/api/v1/pipelines/abc");
    expect(r!.serviceName).toBe("pipelines");
  });

  it("resolves /api/v1/pipeline-runs/456 to pipeline service", () => {
    const r = proxy.resolveUpstreamUrl("/api/v1/pipeline-runs/456");
    expect(r!.serviceName).toBe("pipeline-runs");
  });
});

// ---------------------------------------------------------------------------
// resolveUpstreamUrl — /apps/* bypass (no /api/v1/ prefix)
// ---------------------------------------------------------------------------

describe("resolveUpstreamUrl — /apps/* bypass", () => {
  it("resolves /apps/my-app to the app service", () => {
    const r = proxy.resolveUpstreamUrl("/apps/my-app");
    expect(r!.serviceName).toBe("apps");
  });

  it("resolves /apps/slug/path/subpath to the app service", () => {
    const r = proxy.resolveUpstreamUrl("/apps/slug/path/subpath");
    expect(r!.serviceName).toBe("apps");
  });

  it("resolves apps/my-app (no leading slash) to the app service", () => {
    const r = proxy.resolveUpstreamUrl("apps/my-app");
    expect(r!.serviceName).toBe("apps");
  });

  it("also resolves /api/v1/apps to the app service", () => {
    const r = proxy.resolveUpstreamUrl("/api/v1/apps");
    expect(r!.serviceName).toBe("apps");
  });
});

// ---------------------------------------------------------------------------
// resolveUpstreamUrl — no leading slash / api/v1/ form
// ---------------------------------------------------------------------------

describe("resolveUpstreamUrl — path without leading slash", () => {
  it("resolves api/v1/auth (no leading slash) to auth service", () => {
    const r = proxy.resolveUpstreamUrl("api/v1/auth");
    expect(r!.serviceName).toBe("auth");
  });

  it("resolves api/v1/ontology/fields to ontology", () => {
    const r = proxy.resolveUpstreamUrl("api/v1/ontology/fields");
    expect(r!.serviceName).toBe("ontology");
  });
});

// ---------------------------------------------------------------------------
// resolveUpstreamUrl — unknown paths return null
// ---------------------------------------------------------------------------

describe("resolveUpstreamUrl — unknown paths return null", () => {
  it("returns null for /api/v1/unknown-service", () => {
    expect(proxy.resolveUpstreamUrl("/api/v1/unknown-service")).toBeNull();
  });

  it("returns null for /api/v1/", () => {
    expect(proxy.resolveUpstreamUrl("/api/v1/")).toBeNull();
  });

  it("returns null for /api/v2/auth (wrong version)", () => {
    expect(proxy.resolveUpstreamUrl("/api/v2/auth")).toBeNull();
  });

  it("returns null for / (root path)", () => {
    expect(proxy.resolveUpstreamUrl("/")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(proxy.resolveUpstreamUrl("")).toBeNull();
  });

  it("returns null for /health (no api prefix)", () => {
    expect(proxy.resolveUpstreamUrl("/health")).toBeNull();
  });

  it("returns null for a random string", () => {
    expect(proxy.resolveUpstreamUrl("foobar")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveUpstreamUrl — return shape
// ---------------------------------------------------------------------------

describe("resolveUpstreamUrl — return shape", () => {
  it("returned object has serviceUrl and serviceName properties", () => {
    const r = proxy.resolveUpstreamUrl("/api/v1/auth");
    expect(r).not.toBeNull();
    expect(typeof r!.serviceUrl).toBe("string");
    expect(typeof r!.serviceName).toBe("string");
  });

  it("serviceUrl is a non-empty string", () => {
    const r = proxy.resolveUpstreamUrl("/api/v1/pipelines");
    expect(r!.serviceUrl.length).toBeGreaterThan(0);
  });

  it("serviceUrl starts with http", () => {
    const r = proxy.resolveUpstreamUrl("/api/v1/logs");
    expect(r!.serviceUrl.startsWith("http")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getServiceTimeout
// ---------------------------------------------------------------------------

describe("getServiceTimeout", () => {
  it("returns a custom timeout for auth service (5000 ms default)", () => {
    expect(proxy.getServiceTimeout("auth")).toBe(5000);
  });

  it("returns a custom timeout for connectors service (30000 ms default)", () => {
    expect(proxy.getServiceTimeout("connectors")).toBe(30000);
  });

  it("returns a custom timeout for exec service (35000 ms default)", () => {
    expect(proxy.getServiceTimeout("exec")).toBe(35000);
  });

  it("returns the default timeout for services without a specific entry", () => {
    expect(proxy.getServiceTimeout("ontology")).toBe(10000);
  });

  it("returns the default timeout for an unknown service name", () => {
    expect(proxy.getServiceTimeout("nonexistent")).toBe(10000);
  });
});
