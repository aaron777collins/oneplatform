// packages/core/src/__tests__/deprecation-headers.test.ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { deprecationHeadersMiddleware, type DeprecationInfo } from "../middleware/deprecation-headers.js";

function buildApp(deprecationInfo?: DeprecationInfo) {
  const app = new Hono<{ Variables: { deprecationInfo?: DeprecationInfo; requestId: string } }>();
  if (deprecationInfo) {
    app.use("*", (c, next) => { c.set("deprecationInfo", deprecationInfo); return next(); });
  }
  app.use("*", deprecationHeadersMiddleware());
  app.get("/api/v1/old-resource", (c) => c.json({ id: "1" }));
  return app;
}

describe("deprecationHeadersMiddleware", () => {
  it("sets Deprecation: true header when deprecationInfo is present", async () => {
    const info: DeprecationInfo = {
      sunset: new Date("2028-01-01T00:00:00Z"),
      successorUrl: "https://docs.oneplatform.dev/api/v2/resource",
    };
    const res = await buildApp(info).request("/api/v1/old-resource");
    expect(res.headers.get("Deprecation")).toBe("true");
  });

  it("sets Sunset header in RFC 7231 HTTP-date format", async () => {
    const sunsetDate = new Date("2028-01-01T00:00:00Z");
    const info: DeprecationInfo = { sunset: sunsetDate, successorUrl: "https://docs.oneplatform.dev/api/v2/resource" };
    const res = await buildApp(info).request("/api/v1/old-resource");
    const sunsetHeader = res.headers.get("Sunset");
    expect(sunsetHeader).toBeTruthy();
    // RFC 7231 format: "Sat, 01 Jan 2028 00:00:00 GMT"
    expect(new Date(sunsetHeader!).getTime()).toBe(sunsetDate.getTime());
  });

  it("sets Link header with rel=successor-version pointing to the new URL", async () => {
    const info: DeprecationInfo = {
      sunset: new Date("2028-01-01"),
      successorUrl: "https://docs.oneplatform.dev/api/v2/resource",
    };
    const res = await buildApp(info).request("/api/v1/old-resource");
    const linkHeader = res.headers.get("Link") ?? "";
    expect(linkHeader).toContain("https://docs.oneplatform.dev/api/v2/resource");
    expect(linkHeader).toContain('rel="successor-version"');
  });

  it("does not set deprecation headers when deprecationInfo is absent", async () => {
    const res = await buildApp().request("/api/v1/old-resource");
    expect(res.headers.get("Deprecation")).toBeNull();
    expect(res.headers.get("Sunset")).toBeNull();
  });
});
