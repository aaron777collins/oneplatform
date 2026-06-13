// Unit tests for api-key-service.ts
// Covers: create(), validate(), list(), revoke(), rotate().

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Redis } from "ioredis";
import type pg from "pg";
import type { Logger, EventPublisher } from "@oneplatform/core";
import type { ApiKeyServiceDeps } from "../services/api-key-service.js";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn().mockReturnThis(), audit: vi.fn(),
  } as unknown as Logger;
}

function makeEvents(): EventPublisher {
  return { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventPublisher;
}

function makeRedis(overrides: Partial<Redis> = {}): Redis {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    ...overrides,
  } as unknown as Redis;
}

// ---------------------------------------------------------------------------
// Standard API key DB row
// ---------------------------------------------------------------------------

function makeApiKeyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "key-id-1",
    user_id: "user-1",
    tenant_id: "tenant-1",
    name: "My API Key",
    key_hash: "$2b$10$dummyhash",
    key_prefix: "abcdefgh",
    scopes: ["data:read"],
    expires_at: null,
    last_used_at: null,
    created_at: new Date("2024-01-01T00:00:00Z"),
    revoked_at: null,
    ...overrides,
  };
}

function makeDb(
  queryImpl?: (sql: string, params?: unknown[]) => { rows: unknown[] },
): pg.Pool {
  const defaultImpl = (sql: string) => {
    if (sql.includes("INSERT INTO auth.api_keys")) return { rows: [makeApiKeyRow()] };
    if (sql.includes("SELECT * FROM auth.api_keys")) return { rows: [makeApiKeyRow()] };
    if (sql.includes("UPDATE auth.api_keys")) return { rows: [makeApiKeyRow()] };
    return { rows: [] };
  };
  const impl = queryImpl ?? defaultImpl;
  // Wrap synchronous impl in Promise.resolve so that the fire-and-forget
  // setImmediate(() => db.query(...).catch(...)) pattern in validate() works.
  const asyncImpl = (sql: string, params?: unknown[]) =>
    Promise.resolve(impl(sql, params));
  const mockClient = {
    query: vi.fn().mockImplementation(asyncImpl),
    release: vi.fn(),
  };
  return {
    query: vi.fn().mockImplementation(asyncImpl),
    connect: vi.fn().mockResolvedValue(mockClient),
  } as unknown as pg.Pool;
}

