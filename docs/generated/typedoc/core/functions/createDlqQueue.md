[**@oneplatform/core**](../README.md)

***

[@oneplatform/core](../README.md) / createDlqQueue

# Function: createDlqQueue()

> **createDlqQueue**(`primaryQueueName`, `connection`): `Queue`

Defined in: [packages/core/src/queue.ts:65](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/queue.ts#L65)

Returns a dead-letter queue for the given primary queue.

Move unrecoverable jobs here manually after exhausting retries so they are
isolated from active work and can be replayed or archived independently.

The DLQ name is `{primaryQueueName}:dlq`.

## Parameters

### primaryQueueName

`string`

The name of the primary queue this DLQ mirrors.

### connection

`ConnectionOptions`

ioredis connection options or a `Redis` instance.

## Returns

`Queue`
