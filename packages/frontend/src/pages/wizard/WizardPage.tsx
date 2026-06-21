/**
 * WizardPage — full-page bootstrap wizard rendered by BootstrapGatePage when
 * bootstrap is not yet complete.
 *
 * There is no AppShell, sidebar, or nav — this is a standalone centered page.
 * The bootstrapToken from the index route loader is threaded directly to
 * WizardShell (and ultimately ReviewStep) so it is never stored in Zustand
 * or shown to the user.
 *
 * The token is held in a React ref (not state) because it never needs to
 * trigger a re-render — it only needs to be available when ReviewStep fires
 * POST /api/v1/bootstrap.
 */
import React from "react";
import { WizardShell } from "@/components/wizard/WizardShell.js";

export interface WizardPageProps {
  bootstrapToken: string | undefined;
}

export default function WizardPage({ bootstrapToken }: WizardPageProps) {
  return (
    <main
      className="flex min-h-screen items-center justify-center bg-[var(--color-background)] px-4 py-12"
      aria-label="Platform setup wizard"
    >
      <div className="w-full max-w-lg">
        <div className="mb-8 text-center">
          <p className="text-sm font-medium uppercase tracking-widest text-[var(--color-muted-foreground)]">
            OnePlatform
          </p>
          <h1 className="mt-1 text-3xl font-bold text-[var(--color-foreground)]">
            Welcome to OnePlatform
          </h1>
          <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">
            Your all-in-one data platform for connecting, transforming, and visualizing your data — no coding required.
          </p>
          {/* Brief benefit list so first-time users know what they're setting up */}
          <ul className="mt-4 flex flex-col items-center gap-1.5 text-sm text-[var(--color-muted-foreground)]">
            <li className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-primary)]" aria-hidden="true" />
              Connect your data sources
            </li>
            <li className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-primary)]" aria-hidden="true" />
              Build pipelines visually
            </li>
            <li className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-primary)]" aria-hidden="true" />
              Create dashboards instantly
            </li>
          </ul>
        </div>

        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-8 shadow-sm">
          <WizardShell bootstrapToken={bootstrapToken} />
        </div>
      </div>
    </main>
  );
}
