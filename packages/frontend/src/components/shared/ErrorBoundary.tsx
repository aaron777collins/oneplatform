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

    return (
      <div
        role="alert"
        className="flex min-h-[400px] flex-col items-center justify-center gap-4 p-8 text-center"
      >
        <div className="space-y-2">
          <h2 className="text-xl font-semibold text-[var(--color-foreground)]">
            Something went wrong
          </h2>
          {this.state.error !== null && (
            <p className="max-w-md text-sm text-[var(--color-muted-foreground)]">
              {this.state.error.message}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button onClick={this.handleRetry} variant="outline">
            Try again
          </Button>
          <Button
            onClick={() => window.location.reload()}
            variant="default"
          >
            Reload page
          </Button>
        </div>
      </div>
    );
  }
}
