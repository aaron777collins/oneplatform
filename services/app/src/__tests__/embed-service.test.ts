// Unit tests for services/embed-service.ts — G-071
//
// Covers:
//   - Token generation (happy path, validation, defaults)
//   - Token validation (valid, expired, revoked, bad signature, missing jti)
//   - Token revocation (success, already revoked / not found)
//   - Origin matching (isOriginAllowed)
//   - Snippet generation (generateEmbedSnippet)
//   - Rate limiting is NOT tested here — it is stateful module-level state
//     better covered at the integration level.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SignJWT } from "jose";
import {
  createEmbedService,
  isOriginAllowed,
  generateEmbedSnippet,
  type EmbedService,
  type EmbedServiceDeps,
} from "../services/embed-service.js";
import {
  AppNotFoundError,
  EmbedTokenInvalidError,
  EmbedTokenNotFoundError,
  EmbedTokenExpiredError,
  EmbedTokenRevokedError,
} from "../services/errors.js";
import type { EmbedTokenRepository } from "../repositories/embed-token-repository.js";
import type { AppRepository } from "../repositories/app-repository.js";
import type { Logger } from "@oneplatform/core";
import type { AppRow, EmbedTokenRow } from "../repositories/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// Fixed 32-byte secret — never reuse in production
const TEST_SECRET = new Uint8Array(Buffer.from("test-embed-secret-must-be-32byte", "utf8"));
const BASE_URL    = "https://platform.example";

function makeAppRow(overrides?: Partial<AppRow>): AppRow {
  return {
    id:               "app-001",
    tenant_id:        "tenant-001",
    name:             "Test App",
    slug:             "test-app",
    description:      null,
    access_mode:      "platform-user",
    current_build_id: null,
    allowed_modules:  [],
    created_at:       new Date("2026-01-01T00:00:00Z"),
    updated_at:       new Date("2026-01-01T00:00:00Z"),
    created_by:       "user-001",
    deleted_at:       null,
    ...overrides,
  };
}

