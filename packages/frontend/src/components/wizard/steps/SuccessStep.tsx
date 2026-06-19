/**
 * SuccessStep — step 5 (final) of the setup wizard.
 *
 * Shown after POST /api/v1/bootstrap succeeds. Displays a success
 * confirmation and directs the new admin to the login page so they can
 * authenticate with the account they just created.
 *
 * No "Back" — there is nothing to undo at this point.
 */
import * as React from "react";
import { CheckCircle2 } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button.js";
import { WizardStep } from "@/components/wizard/WizardStep.js";

export function SuccessStep() {
  return (
    <WizardStep title="Platform ready">
      <div className="flex flex-col items-center py-8 text-center space-y-6">
        {/* Success icon — animated only when the user has not set prefer-reduced-motion */}
        <div
          className="flex h-20 w-20 items-center justify-center rounded-full bg-[var(--color-primary)]/10 motion-safe:animate-[ping_0.6s_ease-out_1]"
          aria-hidden="true"
        >
          <CheckCircle2 className="h-12 w-12 text-[var(--color-primary)]" />
        </div>

        <div className="space-y-2 max-w-sm">
          <p className="text-base font-medium text-[var(--color-foreground)]">
            OnePlatform is configured and ready.
          </p>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            You are now signed in and can start using the platform.
          </p>
        </div>

        <Button asChild size="lg" className="w-full max-w-xs">
          <Link to="/">Go to dashboard</Link>
        </Button>
      </div>
    </WizardStep>
  );
}