function makeDeps(overrides: Partial<ApiKeyServiceDeps> = {}): ApiKeyServiceDeps {
  return {
    db: makeDb(),
    redis: makeRedis(),
    logger: makeLogger(),
    events: makeEvents(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// create()
// ---------------------------------------------------------------------------

describe("ApiKeyService.create()", () => {
  beforeEach(() => {
    process.env["OP_BCRYPT_ROUNDS"] = "10";
    vi.resetModules();
  });

  it("returns a key starting with op_live_", async () => {
    const { createApiKeyService } = await import("../services/api-key-service.js");
    const svc = createApiKeyService(makeDeps());
    const { apiKey } = await svc.create("user-1", "tenant-1", {
      name: "Test Key",
      scopes: ["data:read"],
    }, ["data:read"]);
    expect(apiKey).toMatch(/^op_live_/);
  });

  it("stores a bcrypt hash, not the raw key, in the database", async () => {
    const { createApiKeyService } = await import("../services/api-key-service.js");
    const dbQuerySpy = vi.fn().mockResolvedValue({ rows: [makeApiKeyRow()] });
    const db = {
      query: dbQuerySpy,
      connect: vi.fn(),
    } as unknown as pg.Pool;
    const svc = createApiKeyService(makeDeps({ db }));
    const { apiKey } = await svc.create("user-1", "tenant-1", {
      name: "Test Key",
      scopes: ["data:read"],
    }, ["data:read"]);

    // Find the INSERT call
    const insertCall = dbQuerySpy.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" && (call[0] as string).includes("INSERT INTO auth.api_keys"),
    );
    expect(insertCall).toBeDefined();

    // The stored hash should NOT equal the raw key
    const storedHash = (insertCall as unknown[])[1] as unknown[];
    expect(storedHash).toBeDefined();
    // key_hash is the 4th parameter ($4)
    const keyHash = storedHash[3] as string;
    expect(keyHash).not.toBe(apiKey);
    expect(keyHash).toMatch(/^\$2b\$/);
  });

  it("returns a keyRecord with the key prefix (first 8 chars of random part)", async () => {
    const { createApiKeyService } = await import("../services/api-key-service.js");
    const capturedPrefix: string[] = [];
    const db = {
      query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
        if (sql.includes("INSERT INTO auth.api_keys") && params) {
          const prefix = params[4] as string; // key_prefix is $5
          capturedPrefix.push(prefix);
          return Promise.resolve({ rows: [makeApiKeyRow({ key_prefix: prefix })] });
        }
        return Promise.resolve({ rows: [] });
      }),
      connect: vi.fn(),
    } as unknown as pg.Pool;

    const svc = createApiKeyService(makeDeps({ db }));
    const { apiKey, keyRecord } = await svc.create("user-1", "tenant-1", {
      name: "Test Key",
      scopes: ["data:read"],
    }, ["data:read"]);

    // The random part starts right after "op_live_"
    const randomPart = apiKey.replace("op_live_", "");
    expect(keyRecord.keyPrefix).toBe(capturedPrefix[0]);
    expect(keyRecord.keyPrefix).toBe(randomPart.substring(0, 8));
  });

  it("publishes auth.key.created event", async () => {
    const { createApiKeyService } = await import("../services/api-key-service.js");
    const events = makeEvents();
    const svc = createApiKeyService(makeDeps({ events }));
    await svc.create("user-1", "tenant-1", { name: "My Key", scopes: ["data:read"] }, ["data:read"]);
    expect(events.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "auth.key.created" }),
    );
  });

  it("throws ForbiddenError when requesting a scope not held by the caller", async () => {
    const { createApiKeyService } = await import("../services/api-key-service.js");
    const { ForbiddenError } = await import("@oneplatform/core");
    const svc = createApiKeyService(makeDeps());
    // Caller has only data:read but requests admin scope
    await expect(
      svc.create("user-1", "tenant-1", { name: "Escalated Key", scopes: ["admin"] }, ["data:read"]),
    ).rejects.toThrow(ForbiddenError);
  });

  it("throws ForbiddenError with the offending scope name in the message", async () => {
    const { createApiKeyService } = await import("../services/api-key-service.js");
    const svc = createApiKeyService(makeDeps());
    await expect(
      svc.create("user-1", "tenant-1", { name: "Bad Key", scopes: ["data:write"] }, ["data:read"]),
    ).rejects.toThrow("Cannot create API key with scope 'data:write'");
  });

  it("allows creating a key when requested scopes are a strict subset of caller scopes", async () => {
    const { createApiKeyService } = await import("../services/api-key-service.js");
    const svc = createApiKeyService(makeDeps());
    const { apiKey } = await svc.create(
      "user-1",
      "tenant-1",
      { name: "Subset Key", scopes: ["data:read"] },
      ["data:read", "data:write", "logs:read"],
    );
    expect(apiKey).toMatch(/^op_live_/);
  });
});

// ---------------------------------------------------------------------------
// validate()
// ---------------------------------------------------------------------------

