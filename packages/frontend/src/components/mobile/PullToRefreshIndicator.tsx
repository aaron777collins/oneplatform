/**
 * PullToRefreshIndicator — visual feedback for the pull-to-refresh gesture.
 *
 * Renders a spinner/arrow that slides down from the top of the container as
 * the user drags. The indicator is purely presentational — behaviour is
 * owned by the usePullToRefresh hook.
 *
 * Accessibility: the spinner is aria-hidden because it is a decorative motion
 * element. The actual status announcement is done via an aria-live region so
 * screen reader users are notified when a refresh completes.
 */
import * as React from "react";
import { cn } from "@/lib/utils.js";

export interface PullToRefreshIndicatorProps {
  /** 0–1 pull progress. At 1 the indicator is fully visible and coloured. */
  pullProgress: number;
  /** Whether the pull gesture has crossed the threshold and will trigger. */
  willRefresh: boolean;
  /** Whether a refresh is currently in progress. */
  refreshing: boolean;
  className?: string;
}

export function PullToRefreshIndicator({
  pullProgress,
  willRefresh,
  refreshing,
  className,
}: PullToRefreshIndicatorProps) {
  const visible = pullProgress > 0 || refreshing;
  if (!visible) return null;

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 top-0 flex justify-center",
        className,
      )}
      aria-hidden="true"
    >
      <div
        className={cn(
          "flex h-10 w-10 items-center justify-center rounded-full shadow-md",
          "transition-colors duration-150",
          willRefresh || refreshing
            ? "bg-[var(--color-primary)]"
            : "bg-[var(--color-card)]",
        )}
        style={{
          // Translate the indicator down as the user drags; cap at 32px so it
          // stays near the top edge and doesn't obscure content.
          transform: `translateY(${Math.min(pullProgress * 32, 32)}px)`,
          opacity: Math.min(pullProgress * 2, 1),
        }}
      >
        {refreshing ? (
          // Spinning loader during active refresh
          <div
            className={cn(
              "h-5 w-5 rounded-full border-2 border-t-transparent animate-spin",
              willRefresh || refreshing ? "border-white" : "border-[var(--color-primary)]",
            )}
          />
        ) : (
          // Arrow rotates as pullProgress increases, points down before threshold
          // and up after to signal "release to refresh"
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke={willRefresh ? "white" : "currentColor"}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              transform: `rotate(${willRefresh ? 180 : 0}deg)`,
              transition: "transform 0.15s ease",
            }}
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <polyline points="19 12 12 19 5 12" />
          </svg>
        )}
      </div>
    </div>
  );
}
