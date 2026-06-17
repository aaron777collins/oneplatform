[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / ConnectorMetadata

# Interface: ConnectorMetadata

Defined in: [packages/plugin-sdk/src/types/metadata.ts:37](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L37)

## Extends

- [`BaseMetadata`](BaseMetadata.md)

## Properties

### author

> **author**: `string`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:25](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L25)

Plugin author name or organization.

#### Inherited from

[`BaseMetadata`](BaseMetadata.md).[`author`](BaseMetadata.md#author)

***

### category

> **category**: `string`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:44](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L44)

Marketplace category. Standard values: "crm", "ecommerce", "database",
"file", "analytics", "marketing", "finance", "devtools", "iot", "other".

***

### configSchema

> **configSchema**: [`JSONSchema`](../type-aliases/JSONSchema.md)

Defined in: [packages/plugin-sdk/src/types/metadata.ts:31](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L31)

JSON Schema for the tenant-admin configuration form.

#### Inherited from

[`BaseMetadata`](BaseMetadata.md).[`configSchema`](BaseMetadata.md#configschema)

***

### description

> **description**: `string`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:19](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L19)

Brief description shown in the marketplace. 10-500 characters.

#### Inherited from

[`BaseMetadata`](BaseMetadata.md).[`description`](BaseMetadata.md#description)

***

### icon?

> `optional` **icon?**: `string`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:28](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L28)

URL or data URI for the plugin icon. PNG or SVG, max 64KB.

#### Inherited from

[`BaseMetadata`](BaseMetadata.md).[`icon`](BaseMetadata.md#icon)

***

### id

> **id**: `string`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:13](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L13)

Must match manifest.id exactly.

#### Inherited from

[`BaseMetadata`](BaseMetadata.md).[`id`](BaseMetadata.md#id)

***

### name

> **name**: `string`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:16](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L16)

Human-readable display name. 2-100 characters.

#### Inherited from

[`BaseMetadata`](BaseMetadata.md).[`name`](BaseMetadata.md#name)

***

### outputSchema

> **outputSchema**: [`JSONSchema`](../type-aliases/JSONSchema.md)

Defined in: [packages/plugin-sdk/src/types/metadata.ts:47](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L47)

JSON Schema describing the shape of records this connector produces.

***

### rateLimit?

> `optional` **rateLimit?**: `object`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:60](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L60)

Advisory rate limit hint for the Ingestion Service's scheduling algorithm.
Does not enforce anything — the connector is responsible for enforcing its own
rate limits by throwing PluginRateLimitError.

#### requestsPerMinute

> **requestsPerMinute**: `number`

#### rowsPerSecond?

> `optional` **rowsPerSecond?**: `number`

***

### supportsIncremental

> **supportsIncremental**: `boolean`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:50](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L50)

True if the connector supports cursor-based incremental fetching.

***

### supportsRealtime

> **supportsRealtime**: `boolean`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:53](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L53)

True if the connector implements subscribeToEvents().

***

### tags?

> `optional` **tags?**: `string`[]

Defined in: [packages/plugin-sdk/src/types/metadata.ts:34](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L34)

Discoverability tags shown in the marketplace filter UI.

#### Inherited from

[`BaseMetadata`](BaseMetadata.md).[`tags`](BaseMetadata.md#tags)

***

### type

> `readonly` **type**: `"connector"`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:38](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L38)

***

### version

> **version**: `string`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:22](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L22)

Must match manifest.version exactly.

#### Inherited from

[`BaseMetadata`](BaseMetadata.md).[`version`](BaseMetadata.md#version)
