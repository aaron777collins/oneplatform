import { describe, it, expect } from "vitest";
import { safeRedirect } from "@/lib/auth-utils.js";

describe("safeRedirect", () => {
  // ---------------------------------------------------------------------------
  // Allowed values — relative paths starting with exactly one "/"
  // ---------------------------------------------------------------------------

  it("allows root path /", () => { expect(safeRedirect("/")).toBe("/"); });
  it("allows /dashboard", () => { expect(safeRedirect("/dashboard")).toBe("/dashboard"); });
  it("allows /settings?tab=api", () => { expect(safeRedirect("/settings?tab=api")).toBe("/settings?tab=api"); });
  it("allows /path/with/segments", () => { expect(safeRedirect("/a/b/c")).toBe("/a/b/c"); });

  // ---------------------------------------------------------------------------
  // Dangerous schemes — must all fall back to "/"
  // ---------------------------------------------------------------------------

  it("blocks javascript: URI", () => { expect(safeRedirect("javascript:alert(1)")).toBe("/"); });
  it("blocks data: URI", () => { expect(safeRedirect("data:text/html,<h1>")).toBe("/"); });
  it("blocks vbscript: URI", () => { expect(safeRedirect("vbscript:msgbox")).toBe("/"); });

  // ---------------------------------------------------------------------------
  // Absolute URLs — must fall back to "/"
  // ---------------------------------------------------------------------------

  it("blocks https://evil.com", () => { expect(safeRedirect("https://evil.com")).toBe("/"); });
  it("blocks http://evil.com", () => { expect(safeRedirect("http://evil.com")).toBe("/"); });

  // ---------------------------------------------------------------------------
  // Protocol-relative paths — browsers treat these as absolute
  // ---------------------------------------------------------------------------

  it("blocks //evil.com", () => { expect(safeRedirect("//evil.com")).toBe("/"); });
  it("blocks //evil.com/path", () => { expect(safeRedirect("//evil.com/path")).toBe("/"); });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it("returns / for empty string", () => { expect(safeRedirect("")).toBe("/"); });
  it("blocks relative path without leading /", () => { expect(safeRedirect("dashboard")).toBe("/"); });
  it("blocks backslash path (\\evil.com)", () => { expect(safeRedirect("\\evil.com")).toBe("/"); });

  // ---------------------------------------------------------------------------
  // Case variations — the allowlist approach is inherently case-insensitive
  // for schemes since none of the allowed paths start with a scheme prefix
  // ---------------------------------------------------------------------------

  it("blocks JAVASCRIPT: (case-insensitive)", () => { expect(safeRedirect("JAVASCRIPT:void(0)")).toBe("/"); });
  it("blocks Data: (mixed case)", () => { expect(safeRedirect("Data:text/html,x")).toBe("/"); });
});
