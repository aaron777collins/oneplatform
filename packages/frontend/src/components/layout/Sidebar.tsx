/**
 * Sidebar — primary navigation with role-gated links.
 *
 * Collapsible state is persisted to localStorage so the user's preference
 * survives page reloads. The collapsed state is read synchronously on first
 * render to prevent a flash of the expanded sidebar.
 *
 * Role gating: the sidebar reads the auth store directly to determine which
 * items are visible. Items with requiredRole are hidden (not disabled) when
 * the user lacks that role — defense-in-depth supplementing server enforcement.
 *
 * Note on Rules of Hooks: usePermission is called once at the top of the
 * Sidebar with the full set of conditional roles, then the results are
 * threaded down to items. We cannot call hooks inside map() callbacks.
 */
import * as React from "react";
import { Link, useMatchRoute } from "@tanstack/react-router";
import {
  Database,
  GitBranch,
  LayoutDashboard,
  Layers,
  AppWindow,
  FileText,
  ClipboardList,
  Inbox,
  BarChart2,
  Puzzle,
  Settings,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils.js";
import { useAuthStore } from "@/stores/auth.store.js";

// ---------------------------------------------------------------------------
// Navigation data
// ---------------------------------------------------------------------------

interface NavItem {
  label: string;
  to: string;
  // Using `string | undefined` for className because lucide-react defines it as
  // `string | undefined` in LucideProps, and exactOptionalPropertyTypes requires
  // the target type to permit undefined when the source may provide it.
  icon: React.ComponentType<{ className?: string | undefined }>;
  /** If set, the item is only shown when the user has this role. */
  requiredRole?: string;
  /**
   * Optional tooltip description. Shown as a native `title` on the link so
   * users (especially those unfamiliar with the terminology) can hover to learn
   * what the section does before clicking.
   */
  description?: string;
}

interface NavGroup {
  heading: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    heading: "Platform",
    items: [
      { label: "Overview", to: "/", icon: LayoutDashboard },
      { label: "Connectors", to: "/connectors", icon: Database },
      {
        label: "Ontology",
        to: "/ontology",
        icon: Layers,
        description: "Define your data models and schemas. Create entity types that describe the shape of your data (like Customer, Order, or Product) and the relationships between them.",
      },
      { label: "Pipelines", to: "/pipelines", icon: GitBranch },
      { label: "Apps", to: "/apps", icon: AppWindow },
    ],
  },
  {
    heading: "Observe",
    items: [
      { label: "Logs", to: "/logs", icon: FileText },
      { label: "Audit", to: "/logs/audit", icon: ClipboardList },
      // DLQ and Metrics are hidden for viewer-role users (§10.2)
      { label: "DLQ", to: "/dlq", icon: Inbox, requiredRole: "data-engineer" },
      { label: "Metrics", to: "/metrics", icon: BarChart2, requiredRole: "data-engineer" },
    ],
  },
  {
    heading: "Extend",
    items: [{ label: "Plugins", to: "/plugins", icon: Puzzle }],
  },
  {
    heading: "Account",
    items: [{ label: "Settings", to: "/settings", icon: Settings }],
  },
];

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = "op-sidebar-collapsed";

function readCollapsedPreference(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    // localStorage unavailable in some test environments
    return false;
  }
}

function writeCollapsedPreference(collapsed: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(collapsed));
  } catch {
    // silently ignore
  }
}

// ---------------------------------------------------------------------------
// NavLinkItem — renders a single navigation link
// ---------------------------------------------------------------------------

interface NavLinkItemProps {
  item: NavItem;
  collapsed: boolean;
}

function NavLinkItem({ item, collapsed }: NavLinkItemProps) {
  const matchRoute = useMatchRoute();
  // Exact match only for "/" so Overview doesn't light up on every page
  const isActive = Boolean(
    matchRoute({
      to: item.to,
      ...(item.to === "/" ? { fuzzy: false } : { fuzzy: true }),
    }),
  );
  const Icon = item.icon;

  return (
    <li>
      <Link
        to={item.to}
        className={cn(
          "group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
          "hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-foreground)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]",
          isActive
            ? "bg-[var(--color-primary)] text-[var(--color-primary-foreground)]"
            : "text-[var(--color-foreground)]",
          collapsed && "justify-center px-2",
        )}
        aria-current={isActive ? "page" : undefined}
        // Show the label as tooltip when collapsed; show the description when expanded.
        // This gives both new and experienced users context without cluttering the UI.
        title={collapsed ? item.label : item.description}
      >
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        {!collapsed && <span>{item.label}</span>}
      </Link>
    </li>
  );
}

// ---------------------------------------------------------------------------
// NavGroupSection — renders a group heading + filtered items
// ---------------------------------------------------------------------------

interface NavGroupSectionProps {
  group: NavGroup;
  collapsed: boolean;
  /** Set of roles the current user holds. platform-admin supersedes all. */
  userRoles: string[];
}

function NavGroupSection({ group, collapsed, userRoles }: NavGroupSectionProps) {
  const isPlatformAdmin = userRoles.includes("platform-admin");

  const visibleItems = group.items.filter((item) => {
    if (item.requiredRole === undefined) return true;
    return isPlatformAdmin || userRoles.includes(item.requiredRole);
  });

  if (visibleItems.length === 0) return null;

  return (
    <div className="mb-4">
      {!collapsed && (
        <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-muted-foreground)]">
          {group.heading}
        </p>
      )}
      <ul role="list" className="space-y-0.5">
        {visibleItems.map((item) => (
          <NavLinkItem key={item.to} item={item} collapsed={collapsed} />
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export interface SidebarProps {
  className?: string;
}

export function Sidebar({ className }: SidebarProps) {
  const [collapsed, setCollapsed] = React.useState<boolean>(readCollapsedPreference);
  // Read roles once at the top — no conditional hook calls in child loops
  const roles = useAuthStore((state) => state.roles);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      writeCollapsedPreference(next);
      return next;
    });
  }

  return (
    <aside
      className={cn(
        "flex h-full flex-col border-r border-[var(--color-border)] bg-[var(--color-card)] transition-[width] duration-200 motion-reduce:transition-none",
        collapsed ? "w-16" : "w-60",
        className,
      )}
    >
      {/* Logo / brand area */}
      <div
        className={cn(
          "flex h-14 shrink-0 items-center border-b border-[var(--color-border)] px-4",
          collapsed && "justify-center px-2",
        )}
      >
        {!collapsed && (
          <span className="text-sm font-semibold text-[var(--color-foreground)]">
            OnePlatform
          </span>
        )}
      </div>

      {/* Navigation */}
      <nav
        className="flex-1 overflow-y-auto p-2"
        aria-label="Primary navigation"
      >
        {NAV_GROUPS.map((group) => (
          <NavGroupSection
            key={group.heading}
            group={group}
            collapsed={collapsed}
            userRoles={roles}
          />
        ))}
      </nav>

      {/* Collapse toggle */}
      <div className="shrink-0 border-t border-[var(--color-border)] p-2">
        <button
          type="button"
          onClick={toggleCollapsed}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-[var(--color-muted-foreground)] transition-colors",
            "hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-foreground)]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]",
            collapsed && "justify-center px-2",
          )}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />
          ) : (
            <>
              <ChevronLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Collapse</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
