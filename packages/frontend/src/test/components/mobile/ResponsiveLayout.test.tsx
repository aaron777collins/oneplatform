/**
 * ResponsiveLayout tests.
 *
 * matchMedia is mocked via vi.stubGlobal so we can simulate mobile and
 * desktop viewport widths without a real browser.
 *
 * We test:
 * 1. useIsMobile returns correct values based on matchMedia
 * 2. ResponsiveLayout renders children, sidebar, topbar, and mobileNav slots
 * 3. The bottom padding on <main> is applied only when isMobile is true
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import React from "react";
import { renderHook } from "@testing-library/react";
import { ResponsiveLayout, useIsMobile } from "@/components/mobile/ResponsiveLayout.js";

// ---------------------------------------------------------------------------
// matchMedia mock factory
// ---------------------------------------------------------------------------

type MediaQueryCallback = (event: MediaQueryListEvent) => void;

function createMatchMediaMock(matches: boolean) {
  let currentMatches = matches;
  const listeners: MediaQueryCallback[] = [];

  const mq = {
    matches: currentMatches,
    media: "(max-width: 767px)",
    addEventListener: vi.fn((type: string, listener: MediaQueryCallback) => {
      if (type === "change") listeners.push(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: MediaQueryCallback) => {
      const idx = listeners.indexOf(listener);
      if (idx !== -1) listeners.splice(idx, 1);
    }),
    dispatchEvent: vi.fn(),
    // Helper used by tests to simulate a resize event
    _trigger: (newMatches: boolean) => {
      currentMatches = newMatches;
      mq.matches = newMatches;
      const event = { matches: newMatches } as MediaQueryListEvent;
      listeners.forEach((l) => l(event));
    },
  };

  return mq;
}

// ---------------------------------------------------------------------------
// Tests: useIsMobile
// ---------------------------------------------------------------------------

describe("useIsMobile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns true when viewport is narrower than 768px", () => {
    const mq = createMatchMediaMock(true);
    vi.stubGlobal("matchMedia", () => mq);

    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it("returns false when viewport is 768px or wider", () => {
    const mq = createMatchMediaMock(false);
    vi.stubGlobal("matchMedia", () => mq);

    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });

  it("updates when the viewport crosses the mobile breakpoint", () => {
    const mq = createMatchMediaMock(false);
    vi.stubGlobal("matchMedia", () => mq);

    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);

    act(() => mq._trigger(true));
    expect(result.current).toBe(true);

    act(() => mq._trigger(false));
    expect(result.current).toBe(false);
  });

  it("removes the listener on unmount", () => {
    const mq = createMatchMediaMock(false);
    vi.stubGlobal("matchMedia", () => mq);

    const { unmount } = renderHook(() => useIsMobile());
    unmount();

    expect(mq.removeEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: ResponsiveLayout
// ---------------------------------------------------------------------------

describe("ResponsiveLayout", () => {
  const Sidebar = () => <nav aria-label="Desktop sidebar">Sidebar</nav>;
  const Topbar = () => <header>Topbar</header>;
  const MobileNav = () => <nav aria-label="Mobile nav">Mobile Nav</nav>;
  const Content = () => <div>Page content</div>;

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders children in the main content area", () => {
    const mq = createMatchMediaMock(false);
    vi.stubGlobal("matchMedia", () => mq);

    render(
      <ResponsiveLayout sidebar={<Sidebar />} topbar={<Topbar />} mobileNav={<MobileNav />}>
        <Content />
      </ResponsiveLayout>,
    );

    expect(screen.getByText("Page content")).toBeInTheDocument();
  });

  it("renders the topbar slot", () => {
    const mq = createMatchMediaMock(false);
    vi.stubGlobal("matchMedia", () => mq);

    render(
      <ResponsiveLayout sidebar={<Sidebar />} topbar={<Topbar />} mobileNav={<MobileNav />}>
        <Content />
      </ResponsiveLayout>,
    );

    expect(screen.getByText("Topbar")).toBeInTheDocument();
  });

  it("renders the mobileNav slot", () => {
    const mq = createMatchMediaMock(true);
    vi.stubGlobal("matchMedia", () => mq);

    render(
      <ResponsiveLayout sidebar={<Sidebar />} topbar={<Topbar />} mobileNav={<MobileNav />}>
        <Content />
      </ResponsiveLayout>,
    );

    expect(
      screen.getByRole("navigation", { name: /mobile nav/i }),
    ).toBeInTheDocument();
  });

  it("applies bottom padding style to main on mobile viewports", () => {
    const mq = createMatchMediaMock(true);
    vi.stubGlobal("matchMedia", () => mq);

    render(
      <ResponsiveLayout sidebar={<Sidebar />} topbar={<Topbar />} mobileNav={<MobileNav />}>
        <Content />
      </ResponsiveLayout>,
    );

    const main = screen.getByRole("main");
    // paddingBottom should be set to account for the bottom nav bar
    expect(main.style.paddingBottom).not.toBe("");
  });

  it("does not apply bottom padding to main on desktop viewports", () => {
    const mq = createMatchMediaMock(false);
    vi.stubGlobal("matchMedia", () => mq);

    render(
      <ResponsiveLayout sidebar={<Sidebar />} topbar={<Topbar />} mobileNav={<MobileNav />}>
        <Content />
      </ResponsiveLayout>,
    );

    const main = screen.getByRole("main");
    expect(main.style.paddingBottom).toBe("");
  });

  it("updates padding when viewport transitions from desktop to mobile", () => {
    const mq = createMatchMediaMock(false);
    vi.stubGlobal("matchMedia", () => mq);

    render(
      <ResponsiveLayout sidebar={<Sidebar />} topbar={<Topbar />} mobileNav={<MobileNav />}>
        <Content />
      </ResponsiveLayout>,
    );

    const main = screen.getByRole("main");
    expect(main.style.paddingBottom).toBe("");

    act(() => mq._trigger(true));
    expect(main.style.paddingBottom).not.toBe("");
  });

  it("renders the main element with id='main-content'", () => {
    const mq = createMatchMediaMock(false);
    vi.stubGlobal("matchMedia", () => mq);

    render(
      <ResponsiveLayout sidebar={<Sidebar />} topbar={<Topbar />} mobileNav={<MobileNav />}>
        <Content />
      </ResponsiveLayout>,
    );

    expect(document.getElementById("main-content")).not.toBeNull();
  });
});
