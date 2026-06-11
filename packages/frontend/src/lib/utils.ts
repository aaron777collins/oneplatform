import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merges Tailwind CSS class names, resolving conflicts in favor of the
 * last class. This is the standard shadcn/ui utility for component variants.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Formats a date/timestamp into a human-readable string.
 * Uses the user's locale by default.
 */
export function formatDate(
  value: string | number | Date,
  options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  },
): string {
  return new Intl.DateTimeFormat(undefined, options).format(new Date(value));
}

/**
 * Truncates a string to the given maximum length, appending an ellipsis when
 * the string is shortened. Safe to call with values shorter than maxLength.
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return `${str.slice(0, maxLength - 1)}…`;
}

/**
 * Returns a debounced version of the given function. The returned function
 * delays invoking fn until after `delayMs` milliseconds have elapsed since
 * the last invocation. Useful for auto-save in the Monaco editor (§11.4).
 *
 * Note: The cancel() method clears any pending invocation.
 */
export function debounce<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  delayMs: number,
): ((...args: TArgs) => void) & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const debounced = (...args: TArgs): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      fn(...args);
      timer = undefined;
    }, delayMs);
  };

  debounced.cancel = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return debounced;
}

/**
 * Formats a byte count into a human-readable string (e.g., "1.2 MB").
 * Used in the file tree and build output panels.
 */
export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return "0 B";

  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const size = sizes[i];

  if (size === undefined) {
    // Extremely large value — fall back to raw bytes
    return `${bytes} B`;
  }

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${size}`;
}
