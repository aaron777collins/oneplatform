[**@oneplatform/core**](../README.md)

***

[@oneplatform/core](../README.md) / createQueue

# Function: createQueue()

> **createQueue**(`name`, `connection`): `Queue`

Defined in: [packages/core/src/queue.ts:21](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/queue.ts#L21)

Creates a BullMQ `Queue` with the platform-standard retry policy
(5 attempts, exponential backoff starting at 1 s).

## Parameters

### name

`string`

Queue name; must be unique per Redis namespace.

### connection

`ConnectionOptions`

ioredis connection options or a `Redis` instance.

## Returns

`Queue`
