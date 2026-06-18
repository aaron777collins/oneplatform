# Example: Dashboard App

A OnePlatform hosted app that displays a live product catalog. It demonstrates
the three core patterns every app will use:

- **`useQuery`** — paginated data fetching with stale-while-revalidate caching
- **`usePermission`** — synchronous permission checks that control UI visibility
- **`useSubscription`** — real-time entity change events over WebSocket

## How hosted apps work

A hosted app is a React component tree that runs inside the OnePlatform App
Service sandbox. The platform injects `window.__OP_APP_CONFIG__` (containing
`appId` and `tenantId`) before your bundle boots. `AppProvider` reads this
config, fetches the current user and their permissions, opens a WebSocket for
live events, and then renders your component tree.

Your components never talk to the platform API directly — all data flows through
the BFF (backend-for-frontend) layer via the `@oneplatform/app-sdk` hooks.

## Directory structure

```
dashboard-app/
  src/
    App.tsx       — Root component: wraps everything in AppProvider
  package.json   — Dependencies and build scripts
  README.md      — This file
```

## Prerequisites

- Node.js 18+
- The `Product` entity type must exist in your tenant ontology (run
  `examples/data-pipeline/` first to create it).
- Your app registered in the platform: `Settings → Apps → + New App`.

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Start a local dev server (requires the platform's dev proxy — see below)
npm run dev

# 3. Build for deployment
npm run build
```

### Dev proxy

During local development the app still needs the BFF, which is part of the
App Service. The OnePlatform CLI provides a dev proxy that forwards BFF requests
to your running platform instance:

```bash
op app dev \
  --app-id your-app-id \
  --platform https://your-instance.example.com \
  --api-key op_live_...
```

This injects `window.__OP_APP_CONFIG__` and proxies `/bff/*` so all hooks work
against live data without deploying the app first.

## Deploying

```bash
# Build then deploy to the platform
npm run build
op app deploy \
  --app-id your-app-id \
  --dist ./dist \
  --platform https://your-instance.example.com \
  --api-key op_live_...
```

The platform hosts the built bundle and serves it to users who have access to
the app (controlled by the app's `accessMode` setting).
