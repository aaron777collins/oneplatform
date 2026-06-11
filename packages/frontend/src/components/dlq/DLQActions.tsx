/**
 * DLQActions — replay and discard buttons for a DLQ job.
 *
 * Discard is a destructive action and requires confirmation via ConfirmDialog.
 * Replay triggers requeue and is non-destructive so no confirmation is needed.
 */
import * as React from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog.js";
import { cn } from "@/lib/utils.js";

export interface DLQActionsProps {
  jobId: string;
  onReplay: (jobId: string) => void;
  onDiscard: (jobId: string) => void;
  isReplaying?: boolean;
  isDiscarding?: boolean;
  className?: string;
}

export function DLQActions({
  jobId,
  onReplay,
  onDiscard,
  isReplaying = false,
  isDiscarding = false,
  className,
}: DLQActionsProps) {
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  return (
    <>
      <div className={cn("flex items-center gap-2", className)}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onReplay(jobId)}
          disabled={isReplaying || isDiscarding}
          aria-busy={isReplaying}
          aria-label="Replay job"
        >
          {isReplaying ? (
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
              aria-hidden="true"
            />
          ) : (
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          )}
          <span className="ml-1.5">{isReplaying ? "Replaying…" : "Replay"}</span>
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="border-[var(--color-destructive)]/30 text-[var(--color-destructive)] hover:bg-[var(--color-destructive)]/10"
          onClick={() => setConfirmOpen(true)}
          disabled={isReplaying || isDiscarding}
          aria-busy={isDiscarding}
          aria-label="Discard job permanently"
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          <span className="ml-1.5">Discard</span>
        </Button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Discard job?"
        description={`Job ${jobId.slice(0, 8)} will be permanently deleted and cannot be replayed. This action cannot be undone.`}
        confirmLabel="Discard permanently"
        onConfirm={() => {
          setConfirmOpen(false);
          onDiscard(jobId);
        }}
        isLoading={isDiscarding}
      />
    </>
  );
}
