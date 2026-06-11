/**
 * WelcomeStep — step 0 of the setup wizard.
 *
 * Introductory screen that orients the first-time admin before they enter
 * any data. "Get Started" advances to the Admin Account step.
 */
import * as React from "react";
import { Database } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { WizardStep } from "@/components/wizard/WizardStep.js";

export interface WelcomeStepProps {
  onNext: () => void;
}

export function WelcomeStep({ onNext }: WelcomeStepProps) {
  return (
    <WizardStep
      title="Welcome to OnePlatform"
      description="Let's configure your platform. This takes about 2 minutes."
    >
      <div className="flex flex-col items-center py-8 text-center space-y-6">
        {/* Platform logo placeholder */}
        <div
          className="flex h-20 w-20 items-center justify-center rounded-2xl bg-[var(--color-primary)]/10"
          aria-hidden="true"
        >
          <Database className="h-10 w-10 text-[var(--color-primary)]" />
        </div>

        <div className="space-y-2 max-w-sm">
          <p className="text-sm text-[var(--color-muted-foreground)]">
            You'll set up:
          </p>
          <ul className="text-sm text-[var(--color-foreground)] space-y-1 text-left list-disc list-inside">
            <li>An admin account</li>
            <li>Your organization name</li>
            <li>A master encryption key (save it — it cannot be recovered)</li>
          </ul>
        </div>

        <Button onClick={onNext} size="lg" className="w-full max-w-xs">
          Get Started
        </Button>
      </div>
    </WizardStep>
  );
}
