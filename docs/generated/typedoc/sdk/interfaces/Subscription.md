[**@oneplatform/sdk**](../README.md)

***

[@oneplatform/sdk](../README.md) / Subscription

# Interface: Subscription

Defined in: [packages/sdk/src/types/subscription.ts:49](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/subscription.ts#L49)

## Properties

### id

> `readonly` **id**: `string`

Defined in: [packages/sdk/src/types/subscription.ts:51](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/subscription.ts#L51)

Server-assigned subscription ID (from the first 'connected' SSE event).

***

### lastEventId

> `readonly` **lastEventId**: `string` \| `null`

Defined in: [packages/sdk/src/types/subscription.ts:57](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/subscription.ts#L57)

Last event ID received. Used for reconnection resumption.

***

### status

> `readonly` **status**: `"connecting"` \| `"connected"` \| `"reconnecting"` \| `"closed"`

Defined in: [packages/sdk/src/types/subscription.ts:54](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/subscription.ts#L54)

Current connection lifecycle state.

## Methods

### on()

#### Call Signature

> **on**(`event`, `handler`): `this`

Defined in: [packages/sdk/src/types/subscription.ts:63](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/subscription.ts#L63)

Register a listener for status changes.

##### Parameters

###### event

`"status"`

###### handler

(`status`) => `void`

##### Returns

`this`

#### Call Signature

> **on**(`event`, `handler`): `this`

Defined in: [packages/sdk/src/types/subscription.ts:70](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/subscription.ts#L70)

Register a listener for connection errors (emitted before reconnect attempts).
AuthError is emitted for 401 responses — the subscription closes immediately
in that case and no reconnection is attempted.

##### Parameters

###### event

`"error"`

###### handler

(`error`) => `void`

##### Returns

`this`

***

### unsubscribe()

> **unsubscribe**(): `void`

Defined in: [packages/sdk/src/types/subscription.ts:60](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/sdk/src/types/subscription.ts#L60)

Terminate the subscription and close the SSE connection.

#### Returns

`void`
