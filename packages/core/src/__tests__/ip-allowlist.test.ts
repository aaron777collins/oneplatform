// packages/core/src/__tests__/ip-allowlist.test.ts
//
// Unit tests for the IP allowlist utilities and middleware.
// All logic is pure (no I/O) so tests run without mocks.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  isIpInCidr,
  isIpInAllowlist,
  parseIpFromRequest,
  createIpAllowlistMiddleware,
} from "../middleware/ip-allowlist.js";

// ---------------------------------------------------------------------------
// isIpInCidr — IPv4 individual IP
// ---------------------------------------------------------------------------

describe("isIpInCidr — IPv4 individual IP (no slash)", () => {
  it("matches an exact IPv4 address", () => {
    expect(isIpInCidr("10.0.0.1", "10.0.0.1")).toBe(true);
  });

  it("does not match a different IPv4 address", () => {
    expect(isIpInCidr("10.0.0.2", "10.0.0.1")).toBe(false);
  });

  it("does not match when the last octet differs", () => {
    expect(isIpInCidr("192.168.1.100", "192.168.1.101")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isIpInCidr — IPv4 CIDR
// ---------------------------------------------------------------------------

describe("isIpInCidr — IPv4 CIDR", () => {
  it("matches the network address itself (/24)", () => {
    expect(isIpInCidr("192.168.1.0", "192.168.1.0/24")).toBe(true);
  });

  it("matches a host within the /24 subnet", () => {
    expect(isIpInCidr("192.168.1.55", "192.168.1.0/24")).toBe(true);
  });

  it("matches the broadcast address of a /24 subnet", () => {
    expect(isIpInCidr("192.168.1.255", "192.168.1.0/24")).toBe(true);
  });

  it("does not match an IP outside the /24 subnet", () => {
    expect(isIpInCidr("192.168.2.1", "192.168.1.0/24")).toBe(false);
  });

  it("matches a host within a /16 subnet", () => {
    expect(isIpInCidr("10.0.128.1", "10.0.0.0/16")).toBe(true);
  });

  it("does not match an IP outside the /16 subnet", () => {
    expect(isIpInCidr("10.1.0.1", "10.0.0.0/16")).toBe(false);
  });

  it("allows all IPs with /0", () => {
    expect(isIpInCidr("1.2.3.4", "0.0.0.0/0")).toBe(true);
    expect(isIpInCidr("255.255.255.255", "0.0.0.0/0")).toBe(true);
  });

  it("matches exactly one IP with /32", () => {
    expect(isIpInCidr("10.0.0.1", "10.0.0.1/32")).toBe(true);
    expect(isIpInCidr("10.0.0.2", "10.0.0.1/32")).toBe(false);
  });

  it("handles a /8 prefix (class A)", () => {
    expect(isIpInCidr("10.99.88.77", "10.0.0.0/8")).toBe(true);
    expect(isIpInCidr("11.0.0.1", "10.0.0.0/8")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isIpInCidr — IPv6
// ---------------------------------------------------------------------------

describe("isIpInCidr — IPv6", () => {
  it("matches an exact IPv6 address", () => {
    expect(isIpInCidr("2001:db8::1", "2001:db8::1")).toBe(true);
  });

  it("does not match a different IPv6 address", () => {
    expect(isIpInCidr("2001:db8::2", "2001:db8::1")).toBe(false);
  });

  it("matches within a /32 IPv6 prefix", () => {
    expect(isIpInCidr("2001:db8:1234:abcd::1", "2001:db8::/32")).toBe(true);
  });

  it("does not match outside a /32 IPv6 prefix", () => {
    expect(isIpInCidr("2001:dc9::1", "2001:db8::/32")).toBe(false);
  });

  it("matches within a /48 IPv6 prefix", () => {
    expect(isIpInCidr("2001:db8:1234::1", "2001:db8:1234::/48")).toBe(true);
  });

  it("does not match outside a /48 IPv6 prefix", () => {
    expect(isIpInCidr("2001:db8:1235::1", "2001:db8:1234::/48")).toBe(false);
  });

  it("matches loopback ::1 exactly", () => {
    expect(isIpInCidr("::1", "::1")).toBe(true);
    expect(isIpInCidr("::2", "::1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// IPv4-mapped IPv6 addresses
// ---------------------------------------------------------------------------

describe("isIpInCidr — IPv4-mapped IPv6", () => {
  it("matches ::ffff:192.168.1.1 against IPv4 CIDR 192.168.1.0/24", () => {
    expect(isIpInCidr("::ffff:192.168.1.1", "192.168.1.0/24")).toBe(true);
  });

  it("matches ::ffff:192.168.1.1 against exact IPv4 192.168.1.1", () => {
    expect(isIpInCidr("::ffff:192.168.1.1", "192.168.1.1")).toBe(true);
  });

  it("does not match ::ffff:192.168.2.1 against IPv4 CIDR 192.168.1.0/24", () => {
    expect(isIpInCidr("::ffff:192.168.2.1", "192.168.1.0/24")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mixed address families — never match
// ---------------------------------------------------------------------------

describe("isIpInCidr — mixed address families", () => {
  it("does not match an IPv6 address against an IPv4 CIDR", () => {
    expect(isIpInCidr("2001:db8::1", "192.168.1.0/24")).toBe(false);
  });

  it("does not match an IPv4 address against an IPv6 CIDR", () => {
    expect(isIpInCidr("192.168.1.1", "2001:db8::/32")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isIpInAllowlist
// ---------------------------------------------------------------------------

describe("isIpInAllowlist", () => {
  it("returns true when the IP matches an individual entry", () => {
    expect(isIpInAllowlist("10.0.0.1", ["10.0.0.1", "10.0.0.2"])).toBe(true);
  });

  it("returns true when the IP falls within a CIDR entry", () => {
    expect(isIpInAllowlist("10.1.2.3", ["192.168.0.0/16", "10.0.0.0/8"])).toBe(true);
  });

  it("returns false when the IP matches none of the entries", () => {
    expect(isIpInAllowlist("8.8.8.8", ["10.0.0.1", "192.168.1.0/24"])).toBe(false);
  });

  it("returns false for an empty allowlist", () => {
    // Note: caller is responsible for skipping the check when the list is empty.
    // isIpInAllowlist itself returns false for empty lists.
    expect(isIpInAllowlist("10.0.0.1", [])).toBe(false);
  });

  it("ignores whitespace around entries", () => {
    // Leading/trailing spaces in CIDR entries must be stripped before comparison
    expect(isIpInAllowlist("192.168.1.5", ["  192.168.1.0/24  "])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseIpFromRequest
// ---------------------------------------------------------------------------

describe("parseIpFromRequest", () => {
  function buildApp(headers: Record<string, string>) {
    const app = new Hono<{ Variables: { extractedIp: string } }>();
    app.get("/test", (c) => {
      const ip = parseIpFromRequest(c);
      c.set("extractedIp", ip);
      return c.json({ ip });
    });
    return app;
  }

  it("returns the X-Real-IP header value when present", async () => {
    const app = buildApp({});
    const res = await app.request("/test", {
      headers: { "x-real-ip": "1.2.3.4" },
    });
    const body = await res.json() as { ip: string };
    expect(body.ip).toBe("1.2.3.4");
  });

  it("prefers X-Real-IP over X-Forwarded-For", async () => {
    const app = buildApp({});
    const res = await app.request("/test", {
      headers: {
        "x-real-ip": "1.2.3.4",
        "x-forwarded-for": "5.6.7.8, 9.10.11.12",
      },
    });
    const body = await res.json() as { ip: string };
    expect(body.ip).toBe("1.2.3.4");
  });

  it("falls back to the leftmost X-Forwarded-For value", async () => {
    const app = buildApp({});
    const res = await app.request("/test", {
      headers: { "x-forwarded-for": "5.6.7.8, 9.10.11.12" },
    });
    const body = await res.json() as { ip: string };
    expect(body.ip).toBe("5.6.7.8");
  });

  it("returns empty string when no IP header is present", async () => {
    const app = buildApp({});
    const res = await app.request("/test");
    const body = await res.json() as { ip: string };
    expect(body.ip).toBe("");
  });
});

// ---------------------------------------------------------------------------
// createIpAllowlistMiddleware
// ---------------------------------------------------------------------------

describe("createIpAllowlistMiddleware", () => {
  function buildApp(allowlist: string[], clientIp?: string) {
    const app = new Hono<{ Variables: { requestId: string } }>();
    app.use("*", (c, next) => { c.set("requestId", "test-req"); return next(); });
    app.use("*", createIpAllowlistMiddleware({ allowlist, context: "tenant" }));
    app.get("/resource", (c) => c.json({ ok: true }));

    return {
      request: (path: string) =>
        app.request(path, clientIp ? { headers: { "x-real-ip": clientIp } } : {}),
    };
  }

  it("allows all requests when the allowlist is empty", async () => {
    const { request } = buildApp([]);
    const res = await request("/resource");
    expect(res.status).toBe(200);
  });

  it("allows a request whose IP is in the allowlist", async () => {
    const { request } = buildApp(["10.0.0.1", "192.168.1.0/24"], "192.168.1.50");
    const res = await request("/resource");
    expect(res.status).toBe(200);
  });

  it("blocks a request whose IP is NOT in the allowlist", async () => {
    const { request } = buildApp(["10.0.0.1"], "8.8.8.8");
    const res = await request("/resource");
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).not.toContain("8.8.8.8");
    expect(body.error.message).toContain("tenant allowlist");
  });

  it("blocks a request when the IP cannot be determined and an allowlist is configured", async () => {
    const { request } = buildApp(["10.0.0.1"]); // no clientIp header
    const res = await request("/resource");
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("allows a request matching a CIDR range", async () => {
    const { request } = buildApp(["192.168.0.0/16"], "192.168.99.1");
    const res = await request("/resource");
    expect(res.status).toBe(200);
  });

  it("allows an IPv4-mapped IPv6 address that matches an IPv4 CIDR", async () => {
    const { request } = buildApp(["192.168.1.0/24"], "::ffff:192.168.1.5");
    const res = await request("/resource");
    expect(res.status).toBe(200);
  });

  it("blocks an IPv4-mapped IPv6 address outside the IPv4 CIDR", async () => {
    const { request } = buildApp(["192.168.1.0/24"], "::ffff:192.168.2.5");
    const res = await request("/resource");
    expect(res.status).toBe(403);
  });
});
