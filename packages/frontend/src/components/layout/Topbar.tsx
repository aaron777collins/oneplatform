/**
 * Topbar — tenant name, user avatar/menu dropdown, and notification bell.
 *
 * Notifications are in-memory only (lost on page refresh by design — see §10.4).
 * They are capped at 100 entries with oldest-first eviction.
 * Durable event history lives at /logs, not here.
 */
import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { Bell, Menu, X, User, KeyRound, LogOut } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/lib/utils.js";
import { useAuthStore } from "@/stores/auth.store.js";
import { useApiClient } from "@/lib/api-client.js";
import { queryClient } from "@/lib/query-client.js";
import { usePlatformEvents, type PlatformEvent } from "@/hooks/use-platform-events.js";

// ---------------------------------------------------------------------------
// Notification types
// ---------------------------------------------------------------------------

const NOTIFICATION_CAP = 100;

interface Notification {
  id: string;
  message: string;
  read: boolean;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Topbar component
// ---------------------------------------------------------------------------

export interface TopbarProps {
  className?: string;
  /** Called when the hamburger button is clicked on mobile screens. */
  onMobileMenuToggle?: () => void;
  /** Current open state of the mobile navigation drawer. */
  mobileMenuOpen?: boolean;
}

export function Topbar({ className, onMobileMenuToggle, mobileMenuOpen }: TopbarProps) {
  const navigate = useNavigate();
  const client = useApiClient();
  const userId = useAuthStore((state) => state.userId);
  const tenantId = useAuthStore((state) => state.tenantId);
  const clearSession = useAuthStore((state) => state.clearSession);

  // In-memory notification list — intentionally not persisted (§10.4)
  const [notifications, setNotifications] = React.useState<Notification[]>([]);

  const unreadCount = notifications.filter((n) => !n.read).length;

  // Subscribe to platform events to build the in-memory notification list
  usePlatformEvents(
    ["pipeline.run.failed", "build.completed", "dlq.item.added"],
    React.useCallback((event: PlatformEvent) => {
      const message = buildNotificationMessage(event.eventType, event.payload);
      if (message === null) return;

      setNotifications((prev) => {
        const next: Notification = {
          id: event.eventId,
          message,
          read: false,
          createdAt: Date.now(),
        };
        // Cap at NOTIFICATION_CAP; evict oldest first
        const updated = [next, ...prev];
        return updated.length > NOTIFICATION_CAP
          ? updated.slice(0, NOTIFICATION_CAP)
          : updated;
      });
    }, []),
  );

  function markAllRead() {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }

  async function handleLogout() {
    try {
      await client.post("/v1/auth/logout");
    } catch {
      // Proceed with local cleanup even if the server call fails
    }
    clearSession();
    queryClient.clear();
    window.location.href = "/login";
  }

  // Display a short identifier for the user — userId is the only non-sensitive
  // value available in the auth store without making a separate profile fetch.
  const displayName = userId ? userId.slice(0, 8) : "User";

  return (
    <header
      className={cn(
        "flex h-14 shrink-0 items-center gap-4 border-b border-[var(--color-border)] bg-[var(--color-background)] px-4",
        className,
      )}
    >
      {/* Hamburger — visible only on mobile (<md). Toggles the mobile nav drawer. */}
      {onMobileMenuToggle !== undefined && (
        <Button
          variant="ghost"
          size="icon"
          className="mr-1 md:hidden"
          onClick={onMobileMenuToggle}
          aria-label={mobileMenuOpen === true ? "Close navigation menu" : "Open navigation menu"}
          aria-expanded={mobileMenuOpen === true}
          aria-controls="mobile-nav-drawer"
        >
          {mobileMenuOpen === true ? (
            <X className="h-5 w-5" aria-hidden="true" />
          ) : (
            <Menu className="h-5 w-5" aria-hidden="true" />
          )}
        </Button>
      )}

      {/* Tenant name */}
      <div className="flex-1 truncate">
        {tenantId !== null && (
          <span className="text-sm text-[var(--color-muted-foreground)]">
            Tenant:{" "}
            <span className="font-medium text-[var(--color-foreground)]">
              {tenantId}
            </span>
          </span>
        )}
      </div>

      {/* Notification bell */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="relative"
            aria-label={
              unreadCount > 0
                ? `${unreadCount} unread notifications`
                : "Notifications"
            }
          >
            <Bell className="h-4 w-4" aria-hidden="true" />
            {unreadCount > 0 && (
              <Badge
                variant="destructive"
                className="absolute -right-1 -top-1 h-5 min-w-[1.25rem] rounded-full px-1 text-[10px]"
                aria-hidden="true"
              >
                {unreadCount > 99 ? "99+" : unreadCount}
              </Badge>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          <DropdownMenuLabel className="flex items-center justify-between">
            <span>Notifications</span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="text-xs text-[var(--color-primary)] hover:underline focus:outline-none"
              >
                Mark all read
              </button>
            )}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {notifications.length === 0 ? (
            <div className="px-2 py-4 text-center text-sm text-[var(--color-muted-foreground)]">
              No notifications
            </div>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              {notifications.slice(0, 20).map((n) => (
                <div
                  key={n.id}
                  className={cn(
                    "px-2 py-2 text-sm",
                    !n.read && "font-medium",
                  )}
                >
                  {n.message}
                </div>
              ))}
            </div>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* User menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="User menu"
            className="rounded-full"
          >
            <User className="h-4 w-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col space-y-1">
              <p className="text-sm font-medium">{displayName}</p>
              {tenantId !== null && (
                <p className="text-xs text-[var(--color-muted-foreground)]">
                  {tenantId}
                </p>
              )}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => void navigate({ to: "/settings/profile" })}
          >
            <User className="mr-2 h-4 w-4" aria-hidden="true" />
            Profile
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => void navigate({ to: "/settings/api-keys" })}
          >
            <KeyRound className="mr-2 h-4 w-4" aria-hidden="true" />
            API Keys
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => void handleLogout()}
            className="text-[var(--color-destructive)] focus:text-[var(--color-destructive)]"
          >
            <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />
            Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Notification message builder
// Maps platform event types to human-readable messages
// ---------------------------------------------------------------------------

interface PlatformEventPayload {
  [key: string]: unknown;
}

function buildNotificationMessage(
  eventType: string,
  payload: PlatformEventPayload,
): string | null {
  if (eventType === "pipeline.run.failed") {
    const name = typeof payload["pipelineName"] === "string" ? payload["pipelineName"] : "A pipeline";
    return `${name} run failed`;
  }
  if (eventType === "build.completed") {
    const appName = typeof payload["appName"] === "string" ? payload["appName"] : "App";
    const status = typeof payload["status"] === "string" ? payload["status"] : "completed";
    return `${appName} build ${status}`;
  }
  if (eventType === "dlq.item.added") {
    return "A new item was added to the dead letter queue";
  }
  return null;
}
