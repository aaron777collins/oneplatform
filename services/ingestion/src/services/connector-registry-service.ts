/**
 * ConnectorRegistryService — hosted catalog of available connector types.
 *
 * Maintains an in-memory registry of connector definitions so the UI can browse,
 * search, and filter what is available before creating a live connector instance.
 * Built-in connectors are auto-registered at startup and always appear first in
 * results; third-party connectors are registered via registerConnector().
 *
 * Version tracking: each registration call for a known type appends to the
 * version history rather than overwriting, preserving the audit trail.
 *
 * Install counting: incrementInstallCount() is called by the install route so
 * the catalog reflects real-world popularity without requiring a database.
 * The registry is process-scoped (resets on restart), which is acceptable for
 * a v1 in-process catalog. A persistent backing store can be added later.
 */

import { AppError } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ConnectorCategory =
  | "database"
  | "api"
  | "file"
  | "streaming"
  | "webhook"
  | "custom";

export interface ConnectorCapabilities {
  supportsIncremental: boolean;
  supportsRealtime: boolean;
  supportsCdc: boolean;
}

export interface CredentialFieldSpec {
  name: string;
  description: string;
  type: "secret" | "token" | "password";
  required: boolean;
}

export interface ConnectorRegistryEntry {
  type: string;
  displayName: string;
  description: string;
  version: string;
  category: ConnectorCategory;
  author: string;
  icon?: string;
  configSchema: Record<string, unknown>;
  requiredCredentials: CredentialFieldSpec[];
  capabilities: ConnectorCapabilities;
  tags: string[];
  builtIn: boolean;
  installCount: number;
}

export interface ConnectorVersionEntry {
  version: string;
  registeredAt: Date;
  changelog?: string;
}

export interface RegistryListOptions {
  search?: string;
  category?: ConnectorCategory | string;
  sortBy?: "popular" | "recent" | "name";
  cursor?: string;
  limit?: number;
}

export interface RegistryListResult {
  items: ConnectorRegistryEntry[];
  nextCursor: string | null;
  total: number;
}

