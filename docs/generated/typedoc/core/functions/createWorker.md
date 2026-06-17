[**@oneplatform/core**](../README.md)

***

[@oneplatform/core](../README.md) / createWorker

# Function: createWorker()

> **createWorker**\<`T`, `R`\>(`queueName`, `processor`, `connection`): `Worker`\<`T`, `R`\>

Defined in: [packages/core/src/queue.ts:39](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/queue.ts#L39)

Creates a BullMQ `Worker` that processes jobs from the named queue.

Completed jobs are removed immediately (no retention cost). Failed jobs are
kept (up to 100) so the DLQ inspector can examine them without a separate
persistence layer.

## Type Parameters

### T

`T` = `unknown`

### R

`R` = `unknown`

## Parameters

### queueName

`string`

Must match the queue created by [createQueue](createQueue.md).

### processor

`Processor`\<`T`, `R`\>

Async function invoked for each job.

### connection

`ConnectionOptions`

ioredis connection options or a `Redis` instance.

## Returns

`Worker`\<`T`, `R`\>
