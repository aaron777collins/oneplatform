/**
 * Per-type mock context factories for connector, auth-provider, destination,
 * and transformer plugin testing.
 *
 * These factories wrap createMockContext() with pre-populated, realistic sample
 * data so plugin developers can write focused tests without hand-crafting every
 * credential, fetch response, or cache entry.
 *
 * Design decisions:
 * - Each factory follows the same pattern as the existing createMockAuthContext /
 *   createMockTransformerContext factories: delegate to createMockContext(), then
 *   add type-specific convenience aliases and defaults.
 * - Overrides are always applied last so callers can replace any default value.
 * - Introspection arrays (__calls, __logs, __spans) are surfaced as top-level
 *   aliases where they are most useful for the given plugin type.
 * - Realistic-looking but obviously fake credentials avoid accidental real-network
 *   calls during CI (no live keys, no real domains that could receive test traffic).
 */

import { createMockContext } from "./mock-context.js";
import type {
  MockContext,
  MockContextOptions,
  MockFetchCall,
  MockCredentialCall,
} from "./mock-context.js";
import type { OntologySchema } from "../types/context.js";
import type { DataRecord } from "../types/primitives.js";

// ─────────────────────────────────────────────────────────────────────────────
// Connector mock
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pre-populated sample records that the connector fetch handler returns by default.
 * Structured as realistic API payloads so tests can drive full connector logic
 * without writing bespoke response bodies.
 */
export const CONNECTOR_SAMPLE_RECORDS: DataRecord[] = [
  {
    sourceId: "record-001",
    data: { id: "record-001", name: "Acme Corp", industry: "technology", revenue: 5000000 },
    metadata: { createdAt: "2025-01-15T09:00:00Z", updatedAt: "2026-01-10T14:30:00Z" },
  },
  {
    sourceId: "record-002",
    data: { id: "record-002", name: "Globex Inc", industry: "manufacturing", revenue: 12000000 },
    metadata: { createdAt: "2025-03-22T11:15:00Z", updatedAt: "2026-02-28T08:45:00Z" },
  },
  {
    sourceId: "record-003",
    data: { id: "record-003", name: "Initech", industry: "finance", revenue: 3200000 },
    metadata: { createdAt: "2025-06-01T16:00:00Z", updatedAt: "2026-06-15T10:00:00Z" },
  },
];

/** Default pagination response shape returned by the connector fetch handler. */
export interface ConnectorFetchResponse {
  items: DataRecord[];
  nextCursor: string | null;
  total: number;
}

export interface MockConnectorContext extends MockContext {
  /** Convenience alias for ctx.fetch.__calls — inspect outbound API requests. */
  fetchCalls: MockFetchCall[];
}

export interface MockConnectorContextOptions extends MockContextOptions {
  /**
   * Records returned by the default fetch handler's first page.
   * Default: CONNECTOR_SAMPLE_RECORDS (three realistic records).
   */
  sampleRecords?: DataRecord[];

  /**
   * Cursor value the default fetch handler returns as nextCursor.
   * Set to null to signal a single-page dataset with no more records.
   * Default: "cursor-page-2" (simulates a paginated source).
   */
  initialNextCursor?: string | null;
}

/**
 * Create a mock context pre-configured for Connector plugin testing.
 *
 * Defaults:
 * - Credentials: apiKey + baseUrl for a typical REST source
 * - Fetch: returns a paginated JSON payload (items + nextCursor)
 * - Cache: seeded with a token entry to simulate a cached OAuth token
 *
 * @example
 * const ctx = createConnectorMockContext();
 * const handle = await myConnector.connect({}, ctx);
 * const batch = await myConnector.fetchBatch(handle, null, ctx);
 * expect(batch.records).toHaveLength(3);
 * expect(ctx.fetchCalls).toHaveLength(1);
 */
