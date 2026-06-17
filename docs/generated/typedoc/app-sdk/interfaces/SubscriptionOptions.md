[**@oneplatform/app-sdk**](../README.md)

***

[@oneplatform/app-sdk](../README.md) / SubscriptionOptions

# Interface: SubscriptionOptions

Defined in: [types/entities.ts:101](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L101)

## Properties

### events?

> `optional` **events?**: [`EntityEventType`](../type-aliases/EntityEventType.md)[]

Defined in: [types/entities.ts:104](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L104)

Default: all three event types

***

### filter?

> `optional` **filter?**: [`FilterSpec`](../type-aliases/FilterSpec.md)

Defined in: [types/entities.ts:102](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L102)

***

### onEvent?

> `optional` **onEvent?**: (`event`) => `void`

Defined in: [types/entities.ts:105](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/app-sdk/src/types/entities.ts#L105)

#### Parameters

##### event

[`EntityEvent`](EntityEvent.md)\<`unknown`\>

#### Returns

`void`
