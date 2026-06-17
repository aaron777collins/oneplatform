[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / WidgetData

# Interface: WidgetData

Defined in: [packages/plugin-sdk/src/types/widget.ts:31](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/widget.ts#L31)

## Properties

### config

> **config**: `Record`\<`string`, `unknown`\>

Defined in: [packages/plugin-sdk/src/types/widget.ts:41](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/widget.ts#L41)

The widget instance's configuration values.

***

### queryResults

> **queryResults**: `Record`\<`string`, `unknown`[]\>

Defined in: [packages/plugin-sdk/src/types/widget.ts:38](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/widget.ts#L38)

Pre-fetched query results, keyed by entityType.
Populated by the platform before render() is called.
The platform fetches data using the tenant's access rights — widgets
never make data API calls directly.

***

### user

> **user**: `object`

Defined in: [packages/plugin-sdk/src/types/widget.ts:44](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/widget.ts#L44)

The requesting user's identity and roles. Use for conditional rendering only.

#### id

> **id**: `string`

#### roles

> **roles**: `string`[]
