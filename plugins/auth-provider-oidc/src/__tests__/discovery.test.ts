/**
 * Unit tests for OIDC discovery document fetching.
 *
 * Covers:
 *   - buildDiscoveryUrl: URL construction (trailing slash normalisation)
 *   - fetchDiscoveryDocument: caching, HTTP error handling, field validation
 */

import { describe, it, expect } from "vitest";
import { createMockContext } from "@oneplatform/plugin-sdk/testing";
import { PluginConfigError, PluginAuthError } from "@oneplatform/plugin-sdk";
import { buildDiscoveryUrl, fetchDiscoveryDocument } from "../discovery.js";

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const ISSUER = "https://idp.example.test";

const FULL_DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  userinfo_endpoint: `${ISSUER}/userinfo`,
  jwks_uri: `${ISSUER}/.well-known/jwks.json`,
  end_session_endpoint: `${ISSUER}/logout`,
  response_types_supported: ["code"],
  scopes_supported: ["openid", "profile", "email"],
};

function makeDiscoveryHandler(options: {
  document?: Record<string, unknown>;
  status?: number;
  contentType?: string;
} = {}) {
  const document = options.document ?? FULL_DISCOVERY;
  const status = options.status ?? 200;
  const contentType = options.contentType ?? "application/json";

  return async (url: string): Promise<Response> => {
    if (url.includes("/.well-known/openid-configuration")) {
      return new Response(JSON.stringify(document), {
        status,
        headers: { "Content-Type": contentType },
      });
    }
    return new Response("{}", { status: 404 });
  };
}

const FETCH_OPTIONS = {
  issuerUrl: ISSUER,
  cacheTtlSeconds: 3600,
};

// ────────────────────────────────────────────────────────────────────────────
// buildDiscoveryUrl()
// ────────────────────────────────────────────────────────────────────────────

