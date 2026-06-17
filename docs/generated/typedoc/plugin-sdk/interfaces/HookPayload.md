[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / HookPayload

# Interface: HookPayload\<S\>

Defined in: [packages/plugin-sdk/src/types/hooks.ts:209](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/hooks.ts#L209)

The payload passed to every hook function.

Generic form: HookPayload<S extends HookStage>
When S is a key of HookPayloadDataMap, data is narrowed to its specific type.
For all other stages data is Record<string, unknown>.

## Example

```ts
async function onBeforeIngestionReceive(
  payload: HookPayload<"before:ingestion.receive">,
  ctx: PluginContext,
): Promise<HookResult<"before:ingestion.receive">> {
  // payload.data is IngestionReceiveData — fully typed
  console.log(payload.data.rawPayload);
  return { data: payload.data };
}
```

## Type Parameters

### S

`S` *extends* [`HookStage`](../type-aliases/HookStage.md) = [`HookStage`](../type-aliases/HookStage.md)

## Properties

### context

> **context**: `HookContext`

Defined in: [packages/plugin-sdk/src/types/hooks.ts:220](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/hooks.ts#L220)

Metadata about the execution context.

***

### data

> **data**: `S` *extends* keyof `HookPayloadDataMap` ? `HookPayloadDataMap`\[`S`\] : `Record`\<`string`, `unknown`\>

Defined in: [packages/plugin-sdk/src/types/hooks.ts:217](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/hooks.ts#L217)

The data being processed at this stage.
Narrowed to a specific type when S is a known stage in HookPayloadDataMap.

***

### stage

> **stage**: `S`

Defined in: [packages/plugin-sdk/src/types/hooks.ts:211](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/hooks.ts#L211)

The stage that triggered this hook.
