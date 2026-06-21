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

export interface ConnectorRegistryEntry {
  type: string;
  displayName: string;
  description: string;
  version: string;
  category: ConnectorCategory;
  author: string;
  icon?: string;
  configSchema: Record<string, unknown>;
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
    type: "oneplatform.rest-api",
    displayName: "REST API",
    description:
      "Fetch data from any HTTP/HTTPS REST endpoint. Supports pagination, " +
      "authentication headers, and incremental fetching via cursor or date fields.",
    version: "1.0.0",
    category: "api",
    author: "OnePlatform",
    icon: "Globe",
    configSchema: {
      type: "object",
      required: ["baseUrl"],
      properties: {
        baseUrl: { type: "string", format: "uri", description: "Base URL of the REST API" },
        method: { type: "string", enum: ["GET", "POST"], default: "GET", description: "HTTP method" },
        headers: { type: "object", description: "Static request headers (e.g. auth tokens)" },
        paginationType: {
          type: "string",
          enum: ["none", "offset", "cursor", "link-header"],
          default: "none",
          description: "Pagination strategy",
        },
        pageSize: { type: "integer", default: 100, description: "Records per page" },
        dataPath: { type: "string", description: "JSONPath to the records array in the response" },
        cursorField: { type: "string", description: "Field name to use as incremental cursor" },
        timeoutMs: { type: "integer", default: 30000, description: "Request timeout in milliseconds" },
      },
    },
    capabilities: { supportsIncremental: true, supportsRealtime: false, supportsCdc: false },
    tags: ["http", "rest", "api", "polling"],
    builtIn: true,
  },
  {
    type: "oneplatform.postgresql",
    displayName: "PostgreSQL",
    description:
      "Sync data from a PostgreSQL database using full-table or incremental " +
      "queries. For change-data-capture (WAL streaming) use the PostgreSQL CDC connector.",
    version: "1.0.0",
    category: "database",
    author: "OnePlatform",
    icon: "Database",
    configSchema: {
      type: "object",
      required: ["host", "database", "user", "password", "table", "incrementalColumn"],
      properties: {
        host: { type: "string", description: "PostgreSQL hostname or IP" },
        port: { type: "integer", default: 5432, description: "PostgreSQL port" },
        database: { type: "string", description: "Database name" },
        user: { type: "string", description: "Database user" },
        password: { type: "string", format: "password", description: "Database password" },
        schema: { type: "string", default: "public", description: "Schema name" },
        table: { type: "string", description: "Table or view to sync" },
        incrementalColumn: { type: "string", description: "Column to use for incremental sync (e.g. updated_at)" },
        proxyUrl: { type: "string", description: "HTTP(S) proxy URL for outbound connections" },
        connectTimeoutMs: { type: "integer", default: 10000, description: "Connection timeout in milliseconds" },
        ssl: { type: "boolean", default: false, description: "Enable SSL/TLS" },
      },
    },
    capabilities: { supportsIncremental: true, supportsRealtime: false, supportsCdc: false },
    tags: ["database", "sql", "postgres", "relational"],
    builtIn: true,
  },
  {
    type: "oneplatform.mysql",
    displayName: "MySQL",
    description:
      "Sync data from a MySQL or MariaDB database using full-table or incremental " +
      "queries based on an auto-incrementing ID or timestamp column.",
    version: "1.0.0",
    category: "database",
    author: "OnePlatform",
    icon: "Database",
    configSchema: {
      type: "object",
      required: ["host", "database", "user", "password"],
      properties: {
        host: { type: "string", description: "MySQL hostname or IP" },
        port: { type: "integer", default: 3306, description: "MySQL port" },
        database: { type: "string", description: "Database name" },
        user: { type: "string", description: "Database user" },
        password: { type: "string", format: "password", description: "Database password" },
        table: { type: "string", description: "Table to sync" },
        incrementalColumn: { type: "string", description: "Column for incremental sync" },
        connectTimeoutMs: { type: "integer", default: 10000, description: "Connection timeout in milliseconds" },
        ssl: { type: "boolean", default: false, description: "Enable SSL/TLS" },
      },
    },
    capabilities: { supportsIncremental: true, supportsRealtime: false, supportsCdc: false },
    tags: ["database", "sql", "mysql", "mariadb", "relational"],
    builtIn: true,
  },
  {
    type: "oneplatform.csv",
    displayName: "CSV / File Upload",
    description:
      "Import structured data from CSV, TSV, or JSON-lines files. Files can be " +
      "uploaded directly or fetched from an HTTPS URL on each sync run.",
    version: "1.0.0",
    category: "file",
    author: "OnePlatform",
    icon: "FileText",
    configSchema: {
      type: "object",
      properties: {
        sourceUrl: { type: "string", format: "uri", description: "URL to fetch file from (optional — leave blank to upload manually)" },
        delimiter: { type: "string", default: ",", description: "Field delimiter character" },
        hasHeader: { type: "boolean", default: true, description: "Whether the first row is a header" },
        encoding: { type: "string", default: "utf-8", description: "File encoding" },
        skipRows: { type: "integer", default: 0, description: "Number of rows to skip before the header" },
        maxFileSizeMb: { type: "integer", default: 500, description: "Maximum file size in megabytes" },
      },
    },
    capabilities: { supportsIncremental: false, supportsRealtime: false, supportsCdc: false },
    tags: ["file", "csv", "tsv", "json", "batch", "upload"],
    builtIn: true,
  },
  {
    type: "oneplatform.webhook",
    displayName: "Webhook Receiver",
    description:
      "Receive real-time event data over HTTP from external services such as " +
      "Stripe, GitHub, or any system that supports outbound webhooks. " +
      "HMAC signature verification keeps the endpoint secure.",
    version: "1.0.0",
    category: "webhook",
    author: "OnePlatform",
    icon: "Zap",
    configSchema: {
      type: "object",
      properties: {
        hmacAlgorithm: {
          type: "string",
          enum: ["sha256", "sha512"],
          default: "sha256",
          description: "HMAC algorithm for signature verification",
        },
        headerName: {
          type: "string",
          default: "X-Webhook-Signature",
          description: "Header that carries the HMAC signature",
        },
        payloadTransform: {
          type: "string",
          description: "Optional JSONPath expression to extract the data array from the payload",
        },
      },
    },
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
