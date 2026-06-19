/**
 * SettingsPage — settings layout with sidebar navigation.
 *
 * Route: /settings (index redirects to /settings/profile)
 *
 * Acts as a layout shell. Sub-pages render into <Outlet /> so the sidebar
 * and heading persist across sub-route transitions without remounting.
 */
import * as React from "react";
import { Link, Outlet, useMatchRoute } from "@tanstack/react-router";
import { User, Users, Key, Webhook, HardDrive, Shield } from "lucide-react";
import { usePermission } from "@/hooks/use-auth.js";
import { cn } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Navigation items
// ---------------------------------------------------------------------------

// Cast Lucide icons to avoid exactOptionalPropertyTypes conflict on className
type IconComponent = React.ComponentType<{ className?: string }>;

interface NavItem {
  label: string;
  to: string;
  icon: IconComponent;
  adminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { label: "Profile", to: "/settings/profile", icon: User as IconComponent },
  { label: "Teams", to: "/settings/teams", icon: Users as IconComponent },
  { label: "API Keys", to: "/settings/api-keys", icon: Key as IconComponent },
  { label: "Webhooks", to: "/settings/webhooks", icon: Webhook as IconComponent },
  { label: "Storage", to: "/settings/storage", icon: HardDrive as IconComponent },
  { label: "Admin", to: "/settings/admin", icon: Shield as IconComponent, adminOnly: true },
];

// ---------------------------------------------------------------------------
// SettingsPage component
// ---------------------------------------------------------------------------

export function SettingsPage() {
  const isAdmin = usePermission("tenant-admin");
  const matchRoute = useMatchRoute();

  const visibleItems = NAV_ITEMS.filter((item) => {
    if (item.adminOnly === true && !isAdmin) return false;
    return true;
  });

  return (
    <div className="flex-1 p-6">
      <h1 className="mb-6 text-2xl font-semibold">Settings</h1>

      <div className="flex flex-col md:flex-row gap-8">
        {/* Sidebar nav — horizontal scroll on mobile, vertical sidebar on md+ */}
        <nav aria-label="Settings navigation" className="shrink-0 md:w-48">
          <ul className="flex gap-1 overflow-x-auto pb-2 md:flex-col md:space-y-1 md:overflow-x-visible md:pb-0">
            {visibleItems.map((item) => {
              const Icon = item.icon;
              const isActive = matchRoute({ to: item.to }) !== false;
              return (
                <li key={item.to} className="shrink-0">
                  <Link
                    to={item.to}
                    className={cn(
                      "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
                      isActive
                        ? "bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                        : "text-[var(--color-foreground)] hover:bg-[var(--color-muted)]",
                    )}
                    aria-current={isActive ? "page" : undefined}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Content area — active sub-route renders here without remounting the shell */}
        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
