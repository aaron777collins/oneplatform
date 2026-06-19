/**
 * Tests for per-type mock context factories.
 *
 * Each describe block mirrors one factory and verifies:
 * 1. Default credentials are present and correctly named
 * 2. The default fetch handler returns the expected payload
 * 3. Introspection aliases (fetchCalls, credentialCalls, writeCalls) are live
 *    references — mutations to the underlying arrays are reflected immediately
 * 4. Caller overrides replace defaults without breaking structure
 * 5. Pre-seeded cache entries exist where documented
 */

import { describe, it, expect } from "vitest";
import {
  createConnectorMockContext,
  createAuthProviderMockContext,
  createDestinationMockContext,
  createTransformerMockContext,
  CONNECTOR_SAMPLE_RECORDS,
  AUTH_SAMPLE_TOKEN_RESPONSE,
  AUTH_SAMPLE_USERINFO,
  TRANSFORMER_SAMPLE_INPUT_RECORDS,
} from "../testing/mock-factories.js";

// ─────────────────────────────────────────────────────────────────────────────
// createConnectorMockContext
// ─────────────────────────────────────────────────────────────────────────────

describe("createConnectorMockContext", () => {
  describe("default credentials", () => {
    it("provides apiKey and baseUrl by default", async () => {
      const ctx = createConnectorMockContext();
      const apiKey  = await ctx.credentials.get("apiKey");
      const baseUrl = await ctx.credentials.get("baseUrl");
      expect(typeof apiKey).toBe("string");
      expect(apiKey.length).toBeGreaterThan(0);
      expect(typeof baseUrl).toBe("string");
      expect(baseUrl.startsWith("https://")).toBe(true);
    });

    it("lists apiKey and baseUrl among available credentials", async () => {
      const ctx = createConnectorMockContext();
      const names = await ctx.credentials.list();
      expect(names).toContain("apiKey");
      expect(names).toContain("baseUrl");
    });
  });

  describe("default fetch handler", () => {
    it("returns 200 with items and nextCursor payload", async () => {
      const ctx = createConnectorMockContext();
      const resp = await ctx.fetch.fetch("https://api.example-source.test/records");
      expect(resp.status).toBe(200);
      const body = await resp.json() as { items: unknown[]; nextCursor: string | null };
      expect(Array.isArray(body.items)).toBe(true);
      expect("nextCursor" in body).toBe(true);
    });

    it("returns CONNECTOR_SAMPLE_RECORDS as the default items", async () => {
      const ctx = createConnectorMockContext();
      const resp = await ctx.fetch.fetch("https://api.example-source.test/records");
      const body = await resp.json() as { items: unknown[] };
      expect(body.items).toHaveLength(CONNECTOR_SAMPLE_RECORDS.length);
    });

    it("returns a non-null nextCursor by default (simulates pagination)", async () => {
      const ctx = createConnectorMockContext();
      const resp = await ctx.fetch.fetch("https://any.test/");
      const body = await resp.json() as { nextCursor: string | null };
      expect(body.nextCursor).not.toBeNull();
    });

    it("returns null nextCursor when initialNextCursor is explicitly null", async () => {
      const ctx = createConnectorMockContext({ initialNextCursor: null });
      const resp = await ctx.fetch.fetch("https://any.test/");
      const body = await resp.json() as { nextCursor: string | null };
      expect(body.nextCursor).toBeNull();
    });
  });

  describe("fetchCalls alias", () => {
    it("fetchCalls reflects calls made through ctx.fetch.fetch", async () => {
      const ctx = createConnectorMockContext();
      expect(ctx.fetchCalls).toHaveLength(0);
      await ctx.fetch.fetch("https://api.example-source.test/page1");
      expect(ctx.fetchCalls).toHaveLength(1);
      expect(ctx.fetchCalls[0]?.url).toBe("https://api.example-source.test/page1");
    });

    it("fetchCalls is the same array as ctx.fetch.__calls (live reference)", async () => {
      const ctx = createConnectorMockContext();
      await ctx.fetch.fetch("https://any.test/");
      expect(ctx.fetchCalls).toBe(ctx.fetch.__calls);
    });
  });

  describe("cache pre-seed", () => {
    it("seeds access_token in the cache", async () => {
      const ctx = createConnectorMockContext();
      const token = await ctx.cache.get<string>("access_token");
      expect(typeof token).toBe("string");
      expect((token as string).length).toBeGreaterThan(0);
    });
  });

  describe("overrides", () => {
    it("accepts custom sampleRecords", async () => {
      const customRecords = [
        { sourceId: "custom-1", data: { value: 42 } },
      ];
      const ctx = createConnectorMockContext({ sampleRecords: customRecords });
      const resp = await ctx.fetch.fetch("https://any.test/");
      const body = await resp.json() as { items: unknown[] };
      expect(body.items).toHaveLength(1);
    });

    it("accepts a custom fetchHandler that replaces the default", async () => {
      const ctx = createConnectorMockContext({
        fetchHandler: async () =>
          new Response(JSON.stringify({ custom: true }), { status: 202 }),
      });
      const resp = await ctx.fetch.fetch("https://any.test/");
      expect(resp.status).toBe(202);
      const body = await resp.json() as Record<string, unknown>;
      expect(body["custom"]).toBe(true);
    });

    it("allows caller credentials to override defaults", async () => {
      const ctx = createConnectorMockContext({
        credentials: { apiKey: "override-key" },
      });
      const key = await ctx.credentials.get("apiKey");
      expect(key).toBe("override-key");
    });

    it("preserves custom tenantId", () => {
      const ctx = createConnectorMockContext({ tenantId: "acme-corp" });
      expect(ctx.tenant.tenantId).toBe("acme-corp");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createAuthProviderMockContext
// ─────────────────────────────────────────────────────────────────────────────

describe("createAuthProviderMockContext", () => {
  describe("default credentials", () => {
    it("provides clientId, clientSecret, and issuerUrl by default", async () => {
      const ctx = createAuthProviderMockContext();
      const clientId     = await ctx.credentials.get("clientId");
      const clientSecret = await ctx.credentials.get("clientSecret");
      const issuerUrl    = await ctx.credentials.get("issuerUrl");
      expect(typeof clientId).toBe("string");
      expect(typeof clientSecret).toBe("string");
      expect(issuerUrl.startsWith("https://")).toBe(true);
    });
  });

  describe("default fetch handler — /token endpoint", () => {
    it("returns 200 with a token response for /token URLs", async () => {
      const ctx = createAuthProviderMockContext();
      const resp = await ctx.fetch.fetch("https://idp.example.test/oauth2/token");
      expect(resp.status).toBe(200);
      const body = await resp.json() as Record<string, unknown>;
      expect(body["access_token"]).toBe(AUTH_SAMPLE_TOKEN_RESPONSE.access_token);
      expect(body["token_type"]).toBe("Bearer");
      expect(typeof body["expires_in"]).toBe("number");
    });

    it("includes refresh_token and id_token in the default response", async () => {
      const ctx = createAuthProviderMockContext();
      const resp = await ctx.fetch.fetch("https://idp.example.test/token");
      const body = await resp.json() as Record<string, unknown>;
      expect(body["refresh_token"]).toBeDefined();
      expect(body["id_token"]).toBeDefined();
    });
  });

  describe("default fetch handler — /userinfo endpoint", () => {
    it("returns 200 with userinfo for /userinfo URLs", async () => {
      const ctx = createAuthProviderMockContext();
      const resp = await ctx.fetch.fetch("https://idp.example.test/oauth2/userinfo");
      expect(resp.status).toBe(200);
      const body = await resp.json() as Record<string, unknown>;
      expect(body["sub"]).toBe(AUTH_SAMPLE_USERINFO.sub);
      expect(body["email"]).toBe(AUTH_SAMPLE_USERINFO.email);
      expect(body["email_verified"]).toBe(true);
    });
  });

  describe("default fetch handler — unknown endpoints", () => {
    it("returns 404 for unrecognized URLs", async () => {
      const ctx = createAuthProviderMockContext();
      const resp = await ctx.fetch.fetch("https://idp.example.test/unknown");
      expect(resp.status).toBe(404);
    });
  });

  describe("credentialCalls alias", () => {
    it("credentialCalls reflects credential reads", async () => {
      const ctx = createAuthProviderMockContext();
      expect(ctx.credentialCalls).toHaveLength(0);
      await ctx.credentials.get("clientSecret");
      expect(ctx.credentialCalls).toHaveLength(1);
      expect(ctx.credentialCalls[0]?.name).toBe("clientSecret");
    });

    it("credentialCalls is the same array as ctx.credentials.__calls", async () => {
      const ctx = createAuthProviderMockContext();
      await ctx.credentials.get("clientId");
      expect(ctx.credentialCalls).toBe(ctx.credentials.__calls);
    });
  });

  describe("fetchCalls alias", () => {
    it("fetchCalls reflects outbound IdP requests", async () => {
      const ctx = createAuthProviderMockContext();
      await ctx.fetch.fetch("https://idp.example.test/token");
      expect(ctx.fetchCalls).toHaveLength(1);
      expect(ctx.fetchCalls).toBe(ctx.fetch.__calls);
    });
  });

  describe("cache pre-seed", () => {
    it("seeds session_token in the cache", async () => {
      const ctx = createAuthProviderMockContext();
      const token = await ctx.cache.get<string>("session_token");
      expect(typeof token).toBe("string");
    });
  });

  describe("overrides", () => {
    it("accepts authCredentials that override defaults", async () => {
      const ctx = createAuthProviderMockContext({
        authCredentials: { clientSecret: "my-override-secret" },
      });
      const secret = await ctx.credentials.get("clientSecret");
      expect(secret).toBe("my-override-secret");
    });

    it("accepts a custom tokenResponse", async () => {
      const customToken = {
        access_token: "custom-token",
        token_type:   "Bearer",
        expires_in:   7200,
      };
      const ctx = createAuthProviderMockContext({ tokenResponse: customToken });
      const resp = await ctx.fetch.fetch("https://any.test/token");
      const body = await resp.json() as Record<string, unknown>;
      expect(body["access_token"]).toBe("custom-token");
      expect(body["expires_in"]).toBe(7200);
    });

    it("accepts a custom userinfoResponse", async () => {
      const customUserinfo = {
        sub:            "custom-sub",
        email:          "custom@test.test",
        email_verified: false,
        name:           "Custom User",
        given_name:     "Custom",
        family_name:    "User",
      };
      const ctx = createAuthProviderMockContext({ userinfoResponse: customUserinfo });
      const resp = await ctx.fetch.fetch("https://any.test/userinfo");
      const body = await resp.json() as Record<string, unknown>;
      expect(body["sub"]).toBe("custom-sub");
      expect(body["email_verified"]).toBe(false);
    });

    it("accepts a custom fetchHandler that fully replaces the dispatcher", async () => {
      const ctx = createAuthProviderMockContext({
        fetchHandler: async () =>
          new Response(JSON.stringify({ overridden: true }), { status: 200 }),
      });
      const resp = await ctx.fetch.fetch("https://any.test/token");
      const body = await resp.json() as Record<string, unknown>;
      expect(body["overridden"]).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createDestinationMockContext
// ─────────────────────────────────────────────────────────────────────────────

describe("createDestinationMockContext", () => {
  describe("default credentials", () => {
    it("provides host, port, database, username, and password by default", async () => {
      const ctx = createDestinationMockContext();
      const host     = await ctx.credentials.get("host");
      const port     = await ctx.credentials.get("port");
      const database = await ctx.credentials.get("database");
      const username = await ctx.credentials.get("username");
      const password = await ctx.credentials.get("password");
      expect(typeof host).toBe("string");
      expect(port).toBe("5432");
      expect(typeof database).toBe("string");
      expect(typeof username).toBe("string");
      expect(typeof password).toBe("string");
    });

    it("provides apiKey and endpointUrl for API-based destinations", async () => {
      const ctx = createDestinationMockContext();
      const apiKey      = await ctx.credentials.get("apiKey");
      const endpointUrl = await ctx.credentials.get("endpointUrl");
      expect(typeof apiKey).toBe("string");
      expect(endpointUrl.startsWith("https://")).toBe(true);
    });
  });

  describe("default fetch handler — GET (health check / ping)", () => {
    it("returns 200 with status ok for GET requests", async () => {
      const ctx = createDestinationMockContext();
      const resp = await ctx.fetch.fetch("https://api.example-destination.test/health");
      expect(resp.status).toBe(200);
      const body = await resp.json() as Record<string, unknown>;
      expect(body["status"]).toBe("ok");
    });

    it("does not record GET requests in writeCalls", async () => {
      const ctx = createDestinationMockContext();
      await ctx.fetch.fetch("https://api.example-destination.test/health");
      // GET requests appear in fetchCalls but not writeCalls
      expect(ctx.fetchCalls).toHaveLength(1);
      expect(ctx.writeCalls).toHaveLength(0);
    });
  });

  describe("default fetch handler — POST (write)", () => {
    it("returns 200 with accepted:true for POST write requests", async () => {
      const ctx = createDestinationMockContext();
      const payload = JSON.stringify({ records: [{ id: "1" }] });
      const resp = await ctx.fetch.fetch("https://api.example-destination.test/write", {
        method: "POST",
        body:   payload,
      });
      expect(resp.status).toBe(200);
      const body = await resp.json() as Record<string, unknown>;
      expect(body["accepted"]).toBe(true);
    });

    it("records write calls in writeCalls with parsed body", async () => {
      const ctx = createDestinationMockContext();
      const records = [{ id: "r1", name: "Alice" }, { id: "r2", name: "Bob" }];
      await ctx.fetch.fetch("https://api.example-destination.test/ingest", {
        method: "POST",
        body:   JSON.stringify({ records }),
      });
      expect(ctx.writeCalls).toHaveLength(1);
      expect(ctx.writeCalls[0]?.method).toBe("POST");
      expect((ctx.writeCalls[0]?.body as Record<string, unknown>)?.["records"]).toHaveLength(2);
    });

    it("infers batch size from records array for the default response count", async () => {
      const ctx = createDestinationMockContext();
      const records = [{ id: "1" }, { id: "2" }, { id: "3" }];
      const resp = await ctx.fetch.fetch("https://any.test/write", {
        method: "POST",
        body:   JSON.stringify({ records }),
      });
      const body = await resp.json() as Record<string, unknown>;
      expect(body["count"]).toBe(3);
    });

    it("accumulates multiple write calls across multiple fetch invocations", async () => {
      const ctx = createDestinationMockContext();
      await ctx.fetch.fetch("https://any.test/write", {
        method: "POST",
        body:   JSON.stringify({ records: [{ id: "1" }] }),
      });
      await ctx.fetch.fetch("https://any.test/write", {
        method: "POST",
        body:   JSON.stringify({ records: [{ id: "2" }] }),
      });
      expect(ctx.writeCalls).toHaveLength(2);
    });
  });

  describe("fetchCalls and writeCalls aliases", () => {
    it("fetchCalls is the same array as ctx.fetch.__calls", async () => {
      const ctx = createDestinationMockContext();
      await ctx.fetch.fetch("https://any.test/", { method: "POST", body: "{}" });
      expect(ctx.fetchCalls).toBe(ctx.fetch.__calls);
    });

    it("writeCalls is independent from fetchCalls (GET not included)", async () => {
      const ctx = createDestinationMockContext();
      await ctx.fetch.fetch("https://any.test/health"); // GET
      await ctx.fetch.fetch("https://any.test/write", {
        method: "POST",
        body:   JSON.stringify({ records: [] }),
      });
      expect(ctx.fetchCalls).toHaveLength(2);
      expect(ctx.writeCalls).toHaveLength(1);
    });
  });

  describe("overrides", () => {
    it("accepts custom writeStatusCode", async () => {
      const ctx = createDestinationMockContext({ writeStatusCode: 429 });
      const resp = await ctx.fetch.fetch("https://any.test/write", {
        method: "POST",
        body:   "{}",
      });
      expect(resp.status).toBe(429);
    });

    it("accepts custom writeResponseBody", async () => {
      const ctx = createDestinationMockContext({
        writeResponseBody: { result: "written", errors: [] },
      });
      const resp = await ctx.fetch.fetch("https://any.test/write", {
        method: "POST",
        body:   "{}",
      });
      const body = await resp.json() as Record<string, unknown>;
      expect(body["result"]).toBe("written");
    });

    it("accepts a custom endpointUrl credential", async () => {
      const ctx = createDestinationMockContext({
        endpointUrl: "https://custom-endpoint.test",
      });
      const url = await ctx.credentials.get("endpointUrl");
      expect(url).toBe("https://custom-endpoint.test");
    });

    it("accepts caller credentials that override defaults", async () => {
      const ctx = createDestinationMockContext({
        credentials: { database: "production_db" },
      });
      const db = await ctx.credentials.get("database");
      expect(db).toBe("production_db");
    });

    it("accepts a custom fetchHandler that replaces the default", async () => {
      const ctx = createDestinationMockContext({
        fetchHandler: async () =>
          new Response(JSON.stringify({ custom: "response" }), { status: 201 }),
      });
      const resp = await ctx.fetch.fetch("https://any.test/write", {
        method: "POST",
        body:   "{}",
      });
      expect(resp.status).toBe(201);
      // When a custom fetchHandler is used, writeCalls is not populated
      // (the caller owns the handler and the write-call tracking).
      expect(ctx.writeCalls).toHaveLength(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createTransformerMockContext
// ─────────────────────────────────────────────────────────────────────────────

describe("createTransformerMockContext", () => {
  describe("inputRecords", () => {
    it("provides TRANSFORMER_SAMPLE_INPUT_RECORDS by default", () => {
      const ctx = createTransformerMockContext();
      expect(ctx.inputRecords).toHaveLength(TRANSFORMER_SAMPLE_INPUT_RECORDS.length);
      expect(ctx.inputRecords[0]?.sourceId).toBe("tx-input-001");
    });

    it("accepts custom inputRecords", () => {
      const custom = [{ sourceId: "custom-1", data: { x: 1 } }];
      const ctx = createTransformerMockContext({ inputRecords: custom });
      expect(ctx.inputRecords).toHaveLength(1);
      expect(ctx.inputRecords[0]?.sourceId).toBe("custom-1");
    });

    it("inputRecords contains records with data fields", () => {
      const ctx = createTransformerMockContext();
      for (const record of ctx.inputRecords) {
        expect(typeof record.sourceId).toBe("string");
        expect(typeof record.data).toBe("object");
      }
    });
  });

  // TransformerContext deliberately excludes fetch and credentials.
  // Tests that exercise fetch behavior belong in connector mock tests.

  describe("ontology schema", () => {
    it("returns the default Contact schema from ctx.ontology.getSchema()", async () => {
      const ctx = createTransformerMockContext();
      const schema = await ctx.ontology.getSchema();
      expect(schema.entityTypes.length).toBeGreaterThan(0);
      const contact = schema.entityTypes.find(e => e.name === "Contact");
      expect(contact).toBeDefined();
    });

    it("resolves Contact entity schema from getEntitySchema", async () => {
      const ctx = createTransformerMockContext();
      const contact = await ctx.ontology.getEntitySchema("Contact");
      expect(contact).not.toBeNull();
      expect(contact?.primaryKey).toBe("id");
    });

    it("accepts a custom ontologySchema", async () => {
      const customSchema = {
        version:     99,
        updatedAt:   "2026-06-17T00:00:00Z",
        entityTypes: [
          {
            name:        "Product",
            displayName: "Product",
            primaryKey:  "sku",
            fields: [{ name: "sku", type: "string" as const, required: true }],
          },
        ],
      };
      const ctx = createTransformerMockContext({ ontologySchema: customSchema });
      const schema = await ctx.ontology.getSchema();
      expect(schema.version).toBe(99);
      const product = await ctx.ontology.getEntitySchema("Product");
      expect(product?.primaryKey).toBe("sku");
    });
  });

  // TransformerContext deliberately excludes fetch — fetchCalls tests removed.

  describe("overrides", () => {
    it("preserves custom tenantId", () => {
      const ctx = createTransformerMockContext({ tenantId: "custom-tenant" });
      expect(ctx.tenant.tenantId).toBe("custom-tenant");
    });

    it("preserves custom instanceId", () => {
      const ctx = createTransformerMockContext({ instanceId: "my-pipeline-step-42" });
      expect(ctx.tenant.instanceId).toBe("my-pipeline-step-42");
    });
  });

  describe("standard MockContext capabilities are fully preserved", () => {
    it("logger captures entries at all levels", () => {
      const ctx = createTransformerMockContext();
      ctx.logger.debug("d");
      ctx.logger.info("i");
      ctx.logger.warn("w");
      ctx.logger.error("e");
      expect(ctx.logger.__logs).toHaveLength(4);
    });

    it("cache stores and retrieves values", async () => {
      const ctx = createTransformerMockContext();
      await ctx.cache.set("enrichment_cache", { classified: true });
      const cached = await ctx.cache.get<{ classified: boolean }>("enrichment_cache");
      expect(cached?.classified).toBe(true);
    });

    it("tracing records spans", () => {
      const ctx = createTransformerMockContext();
      const span = ctx.tracing.startSpan("transformRecord");
      span.setAttribute("record.id", "tx-input-001");
      span.end();
      expect(ctx.tracing.__spans).toHaveLength(1);
      expect(ctx.tracing.__spans[0]?.ended).toBe(true);
    });
  });
});
