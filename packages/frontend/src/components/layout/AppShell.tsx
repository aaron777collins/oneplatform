/**
 * AppShell — main authenticated application frame.
 *
 * Renders Sidebar (left) + Topbar (top) + main content area (right).
 * Uses TanStack Router's Outlet for nested route content.
 *
 * On mobile (< 768px) the sidebar is hidden. A hamburger button in Topbar
 * opens a full-height overlay drawer containing the Sidebar. The drawer
 * closes automatically on route change so the user is never left with it open.
 *
 * The <main> element has tabIndex={-1} so focus can be programmatically moved
 * to the content region on route change (§14.5 focus management).
 */
import * as React from "react";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { Sidebar } from "@/components/layout/Sidebar.js";
import { Topbar } from "@/components/layout/Topbar.js";
import { MobileNavigation } from "@/components/mobile/MobileNavigation.js";
import { useIsMobile } from "@/components/mobile/ResponsiveLayout.js";
import { Toaster } from "@/components/ui/toaster.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

export function AppShell() {
  const mainRef = React.useRef<HTMLElement>(null);
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  const isMobile = useIsMobile();

  // useRouterState gives us the resolved pathname so we can key focus management
  // on actual route changes rather than triggering on every re-render.
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Move focus to the main content region only when the route pathname changes.
  // Without a dependency array this fires on every render, which disturbs focus
  // during in-page state updates (e.g. form submissions, data re-fetches).
  React.useEffect(() => {
    mainRef.current?.focus();
    // Close mobile nav on route change so the user isn't left with the drawer open
    setMobileNavOpen(false);
  }, [pathname]);

  return (
    <TooltipProvider>
      <div className="flex h-screen overflow-hidden bg-[var(--color-background)]">
        {/* Desktop sidebar — hidden below md breakpoint */}
        <div className="hidden md:flex">
          <Sidebar />
        </div>

        {/* Mobile navigation drawer overlay — visible only when hamburger is open */}
        {mobileNavOpen && (
          <>
            {/* Backdrop: clicking outside closes the drawer */}
            <div
              className="fixed inset-0 z-40 bg-black/50 md:hidden"
              aria-hidden="true"
              onClick={() => setMobileNavOpen(false)}
            />
            {/* Drawer panel */}
            <div
              className="fixed inset-y-0 left-0 z-50 flex md:hidden"
              role="dialog"
              aria-modal="true"
              aria-label="Navigation"
            >
              <Sidebar />
            </div>
          </>
        )}

        {/* Right column: topbar + scrollable content */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <Topbar
            onMobileMenuToggle={() => setMobileNavOpen((prev) => !prev)}
            mobileMenuOpen={mobileNavOpen}
          />

          <main
            ref={mainRef}
            // tabIndex={-1} allows programmatic focus without being in the tab order
            tabIndex={-1}
            className="flex-1 overflow-y-auto outline-none"
            // On mobile the MobileNavigation bar is fixed at the bottom (~56px).
            // Padding prevents content from being obscured behind it.
            // env(safe-area-inset-bottom) accounts for devices with home indicators.
            style={
              isMobile
                ? { paddingBottom: "calc(3.5rem + env(safe-area-inset-bottom, 0px))" }
                : undefined
            }
            id="main-content"
          >
            <Outlet />
          </main>
        </div>
      </div>

      {/* Mobile bottom navigation — visible only on small screens */}
      <MobileNavigation />

      {/* Toaster rendered outside the main layout flow to prevent z-index issues */}
      <Toaster />
    </TooltipProvider>
  );
}
