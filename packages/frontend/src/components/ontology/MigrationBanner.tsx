/**
 * MigrationBanner — alert banner for pending ontology migrations.
 *
 * Shown when there are migrations in "pending" or "running" state.
 * Apply triggers POST /api/v1/ontology/migrations/{id}/confirm.
 * Rollback is a destructive action and uses ConfirmDialog.
 */
import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MigrationStatus = "pending" | "running" | "applied" | "rolled_back" | "failed";

export interface PendingMigration {
  id: string;
  entityType: string;
  fromVersion: number;
  toVersion: number;
  status: MigrationStatus;
}

export interface MigrationBannerProps {
  migrations: PendingMigration[];
  onApply: (migrationId: string) => void | Promise<void>;
  onRollback: (migrationId: string) => void | Promise<void>;
  isApplying?: boolean;
  isRollingBack?: boolean;
}

// ---------------------------------------------------------------------------
// MigrationBanner component
// ---------------------------------------------------------------------------

export function MigrationBanner({
  migrations,
  onApply,
  onRollback,
  isApplying = false,
  isRollingBack = false,
}: MigrationBannerProps) {
  const [rollbackTarget, setRollbackTarget] = React.useState<string | null>(null);

  if (migrations.length === 0) return null;

  // Show only the first pending migration (apply them sequentially)
  const firstMigration = migrations[0];
  if (firstMigration === undefined) return null;

  const isActive = firstMigration.status === "running";

  return (
    <>
      <div
        className="flex flex-col gap-3 rounded-md border border-[var(--color-status-warning)]/50 bg-[var(--color-status-warning)]/10 px-4 py-3 sm:flex-row sm:items-center"
        role="alert"
      >
        <div className="flex items-start gap-2 flex-1 min-w-0">
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-status-warning)]"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[var(--color-foreground)]">
              {migrations.length === 1
                ? "Schema migration pending"
                : `${migrations.length} schema migrations pending`}
            </p>
            <p className="text-xs text-[var(--color-muted-foreground)]">
              {firstMigration.entityType}: v{firstMigration.fromVersion} → v{firstMigration.toVersion}
              {migrations.length > 1 && ` (+${migrations.length - 1} more)`}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            onClick={() => void onApply(firstMigration.id)}
            disabled={isApplying || isActive}
            aria-busy={isApplying}
          >
            {isApplying || isActive ? (
              <span className="flex items-center gap-1.5">
                <span
                  className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
                  aria-hidden
                />
                {isActive ? "Applying…" : "Starting…"}
              </span>
            ) : (
              "Apply"
            )}
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setRollbackTarget(firstMigration.id)}
            disabled={isApplying || isRollingBack || isActive}
          >
            Rollback
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={rollbackTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRollbackTarget(null);
        }}
        title="Roll back migration?"
        description={
          firstMigration !== undefined
            ? `This will roll back the migration for "${firstMigration.entityType}" from v${firstMigration.toVersion} back to v${firstMigration.fromVersion}. This may cause data loss if records were written against the new schema.`
            : "This will roll back the pending migration."
        }
        confirmLabel="Roll back"
        onConfirm={() => {
          if (rollbackTarget !== null) {
            void onRollback(rollbackTarget);
            setRollbackTarget(null);
          }
        }}
        isLoading={isRollingBack}
      />
    </>
  );
}
