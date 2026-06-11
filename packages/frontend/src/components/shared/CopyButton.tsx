/**
 * CopyButton — click-to-copy with a brief checkmark success animation.
 *
 * The success state resets after 2 seconds. The button uses aria-live to
 * announce the copy result to screen readers without causing visual disruption.
 */
import * as React from "react";
import { Check, Copy } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button.js";
import { cn } from "@/lib/utils.js";

const SUCCESS_DURATION_MS = 2000;

export interface CopyButtonProps extends Omit<ButtonProps, "onClick"> {
  /** The text value to copy to the clipboard. */
  value: string;
  /** Accessible label for the button. Defaults to "Copy". */
  label?: string;
}

export function CopyButton({
  value,
  label = "Copy",
  className,
  ...props
}: CopyButtonProps) {
  const [copied, setCopied] = React.useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      // Reset to copy icon after the success duration
      const timer = setTimeout(() => setCopied(false), SUCCESS_DURATION_MS);
      return () => clearTimeout(timer);
    } catch {
      // Clipboard API may be blocked in non-secure contexts; fail silently
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("relative", className)}
      onClick={() => void handleCopy()}
      aria-label={copied ? "Copied!" : label}
      {...props}
    >
      {/* Screen reader announcement — updated after copy */}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {copied ? "Copied to clipboard" : ""}
      </span>

      {copied ? (
        <Check className="h-4 w-4 text-[var(--color-status-success)]" aria-hidden="true" />
      ) : (
        <Copy className="h-4 w-4" aria-hidden="true" />
      )}
    </Button>
  );
}
