/**
 * ConnectorCard — displays a single connector in the grid view.
 *
 * Shows name, type, last sync time, status badge, active sync progress bar,
 * and a trigger-sync button. Delegates status mutation to the caller via onSync
 * so the card stays a pure presentational component; the page handles mutations.
 */
import * as React from "react";
import { RefreshCw } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.js";
import { Button } from "@/components/ui/button.js";
import { RelativeTime } from "@/components/shared/RelativeTime.js";
import { ConnectorStatusBadge, type ConnectorStatus } from "./ConnectorStatusBadge.js";
import { SyncProgressBar } from "./SyncProgressBar.js";
import { cn } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConnectorCardData {
  id: string;
  name: string;
  /** Human-readable connector type label, e.g. "PostgreSQL", "REST API" */
  typeName: string;
  status: ConnectorStatus;
  /** ISO string of the last completed sync, undefined if never synced */
  lastSyncAt?: string;
  /** Present only while a sync is in progress */
  activeSyncPercent?: number;
  /** ISO string ETA for active sync; undefined when not syncing */
  activeSyncEta?: string;
}

export interface ConnectorCardProps {
  connector: ConnectorCardData;
  /** Called when the user clicks the "Sync now" button */
  onSync: (id: string) => void;
  /** True while the sync mutation is in-flight for this connector */
  isSyncing?: boolean;
  onClick?: (id: string) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// ConnectorCard component
// ---------------------------------------------------------------------------

export function ConnectorCard({
  connector,
  onSync,
  isSyncing = false,
  onClick,
  className,
}: ConnectorCardProps) {
  const { id, name, typeName, status, lastSyncAt, activeSyncPercent, activeSyncEta } = connector;

  function handleCardClick(e: React.MouseEvent) {
    // Don't navigate if the click was on the sync button
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;
    onClick?.(id);
  }

  return (
    <Card
      className={cn(
        "transition-shadow hover:shadow-md",
        onClick !== undefined && "cursor-pointer",
        className,
      )}
      onClick={handleCardClick}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <CardTitle className="truncate text-base font-semibold">{name}</CardTitle>
            <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">{typeName}</p>
          </div>
          <ConnectorStatusBadge status={status} />
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Last sync time */}
        <div className="text-xs text-[var(--color-muted-foreground)]">
          {lastSyncAt !== undefined ? (
            <span>
              Last sync: <RelativeTime value={lastSyncAt} />
            </span>
          ) : (
            <span>Never synced</span>
          )}
        </div>

        {/* Active sync progress */}
        {activeSyncPercent !== undefined && (
          <SyncProgressBar
            percent={activeSyncPercent}
            {...(activeSyncEta !== undefined ? { estimatedCompletionAt: activeSyncEta } : {})}
          />
        )}

        {/* Sync button */}
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={(e) => {
            e.stopPropagation();
            onSync(id);
          }}
          disabled={isSyncing || status === "disabled" || status === "syncing"}
          aria-busy={isSyncing}
        >
          <RefreshCw
            className={cn("h-3.5 w-3.5", (isSyncing || status === "syncing") && "animate-spin")}
            aria-hidden="true"
          />
          {isSyncing ? "Triggering…" : "Sync now"}
        </Button>
      </CardContent>
    </Card>
  );
}
