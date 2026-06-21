import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { RouterProvider } from "@tanstack/react-router";

import "@/styles/globals.css";
import { createApiClient, ApiClientContext, configureAuthStore } from "@/lib/api-client.js";
import { queryClient, configureQueryClientAuth } from "@/lib/query-client.js";
import { useAuthStore } from "@/stores/auth.store.js";
import { createAppRouter } from "@/router.js";
import { registerServiceWorker, registerInstallPromptListener } from "@/lib/pwa.js";

// ---------------------------------------------------------------------------
// Bootstrap: wire up cross-module dependencies
// ---------------------------------------------------------------------------

// Provide api-client with access to the auth store's clearSession so it can
// clear state on 401. Done here to avoid circular imports between the modules.
configureAuthStore(() => useAuthStore.getState().clearSession());
configureQueryClientAuth(() => useAuthStore.getState().clearSession());

const apiClient = createApiClient({ baseUrl: "" });
const router = createAppRouter({ apiClient, queryClient });

// ---------------------------------------------------------------------------
// React root
// ---------------------------------------------------------------------------

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Root element #root not found in the DOM. Check index.html.");
}

createRoot(rootElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ApiClientContext.Provider value={apiClient}>
        <RouterProvider router={router} />
      </ApiClientContext.Provider>
      {/* DevTools are tree-shaken in production builds */}
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  </React.StrictMode>,
);

// Register the service worker after first paint so it does not delay TTI.
// The queryClient is passed so SW SYNC_COMPLETE messages can trigger refetches.
void registerServiceWorker(queryClient);

// Capture the beforeinstallprompt event so UI components can trigger the PWA
// install dialog at an appropriate time (e.g. an "Install App" button in the
// nav). Must run before any user interaction that might cause the browser to
// show the default mini-infobar.
registerInstallPromptListener();
