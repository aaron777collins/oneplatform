[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / TenantContext

# Interface: TenantContext

Defined in: [packages/plugin-sdk/src/types/context.ts:154](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L154)

## Properties

### config

> **config**: `Record`\<`string`, `unknown`\>

Defined in: [packages/plugin-sdk/src/types/context.ts:166](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L166)

Configuration values provided by the tenant admin at plugin enable time.
Values are validated against the plugin's manifest.configSchema before being
stored. Safe to read; always typed as Record<string, unknown>.

***

### instanceId

> **instanceId**: `string`

Defined in: [packages/plugin-sdk/src/types/context.ts:173](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L173)

Unique ID of this specific plugin instance within the tenant.
A single plugin can be enabled multiple times (e.g., two Shopify connectors
pointing to different stores). Each enable creates a distinct instanceId.

***

### tenantId

> **tenantId**: `string`

Defined in: [packages/plugin-sdk/src/types/context.ts:156](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L156)

UUID of the tenant that owns this plugin instance.

***

### tenantName

> **tenantName**: `string`

Defined in: [packages/plugin-sdk/src/types/context.ts:159](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/context.ts#L159)

Human-readable display name for this tenant.
