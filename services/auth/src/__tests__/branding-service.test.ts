/**
 * Unit tests for BrandingService.
 *
 * These tests cover:
 *   - CRUD operations (get / update / reset)
 *   - Hex colour validation
 *   - URL validation
 *   - CSS sanitisation (dangerous property stripping)
 *   - CSS size enforcement (10 KB cap)
 *   - Default fallback values for unset branding fields
 *   - Partial update merging (existing values not clobbered)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type pg from "pg";
import {
  createBrandingService,
  isValidHexColor,
  isValidUrl,
  sanitizeCss,
} from "../services/branding-service.js";
import { ValidationError } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(storedBranding: Record<string, unknown> = {}): pg.Pool {
  return {
    query: vi.fn().mockResolvedValue({
      rows: [{ branding: storedBranding }],
      rowCount: 1,
    }),
  } as unknown as pg.Pool;
}

// A db that returns no rows — simulates a missing/deleted tenant.
function makeEmptyDb(): pg.Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  } as unknown as pg.Pool;
}

// ---------------------------------------------------------------------------
// isValidHexColor
// ---------------------------------------------------------------------------

describe("isValidHexColor", () => {
  it("accepts a valid 6-digit hex with hash", () => {
    expect(isValidHexColor("#3b82f6")).toBe(true);
  });

  it("accepts a valid 3-digit shorthand hex", () => {
    expect(isValidHexColor("#f00")).toBe(true);
  });

  it("accepts uppercase hex digits", () => {
    expect(isValidHexColor("#AABBCC")).toBe(true);
  });

  it("rejects hex without leading hash", () => {
    expect(isValidHexColor("3b82f6")).toBe(false);
  });

  it("rejects 4-digit hex", () => {
    expect(isValidHexColor("#abc1")).toBe(false);
  });

  it("rejects 5-digit hex", () => {
    expect(isValidHexColor("#abcde")).toBe(false);
  });

  it("rejects 7-digit hex", () => {
    expect(isValidHexColor("#1234567")).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(isValidHexColor("#zzzzzz")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidHexColor("")).toBe(false);
  });

  it("rejects CSS color name", () => {
    expect(isValidHexColor("red")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isValidUrl
// ---------------------------------------------------------------------------

describe("isValidUrl", () => {
  it("accepts an https URL", () => {
    expect(isValidUrl("https://cdn.example.com/logo.png")).toBe(true);
  });

  it("accepts an http URL", () => {
    expect(isValidUrl("http://localhost:3000/logo.png")).toBe(true);
  });

  it("rejects a data: URI", () => {
    expect(isValidUrl("data:image/png;base64,abc")).toBe(false);
  });

  it("rejects a javascript: URL", () => {
    expect(isValidUrl("javascript:alert(1)")).toBe(false);
  });

  it("rejects a plain string", () => {
    expect(isValidUrl("not-a-url")).toBe(false);
  });

  it("rejects a relative path", () => {
    expect(isValidUrl("/static/logo.png")).toBe(false);
  });

  it("rejects an ftp URL", () => {
    expect(isValidUrl("ftp://files.example.com/logo.png")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sanitizeCss
// ---------------------------------------------------------------------------

describe("sanitizeCss", () => {
  it("passes through benign CSS unchanged", () => {
    const css = "body { color: red; font-size: 14px; }";
    expect(sanitizeCss(css)).toBe(css);
  });

  it("strips url() references", () => {
    const css = "body { background: url(https://evil.com/tracker.png); }";
    const result = sanitizeCss(css);
    expect(result).not.toContain("url(");
    expect(result).toContain("body {");
  });

  it("strips @import rules", () => {
    const css = "@import url('https://evil.com/exfil.css'); body { color: red; }";
    const result = sanitizeCss(css);
    expect(result).not.toContain("@import");
  });

  it("strips javascript: occurrences in property values", () => {
    const css = "a { content: javascript:alert(1); }";
    const result = sanitizeCss(css);
    expect(result).not.toContain("javascript:");
  });

  it("strips expression() calls (IE CSS injection)", () => {
    const css = "div { width: expression(document.body.scrollLeft); }";
    const result = sanitizeCss(css);
    expect(result).not.toContain("expression(");
  });

  it("is case-insensitive when stripping url()", () => {
    const css = "body { background: URL('https://evil.com/x.png'); }";
    const result = sanitizeCss(css);
    expect(result).not.toContain("URL(");
  });

  it("is case-insensitive when stripping @import", () => {
    const css = "@IMPORT 'evil.css'; body {}";
    const result = sanitizeCss(css);
    expect(result).not.toContain("@IMPORT");
  });

  it("throws ValidationError when CSS exceeds 10 KB", () => {
    const oversized = "a { color: red; } ".repeat(1000); // well over 10 KB
    expect(() => sanitizeCss(oversized)).toThrow(ValidationError);
  });

  it("accepts CSS exactly at the 10 KB boundary", () => {
    // Build a string that is exactly 10240 bytes of valid CSS.
    const padding = "/* " + "x".repeat(10_234) + " */";
    expect(padding.length).toBeLessThanOrEqual(10_240);
    expect(() => sanitizeCss(padding)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// BrandingService — getBranding
// ---------------------------------------------------------------------------

describe("BrandingService.getBranding", () => {
  it("returns platform defaults when tenant has no custom branding", async () => {
    const db = makeEmptyDb();
    const service = createBrandingService({ db });

    const result = await service.getBranding("tenant-1");

    expect(result.primaryColor).toBe("#3b82f6");
    expect(result.accentColor).toBe("#8b5cf6");
    expect(result.appName).toBe("OnePlatform");
    expect(result.logoUrl).toBeNull();
    expect(result.faviconUrl).toBeNull();
    expect(result.supportEmail).toBeNull();
    expect(result.customCss).toBeNull();
  });

  it("returns stored values where set, defaults where not", async () => {
    const db = makeDb({
      primaryColor: "#ff0000",
      appName: "MyBrand",
    });
    const service = createBrandingService({ db });

    const result = await service.getBranding("tenant-1");

    expect(result.primaryColor).toBe("#ff0000");
    expect(result.appName).toBe("MyBrand");
    // Unset fields fall back to defaults
    expect(result.accentColor).toBe("#8b5cf6");
    expect(result.logoUrl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// BrandingService — updateBranding
// ---------------------------------------------------------------------------

describe("BrandingService.updateBranding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists valid branding and returns resolved values", async () => {
    const db = makeDb({});
    const service = createBrandingService({ db });

    const result = await service.updateBranding("tenant-1", {
      primaryColor: "#ff0000",
      appName: "AcmeDash",
    });

    expect(result.primaryColor).toBe("#ff0000");
    expect(result.appName).toBe("AcmeDash");
    // The UPDATE must have been called with parameterised query
    const mockQuery = vi.mocked(db.query);
    const updateCall = mockQuery.mock.calls.find((call) =>
      typeof call[0] === "string" && call[0].includes("UPDATE")
    );
    expect(updateCall).toBeDefined();
    // Tenant ID is always the first bind parameter
    expect(updateCall![1]![0]).toBe("tenant-1");
  });

  it("merges partial updates with existing stored branding", async () => {
    const db = makeDb({ primaryColor: "#aabbcc", appName: "ExistingName" });
    const service = createBrandingService({ db });

    const result = await service.updateBranding("tenant-1", {
      accentColor: "#112233",
    });

    // Existing values must be preserved
    expect(result.primaryColor).toBe("#aabbcc");
    expect(result.appName).toBe("ExistingName");
    // New value must be present
    expect(result.accentColor).toBe("#112233");
  });

  it("rejects an invalid hex primaryColor", async () => {
    const db = makeDb({});
    const service = createBrandingService({ db });

    await expect(
      service.updateBranding("tenant-1", { primaryColor: "notacolor" })
    ).rejects.toThrow(ValidationError);
  });

  it("rejects an invalid hex accentColor", async () => {
    const db = makeDb({});
    const service = createBrandingService({ db });

    await expect(
      service.updateBranding("tenant-1", { accentColor: "rgb(255,0,0)" })
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a non-absolute logoUrl", async () => {
    const db = makeDb({});
    const service = createBrandingService({ db });

    await expect(
      service.updateBranding("tenant-1", { logoUrl: "/static/logo.png" })
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a non-absolute faviconUrl", async () => {
    const db = makeDb({});
    const service = createBrandingService({ db });

    await expect(
      service.updateBranding("tenant-1", { faviconUrl: "data:image/png;base64,abc" })
    ).rejects.toThrow(ValidationError);
  });

  it("rejects an empty appName", async () => {
    const db = makeDb({});
    const service = createBrandingService({ db });

    await expect(
      service.updateBranding("tenant-1", { appName: "   " })
    ).rejects.toThrow(ValidationError);
  });

  it("rejects an invalid supportEmail", async () => {
    const db = makeDb({});
    const service = createBrandingService({ db });

    await expect(
      service.updateBranding("tenant-1", { supportEmail: "not-an-email" })
    ).rejects.toThrow(ValidationError);
  });

  it("sanitises url() out of custom CSS before persisting", async () => {
    const db = makeDb({});
    const service = createBrandingService({ db });

    // The update should succeed — dangerous parts are stripped, not rejected.
    const result = await service.updateBranding("tenant-1", {
      customCss: "body { background: url(https://evil.com/track.png); color: red; }",
    });

    // The resolved branding must not contain url()
    expect(result.customCss).not.toContain("url(");
  });

  it("rejects customCss that exceeds 10 KB", async () => {
    const db = makeDb({});
    const service = createBrandingService({ db });

    const oversized = "a { color: red; } ".repeat(1000);
    await expect(
      service.updateBranding("tenant-1", { customCss: oversized })
    ).rejects.toThrow(ValidationError);
  });

  it("accepts a valid https logoUrl", async () => {
    const db = makeDb({});
    const service = createBrandingService({ db });

    const result = await service.updateBranding("tenant-1", {
      logoUrl: "https://cdn.example.com/logo.svg",
    });

    expect(result.logoUrl).toBe("https://cdn.example.com/logo.svg");
  });
});

// ---------------------------------------------------------------------------
// BrandingService — resetBranding
// ---------------------------------------------------------------------------

describe("BrandingService.resetBranding", () => {
  it("returns platform defaults after reset", async () => {
    const db = makeDb({ primaryColor: "#ff0000", appName: "CustomName" });
    const service = createBrandingService({ db });

    const result = await service.resetBranding("tenant-1");

    expect(result.primaryColor).toBe("#3b82f6");
    expect(result.accentColor).toBe("#8b5cf6");
    expect(result.appName).toBe("OnePlatform");
    expect(result.logoUrl).toBeNull();
    expect(result.customCss).toBeNull();
  });

  it("issues an UPDATE with empty branding object", async () => {
    const db = makeDb({});
    const service = createBrandingService({ db });

    await service.resetBranding("tenant-1");

    const mockQuery = vi.mocked(db.query);
    const updateCall = mockQuery.mock.calls.find((call) =>
      typeof call[0] === "string" && call[0].includes("UPDATE")
    );
    expect(updateCall).toBeDefined();
    // The UPDATE query uses $1 for tenant ID, $2 for the literal '{}' in SQL
    expect(updateCall![1]![0]).toBe("tenant-1");
  });
});
