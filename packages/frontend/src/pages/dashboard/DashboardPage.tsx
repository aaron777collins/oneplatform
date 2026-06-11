/**
 * DashboardPage — the overview page shown to authenticated users after bootstrap.
 *
 * Shows three panels (Active Pipelines, Recent Activity, Service Health) plus
 * a Quick Start panel for new users with zero apps (Casey's entry point).
 * See design doc §10.3 for full panel specifications.
 */
import React from "react";

export default function DashboardPage() {
  return (
    <main id="main-content" tabIndex={-1} className="flex-1 p-6" aria-label="Dashboard">
      <header>
        <h1 className="text-2xl font-semibold">Overview</h1>
      </header>
      {/* Panels will be implemented in Layer 2 */}
    </main>
  );
}