describe("buildDiscoveryUrl()", () => {
  it("appends /.well-known/openid-configuration to the issuer URL", () => {
    expect(buildDiscoveryUrl("https://idp.example.test")).toBe(
      "https://idp.example.test/.well-known/openid-configuration",
    );
  });

  it("strips a trailing slash from the issuer before appending the path", () => {
    expect(buildDiscoveryUrl("https://idp.example.test/")).toBe(
      "https://idp.example.test/.well-known/openid-configuration",
    );
  });

  it("handles issuer URLs with a path segment (e.g. Azure AD tenanted endpoint)", () => {
    expect(buildDiscoveryUrl("https://login.microsoftonline.com/tenant-id/v2.0")).toBe(
      "https://login.microsoftonline.com/tenant-id/v2.0/.well-known/openid-configuration",
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// fetchDiscoveryDocument()
// ────────────────────────────────────────────────────────────────────────────

describe("fetchDiscoveryDocument()", () => {
  it("returns a valid discovery document on success", async () => {
    const ctx = createMockContext({ fetchHandler: makeDiscoveryHandler() });

    const doc = await fetchDiscoveryDocument({
      ...FETCH_OPTIONS,
      fetch: ctx.fetch,
      cache: ctx.cache,
      logger: ctx.logger,
    });

    expect(doc.issuer).toBe(ISSUER);
    expect(doc.authorization_endpoint).toBe(`${ISSUER}/authorize`);
    expect(doc.token_endpoint).toBe(`${ISSUER}/token`);
    expect(doc.userinfo_endpoint).toBe(`${ISSUER}/userinfo`);
    expect(doc.jwks_uri).toBe(`${ISSUER}/.well-known/jwks.json`);
  });

  it("includes the optional end_session_endpoint when present", async () => {
    const ctx = createMockContext({ fetchHandler: makeDiscoveryHandler() });

    const doc = await fetchDiscoveryDocument({
      ...FETCH_OPTIONS,
      fetch: ctx.fetch,
      cache: ctx.cache,
      logger: ctx.logger,
    });

    expect(doc.end_session_endpoint).toBe(`${ISSUER}/logout`);
  });

  it("caches the discovery document after the first fetch", async () => {
    const ctx = createMockContext({ fetchHandler: makeDiscoveryHandler() });

    await fetchDiscoveryDocument({
      ...FETCH_OPTIONS,
      fetch: ctx.fetch,
      cache: ctx.cache,
      logger: ctx.logger,
    });

    const callsAfterFirst = ctx.fetch.__calls.length;

    // Second fetch — should be served from cache
    await fetchDiscoveryDocument({
      ...FETCH_OPTIONS,
      fetch: ctx.fetch,
      cache: ctx.cache,
      logger: ctx.logger,
    });

    // No additional fetch calls should have been made
    expect(ctx.fetch.__calls.length).toBe(callsAfterFirst);
  });

  it("fetches the discovery URL with an Accept: application/json header", async () => {
    const ctx = createMockContext({ fetchHandler: makeDiscoveryHandler() });

    await fetchDiscoveryDocument({
      ...FETCH_OPTIONS,
      fetch: ctx.fetch,
      cache: ctx.cache,
      logger: ctx.logger,
    });

    const discoveryCall = ctx.fetch.__calls.find((c) =>
      c.url.includes("/.well-known/openid-configuration"),
    );
    expect(discoveryCall).toBeDefined();
    const headers = discoveryCall?.init?.headers as Record<string, string> | undefined;
    expect(headers?.["Accept"]).toBe("application/json");
  });

  it("throws PluginConfigError when the discovery endpoint returns 404", async () => {
    const ctx = createMockContext({
      fetchHandler: makeDiscoveryHandler({ status: 404 }),
    });

    await expect(
      fetchDiscoveryDocument({
        ...FETCH_OPTIONS,
        fetch: ctx.fetch,
        cache: ctx.cache,
        logger: ctx.logger,
      }),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("throws PluginAuthError when the discovery endpoint returns 401", async () => {
    const ctx = createMockContext({
      fetchHandler: makeDiscoveryHandler({ status: 401 }),
    });

    await expect(
      fetchDiscoveryDocument({
        ...FETCH_OPTIONS,
        fetch: ctx.fetch,
        cache: ctx.cache,
        logger: ctx.logger,
      }),
    ).rejects.toBeInstanceOf(PluginAuthError);
  });

  it("throws PluginConfigError when token_endpoint is missing from the discovery document", async () => {
    const broken = { ...FULL_DISCOVERY };
    delete (broken as Record<string, unknown>)["token_endpoint"];

    const ctx = createMockContext({
      fetchHandler: makeDiscoveryHandler({ document: broken }),
    });

    await expect(
      fetchDiscoveryDocument({
        ...FETCH_OPTIONS,
        fetch: ctx.fetch,
        cache: ctx.cache,
        logger: ctx.logger,
      }),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("throws PluginConfigError when jwks_uri is missing from the discovery document", async () => {
    const broken = { ...FULL_DISCOVERY };
    delete (broken as Record<string, unknown>)["jwks_uri"];

    const ctx = createMockContext({
      fetchHandler: makeDiscoveryHandler({ document: broken }),
    });

    await expect(
      fetchDiscoveryDocument({
        ...FETCH_OPTIONS,
        fetch: ctx.fetch,
        cache: ctx.cache,
        logger: ctx.logger,
      }),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("throws PluginConfigError when the discovery endpoint returns non-JSON", async () => {
    const ctx = createMockContext({
      fetchHandler: async (url: string) => {
        if (url.includes("/.well-known/openid-configuration")) {
          return new Response("<html>not json</html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
        }
        return new Response("{}", { status: 404 });
      },
    });

    await expect(
      fetchDiscoveryDocument({
        ...FETCH_OPTIONS,
        fetch: ctx.fetch,
        cache: ctx.cache,
        logger: ctx.logger,
      }),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("throws PluginConfigError when the discovery response body is not a JSON object", async () => {
    const ctx = createMockContext({
      fetchHandler: async (url: string) => {
        if (url.includes("/.well-known/openid-configuration")) {
          return new Response(JSON.stringify([1, 2, 3]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 404 });
      },
    });

    await expect(
      fetchDiscoveryDocument({
        ...FETCH_OPTIONS,
        fetch: ctx.fetch,
        cache: ctx.cache,
        logger: ctx.logger,
      }),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });
});
