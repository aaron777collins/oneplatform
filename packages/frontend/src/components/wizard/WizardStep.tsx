/**
 * WizardStep — individual step container with title, description, and content slot.
 *
 * Provides consistent heading and spacing across all wizard screens so each
 * step only needs to render its form or informational content.
 */
import * as React from "react";

export interface WizardStepProps {
  title: string;
  description?: string;
  children: React.ReactNode;
}

export function WizardStep({ title, description, children }: WizardStepProps) {
  return (
    <section>
      <header className="mb-6">
        <h2 className="text-xl font-semibold text-[var(--color-foreground)]">
          {title}
        </h2>
        {description !== undefined && (
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            {description}
          </p>
        )}
      </header>

      <div>{children}</div>
    </section>
  );
}
