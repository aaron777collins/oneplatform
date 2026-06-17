[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / Transformer

# Interface: Transformer

Defined in: [packages/plugin-sdk/src/types/transformer.ts:34](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/transformer.ts#L34)

## Methods

### metadata()

> **metadata**(): [`TransformerMetadata`](TransformerMetadata.md)

Defined in: [packages/plugin-sdk/src/types/transformer.ts:35](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/transformer.ts#L35)

#### Returns

[`TransformerMetadata`](TransformerMetadata.md)

***

### transform()

> **transform**(`record`, `context`): `Promise`\<[`DataRecord`](DataRecord.md) \| `null`\>

Defined in: [packages/plugin-sdk/src/types/transformer.ts:48](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/transformer.ts#L48)

Transform a single record.

Return the (possibly modified) DataRecord to pass it downstream.
Return null to drop the record — it will not appear in the output.
Do not mutate the input record — return a new object.

#### Parameters

##### record

[`DataRecord`](DataRecord.md)

##### context

[`TransformerContext`](TransformerContext.md)

#### Returns

`Promise`\<[`DataRecord`](DataRecord.md) \| `null`\>

#### Throws

PluginDataError if the record is malformed and cannot be processed.
        The platform will route the record to the pipeline's dead-letter queue.
        Do not throw for recoverable data issues — return a modified record instead.

***

### transformBatch()?

> `optional` **transformBatch**(`records`, `context`): `Promise`\<[`DataRecord`](DataRecord.md)[]\>

Defined in: [packages/plugin-sdk/src/types/transformer.ts:61](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/transformer.ts#L61)

Transform a batch of records. Optional optimization for transformers that can
process records more efficiently in bulk (e.g., batch enrichment API calls).

If implemented, the platform uses this instead of calling transform() N times.
The result array must preserve ordering: records[i] maps to result[i] or is
absent (dropped). Use an empty array to drop all records.

The platform NEVER calls both transform() and transformBatch() for the same
batch — it prefers transformBatch() if present.

#### Parameters

##### records

[`DataRecord`](DataRecord.md)[]

##### context

[`TransformerContext`](TransformerContext.md)

#### Returns

`Promise`\<[`DataRecord`](DataRecord.md)[]\>
