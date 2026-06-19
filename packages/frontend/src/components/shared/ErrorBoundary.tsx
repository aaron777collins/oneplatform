/**
 * ErrorBoundary — route-level React error boundary.
 *
 * Catches rendering errors thrown anywhere in the subtree and displays a
 * fallback UI with the error message and a "Try again" button. Errors are
 * logged to the console only — this is self-hosted software that does not
 * send telemetry to third-party services (§13.1).
 *
 * TanStack Router's per-route errorComponent handles loader failures. This
 * boundary handles errors that occur during rendering after a successful load.
 */
import * as React from "react";
import { Button } from "@/components/ui/button.js";

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

type ErrorCategory = "network" | "permission" | "not_found" | "server" | "unknown";

interface ClassifiedError {
  category: ErrorCategory;
  title: string;
  description: string;
  suggestion: string;
}

function classifyError(error: Error): ClassifiedError {
  const msg = error.message.toLowerCase();
  const name = error.name.toLowerCase();

  // Network errors (fetch failures, timeouts, CORS)
  if (
    name === "typeerror" && (msg.includes("fetch") || msg.includes("network")) ||
    msg.includes("network") ||
    msg.includes("timeout") ||
    msg.includes("cors") ||
    msg.includes("err_internet_disconnected") ||
    msg.includes("failed to fetch") ||
    msg.includes("load failed") ||
    msg.includes("networkerror")
  ) {
    return {
      category: "network",
      title: "Connection error",
      description: "Unable to reach the server. This may be due to a network issue or the server being temporarily unavailable.",
      suggestion: "Check your internet connection and try again. If the problem persists, the service may be down for maintenance.",
    };
  }

  // Permission / auth errors
  if (
    msg.includes("403") ||
    msg.includes("401") ||
    msg.includes("forbidden") ||
    msg.includes("unauthorized") ||
    msg.includes("permission") ||
    msg.includes("access denied")
  ) {
    return {
      category: "permission",
      title: "Access denied",
      description: "You do not have permission to view this resource or perform this action.",
      suggestion: "Make sure you are signed in with the correct account. Contact your administrator if you believe this is an error.",
    };
  }

  // Not found
  if (
    msg.includes("404") ||
    msg.includes("not found") ||
    msg.includes("does not exist")
  ) {
    return {
      category: "not_found",
      title: "Not found",
      description: "The requested resource could not be found. It may have been deleted or moved.",
      suggestion: "Double-check the URL or navigate back to find the correct page.",
    };
  }

  // Server errors (5xx)
  if (
    msg.includes("500") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("internal server") ||
    msg.includes("server error") ||
    msg.includes("bad gateway") ||
    msg.includes("service unavailable")
  ) {
    return {
      category: "server",
      title: "Server error",
      description: "The server encountered an unexpected error while processing your request.",
      suggestion: "This is usually temporary. Wait a moment and try again. If the issue persists, contact support.",
    };
  }

  // Fallback
  return {
    category: "unknown",
    title: "Something went wrong",
    description: error.message || "An unexpected error occurred while rendering this page.",
    suggestion: "Try refreshing the page. If the problem continues, contact support with the details below.",
  };
}

// ---------------------------------------------------------------------------
// ErrorBoundary component
// ---------------------------------------------------------------------------

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Custom fallback — rendered instead of the default error UI when provided. */
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Log to console for DevOps diagnostics — never to a third-party service
    console.error("[ErrorBoundary] Rendering error:", error, info);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
  };

  override render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    if (this.props.fallback !== undefined) {
      return this.props.fallback;
    }

    const classified = this.state.error !== null
      ? classifyError(this.state.error)
      : { category: "unknown" as ErrorCategory, title: "Something went wrong", description: "An unexpected error occurred.", suggestion: "Try refreshing the page." };

    return (
      <div
        role="alert"
        className="flex min-h-[400px] flex-col items-center justify-center gap-4 p-8 text-center"
      >
        <div className="space-y-2">
          <h2 className="text-xl font-semibold text-[var(--color-foreground)]">
            {classified.title}
          </h2>
          <p className="max-w-md text-sm text-[var(--color-muted-foreground)]">
            {classified.description}
          </p>
          <p className="max-w-md text-xs text-[var(--color-muted-foreground)] italic">
            {classified.suggestion}
          </p>
        </div>
        <div className="flex gap-2">
          {classified.category === "permission" ? (
            <Button
              onClick={() => { window.location.href = "/auth/login"; }}
              variant="default"
            >
              Sign in
            </Button>
          ) : classified.category === "not_found" ? (
            <Button
              onClick={() => { window.history.back(); }}
              variant="default"
            >
              Go back
            </Button>
          ) : (
            <Button onClick={this.handleRetry} variant="outline">
              Try again
            </Button>
          )}
          <Button
            onClick={() => window.location.reload()}
            variant={classified.category === "permission" || classified.category === "not_found" ? "outline" : "default"}
          >
            Reload page
          </Button>
        </div>
        {/* Show raw error for debugging in non-production */}
        {this.state.error !== null && classified.category === "unknown" && (
          <details className="mt-2 max-w-lg text-left">
            <summary className="cursor-pointer text-xs text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]">
              Technical details
            </summary>
            <pre className="mt-1 rounded bg-[var(--color-muted)] p-2 text-xs overflow-auto max-h-32">
              {this.state.error.message}
            </pre>
          </details>
        )}
      </div>
    );
  }
}
