/**
 * NotFoundPage — 404 page with "Go Home" button.
 *
 * Route: * (catch-all)
 */
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { Home, Compass } from "lucide-react";
import { Button } from "@/components/ui/button.js";

export function NotFoundPage() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 text-center"
    >
      {/* Icon */}
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-[var(--color-muted)]">
        <Compass className="h-10 w-10 text-[var(--color-muted-foreground)]" aria-hidden="true" />
      </div>

      {/* Status */}
      <div className="space-y-2">
        <p className="text-6xl font-bold tabular-nums text-[var(--color-foreground)]">404</p>
        <h1 className="text-xl font-semibold">Page not found</h1>
        <p className="max-w-sm text-sm text-[var(--color-muted-foreground)]">
          The page you were looking for doesn't exist or has been moved.
        </p>
      </div>

      {/* Action */}
      <Button asChild>
        <Link to="/">
          <Home className="mr-2 h-4 w-4" aria-hidden="true" />
          Go home
        </Link>
      </Button>
    </main>
  );
}
