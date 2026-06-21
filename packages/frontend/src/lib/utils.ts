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
 * Converts a 5-field cron expression to a plain-English description suitable
 * for display to non-technical users. Handles the common patterns produced by
 * ScheduleBuilder; falls back to "Custom schedule" for unusual expressions.
 *
 * WHY here instead of inside ScheduleBuilder: other components (PipelineCard,
 * PipelineDetailPage, ApiKeysPage) also need to display cron expressions in
 * human-readable form, so this belongs in the shared utility layer.
 */
export function cronToHuman(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return "Custom schedule";

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Every minute
  if (cron.trim() === "* * * * *") return "Every minute";
  // Every hour on the hour
  if (cron.trim() === "0 * * * *") return "Every hour";

  // Step patterns: */N minute/hour/day intervals
  if (
    minute?.startsWith("*/") &&
    hour === "*" &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    const n = parseInt(minute.slice(2), 10);
    if (!isNaN(n) && n > 0) return `Every ${n} minute${n === 1 ? "" : "s"}`;
  }

  if (
    minute === "0" &&
    hour?.startsWith("*/") &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    const n = parseInt(hour.slice(2), 10);
    if (!isNaN(n) && n > 0) return `Every ${n} hour${n === 1 ? "" : "s"}`;
  }

  if (
    minute === "0" &&
    hour === "0" &&
    dayOfMonth?.startsWith("*/") &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    const n = parseInt(dayOfMonth.slice(2), 10);
    if (!isNaN(n) && n > 0)
      return `Every ${n} day${n === 1 ? "" : "s"} at midnight`;
  }

  // Fixed time patterns
  if (dayOfMonth === "*" && month === "*" && minute !== "*" && hour !== "*") {
    const h = `${hour?.padStart(2, "0")}:${minute?.padStart(2, "0")}`;

    if (dayOfWeek === "*") {
      return `Daily at ${h}`;
    }

    const DAY_NAMES: Record<string, string> = {
      "0": "Sunday",
      "1": "Monday",
      "2": "Tuesday",
      "3": "Wednesday",
      "4": "Thursday",
      "5": "Friday",
      "6": "Saturday",
      "7": "Sunday",
    };
    if (dayOfWeek !== undefined && DAY_NAMES[dayOfWeek] !== undefined) {
      return `Every ${DAY_NAMES[dayOfWeek]} at ${h}`;
    }
  }

  // Monthly: specific day-of-month at a fixed time
  if (
    month === "*" &&
    dayOfWeek === "*" &&
    dayOfMonth !== undefined &&
    dayOfMonth !== "*" &&
    minute !== "*" &&
    hour !== "*"
  ) {
    const h = `${hour?.padStart(2, "0")}:${minute?.padStart(2, "0")}`;
    const n = parseInt(dayOfMonth, 10);
    if (!isNaN(n)) {
      const teenException = n >= 11 && n <= 13;
      const lastDigit = n % 10;
      const suffix = teenException
        ? "th"
        : lastDigit === 1
          ? "st"
          : lastDigit === 2
            ? "nd"
            : lastDigit === 3
              ? "rd"
              : "th";
      return `Monthly on the ${n}${suffix} at ${h}`;
    }
  }

  return "Custom schedule";
}

/**
 * Formats a byte count into a human-readable string (e.g., "1.2 MB").
 * Used in the file tree and build output panels.
 */
export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return "0 B";
  if (bytes < 0) return `-${formatBytes(-bytes, decimals)}`;

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
