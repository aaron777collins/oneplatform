---
title: App Developer Quickstart
description: Scaffold an app, deploy it to OnePlatform, and access entity data from React.
sidebar:
  order: 3
---

Scaffold an app, deploy it to OnePlatform, and access entity data from React.

## Prerequisites

- OnePlatform stack running (see [Platform Admin Quickstart](/getting-started/platform-admin))
- Node.js 20+ and npm 10+
- `@oneplatform/cli` installed globally: `npm install -g @oneplatform/cli`
- Account with `apps:manage` scope

## Setup (3 commands)

```sh
# 1. Log in
op auth login --email developer@example.com

# 2. Scaffold a new app project locally
op app init --name "Customer Dashboard" --slug "customer-dashboard"

# 3. Enter the scaffolded directory and install dependencies
cd customer-dashboard && npm install
```

## First working example

### Step 1: Explore the scaffold

The scaffold creates:

```
customer-dashboard/
  src/
    App.tsx          # Root component using AppProvider and useQuery
    index.ts         # Entry point
  app.manifest.json  # App metadata (name, version, entrypoint)
  tsconfig.json
  vite.config.ts
  package.json
```

`src/App.tsx` starts with a minimal working example:

```tsx
import { AppProvider, useQuery } from "@oneplatform/app-sdk";

function CustomerList() {
  const { data, isLoading, error } = useQuery("customer");
  if (isLoading) return <p>Loading...</p>;
  if (error) return <p>Error: {error.message}</p>;
  return <ul>{data?.map((c) => <li key={c.id}>{c.name}</li>)}</ul>;
}

export default function App() {
  return (
    <AppProvider>
      <CustomerList />
    </AppProvider>
  );
}
```

### Step 2: Develop locally

```sh
npm run dev
```

The dev server reloads on file changes. The platform injects runtime configuration
through `window.__OP_APP_CONFIG__` — the `AppProvider` reads this automatically.

### Step 3: Register and deploy the app

```sh
# Register the app on the platform (creates the app record)
op app create --name "Customer Dashboard" --slug "customer-dashboard"

# Build the bundle
npm run build

# Deploy the built bundle
op app deploy customer-dashboard --file dist/bundle.js
```

Expected output:

```
App deployed: customer-dashboard
Deployment ID: <uuid>
URL: http://localhost:8080/apps/customer-dashboard
```

### Bundle format for `op app deploy --file`

| Property | Requirement |
|---|---|
| File type | Single `.js` file |
| Module format | ES module (`type: "module"`) |
| Default export | React component accepting no props |
| Maximum size | 50 MB |
| `@oneplatform/app-sdk` | Must be externalized (not bundled) |

Build with Vite (`lib` mode, `external: ["@oneplatform/app-sdk"]`) or esbuild:

```sh
esbuild src/index.ts --bundle --format=esm \
  --external:@oneplatform/app-sdk --outfile=dist/bundle.js
```

### Generate TypeScript types from your ontology

```sh
# Writes op-types.d.ts in the current directory
op sdk generate-types
```

Then use types for safe queries:

```tsx
import type { EntityTypeMap } from "@oneplatform/app-sdk";
const { data } = useQuery<EntityTypeMap["customer"]>("customer");
```

## Next steps

- `op app --help` — list, update, and manage deployed apps
- [SDK Reference — app-sdk](/sdk/app-sdk) — full `useQuery` API including filters and pagination
- [Plugin Developer Quickstart](/getting-started/plugin-developer) — extend the platform with plugins