function makeEmbedTokenRow(overrides?: Partial<EmbedTokenRow>): EmbedTokenRow {
  return {
    id:              "token-001",
    app_id:          "app-001",
    tenant_id:       "tenant-001",
    allowed_origins: ["example.com"],
    permissions:     "read",
    expires_at:      new Date(Date.now() + 86_400_000),  // 24h from now
    revoked_at:      null,
    created_at:      new Date("2026-01-01T00:00:00Z"),
    created_by:      "user-001",
    ...overrides,
  };
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

type MockEmbedRepo = {
  create:           ReturnType<typeof vi.fn>;
  findById:         ReturnType<typeof vi.fn>;
  listActiveByApp:  ReturnType<typeof vi.fn>;
  revoke:           ReturnType<typeof vi.fn>;
};

type MockAppRepo = {
  findByTenantAndId: ReturnType<typeof vi.fn>;
};

function makeEmbedRepo(): MockEmbedRepo {
  return {
    create:          vi.fn(),
    findById:        vi.fn(),
    listActiveByApp: vi.fn(),
    revoke:          vi.fn(),
  };
}

function makeAppRepo(): MockAppRepo {
  return {
    findByTenantAndId: vi.fn(),
  };
}

function makeDeps(
  embedRepo?: Partial<MockEmbedRepo>,
  appRepo?: Partial<MockAppRepo>
): EmbedServiceDeps & { embedTokenRepo: MockEmbedRepo; appRepo: MockAppRepo } {
  const defaultEmbedRepo = makeEmbedRepo();
  const defaultAppRepo   = makeAppRepo();

  return {
    embedTokenRepo: { ...defaultEmbedRepo, ...embedRepo } as MockEmbedRepo,
    appRepo:        { ...defaultAppRepo,   ...appRepo }   as MockAppRepo,
    embedSecret:    TEST_SECRET,
    baseUrl:        BASE_URL,
    logger:         makeLogger(),
  } as EmbedServiceDeps & { embedTokenRepo: MockEmbedRepo; appRepo: MockAppRepo };
}

// ---------------------------------------------------------------------------
// generateEmbedToken
// ---------------------------------------------------------------------------

describe("generateEmbedToken", () => {
  it("generates a token and returns config + snippet on success", async () => {
    const dbRow = makeEmbedTokenRow();
    const deps  = makeDeps(
      { create: vi.fn().mockResolvedValue(dbRow) },
      { findByTenantAndId: vi.fn().mockResolvedValue(makeAppRow()) }
    );
    const svc = createEmbedService(deps);

    const result = await svc.generateEmbedToken("app-001", "tenant-001", "user-001", {
      allowedOrigins: ["example.com"],
      permissions:    "read",
    });

    expect(result.token).toBeTruthy();
    expect(result.config.appId).toBe("app-001");
    expect(result.config.tenantId).toBe("tenant-001");
    expect(result.config.permissions).toBe("read");
    expect(result.config.allowedOrigins).toEqual(["example.com"]);
    expect(result.snippet).toContain("<iframe");
    expect(result.snippet).toContain(result.token);
  });

  it("defaults to 'read' permissions and empty allowedOrigins", async () => {
    const dbRow = makeEmbedTokenRow({ permissions: "read", allowed_origins: [] });
    const deps  = makeDeps(
      { create: vi.fn().mockResolvedValue(dbRow) },
      { findByTenantAndId: vi.fn().mockResolvedValue(makeAppRow()) }
    );
    const svc = createEmbedService(deps);

    const result = await svc.generateEmbedToken("app-001", "tenant-001", "user-001");

    expect(result.config.permissions).toBe("read");
    expect(result.config.allowedOrigins).toEqual([]);
  });

  it("throws AppNotFoundError when app is not in the tenant", async () => {
    const deps = makeDeps(
      {},
      { findByTenantAndId: vi.fn().mockResolvedValue(null) }
    );
    const svc = createEmbedService(deps);

    await expect(
      svc.generateEmbedToken("missing-app", "tenant-001", "user-001")
    ).rejects.toThrow(AppNotFoundError);
  });

  it("clamps expiresIn to MAX_EXPIRES_IN_SECONDS (30 days)", async () => {
    const dbRow = makeEmbedTokenRow();
    const createFn = vi.fn().mockResolvedValue(dbRow);
    const deps  = makeDeps(
      { create: createFn },
      { findByTenantAndId: vi.fn().mockResolvedValue(makeAppRow()) }
    );
    const svc = createEmbedService(deps);

    const THIRTY_ONE_DAYS = 31 * 86_400;
    await svc.generateEmbedToken("app-001", "tenant-001", "user-001", {
      expiresIn: THIRTY_ONE_DAYS,
    });

    const createdExpiresAt: Date = createFn.mock.calls[0][0].expires_at as Date;
    const diffSeconds = Math.round((createdExpiresAt.getTime() - Date.now()) / 1000);
    // Should be clamped to 30 days (2_592_000 seconds), not 31 days
    expect(diffSeconds).toBeLessThanOrEqual(30 * 86_400 + 5);
    expect(diffSeconds).toBeGreaterThan(30 * 86_400 - 5);
  });

  it("throws when expiresIn is non-positive", async () => {
    const deps = makeDeps(
      {},
      { findByTenantAndId: vi.fn().mockResolvedValue(makeAppRow()) }
    );
    const svc = createEmbedService(deps);

    await expect(
      svc.generateEmbedToken("app-001", "tenant-001", "user-001", { expiresIn: 0 })
    ).rejects.toThrow("positive integer");
  });

  it("throws when more than 20 allowedOrigins are provided", async () => {
    const deps = makeDeps(
      {},
      { findByTenantAndId: vi.fn().mockResolvedValue(makeAppRow()) }
    );
    const svc = createEmbedService(deps);

    const tooMany = Array.from({ length: 21 }, (_, i) => `host${i}.example.com`);

    await expect(
      svc.generateEmbedToken("app-001", "tenant-001", "user-001", {
        allowedOrigins: tooMany,
      })
    ).rejects.toThrow("20");
  });
});

// ---------------------------------------------------------------------------
// validateEmbedToken
// ---------------------------------------------------------------------------

describe("validateEmbedToken", () => {
  async function mintToken(tokenId: string, expiresInSec = 3600): Promise<string> {
    return new SignJWT({ tokenId, appId: "app-001", tenantId: "tenant-001" })
      .setProtectedHeader({ alg: "HS256" })
      .setJti(tokenId)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSec)
      .sign(TEST_SECRET);
  }

  it("returns payload for a valid, non-revoked token", async () => {
    const dbRow = makeEmbedTokenRow();
    const deps  = makeDeps({ findById: vi.fn().mockResolvedValue(dbRow) });
    const svc   = createEmbedService(deps);

    const token   = await mintToken(dbRow.id);
    const payload = await svc.validateEmbedToken(token);

    expect(payload.tokenId).toBe(dbRow.id);
    expect(payload.appId).toBe("app-001");
    expect(payload.permissions).toBe("read");
  });

  it("throws EmbedTokenInvalidError for a tampered token", async () => {
    const deps = makeDeps();
    const svc  = createEmbedService(deps);

    await expect(
      svc.validateEmbedToken("not.a.valid.jwt")
    ).rejects.toThrow(EmbedTokenInvalidError);
  });

  it("throws EmbedTokenInvalidError for an expired JWT (jose rejects before DB)", async () => {
    const deps = makeDeps();
    const svc  = createEmbedService(deps);

    // Sign a token with exp already in the past
    const expiredToken = await new SignJWT({ tokenId: "t1" })
      .setProtectedHeader({ alg: "HS256" })
      .setJti("t1")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(TEST_SECRET);

    await expect(
      svc.validateEmbedToken(expiredToken)
    ).rejects.toThrow(EmbedTokenInvalidError);
  });

  it("throws EmbedTokenNotFoundError when DB row is missing", async () => {
    const deps = makeDeps({ findById: vi.fn().mockResolvedValue(null) });
    const svc  = createEmbedService(deps);

    const token = await mintToken("ghost-token");

    await expect(svc.validateEmbedToken(token)).rejects.toThrow(EmbedTokenNotFoundError);
  });

  it("throws EmbedTokenRevokedError when DB row has revoked_at", async () => {
    const revokedRow = makeEmbedTokenRow({ revoked_at: new Date("2026-01-02T00:00:00Z") });
    const deps = makeDeps({ findById: vi.fn().mockResolvedValue(revokedRow) });
    const svc  = createEmbedService(deps);

    const token = await mintToken(revokedRow.id);

    await expect(svc.validateEmbedToken(token)).rejects.toThrow(EmbedTokenRevokedError);
  });

  it("throws EmbedTokenExpiredError when DB row.expires_at is in the past", async () => {
    const expiredRow = makeEmbedTokenRow({
      expires_at: new Date(Date.now() - 1000),  // 1 second ago
    });
    const deps = makeDeps({ findById: vi.fn().mockResolvedValue(expiredRow) });
    const svc  = createEmbedService(deps);

    // Sign with a future exp so jose accepts it; the DB check should reject
    const token = await mintToken(expiredRow.id, 3600);

    await expect(svc.validateEmbedToken(token)).rejects.toThrow(EmbedTokenExpiredError);
  });

  it("throws EmbedTokenInvalidError when jti claim is missing", async () => {
    const deps = makeDeps();
    const svc  = createEmbedService(deps);

    // Token without jti
    const noJtiToken = await new SignJWT({ payload: "ok" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(TEST_SECRET);

    await expect(svc.validateEmbedToken(noJtiToken)).rejects.toThrow(EmbedTokenInvalidError);
  });
});

// ---------------------------------------------------------------------------
// revokeEmbedToken
// ---------------------------------------------------------------------------

describe("revokeEmbedToken", () => {
  it("succeeds when the token belongs to the app and tenant", async () => {
    const deps = makeDeps({ revoke: vi.fn().mockResolvedValue(true) });
    const svc  = createEmbedService(deps);

    await expect(
      svc.revokeEmbedToken("token-001", "app-001", "tenant-001")
    ).resolves.toBeUndefined();
  });

  it("throws EmbedTokenNotFoundError when token is not found or already revoked", async () => {
    const deps = makeDeps({ revoke: vi.fn().mockResolvedValue(false) });
    const svc  = createEmbedService(deps);

    await expect(
      svc.revokeEmbedToken("ghost-token", "app-001", "tenant-001")
    ).rejects.toThrow(EmbedTokenNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// listEmbedTokens
// ---------------------------------------------------------------------------

describe("listEmbedTokens", () => {
  it("returns formatted configs for active tokens", async () => {
    const rows = [
      makeEmbedTokenRow({ id: "t1" }),
      makeEmbedTokenRow({ id: "t2", permissions: "read-write" }),
    ];
    const deps = makeDeps({ listActiveByApp: vi.fn().mockResolvedValue(rows) });
    const svc  = createEmbedService(deps);

    const configs = await svc.listEmbedTokens("app-001", "tenant-001");

    expect(configs).toHaveLength(2);
    expect(configs[0]?.tokenId).toBe("t1");
    expect(configs[1]?.permissions).toBe("read-write");
  });

  it("returns empty array when no active tokens exist", async () => {
    const deps = makeDeps({ listActiveByApp: vi.fn().mockResolvedValue([]) });
    const svc  = createEmbedService(deps);

    const configs = await svc.listEmbedTokens("app-001", "tenant-001");
    expect(configs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isOriginAllowed
// ---------------------------------------------------------------------------

describe("isOriginAllowed", () => {
  it("returns true for wildcard *", () => {
    expect(isOriginAllowed("https://evil.example.com", ["*"])).toBe(true);
    expect(isOriginAllowed("anything", ["*"])).toBe(true);
  });

  it("returns true for exact match", () => {
    expect(isOriginAllowed("example.com", ["example.com", "other.com"])).toBe(true);
  });

  it("returns false for non-matching origins", () => {
    expect(isOriginAllowed("notallowed.com", ["example.com"])).toBe(false);
  });

  it("returns false for empty allowedOrigins", () => {
    expect(isOriginAllowed("example.com", [])).toBe(false);
  });

  it("matches wildcard subdomain pattern *.example.com", () => {
    expect(isOriginAllowed("foo.example.com", ["*.example.com"])).toBe(true);
    expect(isOriginAllowed("bar.example.com", ["*.example.com"])).toBe(true);
  });

  it("does not match parent domain for *.example.com", () => {
    // "example.com" does not end with ".example.com"
    expect(isOriginAllowed("example.com", ["*.example.com"])).toBe(false);
  });

  it("does not match cross-domain with wildcard pattern", () => {
    expect(isOriginAllowed("evil.notexample.com", ["*.example.com"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generateEmbedSnippet
// ---------------------------------------------------------------------------

describe("generateEmbedSnippet", () => {
  it("generates an iframe tag with the token in the src", () => {
    const snippet = generateEmbedSnippet(BASE_URL, "my.jwt.token");
    expect(snippet).toContain("<iframe");
    expect(snippet).toContain("my.jwt.token");
    expect(snippet).toContain(`${BASE_URL}/api/v1/embed/`);
  });

  it("uses default width=100% and height=600", () => {
    const snippet = generateEmbedSnippet(BASE_URL, "tok");
    expect(snippet).toContain('width="100%"');
    expect(snippet).toContain('height="600"');
  });

  it("accepts custom dimensions", () => {
    const snippet = generateEmbedSnippet(BASE_URL, "tok", { width: "800px", height: "400" });
    expect(snippet).toContain('width="800px"');
    expect(snippet).toContain('height="400"');
  });
});
