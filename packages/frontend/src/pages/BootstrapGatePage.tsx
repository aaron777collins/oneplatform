/**
 * BootstrapGatePage — rendered at "/" by the index route.
 *
 * The loader in router.tsx fetches bootstrap status before this component
 * renders. We access the loader data via useLoaderData from the index route.
 * If bootstrap is incomplete, the setup wizard is shown. If complete, the
 * user sees the authenticated dashboard.
 */
import React from "react";
import { useLoaderData } from "@tanstack/react-router";
import type { IndexLoaderData } from "@/router.js";

export function BootstrapGatePage() {
  const { bootstrapComplete } = useLoaderData({ from: "/" }) as IndexLoaderData;

  if (!bootstrapComplete) {
    const WizardPage = React.lazy(() => import("./wizard/WizardPage.js"));
    return (
      <React.Suspense fallback={<FullPageSpinner />}>
        <WizardPage />
      </React.Suspense>
    );
  }

  const AuthenticatedApp = React.lazy(() => import("../components/layout/AuthenticatedApp.js"));
  return (
    <React.Suspense fallback={<FullPageSpinner />}>
      <AuthenticatedApp />
    </React.Suspense>
  );
}

function FullPageSpinner() {
  return (
    <div
      className="flex min-h-screen items-center justify-center"
      role="status"
      aria-label="Loading"
    >
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
    </div>
  );
}
