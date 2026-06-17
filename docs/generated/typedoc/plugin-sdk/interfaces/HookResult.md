[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / HookResult

# Interface: HookResult\<S\>

Defined in: [packages/plugin-sdk/src/types/hooks.ts:229](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/hooks.ts#L229)

The return type of a hook function.
To modify the data flowing through the stage, return a new payload.
To pass data through unmodified, return the input payload unchanged.
Returning null from an advisory hook is equivalent to returning the input payload.

## Type Parameters

### S

`S` *extends* [`HookStage`](../type-aliases/HookStage.md) = [`HookStage`](../type-aliases/HookStage.md)

## Properties

### data

> **data**: `S` *extends* keyof `HookPayloadDataMap` ? `HookPayloadDataMap`\[`S`\] : `Record`\<`string`, `unknown`\>

Defined in: [packages/plugin-sdk/src/types/hooks.ts:231](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/hooks.ts#L231)

The (possibly modified) data to pass to the next hook or to the stage itself.
