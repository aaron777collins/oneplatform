[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / HookDeclaration

# Interface: HookDeclaration

Defined in: [packages/plugin-sdk/src/types/hooks.ts:58](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/hooks.ts#L58)

## Properties

### criticality

> **criticality**: `"critical"` \| `"advisory"`

Defined in: [packages/plugin-sdk/src/types/hooks.ts:73](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/hooks.ts#L73)

Criticality determines what happens when this hook fails or times out.

"critical":  Hook failure aborts the stage and returns an error to the caller.
             Use for hooks that enforce invariants (e.g., schema validation).
"advisory":  Hook failure is logged but the stage continues with the pre-hook
             payload. Use for enrichment or observability hooks.

***

### entrypoint

> **entrypoint**: `string`

Defined in: [packages/plugin-sdk/src/types/hooks.ts:100](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/hooks.ts#L100)

The named export in dist/bundle.js that implements this hook.
Example: "onBeforeIngestionReceive"

The export must be a function with this signature:
  async function onBeforeIngestionReceive(
    payload: HookPayload,
    context: PluginContext
  ): Promise<HookResult>

***

### priority?

> `optional` **priority?**: `number`

Defined in: [packages/plugin-sdk/src/types/hooks.ts:81](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/hooks.ts#L81)

Execution order within a stage's hook chain. Lower priority = earlier execution.
Default: 100. Valid range: 0-999.
When two hooks share the same priority, execution order is deterministic but
not specified — do not rely on ordering between plugins with equal priority.

***

### stage

> **stage**: [`HookStage`](../type-aliases/HookStage.md)

Defined in: [packages/plugin-sdk/src/types/hooks.ts:63](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/hooks.ts#L63)

The hook stage this declaration registers for.
Must be one of the HookStage values above.

***

### timeout?

> `optional` **timeout?**: `number`

Defined in: [packages/plugin-sdk/src/types/hooks.ts:88](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/hooks.ts#L88)

Execution timeout override for this specific hook.
Default: 30 seconds. Maximum: 300 seconds.
Must be specified in seconds as a positive integer.
