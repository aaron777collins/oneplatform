/**
 * AppShell — main authenticated application frame.
 *
 * Renders Sidebar (left) + Topbar (top) + main content area (right).
 * Uses TanStack Router's Outlet for nested route content.
 *
 * On mobile (< 768px) the sidebar collapses to icon-only mode automatically.
 * The Toaster is mounted here so toast notifications work across all pages.
 *
 * The <main> element has tabIndex={-1} so focus can be programmatically moved
 * to the content region on route change (§14.5 focus management).
 */
import * as React from "react";
import { Outlet } from "@tanstack/react-router";
import { Sidebar } from "@/components/layout/Sidebar.js";
import { Topbar } from "@/components/layout/Topbar.js";
import { Toaster } from "@/components/ui/toaster.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

export function AppShell() {
  const mainRef = React.useRef<HTMLElement>(null);

  // Move focus to the main content region on every route change.
  // This helps screen reader users know a navigation has occurred.
  React.useEffect(() => {
    mainRef.current?.focus();
  });

  return (
    <TooltipProvider>
      <div className="flex h-screen overflow-hidden bg-[var(--color-background)]">
        {/* Sidebar — hidden on small screens via CSS; collapsed state managed internally */}
        <div className="hidden md:flex">
          <Sidebar />
        </div>

        {/* Right column: topbar + scrollable content */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <Topbar />

          <main
            ref={mainRef}
            // tabIndex={-1} allows programmatic focus without being in the tab order
            tabIndex={-1}
            className="flex-1 overflow-y-auto outline-none"
            id="main-content"
          >
            <Outlet />
          </main>
        </div>
      </div>

      {/* Toaster rendered outside the main layout flow to prevent z-index issues */}
      <Toaster />
    </TooltipProvider>
  );
}
