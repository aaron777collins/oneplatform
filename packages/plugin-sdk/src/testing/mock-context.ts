/**
 * createMockContext() factory.
 *
 * Constructs a fully in-process PluginContext suitable for unit tests.
 * No Redis, no database, no network calls unless allowRealFetch is set.
 */

import type {
  PluginContext,
  CredentialAccessor,
  FetchProxy,
  CacheAccessor,
  LockHandle,
  PluginLogger,
  TenantContext,
  OntologyAccessor,
  OntologySchema,
  EntitySchema,
  TracingContext,
  SpanHandle,
} from "../types/context.js";
import { PluginAuthError } from "../types/errors.js";

// ────────────────────────────────────────────────────────────────────────────
// Mock-specific extension interfaces that add test introspection fields.
// These are named with __ prefix by convention to signal "test-only" usage.
// ────────────────────────────────────────────────────────────────────────────

export interface MockCredentialCall {
  name: string;
}

export interface MockFetchCall {
  url: string;
  init?: RequestInit;
}

export interface MockLogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  metadata?: Record<string, unknown>;
}

export interface MockSpanAttributeCall {
  key: string;
  value: string | number | boolean;
}

export interface MockSpan {
  name: string;
  attributes: MockSpanAttributeCall[];
  ended: boolean;
}

// Augmented interfaces expose introspection arrays for assertions
export interface MockCredentialAccessor extends CredentialAccessor {
  __calls: MockCredentialCall[];
}

export interface MockFetchProxy extends FetchProxy {
  __calls: MockFetchCall[];
}

export interface MockLogger extends PluginLogger {
  __logs: MockLogEntry[];
}

export interface MockContext extends PluginContext {
  credentials: MockCredentialAccessor;
  fetch: MockFetchProxy;
  logger: MockLogger;
  tracing: TracingContext & { __spans: MockSpan[] };
}

// ────────────────────────────────────────────────────────────────────────────
// MockContextOptions
// ────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for the mock context. All fields are optional.
 * Unspecified fields get sensible test defaults.
 */
export interface MockContextOptions {
  tenantId?: string;
  tenantName?: string;
  instanceId?: string;
  config?: Record<string, unknown>;

  /**
   * Map of credential name → value. When context.credentials.get("name") is called
   * and "name" exists in this map, the mock returns the value immediately.
   * When "name" does not exist, the mock throws PluginAuthError.
   */
  credentials?: Record<string, string>;

  /**
   * If true, context.fetch() calls are passed through to the actual network.
   * Default: false (fetch is intercepted and returns 200 OK with an empty body).
   */
  allowRealFetch?: boolean;

  /**
   * Custom fetch handler. Called instead of real fetch when allowRealFetch is false.
   * Use to return mock API responses.
   */
  fetchHandler?: (url: string, init?: RequestInit) => Promise<Response>;

  /**
   * Ontology schema to return from context.ontology.getSchema().
   * Default: empty schema with no entity types.
   */
  ontologySchema?: OntologySchema;
}

// ────────────────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_ONTOLOGY_SCHEMA: OntologySchema = {
  entityTypes: [],
  version: 0,
  updatedAt: new Date(0).toISOString(),
};

/**
 * Create a mock PluginContext for use in unit tests.
 * The mock context is fully in-process — no Redis, no database, no network.
 *
 * @example
 * const ctx = createMockContext({
 *   credentials: { apiKey: "test-key-123" },
 *   config: { baseUrl: "https://api.example.com" },
 * });
 */
