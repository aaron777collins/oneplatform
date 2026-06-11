/**
 * MasterKeyStep — step 3 of the setup wizard (security-sensitive).
 *
 * Fetches the master key from GET /api/v1/auth/bootstrap/master-key and
 * delegates display+acknowledgment to MasterKeyDisplay. The key lives
 * ONLY in local component state — it is never written to the wizard store
 * or any persistent storage (§9.3).
 *
 * The endpoint returns 410 Gone once the key has been fetched. If that
 * happens (e.g. the user refreshed mid-wizard), we surface a warning so
 * they know to check their secure notes rather than showing an error state
 * that blocks progress.
 */
import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { useApiClient, ApiError } from "@/lib/api-client.js";
import type { ApiResponse } from "@/lib/api-client.js";
import { useWizardStore } from "@/stores/wizard.store.js";
import { Button } from "@/components/ui/button.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { WizardStep } from "@/components/wizard/WizardStep.js";
import { MasterKeyDisplay } from "@/components/wizard/MasterKeyDisplay.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface MasterKeyStepProps {
  onNext: () => void;
  onPrev: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MasterKeyStep({ onNext, onPrev }: MasterKeyStepProps) {
  const client = useApiClient();
  const updateField = useWizardStore((state) => state.updateField);
  const acknowledged = useWizardStore((state) => state.masterKeyAcknowledged);

  type FetchState =
    | { status: "loading" }
    | { status: "success"; key: string }
    | { status: "gone" }
    | { status: "error"; message: string };

  const [fetchState, setFetchState] = React.useState<FetchState>({ status: "loading" });

  React.useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const result = await client.get<ApiResponse<{ masterKey: string }>>(
          "/v1/auth/bootstrap/master-key",
        );
        if (!cancelled) {
          setFetchState({ status: "success", key: result.data.masterKey });
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.statusCode === 410) {
          // 410 Gone means the key was already fetched in this bootstrap session.
          // The user may have the key saved elsewhere — let them acknowledge and proceed.
          setFetchState({ status: "gone" });
        } else {
          setFetchState({
            status: "error",
            message: err instanceof ApiError ? err.message : "Failed to fetch master key.",
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client]);

  function handleAcknowledgedChange(value: boolean): void {
    updateField("masterKeyAcknowledged", value);
  }

  function handleNext(): void {
    if (acknowledged) onNext();
  }

  return (
    <WizardStep
      title="Master encryption key"
      description="This key protects all secrets stored in the platform. Save it in a password manager now — it cannot be recovered."
    >
      <div className="space-y-6">
        {fetchState.status === "loading" && (
          <div className="space-y-3" aria-label="Loading master key…" role="status">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-4 w-32" />
          </div>
        )}

        {fetchState.status === "success" && (
          <MasterKeyDisplay
            masterKey={fetchState.key}
            acknowledged={acknowledged}
            onAcknowledgedChange={handleAcknowledgedChange}
          />
        )}

        {fetchState.status === "gone" && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-md border border-[var(--color-destructive)]/40 bg-[var(--color-destructive)]/5 px-4 py-3">
              <AlertTriangle
                className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-destructive)]"
                aria-hidden="true"
              />
              <p className="text-sm text-[var(--color-destructive)]">
                The master key has already been displayed. If you haven't saved
                it, you'll need to restart the bootstrap process. Continue only
                if you have the key stored securely.
              </p>
            </div>
            {/* Still require acknowledgment even on the 410 path */}
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => handleAcknowledgedChange(e.target.checked)}
                className="mt-0.5 h-4 w-4 cursor-pointer rounded border-[var(--color-input)] accent-[var(--color-primary)]"
                aria-required="true"
              />
              <span className="text-sm text-[var(--color-foreground)]">
                I have the master key stored securely and wish to proceed.
              </span>
            </label>
          </div>
        )}

        {fetchState.status === "error" && (
          <div
            className="flex items-start gap-3 rounded-md border border-[var(--color-destructive)]/40 bg-[var(--color-destructive)]/5 px-4 py-3"
            role="alert"
          >
            <AlertTriangle
              className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-destructive)]"
              aria-hidden="true"
            />
            <p className="text-sm text-[var(--color-destructive)]">
              {fetchState.message}
            </p>
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <Button type="button" variant="outline" onClick={onPrev} className="flex-1">
            Back
          </Button>
          <Button
            type="button"
            onClick={handleNext}
            disabled={
              !acknowledged ||
              fetchState.status === "loading" ||
              fetchState.status === "error"
            }
            className="flex-1"
          >
            Next
          </Button>
        </div>
      </div>
    </WizardStep>
  );
}
