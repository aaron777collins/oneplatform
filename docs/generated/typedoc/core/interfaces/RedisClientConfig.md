[**@oneplatform/core**](../README.md)

***

[@oneplatform/core](../README.md) / RedisClientConfig

# Interface: RedisClientConfig

Defined in: [packages/core/src/redis.ts:5](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/redis.ts#L5)

Configuration for [createRedisClient](../functions/createRedisClient.md).

## Properties

### maxRetriesPerRequest?

> `optional` **maxRetriesPerRequest?**: `number`

Defined in: [packages/core/src/redis.ts:12](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/redis.ts#L12)

Maximum number of retries per command before the command is rejected.
Defaults to 3. Set to `null` to retry indefinitely (not recommended).

***

### url

> **url**: `string`

Defined in: [packages/core/src/redis.ts:7](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/redis.ts#L7)

Redis connection URL (e.g. `redis://host:6379`).
