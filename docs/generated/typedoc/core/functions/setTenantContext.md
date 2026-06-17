[**@oneplatform/core**](../README.md)

***

[@oneplatform/core](../README.md) / setTenantContext

# Function: setTenantContext()

> **setTenantContext**(`client`, `tenantId`): `Promise`\<`void`\>

Defined in: [packages/core/src/db.ts:45](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/db.ts#L45)

Sets the session-local `app.tenant_id` GUC that Row-Level Security policies
read via `current_setting('app.tenant_id')`.

Must be called within a transaction so the setting is scoped to that
transaction only and does not leak across pool connections.

## Parameters

### client

`PoolClient`

An active pool client obtained via `pool.connect()`.

### tenantId

`string`

The tenant ID to scope queries to.

## Returns

`Promise`\<`void`\>
