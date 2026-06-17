[**@oneplatform/core**](../README.md)

***

[@oneplatform/core](../README.md) / createRedisClient

# Function: createRedisClient()

> **createRedisClient**(`config`): `Redis`

Defined in: [packages/core/src/redis.ts:33](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/redis.ts#L33)

Creates an ioredis `Redis` client configured for OnePlatform services.

Uses `lazyConnect` so startup succeeds even when Redis is momentarily
unavailable. Reconnects with exponential backoff capped at 30 s, giving
up after 10 consecutive failures to surface hard outages quickly.

## Parameters

### config

[`RedisClientConfig`](../interfaces/RedisClientConfig.md)

Redis URL and optional per-command retry limit.

## Returns

`Redis`
