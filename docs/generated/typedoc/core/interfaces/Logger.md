[**@oneplatform/core**](../README.md)

***

[@oneplatform/core](../README.md) / Logger

# Interface: Logger

Defined in: [packages/core/src/logger.ts:38](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/logger.ts#L38)

## Methods

### audit()

> **audit**(`event`): `Promise`\<`void`\>

Defined in: [packages/core/src/logger.ts:43](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/logger.ts#L43)

#### Parameters

##### event

`Omit`\<[`AuditEvent`](AuditEvent.md), `"timestamp"` \| `"traceId"`\>

#### Returns

`Promise`\<`void`\>

***

### debug()

> **debug**(`message`, `metadata?`): `void`

Defined in: [packages/core/src/logger.ts:39](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/logger.ts#L39)

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

Defined in: [packages/core/src/logger.ts:42](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/logger.ts#L42)

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

Defined in: [packages/core/src/logger.ts:40](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/logger.ts#L40)

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

Defined in: [packages/core/src/logger.ts:41](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/logger.ts#L41)

#### Parameters

##### message

`string`

##### metadata?

`Record`\<`string`, `unknown`\>

#### Returns

`void`

***

### withTraceId()

> **withTraceId**(`traceId`): `Logger`

Defined in: [packages/core/src/logger.ts:44](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/logger.ts#L44)

#### Parameters

##### traceId

`string`

#### Returns

`Logger`
