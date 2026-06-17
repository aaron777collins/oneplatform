[**@oneplatform/app-sdk**](../README.md)

***

[@oneplatform/app-sdk](../README.md) / useQuery

# Function: useQuery()

> **useQuery**\<`T`\>(`entity`, `options?`): [`QueryResult`](../interfaces/QueryResult.md)\<`T`\>

Defined in: [hooks/useQuery.ts:129](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/hooks/useQuery.ts#L129)

Fetches platform entity data with filtering, sorting, and cursor pagination.

Implements stale-while-revalidate caching: cached data is returned immediately
while a background refetch runs if the entry is older than `options.staleTime`
(default 30 seconds).

Concurrent calls with the same (entity, options) key share one in-flight
fetch via the module-level QueryCache singleton — no duplicate network requests.

## Type Parameters

### T

`T` = `unknown`

## Parameters

### entity

`string`

The ontology entity type slug (e.g. "customer", "order")

### options?

[`QueryOptions`](../interfaces/QueryOptions.md) = `{}`

Optional filter, sort, field selection, and pagination config

## Returns

[`QueryResult`](../interfaces/QueryResult.md)\<`T`\>

QueryResult with data, loading state, error, and pagination helpers

## Performance

The `options` object is compared by reference for cache key
computation. Passing a new object literal on every render causes unnecessary
re-fetches (the cache key changes even though the filter values are identical).
Always memoize the options object with `useMemo`:

```ts
// WRONG — new object on every render triggers a refetch loop
const { data } = useQuery("customer", { filter: { status: { eq: "active" } } });

// CORRECT — stable reference, refetch only runs when the filter values change
const queryOptions = useMemo(
  () => ({ filter: { status: { eq: "active" } } }),
  [] // empty deps: stable for the component's lifetime
);
const { data } = useQuery("customer", queryOptions);
```

For dynamic filters, include the changing values in the `useMemo` deps array:

```ts
const queryOptions = useMemo(
  () => ({ filter: { status: { eq: activeFilter } } }),
  [activeFilter] // re-memoize (and re-fetch) only when activeFilter changes
);
const { data } = useQuery("customer", queryOptions);
```
