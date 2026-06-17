[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / WidgetMetadata

# Interface: WidgetMetadata

Defined in: [packages/plugin-sdk/src/types/metadata.ts:122](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L122)

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

### maxHeight?

> `optional` **maxHeight?**: `number`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:135](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L135)

Maximum grid height. Omit for no constraint.

***

### maxWidth?

> `optional` **maxWidth?**: `number`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:132](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L132)

Maximum grid width. Omit for no constraint.

***

### minHeight

> **minHeight**: `number`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:129](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L129)

Minimum grid height. Integer 1-12.

***

### minWidth

> **minWidth**: `number`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:126](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L126)

Minimum grid width. Integer 1-12.

***

### name

> **name**: `string`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:16](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L16)

Human-readable display name. 2-100 characters.

#### Inherited from

[`BaseMetadata`](BaseMetadata.md).[`name`](BaseMetadata.md#name)

***

### slots

> **slots**: [`WidgetSlotDeclaration`](WidgetSlotDeclaration.md)[]

Defined in: [packages/plugin-sdk/src/types/metadata.ts:138](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L138)

Slots this widget can render in.

***

### tags?

> `optional` **tags?**: `string`[]

Defined in: [packages/plugin-sdk/src/types/metadata.ts:34](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L34)

Discoverability tags shown in the marketplace filter UI.

#### Inherited from

[`BaseMetadata`](BaseMetadata.md).[`tags`](BaseMetadata.md#tags)

***

### type

> `readonly` **type**: `"widget"`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:123](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L123)

***

### version

> **version**: `string`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:22](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L22)

Must match manifest.version exactly.

#### Inherited from

[`BaseMetadata`](BaseMetadata.md).[`version`](BaseMetadata.md#version)
