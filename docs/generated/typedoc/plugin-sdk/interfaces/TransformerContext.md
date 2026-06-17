[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / TransformerContext

# Interface: TransformerContext

Defined in: [packages/plugin-sdk/src/types/transformer.ts:17](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/transformer.ts#L17)

## Properties

### cache

> **cache**: [`CacheAccessor`](CacheAccessor.md)

Defined in: [packages/plugin-sdk/src/types/transformer.ts:21](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/transformer.ts#L21)

***

### logger

> **logger**: [`PluginLogger`](PluginLogger.md)

Defined in: [packages/plugin-sdk/src/types/transformer.ts:19](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/transformer.ts#L19)

***

### ontology

> **ontology**: [`OntologyAccessor`](OntologyAccessor.md)

Defined in: [packages/plugin-sdk/src/types/transformer.ts:20](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/transformer.ts#L20)

***

### pipelineRunId?

> `optional` **pipelineRunId?**: `string`

Defined in: [packages/plugin-sdk/src/types/transformer.ts:28](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/transformer.ts#L28)

Present when the transformer runs inside a named pipeline run.
Use for logging and correlation, not for control flow.

***

### stageId?

> `optional` **stageId?**: `string`

Defined in: [packages/plugin-sdk/src/types/transformer.ts:31](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/transformer.ts#L31)

The ID of the pipeline step that invoked this transformer.

***

### tenant

> **tenant**: [`TenantContext`](TenantContext.md)

Defined in: [packages/plugin-sdk/src/types/transformer.ts:18](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/transformer.ts#L18)

***

### tracing

> **tracing**: [`TracingContext`](TracingContext.md)

Defined in: [packages/plugin-sdk/src/types/transformer.ts:22](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/transformer.ts#L22)
