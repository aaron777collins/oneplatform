/**
 * PreviewPane — iframe pointing to the app's preview URL.
 *
 * Supports two sandbox modes per design §11.7 / W-06:
 *   Mode A: OP_WILDCARD_DOMAIN configured → cross-origin preview, allow-same-origin safe.
 *   Mode B: no wildcard domain → same-origin preview, allow-same-origin removed for isolation.
 *
 * The preview auto-reloads when a build completes via the reload-stream SSE.
 * Panel width is resizable; the iframe fills the available height.
 */
import * as React from "react";
import { RefreshCw, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/lib/api-client.js";
import { cn } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PublicConfig {
  wildcardDomain?: string;
}

export interface PreviewPaneProps {
  appSlug: string;
  className?: string;
}

// ---------------------------------------------------------------------------
// PreviewPane component
// ---------------------------------------------------------------------------

export function PreviewPane({ appSlug, className }: PreviewPaneProps) {
  const client = useApiClient();
  const iframeRef = React.useRef<HTMLIFrameElement>(null);

  // Determine preview mode from platform config (§11.7)
  const configQuery = useQuery({
    queryKey: ["config", "public"],
    queryFn: ({ signal }) =>
      client.get<{ data: PublicConfig }>("/v1/config/public", undefined, { signal }),
    staleTime: 5 * 60 * 1000, // Config doesn't change often
  });

  const wildcardDomain = configQuery.data?.data.wildcardDomain;
  const isModeA = wildcardDomain !== undefined && wildcardDomain.length > 0;

  // Mode A: preview served from distinct origin → safe to use allow-same-origin
  // Mode B: same origin → omit allow-same-origin to prevent dashboard cookie access
  const previewUrl = isModeA
    ? `https://preview-${appSlug}.apps.${wildcardDomain}/preview`
    : `/apps/${appSlug}/preview`;

  const sandboxValue = isModeA
    ? "allow-scripts allow-same-origin allow-forms"
    : "allow-scripts allow-forms";

  // Subscribe to reload-stream SSE to auto-reload iframe on build completion
  React.useEffect(() => {
    // Only subscribe to reload stream when using same-origin mode;
    // in wildcard mode the preview origin manages its own reload
    if (isModeA) return;

    const es = new EventSource(`/apps/${appSlug}/preview/reload-stream`, {
      withCredentials: true,
    });

    es.addEventListener("reload", () => {
      if (iframeRef.current !== null) {
        // Setting src to itself forces a reload
        iframeRef.current.src = iframeRef.current.src;
      }
    });

    // Handle connection errors to avoid silent infinite reconnect storms.
    // Close the EventSource after repeated failures rather than letting the
    // browser hammer the server at its default 3-second reconnect interval.
    let errorCount = 0;
    const MAX_ERRORS = 5;
    es.onerror = () => {
      errorCount++;
      if (errorCount >= MAX_ERRORS) {
        es.close();
      }
    };
    // Reset error count on successful connection
    es.onopen = () => {
      errorCount = 0;
    };

    return () => es.close();
  }, [appSlug, isModeA]);

  function handleManualRefresh() {
    if (iframeRef.current !== null) {
      iframeRef.current.src = iframeRef.current.src;
    }
  }

  return (
    <div className={cn("flex flex-col border-l border-[var(--color-border)]", className)}>
      {/* Preview toolbar */}
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">
          Preview
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={handleManualRefresh}
            aria-label="Refresh preview"
            title="Refresh preview"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => window.open(previewUrl, "_blank")}
            aria-label="Open preview in new tab"
            title="Open in new tab"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {/* Preview iframe */}
      <div className="flex-1 overflow-hidden">
        {configQuery.isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--color-muted-foreground)]">
            Loading preview…
          </div>
        ) : (
          <iframe
            ref={iframeRef}
            src={previewUrl}
            sandbox={sandboxValue}
            className="h-full w-full border-0"
            title={`Preview of ${appSlug}`}
            // Prevent the hosted app from navigating the top-level context
            referrerPolicy="strict-origin"
          />
        )}
      </div>
    </div>
  );
}
