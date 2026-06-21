# @oneplatform/app-sdk

React hooks and context for OnePlatform hosted apps.

Hosted apps run inside the platform's app sandbox. The SDK connects your React
components to platform data, real-time events, permissions, and per-user
storage through a BFF (Backend-for-Frontend) layer — without requiring your
app to manage authentication or API keys directly.

## Installation

```sh
pnpm add @oneplatform/app-sdk
```

## Quick Start

```tsx
import { AppProvider, useQuery, useMutation } from '@oneplatform/app-sdk';

function Root() {
  return (
    <AppProvider>
      <ProductList />
    </AppProvider>
  );
}

function ProductList() {
  const { data, isLoading, fetchNextPage } = useQuery<Product>('Product', {
    filter: { status: { eq: 'active' } },
    sort: ['-createdAt'],
    limit: 20,
  });

  if (isLoading) return <div>Loading...</div>;

  return (
    <>
      <ul>
        {data?.map((p) => <li key={p.id}>{p.name}</li>)}
      </ul>
      <button onClick={fetchNextPage}>Load more</button>
    </>
  );
}
```

## AppProvider Setup

Wrap your app's root component with `AppProvider`. It fetches the current
user, seeds the permission cache, and establishes the WebSocket connection
for real-time subscriptions before rendering children. All SDK hooks require
an `AppProvider` ancestor.

```tsx
import { AppProvider } from '@oneplatform/app-sdk';

function App() {
  return (
    <AppProvider>
      {/* your components */}
    </AppProvider>
  );
}
```

The provider performs no configuration — authentication is handled by the
platform sandbox at the transport layer.

## Development Setup

In production, `AppProvider` reads runtime configuration from
`window.__OP_APP_CONFIG__`, which is injected by the App Service HTML shell.
This global is **not** present when running your app standalone with `vite dev`
or a custom dev server.

### Option 1: config prop (recommended)

Pass a `config` prop directly to `AppProvider`. It takes precedence over
`window.__OP_APP_CONFIG__` and avoids any need to set window globals.

```tsx
// src/dev-entry.tsx — dev entry point only, not imported in production
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppProvider } from '@oneplatform/app-sdk';
import { App } from './App.js';

const devConfig = {
  appId: 'my-app-dev',      // any string; matched against platform config
  tenantId: 'dev-tenant',   // your development tenant ID
  appSlug: 'my-app',        // optional; used for WebSocket URL
};

createRoot(document.getElementById('root')!).render(
  <AppProvider config={devConfig} bffBaseUrl="http://localhost:4000">
    <App />
  </AppProvider>,
);
```

Configure `vite.config.ts` to use `dev-entry.tsx` as the entry point in dev
mode and `src/main.tsx` (which uses `<AppProvider>` without a config prop) for
production builds.

### Option 2: window global in dev HTML

Alternatively, set `window.__OP_APP_CONFIG__` in your dev `index.html` before
the app bundle loads:

```html
<!-- index.html (dev only) -->
<script>
  window.__OP_APP_CONFIG__ = {
    appId: "my-app-dev",
    tenantId: "dev-tenant",
    appSlug: "my-app"
  };
</script>
```

This mirrors exactly what the production App Service shell injects, making the
dev environment behave identically to production.

## Hooks

### `useQuery`

Fetches entity records with filtering, sorting, and cursor pagination.
Implements stale-while-revalidate: cached data is returned immediately while
a background refetch runs if the entry is older than `staleTime` (default
30 seconds).

```tsx
import { useQuery } from '@oneplatform/app-sdk';

function OrderList() {
  const { data, isLoading, isError, error, refetch, fetchNextPage } =
    useQuery<Order>('Order', {
      filter: { status: { eq: 'pending' } },
      sort: ['-createdAt'],
      fields: ['id', 'customerId', 'total', 'status'],
      limit: 50,
      staleTime: 60_000,       // treat cache as fresh for 60 seconds
      enabled: isAuthenticated, // skip fetch until condition is true
      onError: (err) => console.error(err.message),
    });

  if (isLoading) return <Spinner />;
  if (isError) return <ErrorBanner message={error?.message} />;

  return (
    <>
      {data?.map((order) => <OrderRow key={order.id} order={order} />)}
      <button onClick={fetchNextPage}>Load more</button>
      <button onClick={refetch}>Refresh</button>
    </>
  );
}
```

**Performance note:** Pass a stable `options` object to avoid unnecessary
re-fetches. The cache key is built from `entity + filter + sort + fields +
limit` — a new object literal on every render changes the key even when the
values are identical.

```tsx
// Correct — memoize options to prevent refetch loops
const queryOptions = useMemo(
  () => ({ filter: { status: { eq: activeFilter } } }),
  [activeFilter],
);
const { data } = useQuery('Order', queryOptions);
```

### `useMutation`

Provides `create`, `update`, `replace`, `remove`, and `bulkCreate` operations.
All mutations apply optimistic updates immediately and revert on failure.
Concurrent mutations to the same entity are serialised automatically.

```tsx
import { useMutation } from '@oneplatform/app-sdk';

function NewProductForm() {
  const { create, isLoading, isError, error, reset } = useMutation<Product>('Product');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const product = await create({ name: 'New Widget', price: 29.99 });
      console.log('Created:', product.id);
    } catch (err) {
      // error state is already set by the hook
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      {/* form fields */}
      {isError && <p>{error?.message} <button onClick={reset}>Dismiss</button></p>}
      <button type="submit" disabled={isLoading}>Save</button>
    </form>
  );
}
```

All mutation methods:

```tsx
const { create, update, replace, remove, bulkCreate } = useMutation<Product>('Product');

// Create
const product = await create({ name: 'Widget', price: 10 });

// Partial update (PATCH)
await update(product.id, { price: 9.99 });

// Full replace (PUT)
await replace(product.id, { name: 'Widget', price: 9.99, status: 'active' });

// Delete
await remove(product.id);

// Bulk create
const result = await bulkCreate([
  { name: 'A', price: 1 },
  { name: 'B', price: 2 },
]);
// result.created: number, result.errors: Array<{ index, error }>
```

### `useSubscription`

Subscribes to real-time entity events via WebSocket. The connection is shared
across all `useSubscription` calls in the app — opening multiple subscriptions
does not open multiple connections.

```tsx
import { useSubscription } from '@oneplatform/app-sdk';

function LiveOrderFeed() {
  const { lastEvent, isConnected } = useSubscription<Order>('Order', {
    events: ['created', 'updated'],    // filter to specific event types
    autoInvalidate: true,              // automatically refetch useQuery on event (default: true)
    onEvent: (event) => {
      console.log(event.type, event.data);
    },
  });

  return (
    <div>
      <span>{isConnected ? 'Live' : 'Reconnecting...'}</span>
      {lastEvent && (
        <p>Last update: {lastEvent.type} — {lastEvent.data.id}</p>
      )}
    </div>
  );
}
```

`autoInvalidate: true` (the default) causes active `useQuery` hooks for the
same entity to re-fetch automatically when an event arrives, keeping list
views in sync without manual cache management.

### `usePermission`

Synchronous permission check. Never suspends or causes a loading state because
the permission cache is seeded before `AppProvider` renders children.

```tsx
import { usePermission } from '@oneplatform/app-sdk';

function DeleteButton({ productId }: { productId: string }) {
  // Returns false when still loading or when permission is absent
  const canDelete = usePermission('delete', 'Product');

  if (!canDelete) return null;

  return <button onClick={() => handleDelete(productId)}>Delete</button>;
}
```

Permission model:
- `admin:*` — grants all actions on all resources
- `admin:{resource}` — grants all actions on the given resource
- `{action}:*` — grants the given action on any resource
- `{action}:{resource}` — exact match

The cache refreshes automatically on window focus and every 5 minutes in the
background.

### `useUser`

Returns the current user context, populated by `AppProvider` at mount from
`GET /bff/me`. No network calls per render.

```tsx
import { useUser } from '@oneplatform/app-sdk';

function Header() {
  const { displayName, email, roles, tenantId } = useUser();

  return (
    <header>
      <span>{displayName}</span>
      <span>{tenantId}</span>
    </header>
  );
}
```

Returns a safe sentinel with empty strings (not `null`) while the provider is
loading, so you never need conditional hook usage or null checks.

```ts
interface UserContext {
  id: string;
  email: string | null;
  displayName: string;
  tenantId: string;
  roles: string[];
  isGuest: boolean;
}
```

### `useAppStorage`

Per-app, per-user persistent storage backed by the App Service. Values survive
browser refresh because they are stored server-side, not in `localStorage`.

```tsx
import { useAppStorage } from '@oneplatform/app-sdk';

function ThemeSelector() {
  const [theme, setTheme, { isLoading }] = useAppStorage<'light' | 'dark'>(
    'ui-theme',
    'light', // default value until BFF fetch completes
  );

  if (isLoading) return null;

  return (
    <select value={theme} onChange={(e) => setTheme(e.target.value as 'light' | 'dark')}>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  );
}
```

Key constraints:
- 1–128 characters, alphanumeric plus hyphens and underscores (`a-z`, `A-Z`, `0-9`, `-`, `_`)
- Value must be JSON-serialisable, max 64 KB

`setValue` applies an optimistic update immediately before the network
round-trip so the UI responds without waiting for the server.

## Public API Summary

| Export | Kind | Description |
|---|---|---|
| `AppProvider` | Component | Required root wrapper |
| `useQuery` | Hook | Fetch entity records with filtering and pagination |
| `useMutation` | Hook | Create, update, replace, delete, and bulk-create entities |
| `useSubscription` | Hook | Real-time entity events via WebSocket |
| `usePermission` | Hook | Synchronous permission check |
| `useUser` | Hook | Current user context |
| `useAppStorage` | Hook | Per-user persistent key-value storage |

## TypeScript

All types exported by the SDK:

```ts
import type {
  // Query
  QueryOptions,
  QueryResult,
  FilterSpec,
  FilterValue,
  FilterOperator,
  Pagination,
  // Mutation
  MutationResult,
  BulkResult,
  // Subscription
  SubscriptionOptions,
  SubscriptionResult,
  EntityEvent,
  EntityEventType,
  // User
  UserContext,
  // Permissions
  PermissionAction,
  // Error
  AppSDKError,
} from '@oneplatform/app-sdk';
```

## Building and Deploying

Apps are compiled with Vite or a compatible bundler and deployed as a bundle.

1. Scaffold a new app:
   ```sh
   op app init --name "My App" --slug my-app
   cd my-app
   pnpm install
   ```

2. Develop locally against the live platform:
   ```sh
   op app dev my-app --port 3100
   ```

3. Build for production:
   ```sh
   pnpm run build
   # produces dist/bundle.js (or a .tar.gz bundle)
   ```

4. Deploy:
   ```sh
   # Server-side build from registered source
   op app deploy my-app

   # Upload a pre-built bundle
   vite build && tar -czf bundle.tar.gz -C dist .
   op app deploy my-app --file bundle.tar.gz --wait
   ```
