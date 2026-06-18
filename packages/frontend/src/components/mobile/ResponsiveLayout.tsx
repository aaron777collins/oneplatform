/**
 * ResponsiveLayout — switches between the desktop sidebar layout and the
 * mobile bottom-nav layout based on the viewport width.
 *
 * Why matchMedia instead of pure CSS:
 * - The Sidebar and MobileNavigation are distinct React trees, not the same
 *   element shown/hidden via CSS. matchMedia lets us unmount the tree that
 *   is not in use, preventing accessibility tools from announcing hidden nav
 *   items and keeping the React tree lean.
 * - CSS classes (md:hidden / md:flex) are still used as the primary control;
 *   the JS `isMobile` state is only used to conditionally add bottom padding
 *   to the main content area on mobile (to avoid content being hidden under
 *   the bottom tab bar).
 *
 * Transitions: CSS transitions on the layout shell provide smooth visual
 * continuity. They are suppressed via @media (prefers-reduced-motion: reduce)
 * defined in globals.css.
 */
import * as React from "react";

// ---------------------------------------------------------------------------
// useIsMobile hook
// ---------------------------------------------------------------------------

const MOBILE_BREAKPOINT = 768; // matches Tailwind's md: breakpoint (48rem)

/**
 * Returns true when the viewport is narrower than the md breakpoint.
 *
 * Initialises synchronously from matchMedia so the component never renders
 * with the wrong value on the first frame — prevents a flash of desktop
 * layout on mobile devices during SSR hydration or on fast initial paints.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = React.useState<boolean>(() =>
    // window may be undefined in SSR / test environments
    typeof window !== "undefined"
      ? window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`).matches
      : false,
  );

  React.useEffect(() => {
    if (typeof window === "undefined") return;

    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);

    function handleChange(event: MediaQueryListEvent) {
      setIsMobile(event.matches);
    }

    // addEventListener is available in all modern browsers; addListener is
    // the deprecated fallback for older WebKit. No polyfill required since
    // this codebase targets es2020+ (vite.config.ts).
    mq.addEventListener("change", handleChange);
    return () => mq.removeEventListener("change", handleChange);
  }, []);

  return isMobile;
}

// ---------------------------------------------------------------------------
// ResponsiveLayout props
// ---------------------------------------------------------------------------

export interface ResponsiveLayoutProps {
  /** The main page content — rendered inside the scrollable content region. */
  children: React.ReactNode;
  /**
   * The desktop sidebar element. Caller provides the already-rendered Sidebar
   * so ResponsiveLayout stays presentational and has no nav coupling.
   */
  sidebar: React.ReactNode;
  /**
   * The desktop topbar element. Rendered above the content area on all
   * viewport widths (it contains the hamburger on mobile).
   */
  topbar: React.ReactNode;
  /**
   * The mobile bottom navigation element. Rendered only on mobile screens.
   * The caller provides it fully configured so ResponsiveLayout does not need
   * to know which nav items exist.
   */
  mobileNav: React.ReactNode;
  /** Reference forwarded to the <main> element for programmatic focus management. */
  mainRef?: React.RefObject<HTMLElement | null>;
  className?: string;
}

// ---------------------------------------------------------------------------
// ResponsiveLayout
// ---------------------------------------------------------------------------

export function ResponsiveLayout({
  children,
  sidebar,
  topbar,
  mobileNav,
  mainRef,
  className,
}: ResponsiveLayoutProps) {
  const isMobile = useIsMobile();

  return (
    <div
      className={
        className ??
        "flex h-screen overflow-hidden bg-[var(--color-background)]"
      }
    >
      {/* Desktop sidebar — CSS-hidden on mobile (md:flex) */}
      <div className="hidden md:flex">{sidebar}</div>

      {/* Right column: topbar + scrollable content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {topbar}

        <main
          ref={mainRef as React.RefObject<HTMLElement>}
          // tabIndex={-1} allows programmatic focus without polluting the tab order
          tabIndex={-1}
          className="flex-1 overflow-y-auto outline-none"
          // When mobile nav is present, add bottom padding so content is not
          // obscured behind the fixed bottom tab bar (~56px) + safe-area inset.
          // The CSS env() value accounts for devices with home indicators.
          style={
            isMobile
              ? {
                  paddingBottom:
                    "calc(3.5rem + env(safe-area-inset-bottom, 0px))",
                }
              : undefined
          }
          id="main-content"
        >
          {children}
        </main>
      </div>

      {/* Mobile bottom navigation — only rendered on mobile (<md) */}
      {mobileNav}
    </div>
  );
}
