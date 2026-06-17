[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / PluginLogger

# Interface: PluginLogger

Defined in: [packages/plugin-sdk/src/types/context.ts:128](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L128)

## Methods

### debug()

> **debug**(`message`, `metadata?`): `void`

Defined in: [packages/plugin-sdk/src/types/context.ts:133](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L133)

Log a debug-level message. Debug logs are suppressed by default in production
tenants and are only visible with explicit debug mode enabled on the instance.

#### Parameters

##### message

`string`

##### metadata?

`Record`\<`string`, `unknown`\>

#### Returns

`void`

***

### error()

> **error**(`message`, `metadata?`): `void`

Defined in: [packages/plugin-sdk/src/types/context.ts:151](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L151)

Log an error. Errors are surfaced in the plugin monitoring dashboard, increment
the error counter, and trigger alerting if configured by the tenant admin.

IMPORTANT: Never pass credential values, access tokens, or PII in the metadata
argument. The metadata object is persisted to the platform logging system.

#### Parameters

##### message

`string`

##### metadata?

`Record`\<`string`, `unknown`\>

#### Returns

`void`

***

### info()

> **info**(`message`, `metadata?`): `void`

Defined in: [packages/plugin-sdk/src/types/context.ts:136](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L136)

Log an informational message. Appears in the plugin execution log view.

#### Parameters

##### message

`string`

##### metadata?

`Record`\<`string`, `unknown`\>

#### Returns

`void`

***

### warn()

> **warn**(`message`, `metadata?`): `void`

Defined in: [packages/plugin-sdk/src/types/context.ts:142](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L142)

Log a warning. Warnings are surfaced in the plugin monitoring dashboard and
increment the warning counter for this plugin instance.

#### Parameters

##### message

`string`

##### metadata?

`Record`\<`string`, `unknown`\>

#### Returns

`void`
