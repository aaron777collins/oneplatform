---
title: "@oneplatform/app-sdk"
description: React SDK for building apps that run on the OnePlatform app shell.
sidebar:
  order: 1
---

`@oneplatform/app-sdk` provides the React hooks and context providers used by
apps running inside the OnePlatform app shell. Apps import this package and
receive platform data through the BFF injection layer at runtime.

## Installation

```sh
npm install @oneplatform/app-sdk
```

`@oneplatform/app-sdk` must be listed as a peer dependency and **externalized** in
your bundle (not included in the output). The platform provides the SDK at runtime.

## Quick start

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

## Available hooks

| Hook | Description |
|------|-------------|
| `useQuery(entityType, options?)` | Query entity records |
| `useMutation(entityType)` | Create, update, or delete records |
| `useSubscription(entityType)` | Subscribe to real-time record changes |
| `useUser()` | Get the current authenticated user |
| `usePermission(scope)` | Check if the current user has a permission scope |
| `useAppStorage(key)` | Read/write app-scoped key-value storage |

## Resources

- [App Developer Quickstart](/getting-started/app-developer)
- [App Service API](/api/app)
