/**
 * ReviewStep — step 4 of the setup wizard.
 *
 * Shows a read-only summary of data entered in earlier steps (admin email,
 * org name). The master key is never shown here — only acknowledged in step 3.
 * The password is masked and never displayed.
 *
 * On "Confirm", calls POST /api/v1/auth/bootstrap. The bootstrapToken comes
 * from GET /api/v1/auth/bootstrap/status (captured by WizardPage and passed
 * down) — it is never entered manually by the user (§9.4).
 *
 * After a successful bootstrap the wizard store is cleared and the caller
 * navigates to step 5 (Success).
 */
import * as React from "react";
import { Loader2 } from "lucide-react";
import { useApiClient, ApiError } from "@/lib/api-client.js";
import { useWizardStore } from "@/stores/wizard.store.js";
import { Button } from "@/components/ui/button.js";
import { WizardStep } from "@/components/wizard/WizardStep.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ReviewStepProps {
  /**
   * Bootstrap token from GET /api/v1/auth/bootstrap/status (held in WizardPage).
   * undefined means the server did not return a token — the confirm button is
   * disabled with an explanatory error so the user cannot submit an empty token.
   */
  bootstrapToken: string | undefined;
  onNext: () => void;
  onPrev: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ReviewStep({ bootstrapToken, onNext, onPrev }: ReviewStepProps) {
  const client = useApiClient();
  const adminEmail = useWizardStore((state) => state.adminEmail);
  const adminPassword = useWizardStore((state) => state.adminPassword);
  const orgName = useWizardStore((state) => state.orgName);
  const reset = useWizardStore((state) => state.reset);

  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);

  async function handleConfirm(): Promise<void> {
    // The button is disabled when bootstrapToken is undefined, but guard here
    // too in case the component is rendered programmatically.
    if (bootstrapToken === undefined) {
      setServerError("Bootstrap token is missing. Refresh the page and try again.");
      return;
    }

    setServerError(null);
    setIsSubmitting(true);

    // Clear password from store before the request so it's not held in
    // memory beyond this point, even if the request fails.
    const passwordToSend = adminPassword;
    useWizardStore.getState().updateField("adminPassword", "");

    try {
      await client.post("/v1/auth/bootstrap", {
        adminEmail,
        adminPassword: passwordToSend,
        tenantName: orgName,
        bootstrapToken,
      });
      reset();
      window.location.href = "/";
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.statusCode === 410) {
          // 410 means bootstrap already completed in another session — redirect
          // to login so the existing admin can sign in.
          window.location.href = "/login";
          return;
        }
        setServerError(err.message);
      } else {
        setServerError("An unexpected error occurred. Please try again.");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <WizardStep
      title="Review your setup"
      description="Check the details below before creating the platform."
    >
      <div className="space-y-6">
        {/* Summary table */}
        <dl className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
          <ReviewRow label="Admin email" value={adminEmail} />
          <ReviewRow label="Password" value="••••••••••••" />
          <ReviewRow label="Organization" value={orgName} />
        </dl>

        {/* Show token-missing error ahead of submission attempt */}
        {bootstrapToken === undefined && (
          <p
            role="alert"
            aria-live="assertive"
            className="rounded-md bg-[var(--color-destructive)]/10 px-4 py-3 text-sm text-[var(--color-destructive)]"
          >
            Bootstrap token is missing. Refresh the page to obtain a valid token before continuing.
          </p>
        )}

        {serverError !== null && (
          <p
            role="alert"
            aria-live="assertive"
            className="rounded-md bg-[var(--color-destructive)]/10 px-4 py-3 text-sm text-[var(--color-destructive)]"
          >
            {serverError}
          </p>
        )}

        <div className="flex gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={onPrev}
            disabled={isSubmitting}
            className="flex-1"
          >
            Back
          </Button>
          <Button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={isSubmitting || bootstrapToken === undefined}
            className="flex-1"
          >
            {isSubmitting && (
              <Loader2
                className="mr-2 h-4 w-4 animate-spin"
                aria-hidden="true"
              />
            )}
            {isSubmitting ? "Creating…" : "Create platform"}
          </Button>
        </div>
      </div>
    </WizardStep>
  );
}

// ---------------------------------------------------------------------------
// ReviewRow — one row in the summary table
// ---------------------------------------------------------------------------

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <dt className="text-sm font-medium text-[var(--color-muted-foreground)]">
        {label}
      </dt>
      <dd className="text-sm text-[var(--color-foreground)] font-mono">
        {value}
      </dd>
    </div>
  );
}
