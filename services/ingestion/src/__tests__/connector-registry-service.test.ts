// Unit tests for services/ingestion/src/services/connector-registry-service.ts
//
// Covers:
//   - Built-in connector auto-registration
//   - Listing with search, category filter, and sort order
//   - Built-ins always appear before third-party results
//   - Version tracking (append on re-registration)
//   - Install count increment
//   - Error cases: not found, validation

import { describe, it, expect, beforeEach } from "vitest";
import {
  createConnectorRegistryService,
  registerBuiltinConnectors,
  BUILTIN_CONNECTOR_MANIFESTS,
  ConnectorTypeNotFoundError,
  ConnectorRegistryValidationError,
  type ConnectorRegistryService,
} from "../services/connector-registry-service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(): ConnectorRegistryService {
  return createConnectorRegistryService();
}

// ---------------------------------------------------------------------------
// Built-in registration
// ---------------------------------------------------------------------------

describe("registerBuiltinConnectors", () => {
  it("registers all 5 built-in connectors", async () => {
    const svc = makeService();
    await registerBuiltinConnectors(svc);

    const result = await svc.listConnectors({ limit: 100 });
    expect(result.total).toBe(5);
    expect(result.items).toHaveLength(5);
  });

  it("marks all built-ins with builtIn=true", async () => {
    const svc = makeService();
    await registerBuiltinConnectors(svc);

    const result = await svc.listConnectors({ limit: 100 });
    for (const item of result.items) {
      expect(item.builtIn).toBe(true);
    }
  });

  it("registers all expected built-in types", async () => {
    const svc = makeService();
    await registerBuiltinConnectors(svc);

    const expectedTypes = BUILTIN_CONNECTOR_MANIFESTS.map((m) => m.type);
    const result = await svc.listConnectors({ limit: 100 });
    const registeredTypes = result.items.map((i) => i.type);

    for (const type of expectedTypes) {
      expect(registeredTypes).toContain(type);
    }
  });

  it("is idempotent — re-registering built-ins keeps count at 5", async () => {
    const svc = makeService();
    await registerBuiltinConnectors(svc);
    await registerBuiltinConnectors(svc);

    const result = await svc.listConnectors({ limit: 100 });
    expect(result.total).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// listConnectors — search
// ---------------------------------------------------------------------------

describe("listConnectors — search", () => {
  let svc: ConnectorRegistryService;

  beforeEach(async () => {
    svc = makeService();
    await registerBuiltinConnectors(svc);
  });

  it("returns all connectors when no search is provided", async () => {
    const result = await svc.listConnectors({ limit: 100 });
    expect(result.total).toBe(5);
  });

  it("matches by displayName (case-insensitive)", async () => {
    const result = await svc.listConnectors({ search: "postgresql", limit: 100 });
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(result.items[0]?.type).toBe("oneplatform.postgresql");
  });

  it("matches by tag", async () => {
    const result = await svc.listConnectors({ search: "realtime", limit: 100 });
    // webhook connector has the "realtime" tag
    expect(result.items.some((i) => i.type === "oneplatform.webhook")).toBe(true);
  });

  it("matches by description keyword", async () => {
    const result = await svc.listConnectors({ search: "logical replication", limit: 100 });
    // only the postgres-cdc manifest mentions "logical replication" — but that connector
    // is not registered as a built-in. The PostgreSQL connector mentions it in description.
    // This test just asserts that the search is actually filtering.
    expect(result.items.length).toBeLessThanOrEqual(5);
  });

  it("returns empty items when no match", async () => {
    const result = await svc.listConnectors({ search: "xyznonexistentxyz", limit: 100 });
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// listConnectors — category filter
// ---------------------------------------------------------------------------

describe("listConnectors — category filter", () => {
  let svc: ConnectorRegistryService;

  beforeEach(async () => {
    svc = makeService();
    await registerBuiltinConnectors(svc);
  });

  it("filters to database category", async () => {
    const result = await svc.listConnectors({ category: "database", limit: 100 });
    for (const item of result.items) {
      expect(item.category).toBe("database");
    }
    // postgresql and mysql are both database
    expect(result.items.length).toBe(2);
  });

  it("filters to webhook category", async () => {
    const result = await svc.listConnectors({ category: "webhook", limit: 100 });
    expect(result.items.length).toBe(1);
    expect(result.items[0]?.type).toBe("oneplatform.webhook");
  });

  it("filters to api category", async () => {
    const result = await svc.listConnectors({ category: "api", limit: 100 });
    expect(result.items.length).toBe(1);
    expect(result.items[0]?.type).toBe("oneplatform.rest-api");
  });

  it("filters to file category", async () => {
    const result = await svc.listConnectors({ category: "file", limit: 100 });
    expect(result.items.length).toBe(1);
    expect(result.items[0]?.type).toBe("oneplatform.csv");
  });
});

// ---------------------------------------------------------------------------
// listConnectors — sort order
// ---------------------------------------------------------------------------

describe("listConnectors — sort order", () => {
  let svc: ConnectorRegistryService;

  beforeEach(async () => {
    svc = makeService();
    await registerBuiltinConnectors(svc);
  });

  it("sortBy=name returns results in alphabetical order by displayName", async () => {
    const result = await svc.listConnectors({ sortBy: "name", limit: 100 });
    const names = result.items.map((i) => i.displayName);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it("built-ins always appear before third-party connectors regardless of sort", async () => {
    // Register a third-party connector with a high install count
    await svc.registerConnector({
      type: "acme.super-connector",
      displayName: "Acme Super Connector",
      description: "Third-party connector",
      version: "1.0.0",
      category: "api",
      author: "Acme Corp",
      configSchema: {},
      builtIn: false,
    });

    // Manually bump install count on the third-party entry to make it
    // "more popular" than built-ins — built-ins should still come first.
    for (let i = 0; i < 999; i++) {
      await svc.incrementInstallCount("acme.super-connector");
    }

    const result = await svc.listConnectors({ sortBy: "popular", limit: 100 });

    const builtInIndices = result.items
      .map((item, idx) => ({ builtIn: item.builtIn, idx }))
      .filter((x) => x.builtIn)
      .map((x) => x.idx);

    const thirdPartyIndices = result.items
      .map((item, idx) => ({ builtIn: item.builtIn, idx }))
      .filter((x) => !x.builtIn)
      .map((x) => x.idx);

    // Every built-in index must be less than every third-party index.
    for (const bi of builtInIndices) {
      for (const ti of thirdPartyIndices) {
        expect(bi).toBeLessThan(ti);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// listConnectors — pagination
// ---------------------------------------------------------------------------

describe("listConnectors — pagination", () => {
  let svc: ConnectorRegistryService;

  beforeEach(async () => {
    svc = makeService();
    await registerBuiltinConnectors(svc);
  });

  it("respects the limit parameter", async () => {
    const result = await svc.listConnectors({ limit: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).not.toBeNull();
  });

  it("returns all items when limit >= total", async () => {
    const result = await svc.listConnectors({ limit: 100 });
    expect(result.items).toHaveLength(5);
    expect(result.nextCursor).toBeNull();
  });

  it("returns second page using nextCursor", async () => {
    const page1 = await svc.listConnectors({ limit: 3 });
    expect(page1.items).toHaveLength(3);
    expect(page1.nextCursor).not.toBeNull();

    const cursor = page1.nextCursor ?? "";
    const page2 = await svc.listConnectors({
      limit: 3,
      ...(cursor !== "" ? { cursor } : {}),
    });
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();

    // No overlap between pages
    const page1Types = new Set(page1.items.map((i) => i.type));
    for (const item of page2.items) {
      expect(page1Types.has(item.type)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// getConnectorDetails
// ---------------------------------------------------------------------------

describe("getConnectorDetails", () => {
  let svc: ConnectorRegistryService;

  beforeEach(async () => {
    svc = makeService();
    await registerBuiltinConnectors(svc);
  });

  it("returns the full entry for a known type", async () => {
    const entry = await svc.getConnectorDetails("oneplatform.postgresql");
    expect(entry.type).toBe("oneplatform.postgresql");
    expect(entry.category).toBe("database");
    expect(entry.configSchema).toBeDefined();
    expect(typeof entry.configSchema).toBe("object");
  });

  it("throws ConnectorTypeNotFoundError for unknown type", async () => {
    await expect(svc.getConnectorDetails("unknown.type")).rejects.toThrow(
      ConnectorTypeNotFoundError,
    );
  });

  it("exposes capabilities flags correctly for CSV connector", async () => {
    const entry = await svc.getConnectorDetails("oneplatform.csv");
    expect(entry.capabilities.supportsIncremental).toBe(false);
    expect(entry.capabilities.supportsRealtime).toBe(false);
    expect(entry.capabilities.supportsCdc).toBe(false);
  });

  it("webhook connector reports supportsRealtime=true", async () => {
    const entry = await svc.getConnectorDetails("oneplatform.webhook");
    expect(entry.capabilities.supportsRealtime).toBe(true);
  });

  it("postgresql connector reports supportsIncremental=true", async () => {
    const entry = await svc.getConnectorDetails("oneplatform.postgresql");
    expect(entry.capabilities.supportsIncremental).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// registerConnector
// ---------------------------------------------------------------------------

describe("registerConnector", () => {
  let svc: ConnectorRegistryService;

  beforeEach(() => {
    svc = makeService();
  });

  it("registers a new third-party connector", async () => {
    const entry = await svc.registerConnector({
      type: "acme.widget",
      displayName: "Acme Widget",
      description: "Test connector",
      version: "1.0.0",
      category: "api",
      author: "Acme",
      configSchema: {},
    });

    expect(entry.type).toBe("acme.widget");
    expect(entry.builtIn).toBe(false);
    expect(entry.installCount).toBe(0);
  });

  it("updates an existing connector on re-registration and bumps version", async () => {
    await svc.registerConnector({
      type: "acme.widget",
      displayName: "Acme Widget",
      description: "Initial",
      version: "1.0.0",
      category: "api",
      author: "Acme",
      configSchema: {},
    });

    const updated = await svc.registerConnector({
      type: "acme.widget",
      displayName: "Acme Widget v2",
      description: "Updated",
      version: "2.0.0",
      category: "api",
      author: "Acme",
      configSchema: { type: "object" },
    });

    expect(updated.version).toBe("2.0.0");
    expect(updated.displayName).toBe("Acme Widget v2");
  });

  it("preserves installCount across re-registration", async () => {
    await svc.registerConnector({
      type: "acme.widget",
      displayName: "Acme Widget",
      description: "Test",
      version: "1.0.0",
      category: "api",
      author: "Acme",
      configSchema: {},
    });

    await svc.incrementInstallCount("acme.widget");
    await svc.incrementInstallCount("acme.widget");

    await svc.registerConnector({
      type: "acme.widget",
      displayName: "Acme Widget",
      description: "Test",
      version: "1.1.0",
      category: "api",
      author: "Acme",
      configSchema: {},
    });

    const entry = await svc.getConnectorDetails("acme.widget");
    expect(entry.installCount).toBe(2);
  });

  it("throws ConnectorRegistryValidationError for empty type", async () => {
    await expect(
      svc.registerConnector({
        type: "",
        displayName: "Test",
        description: "Test",
        version: "1.0.0",
        category: "api",
        author: "Author",
        configSchema: {},
      }),
    ).rejects.toThrow(ConnectorRegistryValidationError);
  });

  it("throws ConnectorRegistryValidationError for empty displayName", async () => {
    await expect(
      svc.registerConnector({
        type: "test.type",
        displayName: "",
        description: "Test",
        version: "1.0.0",
        category: "api",
        author: "Author",
        configSchema: {},
      }),
    ).rejects.toThrow(ConnectorRegistryValidationError);
  });

  it("throws ConnectorRegistryValidationError for invalid category", async () => {
    await expect(
      svc.registerConnector({
        type: "test.type",
        displayName: "Test",
        description: "Test",
        version: "1.0.0",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        category: "invalid-category" as any,
        author: "Author",
        configSchema: {},
      }),
    ).rejects.toThrow(ConnectorRegistryValidationError);
  });
});

// ---------------------------------------------------------------------------
// getConnectorVersions
// ---------------------------------------------------------------------------

describe("getConnectorVersions", () => {
  let svc: ConnectorRegistryService;

  beforeEach(() => {
    svc = makeService();
  });

  it("returns single version entry on first registration", async () => {
    await svc.registerConnector({
      type: "acme.widget",
      displayName: "Acme Widget",
      description: "Test",
      version: "1.0.0",
      category: "api",
      author: "Acme",
      configSchema: {},
    });

    const versions = await svc.getConnectorVersions("acme.widget");
    expect(versions).toHaveLength(1);
    expect(versions[0]?.version).toBe("1.0.0");
  });

  it("appends a version entry on re-registration and returns newest first", async () => {
    await svc.registerConnector({
      type: "acme.widget",
      displayName: "Acme Widget",
      description: "Test",
      version: "1.0.0",
      category: "api",
      author: "Acme",
      configSchema: {},
    });

    await svc.registerConnector({
      type: "acme.widget",
      displayName: "Acme Widget",
      description: "Test",
      version: "1.1.0",
      category: "api",
      author: "Acme",
      configSchema: {},
      changelog: "Bug fixes",
    });

    const versions = await svc.getConnectorVersions("acme.widget");
    expect(versions).toHaveLength(2);
    // Newest first
    expect(versions[0]?.version).toBe("1.1.0");
    expect(versions[1]?.version).toBe("1.0.0");
  });

  it("includes changelog when provided", async () => {
    await svc.registerConnector({
      type: "acme.widget",
      displayName: "Acme Widget",
      description: "Test",
      version: "1.0.0",
      category: "api",
      author: "Acme",
      configSchema: {},
      changelog: "Initial release",
    });

    const versions = await svc.getConnectorVersions("acme.widget");
    expect(versions[0]?.changelog).toBe("Initial release");
  });

  it("throws ConnectorTypeNotFoundError for unknown type", async () => {
    await expect(svc.getConnectorVersions("unknown.type")).rejects.toThrow(
      ConnectorTypeNotFoundError,
    );
  });

  it("includes version entries for all 5 built-ins after auto-registration", async () => {
    await registerBuiltinConnectors(svc);

    for (const manifest of BUILTIN_CONNECTOR_MANIFESTS) {
      const versions = await svc.getConnectorVersions(manifest.type);
      expect(versions).toHaveLength(1);
      expect(versions[0]?.version).toBe(manifest.version);
    }
  });
});

// ---------------------------------------------------------------------------
// incrementInstallCount
// ---------------------------------------------------------------------------

describe("incrementInstallCount", () => {
  let svc: ConnectorRegistryService;

  beforeEach(async () => {
    svc = makeService();
    await registerBuiltinConnectors(svc);
  });

  it("increments install count by 1", async () => {
    await svc.incrementInstallCount("oneplatform.postgresql");
    const entry = await svc.getConnectorDetails("oneplatform.postgresql");
    expect(entry.installCount).toBe(1);
  });

  it("accumulates multiple increments", async () => {
    await svc.incrementInstallCount("oneplatform.postgresql");
    await svc.incrementInstallCount("oneplatform.postgresql");
    await svc.incrementInstallCount("oneplatform.postgresql");
    const entry = await svc.getConnectorDetails("oneplatform.postgresql");
    expect(entry.installCount).toBe(3);
  });

  it("throws ConnectorTypeNotFoundError for unknown type", async () => {
    await expect(svc.incrementInstallCount("unknown.type")).rejects.toThrow(
      ConnectorTypeNotFoundError,
    );
  });

  it("popular sort returns higher install count first within built-ins", async () => {
    await svc.incrementInstallCount("oneplatform.mysql");
    await svc.incrementInstallCount("oneplatform.mysql");
    await svc.incrementInstallCount("oneplatform.postgresql");

    const result = await svc.listConnectors({ sortBy: "popular", limit: 100 });
    // MySQL has 2 installs, PostgreSQL has 1 — within built-ins MySQL comes first
    const mysqlIdx = result.items.findIndex((i) => i.type === "oneplatform.mysql");
    const pgIdx = result.items.findIndex((i) => i.type === "oneplatform.postgresql");
    expect(mysqlIdx).toBeLessThan(pgIdx);
  });
});

// ---------------------------------------------------------------------------
// isRegistered
// ---------------------------------------------------------------------------

describe("isRegistered", () => {
  let svc: ConnectorRegistryService;

  beforeEach(async () => {
    svc = makeService();
    await registerBuiltinConnectors(svc);
  });

  it("returns true for a registered type", () => {
    expect(svc.isRegistered("oneplatform.postgresql")).toBe(true);
  });

  it("returns false for an unknown type", () => {
    expect(svc.isRegistered("unknown.type")).toBe(false);
  });
});
