[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / CacheAccessor

# Interface: CacheAccessor

Defined in: [packages/plugin-sdk/src/types/context.ts:92](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L92)

## Methods

### delete()

> **delete**(`key`): `Promise`\<`void`\>

Defined in: [packages/plugin-sdk/src/types/context.ts:113](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L113)

Delete a key from the plugin instance's cache.
No-op if the key does not exist.

#### Parameters

##### key

`string`

#### Returns

`Promise`\<`void`\>

***

### get()

> **get**\<`T`\>(`key`): `Promise`\<`T` \| `null`\>

Defined in: [packages/plugin-sdk/src/types/context.ts:100](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L100)

Get a value from the plugin instance's namespaced cache.
Cache keys are automatically scoped to {tenantId}:{instanceId} — two plugin
instances in the same tenant cannot read each other's cached data.

Returns null if the key does not exist or has expired.

#### Type Parameters

##### T

`T`

#### Parameters

##### key

`string`

#### Returns

`Promise`\<`T` \| `null`\>

***

### lock()

> **lock**(`key`, `ttlSeconds`): `Promise`\<[`LockHandle`](LockHandle.md) \| `null`\>

Defined in: [packages/plugin-sdk/src/types/context.ts:125](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L125)

Acquire a distributed mutex lock. Useful for ensuring only one execution at a
time performs a token refresh or other singleton operation.

Returns a LockHandle if the lock was acquired, or null if it is already held.
Always call release() in a finally block.

#### Parameters

##### key

`string`

##### ttlSeconds

`number`

Lock TTL. The lock is automatically released after this duration
                  even if release() is never called (prevents deadlocks).

#### Returns

`Promise`\<[`LockHandle`](LockHandle.md) \| `null`\>

***

### set()

> **set**\<`T`\>(`key`, `value`, `ttlSeconds?`): `Promise`\<`void`\>

Defined in: [packages/plugin-sdk/src/types/context.ts:107](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L107)

Store a value in the plugin instance's namespaced cache.

#### Type Parameters

##### T

`T`

#### Parameters

##### key

`string`

##### value

`T`

##### ttlSeconds?

`number`

Optional TTL in seconds. If omitted, the value does not expire
                  until evicted by LRU pressure. Maximum TTL is 86400 (24 hours).

#### Returns

`Promise`\<`void`\>
