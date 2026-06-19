/**
 * createDevContext — builds a PluginContext suitable for the local dev server.
 *
 * The dev context differs from the test mock context in three ways:
 *
 * 1. Logger writes to process.stderr in real time so the developer sees output
 *    as the plugin runs, not only after the run completes.
 *
 * 2. The fetch handler uses mockData URL matching so the developer can provide
 *    per-endpoint mock payloads via the CLI without writing a custom handler.
 *
 * 3. The credential store reads from the caller-provided credentials map, with
 *    informative error messages that name the missing credential (helpful since
 *    the developer is iterating against a real manifest).
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
import type { DevContextOptions, DevLogEntry } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Augmented dev context type (exposes captured logs for the run summary)
// ─────────────────────────────────────────────────────────────────────────────

export interface DevContext extends PluginContext {
  /** All log entries written during this run. Read after the run completes. */
  __logs: DevLogEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Empty ontology default — connectors do not normally read the ontology
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_ONTOLOGY: OntologySchema = {
  entityTypes: [],
  version: 0,
  updatedAt: new Date(0).toISOString(),
};

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a development-mode PluginContext.
 *
 * @param options Configuration for the dev context.
 * @returns A PluginContext with a console-logging logger, in-memory cache,
 *          URL-matching fetch proxy, and a file-backed credential store.
 */
export function createDevContext(options: DevContextOptions = {}): DevContext {
  const {
    tenantId = "dev-tenant",
    instanceId = "dev-instance",
    credentials: credentialMap = {},
    config = {},
    mockData = {},
    allowRealFetch = false,
  } = options;

  // ── Credentials ────────────────────────────────────────────────────────────
  // The dev server does not redact credential values in logs because it is
  // running entirely locally. We still avoid logging them proactively.
  const devCredentials: CredentialAccessor = {
    async get(name: string): Promise<string> {
      const value = credentialMap[name];
      if (value === undefined) {
        throw new PluginAuthError(
          `Dev credential not found: "${name}". ` +
            `Provide it via --credentials <file.json> or the credentials option.`,
        );
      }
      return value;
    },

    async list(): Promise<string[]> {
      return Object.keys(credentialMap);
    },
  };

  // ── Fetch ──────────────────────────────────────────────────────────────────
  // URL matching uses substring search so developers can provide concise keys
  // like "api.example.com/items" rather than exact URLs.

  // Emit a prominent warning once if allowRealFetch is enabled so developers
  // are aware that the sandbox URL allowlist is not enforced.
  if (allowRealFetch) {
    process.stderr.write(
      "\n" +
      "  ╔══════════════════════════════════════════════════════════════════╗\n" +
      "  ║  WARNING: allowRealFetch is ON                                 ║\n" +
      "  ║  All fetch() calls will bypass URL allowlist restrictions.      ║\n" +
      "  ║  In production, only URLs matching requiredExternalUrls in the  ║\n" +
      "  ║  manifest are permitted. Disable this flag before publishing.   ║\n" +
      "  ╚══════════════════════════════════════════════════════════════════╝\n" +
      "\n",
    );
  }

  const devFetch: FetchProxy = {
    async fetch(url: string, init?: RequestInit): Promise<Response> {
      if (allowRealFetch) {
        return globalThis.fetch(url, init);
      }

      // Find the first mockData key that appears as a substring of the URL.
      for (const [pattern, payload] of Object.entries(mockData)) {
        if (url.includes(pattern)) {
          return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      // Default: return a 200 with an empty object so plugins that check the
      // status code succeed without a developer-provided mock.
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };

  // ── Cache ──────────────────────────────────────────────────────────────────
  // In-memory map. TTL is tracked but not enforced — dev runs are short-lived
  // and re-check-TTL-in-flight complexity is not worthwhile here.
  const cacheStore = new Map<string, unknown>();

  const devCache: CacheAccessor = {
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

    // Locks always succeed in the single-process dev server.
    async lock(_key: string, _ttlSeconds: number): Promise<LockHandle | null> {
      return {
        async release(): Promise<void> {
          // no-op: no distributed lock to release in dev
        },
      };
    },
  };

  // ── Logger ─────────────────────────────────────────────────────────────────
  // Writes to stderr so stdout can remain clean for machine-readable output.
  // Also captures every entry so the run summary can include the full log list.
  const logs: DevLogEntry[] = [];

  function writeLog(
    level: DevLogEntry["level"],
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    logs.push({ level, message, ...(metadata !== undefined ? { metadata } : {}) });

    const prefix = `[plugin:${level.toUpperCase()}]`;
    const suffix =
      metadata !== undefined ? ` ${JSON.stringify(metadata)}` : "";
    process.stderr.write(`${prefix} ${message}${suffix}\n`);
  }

  const devLogger: PluginLogger = {
    debug: (msg, meta) => writeLog("debug", msg, meta),
    info:  (msg, meta) => writeLog("info",  msg, meta),
    warn:  (msg, meta) => writeLog("warn",  msg, meta),
    error: (msg, meta) => writeLog("error", msg, meta),
  };

  // ── Tenant ─────────────────────────────────────────────────────────────────
  const tenant: TenantContext = {
    tenantId,
    tenantName: "Dev Tenant",
    config,
    instanceId,
  };

  // ── Ontology ───────────────────────────────────────────────────────────────
  let cachedSchema: OntologySchema | null = null;

  const devOntology: OntologyAccessor = {
    async getSchema(): Promise<OntologySchema> {
      if (cachedSchema === null) {
        cachedSchema = EMPTY_ONTOLOGY;
      }
      return cachedSchema;
    },

    async getEntitySchema(entityType: string): Promise<EntitySchema | null> {
      const schema = cachedSchema ?? EMPTY_ONTOLOGY;
      return schema.entityTypes.find((e) => e.name === entityType) ?? null;
    },
  };

  // ── Tracing ─────────────────────────────────────────────────────────────────
  // Synthetic trace IDs so plugin code that reads them gets valid-looking values.
  const devTracing: TracingContext = {
    injectHeaders(headers: Record<string, string>): Record<string, string> {
      return {
        ...headers,
        traceparent: "00-devdevdevdevdevdevdevdevdevdev01-devdev0000000001-01",
      };
    },

    startSpan(name: string): SpanHandle {
      const startMs = Date.now();
      process.stderr.write(`[plugin:SPAN] start "${name}"\n`);

      return {
        setAttribute(key: string, value: string | number | boolean): void {
          process.stderr.write(`[plugin:SPAN] "${name}" ${key}=${String(value)}\n`);
        },

        end(): void {
          const durationMs = Date.now() - startMs;
          process.stderr.write(`[plugin:SPAN] end "${name}" (${durationMs}ms)\n`);
        },
      };
    },
  };

  return {
    credentials: devCredentials,
    fetch: devFetch,
    cache: devCache,
    logger: devLogger,
    tenant,
    ontology: devOntology,
    tracing: devTracing,
    __logs: logs,
  };
}
