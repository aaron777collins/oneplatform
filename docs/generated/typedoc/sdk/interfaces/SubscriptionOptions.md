[**@oneplatform/sdk**](../README.md)

***

[@oneplatform/sdk](../README.md) / SubscriptionOptions

# Interface: SubscriptionOptions

Defined in: [packages/sdk/src/types/subscription.ts:25](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/subscription.ts#L25)

## Properties

### events

> `readonly` **events**: `string`[]

Defined in: [packages/sdk/src/types/subscription.ts:30](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/subscription.ts#L30)

Event patterns to subscribe to.
Supports exact strings and trailing-wildcard patterns (e.g. "pipeline.*").

***

### filter?

> `readonly` `optional` **filter?**: `object`

Defined in: [packages/sdk/src/types/subscription.ts:35](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/subscription.ts#L35)

Optional server-side filter to reduce unnecessary traffic.

#### entityId?

> `readonly` `optional` **entityId?**: `string`

#### entityType?

> `readonly` `optional` **entityType?**: `string`

#### pipelineId?

> `readonly` `optional` **pipelineId?**: `string`

***

### fromEventId?

> `readonly` `optional` **fromEventId?**: `string`

Defined in: [packages/sdk/src/types/subscription.ts:46](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/subscription.ts#L46)

Resume from a specific event ID.
The server replays events after this ID within its replay window.
Managed automatically by the SDK on reconnection via Last-Event-ID.
