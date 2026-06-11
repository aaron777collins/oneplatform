/**
 * TraceIdLink — clickable trace ID that copies to clipboard and optionally
 * links to an external trace viewer.
 *
 * Renders as inline text so it can be embedded in a log row without disrupting
 * layout. Clipboard copy uses CopyButton's feedback pattern.
 */
import * as React from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils.js";

const COPY_SUCCESS_DURATION_MS = 2000;

export interface TraceIdLinkProps {
  traceId: string;
  /** Optional URL to an external trace viewer (e.g., Jaeger or Zipkin) */
  traceViewerUrl?: string;
  className?: string;
}

export function TraceIdLink({ traceId, traceViewerUrl, className }: TraceIdLinkProps) {
  const [copied, setCopied] = React.useState(false);

  async function handleCopy(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(traceId);
      setCopied(true);
      setTimeout(() => setCopied(false), COPY_SUCCESS_DURATION_MS);
    } catch {
      // Clipboard may be blocked in non-secure contexts — fail silently
    }
  }

  const displayId = traceId.length > 16 ? `${traceId.slice(0, 8)}…${traceId.slice(-4)}` : traceId;

  const innerContent = (
    <span className="flex items-center gap-1">
      <span className="font-mono text-xs">{displayId}</span>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {copied ? "Trace ID copied" : ""}
      </span>
      {copied
        ? <Check className="h-3 w-3 text-[var(--color-status-success)]" aria-hidden="true" />
        : <Copy className="h-3 w-3 opacity-50" aria-hidden="true" />
      }
    </span>
  );

  if (traceViewerUrl !== undefined) {
    return (
      <a
        href={traceViewerUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          "inline-flex cursor-pointer items-center rounded px-1 py-0.5 text-[var(--color-primary)] transition-colors hover:underline",
          className,
        )}
        title={`Trace: ${traceId} — click to open in trace viewer`}
        onClick={handleCopy}
        aria-label={`View trace ${traceId} (also copies to clipboard)`}
      >
        {innerContent}
      </a>
    );
  }

  return (
    <button
      type="button"
      className={cn(
        "inline-flex cursor-pointer items-center rounded px-1 py-0.5 text-[var(--color-muted-foreground)] transition-colors hover:text-[var(--color-foreground)]",
        className,
      )}
      title={`Trace: ${traceId} — click to copy`}
      onClick={handleCopy}
      aria-label={copied ? "Trace ID copied" : `Copy trace ID ${traceId}`}
    >
      {innerContent}
    </button>
  );
}
