/**
 * MobileNavigation — bottom tab bar for screens narrower than 768px.
 *
 * Renders only on mobile via an md:hidden wrapper. The five primary tabs map
 * to the most-used sections identified in user story analysis. A slide-out
 * "More" sheet exposes the remaining navigation items without cluttering the
 * tab bar.
 *
 * Tap target sizing: every interactive element meets the 44x44px minimum
 * recommended by WCAG 2.5.5 (§14.3) for touch accuracy.
 *
 * Role gating mirrors the desktop Sidebar: items with requiredRole are hidden
 * (not disabled) when the user lacks the role. The server re-enforces this.
 */
import * as React from "react";
import { Link, useMatchRoute } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Database,
  GitBranch,
  AppWindow,
  Settings,
  MoreHorizontal,
  X,
  Layers,
  FileText,
  ClipboardList,
  Inbox,
  BarChart2,
  Puzzle,
  Store,
} from "lucide-react";
import { cn } from "@/lib/utils.js";
import { useAuthStore } from "@/stores/auth.store.js";

// ---------------------------------------------------------------------------
// Navigation model
// ---------------------------------------------------------------------------

interface NavItem {
  label: string;
  to: string;
  icon: React.ComponentType<{ className?: string | undefined }>;
  requiredRole?: string;
}

/** Primary tabs — always visible in the bottom bar. */
const PRIMARY_TABS: NavItem[] = [
  { label: "Dashboard", to: "/dashboard", icon: LayoutDashboard },
  { label: "Connectors", to: "/connectors", icon: Database },
  { label: "Pipelines", to: "/pipelines", icon: GitBranch },
  { label: "Apps", to: "/apps", icon: AppWindow },
  { label: "Settings", to: "/settings", icon: Settings },
];

/** Secondary items — exposed via the "More" slide-out sheet. */
const SECONDARY_ITEMS: NavItem[] = [
  { label: "Ontology", to: "/ontology", icon: Layers },
  { label: "Marketplace", to: "/connectors/marketplace", icon: Store },
  { label: "Logs", to: "/logs", icon: FileText },
  { label: "Audit", to: "/logs/audit", icon: ClipboardList },
  { label: "DLQ", to: "/dlq", icon: Inbox, requiredRole: "data-engineer" },
  { label: "Metrics", to: "/metrics", icon: BarChart2, requiredRole: "data-engineer" },
  { label: "Plugins", to: "/plugins", icon: Puzzle },
];

// ---------------------------------------------------------------------------
// BottomTabButton — single tab in the bottom bar
// ---------------------------------------------------------------------------

interface BottomTabButtonProps {
  item: NavItem;
}

function BottomTabButton({ item }: BottomTabButtonProps) {
  const matchRoute = useMatchRoute();
  const isActive = Boolean(matchRoute({ to: item.to, fuzzy: true }));
  const Icon = item.icon;

  return (
    <Link
      to={item.to}
      className={cn(
        // 44px minimum tap target — enforced by explicit min-h and py to give
        // generous touch area even with small icons.
        "flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-xs font-medium",
        "min-h-[3rem] min-w-[3rem] transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-inset",
        isActive
          ? "text-[var(--color-primary)]"
          : "text-[var(--color-muted-foreground)]",
      )}
      aria-current={isActive ? "page" : undefined}
      aria-label={item.label}
    >
      <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// MoreSheetItem — single item inside the slide-out "More" panel
// ---------------------------------------------------------------------------

interface MoreSheetItemProps {
  item: NavItem;
  onClose: () => void;
}

function MoreSheetItem({ item, onClose }: MoreSheetItemProps) {
  const matchRoute = useMatchRoute();
  const isActive = Boolean(matchRoute({ to: item.to, fuzzy: true }));
  const Icon = item.icon;

  return (
    <Link
      to={item.to}
      onClick={onClose}
      className={cn(
        "flex items-center gap-4 rounded-md px-4 py-3 text-sm font-medium transition-colors",
        // 44px minimum tap target via explicit py-3 + icon height
        "min-h-[3rem]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]",
        isActive
          ? "bg-[var(--color-primary)] text-[var(--color-primary-foreground)]"
          : "text-[var(--color-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-foreground)]",
      )}
      aria-current={isActive ? "page" : undefined}
    >
      <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
      <span>{item.label}</span>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// MobileNavigation
// ---------------------------------------------------------------------------

export interface MobileNavigationProps {
  className?: string;
}

export function MobileNavigation({ className }: MobileNavigationProps) {
  const [moreOpen, setMoreOpen] = React.useState(false);
  const roles = useAuthStore((state) => state.roles);
  const isPlatformAdmin = roles.includes("platform-admin");

  const visibleSecondary = SECONDARY_ITEMS.filter((item) => {
    if (item.requiredRole === undefined) return true;
    return isPlatformAdmin || roles.includes(item.requiredRole);
  });

  function closeMore() {
    setMoreOpen(false);
  }

  return (
    <>
      {/* Bottom tab bar — only on screens < 768px */}
      <nav
        className={cn(
          "fixed inset-x-0 bottom-0 z-30 flex border-t border-[var(--color-border)] bg-[var(--color-background)] md:hidden",
          // Safe area inset ensures the bar does not overlap notches/home indicators
          // on iOS devices. env() is harmless on devices without safe areas.
          "pb-[env(safe-area-inset-bottom)]",
          className,
        )}
        aria-label="Mobile navigation"
      >
        {PRIMARY_TABS.map((item) => (
          <BottomTabButton key={item.to} item={item} />
        ))}

        {/* "More" button — opens the slide-out sheet for secondary items */}
        <button
          type="button"
          onClick={() => setMoreOpen((prev) => !prev)}
          className={cn(
            "flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-xs font-medium",
            "min-h-[3rem] min-w-[3rem] transition-colors",
            "text-[var(--color-muted-foreground)]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-inset",
            moreOpen && "text-[var(--color-primary)]",
          )}
          aria-label="More navigation items"
          aria-expanded={moreOpen}
          aria-controls="mobile-more-sheet"
        >
          {moreOpen ? (
            <X className="h-5 w-5 shrink-0" aria-hidden="true" />
          ) : (
            <MoreHorizontal className="h-5 w-5 shrink-0" aria-hidden="true" />
          )}
          <span>More</span>
        </button>
      </nav>

      {/* Slide-out "More" sheet */}
      {moreOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-20 bg-black/40 md:hidden"
            aria-hidden="true"
            onClick={closeMore}
          />

          {/* Sheet panel — slides up from the bottom tab bar */}
          <div
            id="mobile-more-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="More navigation options"
            className={cn(
              "fixed inset-x-0 bottom-0 z-30 rounded-t-xl border-t border-[var(--color-border)]",
              "bg-[var(--color-background)] shadow-xl md:hidden",
              // Account for the tab bar height (~56px) + safe-area inset
              "pb-[calc(3.5rem+env(safe-area-inset-bottom))]",
            )}
          >
            <div className="px-2 pt-3 pb-2 space-y-0.5" role="list">
              {visibleSecondary.map((item) => (
                <MoreSheetItem key={item.to} item={item} onClose={closeMore} />
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}
