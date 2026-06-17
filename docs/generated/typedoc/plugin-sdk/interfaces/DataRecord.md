[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / DataRecord

# Interface: DataRecord

Defined in: [packages/plugin-sdk/src/types/primitives.ts:13](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/primitives.ts#L13)

@oneplatform/plugin-sdk — root export

Types-only re-export. Plugin source code imports from this path.

CONSTRAINT: This file must never import Zod, Node.js builtins, or any
runtime library. The only permitted runtime code is the PluginError class
hierarchy from ./types/errors.ts. All other exports are TypeScript
interface/type declarations that emit zero JavaScript.

## Properties

### data

> **data**: `Record`\<`string`, `unknown`\>

Defined in: [packages/plugin-sdk/src/types/primitives.ts:19](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/primitives.ts#L19)

***

### metadata?

> `optional` **metadata?**: `object`

Defined in: [packages/plugin-sdk/src/types/primitives.ts:22](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/primitives.ts#L22)

#### checksum?

> `optional` **checksum?**: `string`

#### createdAt?

> `optional` **createdAt?**: `string`

#### deletedAt?

> `optional` **deletedAt?**: `string`

#### updatedAt?

> `optional` **updatedAt?**: `string`

***

### sourceId

> **sourceId**: `string`

Defined in: [packages/plugin-sdk/src/types/primitives.ts:16](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/primitives.ts#L16)