export function createConnectorMockContext(
  options: MockConnectorContextOptions = {},
): MockConnectorContext {
  const {
    sampleRecords = CONNECTOR_SAMPLE_RECORDS,
    initialNextCursor = "cursor-page-2",
    credentials: callerCredentials,
    fetchHandler: callerFetchHandler,
    ...rest
  } = options;

  const mergedCredentials: Record<string, string> = {
    apiKey: "test-api-key-connector-abc123",
    baseUrl: "https://api.example-source.test",
    // Caller overrides win
    ...callerCredentials,
  };

  // Build the default paginated fetch handler. The caller's fetchHandler (if
  // provided) replaces this entirely — callers that need multi-page simulation
  // should pass their own handler and track cursor state themselves.
  const defaultFetchHandler = async (
    _url: string,
    _init?: RequestInit,
  ): Promise<Response> => {
    const payload: ConnectorFetchResponse = {
      items: sampleRecords,
      nextCursor: initialNextCursor,
      total: sampleRecords.length,
    };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const base = createMockContext({
    instanceId: "connector-test",
    tenantId:   "test-tenant",
    ...rest,
    credentials:  mergedCredentials,
    fetchHandler: callerFetchHandler ?? defaultFetchHandler,
  });

  // Seed the cache with a plausible cached access token so connector tests that
  // check "do we reuse an existing token?" can pass without a real auth round-trip.
  void base.cache.set("access_token", "cached-bearer-token-xyz", 3600);

  return {
    ...base,
    get fetchCalls(): MockFetchCall[] {
      return base.fetch.__calls;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth provider mock
// ─────────────────────────────────────────────────────────────────────────────

/** Token response shape returned by the default auth fetch handler. */
export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

export const AUTH_SAMPLE_TOKEN_RESPONSE: TokenResponse = {
  access_token:  "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.sample-access-token",
  token_type:    "Bearer",
  expires_in:    3600,
  refresh_token: "sample-refresh-token-abc123",
  id_token:      "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.sample-id-token",
  scope:         "openid profile email",
};

/** OIDC userinfo response returned by the default auth fetch handler. */
export interface UserinfoResponse {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
  given_name: string;
  family_name: string;
}

export const AUTH_SAMPLE_USERINFO: UserinfoResponse = {
  sub:            "user-sub-abc123",
  email:          "alice@example.test",
  email_verified: true,
  name:           "Alice Example",
  given_name:     "Alice",
  family_name:    "Example",
};

export interface MockAuthProviderContext extends MockContext {
  /** Convenience alias for ctx.credentials.__calls — inspect credential reads. */
  credentialCalls: MockCredentialCall[];
  /** Convenience alias for ctx.fetch.__calls — inspect outbound IdP requests. */
  fetchCalls: MockFetchCall[];
}

export interface MockAuthProviderContextOptions extends MockContextOptions {
  /**
   * Auth-specific credentials merged on top of the defaults.
   * Common keys: clientId, clientSecret, issuerUrl, privateKey.
   */
  authCredentials?: Record<string, string>;

  /**
   * Token response payload returned by the /token endpoint handler.
   * Default: AUTH_SAMPLE_TOKEN_RESPONSE.
   */
  tokenResponse?: TokenResponse;

  /**
   * Userinfo payload returned by the /userinfo endpoint handler.
   * Default: AUTH_SAMPLE_USERINFO.
   */
  userinfoResponse?: UserinfoResponse;
}

/**
 * Create a mock context pre-configured for AuthProvider plugin testing.
 *
 * The fetch handler dispatches on URL path suffix:
 *   - URLs ending with /token   → returns tokenResponse
 *   - URLs ending with /userinfo → returns userinfoResponse
 *   - All other URLs            → returns 404
 *
 * This covers the two most common OIDC/OAuth2 calls without requiring
 * tests to set up separate handlers for each endpoint.
 *
 * @example
 * const ctx = createAuthProviderMockContext();
 * const result = await myOidcProvider.authenticate({ code: "auth-code" }, ctx);
 * expect(ctx.credentialCalls.map(c => c.name)).toContain("clientSecret");
 * expect(ctx.fetchCalls[0]?.url).toContain("/token");
 */
export function createAuthProviderMockContext(
  options: MockAuthProviderContextOptions = {},
): MockAuthProviderContext {
  const {
    authCredentials,
    tokenResponse    = AUTH_SAMPLE_TOKEN_RESPONSE,
    userinfoResponse = AUTH_SAMPLE_USERINFO,
    credentials:     callerCredentials,
    fetchHandler:    callerFetchHandler,
    ...rest
  } = options;

  const mergedCredentials: Record<string, string> = {
    // OIDC / OAuth2 standard credential names
    clientId:     "test-client-id-oidc",
    clientSecret: "test-client-secret-oidc",
    issuerUrl:    "https://idp.example.test",
    // Caller-provided values override the defaults above
    ...callerCredentials,
    ...authCredentials,
  };

  // Dispatch fetch responses based on URL suffix so tests can exercise both
  // token acquisition and userinfo retrieval without per-test handler setup.
  const defaultFetchHandler = async (url: string): Promise<Response> => {
    if (url.endsWith("/token")) {
      return new Response(JSON.stringify(tokenResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/userinfo")) {
      return new Response(JSON.stringify(userinfoResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Unknown endpoints return 404 to surface routing bugs in plugin code
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  };

  const base = createMockContext({
    instanceId:   "auth-provider-test",
    tenantId:     "test-tenant",
    ...rest,
    credentials:  mergedCredentials,
    fetchHandler: callerFetchHandler ?? defaultFetchHandler,
  });

  // Pre-seed a session token so tests that check "skip re-auth if valid session
  // exists" can verify the early-return path without performing a real token fetch.
  void base.cache.set("session_token", "cached-session-token-abc", 1800);

  return {
    ...base,
    get credentialCalls(): MockCredentialCall[] {
      return base.credentials.__calls;
    },
    get fetchCalls(): MockFetchCall[] {
      return base.fetch.__calls;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Destination mock
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write call recorded by the destination fetch handler.
 * Destination tests inspect these to verify that records were written correctly.
 */
export interface MockDestinationWriteCall {
  url: string;
  method: string;
  /** Parsed request body. null if the request had no body. */
  body: unknown;
}

export interface MockDestinationContext extends MockContext {
  /** All fetch calls recorded. Surface these for HTTP-based destination assertions. */
  fetchCalls: MockFetchCall[];
  /**
   * Structured write calls parsed from the fetch handler. Each entry captures
   * the URL, method, and parsed JSON body of a write request so tests can
   * assert on record-level payloads without parsing raw fetch calls.
   */
  writeCalls: MockDestinationWriteCall[];
}

export interface MockDestinationContextOptions extends MockContextOptions {
  /**
   * API destination write endpoint. Default fetch handler matches requests to this
   * URL prefix.
   * Default: "https://api.example-destination.test"
   */
  endpointUrl?: string;

  /**
   * HTTP status code returned by the write handler.
   * Default: 200 (success). Set to 429 to test rate-limit handling, etc.
   */
  writeStatusCode?: number;

  /**
   * Response body returned by the write handler.
   * Default: { accepted: true, count: <batch size> }
   */
  writeResponseBody?: Record<string, unknown>;
}

/**
 * Create a mock context pre-configured for Destination plugin testing.
 *
 * The default fetch handler accepts POST/PUT/PATCH requests and records
 * them in ctx.writeCalls for structured inspection. GET requests return
 * a 200 OK with connection metadata (useful for "ping" / health-check calls).
 *
 * @example
 * const ctx = createDestinationMockContext();
 * await myDestination.write([{ sourceId: "1", data: { name: "Alice" } }], ctx);
 * expect(ctx.writeCalls).toHaveLength(1);
 * expect(ctx.writeCalls[0]?.body).toMatchObject({ records: expect.any(Array) });
 */
export function createDestinationMockContext(
  options: MockDestinationContextOptions = {},
): MockDestinationContext {
  const {
    endpointUrl      = "https://api.example-destination.test",
    writeStatusCode  = 200,
    writeResponseBody,
    credentials:  callerCredentials,
    fetchHandler: callerFetchHandler,
    ...rest
  } = options;

  const mergedCredentials: Record<string, string> = {
    // Standard DB / API destination credential names
    host:        "db.example-destination.test",
    port:        "5432",
    database:    "test_destination_db",
    username:    "test_user",
    password:    "test-destination-password",
    apiKey:      "test-api-key-destination-abc123",
    endpointUrl,
    // Caller overrides win
    ...callerCredentials,
  };

  // Collect write calls so tests can inspect them without parsing raw fetch bodies.
  // Allocated here so the handler closure and the returned context share the same
  // array reference.
  const writeCalls: MockDestinationWriteCall[] = [];

  const defaultFetchHandler = async (
    url: string,
    init?: RequestInit,
  ): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();

    if (method === "GET") {
      // Health-check / connection ping path
      return new Response(
        JSON.stringify({ status: "ok", endpoint: endpointUrl }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Parse the request body for structured inspection. Tolerate non-JSON bodies
    // (binary uploads, etc.) by falling back to null rather than throwing.
    let parsedBody: unknown = null;
    if (init?.body !== undefined && init.body !== null) {
      try {
        parsedBody = JSON.parse(init.body as string);
      } catch {
        parsedBody = init.body;
      }
    }

    writeCalls.push({ url, method, body: parsedBody });

    // Derive a sensible default response body if the caller did not provide one.
    // We read parsedBody here because batch size is only knowable after parsing.
    const batchSize =
      Array.isArray((parsedBody as Record<string, unknown>)?.["records"])
        ? ((parsedBody as Record<string, unknown>)["records"] as unknown[]).length
        : 1;

    const responseBody = writeResponseBody ?? { accepted: true, count: batchSize };
    return new Response(JSON.stringify(responseBody), {
      status: writeStatusCode,
      headers: { "Content-Type": "application/json" },
    });
  };

  const base = createMockContext({
    instanceId:   "destination-test",
    tenantId:     "test-tenant",
    ...rest,
    credentials:  mergedCredentials,
    fetchHandler: callerFetchHandler ?? defaultFetchHandler,
  });

  return {
    ...base,
    get fetchCalls(): MockFetchCall[] {
      return base.fetch.__calls;
    },
    get writeCalls(): MockDestinationWriteCall[] {
      return writeCalls;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Transformer mock
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sample input records for transformer tests. Structured to exercise common
 * field types: strings, numbers, nested objects, and nullable fields.
 */
export const TRANSFORMER_SAMPLE_INPUT_RECORDS: DataRecord[] = [
  {
    sourceId: "tx-input-001",
    data: {
      id:         "tx-input-001",
      firstName:  "Bob",
      lastName:   "Builder",
      email:      "bob@example.test",
      score:      87.5,
      tags:       ["enterprise", "active"],
      address:    { city: "Springfield", country: "US" },
      deletedAt:  null,
    },
    metadata: { createdAt: "2026-01-01T00:00:00Z" },
  },
  {
    sourceId: "tx-input-002",
    data: {
      id:         "tx-input-002",
      firstName:  "Carol",
      lastName:   "Danvers",
      email:      "carol@example.test",
      score:      95.0,
      tags:       ["vip"],
      address:    { city: "New York", country: "US" },
      deletedAt:  null,
    },
    metadata: { createdAt: "2026-02-14T08:30:00Z" },
  },
];

/** Minimal ontology schema for transformer tests — covers common entity shapes. */
const TRANSFORMER_ONTOLOGY_SCHEMA: OntologySchema = {
  version:   1,
  updatedAt: "2026-06-01T00:00:00Z",
  entityTypes: [
    {
      name:        "Contact",
      displayName: "Contact",
      primaryKey:  "id",
      fields: [
        { name: "id",        type: "string",  required: true  },
        { name: "firstName", type: "string",  required: true  },
        { name: "lastName",  type: "string",  required: true  },
        { name: "email",     type: "string",  required: false },
        { name: "score",     type: "number",  required: false },
      ],
    },
  ],
};

export interface MockTransformerFactoryContext extends MockContext {
  /** Convenience alias for ctx.fetch.__calls — inspect enrichment API calls. */
  fetchCalls: MockFetchCall[];
  /** The input records this context was seeded with. */
  inputRecords: DataRecord[];
}

export interface MockTransformerContextOptions extends MockContextOptions {
  /**
   * Input records to seed the context with. Accessible via ctx.inputRecords.
   * Default: TRANSFORMER_SAMPLE_INPUT_RECORDS.
   */
  inputRecords?: DataRecord[];

  /**
   * Ontology schema for the context.
   * Default: a minimal Contact schema with id, firstName, lastName, email, score.
   */
  ontologySchema?: OntologySchema;

  /**
   * JSON body returned by the enrichment fetch handler.
   * Default: { enriched: true, category: "enterprise" }.
   */
  enrichmentResponse?: Record<string, unknown>;
}

/**
 * Create a mock context pre-configured for Transformer plugin testing.
 *
 * The fetch handler returns a generic enrichment response so transformers that
 * call external enrichment APIs succeed without additional test setup.
 *
 * @example
 * const ctx = createTransformerMockContext();
 * const output = await myTransformer.transform(ctx.inputRecords[0]!, ctx);
 * expect(ctx.fetchCalls).toHaveLength(1); // enrichment call was made
 */
export function createTransformerMockContext(
  options: MockTransformerContextOptions = {},
): MockTransformerFactoryContext {
  const {
    inputRecords       = TRANSFORMER_SAMPLE_INPUT_RECORDS,
    ontologySchema     = TRANSFORMER_ONTOLOGY_SCHEMA,
    enrichmentResponse = { enriched: true, category: "enterprise" },
    fetchHandler:      callerFetchHandler,
    ...rest
  } = options;

  // Default enrichment handler covers the typical transformer pattern:
  // call an external API to enrich a record field, then return the enriched data.
  const defaultFetchHandler = async (): Promise<Response> =>
    new Response(JSON.stringify(enrichmentResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const base = createMockContext({
    instanceId:    "transformer-step-test",
    tenantId:      "test-tenant",
    ...rest,
    ontologySchema,
    fetchHandler:  callerFetchHandler ?? defaultFetchHandler,
  });

  return {
    ...base,
    get fetchCalls(): MockFetchCall[] {
      return base.fetch.__calls;
    },
    inputRecords,
  };
}
