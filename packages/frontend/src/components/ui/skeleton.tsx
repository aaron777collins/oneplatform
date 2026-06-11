/**
 * Skeleton — loading placeholder with pulse animation.
 * Shape should match the content it replaces to prevent layout shift.
 * Respects prefers-reduced-motion (animation disabled via globals.css).
 */
import { cn } from "@/lib/utils.js";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md bg-[var(--color-muted)]",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
