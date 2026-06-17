[**@oneplatform/core**](../README.md)

***

[@oneplatform/core](../README.md) / DbClientConfig

# Interface: DbClientConfig

Defined in: [packages/core/src/db.ts:6](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/db.ts#L6)

Configuration for [createDbClient](../functions/createDbClient.md).

## Properties

### connectionString

> **connectionString**: `string`

Defined in: [packages/core/src/db.ts:8](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/db.ts#L8)

PostgreSQL connection string (e.g. `postgres://user:pass@host:5432/db`).

***

### maxConnections

> **maxConnections**: `number`

Defined in: [packages/core/src/db.ts:10](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/db.ts#L10)

Maximum number of pooled connections.

***

### statementTimeoutMs?

> `optional` **statementTimeoutMs?**: `number`

Defined in: [packages/core/src/db.ts:16](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/db.ts#L16)

Statement timeout in milliseconds. Defaults to 30 000 ms.

Prevents runaway queries from holding connections and exhausting the pool.
