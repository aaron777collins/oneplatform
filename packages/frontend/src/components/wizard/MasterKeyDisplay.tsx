/**
 * MasterKeyDisplay — shows the bootstrap master key with security controls.
 *
 * Security design (§9.3):
 * - Key is held in local state only — never in the wizard Zustand store.
 * - 60-second countdown clears the key from the DOM on expiry.
 * - Show/Hide toggle prevents shoulder-surfing in open offices.
 * - Copy button uses the CopyButton shared component.
 * - Acknowledgment checkbox is required before the parent can proceed.
 *
 * The caller is responsible for fetching the key from
 * GET /api/v1/auth/bootstrap/master-key and passing it as the `masterKey`
 * prop. This separation keeps the component testable without mocking the API.
 */
import * as React from "react";
import { Eye, EyeOff, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { CopyButton } from "@/components/shared/CopyButton.js";
import { cn } from "@/lib/utils.js";

const COUNTDOWN_SECONDS = 60;
// Announce remaining time at these thresholds to avoid over-notifying
// screen reader users on every tick (§9.5).
const ANNOUNCE_AT_SECONDS = new Set([30, 10]);

export interface MasterKeyDisplayProps {
  /** The raw master key returned by GET /api/v1/auth/bootstrap/master-key. */
  masterKey: string;
  /** Whether the user has acknowledged saving the key. */
  acknowledged: boolean;
  /** Called when the user toggles the acknowledgment checkbox. */
  onAcknowledgedChange: (value: boolean) => void;
}

export function MasterKeyDisplay({
  masterKey,
  acknowledged,
  onAcknowledgedChange,
}: MasterKeyDisplayProps) {
  const [isVisible, setIsVisible] = React.useState(false);
  const [secondsLeft, setSecondsLeft] = React.useState(COUNTDOWN_SECONDS);
  // Once expired the key is removed from the DOM — set to null, not the original value.
  const [liveKey, setLiveKey] = React.useState<string | null>(masterKey);
  // Announcement text for aria-live — only updated at specific thresholds.
  const [announcement, setAnnouncement] = React.useState("");

  React.useEffect(() => {
    if (secondsLeft <= 0) {
      setLiveKey(null);
      setIsVisible(false);
      return;
    }

    const timer = setTimeout(() => {
      const next = secondsLeft - 1;
      setSecondsLeft(next);
      // Only announce at specific seconds to avoid flooding screen readers
      if (ANNOUNCE_AT_SECONDS.has(next)) {
        setAnnouncement(`${next} seconds remaining to copy the master key.`);
      }
    }, 1000);

    return () => clearTimeout(timer);
  }, [secondsLeft]);

  const isExpired = liveKey === null;

  return (
    <div className="space-y-4">
      {/* Key display area */}
      {isExpired ? (
        <div
          className="flex items-start gap-3 rounded-md border border-[var(--color-destructive)]/40 bg-[var(--color-destructive)]/5 px-4 py-3"
          role="alert"
        >
          <AlertTriangle
            className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-destructive)]"
            aria-hidden="true"
          />
          <p className="text-sm text-[var(--color-destructive)]">
            Key display expired for security. Continue only if you have saved
            the key.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            {/* Monospace field — aria-label because the content itself is the value */}
            <div
              role="textbox"
              aria-label="Master encryption key"
              aria-readonly="true"
              className={cn(
                "flex-1 overflow-x-auto rounded-md border border-[var(--color-input)] bg-[var(--color-muted)] px-3 py-2 font-mono text-sm tracking-widest",
                !isVisible && "text-[var(--color-muted)]",
              )}
            >
              {isVisible ? liveKey : "•".repeat(Math.min(liveKey.length, 48))}
            </div>

            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setIsVisible((v) => !v)}
              aria-label={isVisible ? "Hide master key" : "Show master key"}
            >
              {isVisible ? (
                <EyeOff className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Eye className="h-4 w-4" aria-hidden="true" />
              )}
            </Button>

            <CopyButton value={liveKey} label="Copy master key" />
          </div>

          {/* Countdown timer — polite so screen readers announce at thresholds */}
          <div className="flex items-center justify-between">
            <p
              className={cn(
                "text-xs tabular-nums",
                secondsLeft <= 10
                  ? "text-[var(--color-destructive)]"
                  : "text-[var(--color-muted-foreground)]",
              )}
            >
              Key will be hidden in{" "}
              <span aria-live="off">{secondsLeft}</span>s
            </p>
            {/* Hidden live region — announced only at threshold seconds */}
            <span className="sr-only" aria-live="polite" aria-atomic="true">
              {announcement}
            </span>
          </div>
        </div>
      )}

      {/* Acknowledgment checkbox — required before the parent enables "Next" */}
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => onAcknowledgedChange(e.target.checked)}
          className="mt-0.5 h-4 w-4 cursor-pointer rounded border-[var(--color-input)] accent-[var(--color-primary)]"
          aria-required="true"
        />
        <span className="text-sm text-[var(--color-foreground)]">
          I have securely stored this master key. I understand it cannot be
          recovered if lost.
        </span>
      </label>
    </div>
  );
}
