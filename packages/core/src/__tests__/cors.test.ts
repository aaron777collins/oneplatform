import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { corsMiddleware } from "../middleware/cors.js";

function buildApp(allowedOrigins: string[]) {
  const app = new Hono();
  app.use("*", corsMiddleware({ allowedOrigins }));
  app.get("/data", (c) => c.json({ ok: true }));
  return app;
}

describe("corsMiddleware", () => {
  it("sets CORS headers for an allowed origin", async () => {
    const app = buildApp(["https://app.example.com"]);
    const res = await app.request("/data", {
      headers: { Origin: "https://app.example.com" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("returns 403 ORIGIN_NOT_ALLOWED for an origin not in the allowlist", async () => {
    const app = buildApp(["https://app.example.com"]);
    const res = await app.request("/data", {
      headers: { Origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("handles OPTIONS preflight with 204 and correct headers for an allowed origin", async () => {
    const app = buildApp(["https://app.example.com"]);
    const res = await app.request("/data", {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.example.com",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Max-Age")).toBe("86400");
  });

  it("returns 403 on OPTIONS preflight for a disallowed origin", async () => {
    const app = buildApp(["https://app.example.com"]);
    const res = await app.request("/data", {
      method: "OPTIONS",
      headers: {
        Origin: "https://attacker.example.com",
        "Access-Control-Request-Method": "DELETE",
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("allows requests without an Origin header (non-browser, e.g. CLI or server)", async () => {
    const app = buildApp(["https://app.example.com"]);
    // No Origin header — direct server-to-server call
    const res = await app.request("/data");
    expect(res.status).toBe(200);
  });

  it("exposes X-RateLimit-* and X-OnePlatform-Request-ID in CORS expose headers", async () => {
    const app = buildApp(["https://app.example.com"]);
    const res = await app.request("/data", {
      headers: { Origin: "https://app.example.com" },
    });
    const exposeHeader = res.headers.get("Access-Control-Expose-Headers") ?? "";
    expect(exposeHeader).toContain("X-RateLimit-Limit");
    expect(exposeHeader).toContain("X-OnePlatform-Request-ID");
  });

  it("sets correct Allow-Headers including Authorization and X-API-Key", async () => {
    const app = buildApp(["https://app.example.com"]);
    const res = await app.request("/data", {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.example.com",
        "Access-Control-Request-Method": "GET",
      },
    });
    const allowHeaders = res.headers.get("Access-Control-Allow-Headers") ?? "";
    expect(allowHeaders).toContain("Authorization");
    expect(allowHeaders).toContain("X-API-Key");
  });
});
