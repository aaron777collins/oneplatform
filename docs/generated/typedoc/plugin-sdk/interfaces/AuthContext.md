[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / AuthContext

# Interface: AuthContext

Defined in: [packages/plugin-sdk/src/types/auth-provider.ts:40](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/auth-provider.ts#L40)

## Properties

### cache

> **cache**: [`CacheAccessor`](CacheAccessor.md)

Defined in: [packages/plugin-sdk/src/types/auth-provider.ts:49](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/auth-provider.ts#L49)

Cache accessor for storing PKCE code verifiers, nonces, or other
short-lived values needed across the two legs of the auth flow.
Use TTLs of 300 seconds (5 minutes) for these values.

***

### logger

> **logger**: [`PluginLogger`](PluginLogger.md)

Defined in: [packages/plugin-sdk/src/types/auth-provider.ts:42](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/auth-provider.ts#L42)

***

### tenant

> **tenant**: [`TenantContext`](TenantContext.md)

Defined in: [packages/plugin-sdk/src/types/auth-provider.ts:41](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/auth-provider.ts#L41)
