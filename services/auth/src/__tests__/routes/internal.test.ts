// Route-level tests for /internal/* routes.
// Uses a real Ed25519 key pair (generated once in beforeAll) to produce valid
// X-Service-Token headers so the serviceAuthMiddleware passes.
// The caller service is "gateway-service" which has a wildcard RBAC grant.

import { describe, it, expect, vi, beforeAll } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { errorHandlerMiddleware } from "@oneplatform/core";
import type { TokenService } from "../../services/token-service.js";
import type { GuestSessionService } from "../../services/index.js";
import { createInternalRoutes } from "../../routes/internal.js";
import type { OAuthClientRepository } from "../../repositories/oauth-client-repository.js";
import type { OAuthClient } from "../../repositories/types.js";
import { generateKeyPair, exportSPKI, SignJWT } from "jose";

// ---------------------------------------------------------------------------
// Ed25519 key pair for service tokens
// ---------------------------------------------------------------------------

let publicKeyPem: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let privateKeyObj: any;

beforeAll(async () => {
  const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  privateKeyObj = pair.privateKey;
  publicKeyPem = await exportSPKI(pair.publicKey);
});

async function issueServiceToken(callerService = "gateway-service") {
  return new SignJWT({ sub: callerService, role: "service" })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .setJti("svc-jti-" + Math.random())
    .sign(privateKeyObj);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTokenService(overrides: Partial<TokenService> = {}): TokenService {
  return {
    issueAccessToken: vi.fn().mockResolvedValue("access-token"),
    issueRefreshToken: vi.fn().mockResolvedValue({ token: "refresh-token", jti: "jti-1" }),
    verifyAccessToken: vi.fn().mockResolvedValue(null),
    revokeAccessToken: vi.fn().mockResolvedValue(undefined),
    rotateRefreshToken: vi.fn().mockResolvedValue({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresIn: 900,
    }),
    ...overrides,
  };
}

function makeGuestSessionService(overrides: Partial<GuestSessionService> = {}): GuestSessionService {
  return {
    create: vi.fn().mockResolvedValue({
      guestToken: "a".repeat(64),
      expiresAt: new Date(Date.now() + 86_400_000),
    }),
    validate: vi.fn().mockResolvedValue({
      tenantId: "tenant-1",
      appId: "app-1",
      createdAt: new Date().toISOString(),
    }),
    ...overrides,
  };
}

function makeOAuthClientRepo(overrides: Partial<OAuthClientRepository> = {}): OAuthClientRepository {
  const now = new Date();
  const baseClient: OAuthClient = {
    client_id: "app:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:ffffffff-0000-1111-2222-333333333333",
    client_secret_hash: null,
    client_type: "public",
    redirect_uris: ["https://app.example.com/callback"],
    allowed_scopes: ["data:read"],
    tenant_id: "tenant-1",
    app_id: null,
    access_mode: "platform-user",
    created_at: now,
    updated_at: now,
    created_by_service: null,
  };
  return {
    upsert: vi.fn().mockResolvedValue(baseClient),
    findByClientId: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as OAuthClientRepository;
}

function buildApp(
  tokenService: TokenService,
  guestSessionService: GuestSessionService,
  oauthClientRepository: OAuthClientRepository,
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.onError(errorHandlerMiddleware());
  const routes = createInternalRoutes({
    tokenService,
    guestSessionService,
    oauthClientRepository,
    servicePublicKeys: { "gateway-service": publicKeyPem },
  });
  app.route("/", routes);
  return app;
}

// ---------------------------------------------------------------------------
// POST /internal/auth/validate
// ---------------------------------------------------------------------------

describe("POST /internal/auth/validate", () => {
  it("returns valid=true with claims for a valid token", async () => {
    const claims = {
      sub: "user-1",
      tid: "tenant-1",
      roles: ["viewer"],
      scopes: ["data:read"],
      ev: true,
      unverified: false,
      jti: "jti-abc",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900,
    };
    const tokenSvc = makeTokenService({
      verifyAccessToken: vi.fn().mockResolvedValue(claims),
    });
    const app = buildApp(tokenSvc, makeGuestSessionService(), makeOAuthClientRepo());
    const svcToken = await issueServiceToken();
    const res = await app.request("/internal/auth/validate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Service-Token": svcToken,
      },
      body: JSON.stringify({ token: "valid-access-token" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["valid"]).toBe(true);
    expect(body["userId"]).toBe("user-1");
    expect(body["tenantId"]).toBe("tenant-1");
    expect(body["roles"]).toEqual(["viewer"]);
    expect(body["scopes"]).toEqual(["data:read"]);
    expect(body["isGuest"]).toBe(false);
  });

  it("returns valid=false with reason when token is invalid", async () => {
    const tokenSvc = makeTokenService({
      verifyAccessToken: vi.fn().mockResolvedValue(null),
    });
    const app = buildApp(tokenSvc, makeGuestSessionService(), makeOAuthClientRepo());
    const svcToken = await issueServiceToken();
    const res = await app.request("/internal/auth/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Service-Token": svcToken },
      body: JSON.stringify({ token: "invalid-token" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["valid"]).toBe(false);
    expect(body["reason"]).toBe("TOKEN_INVALID");
  });

  it("returns 422 when the token field is missing from body", async () => {
    const app = buildApp(makeTokenService(), makeGuestSessionService(), makeOAuthClientRepo());
    const svcToken = await issueServiceToken();
    const res = await app.request("/internal/auth/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Service-Token": svcToken },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it("returns 401 when no X-Service-Token header is provided", async () => {
    const app = buildApp(makeTokenService(), makeGuestSessionService(), makeOAuthClientRepo());
    const res = await app.request("/internal/auth/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "some-token" }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /internal/auth/guest-sessions
// ---------------------------------------------------------------------------

describe("POST /internal/auth/guest-sessions", () => {
  const validBody = {
    tenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    appId: "ffffffff-0000-1111-2222-333333333333",
  };

  it("returns 201 with guestToken (64 chars) and expiresAt", async () => {
    const app = buildApp(makeTokenService(), makeGuestSessionService(), makeOAuthClientRepo());
    const svcToken = await issueServiceToken();
    const res = await app.request("/internal/auth/guest-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Service-Token": svcToken },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(String(body["guestToken"])).toHaveLength(64);
    expect(body["expiresAt"]).toBeDefined();
  });

  it("returns 422 when tenantId is not a valid UUID", async () => {
    const app = buildApp(makeTokenService(), makeGuestSessionService(), makeOAuthClientRepo());
    const svcToken = await issueServiceToken();
    const res = await app.request("/internal/auth/guest-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Service-Token": svcToken },
      body: JSON.stringify({ ...validBody, tenantId: "not-a-uuid" }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when appId is not a valid UUID", async () => {
    const app = buildApp(makeTokenService(), makeGuestSessionService(), makeOAuthClientRepo());
    const svcToken = await issueServiceToken();
    const res = await app.request("/internal/auth/guest-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Service-Token": svcToken },
      body: JSON.stringify({ ...validBody, appId: "bad-app-id" }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when ipAddress is provided but is not a valid IP", async () => {
    const app = buildApp(makeTokenService(), makeGuestSessionService(), makeOAuthClientRepo());
    const svcToken = await issueServiceToken();
    const res = await app.request("/internal/auth/guest-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Service-Token": svcToken },
      body: JSON.stringify({ ...validBody, ipAddress: "not.an.ip.address" }),
    });
    expect(res.status).toBe(422);
  });

  it("passes ipAddress to guestSessionService.create when provided", async () => {
    const createSpy = vi.fn().mockResolvedValue({
      guestToken: "a".repeat(64),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const app = buildApp(
      makeTokenService(),
      makeGuestSessionService({ create: createSpy }),
      makeOAuthClientRepo(),
    );
    const svcToken = await issueServiceToken();
    await app.request("/internal/auth/guest-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Service-Token": svcToken },
      body: JSON.stringify({ ...validBody, ipAddress: "192.168.0.1" }),
    });
    expect(createSpy).toHaveBeenCalledWith(
      validBody.tenantId,
      validBody.appId,
      "192.168.0.1",
    );
  });
});

// ---------------------------------------------------------------------------
// POST /internal/oauth/clients
// ---------------------------------------------------------------------------

describe("POST /internal/oauth/clients", () => {
  const validClientBody = {
    clientId: "app:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:ffffffff-0000-1111-2222-333333333333",
    clientType: "public",
    redirectUris: ["https://app.example.com/callback"],
    allowedScopes: ["data:read"],
    tenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  };

  it("returns 201 with client details on successful upsert", async () => {
    const app = buildApp(makeTokenService(), makeGuestSessionService(), makeOAuthClientRepo());
    const svcToken = await issueServiceToken();
    const res = await app.request("/internal/oauth/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Service-Token": svcToken },
      body: JSON.stringify(validClientBody),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body["clientId"]).toBeDefined();
    expect(body["redirectUris"]).toBeDefined();
  });

  it("returns 422 when redirectUris is empty", async () => {
    const app = buildApp(makeTokenService(), makeGuestSessionService(), makeOAuthClientRepo());
    const svcToken = await issueServiceToken();
    const res = await app.request("/internal/oauth/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Service-Token": svcToken },
      body: JSON.stringify({ ...validClientBody, redirectUris: [] }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when clientId format is invalid", async () => {
    const app = buildApp(makeTokenService(), makeGuestSessionService(), makeOAuthClientRepo());
    const svcToken = await issueServiceToken();
    const res = await app.request("/internal/oauth/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Service-Token": svcToken },
      body: JSON.stringify({ ...validClientBody, clientId: "invalid-client-id" }),
    });
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// DELETE /internal/oauth/clients/:clientId
// ---------------------------------------------------------------------------

describe("DELETE /internal/oauth/clients/:clientId", () => {
  it("returns 204 when client exists and redirect URIs are cleared", async () => {
    const existingClient: OAuthClient = {
      client_id: "app:uuid1:uuid2",
      client_secret_hash: null,
      client_type: "public",
      redirect_uris: ["https://example.com"],
      allowed_scopes: ["data:read"],
      tenant_id: "tenant-1",
      app_id: null,
      access_mode: "platform-user",
      created_at: new Date(),
      updated_at: new Date(),
      created_by_service: null,
    };
    const repo = makeOAuthClientRepo({
      findByClientId: vi.fn().mockResolvedValue(existingClient),
      upsert: vi.fn().mockResolvedValue({ ...existingClient, redirect_uris: [] }),
    });
    const app = buildApp(makeTokenService(), makeGuestSessionService(), repo);
    const svcToken = await issueServiceToken();
    const res = await app.request("/internal/oauth/clients/app:uuid1:uuid2", {
      method: "DELETE",
      headers: { "X-Service-Token": svcToken },
    });
    expect(res.status).toBe(204);
  });

  it("returns 404 when client does not exist", async () => {
    const repo = makeOAuthClientRepo({
      findByClientId: vi.fn().mockResolvedValue(null),
    });
    const app = buildApp(makeTokenService(), makeGuestSessionService(), repo);
    const svcToken = await issueServiceToken();
    const res = await app.request("/internal/oauth/clients/nonexistent-client", {
      method: "DELETE",
      headers: { "X-Service-Token": svcToken },
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });
});
