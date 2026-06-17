[**@oneplatform/plugin-sdk**](../README.md)

***

[@oneplatform/plugin-sdk](../README.md) / MappedRecord

# Interface: MappedRecord

Defined in: [packages/plugin-sdk/src/types/primitives.ts:32](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/primitives.ts#L32)

@oneplatform/plugin-sdk — root export

Types-only re-export. Plugin source code imports from this path.

CONSTRAINT: This file must never import Zod, Node.js builtins, or any
runtime library. The only permitted runtime code is the PluginError class
hierarchy from ./types/errors.ts. All other exports are TypeScript
interface/type declarations that emit zero JavaScript.

## Properties

### data

> **data**: `Record`\<`string`, `unknown`\>

Defined in: [packages/plugin-sdk/src/types/primitives.ts:35](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/primitives.ts#L35)

***

### entityType

> **entityType**: `string`

Defined in: [packages/plugin-sdk/src/types/primitives.ts:34](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/primitives.ts#L34)

***

### operation

> **operation**: `"upsert"` \| `"delete"`

Defined in: [packages/plugin-sdk/src/types/primitives.ts:36](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/primitives.ts#L36)

***

### sourceId

> **sourceId**: `string`

Defined in: [packages/plugin-sdk/src/types/primitives.ts:33](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/plugin-sdk/src/types/primitives.ts#L33)
