/**
 * BootstrapErrorPage — shown when the index route loader fails to reach the API.
 *
 * This is the first page users see when OnePlatform cannot connect. A white
 * screen or cryptic JS error here is extremely damaging to first impressions
 * and leaves operators without any recovery path.
 *
 * Design goals:
 * - Explain what went wrong in plain language (not "network error")
 * - Give actionable troubleshooting steps relevant to the deployment context
 * - Provide a retry button so operators don't have to manually refresh
 */
import React from "react";
import { useRouter } from "@tanstack/react-router";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";

export function BootstrapErrorPage() {
  const router = useRouter();
  const [isRetrying, setIsRetrying] = React.useState(false);

  async function handleRetry() {
    setIsRetrying(true);
    try {
      await router.invalidate();
    } finally {
      setIsRetrying(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-6 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-destructive)]/10">
        <AlertCircle
          className="h-8 w-8 text-[var(--color-destructive)]"
          aria-hidden="true"
        />
      </div>

      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Could not connect to OnePlatform
        </h1>
        <p className="max-w-md text-sm text-[var(--color-muted-foreground)]">
          The setup page could not reach the OnePlatform API. This usually means
          the server is not running or the network is unreachable.
        </p>
      </div>

      <Button
        onClick={() => void handleRetry()}
        disabled={isRetrying}
        className="gap-2"
        aria-busy={isRetrying}
      >
        <RefreshCw
          className={`h-4 w-4 ${isRetrying ? "animate-spin" : ""}`}
          aria-hidden="true"
        />
        {isRetrying ? "Retrying…" : "Retry connection"}
      </Button>

      <div className="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-muted)]/40 p-4 text-left">
        <p className="mb-3 text-sm font-medium">Troubleshooting steps</p>
        <ol className="space-y-2 text-sm text-[var(--color-muted-foreground)]">
          <li className="flex gap-2">
            <span className="shrink-0 font-mono text-xs font-semibold text-[var(--color-foreground)]">1.</span>
            <span>
              <strong className="text-[var(--color-foreground)]">Is Docker running?</strong>{" "}
              Run <code className="rounded bg-[var(--color-muted)] px-1 py-0.5 text-xs">docker compose ps</code>{" "}
              and check that all services are Up.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="shrink-0 font-mono text-xs font-semibold text-[var(--color-foreground)]">2.</span>
            <span>
              <strong className="text-[var(--color-foreground)]">Check the gateway port.</strong>{" "}
              The API gateway should be reachable at port 3000 by default.
              Try <code className="rounded bg-[var(--color-muted)] px-1 py-0.5 text-xs">curl http://localhost:3000/healthz</code>.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="shrink-0 font-mono text-xs font-semibold text-[var(--color-foreground)]">3.</span>
            <span>
              <strong className="text-[var(--color-foreground)]">Check service logs.</strong>{" "}
              Run <code className="rounded bg-[var(--color-muted)] px-1 py-0.5 text-xs">docker compose logs gateway auth</code>{" "}
              to look for startup errors.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="shrink-0 font-mono text-xs font-semibold text-[var(--color-foreground)]">4.</span>
            <span>
              <strong className="text-[var(--color-foreground)]">Check your .env file.</strong>{" "}
              Ensure the API gateway is running on port 3000
              and database connection strings are set correctly.
            </span>
          </li>
        </ol>
      </div>
    </div>
  );
}
