// packages/core/src/__tests__/service-auth.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { generateKeyPair, exportPKCS8, exportSPKI, SignJWT } from "jose";
import { serviceAuthMiddleware } from "../middleware/service-auth.js";

let privateKeyPem: string;
let publicKeyPem: string;
let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  privateKey = pair.privateKey;
  privateKeyPem = await exportPKCS8(pair.privateKey);
  publicKeyPem = await exportSPKI(pair.publicKey);
});

async function issueServiceToken(callerService: string, expiresIn = "5m") {
  return new SignJWT({ sub: callerService, role: "service" })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .setJti("svc-jti-" + Math.random())
    .sign(privateKey);
}

function buildApp(opts: {
  targetService: string;
  // Map of callerService -> publicKey PEM string
  servicePublicKeys: Record<string, string>;
}) {
  const app = new Hono<{ Variables: { user: unknown; requestId: string } }>();
  app.use("*", (c, next) => { c.set("requestId", "req-test"); return next(); });
  app.use(
    "/internal/*",
    serviceAuthMiddleware({
      targetService: opts.targetService,
      servicePublicKeys: opts.servicePublicKeys,
    })
  );
  app.post("/internal/ontology/map", (c) => c.json({ ok: true }));
  app.get("/internal/ontology/schema", (c) => c.json({ ok: true }));
  return app;
}

describe("serviceAuthMiddleware", () => {
  it("allows an authorized service call with valid Ed25519 token", async () => {
    const token = await issueServiceToken("ingestion-service");
    const app = buildApp({
      targetService: "ontology-service",
      servicePublicKeys: { "ingestion-service": publicKeyPem },
    });
    const res = await app.request("/internal/ontology/map", {
      method: "POST",
      headers: { "X-Service-Token": token },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 when X-Service-Token is missing on an internal route", async () => {
    const app = buildApp({
      targetService: "ontology-service",
      servicePublicKeys: { "ingestion-service": publicKeyPem },
    });
    const res = await app.request("/internal/ontology/map", { method: "POST" });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for an expired service token", async () => {
    const token = await issueServiceToken("ingestion-service", "-1m");
    const app = buildApp({
      targetService: "ontology-service",
      servicePublicKeys: { "ingestion-service": publicKeyPem },
    });
    const res = await app.request("/internal/ontology/map", {
      method: "POST",
      headers: { "X-Service-Token": token },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for an unknown caller service (no public key registered)", async () => {
    const token = await issueServiceToken("rogue-service");
    const app = buildApp({
      targetService: "ontology-service",
      // No entry for rogue-service
      servicePublicKeys: { "ingestion-service": publicKeyPem },
    });
    const res = await app.request("/internal/ontology/map", {
      method: "POST",
      headers: { "X-Service-Token": token },
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 FORBIDDEN when RBAC denies the call", async () => {
    // ingestion-service is NOT allowed to call GET /internal/ontology/schema
    const token = await issueServiceToken("ingestion-service");
    const app = buildApp({
      targetService: "ontology-service",
      servicePublicKeys: { "ingestion-service": publicKeyPem },
    });
    const res = await app.request("/internal/ontology/schema", {
      headers: { "X-Service-Token": token },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("sets c.var.user with isService=true on success", async () => {
    const token = await issueServiceToken("ingestion-service");
    // Build a dedicated app that exposes c.var.user to verify it was set.
    // This does not reuse buildApp() because Hono matches the first registered
    // handler — re-registering the same path after buildApp() would be ignored.
    const app = new Hono<{ Variables: { user: unknown; requestId: string } }>();
    app.use("*", (c, next) => { c.set("requestId", "req-test"); return next(); });
    app.use(
      "/internal/*",
      serviceAuthMiddleware({
        targetService: "ontology-service",
        servicePublicKeys: { "ingestion-service": publicKeyPem },
      })
    );
    app.post("/internal/ontology/map", (c) => c.json({ user: (c.var as { user: unknown }).user }));
    const res = await app.request("/internal/ontology/map", {
      method: "POST",
      headers: { "X-Service-Token": token },
    });
    const body = await res.json();
    expect(body.user.isService).toBe(true);
    expect(body.user.userId).toBe("ingestion-service");
  });

  it("rejects X-User-Context without a valid X-Service-Token (spec §4 security invariant)", async () => {
    const app = buildApp({
      targetService: "ontology-service",
      servicePublicKeys: { "ingestion-service": publicKeyPem },
    });
    const res = await app.request("/internal/ontology/map", {
      method: "POST",
      headers: {
        // X-User-Context alone — no X-Service-Token
        "X-User-Context": Buffer.from(JSON.stringify({ userId: "injected", tenantId: "t", roles: ["platform-admin"], scopes: ["admin"] })).toString("base64"),
      },
    });
    // Must be rejected — X-User-Context without a valid X-Service-Token is a spoofing attempt
    expect(res.status).toBe(401);
  });
});
