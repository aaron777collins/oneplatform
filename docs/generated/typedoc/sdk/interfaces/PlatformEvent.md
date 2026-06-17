[**@oneplatform/sdk**](../README.md)

***

[@oneplatform/sdk](../README.md) / PlatformEvent

# Interface: PlatformEvent

Defined in: [packages/sdk/src/types/subscription.ts:8](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/subscription.ts#L8)

## Properties

### id

> `readonly` **id**: `string`

Defined in: [packages/sdk/src/types/subscription.ts:10](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/subscription.ts#L10)

Unique event ID. Used as Last-Event-ID for stream resumption.

***

### occurredAt

> `readonly` **occurredAt**: `string`

Defined in: [packages/sdk/src/types/subscription.ts:19](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/subscription.ts#L19)

ISO 8601 timestamp when the event occurred on the server.

***

### payload

> `readonly` **payload**: `unknown`

Defined in: [packages/sdk/src/types/subscription.ts:22](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/subscription.ts#L22)

Event-specific payload. Type varies by event type.

***

### tenantId

> `readonly` **tenantId**: `string`

Defined in: [packages/sdk/src/types/subscription.ts:16](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/subscription.ts#L16)

Tenant this event belongs to.

***

### type

> `readonly` **type**: `string`

Defined in: [packages/sdk/src/types/subscription.ts:13](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/subscription.ts#L13)

Dot-separated event type hierarchy. E.g. "pipeline.run.completed"