export function createMockContext(options: MockContextOptions = {}): MockContext {
  const {
    tenantId = "test-tenant",
    tenantName = "Test Tenant",
    instanceId = "test-instance",
    config = {},
    credentials: credentialMap = {},
    allowRealFetch = false,
    fetchHandler,
    ontologySchema = DEFAULT_ONTOLOGY_SCHEMA,
  } = options;

  // ── Credentials ──────────────────────────────────────────────────────────
  const credentialCalls: MockCredentialCall[] = [];

  const mockCredentials: MockCredentialAccessor = {
    __calls: credentialCalls,

    async get(name: string): Promise<string> {
      credentialCalls.push({ name });
      const value = credentialMap[name];
      if (value === undefined) {
        throw new PluginAuthError(`Credential not found: ${name}`);
      }
      return value;
    },

    async list(): Promise<string[]> {
      return Object.keys(credentialMap);
    },
  };

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const fetchCalls: MockFetchCall[] = [];

  const mockFetch: MockFetchProxy = {
    __calls: fetchCalls,

    async fetch(url: string, init?: RequestInit): Promise<Response> {
      fetchCalls.push({ url, ...(init !== undefined ? { init } : {}) });

      if (allowRealFetch) {
        return globalThis.fetch(url, init);
      }

      if (fetchHandler !== undefined) {
        return fetchHandler(url, init);
      }

      // Default: 200 OK with empty JSON body
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };

  // ── Cache ─────────────────────────────────────────────────────────────────
  // An in-process Map. Each createMockContext() call creates a fresh map.
  // TTL is tracked but not enforced — test contexts assume instant expiry checks
  // are unnecessary since tests run to completion before any TTL would fire.
  const cacheStore = new Map<string, unknown>();

  const mockCache: CacheAccessor = {
    async get<T>(key: string): Promise<T | null> {
      const value = cacheStore.get(key);
      return value === undefined ? null : (value as T);
    },

    async set<T>(key: string, value: T, _ttlSeconds?: number): Promise<void> {
      cacheStore.set(key, value);
    },

    async delete(key: string): Promise<void> {
      cacheStore.delete(key);
    },

    // Lock always succeeds in tests — concurrent execution does not occur in unit tests
    async lock(_key: string, _ttlSeconds: number): Promise<LockHandle | null> {
      const handle: LockHandle = {
        async release(): Promise<void> {
          // no-op in test context
        },
      };
      return handle;
    },
  };

  // ── Logger ────────────────────────────────────────────────────────────────
  const logs: MockLogEntry[] = [];

  function makeLogFn(level: MockLogEntry["level"]) {
    return (message: string, metadata?: Record<string, unknown>): void => {
      logs.push({ level, message, ...(metadata !== undefined ? { metadata } : {}) });
    };
  }

  const mockLogger: MockLogger = {
    __logs: logs,
    debug: makeLogFn("debug"),
    info: makeLogFn("info"),
    warn: makeLogFn("warn"),
    error: makeLogFn("error"),
  };

  // ── Tenant ────────────────────────────────────────────────────────────────
  const tenant: TenantContext = {
    tenantId,
    tenantName,
    config,
    instanceId,
  };

  // ── Ontology ──────────────────────────────────────────────────────────────
  // Cache the schema within this mock context — matches production behaviour.
  let cachedSchema: OntologySchema | null = null;

  const mockOntology: OntologyAccessor = {
    async getSchema(): Promise<OntologySchema> {
      if (cachedSchema === null) {
        cachedSchema = ontologySchema;
      }
      return cachedSchema;
    },

    async getEntitySchema(entityType: string): Promise<EntitySchema | null> {
      const schema = cachedSchema ?? ontologySchema;
      return schema.entityTypes.find((e) => e.name === entityType) ?? null;
    },
  };

  // ── Tracing ───────────────────────────────────────────────────────────────
  const spans: MockSpan[] = [];

  const mockTracing: TracingContext & { __spans: MockSpan[] } = {
    __spans: spans,

    injectHeaders(headers: Record<string, string>): Record<string, string> {
      // Inject a synthetic traceparent so callers can verify propagation in tests
      return {
        ...headers,
        traceparent: "00-00000000000000000000000000000001-0000000000000001-01",
      };
    },

    startSpan(name: string): SpanHandle {
      const span: MockSpan = { name, attributes: [], ended: false };
      spans.push(span);

      const handle: SpanHandle = {
        setAttribute(key: string, value: string | number | boolean): void {
          span.attributes.push({ key, value });
        },

        end(): void {
          span.ended = true;
        },
      };

      return handle;
    },
  };

  return {
    credentials: mockCredentials,
    fetch: mockFetch,
    cache: mockCache,
    logger: mockLogger,
    tenant,
    ontology: mockOntology,
    tracing: mockTracing,
  };
}
