import React from "react";
import { createRoot } from "react-dom/client";
import { AppProvider } from "@oneplatform/app-sdk";
import { App } from "./App.js";
import "./styles.css";

// ---------------------------------------------------------------------------
// Entry point.
//
// The platform HTML shell injects window.__OP_APP_CONFIG__ (appId + tenantId)
// before this bundle runs. AppProvider reads that config, authenticates the
// session, seeds the permission cache, and withholds children until ready.
//
// The Docker data itself is NOT fetched through the SDK hooks (Docker entities
// are not in the ontology) — it flows through the custom dockerApiClient which
// hits the App Service's /bff/docker proxy. AppProvider is still required so
// the app participates in the platform session + permission model.
// ---------------------------------------------------------------------------

const container = document.getElementById("root");
if (container === null) {
  throw new Error("Root element #root not found.");
}

createRoot(container).render(
  <React.StrictMode>
    <AppProvider
      loadingFallback={
        <div className="empty-state" aria-live="polite" aria-busy="true">
          Loading Docker Fleet Manager…
        </div>
      }
    >
      <App />
    </AppProvider>
  </React.StrictMode>,
);
