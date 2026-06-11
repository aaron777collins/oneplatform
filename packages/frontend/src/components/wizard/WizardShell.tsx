/**
 * WizardShell — step progress indicator and step renderer.
 *
 * Renders the numbered progress circles at the top, then delegates rendering
 * of the current step's content to the appropriate step component. Navigation
 * (next/prev) is handled inside each step component rather than here, because
 * steps have different validation requirements before they can advance.
 *
 * The bootstrapToken is threaded through to ReviewStep, which needs it for
 * the POST /api/v1/auth/bootstrap call (§9.4).
 *
 * Accessibility (§9.5): progress list uses aria-current="step" on the active
 * item and role="list" on the <ol>.
 */
import * as React from "react";
import { useWizardStore, type WizardStep as WizardStepIndex } from "@/stores/wizard.store.js";
import { WelcomeStep } from "@/components/wizard/steps/WelcomeStep.js";
import { AdminAccountStep } from "@/components/wizard/steps/AdminAccountStep.js";
import { OrgNameStep } from "@/components/wizard/steps/OrgNameStep.js";
import { MasterKeyStep } from "@/components/wizard/steps/MasterKeyStep.js";
import { ReviewStep } from "@/components/wizard/steps/ReviewStep.js";
import { SuccessStep } from "@/components/wizard/steps/SuccessStep.js";
import { cn } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Step metadata
// ---------------------------------------------------------------------------

const STEP_LABELS: Record<WizardStepIndex, string> = {
  0: "Welcome",
  1: "Admin account",
  2: "Organization",
  3: "Master key",
  4: "Review",
  5: "Done",
};

// The success step (5) has no progress dot — it's the terminal state.
const PROGRESS_STEPS = [0, 1, 2, 3, 4] as const;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface WizardShellProps {
  /** Bootstrap token from GET /api/v1/auth/bootstrap/status (§9.4). */
  bootstrapToken: string | undefined;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WizardShell({ bootstrapToken }: WizardShellProps) {
  const currentStep = useWizardStore((state) => state.currentStep);
  const next = useWizardStore((state) => state.next);
  const prev = useWizardStore((state) => state.prev);

  return (
    <div className="space-y-8">
      {/* Step progress indicator — hidden on success step */}
      {currentStep < 5 && (
        <nav aria-label="Setup progress">
          <ol
            role="list"
            className="flex items-center justify-center gap-0"
          >
            {PROGRESS_STEPS.map((step, idx) => {
              const isActive = currentStep === step;
              const isComplete = currentStep > step;
              const isLast = idx === PROGRESS_STEPS.length - 1;

              return (
                <React.Fragment key={step}>
                  <li
                    className="flex flex-col items-center gap-1"
                    aria-current={isActive ? "step" : undefined}
                  >
                    {/* Numbered circle */}
                    <span
                      className={cn(
                        "flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold transition-colors",
                        isActive &&
                          "bg-[var(--color-primary)] text-[var(--color-primary-foreground)]",
                        isComplete &&
                          "bg-[var(--color-primary)]/60 text-[var(--color-primary-foreground)]",
                        !isActive &&
                          !isComplete &&
                          "border border-[var(--color-border)] text-[var(--color-muted-foreground)]",
                      )}
                      aria-label={`Step ${step + 1}: ${STEP_LABELS[step]}`}
                    >
                      {step + 1}
                    </span>
                    {/* Step label — hidden on small screens */}
                    <span
                      className={cn(
                        "hidden text-[10px] sm:block",
                        isActive
                          ? "font-medium text-[var(--color-foreground)]"
                          : "text-[var(--color-muted-foreground)]",
                      )}
                    >
                      {STEP_LABELS[step]}
                    </span>
                  </li>

                  {/* Connecting line between circles */}
                  {!isLast && (
                    <div
                      aria-hidden="true"
                      className={cn(
                        "mb-5 h-px w-8 flex-1 transition-colors",
                        isComplete
                          ? "bg-[var(--color-primary)]/60"
                          : "bg-[var(--color-border)]",
                      )}
                    />
                  )}
                </React.Fragment>
              );
            })}
          </ol>
        </nav>
      )}

      {/* Active step content */}
      <div>
        {currentStep === 0 && <WelcomeStep onNext={next} />}
        {currentStep === 1 && <AdminAccountStep onNext={next} onPrev={prev} />}
        {currentStep === 2 && <OrgNameStep onNext={next} onPrev={prev} />}
        {currentStep === 3 && <MasterKeyStep onNext={next} onPrev={prev} />}
        {currentStep === 4 && (
          <ReviewStep
            bootstrapToken={bootstrapToken}
            onNext={next}
            onPrev={prev}
          />
        )}
        {currentStep === 5 && <SuccessStep />}
      </div>
    </div>
  );
}