export interface RegisterConnectorInput {
  type: string;
  displayName: string;
  description: string;
  version: string;
  category: ConnectorCategory;
  author: string;
  icon?: string;
  configSchema: Record<string, unknown>;
  requiredCredentials?: CredentialFieldSpec[];
  capabilities?: Partial<ConnectorCapabilities>;
  tags?: string[];
  builtIn?: boolean;
  changelog?: string;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class ConnectorTypeNotFoundError extends AppError {
  readonly code = "REGISTRY_CONNECTOR_NOT_FOUND" as const;
  readonly statusCode = 404;
}

export class ConnectorTypeAlreadyExistsError extends AppError {
  readonly code = "REGISTRY_CONNECTOR_ALREADY_EXISTS" as const;
  readonly statusCode = 409;
}

export class ConnectorRegistryValidationError extends AppError {
  readonly code = "REGISTRY_VALIDATION_ERROR" as const;
  readonly statusCode = 400;
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface ConnectorRegistryService {
  listConnectors(options: RegistryListOptions): Promise<RegistryListResult>;
  getConnectorDetails(connectorType: string): Promise<ConnectorRegistryEntry>;
  registerConnector(input: RegisterConnectorInput): Promise<ConnectorRegistryEntry>;
  getConnectorVersions(connectorType: string): Promise<ConnectorVersionEntry[]>;
  incrementInstallCount(connectorType: string): Promise<void>;
  isRegistered(connectorType: string): boolean;
}

// ---------------------------------------------------------------------------
// Internal storage types
// ---------------------------------------------------------------------------

interface RegistryRecord {
  entry: ConnectorRegistryEntry;
  versions: ConnectorVersionEntry[];
  // ISO string of the most recent registration — used for "recent" sort order
  lastRegisteredAt: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createConnectorRegistryService(): ConnectorRegistryService {
  // In-memory Map is intentional for single-instance deployments: the registry
  // is rebuilt at startup from BUILTIN_CONNECTOR_MANIFESTS and populated at
  // runtime via registerConnector(). State resets on process restart, which is
  // acceptable because built-in descriptors are always re-registered.
  //
  // HA / multi-instance deployments should back this with Redis (HSET/HGETALL
  // per connector type) or a Postgres table so registrations survive restarts
  // and are consistent across replicas.
  // TODO(OP-INFRA-42): Back ConnectorRegistryService with Redis for HA support.
  const registry = new Map<string, RegistryRecord>();

  // ---------------------------------------------------------------------------
  // Input validation
  // ---------------------------------------------------------------------------

  function validateInput(input: RegisterConnectorInput): void {
    if (input.type.trim() === "") {
      throw new ConnectorRegistryValidationError(
        'Connector type must not be empty.',
      );
    }
    if (input.displayName.trim() === "") {
      throw new ConnectorRegistryValidationError(
        'Connector displayName must not be empty.',
      );
    }
    if (input.version.trim() === "") {
      throw new ConnectorRegistryValidationError(
        'Connector version must not be empty.',
      );
    }
    if (input.author.trim() === "") {
      throw new ConnectorRegistryValidationError(
        'Connector author must not be empty.',
      );
    }
    const validCategories: ConnectorCategory[] = [
      "database", "api", "file", "streaming", "webhook", "custom",
    ];
    if (!validCategories.includes(input.category)) {
      throw new ConnectorRegistryValidationError(
        `Invalid category "${input.category}". Must be one of: ${validCategories.join(", ")}.`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // listConnectors
  // ---------------------------------------------------------------------------

  async function listConnectors(options: RegistryListOptions): Promise<RegistryListResult> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

    // Collect all entries, normalising to a stable list for filtering/sorting.
    let items = Array.from(registry.values()).map((r) => r.entry);

    // Full-text search against type, displayName, description, and tags.
    if (options.search !== undefined && options.search.trim() !== "") {
      const needle = options.search.trim().toLowerCase();
      items = items.filter((e) =>
        e.type.toLowerCase().includes(needle) ||
        e.displayName.toLowerCase().includes(needle) ||
        e.description.toLowerCase().includes(needle) ||
        e.tags.some((tag) => tag.toLowerCase().includes(needle)),
      );
    }

    if (options.category !== undefined && options.category !== "") {
      items = items.filter((e) => e.category === options.category);
    }

    // Built-ins always appear first regardless of sort; within each group apply
    // the secondary sort. This matches the spec requirement.
    const sortFn = buildSortFn(options.sortBy ?? "popular");
    const builtIns = items.filter((e) => e.builtIn).sort(sortFn);
    const thirdParty = items.filter((e) => !e.builtIn).sort(sortFn);
    items = [...builtIns, ...thirdParty];

    const total = items.length;

    // Cursor is the index encoded as a base-10 string for simplicity.
    // Index-based cursors are safe here because the registry is append-only
    // (no deletions), so a stale cursor advances to the next available item
    // rather than skipping items silently.
    let startIdx = 0;
    if (options.cursor !== undefined) {
      const decoded = parseInt(options.cursor, 10);
      if (!isNaN(decoded) && decoded > 0) {
        startIdx = decoded;
      }
    }

    const page = items.slice(startIdx, startIdx + limit);
    const nextCursor = startIdx + limit < total
      ? String(startIdx + limit)
      : null;

    return { items: page, nextCursor, total };
  }

  // ---------------------------------------------------------------------------
  // getConnectorDetails
  // ---------------------------------------------------------------------------

  async function getConnectorDetails(connectorType: string): Promise<ConnectorRegistryEntry> {
    const record = registry.get(connectorType);
    if (record === undefined) {
      throw new ConnectorTypeNotFoundError(
        `Connector type "${connectorType}" is not registered.`,
        { connectorType },
      );
    }
    return record.entry;
  }

  // ---------------------------------------------------------------------------
  // registerConnector
  // ---------------------------------------------------------------------------

  async function registerConnector(input: RegisterConnectorInput): Promise<ConnectorRegistryEntry> {
    validateInput(input);

    const now = new Date().toISOString();
    const existing = registry.get(input.type);

    if (existing !== undefined) {
      // Update entry in place: bump version, update mutable fields, preserve
      // install count and builtIn flag. Append a new version history entry.
      const updatedEntry: ConnectorRegistryEntry = {
        ...existing.entry,
        displayName: input.displayName,
        description: input.description,
        version: input.version,
        category: input.category,
        author: input.author,
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
        configSchema: input.configSchema,
        requiredCredentials: input.requiredCredentials ?? existing.entry.requiredCredentials,
        capabilities: {
          supportsIncremental: input.capabilities?.supportsIncremental ?? existing.entry.capabilities.supportsIncremental,
          supportsRealtime: input.capabilities?.supportsRealtime ?? existing.entry.capabilities.supportsRealtime,
          supportsCdc: input.capabilities?.supportsCdc ?? existing.entry.capabilities.supportsCdc,
        },
        tags: input.tags ?? existing.entry.tags,
      };

      const versionEntry: ConnectorVersionEntry = {
        version: input.version,
        registeredAt: new Date(),
        ...(input.changelog !== undefined ? { changelog: input.changelog } : {}),
      };

      registry.set(input.type, {
        entry: updatedEntry,
        versions: [...existing.versions, versionEntry],
        lastRegisteredAt: now,
      });

      return updatedEntry;
    }

    // New registration
    const entry: ConnectorRegistryEntry = {
      type: input.type,
      displayName: input.displayName,
      description: input.description,
      version: input.version,
      category: input.category,
      author: input.author,
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
      configSchema: input.configSchema,
      requiredCredentials: input.requiredCredentials ?? [],
      capabilities: {
        supportsIncremental: input.capabilities?.supportsIncremental ?? false,
        supportsRealtime: input.capabilities?.supportsRealtime ?? false,
        supportsCdc: input.capabilities?.supportsCdc ?? false,
      },
      tags: input.tags ?? [],
      builtIn: input.builtIn ?? false,
      installCount: 0,
    };

    const versionEntry: ConnectorVersionEntry = {
      version: input.version,
      registeredAt: new Date(),
      ...(input.changelog !== undefined ? { changelog: input.changelog } : {}),
    };

    registry.set(input.type, {
      entry,
      versions: [versionEntry],
      lastRegisteredAt: now,
    });

    return entry;
  }

  // ---------------------------------------------------------------------------
  // getConnectorVersions
  // ---------------------------------------------------------------------------

  async function getConnectorVersions(connectorType: string): Promise<ConnectorVersionEntry[]> {
    const record = registry.get(connectorType);
    if (record === undefined) {
      throw new ConnectorTypeNotFoundError(
        `Connector type "${connectorType}" is not registered.`,
        { connectorType },
      );
    }
    // Return newest-first so callers don't need to reverse.
    return [...record.versions].reverse();
  }

  // ---------------------------------------------------------------------------
  // incrementInstallCount
  // ---------------------------------------------------------------------------

  async function incrementInstallCount(connectorType: string): Promise<void> {
    const record = registry.get(connectorType);
    if (record === undefined) {
      throw new ConnectorTypeNotFoundError(
        `Cannot increment install count: connector type "${connectorType}" is not registered.`,
        { connectorType },
      );
    }
    registry.set(connectorType, {
      ...record,
      entry: { ...record.entry, installCount: record.entry.installCount + 1 },
    });
  }

  // ---------------------------------------------------------------------------
  // isRegistered
  // ---------------------------------------------------------------------------

  function isRegistered(connectorType: string): boolean {
    return registry.has(connectorType);
  }

  return {
    listConnectors,
    getConnectorDetails,
    registerConnector,
    getConnectorVersions,
    incrementInstallCount,
    isRegistered,
  };
}

// ---------------------------------------------------------------------------
// Sort comparator factory
// ---------------------------------------------------------------------------

function buildSortFn(
  sortBy: "popular" | "recent" | "name",
): (a: ConnectorRegistryEntry, b: ConnectorRegistryEntry) => number {
  switch (sortBy) {
    case "popular":
      // Descending install count; ties broken by name ascending.
      return (a, b) =>
        b.installCount - a.installCount || a.displayName.localeCompare(b.displayName);
    case "name":
      return (a, b) => a.displayName.localeCompare(b.displayName);
    case "recent":
      // "recent" defers to registration order (maintained by Map insertion order).
      // No-op comparator preserves the original order.
      return () => 0;
  }
}

// ---------------------------------------------------------------------------
// Built-in connector definitions
//
// These descriptors are the single source of truth for what the 5 built-in
// connectors expose in the registry. The actual execution logic lives in
// the connector implementations (postgres-cdc-connector.ts, etc.); these
// are metadata-only records for catalog display and schema documentation.
// ---------------------------------------------------------------------------

export const BUILTIN_CONNECTOR_MANIFESTS: RegisterConnectorInput[] = [
  {
    type: "oneplatform.csv",
    displayName: "CSV / Google Sheets",
    description:
      "Import data from any CSV file accessible via HTTPS URL — including Google Sheets " +
      "(use the export-as-CSV link). Supports custom delimiters, optional header rows, " +
      "and authenticated endpoints via bearer token.",
    version: "1.0.0",
    category: "file",
    author: "OnePlatform",
    icon: "FileText",
    configSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: {
          type: "string",
          title: "CSV File URL",
          description: "HTTPS URL to fetch the CSV file from. Supports Google Sheets export URLs, S3 presigned URLs, and any public/authenticated HTTPS endpoint.",
          examples: ["https://docs.google.com/spreadsheets/d/SHEET_ID/export?format=csv"],
        },
        delimiter: {
          type: "string",
          default: ",",
          title: "Delimiter",
          description: "Single character used to separate fields. Use ',' for CSV, '\\t' for TSV, '|' for pipe-delimited.",
          examples: [",", "\\t", "|", ";"],
        },
        hasHeader: {
          type: "boolean",
          default: true,
          title: "First Row is Header",
          description: "When enabled, the first row provides column names. When disabled, columns are named col_0, col_1, etc.",
        },
        encoding: {
          type: "string",
          default: "utf-8",
          title: "Character Encoding",
          description: "Text encoding of the CSV file. Most files use UTF-8.",
          examples: ["utf-8", "latin1", "windows-1252"],
        },
        idColumn: {
          type: "string",
          title: "ID Column (optional)",
          description: "Column name to use as the unique record identifier. When omitted, the row number is used as the ID.",
          examples: ["id", "order_id", "email"],
        },
        batchSize: {
          type: "number",
          default: 500,
          minimum: 1,
          maximum: 10000,
          title: "Batch Size",
          description: "Number of rows to process per batch. The default of 500 works well for most files.",
        },
      },
    },
    requiredCredentials: [
      { name: "bearerToken", description: "Bearer token for authenticated endpoints. Leave blank for public URLs like Google Sheets.", type: "token" as const, required: false },
    ],
    capabilities: { supportsIncremental: false, supportsRealtime: false, supportsCdc: false },
    tags: ["file", "csv", "tsv", "google-sheets", "import", "data-source"],
    builtIn: true,
  },
  {
    type: "oneplatform.postgresql",
    displayName: "PostgreSQL",
    description:
      "Sync data from a PostgreSQL database via a REST proxy. Supports full-table scans, " +
      "incremental cursor-based sync, and custom SQL queries.",
    version: "1.0.0",
    category: "database",
    author: "OnePlatform",
    icon: "Database",
    configSchema: {
      type: "object",
      required: ["proxyUrl"],
      properties: {
        proxyUrl: {
          type: "string",
          title: "Database Proxy URL",
          description: "Base URL of the PostgreSQL REST proxy (PostgREST, pgweb, or the platform DB proxy). Must be HTTPS.",
          examples: ["https://db-proxy.example.com"],
        },
        table: {
          type: "string",
          title: "Table Name",
          description: "PostgreSQL table or view to sync records from.",
          examples: ["users", "orders", "products"],
        },
        schema: {
          type: "string",
          default: "public",
          title: "Schema",
          description: "Database schema name. Defaults to 'public'.",
          examples: ["public", "app", "analytics"],
        },
        incrementalColumn: {
          type: "string",
          title: "Incremental Column (optional)",
          description: "Column used as cursor for incremental sync. Only rows where this column is greater than the last sync value are fetched.",
          examples: ["updated_at", "created_at", "id"],
        },
        batchSize: {
          type: "number",
          default: 1000,
          minimum: 1,
          maximum: 10000,
          title: "Batch Size",
          description: "Number of rows to fetch per batch.",
        },
        customQuery: {
          type: "string",
          title: "Custom SQL Query (optional)",
          description: "Raw SQL SELECT query. When provided, overrides the table setting. The proxy must support /rpc/query.",
          examples: ["SELECT id, name, email FROM users WHERE active = true"],
        },
        primaryKey: {
          type: "string",
          title: "Primary Key Column",
          description: "Column to use as the record's unique identifier. Defaults to 'id'.",
          examples: ["id", "user_id", "uuid"],
        },
      },
    },
    requiredCredentials: [
      { name: "connectionString", description: "PostgreSQL connection string (postgresql://user:password@host:port/dbname).", type: "secret" as const, required: true },
    ],
    capabilities: { supportsIncremental: true, supportsRealtime: false, supportsCdc: false },
    tags: ["database", "sql", "postgres", "postgresql", "relational"],
    builtIn: true,
  },
  {
    type: "oneplatform.mysql",
    displayName: "MySQL",
    description:
      "Sync data from a MySQL or MariaDB database via a REST proxy. Supports full-table " +
      "scans, incremental cursor-based sync, and custom SQL queries.",
    version: "1.0.0",
    category: "database",
    author: "OnePlatform",
    icon: "Database",
    configSchema: {
      type: "object",
      required: ["proxyUrl", "database", "table"],
      properties: {
        proxyUrl: {
          type: "string",
          title: "Database Proxy URL",
          description: "URL of the MySQL REST proxy that executes queries on behalf of the sandbox. Required because plugins cannot open raw TCP sockets.",
          examples: ["https://mysql-proxy.example.com"],
        },
        database: {
          type: "string",
          title: "Database Name",
          description: "MySQL database (schema) to connect to.",
          examples: ["myapp", "analytics", "production"],
        },
        table: {
          type: "string",
          title: "Table Name",
          description: "Table to extract records from. Ignored when a custom query is provided.",
          examples: ["users", "orders", "events"],
        },
        incrementalColumn: {
          type: "string",
          title: "Incremental Column (optional)",
          description: "Column used for incremental sync. Only rows where this column exceeds the last cursor value are fetched.",
          examples: ["updated_at", "created_at", "id"],
        },
        batchSize: {
          type: "number",
          default: 1000,
          minimum: 1,
          maximum: 10000,
          title: "Batch Size",
          description: "Number of rows to fetch per batch.",
        },
        customQuery: {
          type: "string",
          title: "Custom SQL Query (optional)",
          description: "SQL SELECT query. When provided, table and incrementalColumn are ignored. Must not include LIMIT or OFFSET.",
          examples: ["SELECT id, name, total FROM orders WHERE status = 'complete'"],
        },
      },
    },
    requiredCredentials: [
      { name: "connectionString", description: "MySQL connection string (mysql://user:password@host:port/database).", type: "secret" as const, required: true },
    ],
    capabilities: { supportsIncremental: true, supportsRealtime: false, supportsCdc: false },
    tags: ["database", "sql", "mysql", "mariadb", "relational"],
    builtIn: true,
  },
  {
    type: "oneplatform.rest-api",
    displayName: "REST API",
    description:
      "Fetch data from any REST API endpoint. Supports offset, cursor, and link-header " +
      "pagination, incremental sync, and multiple authentication methods.",
    version: "1.0.0",
    category: "api",
    author: "OnePlatform",
    icon: "Globe",
    configSchema: {
      type: "object",
      required: ["baseUrl", "endpoint"],
      properties: {
        baseUrl: {
          type: "string",
          title: "Base URL",
          description: "Base URL of the REST API, without trailing slash.",
          examples: ["https://api.example.com/v1", "https://jsonplaceholder.typicode.com"],
        },
        endpoint: {
          type: "string",
          title: "API Endpoint",
          description: "Path to the resource, relative to the base URL.",
          examples: ["/orders", "/users", "/data/records"],
        },
        method: {
          type: "string",
          enum: ["GET", "POST"],
          default: "GET",
          title: "HTTP Method",
          description: "HTTP method to use when fetching records.",
        },
        headers: {
          type: "object",
          title: "Request Headers (optional)",
          description: "Static headers to include with every request, as key-value pairs. Example: { \"Accept\": \"application/json\" }",
        },
        responseDataPath: {
          type: "string",
          title: "Response Data Path (optional)",
          description: "Dot-delimited path to the records array in the JSON response. Omit if the response root is the array.",
          examples: ["data", "results.items", "response.records"],
        },
        paginationType: {
          type: "string",
          enum: ["none", "offset", "cursor", "link"],
          default: "none",
          title: "Pagination Strategy",
          description: "How the API paginates results: 'none' for single request, 'offset' for ?offset=N&limit=N, 'cursor' for ?cursor=TOKEN, 'link' for Link header rel=next.",
        },
        pageSize: {
          type: "number",
          default: 100,
          minimum: 1,
          maximum: 10000,
          title: "Page Size",
          description: "Number of records to request per page.",
        },
        incrementalField: {
          type: "string",
          title: "Incremental Field (optional)",
          description: "Field name for incremental sync. After first run, appends ?{field}={lastValue} to filter for new records only.",
          examples: ["updated_at", "modified_since", "last_id"],
        },
      },
    },
    requiredCredentials: [
      { name: "apiKey", description: "API key sent as X-API-Key header.", type: "secret", required: false },
      { name: "bearerToken", description: "Bearer token sent as Authorization header.", type: "token", required: false },
      { name: "username", description: "Username for HTTP Basic authentication.", type: "secret", required: false },
      { name: "password", description: "Password for HTTP Basic authentication.", type: "password", required: false },
    ],
    capabilities: { supportsIncremental: true, supportsRealtime: false, supportsCdc: false },
    tags: ["http", "rest", "api", "polling"],
    builtIn: true,
  },
  {
    type: "oneplatform.webhook",
    displayName: "Webhook Receiver",
    description:
      "Receive real-time event data over HTTP from external services such as Stripe, " +
      "GitHub, or any system that supports outbound webhooks. Supports HMAC signature " +
      "verification for payload authenticity.",
    version: "1.0.0",
    category: "webhook",
    author: "OnePlatform",
    icon: "Zap",
    configSchema: {
      type: "object",
      required: ["webhookPath"],
      properties: {
        webhookPath: {
          type: "string",
          title: "Webhook Path",
          description: "URL path segment for receiving webhooks. External services POST to /api/v1/ingestion/webhooks/{connectorId}.",
          examples: ["my-webhook", "stripe-events", "github-hooks"],
          minLength: 1,
          maxLength: 100,
        },
        signatureHeader: {
          type: "string",
          title: "Signature Header (optional)",
          description: "HTTP header containing the HMAC signature for verification. Required when signature verification is enabled.",
          examples: ["X-Hub-Signature-256", "Stripe-Signature", "X-Webhook-Signature"],
        },
        signatureAlgorithm: {
          type: "string",
          enum: ["sha256", "sha1"],
          default: "sha256",
          title: "Signature Algorithm",
          description: "HMAC algorithm for signature verification. SHA-256 is strongly recommended; SHA-1 is for legacy compatibility only.",
        },
        idField: {
          type: "string",
          title: "ID Field (optional)",
          description: "Dot-notation path to a field in the webhook payload to use as the record ID. When omitted, a platform-assigned ID is used.",
          examples: ["id", "event.id", "data.order_id"],
        },
        batchSize: {
          type: "number",
          default: 100,
          minimum: 1,
          maximum: 1000,
          title: "Batch Size",
          description: "Maximum number of queued webhook payloads to process per batch.",
        },
      },
    },
    requiredCredentials: [
      { name: "signatureSecret", description: "HMAC secret for verifying webhook signatures. Leave blank to skip verification.", type: "secret" as const, required: false },
    ],
    capabilities: { supportsIncremental: false, supportsRealtime: true, supportsCdc: false },
    tags: ["webhook", "realtime", "push", "events", "http"],
    builtIn: true,
  },
];

// ---------------------------------------------------------------------------
// Bootstrap helper — called once at service startup
// ---------------------------------------------------------------------------

export async function registerBuiltinConnectors(
  registryService: ConnectorRegistryService,
): Promise<void> {
  for (const manifest of BUILTIN_CONNECTOR_MANIFESTS) {
    await registryService.registerConnector(manifest);
  }
}