describe("ApiKeyService.validate()", () => {
  beforeEach(() => {
    process.env["OP_BCRYPT_ROUNDS"] = "10";
    vi.resetModules();
  });

  it("returns null for a key that does not start with op_live_", async () => {
    const { createApiKeyService } = await import("../services/api-key-service.js");
    const svc = createApiKeyService(makeDeps());
    expect(await svc.validate("sk_test_invalidprefix")).toBeNull();
  });

  it("returns null when no DB row matches the prefix", async () => {
    const { createApiKeyService } = await import("../services/api-key-service.js");
    const db = makeDb(() => ({ rows: [] }));
    const svc = createApiKeyService(makeDeps({ db }));
    expect(await svc.validate("op_live_" + "A".repeat(43))).toBeNull();
  });

  it("returns null when bcrypt comparison fails", async () => {
    // We insert a row whose hash does not match the provided key
    const { createApiKeyService } = await import("../services/api-key-service.js");
    // Create a valid key to get a real bcrypt hash
    const bcrypt = await import("bcrypt");
    const realKey = "op_live_" + "B".repeat(43);
    const wrongHash = await bcrypt.default.hash("op_live_" + "C".repeat(43), 10);

    const db = makeDb(() => ({
      rows: [makeApiKeyRow({ key_hash: wrongHash })],
    }));
    const svc = createApiKeyService(makeDeps({ db }));
    expect(await svc.validate(realKey)).toBeNull();
  });

  it("returns null for a key that is in the Redis revocation set", async () => {
    const { createApiKeyService } = await import("../services/api-key-service.js");
    // Create a valid key and hash it
    const bcrypt = await import("bcrypt");
    const key = "op_live_" + "D".repeat(43);
    const hash = await bcrypt.default.hash(key, 10);

    const db = makeDb(() => ({
      rows: [makeApiKeyRow({ id: "revoked-key-id", key_hash: hash, key_prefix: "D".repeat(8) })],
    }));
    const redis = makeRedis({
      // Redis says this key is revoked
      get: vi.fn().mockImplementation((k: string) => {
        if (k === "auth:apikey:revocation:revoked-key-id") return Promise.resolve("1");
        return Promise.resolve(null);
      }),
    });
    const svc = createApiKeyService(makeDeps({ db, redis }));
    expect(await svc.validate(key)).toBeNull();
  });

  it("returns a UserContext for a valid, non-revoked key", async () => {
    const { createApiKeyService } = await import("../services/api-key-service.js");
    const bcrypt = await import("bcrypt");
    const key = "op_live_" + "E".repeat(43);
    const hash = await bcrypt.default.hash(key, 10);

    const db = makeDb(() => ({
      rows: [makeApiKeyRow({
        id: "valid-key-id",
        key_hash: hash,
        key_prefix: "E".repeat(8),
        scopes: ["data:read", "data:write"],
      })],
    }));
    const redis = makeRedis({ get: vi.fn().mockResolvedValue(null) });
    const svc = createApiKeyService(makeDeps({ db, redis }));
    const ctx = await svc.validate(key);
    expect(ctx).not.toBeNull();
    expect(ctx!.userId).toBe("user-1");
    expect(ctx!.tenantId).toBe("tenant-1");
    expect(ctx!.scopes).toEqual(["data:read", "data:write"]);
    expect(ctx!.isGuest).toBe(false);
  });

  it("returns null for a key that is too short (prefix length < 8)", async () => {
    const { createApiKeyService } = await import("../services/api-key-service.js");
    const svc = createApiKeyService(makeDeps());
    expect(await svc.validate("op_live_abc")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe("ApiKeyService.list()", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns an array of ApiKeyRecord for the user", async () => {
    const { createApiKeyService } = await import("../services/api-key-service.js");
    const db = makeDb((sql: string) => {
      if (sql.includes("SELECT") && sql.includes("auth.api_keys")) {
        return {
          rows: [
            makeApiKeyRow({ id: "k1", name: "Key 1" }),
            makeApiKeyRow({ id: "k2", name: "Key 2" }),
          ],
        };
      }
      return { rows: [] };
    });
    const svc = createApiKeyService(makeDeps({ db }));
    const keys = await svc.list("user-1");
    expect(keys).toHaveLength(2);
    expect(keys[0]?.id).toBe("k1");
    expect(keys[1]?.id).toBe("k2");
  });

  it("returns an empty array when the user has no keys", async () => {
    const { createApiKeyService } = await import("../services/api-key-service.js");
    const db = makeDb(() => ({ rows: [] }));
    const svc = createApiKeyService(makeDeps({ db }));
    const keys = await svc.list("user-1");
    expect(keys).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// revoke()
// ---------------------------------------------------------------------------

describe("ApiKeyService.revoke()", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("marks the key revoked and sets Redis revocation flag", async () => {
    const { createApiKeyService } = await import("../services/api-key-service.js");
    const redis = makeRedis();
    const db = makeDb((sql: string) => {
      if (sql.includes("UPDATE auth.api_keys")) {
        return { rows: [makeApiKeyRow({ id: "key-id-1", tenant_id: "tenant-1", user_id: "user-1" })] };
      }
      return { rows: [] };
    });
    const svc = createApiKeyService(makeDeps({ db, redis }));
    await svc.revoke("key-id-1", "user-1");
    expect(redis.set).toHaveBeenCalledWith("auth:apikey:revocation:key-id-1", "1");
  });

  it("throws NotFoundError when key does not exist or is already revoked", async () => {
    const { createApiKeyService } = await import("../services/api-key-service.js");
    const { NotFoundError } = await import("@oneplatform/core");
    const db = makeDb(() => ({ rows: [] })); // UPDATE returns no rows
    const svc = createApiKeyService(makeDeps({ db }));
    await expect(svc.revoke("nonexistent-key", "user-1")).rejects.toThrow(NotFoundError);
  });

  it("publishes auth.key.revoked event", async () => {
    const { createApiKeyService } = await import("../services/api-key-service.js");
    const events = makeEvents();
    const db = makeDb((sql: string) => {
      if (sql.includes("UPDATE auth.api_keys")) {
        return { rows: [makeApiKeyRow({ id: "key-id-1", tenant_id: "t1", user_id: "u1" })] };
      }
      return { rows: [] };
    });
    const svc = createApiKeyService(makeDeps({ db, events }));
    await svc.revoke("key-id-1", "user-1");
    expect(events.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "auth.key.revoked" }),
    );
  });
});

// ---------------------------------------------------------------------------
// rotate()
// ---------------------------------------------------------------------------

describe("ApiKeyService.rotate()", () => {
  beforeEach(() => {
    process.env["OP_BCRYPT_ROUNDS"] = "10";
    vi.resetModules();
  });

  it("returns a new key with op_live_ prefix and publishes event", async () => {
    const { createApiKeyService } = await import("../services/api-key-service.js");
    const events = makeEvents();
    const mockClient = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return Promise.resolve({ rows: [] });
        if (sql.includes("UPDATE auth.api_keys")) return Promise.resolve({ rows: [] });
        if (sql.includes("INSERT INTO auth.api_keys")) {
          return Promise.resolve({ rows: [makeApiKeyRow({ id: "new-key-id" })] });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: vi.fn(),
    };
    const db = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("SELECT * FROM auth.api_keys")) {
          return Promise.resolve({ rows: [makeApiKeyRow()] });
        }
        return Promise.resolve({ rows: [] });
      }),
      connect: vi.fn().mockResolvedValue(mockClient),
    } as unknown as pg.Pool;

    const redis = makeRedis();
    const svc = createApiKeyService(makeDeps({ db, redis, events }));
    const { apiKey, keyRecord } = await svc.rotate("key-id-1", "user-1");

    expect(apiKey).toMatch(/^op_live_/);
    expect(keyRecord.id).toBe("new-key-id");
    expect(events.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "auth.key.created" }),
    );
    // Old key should be revoked in Redis
    expect(redis.set).toHaveBeenCalledWith("auth:apikey:revocation:key-id-1", "1");
  });

  it("throws NotFoundError when the key to rotate does not exist", async () => {
    const { createApiKeyService } = await import("../services/api-key-service.js");
    const { NotFoundError } = await import("@oneplatform/core");
    const db = makeDb(() => ({ rows: [] }));
    const svc = createApiKeyService(makeDeps({ db }));
    await expect(svc.rotate("nonexistent-key", "user-1")).rejects.toThrow(NotFoundError);
  });

  it("throws ForbiddenError when user does not own the key", async () => {
    const { createApiKeyService } = await import("../services/api-key-service.js");
    const { ForbiddenError } = await import("@oneplatform/core");
    const db = makeDb((sql: string) => {
      if (sql.includes("SELECT * FROM auth.api_keys")) {
        return { rows: [makeApiKeyRow({ user_id: "other-user" })] };
      }
      return { rows: [] };
    });
    const svc = createApiKeyService(makeDeps({ db }));
    await expect(svc.rotate("key-id-1", "user-1")).rejects.toThrow(ForbiddenError);
  });
});
