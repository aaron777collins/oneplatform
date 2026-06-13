/**
 * Application router — all route definitions live here.
 *
 * Code splitting approach: page files export a default component. Routes use
 * `component: lazy(() => import(...))` for all pages. This avoids the
 * `createLazyRoute` path-literal type constraint while still achieving full
 * code splitting for every page and the Monaco editor chunk.
 *
 * The authenticatedRoute is a pathless layout route (id only, no path).
 * Its children are at the top level URL-wise but nested in the route tree
 * for shared layout and auth-guard logic.
 */
import {
  createRouter,
  createRootRouteWithContext,
  createRoute,
  redirect,
  Outlet,
  lazyRouteComponent,
} from "@tanstack/react-router";
import React from "react";
import type { ApiClient } from "@/lib/api-client.js";
import type { QueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/stores/auth.store.js";

// ---------------------------------------------------------------------------
// Router context — available in all loaders
// ---------------------------------------------------------------------------

interface RouterContext {
  apiClient: ApiClient;
  queryClient: QueryClient;
}

// ---------------------------------------------------------------------------
// Root route
// ---------------------------------------------------------------------------

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
});

// ---------------------------------------------------------------------------
// Public routes (no auth guard)
// ---------------------------------------------------------------------------

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: lazyRouteComponent(
    () => import("./pages/auth/LoginPage.js"),
    "LoginPage",
  ),
});

const callbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/callback",
  component: lazyRouteComponent(
    () => import("./pages/auth/CallbackPage.js"),
    "CallbackPage",
  ),
});

const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/forgot-password",
  component: lazyRouteComponent(
    () => import("./pages/auth/ForgotPasswordPage.js"),
    "ForgotPasswordPage",
  ),
});

const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reset-password/$token",
  component: lazyRouteComponent(
    () => import("./pages/auth/ResetPasswordPage.js"),
    "ResetPasswordPage",
  ),
});

// ---------------------------------------------------------------------------
// Index route — Bootstrap gate
// ---------------------------------------------------------------------------

export interface IndexLoaderData {
  bootstrapComplete: boolean;
  bootstrapToken: string | undefined;
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  loader: async ({ context }): Promise<IndexLoaderData> => {
    const status = await context.apiClient.get<{
      data: { completed: boolean; bootstrapToken?: string };
    }>("/v1/auth/bootstrap/status");

    // Once bootstrap is complete the user belongs inside the authenticated shell.
    // Redirecting here (in the loader, before render) avoids a flash of the
    // BootstrapGatePage component entirely.
    if (status.data.completed) {
      throw redirect({ to: "/dashboard" });
    }

    return {
      bootstrapComplete: status.data.completed,
      ...(status.data.bootstrapToken !== undefined
        ? { bootstrapToken: status.data.bootstrapToken }
        : { bootstrapToken: undefined }),
    };
  },
  component: lazyRouteComponent(
    () => import("./pages/BootstrapGatePage.js"),
    "BootstrapGatePage",
  ),
  // When the loader fails (API unreachable, network error, etc.) show a
  // recovery page instead of a white screen. This is the first page new
  // operators see — a blank error is the worst possible first impression.
  errorComponent: lazyRouteComponent(
    () => import("./pages/BootstrapErrorPage.js"),
    "BootstrapErrorPage",
  ),
});

// ---------------------------------------------------------------------------
// Authenticated layout route — pathless, wraps all protected pages
// ---------------------------------------------------------------------------

const authenticatedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "authenticated",
  component: lazyRouteComponent(
    () => import("./components/layout/AuthenticatedLayout.js"),
    "AuthenticatedLayout",
  ),
});

// ---------------------------------------------------------------------------
// Authenticated child routes
// ---------------------------------------------------------------------------

// --- Dashboard ---
const dashboardRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/dashboard",
  component: lazyRouteComponent(
    () => import("./pages/dashboard/DashboardPage.js"),
    "default",
  ),
});

// --- Connectors ---
const connectorsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/connectors",
  component: lazyRouteComponent(
    () => import("./pages/connectors/ConnectorsPage.js"),
    "ConnectorsPage",
  ),
});

const newConnectorRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/connectors/new",
  component: lazyRouteComponent(
    () => import("./pages/connectors/NewConnectorPage.js"),
    "NewConnectorPage",
  ),
});

const connectorDetailRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/connectors/$id",
  component: lazyRouteComponent(
    () => import("./pages/connectors/ConnectorDetailPage.js"),
    "ConnectorDetailPage",
  ),
});

// --- Ontology ---
const ontologyRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/ontology",
  component: lazyRouteComponent(
    () => import("./pages/ontology/OntologyPage.js"),
    "OntologyPage",
  ),
});

const migrationsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/ontology/migrations",
  component: lazyRouteComponent(
    () => import("./pages/ontology/MigrationsPage.js"),
    "MigrationsPage",
  ),
});

const entityDetailRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/ontology/$entityType",
  component: lazyRouteComponent(
    () => import("./pages/ontology/EntityDetailPage.js"),
    "EntityDetailPage",
  ),
});

// --- Pipelines ---
const pipelinesRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/pipelines",
  component: lazyRouteComponent(
    () => import("./pages/pipelines/PipelinesPage.js"),
    "PipelinesPage",
  ),
});

const pipelineDetailRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/pipelines/$id",
  component: lazyRouteComponent(
    () => import("./pages/pipelines/PipelineDetailPage.js"),
    "PipelineDetailPage",
  ),
});

const pipelineBuilderRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/pipelines/$id/edit",
  component: lazyRouteComponent(
    () => import("./pages/pipelines/PipelineBuilderPage.js"),
    "PipelineBuilderPage",
  ),
});

const runDetailRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/pipeline-runs/$runId",
  component: lazyRouteComponent(
    () => import("./pages/pipelines/RunDetailPage.js"),
    "RunDetailPage",
  ),
});

// --- Apps ---
const appsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/apps",
  component: lazyRouteComponent(
    () => import("./pages/apps/AppsPage.js"),
    "AppsPage",
  ),
});

const appDetailRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/apps/$id",
  component: lazyRouteComponent(
    () => import("./pages/apps/AppDetailPage.js"),
    "AppDetailPage",
  ),
});

// Monaco editor chunk (~4MB) — only Jordan (app developer) loads this.
// lazyRouteComponent defers the import so the chunk is not fetched until
// the user navigates to /apps/$id/edit. The router's default "intent"
// preloading starts the fetch on hover, before the click is confirmed.
const appEditorRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/apps/$id/edit",
  component: lazyRouteComponent(
    () => import("./pages/apps/AppEditorPage.js"),
    "AppEditorPage",
  ),
});

// --- Logs ---
const logsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/logs",
  component: lazyRouteComponent(
    () => import("./pages/logs/LogsPage.js"),
    "LogsPage",
  ),
});

const auditRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/logs/audit",
  component: lazyRouteComponent(
    () => import("./pages/logs/AuditPage.js"),
    "AuditPage",
  ),
});

// --- DLQ ---
const dlqRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/dlq",
  component: lazyRouteComponent(
    () => import("./pages/dlq/DLQPage.js"),
    "DLQPage",
  ),
});

// --- Metrics ---
const metricsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/metrics",
  component: lazyRouteComponent(
    () => import("./pages/metrics/MetricsPage.js"),
    "MetricsPage",
  ),
});

// --- Plugins ---
const pluginsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/plugins",
  component: lazyRouteComponent(
    () => import("./pages/plugins/PluginsPage.js"),
    "PluginsPage",
  ),
});

const pluginDetailRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/plugins/$id",
  component: lazyRouteComponent(
    () => import("./pages/plugins/PluginDetailPage.js"),
    "PluginDetailPage",
  ),
});

// --- Settings ---
const settingsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings",
  component: lazyRouteComponent(
    () => import("./pages/settings/SettingsPage.js"),
    "SettingsPage",
  ),
});

const profileRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings/profile",
  component: lazyRouteComponent(
    () => import("./pages/settings/ProfilePage.js"),
    "ProfilePage",
  ),
});

const teamsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings/teams",
  component: lazyRouteComponent(
    () => import("./pages/settings/TeamsPage.js"),
    "TeamsPage",
  ),
});

const apiKeysRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings/api-keys",
  component: lazyRouteComponent(
    () => import("./pages/settings/ApiKeysPage.js"),
    "ApiKeysPage",
  ),
});

const webhooksRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings/webhooks",
  component: lazyRouteComponent(
    () => import("./pages/settings/WebhooksPage.js"),
    "WebhooksPage",
  ),
});

const adminRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings/admin",
  // Guard: only platform-admin users may access the admin page.
  // The server enforces this too — this check prevents non-admins from seeing
  // the page content while the server request is in flight.
  beforeLoad: () => {
    const hasPermission = useAuthStore.getState().hasPermission("platform-admin");
    if (!hasPermission) {
      throw redirect({ to: "/settings" });
    }
  },
  component: lazyRouteComponent(
    () => import("./pages/settings/AdminPage.js"),
    "AdminPage",
  ),
});

// --- 404 catch-all ---
const notFoundRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "*",
  component: lazyRouteComponent(
    () => import("./pages/NotFoundPage.js"),
    "NotFoundPage",
  ),
});

// ---------------------------------------------------------------------------
// Route tree assembly
// ---------------------------------------------------------------------------

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  callbackRoute,
  forgotPasswordRoute,
  resetPasswordRoute,
  authenticatedRoute.addChildren([
    dashboardRoute,
    connectorsRoute,
    newConnectorRoute,
    connectorDetailRoute,
    ontologyRoute,
    migrationsRoute,
    entityDetailRoute,
    pipelinesRoute,
    pipelineDetailRoute,
    pipelineBuilderRoute,
    runDetailRoute,
    appsRoute,
    appDetailRoute,
    appEditorRoute,
    logsRoute,
    auditRoute,
    dlqRoute,
    metricsRoute,
    pluginsRoute,
    pluginDetailRoute,
    settingsRoute,
    profileRoute,
    teamsRoute,
    apiKeysRoute,
    webhooksRoute,
    adminRoute,
  ]),
  notFoundRoute,
]);

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createAppRouter(context: RouterContext) {
  return createRouter({
    routeTree,
    context,
    defaultPreload: "intent",
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

// Global router type registration for full type inference in all hooks
declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
