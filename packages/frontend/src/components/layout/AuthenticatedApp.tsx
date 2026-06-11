/**
 * AuthenticatedApp — used by BootstrapGatePage after bootstrap completes.
 *
 * Renders the DashboardPage with the same auth check as AuthenticatedLayout.
 * This is a thin wrapper so BootstrapGatePage can lazy-load it without
 * importing the full router structure.
 */
import React from "react";
import DashboardPage from "@/pages/dashboard/DashboardPage.js";
import { useRequireAuth } from "@/hooks/use-auth.js";

export default function AuthenticatedApp() {
  // Redirects to /login if no valid session exists
  useRequireAuth();

  return <DashboardPage />;
}
