[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / BaseMetadata

# Interface: BaseMetadata

Defined in: [packages/plugin-sdk/src/types/metadata.ts:11](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L11)

## Extended by

- [`ConnectorMetadata`](ConnectorMetadata.md)
- [`TransformerMetadata`](TransformerMetadata.md)
- [`DestinationMetadata`](DestinationMetadata.md)
- [`AuthProviderMetadata`](AuthProviderMetadata.md)
- [`WidgetMetadata`](WidgetMetadata.md)

## Properties

### author

> **author**: `string`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:25](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L25)

Plugin author name or organization.

***

### configSchema

> **configSchema**: [`JSONSchema`](../type-aliases/JSONSchema.md)

Defined in: [packages/plugin-sdk/src/types/metadata.ts:31](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L31)

JSON Schema for the tenant-admin configuration form.

***

### description

> **description**: `string`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:19](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L19)

Brief description shown in the marketplace. 10-500 characters.

***

### icon?

> `optional` **icon?**: `string`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:28](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L28)

URL or data URI for the plugin icon. PNG or SVG, max 64KB.

***

### id

> **id**: `string`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:13](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L13)

Must match manifest.id exactly.

***

### name

> **name**: `string`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:16](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L16)

Human-readable display name. 2-100 characters.

***

### tags?

> `optional` **tags?**: `string`[]

Defined in: [packages/plugin-sdk/src/types/metadata.ts:34](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L34)

Discoverability tags shown in the marketplace filter UI.

***

### version

> **version**: `string`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:22](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L22)

Must match manifest.version exactly.
