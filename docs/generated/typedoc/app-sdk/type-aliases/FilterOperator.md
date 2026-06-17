[**@oneplatform/app-sdk**](../README.md)

***

[@oneplatform/app-sdk](../README.md) / FilterOperator

# Type Alias: FilterOperator

> **FilterOperator** = `"eq"` \| `"ne"` \| `"lt"` \| `"lte"` \| `"gt"` \| `"gte"` \| `"in"` \| `"nin"` \| `"contains"`

Defined in: [types/entities.ts:12](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L12)

Generic entity and query types used across the public API surface.

These types are generic-first so that app developers can substitute
their own entity shapes (e.g. useQuery<Customer>) for full type safety.
The SDK itself ships with T = unknown as the default — type safety is
additive through the declaration injection mechanism described in the spec.
