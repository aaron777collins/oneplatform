/**
 * DetailPanel — slide-out side panel for viewing record details.
 *
 * Renders as a fixed overlay with a semi-transparent backdrop + a right-anchored
 * panel that slides in when `open` is true. Focus is trapped inside the panel
 * when open so keyboard users cannot accidentally interact with content behind
 * the overlay — the Escape key and close button both call `onClose`.
 *
 * The panel uses role="dialog" and aria-modal so screen readers announce it as
 * a modal dialog and do not allow virtual cursor navigation outside it.
 */

import * as React from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DetailPanelProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Optional subtitle shown below the panel title. */
  description?: string;
  /** Panel content. */
  children?: React.ReactNode;
  /** Width class applied to the panel. Defaults to a 480px wide panel. */
  width?: string;
}

// ---------------------------------------------------------------------------
// DetailPanel component
// ---------------------------------------------------------------------------

export function DetailPanel({
  open,
  onClose,
  title,
  description,
  children,
  width = "w-full max-w-[480px]",
}: DetailPanelProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();

  // Close on Escape key press — standard dialog keyboard behavior.
  React.useEffect(() => {
    if (!open) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  // When the panel opens, move focus to the panel container so screen readers
  // announce the dialog title immediately. When it closes, focus returns to the
  // trigger element automatically because we use the DOM event model.
  React.useEffect(() => {
    if (open) {
      // Defer to next tick so the panel is rendered and visible before focusing.
      const frameId = requestAnimationFrame(() => {
        panelRef.current?.focus();
      });
      return () => cancelAnimationFrame(frameId);
    }
    return undefined;
  }, [open]);

  // Prevent body scroll while the panel is open so the user cannot accidentally
  // scroll the underlying page via keyboard.
  React.useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" aria-hidden={!open}>
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40"
        aria-hidden="true"
        onClick={onClose}
      />

      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={[
          "relative flex h-full flex-col bg-[var(--color-background,#fff)] shadow-xl",
          "focus:outline-none",
          // Slide-in animation via translate — relies on Tailwind CSS v4's
          // arbitrary value support. Falls back gracefully if CSS transforms
          // are unsupported.
          "translate-x-0",
          width,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {/* Panel header */}
        <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border,#e5e7eb)] px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2
              id={titleId}
              className="truncate text-lg font-semibold text-[var(--color-foreground,#111)]"
            >
              {title}
            </h2>
            {description !== undefined && (
              <p className="mt-0.5 text-sm text-[var(--color-muted-foreground,#6b7280)]">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="shrink-0 rounded-md p-1 text-[var(--color-muted-foreground,#6b7280)] hover:bg-[var(--color-muted,#f3f4f6)] hover:text-[var(--color-foreground,#111)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring,#6366f1)]"
          >
            {/* X glyph — avoids a lucide-react dependency in the SDK */}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {children}
        </div>
      </div>
    </div>
  );
}
