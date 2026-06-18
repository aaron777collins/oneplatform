/**
 * Tests for BrandingProvider, useBranding hook, BrandLogo component,
 * and the applyBranding DOM helper.
 *
 * Tests cover:
 *   - Provider renders children with default branding when no tenantId is given
 *   - Provider fetches branding on mount when tenantId is present
 *   - Provider applies CSS custom properties to documentElement
 *   - Provider sets document.title to appName
 *   - Provider falls back to defaults on network error
 *   - Provider falls back to defaults on non-ok HTTP response
 *   - useBranding returns resolved branding values
 *   - BrandLogo renders the custom logo image when logoUrl is set
 *   - BrandLogo renders fallback when logoUrl is null
 *   - applyBranding writes CSS variables and document title
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import {
  BrandingProvider,
  BrandLogo,
  useBranding,
  applyBranding,
} from "./BrandingProvider.js";
import type { TenantBrandingConfig } from "./branding-types.js";

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

function makeFetchMock(
  response: Partial<TenantBrandingConfig>,
  status = 200
): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(response),
  } as unknown as Response);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function BrandingConsumer(): React.JSX.Element {
  const { branding, isLoading } = useBranding();
  return (
    <div>
      <span data-testid="primary-color">{branding.primaryColor}</span>
      <span data-testid="app-name">{branding.appName}</span>
      <span data-testid="is-loading">{String(isLoading)}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// applyBranding
// ---------------------------------------------------------------------------

describe("applyBranding", () => {
  it("sets --brand-primary CSS variable on documentElement", () => {
    applyBranding({
      logoUrl: null,
      faviconUrl: null,
      primaryColor: "#ff0000",
      accentColor: "#00ff00",
      appName: "TestApp",
      supportEmail: null,
      customCss: null,
    });

    expect(
      document.documentElement.style.getPropertyValue("--brand-primary")
    ).toBe("#ff0000");
  });

  it("sets --brand-accent CSS variable on documentElement", () => {
    applyBranding({
      logoUrl: null,
      faviconUrl: null,
      primaryColor: "#3b82f6",
      accentColor: "#8b5cf6",
      appName: "TestApp",
      supportEmail: null,
      customCss: null,
    });

    expect(
      document.documentElement.style.getPropertyValue("--brand-accent")
    ).toBe("#8b5cf6");
  });

  it("sets document.title to appName", () => {
    applyBranding({
      logoUrl: null,
      faviconUrl: null,
      primaryColor: "#3b82f6",
      accentColor: "#8b5cf6",
      appName: "AcmeDash",
      supportEmail: null,
      customCss: null,
    });

    expect(document.title).toBe("AcmeDash");
  });

  it("injects a <style> tag for customCss", () => {
    applyBranding({
      logoUrl: null,
      faviconUrl: null,
      primaryColor: "#3b82f6",
      accentColor: "#8b5cf6",
      appName: "TestApp",
      supportEmail: null,
      customCss: "body { font-size: 16px; }",
    });

    const style = document.getElementById("__op_branding_css__");
    expect(style).not.toBeNull();
    expect(style?.textContent).toContain("font-size: 16px");
  });

  it("removes previous <style> tag on repeated calls", () => {
    applyBranding({
      logoUrl: null,
      faviconUrl: null,
      primaryColor: "#3b82f6",
      accentColor: "#8b5cf6",
      appName: "TestApp",
      supportEmail: null,
      customCss: "body { color: red; }",
    });

    applyBranding({
      logoUrl: null,
      faviconUrl: null,
      primaryColor: "#3b82f6",
      accentColor: "#8b5cf6",
      appName: "TestApp",
      supportEmail: null,
      customCss: "body { color: blue; }",
    });

    const styles = document.querySelectorAll("#__op_branding_css__");
    expect(styles).toHaveLength(1);
    expect(styles[0]?.textContent).toContain("color: blue");
  });
});

// ---------------------------------------------------------------------------
// BrandingProvider — no tenantId
// ---------------------------------------------------------------------------

describe("BrandingProvider without tenantId", () => {
  it("renders children immediately with default branding", () => {
    render(
      <BrandingProvider>
        <BrandingConsumer />
      </BrandingProvider>
    );

    expect(screen.getByTestId("primary-color").textContent).toBe("#3b82f6");
    expect(screen.getByTestId("app-name").textContent).toBe("OnePlatform");
    expect(screen.getByTestId("is-loading").textContent).toBe("false");
  });

  it("does not call fetch when tenantId is absent", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(
      <BrandingProvider>
        <span>child</span>
      </BrandingProvider>
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// BrandingProvider — with tenantId
// ---------------------------------------------------------------------------

describe("BrandingProvider with tenantId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clean up injected style/favicon tags between tests
    document.getElementById("__op_branding_css__")?.remove();
    document.getElementById("__op_branding_favicon__")?.remove();
  });

  it("fetches branding and renders resolved values", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      makeFetchMock({ primaryColor: "#ff0000", appName: "AcmeDash" })
    );

    render(
      <BrandingProvider tenantId="tenant-1" apiBaseUrl="http://localhost:3000">
        <BrandingConsumer />
      </BrandingProvider>
    );

    // Initially loading
    expect(screen.getByTestId("is-loading").textContent).toBe("true");

    await waitFor(() =>
      expect(screen.getByTestId("is-loading").textContent).toBe("false")
    );

    expect(screen.getByTestId("primary-color").textContent).toBe("#ff0000");
    expect(screen.getByTestId("app-name").textContent).toBe("AcmeDash");
  });

  it("calls the correct API endpoint for the tenant", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(makeFetchMock({}));

    render(
      <BrandingProvider tenantId="tenant-42" apiBaseUrl="http://api.example.com">
        <span>child</span>
      </BrandingProvider>
    );

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://api.example.com/api/v1/tenants/tenant-42/branding",
      expect.objectContaining({ method: "GET", credentials: "include" })
    );
  });

  it("falls back to defaults when fetch returns a non-ok status", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchMock({}, 404));

    render(
      <BrandingProvider tenantId="tenant-1" apiBaseUrl="http://localhost:3000">
        <BrandingConsumer />
      </BrandingProvider>
    );

    await waitFor(() =>
      expect(screen.getByTestId("is-loading").textContent).toBe("false")
    );

    // Defaults should be used
    expect(screen.getByTestId("primary-color").textContent).toBe("#3b82f6");
    expect(screen.getByTestId("app-name").textContent).toBe("OnePlatform");
  });

  it("falls back to defaults when fetch throws a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("Failed to fetch")
    );

    render(
      <BrandingProvider tenantId="tenant-1" apiBaseUrl="http://localhost:3000">
        <BrandingConsumer />
      </BrandingProvider>
    );

    await waitFor(() =>
      expect(screen.getByTestId("is-loading").textContent).toBe("false")
    );

    expect(screen.getByTestId("primary-color").textContent).toBe("#3b82f6");
    expect(screen.getByTestId("app-name").textContent).toBe("OnePlatform");
  });

  it("applies CSS variables after successful fetch", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      makeFetchMock({ primaryColor: "#abcdef", accentColor: "#fedcba" })
    );

    render(
      <BrandingProvider tenantId="tenant-1" apiBaseUrl="http://localhost:3000">
        <span>child</span>
      </BrandingProvider>
    );

    await waitFor(() =>
      expect(
        document.documentElement.style.getPropertyValue("--brand-primary")
      ).toBe("#abcdef")
    );

    expect(
      document.documentElement.style.getPropertyValue("--brand-accent")
    ).toBe("#fedcba");
  });

  it("calls onBrandingApplied callback with resolved branding", async () => {
    const onApplied = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      makeFetchMock({ appName: "CallbackTest" })
    );

    render(
      <BrandingProvider
        tenantId="tenant-1"
        apiBaseUrl="http://localhost:3000"
        onBrandingApplied={onApplied}
      >
        <span>child</span>
      </BrandingProvider>
    );

    await waitFor(() => expect(onApplied).toHaveBeenCalledOnce());
    expect(onApplied).toHaveBeenCalledWith(
      expect.objectContaining({ appName: "CallbackTest" })
    );
  });

  it("uses platform defaults for unset fields in partial API response", async () => {
    // API only returns primaryColor — everything else should default
    vi.spyOn(globalThis, "fetch").mockImplementation(
      makeFetchMock({ primaryColor: "#112233" })
    );

    const onApplied = vi.fn();
    render(
      <BrandingProvider
        tenantId="tenant-1"
        apiBaseUrl="http://localhost:3000"
        onBrandingApplied={onApplied}
      >
        <span>child</span>
      </BrandingProvider>
    );

    await waitFor(() => expect(onApplied).toHaveBeenCalledOnce());
    const resolved = onApplied.mock.calls[0]![0] as TenantBrandingConfig;
    expect(resolved.primaryColor).toBe("#112233");
    expect(resolved.accentColor).toBe("#8b5cf6"); // default
    expect(resolved.appName).toBe("OnePlatform"); // default
    expect(resolved.logoUrl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// BrandLogo
// ---------------------------------------------------------------------------

describe("BrandLogo", () => {
  it("renders an img when logoUrl is set", () => {
    render(
      <BrandingProvider>
        <BrandingContext.Provider
          value={{
            branding: {
              logoUrl: "https://cdn.acme.com/logo.svg",
              faviconUrl: null,
              primaryColor: "#3b82f6",
              accentColor: "#8b5cf6",
              appName: "Acme",
              supportEmail: null,
              customCss: null,
            },
            isLoading: false,
          }}
        >
          <BrandLogo />
        </BrandingContext.Provider>
      </BrandingProvider>
    );

    const img = screen.getByRole("img");
    expect(img.getAttribute("src")).toBe("https://cdn.acme.com/logo.svg");
    expect(img.getAttribute("alt")).toBe("Acme");
  });

  it("renders the fallback element when logoUrl is null", () => {
    render(
      <BrandingProvider>
        <BrandLogo fallback={<span data-testid="fallback">Default Logo</span>} />
      </BrandingProvider>
    );

    // getByTestId throws if absent — so existence is asserted by the query itself
    expect(screen.getByTestId("fallback").textContent).toBe("Default Logo");
  });

  it("renders a span with appName when no logo and no fallback", () => {
    render(
      <BrandingProvider>
        <BrandLogo />
      </BrandingProvider>
    );

    // Should render the appName text — getByText throws if not found
    expect(screen.getByText("OnePlatform").textContent).toBe("OnePlatform");
  });

  it("uses the alt prop over appName when both are present", () => {
    render(
      <BrandingProvider>
        <BrandingContext.Provider
          value={{
            branding: {
              logoUrl: "https://cdn.acme.com/logo.svg",
              faviconUrl: null,
              primaryColor: "#3b82f6",
              accentColor: "#8b5cf6",
              appName: "Acme",
              supportEmail: null,
              customCss: null,
            },
            isLoading: false,
          }}
        >
          <BrandLogo alt="Custom alt text" />
        </BrandingContext.Provider>
      </BrandingProvider>
    );

    expect(screen.getByRole("img").getAttribute("alt")).toBe("Custom alt text");
  });
});

// Need to import BrandingContext for direct context injection in logo tests
import { BrandingContext } from "./BrandingProvider.js";
