/**
 * AppRollbackDialog — lets the user select a previous build to rollback to.
 *
 * Fetches the build list, shows a select, then delegates to ConfirmDialog
 * for the destructive confirmation step before POSTing to the rollback endpoint.
 */
import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Button } from "@/components/ui/button.js";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog.js";
import { useApiClient, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";
import type { PaginatedResponse } from "@/lib/api-client.js";
import type { AppBuild } from "./BuildHistoryTable.js";
import { formatDate } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppRollbackDialogProps {
  appId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ---------------------------------------------------------------------------
// AppRollbackDialog component
// ---------------------------------------------------------------------------

export function AppRollbackDialog({ appId, open, onOpenChange }: AppRollbackDialogProps) {
  const client = useApiClient();
  const queryClient = useQueryClient();

  const [selectedBuildId, setSelectedBuildId] = React.useState<string | undefined>(undefined);
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  // Fetch recent builds to populate the select
  const buildsQuery = useQuery({
    queryKey: ["apps", appId, "builds", "select"],
    queryFn: ({ signal }) =>
      client.get<PaginatedResponse<AppBuild>>(`/v1/apps/${appId}/builds`, { limit: "20" }, { signal }),
    enabled: open,
  });

  const successfulBuilds = React.useMemo(() => {
    const envelope = buildsQuery.data as any;
    const inner = envelope?.data ?? envelope;
    const arr: AppBuild[] = Array.isArray(inner?.data) ? inner.data : Array.isArray(inner) ? inner : [];
    return arr.filter((b) => b.status === "success");
  }, [buildsQuery.data]);

  const selectedBuild = selectedBuildId !== undefined
    ? successfulBuilds.find((b) => b.id === selectedBuildId)
    : undefined;

  const rollbackMutation = useMutation({
    mutationFn: (buildId: string) =>
      client.post(`/v1/apps/${appId}/rollback`, { buildId }),
    onSuccess: () => {
      toast({ title: "Rollback initiated", description: "The app will be restored to the selected build." });
      void queryClient.invalidateQueries({ queryKey: ["apps", appId] });
      setConfirmOpen(false);
      onOpenChange(false);
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Rollback failed. Try again.";
      toast({ title: "Rollback failed", description: message, variant: "destructive" });
      setConfirmOpen(false);
    },
  });

  function handleRollbackClick() {
    if (selectedBuildId === undefined) return;
    setConfirmOpen(true);
  }

  function handleConfirm() {
    if (selectedBuildId !== undefined) {
      rollbackMutation.mutate(selectedBuildId);
    }
  }

  // Reset state when dialog closes
  React.useEffect(() => {
    if (!open) {
      setSelectedBuildId(undefined);
      setConfirmOpen(false);
    }
  }, [open]);

  return (
    <>
      <Dialog open={open && !confirmOpen} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rollback App</DialogTitle>
            <DialogDescription>
              Select a previous successful build to restore. The current deployment will be replaced.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            {buildsQuery.isLoading ? (
              <p className="text-sm text-[var(--color-muted-foreground)]">Loading builds…</p>
            ) : successfulBuilds.length === 0 ? (
              <p className="text-sm text-[var(--color-muted-foreground)]">No successful builds available to rollback to.</p>
            ) : (
              <Select
                value={selectedBuildId ?? ""}
                onValueChange={setSelectedBuildId}
              >
                <SelectTrigger aria-label="Select build version">
                  <SelectValue placeholder="Select a build version…" />
                </SelectTrigger>
                <SelectContent>
                  {successfulBuilds.map((build) => (
                    <SelectItem key={build.id} value={build.id}>
                      <span className="font-mono text-xs">{build.id.slice(0, 8)}</span>
                      {" — "}
                      {formatDate(build.createdAt)}
                      {build.commitSha !== undefined && (
                        <span className="ml-2 text-[var(--color-muted-foreground)]">
                          ({build.commitSha.slice(0, 7)})
                        </span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRollbackClick}
              disabled={selectedBuildId === undefined || buildsQuery.isLoading}
            >
              Rollback
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Confirm Rollback"
        description={
          selectedBuild !== undefined
            ? `Roll back to build ${selectedBuild.id.slice(0, 8)} from ${formatDate(selectedBuild.createdAt)}? The current deployment will be replaced.`
            : "Are you sure you want to rollback? The current deployment will be replaced."
        }
        confirmLabel="Rollback"
        onConfirm={handleConfirm}
        isLoading={rollbackMutation.isPending}
      />
    </>
  );
}
