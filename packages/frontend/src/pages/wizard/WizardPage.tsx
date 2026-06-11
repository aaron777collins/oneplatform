/**
 * WizardPage — rendered by BootstrapGatePage when bootstrap is incomplete.
 *
 * This is the first-run setup experience (§9). The page has no AppShell,
 * sidebar, or nav — it is the only content on screen during bootstrap.
 *
 * The bootstrapToken is held in local state here (never in the Zustand wizard
 * store) and passed directly to POST /api/v1/auth/bootstrap. Sam never needs
 * to manually enter or copy this token — the API returns it automatically when
 * bootstrap is incomplete.
 */
import React from "react";
import { useWizardStore } from "@/stores/wizard.store.js";

export default function WizardPage() {
  const currentStep = useWizardStore((state) => state.currentStep);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-2xl p-8">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold">Welcome to OnePlatform</h1>
          <p className="mt-2 text-muted-foreground">
            Complete the setup to get started
          </p>
        </div>
        {/* Step indicator — aria-current="step" on active item per §9.5 */}
        <ol
          role="list"
          className="mb-8 flex justify-center gap-2"
          aria-label="Setup steps"
        >
          {([0, 1, 2, 3, 4, 5] as const).map((step) => (
            <li
              key={step}
              aria-current={currentStep === step ? "step" : undefined}
              className={`h-2 w-8 rounded-full transition-colors ${
                currentStep === step
                  ? "bg-primary"
                  : currentStep > step
                  ? "bg-primary/50"
                  : "bg-border"
              }`}
            />
          ))}
        </ol>
        {/* WizardShell renders the active step — implemented in Layer 2 */}
        <div className="rounded-lg border border-border bg-card p-8">
          <p className="text-muted-foreground">Step {currentStep + 1} of 6</p>
        </div>
      </div>
    </main>
  );
}
