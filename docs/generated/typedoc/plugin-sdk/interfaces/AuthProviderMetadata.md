[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / AuthProviderMetadata

# Interface: AuthProviderMetadata

Defined in: [packages/plugin-sdk/src/types/metadata.ts:103](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L103)

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

### name

> **name**: `string`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:16](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L16)

Human-readable display name. 2-100 characters.

#### Inherited from

[`BaseMetadata`](BaseMetadata.md).[`name`](BaseMetadata.md#name)

***

### protocol

> **protocol**: `"oauth2"` \| `"saml"` \| `"oidc"` \| `"ldap"` \| `"custom"`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:107](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L107)

The identity protocol this provider implements.

***

### scopes?

> `optional` **scopes?**: `string`[]

Defined in: [packages/plugin-sdk/src/types/metadata.ts:119](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L119)

OAuth scopes this provider supports. Shown in the admin configuration UI.
Omit for non-OAuth providers.

***

### supportsTokenRefresh

> **supportsTokenRefresh**: `boolean`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:113](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L113)

True if the provider implements refreshToken().

***

### supportsTokenValidation

> **supportsTokenValidation**: `boolean`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:110](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L110)

True if the provider implements validateToken().

***

### tags?

> `optional` **tags?**: `string`[]

Defined in: [packages/plugin-sdk/src/types/metadata.ts:34](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L34)

Discoverability tags shown in the marketplace filter UI.

#### Inherited from

[`BaseMetadata`](BaseMetadata.md).[`tags`](BaseMetadata.md#tags)

***

### type

> `readonly` **type**: `"auth-provider"`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:104](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L104)

***

### version

> **version**: `string`

Defined in: [packages/plugin-sdk/src/types/metadata.ts:22](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/metadata.ts#L22)

Must match manifest.version exactly.

#### Inherited from

[`BaseMetadata`](BaseMetadata.md).[`version`](BaseMetadata.md#version)
