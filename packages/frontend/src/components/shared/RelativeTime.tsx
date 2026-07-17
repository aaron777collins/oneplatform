/**
 * RelativeTime — displays a human-readable relative timestamp ("3 minutes ago")
 * with a Tooltip showing the exact absolute datetime.
 *
 * Updates automatically every 30 seconds so the displayed relative time stays
 * fresh without requiring a full page refresh.
 *
 * date-fns formatDistanceToNow is used because it handles edge cases like
 * sub-second differences ("less than a minute ago") correctly and is already
 * a monorepo dependency.
 */
import * as React from "react";
import { formatDistanceToNow } from "date-fns";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { formatDate } from "@/lib/utils.js";

const REFRESH_INTERVAL_MS = 30_000;

export interface RelativeTimeProps {
  /** ISO 8601 date string or Unix timestamp (ms). */
  value: string | number | Date;
  className?: string;
}

export function RelativeTime({ value, className }: RelativeTimeProps) {
  const date = React.useMemo(() => new Date(value), [value]);

  const [relativeText, setRelativeText] = React.useState<string>(() =>
    formatRelative(date),
  );

  // Refresh the relative display every 30 seconds
  React.useEffect(() => {
    setRelativeText(formatRelative(date));

    const interval = setInterval(() => {
      setRelativeText(formatRelative(date));
    }, REFRESH_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [date]);

  const isValid = !Number.isNaN(date.getTime());
  const absoluteText = isValid ? formatDate(date) : "Unknown";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          // date.toISOString() throws a RangeError on an invalid date, so only
          // set dateTime when the value parsed to a real date.
          {...(isValid ? { dateTime: date.toISOString() } : {})}
          className={className}
          style={{ cursor: "default" }}
        >
          {relativeText}
        </time>
      </TooltipTrigger>
      <TooltipContent>
        <p>{absoluteText}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function formatRelative(date: Date): string {
  try {
    return formatDistanceToNow(date, { addSuffix: true });
  } catch {
    // formatDistanceToNow throws on invalid dates
    return "Unknown";
  }
}
