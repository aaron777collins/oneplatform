[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / Destination

# Interface: Destination

Defined in: [packages/plugin-sdk/src/types/destination.ts:43](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/destination.ts#L43)

## Methods

### metadata()

> **metadata**(): [`DestinationMetadata`](DestinationMetadata.md)

Defined in: [packages/plugin-sdk/src/types/destination.ts:44](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/destination.ts#L44)

#### Returns

[`DestinationMetadata`](DestinationMetadata.md)

***

### write()

> **write**(`records`, `context`): `Promise`\<[`WriteResult`](WriteResult.md)\>

Defined in: [packages/plugin-sdk/src/types/destination.ts:58](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/destination.ts#L58)

Write a batch of mapped records to the destination.

The platform calls this with batches sized according to the destination's
delivery guarantee. For at-least-once destinations, the same record may be
delivered more than once (e.g., after a retry). The destination must handle
idempotent writes if its DestinationMetadata.deliveryGuarantee is
"at-least-once" or "exactly-once".

Never partially fail silently — report all failures in WriteResult.errors.
The platform uses this to trigger DLQ routing.

#### Parameters

##### records

[`MappedRecord`](MappedRecord.md)[]

##### context

[`DestinationContext`](DestinationContext.md)

#### Returns

`Promise`\<[`WriteResult`](WriteResult.md)\>

***

### writeStream()?

> `optional` **writeStream**(`stream`, `context`): `Promise`\<[`WriteResult`](WriteResult.md)\>

Defined in: [packages/plugin-sdk/src/types/destination.ts:68](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/destination.ts#L68)

Stream records to the destination. Only implement if
DestinationMetadata.supportsStreaming is true.

The platform provides an AsyncIterable of records. The destination should
maintain an open connection to the target system and write records as they
arrive. Return a WriteResult when the stream is exhausted.

#### Parameters

##### stream

`AsyncIterable`\<[`MappedRecord`](MappedRecord.md)\>

##### context

[`DestinationContext`](DestinationContext.md)

#### Returns

`Promise`\<[`WriteResult`](WriteResult.md)\>
