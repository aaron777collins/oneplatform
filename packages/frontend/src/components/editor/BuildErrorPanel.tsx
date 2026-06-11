/**
 * BuildErrorPanel — inline panel showing esbuild errors after a failed build.
 *
 * Each error is a clickable link that tells the caller to jump to that
 * file + line in the editor. The panel renders nothing when there are no errors.
 */
import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildError {
  file: string;
  line: number;
  column: number;
  message: string;
}

export interface BuildErrorPanelProps {
  errors: BuildError[];
  /** Called when the user clicks an error to navigate to the offending line */
  onJumpToError?: (error: BuildError) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// BuildErrorPanel component
// ---------------------------------------------------------------------------

export function BuildErrorPanel({ errors, onJumpToError, className }: BuildErrorPanelProps) {
  if (errors.length === 0) return null;

  return (
    <div
      className={cn(
        "border-t border-[var(--color-border)] bg-red-50 dark:bg-red-950/20",
        className,
      )}
      role="region"
      aria-label="Build errors"
    >
      <div className="flex items-center gap-2 border-b border-red-200 px-3 py-2 dark:border-red-900/40">
        <AlertTriangle className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" aria-hidden="true" />
        <span className="text-sm font-semibold text-red-800 dark:text-red-300">
          {errors.length} build {errors.length === 1 ? "error" : "errors"}
        </span>
      </div>

      <ul className="divide-y divide-red-200 dark:divide-red-900/30">
        {errors.map((error, index) => (
          <li key={index}>
            <button
              type="button"
              className={cn(
                "w-full px-3 py-2 text-left text-xs transition-colors",
                "hover:bg-red-100 dark:hover:bg-red-900/30",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-500",
                onJumpToError !== undefined ? "cursor-pointer" : "cursor-default",
              )}
              onClick={() => onJumpToError?.(error)}
              aria-label={`Go to error at ${error.file}:${error.line}:${error.column}`}
            >
              <span className="font-medium text-red-800 dark:text-red-300">
                {error.message}
              </span>
              <span className="ml-2 font-mono text-red-600/80 dark:text-red-400/80">
                {error.file}:{error.line}:{error.column}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
