# OnePlatform Frontend — L2 Package Design

**Document level:** L2 (Package Design)
**Status:** APPROVED
**Date:** 2026-06-10
**Location:** `packages/frontend/`
**References:**
- L1: `docs/superpowers/specs/2026-06-10-oneplatform-design.md` (Bootstrap §2, Auth §4, App Platform §9, CLI/SDKs §10, Implementation Order §14)
- L2: `docs/designs/app-service.md` (Monaco §13, BFF §8, SSE §11)
- L2: `docs/designs/auth-service.md`
- L2: `docs/designs/gateway-service.md`
- L2: `docs/designs/sdk-package.md`
- ADR-24: First-Run Experience and Bootstrap
- ADR-25: App Platform Design
- ADR-26: App-SDK and BFF Design
- ADR-27: App Access Control and OAuth Client Lifecycle
- ADR-29: API Contract Standard
- ADR-30: Outbound Event System

---

## Table of Contents

1. [Package Overview](#1-package-overview)
2. [Technology Stack](#2-technology-stack)
3. [Project Structure](#3-project-structure)
4. [Routing Structure](#4-routing-structure)
5. [State Management](#5-state-management)
6. [Authentication Flow](#6-authentication-flow)
7. [API Client and Data Fetching](#7-api-client-and-data-fetching)
8. [Real-Time Updates](#8-real-time-updates)
9. [Setup Wizard](#9-setup-wizard)
10. [Dashboard Layout and Navigation](#10-dashboard-layout-and-navigation)
11. [Monaco Editor Integration](#11-monaco-editor-integration)
12. [Component Library Approach](#12-component-library-approach)
13. [Error Handling and Loading States](#13-error-handling-and-loading-states)
14. [Accessibility](#14-accessibility)
15. [Performance](#15-performance)
16. [Testing Strategy](#16-testing-strategy)
17. [Build and Deployment](#17-build-and-deployment)
18. [Security Design](#18-security-design)
19. [TypeScript Conventions](#19-typescript-conventions)

---

## 1. Package Overview

### 1.1 Responsibility

`packages/frontend/` is the single-page application served to all platform users — data engineers, app developers, non-technical users, and administrators. It is the dashboard client, not the app runtime. Platform-hosted apps (Jordan's internal tools, Casey's data viewers) are entirely separate bundles served by the App Service at `/apps/{slug}/*`. The dashboard at `/` is this package.

The frontend consumes the Gateway REST API exclusively at `/api/v1/*`. It never calls internal services directly. All authentication is managed through `httpOnly` cookies — the browser never holds an access token in JavaScript-accessible storage.

### 1.2 User Personas and Primary Views

| Persona | Entry points |
|---------|-------------|
| Sam (DevOps/admin) | Setup wizard → admin settings → connector config → team management |
| Alex (data engineer) | Connector list → ontology builder → pipeline builder → run monitor |
| Jordan (app developer) | App list → Monaco editor → build logs → deploy controls |
| Casey (non-technical) | CSV upload → schema confirm wizard → starter app generation |

### 1.3 Serving Model

The frontend is a compiled static bundle. Vite produces `dist/` during `pnpm build`. In production the `frontend` Docker container serves `dist/` via Nginx. Nginx also reverse-proxies `/api/*` and `/bff/*` to the Gateway at port 3000. No Node.js runtime is required in production.

```
Browser → Nginx :80 → static files (dist/)
               → /api/* → Gateway :3000
               → /bff/* → Gateway :3000 (routed internally to App Service)
```

---

## 2. Technology Stack

### 2.1 Core Framework

| Choice | Justification |
|--------|--------------|
| **Vite 5** | Native ESM dev server, sub-second HMR, first-class TypeScript and React support, straightforward static build output. No custom Webpack configuration required. |
| **React 18** | Concurrent rendering for the log viewer and real-time panels. The existing `@oneplatform/app-sdk` is already React 18 — consistent peer dependency across the monorepo. |
| **TypeScript 5 strict** | Matches `tsconfig.base.json`. The `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` flags are non-negotiable per the monorepo convention. |

### 2.2 Styling

| Choice | Justification |
|--------|--------------|
| **Tailwind CSS v4** | L1 spec mandates it (§14 Phase 7). v4's CSS-first configuration (no `tailwind.config.js`) aligns with the ESM-only constraint. Performance: only emits used CSS. |
| **shadcn/ui** | L1 spec mandates it. Component code is copied into `src/components/ui/` and owned by the project — no shadcn runtime dependency, no version lock-in. Components are built on Radix UI primitives, which provide accessibility out of the box. |

**Tailwind v4 configuration approach:** Configured via `@import "tailwindcss"` and `@theme {}` block in `src/styles/globals.css`. No separate config file. Design tokens (colors, radii, spacing) defined in the theme block. shadcn uses CSS custom properties (`--color-primary`, etc.) injected by the Tailwind theme.

### 2.3 Routing

| Choice | Justification |
|--------|--------------|
| **TanStack Router v1** | File-based or code-defined routes with full TypeScript type safety for params and search params. `exactOptionalPropertyTypes` compatible because route params are never `undefined` on matched routes. Lightweight compared to React Router v7's full-framework mode. Code splitting is built-in via `lazy()` route loading. |

TanStack Router is preferred over React Router because its type inference for route parameters eliminates a class of runtime errors (accessing an absent param) without requiring manual type assertions.

### 2.4 Server State

| Choice | Justification |
|--------|--------------|
| **TanStack Query v5** | De-facto standard for REST API state in React. Provides caching, background refetch, pagination helpers, and optimistic updates. The `exactOptionalPropertyTypes` constraint is handled by using spread patterns in query options — never assigning `undefined` directly to optional properties. Pairs naturally with TanStack Router for loader-based prefetching. |

### 2.5 Client State

| Choice | Justification |
|--------|--------------|
| **Zustand v4** | Minimal boilerplate for the auth session store, setup wizard step state, and editor file tree. Does not require a Provider wrapper. TypeScript support is excellent. Avoids the verbosity of Redux for a UI that has limited global state. |

React context is used only for provider-pattern values that are stable across renders (theme, SDK client instance). Zustand is used for state that changes frequently or is accessed outside of React components.

### 2.6 Form Handling

| Choice | Justification |
|--------|--------------|
| **React Hook Form v7 + Zod** | Zero controlled-component re-renders. Zod schemas are already used platform-wide for API validation — reusing them on the client ensures the wizard and settings forms fail with the same messages as the server. |

### 2.7 Monaco Editor

| Choice | Justification |
|--------|--------------|
| **@monaco-editor/react v4** | The L1 spec (§9) and app-service design (§13) mandate Monaco. `@monaco-editor/react` provides a React component wrapper with lazy loading. The underlying `monaco-editor` package (~4MB gzipped) is loaded on demand via a route-level code split — only Jordan's app developer persona loads it. |

Monaco worker files are served from a CDN (`cdnjs.cloudflare.com/ajax/libs/monaco-editor/`) in production to avoid bundling the language workers. The self-hosted fallback uses Vite's `new URL('./worker', import.meta.url)` worker pattern. See section 11 for full configuration.

### 2.8 Real-Time

| Mechanism | Usage |
|-----------|-------|
| **Native EventSource** | Platform SSE stream at `GET /api/v1/events/stream`. Reconnects automatically. `Last-Event-ID` support is native. |
| **Native WebSocket** | Pipeline run log streaming at `GET /api/v1/pipeline-runs/{id}/logs` (the Gateway upgrades the SSE log streams; the frontend uses `EventSource` for these too). The App Service `/apps/{slug}/ws` WebSocket is used only inside Monaco preview iframes (hosted apps), not by the dashboard itself. |

No third-party real-time library is required. The reconnection logic is owned by the `useSSEStream` hook (see section 8).

### 2.9 Full Dependency Summary

**Runtime dependencies:**

```
react                       ^18.3.0
react-dom                   ^18.3.0
@tanstack/react-router      ^1.0.0
@tanstack/react-query       ^5.0.0
@tanstack/react-query-devtools  ^5.0.0   (dev only, tree-shaken in prod)
zustand                     ^4.5.0
react-hook-form             ^7.52.0
zod                         ^3.23.0
@monaco-editor/react        ^4.6.0
@radix-ui/react-*           (via shadcn/ui — exact versions pinned by shadcn init)
class-variance-authority    ^0.7.0        (shadcn dependency)
clsx                        ^2.1.0        (shadcn dependency)
tailwind-merge              ^2.3.0        (shadcn dependency)
lucide-react                ^0.400.0      (icon set used by shadcn)
recharts                    ^2.12.0       (metrics charts — already in app-sdk allowed list)
date-fns                    ^3.6.0        (date formatting in log viewer, metrics)
```

**Dev dependencies:**

```
vite                        ^5.3.0
@vitejs/plugin-react         ^4.3.0        (React Fast Refresh)
vitest                      ^2.0.0
@testing-library/react      ^16.0.0
@testing-library/user-event ^14.0.0
@testing-library/jest-dom   ^6.4.0
@playwright/test            ^1.45.0
msw                         ^2.3.0        (API mocking for tests)
tailwindcss                 ^4.0.0
autoprefixer                ^10.4.0
typescript                  *             (workspace version)
```

No `@oneplatform/sdk` dependency at runtime — the dashboard builds its own fetch wrapper around the Gateway API (see section 7). The `@oneplatform/app-sdk` is never imported by the dashboard; it is used only inside Monaco-built app bundles.

---

## 3. Project Structure

```
packages/frontend/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── playwright.config.ts
├── vitest.config.ts
├── index.html                         # Vite entry — loads /src/main.tsx
├── nginx.conf                         # Production Nginx config
├── Dockerfile
│
├── src/
│   ├── main.tsx                       # React root, QueryClientProvider, RouterProvider
│   ├── router.tsx                     # TanStack Router instance + route tree
│   │
│   ├── styles/
│   │   └── globals.css                # @import "tailwindcss"; @theme {}; CSS resets
│   │
│   ├── lib/
│   │   ├── api-client.ts              # Typed fetch wrapper — all API calls go here
│   │   ├── query-client.ts            # TanStack QueryClient singleton with defaults
│   │   ├── sse.ts                     # SSE connection factory (useSSEStream internals)
│   │   └── utils.ts                  # cn(), formatDate(), truncate(), etc.
│   │
│   ├── stores/
│   │   ├── auth.store.ts              # Session state (userId, tenantId, roles, isGuest)
│   │   ├── wizard.store.ts            # Setup wizard step + form data across screens
│   │   └── editor.store.ts            # Monaco editor open files, dirty state, active file
│   │
│   ├── hooks/
│   │   ├── use-auth.ts                # useSession(), useRequireAuth(), usePermission()
│   │   ├── use-sse-stream.ts          # EventSource wrapper with reconnect + backoff
│   │   ├── use-pipeline-run-logs.ts   # SSE log follower for pipeline run viewer
│   │   ├── use-build-logs.ts          # SSE log follower for app build viewer
│   │   ├── use-bootstrap-status.ts    # Polls GET /api/v1/auth/bootstrap/status
│   │   └── use-platform-events.ts    # Subscribes to /api/v1/events/stream
│   │
│   ├── components/
│   │   ├── ui/                        # shadcn/ui copies (owned code, not a dependency)
│   │   │   ├── button.tsx
│   │   │   ├── card.tsx
│   │   │   ├── dialog.tsx
│   │   │   ├── dropdown-menu.tsx
│   │   │   ├── form.tsx
│   │   │   ├── input.tsx
│   │   │   ├── label.tsx
│   │   │   ├── select.tsx
│   │   │   ├── separator.tsx
│   │   │   ├── skeleton.tsx
│   │   │   ├── table.tsx
│   │   │   ├── tabs.tsx
│   │   │   ├── textarea.tsx
│   │   │   ├── toast.tsx
│   │   │   ├── toaster.tsx
│   │   │   ├── tooltip.tsx
│   │   │   └── badge.tsx
│   │   │
│   │   ├── layout/
│   │   │   ├── AppShell.tsx           # Sidebar + topbar + main content area
│   │   │   ├── Sidebar.tsx            # Primary navigation with role-gated links
│   │   │   ├── Topbar.tsx             # Tenant name, user menu, notifications bell
│   │   │   └── PageHeader.tsx         # Breadcrumb + page title + action slot
│   │   │
│   │   ├── auth/
│   │   │   ├── LoginForm.tsx          # Email/password form + OAuth buttons
│   │   │   ├── RegisterForm.tsx       # For invite-based registration
│   │   │   ├── OAuthButton.tsx        # GitHub / Google SSO button
│   │   │   └── AuthGuard.tsx          # Redirects unauthenticated to /login
│   │   │
│   │   ├── wizard/
│   │   │   ├── WizardShell.tsx        # Step progress indicator + step renderer
│   │   │   ├── WizardStep.tsx         # Individual step container
│   │   │   ├── steps/
│   │   │   │   ├── WelcomeStep.tsx
│   │   │   │   ├── AdminAccountStep.tsx
│   │   │   │   ├── OrgNameStep.tsx
│   │   │   │   ├── MasterKeyStep.tsx  # 60s auto-clear countdown
│   │   │   │   ├── ReviewStep.tsx
│   │   │   │   └── SuccessStep.tsx
│   │   │   └── MasterKeyDisplay.tsx   # Masked key with copy button + countdown timer
│   │   │
│   │   ├── connectors/
│   │   │   ├── ConnectorCard.tsx
│   │   │   ├── ConnectorForm.tsx      # Dynamic form from connector config schema
│   │   │   ├── ConnectorStatusBadge.tsx
│   │   │   └── SyncProgressBar.tsx
│   │   │
│   │   ├── ontology/
│   │   │   ├── EntityList.tsx
│   │   │   ├── EntityEditor.tsx       # Field/relationship builder
│   │   │   ├── FieldRow.tsx
│   │   │   ├── RelationshipEditor.tsx
│   │   │   ├── MigrationBanner.tsx    # Pending migration alert with confirm/rollback
│   │   │   └── SchemaInferencePanel.tsx  # CSV upload → inferred schema review (Casey)
│   │   │
│   │   ├── pipelines/
│   │   │   ├── PipelineCard.tsx
│   │   │   ├── PipelineBuilder.tsx    # Step-based visual builder
│   │   │   ├── PipelineStepNode.tsx
│   │   │   ├── RunStatusBadge.tsx
│   │   │   ├── RunHistoryTable.tsx
│   │   │   └── RunLogViewer.tsx       # SSE log follower with level filter + search
│   │   │
│   │   ├── apps/
│   │   │   ├── AppCard.tsx
│   │   │   ├── AppDeployButton.tsx
│   │   │   ├── AppRollbackDialog.tsx
│   │   │   ├── BuildHistoryTable.tsx
│   │   │   └── BuildStatusBadge.tsx
│   │   │
│   │   ├── editor/
│   │   │   ├── AppEditor.tsx          # Full-page Monaco editor layout
│   │   │   ├── FileTree.tsx           # VFS file browser (left panel)
│   │   │   ├── EditorPane.tsx         # Monaco instance (center panel)
│   │   │   ├── PreviewPane.tsx        # iframe pointing to /apps/{slug}/preview (right panel)
│   │   │   ├── BuildErrorPanel.tsx    # Inline esbuild error display
│   │   │   ├── FileTreeNode.tsx
│   │   │   └── EditorToolbar.tsx      # Save, build, deploy, file ops
│   │   │
│   │   ├── logs/
│   │   │   ├── LogViewer.tsx          # Virtualized log table with level filter
│   │   │   ├── LogRow.tsx
│   │   │   ├── AuditLogTable.tsx
│   │   │   └── TraceIdLink.tsx        # Click-to-copy trace ID
│   │   │
│   │   ├── dlq/
│   │   │   ├── DLQTable.tsx
│   │   │   ├── DLQJobDetail.tsx
│   │   │   └── DLQActions.tsx         # Replay / discard buttons
│   │   │
│   │   ├── metrics/
│   │   │   ├── MetricsDashboard.tsx   # Recharts-based metrics panels
│   │   │   ├── PipelineThroughputChart.tsx
│   │   │   ├── ErrorRateChart.tsx
│   │   │   ├── ServiceHealthGrid.tsx  # /healthz status per service
│   │   │   └── QueueDepthChart.tsx
│   │   │
│   │   ├── plugins/
│   │   │   ├── PluginCard.tsx
│   │   │   ├── PluginInstallDialog.tsx
│   │   │   ├── PluginConfigForm.tsx   # Dynamic form from manifest configSchema
│   │   │   └── PluginStatusBadge.tsx
│   │   │
│   │   └── shared/
│   │       ├── ErrorBoundary.tsx      # Route-level React error boundary
│   │       ├── EmptyState.tsx         # Consistent zero-state component
│   │       ├── ConfirmDialog.tsx      # Generic destructive action confirmation
│   │       ├── CopyButton.tsx         # Click-to-copy with success feedback
│   │       ├── StatusIndicator.tsx    # Colored dot + label for statuses
│   │       ├── VirtualizedList.tsx    # react-window wrapper for large lists
│   │       ├── InfiniteTable.tsx      # Cursor-paginated table with TanStack Query
│   │       └── RelativeTime.tsx       # "3 minutes ago" with tooltip for absolute time
│   │
│   └── pages/
│       ├── wizard/
│       │   └── WizardPage.tsx         # Route: / (when bootstrap incomplete)
│       │
│       ├── auth/
│       │   ├── LoginPage.tsx          # Route: /login
│       │   ├── CallbackPage.tsx       # Route: /auth/callback (OAuth return)
│       │   ├── ForgotPasswordPage.tsx # Route: /forgot-password
│       │   └── ResetPasswordPage.tsx  # Route: /reset-password/:token
│       │
│       ├── dashboard/
│       │   └── DashboardPage.tsx      # Route: / (after bootstrap) — overview widgets
│       │
│       ├── connectors/
│       │   ├── ConnectorsPage.tsx     # Route: /connectors
│       │   ├── ConnectorDetailPage.tsx # Route: /connectors/:id
│       │   └── NewConnectorPage.tsx   # Route: /connectors/new
│       │
│       ├── ontology/
│       │   ├── OntologyPage.tsx       # Route: /ontology
│       │   ├── EntityDetailPage.tsx   # Route: /ontology/:entityType
│       │   └── MigrationsPage.tsx     # Route: /ontology/migrations
│       │
│       ├── pipelines/
│       │   ├── PipelinesPage.tsx      # Route: /pipelines
│       │   ├── PipelineDetailPage.tsx # Route: /pipelines/:id
│       │   ├── PipelineBuilderPage.tsx # Route: /pipelines/:id/edit
│       │   └── RunDetailPage.tsx      # Route: /pipeline-runs/:runId
│       │
│       ├── apps/
│       │   ├── AppsPage.tsx           # Route: /apps
│       │   ├── AppDetailPage.tsx      # Route: /apps/:id
│       │   └── AppEditorPage.tsx      # Route: /apps/:id/edit (Monaco)
│       │
│       ├── logs/
│       │   ├── LogsPage.tsx           # Route: /logs
│       │   └── AuditPage.tsx          # Route: /logs/audit
│       │
│       ├── dlq/
│       │   └── DLQPage.tsx            # Route: /dlq
│       │
│       ├── metrics/
│       │   └── MetricsPage.tsx        # Route: /metrics
│       │
│       ├── plugins/
│       │   ├── PluginsPage.tsx        # Route: /plugins
│       │   └── PluginDetailPage.tsx   # Route: /plugins/:id
│       │
│       ├── settings/
│       │   ├── SettingsPage.tsx       # Route: /settings (layout wrapper)
│       │   ├── ProfilePage.tsx        # Route: /settings/profile
│       │   ├── TeamsPage.tsx          # Route: /settings/teams
│       │   ├── ApiKeysPage.tsx        # Route: /settings/api-keys
│       │   ├── WebhooksPage.tsx       # Route: /settings/webhooks
│       │   └── AdminPage.tsx          # Route: /settings/admin (platform-admin only)
│       │
│       └── NotFoundPage.tsx           # Route: * (catch-all)
```

---

## 4. Routing Structure

### 4.1 Route Tree

All routes are defined in `src/router.tsx` using TanStack Router's `createRouter` and `createRoute` API.

```
RootRoute (AppShell layout, auth guard)
├── /                          → BootstrapGate → WizardPage | DashboardPage
├── /login                     → LoginPage (no auth guard)
├── /auth/callback             → CallbackPage (handles OAuth redirect)
├── /forgot-password           → ForgotPasswordPage (no auth guard)
├── /reset-password/$token     → ResetPasswordPage (no auth guard)
│
├── (authenticated)
│   ├── /connectors            → ConnectorsPage
│   ├── /connectors/new        → NewConnectorPage
│   ├── /connectors/$id        → ConnectorDetailPage
│   │
│   ├── /ontology              → OntologyPage
│   ├── /ontology/migrations   → MigrationsPage
│   ├── /ontology/$entityType  → EntityDetailPage
│   │
│   ├── /pipelines             → PipelinesPage
│   ├── /pipelines/$id         → PipelineDetailPage
│   ├── /pipelines/$id/edit    → PipelineBuilderPage
│   ├── /pipeline-runs/$runId  → RunDetailPage
│   │
│   ├── /apps                  → AppsPage
│   ├── /apps/$id              → AppDetailPage
│   ├── /apps/$id/edit         → AppEditorPage (lazy — loads Monaco)
│   │
│   ├── /logs                  → LogsPage
│   ├── /logs/audit            → AuditPage
│   │
│   ├── /dlq                   → DLQPage
│   ├── /metrics               → MetricsPage
│   │
│   ├── /plugins               → PluginsPage
│   ├── /plugins/$id           → PluginDetailPage
│   │
│   └── /settings              → SettingsPage (layout)
│       ├── /settings/profile  → ProfilePage
│       ├── /settings/teams    → TeamsPage
│       ├── /settings/api-keys → ApiKeysPage
│       ├── /settings/webhooks → WebhooksPage
│       └── /settings/admin    → AdminPage (requires platform-admin role)
│
└── *                          → NotFoundPage
```

### 4.2 Bootstrap Gate

The root `/` route has a loader that calls `GET /api/v1/auth/bootstrap/status` before rendering. The response determines which component renders:

```typescript
// src/router.tsx
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  loader: async ({ context }) => {
    const status = await context.apiClient.getBootstrapStatus();
    return { bootstrapComplete: status.completed };
  },
  component: BootstrapGate,
});

function BootstrapGate() {
  const { bootstrapComplete } = indexRoute.useLoaderData();
  if (!bootstrapComplete) return <WizardPage />;
  return <AuthGuard><DashboardPage /></AuthGuard>;
}
```

This check runs on every load of `/`. After bootstrap completes the endpoint permanently returns `{ completed: true }`, so the overhead is a single lightweight GET request cached by TanStack Query for 60 seconds.

### 4.3 Auth Guard

`AuthGuard` checks the auth store (populated on mount via `GET /api/v1/auth/me`). On missing session it redirects to `/login` with `?redirect={currentPath}` so the user is returned after successful login.

```typescript
function AuthGuard({ children }: { children: React.ReactNode }) {
  const { session, isLoading } = useSession();
  const navigate = useNavigate();

  if (isLoading) return <FullPageSpinner />;
  if (!session) {
    navigate({ to: "/login", search: { redirect: window.location.pathname } });
    return null;
  }
  return <>{children}</>;
}
```

### 4.4 Route-Level Code Splitting

Every top-level page is lazy-loaded via TanStack Router's `lazy` option. The Monaco editor chunk (~4MB) is only loaded when the user navigates to `/apps/$id/edit`.

```typescript
const appEditorRoute = createRoute({
  path: "/apps/$id/edit",
  component: lazy(() => import("./pages/apps/AppEditorPage")),
});
```

This keeps the initial bundle below 200KB (gzipped) for the login and dashboard views.

### 4.5 Route Parameters

All route parameters are typed by TanStack Router:

```typescript
// /connectors/$id
const connectorDetailRoute = createRoute({
  path: "/connectors/$id",
  parseParams: (params) => ({ id: params.id }), // string, never undefined
  component: ConnectorDetailPage,
});
// Inside component:
const { id } = connectorDetailRoute.useParams(); // string — no undefined guard needed
```

---

## 5. State Management

### 5.1 Three Layers

| Layer | Tool | Examples |
|-------|------|---------|
| **Server state** | TanStack Query | Connectors list, pipeline runs, app builds, logs |
| **Global client state** | Zustand | Auth session, setup wizard data, editor open files |
| **Local component state** | `useState` / `useReducer` | Form inputs, dialog open/closed, dropdown open |

No state library is used for things that TanStack Query already manages. Rule: if it comes from the server, TanStack Query owns it.

### 5.2 Auth Store

```typescript
// src/stores/auth.store.ts
interface AuthState {
  userId: string | null;
  tenantId: string | null;
  roles: string[];
  scopes: string[];
  isGuest: boolean;
  emailVerified: boolean;
  isLoading: boolean;
  // Actions — never assign undefined to optional properties (exactOptionalPropertyTypes)
  setSession: (session: Session) => void;
  clearSession: () => void;
}
```

The auth store is populated by a single query on app mount (`GET /api/v1/auth/me`). On 401 responses from any API call, a global query error handler clears the store and redirects to `/login`.

### 5.3 Wizard Store

```typescript
// src/stores/wizard.store.ts
interface WizardState {
  currentStep: 0 | 1 | 2 | 3 | 4 | 5;
  adminEmail: string;
  adminPassword: string;
  orgName: string;
  masterKeyAcknowledged: boolean;
  // Actions
  goToStep: (step: WizardState["currentStep"]) => void;
  updateField: <K extends keyof WizardData>(key: K, value: WizardData[K]) => void;
  reset: () => void;
}
```

The wizard store is ephemeral — it holds form data only during the bootstrap flow. It is reset to initial state after the `POST /api/v1/auth/bootstrap` succeeds. The `adminPassword` field is cleared from store immediately after the bootstrap POST fires (it is never persisted beyond that).

### 5.4 Editor Store

```typescript
// src/stores/editor.store.ts
interface EditorState {
  appId: string | null;
  openFiles: Map<string, OpenFile>; // path → { content, isDirty, fileVersion }
  activeFilePath: string | null;
  buildStatus: "idle" | "building" | "success" | "failed";
  lastBuildId: string | null;
  // Actions
  openFile: (path: string, content: string, fileVersion: number) => void;
  closeFile: (path: string) => void;
  markDirty: (path: string, content: string) => void;
  markSaved: (path: string, fileVersion: number) => void;
  setBuildStatus: (status: EditorState["buildStatus"], buildId?: string) => void;
}
```

### 5.5 TanStack Query Configuration

```typescript
// src/lib/query-client.ts
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,           // 30 seconds — platform data changes infrequently
      gcTime: 5 * 60 * 1000,      // 5 minutes garbage collection
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.statusCode < 500) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: true,
    },
    mutations: {
      onError: (error) => {
        if (error instanceof ApiError && error.statusCode === 401) {
          authStore.getState().clearSession();
        }
      },
    },
  },
});
```

Query keys follow a consistent hierarchy: `["resource", ...params]`. Examples:
- `["connectors"]` — connector list
- `["connectors", id]` — single connector
- `["pipelines", pipelineId, "runs"]` — runs for a pipeline
- `["apps", appId, "files"]` — VFS file list

---

## 6. Authentication Flow

### 6.1 Overview

The dashboard uses the platform's cookie-based session model. The browser never receives or stores a JWT or refresh token. All authentication state lives in `httpOnly` cookies managed by the server.

```
Dashboard browser
  │
  │ GET /api/v1/auth/me
  │  Cookie: op_session=<httpOnly, not JS-readable>
  ▼
Gateway → Auth Service
  │  validate op_session → { userId, tenantId, roles, scopes }
  ▼
Auth Store ← populated with non-sensitive session data
```

### 6.2 Email/Password Login

```
User fills LoginForm → submit
  │
  POST /api/v1/auth/login  { email, password }
  │
  ← 200 { data: { userId, tenantId } }
  ← Set-Cookie: op_session=...; HttpOnly; Secure; SameSite=Strict
  │
Auth Store.setSession(response.data)
Navigate to redirect param or /
```

The login response body contains non-sensitive profile data. The actual session token is in the `Set-Cookie` header. Client JavaScript never sees the token value.

### 6.3 OAuth / PKCE Flow

The platform supports GitHub and Google OAuth. The dashboard initiates the flow:

```
User clicks "Sign in with GitHub"
  │
  GET /api/v1/auth/oauth/github/authorize
  │
  ← 302 redirect to GitHub with state + code_challenge (PKCE, server-side)
  │
  [GitHub authorization page]
  │
  GET /auth/callback?code=...&state=...   (browser redirected back)
  │
  CallbackPage.tsx:
    POST /api/v1/auth/oauth/github/callback  { code, state }
    ← 200 { data: { userId, tenantId } }
    ← Set-Cookie: op_session=...
    │
  Navigate to / or redirect param
```

The PKCE `code_verifier` is generated and managed server-side (by the Auth Service) because the dashboard is served as an SPA with an implicit registration as a confidential client for the platform's own OAuth flow. The dashboard is NOT an app-platform app and does NOT use the `@oneplatform/app-sdk` PKCE flow.

### 6.4 Session Refresh

Access tokens inside `op_session` are 15-minute JWTs. The server handles refresh transparently via the BFF pattern: when the App Service (for hosted apps) or Auth Service (for the dashboard) detects an expired access token in the session, it uses the embedded refresh token reference to issue a new access token and rotates the cookie.

From the dashboard's perspective: if an API call returns 401, the dashboard retries it once (in case the cookie was just refreshed by a parallel request) and then redirects to `/login` if the retry also fails.

```typescript
// src/lib/api-client.ts — simplified retry on 401
async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",  // always send cookies
  });

  if (response.status === 401) {
    // Attempt one refresh via the auth endpoint
    const refreshed = await fetch("/api/v1/auth/refresh", {
      method: "POST",
      credentials: "include",
    });
    if (!refreshed.ok) {
      authStore.getState().clearSession();
      window.location.href = "/login";
      throw new AuthError("Session expired");
    }
    // Retry the original request once
    return apiFetch<T>(path, init);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(response.status, body);
  }

  return response.json() as Promise<T>;
}
```

### 6.5 Logout

```typescript
async function logout() {
  await apiFetch("/v1/auth/logout", { method: "POST" });
  // Server clears op_session cookie
  authStore.getState().clearSession();
  queryClient.clear();
  window.location.href = "/login";
}
```

`window.location.href` is used (not `navigate`) to force a full page reload, clearing all in-memory state.

### 6.6 Permissions in the Dashboard

The dashboard uses role-based gating for navigation and actions. The `usePermission` hook is implemented as:

```typescript
// src/hooks/use-auth.ts
export function usePermission(requiredRole: string): boolean {
  const roles = useAuthStore((state) => state.roles);
  return roles.includes(requiredRole) || roles.includes("platform-admin");
}
```

Sidebar links and action buttons are hidden (not just disabled) when the user lacks the required role. This is defense-in-depth — the server enforces permissions on every API call.

---

## 7. API Client and Data Fetching

### 7.1 API Client Design

`src/lib/api-client.ts` is the single module through which all API calls flow. It is NOT the `@oneplatform/sdk` (which is designed for server-side and CLI use). The dashboard's client is a thin typed fetch wrapper that:

1. Always sends `credentials: "include"` to propagate the session cookie.
2. Handles 401 with one retry (see section 6.4).
3. Deserializes the standard `{ data: T }` response envelope.
4. Throws typed `ApiError` on non-2xx responses.
5. Does not retry on 4xx (except 401 as above).
6. Retries on 429 after `Retry-After` seconds (max 2 retries).
7. Retries on 5xx with exponential backoff (max 2 retries, 1s/2s delays).

```typescript
// src/lib/api-client.ts

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly requestId: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type ApiResponse<T> = { data: T };
export type PaginatedResponse<T> = {
  data: T[];
  pagination: { nextCursor: string | null; total: number | null };
};
```

The API client is instantiated once and passed via React context:

```typescript
// src/main.tsx
const apiClient = createApiClient({ baseUrl: "" }); // relative — proxied by Nginx
<ApiClientContext.Provider value={apiClient}>
  <RouterProvider router={router} context={{ apiClient }} />
</ApiClientContext.Provider>
```

### 7.2 TanStack Query Integration

All data fetching uses TanStack Query hooks. Query functions call the API client. This is the pattern for every list view:

```typescript
// Example: connector list
export function useConnectors() {
  const client = useApiClient();
  return useQuery({
    queryKey: ["connectors"],
    queryFn: () => client.get<PaginatedResponse<Connector>>("/v1/connectors"),
  });
}
```

For paginated lists (logs, pipeline runs, DLQ):

```typescript
export function usePipelineRuns(pipelineId: string) {
  const client = useApiClient();
  return useInfiniteQuery({
    queryKey: ["pipelines", pipelineId, "runs"],
    queryFn: ({ pageParam }) =>
      client.get<PaginatedResponse<PipelineRun>>(
        "/v1/pipeline-runs",
        // exactOptionalPropertyTypes: conditional spread, never assign undefined
        {
          ...(pageParam ? { cursor: pageParam } : {}),
          filter: { pipelineId },
        },
      ),
    getNextPageParam: (lastPage) => lastPage.pagination.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
  });
}
```

### 7.3 Mutations

Mutations use TanStack Query's `useMutation` with optimistic updates where appropriate:

```typescript
export function useCreateConnector() {
  const client = useApiClient();
  return useMutation({
    mutationFn: (body: CreateConnectorBody) =>
      client.post<Connector>("/v1/connectors", body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connectors"] });
    },
  });
}
```

### 7.4 Request Cancellation

TanStack Query passes an `AbortSignal` to every query function. The API client passes it to `fetch`:

```typescript
queryFn: ({ signal }) => client.get<...>("/v1/connectors", {}, { signal }),
```

This cancels in-flight requests when a component unmounts or a query is superseded by a newer one.

### 7.5 Filter and Sort Parameters

Filter DSL parameters from the API spec (section 6, L1) are typed and serialized by the API client:

```typescript
// src/lib/api-client.ts
function serializeFilters(filters: FilterSpec): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [field, ops] of Object.entries(filters)) {
    for (const [op, value] of Object.entries(ops)) {
      params[`filter[${field}][${op}]`] = String(value);
    }
  }
  return params;
}
```

Type definitions mirror the API filter DSL without runtime validation (the server validates; the client types only).

---

## 8. Real-Time Updates

### 8.1 Platform Events SSE

The `usePlatformEvents` hook manages the single SSE connection to `GET /api/v1/events/stream`:

```typescript
// src/hooks/use-platform-events.ts
export function usePlatformEvents(
  eventFilter: string[],
  handler: (event: PlatformEvent) => void,
): { isConnected: boolean; reconnectCount: number } {
  // Implementation: uses src/lib/sse.ts SSEConnection class
  // - Connects EventSource with Last-Event-ID header
  // - Calls handler on each message
  // - Reconnects with exponential backoff (1s, 2s, 4s, 8s, max 30s)
  // - Tracks Last-Event-ID for replay on reconnect
  // - Heartbeat keepalives (": keepalive" comments) reset the reconnect timer
}
```

The hook is used by the dashboard's pipeline status widget and the metrics page to update displayed state without polling:

```typescript
// In DashboardPage.tsx
usePlatformEvents(["pipeline.*", "ingestion.*"], (event) => {
  if (event.eventType.startsWith("pipeline.")) {
    queryClient.invalidateQueries({ queryKey: ["pipelines"] });
  }
});
```

This pattern — invalidate TanStack Query on event rather than maintaining parallel event state — keeps state management simple. The event is a signal to re-fetch, not a full data payload to merge.

### 8.2 SSE Log Streaming

Pipeline run logs and app build logs are streamed via SSE. These are separate connections from the platform events stream.

```typescript
// src/hooks/use-pipeline-run-logs.ts
export function usePipelineRunLogs(runId: string): {
  logs: LogLine[];
  isComplete: boolean;
  error: string | null;
} {
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [isComplete, setIsComplete] = useState(false);

  useEffect(() => {
    const es = new EventSource(`/api/v1/pipeline-runs/${runId}/logs`, {
      withCredentials: true,
    });

    es.addEventListener("log", (e) => {
      const line = JSON.parse(e.data) as LogLine;
      setLogs((prev) => [...prev, line]);
    });

    es.addEventListener("complete", () => {
      setIsComplete(true);
      es.close();
    });

    es.onerror = () => {
      // EventSource reconnects automatically; isComplete stays false
    };

    return () => es.close();
  }, [runId]);

  return { logs, isComplete, error: null };
}
```

The `RunLogViewer` component renders logs into a virtualized list (`VirtualizedList.tsx`) to handle runs with thousands of log lines without DOM performance degradation.

### 8.3 SSE Connection Factory

`src/lib/sse.ts` encapsulates connection lifecycle for hooks that need more control than raw `EventSource`:

```typescript
// src/lib/sse.ts
export class SSEConnection {
  private es: EventSource | null = null;
  private lastEventId: string | null = null;
  private reconnectDelay = 1000; // ms, doubles each attempt, max 30000

  connect(url: string, handlers: SSEHandlers): void { ... }
  disconnect(): void { ... }
  getLastEventId(): string | null { return this.lastEventId; }
}
```

### 8.4 Real-Time State Updates in the Dashboard

The dashboard reflects real-time pipeline and ingestion state on the overview page. The strategy is:

1. Initial data loaded via TanStack Query on page mount.
2. SSE event arrives → `queryClient.invalidateQueries` for the affected resource.
3. TanStack Query background-refetches → UI updates with fresh server data.

This avoids the complexity of merging SSE event payloads into cached query data. The extra round-trip (one GET after each relevant event) is acceptable for a dashboard that typically has 1-10 active pipelines.

---

## 9. Setup Wizard

### 9.1 Entry Condition

When the user first navigates to `/`, the bootstrap gate (section 4.2) calls `GET /api/v1/auth/bootstrap/status`. If `{ completed: false }`, the `WizardPage` renders. The wizard is the only content on the page — no nav, no sidebar.

### 9.2 Six Screens

| Step | Index | Route segment | Content | Validation |
|------|-------|--------------|---------|------------|
| Welcome | 0 | (none — step 0) | Platform overview, "Get started" CTA | None |
| Admin Account | 1 | — | Email + password + confirm password fields | Zod: email format, password min 12 chars, passwords match |
| Org Name | 2 | — | Tenant/organization name field | Zod: 2–64 chars, no leading/trailing spaces |
| Master Key | 3 | — | Displays master key from `/internal/auth/master-key-display`, 60s countdown auto-clear | User must click "I have saved this key" checkbox to proceed |
| Review | 4 | — | Summary of admin email + org name (password hidden), no master key shown again | None (confirmation step) |
| Success | 5 | — | "Platform ready" message, link to login | None |

### 9.3 Master Key Screen Design

This screen is the most security-sensitive screen in the application.

**Behavior:**

1. On mount, call `GET /internal/auth/master-key-display` (proxied through Gateway, auth not required during bootstrap, single-use endpoint that returns 410 after first access).
2. Display the key in a monospace, masked input. Provide a "Show / Hide" toggle (eye icon) and a "Copy to clipboard" button.
3. Start a 60-second countdown timer. When the timer reaches 0:
   - Clear the displayed key from the DOM (set state to `null`).
   - Replace the display with a warning: "Key display expired for security. Continue only if you have saved the key."
   - The "Next" button remains enabled (continuing without re-display is intentional).
4. Require the user to check a box: "I have securely stored this master key."
5. The key value is never stored in the wizard Zustand store. It is held only in component-local state.

```typescript
// src/components/wizard/MasterKeyDisplay.tsx
export function MasterKeyDisplay() {
  const [key, setKey] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(60);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    fetchMasterKey().then((k) => setKey(k));
  }, []);

  useEffect(() => {
    if (secondsLeft <= 0) {
      setKey(null);
      setIsVisible(false);
      return;
    }
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  // ... render
}
```

### 9.4 Wizard Store and Navigation

The wizard uses `WizardShell.tsx` to render step progress and individual steps. Navigation is forward-only except for a "Back" link on steps 2–4. The Zustand wizard store persists form data across steps so the user can go back without losing input.

On "Finish" (step 4 → submit):
```typescript
const payload = {
  adminEmail: wizardStore.adminEmail,
  adminPassword: wizardStore.adminPassword,
  tenantName: wizardStore.orgName,
  bootstrapToken: "<entered by user on review screen OR fetched earlier>",
};
// POST /api/v1/auth/bootstrap
// On 200: navigate to step 5 (Success), clear store
// On 410: wizard is already complete — redirect to /login
// On 4xx: show error, stay on step 4
```

The bootstrap token is not shown to the user in the wizard — Sam (DevOps) runs `docker compose up`, the services start, and the bootstrap token was already consumed by the Auth Service to secure the endpoint. The `POST /api/v1/auth/bootstrap` body includes the bootstrap token that op-init generated; the wizard collects this via a text input on the Review step labeled "Bootstrap Token (from docker compose logs)".

### 9.5 Accessibility for the Wizard

- Step progress is a `<ol role="list">` with `aria-current="step"` on the active item.
- All form inputs have associated `<label>` elements with `htmlFor`.
- The countdown timer uses `aria-live="polite"` so screen readers announce the remaining time at 30s and 10s.
- The master key field uses `role="textbox"` with `aria-label="Master encryption key"`.
- Errors are announced via `aria-live="assertive"`.

---

## 10. Dashboard Layout and Navigation

### 10.1 Shell Structure

`AppShell.tsx` renders the authenticated application frame:

```
┌─────────────────────────────────────────────────────────────────┐
│ Topbar: [OnePlatform logo] [tenant name] ... [user menu]         │
├──────────┬──────────────────────────────────────────────────────┤
│ Sidebar  │ Main content area                                      │
│ (240px)  │ <PageHeader breadcrumb, title, actions>               │
│          │                                                        │
│ Nav      │ <Route component>                                      │
│ links    │                                                        │
│          │                                                        │
│          │                                                        │
└──────────┴──────────────────────────────────────────────────────┘
```

On screens < 768px (mobile) the sidebar collapses to a hamburger menu. The `AppEditorPage` overrides `AppShell` entirely — the Monaco editor occupies the full viewport with its own toolbar.

### 10.2 Sidebar Navigation

```
OnePlatform

--- Platform ---
  Overview          /
  Connectors        /connectors
  Ontology          /ontology
  Pipelines         /pipelines
  Apps              /apps

--- Observe ---
  Logs              /logs
  Audit             /logs/audit
  DLQ               /dlq
  Metrics           /metrics

--- Extend ---
  Plugins           /plugins

--- Account ---
  Settings          /settings
```

Role gating:
- `Metrics` and `DLQ` are hidden for `viewer` role users.
- `Settings → Admin` is only visible to `platform-admin` and `tenant-admin` roles.
- `Plugins → Install` (action within the Plugins page) requires `plugins:manage` scope.

### 10.3 Dashboard Overview Page

`DashboardPage.tsx` shows three panels:

**Panel 1 — Active Pipelines:**
- List of pipelines with most-recent run status.
- Status badges: queued / running / succeeded / failed / scheduled.
- Live updates via `usePlatformEvents(["pipeline.*"], ...)`.

**Panel 2 — Recent Activity:**
- Last 20 events from `GET /api/v1/logs?limit=20&sort=-createdAt`.
- Shows service name, level (color-coded badge), and message truncated to 120 chars.
- "View all logs" link.

**Panel 3 — Service Health:**
- `ServiceHealthGrid.tsx` polls `GET /healthz` for each of the 9 services every 30 seconds.
- Displays a dot (green/red) and service name.
- Note: these are called via the gateway proxy at `/api/v1/health/{service}` — the frontend never calls internal service ports directly.

### 10.4 Notifications

A notification bell in the `Topbar` tracks:
- Build completions (from platform events SSE).
- Pipeline failures.
- DLQ additions.

Notifications are stored in-memory (local component state, not persisted). Clicking "mark all read" clears them.

---

## 11. Monaco Editor Integration

### 11.1 Layout

`AppEditorPage.tsx` renders a full-viewport three-panel layout when navigating to `/apps/:id/edit`:

```
┌─────────────────────────────────────────────────────────┐
│ EditorToolbar: [app name] [save] [build] [deploy] [...]  │
├───────────┬────────────────────────┬────────────────────┤
│ FileTree  │ EditorPane             │ PreviewPane        │
│ (240px)   │ <Monaco>               │ <iframe>           │
│           │                        │ /apps/{slug}/preview│
│           │                        │                    │
└───────────┴────────────────────────┴────────────────────┘
```

Panel widths are resizable via drag handles. The user's preferred widths are persisted in `localStorage`.

### 11.2 Monaco Loading

`@monaco-editor/react` loads Monaco lazily. The editor route is code-split so Monaco's ~4MB bundle is only fetched when the user navigates to the editor. A loading skeleton with the three-panel layout structure is shown during load.

```typescript
// src/components/editor/EditorPane.tsx
import Editor, { useMonaco } from "@monaco-editor/react";

export function EditorPane({ filePath, content, onChange }: EditorPaneProps) {
  const monaco = useMonaco();

  useEffect(() => {
    if (!monaco) return;
    configureMonaco(monaco);  // compiler options, diagnostics — see section 11.3
  }, [monaco]);

  // ...
}
```

### 11.3 TypeScript Configuration for Monaco

When the editor opens for an app, `EditorPane` fetches type declarations from `GET /api/v1/apps/:id/type-declarations`. This endpoint is defined in the app-service design (section 13.1) and returns ontology-typed interfaces plus SDK augmentation.

```typescript
async function loadTypeDeclarations(appId: string, monaco: Monaco): Promise<void> {
  const response = await apiClient.get<TypeDeclarationsResponse>(
    `/v1/apps/${appId}/type-declarations`,
  );
  for (const decl of response.data.declarations) {
    monaco.languages.typescript.typescriptDefaults.addExtraLib(
      decl.content,
      `file:///node_modules/${decl.filename}`,
    );
  }
}
```

Monaco compiler options (per app-service.md §13.4):

```typescript
function configureMonaco(monaco: Monaco): void {
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ES2020,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
    strict: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    noUnusedLocals: false,
    noUnusedParameters: false,
  });

  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    diagnosticCodesToIgnore: [],
  });
}
```

### 11.4 File Saves (Debounced)

The `EditorPane` calls `onChange` on every keystroke. `AppEditor.tsx` debounces this to 500ms before calling the save API:

```typescript
// src/components/editor/AppEditor.tsx
const debouncedSave = useMemo(
  () =>
    debounce(async (path: string, content: string, fileVersion: number) => {
      try {
        const result = await apiClient.put<AppFile>(
          `/v1/apps/${appId}/files/${encodeURIComponent(path)}`,
          { content, fileVersion },
        );
        editorStore.getState().markSaved(path, result.data.fileVersion);
      } catch (err) {
        if (err instanceof ApiError && err.code === "APP_FILE_VERSION_CONFLICT") {
          toast.error("File modified elsewhere. Reload to merge changes.");
        }
      }
    }, 500),
  [appId],
);
```

The `fileVersion` from the store ensures optimistic locking: concurrent edits from the CLI or another browser session result in a 409 rather than silent overwrites.

### 11.5 File Tree (VFS)

`FileTree.tsx` fetches `GET /api/v1/apps/:id/files` on mount and when files are created/deleted. It renders a tree using the file path hierarchy (grouping by directory prefix). Operations:

- **Create file:** dialog for path + initial content → `PUT /api/v1/apps/:id/files/{path}` with `fileVersion: 0`.
- **Delete file:** confirmation dialog → `DELETE /api/v1/apps/:id/files/{path}`.
- **Rename:** not a native API operation; implemented as create + delete in sequence.

### 11.6 Build Trigger and Log Streaming

`EditorToolbar.tsx` contains the "Build" button:

```typescript
async function triggerBuild() {
  editorStore.getState().setBuildStatus("building");
  const build = await apiClient.post<AppBuild>(`/v1/apps/${appId}/builds`);
  // Open build log panel, connect SSE
  const buildId = build.data.id;
  setBuildLogBuildId(buildId);
  // useBuildLogs hook will connect to /api/v1/apps/:id/builds/:buildId/logs/stream
}
```

`BuildErrorPanel.tsx` renders `error_detail` from the app build record when `status === "failed"`. The error detail is an array of esbuild error objects with `{ file, line, column, message }`. The component renders these as clickable links that jump to the relevant line in the editor.

### 11.7 Preview Pane

`PreviewPane.tsx` renders an `<iframe>` pointing to `/apps/{slug}/preview`. The iframe reloads automatically when a build completes:

```typescript
useEffect(() => {
  const es = new EventSource(
    `/apps/${slug}/preview/reload-stream`,
    { withCredentials: true },
  );
  es.addEventListener("reload", () => {
    if (iframeRef.current) {
      iframeRef.current.src = iframeRef.current.src; // reload
    }
  });
  return () => es.close();
}, [slug]);
```

The preview iframe is sandboxed with `allow-scripts allow-same-origin allow-forms` to permit the app-sdk to function while preventing the hosted app from navigating the parent frame.

### 11.8 Diff View

The build history table (`BuildHistoryTable.tsx`) has a "Diff" action per build. Clicking it opens a modal with Monaco's diff editor comparing the selected build's file snapshot against the current working files:

```typescript
monaco.editor.createDiffEditor(containerRef.current, {
  originalEditable: false,
  readOnly: true,
  renderSideBySide: true,
});
```

File content for historical builds is fetched from `GET /api/v1/apps/:id/builds/:buildId/files/:path`.

---

## 12. Component Library Approach

### 12.1 shadcn/ui Ownership

shadcn/ui components are copied into `src/components/ui/` by running `npx shadcn@latest add <component>`. The generated files are committed to the repository. This means:

- No runtime dependency on shadcn packages.
- Components can be modified freely without breaking upstream updates.
- New components are added via `npx shadcn add`, which generates new files.
- Existing components are updated by re-running add — the diff is reviewed before committing.

All shadcn components use Tailwind CSS classes and Radix UI primitives. They work correctly with Tailwind v4's CSS-first configuration because shadcn uses CSS custom properties (`--radius`, `--primary`, etc.) rather than hardcoded Tailwind color names.

### 12.2 Design Tokens

Design tokens are defined in `src/styles/globals.css` as CSS custom properties inside `@theme {}`:

```css
@import "tailwindcss";

@theme {
  --color-primary: oklch(0.55 0.2 250);
  --color-primary-foreground: oklch(0.98 0 0);
  --color-destructive: oklch(0.55 0.22 25);
  --color-muted: oklch(0.95 0.01 250);
  --color-border: oklch(0.87 0.01 250);
  --radius-md: 0.375rem;
  --radius-lg: 0.5rem;
}
```

Dark mode is supported via a `data-theme="dark"` attribute on `<html>`. All color custom properties have dark-mode overrides in a `[data-theme="dark"] {}` block. The user's preference is persisted in `localStorage["op-theme"]` and applied before first render (inline script in `index.html` to prevent flash of wrong theme).

### 12.3 Component Conventions

**Variant-first:** Every component with visual states uses `class-variance-authority` (cva) variants. Never conditional class string construction.

**No prop drilling for theme:** All theme values come from CSS custom properties. No theme context is passed through props.

**Compound components for complex UI:** `Table`, `Card`, `Dialog` follow compound component patterns (Table.Root, Table.Header, Table.Row, Table.Cell) via Radix slots.

**Polymorphic components:** `Button` accepts an `asChild` prop (Radix Slot) to render as an `<a>` or router `Link` without creating a nested interactive element.

### 12.4 Icon Usage

All icons use `lucide-react`. The package is tree-shakeable — only used icons are bundled. Custom platform-specific icons (e.g., a pipeline DAG icon) are inline SVGs in `src/components/ui/icons/`.

---

## 13. Error Handling and Loading States

### 13.1 Error Boundaries

Every route has an `ErrorBoundary` wrapping it. The boundary catches React rendering errors and shows an `ErrorState` component with the error message and a "Reload page" button. Errors are logged to the console (never to a third-party service from the frontend — this is self-hosted software).

```typescript
// src/components/shared/ErrorBoundary.tsx
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback?: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  // ...standard implementation with componentDidCatch
}
```

TanStack Router provides per-route `errorComponent` which renders on loader failure. This is separate from component-level error boundaries.

### 13.2 API Error Display

The `ApiError` class carries `code`, `message`, `requestId`, and optional `details`. Display policy:

| HTTP status | What the user sees |
|-------------|-------------------|
| 400 (validation) | Inline field errors from `details` (RHF integration), or toast with `message` |
| 401 | Redirect to `/login` (silently — no toast) |
| 403 | Toast: "You don't have permission to do this." (no technical detail) |
| 404 | Inline empty state on the affected section |
| 409 | Toast with the server's `message` (conflict messages are user-readable) |
| 422 | Inline field errors from Zod validation `details` |
| 429 | Toast: "Too many requests. Retrying in {retryAfter}s." |
| 5xx | Toast: "Something went wrong. Request ID: {requestId}" + copy button |

The `requestId` shown on 5xx errors enables Sam (DevOps) to correlate with `op logs query --trace-id {requestId}`.

### 13.3 Loading States

Every data-fetching component handles three states:

1. **Loading:** Skeleton (`Skeleton.tsx` from shadcn). Skeletons match the shape of the content they replace (table skeletons, card skeletons) to prevent layout shift.
2. **Error:** `EmptyState.tsx` with an error icon and "Retry" button that calls `refetch()`.
3. **Empty:** `EmptyState.tsx` with a context-appropriate message and CTA (e.g., "No connectors yet. Add your first connector.").

The loading state is never a full-page spinner except for the initial auth check on app mount.

### 13.4 Mutation Feedback

All mutations provide immediate feedback via the toast system (`useToast()` from shadcn). Pattern:

```typescript
const createConnector = useCreateConnector();

async function handleSubmit(values: FormValues) {
  try {
    await createConnector.mutateAsync(values);
    toast({ title: "Connector created", variant: "success" });
    navigate({ to: "/connectors" });
  } catch (err) {
    if (err instanceof ApiError) {
      toast({ title: err.message, variant: "destructive" });
    }
  }
}
```

Buttons show a loading spinner and are disabled during mutation execution to prevent double submission.

---

## 14. Accessibility

### 14.1 Target Standard

WCAG 2.1 AA. No WCAG 2.2 or ARIA 1.2 features required beyond what Radix UI provides out of the box.

### 14.2 Radix UI Foundation

shadcn/ui is built on Radix UI primitives. Radix provides:

- Keyboard navigation (arrow keys, Enter, Escape) for menus, dialogs, and selects.
- Focus trapping in modals and dialogs.
- `aria-expanded`, `aria-haspopup`, `aria-selected`, `aria-disabled` on interactive elements.
- Screen reader announcements for state changes via `aria-live` regions.

The primary accessibility obligation is correct semantic HTML structure and contrast ratios.

### 14.3 Semantic HTML

| Component | Semantic element |
|-----------|----------------|
| Page header | `<header>` with `<h1>` |
| Sidebar nav | `<nav aria-label="Primary navigation">` with `<ul>` and `<li>` |
| Data tables | `<table>` with `<thead>`, `<th scope="col">`, `<tbody>` |
| Form errors | `<p aria-live="assertive">` linked to input via `aria-describedby` |
| Step progress | `<ol role="list">` with `aria-current="step"` |
| Status badges | `<span role="status">` or inline text with screen-reader-only context |

### 14.4 Color Contrast

All text meets AA minimum:
- Normal text (< 18pt): 4.5:1 minimum contrast ratio.
- Large text (≥ 18pt): 3:1 minimum.
- Status colors (badge backgrounds): contrast is supplemented by icons and text labels. Color is never the sole indicator of status.

Design tokens use OKLCH color space for perceptually uniform contrast calculations.

### 14.5 Focus Management

- The app shell sets focus to the main content region on route changes (using a `focus()` call on a `<main tabIndex={-1}>` element after navigation).
- Modal dialogs return focus to the trigger element on close.
- The Monaco editor's Tab key behavior is preserved (indentation); users can press Escape followed by Tab to exit the editor and navigate to the next focusable element.

### 14.6 Keyboard Shortcuts

| Shortcut | Action | Context |
|----------|--------|---------|
| `Ctrl/Cmd+S` | Save current file | Monaco editor |
| `Ctrl/Cmd+Shift+B` | Trigger build | Monaco editor |
| `Ctrl/Cmd+K` | Open command palette (future) | Global |
| `?` | Show keyboard shortcut help | Global |

All shortcuts are discoverable via a `?` help overlay and documented in the `<kbd>` elements in the UI.

### 14.7 Reduced Motion

CSS transitions respect `@media (prefers-reduced-motion: reduce)`. Toast animations, sidebar slide transitions, and modal entry animations are disabled. Implemented via Tailwind's `motion-safe:` and `motion-reduce:` variants.

---

## 15. Performance

### 15.1 Bundle Strategy

Vite produces multiple chunks:

| Chunk | Contents | Approx. gzipped size |
|-------|----------|---------------------|
| `index` | React, ReactDOM, TanStack Router, Zustand | ~45KB |
| `query` | TanStack Query | ~15KB |
| `ui` | shadcn/ui components, Radix, clsx, cva | ~30KB |
| `icons` | lucide-react (used icons only — tree-shaken) | ~10KB |
| `wizard` | Setup wizard screens, RHF, Zod | ~20KB (lazy) |
| `editor` | Monaco editor wrapper, editor components | ~4MB (lazy) |
| `monaco-worker-ts` | TypeScript language worker | served from CDN |
| `charts` | Recharts | ~80KB (lazy) |
| Per-page chunks | Individual page components | 5–30KB each (lazy) |

The initial page load (login or dashboard for returning user) delivers ≤ 100KB gzipped. Monaco is loaded only when the user navigates to the app editor.

### 15.2 Code Splitting

All routes use `lazy()` loading. Vite's automatic chunk splitting handles vendor deduplication. The Vite config sets `build.rollupOptions.output.manualChunks` for the three large stable vendors (React, TanStack Query, Monaco).

### 15.3 Image and Asset Optimization

- SVG icons are inlined via `?url` or Vite's built-in asset handling (no separate HTTP request for each icon).
- No raster images in the dashboard UI (all iconography is SVG or Lucide).
- Fonts: System font stack only. No web font loading.

### 15.4 Log Viewer Virtualization

The `LogViewer` component renders potentially thousands of log lines. It uses `react-window` (`VariableSizeList`) to render only the visible rows. Rows have variable heights due to multiline log messages. A `useCallback` ref measures row heights and caches them.

### 15.5 TanStack Query Caching

- Connector list: `staleTime: 30s` (changes infrequently).
- Pipeline runs: `staleTime: 10s` (changes more frequently when pipelines are running).
- Logs: `staleTime: 5s` (fresh enough for the paginated log viewer, not the live follower).
- App files: `staleTime: 0` (always refetch — optimistic locking requires fresh fileVersion).

### 15.6 Monaco Worker Offloading

Monaco's TypeScript, JSON, and HTML language workers run in Web Workers, never on the main thread. The `@monaco-editor/react` package handles worker setup. In production builds, workers are loaded from `cdnjs.cloudflare.com` via the `getWorker` option to avoid including them in the Vite build:

```typescript
// vite.config.ts
// In self-hosted environments without CDN access, workers are served from the
// frontend Nginx container at /monaco-workers/
```

The Nginx config serves pre-downloaded worker files at `/monaco-workers/` to support fully offline/air-gapped deployments.

### 15.7 Nginx Caching Headers

```nginx
# nginx.conf — immutable assets (content-hashed filenames)
location ~* \.(js|css)$ {
  add_header Cache-Control "public, max-age=31536000, immutable";
}

# index.html — no cache (always fresh for navigation)
location = /index.html {
  add_header Cache-Control "no-cache, no-store, must-revalidate";
}

# Monaco worker files
location /monaco-workers/ {
  add_header Cache-Control "public, max-age=86400";
}
```

---

## 16. Testing Strategy

### 16.1 Layers

| Layer | Tool | What it tests |
|-------|------|--------------|
| Unit | Vitest | Utility functions, store logic, API client serialization, Zod schemas |
| Component | React Testing Library + Vitest | UI components in isolation, user interactions, accessibility |
| Integration | RTL + msw | Pages with mocked API responses, full render trees |
| E2E | Playwright | Full user workflows in a real browser against real or MSW-mocked APIs |

### 16.2 Unit Tests

```
packages/frontend/src/
├── lib/api-client.test.ts      # serialize filters, retry logic, error parsing
├── lib/sse.test.ts             # reconnect backoff, Last-Event-ID tracking
├── stores/auth.store.test.ts   # state transitions
├── stores/wizard.store.test.ts # step navigation, field updates, password clear
└── lib/utils.test.ts           # cn(), date formatters
```

Vitest runs in `jsdom` environment. No DOM needed for store and utility tests — `environment: 'node'` is used where appropriate.

### 16.3 Component Tests

Pattern for component tests using RTL and `msw`:

```typescript
// src/components/wizard/steps/AdminAccountStep.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminAccountStep } from "./AdminAccountStep";

test("shows password mismatch error", async () => {
  render(<AdminAccountStep onNext={vi.fn()} />);
  await userEvent.type(screen.getByLabelText("Password"), "correct-horse-battery");
  await userEvent.type(screen.getByLabelText("Confirm Password"), "differentpassword");
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Passwords do not match");
});
```

Key component coverage targets:
- Setup wizard: all six screens, validation error display, password clear on unmount, master key countdown.
- `AuthGuard`: redirects unauthenticated users.
- `LogViewer`: renders, filters by level, streams additional lines.
- `AppEditor`: debounced save triggered, 409 conflict toast shown, build trigger.
- `MasterKeyDisplay`: countdown clears key, cannot proceed without acknowledgment.

### 16.4 MSW Setup

`msw` is configured in `src/test/mocks/handlers.ts` with handlers for every API endpoint used in component tests. The mock server starts in `src/test/setup.ts`:

```typescript
// src/test/setup.ts
import { setupServer } from "msw/node";
import { handlers } from "./mocks/handlers";
import "@testing-library/jest-dom/vitest";

const server = setupServer(...handlers);
beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

Individual tests override specific handlers to test error paths:
```typescript
server.use(
  http.post("/api/v1/auth/bootstrap", () =>
    HttpResponse.json({ error: { code: "VALIDATION_ERROR", message: "..." } }, { status: 422 }),
  ),
);
```

### 16.5 E2E Tests (Playwright)

E2E tests live in `packages/frontend/playwright/`. They run against a full-stack environment (Docker Compose test profile) or against the Vite dev server with MSW for faster iteration.

**Critical E2E flows:**

| Test file | Flow covered |
|-----------|-------------|
| `wizard.spec.ts` | Sam's full bootstrap: GET /api/v1/auth/bootstrap/status → six wizard screens → POST /api/v1/auth/bootstrap → login |
| `auth.spec.ts` | Login, logout, OAuth callback, password reset |
| `connectors.spec.ts` | Alex: create connector → test connection → view sync progress |
| `pipeline-builder.spec.ts` | Alex: create pipeline → add steps → trigger → view run logs |
| `app-editor.spec.ts` | Jordan: create app → open editor → edit file → trigger build → view errors → deploy |
| `csv-upload.spec.ts` | Casey: upload CSV → confirm inferred schema → generate starter app |
| `dlq.spec.ts` | Sam: view DLQ → replay job → discard job |

### 16.6 Accessibility Tests

`axe-core` is integrated with Playwright via `@axe-core/playwright`. Every E2E test calls `checkA11y()` on the main content area after page load. This catches contrast, missing labels, and focus-order issues automatically.

Component tests use `@testing-library/jest-dom`'s ARIA queries (`getByRole`, `getByLabelText`, `getByText`) which enforce that correct ARIA attributes are present.

### 16.7 Coverage

Vitest coverage is collected with `@vitest/coverage-v8`. CI enforces:
- Lines: ≥ 80%
- Functions: ≥ 80%
- Branches: ≥ 75%

The Monaco editor component and code-split chunks are excluded from coverage requirements — they are covered by E2E tests instead.

---

## 17. Build and Deployment

### 17.1 Vite Configuration

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    target: "es2020",
    outDir: "dist",
    sourcemap: true, // included in dist, served by Nginx only in non-production
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom"],
          "vendor-query": ["@tanstack/react-query"],
          "vendor-router": ["@tanstack/react-router"],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",  // Gateway in local dev
      "/bff": "http://localhost:3006",  // App Service in local dev
    },
  },
});
```

### 17.2 TypeScript Configuration

```jsonc
// packages/frontend/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "noEmit": true, // Vite handles transpilation
    "types": ["vite/client"]
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

`moduleResolution: "Bundler"` is used for the frontend to support Vite's module resolution (extensions optional, package.json exports fields). This differs from the `NodeNext` resolution used in service packages. The discrepancy is intentional: services run in Node; the frontend is built by Vite.

### 17.3 Dockerfile

```dockerfile
# Build stage
FROM node:22-alpine AS builder
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/frontend/package.json ./packages/frontend/
RUN corepack enable && pnpm install --frozen-lockfile
COPY packages/frontend ./packages/frontend
RUN pnpm --filter @oneplatform/frontend build

# Runtime stage
FROM nginx:1.27-alpine AS runtime
COPY --from=builder /app/packages/frontend/dist /usr/share/nginx/html
COPY packages/frontend/nginx.conf /etc/nginx/conf.d/default.conf
# Monaco workers (self-hosted, offline-safe)
COPY packages/frontend/public/monaco-workers /usr/share/nginx/html/monaco-workers
EXPOSE 80
```

### 17.4 Nginx Configuration

```nginx
# packages/frontend/nginx.conf
server {
  listen 80;
  root /usr/share/nginx/html;
  index index.html;

  # Gzip
  gzip on;
  gzip_types text/plain text/css application/javascript application/json;
  gzip_min_length 1024;

  # Security headers
  add_header X-Frame-Options "SAMEORIGIN";
  add_header X-Content-Type-Options "nosniff";
  add_header Referrer-Policy "strict-origin-when-cross-origin";
  add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self' blob:;";

  # Immutable assets
  location ~* \.(js|css|woff2?)$ {
    expires 1y;
    add_header Cache-Control "public, max-age=31536000, immutable";
  }

  # Monaco workers (self-hosted fallback)
  location /monaco-workers/ {
    expires 1d;
    add_header Cache-Control "public, max-age=86400";
  }

  # API proxy → Gateway
  location /api/ {
    proxy_pass http://gateway-service:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    # SSE connections require no buffering
    proxy_buffering off;
    proxy_cache off;
    proxy_set_header Connection "";
    proxy_http_version 1.1;
  }

  # BFF proxy → Gateway (routes internally to App Service)
  location /bff/ {
    proxy_pass http://gateway-service:3000;
    proxy_set_header Host $host;
    proxy_buffering off;
  }

  # SPA fallback — all non-file routes serve index.html
  location / {
    try_files $uri $uri/ /index.html;
    add_header Cache-Control "no-cache, no-store, must-revalidate";
  }
}
```

### 17.5 Turbo Pipeline

```jsonc
// turbo.json addition for frontend
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "inputs": ["src/**", "index.html", "vite.config.ts", "tsconfig.json"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": [],
      "inputs": ["src/**", "src/test/**"],
      "outputs": ["coverage/**"]
    },
    "dev": {
      "dependsOn": [],
      "persistent": true,
      "cache": false
    }
  }
}
```

### 17.6 CI Checks

Frontend CI runs on every PR:

1. `pnpm --filter @oneplatform/frontend lint` — ESLint with `@typescript-eslint/recommended-strict`.
2. `pnpm --filter @oneplatform/frontend test` — Vitest unit + component tests.
3. `pnpm --filter @oneplatform/frontend build` — confirms production build succeeds.
4. Playwright E2E (on CI Docker Compose environment) — runs `wizard.spec.ts` and `auth.spec.ts` as smoke tests. Full E2E suite runs on merge to main.

---

## 18. Security Design

### 18.1 Cookie Security

The dashboard never reads the `op_session` cookie. All API requests include `credentials: "include"` so the browser automatically appends the `httpOnly` cookie. The session value is invisible to JavaScript.

The cookie is `Secure` (HTTPS only), `SameSite=Strict` (no cross-site sending), and `HttpOnly` (no JS access). These three properties together prevent the three most common cookie-based attacks: interception (Secure), CSRF (SameSite), and XSS token theft (HttpOnly).

### 18.2 Content Security Policy

The CSP header (set by Nginx) restricts:

```
default-src 'self'
script-src 'self'
style-src 'self' 'unsafe-inline'     -- Required by Tailwind's dynamic CSS
img-src 'self' data:                  -- data: required for Monaco editor
connect-src 'self'                    -- API and SSE connections only
worker-src 'self' blob:              -- Monaco Web Workers
```

`'unsafe-eval'` is NOT in the policy. Monaco does not require eval in modern versions. This is verified by the CSP test in the E2E suite.

No inline `<script>` tags in the application HTML. The only inline script is the theme-detection snippet in `index.html` (reads `localStorage["op-theme"]`). This snippet is a known exception to the `script-src 'self'` rule — in production, a hash for this exact script is added to the CSP header via the Nginx configuration.

### 18.3 Dependency Security

- `pnpm audit` runs in CI on every PR. High or critical severity findings block merges.
- Dependency updates are managed by Dependabot (weekly grouped updates for minor/patch, manual review for major).
- Monaco editor is treated as a high-risk dependency due to its size and execution model. Updates go through a manual security review checklist.

### 18.4 Input Sanitization

The dashboard displays user-generated content in:
- Log messages (from log viewer)
- App names, connector names, pipeline names
- Error messages from API responses

All such content is rendered as React text nodes (string interpolation in JSX), never via `dangerouslySetInnerHTML`. This prevents XSS by construction — React escapes all string interpolations.

The `PreviewPane` renders hosted apps in a sandboxed `<iframe>`. The iframe `sandbox` attribute is set to `allow-scripts allow-same-origin allow-forms`. The hosted app cannot access the parent frame's DOM or navigate the top-level browsing context.

### 18.5 No Secrets in Frontend Code

The frontend has no hardcoded API keys, tokens, or credentials. All secrets are in `httpOnly` cookies managed by the server. The Vite build does not inline any `OP_*` environment variables — all configuration reaches the frontend through the session cookie and the `window.__OP_APP_CONFIG__` injection (which contains only `appId` and `tenantId`).

---

## 19. TypeScript Conventions

### 19.1 exactOptionalPropertyTypes

The monorepo's `exactOptionalPropertyTypes: true` setting means `undefined` cannot be assigned to optional properties. All conditional properties use spread:

```typescript
// CORRECT
const options = {
  queryKey: ["connectors"],
  ...(cursor ? { cursor } : {}),
};

// INCORRECT — TypeScript error under exactOptionalPropertyTypes
const options = {
  queryKey: ["connectors"],
  cursor: cursor ?? undefined, // Error: Type 'string | undefined' not assignable to 'string'
};
```

This pattern appears throughout query functions, mutation bodies, and route loaders.

### 19.2 noUncheckedIndexedAccess

Array indexing returns `T | undefined`. Every array index access is guarded:

```typescript
// CORRECT
const firstRun = runs[0];
if (firstRun === undefined) return null;

// INCORRECT
const firstRun = runs[0];
console.log(firstRun.status); // Error: possibly undefined
```

For iterating arrays, `for...of` and `.map()` are preferred over index access.

### 19.3 Type-Only Imports

All type-only imports use the `import type` syntax to prevent accidental runtime imports:

```typescript
import type { Connector, ConnectorStatus } from "../types/connector.js";
```

### 19.4 Never Use `any`

The ESLint rule `@typescript-eslint/no-explicit-any` is set to `error`. Unknown data from the API is typed as `unknown` and narrowed:

```typescript
// API error details
const details = (error as ApiError).details; // unknown
if (typeof details === "object" && details !== null && "field" in details) {
  // narrowed
}
```

### 19.5 Discriminated Unions for State

Loading states use discriminated unions rather than multiple boolean flags:

```typescript
type LoadingState<T> =
  | { status: "loading" }
  | { status: "success"; data: T }
  | { status: "error"; error: ApiError };
```

TanStack Query's `status` field follows this pattern; components switch on `status` rather than checking `isLoading && !isError`.

---

## Appendix A: Package Dependencies at a Glance

```
packages/frontend/ → no workspace package dependencies at runtime
  (app-sdk is built into app bundles by App Service, not by the dashboard)

dev:
  pnpm workspace protocol for typescript version alignment
```

The frontend is the only package in the monorepo with zero workspace package dependencies. It consumes the platform through HTTP (the Gateway API), not through imported code. This is intentional: it enforces the architectural boundary between the dashboard (a client) and the platform (a server).

---

## Appendix B: Environment and Configuration

No environment variables are embedded in the frontend build. The Vite build is environment-agnostic — the same `dist/` artifact runs against any platform instance. The only environment-specific configuration is the Nginx proxy target (`gateway-service:3000`), which is a Docker Compose service name that resolves correctly in both single-host and distributed deployments.

The base URL for API calls is always `/api` (relative), relying on the Nginx proxy. This means the frontend works correctly regardless of whether the platform runs on `localhost:80`, `platform.example.com`, or behind a subdirectory reverse proxy.

---

## Appendix C: Relationship to Other L2 Documents

| L2 document | Intersection with frontend |
|-------------|--------------------------|
| `auth-service.md` | Login flow, bootstrap endpoint, OAuth callback shape, `/api/v1/auth/me` response |
| `app-service.md` | VFS file API, build API, BFF endpoints, Monaco type declaration endpoint, SSE log streaming format, preview reload stream |
| `gateway-service.md` | SSE event stream (`/api/v1/events/stream`), API pagination, rate limit headers |
| `sdk-package.md` | NOT used by the dashboard. SDK is for external server-side clients. |
| `app-sdk-package.md` | NOT used by the dashboard. app-sdk is used inside Monaco-built hosted apps only. |
| All service designs | REST API endpoints consumed via `src/lib/api-client.ts` |
