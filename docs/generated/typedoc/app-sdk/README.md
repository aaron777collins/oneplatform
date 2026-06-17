**@oneplatform/app-sdk**

***

# @oneplatform/app-sdk

@oneplatform/app-sdk — React hooks and context for OnePlatform hosted apps.

## Quick start
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
  const { data, isLoading } = useQuery('Product');
  if (isLoading) return <div>Loading...</div>;
  return <ul>{data?.map(p => <li key={p.id}>{p.name}</li>)}</ul>;
}
```

Only the seven public exports and their associated types are re-exported here.
Internal modules (client/, cache/, ws/) are not accessible from package consumers.
Any attempt to import @oneplatform/app-sdk/client/BffClient will fail at the
esbuild enforcement layer in the sandbox build.

## Interfaces

- [AppSDKError](interfaces/AppSDKError.md)
- [BulkResult](interfaces/BulkResult.md)
- [EntityEvent](interfaces/EntityEvent.md)
- [MutationResult](interfaces/MutationResult.md)
- [Pagination](interfaces/Pagination.md)
- [QueryOptions](interfaces/QueryOptions.md)
- [QueryResult](interfaces/QueryResult.md)
- [SubscriptionOptions](interfaces/SubscriptionOptions.md)
- [SubscriptionResult](interfaces/SubscriptionResult.md)
- [UserContext](interfaces/UserContext.md)

## Type Aliases

- [EntityEventType](type-aliases/EntityEventType.md)
- [FilterOperator](type-aliases/FilterOperator.md)
- [FilterSpec](type-aliases/FilterSpec.md)
- [FilterValue](type-aliases/FilterValue.md)
- [PermissionAction](type-aliases/PermissionAction.md)

## Functions

- [AppProvider](functions/AppProvider.md)
- [useAppStorage](functions/useAppStorage.md)
- [useMutation](functions/useMutation.md)
- [usePermission](functions/usePermission.md)
- [useQuery](functions/useQuery.md)
- [useSubscription](functions/useSubscription.md)
- [useUser](functions/useUser.md)
